import { DetailDialog } from '../components/DetailDialog';
import {RoutingResultContent} from './RoutingResults';
import {resultMatchesWork,bindingMatchesWork,routingBindingLabel} from '../client/routingResults';
import type {RoutingExecutionResult,RoutingExecutionBinding,RoutingObservation} from '../client/routingResults';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Button, GConversationMessage, InlineError, Tabs, TabsContent, TabsList, TabsTrigger } from '@garden/ui';
import { WorkRow } from './WorkViews';
import { Modal } from '../components/Modal';
import type { Profile } from '../client/types';
import type { AdmissionView, RoutingCapability, RoutingEntry, RoutingView, Work, WorkTarget } from '../client/routingTypes';
import type { RoutingClient } from '../client/routingClient';
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
 if (error) return <InlineError className="py-2.5" onRetry={onRetry} retryLabel="다시 확인">{error}</InlineError>;
 if (!view?.admissions.length) return null;
 const works = new Map(view.works.map(w => [w.id, w]));
 return <section className="mt-3 mb-6 grid gap-7" aria-label="요청과 확인 질문">
  {view.admissions.map(receipt => {
   const a = receipt.admission, summary = admissionSummary(receipt);
   const linked = [...new Set(a.items.flatMap(i => i.work_id ? [i.work_id] : []))];
   return <article className="grid gap-3.5" key={a.id} data-admission-id={a.id}>
    <GConversationMessage role="user" label="나">{a.input.text}</GConversationMessage>
    <div className="px-1 text-body leading-[1.75]">
     <p className="m-0">{summary.created && summary.amended ? `기존 ${summary.amended}개 요청을 바꾸고, 새 일 ${summary.created}개를 접수했습니다.` : summary.created ? `${summary.created}개 일을 접수했습니다.` : summary.amended ? `${summary.amended}개 일의 요청을 바꿨습니다.` : a.input.resolves.length ? '확인한 대상에 답변을 연결했습니다.' : '요청을 저장했습니다.'}</p>
     {linked.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{linked.map(id => <Button type="button" variant="outline" size="sm" key={id} onClick={() => onOpenWork(id)} data-work-link={id}>{works.get(id)?.title ?? '작업 보기'}<ArrowUpRight className="size-3"/></Button>)}</div>}
    </div>
    {a.items.filter(i => i.operation.type === 'clarify').map(i => {
     if (i.operation.type !== 'clarify') return null;
     const key = `${a.id}:${i.segment_id}`;
     const resolved = receipt.resolutions.some(r => r.source_admission_id === a.id && r.source_segment_id === i.segment_id);
     return <div className={`px-1 ${resolved ? '' : 'grid'}`} key={i.segment_id} data-source-admission={a.id} data-source-segment={i.segment_id}>
      {resolved ? <p className="m-0 mt-2 block text-caption text-ink-2">대상을 확인했습니다.</p> : <>
       <p className="m-0 mb-2.5 text-body leading-[1.75]">{i.operation.question}</p>
       {onClarify && <div className="my-1.5 text-caption text-ink-2"><label className="mt-2 grid gap-1">답변에 덧붙일 요청<textarea aria-label="답변에 덧붙일 요청" rows={2} maxLength={2048} value={answerExtras[key] ?? ''} disabled={answering === key} placeholder="예: 새 할 일도 하나 저장해 줘." onChange={event => setAnswerExtras(previous => ({ ...previous, [key]: event.target.value }))} className="w-full resize-y text-caption"/></label><small className="mt-2 block">아래에서 대상을 선택하면 답변과 함께 전송합니다.</small></div>}
       <div className="flex flex-wrap gap-2">{i.operation.candidates.map(target => <Button type="button" variant="outline" size="sm" key={target.work_id} disabled={!onClarify || answering === key} data-clarification-target={target.work_id} onClick={() => onClarify?.({ source_admission_id: a.id, source_segment_id: i.segment_id, group_anchor_segment_id: i.group_anchor_segment_id, expected_input_hash: a.input_hash, target, text: `${works.get(target.work_id)?.title ?? '선택한 작업'} 쪽이에요.${answerExtras[key]?.trim() ? '\n' + answerExtras[key] : ''}` })}>{works.get(target.work_id)?.title ?? '작업 확인'}</Button>)}</div>
       {summary.amended > 0 && <small className="mt-2 block text-caption text-ink-2">다른 정정은 접수되었습니다.</small>}
       {clarificationError?.source === key && <p className="m-0 mt-2.5 text-caption text-danger" role="alert">{clarificationError.message}</p>}
      </>}
     </div>;
    })}
   </article>;
  })}
 </section>;
}
export function RoutingWorkList({ view, profileId, profiles, onOpenWork }: { view: RoutingView; profileId: string; profiles: Profile[]; onOpenWork: (id: string) => void }) {
 return <div className="grid" aria-label="맡긴 일">{view.works.map(w => <WorkRow key={w.id} data-work-id={w.id}
   title={w.title}
   owner={w.responsible_profile_id !== profileId ? profiles.find(p => p.id === w.responsible_profile_id)?.name ?? '담당 Ghost' : undefined}
   status={{ label: w.status === 'cancel_requested' ? '취소 요청' : '접수', tone: w.status === 'cancel_requested' ? 'warning' : 'default' }}
   onClick={() => onOpenWork(w.id)}
 />)}</div>;
}
export function RoutingWorkDetail({ work, view, capability, results = [], bindings = [], observations = [], effectObservations = [], onClose }: { work: Work; view: RoutingView; capability: RoutingCapability; results?:RoutingExecutionResult[]; bindings?:RoutingExecutionBinding[]; observations?:RoutingObservation[];effectObservations?:RoutingObservation[]; onClose: () => void }) {
 const [tab, setTab] = useState<'request' | 'history' | 'result'>('request');
 const currentResults=capability.runtime_dispatch?results.filter(r=>resultMatchesWork(r,work)):[],historicalResults=capability.runtime_dispatch?results.filter(r=>r.work_id===work.id&&!resultMatchesWork(r,work)):[];
 const currentBindings=capability.runtime_dispatch?bindings.filter(b=>bindingMatchesWork(b,work)):[];
 const preservedObservations=capability.immutable_evidence?observations.filter(e=>e.work_id===work.id):[],preservedEffects=capability.immutable_evidence?effectObservations.filter(e=>e.work_id===work.id):[];
 return <Modal title={work.title} onClose={onClose}>
  <Tabs value={tab} onValueChange={value => setTab(value as typeof tab)} className="gap-4">
   <TabsList className="w-full border-b border-line" aria-label="맡긴 일 상세">{([{id:'request',label:'요청'},{id:'history',label:'작업 기록'},{id:'result',label:'결과'}] as const).map(t => <TabsTrigger value={t.id} key={t.id} className="flex-1">{t.label}</TabsTrigger>)}</TabsList>
   <TabsContent value="request" className="text-body leading-[1.8]"><><p className="m-0 mb-3 [overflow-wrap:anywhere]">{work.scope}</p><small className="text-caption text-ink-2">{work.status === 'cancel_requested' ? '취소 요청이 저장됐습니다. 실제 중단 결과는 아직 확인되지 않았습니다.' : '요청이 저장되어 있습니다.'}</small></></TabsContent>
   <TabsContent value="history" className="text-body leading-[1.8]"><div className="divide-y divide-line">{view.decisions.filter(d => d.work_id === work.id).map(d => <article className="py-4 first:pt-0 last:pb-0" key={d.id}><h3 className="m-0 mb-2 flex flex-wrap justify-between gap-2.5 text-ui font-medium"><span>{d.supersedes === null ? '처음 맡긴 요청' : '요청 정정'}</span><small className="font-normal text-caption text-ink-2">요구사항 {d.revision}판</small></h3>{d.source_fragments.map(f => <p className="my-1 [overflow-wrap:anywhere]" key={f.segment_id}>{f.text}</p>)}<DetailDialog title="원문 위치" className="mt-2">{d.source_fragments.map(f => <small className="block text-caption text-ink-2" key={f.segment_id}>{f.segment_id} · {f.start_byte}–{f.end_byte} bytes</small>)}</DetailDialog></article>)}</div>
    {(preservedObservations.length>0||preservedEffects.length>0)&&<div className="mt-4 grid gap-1 py-2.5 text-caption text-ink-2" data-preserved-observations><strong className="text-caption text-ink">보존된 상태 기록</strong><p className="m-0 [overflow-wrap:anywhere]">상태 관측 {preservedObservations.length}개 · 도구 출력 관측 {preservedEffects.length}개</p><small>관측 당시의 기록이 보존되어 있습니다. 현재 요청의 결과와 저장 근거는 결과 탭에서 확인할 수 있습니다.</small></div>}</TabsContent>
   <TabsContent value="result" className="text-body leading-[1.8]"><>{currentResults.length?currentResults.map(result=><RoutingResultContent key={result.id} result={result} capability={capability}/>):<p className="m-0 text-caption text-ink-2">{!capability.runtime_dispatch ? '아직 결과가 없습니다. 현재 연결은 요청 저장까지만 지원합니다.' : '확인할 수 있는 결과가 아직 없습니다.'}</p>}{currentBindings.length>0&&<div className="mt-4 grid gap-1 py-2.5 text-caption text-ink-2"><strong className="text-caption text-ink">실행 연결</strong>{currentBindings.map(binding=><p className="m-0 [overflow-wrap:anywhere]" key={binding.id} data-routing-binding={binding.id}>요구사항 {binding.work_revision}판 · {routingBindingLabel(binding)}</p>)}<small>실행 연결은 완료 결과를 뜻하지 않습니다.</small></div>}{historicalResults.length>0&&<DetailDialog title="이전 요청의 결과" className="mt-6 border-t border-line pt-4">{historicalResults.map(result=><RoutingResultContent key={result.id} result={{...result,current:false}} capability={capability}/>)}</DetailDialog>}</></TabsContent>
  </Tabs>
 </Modal>;
}
