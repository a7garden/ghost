import type { Decision, Space, VaultItem, Work } from "@ghost/contract";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Builds the Pi execution environment of a work conversation. Implemented in src/sandbox. */
export interface SandboxEnvFactory {
  /** Environment whose filesystem root is the Work's workspace (`/workspace` inside a container). */
  envFor(work: Work): Promise<ExecutionEnv>;
  /** Host path of the Work's workspace directory; created on demand. */
  workspacePath(work: Work): string;
  /** Copy accepted child artifacts into `inputs/<child-id>/<name>` of the workspace. Refuses tampered bytes. */
  stageInputs(work: Work, inputs: { childId: string; name: string; digest: string }[]): Promise<void>;
  /** Free a settled Work's compute (its container); the workspace stays. */
  release(work: Work): Promise<void>;
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

/** One result entry of an `agent-reach` invocation. All fields come from untrusted web content. */
export interface ReachItem {
  title: string | null;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  text: string | null;
}

export interface ReachError {
  code: string;
  message: string;
  hint: string | null;
}

/** One normalized `agent-reach` invocation. `ok:false` carries `error`; `ok:true` carries `items`. */
export interface ReachResult {
  ok: boolean;
  channel: string | null;
  action: string | null;
  items: ReachItem[];
  error: ReachError | null;
}

export interface ReachChannel {
  name: string;
  actions: { name: string }[];
}

/** Read-only web research through the installed `agent-reach` CLI. Implemented in src/integrations/reach.ts. */
export interface ReachPort {
  /** The host-side deadline in seconds; the tools clamp the CLI's own `--timeout` to it. */
  readonly timeoutSeconds: number;
  /** `agent-reach web search <query> --limit <limit>`. */
  search(query: string, limit: number): Promise<ReachResult>;
  /** `agent-reach read <url>`. The caller must have vetted the URL against the SSRF guard. */
  read(url: string): Promise<ReachResult>;
  /** `agent-reach <channel> <action> ...args`. The caller must have validated channel/action against the catalog. */
  run(channel: string, action: string, args: string[]): Promise<ReachResult>;
  /** The channel/action catalog the CLI reports (`agent-reach channels`); cached after the first call. */
  catalog(): Promise<ReachChannel[]>;
}

export interface HostCommand {
  title: string;
  reason: string;
  program: string;
  args: string[];
  cwd: string;
  risk: string;
}

export interface HostStatus {
  collectedAt: number;
  disks: { path: string; volumeId?: string; totalBytes: number; freeBytes: number; pressure: "healthy" | "pressure" | "critical" }[];
  ramBytes: number;
  memoryFreePct: number | null;
  cores: number;
  loadAverage: number[];
  topProcesses: { name: string; cpuPct: number }[];
  listeningPortCount: number;
  warnings: string[];
}

export interface HostServices {
  services: { label: string; state: "running" | "loaded" | "unloaded" | "unknown"; lastExit: number | null }[];
  failed: HostServices["services"];
  partial: boolean;
}

export interface HostNodes {
  nodes: { name: string; online: boolean; os: string; lastSeen: string | null }[];
  healthWarnings: string[];
  error: string | null;
}

/** Owner-enabled, guarded Mac probes; callers cannot supply an arbitrary probe command. */
export interface HostPort {
  status(): Promise<HostStatus>;
  services(): Promise<HostServices>;
  nodes(): Promise<HostNodes>;
  diskScan(): Promise<unknown>;
  diskUsage(path: string): Promise<unknown>;
  list(path: string): Promise<unknown>;
  read(path: string): Promise<unknown>;
  validateCommand(input: HostCommand): HostCommand;
  executeCommand(input: HostCommand): Promise<{ exitCode: number | null; output: string; timedOut: boolean; truncated: boolean }>;
}

/** The owner's skill folders, read-only. Implemented in src/integrations/skills.ts. */
export interface SkillsPort {
  /** Skills across the configured roots, first root wins on duplicate names; cached briefly. */
  catalog(): { name: string; description: string }[];
  /** A skill's SKILL.md without its frontmatter, or null when the skill is missing or unreadable. */
  body(name: string): string | null;
  /** Relative file paths of a skill, files only, dotfiles skipped. */
  list(name: string): string[];
  /** One skill file as UTF-8 text, bounded. */
  readFile(name: string, relPath: string): string;
}

/** A secret field of a vault item. Values flow host → page only; no tool result carries one. */
export type VaultField = "username" | "password" | "totp" | "card_number" | "card_expiry" | "card_cvc" | "card_name" | "value";

/** Fields whose fill needs an owner-approved effect each time (money moves through them). */
export const APPROVAL_FIELDS: readonly VaultField[] = ["card_number", "card_expiry", "card_cvc", "card_name"];

/**
 * The Ghost vault: encrypted items, per-Ghost grants, write-only secrets. Implemented in src/stores/vault.ts.
 * `reveal` is host-internal (the browser fill path); its value must never enter a tool result, log, event or effect row.
 */
export interface VaultPort {
  /** Metadata of the items a Ghost may use, optionally narrowed to an origin (exact canonical match) or kind. */
  listFor(ghostId: string, filter?: { origin?: string; kind?: VaultItem["kind"] }): VaultItem[];
  /** One item's metadata if the Ghost may use it; throws forbidden/not_found otherwise. */
  itemFor(ghostId: string, itemId: string): VaultItem;
  /** The secret value of one field, for filling into a page. Throws when not granted, expired or absent. */
  reveal(ghostId: string, itemId: string, field: VaultField, at?: number): string;
  /** Reuse a granted exact-origin/username login, otherwise generate one within the per-Ghost creation quota. Never returns the password. */
  generateLogin(ghostId: string, input: { origin: string; username: string; title?: string; hints?: string }): VaultItem;
}

/** The conversation whose browser session a command runs in; logins persist per Ghost. */
export interface BrowserSessionRef {
  ghostId: string;
  conversationId: string;
}

/** One normalized agent-browser `--json` response. Page-derived strings in `data` are untrusted. */
export interface BrowserCommandResult {
  ok: boolean;
  data: unknown;
  error: string | null;
}

/**
 * Host-side Chrome through the installed agent-browser CLI, behind the host's egress proxy (no loopback,
 * private, link-local or tailnet destinations, including page-issued requests). Implemented in src/integrations/browser.ts.
 */
export interface BrowserPort {
  /** One command in the conversation's session. Secret material may only travel through `stdin`. */
  run(session: BrowserSessionRef, argv: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<BrowserCommandResult>;
  /** Reopen the session in a visible window (same Ghost login state) at `url` so the owner can act. */
  handoff(session: BrowserSessionRef, url: string | null): Promise<void>;
  /** End the visible window after the owner is done; the next command starts headless with the saved state. */
  endHandoff(session: BrowserSessionRef): Promise<void>;
  /** Close the conversation's session; the Ghost's login state is saved. */
  close(session: BrowserSessionRef): Promise<void>;
  /** Stop every session and the egress proxy (host shutdown). */
  shutdown(): Promise<void>;
}
