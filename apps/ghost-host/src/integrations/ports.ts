import type { Decision, ExecutionTarget, Scope, VaultItem, Work } from "@ghost/contract";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
export type { McpPort, McpTool, McpCallResult } from "./mcp.ts";

/** Builds the Pi execution environment of a work conversation. Implemented in src/sandbox. */
export interface SandboxEnvFactory {
  /** Uses the explicit Work target: real PC cwd for Host; otherwise the private workspace. */
  envFor(work: Work, authorize?: () => string): Promise<ExecutionEnv>;
  /** Private staging directory, never the Host target cwd; browser transfers stay confined here. */
  workspacePath(work: Work): string;
  /** Copy accepted child artifacts into `inputs/<child-id>/<name>` of the workspace. Refuses tampered bytes. */
  stageInputs(work: Work, inputs: { childId: string; name: string; digest: string }[]): Promise<void>;
  /** Abort a settled Work's Host processes or free its container; staging and owner files stay. */
  release(work: Work): Promise<void>;
  /** Confined reviewer environment (read-only view of the Work, writable scratch, no network). */
  reviewEnvFor?(work: Work, conversationId: string): ExecutionEnv;
  /** Admission-time validation of an execution target beyond its static shape. */
  validateExecution?(target: ExecutionTarget): void;
  /** Whether this Work's shell reaches any network: the egress proxy or an unconfined local shell. A network-none container does not. */
  shellEgress?(work: Work): boolean;
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
  scopeId: string;
  title: string;
  body: string;
  /** `pdc-markdown/1` by default, `pdc-html/1` when authored HTML matters. */
  profile: string;
  /** Present for an edit of an existing page. */
  pageId: string | null;
  expectedHash: string | null;
}

