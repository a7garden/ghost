import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { Button, Input, Page, Popover, PopoverContent, PopoverTrigger } from '../ui';
import type { Ghost, State, Work } from '@ghost/contract';
import { LifecycleTrack, StateGlyph, glyphLabel, glyphTone, workGlyph } from '../components/agent';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { uiTerms } from '../uiText';
import { liveWork, pendingDecisions, visibleGhosts } from './ghostState';
import { absoluteTime, relativeTime, useNow } from './time';
import { useHost } from '../host/context';
import { useCompact } from '../ui/adaptive';
import { WorkDispatch } from './WorkBrief';
import './Work.css';

const RECENT_FINISHED_MS = 14 * 24 * 60 * 60 * 1_000;
const workTime = (work: Work) => work.endedAt ?? work.updatedAt;

type WorkBoardVisit = { selectedId: string; scrollTop: number; older: boolean };

function WorkGhostFilter({ ghosts, selected, onPick }: {
  ghosts: Pick<Ghost, 'id' | 'name'>[]; selected: string | null; onPick(id: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const pick = (id: string | null) => {
    setOpen(false);
    onPick(id === selected ? null : id);
  };
  const all = <button type="button" className="work-filter__choice" aria-pressed={selected === null} onClick={() => pick(null)}>모든 Ghost</button>;
  const choice = (ghost: Pick<Ghost, 'id' | 'name'>) =>
    <button type="button" key={ghost.id} className="work-filter__choice" aria-pressed={selected === ghost.id} onClick={() => pick(ghost.id)}>{ghost.name}</button>;
  if (ghosts.length <= 3) return <div className="work-filter" role="group" aria-label="담당 Ghost">{all}{ghosts.map(choice)}</div>;

  const needle = query.trim().toLocaleLowerCase();
  const matches = needle ? ghosts.filter(ghost => ghost.name.toLocaleLowerCase().includes(needle)) : ghosts;
  const selectedName = ghosts.find(ghost => ghost.id === selected)?.name ?? '모든 Ghost';
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (value) setQuery(''); }}>
    <PopoverTrigger asChild>
      <button type="button" className="work-filter__choice work-filter__trigger" aria-label={`담당 Ghost: ${selectedName}`}>
        <span>{selectedName}</span><ChevronDown size={14} aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="end" aria-label="담당 Ghost" className="work-filter__menu">
      <Input type="search" className="text-[16px] sm:text-ui" aria-label="Ghost 검색" placeholder="Ghost 검색" value={query} onChange={event => setQuery(event.target.value)}/>
      <div role="group" aria-label="담당 Ghost">{all}{matches.map(choice)}</div>
      {!matches.length && <p className="work-board__empty">검색 결과 없음</p>}
    </PopoverContent>
  </Popover>;
}

