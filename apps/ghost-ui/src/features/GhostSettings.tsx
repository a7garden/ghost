import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Crown, Lock, MessageCircle, Pencil, Plus, Power, RotateCcw, Search, Square, Trash2, X } from 'lucide-react';
import { ADAPTATION_MAX_CHARS, BROWSER_TOOLS, DESKTOP_TOOLS, FINANCE_TOOLS, GHOST_TOOLS, HOST_TOOLS, MAIL_TOOLS, VAULT_TOOLS, type Adaptation, type AutonomyPlan, type Command, type Ghost, type GhostState, type GhostTool, type ModelRef, type SkillCatalog } from '@ghost/contract';
import { InlineError, Popover, PopoverContent, PopoverTrigger, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { GhostDesignEditor } from './GhostDesign';
import { GhostMemory } from './GhostMemory';
import { toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { usableProviders } from '../pets/ModelPicker';
import { uiTerms } from '../uiText';
import './ghost-settings.css';
import { blurTouchSearchOnEnter } from '../ui/adaptive';
import { FallbackSteps, ModelChoice, editFallbacks, modelName, type FallbackAction } from './fallbacks';
import { toolLabels } from './toolLabels';
import { PatternGrants } from './PatternGrants';
import { GhostAttachments } from './GhostAttachments';

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
    <Panel title="추가 도구"><PatternGrants key={JSON.stringify(ghost.tools)} tools={ghost.tools} onSave={tools => update({ tools })}/></Panel>
    <Panel title="붙임"><GhostAttachments key={JSON.stringify(ghost.attachments)} ghost={ghost}/></Panel>
    <Panel title="기억"><GhostMemory ghost={ghost}/></Panel>
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
    <p className="model-route__hint">{inherited.length
      ? '기본 대체 모델을 따릅니다. 여기서 추가하면 이 Ghost만의 목록이 되어 기본 대체 모델 대신 씁니다.'
      : '연결 오류·사용 한도에 걸리면 다음 모델로 이어갑니다.'}</p>
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


/**
 * Role instructions read as text first; 「역할 편집」 opens the note for editing, and saving or cancelling closes it.
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
    <div className="persona-note__actions">
      <span className="persona-note__hint">기본 지시 앞에 이 Ghost만의 역할로 붙습니다.</span>
      <button type="button" className="persona-note__edit" onClick={() => setEditing(true)}><Pencil aria-hidden="true"/>역할 편집</button>
    </div>
  </div>;
  return <div className="persona-note" data-changed={changed || undefined}>
    <textarea ref={area} aria-label={uiTerms.roleInstructions} value={draft} maxLength={8192} rows={3} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void commit(); }
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }}/>
    <div className="persona-note__actions">
      {changed && <button type="button" className="persona-note__revert" onClick={() => setDraft(persona)} aria-label="되돌리기" title="되돌리기"><RotateCcw aria-hidden="true"/></button>}
      <button type="button" className="persona-note__cancel" onClick={cancel}>취소</button>
      <button type="button" className="persona-note__save" disabled={!draft.trim()} onClick={() => void commit()}>저장</button>
    </div>
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
