import { useId, useState } from 'react';
import { Card, GPanel } from '@garden/ui';
import { ArrowUpRight, CircleAlert, GitBranch, Play, Plus, Save, Square, Trash2 } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { toneFor } from '../client/types';
import type { Command, Profile, Snapshot } from '../client/types';
import { edgeLabels, graphLayers, graphStateLabels, validateGraph } from '../client/orchestration';
import type { EdgeCondition, GraphInput, GraphJob, GraphNode, GraphPlan, GraphRun } from '../client/orchestration';
import './orchestration.css';

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
  const active = history.find(run => ['running','cancelling'].includes(run.state));
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
  return <div className="page-content orchestration-page">
    <div className="page-heading"><h1>작업 구조</h1><button className="button primary" disabled={locked || !snapshot.profiles.length} onClick={() => edit()}><Plus size={16}/>구조 만들기</button></div>
    {!available && <p className="inline-error" role="status"><CircleAlert size={16}/>연결된 호스트가 구조 저장과 실행을 지원하지 않습니다. 새 호스트 버전으로 실행해 주세요.</p>}
    {error && !editing && <p className="inline-error" role="alert">{error}</p>}
    {!plans.length ? <div className="empty-state large-empty"><GitBranch size={32}/><h2>저장된 작업 구조 없음</h2><p>작업마다 담당 Ghost를 지정하고, 결과를 전달할 다음 작업을 연결하세요.</p><button className="button secondary" disabled={!snapshot.profiles.length || locked} onClick={() => edit()}>구조 만들기<Plus size={16}/></button></div> : <>
      <div className="graph-plan-tabs" aria-label="저장된 작업 구조">{plans.map(plan => <button className="filter-button" key={plan.id} aria-pressed={selected?.id === plan.id} onClick={() => { setSelectedId(plan.id); setRunId(''); setError(''); }}>{plan.title}</button>)}</div>
      {selected && <>
        <div className="graph-heading"><div><h2>{viewing?.plan.title ?? selected.title}</h2><span>{viewing ? `실행 당시 구조 · 버전 ${viewing.plan.version}` : `저장된 구조 · 버전 ${selected.version}`}</span></div><div className="graph-actions"><button className="button secondary" disabled={locked || !available} onClick={() => edit(selected)}>{viewing ? '저장된 구조 편집' : '구조 편집'}</button><button className="button primary" disabled={locked || Boolean(active) || mode === 'demo' || !available} onClick={() => setConfirmRun(true)}><Play size={14}/>{viewing ? '저장된 구조 실행' : '구조 실행'}</button></div></div>
        {mode === 'demo' && <p className="field-help">예시 모드에서는 구조를 저장하고 편집할 수 있습니다. 실제 실행은 호스트 연결 후 사용할 수 있습니다.</p>}
        <GraphCanvas plan={viewing?.plan ?? selected} profiles={snapshot.profiles} run={viewing} onSelect={node => {
          const job = viewing?.jobs.find(job => job.node_id === node.id);
          if (viewing) setInspecting({ node, job });
          else edit(selected, node.id);
        }}/>
        <div className="graph-history-heading"><h2>구조 실행 기록</h2>{viewing && <button className="text-button" onClick={() => setRunId('')}>저장된 구조 보기</button>}</div>
        {!history.length ? <p className="quiet-empty">아직 실행한 기록이 없습니다.</p> : <div className="graph-run-tabs" aria-label="구조 실행 선택">{history.map(run => <button className="filter-button" aria-pressed={viewing?.id === run.id} key={run.id} onClick={() => setRunId(run.id)}><time dateTime={new Date(run.created_ms).toISOString()}>{new Date(run.created_ms).toLocaleString('ko-KR')}</time><span>{graphStateLabels[run.state]}</span></button>)}</div>}
        {viewing && <section className="graph-run-results" aria-label="작업별 실행 결과">{viewing.jobs.map(job => {
          const node = viewing.plan.nodes.find(node => node.id === job.node_id)!;
          return <Card key={job.node_id} className="graph-result"><div><h3>{node.title}</h3><span>{graphStateLabels[job.state]}</span></div>{job.output && <details><summary>결과 보기</summary><pre>{job.output}</pre></details>}{job.task_id && <button className="text-button" onClick={() => navigate(`/ghosts/${node.profile_id}?conversation=${encodeURIComponent(job.conversation_id)}`)}>작업 대화<ArrowUpRight size={14}/></button>}</Card>;
        })}{['running','cancelling'].includes(viewing.state) && <button className="button secondary" disabled={locked || viewing.state === 'cancelling'} onClick={() => void perform({ type:'workspace', action:{ type:'cancel_orchestration', run_id:viewing.id } })}><Square size={13}/>{viewing.state === 'cancelling' ? '취소 확인 중' : '이 실행 취소'}</button>}</section>}
        {active && !viewing && <button className="text-button" onClick={() => setRunId(active.id)}>진행 중인 실행 보기<ArrowUpRight size={14}/></button>}
      </>}
    </>}
    {editing && <GraphEditor profiles={snapshot.profiles} initial={editing.draft} initialSelected={editing.selected} title={editing.plan ? '작업 구조 편집' : '작업 구조 만들기'} busy={locked} available={available} error={error} onClose={() => { if (!locked) { setEditing(undefined); setError(''); } }} onSave={async draft => {
      const result = await perform({ type:'workspace', action:{ type:'save_orchestration', id:editing.plan?.id ?? null, version:editing.plan?.version ?? null, plan:draft } });
      if (result) { setSelectedId(result.id); setRunId(''); setEditing(undefined); }
    }}/> }
    {inspecting && <Modal title="실행 작업 상세" onClose={() => setInspecting(undefined)}><div className="form-stack"><h3>{inspecting.node.title}</h3><p>{snapshot.profiles.find(profile => profile.id === inspecting.node.profile_id)?.name ?? '담당 Ghost'} · {graphStateLabels[inspecting.job?.state ?? 'pending']}</p><label>요청 내용<textarea readOnly value={inspecting.node.prompt} rows={5}/></label>{inspecting.job?.output && <div className="graph-result"><h3>실행 결과</h3><pre>{inspecting.job.output}</pre></div>}{inspecting.job?.task_id && <button className="button secondary" onClick={() => navigate(`/ghosts/${inspecting.node.profile_id}?conversation=${encodeURIComponent(inspecting.job!.conversation_id)}`)}>작업 대화 열기<ArrowUpRight size={14}/></button>}</div></Modal>}
    {confirmRun && selected && <Modal title="작업 구조 실행" onClose={() => !locked && setConfirmRun(false)}><div className="form-stack"><p><strong>{selected.title}</strong>의 저장된 버전 {selected.version}을 실행합니다.</p><p className="field-help">담당 Ghost의 현재 모델과 허용된 도구를 사용합니다. 연결 없는 작업은 병렬로 시작하고, 각 작업의 선행 조건을 모두 충족하면 결과를 전달합니다. 실행 중 구조를 편집해도 이 실행은 바뀌지 않습니다.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary" disabled={locked} onClick={() => void (async () => { const result = await perform({ type:'workspace', action:{ type:'start_orchestration', plan_id:selected.id, version:selected.version } }); if (result) { setRunId(result.id); setConfirmRun(false); } })()}><Play size={14}/>{locked ? '접수 중…' : '실행 시작'}</button></div></Modal>}
  </div>;
}

