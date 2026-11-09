import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, FormField, Page, PageHeader, InlineError, Input, SegmentedControl, SelectField, Textarea } from '../ui'
import type { ExecutionTarget, State, Work } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { PresenceAvatar, WorkLane } from '../components/agent';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';
import { ghostPresence, visibleGhosts } from './ghostState';
import { useNow } from './time';
import { useHost } from '../host/context';

type WorkTab = 'active' | 'finished';

/** 맡긴 일: every Work the host keeps as delegation trees — live first, then what settled. */
export function WorkView({ state, navigate, filterGhostId }: {
  state: State;
  navigate: (path: string) => void;
  /** ?ghost= narrows the board to one assignee; null shows everyone. */
  filterGhostId: string | null;
}) {
  const { client } = useHost();
  const now = useNow();
  const [tab, setTab] = useState<WorkTab>('active');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const waiting = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  const settled = (work: Work) => TERMINAL_WORK_STATES.includes(work.state);
  const scoped = state.works.filter(work => (filterGhostId ? work.ghostId === filterGhostId : true));
  const inTab = scoped.filter(work => tab === 'active' ? !settled(work) : settled(work)).sort((a, b) => b.updatedAt - a.updatedAt);
  // A child hangs under its parent when both are on this board; otherwise it stands as its own lane.
  const shown = new Set(inTab.map(work => work.id));
  const roots = inTab.filter(work => !work.parentId || !shown.has(work.parentId));
  const counts = { active: scoped.filter(work => !settled(work)).length, finished: scoped.filter(settled).length };
  const cancel = (work: Work) => { setError(''); void client.send({ type: 'work.cancel', workId: work.id }).catch(e => setError(e instanceof Error ? e.message : '맡긴 일을 취소하지 못했습니다.')); };
  const lane = (work: Work) => {
    const children = inTab.filter(child => child.parentId === work.id);
    return <WorkLane key={work.id} work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'} needsOwner={waiting.has(work.id)} now={now}
      showGhost={!filterGhostId || work.ghostId !== filterGhostId}
      onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}
      action={work.state === 'running' || work.state === 'queued' || work.state === 'waiting'
        ? <Button variant="ghost" size="sm" aria-label={`${work.title} 취소`} onClick={() => cancel(work)}>취소</Button> : undefined}
      branch={children.length > 0 ? children.map(lane) : undefined}/>;
  };
  const ghosts = visibleGhosts(state.ghosts);
  return <Page className="grid content-start gap-6">
    <PageHeader title={uiTerms.work} className="mb-2" actions={<Button onClick={() => setCreating(true)} disabled={!state.ghosts.length}><Plus/>일 맡기기</Button>}/>
    <div className="board-bar">
      <SegmentedControl aria-label="맡긴 일 상태" value={tab} onValueChange={setTab}
        options={[{ value: 'active', label: '진행 중', count: counts.active }, { value: 'finished', label: '끝난 일', count: counts.finished }]}/>
      {/* A small team shows presence chips; past six Ghosts the row becomes a select. */}
      {ghosts.length > 6
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
        </div>}
    </div>
    {error && <InlineError>{error}</InlineError>}
    {roots.length > 0
      ? <div className="lanes">{roots.map(lane)}</div>
      : <div className="calm"><p>{tab === 'active' ? '진행 중인 일 없음' : '끝난 일 없음'}</p></div>}
    {creating && <NewWorkModal state={state} defaultGhostId={filterGhostId && ghosts.some(ghost => ghost.id === filterGhostId) ? filterGhostId : ghosts.find(ghost => ghost.isDefault)?.id ?? ghosts[0]?.id ?? ''}
      onClose={() => setCreating(false)} onCreated={id => { setCreating(false); navigate(`/work/${encodeURIComponent(id)}`); }}/>}
  </Page>;
}

