import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TerminalAgent, WorkbenchTerminalSpec } from '@ghost/contract';
import { FolderField } from '../components/FolderPicker';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { Button, FormField, InlineError, Input, SelectField, Textarea } from '../ui';
import { codingError } from './CodingSessionModel';
import { OmpAgentOptions, useOmpLaunch } from './OmpAgentOptions';
import { buildAgentTerminalSpec, type TerminalConversation } from './workbenchAgent';

const agentNames: Record<TerminalAgent, string> = { omp: 'omp', claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };

const conversations: { value: TerminalConversation; label: string }[] = [
  { value: 'new', label: '새 대화' },
  { value: 'continue', label: '최근 대화 이어서' },
  { value: 'resume', label: 'CLI에서 이전 대화 선택' },
];

export function WorkbenchAgentStart({ root, onSave, onClose }: {
  root: string | null; onSave(spec: WorkbenchTerminalSpec): Promise<unknown>; onClose(): void;
}) {
  const { client } = useHost();
  const [directory, setDirectory] = useState(root ?? '');
  const [installed, setInstalled] = useState<TerminalAgent[] | null>(null);
  const [agent, setAgent] = useState<TerminalAgent>();
  const [lookupError, setLookupError] = useState('');
  const [revision, retry] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const kind = installed?.find(item => item === agent) ?? installed?.[0];
  const launch = useOmpLaunch(kind === 'omp', directory);
  const [conversation, setConversation] = useState<TerminalConversation>('new');
  const [model, setModel] = useState('');
  const [task, setTask] = useState('');

  useEffect(() => {
    const request = new AbortController();
    void client.terminalAgents(request.signal).then(agents => {
      if (!request.signal.aborted) setInstalled(agents);
    }).catch(reason => {
      if (!request.signal.aborted) setLookupError(codingError(reason, '설치된 에이전트를 확인하지 못했습니다.'));
    });
    return () => request.abort();
  }, [client, revision]);

  const canStart = Boolean(directory && kind);
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind || !directory || submitting.current) return;
    const args = kind === 'omp' ? launch.prepare() : [];
    if (!args) return;
    const spec = buildAgentTerminalSpec(directory, kind === 'omp' ? { kind, args }
      : kind === 'pi' ? { kind, task } : { kind, conversation, model });
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      await onSave(spec);
      if (kind === 'omp') launch.remember();
      onClose();
    } catch (reason) {
      setError(codingError(reason, '에이전트 패널을 만들지 못했습니다.'));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <Modal title="에이전트 실행" onClose={() => { if (!submitting.current) onClose(); }} className="sm:max-w-[420px]">
    {lookupError ? <InlineError onRetry={() => { setLookupError(''); retry(value => value + 1); }} retryLabel="다시 확인">{lookupError}</InlineError>
      : !installed ? <p className="agent-launch-hint" role="status">설치된 에이전트 확인 중…</p>
      : !installed.length ? <p className="agent-launch-hint">Mac에 설치된 에이전트가 없습니다.</p>
      : <form className="grid gap-3" aria-busy={pending || undefined} onSubmit={start}>
        <FormField label="에이전트">{({ id }) => <SelectField id={id} label="에이전트" className="w-full" value={kind ?? ''}
          disabled={pending} options={installed.map(value => ({ value, label: agentNames[value] }))} onValueChange={value => {
            setAgent(installed.find(item => item === value));
            setConversation('new'); setModel('');
          }}/>}</FormField>
        <FolderField label="작업 폴더" value={directory} disabled={pending} onChange={setDirectory}/>
        {kind === 'omp' && <fieldset disabled={pending}><OmpAgentOptions launch={launch}/></fieldset>}
        {(kind === 'claude' || kind === 'codex') && <>
          <FormField label="대화">{({ id }) => <SelectField id={id} label="대화" className="w-full" value={conversation}
            disabled={pending} options={conversations} onValueChange={value => {
              const selected = conversations.find(item => item.value === value);
              if (selected) setConversation(selected.value);
            }}/>}</FormField>
          <FormField label="모델">{props => <Input {...props} value={model} disabled={pending} maxLength={200}
            spellCheck={false} placeholder="기본값" onChange={event => setModel(event.currentTarget.value)}/>}</FormField>
        </>}
        {kind === 'pi' && <FormField label="첫 지시 (선택)">{props => <Textarea {...props} value={task} disabled={pending}
          rows={3} maxLength={4096} onChange={event => setTask(event.currentTarget.value)}/>}</FormField>}
        {error && <InlineError>{error}</InlineError>}
        <Button className="justify-self-end" disabled={!canStart || pending} type="submit">{pending ? '여는 중…' : '실행'}</Button>
      </form>}
  </Modal>;
}

