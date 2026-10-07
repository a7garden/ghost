import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleAlert, GitBranch, MessageCircle, Plus, RefreshCw, Square, Users } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { Status } from '../components/Status';
import { collaborationGroups, delegationContext, finishedDelegation } from '../client/collaboration';
import { toneFor } from '../client/types';
import type { Snapshot, Delegation, Command, CollaborationMessage } from '../client/types';

type Action = (command: Command) => Promise<Record<string, any>>;
type Props = { snapshot: Snapshot; route: string; mode: string; action: Action; query: Action; busy: boolean; navigate: (route: string) => void; onAssign: () => void };

export function CollaborationView({ snapshot, route, mode, action, query, busy, navigate, onAssign }: Props) {
  const groups = collaborationGroups(snapshot);
  const requested = new URLSearchParams(route.split('?')[1] ?? '').get('delegation');
  const [selected, setSelected] = useState(requested ?? ''), [groupId, setGroupId] = useState(''), [filter, setFilter] = useState('active');
  useEffect(() => { if (requested) setSelected(requested); }, [requested]);
  const visible = groups.filter(g => filter === 'all' || g.delegations.some(d => !finishedDelegation(d)));
  const group = groups.find(g => g.delegations.some(d => d.id === requested)) ?? visible.find(g => g.id === groupId) ?? visible[0];
  const owner = snapshot.profiles.find(p => p.id === group?.owner);
  const detail = snapshot.delegations.find(d => d.id === selected);
  const completed = group?.delegations.filter(d => d.state === 'complete').length ?? 0;
  const involved = group ? new Set([group.owner, ...group.delegations.map(d => d.target)]).size : 0;
  return <div className="page-content collaboration-page">
    <div className="page-heading"><div><h1>함께 하는 일</h1></div><button className="button primary" onClick={onAssign} disabled={!snapshot.profiles.length}><Plus size={16}/>협업 요청</button></div>
    <div className="collab-filters"><div className="filter-options"><button className={`filter-button ${filter === 'active' ? 'selected' : ''}`} aria-pressed={filter === 'active'} onClick={() => { setFilter('active'); navigate('/together'); }}>진행 중</button><button className={`filter-button ${filter === 'all' ? 'selected' : ''}`} aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); navigate('/together'); }}>모든 협업</button></div><span className="muted">{visible.length}개의 흐름</span></div>
    {visible.length > 1 && <div className="collab-group-tabs" aria-label="협업 선택">{visible.map(g => <button key={g.id} className={`filter-button ${g.id === group?.id ? 'selected' : ''}`} onClick={() => { setGroupId(g.id); navigate('/together'); }}><DotAvatar profileId={g.owner} tone={toneFor(g.owner)} size={25}/><span>{g.title}</span></button>)}</div>}
    {group ? <>
      <section className="collab-board" aria-label={`${group.title} 협업 흐름`}>
        <div className="collab-board-heading"><div><h2>{group.title}</h2><p>{involved}명의 Ghost · {completed}/{group.delegations.length}개 결과 전달</p></div><button className="text-button" onClick={() => navigate(`/ghosts/${group.owner}${group.sourceId ? `?conversation=${group.sourceId}` : ''}`)}>시작한 대화<ArrowUpRight size={14}/></button></div>
        <div className="collab-flow">
          <div className="collab-lead"><span className="flow-role">요청한 Ghost</span><button className="leader-node" onClick={() => navigate(`/ghosts/${group.owner}${group.sourceId ? `?conversation=${group.sourceId}` : ''}`)}><DotAvatar profileId={group.owner} tone={toneFor(group.owner)} size={100}/><strong>{owner?.name ?? '연결되지 않은 Ghost'}</strong><span>{owner?.persona ?? '저장된 협업 기록'}</span><span className="leader-action"><MessageCircle size={13}/>대화 열기<ArrowUpRight size={13}/></span></button></div>
          <div className="flow-bridge" aria-hidden="true"><span/><ArrowRight size={17}/><small>위임</small></div>
          <div className="collab-branches"><span className="flow-role">참여 Ghost</span><div className="collab-workers">{group.delegations.map(d => {
            const ctx = delegationContext(snapshot, d);
            return <button key={d.id} className={`worker-node ${ctx.status === 'attention' ? 'needs-owner' : ''}`} aria-label={`${ctx.owner?.name ?? 'Ghost'}에서 ${ctx.target?.name ?? 'Ghost'}로 맡긴 협업 기록`} onClick={() => setSelected(d.id)}>
              <div className="worker-identity"><DotAvatar profileId={d.target} tone={toneFor(d.target)} size={56}/><div><strong>{ctx.target?.name ?? '연결되지 않은 Ghost'}</strong><Status state={ctx.status} label={ctx.label}/></div><ChevronRight size={16}/></div>
              <h3>{ctx.title}</h3>{ctx.summary && <p>{ctx.summary}</p>}
              <div className="worker-footer"><span><span className={`mini-dot ${!finishedDelegation(d) ? 'active' : ''}`}/>{finishedDelegation(d) ? (d.state === 'complete' ? '결과 전달됨' : ctx.label) : d.background ? '백그라운드 협업' : '결과 대기'}</span><span>기록 보기<ArrowUpRight size={13}/></span></div>
            </button>;
          })}</div></div>
        </div>
        <div className="collab-return"><ArrowDownLeft size={18}/><p>결과 수신: <strong>{owner?.name ?? '요청한 Ghost'}</strong></p><span className="return-progress">{completed} / {group.delegations.length}</span></div>
      </section>
      <section className="collab-under"><div><h2>연결된 대화</h2></div><div className="collab-conversations">{group.delegations.map(d => { const ctx = delegationContext(snapshot, d); return <button key={d.id} onClick={() => navigate(`/ghosts/${d.target}?conversation=${d.conversation_id}`)}><DotAvatar profileId={d.target} tone={toneFor(d.target)} size={36}/><span><strong>{ctx.target?.name ?? 'Ghost'}</strong><small>{ctx.title}</small></span><ArrowUpRight size={15}/></button>; })}</div></section>
      <p className="workspace-foot">{mode === 'demo' ? '예시 데이터' : ''}</p>
    </> : <div className="empty-state large-empty"><GitBranch size={34}/><h2>{groups.length ? '진행 중인 협업 없음' : '협업 기록 없음'}</h2><p>{groups.length ? '모든 협업에서 이전 기록과 결과를 살펴보세요.' : 'Ghost에게 다른 Ghost와 함께 일해 달라고 요청해 보세요. 실제로 전달된 요청이 여기에 나타납니다.'}</p><button className="button secondary" onClick={() => groups.length ? setFilter('all') : onAssign()}>{groups.length ? '모든 협업 보기' : '협업 요청하기'}<ArrowRight size={14}/></button></div>}
    {detail && <CollaborationRecord snapshot={snapshot} delegation={detail} query={query} action={action} busy={busy} navigate={navigate} onClose={() => setSelected('')}/>}
  </div>;
}

