import { OrchestrationView } from './OrchestrationView';
import { uiTerms } from '../uiText';
import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleAlert, GitBranch, MessageCircle, Plus, RefreshCw, Square } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { Status } from '../components/Status';
import { collaborationGroups, delegationContext, finishedDelegation } from '../client/collaboration';
import { toneFor } from '../client/types';
import type { Snapshot, Delegation, Command, CollaborationMessage } from '../client/types';

type Action = (command: Command) => Promise<Record<string, any>>;
type Props = { snapshot: Snapshot; route: string; mode: string; action: Action; query: Action; busy: boolean; navigate: (route: string) => void; onAssign: () => void };

export function CollaborationView(props: Props) {
  const [groupId, setGroupId] = useState('');
  const params = new URLSearchParams(props.route.split('?')[1] ?? '');
  if (params.get('view') === 'structure') return <OrchestrationView {...props}/>;
  return <CollaborationRecords {...props} requested={params.get('delegation')} groupId={groupId} onGroupChange={setGroupId}/>;
}

type Group = ReturnType<typeof collaborationGroups>[number];
const activeGroup = (group: Group) => group.delegations.some(item => !finishedDelegation(item));

function CollaborationRecords({ snapshot, requested, groupId, onGroupChange, mode, action, query, busy, navigate, onAssign }: Props & {
  requested: string | null; groupId: string; onGroupChange(id: string): void;
}) {
  const [selected, setSelected] = useState(requested ?? '');
  useEffect(() => { setSelected(requested ?? ''); }, [requested]);

  const groups = collaborationGroups(snapshot).sort((a, b) => Number(activeGroup(b)) - Number(activeGroup(a)));
  const group = groups.find(item => item.delegations.some(delegation => delegation.id === requested))
    ?? groups.find(item => item.id === groupId) ?? groups[0];
  const displayedGroupId = group?.id;
  useEffect(() => {
    if (displayedGroupId) onGroupChange(displayedGroupId);
  }, [displayedGroupId, onGroupChange]);
  const detail = snapshot.delegations.find(item => item.id === selected);

  return <div className="page-content collaboration-page">
    <header className="page-heading collab-heading">
      <div className="collab-heading-title"><h1>{uiTerms.collaboration}</h1>
        {mode === 'demo' && <span>예시 데이터</span>}
      </div>
      <div className="collab-actions">
        <button type="button" className="button secondary" onClick={() => navigate('/together?view=structure')}><GitBranch size={15}/>작업 구조</button>
        <button type="button" className="button primary" onClick={onAssign} disabled={!snapshot.profiles.length}><Plus size={16}/>협업 요청</button>
      </div>
    </header>

    {group ? <div className={`collab-workbench ${groups.length > 1 ? 'has-index' : ''}`}>
      {groups.length > 1 && <nav className="collab-index" aria-label="협업 선택">
        {groups.map(item => {
          const open = item.id === group.id;
          const active = item.delegations.filter(delegation => !finishedDelegation(delegation)).length;
          return <button type="button" className="collab-index-row" aria-current={open ? 'true' : undefined} key={item.id}
            title={item.title} onClick={() => { onGroupChange(item.id); if (requested) navigate('/together'); }}>
            <DotAvatar profileId={item.owner} tone={toneFor(item.owner)} size={28}/>
            <span className="collab-index-copy"><strong>{item.title}</strong>
              <small data-active={active > 0}>{active ? `진행 중 ${active}개` : '종료'}</small></span>
          </button>;
        })}
      </nav>}
      <CollaborationMap snapshot={snapshot} group={group} onOpen={setSelected} navigate={navigate}/>
    </div> : <div className="collab-empty">
      <h2>아직 협업이 없습니다.</h2>
      {snapshot.profiles.length > 0 && <p>Ghost에게 다른 Ghost와 함께 일해 달라고 요청하면 여기에 표시됩니다.</p>}
    </div>}

    {detail && <CollaborationRecord key={detail.id} snapshot={snapshot} delegation={detail} query={query} action={action}
      busy={busy} navigate={navigate} onClose={() => setSelected('')}/>}
  </div>;
}