function WorkGroups({ works, ghosts, scopes, waiting, now, navigate, onCancel }: {
  works: Work[]; ghosts: State['ghosts']; scopes: State['scopes']; waiting: Set<string>; now: number;
  navigate(path: string): void; onCancel(work: Work): void;
}) {
  const [visit] = useState<WorkBoardVisit | undefined>(() => typeof history === 'undefined' ? undefined : history.state?.workBoard);
  const [older, setOlder] = useState(visit?.older ?? false);
  const selectedRow = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!visit) return;
    document.getElementById('main-content')?.scrollTo(0, visit.scrollTop);
    selectedRow.current?.focus({ preventScroll: true });
  }, [visit]);

  const names = new Map(ghosts.map(ghost => [ghost.id, ghost.name]));
  const projects = new Map(scopes.map(scope => [scope.id, scope.name]));
  const attention: Work[] = [], active: Work[] = [], finished: Work[] = [];
  let hasOlder = false;
  for (const work of works) {
    if (liveWork(work)) (waiting.has(work.id) || work.state === 'blocked' ? attention : active).push(work);
    else if (now - workTime(work) <= RECENT_FINISHED_MS) finished.push(work);
    else { hasOlder = true; if (older) finished.push(work); }
  }
  const openWork = (work: Work) => {
    const scrollTop = document.getElementById('main-content')?.scrollTop ?? 0;
    // The existing Work route unmounts the list. Restore its position and expanded history on Back.
    history.replaceState({ ...history.state, workBoard: { selectedId: work.id, scrollTop, older } }, '');
    navigate(`/work/${encodeURIComponent(work.id)}`);
  };
  const tree = (rows: Work[]) => {
    rows.sort((a, b) => workTime(b) - workTime(a));
    const visible = new Set(rows.map(work => work.id));
    const branches = new Map<string, Work[]>();
    const roots: Work[] = [];
    for (const work of rows) {
      if (work.parentId && visible.has(work.parentId)) {
        const branch = branches.get(work.parentId);
        if (branch) branch.push(work);
        else branches.set(work.parentId, [work]);
      } else roots.push(work);
    }
    const row = (work: Work, depth: number) => {
      const indent = Math.min(depth, 3) * 8;
      const branch = branches.get(work.id);
      const needsOwner = waiting.has(work.id);
      const glyph = workGlyph(work.state, needsOwner);
      const selected = visit?.selectedId === work.id;
      const at = workTime(work);
      return <li key={work.id} className="work-tree__item">
        <div className="work-row" data-selected={selected || undefined} data-tone={glyphTone(glyph)} style={{ '--work-indent': `${indent}px` } as CSSProperties}>
          <button type="button" ref={selected ? selectedRow : undefined} className="work-row__open" onClick={() => openWork(work)}>
            <span className="work-row__glyph" aria-hidden="true"><StateGlyph state={glyph}/></span>
            <span className="work-row__copy">
              <span className="work-row__title">{work.title}</span>
              <span className="work-row__meta">
                {names.get(work.ghostId) ?? 'Ghost'}{work.scopeId && ` · ${projects.get(work.scopeId) ?? '삭제된 프로젝트'}`} · {glyphLabel[glyph]}
              </span>
            </span>
            <time className="work-row__time" dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>{relativeTime(at, now)}</time>
          </button>
          {liveWork(work) && <LifecycleTrack className="work-row__track" state={work.state} needsOwner={needsOwner} compact stageOnly/>}
          {(work.state === 'running' || work.state === 'queued' || work.state === 'waiting') &&
            <Button variant="ghost" size="sm" className="work-row__cancel px-1.5" aria-label={`${work.title} 취소`} onClick={() => onCancel(work)}>취소</Button>}
        </div>
        {branch && <ul className="work-tree work-tree--branch" role="list" style={{ '--work-branch-indent': `${indent}px` } as CSSProperties}>{branch.map(child => row(child, depth + 1))}</ul>}
      </li>;
    };
    return <ul className="work-tree" role="list">{roots.map(work => row(work, 0))}</ul>;
  };

  return <div className="work-groups">
    {attention.length > 0 && <section aria-labelledby="work-group-attention">
      <h2 id="work-group-attention" className="work-group__label" data-attention>확인 필요</h2>
      {tree(attention)}
    </section>}
    {active.length > 0 && <section aria-labelledby="work-group-active">
      <h2 id="work-group-active" className="work-group__label">진행 중</h2>
      {tree(active)}
    </section>}
    {(finished.length > 0 || hasOlder) && <section aria-labelledby="work-group-finished">
      <h2 id="work-group-finished" className="work-group__label">끝난 일</h2>
      <div id="work-finished-list">{finished.length > 0 && tree(finished)}</div>
      {hasOlder && <button type="button" className="work-filter__choice work-group__more" aria-expanded={older} aria-controls="work-finished-list" onClick={() => setOlder(!older)}>{older ? '접기' : '더 보기'}</button>}
    </section>}
  </div>;
}

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
  const [creator, setCreator] = useState<'open' | 'closed' | null>(createRequested ? 'open' : null);
  const [cancelling, setCancelling] = useState<Work | null>(null);
  const ghosts = visibleGhosts(state.ghosts);
  const scoped = filterGhostId ? state.works.filter(work => work.ghostId === filterGhostId) : state.works;
  const offerBrief = creator === null && !scoped.length && ghosts.length > 0;
  const creating = creator === 'open' || offerBrief;
  const createButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (createRequested || offerBrief) setCreator('open'); }, [createRequested, offerBrief]);
  const waiting = new Set<string>();
  for (const decision of pendingDecisions(state)) if (decision.workId) waiting.add(decision.workId);
  const filterGhosts = filterGhostId && !ghosts.some(ghost => ghost.id === filterGhostId)
    ? [...ghosts, { id: filterGhostId, name: state.ghosts.find(ghost => ghost.id === filterGhostId)?.name ?? '이전 Ghost' }]
    : ghosts;
  const closeCreator = () => {
    setCreator('closed');
    if (createRequested) onCreateClosed?.();
  };
  const createAction = !creating && <Button ref={createButton} aria-label="일 맡기기" onClick={() => setCreator('open')} disabled={!ghosts.length}>
    <Plus/><span>일 맡기기</span>
  </Button>;
  return <Page className="work-board">
    <header className={`work-board__toolbar${compact ? '' : ' work-board__header'}`}>
      {!compact && <h1 className="work-board__title">{uiTerms.work}</h1>}
      {filterGhosts.length > 0 && <WorkGhostFilter ghosts={filterGhosts} selected={filterGhostId} onPick={id => {
        if (id === filterGhostId) return;
        const query = new URLSearchParams();
        if (id) query.set('ghost', id);
        if (createRequested) query.set('new', '1');
        const search = query.toString();
        navigate(search ? `/work?${search}` : '/work');
      }}/>}
      {createAction}
    </header>
    {!scoped.length && <p className="work-board__empty">{filterGhostId ? '이 Ghost에게 맡긴 일이 없습니다.' : '아직 맡긴 일이 없습니다.'}</p>}
    {creating && <WorkDispatch ghosts={ghosts} hasProjects={state.scopes.length > 0}
      defaultGhostId={ghosts.find(ghost => ghost.id === filterGhostId)?.id ?? ghosts.find(ghost => ghost.isDefault)?.id ?? ghosts[0]?.id ?? ''}
      onClose={() => { closeCreator(); requestAnimationFrame(() => createButton.current?.focus()); }}
      onCreated={id => { closeCreator(); navigate(`/work/${encodeURIComponent(id)}`); }}/>}
    {scoped.length > 0 && <WorkGroups key={filterGhostId} works={scoped} ghosts={state.ghosts} scopes={state.scopes} waiting={waiting} now={now} navigate={navigate} onCancel={setCancelling}/>}
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
