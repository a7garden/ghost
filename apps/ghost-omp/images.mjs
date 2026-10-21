import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,readFile,writeFile,rename,realpath,lstat,rm,readdir} from 'node:fs/promises';
import {join,dirname,extname} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {runCodex,codexEnvironment} from './codex-client.mjs';

const MAX_IMAGE=4*1024*1024;
const activeImages=new Set();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validID=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/u.test(id);
const magic=bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
async function boundedFile(path,root,started) {
  const resolved=await realpath(path), boundary=await realpath(root);
  if(!resolved.startsWith(`${boundary}/`) || (await lstat(path)).isSymbolicLink()) throw new Error('Image outside the owned output boundary.');
  const file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
  try { const s=await file.stat();if(!s.isFile()||s.uid!==process.getuid()||s.size>MAX_IMAGE||s.mtimeMs<started-3000) throw new Error('Invalid image output file.');const bytes=await file.readFile();if(!magic(bytes))throw new Error('Invalid image encoding.');return bytes; }finally{await file.close();}
}
async function keyFor(root,provider){
 const file=await open(join(root,'inference-credentials',`${provider}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const s=await file.stat();if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)!==0||s.size>8192)throw new Error('Invalid provider key permissions.');const value=JSON.parse(await file.readFile('utf8')).api_key;if(typeof value!=='string'||value.length<8||/\s/u.test(value))throw new Error('Invalid provider key.');return value;}finally{await file.close();}
}
async function nativeImage({cwd,prompt,executable}){
 const started=Date.now();
 let phase='native_request';const diagnostic={};
 try {
 const result=await runCodex({executable,cwd,prompt:`Use native image_generation once to create the following requested image. Do not use any other tools. Return the absolute newly generated image path in files (the native tool may save under the Codex generated_images directory).\n\n${prompt}`,
   images:true,model:'gpt-6-luna',effort:'high',schema:{type:'object',additionalProperties:false,required:['files','summary'],properties:{files:{type:'array',items:{type:'string'}},summary:{type:'string'}}}});
 phase='native_paths';
 let paths=result.value?.files;
 // Some CLI releases explain the native output location in the structured
 // summary. Accept only a fresh verified file under Codex's own output root.
 if(!Array.isArray(paths)||!paths.length) paths=typeof result.value?.summary==='string' ? (result.value.summary.match(/\/[^\s"<>]+\.(?:png|jpg|jpeg|webp)/gu)??[]) : [];
 diagnostic.file_count=Array.isArray(paths)?paths.length:0;
 phase='native_identity';
 if(!validID(result.native_thread_id))throw new Error('Native image result has no captured CLI thread identity.');
 diagnostic.native_thread_id=result.native_thread_id;
 const generated=join(homedir(),'.codex','generated_images',result.native_thread_id);
 // Native output is authoritative. Inspect only this newly created CLI
 // thread, never the global image directory or another conversation.
 let nativeFiles=[];
 try {nativeFiles=(await readdir(generated)).filter(name=>/\.(png|jpe?g|webp)$/iu.test(name)).map(name=>join(generated,name));}
 catch(error){if(error.code!=='ENOENT')throw error;}
 if(nativeFiles.length)paths=nativeFiles;
 if(!Array.isArray(paths)||paths.length!==1)throw new Error('Native image result does not identify exactly one output.');
 const path=paths[0];
 phase='native_boundary';
 diagnostic.in_job_directory=typeof path==='string'&&path.startsWith(`${cwd}/`);
 diagnostic.in_native_thread_directory=typeof path==='string'&&path.startsWith(`${generated}/`);
 return await boundedFile(path,diagnostic.in_job_directory?cwd:generated,started);
 }catch(error){throw Object.assign(new Error('Native image output was not verified.'),{code:`image_${phase}`,diagnostic:{...diagnostic,...(error.code==='codex_invalid_result'?{codex_result_phase:error.reason}:{})}});}
}
async function miniMaxImage(root,prompt,fetchImpl=fetch){
 const response=await fetchImpl('https://api.minimax.io/v1/image_generation',{method:'POST',redirect:'error',signal:AbortSignal.timeout(180000),headers:{Authorization:`Bearer ${await keyFor(root,'minimax')}`,'Content-Type':'application/json'},body:JSON.stringify({model:'image-01',prompt,n:1,response_format:'base64',aspect_ratio:'1:1'})});
 let size=0;const chunks=[];for await(const chunk of response.body??[]){size+=chunk.length;if(size>6*1024*1024)throw new Error('Image response exceeded its limit.');chunks.push(chunk);}
 if(!response.ok) throw new Error('MiniMax image request failed.');
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const encoded=value?.data?.image_base64?.[0];
 if(value.base_resp?.status_code!==0||typeof encoded!=='string'||!/^[A-Za-z0-9+/=]+$/u.test(encoded))throw new Error('MiniMax did not confirm an image.');
 const bytes=Buffer.from(encoded,'base64');if(bytes.length>MAX_IMAGE||!magic(bytes))throw new Error('Invalid image encoding.');return bytes;
}
async function localImage({cwd,prompt,dynoExecutable}){
 if(!dynoExecutable?.startsWith('/')) throw new Error('Local image CLI is not configured.');
 const promptFile=join(cwd,'prompt.txt');await writeFile(promptFile,prompt,{mode:0o600});
 const output=join(cwd,'output');
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(dynoExecutable,['--json','media','generate','--prompt-file',promptFile,'--output-dir',output,'--width','512','--height','512','--steps','40','--seed','42','--deadline-secs','600'],{cwd,env:codexEnvironment(dynoExecutable),stdio:['ignore','pipe','pipe']});
  let size=0;const parts=[];const timer=setTimeout(()=>child.kill('SIGTERM'),750000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>128*1024)child.kill('SIGKILL');else parts.push(chunk);});child.stderr.on('data',()=>{});
  child.once('error',()=>reject(new Error('Local image process could not start.')));child.once('close',code=>{clearTimeout(timer);resolve({code,output:Buffer.concat(parts).toString('utf8')});});
 });
 if(result.code===3) return null;
 if(result.code!==0) throw new Error('Local image generation failed.');
 const files=(await readdir(output,{recursive:true})).filter(name=>/\.(png|jpe?g|webp)$/iu.test(name));
 if(files.length!==1)throw new Error('Local output does not identify one image.');return boundedFile(join(output,files[0]),cwd,0);
}
function receiptPath(root,id){if(!validID(id))throw new Error('Invalid image request ID.');return join(root,'images',id,'receipt.json');}
async function writeReceipt(path,value){const temp=`${path}.${randomUUID()}`;await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temp,path);}
export async function imageReceipt(root,id,pair){
 const path=receiptPath(root,id), value=JSON.parse(await readFile(path,'utf8'));
 if(value.ghost_id!==pair.ghost_id||value.conversation_id!==pair.conversation_id)throw new Error('Image outside the selected conversation.');
 if(value.state!=='completed')return activeImages.has(path)?{...value,state:'running'}:value;
 const bytes=await boundedFile(join(dirname(path),value.file),dirname(path),0);
 if(hash(bytes)!==value.digest)throw new Error('Image artifact integrity mismatch.');
 return {...value,image:{base64:bytes.toString('base64'),mime:magic(bytes)}};
}
export async function generateImage({root,id,pair,provider,prompt,granted,executable,dynoExecutable,background=false,generateNative=nativeImage,generateMiniMax=miniMaxImage,generateLocal=localImage}){
 const path=receiptPath(root,id);
 if(!['codex','minimax','local'].includes(provider)||typeof prompt!=='string'||!prompt.trim()||prompt.length>1500||(provider!=='local'&&!granted))throw new Error('Image provider, prompt or conversation consent is invalid.');
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const intent={id,...pair,provider,prompt_digest:hash(prompt),state:'effect_unknown',created_at_ms:Date.now()};
 try {await writeFile(path,JSON.stringify(intent),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const previous=await imageReceipt(root,id,pair);if(previous.provider!==provider||previous.prompt_digest!==intent.prompt_digest)throw new Error('Image request ID conflict.');return previous;}
 const cwd=await mkdtemp(join(dirname(path),'work-'));
 const finish=async()=>{
 try {
  const bytes=provider==='codex'?await generateNative({cwd,prompt,executable}):provider==='minimax'?await generateMiniMax(root,prompt):await generateLocal({cwd,prompt,dynoExecutable});
  if(bytes===null){const blocked={...intent,state:'blocked',reason_code:'local_resource_gate'};await writeReceipt(path,blocked);return blocked;}
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_IMAGE||!magic(bytes))throw new Error('Invalid image output.');
  const file=`image${magic(bytes)==='image/png'?'.png':magic(bytes)==='image/jpeg'?'.jpg':'.webp'}`;
  await writeFile(join(dirname(path),file),bytes,{mode:0o600,flag:'wx'});
  await writeReceipt(path,{...intent,state:'completed',file,digest:hash(bytes),byte_length:bytes.length});
  return imageReceipt(root,id,pair);
 }catch(error){
  const nativeFailure=['image_native_request','image_native_paths','image_native_identity','image_native_boundary'].includes(error.code);
  const unknown={...intent,reason_code:'generation_unconfirmed',...(nativeFailure?{diagnostic:{phase:error.code,...error.diagnostic}}:{})};await writeReceipt(path,unknown);return unknown;
 }finally{activeImages.delete(path);await rm(cwd,{recursive:true,force:true});}
 };
 activeImages.add(path);
 if(background){void finish().catch(()=>{activeImages.delete(path);});return {...intent,state:'running'};}
 return finish();
}
export async function imageOperation({root,input,configuration,executable,dynoExecutable}) {
 const allowed=new Set(['operation','id','ghost_id','conversation_id','provider','prompt','allow_external']);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key))||!validID(input.id)||!validID(input.ghost_id)||!validID(input.conversation_id))throw new Error('Invalid image operation.');
 const pair={ghost_id:input.ghost_id,conversation_id:input.conversation_id};
 if(input.operation==='read')return imageReceipt(root,input.id,pair);
 if(input.operation!=='generate')throw new Error('Unsupported image operation.');
 const provider=input.provider??configuration.settings.image_provider;
 if(provider==='minimax'&&!configuration.settings.credentials?.minimax)throw new Error('Register the MiniMax API key first.');
 const granted=input.allow_external===true; // Explicit generation sends only this prompt, never conversation history.
 return generateImage({root,id:input.id,pair,provider,prompt:input.prompt,granted,executable,dynoExecutable,background:true});
}
