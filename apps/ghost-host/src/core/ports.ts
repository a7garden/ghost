import type {
  ArtifactRef,
  Conversation,
  Ghost,
  Live,
  LiveEvent,
  Message,
  MessageOrigin,
  Sandbox,
  Work,
} from "@ghost/contract";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { MemoryEngine } from "../memory/types.ts";

/** What the engine needs to run one conversation. Built by core from ledger rows. */
export interface ConversationSetup {
  conversation: Conversation;
  ghost: Ghost;
  /** The Work this conversation executes (work) or judges (review). */
  work: Work | null;
}

export interface Submission {
  text: string;
  origin: MessageOrigin;
  /** Deterministic; a repeated id is a no-op, which makes every wake crash-safe. */
  requestId: string;
  attachments?: ArtifactRef[];
  /** Resolve only after checking the durable submission identity, so retries survive deletion. */
  spaceIds?: string[];
  /** Join the running turn instead of queueing a follow-up. */
  steer?: boolean;
}

export interface TranscriptPage {
  messages: Message[];
  before: string | null;
  live: Live | null;
}

/** Pi Durable, seen from core. Implemented in src/engine. */
export interface Engine extends Partial<MemoryEngine> {
  /** Create the conversation if missing and (re)apply its agent: model, instructions, tools. Idempotent. */
  open(setup: ConversationSetup): Promise<void>;
  submit(conversationId: string, submission: Submission): Promise<void>;
  /** Stop the current run and withdraw queued inputs. */
  abort(conversationId: string): Promise<void>;
  page(conversationId: string, before: string | null, limit: number): Promise<TranscriptPage>;
  watch(conversationId: string, listener: (event: LiveEvent) => void): () => void;
  status(): { ready: boolean; detail: string };
  /** Append imported history without running the model. Only for `ghost import` into a fresh conversation. */
  appendHistory(conversationId: string, messages: { role: "user" | "assistant"; text: string; at: number }[]): Promise<void>;
  /** Resume interrupted runs after startup. */
  resume(): void;
  close(): Promise<void>;
}

/** How the engine says a run ended. */
export interface RunEnd {
  /** True when the last model error was a provider quota: a condition to wait out, not a Ghost stopping. */
  quota: boolean;
}

/** What the engine reports back to core. */
export interface EngineEvents {
  /** A conversation started or finished a run. `idle` fires after the run settled and its outputs are committed. */
  activity(conversationId: string, busy: boolean, at: number, ended?: RunEnd): void;
}

/** Content-addressed bytes under `artifacts/sha256/`. */
export interface ArtifactStore {
  put(bytes: Uint8Array, name: string, mediaType: string): Promise<ArtifactRef>;
  read(digest: string, maxBytes?: number): Promise<Uint8Array>;
  size(digest: string): Promise<number>;
  has(digest: string): boolean;
  path(digest: string): string;
}

export interface SandboxControl {
  status(ghostId: string): Sandbox;
  control(ghostId: string, action: "stop" | "reset"): Promise<void>;
}

/**
 * Provider credentials, stored outside the ledger. Extends pi-ai's app-owned
 * `CredentialStore`: `read`/`list`/`modify`/`delete` are the canonical async
 * API that pi-ai `Models` uses (OAuth refresh runs single-flight inside
 * `modify`), while `credential`/`has`/`get`/`put` are Ghost's synchronous
 * helpers. `put`/`delete` replace the stored credential and invalidate any
 * in-flight `modify` publication, so an owner-side replacement can never be
 * overwritten by a stale refresh.
 */
export interface Secrets extends CredentialStore {
  /** Synchronous read of the stored credential (model construction). */
  credential(providerId: string): Credential | undefined;
  /** Whether a valid credential — API key or OAuth — exists. */
  has(providerId: string): boolean;
  /** API key only; OAuth credentials return null. */
  get(providerId: string): string | null;
  /** Replace the credential with an API key (null deletes). */
  put(providerId: string, apiKey: string | null): void;
}
