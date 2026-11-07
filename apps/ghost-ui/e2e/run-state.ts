import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeedResult } from './seed';

/** What the tests need to know about the run: written by global setup, read by specs. */
export interface VisualRunState extends SeedResult {
  baseUrl: string;
  mockPort: number;
  /** Browser clock freeze point: seed end plus a minute, so relative labels stay in the same bucket. */
  fixedNow: number;
}

const statePath = join(dirname(fileURLToPath(import.meta.url)), '.run', 'state.json');
const cleanupPath = join(dirname(fileURLToPath(import.meta.url)), '.run', 'cleanup.json');

/** Early partial state (process handle, temp root) so teardown can clean up a failed setup. */
export interface CleanupState { hostPid?: number; tempRoot?: string; }

export function writeRunState(state: VisualRunState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function writeCleanupState(state: CleanupState): void {
  mkdirSync(dirname(cleanupPath), { recursive: true });
  writeFileSync(cleanupPath, JSON.stringify(state, null, 2));
}

export function readRunState(): VisualRunState {
  return JSON.parse(readFileSync(statePath, 'utf8')) as VisualRunState;
}

export function readCleanupState(): CleanupState | null {
  try {
    return JSON.parse(readFileSync(cleanupPath, 'utf8')) as CleanupState;
  } catch {
    return null;
  }
}

export const runStatePath = statePath;