export function GraphCanvas({ plan, profiles, run, selected, onSelect }: { plan: GraphInput; profiles: Profile[]; run?: GraphRun; selected?: string; onSelect: (node: GraphNode) => void }) {
  const layers = graphLayers(plan), columns = layers.length ? layers : [plan.nodes.map(node => node.id)];
  const positions = new Map(columns.flatMap((ids,column) => ids.map((id,row) => [id,{x:column*292+16,y:row*144+40}] as const)));
  const width = Math.max(1,columns.length)*292, height = Math.max(1,...columns.map(ids => ids.length))*144+56;
  const key = useId();
  return <div className="graph-canvas-scroll" role="region" aria-label="Ghost 작업 연결도" tabIndex={0}>
    <div className="graph-canvas" style={{width,height}}>
      <svg width={width} height={height} aria-hidden="true"><defs><marker id={key} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="currentColor"/></marker></defs>{plan.edges.map(edge => {
        const from=positions.get(edge.from), to=positions.get(edge.to); if (!from || !to) return null;
        const x1=from.x+240,y1=from.y+52,x2=to.x,y2=to.y+52;
        return <path key={`${edge.from}:${edge.to}`} data-condition={edge.condition} d={`M${x1},${y1} C${x1+28},${y1} ${x2-28},${y2} ${x2},${y2}`} fill="none" markerEnd={`url(#${key})`}/>;
      })}</svg>
      {columns.map((ids,column) => <span key={column} className="graph-stage-label" style={{left:column*292+16}}>단계 {column+1}</span>)}
      {plan.nodes.map(node => {
        const position=positions.get(node.id)!, profile=profiles.find(profile=>profile.id===node.profile_id), job=run?.jobs.find(job=>job.node_id===node.id);
        return <button key={node.id} className={`graph-node ${job?.state === 'uncertain' || job?.state === 'failed' ? 'needs-attention' : ''}`} style={{left:position.x,top:position.y}} aria-pressed={selected === undefined ? undefined : selected === node.id} title={node.title} onClick={() => onSelect(node)} aria-label={`${node.title} · ${profile?.name ?? '담당 미지정'}${job ? ` · ${graphStateLabels[job.state]}` : ''}`}><div><DotAvatar profileId={node.profile_id} tone={toneFor(node.profile_id)} size={30}/><span>{profile?.name ?? '담당 Ghost 미지정'}</span></div><strong>{node.title || '작업 이름 없음'}</strong><span>{job ? graphStateLabels[job.state] : '작업 설정'}</span></button>;
      })}
    </div>
    {plan.edges.length > 0 && <ul className="graph-edge-list" aria-label="작업 연결 조건">{plan.edges.map(edge => <li key={`${edge.from}:${edge.to}`}><span>{plan.nodes.find(node=>node.id===edge.from)?.title}</span><span>{edgeLabels[edge.condition]} →</span><span>{plan.nodes.find(node=>node.id===edge.to)?.title}</span></li>)}</ul>}
  </div>;
}

