import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Crown, Lock, MessageCircle, Plus, Power, RotateCcw, Search, Square, Trash2, X } from 'lucide-react';
import { ADAPTATION_MAX_CHARS, BROWSER_TOOLS, DESKTOP_TOOLS, FINANCE_TOOLS, GHOST_TOOLS, HOST_TOOLS, VAULT_TOOLS, type Adaptation, type AutonomyPlan, type Command, type Ghost, type GhostState, type GhostTool, type ModelRef, type SkillCatalog } from '@ghost/contract';
import { InlineError, Popover, PopoverContent, PopoverTrigger, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { GhostDesignEditor } from './GhostDesign';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { usableProviders } from '../pets/ModelPicker';
import { uiTerms } from '../uiText';
import './ghost-settings.css';
import { blurTouchSearchOnEnter } from '../ui/adaptive';

export const toolLabels: Record<GhostTool, string> = {
  work_create: '일 만들기', work_list: '일 목록', work_inspect: '일 자세히', work_update: '일 고치기', work_cancel: '일 취소',
  schedule_create: '반복 만들기', schedule_list: '반복 보기', schedule_cancel: '반복 취소',
  ghost_list: 'Ghost 목록', activity_propose: '활동 제안', read: '파일 읽기', write: '파일 쓰기', edit: '파일 고치기', bash: '명령 실행',
  publish_artifact: '결과물 공유', delegate: '다른 Ghost에게 맡기기',
  memory_search: '기억 검색', memory_recall: '기억 불러오기', memory_retain: '기억 저장',
  document_spaces: '문서 공간', document_list: '문서 목록', document_read: '문서 읽기', document_propose: '문서 수정 제안',
  web_search: '웹 검색', web_read: '웹 읽기', reach: '외부 읽기', skill_read: '스킬 읽기',
  connection_list: '연결 목록', connection_register: '연결 등록', connection_request: '연결 API 사용',
  host_status: 'Mac 상태', host_services: 'Mac 서비스', host_disk_scan: 'Mac 디스크 검색', host_disk_usage: 'Mac 디스크 사용량',
  host_list: 'Mac 파일 목록', host_read: 'Mac 파일 읽기', host_nodes: 'Tailscale 노드', host_command_propose: 'Mac 명령 제안',
  browser_open: '브라우저 열기', browser_snapshot: '브라우저 구조 읽기', browser_screenshot: '브라우저 캡처', browser_read: '브라우저 읽기',
  browser_click: '브라우저 클릭', browser_fill: '브라우저 채우기', browser_type: '브라우저 입력', browser_press: '브라우저 키 누르기',
  browser_select: '브라우저 선택', browser_check: '브라우저 체크', browser_scroll: '브라우저 스크롤', browser_navigate: '브라우저 이동',
  browser_tabs: '브라우저 탭', browser_wait: '브라우저 대기', browser_upload: '브라우저 올리기', browser_download: '브라우저 내려받기',
  browser_propose: '브라우저 클릭 제안', browser_handoff: '브라우저 넘겨주기', browser_fill_secret: '브라우저 금고 채우기', browser_close: '브라우저 닫기',
  vault_list: '금고 목록', vault_request: '금고 저장 요청', vault_generate_login: '금고 로그인 만들기',
  desktop_apps: 'PC 앱 목록', desktop_snapshot: 'PC 화면 구조 읽기', desktop_screenshot: 'PC 화면 캡처', desktop_click: 'PC 클릭',
  desktop_fill: 'PC 값 채우기', desktop_type: 'PC 입력', desktop_select: 'PC 선택', desktop_check: 'PC 체크',
  desktop_scroll: 'PC 스크롤', desktop_press: 'PC 키 누르기', desktop_launch: 'PC 앱 열기', desktop_focus: 'PC 창 앞으로',
  desktop_wait: 'PC 대기', desktop_pointer: 'PC 포인터 직접 조작', desktop_keys: 'PC 키보드 직접 입력', desktop_propose: 'PC 클릭 제안',
  toss_read: '토스증권 조회',
};

/** 용도별 묶음. contract의 GHOST_TOOLS를 따르고 여기 없는 새 도구는 기타로 내려간다. Exported for the coverage test. */
export const toolGroups: readonly { title: string; tools: readonly GhostTool[]; privileged?: boolean }[] = [
  { title: '맡긴 일', tools: ['work_create', 'work_list', 'work_inspect', 'work_update', 'work_cancel'] },
  { title: '협업', tools: ['delegate', 'ghost_list', 'publish_artifact'] },
  { title: '파일과 명령', tools: ['read', 'write', 'edit', 'bash'] },
  { title: '웹', tools: ['web_search', 'web_read', 'reach'] },
  { title: '연결', tools: ['connection_list', 'connection_register', 'connection_request'] },
  { title: '브라우저', tools: [...BROWSER_TOOLS] },
  { title: '금고', tools: [...VAULT_TOOLS] },
  { title: '스킬', tools: ['skill_read'] },
  { title: '기억', tools: ['memory_search', 'memory_recall', 'memory_retain'] },
  { title: '문서', tools: ['document_spaces', 'document_list', 'document_read', 'document_propose'] },
  { title: '반복 작업', tools: ['schedule_create', 'schedule_list', 'schedule_cancel'] },
  { title: '자동 활동', tools: ['activity_propose'] },
  { title: 'Mac', tools: [...HOST_TOOLS], privileged: true },
  { title: 'PC 조작', tools: [...DESKTOP_TOOLS], privileged: true },
  { title: '자산', tools: [...FINANCE_TOOLS], privileged: true },
];
/** 대화 종류에 따라 항상 쓰는 도구. 선택 목록에 없고 끌 수 없다. */
const alwaysTools = ['소유자에게 묻기', '위임한 Ghost에게 묻기', '자식 일에 답하기', '일 완료 보고', '일 상태 보고', '결과물 읽기', '실행 기록 보기', '관측 근거 읽기', '검토 판정'];
const states: { value: GhostState; label: string }[] = [{ value: 'active', label: '활성' }, { value: 'paused', label: '일시정지' }, { value: 'retired', label: '은퇴' }];

/**
 * Ghost 설정: 위쪽 초상 줄에서 Ghost를 고르고, 아래에서 그 Ghost의 이름·메인 지정·상태·모델·역할·환경 적응·도구·샌드박스를 고친다.
 * 모습은 초상을 눌러 여는 꾸미기가 맡는다. 모든 변경은 ghost.update · ghost.adapt · ghost.set_default · sandbox.control로 바로 저장된다.
 */
/** The settings roster: deleted Ghosts leave it, the main Ghost leads, then oldest first. Pure; tests pin it. */
export function settingsRoster(ghosts: readonly Ghost[]): Ghost[] {
  return ghosts.filter(ghost => ghost.deletedAt === null)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt);
}

