import {RoutingResultContent} from './RoutingResults';
import {resultMatchesWork,bindingMatchesWork,routingBindingLabel} from '../client/routingResults';
import type {RoutingExecutionResult,RoutingExecutionBinding,RoutingObservation} from '../client/routingResults';
import { useEffect, useState } from 'react';
import { CircleAlert, RefreshCw, ArrowUpRight } from 'lucide-react';
import { Modal } from '../components/Modal';
import type { Profile } from '../client/types';
import type { AdmissionView, RoutingCapability, RoutingEntry, RoutingView, Work, WorkTarget } from '../client/routingTypes';
import type { RoutingClient } from '../client/routingClient';
import './routing.css';
export interface RoutingConnection { client: RoutingClient; capability: RoutingCapability; inputAvailable?: boolean }
export function admissionSummary(view: AdmissionView) {
 const created = new Set(view.admission.items.filter(i => i.operation.type === 'new' && i.work_id).map(i => i.work_id));
 const amended = new Set(view.admission.items.filter(i => i.operation.type === 'amend' && i.work_id).map(i => i.work_id));
 const unresolved = view.admission.items.filter(i => i.operation.type === 'clarify' && !view.resolutions.some(r => r.source_admission_id === view.admission.id && r.source_segment_id === i.segment_id));
 return { created: created.size, amended: amended.size, unresolved };
}
export function useRoutingConversation(connection: RoutingConnection | undefined, entry: RoutingEntry, refreshKey: unknown) {
 const [state, setState] = useState<{ entryKey: string; view: RoutingView } | null>(null);
 const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
 const entryKey = `${entry.entry_profile_id}:${entry.conversation_id}`;
 useEffect(() => {
  let active = true;
  if (!connection?.capability.admission || !entry.conversation_id) { setState(null); return; }
  connection.client.view(entry).then(view => { if (active) { setState({ entryKey, view }); setError(''); } }).catch(e => {
   if (active) { setState(null); setError(e instanceof Error ? e.message : '맡긴 일을 불러오지 못했습니다.'); }
  });
  return () => { active = false; };
 }, [connection, entryKey, refreshKey, attempt]);
 return { view: connection?.capability.admission && state?.entryKey === entryKey ? state.view : null, error, refresh: () => setAttempt(a => a + 1) };
}
export interface ClarificationChoice { source_admission_id: string; source_segment_id: string; group_anchor_segment_id: string; expected_input_hash: string; target: WorkTarget; text: string }
export function RoutingConversation({ view, error, onRetry, onOpenWork, onClarify, answering, clarificationError }: { view: RoutingView | null; error: string; onRetry: () => void; onOpenWork: (id: string) => void; onClarify?: (choice: ClarificationChoice) => void; answering?: string; clarificationError?: { source: string; message: string } }) {
 const [answerExtras, setAnswerExtras] = useState<Record<string, string>>({});
 if (error) return <div className="routing-read-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button className="text-button" onClick={onRetry}><RefreshCw size={13}/>다시 확인</button></div>;
 if (!view?.admissions.length) return null;
 const works = new Map(view.works.map(w => [w.id, w]));
 return <section className="routing-conversation" aria-label="요청과 확인 질문">
  {view.admissions.map(receipt => {
   const a = receipt.admission, summary = admissionSummary(receipt);
   const linked = [...new Set(a.items.flatMap(i => i.work_id ? [i.work_id] : []))];
   return <article className="routing-admission" key={a.id} data-admission-id={a.id}>
    <div className="message message-user"><div className="user-bubble">{a.input.text}</div></div>
    <div className="routing-receipt">
     <p>{summary.created && summary.amended ? `기존 ${summary.amended}개 요청을 바꾸고, 새 일 ${summary.created}개를 접수했습니다.` : summary.created ? `${summary.created}개 일을 접수했습니다.` : summary.amended ? `${summary.amended}개 일의 요청을 바꿨습니다.` : a.input.resolves.length ? '확인한 대상에 답변을 연결했습니다.' : '요청을 저장했습니다.'}</p>
     {linked.length > 0 && <div className="routing-links">{linked.map(id => <button type="button" key={id} onClick={() => onOpenWork(id)} className="routing-work-chip" data-work-link={id}>{works.get(id)?.title ?? '작업 보기'}<ArrowUpRight size={11}/></button>)}</div>}
    </div>
    {a.items.filter(i => i.operation.type === 'clarify').map(i => {
     if (i.operation.type !== 'clarify') return null;
     const key = `${a.id}:${i.segment_id}`;
     const resolved = receipt.resolutions.some(r => r.source_admission_id === a.id && r.source_segment_id === i.segment_id);
     return <div className={`routing-clarification ${resolved ? 'answered' : ''}`} key={i.segment_id} data-source-admission={a.id} data-source-segment={i.segment_id}>
      {resolved ? <p className="routing-resolved">대상을 확인했습니다.</p> : <>
       <p>{i.operation.question}</p>
       {onClarify && <details className="routing-answer-extra"><summary>답변에 다른 요청 덧붙이기</summary><label>답변에 덧붙일 요청<textarea aria-label="답변에 덧붙일 요청" rows={2} maxLength={2048} value={answerExtras[key] ?? ''} disabled={answering === key} placeholder="예: 새 할 일도 하나 저장해 줘." onChange={event => setAnswerExtras(previous => ({ ...previous, [key]: event.target.value }))}/></label><small>아래에서 대상을 선택하면 답변과 함께 전송합니다.</small></details>}
       <div className="routing-choices">{i.operation.candidates.map(target => <button type="button" key={target.work_id} disabled={!onClarify || answering === key} data-clarification-target={target.work_id} onClick={() => onClarify?.({ source_admission_id: a.id, source_segment_id: i.segment_id, group_anchor_segment_id: i.group_anchor_segment_id, expected_input_hash: a.input_hash, target, text: `${works.get(target.work_id)?.title ?? '선택한 작업'} 쪽이에요.${answerExtras[key]?.trim() ? '\n' + answerExtras[key] : ''}` })}>{works.get(target.work_id)?.title ?? '작업 확인'}</button>)}</div>
       {summary.amended > 0 && <small>다른 정정은 접수되었습니다.</small>}
       {clarificationError?.source === key && <p className="routing-choice-error" role="alert">{clarificationError.message}</p>}
      </>}
     </div>;
    })}
   </article>;
  })}
 </section>;
}
export function RoutingWorkList({ view, profileId, profiles, onOpenWork }: { view: RoutingView; profileId: string; profiles: Profile[]; onOpenWork: (id: string) => void }) {
 return <div className="routing-work-list" aria-label="맡긴 일">{view.works.map(w => <button type="button" key={w.id} className="routing-work-row" data-work-id={w.id} onClick={() => onOpenWork(w.id)}><span><strong>{w.title}</strong>{w.responsible_profile_id !== profileId && <small>{profiles.find(p => p.id === w.responsible_profile_id)?.name ?? '담당 Ghost'}</small>}</span><span className="routing-admission-state">{w.status === 'cancel_requested' ? '취소 요청' : '접수'}</span><ArrowUpRight size={13}/></button>)}</div>;
}
export function RoutingWorkDetail({ work, view, capability, results = [], bindings = [], observations = [], effectObservations = [], onClose }: { work: Work; view: RoutingView; capability: RoutingCapability; results?:RoutingExecutionResult[]; bindings?:RoutingExecutionBinding[]; observations?:RoutingObservation[];effectObservations?:RoutingObservation[]; onClose: () => void }) {
 const [tab, setTab] = useState<'request' | 'history' | 'result'>('request');
 const currentResults=capability.runtime_dispatch?results.filter(r=>resultMatchesWork(r,work)):[],historicalResults=capability.runtime_dispatch?results.filter(r=>r.work_id===work.id&&!resultMatchesWork(r,work)):[];
 const currentBindings=capability.runtime_dispatch?bindings.filter(b=>bindingMatchesWork(b,work)):[];
 const preservedObservations=capability.immutable_evidence?observations.filter(e=>e.work_id===work.id):[],preservedEffects=capability.immutable_evidence?effectObservations.filter(e=>e.work_id===work.id):[];
 return <Modal title={work.title} onClose={onClose} className="routing-work-detail">
  <div className="routing-detail-tabs" role="tablist" aria-label="맡긴 일 상세">{([{id:'request',label:'요청'},{id:'history',label:'작업 기록'},{id:'result',label:'결과'}] as const).map(t => <button role="tab" id={`work-tab-${t.id}`} aria-controls={`work-panel-${t.id}`} aria-selected={tab===t.id} key={t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
  <section className="routing-detail-body" role="tabpanel" id={`work-panel-${tab}`} aria-labelledby={`work-tab-${tab}`}>
   {tab === 'request' && <><p>{work.scope}</p><small>{work.status === 'cancel_requested' ? '취소 요청이 저장됐습니다. 실제 중단 결과는 아직 확인되지 않았습니다.' : '요청이 저장되어 있습니다.'}</small></>}
   {tab === 'history' && view.decisions.filter(d => d.work_id === work.id).map(d => <article className="routing-decision" key={d.id}><h3>{d.supersedes === null ? '처음 맡긴 요청' : '요청 정정'}<small>요구사항 {d.revision}판</small></h3>{d.source_fragments.map(f => <p key={f.segment_id}>{f.text}</p>)}<details><summary>원문 위치</summary>{d.source_fragments.map(f => <small className="routing-source" key={f.segment_id}>{f.segment_id} · {f.start_byte}–{f.end_byte} bytes</small>)}</details></article>)}
   {tab==='history'&&(preservedObservations.length>0||preservedEffects.length>0)&&<details className="routing-result-source" data-preserved-observations><summary>보존된 상태 기록</summary><p>상태 관측 {preservedObservations.length}개 · 도구 출력 관측 {preservedEffects.length}개</p><small>관측 당시의 기록이 보존되어 있습니다. 현재 요청의 결과와 저장 근거는 결과 탭에서 확인할 수 있습니다.</small></details>}
   {tab === 'result' && <>{currentResults.length?currentResults.map(result=><RoutingResultContent key={result.id} result={result} capability={capability}/>):<p className="routing-result-empty">{!capability.runtime_dispatch ? '아직 결과가 없습니다. 현재 연결은 요청 저장까지만 지원합니다.' : '확인할 수 있는 결과가 아직 없습니다.'}</p>}{currentBindings.length>0&&<details className="routing-result-source"><summary>실행 연결</summary>{currentBindings.map(binding=><p key={binding.id} data-routing-binding={binding.id}>요구사항 {binding.work_revision}판 · {routingBindingLabel(binding)}</p>)}<small>실행 연결은 완료 결과를 뜻하지 않습니다.</small></details>}{historicalResults.length>0&&<details className="routing-result-history"><summary>이전 요청의 결과</summary>{historicalResults.map(result=><RoutingResultContent key={result.id} result={{...result,current:false}} capability={capability}/>)}</details>}</>}
  </section>
 </Modal>;
}
