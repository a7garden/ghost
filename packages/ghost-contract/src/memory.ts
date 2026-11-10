export type MemorySource = { conversationId: string; messageId: string; quote: string };

export type MemoryFile = {
  path: string;
  content: string;
  hash: string;
  revision: number;
  updatedAt: number;
  author: string;
  trust: "untrusted" | "owner";
  reads: number;
  lastReadAt: number | null;
  sources: MemorySource[];
};

export type MemoryHistory = {
  seq: number;
  id: string;
  conversationId: string;
  role: string;
  origin: string | null;
  text: string;
  at: number;
};

export type MemorySearchHit = {
  kind: "note" | "history";
  path: string | null;
  conversationId: string | null;
  messageId: string | null;
  text: string;
  score: number;
  at: number;
};

export type MemoryDreamRun = {
  id: string;
  ghostId: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
  through: number;
  report: string;
  error: string | null;
};

export type MemoryView = { files: MemoryFile[]; runs: MemoryDreamRun[] };

export type MemoryRevision = {
  revision: number;
  content: string | null;
  at: number;
  author: string;
  reason: string;
  sources: MemorySource[];
};