export function GhostSettings({ onChat, onSelect, selectedGhostId, createRequested = false, onCreateClosed }: {
  onChat(id: string): void;
  onSelect(id: string): void;
  selectedGhostId?: string;
  createRequested?: boolean;
  onCreateClosed?(): void;
}) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const ghosts = settingsRoster(state?.ghosts ?? []);
  const [creating, setCreating] = useState(createRequested);
  useEffect(() => { if (createRequested) setCreating(true); }, [createRequested]);
  const closeCreator = () => { setCreating(false); if (createRequested) onCreateClosed?.(); };
  const [query, setQuery] = useState('');
  const shown = ghosts.filter(ghost => ghost.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = creating ? null : ghosts.find(ghost => ghost.id === selectedGhostId) ?? ghosts[0] ?? null;
  return <section className="ghost-settings-page" aria-label={uiTerms.ghostSettings}>
    <div className="roster-picker">
      {(ghosts.length >= 8 || query) && <label className="roster-search">
        <Search aria-hidden="true"/>
        <input type="text" enterKeyHint="search" aria-label="설정할 Ghost 찾기" placeholder="Ghost 찾기" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>
        {query && <button type="button" aria-label="Ghost 검색 지우기" onClick={() => setQuery('')}><X aria-hidden="true"/></button>}
      </label>}
      <div className="roster" aria-label="설정할 Ghost">
        {shown.map(ghost => <button key={ghost.id} type="button" aria-pressed={!creating && ghost.id === selected?.id} className="roster__ghost"
          title={ghost.name} data-state={ghost.state} onClick={() => { closeCreator(); onSelect(ghost.id); }}>
          <span className="roster__portrait"><DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={30}/></span>
          <span className="roster__name">{ghost.name}</span>
          {ghost.isDefault && <Crown className="roster__crown" aria-label="메인"/>}
        </button>)}
        {!shown.length && <span className="roster__empty">일치하는 Ghost가 없습니다.</span>}
        <button type="button" aria-pressed={creating} className="roster__ghost roster__new" disabled={!state} onClick={() => setCreating(true)}>
          <Plus aria-hidden="true"/><span>새 Ghost</span>
        </button>
      </div>
    </div>
    {creating ? <GhostCreator onCancel={closeCreator} onCreated={id => { closeCreator(); onSelect(id); }}/>
      : selected && <GhostSheet key={selected.id} ghost={selected} onChat={() => onChat(selected.id)}/>}
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

export const MAX_FALLBACKS = 3;

/** One owner edit of the fallback list. Pure; tests pin what each action saves. */
export type FallbackAction =
  | { kind: 'add'; model: ModelRef }
  | { kind: 'replace'; index: number; model: ModelRef }
  | { kind: 'remove'; index: number }
  | { kind: 'move'; index: number; delta: 1 | -1 };

/** The next fallback list after an owner edit; adds cap at three and moves clamp at the ends. */
export function editFallbacks(fallbacks: readonly ModelRef[], action: FallbackAction): ModelRef[] {
  const next = [...fallbacks];
  const inside = (index: number) => Number.isInteger(index) && index >= 0 && index < next.length;
  if (action.kind === 'add') { if (next.length < MAX_FALLBACKS) next.push(action.model); }
  else if (action.kind === 'replace') { if (inside(action.index)) next[action.index] = action.model; }
  else if (action.kind === 'remove') { if (inside(action.index)) next.splice(action.index, 1); }
  else { const to = action.index + action.delta; if (inside(action.index) && inside(to)) [next[action.index], next[to]] = [next[to], next[action.index]]; }
  return next;
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

/** 삭제 is for a retired, non-default Ghost that is not already deleted. Pure; tests pin it. */
export function canDeleteGhost(ghost: Ghost): boolean {
  return ghost.state === 'retired' && !ghost.isDefault && ghost.deletedAt === null;
}

/** The exact command the delete confirm sends. Pure; tests pin it. */
export function deleteCommand(ghostId: string): { type: 'ghost.delete'; ghostId: string } {
  return { type: 'ghost.delete', ghostId };
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
  const { store } = useHost();
  const { state } = useHostState(store);
  const { client } = useHost();
  const { save, error, saving } = useSaver();
  const [designing, setDesigning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
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
  return <div className="ghost-sheet" aria-busy={saving}>
    <header className="ghost-sheet__identity">
      <button type="button" className="ghost-sheet__portrait" aria-label={`${ghost.name} 꾸미기`} title="꾸미기" onClick={() => setDesigning(true)}>
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={60}/>
      </button>
      <div className="ghost-sheet__who">
        <NameField key={ghost.name} name={ghost.name} onSave={name => update({ name })}/>
        <div className="ghost-sheet__marks">
          {ghost.isDefault && <span className="main-mark" data-on><Crown aria-hidden="true"/>메인 Ghost</span>}
          <span className="ghost-sheet__state" data-state={ghost.state}><Power aria-hidden="true"/>{states.find(item => item.value === ghost.state)?.label}</span>
        </div>
      </div>
      <button type="button" className="ghost-sheet__chat" onClick={onChat}><MessageCircle aria-hidden="true"/>대화</button>
    </header>
    {error && <div className="ghost-sheet__feedback" role="status"><InlineError>{error}</InlineError></div>}

    <Panel title="모델"><ModelRoute ghost={ghost} save={save}/></Panel>
    <Panel title={uiTerms.roleInstructions}><PersonaNote key={ghost.persona} persona={ghost.persona} onSave={persona => update({ persona })}/></Panel>
    <Panel title="환경 적응">
      <AdaptationNote key={adaptation?.notes ?? ''} adaptation={adaptation} onSave={notes => save({ type: 'ghost.adapt', ghostId: ghost.id, notes })}/>
    </Panel>
    <SkillsPanel catalog={catalog} skills={ghost.skills} onChange={skills => void update({ skills })}/>
    <Panel title="도구"><CapabilityBoard tools={ghost.tools} onChange={tools => void update({ tools })}/></Panel>
    <Panel title="운영">
      <SettingsRow label="상태" description={ghost.isDefault ? '메인 Ghost는 활성 상태를 유지합니다.' : undefined}>
        {ghost.isDefault ? <span className="ghost-sheet__locked"><Lock aria-hidden="true"/>활성</span>
          : <StateSwitch value={ghost.state} disabled={saving} onChange={next => void update({ state: next })}/>}
      </SettingsRow>
      <SettingsRow label="스스로 일하기" description={planLine(plan)}>
        <Switch checked={plan?.enabled !== false} disabled={saving} aria-label="스스로 일하기"
          onCheckedChange={next => void save({ type: 'autonomy.set', ghostId: ghost.id, enabled: next })}/>
      </SettingsRow>
      {!ghost.isDefault && <SettingsRow label="메인 Ghost" description="새 대화와 일을 처음 받는 Ghost">
        <button type="button" className="sandbox-strip__action" disabled={saving || ghost.state !== 'active'} onClick={() => void save({ type: 'ghost.set_default', ghostId: ghost.id })}>
          <Crown aria-hidden="true"/>메인으로 지정
        </button>
      </SettingsRow>}
      <SettingsRow label="PC 직접 실행" description="이 Ghost가 샌드박스 없이 이 Mac의 파일과 셸 명령을 직접 실행합니다. Mac 전체와 네트워크에 영향을 줄 수 있고, 활동의 PR 댓글·메일 회신 승인 설정으로 제한되지 않습니다. 허용을 끄면 진행 중인 PC 작업도 중지됩니다.">
        <Switch checked={ghost.hostExecution === true} disabled={saving} aria-label="PC 직접 실행 허용"
          onCheckedChange={next => void update({ hostExecution: next })}/>
      </SettingsRow>
      {canDeleteGhost(ghost) && <SettingsRow label="Ghost 삭제" description="목록에서 제거합니다. 지난 맡긴 일의 기록은 남습니다.">
        <button type="button" className="sandbox-strip__action" data-danger onClick={() => setDeleting(true)}><Trash2 aria-hidden="true"/>삭제</button>
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
  const used = [primary, ...ghost.fallbacks].filter((ref): ref is ModelRef => !!ref);
  return <div className="model-route" aria-busy={pending}>
    <ol className="model-route__steps" aria-label="모델 사용 순서">
      <li className="model-route__step" data-primary>
        <span className="model-route__node" aria-hidden="true"><span/></span>
        <div className="model-route__choice">
          <span className="model-route__label">먼저 사용</span>
          <ModelChoice label="기본 모델 선택" value={ghost.model} excluded={ghost.fallbacks} disabled={pending} onChange={model => void commit({ type: 'ghost.update', ghostId: ghost.id, model })}/>
        </div>
      </li>
      {ghost.fallbacks.map((fallback, index) => <li key={`${fallback.provider}/${fallback.model}:${index}`} className="model-route__step">
        <span className="model-route__node" aria-hidden="true">{index + 1}</span>
        <div className="model-route__choice">
          <span className="model-route__label">대체 {index + 1}</span>
          <ModelChoice label={`${index + 1}번 대체 모델 선택`} value={fallback} inherit={false} disabled={pending}
            excluded={used.filter(ref => ref.provider !== fallback.provider || ref.model !== fallback.model)}
            onChange={model => model && act({ kind: 'replace', index, model })}/>
        </div>
        <div className="model-route__actions" role="group" aria-label={`대체 ${index + 1} 순서와 삭제`}>
          <button type="button" aria-label={`${index + 1}번 위로`} title="앞으로" disabled={pending || index === 0} onClick={() => act({ kind: 'move', index, delta: -1 })}><ArrowUp aria-hidden="true"/></button>
          <button type="button" aria-label={`${index + 1}번 아래로`} title="뒤로" disabled={pending || index === ghost.fallbacks.length - 1} onClick={() => act({ kind: 'move', index, delta: 1 })}><ArrowDown aria-hidden="true"/></button>
          <button type="button" aria-label={`${index + 1}번 대체 모델 지우기`} title="삭제" disabled={pending} onClick={() => act({ kind: 'remove', index })}><X aria-hidden="true"/></button>
        </div>
      </li>)}
      {ghost.fallbacks.length < MAX_FALLBACKS && <li className="model-route__step" data-add>
        <span className="model-route__node" aria-hidden="true"><Plus/></span>
        <ModelChoice add value={null} excluded={used} disabled={pending} onChange={model => model && act({ kind: 'add', model })}/>
      </li>}
    </ol>
    <p className="model-route__hint">연결 오류·사용 한도에 걸리면 다음 모델로 이어갑니다.</p>
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

/** 삭제 confirm: the title says it all; a conflict shows the server message in place. */
function DeleteDialog({ ghost, onClose }: { ghost: Ghost; onClose(): void }) {
  const { client } = useHost();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remove = () => {
    setBusy(true); setError('');
    void client.send(deleteCommand(ghost.id))
      .then(onClose)
      .catch(reason => { setError(reason instanceof Error ? reason.message : 'Ghost를 삭제하지 못했습니다. 다시 시도해 주세요.'); setBusy(false); });
  };
  return <Modal title={`${ghost.name} 삭제`} onClose={onClose} className="sm:max-w-[420px]">
    {error && <InlineError>{error}</InlineError>}
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" className="sandbox-strip__action" disabled={busy} onClick={onClose}>취소</button>
      <button type="button" className="sandbox-strip__action" data-danger disabled={busy} onClick={remove}>삭제</button>
    </div>
  </Modal>;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <SettingsGroup title={title} className="ghost-panel">{children}</SettingsGroup>;
}

/** The name reads as the heading and edits in place; Enter or leaving the field saves, Escape restores. */
function NameField({ name, onSave }: { name: string; onSave(name: string): Promise<boolean> }) {
  const [draft, setDraft] = useState(name);
  const commit = () => { const next = draft.trim(); if (!next) setDraft(name); else if (next !== name) void onSave(next).then(ok => { if (!ok) setDraft(name); }); };
  return <input className="ghost-sheet__name" aria-label="이름" value={draft} maxLength={128} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setDraft(name); event.currentTarget.blur(); } }}/>;
}

/** 활성 · 일시정지 · 은퇴 as one capsule with a sliding thumb. The main Ghost stays active. */
function StateSwitch({ value, disabled, onChange }: { value: GhostState; disabled: boolean; onChange(next: GhostState): void }) {
  const index = states.findIndex(item => item.value === value);
  return <div className="state-switch" role="radiogroup" aria-label="상태" data-value={value} style={{ '--index': index } as CSSProperties}>
    <span className="state-switch__thumb" aria-hidden="true"/>
    {states.map(item => <button key={item.value} type="button" role="radio" aria-checked={item.value === value} disabled={disabled && item.value !== value}
      onClick={() => item.value !== value && onChange(item.value)}>{item.value === 'active' && <Power aria-hidden="true"/>}{item.label}</button>)}
  </div>;
}

function ModelChoice({ value, onChange, add = false, inherit = true, excluded = [], disabled = false, label }: {
  value: ModelRef | null;
  onChange(model: ModelRef | null): void;
  add?: boolean;
  inherit?: boolean;
  excluded?: readonly ModelRef[];
  disabled?: boolean;
  label?: string;
}) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const settings = state?.settings;
  const providers = usableProviders(settings);
  const nameOf = (ref: ModelRef | null | undefined) => {
    if (!ref) return null;
    const provider = settings?.providers.find(item => item.id === ref.provider);
    const model = provider?.models.find(item => item.id === ref.model);
    return { provider: provider?.name ?? ref.provider, model: model?.name || ref.model };
  };
  const current = nameOf(value);
  const fallback = nameOf(settings?.defaultModel);
  const search = query.trim().toLocaleLowerCase();
  const matches = providers.map(provider => ({
    ...provider, models: provider.models.filter(model => `${provider.name} ${model.name} ${model.id}`.toLocaleLowerCase().includes(search)),
  })).filter(provider => provider.models.length);
  const pick = (model: ModelRef | null) => { setOpen(false); onChange(model); };
  return <Popover open={open && !disabled} onOpenChange={next => { setOpen(next); if (next) setQuery(''); }}>
    <PopoverTrigger asChild>
      <button type="button" className="model-choice" disabled={disabled} data-add={add || undefined} data-default={(!value && !add) || undefined}>
        {label && <span className="sr-only">{label}: </span>}
        {add ? <span>대체 모델 추가</span> : <span className="model-choice__copy">
          <span className="model-choice__model">{current?.model ?? fallback?.model ?? '모델 없음'}</span>
          <span className="model-choice__provider">{current ? current.provider : `기본 모델 따름${fallback ? ` · ${fallback.provider}` : ''}`}</span>
        </span>}
        <ChevronDown aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="model-menu w-[min(380px,calc(100vw-32px))] p-1.5" aria-label={label ?? '대체 모델 추가'}>
      <label className="model-menu__search"><Search aria-hidden="true"/>
        <input type="text" enterKeyHint="search" aria-label="모델 검색" placeholder="모델 검색" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>
      </label>
      <div className="model-menu__list">
        {!add && inherit && !search && <button type="button" className="menu-row w-full" aria-pressed={!value} onClick={() => pick(null)}>
          <span className="flex-1">기본 모델 따름</span>{!value && <Check size={14} aria-hidden="true"/>}
        </button>}
        {matches.map(provider => <div key={provider.id}>
          <p className="menu-heading">{provider.name}</p>
          {provider.models.map(model => {
            const chosen = value?.provider === provider.id && value.model === model.id;
            const used = excluded.some(ref => ref.provider === provider.id && ref.model === model.id);
            return <button key={model.id} type="button" className="menu-row w-full" disabled={used} aria-pressed={chosen} onClick={() => pick({ provider: provider.id, model: model.id })}>
              <span className="model-menu__name">{model.name || model.id}</span>
              {used ? <span className="model-menu__used">이미 사용 중</span> : chosen && <Check size={14} aria-hidden="true"/>}
            </button>;
          })}
        </div>)}
        {!matches.length && <p className="model-menu__empty">{providers.length ? '일치하는 모델이 없습니다.' : '연결된 모델이 없습니다.'}</p>}
        {!providers.length && <a className="menu-row" href="#/settings?tab=models">모델 설정</a>}
      </div>
    </PopoverContent>
  </Popover>;
}

/** Role instructions as a note: it grows with its text and a save chip appears only when it changed. */
function PersonaNote({ persona, onSave }: { persona: string; onSave(persona: string): Promise<boolean> }) {
  const [draft, setDraft] = useState(persona);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const node = area.current; if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }, [draft]);
  const changed = draft !== persona;
  const commit = () => { if (changed && draft.trim()) void onSave(draft); };
  return <div className="persona-note" data-changed={changed || undefined}>
    <textarea ref={area} aria-label={uiTerms.roleInstructions} value={draft} maxLength={8192} rows={3} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); commit(); } }}/>
    {changed && <div className="persona-note__actions">
      <button type="button" className="persona-note__revert" onClick={() => setDraft(persona)} aria-label="되돌리기"><RotateCcw aria-hidden="true"/></button>
      <button type="button" className="persona-note__save" disabled={!draft.trim()} onClick={commit}>저장</button>
    </div>}
  </div>;
}