function CollaborationRecord({ snapshot, delegation: d, query, action, busy, navigate, onClose }: { snapshot: Snapshot; delegation: Delegation; query: Action; action: Action; busy: boolean; navigate: Props['navigate']; onClose: () => void }) {
  const [messages, setMessages] = useState<CollaborationMessage[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [confirm, setConfirm] = useState(false);
  const ctx = delegationContext(snapshot, d);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const data = await query({ type: 'workspace', action: { type: 'collaboration_messages', delegation_id: d.id, after: 0 } }); if (alive) { setMessages(Array.isArray(data) ? data : []); setError(''); } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : '협업 기록을 불러오지 못했습니다.'); }
      finally { if (alive) { setLoading(false); timer = setTimeout(load, 5000); } }
    };
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [d.id, query, attempt]);
  return <Modal title="협업 기록" onClose={onClose} drawer><div className="collab-record">
    <div className="record-pair"><div><DotAvatar profileId={d.owner} tone={toneFor(d.owner)} size={70}/><strong>{ctx.owner?.name ?? 'Ghost'}</strong><span>요청</span></div><ArrowRight size={22}/><div><DotAvatar profileId={d.target} tone={toneFor(d.target)} size={70}/><strong>{ctx.target?.name ?? 'Ghost'}</strong><span>함께 진행</span></div></div>
    <div className="record-heading"><h2>{ctx.title}</h2><Status state={ctx.status} label={ctx.label}/></div>
    {error && <div className="inline-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button className="icon-button" aria-label="협업 기록 다시 불러오기" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={15}/></button></div>}
    {loading ? <div className="skeleton record-skeleton" aria-label="협업 기록 불러오는 중"/> : <ol className="collab-timeline">{messages.map(m => { const sender = snapshot.profiles.find(p => p.id === m.from); const type = ({ requested: '요청', accepted: '수락', progress: '진행 보고', result: '결과 전달', cancel_requested: '중단 요청', cancel_receipt: '중단 확인' }[m.event.type] ?? m.event.type); return <li key={m.message_id}><div className="timeline-marker">{m.event.type === 'result' ? <Check size={14}/> : <DotAvatar profileId={m.from} tone={toneFor(m.from)} size={29}/>}</div><div className="timeline-copy"><div><strong>{sender?.name ?? 'Ghost'}</strong><time dateTime={new Date(m.created_ms).toISOString()}>{new Date(m.created_ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></div><h3>{type}</h3>{(m.event.prompt || m.event.summary || m.event.reason) && <p>{m.event.prompt || m.event.summary || m.event.reason}</p>}{m.event.artifacts?.length ? <div className="timeline-artifacts">{m.event.artifacts.map((a, i) => <span key={i}>{a}</span>)}</div> : null}{m.event.uncertain_effects?.length ? <p className="form-error">결과 확인이 필요한 작업이 {m.event.uncertain_effects.length}개 있습니다.</p> : null}</div></li>; })}</ol>}
    {!loading && !messages.length && !error && <p className="quiet-empty">저장된 협업 메시지가 아직 없습니다.</p>}
  </div><div className="drawer-footer"><div><button className="button secondary" onClick={() => navigate(`/ghosts/${d.target}?conversation=${d.conversation_id}`)}><MessageCircle size={14}/>대화 열기<ArrowUpRight size={13}/></button>{!finishedDelegation(d) && <button className="button secondary" disabled={busy || d.state === 'cancelling'} onClick={() => setConfirm(v => !v)}><Square size={12}/>{d.state === 'cancelling' ? '중단 확인 중' : '협업 중단'}</button>}</div>{confirm && !finishedDelegation(d) && <form className="cancel-collab-form" onSubmit={e => { e.preventDefault(); const reason = String(new FormData(e.currentTarget).get('reason')); void action({ type: 'workspace', action: { type: 'cancel_delegation', delegation_id: d.id, reason } }).then(() => { setConfirm(false); setAttempt(n => n + 1); }).catch(e => setError(e.message)); }}><label>중단 이유<input name="reason" placeholder="진행 방향이 바뀌었어요." maxLength={2048} required/></label><p className="field-help">이미 완료된 결과와 협업 기록은 남습니다.</p><button className="button primary" disabled={busy}>이 협업 중단</button></form>}</div></Modal>;
}

export function CollaborationStrip({ snapshot, profileId, conversationId, navigate }: { snapshot: Snapshot; profileId: string; conversationId?: string; navigate: Props['navigate'] }) {
  const records = snapshot.delegations.filter(d => {
    if (d.target === profileId) return d.conversation_id === conversationId;
    return d.owner === profileId && delegationContext(snapshot, d).source?.id === conversationId;
  });
  if (!records.length) return null;
  const peers = [...new Set(records.map(d => d.owner === profileId ? d.target : d.owner))];
  return <button className="collaboration-strip" onClick={() => navigate(`/together?delegation=${records[0].id}`)}><span className="avatar-stack">{peers.slice(0, 4).map(id => <DotAvatar key={id} profileId={id} tone={toneFor(id)} size={37}/>)}</span><span className="strip-copy"><strong>{peers.map(id => snapshot.profiles.find(p => p.id === id)?.name ?? 'Ghost').join(', ')}와 함께</strong><small>{records.filter(d => !finishedDelegation(d)).length ? '협업 진행 중' : '협업 종료'}</small></span><span className="strip-link">협업 보기<ArrowUpRight size={15}/></span></button>;
}
