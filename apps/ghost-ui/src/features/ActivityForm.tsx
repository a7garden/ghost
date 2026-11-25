import { useState, type ReactNode } from 'react';
import { Button, InlineError } from '../ui';
import type { Activity, ActivityConfig, ActivitySource, Connection, Ghost, GhostTool, State } from '@ghost/contract';
import { FolderField } from '../components/FolderPicker';
import { toolLabels } from './toolLabels';
import { visibleGhosts } from './ghostState';
import { activityToolChoices, buildActivityConfig, deliveryLabel, draftFromConfig, emptyDraft, executionLabel, intersectTools, DEFAULT_ACTIVITY_TOOLS, externalActionsLabel, policySummary, sourceKindLabel, sourceSummary } from './activity-config';
import { intervalLabel } from './Schedules';
import { ruleError, ruleKeys } from './standing-rules';

/** Ghosts a form may target: everyone in circulation, plus the edited activity's own Ghost if it left those lists. */
function formGhosts(state: Pick<State, 'ghosts'>, activity: Activity | null): Ghost[] {
  const ghosts = visibleGhosts(state.ghosts);
  const bound = activity ? state.ghosts.find(ghost => ghost.id === activity.ghostId) : undefined;
  return bound && !ghosts.some(ghost => ghost.id === bound.id) ? [bound, ...ghosts] : ghosts;
}

/** The list, pending proposal and editor all read down the same rule rail. */
function ActivityRule({ when, does, limits }: { when: ReactNode; does: ReactNode; limits: ReactNode }) {
  return <ol className="activity-rule">
    <li className="activity-rule__step"><span className="activity-rule__lead">계기</span><div className="activity-rule__body">{when}</div></li>
    <li className="activity-rule__step"><span className="activity-rule__lead">할 일</span><div className="activity-rule__body">{does}</div></li>
    <li className="activity-rule__step"><span className="activity-rule__lead">한도</span><div className="activity-rule__body">{limits}</div></li>
  </ol>;
}

function ActivityToolSummary({ tools }: { tools: readonly GhostTool[] }) {
  return <>도구 {tools.length}개{tools.length > 0 && ` · ${tools.map(tool => toolLabels[tool] ?? tool).join(', ')}`}</>;
}

function ActivityTools({ choices, selected, saving, onChange }: {
  choices: readonly GhostTool[];
  selected: readonly GhostTool[];
  saving: boolean;
  onChange(tools: GhostTool[]): void;
}) {
  const [query, setQuery] = useState('');
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length === 0 ? choices : choices.filter(tool => {
    const searchable = `${toolLabels[tool] ?? ''} ${tool}`.toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  if (!choices.length) return <p className="rule-facts"><ActivityToolSummary tools={[]}/></p>;
  return <details className="rule-disclosure activity-rule__tools">
    <summary><ActivityToolSummary tools={choices.filter(tool => selected.includes(tool))}/></summary>
    <div role="group" aria-label="활동 도구" className="activity-rule__tool-picker">
      <input className="rule-blank activity-rule__tool-search" type="search" aria-label="활동 도구 검색" placeholder="도구 검색"
        value={query} disabled={saving} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) event.preventDefault(); }}/>
      {visible.length
        ? <div className="activity-rule__tool-options">{visible.map(tool => <label key={tool} className="rule-check">
          <input type="checkbox" checked={selected.includes(tool)} disabled={saving}
            onChange={event => onChange(event.target.checked ? [...selected, tool] : selected.filter(item => item !== tool))}/>
          {toolLabels[tool] ?? tool}
        </label>)}</div>
        : <p className="rule-facts" role="status">검색에 맞는 도구가 없습니다.</p>}
    </div>
  </details>;
}