/** 일 맡기기: one Ghost, what to do, how it is judged finished, and when it must be done. */
export function NewWorkModal({ state, defaultGhostId, onClose, onCreated }: {
  state: State;
  defaultGhostId: string | null;
  onClose(): void;
  onCreated(workId: string): void;
}) {
  const { client } = useHost();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ghosts = visibleGhosts(state.ghosts);
  const [ghostId, setGhostId] = useState(defaultGhostId ?? ghosts[0]?.id ?? '');
  const [execution, setExecution] = useState<'container' | 'host'>('container');
  const [cwd, setCwd] = useState('');
  const selected = ghosts.find(ghost => ghost.id === ghostId) ?? null;
  const hostAllowed = selected?.hostExecution === true;
  const pickGhost = (id: string) => {
    setGhostId(id);
    // PC execution is per-Ghost owner grant; losing it must never leave host selected invisibly.
    if (ghosts.find(ghost => ghost.id === id)?.hostExecution !== true) { setExecution('container'); setCwd(''); }
  };
  const submit = (data: FormData) => {
    const title = String(data.get('title')).trim();
    const brief = String(data.get('brief')).trim();
    const criteria = String(data.get('criteria') ?? '').trim();
    const deadline = String(data.get('deadline'));
    if (!title || !brief || !ghostId) return;
    let target: ExecutionTarget = { kind: 'container' };
    if (execution === 'host') {
      const path = cwd.trim();
      if (!path.startsWith('/')) { setError('작업 폴더는 /로 시작하는 전체 경로여야 합니다.'); return; }
      if (path.length > 4096) { setError('작업 폴더 경로는 4,096자 이하여야 합니다.'); return; }
      target = { kind: 'host', cwd: path };
    }
    setBusy(true); setError('');
    void (async () => {
      try {
        const created = await client.send<{ workId: string }>({
          type: 'work.create', ghostId, title, brief,
          ...(criteria ? { acceptance: { criteria, checks: [], reviewer: null } } : {}),
          ...(deadline ? { deadlineAt: new Date(deadline).getTime() } : {}),
          execution: target,
        });
        onCreated(created.workId);
      } catch (e) {
        setError(e instanceof Error ? e.message : '맡긴 일을 만들지 못했습니다. 다시 시도해 주세요.');
        setBusy(false);
      }
    })();
  };
  return <Modal title="일 맡기기" onClose={() => { if (!busy) onClose(); }}>
    <form className="grid gap-4" onSubmit={e => { e.preventDefault(); submit(new FormData(e.currentTarget)); }}>
      <FormField label="맡길 Ghost" required>
        {control => <SelectField {...control} label="맡길 Ghost" value={ghostId} onValueChange={pickGhost} required
          options={ghosts.map(ghost => ({ value: ghost.id, label: ghost.isDefault ? `${ghost.name} · 메인` : ghost.name }))}/>}
      </FormField>
      <FormField label="제목" required>
        {control => <Input {...control} name="title" placeholder="예: 1분기 회고 자료 모으기" required maxLength={256}/>}
      </FormField>
      <FormField label="할 일" required>
        {control => <Textarea {...control} name="brief" placeholder="무엇을, 어떻게 완료할지 적어 주세요." required maxLength={32768} rows={5}/>}
      </FormField>
      <FormField label="완료 기준">
        {control => <Input {...control} name="criteria" placeholder="무엇이 되면 끝난 것인지" maxLength={8192}/>}
      </FormField>
      <FormField label="기한" description="비워 두면 기한 없이 진행합니다.">
        {control => <Input {...control} type="datetime-local" name="deadline"/>}
      </FormField>
      <FormField label="실행 환경" description={selected
        ? hostAllowed ? undefined : '이 Ghost는 PC 직접 실행이 허용되지 않았습니다. Ghost 설정의 운영에서 허용할 수 있습니다.'
        : undefined}>
        {control => <SegmentedControl {...control} aria-label="실행 환경" value={execution}
          onValueChange={value => setExecution(value as 'container' | 'host')}
          options={[{ value: 'container', label: '컨테이너', disabled: busy },
            { value: 'host', label: '이 Mac', disabled: busy || !hostAllowed }]}/>}
      </FormField>
      {execution === 'host' && <>
        <FormField label="작업 폴더" required description="이 폴더 안에서 파일과 명령을 곧바로 실행합니다.">
          {control => <Input {...control} name="cwd" value={cwd} required maxLength={4096} placeholder="/Users/garden/Workspace"
            onChange={event => setCwd(event.target.value)}/>}
        </FormField>
        <p className="activity-warn">이 Mac 실행은 샌드박스 없이 셸을 씁니다. PC 전체와 네트워크에 영향을 줄 수 있습니다.</p>
      </>}
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={busy}>{busy ? '맡기는 중…' : '일 맡기기'}</Button>
    </form>
  </Modal>;
}
