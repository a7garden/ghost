import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleSlash2, Crown, Lock, MessageCircle, Pause, Pencil, Plus, Power, RotateCcw, Search, Square, Trash2, X } from 'lucide-react';
import { ADAPTATION_MAX_CHARS, BROWSER_TOOLS, CODE_TOOLS, DESKTOP_TOOLS, FINANCE_TOOLS, GHOST_TOOLS, HOST_TOOLS, MAIL_TOOLS, VAULT_TOOLS, type Adaptation, type AutonomyPlan, type Command, type Ghost, type GhostPackageEntry, type GhostState, type GhostTool, type ModelRef, type Scope, type SkillCatalog } from '@ghost/contract';
import { Button, InlineError, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { DotAvatar } from '../components/DotAvatar';
import { StateGlyph } from '../components/agent/StateGlyph';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ghostAddPath } from './ghostRoutes';
import { GhostDesignEditor } from './GhostDesign';
import { GhostMemory } from './GhostMemory';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';
import './ghost-settings.css';
import { blurTouchSearchOnEnter, useCompact } from '../ui/adaptive';
import { FallbackSteps, ModelChoice, editFallbacks, modelName, type FallbackAction } from './fallbacks';
import { toolLabels } from './toolLabels';
import { PatternGrants } from './PatternGrants';
import { GhostAttachments } from './GhostAttachments';
import './GhostSettings.css';

export { MAX_FALLBACKS, editFallbacks, type FallbackAction } from './fallbacks';

/** 용도별 묶음. contract의 GHOST_TOOLS를 따르고 여기 없는 새 도구는 기타로 내려간다. Exported for the coverage test. */
export const toolGroups: readonly { title: string; tools: readonly GhostTool[]; privileged?: boolean }[] = [
  { title: '맡긴 일', tools: ['work_create', 'work_list', 'work_inspect', 'work_update', 'work_cancel'] },
  { title: '협업', tools: ['delegate', 'ghost_list', 'publish_artifact', 'subagent_run'] },
  { title: '파일과 명령', tools: ['read', 'write', 'edit', 'bash'] },
  { title: '웹', tools: ['web_search', 'web_read', 'reach'] },
  { title: '연결', tools: ['connection_list', 'connection_register', 'connection_request'] },
  { title: '브라우저', tools: [...BROWSER_TOOLS] },
  { title: '금고', tools: [...VAULT_TOOLS] },
  { title: '메일', tools: [...MAIL_TOOLS] },
  { title: '스킬', tools: ['skill_read'] },
  { title: '문서', tools: ['document_scopes', 'document_list', 'document_read', 'document_propose'] },
  { title: '반복 작업', tools: ['schedule_create', 'schedule_list', 'schedule_cancel'] },
  { title: '자동 활동', tools: ['activity_propose'] },
  { title: '구성', tools: ['scope_create', 'scope_update', 'scope_attach', 'scope_delete', 'slot_set', 'slot_delete', 'limits_set', 'rule_create', 'rule_update', 'rule_delete', 'rule_propose', 'mcp_create', 'mcp_update', 'mcp_delete', 'config_revert', 'config_history', 'metrics_read'] },
  { title: '목표', tools: ['goal_list', 'goal_propose', 'milestone_plan', 'milestone_update'] },
  { title: 'Mac', tools: [...HOST_TOOLS], privileged: true },
  { title: '코딩 세션에서 일하기', tools: [...CODE_TOOLS], privileged: true },
  { title: 'PC 조작', tools: [...DESKTOP_TOOLS], privileged: true },
  { title: '자산', tools: [...FINANCE_TOOLS], privileged: true },
];
/** 대화 종류에 따라 항상 쓰는 도구. 선택 목록에 없고 끌 수 없다. */
const alwaysTools = ['소유자에게 묻기', '위임한 Ghost에게 묻기', '자식 일에 답하기', '일 완료 보고', '일 상태 보고', '결과물 읽기', '실행 기록 보기', '관측 근거 읽기', '검토 판정'];
const states = [
  { value: 'active', label: '사용 중', icon: Power },
  { value: 'paused', label: '일시 중지', icon: Pause },
  { value: 'retired', label: '은퇴', icon: CircleSlash2 },
] as const;
const ghostSplitQuery = '(min-width: 64rem)';
const ghostRosterRoute = '/settings?tab=team';
type RosterPosition = { scroll: number; query: string; row: string };
type GhostSettingsHistory = { ghostSettingsRoster?: RosterPosition; ghostSettingsFromRoster?: boolean };