export function ActivityRulePreview({ config, state }: { config: ActivityConfig; state: Pick<State, 'ghosts' | 'scopes' | 'connections'> }) {
  const { source, execution, policy } = config;
  const ghost = state.ghosts.find(item => item.id === config.ghostId)?.name ?? config.ghostId;
  const scopeName = (id: string) => state.scopes.find(item => item.id === id)?.name ?? id;
  const connection = 'connectionId' in source ? state.connections?.find(item => item.id === source.connectionId) : undefined;
  const watched = source.kind === 'commit' ? `${scopeName(source.scopeId)}에 커밋이 생기면` : sourceSummary(source);
  const checks = source.kind === 'mail' || source.kind === 'pull_request' ? `${intervalLabel(source.pollSeconds)}마다 새 항목 확인` : null;
  const existing = 'includeExisting' in source && source.includeExisting;
  return <ActivityRule when={<>
    <p>{source.kind === 'mail' || source.kind === 'pull_request' ? `${watched} · 새 항목이 오면` : watched}
      {'connectionId' in source && ` · ${connection?.name ?? '연결 없음'}`}</p>
    {(checks || existing) && <p className="rule-facts">{checks}{existing && ' · 처음엔 기존 항목도 실행'}</p>}
    {source.kind === 'poll' && (source.itemsPointer || source.idPointer) && <p className="rule-facts">
      {source.itemsPointer && `목록 ${source.itemsPointer}`}{source.itemsPointer && source.idPointer && ' · '}{source.idPointer && `항목 ID ${source.idPointer}`}
    </p>}
  </>} does={<>
    <p className="rule-facts">{ghost}에게{config.scopeId && ` · ${scopeName(config.scopeId)}`}</p>
    <h3 className="rule-message rule-message--heading">{config.name}</h3>
    <details className="rule-disclosure"><summary>지시와 완료 기준</summary>
      <p className="rule-message">{config.prompt}</p>
      <p className="rule-facts rule-facts--important whitespace-pre-wrap">완료 기준 · {config.acceptanceCriteria}</p>
    </details>
  </>} limits={<>
    <p>{executionLabel[execution.kind]}{execution.kind === 'host' && ` · ${execution.cwd}`} · {policySummary(policy)}</p>
    <p className="rule-facts"><ActivityToolSummary tools={config.tools}/></p>
  </>}/>;
}

