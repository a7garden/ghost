import { useId, useRef, useState, type FormEvent } from 'react';
import { FolderOpen, Play } from 'lucide-react';
import type { CodingAgentId, CodingSetup, CodingStart, HerdrPaneView, Scope } from '@ghost/contract';
import { Button, FormField, InlineError, Input, Popover, PopoverContent, PopoverTrigger, SelectField, Switch, Textarea } from '../ui';
import { useHost } from '../host/context';
import { submitCodingOnShortcut } from './herdrDisplay';

export function codingStartInput(data: FormData, agent: CodingAgentId): CodingStart {
  const field = (name: string) => String(data.get(name) ?? '').trim();
  const worktree = data.has('worktree');
  const branch = worktree ? field('branch') : '';
  return { agent, repo: field('repo'), task: field('task'), worktree, ...(branch ? { branch } : {}) };
}

function RepositoryField({ scopes, repo, onChange }: { scopes: Scope[]; repo: string; onChange(path: string): void }) {
  const [open, setOpen] = useState(false);
  const paths = new Map<string, string>();
  for (const scope of scopes) for (const path of scope.paths) if (path.startsWith('/') && !paths.has(path)) paths.set(path, scope.name);
  return <FormField label="저장소" required>{props => <div className="coding-repo">
    <Input {...props} name="repo" value={repo} onChange={event => onChange(event.currentTarget.value)}
      placeholder="/Users/…" maxLength={4096} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
    {paths.size > 0 && <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="outline" size="icon" type="button" aria-label="저장소 선택" title="저장소 선택"><FolderOpen aria-hidden="true"/></Button></PopoverTrigger>
      <PopoverContent className="coding-repo-picker" align="end" aria-label="저장소 선택">
        {[...paths].map(([path, name]) => <button className="coding-repo-option" type="button" key={path} onClick={() => { onChange(path); setOpen(false); }}>
          <strong>{name}</strong><code>{path}</code>
        </button>)}
      </PopoverContent>
    </Popover>}
  </div>}</FormField>;
}

export function NewHerdrWorkspace({ scopes, setup, onStarted, onCancel }: {
  scopes: Scope[]; setup: CodingSetup | null; onStarted(pane: HerdrPaneView): void; onCancel(): void;
}) {
  const { client } = useHost();
  const [agent, setAgent] = useState<CodingAgentId>();
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [worktree, setWorktree] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const worktreeId = useId();
  const titleId = useId();
  const installed = setup?.agents.filter(item => item.path !== null) ?? [];
  const selected = installed.find(item => item.id === (agent ?? setup?.prefs.agent))?.id ?? installed[0]?.id;
  const canStart = Boolean(selected && setup?.herdr.path && setup.config.ok && setup.server?.compatible);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !selected || !canStart) return;
    const input = codingStartInput(new FormData(event.currentTarget), selected);
    if (!input.repo.startsWith('/')) { setError('경로는 /로 시작하는 절대 경로를 입력하세요.'); return; }
    if (!input.task) { setError('첫 지시를 입력하세요.'); return; }
    setError('');
    pendingRef.current = true;
    setPending(true);
    try { onStarted(await client.startHerdr(input)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '세션을 시작하지 못했습니다.'); }
    finally { pendingRef.current = false; setPending(false); }
  }

  return <section className="coding-new" aria-labelledby={titleId}>
    <form className="coding-new-form" onSubmit={event => void start(event)} aria-busy={pending || undefined}>
      <h2 id={titleId}>새 코딩 세션</h2>
      <fieldset disabled={pending}>
        <FormField label="코딩 에이전트">{({ id }) => <SelectField id={id} label="코딩 에이전트" className="w-full"
          value={selected ?? 'status'} onValueChange={value => setAgent(installed.find(item => item.id === value)?.id)} disabled={!selected || pending}
          options={selected ? installed.map(item => ({ value: item.id, label: item.name })) : [{
            value: 'status', label: setup ? '설치된 에이전트 없음' : '확인 중…',
          }]}/>}</FormField>
        {setup && !selected && <a className="link-quiet" href="#/settings?tab=coding">에이전트 설치 확인</a>}
        <RepositoryField scopes={scopes} repo={repo} onChange={setRepo}/>
        <FormField label="첫 지시" required>{props => <Textarea {...props} name="task" rows={4} maxLength={24_000}
          className="field-sizing-fixed min-h-28 resize-y" aria-keyshortcuts="Meta+Enter Control+Enter" onKeyDown={submitCodingOnShortcut}/>}</FormField>
        <div className="coding-worktree"><label htmlFor={worktreeId}>새 워크트리에서 작업</label>
          <Switch id={worktreeId} name="worktree" checked={worktree} onCheckedChange={setWorktree}/>
        </div>
        {worktree && <FormField label="브랜치 이름 (선택)">{props => <Input {...props} name="branch" value={branch} onChange={event => setBranch(event.currentTarget.value)} maxLength={80} autoCapitalize="none" spellCheck={false}/>}</FormField>}
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="coding-new-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>취소</Button>
        <Button type="submit" disabled={!canStart || pending}><Play aria-hidden="true"/>{pending ? '시작 중…' : '세션 시작'}</Button>
      </div>
    </form>
  </section>;
}
