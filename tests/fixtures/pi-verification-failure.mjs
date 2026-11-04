// Controlled model, actual Pi SDK and production Host converter. No endpoint,
// credentials lookup, verifier invocation, or acceptance authority is used.
import {createInterface} from 'node:readline';
import {openGhostRuntime} from '../../apps/ghost-durable/src/runtime.js';
import {createBrokerModelProvider} from '../../apps/ghost-durable/src/models.js';
import {createHostToolTransport} from '../../apps/ghost-durable/src/host-transport.js';
const [root,hostRoot,workId]=process.argv.slice(2),pending=new Map();let id=0,runtime,current=null,steps=0,report=false,chain=Promise.resolve();
const emit=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const transport=createHostToolTransport({hostRoot,callbackToken:'controlled-stdio-no-http-token',authorityEpoch:1,dispatch:request=>new Promise(resolve=>{const call=++id;pending.set(call,resolve);emit({type:'callback',id:call,request});})});
const provider=createBrokerModelProvider({modelRef:'minimax-code/MiniMax-M2.7',invoke:async request=>{
 const names=request.body.tools.map(tool=>tool.function?.name);if(names.some(name=>['source_view_list','source_view_read'].includes(name)))throw Error('Unavailable publication tools reached the actual provider request');
 let message;
 if(report){
  const text=request.body.messages.filter(message=>['system','developer'].includes(message.role)).map(message=>String(message.content)).join('\n');
  if(!text.includes('Current independent verification evidence:')||!text.includes('"status":"failed"'))throw Error('Fresh failed verdict absent from first report provider request');
  steps++;message={role:'assistant',content:'Independent verification failed; this output was not accepted.'};
 }
 else if(steps++===0)message={role:'assistant',content:null,tool_calls:[{id:'inspect-original-work',type:'function',function:{name:'work_inspect',arguments:JSON.stringify({work_id:workId})}}]};
 else {
  const result=request.body.messages.filter(message=>message.role==='tool').at(-1);const parsed=JSON.parse(result.content),view=parsed.data.independent_verification;
  if(view?.status!=='failed'||view.historical_status!=='failed'||view.accepted!==false||view.authorizes_inference_or_effects!==false)throw Error('Actual Host did not project failed independent verification');
  message={role:'assistant',content:'Independent verification failed; this output was not accepted.'};
 }
 return {id:request.id,status:200,body:{id:`controlled-${current}`,object:'chat.completion',model:request.body.model,created:1,choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}};
}});
runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:transport});emit({type:'configured'});
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.type==='callback_result'){pending.get(frame.id)?.(frame.frame);pending.delete(frame.id);return;}
 chain=chain.then(async()=>{
  if(frame.type==='stop'){await runtime.close();emit({type:'stopped'});lines.close();return;}
  if(frame.type!=='command')throw Error('Unexpected controlled frame');current=frame.command.command_id;steps=0;report=frame.command.body.method==='conversation.submit';
  const receipt=await runtime.handle(frame.command);await runtime.waitForIdle(frame.command.body.ghost_id,frame.command.body.conversation_id);emit({type:'command_result',receipt,model_calls:steps});
 }).catch(async error=>{emit({type:'failure',error_code:'controlled_verification_settlement_failed',name:error.name});await runtime.close();lines.close();process.exitCode=1;});
});
