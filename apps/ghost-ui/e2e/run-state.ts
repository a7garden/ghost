import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SeedResult } from './seed';

/** What the tests need to know about the run: written by global setup, read by specs. */
export interface VisualRunState extends SeedResult {
  baseUrl: string;
  mockPort: number;
  /** Browser clock freeze point: seed end plus a minute, so relative labels stay in the same bucket. */
  fixedNow: number;
}

function runRoot(): string {
  const root = process.env.GHOST_VISUAL_RUN_ROOT;
  if (!root) throw new Error('Visual run has no isolated root; global setup must run first.');
  return root;
}

/** Early partial state (process handle, temp root) so teardown can clean up a failed setup. */
export interface CleanupState { hostPid?: number; tempRoot?: string; }

export function writeRunState(state: VisualRunState): void {
  const statePath = join(runRoot(), 'state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function writeCleanupState(state: CleanupState): void {
  const cleanupPath = join(runRoot(), 'cleanup.json');
  mkdirSync(dirname(cleanupPath), { recursive: true });
  writeFileSync(cleanupPath, JSON.stringify(state, null, 2));
}

export function readRunState(): VisualRunState {
  return JSON.parse(readFileSync(join(runRoot(), 'state.json'), 'utf8')) as VisualRunState;
}

export function readCleanupState(): CleanupState | null {
  try {
    const state = JSON.parse(readFileSync(join(runRoot(), 'cleanup.json'), 'utf8')) as CleanupState;
    if (state.tempRoot !== runRoot()) throw new Error('Visual cleanup root does not belong to this run.');
    return state;
  } catch {
    return null;
  }
}
