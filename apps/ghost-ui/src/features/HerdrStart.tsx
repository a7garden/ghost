import { useId, useRef, useState, type FormEvent } from 'react';
import { FolderOpen, Plus } from 'lucide-react';
import { HERDR_AGENT_KINDS, type CodingSetup, type HerdrAgentKind, type HerdrPaneView, type HerdrWorkspaceCreate, type Scope } from '@ghost/contract';
import { Button, FormField, InlineError, Input, Popover, PopoverContent, PopoverTrigger, SelectField, Switch, Textarea } from '../ui';
import { useHost } from '../host/context';
import { submitCodingOnShortcut } from './herdrDisplay';
import { useAgentLaunch } from './HerdrAgentOptions';

const kindNames: Record<HerdrAgentKind, string> = {
  omp: 'omp', claude: 'Claude Code', codex: 'Codex', pi: 'Pi', gemini: 'Gemini CLI', cursor: 'Cursor',
  devin: 'Devin', agy: 'Antigravity CLI', cline: 'Cline', mastracode: 'MastraCode', opencode: 'OpenCode',
  copilot: 'GitHub Copilot CLI', kimi: 'Kimi Code CLI', kiro: 'Kiro CLI', droid: 'Droid', amp: 'Amp', grok: 'Grok',
  hermes: 'Hermes Agent', kilo: 'Kilo Code CLI', qodercli: 'Qoder CLI', qwen: 'Qwen Code', letta: 'Letta Code', maki: 'Maki', muse: 'Muse Agent',
};

export function herdrAgentOptions(installed: readonly HerdrAgentKind[]) {
  const enabled: { value: HerdrAgentKind; label: string; disabled: boolean }[] = [];
  const unavailable: typeof enabled = [];
  for (const kind of HERDR_AGENT_KINDS) {
    const ready = installed.includes(kind);
    (ready ? enabled : unavailable).push({ value: kind, label: ready ? kindNames[kind] : `${kindNames[kind]} · 설치 안 됨`, disabled: !ready });
  }
  return [...enabled, ...unavailable];
}

export function workspaceInput(data: FormData, agent?: HerdrAgentKind): HerdrWorkspaceCreate {
  const field = (name: string) => String(data.get(name) ?? '').trim();
  const worktree = data.has('worktree'), label = field('label'), task = agent ? field('task') : '';
  const branch = worktree ? field('branch') : '';
  return { cwd: field('cwd'), worktree, ...(label && { label }), ...(branch && { branch }), ...(agent && { agent }), ...(task && { task }) };
}

export function AgentFields({ setup, value, onChange, required = false, pending, optionsDisclosure }: {
  setup: CodingSetup | null; value: HerdrAgentKind | undefined; onChange(value: HerdrAgentKind | undefined): void;
  required?: boolean; pending: boolean; optionsDisclosure: React.ReactNode;
}) {
  const installed = setup?.kinds ?? [];
  const options = [...(required ? [] : [{ value: 'shell', label: '셸' }]), ...herdrAgentOptions(installed)];
  return <>
    <FormField label="에이전트" required={required}>{({ id }) => <SelectField id={id} label="에이전트" className="w-full"
      value={value ?? (required ? '' : 'shell')} onValueChange={next => onChange(installed.find(kind => kind === next))}
      disabled={!setup || pending || (required && installed.length === 0)} options={options}/>}</FormField>
    {required && installed.length === 0 && <p className="coding-hint">설치된 에이전트가 없습니다.</p>}
    {optionsDisclosure}
    {value && <FormField label="첫 지시 (선택)">{props => <Textarea {...props} name="task" rows={3} maxLength={24_000}
      className="field-sizing-fixed min-h-20 resize-y" aria-keyshortcuts="Meta+Enter Control+Enter" onKeyDown={submitCodingOnShortcut}/>}</FormField>}
  </>;
}

function RepositoryField({ scopes, repo, onChange }: { scopes: Scope[]; repo: string; onChange(path: string): void }) {
  const [open, setOpen] = useState(false);
  const paths = new Map<string, string>();
  for (const scope of scopes) for (const path of scope.paths) if (path.startsWith('/') && !paths.has(path)) paths.set(path, scope.name);
  return <FormField label="디렉터리" required>{props => <div className="coding-repo">
    <Input {...props} name="cwd" value={repo} onChange={event => onChange(event.currentTarget.value)}
      placeholder="/Users/…" maxLength={4096} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
    {paths.size > 0 && <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="outline" size="icon" type="button" aria-label="프로젝트 경로 선택"><FolderOpen aria-hidden="true"/></Button></PopoverTrigger>
      <PopoverContent className="coding-repo-picker" align="end" aria-label="프로젝트 경로 선택">
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
  const [agent, setAgent] = useState<HerdrAgentKind | 'shell'>();
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [worktree, setWorktree] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const worktreeId = useId();
  const titleId = useId();
  const preferred = setup?.prefs.agent;
  const selected = setup?.kinds.find(kind => kind === (agent ?? preferred));
  const launch = useAgentLaunch(selected, repo, !worktree);
  const canStart = Boolean(setup?.herdr.path && setup.config.ok && setup.server?.compatible);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !canStart) return;
    const input = workspaceInput(new FormData(event.currentTarget), selected);
    if (!input.cwd.startsWith('/')) { setError('경로는 /로 시작하는 절대 경로를 입력하세요.'); return; }
    const args = launch.prepare();
    if (!args) return;
    setError('');
    pendingRef.current = true;
    setPending(true);
    try {
      const pane = await client.createHerdrWorkspace(args.length ? { ...input, args } : input);
      launch.remember();
      onStarted(pane);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '스페이스를 만들지 못했습니다.'); }
    finally { pendingRef.current = false; setPending(false); }
  }

  return <section className="coding-new" aria-labelledby={titleId}>
    <form className="coding-new-form" onSubmit={event => void start(event)} aria-busy={pending || undefined}>
      <h2 id={titleId}>새 스페이스</h2>
      <fieldset disabled={pending}>
        <RepositoryField scopes={scopes} repo={repo} onChange={setRepo}/>
        <FormField label="이름 (선택)">{props => <Input {...props} name="label" maxLength={80}/>}</FormField>
        <div className="coding-worktree"><label htmlFor={worktreeId}>새 워크트리에서 작업</label>
          <Switch id={worktreeId} name="worktree" checked={worktree} onCheckedChange={setWorktree}/>
        </div>
        {worktree && <FormField label="브랜치 이름 (선택)">{props => <Input {...props} name="branch" value={branch} onChange={event => setBranch(event.currentTarget.value)} maxLength={80} autoCapitalize="none" spellCheck={false}/>}</FormField>}
        <AgentFields setup={setup} value={selected} pending={pending} onChange={value => setAgent(value ?? 'shell')} optionsDisclosure={launch.disclosure}/>
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="coding-new-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>취소</Button>
        <Button type="submit" disabled={!canStart || pending}><Plus aria-hidden="true"/>{pending ? '만드는 중…' : '스페이스 만들기'}</Button>
      </div>
    </form>
  </section>;
}
