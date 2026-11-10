import { useState } from 'react';
import { Button, FormField, InlineError, Input, SegmentedControl, SelectField, Switch, Textarea } from '../ui';
import { type Activity, type ActivityConfig, type ActivitySource, type Connection, type ExecutionTarget, type Ghost, type State } from '@ghost/contract';
import { Modal } from '../components/Modal';
import { toolLabels } from './GhostSettings';
import { visibleGhosts } from './ghostState';
import { activityToolChoices, buildActivityConfig, draftFromConfig, emptyDraft, intersectTools, DEFAULT_ACTIVITY_TOOLS, externalActionsLabel, sourceKindLabel } from './activity-config';

/** Ghosts a form may target: everyone in circulation, plus the edited activity's own Ghost if it left those lists. */
export function formGhosts(state: State, activity: Activity | null): Ghost[] {
  const ghosts = visibleGhosts(state.ghosts);
  const bound = activity ? state.ghosts.find(ghost => ghost.id === activity.ghostId) : undefined;
  return bound && !ghosts.some(ghost => ghost.id === bound.id) ? [bound, ...ghosts] : ghosts;
}

/** 활동 만들기/편집. Every field lands in one contract ActivityConfig; nothing sends before the owner saves. */
export function ActivityFormDialog({ state, connections, activity, onClose, onSave }: {
  state: State;
  connections: readonly Connection[];
  activity: Activity | null;
  onClose(): void;
  onSave(config: ActivityConfig): Promise<void>;
}) {
  const ghosts = formGhosts(state, activity);
  const [draft, setDraft] = useState(() => activity ? draftFromConfig(activity) : emptyDraft(ghosts[0] ?? null));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const ghost = ghosts.find(item => item.id === draft.ghostId);
  const set = (patch: Partial<typeof draft>) => setDraft(prev => ({ ...prev, ...patch }));

  const selectGhost = (ghostId: string) => setDraft(prev => {
    const next = ghosts.find(item => item.id === ghostId);
    return {
      ...prev, ghostId,
      tools: intersectTools(DEFAULT_ACTIVITY_TOOLS, next?.tools ?? []),
      ...(prev.executionKind === 'host' && next?.hostExecution !== true ? { executionKind: 'container' as const, hostCwd: '' } : {}),
    };
  });

  const sourceConnections = connections.filter(connection => draft.sourceKind === 'mail'
    ? connection.config.kind === 'mail' : connection.config.kind === 'github' || connection.config.kind === 'gitea');
  const staleConnection = draft.connectionId !== '' && !sourceConnections.some(connection => connection.id === draft.connectionId);
  const connectionOptions = sourceConnections.map(connection => ({
    value: connection.id,
    label: `${connection.name}${connection.hasCredential ? '' : ' · 자격 없음'}`,
  }));
  const shownConnections = staleConnection
    ? [{ value: draft.connectionId, label: '삭제된 연결' }, ...connectionOptions]
    : connectionOptions;

  const save = async () => {
    if (saving) return;
    if (draft.sourceKind !== 'schedule' && !sourceConnections.some(connection => connection.id === draft.connectionId)) {
      setError('연결을 다시 선택해 주세요. 연결 계정에서 먼저 만들 수 있습니다.');
      return;
    }
    const built = buildActivityConfig(draft, ghost);
    if (!built.ok) { setError(built.error); return; }
    setSaving(true); setError('');
    try { await onSave(built.config); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '활동을 저장하지 못했습니다.'); setSaving(false); }
  };

  return <Modal title={activity ? '활동 편집' : '활동 만들기'} onClose={() => { if (!saving) onClose(); }} className="sm:max-w-[640px]">
    <form className="flex flex-col gap-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      {activity && <p className="activity-warn activity-warn--calm">저장하면 이 활동의 진행 중인 실행이 취소됩니다.</p>}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FormField label="Ghost" required>
          {control => <SelectField {...control} label="Ghost" value={draft.ghostId} disabled={saving || activity !== null || !ghosts.length}
            onValueChange={selectGhost} options={ghosts.map(item => ({ value: item.id, label: item.isDefault ? `${item.name} · 메인` : item.name }))}/>}
        </FormField>
        <FormField label="이름" required error={error.startsWith('활동 이름') ? error : undefined}>
          {control => <Input {...control} value={draft.name} maxLength={128} disabled={saving} placeholder="예: 메일 우선순위 정리"
            onChange={event => set({ name: event.target.value })}/>}
        </FormField>
      </div>
      <FormField label="활동 지시" required description="이 활동이 켜질 때마다 Ghost가 이 지시로 맡긴 일을 실행합니다.">
        {control => <Textarea {...control} value={draft.prompt} rows={4} maxLength={8192} required disabled={saving}
          placeholder="무엇을 살피고 무엇을 할지 적어 주세요." onChange={event => set({ prompt: event.target.value })}/>}
      </FormField>
      <FormField label="완료 기준" required description="실행이 제대로 끝났는지 판단하는 기준입니다.">
        {control => <Textarea {...control} value={draft.acceptanceCriteria} rows={3} maxLength={8192} required disabled={saving}
          onChange={event => set({ acceptanceCriteria: event.target.value })}/>}
      </FormField>

      <h3 className="section-title">어디를 살필까</h3>
      <SegmentedControl aria-label="활동 소스" value={draft.sourceKind}
        onValueChange={value => set({ sourceKind: value as ActivitySource['kind'], connectionId: '' })}
        options={(Object.keys(sourceKindLabel) as ActivitySource['kind'][]).map(kind => ({ value: kind, label: sourceKindLabel[kind], disabled: saving }))}/>
      {draft.sourceKind === 'schedule'
        ? <>
          <SegmentedControl aria-label="실행 방식" value={draft.scheduleMode}
            onValueChange={value => set({ scheduleMode: value as typeof draft.scheduleMode })}
            options={[{ value: 'every', label: '반복 간격', disabled: saving }, { value: 'at', label: '지정 시각', disabled: saving }]}/>
          {draft.scheduleMode === 'at'
            ? <FormField label="실행 시각" description="이 시각에 한 번 실행합니다.">
              {control => <Input {...control} type="datetime-local" value={draft.scheduleAt} disabled={saving}
                onChange={event => set({ scheduleAt: event.target.value })}/>}
            </FormField>
            : <FormField label="반복 간격 (분)" description="1분 이상. 지금부터 이 간격으로 살핍니다.">
              {control => <Input {...control} type="number" min={1} step="any" value={draft.everyMinutes} disabled={saving}
                onChange={event => set({ everyMinutes: event.target.value })}/>}
            </FormField>}
        </>
        : <>
          <FormField label="연결 계정" required error={staleConnection ? '선택한 연결이 없습니다. 다시 선택해 주세요.' : undefined}
            description={sourceConnections.length ? undefined : '연결 계정 탭에서 먼저 만들어 주세요.'}>
            {control => <SelectField {...control} label="연결 계정" value={draft.connectionId} disabled={saving}
              onValueChange={value => set({ connectionId: value })}
              options={shownConnections}/>}
          </FormField>
          {draft.sourceKind === 'pull_request'
            ? <>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="저장소" required description="owner/repo 형태.">
                  {control => <Input {...control} value={draft.repository} placeholder="garden/ghost" maxLength={256} disabled={saving}
                    onChange={event => set({ repository: event.target.value })}/>}
                </FormField>
                <FormField label="기준 브랜치" description="비워 두면 기본 브랜치를 살핍니다.">
                  {control => <Input {...control} value={draft.baseBranch} placeholder="main" maxLength={256} disabled={saving}
                    onChange={event => set({ baseBranch: event.target.value })}/>}
                </FormField>
              </div>
              <FormField label="라벨" description="쉼표로 구분. 비워 두면 라벨을 따지지 않습니다.">
                {control => <Input {...control} value={draft.labels} placeholder="bug, review" disabled={saving}
                  onChange={event => set({ labels: event.target.value })}/>}
              </FormField>
              <SwitchLine label="드래프트 PR 포함" checked={draft.includeDrafts} disabled={saving} onChange={includeDrafts => set({ includeDrafts })}/>
            </>
            : <>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="보낸 사람" description="비워 두면 모든 보낸 사람.">
                  {control => <Input {...control} type="email" value={draft.sender} maxLength={320} disabled={saving}
                    onChange={event => set({ sender: event.target.value })}/>}
                </FormField>
                <FormField label="제목에 포함" description="비워 두면 제목을 따지지 않습니다.">
                  {control => <Input {...control} value={draft.subjectContains} maxLength={256} disabled={saving}
                    onChange={event => set({ subjectContains: event.target.value })}/>}
                </FormField>
              </div>
              <SwitchLine label="안 읽은 메일만" checked={draft.unreadOnly} disabled={saving} onChange={unreadOnly => set({ unreadOnly })}/>
            </>}
          <FormField label="확인 주기 (분)" description="이 간격으로 소스를 물어봅니다. 새 항목이 있을 때만 Ghost가 실행됩니다.">
            {control => <Input {...control} type="number" min={1} max={1440} step="any" value={draft.pollMinutes} disabled={saving}
              onChange={event => set({ pollMinutes: event.target.value })}/>}
          </FormField>
          <SwitchLine label="처음 기존 항목도 실행" checked={draft.includeExisting} disabled={saving} onChange={includeExisting => set({ includeExisting })}
            description="끄면 지금 있는 항목은 기준으로 건너뛰고 새 항목부터 실행합니다."/>
        </>}

      <h3 className="section-title">어디서 실행할까</h3>
      <FormField label="실행 환경" description={ghost && ghost.hostExecution !== true
        ? '이 Ghost는 PC 직접 실행이 허용되지 않았습니다. Ghost 설정의 운영에서 허용할 수 있습니다.' : undefined}>
        {control => <SegmentedControl {...control} aria-label="실행 환경" value={draft.executionKind}
          onValueChange={value => set({ executionKind: value as ExecutionTarget['kind'] })}
          options={[
            { value: 'container', label: '컨테이너', disabled: saving },
            { value: 'host', label: '이 Mac', disabled: saving || ghost?.hostExecution !== true },
          ]}/>}
      </FormField>
      {draft.executionKind === 'host'
        ? <>
          <FormField label="작업 폴더" required description="이 폴더 안에서 파일과 명령을 곧바로 실행합니다.">
            {control => <Input {...control} value={draft.hostCwd} placeholder="/Users/garden/Workspace" maxLength={4096} disabled={saving}
              onChange={event => set({ hostCwd: event.target.value })}/>}
          </FormField>
          <p className="activity-warn">이 Mac 실행은 샌드박스 없이 셸을 씁니다. PC 전체와 네트워크에 영향을 줄 수 있고 아래 PR 댓글·메일 회신 승인 설정으로 제한되지 않습니다.</p>
        </>
        : <p className="activity-warn activity-warn--calm">활동은 Ghost의 컨테이너 안에서 실행됩니다.</p>}

      <h3 className="section-title">쓸 수 있는 도구</h3>
      <div className="skills" role="group" aria-label="활동 도구">
        {activityToolChoices(ghost?.tools ?? []).map(tool => <button key={tool} type="button" className="skill activity-tool" aria-pressed={draft.tools.includes(tool)}
          disabled={saving} title={tool}
          onClick={() => set({ tools: draft.tools.includes(tool) ? draft.tools.filter(name => name !== tool) : [...draft.tools, tool] })}
        >{toolLabels[tool]}</button>)}
      </div>
      <p className="activity-warn activity-warn--calm">Ghost가 가진 도구만 줄 수 있습니다. 시험 실행에서는 쓰기·실행 도구를 빼고 읽기만 살핍니다.</p>

      <h3 className="section-title">한도와 권한</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="하루 최대 실행">
          {control => <Input {...control} type="number" min={1} max={1000} step={1} value={draft.maxRunsPerDay} disabled={saving}
            onChange={event => set({ maxRunsPerDay: event.target.value })}/>}
        </FormField>
        <FormField label="동시 실행">
          {control => <Input {...control} type="number" min={1} max={8} step={1} value={draft.maxConcurrent} disabled={saving}
            onChange={event => set({ maxConcurrent: event.target.value })}/>}
        </FormField>
        <FormField label="실행 제한 (분)">
          {control => <Input {...control} type="number" min={0.5} max={1440} step="any" value={draft.runTimeoutMinutes} disabled={saving}
            onChange={event => set({ runTimeoutMinutes: event.target.value })}/>}
        </FormField>
      </div>
      <FormField label="PR 댓글·메일 회신">
        {() => <SegmentedControl aria-label="PR 댓글·메일 회신" value={draft.externalActions}
          onValueChange={value => set({ externalActions: value as typeof draft.externalActions })}
          options={(Object.keys(externalActionsLabel) as (keyof typeof externalActionsLabel)[])
            .map(value => ({ value, label: externalActionsLabel[value], disabled: saving }))}/>}
      </FormField>
      <p className="activity-warn activity-warn--calm">이 활동에서 받은 메일의 회신·PR 댓글만 여기서 제어합니다. 브라우저 도구는 별도의 브라우저·금고 승인 규칙을 따르며, 이 설정으로 제한되지 않습니다. Mac 도구도 별도 권한과 자체 승인 규칙을 따릅니다. 샌드박스·PC 파일과 셸 도구에도 적용되지 않습니다.</p>
      <FormField label="결과 전달">
        {() => <SegmentedControl aria-label="결과 전달" value={draft.delivery}
          onValueChange={value => set({ delivery: value as typeof draft.delivery })}
          options={[{ value: 'changes', label: '바뀔 때만', disabled: saving }, { value: 'always', label: '항상', disabled: saving }]}/>}
      </FormField>
      <SwitchLine label="자기 점검 허용" checked={draft.allowSelfCheck} disabled={saving} onChange={allowSelfCheck => set({ allowSelfCheck })}
        description="Ghost가 실행을 마치고 스스로 다음 확인 시각을 정할 수 있습니다."/>
      {draft.allowSelfCheck && <FormField label="자기 점검 최소 간격 (분)">
        {control => <Input {...control} type="number" min={1} max={1440} step="any" value={draft.minCheckMinutes} disabled={saving}
          onChange={event => set({ minCheckMinutes: event.target.value })}/>}
      </FormField>}

      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={saving} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={saving}>{saving ? '저장하는 중…' : activity ? '저장' : '활동 만들기'}</Button>
      </div>
    </form>
  </Modal>;
}

/** One labelled switch line inside the dialog. */
export function SwitchLine({ label, description, checked, disabled, onChange }: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return <div className="activity-check">
    <span className="activity-check__copy">
      <span>{label}</span>
      {description && <small>{description}</small>}
    </span>
    <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label}/>
  </div>;
}