function subscribeGhostSplit(listener: () => void) {
  const media = matchMedia(ghostSplitQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function GhostStateWord({ state }: { state: GhostState }) {
  const { label, icon: Icon } = states.find(item => item.value === state)!;
  return <span className="ghost-state-word" data-state={state}><Icon aria-hidden="true"/>{label}</span>;
}
/** The settings roster: deleted Ghosts leave it, the main Ghost leads, then oldest first. Pure; tests pin it. */
export function settingsRoster(ghosts: readonly Ghost[]): Ghost[] {
  return ghosts.filter(ghost => ghost.deletedAt === null)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt);
}

export function GhostSettings({ onChat, onSelect, selectedGhostId }: {
  onChat(id: string): void;
  onSelect(id: string): void;
  selectedGhostId?: string;
}) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const split = useSyncExternalStore(subscribeGhostSplit, () => matchMedia(ghostSplitQuery).matches, () => false);
  const compact = useCompact();
  const ghosts = settingsRoster(state?.ghosts ?? []);
  const [query, setQuery] = useState(() => typeof history === 'undefined' ? '' : (history.state as GhostSettingsHistory | null)?.ghostSettingsRoster?.query ?? '');
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? ghosts.filter(ghost => ghost.name.toLocaleLowerCase().includes(needle)) : ghosts;
  const selected = ghosts.find(ghost => ghost.id === selectedGhostId) ?? (split ? ghosts[0] : undefined);
  const showingDetail = selectedGhostId !== undefined;
  const root = useRef<HTMLElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const didShowDetail = useRef(showingDetail);

  useLayoutEffect(() => {
    const scroller = root.current?.closest('.ghost-settings__content');
    if (!scroller) return;
    if (!split && !showingDetail) {
      const saved = (history.state as GhostSettingsHistory | null)?.ghostSettingsRoster;
      scroller.scrollTop = saved?.scroll ?? 0;
      if (saved) document.getElementById(saved.row)?.focus({ preventScroll: true });
    } else {
      scroller.scrollTop = 0;
      if (!split && !didShowDetail.current) detail.current?.focus({ preventScroll: true });
    }
    didShowDetail.current = showingDetail;
  }, [split, showingDetail, selected?.id]);

  const rememberRoster = (row: string) => {
    if (split) return;
    const scroll = root.current?.closest('.ghost-settings__content')?.scrollTop ?? 0;
    history.replaceState({ ...history.state, ghostSettingsRoster: { scroll, query, row } }, '');
  };
  const select = (id: string) => {
    if (split && id === selectedGhostId) return;
    rememberRoster(`settings-ghost-${id}`);
    onSelect(id);
    if (!split) history.replaceState({ ...history.state, ghostSettingsFromRoster: true }, '');
  };

  return <section ref={root} className="ghost-settings-page" aria-label={uiTerms.ghostSettings} data-split={split || undefined}>
    {(split || !showingDetail) && <div className="roster-picker">
      {(ghosts.length >= 8 || query) && <div className="roster-search">
        <Search aria-hidden="true"/>
        <input type="text" enterKeyHint="search" aria-label="설정할 Ghost 찾기" placeholder="Ghost 찾기" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>
        {query && <button type="button" aria-label="Ghost 검색 지우기" onClick={() => setQuery('')}><X aria-hidden="true"/></button>}
      </div>}
      <ul className="ghost-config-roster" aria-label="설정할 Ghost">
        {shown.map(ghost => <li key={ghost.id}>
          <button type="button" id={`settings-ghost-${ghost.id}`} aria-label={ghost.name}
            aria-describedby={`settings-ghost-${ghost.id}-state`}
            aria-pressed={split ? ghost.id === selected?.id : undefined} className="roster__ghost"
            title={ghost.name} data-state={ghost.state} onClick={() => select(ghost.id)}>
            <span className="roster__portrait"><DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={32}/></span>
            <span className="roster__copy">
              <span className="roster__name">{ghost.name}</span>
              <span id={`settings-ghost-${ghost.id}-state`}>
                <GhostStateWord state={ghost.state}/>{ghost.isDefault && <span className="sr-only"> · 메인</span>}
              </span>
            </span>
            {ghost.isDefault && <Crown className="roster__crown" aria-hidden="true"/>}
            {!split && <ArrowRight className="roster__arrow" aria-hidden="true"/>}
          </button>
        </li>)}
      </ul>
      {!shown.length && state && <p className="roster__empty" role="status">{needle ? '일치하는 Ghost가 없습니다.' : '설정할 Ghost가 없습니다.'}</p>}
      <a id="settings-new-ghost" className="roster__new" href={`#${ghostAddPath}`} onClick={() => rememberRoster('settings-new-ghost')}>
        <Plus aria-hidden="true"/>Ghost 추가
      </a>
    </div>}
    {(split || showingDetail) && <div ref={detail} className="ghost-settings-page__detail" tabIndex={-1}>
      {!split && !compact && <a className="ghost-settings-page__back" href={`#${ghostRosterRoute}`} onClick={event => {
        if ((history.state as GhostSettingsHistory | null)?.ghostSettingsFromRoster) { event.preventDefault(); history.back(); }
      }}><ArrowLeft aria-hidden="true"/>Ghost 목록</a>}
      {selected
        ? <GhostSheet key={selected.id} ghost={selected} onChat={() => onChat(selected.id)}/>
        : state && showingDetail && <p className="roster__empty" role="status">이 Ghost를 찾을 수 없습니다.</p>}
    </div>}
  </section>;
}

