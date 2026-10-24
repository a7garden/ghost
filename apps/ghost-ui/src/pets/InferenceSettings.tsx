import { useEffect, useState } from 'react';
import { ImageComposer } from './ImageComposer';

type Selection = { provider: string; model: string; effort: string };
type Provider = { id: string; name: string; auth: string; models: string[]; efforts: string[]; default_model: string; default_effort: string; image: boolean };
type Configuration = { settings: { version: number; default: Selection; conversations: Record<string, Selection>; external_grants: Record<string,string[]>; credentials: Record<string,boolean>; image_provider: string }; providers: Provider[] };
export async function inferenceRequest(body?: Record<string,unknown>): Promise<Configuration> {
  const bootstrapResponse=await fetch('/ghost-api/bootstrap',{cache:'no-store'});
  if(!bootstrapResponse.ok) throw new Error('연결된 Ghost 호스트가 필요합니다.');
  const bootstrap=await bootstrapResponse.json();
  if(bootstrap.mode!=='live'||!bootstrap.csrf) throw new Error('연결된 Ghost 호스트가 필요합니다.');
  const response=await fetch('/ghost-api/inference/settings',{method:body?'POST':'GET',cache:'no-store',
    headers:{'Content-Type':'application/json','X-Ghost-UI-CSRF':bootstrap.csrf},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();
  if(!response.ok||value.ok!==true||!value.settings) throw new Error(typeof value.error==='string'?value.error:'모델 설정을 저장하지 못했습니다. 새로고침 후 확인해 주세요.');
  return value;
}
const effortName:Record<string,string>={off:'사용 안 함',low:'빠르게',medium:'균형',high:'깊게',xhigh:'더 깊게',max:'최대'};

export function InferenceSettings({ pair, disabled=false }: { pair?:{ghost_id:string;conversation_id:string}; disabled?:boolean }) {
  const [data,setData]=useState<Configuration>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[expanded,setExpanded]=useState(!pair);
  const [draft,setDraft]=useState<Selection>(),[allow,setAllow]=useState(false),[keys,setKeys]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
  const pairKey=pair?`${pair.ghost_id}/${pair.conversation_id}`:'';
  const [reload,setReload]=useState(0);
  useEffect(()=>{let stale=false;void (async()=>{try{const next=await inferenceRequest();if(stale)return;setData(next);setDraft(next.settings.conversations[pairKey]??next.settings.default);setError('');}catch(e){if(!stale)setError(e instanceof Error?e.message:'설정을 불러오지 못했습니다.');}})();return()=>{stale=true;};},[pairKey,reload]);
  const save=async(body:Record<string,unknown>)=>{if(!data||busy)return false;setBusy(true);setError('');setNotice('');try{const next=await inferenceRequest({version:data.settings.version,...body});setData(next);setDraft(next.settings.conversations[pairKey]??next.settings.default);setAllow(false);return true;}catch(e){setError(e instanceof Error?e.message:'저장 결과를 확인하지 못했습니다.');return false;}finally{setBusy(false);}};
  const provider=data?.providers.find(p=>p.id===draft?.provider);
  const granted=Boolean(pairKey&&draft&&data?.settings.external_grants[pairKey]?.includes(draft.provider));
  const registered=provider?.auth!=='api_key'||data?.settings.credentials[provider.id]===true;
  return <section className="inference-settings" aria-label={pair?'이 대화의 모델':'Ghost 대화 모델'}>
    {pair?<button className="button secondary" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>{draft?.model??'모델 선택'} · {effortName[draft?.effort??'high']??draft?.effort}</button>:<><h2>대화 모델</h2><p className="field-help">기본값은 Codex GPT-6 Luna입니다. 이 설정은 주 Ghost의 대화에 적용됩니다.</p></>}
    {expanded&&data&&draft&&<div className="form-stack">
      <label>제공자<select aria-label="대화 제공자" disabled={disabled||busy} value={draft.provider} onChange={e=>{const p=data.providers.find(p=>p.id===e.target.value)!;setDraft({provider:p.id,model:p.default_model,effort:p.default_effort});setAllow(false);}}>{data.providers.map(p=><option value={p.id} key={p.id} disabled={!p.models.length}>{p.name}</option>)}</select></label>
      <label>모델<select aria-label="Ghost 모델" value={draft.model} disabled={disabled||busy} onChange={e=>setDraft({...draft,model:e.target.value})}>{provider?.models.map(model=><option key={model}>{model}</option>)}</select></label>
      <label>추론 수준<select aria-label="추론 수준" value={draft.effort} disabled={disabled||busy} onChange={e=>setDraft({...draft,effort:e.target.value})}>{provider?.efforts.map(effort=><option key={effort} value={effort}>{effortName[effort]??effort}</option>)}</select></label>
      {pair&&draft.provider!=='local'&&!granted&&<label><input type="checkbox" checked={allow} onChange={e=>setAllow(e.target.checked)}/>이 대화의 기존 기록과 새 메시지를 {provider?.name}에 전송하는 것을 허용</label>}
      {pair&&granted&&<p className="field-help">이 대화의 {provider?.name} 외부 처리가 허용돼 있습니다.</p>}
      {!registered&&<p role="status">먼저 설정에서 이 제공자의 API 키를 등록해 주세요.</p>}
      <button className="button primary" disabled={disabled||busy||!registered||(!!pair&&draft.provider!=='local'&&!granted&&!allow)} onClick={()=>void save(pair?{operation:'select',...pair,selection:draft,allow_external:allow}:{operation:'set_default',selection:draft})}>{busy?'저장 중…':pair?'이 대화에 적용':'기본 모델 저장'}</button>
      {!pair&&<>
        <p className="field-help">Codex는 이 Mac의 공식 Codex CLI 로그인을 사용합니다. 별도 OpenAI API 키를 입력하지 않습니다.</p>
        {data.providers.filter(p=>p.auth==='api_key').map(p=><div key={p.id} className="model-provider"><strong>{p.name}</strong><p className="field-help">{data.settings.credentials[p.id]?'API 키 등록됨 · 실제 응답 시 권한 확인':'API 키 등록 필요'}</p><input type="password" autoComplete="off" aria-label={`${p.name} API 키`} placeholder="API 키" value={keys[p.id]??''} onChange={e=>setKeys({...keys,[p.id]:e.target.value})}/><button className="button secondary" disabled={busy||!(keys[p.id]?.length>=8)} onClick={()=>{const key=keys[p.id];void save({operation:'set_api_key',provider:p.id,api_key:key}).then(ok=>{if(ok){setKeys(current=>({...current,[p.id]:''}));setNotice(`${p.name} API 키를 저장했습니다.`);}});}}>키 저장</button></div>)}
        <label>이미지 생성<select aria-label="이미지 제공자" value={data.settings.image_provider} disabled={busy} onChange={e=>void save({operation:'image_provider',provider:e.target.value})}>{data.providers.filter(p=>p.image).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <p className="field-help">Codex 이미지는 같은 OAuth 로그인, MiniMax 이미지는 등록한 API 키를 사용합니다.</p>
      </>}
    </div>}
    {notice&&<p role="status">{notice}</p>}
    {error&&<p role="alert" className="form-error">{error}<button className="text-button" onClick={()=>setReload(n=>n+1)}>다시 확인</button></p>}
    {pair&&expanded&&<ImageComposer key={pairKey} pair={pair}/>}
  </section>;
}
