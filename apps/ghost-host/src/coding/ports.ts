import { createHash } from "node:crypto";
import type { CodingDialogAnswer, CodingEvent, CodingItem, CodingPrompt, CodingSession, CodingSessionCreate } from "@ghost/contract";

/** Who asked for a session: the owner in the app, or a Ghost for one 맡긴 일. Only a Ghost's session reports back. */
export type CodingRequester = { kind: "owner" } | { kind: "ghost"; ghostId: string; workId: string; callId: string };

/** Resolve the ledger address before any worktree I/O, including when recovering a Ghost effect. */
export function ghostCodingSessionId(requester: Extract<CodingRequester, { kind: "ghost" }>): string {
  const input = JSON.stringify([requester.ghostId, requester.workId, requester.callId]);
  return `coding-${createHash("sha256").update(input).digest("hex").slice(0, 32)}`;
}

/** The changes a session's worktree holds against the commit it was cut from: the Host's observation, never the agent's claim. */
export interface CodingChanges {
  files: { path: string; status: "added" | "modified" | "deleted" | "renamed" | "untracked"; additions: number; deletions: number }[];
  /** Unified diff, bounded; `truncated` says it was cut. */
  diff: string;
  truncated: boolean;
  /** Commits on the branch since the base, newest first (subject lines), and whether the worktree has uncommitted changes. */
  commits: string[];
  dirty: boolean;
}

/** One turn that ended: what a Ghost's report is made from. `waiting` is a turn paused on the owner's dialog. */
export interface CodingSettled {
  session: CodingSession;
  turn: number;
  outcome: "done" | "failed" | "aborted" | "waiting" | "interrupted";
  /** The agent's last assistant text of the turn: its claim, untrusted. */
  finalText: string | null;
}

/**
 * The coding sessions the Host runs in process (`docs/coding-session.md`). The Ghost tools, the API and the update
 * gate use this port only. Reads never change a session; `create` and `prompt` are the effects.
 */
export interface CodingSessionsPort {
  list(): CodingSession[];
  get(id: string): CodingSession | null;
  create(input: CodingSessionCreate, requester: CodingRequester): Promise<CodingSession>;
  /** Resolves when the prompt is accepted (`started`, or `queued` behind a running turn), not when the turn ends. A refused `prompt` mode while working rejects. */
  prompt(id: string, input: CodingPrompt): Promise<{ disposition: "started" | "queued" }>;
  abort(id: string): Promise<void>;
  /** Close keeps the worktree and branch. */
  close(id: string): Promise<void>;
  /** The owner answers the open dialog; rejects when it is no longer the open one. */
  answer(id: string, dialogId: string, answer: CodingDialogAnswer): Promise<void>;
  rename(id: string, patch: { title?: string; model?: { provider: string; model: string }; thinking?: CodingSession["thinking"] }): Promise<CodingSession>;
  /** Normalized transcript, oldest first, after the item with id `after` when given. */
  items(id: string, options?: { after?: string; limit?: number }): CodingItem[];
  /** Observe one session: its state and items as they change. Returns the unsubscribe. */
  subscribe(id: string, listener: (event: CodingEvent) => void): () => void;
  /** Observe every turn that ends, in order, once each. */
  onSettled(listener: (settled: CodingSettled) => void): () => void;
  changes(id: string): Promise<CodingChanges>;
  /** True while a session is working or waiting: the Host update waits for it. */
  busy(): boolean;
  /** Serve a file the session may show (inside its cwd or its artifacts); null when the path is outside. */
  file(id: string, path: string): { path: string; mimeType: string } | null;
  /** Stop every session at Host shutdown. */
  shutdown?(): Promise<void>;
}