/** Saves a change and reports failure in place; the newest request wins the status line. */
function useSaver() {
  const { client } = useHost();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const save = async (command: Parameters<typeof client.send>[0]) => {
    setError(''); setPending(count => count + 1);
    try { await client.send(command); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 시도해 주세요.'); return false; }
    finally { setPending(count => count - 1); }
  };
  return { save, error, saving: pending > 0 };
}

/** The exact command a fallback edit saves. Pure, so tests pin what goes on the wire. */
export function fallbacksCommand(ghostId: string, fallbacks: readonly ModelRef[], action: FallbackAction):
  { type: 'ghost.update'; ghostId: string; fallbacks: ModelRef[] } {
  return { type: 'ghost.update', ghostId, fallbacks: editFallbacks(fallbacks, action) };
}

/** The next skill list after one toggle: picking order, unique. Pure; tests pin it. */
export function toggleSkill(skills: readonly string[], name: string, on: boolean): string[] {
  return on ? (skills.includes(name) ? [...skills] : [...skills, name]) : skills.filter(skill => skill !== name);
}

/** The exact command a skill toggle saves; the list stays unique and in picking order. */
export function skillsCommand(ghostId: string, skills: readonly string[], name: string, on: boolean):
  { type: 'ghost.update'; ghostId: string; skills: string[] } {
  return { type: 'ghost.update', ghostId, skills: toggleSkill(skills, name, on) };
}

/** 제거 is for every Ghost but the main one. Pure; tests pin it. */
export function canRemoveGhost(ghost: Ghost): boolean {
  return !ghost.isDefault && ghost.deletedAt === null;
}

/**
 * What 제거 sends, in order: each project the Ghost receives goes back to the main Ghost, then the Ghost goes.
 * The Host refuses removal while a project still points at it, so the order matters. Pure; tests pin it.
 */
export function removalCommands(ghostId: string, scopes: readonly Pick<Scope, 'id' | 'ghostId'>[]): Command[] {
  return [
    ...scopes.filter(scope => scope.ghostId === ghostId).map(scope => ({ type: 'scope.update' as const, scopeId: scope.id, ghostId: null })),
    { type: 'ghost.delete', ghostId },
  ];
}

/** Whether the Ghost's persona, look, tools or skills have left its package, or the package moved on. Pure; tests pin it. */
export function packageDrift(ghost: Pick<Ghost, 'persona' | 'tools' | 'skills' | 'look' | 'source'>, entry: Pick<GhostPackageEntry, 'persona' | 'tools' | 'skills' | 'look' | 'version' | 'missingSkills'>): 'update' | 'edited' | null {
  if (ghost.source && entry.version > ghost.source.version) return 'update';
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(item => b.includes(item));
  // Skills this Host lacks are left out at install and kept by 되돌리기, so neither side counts them.
  const present = (skills: readonly string[]) => skills.filter(skill => !entry.missingSkills.includes(skill));
  const look = (value: Ghost['look']) => [value.body, value.shape, value.face, value.mark].join('|');
  return ghost.persona === entry.persona && same(ghost.tools, entry.tools) && same(present(ghost.skills), present(entry.skills)) && look(ghost.look) === look(entry.look) ? null : 'edited';
}

/** When and why a Ghost looks again on its own. */
function planLine(plan: AutonomyPlan | undefined): ReactNode {
  if (!plan) return undefined;
  if (!plan.enabled) return '말을 걸 때만 움직입니다.';
  if (plan.nextAt === null) return undefined;
  const at = new Date(plan.nextAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return <>다음 <time dateTime={new Date(plan.nextAt).toISOString()}>{at}</time>{plan.intent ? ` · ${plan.intent}` : ''}</>;
}

/** Who last wrote a Ghost's 환경 적응 notes, when, and why. Pure; tests pin it. */
export function adaptationLine(adaptation: Adaptation, now: number): string {
  const by = { self: '스스로', main: '메인', owner: '소유자' }[adaptation.by];
  return [by, relativeTime(adaptation.updatedAt, now), adaptation.reason].filter(Boolean).join(' · ');
}

/** One Ghost's sheet; exported for tests. */
export function GhostSheet({ ghost, onChat }: { ghost: Ghost; onChat(): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const { save, error, saving } = useSaver();
  const [designing, setDesigning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [packageEntry, setPackageEntry] = useState<GhostPackageEntry>();
  const sandbox = state?.sandboxes.find(item => item.ghostId === ghost.id);
  const plan = state?.autonomy?.find(item => item.ghostId === ghost.id);
  const adaptation = state?.adaptations?.find(item => item.ghostId === ghost.id);
  const update = (patch: Partial<Pick<Ghost, 'name' | 'persona' | 'state' | 'tools' | 'fallbacks' | 'skills' | 'hostExecution'>> & { model?: ModelRef | null }) =>
    save({ type: 'ghost.update', ghostId: ghost.id, ...patch });
  useEffect(() => {
    let alive = true;
    client.skills().then(found => { if (alive) setCatalog(found); }).catch(() => { if (alive) setCatalog(null); });
    return () => { alive = false; };
  }, [client]);
  useEffect(() => {
    if (!ghost.source) return;
    let alive = true;
    const name = ghost.source.package;
    client.ghostPackages().then(found => { if (alive) setPackageEntry(found.packages.find(item => item.name === name)); }).catch(() => {});
    return () => { alive = false; };
  }, [client, ghost.source?.package, ghost.source?.version]);
  return <div className="ghost-sheet" aria-busy={saving}>
    <header className="ghost-sheet__identity">
      <button type="button" className="ghost-sheet__portrait" aria-label={`${ghost.name} 꾸미기`} title="꾸미기" onClick={() => setDesigning(true)}>
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={48}/>
      </button>
      <div className="ghost-sheet__who">
        <NameField key={ghost.name} name={ghost.name} onSave={name => update({ name })}/>
        <div className="ghost-sheet__marks">
          {ghost.isDefault && <span className="main-mark"><Crown aria-hidden="true"/>메인</span>}
          {ghost.source && <span className="ghost-sheet__source">{packageEntry?.title ?? ghost.source.package} 패키지</span>}
          <GhostStateWord state={ghost.state}/>
        </div>
      </div>
      <Button type="button" variant="outline" className="ghost-sheet__chat" onClick={onChat}><MessageCircle aria-hidden="true"/>대화</Button>
    </header>
    {error && <div className="ghost-sheet__feedback" role="status"><InlineError>{error}</InlineError></div>}
    {ghost.source && <Panel title="패키지"><PackageRow ghost={ghost} entry={packageEntry} saving={saving}/></Panel>}
    <Panel title={uiTerms.persona}><PersonaNote key={ghost.persona} persona={ghost.persona} onSave={persona => update({ persona })}/></Panel>
    <Panel title="모델"><ModelRoute ghost={ghost} save={save}/></Panel>
    <Panel title="환경 적응">
      <AdaptationNote key={adaptation?.notes ?? ''} adaptation={adaptation} onSave={notes => save({ type: 'ghost.adapt', ghostId: ghost.id, notes })}/>
    </Panel>
    <SkillsPanel catalog={catalog} skills={ghost.skills} onChange={skills => void update({ skills })}/>
    <Panel title="도구"><CapabilityBoard tools={ghost.tools} onChange={tools => void update({ tools })}/></Panel>
    <Panel title={uiTerms.advanced}><PatternGrants key={JSON.stringify(ghost.tools)} tools={ghost.tools} onSave={tools => update({ tools })}/></Panel>
    <Panel title="붙임"><GhostAttachments key={JSON.stringify(ghost.attachments)} ghost={ghost}/></Panel>
    <Panel title="기억"><GhostMemory ghost={ghost}/></Panel>
    <Panel title="운영">
      {ghost.isDefault
        ? <SettingsRow label="상태" description="메인 Ghost는 늘 사용 중입니다."><span className="ghost-sheet__locked"><Lock aria-hidden="true"/>사용 중</span></SettingsRow>
        : <SettingsRow label="사용" description={ghost.state === 'active' ? undefined : '끄면 말을 걸거나 일을 맡길 수 없습니다. 기억과 설정은 그대로입니다.'}>
          <Switch checked={ghost.state === 'active'} disabled={saving} aria-label="사용"
            onCheckedChange={next => void update({ state: next ? 'active' : 'paused' })}/>
        </SettingsRow>}
      <SettingsRow label="스스로 일하기" description={planLine(plan)}>
        <Switch checked={plan?.enabled !== false} disabled={saving} aria-label="스스로 일하기"
          onCheckedChange={next => void save({ type: 'autonomy.set', ghostId: ghost.id, enabled: next })}/>
      </SettingsRow>
      <SettingsRow label="PC 직접 실행" description="이 Ghost가 보호 장치 없이 이 Mac의 파일과 명령을 직접 실행합니다. Mac 전체와 인터넷에 영향을 줄 수 있습니다. 끄면 진행 중인 PC 작업도 멈춥니다.">
        <Switch checked={ghost.hostExecution === true} disabled={saving} aria-label="PC 직접 실행 허용"
          onCheckedChange={next => void update({ hostExecution: next })}/>
      </SettingsRow>
      {canRemoveGhost(ghost) && <SettingsRow label="Ghost 제거" description="받던 프로젝트는 메인으로 돌아갑니다. 지난 일의 기록은 남습니다.">
        <Button type="button" variant="destructive" size="sm" onClick={() => setDeleting(true)}><Trash2 aria-hidden="true"/>제거</Button>
      </SettingsRow>}
    </Panel>
    {sandbox && sandbox.state !== 'none' && <Panel title="샌드박스"><SandboxStrip ghostId={ghost.id} state={sandbox.state} detail={sandbox.detail}/></Panel>}

    {designing && <Modal title={`${ghost.name} 꾸미기`} onClose={() => setDesigning(false)} className="sm:max-w-[760px]"><GhostDesignEditor ghostId={ghost.id}/></Modal>}
    {deleting && <DeleteDialog ghost={ghost} onClose={() => setDeleting(false)}/>}
  </div>;
}

/** One route: the effective primary, then up to three ordered alternatives. */
function ModelRoute({ ghost, save }: { ghost: Ghost; save(command: Command): Promise<boolean> }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const primary = ghost.model ?? state?.settings.defaultModel;
  const commit = async (command: Command) => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true);
    try { await save(command); }
    finally { inFlight.current = false; setPending(false); }
  };
  const act = (action: FallbackAction) => void commit(fallbacksCommand(ghost.id, ghost.fallbacks, action));
  // 자기 목록이 없으면 기본 대체 모델을 따른다. 실제로 쓰이는 것만 보인다 — 먼저 쓰는 모델과 같은 것은 런타임이 건너뛴다.
  // 소유자가 이 Ghost 를 「대체 모델 없음」으로 두면 기본 목록도 따르지 않는다(한 공급자에 묶어 둘 Ghost 용).
  const optedOut = state?.settings.noFallbackGhosts ?? [];
  const follows = !optedOut.includes(ghost.id);
  const defaults = ghost.fallbacks.length === 0
    ? (state?.settings.defaultFallbacks ?? []).filter(ref => !primary || ref.provider !== primary.provider || ref.model !== primary.model)
    : [];
  const inherited = follows ? defaults : [];
  const setFollows = (on: boolean) => void commit({ type: 'settings.update',
    noFallbackGhosts: on ? optedOut.filter(id => id !== ghost.id) : [...optedOut.filter(id => id !== ghost.id), ghost.id] });
  return <div className="model-route" aria-busy={pending}>
    <ol className="model-route__steps" aria-label="모델 사용 순서">
      <li className="model-route__step" data-primary>
        <span className="model-route__node" aria-hidden="true"><span/></span>
        <div className="model-route__choice">
          <span className="model-route__label">먼저 사용</span>
          <ModelChoice label="기본 모델 선택" value={ghost.model} excluded={ghost.fallbacks} disabled={pending} onChange={model => void commit({ type: 'ghost.update', ghostId: ghost.id, model })}/>
        </div>
      </li>
      {inherited.map((ref, index) => <li key={`inherited:${ref.provider}/${ref.model}`} className="model-route__step" data-inherited>
        <span className="model-route__node" aria-hidden="true">{index + 1}</span>
        <div className="model-route__choice">
          <span className="model-route__label">기본 대체 {index + 1}</span>
          <span className="model-route__inherited">{modelName(state?.settings, ref)}</span>
        </div>
      </li>)}
      <FallbackSteps fallbacks={ghost.fallbacks} primary={primary ?? null} pending={pending} onAction={act}/>
    </ol>
    {defaults.length > 0 && <label className="model-route__follow">
      <span>기본 대체 모델 따르기<small>{follows ? '끄면 이 Ghost는 대체 모델 없이 한 모델만 씁니다.' : '이 Ghost는 대체 모델 없이 한 모델만 씁니다.'}</small></span>
      <Switch checked={follows} disabled={pending} onCheckedChange={setFollows} aria-label="기본 대체 모델 따르기"/>
    </label>}
    {(inherited.length > 0 || ghost.fallbacks.length > 0) && <p className="model-route__hint">{inherited.length
      ? '여기서 추가하면 기본 대체 모델 대신 이 Ghost만의 목록을 씁니다.'
      : '연결 오류·사용 한도에 걸리면 다음 모델로 이어갑니다.'}</p>}
  </div>;
}

/** 스킬 catalog가 없거나 비어 있으면 패널 자체를 숨긴다. */
export function SkillsPanel({ catalog, skills, onChange }: {
  catalog: SkillCatalog | null;
  skills: readonly string[];
  onChange(skills: string[]): void;
}) {
  if (!catalog?.skills.length) return null;
  return <Panel title="스킬"><SkillBoard catalog={catalog.skills} skills={skills} onChange={onChange}/></Panel>;
}

/** Skills as toggle pills; touch keeps the description in the pill rather than behind hover. */
export function SkillBoard({ catalog, skills, onChange }: {
  catalog: readonly { name: string; description: string }[];
  skills: readonly string[];
  onChange(skills: string[]): void;
}) {
  const known = new Map(catalog.map(skill => [skill.name, skill.description]));
  const toggle = (name: string, on: boolean) => onChange(toggleSkill(skills, name, on));
  return <div className="skills">
    {catalog.map(skill => {
      const on = skills.includes(skill.name);
      return <button key={skill.name} type="button" className="skill" aria-pressed={on} disabled={!on && skills.length >= 16}
        title={skill.description || undefined} onClick={() => toggle(skill.name, !on)}>{skill.name}{skill.description && <span className="skill__description">{skill.description}</span>}</button>;
    })}
    {[...skills].filter(name => !known.has(name)).map(name => <button key={name} type="button" className="skill" data-unavailable
      aria-pressed title="카탈로그에 없는 스킬" onClick={() => toggle(name, false)}>{name}</button>)}
  </div>;
}

/** 패키지 row: which package and version, and 되돌리기/업데이트 when the Ghost has left it. Re-applying keeps model, PC grant, notes and memory. */
function PackageRow({ ghost, entry, saving }: { ghost: Ghost; entry: GhostPackageEntry | undefined; saving: boolean }) {
  const { client } = useHost();
  const [confirming, setConfirming] = useState(false);
  const drift = entry ? packageDrift(ghost, entry) : null;
  const version = `v${ghost.source!.version}${drift === 'update' ? ` → v${entry!.version}` : ''}`;
  const description = !entry ? '이 Host에서 패키지를 찾을 수 없습니다.'
    : drift === 'update' ? '새 버전이 있습니다.'
    : drift === 'edited' ? '페르소나·모습·도구·스킬 중 일부를 고쳤습니다.'
    : undefined;
  return <>
    <SettingsRow label={`${entry?.title ?? ghost.source!.package} · ${version}`} description={description}>
      {drift && <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setConfirming(true)}>
        <RotateCcw aria-hidden="true"/>{drift === 'update' ? '업데이트' : '패키지대로 되돌리기'}
      </Button>}
    </SettingsRow>
    {confirming && <ConfirmDialog title={drift === 'update' ? `${ghost.name} 업데이트` : '패키지대로 되돌리기'} confirmLabel={drift === 'update' ? '업데이트' : '되돌리기'}
      tone="default" onConfirm={() => client.send({ type: 'ghost.apply_package', ghostId: ghost.id })} onClose={() => setConfirming(false)}>
      페르소나·모습·도구·스킬을 패키지대로 바꿉니다. 모델, PC 직접 실행, 환경 적응과 기억은 그대로입니다.
    </ConfirmDialog>}
  </>;
}

/** 제거 confirm: names what happens to the Ghost's projects; a refusal shows the Host's reason in place. */
function DeleteDialog({ ghost, onClose }: { ghost: Ghost; onClose(): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const owned = state?.scopes.filter(scope => scope.ghostId === ghost.id) ?? [];
  const remove = async () => {
    setBusy(true); setError('');
    try {
      for (const command of removalCommands(ghost.id, state?.scopes ?? [])) await client.send(command);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ghost를 제거하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); }
  };
  return <Modal title={`${ghost.name} 제거`} onClose={onClose} className="sm:max-w-[420px]">
    {owned.length > 0 && <p className="m-0">{owned.map(scope => scope.name).join(', ')} 프로젝트는 메인이 받습니다.</p>}
    {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
    <div className="mt-4 flex justify-end gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>취소</Button>
      <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>제거</Button>
    </div>
  </Modal>;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <SettingsGroup title={title} className="ghost-panel">{children}</SettingsGroup>;
}

/** The name reads as the heading and edits in place; Enter or leaving the field saves, Escape restores. */
function NameField({ name, onSave }: { name: string; onSave(name: string): Promise<boolean> }) {
  const [draft, setDraft] = useState(name);
  const cancelling = useRef(false);
  const commit = () => {
    if (cancelling.current) { cancelling.current = false; return; }
    const next = draft.trim();
    if (!next) setDraft(name);
    else if (next !== name) void onSave(next).then(ok => { if (!ok) setDraft(name); });
  };
  return <input className="ghost-sheet__name" aria-label="이름" value={draft} maxLength={128} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') { cancelling.current = true; setDraft(name); event.currentTarget.blur(); }
    }}/>;
}

