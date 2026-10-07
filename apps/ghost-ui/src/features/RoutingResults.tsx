import {useState} from 'react';
import {ArrowUpRight,FileText} from 'lucide-react';
import {Modal} from '../components/Modal';
import {routingResultLabel} from '../client/routingResults';
import type {RoutingExecutionResult} from '../client/routingResults';
import type {RoutingCapability} from '../client/routingTypes';
import type {Snapshot} from '../client/types';
export function RoutingResultContent({result,capability}:{result:RoutingExecutionResult;capability:RoutingCapability|undefined}) {
 const verified=result.current&&result.status==='finished_verified'&&result.verified&&capability?.verified_completion_report===true;
 const restricted = !verified && capability?.external_mutation_dispatch === false && Boolean(capability.unsupported_bound_mutation_tools?.length);
 return <article className="routing-execution-result" data-routing-result={result.id} data-current-result={result.current}>
  <p className="routing-result-state">{routingResultLabel(result,capability)}</p>
  {restricted&&<p className="routing-execution-limitation" role="status">현재 맡긴 일에서는 원격 일정이나 외부 서비스의 변경을 지원하지 않습니다. 로컬 파일과 기록의 저장 근거만 확인할 수 있습니다.</p>}
  {verified&&<p className="field-help">파일이나 기록의 저장 근거가 확인됐습니다. 요청 내용은 아래 결과에서 확인할 수 있습니다.</p>}
  {result.model_output&&<div className="routing-result-output">{result.model_output}</div>}
  {result.artifacts.length>0&&<div className="routing-result-artifacts"><h3>결과 자료</h3>{result.artifacts.map(path=><p key={path}>{path}</p>)}</div>}
  {result.receipts.length>0&&<p className="field-help">실행 기록 {result.receipts.length}개{capability?.verified_completion_report===true&&<> · 근거 확인 {result.receipts.filter(r=>r.verified).length}개</>}</p>}
  <details className="routing-result-source"><summary>요청과 실행 기록</summary><small>요구사항 {result.work_revision}판 · 결정 {result.decision_revision}판</small>{result.source_fragments.map(f=><p key={f.segment_id}>{f.text}</p>)}</details>
 </article>;
}
export function RoutingCompletionInbox({snapshot,connected=true}:{snapshot:Snapshot;connected?:boolean}) {
 const [selectedId,setSelectedId]=useState(''),capability=snapshot.capabilities.routing as RoutingCapability|undefined;
 if(!connected||capability?.runtime_dispatch!==true||!snapshot.routing_results?.completion_outbox.length)return null;
 const rows=snapshot.routing_results.completion_outbox.slice().sort((a,b)=>b.updated_ms-a.updated_ms),selected=rows.find(r=>r.id===selectedId);
 return <><section className="routing-completion-inbox" aria-label="저장된 과업 결과"><h2>과업 결과</h2>{rows.map(result=><article className="inbox-item" key={result.id} data-completion-result={result.id}><FileText size={22}/><div><span className="eyeline">{snapshot.profiles.find(p=>p.id===result.profile_id)?.name??'담당 Ghost'} · {routingResultLabel(result,capability)}</span><h2>{result.source_fragments[0]?.text||'맡긴 작업'}</h2><button className="button secondary" onClick={()=>setSelectedId(result.id)}>결과 확인<ArrowUpRight size={14}/></button></div></article>)}</section>{selected&&<Modal title="과업 결과" onClose={()=>setSelectedId('')}><RoutingResultContent result={selected} capability={capability}/></Modal>}</>;
}