/** PDC document vaults registered as Scopes. Implemented in src/integrations/documents.ts. */
export interface DocumentsPort {
  /** Every active Ghost may read and propose to every registered Scope. */
  scopesFor(ghostId: string): Scope[];
  listPages(scopeId: string, query: string | null): Promise<PageMeta[]>;
  readPage(scopeId: string, ref: { pageId?: string; locator?: string }): Promise<Page>;
  /** Validate a proposal without writing; throws when it can never apply (stale hash, bad profile). */
  check(proposal: DocumentProposal): Promise<void>;
  /** Write an approved `document_review` decision's proposal. Returns a line for the Ghost. */
  apply(decision: Decision, authorize: () => void): Promise<string>;
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

/** One incoming Messages row containing a verification code. */
export interface MessageVerificationCode {
  code: string;
  sender: string;
  service: string;
  receivedAt: number;
  excerpt: string;
}

/** Owner-enabled, guarded Mac probes; callers cannot supply an arbitrary probe command. */
export interface HostPort {
  status(): Promise<HostStatus>;
  services(): Promise<HostServices>;
  nodes(): Promise<HostNodes>;
  diskScan(): Promise<unknown>;
  diskUsage(path: string): Promise<unknown>;
  list(path: string): Promise<unknown>;
  read(path: string, offset?: number, limit?: number): Promise<unknown>;
  /** Read incoming verification codes from Messages; dbPath is injectable for tests. */
  messageCodes(input: { dbPath?: string; withinMinutes: number; senderContains?: string }): Promise<{ codes: MessageVerificationCode[] }>;
  /** Runs an eligible inspection; null means the requested command did not run and needs approval. */
  inspect(input: HostCommand, authorize?: () => void): Promise<{ exitCode: number | null; output: string; timedOut: boolean; truncated: boolean } | null>;
  validateCommand(input: HostCommand): HostCommand;
  executeCommand(input: HostCommand, authorize?: () => void): Promise<{ exitCode: number | null; output: string; timedOut: boolean; truncated: boolean }>;
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
export type VaultField = "username" | "password" | "totp" | "card_number" | "card_expiry" | "card_expiry_month" | "card_expiry_year" | "card_cvc" | "card_name" | "value";

/** Fields whose fill needs an owner-approved effect each time (money moves through them). */
export const APPROVAL_FIELDS: readonly VaultField[] = ["card_number", "card_expiry", "card_expiry_month", "card_expiry_year", "card_cvc", "card_name"];

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

export type BrowserLiveEvent =
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "page"; url: string; title: string }
  | { type: "end"; reason: string };
export type BrowserLiveInput =
  | { type: "mouse"; event: "down" | "up" | "move" | "wheel"; x: number; y: number; button?: "left" | "middle" | "right" | "none"; clickCount?: 1 | 2 | 3; deltaX?: number; deltaY?: number; modifiers?: number }
  | { type: "key"; event: "down" | "up"; key: string; code: string; text?: string; keyCode?: number; modifiers?: number }
  | { type: "text"; text: string }
  | { type: "viewport"; width: number; height: number }
  | { type: "navigate"; action: "back" | "forward" | "reload" };
export interface BrowserSessionInfo extends BrowserSessionRef { engine: "chrome" | "obscura"; headed: boolean }
export interface BrowserLogin { origin: string; username: string; password: string }

export interface BrowserHandoffEnd {
  /** The headed page URL could not be recovered; the headless session resumed at about:blank. */
  fallback: boolean;
}

export interface BrowserRunOptions {
  /** Selected only on the first open of a conversation session. */
  engine?: "chrome" | "obscura";
  stdin?: string;
  timeoutMs?: number;
  /** Rechecked after adapter waits, immediately before dispatch. */
  authorize?: () => void;
  /** Host-only ephemeral redaction registry. Never written to disk or passed in argv. */
  sensitive?: { value: string; field: VaultField; origin: string };
  /** Workspace paths never reach Chrome; the adapter stages/copies with no-follow semantics. */
  transfer?: { kind: "upload"; workspace: string; path: string } | { kind: "download"; workspace: string; name: string };
}

/**
 * Host-side browser through the installed agent-browser CLI, behind the host's egress proxy (no loopback,
 * private, link-local or tailnet destinations, including page-issued requests). Implemented in src/integrations/browser.ts.
 */
export interface BrowserPort {
  readonly supportsObscura?: boolean;
  assertVaultFill?(session: BrowserSessionRef, field: VaultField, origin: string): void;
  /** One command in the conversation's session. Secret material may only travel through `stdin`. */
  run(session: BrowserSessionRef, argv: string[], options?: BrowserRunOptions): Promise<BrowserCommandResult>;
  /** Host-only atomic issuer-field capture; protects the value from subsequent model output. */
  captureCredential(session: BrowserSessionRef, input: { origin: string; ref?: string; selector?: string }): Promise<string>;
  /** Prepare secure Chrome owner interaction; headed defaults true for the explicit Mac-window action. */
  handoff(session: BrowserSessionRef, url: string | null, options?: { headed?: boolean; authorize?: () => void }): Promise<void>;
  sessions(): BrowserSessionInfo[];
  /** Shared local screencast, owner-only. Returns an unsubscribe function. */
  live(session: BrowserSessionRef, options: { maxFps: number }, sink: (event: BrowserLiveEvent) => void): Promise<() => void>;
  input(session: BrowserSessionRef, input: BrowserLiveInput): Promise<void>;
  /** Consumed once by the next Ghost browser call. */
  takeNotice?(session: BrowserSessionRef): string | null;
  /** Keep focus and all secret writes isolated from owner input. */
  exclusive?<T>(session: BrowserSessionRef, perform: () => Promise<T>): Promise<T>;
  /** Save the headed state and reopen headless at the owner's final page before the next command. */
  endHandoff(session: BrowserSessionRef): Promise<BrowserHandoffEnd>;
  /** Close the conversation's session; the Ghost's login state is saved. */
  close(session: BrowserSessionRef, authorize?: () => void): Promise<void>;
  /** Keep sessions alive and out of eviction while `held` says an owner approval or handoff still needs them. */
  retainWhile?(held: (session: BrowserSessionRef) => boolean): void;
  /** Stop every session and the egress proxy (host shutdown). */
  shutdown(): Promise<void>;
}

/** One runtime reply. `delivered: false` only when the runtime reports the action certainly did not happen. */
export interface DesktopResult {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
  delivered: boolean;
}

/** The Ghost Control identity's macOS permissions and diagnostic HID idle time (includes synthesized input). */
export interface DesktopStatus {
  accessibility: boolean;
  screenRecording: boolean;
  idleSeconds: number;
}

/**
 * PC control through the signed Ghost Control helper, which owns the macOS privacy grant and runs agent-desktop
 * (accessibility tree, semantic actions, apps and windows) and Geist (window image, physical input). One request
 * at a time for the whole Host: there is one desktop. Implemented in src/integrations/desktop.ts.
 */
export interface DesktopPort {
  /** `authorize` runs at queue dispatch, immediately before I/O; throwing prevents delivery. */
  agentDesktop(argv: string[], options?: { stdin?: string; timeoutMs?: number; authorize?: () => void }): Promise<DesktopResult>;
  geist(tool: string, args: Record<string, unknown>, options?: { timeoutMs?: number; authorize?: () => void }): Promise<DesktopResult>;
  status(): Promise<DesktopStatus>;
  /** A PNG window image as a JPEG no larger than `maxEdge` pixels on its long side, for model input. */
  image(png: Uint8Array, maxEdge: number): Promise<{ data: string; mimeType: "image/jpeg"; width: number; height: number }>;
  shutdown(): Promise<void>;
}