/**
 * The persona — who this Ghost is and how it works (docs/concept.md) — reads as text first; 「편집」 opens it for editing,
 * and saving or cancelling closes it.
 * 2026.11.11 : 늘 열린 입력칸이라 설정을 훑다가 실수로 고치기 쉬웠다. 읽기가 기본이고 편집은 고르는 일로 바꿨다.
 * 이 글은 Host 가 정한 기본 지시 앞에 붙는 Ghost 의 몫이다 — 기본 지시를 갈아 끼우지 않는다.
 */
function PersonaNote({ persona, onSave }: { persona: string; onSave(persona: string): Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(persona);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const node = area.current; if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }, [draft, editing]);
  useEffect(() => { if (editing) area.current?.focus(); }, [editing]);
  const changed = draft !== persona;
  const cancel = () => { setDraft(persona); setEditing(false); };
  const commit = async () => {
    if (!changed) { setEditing(false); return; }
    if (draft.trim() && await onSave(draft)) setEditing(false);
  };
  if (!editing) return <div className="persona-note" data-reading>
    <p className="persona-note__text">{persona}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil aria-hidden="true"/>편집</Button>
  </div>;
  return <div className="persona-note" data-changed={changed || undefined}>
    <textarea ref={area} aria-label={uiTerms.persona} aria-describedby="ghost-persona-hint" value={draft} maxLength={8192} rows={3} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void commit(); }
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }}/>
    <p className="persona-note__hint" id="ghost-persona-hint">첫 줄은 목록에 보이는 한 줄 소개입니다.</p>
    <div className="persona-note__actions">
      {changed && <Button type="button" variant="ghost" size="icon" onClick={() => setDraft(persona)} aria-label="되돌리기" title="되돌리기"><RotateCcw aria-hidden="true"/></Button>}
      <Button type="button" variant="outline" size="sm" onClick={cancel}>취소</Button>
      <Button type="button" size="sm" disabled={!draft.trim()} onClick={() => void commit()}>저장</Button>
    </div>
  </div>;
}

