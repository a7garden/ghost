import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import type { OmpInfo } from '@ghost/contract';
import { useHost } from '../host/context';
import { Button, FormField, InlineError, Input, Popover, PopoverContent, PopoverTrigger, SelectField } from '../ui';
import { approvals, buildOmpArgs, conversationForDirectory, readOmpOptions, rememberOmpOptions } from './ompAgentArgs';

export function useOmpLaunch(active: boolean, directory: string): OmpLaunch {
  const { client } = useHost();
  const [omp, setOmp] = useState(readOmpOptions);
  const [expanded, setExpanded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationNeeded, setConfirmationNeeded] = useState(false);
  const [lookup, setLookup] = useState<{ directory: string; data?: OmpInfo; error?: string }>();
  const [revision, setRevision] = useState(0);
  const cwd = directory.trim().replace(/\/+$/, '') || (directory.startsWith('/') ? '/' : '');
  const conversation = conversationForDirectory(omp, cwd);
  const needsInfo = Boolean(omp.model || conversation === 'pick');
  const fetchInfo = active && (expanded || needsInfo);
  const queryCwd = cwd.startsWith('/') ? cwd : '/';
  useEffect(() => {
    if (!fetchInfo) return;
    const request = new AbortController();
    const load = setTimeout(async () => {
      try {
        const data = await client.ompInfo(queryCwd, request.signal);
        if (!request.signal.aborted) setLookup({ directory: queryCwd, data });
      } catch (error) {
        if (!request.signal.aborted) setLookup({ directory: queryCwd, error: error instanceof Error ? error.message : 'omp 옵션을 불러오지 못했습니다.' });
      }
    }, 250);
    return () => { clearTimeout(load); request.abort(); };
  }, [client, queryCwd, fetchInfo, revision]);
  const current = lookup?.directory === queryCwd ? lookup : undefined;
  const info = current?.data ?? null;
  const levels = info?.models.find(model => model.selector === omp.model)?.thinking ?? [];
  const unavailable = (omp.model && info && !info.models.some(model => model.selector === omp.model))
    || (conversation === 'pick' && info && !info.sessions.some(session => session.id === omp.session));
  const isLoading = fetchInfo && !current;
  const yolo = omp.approval === 'yolo';

  function prepare() {
    if (needsInfo && !info || unavailable || yolo && !confirmed) {
      setExpanded(true);
      if (yolo && !confirmed) setConfirmationNeeded(true);
      return null;
    }
    return buildOmpArgs(omp, cwd, info, confirmed);
  }
  function remember() {
    rememberOmpOptions({ ...omp, conversation, session: conversation === 'pick' ? omp.session : '', directory: cwd });
  }

  const fields = <>
    <label className="agent-check"><input type="checkbox" checked={conversation === 'continue'}
      onChange={event => setOmp({ ...omp, conversation: event.currentTarget.checked ? 'continue' : 'new', session: '', directory: cwd })}/>이어서 하기</label>
      <FormField label="대화 고르기">{({ id }) => <SelectField id={id} label="대화 고르기" className="w-full"
        value={conversation === 'pick' ? `session:${omp.session}` : 'none'}
        options={[{ value: 'none', label: '선택 안 함' }, ...(conversation === 'pick' && !info?.sessions.some(session => session.id === omp.session)
          ? [{ value: `session:${omp.session}`, label: '이전 선택을 사용할 수 없음', disabled: true }] : []),
        ...(cwd.startsWith('/') ? info?.sessions.map(session => ({ value: `session:${session.id}`, label: session.title || session.id })) ?? [] : [])]}
        onValueChange={value => setOmp({ ...omp, directory: cwd, conversation: value === 'none' ? 'new' : 'pick', session: value === 'none' ? '' : value.slice(8) })}/>}</FormField>
      <OmpModelPicker models={info?.models ?? []} value={omp.model} loading={isLoading}
        onChange={model => setOmp({ ...omp, model, thinking: '' })}/>
      {levels.length > 0 && <FormField label="생각 수준">{({ id }) => <SelectField id={id} label="생각 수준" className="w-full"
        value={levels.includes(omp.thinking) ? omp.thinking : 'default'}
        options={[{ value: 'default', label: '기본값' }, ...levels.map(level => ({ value: level, label: level }))]}
        onValueChange={thinking => setOmp({ ...omp, thinking: thinking === 'default' ? '' : thinking })}/>}</FormField>}
      <FormField label="승인 방식">{({ id }) => <SelectField id={id} label="승인 방식" className="w-full" value={omp.approval || 'default'}
        options={[{ value: 'default', label: 'omp 기본값' }, { value: 'always-ask', label: '항상 묻기' }, { value: 'write', label: '쓰기 허용' }, { value: 'yolo', label: '승인 없이 실행 (위험)' }]}
        onValueChange={value => {
          setOmp({ ...omp, approval: approvals.find(item => item === value) ?? '' });
          setConfirmed(false);
          setConfirmationNeeded(value === 'yolo');
        }}/>}</FormField>
      {yolo && (confirmed ? <span role="status">이번 실행에 한해 승인 없이 실행</span> : <Button type="button" variant="outline"
        className="agent-yolo-confirm" autoFocus={confirmationNeeded} onClick={() => { setConfirmed(true); setConfirmationNeeded(false); }}>이번 실행은 승인 없이 진행</Button>)}
      {isLoading && <p role="status" className="agent-launch-hint">omp 옵션을 불러오는 중…</p>}
      {current?.error && <InlineError onRetry={() => { setLookup(undefined); setRevision(value => value + 1); }} retryLabel="다시 불러오기">{current.error}</InlineError>}
      {unavailable && <InlineError>이전 대화나 모델을 사용할 수 없습니다. 다시 선택하세요.</InlineError>}
  </>;
  const risk = omp.approval === 'yolo' ? [{ label: '승인 없이 실행', danger: true } satisfies AgentRisk]
    : omp.approval === 'write' ? [{ label: '쓰기 허용' } satisfies AgentRisk] : [];
  return { expanded, setExpanded, fields, risk, prepare, remember };
}

