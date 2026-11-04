import { useEffect, useState } from 'react';
type ImageResult = { state?: 'running' | 'completed' | 'blocked'; image?: { mime: string; base64: string } };
// 부트스트랩(모드·CSRF)은 세션당 고정이므로 폴링 read가 매번 다시 요청하지 않도록 캐시한다.
let bootstrap: Promise<{ mode: string; csrf: string }> | undefined;
const loadBootstrap = () => bootstrap ??= fetch('/ghost-api/bootstrap', { cache: 'no-store' }).then(r => {
  if (!r.ok) throw new Error('연결 정보를 확인하지 못했습니다.');
  return r.json();
}).catch(error => { bootstrap = undefined; throw error; });
const statusText = (result: ImageResult | undefined) => {
  if (result?.state === 'running') return '이미지를 만들고 있습니다.';
  if (result?.state === 'blocked') return '로컬 자원 보호 조건으로 생성이 차단됐습니다.';
  return '생성 여부를 확인해야 합니다. 같은 요청으로 결과만 조회합니다.';
};
export function ImageComposer({pair}: {pair:{ghost_id:string;conversation_id:string}}) {
 const key=`ghost-image:${pair.ghost_id}/${pair.conversation_id}`;
 const [prompt,setPrompt]=useState(''),[provider,setProvider]=useState('codex'),[id,setID]=useState(()=>localStorage.getItem(key)??''),[result,setResult]=useState<ImageResult>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const request=async(body:Record<string,unknown>)=>{
  const bootstrap=await loadBootstrap();
  const response=await fetch('/ghost-api/inference/images',{method:'POST',headers:{'Content-Type':'application/json','X-Ghost-UI-CSRF':bootstrap.csrf},body:JSON.stringify({...body,...pair}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error(typeof data.error==='string'?data.error:'생성 결과를 확인하지 못했습니다. 같은 요청의 결과를 다시 확인해 주세요.');return data.result;
 };
 const read=async()=>{if(!id)return;try{setResult(await request({operation:'read',id}));setError('');}catch(e){setError((e as Error).message);}};
 useEffect(()=>{if(!id)return;void read();},[id]);
 useEffect(()=>{if(result?.state!=='running')return;const timer=setInterval(()=>void read(),5000);return()=>clearInterval(timer);},[result?.state,id]);
 const reset=()=>{localStorage.removeItem(key);setID('');setResult(undefined);};
 const generate=async()=>{if(busy||id)return;const next=crypto.randomUUID();localStorage.setItem(key,next);setID(next);setBusy(true);setError('');try{setResult(await request({operation:'generate',id:next,provider,prompt,allow_external:true}));}catch(e){reset();setError((e as Error).message);}finally{setBusy(false);}};
 const url=result?.image?`data:${result.image.mime};base64,${result.image.base64}`:null;
 return <section><h3>이미지 만들기</h3><div className="form-stack">
  <select aria-label="이미지 생성 제공자" value={provider} disabled={!!id} onChange={e=>setProvider(e.target.value)}><option value="codex">Codex · 같은 OAuth</option><option value="minimax">MiniMax · 등록한 API 키</option><option value="local">로컬 · Dyno 평가</option></select>
  <p className="field-help">선택한 제공자에 이미지 설명만 보냅니다. 대화 이력은 포함하지 않습니다.</p>
  <textarea aria-label="이미지 설명" placeholder="만들고 싶은 이미지를 설명하세요" maxLength={1500} value={prompt} disabled={!!id} onChange={e=>setPrompt(e.target.value)}/>
  {!id&&<button className="button secondary" disabled={busy||!prompt.trim()} onClick={()=>void generate()}>이미지 생성</button>}
  {id&&!url&&<><p>{statusText(result)}</p><button className="text-button" onClick={()=>void read()}>결과 확인</button></>}
  {url&&<img src={url} alt="요청한 생성 이미지" style={{maxWidth:'100%',maxHeight:480,objectFit:'contain'}}/>}
  {id&&(!result||result.state==='completed'||result.state==='blocked')&&<button className="text-button" onClick={reset}>새 이미지</button>}
  {error&&<p role="alert">{error}</p>}
 </div></section>;
}