/** 환경 적응 notes: the role editor's note, a quiet line about the last change, and 되돌리기 back to the previous notes. */
function AdaptationNote({ adaptation, onSave }: { adaptation: Adaptation | undefined; onSave(notes: string): Promise<boolean> }) {
  const notes = adaptation?.notes ?? '';
  const previous = adaptation?.previous ?? null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes);
  const area = useRef<HTMLTextAreaElement>(null);
  const now = useNow();
  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [draft, editing]);
  useEffect(() => { if (editing) area.current?.focus(); }, [editing]);
  const changed = draft !== notes;
  const cancel = () => { setDraft(notes); setEditing(false); };
  const commit = async () => { if (changed && await onSave(draft)) setEditing(false); };
  const meta = adaptation && <p className="adaptation-note__meta">{adaptationLine(adaptation, now)}</p>;
  if (!editing) return <div className="persona-note" data-reading>
    <div className="persona-note__copy">
      {notes ? <p className="persona-note__text">{notes}</p> : <p className="persona-note__empty">기록 없음</p>}
      {meta}
    </div>
    <div className="persona-note__row-actions">
      {previous !== null && <Button type="button" variant="ghost" size="sm" onClick={() => void onSave(previous)}>되돌리기</Button>}
      <Button type="button" variant="outline" size="sm" aria-label="환경 적응 편집" onClick={() => setEditing(true)}><Pencil aria-hidden="true"/>편집</Button>
    </div>
  </div>;
  return <div className="persona-note" data-changed={changed || undefined}>
    <textarea ref={area} aria-label="환경 적응" value={draft} maxLength={ADAPTATION_MAX_CHARS} rows={3} placeholder="이 Mac에서 배운 사용법과 습관" onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void commit(); }
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }}/>
    {meta}
    <div className="persona-note__actions">
      <Button type="button" variant="outline" size="sm" onClick={cancel}>취소</Button>
      <Button type="button" size="sm" disabled={!changed} onClick={() => void commit()}>저장</Button>
    </div>
  </div>;
}

