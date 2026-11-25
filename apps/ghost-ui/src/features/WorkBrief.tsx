import { useId, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Folder } from 'lucide-react';
import type { DocRef, ExecutionTarget, Ghost } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { useProjectMentions } from '../components/composer/ProjectMentions';
import { useHost } from '../host/context';
import { Button, InlineError, Input } from '../ui';
import { DocAttachments } from './DocAttachments';
import { WorkModelFields } from './WorkModelFields';
import { executionLabel } from './activity-config';
import { fromLocalInput } from './Schedules';
import { toneFor } from './ghostState';
import './work-brief.css';

export function WorkCriteriaField({ form, initial = '', busy }: { form?: string; initial?: string; busy: boolean }) {
  return <label className="work-brief-criteria">
    <span>완료 기준</span>
    <textarea form={form} className="work-brief-field" name="criteria" rows={1} maxLength={8192} defaultValue={initial} readOnly={busy}/>
  </label>;
}

export function WorkDeadlineField({ form, initial = '', busy }: { form?: string; initial?: string; busy: boolean }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  return <div className="work-brief-deadline">
    <label><span>기한</span><input ref={input} form={form} className="work-brief-field" name="deadline" type="datetime-local" value={value} disabled={busy}
      onChange={event => setValue(event.target.value)}/></label>
    {value && <Button type="button" form={form} variant="ghost" size="sm" aria-label="기한 지우기" disabled={busy}
      onClick={() => { setValue(''); input.current?.focus(); }}>지우기</Button>}
  </div>;
}

export function workWriteError(reason: unknown, fallback: string): string {
  return reason instanceof Error && /[가-힣]/.test(reason.message) ? `${fallback} ${reason.message}` : fallback;
}

