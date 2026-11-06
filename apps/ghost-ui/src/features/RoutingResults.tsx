import { DetailDialog } from '../components/DetailDialog';
import { uiTerms } from '../uiText';
import {useState} from 'react';
import {ArrowUpRight,FileText} from 'lucide-react';
import {Button} from '@garden/ui';
import { WorkRow } from './WorkViews';
import { Modal } from '../components/Modal';
import {routingResultLabel} from '../client/routingResults';
import type {RoutingExecutionResult} from '../client/routingResults';
import type {RoutingCapability} from '../client/routingTypes';
import type {Snapshot} from '../client/types';
export function RoutingResultContent({result,capability}:{result:RoutingExecutionResult;capability:RoutingCapability|undefined}) {
 const verified=result.current&&result.status==='finished_verified'&&result.verified&&capability?.verified_completion_report===true;
 const restricted = !verified && capability?.external_mutation_dispatch === false && Boolean(capability.unsupported_bound_mutation_tools?.length);
 return <article className="grid min-w-0 gap-3" data-routing-result={result.id} data-current-result={result.current}>
  <p className="m-0 text-caption text-ink-2">{routingResultLabel(result,capability)}</p>
  {restricted&&<p className="m-0 text-caption text-ink" role="status">현재 맡긴 일에서는 원격 일정이나 외부 서비스의 변경을 지원하지 않습니다. 로컬 파일과 기록의 저장 근거만 확인할 수 있습니다.</p>}
  {verified&&<p className="m-0 text-caption text-ink-2">파일이나 기록의 저장 근거가 확인됐습니다. 요청 내용은 아래 결과에서 확인할 수 있습니다.</p>}
  {result.model_output&&<div className="whitespace-pre-wrap [overflow-wrap:anywhere] text-ui leading-relaxed">{result.model_output}</div>}
  {result.artifacts.length>0&&<div className="grid gap-2"><h3 className="m-0 text-caption font-medium">결과 자료</h3>{result.artifacts.map(path=><p className="my-1 text-caption [overflow-wrap:anywhere]" key={path}>{path}</p>)}</div>}
  {result.receipts.length>0&&<p className="m-0 text-caption text-ink-2">실행 기록 {result.receipts.length}개{capability?.verified_completion_report===true&&<> · 근거 확인 {result.receipts.filter(r=>r.verified).length}개</>}</p>}
  <DetailDialog title="요청과 실행 기록"><small className="block">요구사항 {result.work_revision}판 · 결정 {result.decision_revision}판</small>{result.source_fragments.map(f=><p className="my-1 text-caption [overflow-wrap:anywhere]" key={f.segment_id}>{f.text}</p>)}</DetailDialog>
 </article>;
}
export function RoutingCompletionInbox({snapshot,connected=true}:{snapshot:Snapshot;connected?:boolean}) {
 const [selectedId,setSelectedId]=useState(''),capability=snapshot.capabilities.routing as RoutingCapability|undefined;
 if(!connected||capability?.runtime_dispatch!==true||!snapshot.routing_results?.completion_outbox.length)return null;
 const rows=snapshot.routing_results.completion_outbox.slice().sort((a,b)=>b.updated_ms-a.updated_ms),selected=rows.find(r=>r.id===selectedId);
 return <><section className="mt-8 grid gap-1" aria-label={`저장된 ${uiTerms.workResults}`}><h2 className="flex flex-wrap items-center gap-2 text-ui font-semibold text-ink">{uiTerms.workResults}</h2>{rows.map(result=><WorkRow icon={<FileText className="size-5"/>} key={result.id} data-completion-result={result.id}
   title={result.source_fragments[0]?.text||uiTerms.work}
   owner={`${snapshot.profiles.find(p=>p.id===result.profile_id)?.name??'담당 Ghost'} · ${routingResultLabel(result,capability)}`}
   action={<Button variant="outline" size="sm" onClick={()=>setSelectedId(result.id)}>결과 확인<ArrowUpRight className="size-3.5"/></Button>}
 />)}</section>{selected&&<Modal title={uiTerms.workResults} onClose={()=>setSelectedId('')}><RoutingResultContent result={selected} capability={capability}/></Modal>}</>;
}