/** Every selectable tool as a switch-pill, grouped by purpose; a group label toggles the whole group. */
function CapabilityBoard({ tools, onChange }: { tools: readonly GhostTool[]; onChange(tools: GhostTool[]): void }) {
  // Optimistic: pills flip at once; the stored list catches up through the host snapshot.
  const [shown, setShown] = useState<readonly GhostTool[]>(tools);
  useEffect(() => setShown(tools), [tools]);
  const set = (changes: readonly GhostTool[], on: boolean) => {
    const next = [...new Set([...shown, ...changes])].filter(tool => changes.includes(tool) ? on : shown.includes(tool));
    setShown(next);
    onChange(next);
  };
  const grouped = new Set<GhostTool>(toolGroups.flatMap(group => [...group.tools]));
  const groups = [...toolGroups, ...(GHOST_TOOLS.some(tool => !grouped.has(tool)) ? [{ title: '기타', tools: GHOST_TOOLS.filter(tool => !grouped.has(tool)) }] : [])];
  return <div className="capabilities">
    {groups.map(group => {
      const enabled = group.tools.filter(tool => shown.includes(tool)).length;
      const all = enabled === group.tools.length;
      return <div key={group.title} className="capabilities__group" data-privileged={group.privileged || undefined}>
        <button type="button" className="capabilities__head" aria-pressed={all} onClick={() => set(group.tools, !all)}>
          <span aria-hidden="true"><StateGlyph state={all ? 'done' : enabled ? 'verifying' : 'queued'} mark={enabled ? 'dot' : 'ring'} size={16}/></span>
          {group.title}<span className="tabular">{enabled}/{group.tools.length}</span>
          {group.privileged && <Lock className="capabilities__lock" aria-label="소유자 전용"/>}
        </button>
        <div className="capabilities__pills">
          {group.tools.map(tool => <button key={tool} type="button" className="capability" aria-pressed={shown.includes(tool)} onClick={() => set([tool], !shown.includes(tool))}>
            <span className="capability__dot" aria-hidden="true"/>{toolLabels[tool]}
          </button>)}
        </div>
      </div>;
    })}
    <p className="capabilities__always"><span>항상</span>{alwaysTools.join(' · ')}</p>
  </div>;
}