type AgentRisk = { label: string; danger?: boolean };
type OmpLaunch = {
  expanded: boolean; setExpanded(open: boolean): void; fields: ReactNode; risk: AgentRisk[];
  prepare(): string[] | null; remember(): void;
};

export function OmpAgentOptions({ launch }: { launch: OmpLaunch }) {
  return <details className="agent-options" open={launch.expanded} onToggle={event => launch.setExpanded(event.currentTarget.open)}>
    <summary>옵션{launch.risk.map(item =>
      <span key={item.label} className={item.danger ? 'text-danger-ink' : undefined}> · {item.label}</span>)}</summary>
    {launch.expanded && <div className="agent-option-fields">{launch.fields}</div>}
  </details>;
}

function OmpModelPicker({ models, value, loading, onChange }: {
  models: OmpInfo['models']; value: string; loading: boolean; onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const id = useId();
  const selected = models.find(model => model.selector === value);
  const needle = search.toLowerCase().trim();
  const visible = models.filter(model => `${model.name} ${model.provider} ${model.selector}`.toLowerCase().includes(needle));
  return <FormField label="모델">{({ id: fieldId }) => <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setSearch(''); }}>
    <PopoverTrigger asChild><Button type="button" id={fieldId} variant="outline" className="agent-model-trigger w-full justify-between" aria-label="모델">
      <span>{selected?.name ?? (value || '기본 모델')}</span><ChevronsUpDown aria-hidden="true"/>
    </Button></PopoverTrigger>
    <PopoverContent className="agent-models" aria-label="모델 선택">
      <Input value={search} onChange={event => setSearch(event.currentTarget.value)} aria-label="모델 검색" placeholder="모델 검색" aria-controls={id}/>
      <div id={id} className="agent-model-list" role="group" aria-label="모델 목록">
        {!needle && <Button type="button" variant="ghost" className="justify-start" aria-pressed={!value} onClick={() => { onChange(''); setOpen(false); }}>기본 모델</Button>}
        {visible.map(model => <Button key={model.selector} type="button" variant="ghost" className="justify-between" aria-pressed={value === model.selector}
          onClick={() => { onChange(model.selector); setOpen(false); }}><span>{model.name}</span><small>{model.provider}</small></Button>)}
        {!visible.length && !loading && <p className="agent-launch-hint">{needle ? '일치하는 모델이 없습니다.' : '사용할 수 있는 모델이 없습니다.'}</p>}
      </div>
    </PopoverContent>
  </Popover>}</FormField>;
}