export function ActivityRuleEditor({ state, connections, activity, initialScopeId, onClose, onSave }: {
  state: Pick<State, 'ghosts' | 'scopes'>;
  connections: readonly Connection[];
  activity: Activity | null;
  initialScopeId?: string;
  onClose(): void;
  onSave(config: ActivityConfig): Promise<void>;
}) {
  const ghosts = formGhosts(state, activity);
  const [draft, setDraft] = useState(() => {
    if (activity) return draftFromConfig(activity);
    const scope = state.scopes.find(item => item.id === initialScopeId);
    const receiver = ghosts.find(ghost => ghost.id === scope?.ghostId) ?? ghosts.find(ghost => ghost.isDefault) ?? ghosts[0] ?? null;
    return { ...emptyDraft(receiver), scopeId: initialScopeId ?? '', commitScopeId: initialScopeId ?? '' };
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const ghost = ghosts.find(item => item.id === draft.ghostId);
  const set = (patch: Partial<typeof draft>) => setDraft(prev => ({ ...prev, ...patch }));

  const selectGhost = (ghostId: string) => setDraft(prev => {
    const next = ghosts.find(item => item.id === ghostId);
    return {
      ...prev, ghostId,
      tools: intersectTools(DEFAULT_ACTIVITY_TOOLS, next?.tools ?? []),
      ...(prev.executionKind === 'host' && next?.hostExecution !== true ? { executionKind: 'workspace' as const, hostCwd: '' } : {}),
    };
  });

  const sourceConnections = connections.filter(connection => draft.sourceKind === 'poll' ? connection.config.kind === 'api' : draft.sourceKind === 'mail'
    ? connection.config.kind === 'mail' : connection.config.kind === 'github' || connection.config.kind === 'gitea');
  const staleConnection = draft.connectionId !== '' && !sourceConnections.some(connection => connection.id === draft.connectionId);
  const connectionOptions = sourceConnections.map(connection => ({
    value: connection.id,
    label: `${connection.name}${connection.hasCredential ? '' : ' · 자격 없음'}`,
  }));
  const shownConnections = staleConnection
    ? [{ value: draft.connectionId, label: '삭제된 연결' }, ...connectionOptions]
    : connectionOptions;

  const save = async (form: HTMLFormElement) => {
    if (saving) return;
    if (draft.sourceKind !== 'schedule' && draft.sourceKind !== 'commit' && !sourceConnections.some(connection => connection.id === draft.connectionId)) {
      setError('연결을 다시 선택해 주세요. 연결 계정에서 먼저 만들 수 있습니다.');
      return;
    }
    if (draft.sourceKind === 'mail' && (form.elements.namedItem('sender') as HTMLInputElement | null)?.validity.typeMismatch) {
      setError('보낸 사람의 이메일 주소를 확인해 주세요.');
      return;
    }
    const built = buildActivityConfig(draft, ghost);
    if (!built.ok) { setError(built.error); return; }
    setSaving(true); setError('');
    try { await onSave(built.config); }
    catch (reason) { setError(ruleError(reason, '활동을 저장하지 못했습니다. 다시 시도해 주세요.')); setSaving(false); }
  };

  const close = () => { if (!saving) onClose(); };
  const scopes = state.scopes.map(scope => ({ value: scope.id, label: scope.name }));
  const availableTools = activityToolChoices(ghost?.tools ?? []);
  const options = <T extends string,>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map(value => <option key={value} value={value}>{labels[value]}</option>);
  const choice = (label: string, value: string, change: (value: string) => void, items: ReactNode, disabled = false, autoFocus = false) =>
    <select data-rule-blank className="rule-blank" aria-label={label} disabled={saving || disabled} value={value} autoFocus={autoFocus}
      onChange={event => change(event.target.value)}>{items}</select>;
  const optionList = (items: { value: string; label: string }[]) => items.map(item => <option key={item.value} value={item.value}>{item.label}</option>);
  const text = (key: 'repository' | 'baseBranch' | 'labels' | 'pollPath' | 'itemsPointer' | 'idPointer' | 'sender' | 'subjectContains',
    label: string, placeholder: string, maxLength?: number) =>
    <input data-rule-blank className="rule-blank" aria-label={label} name={key} type={key === 'sender' ? 'email' : 'text'} value={draft[key]}
      maxLength={maxLength} disabled={saving} placeholder={placeholder} onChange={event => set({ [key]: event.target.value })}/>;
  const number = (key: 'everyMinutes' | 'pollMinutes' | 'maxRunsPerDay' | 'maxConcurrent' | 'runTimeoutMinutes' | 'minCheckMinutes',
    label: string, min: number, max?: number, step: number | 'any' = 'any') =>
    <input data-rule-blank className="rule-blank" aria-label={label} type="number" min={min} max={max} step={step} value={draft[key]}
      disabled={saving} onChange={event => set({ [key]: event.target.value })}/>;
  const check = (key: 'includeDrafts' | 'unreadOnly' | 'includeExisting' | 'allowSelfCheck', label: string) =>
    <label className="rule-check"><input type="checkbox" checked={draft[key]} disabled={saving} onChange={event => set({ [key]: event.target.checked })}/>{label}</label>;

  return <form className="rule-sheet" data-editing aria-label={activity ? '활동 편집' : '활동 만들기'} aria-busy={saving} noValidate
    onKeyDown={event => ruleKeys(event, close)} onSubmit={event => { event.preventDefault(); void save(event.currentTarget); }}>
    <ActivityRule when={<>
      <div className="rule-inline">
        {choice('활동 소스', draft.sourceKind, sourceKind => set({ sourceKind: sourceKind as ActivitySource['kind'], connectionId: '' }), options(sourceKindLabel), false, !activity)}
        {draft.sourceKind === 'schedule' && <>
          {choice('실행 방식', draft.scheduleMode, scheduleMode => set({ scheduleMode: scheduleMode as typeof draft.scheduleMode }),
            <><option value="every">반복 간격</option><option value="at">지정 시각</option></>)}
          {draft.scheduleMode === 'at'
            ? <label className="rule-clause"><input data-rule-blank className="rule-blank" aria-label="실행 시각" type="datetime-local"
              value={draft.scheduleAt} disabled={saving} onChange={event => set({ scheduleAt: event.target.value })}/>에 한 번</label>
            : <label className="rule-quantity">{number('everyMinutes', '반복 간격 (분)', 1)} 분마다</label>}
        </>}
        {draft.sourceKind === 'commit' && <label className="rule-clause">
          {choice('커밋을 살필 프로젝트', draft.commitScopeId, commitScopeId => set({ commitScopeId }),
            <><option value="">프로젝트 선택</option>{optionList(state.scopes.filter(scope => scope.paths.length > 0).map(scope => ({ value: scope.id, label: scope.name })))}</>)}
          에 새 커밋이 생기면
        </label>}
        {draft.sourceKind !== 'schedule' && draft.sourceKind !== 'commit' && choice('연결 계정', draft.connectionId, connectionId => set({ connectionId }),
          <><option value="">연결 계정 선택</option>{optionList(shownConnections)}</>, !shownConnections.length)}
      </div>
      {draft.sourceKind !== 'schedule' && draft.sourceKind !== 'commit' && <>
        {staleConnection
          ? <InlineError>선택한 연결이 없습니다. 다시 선택해 주세요.</InlineError>
          : !sourceConnections.length && <p className="rule-facts rule-facts--important">연결 계정에서 먼저 연결해 주세요.</p>}
        {draft.sourceKind === 'pull_request' && <>
          <div className="rule-inline">
            <label className="rule-clause">저장소 {text('repository', '저장소', 'owner/repo', 256)}</label>
            <label className="rule-clause">기준 브랜치 {text('baseBranch', '기준 브랜치', '기본 브랜치', 256)}</label>
            <label className="rule-clause">라벨 {text('labels', '라벨', '쉼표로 구분')}</label>
          </div>
          {check('includeDrafts', '드래프트 PR 포함')}
        </>}
        {draft.sourceKind === 'poll' && <div className="rule-inline">
          <label className="rule-clause">확인할 주소 {text('pollPath', '확인할 주소', '/items')}</label>
          <label className="rule-clause">목록 위치 {text('itemsPointer', '목록 위치', '응답 전체')}</label>
          <label className="rule-clause">항목 구분 값 위치 {text('idPointer', '항목 구분 값 위치', '예: /id')}</label>
        </div>}
        {draft.sourceKind === 'mail' && <>
          <div className="rule-inline">
            <label className="rule-clause">보낸 사람 {text('sender', '보낸 사람', '모든 보낸 사람', 320)}</label>
            <label className="rule-clause">제목에 포함 {text('subjectContains', '제목에 포함', '어떤 제목이든', 256)}</label>
          </div>
          {check('unreadOnly', '안 읽은 메일만')}
        </>}
        <div className="rule-inline">
          <label className="rule-quantity">{number('pollMinutes', '확인 주기 (분)', 1, 1440)} 분마다 새 항목 확인</label>
          {draft.sourceKind !== 'poll' && check('includeExisting', '처음엔 기존 항목도 실행')}
        </div>
      </>}
    </>} does={<>
      <div className="rule-inline">
        <label className="rule-clause">
          {choice('Ghost', draft.ghostId, selectGhost, <><option value="">Ghost 선택</option>{optionList(ghosts.map(item => ({ value: item.id, label: item.isDefault ? `${item.name} · 메인` : item.name })))}</>, !!activity || !ghosts.length)}
          에게
        </label>
        <label className="rule-clause">프로젝트
          {choice('프로젝트', draft.scopeId, scopeId => set({ scopeId }), <><option value="">전체</option>{optionList(scopes)}</>)}
        </label>
      </div>
      <input data-rule-blank className="rule-blank rule-message--heading" aria-label="이름" value={draft.name} maxLength={128} required
        autoFocus={!!activity} disabled={saving} placeholder="활동 이름" onChange={event => set({ name: event.target.value })}/>
      <textarea data-rule-blank className="rule-blank rule-message" aria-label="활동 지시" value={draft.prompt} rows={2} maxLength={8192} required
        disabled={saving} placeholder="무엇을 할까요?" onChange={event => set({ prompt: event.target.value })}/>
      <label className="activity-rule__subclause"><span>완료 기준</span>
        <textarea data-rule-blank className="rule-blank" aria-label="완료 기준" value={draft.acceptanceCriteria} rows={1} maxLength={8192} required
          disabled={saving} placeholder="무엇이 남아야 끝난 걸까요?" onChange={event => set({ acceptanceCriteria: event.target.value })}/>
      </label>
    </>} limits={<>
      <div className="rule-inline">
        <label className="rule-clause">
          {choice('실행 환경', draft.executionKind, executionKind => set({ executionKind: executionKind as typeof draft.executionKind }),
            <><option value="workspace">{executionLabel.workspace}</option><option value="container">{executionLabel.container}</option>
              <option value="host" disabled={ghost?.hostExecution !== true}>{executionLabel.host}</option></>)}
          에서
        </label>
        <label className="rule-quantity">하루 {number('maxRunsPerDay', '하루 최대 실행', 1, 1000, 1)} 회까지</label>
        <label className="rule-quantity">동시 {number('maxConcurrent', '동시 실행', 1, 8, 1)} 개까지</label>
        <label className="rule-quantity">한 번에 {number('runTimeoutMinutes', '실행 제한 (분)', 0.5, 1440)} 분까지</label>
      </div>
      {draft.executionKind === 'host' && <>
        <div className="activity-rule__inline-folder"><FolderField inline label="작업 폴더" showLabel={false} value={draft.hostCwd} disabled={saving} onChange={hostCwd => set({ hostCwd })}/></div>
        <p className="activity-warn">이 Mac에서 직접 실행하면 보호 장치 없이 파일과 명령을 씁니다. Mac 전체와 인터넷에 영향을 줄 수 있고, 「PR 댓글·메일 회신」 설정으로 막을 수 없습니다.</p>
      </>}
      {ghost && ghost.hostExecution !== true && <p className="rule-facts">이 Mac에서 실행하려면 Ghost 설정의 운영에서 PC 직접 실행을 허용해야 합니다.</p>}
      <ActivityTools key={draft.ghostId} choices={availableTools} selected={draft.tools} saving={saving} onChange={tools => set({ tools })}/>
      <div className="rule-inline">
        <label className="rule-clause">이 활동의 PR 댓글·메일 회신
          {choice('이 활동의 PR 댓글·메일 회신', draft.externalActions, externalActions => set({ externalActions: externalActions as typeof draft.externalActions }), options(externalActionsLabel))}
        </label>
        <label className="rule-clause">결과 전달
          {choice('결과 전달', draft.delivery, delivery => set({ delivery: delivery as typeof draft.delivery }), options(deliveryLabel))}
        </label>
      </div>
      <div className="rule-inline">
        {check('allowSelfCheck', '자기 점검 허용')}
        {draft.allowSelfCheck && <label className="rule-quantity">실행을 마치고 최소 {number('minCheckMinutes', '자기 점검 최소 간격 (분)', 1, 1440)} 분 뒤 점검</label>}
      </div>
    </>}/>
    {activity && <p className="rule-facts rule-facts--important">저장하면 이 활동의 진행 중인 실행이 취소됩니다.</p>}
    {error && <InlineError>{error}</InlineError>}
    <div className="rule-actions rule-actions--end">
      <Button variant="ghost" type="button" disabled={saving} onClick={close}>취소</Button>
      <Button type="submit" disabled={saving}>{saving ? '저장하는 중…' : activity ? '저장' : '활동 만들기'}</Button>
    </div>
  </form>;
}
