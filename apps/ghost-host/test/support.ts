import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRef, LiveEvent, Sandbox } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { sha256 } from "../src/core/ids.ts";
import type { ArtifactStore, ConversationSetup, Engine, Submission, SubmissionRecovery, TranscriptPage } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { BaseSecrets } from "../src/stores/secrets.ts";

/** Records what core asks of Pi. Deduplicates submissions by request id like Pi does. */
export class FakeEngine implements Engine {
  readonly opened: ConversationSetup[] = [];
  readonly submissions = new Map<string, { conversationId: string; submission: Submission }>();
  readonly aborted: string[] = [];
  readonly outcomes = new Map<string, SubmissionRecovery>();

  async submissionRecovery(_conversationId: string, requestId: string): Promise<SubmissionRecovery | null> {
    return this.outcomes.get(requestId) ?? (this.submissions.has(requestId)
      ? { status: "pending", entryId: 0, serving: null, hit: null }
      : null);
  }
  history: { conversationId: string; role: string; text: string }[] = [];

  async open(setup: ConversationSetup) {
    this.opened.push(setup);
  }
  async submit(conversationId: string, submission: Submission) {
    if (!this.submissions.has(submission.requestId)) this.submissions.set(submission.requestId, { conversationId, submission });
  }
  async abort(conversationId: string) {
    this.aborted.push(conversationId);
  }
  async page(): Promise<TranscriptPage> {
    return { messages: [], before: null, live: null };
  }
  watch(_conversationId: string, _listener: (event: LiveEvent) => void) {
    return () => {};
  }
  status() {
    return { ready: true, detail: "fake" };
  }
  async appendHistory(conversationId: string, messages: { role: "user" | "assistant"; text: string; at: number }[]) {
    for (const message of messages) this.history.push({ conversationId, role: message.role, text: message.text });
  }
  resume() {}
  async close() {}

  /** Submissions sent to one conversation, oldest first. */
  to(conversationId: string): Submission[] {
    return [...this.submissions.values()].filter((item) => item.conversationId === conversationId).map((item) => item.submission);
  }
}

export class MemoryArtifacts implements ArtifactStore {
  readonly bytes = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array, name: string, mediaType: string): Promise<ArtifactRef> {
    const digest = sha256(bytes);
    this.bytes.set(digest, bytes);
    return { digest, name, mediaType, size: bytes.length };
  }
  async size(digest: string): Promise<number> {
    const bytes = this.bytes.get(digest);
    if (!bytes) throw new Error(`no artifact ${digest}`);
    return bytes.byteLength;
  }
  async read(digest: string, maxBytes?: number) {
    const bytes = this.bytes.get(digest);
    if (!bytes) throw new Error(`no artifact ${digest}`);
    return maxBytes === undefined ? bytes : bytes.subarray(0, maxBytes);
  }
  has(digest: string) {
    return this.bytes.has(digest);
  }
  path(digest: string) {
    return `/memory/${digest}`;
  }
}

export class MemorySecrets extends BaseSecrets {
  protected persist() {}
}

export const noSandbox = {
  status: (ghostId: string): Sandbox => ({ ghostId, state: "none", detail: "" }),
  control: async () => {},
};

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "ghost-"));
}

/** A Core over a fresh ledger with a fake engine attached. */
export function harness(path = ":memory:", artifacts: ArtifactStore = new MemoryArtifacts()) {
  const ledger = new Ledger(path);
  const core = new Core({ ledger, artifacts, sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {} });
  const engine = new FakeEngine();
  core.attach(engine);
  return { ledger, core, engine, artifacts };
}
