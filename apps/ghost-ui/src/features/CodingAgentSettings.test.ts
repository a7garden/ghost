import { describe, expect, it } from 'vitest';
import type { CodingAgentsView } from '@ghost/contract';
import { usedByDefault } from './CodingAgentSettings';

const agent = (id: CodingAgentsView['agents'][number]['id'], ready = true) => ({ id, name: id, path: `/bin/${id}`, version: '1', ready, note: null });

describe('the coding agent a run uses when none is named', () => {
  const all = [agent('omp'), agent('claude'), agent('codex', false)];
  it('is the first one that can run, unless the owner picked another that can', () => {
    expect(usedByDefault({ agents: all, default: null, disabled: [] })).toBe('omp');
    expect(usedByDefault({ agents: all, default: 'claude', disabled: [] })).toBe('claude');
  });
  it('skips an agent that is off or cannot run, even if it was picked', () => {
    expect(usedByDefault({ agents: all, default: 'claude', disabled: ['claude'] })).toBe('omp');
    expect(usedByDefault({ agents: all, default: 'codex', disabled: [] })).toBe('omp');
  });
  it('is none when nothing can run', () => {
    expect(usedByDefault({ agents: all, default: null, disabled: ['omp', 'claude'] })).toBeNull();
    expect(usedByDefault({ agents: [], default: null, disabled: [] })).toBeNull();
  });
});