/** A dispatch at the head of its own list: address, instruction, then what counts as done. */
export function WorkDispatch({ ghosts, defaultGhostId, hasProjects, initialScopeId, onClose, onCreated }: {
  ghosts: Ghost[]; defaultGhostId: string; hasProjects: boolean; initialScopeId?: string; onClose(): void; onCreated(workId: string): void;
}) {
  const { client } = useHost();
  const [ghostId, setGhostId] = useState(defaultGhostId);
  const [brief, setBrief] = useState('');
  const [execution, setExecution] = useState<ExecutionTarget['kind']>('workspace');
  const [cwd, setCwd] = useState('');
  const [slot, setSlot] = useState(''), [retrySlot, setRetrySlot] = useState('');
  const [attachments, setAttachments] = useState<DocRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const hostWarningId = useId();
  const projects = useProjectMentions(brief, setBrief, briefRef, initialScopeId ? [initialScopeId] : [], busy);
  const selected = ghosts.find(ghost => ghost.id === ghostId);
  const hostAllowed = selected?.hostExecution === true;
  const pickGhost = (id: string) => {
    setGhostId(id);
    if (execution === 'host' && ghosts.find(ghost => ghost.id === id)?.hostExecution !== true) {
      setExecution('workspace'); setCwd('');
    }
  };
  const linkProject = () => {
    const field = briefRef.current;
    if (!field) return;
    field.focus();
    if (!projects.open) {
      const end = field.value.length;
      field.setRangeText(end && !/\s$/.test(field.value) ? ' #' : '#', end, end, 'end');
      projects.onChange(field.value);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const title = text('title'), instruction = text('brief'), criteria = text('criteria'), deadline = text('deadline');
    if (!title || !instruction) {
      setError(!title ? '제목을 적어 주세요.' : '할 일을 적어 주세요.');
      (form.elements.namedItem(title ? 'brief' : 'title') as HTMLElement | null)?.focus();
      return;
    }
    const deadlineAt = fromLocalInput(deadline);
    if (deadline && deadlineAt === null) { setError('기한을 확인해 주세요.'); return; }
    let target: ExecutionTarget = { kind: execution === 'container' ? 'container' : 'workspace' };
    if (execution === 'host') {
      const path = cwd.trim();
      if (!hostAllowed) { setError('이 Ghost는 PC 직접 실행이 허용되지 않았습니다.'); return; }
      if (!path.startsWith('/')) { setError('작업 폴더는 /로 시작하는 전체 경로여야 합니다.'); return; }
      if (path.length > 4096) { setError('작업 폴더 경로는 4,096자 이하여야 합니다.'); return; }
      target = { kind: 'host', cwd: path };
    }
    setBusy(true); setError('');
    try {
      const created = await client.send<{ workId: string }>({
        type: 'work.create', ghostId: selected.id, title, brief: instruction, scopeId: projects.scopeIds[0] ?? null,
        slot: slot || null, retry: retrySlot ? { slot: retrySlot } : null, attachments,
        ...(criteria ? { acceptance: { criteria, checks: [], reviewer: null } } : {}),
        ...(deadlineAt !== null ? { deadlineAt } : {}),
        execution: target,
      });
      if (form.isConnected) onCreated(created.workId);
    } catch (reason) {
      setError(workWriteError(reason, '맡긴 일을 만들지 못했습니다.'));
      setBusy(false);
    }
  };
  return <form className="work-dispatch" aria-label="일 맡기기" aria-busy={busy || undefined} onSubmit={submit}
    onInvalid={event => { const fold = (event.target as HTMLElement).closest('details'); if (fold) fold.open = true; }}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || busy) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Enter') return;
      if (event.metaKey || event.ctrlKey) { event.preventDefault(); event.currentTarget.requestSubmit(); return; }
      if (event.shiftKey) return;
      const name = (event.target as HTMLInputElement).name;
      const next = name === 'title' ? 'brief' : name === 'brief' ? 'criteria' : name === 'criteria' ? 'deadline' : null;
      if (next) { event.preventDefault(); (event.currentTarget.elements.namedItem(next) as HTMLElement | null)?.focus(); }
    }}>
    <fieldset className="work-dispatch__draft" disabled={busy} aria-label="맡길 일">
      <label className="work-dispatch__address">
        <span className="work-dispatch__recipient">
          {selected && <DotAvatar profileId={selected.id} tone={toneFor(selected.id)} size={20}/>}
          <select aria-label="맡길 Ghost" autoFocus required value={selected?.id ?? ''} onChange={event => pickGhost(event.target.value)}>
            {!selected && <option value="" disabled>Ghost 선택</option>}
            {ghosts.map(ghost => <option key={ghost.id} value={ghost.id}>{ghost.isDefault ? `${ghost.name} · 메인` : ghost.name}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true"/>
        </span><span aria-hidden="true">에게</span>
      </label>
      <input className="work-brief-field work-brief-field--title" aria-label="제목" name="title" placeholder="맡길 일 제목" required maxLength={256} enterKeyHint="next"/>
      <div className="work-dispatch__instruction">
        {projects.above}
        <textarea {...projects.inputAria} className="work-brief-field work-brief-field--body" ref={briefRef} aria-label="할 일" name="brief" value={brief}
          onChange={event => projects.onChange(event.target.value)} onSelect={projects.onSelect} onKeyDown={projects.onKeyDown}
          placeholder="할 일을 적어 주세요" required maxLength={32768} rows={3} enterKeyHint="next"/>
      </div>
      <WorkCriteriaField busy={busy}/>
      <div className="work-dispatch__routing">
        <WorkDeadlineField busy={busy}/>
        {projects.scopeIds.length > 0 ? projects.chips : hasProjects && <Button type="button" variant="ghost" size="sm" onClick={linkProject}><Folder/>프로젝트 연결</Button>}
      </div>
      <div className="work-dispatch__extras">
        <details>
          <summary>문서 붙임{attachments.length > 0 && <span className="tabular">{attachments.length}</span>}</summary>
          <DocAttachments value={attachments} onChange={setAttachments} scopeId={projects.scopeIds[0]}/>
        </details>
        <details>
          <summary>실행 옵션{execution !== 'workspace' && <span>{executionLabel[execution]}</span>}</summary>
          <div className="work-dispatch__options">
            <WorkModelFields slot={slot} retrySlot={retrySlot} onSlot={setSlot} onRetry={setRetrySlot}/>
            <label className="work-dispatch__environment"><span>실행 환경</span>
              <select className="work-brief-field" value={execution} onChange={event => setExecution(event.target.value as ExecutionTarget['kind'])}>
                <option value="workspace">{executionLabel.workspace}</option>
                <option value="container">{executionLabel.container}</option>
                <option value="host" disabled={!hostAllowed}>{executionLabel.host}</option>
              </select>
            </label>
            {selected && !hostAllowed && <p className="work-dispatch__hint">이 Ghost의 PC 직접 실행은 Ghost 설정의 운영에서 허용할 수 있습니다.</p>}
            {execution === 'host' && <label className="work-dispatch__folder"><span>작업 폴더</span>
              <Input name="cwd" value={cwd} onChange={event => setCwd(event.target.value)} aria-describedby={hostWarningId}
                required maxLength={4096} placeholder="/Users/garden/Workspace"/>
            </label>}
          </div>
        </details>
      </div>
    </fieldset>
    {execution === 'host' && <p className="activity-warn" id={hostWarningId}>이 Mac 실행은 샌드박스 없이 셸을 씁니다. PC 전체와 네트워크에 영향을 줄 수 있습니다.</p>}
    {!ghosts.length && <p className="work-dispatch__hint">일을 맡길 수 있는 Ghost가 없습니다.</p>}
    {error && <InlineError>{error}</InlineError>}
    <div className="work-brief-actions">
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
      <Button type="submit" disabled={busy || !selected}>{busy ? '맡기는 중…' : '일 맡기기'}</Button>
    </div>
  </form>;
}
