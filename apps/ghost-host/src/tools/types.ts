import type { Conversation, DocRef, Ghost, Work } from "@ghost/contract";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/** The model-facing capability of each conversation kind. Implemented in src/tools/index.ts. */
export interface ToolSet {
  /** Every extension, installed once in the engine's registry. */
  all(): Extension[];
  /** Extensions a conversation selects; decided by its kind and the Ghost's grants. */
  extensionsFor(conversation: Conversation, ghost: Ghost, work: Work | null): Extension[];
  /** Refresh the live catalog and select bounded deferred definitions before a turn. */
  prepare?(conversation: Conversation, ghost: Ghost, work: Work | null, extensions: Extension[]): Promise<Extension[]>;
  /** Install newly searched definitions in the current conversation without changing grants. */
  bindLoader?(load: (piId: number, tools: ToolRegistration[]) => Promise<void>): void;
  contextFor?(conversation: Conversation, ghost: Ghost, work: Work | null, scopeId?: string | null, attachments?: DocRef[]): Promise<string>;
  /** Kind instructions rendered after the persona: what this conversation is for and how its tools behave. */
  instructionsFor(conversation: Conversation, ghost: Ghost, work: Work | null): string;
}
