import type { WorkbenchTerminalSpec } from '@ghost/contract';

export type TerminalConversation = 'new' | 'continue' | 'resume';
type TerminalLaunch =
  | { kind: 'omp'; args: string[] }
  | { kind: 'claude' | 'codex'; conversation: TerminalConversation; model: string }
  | { kind: 'pi'; task: string };

export function buildAgentTerminalSpec(cwd: string, launch: TerminalLaunch): WorkbenchTerminalSpec {
  const command = launch.kind;
  if (launch.kind === 'omp') return { cwd, command, args: launch.args };
  if (launch.kind === 'pi') return { cwd, command, args: launch.task.trim() ? ['--', launch.task] : [] };

  const args: string[] = [];
  if (launch.kind === 'claude') {
    if (launch.conversation === 'continue') args.push('--continue');
    if (launch.conversation === 'resume') args.push('--resume');
  } else if (launch.conversation !== 'new') {
    args.push('resume');
    if (launch.conversation === 'continue') args.push('--last');
  }
  const model = launch.model.trim();
  if (model) args.push(`--model=${model}`);
  return { cwd, command, args };
}
