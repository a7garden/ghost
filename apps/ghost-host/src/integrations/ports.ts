import type { Decision, Space, Work } from "@ghost/contract";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Builds the Pi execution environment of a work conversation. Implemented in src/sandbox. */
export interface SandboxEnvFactory {
  /**
   * Environment whose filesystem root is the Work's workspace (`/workspace` inside a container).
   * `review` gives the reviewer its own container over the same files, read-only.
   */
  envFor(work: Work, options?: { review?: boolean }): Promise<ExecutionEnv>;
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

/** Program classes the owner allowed for a Ghost's Mac commands (GhostPermissions.host). */
export interface HostCommandPolicy {
  /** Shells and interpreters; their arguments may then carry shell syntax. */
  interpreters: boolean;
  /** sudo, ssh, launchctl and similar. */
  privileged: boolean;
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
/** One agent-browser answer: `--json` output's `data`, or the CLI's error text. */
export type BrowserReply = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * The owner's browser (`agent-browser`), one browser per Ghost over that Ghost's sign-in profile.
 * Every call names the conversation's tab; calls for one Ghost run one after another because the
 * daemon has a single active tab and refs belong to it.
 */
export interface BrowserPort {
  /** Run one agent-browser command in the conversation's tab, creating the tab when it is missing. */
  run(ghostId: string, tab: string, args: string[]): Promise<BrowserReply>;
  /** Several commands in the conversation's tab within one turn of the Ghost's queue (re-resolving a target, then acting). */
  exclusive<T>(ghostId: string, tab: string, body: (run: (args: string[]) => Promise<BrowserReply>) => Promise<T>): Promise<T>;
  /** A fresh file path for a screenshot; the caller reads and removes it. */
  scratchPath(extension: string): string;
  /** Write a one-shot grant the credential plugin consumes; returns its token (the `auth login` name). */
  grantLogin(grant: { itemId: string; origin: string }): string;
  /** Remove a grant the plugin did not consume; a consumed one is already gone. */
  revokeGrant(token: string): void;
  /** Close tabs whose conversation no longer needs a browser. */
  closeTabs(ghostId: string, keep: (tab: string) => boolean): Promise<void>;
  /** Whether vault sign-in is configured (a Shade CLI path). */
  readonly vault: boolean;
}

export interface HostPort {
  status(): Promise<HostStatus>;
  services(): Promise<HostServices>;
  nodes(): Promise<HostNodes>;
  diskScan(): Promise<unknown>;
  diskUsage(path: string): Promise<unknown>;
  list(path: string): Promise<unknown>;
  read(path: string): Promise<unknown>;
  /** `policy` widens the program rules to what the owner granted the Ghost; absent = the conservative rules. */
  validateCommand(input: HostCommand, policy?: HostCommandPolicy): HostCommand;
  executeCommand(input: HostCommand, policy?: HostCommandPolicy): Promise<{ exitCode: number | null; output: string; timedOut: boolean; truncated: boolean }>;
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
