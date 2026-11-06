import { OrchestrationView } from './OrchestrationView';
import { uiTerms } from '../uiText';
import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, GitBranch, MessageCircle, Plus, Square } from 'lucide-react';
import { Badge, Button, EmptyState, GPage, GPageHeader, InlineError, Input, Skeleton } from '@garden/ui';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { Status } from '../components/Status';
import { WorkRow } from './WorkViews';
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

  return <GPage>
    <GPageHeader actions={<>
      <Button variant="outline" onClick={() => navigate('/together?view=structure')}><GitBranch className="size-4"/>작업 구조</Button>
      <Button onClick={onAssign} disabled={!snapshot.profiles.length}><Plus className="size-4"/>협업 요청</Button>
    </>} title={<span className="flex flex-wrap items-center gap-2">{uiTerms.collaboration}{mode === 'demo' && <Badge variant="outline">예시 데이터</Badge>}</span>}/>

    {group ? <div className={`grid items-start gap-4 ${groups.length > 1 ? 'min-[74rem]:grid-cols-[minmax(11rem,14rem)_minmax(0,1fr)]' : ''}`}>
      {groups.length > 1 && <nav className="grid max-h-44 min-w-0 gap-1 overflow-y-auto min-[74rem]:max-h-[min(60dvh,36rem)]" aria-label="협업 선택">
        {groups.map(item => {
          const open = item.id === group.id;
          const active = item.delegations.filter(delegation => !finishedDelegation(delegation)).length;
          return <button type="button" aria-current={open ? 'true' : undefined} key={item.id}
            title={item.title} onClick={() => { onGroupChange(item.id); if (requested) navigate('/together'); }}
            className={`flex min-h-12 min-w-0 items-center gap-2 rounded-control border-l-2 p-2 text-left hover:bg-hover aria-[current=true]:bg-hover ${open ? 'border-l-ink' : 'border-l-transparent'}`}>
            <DotAvatar profileId={item.owner} tone={toneFor(item.owner)} size={28}/>
            <span className="grid min-w-0 gap-1"><strong className="truncate text-ui font-medium text-ink">{item.title}</strong>
              <small className={`text-caption ${active ? 'font-medium text-ink' : 'text-ink-2'}`} data-active={active > 0}>{active ? `진행 중 ${active}개` : '종료'}</small></span>
          </button>;
        })}
      </nav>}
      <CollaborationMap snapshot={snapshot} group={group} onOpen={setSelected} navigate={navigate}/>
    </div> : <div className="border-t border-line">
      <EmptyState title="아직 협업이 없습니다." description={snapshot.profiles.length > 0 ? 'Ghost에게 다른 Ghost와 함께 일해 달라고 요청하면 여기에 표시됩니다.' : undefined} className="py-12"/>
    </div>}

    {detail && <CollaborationRecord key={detail.id} snapshot={snapshot} delegation={detail} query={query} action={action}
      busy={busy} navigate={navigate} onClose={() => setSelected('')}/>}
  </GPage>;
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
  const entries = [...recipients];
  const flowLine = (flow: string) => flow === 'attention' ? 'bg-orange' : flow === 'working' ? 'bg-ink-2' : 'bg-line-strong';
  return <section className="min-w-0 overflow-hidden rounded-card border border-line" aria-label={`${group.title} 협업 관계`}>
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-3">
      <h2 className="m-0 min-w-0 text-body font-semibold text-ink [overflow-wrap:anywhere]">{group.title}</h2>
      <span className="whitespace-nowrap text-caption tabular-nums text-ink-2">결과 전달 {completed}/{group.delegations.length}</span>
    </header>
    <div className="bg-inset p-4 sm:p-8">
      <div className="mx-auto grid max-w-[52rem] gap-4 md:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.4fr)] md:items-center">
        <button type="button" className="relative flex min-w-0 items-center gap-2 rounded-card border border-line bg-surface p-3 text-left hover:bg-hover"
          onClick={() => navigate(`/ghosts/${group.owner}${group.sourceId ? `?conversation=${encodeURIComponent(group.sourceId)}` : ''}`)}
          aria-label={`${owner?.name ?? '요청한 Ghost'} · 시작한 대화`}>
          <DotAvatar profileId={group.owner} tone={toneFor(group.owner)} size={40}/>
          <span className="grid min-w-0 flex-1"><small className="text-caption text-ink-2">요청한 Ghost</small><strong className="truncate">{owner?.name ?? '연결되지 않은 Ghost'}</strong></span>
          <ArrowUpRight className="size-3.5 shrink-0 text-ink-2" aria-hidden="true"/>
          <span aria-hidden="true" className="absolute left-6 top-full h-4 w-px bg-line-strong md:hidden"/>
          <span aria-hidden="true" className="absolute left-full top-1/2 hidden h-px w-4 -translate-y-1/2 bg-line-strong md:block"/>
        </button>
        <ul className="m-0 min-w-0 list-none p-0" aria-label="참여 Ghost">
          {entries.map(([id, recipient], index) => {
            const flow = recipient.tasks.some(({ context }) => context.status === 'attention') ? 'attention'
              : recipient.tasks.some(({ context }) => context.status === 'working') ? 'working' : 'idle';
            const last = index === entries.length - 1;
            return <li className="relative py-2 pl-6" data-flow={flow} key={id}>
              <span aria-hidden="true" className={`absolute left-0 top-0 w-px ${last ? 'h-1/2' : 'h-full'} ${flowLine(flow)}`}/>
              <span aria-hidden="true" className={`absolute left-0 top-1/2 h-px w-6 ${flowLine(flow)}`}/>
              <div className="min-w-0 rounded-card border border-line bg-surface">
                <h3 className="m-0 flex items-center gap-2 px-3 py-2 text-body font-semibold text-ink">
                  <DotAvatar profileId={id} tone={toneFor(id)} size={32}/><span className="truncate">{recipient.name}</span>
                </h3>
                <ul className="m-0 list-none p-0">{recipient.tasks.map(({ delegation, context }) => <li key={delegation.id}>
                  <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 border-t border-line px-3 py-2 text-left hover:bg-hover first:border-t-0" aria-haspopup="dialog" title={context.title}
                    onClick={() => onOpen(delegation.id)}>
                    <span className="grid min-w-0 gap-1"><strong className="truncate text-ui font-medium text-ink">{context.title}</strong><Status state={context.status} label={context.label}/></span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-ink-2" aria-hidden="true"/>
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
  return <Modal title="협업 기록" onClose={onClose} drawer focusClose><div className="grid gap-6">
    <div className="flex items-center justify-center gap-8 pb-2 pt-4">
      <div className="flex flex-col items-center gap-1"><DotAvatar profileId={d.owner} tone={toneFor(d.owner)} size={48}/><strong className="text-body font-semibold text-ink">{ctx.owner?.name ?? 'Ghost'}</strong><span className="text-caption text-ink-3">요청</span></div>
      <ArrowRight className="mb-7 size-5 shrink-0 text-ink-3"/>
      <div className="flex flex-col items-center gap-1"><DotAvatar profileId={d.target} tone={toneFor(d.target)} size={48}/><strong className="text-body font-semibold text-ink">{ctx.target?.name ?? 'Ghost'}</strong><span className="text-caption text-ink-3">함께 진행</span></div>
    </div>
    <div className="border-b border-line pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 min-w-0 text-headingSm font-semibold text-ink">{ctx.title}</h2>
        <div className="flex items-center gap-2"><Status state={ctx.status} label={ctx.label}/>
          {d.background && !finishedDelegation(d) && <small className="text-caption text-ink-2">백그라운드 협업</small>}</div>
      </div>
      {ctx.summary && !messages.some(message => message.event.summary === ctx.summary) && <p className="mb-0 mt-3 whitespace-pre-wrap text-ui [overflow-wrap:anywhere]">{ctx.summary}</p>}
    </div>
    {error && <InlineError onRetry={() => setAttempt(n => n + 1)} retryLabel="다시 불러오기">{error}</InlineError>}
    {loading ? <Skeleton className="h-60" aria-label="협업 기록 불러오는 중"/> : <ol className="m-0 list-none p-0">{messages.map((m, index) => {
      const sender = snapshot.profiles.find(p => p.id === m.from);
      const type = ({ requested: '요청', accepted: '수락', progress: '진행 보고', result: '결과 전달', cancel_requested: '취소 요청', cancel_receipt: '취소 확인' }[m.event.type] ?? m.event.type);
      return <li key={m.message_id} className="relative flex gap-3 pb-7 last:pb-0">
        {index < messages.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[14px] top-[30px] w-px bg-line"/>}
        <div className="grid size-[29px] shrink-0 place-items-center rounded-full text-ink">{m.event.type === 'result' ? <Check className="size-3.5"/> : <DotAvatar profileId={m.from} tone={toneFor(m.from)} size={29}/>}</div>
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-center gap-2"><strong className="text-caption font-semibold text-ink">{sender?.name ?? 'Ghost'}</strong><time className="ml-auto text-2xs text-ink-3" dateTime={new Date(m.created_ms).toISOString()}>{new Date(m.created_ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></div>
          <h3 className="mb-0 mt-1 text-2xs font-normal text-ink-3">{type}</h3>
          {(m.event.prompt || m.event.summary || m.event.reason) && <p className="mb-0 mt-3 whitespace-pre-wrap text-caption leading-[1.85] [overflow-wrap:anywhere]">{m.event.prompt || m.event.summary || m.event.reason}</p>}
          {m.event.artifacts?.length ? <div className="mt-3 flex flex-wrap gap-2">{m.event.artifacts.map((a, i) => <span key={i} className="rounded-md border border-line bg-inset px-3 py-2 text-2xs [overflow-wrap:anywhere]">{a}</span>)}</div> : null}
          {m.event.uncertain_effects?.length ? <p className="mt-3 text-caption text-danger">결과 확인이 필요한 작업이 {m.event.uncertain_effects.length}개 있습니다.</p> : null}
        </div>
      </li>;
    })}</ol>}
    {!loading && !messages.length && !error && <p className="m-0 text-caption text-ink-2">저장된 협업 메시지가 아직 없습니다.</p>}
  </div>
    <div className="mt-2 flex flex-wrap items-end justify-between gap-3"><div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => navigate(`/ghosts/${d.target}?conversation=${d.conversation_id}`)}><MessageCircle className="size-3.5"/>대화 열기<ArrowUpRight className="size-3"/></Button>
      {!finishedDelegation(d) && <Button variant="outline" size="sm" disabled={busy || d.state === 'cancelling'} onClick={() => setConfirm(v => !v)}><Square className="size-3"/>{d.state === 'cancelling' ? '취소 확인 중' : '협업 취소'}</Button>}
    </div>
      {confirm && !finishedDelegation(d) && <form className="grid flex-1 basis-72 gap-3" onSubmit={e => { e.preventDefault(); const reason = String(new FormData(e.currentTarget).get('reason')); void action({ type: 'workspace', action: { type: 'cancel_delegation', delegation_id: d.id, reason } }).then(() => { setConfirm(false); setAttempt(n => n + 1); }).catch(e => setError(e.message)); }}>
        <label className="grid gap-2 text-caption">취소 이유<Input name="reason" placeholder="진행 방향이 바뀌었어요." maxLength={2048} required/></label>
        <p className="m-0 text-caption text-ink-2">이미 완료된 결과와 협업 기록은 남습니다.</p>
        <div><Button type="submit" disabled={busy}>이 협업 취소</Button></div>
      </form>}
    </div></Modal>;
}

export function CollaborationStrip({ snapshot, profileId, conversationId, navigate }: { snapshot: Snapshot; profileId: string; conversationId?: string; navigate: Props['navigate'] }) {
  const records = snapshot.delegations.filter(d => {
    if (d.target === profileId) return d.conversation_id === conversationId;
    return d.owner === profileId && delegationContext(snapshot, d).source?.id === conversationId;
  });
  if (!records.length) return null;
  const peers = [...new Set(records.map(d => d.owner === profileId ? d.target : d.owner))];
  const running = records.filter(d => !finishedDelegation(d)).length;
  return <WorkRow className="mt-2 rounded-card border border-line bg-surface px-4 py-4"
    leading={<span className="flex shrink-0 pr-1">{peers.slice(0, 4).map((id, i) => <DotAvatar key={id} profileId={id} tone={toneFor(id)} size={37} className={i ? '-ml-3' : ''}/>)}</span>}
    title={<span className="truncate">{peers.map(id => snapshot.profiles.find(p => p.id === id)?.name ?? 'Ghost').join(', ')}와 함께</span>}
    status={{ label: running ? '협업 진행 중' : '협업 종료', tone: running ? 'default' : 'outline' }}
    action={<span className="flex items-center gap-1 text-caption text-ink-2">협업 보기<ArrowUpRight className="size-3.5"/></span>}
    onClick={() => navigate(`/together?delegation=${records[0].id}`)}
  />;
}
