import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { FolderOpen, Play } from 'lucide-react';
import type { CodingAgentId, CodingAgentsView, CodingSessionDetail, CodingSessionStart, CodingSessionView, Scope } from '@ghost/contract';
import { Button, FormField, InlineError, Input, Popover, PopoverContent, PopoverTrigger, SelectField, Switch, Textarea } from '../ui';
import { useHost } from '../host/context';

export function submitCodingOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

/** Read the same named fields used by native form submission and by the keyboard shortcut. */
export function codingStartInput(data: FormData, agent: CodingAgentId): CodingSessionStart {
  const field = (name: string) => String(data.get(name) ?? '').trim();
  const resume = field('resume');
  const input: CodingSessionStart = { agent, repo: field('repo'), task: field('task') };
  if (resume) return { ...input, resume };
  const worktree = data.has('worktree');
  const branch = worktree ? field('branch') : '';
  return { ...input, worktree, ...(branch ? { branch } : {}) };
}

function RepositoryField({ scopes, sessions, repo, onChange, resume }: {
  scopes: Scope[]; sessions: CodingSessionView[]; repo: string; onChange(path: string): void; resume: boolean;
}) {
  const [open, setOpen] = useState(false);
  const paths = new Map<string, string | null>();
  for (const scope of scopes) for (const path of scope.paths) if (path.startsWith('/') && !paths.has(path)) paths.set(path, scope.name);
  for (const { cwd } of sessions) if (cwd.startsWith('/') && !paths.has(cwd)) paths.set(cwd, null);
  return <FormField label={resume ? '작업 디렉터리' : '저장소'} required>{props => <div className="coding-repo">
    <Input {...props} name="repo" value={repo} onChange={event => onChange(event.currentTarget.value)}
      placeholder="/Users/…" maxLength={4096} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
    {paths.size > 0 && <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="outline" size="icon" type="button" aria-label="저장소 선택" title="저장소 선택"><FolderOpen aria-hidden="true"/></Button></PopoverTrigger>
      <PopoverContent className="coding-repo-picker" align="end" aria-label="저장소 선택">
        {[...paths].map(([path, name]) => <button className="coding-repo-option" type="button" key={path} onClick={() => { onChange(path); setOpen(false); }}>
          {name && <strong>{name}</strong>}<code>{path}</code>
        </button>)}
      </PopoverContent>
    </Popover>}
  </div>}</FormField>;
}

export function NewCodingSession({ scopes, sessions, onStarted, onCancel }: {
  scopes: Scope[]; sessions: CodingSessionView[]; onStarted(detail: CodingSessionDetail): void; onCancel(): void;
}) {
  const { client } = useHost();
  const [agents, setAgents] = useState<CodingAgentsView | null>(null);
  const [agentError, setAgentError] = useState('');
  const [agent, setAgent] = useState<CodingAgentId | ''>('');
  const [repo, setRepo] = useState('');
  const [resume, setResume] = useState('');
  const [branch, setBranch] = useState('');
  const [worktree, setWorktree] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const worktreeId = useId();
  const titleId = useId();
  useEffect(() => {
    let live = true;
    void client.codingAgents().then(view => { if (live) setAgents(view); }, reason => {
      if (live) setAgentError(reason instanceof Error ? reason.message : '코딩 에이전트를 불러오지 못했습니다.');
    });
    return () => { live = false; };
  }, [client]);
  const ready = agents?.agents.filter(item => item.ready && !agents.disabled.includes(item.id)) ?? [];
  const selected = ready.find(item => item.id === (agent || agents?.default))?.id ?? ready[0]?.id;
  const resuming = resume.trim() !== '';

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current || !selected) return;
    const input = codingStartInput(new FormData(event.currentTarget), selected);
    if (!input.repo.startsWith('/')) { setError('경로는 /로 시작하는 절대 경로를 입력하세요.'); return; }
    if (!input.task) { setError('첫 지시를 입력하세요.'); return; }
    setError('');
    pendingRef.current = true;
    setPending(true);
    try { onStarted(await client.startCodingSession(input)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '세션을 시작하지 못했습니다.'); }
    finally { pendingRef.current = false; setPending(false); }
  };

  return <section className="coding-new" aria-labelledby={titleId}>
    <form className="coding-new-form" onSubmit={event => void start(event)}>
      <h2 id={titleId}>새 코딩 세션</h2>
      <fieldset disabled={pending}>
        <FormField label="코딩 에이전트">{({ id }) => <SelectField id={id} label="코딩 에이전트" className="w-full"
          value={selected ?? 'status'} onValueChange={value => setAgent(value as CodingAgentId)} disabled={!selected || pending}
          options={selected ? ready.map(item => ({ value: item.id, label: item.name })) : [{
            value: 'status', label: agents ? '쓸 수 있는 에이전트 없음' : agentError ? '불러오지 못함' : '불러오는 중…',
          }]}/>}</FormField>
        {agentError && <InlineError>{agentError}</InlineError>}
        <RepositoryField scopes={scopes} sessions={sessions} repo={repo} onChange={setRepo} resume={resuming}/>
        <FormField label="첫 지시" required>{props => <Textarea {...props} name="task" rows={4} maxLength={24_000}
          className="field-sizing-fixed min-h-28 resize-y" aria-keyshortcuts="Meta+Enter Control+Enter" onKeyDown={submitCodingOnShortcut}/>}</FormField>
        {!resuming && <>
          <div className="coding-worktree"><label htmlFor={worktreeId}>새 워크트리에서 작업</label>
            <Switch id={worktreeId} name="worktree" checked={worktree} onCheckedChange={setWorktree}/>
          </div>
          {worktree && <FormField label="브랜치 이름 (선택)">{props => <Input {...props} name="branch" value={branch} onChange={event => setBranch(event.currentTarget.value)} maxLength={80} autoCapitalize="none" spellCheck={false}/>}</FormField>}
        </>}
        <FormField label="기존 에이전트 세션 ID (선택)">{props => <Input {...props} name="resume" value={resume} onChange={event => setResume(event.currentTarget.value)} maxLength={128} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>}</FormField>
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="coding-new-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>취소</Button>
        <Button type="submit" disabled={!selected || pending}><Play aria-hidden="true"/>{pending ? '시작 중…' : '세션 시작'}</Button>
      </div>
    </form>
  </section>;
}
