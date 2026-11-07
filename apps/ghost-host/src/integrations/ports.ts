import type { Decision, Space, Work } from "@ghost/contract";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Builds the Pi execution environment of a work conversation. Implemented in src/sandbox. */
export interface SandboxEnvFactory {
  /** Environment whose filesystem root is the Work's workspace (`/workspace` inside a container). */
  envFor(work: Work): Promise<ExecutionEnv>;
  /** Host path of the Work's workspace directory; created on demand. */
  workspacePath(work: Work): string;
  /** Copy accepted child artifacts into `inputs/<child-id>/<name>` of the workspace. Refuses tampered bytes. */
  stageInputs(work: Work, inputs: { childId: string; name: string; digest: string }[]): Promise<void>;
}

export interface MemoryHit {
  text: string;
  source: string;
  score: number | null;
}

/** Oxibrain personal memory, scoped per Ghost. Implemented in src/integrations/memory.ts. */
export interface MemoryPort {
  /** True when the Ghost has a mapped memory space and the engine is reachable. */
  available(ghostId: string): boolean;
  search(ghostId: string, query: string, limit: number): Promise<MemoryHit[]>;
  recall(ghostId: string, query: string, tokenBudget: number): Promise<{ text: string; sources: string[] }>;
  /** Store untrusted source text; never a fact or preference by itself. */
  retain(ghostId: string, text: string, origin: { conversationId: string; workId: string | null }): Promise<{ id: string }>;
}

export interface PageMeta {
  pageId: string;
  locator: string;
  title: string;
  profile: string;
}

export interface Page extends PageMeta {
  body: string;
  /** Hash of the current bytes; required to propose an edit. */
  hash: string;
}

export interface DocumentProposal {
  spaceId: string;
  title: string;
  body: string;
  /** `pdc-markdown/1` by default, `pdc-html/1` when authored HTML matters. */
  profile: string;
  /** Present for an edit of an existing page. */
  pageId: string | null;
  expectedHash: string | null;
}

/** PDC document vaults registered as Spaces. Implemented in src/integrations/documents.ts. */
export interface DocumentsPort {
  /** Spaces the Ghost may read, with its mode. */
  spacesFor(ghostId: string): { space: Space; mode: "read" | "propose" }[];
  listPages(spaceId: string, query: string | null): Promise<PageMeta[]>;
  readPage(spaceId: string, ref: { pageId?: string; locator?: string }): Promise<Page>;
  /** Validate a proposal without writing; throws when it can never apply (stale hash, bad profile). */
  check(proposal: DocumentProposal): Promise<void>;
  /** Write an approved `document_review` decision's proposal. Returns a line for the Ghost. */
  apply(decision: Decision): Promise<string>;
  /** Owner edit from the UI: same checks and atomic write as `apply`, returns the saved page. */
  save(proposal: DocumentProposal): Promise<Page>;
}
