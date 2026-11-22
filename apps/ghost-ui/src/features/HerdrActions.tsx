import { useRef, useState, type FormEvent } from 'react';
import type { CodingSetup, HerdrAgentKind, HerdrPaneView } from '@ghost/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { Button, FormField, InlineError, Input } from '../ui';
import type { HerdrNode, RosterAction } from './HerdrRoster';
import { AgentFields } from './HerdrStart';
import { useAgentLaunch } from './HerdrAgentOptions';

const targetName: Record<HerdrNode['target'], string> = { workspace: '스페이스', tab: '탭', pane: '패널' };

export function HerdrActionDialog({ action, setup, onDismiss, onChanged, onClosed }: {
  action: RosterAction; setup: CodingSetup | null;
  onDismiss(): void; onChanged(pane?: HerdrPaneView): void; onClosed(node: HerdrNode): void;
}) {
  const { client } = useHost();
  const { kind, node } = action;
  const [agent, setAgent] = useState<HerdrAgentKind | undefined>(() => kind === 'agent'
    ? setup?.kinds.find(item => item === setup.prefs.agent) ?? setup?.kinds[0] : undefined);
  const [cwd, setCwd] = useState('');
  const directory = cwd.trim() || node.cwd || '';
  const launch = useAgentLaunch(agent, directory, directory.startsWith('/'));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const target = targetName[node.target];
  if (kind === 'close') return <ConfirmDialog title={`${target} 닫기`} confirmLabel={`${target} 닫기`} onClose={onDismiss}
    onConfirm={async () => {
      await client.closeHerdrNode({ target: node.target, id: node.id });
      onClosed(node);
    }}>
    <p className="m-0"><strong>{node.label}</strong>에서 실행 중인 프로세스가 종료됩니다.</p>
  </ConfirmDialog>;

  const title = kind === 'rename' ? `${target} 이름 바꾸기` : kind === 'tab' ? '새 탭'
    : kind === 'agent' ? '에이전트 시작' : action.direction === 'right' ? '오른쪽으로 분할' : '아래로 분할';
  const submitLabel = kind === 'rename' ? '저장' : kind === 'agent' ? '시작' : kind === 'tab' ? '탭 만들기' : '분할';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const fields = new FormData(event.currentTarget);
    const label = String(fields.get('label') ?? '').trim();
    const explicitCwd = cwd.trim();
    const task = agent ? String(fields.get('task') ?? '').trim() : '';
    if (kind === 'rename' && !label) { setError('이름을 입력하세요.'); return; }
    if (explicitCwd && !explicitCwd.startsWith('/')) { setError('경로는 /로 시작하는 절대 경로를 입력하세요.'); return; }
    const args = launch.prepare();
    if (!args) return;
    const options = { ...(args.length && { args }), ...(task && { task }) };
    const start = { ...(agent && { agent }), ...options };
    busy.current = true;
    setPending(true);
    setError('');
    try {
      let pane: HerdrPaneView | undefined;
      if (kind === 'rename') await client.renameHerdrNode({ target: node.target, id: node.id, label });
      else if (kind === 'tab') {
        const tabCwd = explicitCwd || (args.includes('--continue') ? directory : '');
        pane = await client.createHerdrTab({ workspace: node.id, ...(label && { label }), ...(tabCwd && { cwd: tabCwd }), ...start });
      }
      else if (kind === 'split') pane = await client.splitHerdrPane({ pane: action.pane, direction: action.direction, ...start });
      else if (kind === 'agent' && agent) pane = await client.startHerdrAgent({ pane: node.id, agent, ...options });
      launch.remember();
      onDismiss();
      onChanged(pane);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '작업을 처리하지 못했습니다.');
    } finally { busy.current = false; setPending(false); }
  }

  return <Modal title={title} onClose={() => { if (!busy.current) onDismiss(); }} className="herdr-action-dialog">
    <form className="herdr-action-form" onSubmit={event => void submit(event)} aria-busy={pending || undefined}>
      <fieldset disabled={pending}>
        {(kind === 'tab' || kind === 'rename') && <FormField label={kind === 'rename' ? '이름' : '이름 (선택)'} required={kind === 'rename'}>{props =>
          <Input {...props} name="label" maxLength={80} defaultValue={kind === 'rename' ? node.label : undefined}/>}</FormField>}
        {kind === 'tab' && <FormField label="디렉터리 (선택)">{props => <Input {...props} name="cwd" maxLength={4096} placeholder={node.cwd ?? '/Users/…'}
          value={cwd} onChange={event => setCwd(event.currentTarget.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>}</FormField>}
        {kind !== 'rename' && <AgentFields setup={setup} value={agent} onChange={setAgent} required={kind === 'agent'} pending={pending} optionsDisclosure={launch.disclosure}/>}
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="coding-new-actions">
        <Button variant="ghost" type="button" disabled={pending} onClick={onDismiss}>취소</Button>
        <Button type="submit" disabled={pending || (kind === 'agent' && !agent)}>{pending ? '처리 중…' : submitLabel}</Button>
      </div>
    </form>
  </Modal>;
}