function GraphEditor({ profiles, initial, initialSelected, title, busy, available, error, onClose, onSave }: { profiles: Profile[]; initial: GraphInput; initialSelected?: string; title: string; busy: boolean; available: boolean; error: string; onClose: () => void; onSave: (plan: GraphInput) => Promise<void> }) {
  const [draft,setDraft]=useState(initial), [selected,setSelected]=useState(initialSelected ?? initial.nodes[0]?.id ?? ''), [localError,setLocalError]=useState('');
  const node=draft.nodes.find(node=>node.id===selected);
  const changeNode=(patch:Partial<GraphNode>)=>setDraft(previous=>({...previous,nodes:previous.nodes.map(item=>item.id===selected?{...item,...patch}:item)}));
  const add=()=>{const next=newNode(profiles[0]?.id ?? '');setDraft(previous=>({...previous,nodes:[...previous.nodes,next]}));setSelected(next.id);};
  const errorId=useId();
  return <Modal title={title} onClose={onClose} className="graph-editor-dialog"><form className="graph-editor-form" onSubmit={event=>{event.preventDefault();const error=validateGraph(draft,profiles.map(profile=>profile.id));setLocalError(error??'');if(!error)void onSave(draft);}}>
    <label className="graph-name">구조 이름<input value={draft.title} maxLength={200} disabled={busy} onChange={event=>setDraft({...draft,title:event.target.value})} required placeholder="예: 자료 조사와 검토"/></label>
    <p className="field-help">연결 없는 작업은 병렬로 시작합니다. 선행 작업이 여러 개면 모든 연결 조건을 충족해야 시작합니다.</p>
    {!available && <p className="form-error" role="status">구조를 저장하려면 연결된 호스트를 새 버전으로 실행해 주세요.</p>}
    <div className="graph-editor-layout"><div><div className="graph-editor-tools"><span>{draft.nodes.length} / 16개 작업</span><button className="button secondary" type="button" disabled={busy || draft.nodes.length>=16 || !profiles.length} onClick={add}><Plus size={14}/>작업 추가</button></div><GraphCanvas plan={draft} profiles={profiles} selected={selected} onSelect={node=>setSelected(node.id)}/></div>
      <GPanel title="작업 설정" className="graph-node-editor">{node ? <div className="form-stack">
        <label>작업 이름<input value={node.title} maxLength={200} disabled={busy} onChange={event=>changeNode({title:event.target.value})}/></label>
        <label>담당 Ghost<select aria-label="담당 Ghost" value={node.profile_id} disabled={busy} onChange={event=>changeNode({profile_id:event.target.value})}>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>요청 내용<textarea value={node.prompt} rows={5} maxLength={4000} disabled={busy} onChange={event=>changeNode({prompt:event.target.value})} placeholder="이 Ghost가 수행할 작업과 원하는 결과"/></label>
        <fieldset className="graph-dependencies"><legend>선행 작업과 시작 조건</legend>{draft.nodes.filter(other=>other.id!==node.id).map(other=>{
          const edge=draft.edges.find(edge=>edge.from===other.id&&edge.to===node.id);
          return <div key={other.id}><label><input type="checkbox" checked={Boolean(edge)} disabled={busy} onChange={event=>setDraft(previous=>({...previous,edges:event.target.checked?[...previous.edges,{from:other.id,to:node.id,condition:'success'}]:previous.edges.filter(edge=>!(edge.from===other.id&&edge.to===node.id))}))}/><span>{other.title}</span></label>{edge&&<select aria-label={`${other.title}의 결과 조건`} value={edge.condition} disabled={busy} onChange={event=>setDraft(previous=>({...previous,edges:previous.edges.map(item=>item.from===other.id&&item.to===node.id?{...item,condition:event.target.value as EdgeCondition}:item)}))}>{Object.entries(edgeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>}</div>;
        })}{draft.nodes.length<2&&<p className="field-help">다른 작업을 추가하면 연결할 수 있습니다.</p>}</fieldset>
        <button type="button" className="button secondary" disabled={busy} onClick={()=>{const nodes=draft.nodes.filter(item=>item.id!==node.id);setDraft({...draft,nodes,edges:draft.edges.filter(edge=>edge.from!==node.id&&edge.to!==node.id)});setSelected(nodes[0]?.id??'');}}><Trash2 size={14}/>이 작업 제거</button>
      </div>:<p className="quiet-empty">작업을 추가하거나 선택하세요.</p>}</GPanel>
    </div>
    {(localError||error)&&<p id={errorId} className="form-error" role="alert">{localError||error}</p>}
    <div className="graph-editor-footer"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>닫기</button><button className="button primary" disabled={busy||!available} aria-describedby={localError||error?errorId:undefined}><Save size={14}/>{busy?'저장 중…':'구조 저장'}</button></div>
  </form></Modal>;
}
