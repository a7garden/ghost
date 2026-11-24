import { useId, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { type CodingSetup, type HerdrAgentKind, type HerdrPaneView, type HerdrWorkspaceCreate } from '@ghost/contract';
import { FolderField } from '../components/FolderPicker';
import { Button, FormField, InlineError, Input, Popover, PopoverContent, PopoverTrigger, SelectField, Switch, Textarea } from '../ui';
import { useHost } from '../host/context';
import { submitCodingOnShortcut } from './herdrDisplay';
import { AgentOptionsSection, useAgentLaunch } from './HerdrAgentOptions';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';

const kindNames: Record<HerdrAgentKind, string> = {
  omp: 'omp', claude: 'Claude Code', codex: 'Codex', pi: 'Pi', gemini: 'Gemini CLI', cursor: 'Cursor',
  devin: 'Devin', agy: 'Antigravity CLI', cline: 'Cline', mastracode: 'MastraCode', opencode: 'OpenCode',
  copilot: 'GitHub Copilot CLI', kimi: 'Kimi Code CLI', kiro: 'Kiro CLI', droid: 'Droid', amp: 'Amp', grok: 'Grok',
  hermes: 'Hermes Agent', kilo: 'Kilo Code CLI', qodercli: 'Qoder CLI', qwen: 'Qwen Code', letta: 'Letta Code', maki: 'Maki', muse: 'Muse Agent',
};

/** The routine picker offers only what runs on this Mac; uninstalled kinds live in the 연동 checklist. */
export function herdrAgentOptions(installed: readonly HerdrAgentKind[]) {
  return installed.map(kind => ({ value: kind, label: kindNames[kind] }));
}

export function preferredHerdrAgent(setup: CodingSetup | null) {
  return setup?.kinds.find(kind => kind === setup.prefs.agent) ?? setup?.kinds[0];
}

export function HerdrShellStart({ pane, setup, onStarted }: { pane: string; setup: CodingSetup | null; onStarted(pane: HerdrPaneView): void }) {
  const { client } = useHost();
  const [choice, setChoice] = useState<HerdrAgentKind>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<'resume' | 'new' | null>(null);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const options = herdrAgentOptions(setup?.kinds ?? []);
  const agent = options.find(option => option.value === choice)?.value ?? preferredHerdrAgent(setup);
  const agentName = agent ? kindNames[agent] : null;
  async function start(resume: boolean) {
    if (!agent || busy.current) return;
    busy.current = true;
    setError('');
    setPending(resume ? 'resume' : 'new');
    try { onStarted(await client.startHerdrAgent({ pane, agent, ...(resume && { args: ['--continue'] }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '에이전트를 시작하지 못했습니다.'); }
    finally { busy.current = false; setPending(null); }
  }
  return <div className="coding-shell-start" aria-busy={Boolean(pending) || undefined}>
    <Button type="button" size="sm" title={agentName ?? undefined} disabled={!agent || Boolean(pending)} onClick={() => void start(true)}>
      {pending === 'resume' ? '이어서 시작 중…' : '이어서 시작'}
    </Button>
    <Button type="button" size="sm" variant="ghost" title={agentName ?? undefined} disabled={!agent || Boolean(pending)} onClick={() => void start(false)}>
      {pending === 'new' ? '새로 시작 중…' : '새로 시작'}
    </Button>
    {options.length > 1 && <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" size="icon" variant="ghost" disabled={Boolean(pending)}
        aria-label="시작할 에이전트 선택" title={agentName ?? undefined}><ChevronDown aria-hidden="true"/></Button></PopoverTrigger>
      <PopoverContent className="coding-shell-agent-menu" side="top" align="start" aria-label="시작할 에이전트 선택">
        {options.map(({ value, label }) => <Button key={value} type="button" variant="ghost" aria-pressed={agent === value}
          onClick={() => { setChoice(value); setOpen(false); }}>{label}{agent === value && <Check aria-hidden="true"/>}</Button>)}
      </PopoverContent>
    </Popover>}
    {setup && !agent && <p className="coding-hint">설치된 에이전트가 없습니다.</p>}
    {error && <InlineError>{error}</InlineError>}
  </div>;
}

/** `label`, `branch` and `worktree` live in the collapsible options section, so they arrive as values, not form fields. */
export function workspaceInput(data: FormData, agent: HerdrAgentKind | undefined,
  section: { worktree: boolean; label?: string; branch?: string }): HerdrWorkspaceCreate {
  const field = (name: string) => String(data.get(name) ?? '').trim();
  const label = section.label?.trim() ?? '';
  const branch = section.worktree ? section.branch?.trim() ?? '' : '';
  const task = agent ? field('task') : '';
  return { cwd: field('cwd'), worktree: section.worktree, ...(label && { label }), ...(branch && { branch }), ...(agent && { agent }), ...(task && { task }) };
}

export function AgentFields({ setup, value, onChange, required = false, pending }: {
  setup: CodingSetup | null; value: HerdrAgentKind | undefined; onChange(value: HerdrAgentKind | undefined): void;
  required?: boolean; pending: boolean;
}) {
  const installed = setup?.kinds ?? [];
  const options = [...(required ? [] : [{ value: 'shell', label: '셸' }]), ...herdrAgentOptions(installed)];
  return <>
    <FormField label="에이전트" required={required}>{({ id }) => <SelectField id={id} label="에이전트" className="w-full"
      value={value ?? (required ? '' : 'shell')} onValueChange={next => onChange(installed.find(kind => kind === next))}
      disabled={!setup || pending || (required && installed.length === 0)} options={options}/>}</FormField>
    {required && installed.length === 0 && <p className="coding-hint">설치된 에이전트가 없습니다.</p>}
  </>;
}

export function TaskField() {
  return <FormField label="첫 지시 (선택)">{props => <Textarea {...props} name="task" rows={3} maxLength={24_000}
    className="field-sizing-fixed min-h-20 resize-y" aria-keyshortcuts="Meta+Enter Control+Enter" onKeyDown={submitCodingOnShortcut}/>}</FormField>;
}

function RepositoryField({ repo, onChange }: { repo: string; onChange(path: string): void }) {
  return <>
    <FolderField label="디렉터리" value={repo} onChange={onChange}/>
    <input type="hidden" name="cwd" value={repo}/>
  </>;
}

export function NewHerdrWorkspace({ setup, onStarted, onCancel }: {
  setup: CodingSetup | null; onStarted(pane: HerdrPaneView): void; onCancel(): void;
}) {
  const { client } = useHost();
  const [agent, setAgent] = useState<HerdrAgentKind | 'shell'>();
  const [repo, setRepo] = useState(() => readCodingValue('new-space-dir') ?? '');
  const [label, setLabel] = useState('');
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
    const input = workspaceInput(new FormData(event.currentTarget), selected, { worktree, label, branch });
    if (!input.cwd.startsWith('/')) { setError('경로는 /로 시작하는 절대 경로를 입력하세요.'); return; }
    const args = launch.prepare();
    if (!args) return;
    setError('');
    pendingRef.current = true;
    setPending(true);
    try {
      const pane = await client.createHerdrWorkspace(args.length ? { ...input, args } : input);
      launch.remember();
      writeCodingValue('new-space-dir', input.cwd);
      onStarted(pane);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '스페이스를 만들지 못했습니다.'); }
    finally { pendingRef.current = false; setPending(false); }
  }

  return <section className="coding-new" aria-labelledby={titleId}>
    <form className="coding-new-form" onSubmit={event => void start(event)} aria-busy={pending || undefined}>
      <h2 id={titleId}>새 스페이스</h2>
      <fieldset disabled={pending}>
        <RepositoryField repo={repo} onChange={setRepo}/>
        <AgentFields setup={setup} value={selected} pending={pending} onChange={value => setAgent(value ?? 'shell')}/>
        {selected && <TaskField/>}
        <AgentOptionsSection launch={launch} risks={worktree ? [] : [{ label: '직접 쓰기', danger: true }]}>
          <FormField label="이름 (선택)">{props => <Input {...props} name="label" value={label}
            onChange={event => setLabel(event.currentTarget.value)} maxLength={80}/>}</FormField>
          <div className="coding-worktree"><label htmlFor={worktreeId}>새 워크트리에서 작업</label>
            <Switch id={worktreeId} checked={worktree} onCheckedChange={setWorktree}/>
          </div>
          {worktree && <FormField label="브랜치 이름 (선택)">{props => <Input {...props} name="branch" value={branch}
            onChange={event => setBranch(event.currentTarget.value)} maxLength={80} autoCapitalize="none" spellCheck={false}/>}</FormField>}
        </AgentOptionsSection>
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="coding-new-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={pending}>취소</Button>
        <Button type="submit" disabled={!canStart || pending}><Plus aria-hidden="true"/>{pending ? '만드는 중…' : '스페이스 만들기'}</Button>
      </div>
    </form>
  </section>;
}
