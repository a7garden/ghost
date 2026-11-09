import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Crown, Lock, MessageCircle, Plus, Power, RotateCcw, Search, Square, Trash2, X } from 'lucide-react';
import { BROWSER_TOOLS, GHOST_TOOLS, HOST_TOOLS, TERMINAL_WORK_STATES, type Command, type Ghost, type GhostState, type GhostTool, type ModelRef, type SkillCatalog, type Work } from '@ghost/contract';
import { Button, InlineError, Popover, PopoverContent, PopoverTrigger, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { shortcut } from '../ui/keys';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { GhostDesignEditor } from './GhostDesign';
import { PermissionsPanel } from './GhostPermissions';
import { toneFor } from './ghostState';
import { usableProviders } from '../pets/ModelPicker';
import { uiTerms } from '../uiText';
import './ghost-settings.css';

const toolLabels: Record<GhostTool, string> = {
  work_create: '일 만들기', work_list: '일 목록', work_inspect: '일 자세히', work_update: '일 고치기', work_cancel: '일 취소',
  schedule_create: '반복 만들기', schedule_list: '반복 보기', schedule_cancel: '반복 취소',
  ghost_list: 'Ghost 목록', read: '파일 읽기', write: '파일 쓰기', edit: '파일 고치기', bash: '명령 실행',
  publish_artifact: '결과물 공유', delegate: '다른 Ghost에게 맡기기',
  memory_search: '기억 검색', memory_recall: '기억 불러오기', memory_retain: '기억 저장',
  document_spaces: '문서 공간', document_list: '문서 목록', document_read: '문서 읽기', document_propose: '문서 수정 제안',
  web_search: '웹 검색', web_read: '웹 읽기', reach: '외부 읽기', skill_read: '스킬 읽기',
  host_status: 'Mac 상태', host_services: 'Mac 서비스', host_disk_scan: 'Mac 디스크 검색', host_disk_usage: 'Mac 디스크 사용량',
  host_list: 'Mac 파일 목록', host_read: 'Mac 파일 읽기', host_nodes: 'Tailscale 노드', host_command_propose: 'Mac 명령 제안',
  browser_open: '브라우저 열기', browser_snapshot: '화면 요소 보기', browser_text: '화면 글 읽기', browser_screenshot: '화면 캡처',
  browser_act: '누르기 · 입력', browser_login: '금고로 로그인',
};

/** 용도별 묶음. contract의 GHOST_TOOLS를 따르고 여기 없는 새 도구는 기타로 내려간다. */
const toolGroups: readonly { title: string; tools: readonly GhostTool[]; privileged?: { label: string; note: string; consequence: string } }[] = [
  { title: '맡긴 일', tools: ['work_create', 'work_list', 'work_inspect', 'work_update', 'work_cancel'] },
  { title: '협업', tools: ['delegate', 'ghost_list', 'publish_artifact'] },
  { title: '파일과 명령', tools: ['read', 'write', 'edit', 'bash'] },
  { title: '웹', tools: ['web_search', 'web_read', 'reach'] },
  { title: '스킬', tools: ['skill_read'] },
  { title: '기억', tools: ['memory_search', 'memory_recall', 'memory_retain'] },
  { title: '문서', tools: ['document_spaces', 'document_list', 'document_read', 'document_propose'] },
  { title: '반복 작업', tools: ['schedule_create', 'schedule_list', 'schedule_cancel'] },
  // The host refuses Mac tool changes from the main Ghost's ghost_update, so 소유자 전용 is literal here.
  { title: 'Mac', tools: [...HOST_TOOLS], privileged: {
    label: '소유자 전용',
    note: '샌드박스 밖 Mac에 닿습니다. 소유자만 켜고 끌 수 있고 메인 Ghost도 바꾸지 못합니다.',
    consequence: 'Mac의 파일 · 서비스 · 디스크를 읽고 Mac에서 실행할 명령을 제안합니다. 명령은 「권한」의 「Mac 명령」 설정에 따라 승인을 받거나 바로 실행됩니다.',
  } },
  // 2026-11-09: 소유자의 브라우저(로그인 상태 포함)를 쓰므로 Mac 도구처럼 기본으로 주지 않는다.
  // Not owner-only on the host (only HOST_TOOLS are), so the note does not claim it.
  { title: '브라우저', tools: [...BROWSER_TOOLS], privileged: {
    label: '기본으로 꺼짐',
    note: '소유자의 브라우저와 로그인 상태를 씁니다. 새 Ghost에는 주지 않습니다.',
    consequence: '소유자의 브라우저에서 사이트를 열고 누르고 입력하며, 「금고 로그인」에 넣은 계정으로 로그인합니다. 결제 · 전송 클릭은 「권한」 설정에 따라 승인을 받습니다.',
  } },
];
/** Tools that act outside the sandbox with the owner's reach; switching a whole group with one of them on asks first. */
const confirmedTools: readonly GhostTool[] = ['host_command_propose', 'browser_login'];

/** Whether a group-head toggle needs a confirm: only turning on, and only when it newly grants a confirmed tool. Pure; tests pin it. */
export function groupToggleNeedsConfirm(group: readonly GhostTool[], shown: readonly GhostTool[], on: boolean): boolean {
  return on && group.some(tool => confirmedTools.includes(tool) && !shown.includes(tool));
}

/** The Ghost's own Work that has not settled yet. Pure; tests pin it. */
export function liveWorkCount(works: readonly Pick<Work, 'ghostId' | 'state'>[], ghostId: string): number {
  return works.filter(work => work.ghostId === ghostId && !TERMINAL_WORK_STATES.includes(work.state)).length;
}
/** 대화 종류에 따라 항상 쓰는 도구. 선택 목록에 없고 끌 수 없다. */
const alwaysTools = ['소유자에게 묻기', '일 완료 보고', '일 상태 보고', '결과물 읽기', '실행 기록 보기', '검토 실행', '검토 판정'];
const states: { value: GhostState; label: string }[] = [{ value: 'active', label: '활성' }, { value: 'paused', label: '일시정지' }, { value: 'retired', label: '은퇴' }];

/**
 * Ghost 설정: 위쪽 초상 줄에서 Ghost를 고르고, 아래에서 그 Ghost의 이름·메인 지정·상태·모델·역할·도구·샌드박스를 고친다.
 * 모습은 초상을 눌러 여는 꾸미기가 맡는다. 모든 변경은 ghost.update · ghost.set_default · sandbox.control로 바로 저장된다.
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
  /** ?new=1 opens the creator on arrival, as the command palette asks. */
  createRequested?: boolean;
  /** Drops ?new=1 without a history entry once the creator closes, so Back does not reopen it. */
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
        <input aria-label="설정할 Ghost 찾기" placeholder="Ghost 찾기" value={query} onChange={event => setQuery(event.target.value)}/>
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

/**
 * Saves a change and reports failure in place; the newest request wins the status line.
 * Each control owns its saver, so an error shows beside the control that caused it.
 * `attempt` throws instead of recording, for a ConfirmDialog that shows the reason itself.
 */
export function useSaver() {
  const { client } = useHost();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const attempt = async (command: Command) => {
    setError(''); setPending(count => count + 1);
    try { await client.send(command); }
    catch (reason) { throw reason instanceof Error ? reason : new Error('저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setPending(count => count - 1); }
  };
  const save = async (command: Command) => {
    try { await attempt(command); return true; }
    catch (reason) { setError((reason as Error).message); return false; }
  };
  return { save, attempt, error, saving: pending > 0 };
}
export type Saver = ReturnType<typeof useSaver>;

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

/** One Ghost's sheet; exported for tests. */
export function GhostSheet({ ghost, onChat }: { ghost: Ghost; onChat(): void }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const { client } = useHost();
  // The sheet-top line is for the identity (name); every other control reports beside itself.
  const { save, error, saving: naming } = useSaver();
  const routeSaver = useSaver(), personaSaver = useSaver(), skillSaver = useSaver(), toolSaver = useSaver(), permissionSaver = useSaver(), operate = useSaver();
  const saving = naming || [routeSaver, personaSaver, skillSaver, toolSaver, permissionSaver, operate].some(saver => saver.saving);
  const [designing, setDesigning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [changingState, setChangingState] = useState<GhostState | null>(null);
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const sandbox = state?.sandboxes.find(item => item.ghostId === ghost.id);
  const live = liveWorkCount(state?.works ?? [], ghost.id);
  type Patch = Partial<Pick<Ghost, 'name' | 'persona' | 'state' | 'tools' | 'fallbacks' | 'skills'>> & { model?: ModelRef | null };
  const update = (patch: Patch, saver: Pick<Saver, 'save'> = { save }) => saver.save({ type: 'ghost.update', ghostId: ghost.id, ...patch });
  // Pausing or retiring leaves live Work running (the host only refuses new Work), so the owner hears that first.
  const changeState = (next: GhostState) => { if (next !== 'active' && live > 0) setChangingState(next); else void update({ state: next }, operate); };
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

    <Panel title="모델"><ModelRoute ghost={ghost} save={routeSaver.save}/>{routeSaver.error && <InlineError>{routeSaver.error}</InlineError>}</Panel>
    <Panel title={uiTerms.roleInstructions}><PersonaNote key={ghost.persona} ghostId={ghost.id} persona={ghost.persona} error={personaSaver.error} onSave={text => update({ persona: text }, personaSaver)}/></Panel>
    <SkillsPanel catalog={catalog} skills={ghost.skills} error={skillSaver.error} onChange={next => void update({ skills: next }, skillSaver)}/>
    <Panel title="도구"><CapabilityBoard tools={ghost.tools} error={toolSaver.error} onChange={next => update({ tools: next }, toolSaver)}/></Panel>
    <PermissionsPanel ghost={ghost} save={permissionSaver.save} saving={permissionSaver.saving} error={permissionSaver.error}/>
    <Panel title="운영">
      <SettingsRow label="상태" description={ghost.isDefault ? '메인 Ghost는 활성 상태를 유지합니다.' : undefined}>
        {ghost.isDefault ? <span className="ghost-sheet__locked"><Lock aria-hidden="true"/>활성</span>
          : <StateSwitch value={ghost.state} disabled={saving} onChange={changeState}/>}
      </SettingsRow>
      {!ghost.isDefault && <SettingsRow label="메인 Ghost" description="새 대화와 일을 처음 받는 Ghost">
        <button type="button" className="sandbox-strip__action" disabled={saving || ghost.state !== 'active'} onClick={() => void operate.save({ type: 'ghost.set_default', ghostId: ghost.id })}>
          <Crown aria-hidden="true"/>메인으로 지정
        </button>
      </SettingsRow>}
      {canDeleteGhost(ghost) && <SettingsRow label="Ghost 삭제" description="목록에서 제거합니다. 지난 맡긴 일의 기록은 남습니다.">
        <button type="button" className="sandbox-strip__action" data-danger onClick={() => setDeleting(true)}><Trash2 aria-hidden="true"/>삭제</button>
      </SettingsRow>}
      {operate.error && <InlineError>{operate.error}</InlineError>}
    </Panel>
    {sandbox && sandbox.state !== 'none' && <Panel title="샌드박스"><SandboxStrip ghostId={ghost.id} state={sandbox.state} detail={sandbox.detail}/></Panel>}

    {designing && <Modal title={`${ghost.name} 꾸미기`} onClose={() => setDesigning(false)} className="sm:max-w-[760px]"><GhostDesignEditor ghostId={ghost.id}/></Modal>}
    {deleting && <DeleteDialog ghost={ghost} onClose={() => setDeleting(false)}/>}
    {changingState && <ConfirmDialog title={`${ghost.name} ${changingState === 'paused' ? '일시정지' : '은퇴'}`}
      confirmLabel={changingState === 'paused' ? '일시정지' : '은퇴'} tone={changingState === 'retired' ? 'destructive' : 'default'}
      onConfirm={() => operate.attempt({ type: 'ghost.update', ghostId: ghost.id, state: changingState })} onClose={() => setChangingState(null)}>
      <p>진행 중인 맡긴 일 {live}개는 취소되지 않고 그대로 이어집니다.</p>
      <p>{changingState === 'paused' ? '일시정지하는 동안' : '은퇴한 뒤에는'} 새 일 · 위임 · 반복 작업을 받지 않습니다.{changingState === 'retired' && ' 삭제는 이 일들이 모두 끝난 뒤에 할 수 있습니다.'}</p>
    </ConfirmDialog>}
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
export function SkillsPanel({ catalog, skills, onChange, error }: {
  catalog: SkillCatalog | null;
  skills: readonly string[];
  onChange(skills: string[]): void;
  error?: string;
}) {
  if (!catalog?.skills.length) return null;
  return <Panel title="스킬"><SkillBoard catalog={catalog.skills} skills={skills} onChange={onChange}/>{error && <InlineError>{error}</InlineError>}</Panel>;
}

/** Skills as toggle pills; the description rides on hover only, and skills gone from the catalog stay removable. */
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
        title={skill.description || undefined} onClick={() => toggle(skill.name, !on)}>{skill.name}</button>;
    })}
    {[...skills].filter(name => !known.has(name)).map(name => <button key={name} type="button" className="skill" data-unavailable
      aria-pressed title="카탈로그에 없는 스킬" onClick={() => toggle(name, false)}>{name}</button>)}
  </div>;
}

/** 삭제 confirm: the body says what goes and what stays (host deleteGhost); a conflict shows the server message in place. */
function DeleteDialog({ ghost, onClose }: { ghost: Ghost; onClose(): void }) {
  const { client } = useHost();
  const remove = async () => {
    try { await client.send(deleteCommand(ghost.id)); }
    catch (reason) { throw reason instanceof Error ? reason : new Error('Ghost를 삭제하지 못했습니다. 다시 시도해 주세요.'); }
  };
  return <ConfirmDialog title={`${ghost.name} 삭제`} confirmLabel="삭제" onConfirm={remove} onClose={onClose}>
    <p>목록에서 사라지며 되살릴 수 없습니다. 이 Ghost의 반복 작업과 문서 공간 권한도 함께 지워집니다.</p>
    <p>지난 맡긴 일과 대화의 기록은 남습니다.</p>
  </ConfirmDialog>;
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
        <input aria-label="모델 검색" placeholder="모델 검색" value={query} onChange={event => setQuery(event.target.value)}/>
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

/**
 * Unsaved role instructions per Ghost, kept for the app's lifetime. Switching Ghost or page unmounts the
 * note; instead of blocking that, the draft waits here and comes back marked as unsaved.
 */
type PersonaDraft = { base: string; draft: string };
const personaDrafts = new Map<string, PersonaDraft>();

/** Remembers or forgets a Ghost's unsaved role instructions; a draft equal to the stored text is no draft. Exported for tests. */
export function keepPersonaDraft(drafts: Map<string, PersonaDraft>, ghostId: string, draft: string, persona: string): void {
  if (draft === persona) drafts.delete(ghostId); else drafts.set(ghostId, { base: persona, draft });
}

/** A parked draft, only while the stored text is still the one it was written against: a newer persona saved
 * elsewhere wins, so 저장 never overwrites it with an older edit. Exported for tests. */
export function restorePersonaDraft(drafts: Map<string, PersonaDraft>, ghostId: string, persona: string): string {
  const kept = drafts.get(ghostId);
  if (kept && kept.base === persona) return kept.draft;
  drafts.delete(ghostId);
  return persona;
}

/** Role instructions as a note: it grows with its text and a save chip appears only when it changed. */
function PersonaNote({ ghostId, persona, error, onSave }: { ghostId: string; persona: string; error?: string; onSave(persona: string): Promise<boolean> }) {
  const [draft, setDraft] = useState(() => restorePersonaDraft(personaDrafts, ghostId, persona));
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const node = area.current; if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }, [draft]);
  const changed = draft !== persona;
  useEffect(() => keepPersonaDraft(personaDrafts, ghostId, draft, persona), [ghostId, draft, persona]);
  // In-app navigation keeps the draft above; closing or reloading the window would not, so it asks.
  useEffect(() => {
    if (!changed) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [changed]);
  const commit = () => { if (changed && draft.trim()) void onSave(draft); };
  return <div className="persona-note" data-changed={changed || undefined}>
    <textarea ref={area} aria-label={uiTerms.roleInstructions} value={draft} maxLength={8192} rows={3} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); commit(); } }}/>
    {changed && <div className="persona-note__actions">
      <span className="persona-note__unsaved" role="status">저장하지 않은 변경 · {shortcut('S')}로 저장</span>
      <button type="button" className="persona-note__revert" onClick={() => setDraft(persona)} aria-label="되돌리기" title="저장된 내용으로 되돌리기"><RotateCcw aria-hidden="true"/></button>
      <button type="button" className="persona-note__save" disabled={!draft.trim()} onClick={commit}>저장</button>
    </div>}
    {error && <div className="persona-note__error"><InlineError>{error}</InlineError></div>}
  </div>;
}

