import type { MemoryFile, MemoryHistory, MemorySource } from "@ghost/contract";
import type { Core } from "../core/core.ts";
import { CommandError } from "../core/errors.ts";
import { digestOf } from "../core/ids.ts";
import type { MemoryStore } from "../stores/memory.ts";
import type { MemoryEngine, MemorySnapshot } from "./types.ts";

const DAY = 86_400_000;
const BACKOFF = 3_600_000;
const MIN_INTERVAL = 6 * 3_600_000;
const IDLE_DELAY = 180_000;
const FILE_BUDGET = 40 * 1024;
const HISTORY_BUDGET = 40 * 1024;
const MAX_OUTPUT = 48 * 1024;

interface Change { path: string; content: string | null; sources: MemorySource[]; reason: string }
interface Proposal { changes: Change[]; report: string }

function ownPath(ghostId: string, path: string): boolean {
  return /^\/me\/(?:[^/]+\/)*[^/]+\.md$/.test(path) || (path.startsWith(`/team/${ghostId}/`) && /^\/(?:[^/]+\/)*[^/]+\.md$/.test(path.slice(`/team/${ghostId}`.length)));
}

/** Complete selected notes, never truncated notes that a model could accidentally overwrite. */
export function memorySnapshot(memory: MemoryStore, ghostId: string, after: number, through?: number): MemorySnapshot {
  const visible = memory.list(ghostId);
  const all = visible.filter((file) => ownPath(ghostId, file.path));
  const sharedPaths = visible.filter((file) => file.path.startsWith("/team/") && !ownPath(ghostId, file.path)).map((file) => file.path).sort();
  const paths: string[] = [];
  let metadataBytes = 0;
  for (const path of sharedPaths) {
    const size = Buffer.byteLength(JSON.stringify(path));
    if (paths.length >= 32 || metadataBytes + size > 4000) break;
    paths.push(path);
    metadataBytes += size;
  }
  const history: MemoryHistory[] = [];
  let bytes = 0;
  for (const row of memory.history(ghostId, after, 128)) {
    if (through !== undefined && row.seq > through) break;
    const evidence = { ...row, text: row.text.slice(0, 8000) };
    let size = Buffer.byteLength(JSON.stringify(evidence));
    // Even heavily escaped source text must not permanently block the cursor.
    while (!history.length && size > HISTORY_BUDGET && evidence.text.length) {
      evidence.text = evidence.text.slice(0, Math.floor(evidence.text.length / 2));
      size = Buffer.byteLength(JSON.stringify(evidence));
    }
    if (bytes + size > HISTORY_BUDGET) break;
    history.push(evidence);
    bytes += size;
  }
  const evidenceText = history.map((row) => row.text).join("\n").toLowerCase();
  const terms = [...new Set(evidenceText.match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 128);
  const order = new Map(all.map((file) => file.path).sort().map((path, index) => [path, index]));
  const offset = after % Math.max(all.length, 1);
  const ranks = new Map(all.map((file) => {
    const body = file.content.toLowerCase();
    const title = body.split("\n", 1)[0]!.replace(/^#+\s*/, "").trim();
    const score = (evidenceText.includes(file.path.toLowerCase()) ? 1_000_000 : 0)
      + (title.length > 2 && evidenceText.includes(title) ? 500_000 : 0)
      + terms.reduce((score, term) => score + (body.includes(term) ? 100 : 0), 0)
      + Math.min(file.reads, 99);
    return [file.path, { score, rotation: (order.get(file.path)! - offset + all.length) % all.length }];
  }));
  const files: MemoryFile[] = [];
  bytes = 0;
  for (const file of all.filter((file) => file.path !== "/me/MEMORY.md").sort((a, b) => ranks.get(b.path)!.score - ranks.get(a.path)!.score || ranks.get(a.path)!.rotation - ranks.get(b.path)!.rotation)) {
    const size = Buffer.byteLength(JSON.stringify(file));
    if (bytes + size > FILE_BUDGET) continue;
    files.push(file);
    bytes += size;
  }
  return { ghostId, after, through: history.at(-1)?.seq ?? after, versions: all.map(({ path, hash }) => ({ path, hash })), files, shared: { paths, omitted: sharedPaths.length - paths.length }, history };
}

/** Existence of a quote is checked; this is provenance validation, not semantic entailment. */
export function readProposal(output: string, snapshot: MemorySnapshot): Proposal {
  if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error("memory response exceeds the output limit");
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object") throw new Error("memory response must be an object");
  const proposal = value as Record<string, unknown>;
  if (!Array.isArray(proposal.changes) || proposal.changes.length > 8 || typeof proposal.report !== "string" || proposal.report.length > 2000) throw new Error("invalid memory proposal");
  const paths = new Set<string>();
  const changes = proposal.changes.map((raw: unknown): Change => {
    if (!raw || typeof raw !== "object") throw new Error("invalid memory change");
    const change = raw as Record<string, unknown>;
    const path = change.path;
    if (typeof path !== "string" || !ownPath(snapshot.ghostId, path) || path === "/me/MEMORY.md" || /[\x00-\x1f\\]/.test(path) || path.split("/").some((part) => part === "." || part === "..")) throw new Error("memory path is outside the editable private or own-team namespace");
    if (paths.has(path)) throw new Error("duplicate memory path");
    paths.add(path);
    if (snapshot.versions.some((file) => file.path === path) && !snapshot.files.some((file) => file.path === path)) throw new Error("cannot edit an existing note omitted from the bounded snapshot");
    if ((typeof change.content !== "string" && change.content !== null) || (typeof change.content === "string" && (!change.content.trim() || Buffer.byteLength(change.content) > 30 * 1024)) || typeof change.reason !== "string" || !change.reason.trim() || change.reason.length > 500) throw new Error("invalid note content or reason");
    if (change.content === null && !snapshot.files.some((file) => file.path === path)) throw new Error("cannot delete a nonexistent note");
    if (!Array.isArray(change.sources) || change.sources.length < 1 || change.sources.length > 16) throw new Error("each change needs bounded exact evidence references");
    const sources = change.sources.map((rawSource: unknown): MemorySource => {
      if (!rawSource || typeof rawSource !== "object") throw new Error("invalid memory source");
      const source = rawSource as Record<string, unknown>;
      if (typeof source.conversationId !== "string" || typeof source.messageId !== "string" || typeof source.quote !== "string" || !source.quote.trim() || source.quote.length > 4000) throw new Error("invalid source identity or quote");
      const evidence = snapshot.history.find((row) => row.conversationId === source.conversationId && row.id === source.messageId);
      if (!evidence || !evidence.text.includes(source.quote)) throw new Error("memory quote does not occur in the immutable source snapshot");
      return { conversationId: source.conversationId, messageId: source.messageId, quote: source.quote };
    });
    return { path, content: change.content as string | null, sources, reason: change.reason };
  });
  return { changes, report: proposal.report };
}

/** Deterministic navigation, not model-authored facts. Omission is always explicit. */
export function memoryIndex(files: MemoryFile[]): string {
  const privateFiles = files.filter((file) => file.path.startsWith("/me/") && file.path !== "/me/MEMORY.md")
    .sort((a, b) => b.reads - a.reads || (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
  const lines = ["# Private memory index", "", "Untrusted note DATA; titles are navigation, not verified facts.", ""];
  let included = 0;
  for (const file of privateFiles) {
    const title = file.content.split("\n").find((line) => line.trim() && !line.startsWith("<!--"))?.replace(/^[#>\s]+/, "").replace(/[\x00-\x1f]/g, " ").slice(0, 80) ?? "Untitled";
    const line = `- ${JSON.stringify(file.path)} — ${title}`;
    if (lines.length >= 190 || Buffer.byteLength([...lines, line].join("\n")) > 7500) break;
    lines.push(line);
    included++;
  }
  lines.push("", `Omitted private notes: ${privateFiles.length - included}. Use memory list/search for all notes.`);
  return lines.join("\n");
}

/** All revisions, receipts, generated index, completion and cursor commit together. */
export function commitProposal(memory: MemoryStore, id: string, snapshot: MemorySnapshot, output: string): void {
  const proposal = readProposal(output, snapshot);
  memory.transaction(() => {
    if (memory.dreamCursor(snapshot.ghostId) !== snapshot.after) throw new CommandError("conflict", "memory consolidation cursor changed");
    const current = memory.list(snapshot.ghostId).filter((file) => ownPath(snapshot.ghostId, file.path));
    if (digestOf(current.map(({ path, hash }) => [path, hash]).sort()) !== digestOf(snapshot.versions.map(({ path, hash }) => [path, hash]).sort())) throw new CommandError("conflict", "memory changed while consolidation was running");
    for (const [index, change] of proposal.changes.entries()) {
      const file = current.find((file) => file.path === change.path);
      memory.write({ ghostId: snapshot.ghostId, path: change.path, content: change.content === null ? null : `<!-- Untrusted Host synthesis; cited quotes establish provenance, not proof of every claim. -->\n${change.content}`, expectedHash: file?.hash ?? null, actor: "host", operationId: `${id}:${index}`, reason: change.reason, sources: change.sources });
    }
    const index = current.find((file) => file.path === "/me/MEMORY.md");
    const content = memoryIndex(memory.list(snapshot.ghostId));
    if (content !== index?.content) memory.write({ ghostId: snapshot.ghostId, path: "/me/MEMORY.md", content, expectedHash: index?.hash ?? null, actor: "host", operationId: `${id}:index`, reason: "Rebuild private memory navigation", sources: [] });
    memory.setDreamCursor(snapshot.ghostId, snapshot.through);
    memory.finishRun(id, "done", proposal.report, null);
  });
}

export interface MemoryDreamDeps {
  core: Core;
  memory: MemoryStore;
  engine: MemoryEngine;
  log: (message: string, detail?: unknown) => void;
}

/** One Host scheduler: idle only, one bounded durable model submission at a time. */
export class MemoryDreams {
  private timer?: ReturnType<typeof setInterval>;
  private stopLedger?: () => void;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private readonly requested = new Set<string>();

  constructor(private readonly deps: MemoryDreamDeps) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.stopLedger = this.deps.core.ledger.subscribe(() => this.kick());
    this.timer = setInterval(() => this.kick(), 60_000);
    this.timer.unref?.();
    this.kick();
  }

  request(ghostId: string): void {
    const ghost = this.deps.core.ledger.ghost(ghostId);
    if (ghost.deletedAt !== null || ghost.state !== "active") throw new CommandError("invalid", "memory consolidation needs an active Ghost");
    if (this.closed) throw new CommandError("unavailable", "memory consolidation is closed");
    this.requested.add(ghostId);
    this.kick();
  }

  isBusy(): boolean { return this.active !== null; }
  waitForIdle(): Promise<void> { return this.active ?? Promise.resolve(); }

  private idle(): boolean {
    return !this.deps.core.ledger.conversations().some((conversation) => conversation.busy);
  }

  private kick(): void {
    if (this.closed || this.active || !this.idle()) return;
    this.active = this.tick().catch((error) => this.deps.log("memory: consolidation scheduling failed", error)).finally(() => { this.active = null; });
  }

  private async tick(): Promise<void> {
    const { core, memory, engine } = this.deps;
    // Engine owns/cancels catch-up on shutdown. Do not make dream shutdown await all history.
    void engine.catchUpMemory().catch((error) => this.deps.log("memory: historical catch-up failed", error));
    if (this.closed || !this.idle()) return;
    const now = Date.now();
    const lastActivity = core.ledger.conversations().reduce((at, conversation) => Math.max(at, conversation.lastActivityAt), 0);
    for (const ghost of core.ledger.ghosts()) {
      if (ghost.deletedAt !== null || ghost.state !== "active") continue;
      if (!engine.memoryStatus(ghost.id).ready) continue;
      const after = memory.dreamCursor(ghost.id);
      if (memory.historySeq(ghost.id) <= after) { this.requested.delete(ghost.id); continue; }
      const runs = memory.runs(ghost.id);
      const interrupted = runs.find((run) => run.state === "running");
      const latest = runs.reduce<(typeof runs)[number] | undefined>((last, run) => !last || run.startedAt > last.startedAt ? run : last, undefined);
      if (!interrupted && latest?.state === "failed" && now - (latest.endedAt ?? latest.startedAt) < BACKOFF) continue;
      if (!interrupted && runs.filter((run) => run.startedAt >= now - DAY).length >= 4) continue;
      const lastDone = runs.filter((run) => run.state === "done").reduce((at, run) => Math.max(at, run.endedAt ?? run.startedAt), 0);
      const settledNewWork = core.ledger.worksSettledSince(lastDone, 200).some((work) => work.ghostId === ghost.id && (work.endedAt ?? 0) > lastDone);
      const due = interrupted || this.requested.has(ghost.id) || (now - lastActivity >= IDLE_DELAY && (now - (latest?.endedAt ?? latest?.startedAt ?? 0) >= MIN_INTERVAL || settledNewWork));
      if (!due) continue;
      const model = core.ledger.settings().memoryModel ?? core.ledger.settings().defaultModel;
      if (!model) continue;
      const snapshot = memorySnapshot(memory, ghost.id, after, interrupted?.through);
      if (!snapshot.history.length) continue;
      const through = snapshot.through;
      const id = interrupted?.id ?? `memory:${digestOf({ ghostId: ghost.id, after, through, versions: snapshot.versions, previousRun: latest?.id ?? null })}`;
      const startedAt = interrupted?.startedAt ?? now;
      if (!interrupted) memory.startRun({ id, ghostId: ghost.id, state: "running", startedAt, endedAt: null, through, report: "", error: null });
      this.requested.delete(ghost.id);
      this.controller = new AbortController();
      const timeout = setTimeout(() => this.controller?.abort(new Error("memory consolidation deadline exceeded")), 90_000);
      const stop = core.ledger.subscribe(() => { if (!this.idle()) this.controller?.abort(new Error("owner work became active")); });
      try {
        const result = await engine.dreamMemory({ id, snapshot, model, startedAt }, this.controller.signal);
        if (this.controller.signal.aborted || this.closed || !this.idle()) throw new Error("memory consolidation cancelled");
        commitProposal(memory, id, result.snapshot, result.output);
      } catch (error) {
        memory.finishRun(id, "failed", "No memory changes committed; cursor retained.", error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timeout);
        stop();
        this.controller = null;
      }
      return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.stopLedger?.();
    this.controller?.abort(new Error("Host is shutting down"));
    await this.active;
  }
}