/** 환경 적응 notes: the role editor's note, a quiet line about the last change, and 되돌리기 back to the previous notes. */
function AdaptationNote({ adaptation, onSave }: { adaptation: Adaptation | undefined; onSave(notes: string): Promise<boolean> }) {
  const notes = adaptation?.notes ?? '';
  const previous = adaptation?.previous ?? null;
  const [draft, setDraft] = useState(notes);
  const area = useRef<HTMLTextAreaElement>(null);
  const now = useNow();
  useEffect(() => { const node = area.current; if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }, [draft]);
  const changed = draft !== notes;
  const commit = () => { if (changed) void onSave(draft); };
  return <div className="persona-note" data-changed={changed || undefined}>
    <textarea ref={area} aria-label="환경 적응" value={draft} maxLength={ADAPTATION_MAX_CHARS} rows={3} placeholder="이 Mac에서 배운 사용법과 습관" onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); commit(); } }}/>
    {adaptation && <p className="adaptation-note__meta">{adaptationLine(adaptation, now)}</p>}
    {(changed || previous !== null) && <div className="persona-note__actions">
      {previous !== null && <button type="button" className="adaptation-note__revert" onClick={() => void onSave(previous)}>되돌리기</button>}
      {changed && <button type="button" className="persona-note__save" onClick={commit}>저장</button>}
    </div>}
  </div>;
}

