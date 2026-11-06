import { DetailDialog } from '../components/DetailDialog';
import { useId, useState } from 'react';
import { Card, Checkbox, EmptyState, GPage, GPageHeader, GPanel, InlineError, Input, SelectField, Textarea, Button, SegmentedControl } from '@garden/ui';
import { ArrowLeft, ArrowUpRight, GitBranch, Play, Plus, Save, Square, Trash2 } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { toneFor } from '../client/types';
import type { Command, Profile, Snapshot } from '../client/types';
import { activeRunStates, edgeLabels, graphLayers, graphStateLabels, validateGraph } from '../client/orchestration';
import type { EdgeCondition, GraphInput, GraphJob, GraphNode, GraphPlan, GraphRun } from '../client/orchestration';

type Action = (command: Command) => Promise<Record<string, any>>;
type Props = { snapshot: Snapshot; mode: string; busy: boolean; action: Action; navigate: (route: string) => void };
const newNode = (profile: string): GraphNode => ({ id: crypto.randomUUID(), profile_id: profile, title: '새 작업', prompt: '' });
export function OrchestrationView({ snapshot, mode, busy, action, navigate }: Props) {
  const plans = snapshot.orchestration_plans ?? [], runs = snapshot.orchestration_runs ?? [];
  const [selectedId, setSelectedId] = useState(''), [runId, setRunId] = useState('');
  const [editing, setEditing] = useState<{ plan?: GraphPlan; draft: GraphInput; selected?: string }>();
  const [inspecting, setInspecting] = useState<{ node: GraphNode; job?: GraphJob }>();
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const selected = plans.find(plan => plan.id === selectedId) ?? plans[0];
  const history = runs.filter(run => run.plan.id === selected?.id).sort((a,b) => b.created_ms-a.created_ms);
  const viewing = history.find(run => run.id === runId);
  const active = history.find(run => activeRunStates.includes(run.state));
  const available = mode === 'demo' || snapshot.capabilities.orchestration === true;
  const locked = busy || pending;
  const perform = async (command: Command) => {
    setPending(true); setError('');
    try { return await action(command); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(false); }
  };
  const edit = (plan?: GraphPlan, selected?: string) => {
    setError('');
    setEditing({ plan, selected, draft: plan ? structuredClone({ title: plan.title, nodes: plan.nodes, edges: plan.edges }) : { title: '', nodes: snapshot.profiles.length ? [newNode(snapshot.profiles[0].id)] : [], edges: [] } });
  };
  return <GPage>
    <Button variant="ghost" size="sm" className="mb-3 w-fit" onClick={() => navigate('/together')}><ArrowLeft className="size-3.5"/>협업</Button>
    <GPageHeader title="작업 구조" actions={<Button disabled={locked || !snapshot.profiles.length} onClick={() => edit()}><Plus className="size-4"/>구조 만들기</Button>}/>
    {!available && <p className="m-0 mb-4 flex items-start gap-2 text-caption text-ink-2" role="status">연결된 호스트가 구조 저장과 실행을 지원하지 않습니다. 새 호스트 버전으로 실행해 주세요.</p>}
    {error && !editing && <InlineError className="mb-4">{error}</InlineError>}
    {!plans.length ? <EmptyState icon={<GitBranch/>} title="저장된 작업 구조 없음" description="작업마다 담당 Ghost를 지정하고, 결과를 전달할 다음 작업을 연결하세요." className="py-16"/> : <>
      <SegmentedControl variant="filter" aria-label="저장된 작업 구조" value={selected?.id ?? ''} onValueChange={value => { setSelectedId(value); setRunId(''); setError(''); }}
        options={plans.map(plan => ({ value: plan.id, label: plan.title }))}/>
      {selected && <>
        <div className="mt-5 mb-4 flex flex-wrap items-center justify-between gap-4">
          <div className="grid min-w-0 gap-1.5">
            <h2 className="m-0 text-ui font-semibold text-ink [overflow-wrap:anywhere]">{viewing?.plan.title ?? selected.title}</h2>
            <span className="text-caption text-ink-2">{viewing ? `실행 당시 구조 · 버전 ${viewing.plan.version}` : `저장된 구조 · 버전 ${selected.version}`}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={locked || !available} onClick={() => edit(selected)}>{viewing ? '저장된 구조 편집' : '구조 편집'}</Button>
            <Button disabled={locked || Boolean(active) || mode === 'demo' || !available} onClick={() => setConfirmRun(true)}><Play className="size-3.5"/>{viewing ? '저장된 구조 실행' : '구조 실행'}</Button>
          </div>
        </div>
        {mode === 'demo' && <p className="m-0 mb-4 text-caption text-ink-2">예시 모드에서는 구조를 저장하고 편집할 수 있습니다. 실제 실행은 호스트 연결 후 사용할 수 있습니다.</p>}
        <GraphCanvas plan={viewing?.plan ?? selected} profiles={snapshot.profiles} run={viewing} onSelect={node => {
          const job = viewing?.jobs.find(job => job.node_id === node.id);
          if (viewing) setInspecting({ node, job });
          else edit(selected, node.id);
        }}/>
        <div className="mt-4 mb-4 flex flex-wrap items-center justify-between gap-4">
          <h2 className="m-0 text-ui font-semibold text-ink">구조 실행 기록</h2>
          {viewing && <Button variant="ghost" size="sm" onClick={() => setRunId('')}>저장된 구조 보기</Button>}
        </div>
        {!history.length ? <p className="m-0 flex items-center gap-2 py-6 text-caption text-ink-2">아직 실행한 기록이 없습니다.</p> : <SegmentedControl variant="filter" aria-label="구조 실행 선택" value={viewing?.id ?? ''} onValueChange={setRunId}
          options={history.map(run => ({ value: run.id, label: <time dateTime={new Date(run.created_ms).toISOString()}>{new Date(run.created_ms).toLocaleString('ko-KR')}</time>, count: graphStateLabels[run.state] }))}/>}
        {viewing && <section className="mt-3 grid gap-3" aria-label="작업별 실행 결과">{viewing.jobs.map(job => {
          const node = viewing.plan.nodes.find(node => node.id === job.node_id)!;
          return <Card key={job.node_id} className="gap-3 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="m-0 min-w-0 text-ui font-medium text-ink [overflow-wrap:anywhere]">{node.title}</h3><span className="text-caption text-ink-2">{graphStateLabels[job.state]}</span></div>
            {job.output && <DetailDialog title="결과 보기"><pre className="max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{job.output}</pre></DetailDialog>}
            {job.task_id && <div><Button variant="ghost" size="sm" onClick={() => navigate(`/ghosts/${node.profile_id}?conversation=${encodeURIComponent(job.conversation_id)}`)}>작업 대화<ArrowUpRight className="size-3.5"/></Button></div>}
          </Card>;
        })}{activeRunStates.includes(viewing.state) && <div><Button variant="outline" size="sm" disabled={locked || viewing.state === 'cancelling'} onClick={() => void perform({ type:'workspace', action:{ type:'cancel_orchestration', run_id:viewing.id } })}><Square className="size-3"/>{viewing.state === 'cancelling' ? '취소 확인 중' : '이 실행 취소'}</Button></div>}</section>}
        {active && !viewing && <div className="mt-2"><Button variant="ghost" size="sm" onClick={() => setRunId(active.id)}>진행 중인 실행 보기<ArrowUpRight className="size-3.5"/></Button></div>}
      </>}
    </>}
    {editing && <GraphEditor profiles={snapshot.profiles} initial={editing.draft} initialSelected={editing.selected} title={editing.plan ? '작업 구조 편집' : '작업 구조 만들기'} busy={locked} available={available} error={error} onClose={() => { if (!locked) { setEditing(undefined); setError(''); } }} onSave={async draft => {
      const result = await perform({ type:'workspace', action:{ type:'save_orchestration', id:editing.plan?.id ?? null, version:editing.plan?.version ?? null, plan:draft } });
      if (result) { setSelectedId(result.id); setRunId(''); setEditing(undefined); }
    }}/> }
    {inspecting && <Modal title="실행 작업 상세" onClose={() => setInspecting(undefined)}><div className="grid gap-4">
      <h3 className="m-0 min-w-0 text-ui font-medium text-ink [overflow-wrap:anywhere]">{inspecting.node.title}</h3>
      <p className="m-0 text-caption text-ink-2">{snapshot.profiles.find(profile => profile.id === inspecting.node.profile_id)?.name ?? '담당 Ghost'} · {graphStateLabels[inspecting.job?.state ?? 'pending']}</p>
      <label className="grid gap-2 text-caption">요청 내용<Textarea readOnly value={inspecting.node.prompt} rows={5}/></label>
      {inspecting.job?.output && <div className="rounded-xl border border-line p-4"><h3 className="m-0 text-ui font-medium text-ink">실행 결과</h3><pre className="mb-0 mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-caption [overflow-wrap:anywhere]">{inspecting.job.output}</pre></div>}
      {inspecting.job?.task_id && <div><Button variant="outline" size="sm" onClick={() => navigate(`/ghosts/${inspecting.node.profile_id}?conversation=${encodeURIComponent(inspecting.job!.conversation_id)}`)}>작업 대화 열기<ArrowUpRight className="size-3.5"/></Button></div>}
    </div></Modal>}
    {confirmRun && selected && <Modal title="작업 구조 실행" onClose={() => !locked && setConfirmRun(false)}><div className="grid gap-4">
      <p className="m-0 text-body"><strong>{selected.title}</strong>의 저장된 버전 {selected.version}을 실행합니다.</p>
      <p className="m-0 text-caption text-ink-2">담당 Ghost의 현재 모델과 허용된 도구를 사용합니다. 연결 없는 작업은 병렬로 시작하고, 각 작업의 선행 조건을 모두 충족하면 결과를 전달합니다. 실행 중 구조를 편집해도 이 실행은 바뀌지 않습니다.</p>
      {error && <InlineError>{error}</InlineError>}
      <div><Button disabled={locked} onClick={() => void (async () => { const result = await perform({ type:'workspace', action:{ type:'start_orchestration', plan_id:selected.id, version:selected.version } }); if (result) { setRunId(result.id); setConfirmRun(false); } })()}><Play className="size-3.5"/>{locked ? '접수 중…' : '실행 시작'}</Button></div>
    </div></Modal>}
  </GPage>;
}

export function GraphCanvas({ plan, profiles, run, selected, onSelect, className = '' }: { plan: GraphInput; profiles: Profile[]; run?: GraphRun; selected?: string; onSelect: (node: GraphNode) => void; className?: string }) {
  const layers = graphLayers(plan), columns = layers.length ? layers : [plan.nodes.map(node => node.id)];
  const positions = new Map(columns.flatMap((ids,column) => ids.map((id,row) => [id,{x:column*292+16,y:row*144+40}] as const)));
  const width = Math.max(1,columns.length)*292, height = Math.max(1,...columns.map(ids => ids.length))*144+56;
  const key = useId();
  return <div className={`min-w-0 max-w-full overflow-auto overscroll-contain rounded-xl border border-line bg-inset ${className}`} role="region" aria-label="Ghost 작업 연결도" tabIndex={0}>
    <div className="relative min-w-0" style={{width,height}}>
      <svg className="pointer-events-none absolute inset-0 text-ink-3" width={width} height={height} aria-hidden="true"><defs><marker id={key} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="currentColor"/></marker></defs>{plan.edges.map(edge => {
        const from=positions.get(edge.from), to=positions.get(edge.to); if (!from || !to) return null;
        const x1=from.x+240,y1=from.y+52,x2=to.x,y2=to.y+52;
        const dash = edge.condition === 'failure' ? '4 4' : edge.condition === 'always' ? '8 3 2 3' : undefined;
        return <path key={`${edge.from}:${edge.to}`} d={`M${x1},${y1} C${x1+28},${y1} ${x2-28},${y2} ${x2},${y2}`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={dash} markerEnd={`url(#${key})`}/>;
      })}</svg>
      {columns.map((ids,column) => <span key={column} className="absolute top-3.5 text-2xs text-ink-2" style={{left:column*292+16}}>단계 {column+1}</span>)}
      {plan.nodes.map(node => {
        const position=positions.get(node.id)!, profile=profiles.find(profile=>profile.id===node.profile_id), job=run?.jobs.find(job=>job.node_id===node.id);
        const attention = job?.state === 'uncertain' || job?.state === 'failed';
        return <button key={node.id} className="absolute flex h-28 w-60 flex-col items-start gap-2 rounded-xl border border-line bg-surface p-3 text-left hover:bg-hover aria-[pressed=true]:outline aria-[pressed=true]:outline-2 aria-[pressed=true]:outline-offset-2 aria-[pressed=true]:outline-ink-2" style={{left:position.x,top:position.y}} aria-pressed={selected === undefined ? undefined : selected === node.id} title={node.title} onClick={() => onSelect(node)} aria-label={`${node.title} · ${profile?.name ?? '담당 미지정'}${job ? ` · ${graphStateLabels[job.state]}` : ''}`}>
          <div className="flex items-center gap-2 text-caption"><DotAvatar profileId={node.profile_id} tone={toneFor(node.profile_id)} size={30}/><span className="min-w-0 truncate">{profile?.name ?? '담당 Ghost 미지정'}</span></div>
          <strong className="max-w-full truncate text-ui font-medium text-ink">{node.title || '작업 이름 없음'}</strong>
          <span className={`text-2xs ${attention ? 'text-orange' : 'text-ink-2'}`}>{job ? graphStateLabels[job.state] : '작업 설정'}</span>
        </button>;
      })}
    </div>
    {plan.edges.length > 0 && <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 border-t border-line px-4 py-3 text-2xs text-ink-2" aria-label="작업 연결 조건">{plan.edges.map(edge => <li key={`${edge.from}:${edge.to}`} className="flex max-w-full flex-wrap gap-1.5 [overflow-wrap:anywhere]"><span>{plan.nodes.find(node=>node.id===edge.from)?.title}</span><span>{edgeLabels[edge.condition]} →</span><span>{plan.nodes.find(node=>node.id===edge.to)?.title}</span></li>)}</ul>}
  </div>;
}

function GraphEditor({ profiles, initial, initialSelected, title, busy, available, error, onClose, onSave }: { profiles: Profile[]; initial: GraphInput; initialSelected?: string; title: string; busy: boolean; available: boolean; error: string; onClose: () => void; onSave: (plan: GraphInput) => Promise<void> }) {
  const [draft,setDraft]=useState(initial), [selected,setSelected]=useState(initialSelected ?? initial.nodes[0]?.id ?? ''), [localError,setLocalError]=useState('');
  const node=draft.nodes.find(node=>node.id===selected);
  const changeNode=(patch:Partial<GraphNode>)=>setDraft(previous=>({...previous,nodes:previous.nodes.map(item=>item.id===selected?{...item,...patch}:item)}));
  const add=()=>{const next=newNode(profiles[0]?.id ?? '');setDraft(previous=>({...previous,nodes:[...previous.nodes,next]}));setSelected(next.id);};
  const errorId=useId();
  return <Modal title={title} onClose={onClose} className="w-[min(1120px,calc(100vw-2rem))] max-w-none sm:max-w-[min(1120px,calc(100vw-2rem))] overflow-auto"><form className="flex min-w-0 flex-col gap-4" onSubmit={event=>{event.preventDefault();const error=validateGraph(draft,profiles.map(profile=>profile.id));setLocalError(error??'');if(!error)void onSave(draft);}}>
    <label className="grid gap-2 text-caption">구조 이름<Input value={draft.title} maxLength={200} disabled={busy} onChange={event=>setDraft({...draft,title:event.target.value})} required placeholder="예: 자료 조사와 검토"/></label>
    <p className="m-0 text-caption text-ink-2">연결 없는 작업은 병렬로 시작합니다. 선행 작업이 여러 개면 모든 연결 조건을 충족해야 시작합니다.</p>
    {!available && <p className="m-0 text-caption text-danger" role="status">구조를 저장하려면 연결된 호스트를 새 버전으로 실행해 주세요.</p>}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px] max-lg:grid-cols-1">
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3"><span className="text-caption text-ink-2">{draft.nodes.length} / 16개 작업</span><Button variant="outline" type="button" disabled={busy || draft.nodes.length>=16 || !profiles.length} onClick={add}><Plus className="size-3.5"/>작업 추가</Button></div>
        <GraphCanvas plan={draft} profiles={profiles} selected={selected} onSelect={node=>setSelected(node.id)} className="max-h-[460px] max-lg:max-h-[260px]"/>
      </div>
      <GPanel title="작업 설정" className="h-auto">{node ? <div className="grid gap-4">
        <label className="grid gap-2 text-caption">작업 이름<Input value={node.title} maxLength={200} disabled={busy} onChange={event=>changeNode({title:event.target.value})}/></label>
        <SelectField label="담당 Ghost" value={node.profile_id} disabled={busy} onValueChange={value=>changeNode({profile_id:value})} options={profiles.map(profile=>({value:profile.id,label:profile.name}))}/>
        <label className="grid gap-2 text-caption">요청 내용<Textarea value={node.prompt} rows={5} maxLength={4000} disabled={busy} onChange={event=>changeNode({prompt:event.target.value})} placeholder="이 Ghost가 수행할 작업과 원하는 결과"/></label>
        <fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0"><legend className="mb-3 text-caption">선행 작업과 시작 조건</legend>{draft.nodes.filter(other=>other.id!==node.id).map(other=>{
          const edge=draft.edges.find(edge=>edge.from===other.id&&edge.to===node.id);
          return <div key={other.id} className="grid gap-2"><label className="flex items-start gap-2 [overflow-wrap:anywhere]"><Checkbox checked={Boolean(edge)} disabled={busy} onCheckedChange={event=>setDraft(previous=>({...previous,edges:event?[...previous.edges,{from:other.id,to:node.id,condition:'success'}]:previous.edges.filter(edge=>!(edge.from===other.id&&edge.to===node.id))}))} aria-label={other.title}/><span className="text-ui">{other.title}</span></label>{edge&&<SelectField label={`${other.title}의 결과 조건`} value={edge.condition} disabled={busy} onValueChange={value=>setDraft(previous=>({...previous,edges:previous.edges.map(item=>item.from===other.id&&item.to===node.id?{...item,condition:value as EdgeCondition}:item)}))} options={Object.entries(edgeLabels).map(([value,label])=>({value,label}))}/>}</div>;
        })}{draft.nodes.length<2&&<p className="m-0 text-caption text-ink-2">다른 작업을 추가하면 연결할 수 있습니다.</p>}</fieldset>
        <div><Button variant="outline" type="button" disabled={busy} onClick={()=>{const nodes=draft.nodes.filter(item=>item.id!==node.id);setDraft({...draft,nodes,edges:draft.edges.filter(edge=>edge.from!==node.id&&edge.to!==node.id)});setSelected(nodes[0]?.id??'');}}><Trash2 className="size-3.5"/>이 작업 제거</Button></div>
      </div>:<p className="m-0 text-caption text-ink-2">작업을 추가하거나 선택하세요.</p>}</GPanel>
    </div>
    {(localError||error)&&<InlineError id={errorId}>{localError||error}</InlineError>}
    <div className="flex justify-end gap-2">
      <Button variant="outline" type="button" disabled={busy} onClick={onClose}>닫기</Button>
      <Button type="submit" disabled={busy||!available} aria-describedby={localError||error?errorId:undefined}><Save className="size-3.5"/>{busy?'저장 중…':'구조 저장'}</Button>
    </div>
  </form></Modal>;
}
