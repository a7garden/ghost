import type { MemoryFile, MemoryHistory, ModelRef } from "@ghost/contract";

/** Full CAS manifest, but only bounded, complete selected files and evidence reach the model. */
export interface MemorySnapshot {
  ghostId: string;
  after: number;
  through: number;
  versions: { path: string; hash: string }[];
  files: MemoryFile[];
  shared: { paths: string[]; omitted: number };
  history: MemoryHistory[];
}

export interface MemoryDreamInput {
  id: string;
  snapshot: MemorySnapshot;
  model: ModelRef;
  startedAt: number;
}

/** Host-only engine capability. Never exposed as a Ghost tool or a Ghost row. */
export interface MemoryEngine {
  catchUpMemory(ghostId?: string): Promise<void>;
  memoryStatus(ghostId: string): { ready: boolean; pending: number };
  dreamMemory(input: MemoryDreamInput, signal: AbortSignal): Promise<{ snapshot: MemorySnapshot; output: string }>;
}