/** Every selectable tool as a switch-pill, grouped by purpose; a group label toggles the whole group. */
function CapabilityBoard({ tools, error, onChange }: { tools: readonly GhostTool[]; error?: string; onChange(tools: GhostTool[]): Promise<boolean> }) {
  // Optimistic: pills flip at once; the stored list catches up through the host snapshot, and a failed save
  // rolls back to it (the snapshot does not move on failure, so the effect alone would leave the flip standing).
  const [shown, setShown] = useState<readonly GhostTool[]>(tools);
  const [failedGroup, setFailedGroup] = useState('');
  const [confirming, setConfirming] = useState<(typeof toolGroups)[number] | null>(null);
  useEffect(() => setShown(tools), [tools]);
  // Each save carries the whole list, so saves run one at a time: an overlapping second save would carry the
  // first one's flip even if that first one failed. A failure rolls back to the newest stored list, not the one
  // captured at click time.
  const stored = useRef(tools);
  stored.current = tools;
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const set = async (group: string, changes: readonly GhostTool[], on: boolean) => {
    if (inFlight.current) return false;
    inFlight.current = true; setSaving(true);
    const next = GHOST_TOOLS.filter(tool => changes.includes(tool) ? on : shown.includes(tool));
    setShown(next);
    try {
      const ok = await onChange(next);
      if (ok) setFailedGroup(''); else { setShown(stored.current); setFailedGroup(group); }
      return ok;
    } finally {
      inFlight.current = false; setSaving(false);
    }
  };
  const grouped = new Set<GhostTool>(toolGroups.flatMap(group => [...group.tools]));
  const groups: readonly (typeof toolGroups)[number][] = [...toolGroups, ...(GHOST_TOOLS.some(tool => !grouped.has(tool)) ? [{ title: '기타', tools: GHOST_TOOLS.filter(tool => !grouped.has(tool)) }] : [])];
  return <div className="capabilities" aria-busy={saving || undefined}>
    {groups.map(group => {
      const enabled = group.tools.filter(tool => shown.includes(tool)).length;
      const all = enabled === group.tools.length;
      const toggleGroup = () => groupToggleNeedsConfirm(group.tools, shown, !all) ? setConfirming(group) : void set(group.title, group.tools, !all);
      return <div key={group.title} className="capabilities__group" data-level={all ? 'all' : enabled ? 'some' : 'none'} data-privileged={group.privileged ? true : undefined}>
        <div className="capabilities__side">
          <button type="button" className="capabilities__head" aria-pressed={all} onClick={toggleGroup}>
            <span className="capabilities__meter" aria-hidden="true" style={{ '--fill': enabled / group.tools.length } as CSSProperties}/>
            {group.title}<span className="tabular">{enabled}/{group.tools.length}</span>
            {group.privileged && <Lock className="capabilities__lock" aria-hidden="true"/>}
          </button>
          {group.privileged && <p className="capabilities__note" title={group.privileged.note}><strong>{group.privileged.label}</strong> · {group.privileged.note}</p>}
        </div>
        <div className="capabilities__pills">
          {group.tools.map(tool => <button key={tool} type="button" className="capability" aria-pressed={shown.includes(tool)} onClick={() => void set(group.title, [tool], !shown.includes(tool))}>
            <span className="capability__dot" aria-hidden="true"/>{toolLabels[tool]}
          </button>)}
          {error && failedGroup === group.title && <div className="capabilities__error"><InlineError>{error}</InlineError></div>}
        </div>
      </div>;
    })}
    {confirming?.privileged && <ConfirmDialog title={`${confirming.title} 도구 모두 켜기`} confirmLabel="모두 켜기" tone="default"
      onConfirm={async () => { if (!await set(confirming.title, confirming.tools, true)) throw new Error('도구를 켜지 못했습니다. 다시 시도해 주세요.'); }}
      onClose={() => setConfirming(null)}>
      <p>{confirming.privileged.consequence}</p>
      <p>실행 기록은 그대로 남습니다. 필요한 도구만 하나씩 골라 켤 수도 있습니다.</p>
    </ConfirmDialog>}
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
      <Button variant="outline" type="button" disabled={saving} onClick={onCancel}>취소</Button>
      <Button type="submit" disabled={saving || !name.trim() || !persona.trim()}>{saving ? '만드는 중…' : '만들기'}</Button>
    </div>
  </form>;
}
