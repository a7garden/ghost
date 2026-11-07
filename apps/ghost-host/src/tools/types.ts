import type { Conversation, Ghost, Work } from "@ghost/contract";
import type { Extension } from "@earendil-works/pi-durable";

/** The model-facing capability of each conversation kind. Implemented in src/tools/index.ts. */
export interface ToolSet {
  /** Every extension, installed once in the engine's registry. */
  all(): Extension[];
  /** Extensions a conversation selects; decided by its kind and the Ghost's grants. */
  extensionsFor(conversation: Conversation, ghost: Ghost, work: Work | null): Extension[];
  /** Kind instructions rendered after the persona: what this conversation is for and how its tools behave. */
  instructionsFor(conversation: Conversation, ghost: Ghost, work: Work | null): string;
}
