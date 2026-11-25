import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { Button, Page, PageHeader, SegmentedControl, SelectField } from '../ui';
import type { State, Work } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { PresenceAvatar, WorkLane } from '../components/agent';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { uiTerms } from '../uiText';
import { ghostPresence, visibleGhosts } from './ghostState';
import { useNow } from './time';
import { useHost } from '../host/context';
import { useCompact } from '../ui/adaptive';
import { WorkDispatch } from './WorkBrief';

type WorkTab = 'active' | 'finished';

/** 맡긴 일: every Work the host keeps as delegation trees — live first, then what settled. */
export function WorkView({ state, navigate, filterGhostId, createRequested = false, onCreateClosed }: {
  state: State;
  navigate: (path: string) => void;
  /** ?ghost= narrows the board to one assignee; null shows everyone. */
  filterGhostId: string | null;
  /** ?new=1 opens 일 맡기기 on arrival, as the command palette asks. */
  createRequested?: boolean;
  /** Drops ?new=1 without a history entry once the creator closes or succeeds. */
  onCreateClosed?(): void;
}) {
  const { client } = useHost();
  const compact = useCompact();
  const now = useNow();
  const [tab, setTab] = useState<WorkTab>('active');
  const [cancelling, setCancelling] = useState<Work | null>(null);
  const [creating, setCreating] = useState(createRequested);
  const createButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (createRequested) { setTab('active'); setCreating(true); }
  }, [createRequested]);
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const waiting = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  const settled = (work: Work) => TERMINAL_WORK_STATES.includes(work.state);
  const scoped = state.works.filter(work => (filterGhostId ? work.ghostId === filterGhostId : true));
  const inTab = scoped.filter(work => tab === 'active' ? !settled(work) : settled(work)).sort((a, b) => b.updatedAt - a.updatedAt);
  // A child hangs under its parent when both are on this board; otherwise it stands as its own lane.
  const shown = new Set(inTab.map(work => work.id));
  const roots = inTab.filter(work => !work.parentId || !shown.has(work.parentId));
  const counts = { active: scoped.filter(work => !settled(work)).length, finished: scoped.filter(settled).length };
  const lane = (work: Work) => {
    const children = inTab.filter(child => child.parentId === work.id);
    return <WorkLane key={work.id} work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'} projectName={work.scopeId ? state.scopes.find(scope => scope.id === work.scopeId)?.name ?? '삭제된 프로젝트' : undefined} needsOwner={waiting.has(work.id)} now={now}
      showGhost={!filterGhostId || work.ghostId !== filterGhostId}
      onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}
      action={work.state === 'running' || work.state === 'queued' || work.state === 'waiting'
        ? <Button variant="ghost" size="sm" aria-label={`${work.title} 취소`} onClick={() => setCancelling(work)}>취소</Button> : undefined}
      branch={children.length > 0 ? children.map(lane) : undefined}/>;
  };
  const ghosts = visibleGhosts(state.ghosts);
  const closeCreator = () => {
    setCreating(false);
    if (createRequested) onCreateClosed?.();
  };
  const createAction = !creating && <Button ref={createButton} aria-label="일 맡기기" onClick={() => { setTab('active'); setCreating(true); }} disabled={!ghosts.length}>
    <Plus/><span>일 맡기기</span>
  </Button>;
  return <Page className="work-board grid content-start gap-6">
    {!compact && <PageHeader title={uiTerms.work} className="work-board__header mb-2" actions={createAction}/>}
    <div className="board-bar">
      <SegmentedControl aria-label="맡긴 일 상태" value={tab} onValueChange={setTab}
        options={[{ value: 'active', label: '진행 중', count: counts.active }, { value: 'finished', label: '끝난 일', count: counts.finished }]}/>
      {compact && (ghosts.length > 1 || filterGhostId) && <label className="board-assignee" data-filtered={Boolean(filterGhostId) || undefined}>
        <span aria-hidden="true">{(filterGhostId && names.get(filterGhostId)) || '담당'}</span><ChevronDown size={14} aria-hidden="true"/>
        <select aria-label="담당 Ghost" value={filterGhostId ?? ''} onChange={event =>
          navigate(event.target.value ? `/work?ghost=${encodeURIComponent(event.target.value)}` : '/work')}>
          <option value="">모든 Ghost</option>
          {filterGhostId && !ghosts.some(ghost => ghost.id === filterGhostId) && <option value={filterGhostId}>{names.get(filterGhostId) ?? '이전 Ghost'}</option>}
          {ghosts.map(ghost => <option key={ghost.id} value={ghost.id}>{ghost.name}</option>)}
        </select>
      </label>}
      {compact && createAction}
      {!compact && (ghosts.length > 6
        ? <SelectField label="담당 Ghost" value={filterGhostId ?? ''} disabled={!ghosts.length}
          onValueChange={value => navigate(value ? `/work?ghost=${encodeURIComponent(value)}` : '/work')}
          options={[{ value: '', label: '모든 Ghost' }, ...ghosts.map(ghost => ({ value: ghost.id, label: ghost.name }))]}
          className="ghost-filter__select"/>
        : ghosts.length > 1 && <div className="ghost-filter" role="group" aria-label="담당 Ghost">
          <button type="button" aria-pressed={!filterGhostId} onClick={() => navigate('/work')}>전체</button>
          {ghosts.map(ghost => <button key={ghost.id} type="button" aria-pressed={filterGhostId === ghost.id} title={ghost.name}
            onClick={() => navigate(filterGhostId === ghost.id ? '/work' : `/work?ghost=${encodeURIComponent(ghost.id)}`)}>
            <PresenceAvatar ghostId={ghost.id} state={ghostPresence(ghost, state).state} size={18}/><span>{ghost.name}</span>
          </button>)}
        </div>)}
    </div>
    {creating && <WorkDispatch ghosts={ghosts} hasProjects={state.scopes.length > 0}
      defaultGhostId={ghosts.find(ghost => ghost.id === filterGhostId)?.id ?? ghosts.find(ghost => ghost.isDefault)?.id ?? ghosts[0]?.id ?? ''}
      onClose={() => { closeCreator(); requestAnimationFrame(() => createButton.current?.focus()); }}
      onCreated={id => { closeCreator(); navigate(`/work/${encodeURIComponent(id)}`); }}/>}
    {roots.length > 0
      ? <div className="lanes">{roots.map(lane)}</div>
      : (!creating || tab === 'finished') && <div className="calm"><p>{tab === 'active' ? '진행 중인 일 없음' : '끝난 일 없음'}</p></div>}
    {cancelling && <CancelWorkDialog work={cancelling} onCancel={() => client.send({ type: 'work.cancel', workId: cancelling.id })} onClose={() => setCancelling(null)}/>}
  </Page>;
}

/**
 * Cancelling has no undo: the host stops the run, closes its pending decisions and cancels every
 * live delegated Work beneath it, and a cancelled Work cannot be resumed.
 */
export function CancelWorkDialog({ work, onCancel, onClose }: { work: Work; onCancel(): Promise<unknown>; onClose(): void }) {
  return <ConfirmDialog title="맡긴 일 취소" confirmLabel="일 취소" onConfirm={onCancel} onClose={onClose}>
    <p className="m-0">「{work.title}」의 진행을 멈춥니다. 기다리던 확인 요청은 닫히고, 이 일이 위임한 일도 함께 취소됩니다.</p>
    <p className="m-0">취소한 일은 다시 이어 갈 수 없습니다.</p>
  </ConfirmDialog>;
}
