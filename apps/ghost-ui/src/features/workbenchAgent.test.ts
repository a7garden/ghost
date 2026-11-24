import type { OmpInfo } from '@ghost/contract';
import { describe, expect, it } from 'vitest';
import { buildOmpArgs, type AgentOptions } from './ompAgentArgs';
import { buildAgentTerminalSpec } from './workbenchAgent';

const cwd = '/Users/test/work tree';

describe('workbench agent launch', () => {
  it('uses the shared omp resume, model, thinking, and approval selections as argv', () => {
    const info: OmpInfo = {
      sessions: [{ id: 'abc-123', title: '이전 작업', updatedAt: 0 }],
      models: [{ selector: 'anthropic/example', name: 'Example', provider: 'Anthropic', thinking: ['low', 'high'] }],
    };
    const selected: AgentOptions = {
      conversation: 'pick', session: 'abc-123', directory: cwd,
      model: 'anthropic/example', thinking: 'high', approval: 'yolo',
    };
    const args = buildOmpArgs(selected, cwd, info, true);
    expect(buildAgentTerminalSpec(cwd, { kind: 'omp', args })).toEqual({
      cwd, command: 'omp', args: ['--resume', 'abc-123', '--model', 'anthropic/example', '--thinking', 'high', '--approval-mode', 'yolo'],
    });
    expect(buildOmpArgs(selected, cwd, info)).not.toContain('--approval-mode');
    expect(buildOmpArgs(selected, '/other/repo', info, true)).not.toContain('--resume');
    expect(buildOmpArgs({ ...selected, session: 'missing' }, cwd, info, true)).not.toContain('--resume');
    expect(buildOmpArgs({ ...selected, model: 'missing' }, cwd, info, true)).not.toContain('--model');
    expect(buildOmpArgs({ ...selected, thinking: 'medium' }, cwd, info, true)).not.toContain('--thinking');
    expect(buildOmpArgs({ ...selected, conversation: 'continue' }, cwd, info, true)).toContain('--continue');
  });

  it('places the model on the Codex resume subcommand and uses the Claude resume picker', () => {
    expect(buildAgentTerminalSpec(cwd, { kind: 'codex', conversation: 'continue', model: 'gpt-5.4' }).args)
      .toEqual(['resume', '--last', '--model=gpt-5.4']);
    expect(buildAgentTerminalSpec(cwd, { kind: 'claude', conversation: 'resume', model: 'opus' }).args)
      .toEqual(['--resume', '--model=opus']);
  });

  it('passes a Pi task as one positional argument, not as CLI options or shell text', () => {
    const task = '--print this literally\n$(printf example)';
    expect(buildAgentTerminalSpec(cwd, { kind: 'pi', task })).toEqual({ cwd, command: 'pi', args: ['--', task] });
  });
});