/** Every selectable tool as a switch-pill, grouped by purpose; a group label toggles the whole group. */
function CapabilityBoard({ tools, onChange }: { tools: readonly GhostTool[]; onChange(tools: GhostTool[]): void }) {
  // Optimistic: pills flip at once; the stored list catches up through the host snapshot.
  const [shown, setShown] = useState<readonly GhostTool[]>(tools);
  useEffect(() => setShown(tools), [tools]);
  const set = (changes: readonly GhostTool[], on: boolean) => {
    const next = GHOST_TOOLS.filter(tool => changes.includes(tool) ? on : shown.includes(tool));
    setShown(next);
    onChange(next);
  };
  const grouped = new Set<GhostTool>(toolGroups.flatMap(group => [...group.tools]));
  const groups = [...toolGroups, ...(GHOST_TOOLS.some(tool => !grouped.has(tool)) ? [{ title: '기타', tools: GHOST_TOOLS.filter(tool => !grouped.has(tool)) }] : [])];
  return <div className="capabilities">
    {groups.map(group => {
      const enabled = group.tools.filter(tool => shown.includes(tool)).length;
      const all = enabled === group.tools.length;
      return <div key={group.title} className="capabilities__group" data-level={all ? 'all' : enabled ? 'some' : 'none'} data-privileged={group.privileged || undefined}>
        <button type="button" className="capabilities__head" aria-pressed={all} onClick={() => set(group.tools, !all)}>
          <span className="capabilities__meter" aria-hidden="true" style={{ '--fill': enabled / group.tools.length } as CSSProperties}/>
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
    <span className="sandbox-strip__orb" aria-hidden="true"/>
    <span className="sandbox-strip__copy"><strong>{label[state] ?? state}</strong>{detail && <small>{detail}</small>}</span>
    {state === 'running' && <button type="button" className="sandbox-strip__action" onClick={() => void save({ type: 'sandbox.control', ghostId, action: 'stop' })}><Square aria-hidden="true"/>정지</button>}
    {confirm
      ? <span className="sandbox-strip__confirm">
        <button type="button" className="sandbox-strip__action" data-danger onClick={() => void save({ type: 'sandbox.control', ghostId, action: 'reset' }).then(() => setConfirm(false))}>파일까지 지우고 초기화</button>
        <button type="button" className="sandbox-strip__action" aria-label="취소" onClick={() => setConfirm(false)}><X aria-hidden="true"/></button>
      </span>
      : <button type="button" className="sandbox-strip__action" onClick={() => setConfirm(true)}><RotateCcw aria-hidden="true"/>초기화</button>}
    {error && <InlineError>{error}</InlineError>}
  </div>;
}

/** A new Ghost starts as a sheet of its own: the portrait it will get, its name and its role. */
function GhostCreator({ onCancel, onCreated }: { onCancel(): void; onCreated(id: string): void }) {
  const { client } = useHost();
  const [name, setName] = useState(''), [persona, setPersona] = useState('');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const create = async () => {
    if (!name.trim() || !persona.trim() || saving) return;
    setSaving(true); setError('');
    try {
      const created = await client.send<{ ghostId?: string }>({ type: 'ghost.create', name: name.trim(), persona });
      if (created.ghostId) onCreated(created.ghostId); else onCancel();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ghost를 만들지 못했습니다.'); setSaving(false); }
  };
  return <form className="ghost-sheet ghost-sheet--new" onSubmit={event => { event.preventDefault(); void create(); }}>
    <header className="ghost-sheet__identity">
      <span className="ghost-sheet__portrait" aria-hidden="true"><DotAvatar profileId={`new:${name}`} size={60}/></span>
      <div className="ghost-sheet__who">
        <input className="ghost-sheet__name" aria-label="이름" placeholder="이름" value={name} maxLength={128} autoFocus required disabled={saving} onChange={event => setName(event.target.value)}/>
      </div>
    </header>
    <Panel title={uiTerms.roleInstructions}>
      <div className="persona-note"><textarea aria-label={uiTerms.roleInstructions} placeholder="어떻게 말하고 일할지" value={persona} rows={4} maxLength={8192} required disabled={saving} onChange={event => setPersona(event.target.value)}/></div>
    </Panel>
    {error && <InlineError>{error}</InlineError>}
    <div className="ghost-sheet__footer">
      <button type="button" className="sandbox-strip__action" disabled={saving} onClick={onCancel}>취소</button>
      <button type="submit" className="persona-note__save" disabled={saving || !name.trim() || !persona.trim()}>{saving ? '만드는 중…' : '만들기'}</button>
    </div>
  </form>;
}