function CollaborationMap({ snapshot, group, onOpen, navigate }: {
  snapshot: Snapshot; group: Group; onOpen(id: string): void; navigate: Props['navigate'];
}) {
  const owner = snapshot.profiles.find(profile => profile.id === group.owner);
  const recipients = new Map<string, { name: string; tasks: { delegation: Delegation; context: ReturnType<typeof delegationContext> }[] }>();
  for (const delegation of group.delegations) {
    const context = delegationContext(snapshot, delegation);
    const recipient = recipients.get(delegation.target) ?? { name: context.target?.name ?? '연결되지 않은 Ghost', tasks: [] };
    recipient.tasks.push({ delegation, context });
    recipients.set(delegation.target, recipient);
  }
  const completed = group.delegations.filter(item => item.state === 'complete').length;
  return <section className="collab-map" aria-label={`${group.title} 협업 관계`}>
    <header className="collab-map-heading">
      <h2>{group.title}</h2>
      <span>결과 전달 {completed}/{group.delegations.length}</span>
    </header>
    <div className="collab-map-surface">
      <div className="collab-map-flow">
        <button type="button" className="collab-map-source"
          onClick={() => navigate(`/ghosts/${group.owner}${group.sourceId ? `?conversation=${encodeURIComponent(group.sourceId)}` : ''}`)}
          aria-label={`${owner?.name ?? '요청한 Ghost'} · 시작한 대화`}>
          <DotAvatar profileId={group.owner} tone={toneFor(group.owner)} size={40}/>
          <span><small>요청한 Ghost</small><strong>{owner?.name ?? '연결되지 않은 Ghost'}</strong></span>
          <ArrowUpRight size={15} aria-hidden="true"/>
        </button>
        <ul className="collab-map-branches" aria-label="참여 Ghost">
          {[...recipients].map(([id, recipient]) => {
            const flow = recipient.tasks.some(({ context }) => context.status === 'attention') ? 'attention'
              : recipient.tasks.some(({ context }) => context.status === 'working') ? 'working' : 'idle';
            return <li className="collab-map-branch" data-flow={flow} key={id}>
              <div className="collab-map-recipient">
                <h3><DotAvatar profileId={id} tone={toneFor(id)} size={32}/><span>{recipient.name}</span></h3>
                <ul className="collab-map-tasks">{recipient.tasks.map(({ delegation, context }) => <li key={delegation.id}>
                  <button type="button" className="collab-map-task" aria-haspopup="dialog" title={context.title}
                    onClick={() => onOpen(delegation.id)}>
                    <span><strong>{context.title}</strong><Status state={context.status} label={context.label}/></span>
                    <ArrowUpRight size={15} aria-hidden="true"/>
                  </button>
                </li>)}</ul>
              </div>
            </li>;
          })}
        </ul>
      </div>
    </div>
  </section>;
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
  return <Modal title="협업 기록" onClose={onClose} drawer focusClose><div className="collab-record">
    <div className="record-pair"><div><DotAvatar profileId={d.owner} tone={toneFor(d.owner)} size={48}/><strong>{ctx.owner?.name ?? 'Ghost'}</strong><span>요청</span></div><ArrowRight size={22}/><div><DotAvatar profileId={d.target} tone={toneFor(d.target)} size={48}/><strong>{ctx.target?.name ?? 'Ghost'}</strong><span>함께 진행</span></div></div>
    <div className="record-heading"><h2>{ctx.title}</h2><div className="record-state"><Status state={ctx.status} label={ctx.label}/>
      {d.background && !finishedDelegation(d) && <small>백그라운드 협업</small>}</div>
      {ctx.summary && !messages.some(message => message.event.summary === ctx.summary) && <p className="record-summary">{ctx.summary}</p>}
    </div>
    {error && <div className="inline-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button className="icon-button" aria-label="협업 기록 다시 불러오기" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={15}/></button></div>}
    {loading ? <div className="skeleton record-skeleton" aria-label="협업 기록 불러오는 중"/> : <ol className="collab-timeline">{messages.map(m => { const sender = snapshot.profiles.find(p => p.id === m.from); const type = ({ requested: '요청', accepted: '수락', progress: '진행 보고', result: '결과 전달', cancel_requested: '취소 요청', cancel_receipt: '취소 확인' }[m.event.type] ?? m.event.type); return <li key={m.message_id}><div className="timeline-marker">{m.event.type === 'result' ? <Check size={14}/> : <DotAvatar profileId={m.from} tone={toneFor(m.from)} size={29}/>}</div><div className="timeline-copy"><div><strong>{sender?.name ?? 'Ghost'}</strong><time dateTime={new Date(m.created_ms).toISOString()}>{new Date(m.created_ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></div><h3>{type}</h3>{(m.event.prompt || m.event.summary || m.event.reason) && <p>{m.event.prompt || m.event.summary || m.event.reason}</p>}{m.event.artifacts?.length ? <div className="timeline-artifacts">{m.event.artifacts.map((a, i) => <span key={i}>{a}</span>)}</div> : null}{m.event.uncertain_effects?.length ? <p className="form-error">결과 확인이 필요한 작업이 {m.event.uncertain_effects.length}개 있습니다.</p> : null}</div></li>; })}</ol>}
    {!loading && !messages.length && !error && <p className="quiet-empty">저장된 협업 메시지가 아직 없습니다.</p>}
  </div><div className="drawer-footer"><div><button className="button secondary" onClick={() => navigate(`/ghosts/${d.target}?conversation=${d.conversation_id}`)}><MessageCircle size={14}/>대화 열기<ArrowUpRight size={13}/></button>{!finishedDelegation(d) && <button className="button secondary" disabled={busy || d.state === 'cancelling'} onClick={() => setConfirm(v => !v)}><Square size={12}/>{d.state === 'cancelling' ? '취소 확인 중' : '협업 취소'}</button>}</div>{confirm && !finishedDelegation(d) && <form className="cancel-collab-form" onSubmit={e => { e.preventDefault(); const reason = String(new FormData(e.currentTarget).get('reason')); void action({ type: 'workspace', action: { type: 'cancel_delegation', delegation_id: d.id, reason } }).then(() => { setConfirm(false); setAttempt(n => n + 1); }).catch(e => setError(e.message)); }}><label>취소 이유<input name="reason" placeholder="진행 방향이 바뀌었어요." maxLength={2048} required/></label><p className="field-help">이미 완료된 결과와 협업 기록은 남습니다.</p><button className="button primary" disabled={busy}>이 협업 취소</button></form>}</div></Modal>;
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