function SandboxStrip({ ghostId, state, detail }: { ghostId: string; state: string; detail: string }) {
  const { save, error } = useSaver();
  const [confirm, setConfirm] = useState(false);
  const label: Record<string, string> = { running: '실행 중', stopped: '정지됨', error: '오류' };
  return <div className="sandbox-strip" data-state={state}>
    <span aria-hidden="true"><StateGlyph state={state === 'error' ? 'failed' : state === 'running' ? 'running' : 'waiting'} size={16}/></span>
    <span className="sandbox-strip__copy"><strong>{label[state] ?? state}</strong>{detail && <small>{detail}</small>}</span>
    {state === 'running' && <Button type="button" variant="secondary" size="sm" onClick={() => void save({ type: 'sandbox.control', ghostId, action: 'stop' })}><Square aria-hidden="true"/>정지</Button>}
    {confirm
      ? <span className="sandbox-strip__confirm">
        <Button type="button" variant="destructive" size="sm" onClick={() => void save({ type: 'sandbox.control', ghostId, action: 'reset' }).then(() => setConfirm(false))}>파일까지 지우고 초기화</Button>
        <Button type="button" variant="secondary" size="icon" aria-label="취소" onClick={() => setConfirm(false)}><X aria-hidden="true"/></Button>
      </span>
      : <Button type="button" variant="secondary" size="sm" onClick={() => setConfirm(true)}><RotateCcw aria-hidden="true"/>초기화</Button>}
    {error && <InlineError>{error}</InlineError>}
  </div>;
}

