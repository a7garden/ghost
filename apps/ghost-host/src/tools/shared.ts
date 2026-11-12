import { matchToolPattern, matchesToolPatterns, type BuiltinGhostTool, type Conversation, type Ghost, type Work } from "@ghost/contract";
import { Type } from "typebox";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { CommandError, forbidden, invalid, notFound } from "../core/errors.ts";
import { NoEffect } from "../core/effects.ts";
import { idFor } from "../core/ids.ts";
import { NotFound } from "../ledger/ledger.ts";
import { markPolicyRead, policyRead } from "../core/policy-context.ts";

/** What one tool call is bound to. Resolved from the ledger row of the calling conversation, never from model arguments. */
export interface Scope {
  conversation: Conversation;
  ghost: Ghost;
  work: Work | null;
}

/** The conversation kinds each selectable tool runs in; `Record<GhostTool, …>` stays exhaustive over the contract list. */
const TOOL_KINDS: Record<BuiltinGhostTool, readonly Conversation["kind"][]> = {
  subagent_run: ["direct", "work"],
  scope_create: ["direct"], scope_update: ["direct"], scope_attach: ["direct"], scope_delete: ["direct"],
  slot_set: ["direct"], slot_delete: ["direct"], limits_set: ["direct"],
  rule_create: ["direct"], rule_update: ["direct"], rule_delete: ["direct"],
  mcp_create: ["direct"], mcp_update: ["direct"], mcp_delete: ["direct"],
  config_revert: ["direct"], config_history: ["direct"], metrics_read: ["direct"],
  rule_propose: ["direct"], goal_list: ["direct"], goal_propose: ["direct"], milestone_plan: ["direct"], milestone_update: ["direct"],
  work_create: ["direct"],
  work_list: ["direct"],
  work_inspect: ["direct"],
  work_update: ["direct"],
  work_cancel: ["direct"],
  schedule_create: ["direct"],
  schedule_list: ["direct"],
  schedule_cancel: ["direct"],
  ghost_list: ["direct"],
  activity_propose: ["direct"],
  read: ["work"],
  write: ["work"],
  edit: ["work"],
  bash: ["work"],
  publish_artifact: ["work"],
  delegate: ["work"],
  document_scopes: ["direct", "work"],
  document_list: ["direct", "work"],
  document_read: ["direct", "work"],
  document_propose: ["direct"],
  web_search: ["direct", "work"],
  web_read: ["direct", "work"],
  reach: ["direct", "work"],
  skill_read: ["direct", "work"],
  host_status: ["direct", "work"],
  host_services: ["direct", "work"],
  host_disk_scan: ["direct", "work"],
  host_disk_usage: ["direct", "work"],
  host_list: ["direct", "work"],
  host_read: ["direct", "work"],
  host_nodes: ["direct", "work"],
  host_command_propose: ["direct", "work"],
  host_message_codes: ["direct", "work"],
  browser_open: ["direct", "work"],
  browser_snapshot: ["direct", "work"],
  browser_screenshot: ["direct", "work"],
  browser_read: ["direct", "work"],
  browser_click: ["direct", "work"],
  browser_fill: ["direct", "work"],
  browser_type: ["direct", "work"],
  browser_press: ["direct", "work"],
  browser_select: ["direct", "work"],
  browser_check: ["direct", "work"],
  browser_scroll: ["direct", "work"],
  browser_navigate: ["direct", "work"],
  browser_tabs: ["direct", "work"],
  browser_wait: ["direct", "work"],
  // Files move only through a Work's sandbox workspace.
  browser_upload: ["work"],
  browser_download: ["work"],
  browser_propose: ["direct", "work"],
  browser_handoff: ["direct", "work"],
  browser_fill_secret: ["direct", "work"],
  browser_fill_card: ["direct", "work"],
  browser_close: ["direct", "work"],
  vault_list: ["direct", "work"],
  vault_request: ["direct", "work"],
  vault_generate_login: ["direct", "work"],
  connection_list: ["direct", "work"],
  connection_register: ["direct", "work"],
  connection_request: ["direct", "work"],
  desktop_apps: ["direct", "work"],
  desktop_snapshot: ["direct", "work"],
  desktop_screenshot: ["direct", "work"],
  desktop_click: ["direct", "work"],
  desktop_fill: ["direct", "work"],
  desktop_type: ["direct", "work"],
  desktop_select: ["direct", "work"],
  desktop_check: ["direct", "work"],
  desktop_scroll: ["direct", "work"],
  desktop_press: ["direct", "work"],
  desktop_launch: ["direct", "work"],
  desktop_focus: ["direct", "work"],
  desktop_wait: ["direct", "work"],
  desktop_pointer: ["direct", "work"],
  desktop_keys: ["direct", "work"],
  desktop_propose: ["direct", "work"],
  mail_search: ["direct", "work"],
  mail_read: ["direct", "work"],
  mail_update: ["direct", "work"],
  mail_send: ["direct", "work"],
  toss_read: ["direct", "work"],
};

/**
 * Execution-time authorization for a selectable tool: resolve the caller from the ledger now, then
 * require conversation kind ∩ the Ghost's persisted allow-list. A call configured before a revocation
 * still passes through here before any effect, so revocation stops even in-flight stale calls.
 */
export function requireAllowed(core: Core, api: Pick<ToolExecutionApi, "conversationId"> & Partial<Pick<ToolExecutionApi, "callId">>, name: string): Scope {
  const scope = scopeOf(core, api);
  const kind = scope.conversation.kind === "wake" ? "direct" : scope.conversation.kind;
  const kinds = TOOL_KINDS[name as BuiltinGhostTool] ?? (/^(mcp|conn)\./.test(name) ? ["direct", "work", "subagent"] : []);
  if (kind === "subagent") {
    if (!SUBAGENT_READ_TOOLS[name] && !name.startsWith("mcp.") && !name.startsWith("conn.")) throw forbidden(`${name} is not read-only`);
    const selected = core.ledger.setting<string[]>(`subagent:tools:${scope.conversation.id}`, []);
    if (!selected.includes(name)) throw forbidden(`${name} was not selected for this subagent`);
  } else if (!kinds.includes(kind)) throw forbidden(`${name} does not run in a ${scope.conversation.kind} conversation`);
  if (!matchesToolPatterns(scope.ghost.tools, name)) throw forbidden(`${name} is not enabled for ${scope.ghost.name}; if the goal needs it, ask once with capability_request (tools: ["${name}"]) and end your turn`);
  if (!workAllowsTool(core, scope.work, name)) throw forbidden(`${name} is outside this Work's activity rule, which only the owner changes; do the step with another tool or report it in complete`);
  if (scope.work?.execution?.kind === "host" && ["read", "write", "edit", "bash", "publish_artifact"].includes(name) && !scope.ghost.hostExecution) throw forbidden("direct PC execution was revoked by the owner");
  if (scope.work && scope.ghost.state !== "active") throw forbidden("the executing Ghost is no longer active");
  if (scope.work && !["running", "waiting"].includes(scope.work.state)) throw forbidden(`Work is ${scope.work.state}`);
  if (scope.work && scope.work.deadlineAt !== null && scope.work.deadlineAt <= Date.now()) throw forbidden("Work deadline has passed");
  if (scope.work?.activityId) core.activities.authorize(scope.work.id, name);
  const externalRead = ["web_search", "web_read", "reach", "browser_open", "browser_snapshot", "browser_screenshot", "browser_read", "mail_search", "mail_read"].includes(name);
  const privateRead = name.startsWith("host_") || name.startsWith("vault_") || name.startsWith("mail_") || name.startsWith("desktop_") || ["toss_read", "browser_fill_secret", "browser_fill_card"].includes(name);
  if (externalRead || privateRead) markPolicyRead(core, scope.conversation.id, { untrustedInput: externalRead || name.startsWith("desktop_"), privateData: privateRead });
  if (!name.startsWith("browser_") && !name.startsWith("mail_") && (externalRead || ["host_status", "host_services", "host_disk_scan", "host_disk_usage", "host_list", "host_read", "host_nodes", "host_message_codes", "vault_list", "desktop_apps", "desktop_snapshot", "desktop_screenshot", "toss_read"].includes(name))) {
    if (!api.callId) throw forbidden("Read authorization requires its logical tool call id");
    policyRead(core, scope.conversation.id, { tool: name, target: { kind: name.startsWith("web_") || name === "reach" ? "browser_origin" : name.startsWith("host_") || name.startsWith("desktop_") ? "mac" : name === "toss_read" ? "connection" : "host", id: null }, access: "read", reversible: true, external: externalRead, amount: null }, api.callId);
  }
  return scope;
}

/** Each delegation may narrow its scope, never erase a live ancestor's boundary. */
export function workAllowsTool(core: Core, work: Work | null, name: string, prefix = false): boolean {
  let current = work;
  let depth = 0;
  while (current) {
    if (++depth > 256) return false;
    if (current.toolScope && !current.toolScope.some(pattern => matchToolPattern(pattern, name, prefix))) return false;
    current = current.parentId ? core.ledger.work(current.parentId) : null;
  }
  return true;
}

export const SUBAGENT_READ_TOOLS: Readonly<Record<string, true>> = Object.fromEntries(["web_search", "web_read", "reach", "document_scopes", "document_list", "document_read", "skill_read", "source_list", "source_check", "host_read", "host_list", "host_search", "host_status", "host_services", "host_disk_scan", "host_disk_usage", "host_nodes", "memory_search", "memory_read", "connection_list", "toss_read"].map(name => [name, true]));

/** Resolve the calling conversation from the Pi conversation id the harness puts on every call. */
export function scopeOf(core: Core, api: Pick<ToolExecutionApi, "conversationId">): Scope {
  const conversation = core.ledger.conversationByPiId(String(api.conversationId));
  if (!conversation) throw notFound(`conversation ${api.conversationId} is not in the ledger`);
  const ghost = core.ledger.ghost(conversation.ghostId);
  if (ghost.deletedAt !== null) throw forbidden(`${ghost.name} was deleted`);
  let work = conversation.workId ? core.ledger.work(conversation.workId) : null;
  if (conversation.kind === "subagent") {
    const parentId = core.ledger.setting<string | null>(`subagent:parent:${conversation.id}`, null);
    if (!parentId || ghost.state !== "active") throw forbidden("Subagent authority is unavailable");
    const parent = core.ledger.conversation(parentId);
    if (parent.ghostId !== ghost.id || !["direct", "wake", "work"].includes(parent.kind)) throw forbidden("Subagent parent authority changed");
    work = parent.workId ? core.ledger.work(parent.workId) : null;
  }
  return { conversation, ghost, work };
}

export function requireWork(scope: Scope): Scope & { work: Work } {
  if (scope.conversation.kind !== "work" || !scope.work) throw forbidden("only a work conversation can do this");
  return scope as Scope & { work: Work };
}

export function requireReview(scope: Scope): Scope & { work: Work } {
  if (scope.conversation.kind !== "review" || !scope.work) throw forbidden("only a review conversation can do this");
  return scope as Scope & { work: Work };
}

/** A Work whose root was created in this conversation: the tree a direct conversation owns. */
export function requireOrigin(core: Core, scope: Scope, workId: string): Work {
  const work = core.ledger.work(workId);
  const root = work.rootId === work.id ? work : core.ledger.work(work.rootId);
  let originId = scope.conversation.id;
  if (scope.conversation.kind === "wake") {
    const ownerId = core.ledger.setting<string | null>(`wake:owner:${scope.conversation.id}`, null);
    const context = core.ledger.setting<{ scopeId: string | null } | null>(`context:${scope.conversation.id}`, null);
    if (!ownerId || !context) throw forbidden("this wake has no trusted owner and scope binding");
    const owner = core.ledger.conversation(ownerId);
    if (owner.kind !== "direct" || owner.ghostId !== scope.ghost.id || root.scopeId !== context.scopeId) throw forbidden("this Work is outside the wake's owner or scope");
    originId = ownerId;
  }
  if (root.originConversationId !== originId) throw forbidden("this Work does not originate from this conversation");
  return work;
}

const errorText = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Map a refusal to an error result carrying its message. Unknown errors keep the harness's error path. */
export function errorResult(error: unknown): ToolExecutionResult {
  if (error instanceof CommandError || error instanceof NoEffect || error instanceof NotFound) return errorText(error.message);
  throw error;
}

/** First line of a longer text, for titles and one-line summaries. */
export function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? text).slice(0, 200);
}

/** One compact line for a list of Work. */
export function describeWorkLine(core: Core, work: Work): string {
  const assignee = core.ledger.ghost(work.ghostId).name;
  const owner = work.parentId === null ? "" : ` [child of ${work.parentId}]`;
  const deadline = work.deadlineAt === null ? "" : ` due ${new Date(work.deadlineAt).toISOString()}`;
  return `- ${work.title} (${work.id}) — ${work.state}${owner} · ${assignee}${deadline}`;
}

/**
 * A question as the owner's card reads it: the first line is the heading, the rest the context under it.
 * 2026-11-10: the whole question used to be the detail too, so the heading printed twice.
 */
export function splitQuestion(question: string): { title: string; detail: string } {
  const [first = "", ...rest] = question.trim().split("\n");
  const title = firstLine(first).trim();
  // A first line cut at 200 characters keeps the whole text below, so nothing is lost.
  if (title.length < first.trim().length) return { title, detail: question.trim() };
  return { title, detail: rest.join("\n").trim() };
}

/**
 * The origin settles a Work the Host paused: `extend` grants one more execution budget (budget pause),
 * `continue` clears a repeated-failure stop, `stop` cancels it. Splitting is stop plus new, smaller
 * delegations, so it needs no action of its own. Only the conversation the Work came from may call it.
 */
export function workDecideTool(core: Core) {
  return defineTool({
    name: "work_decide",
    description:
      "Settle a Work paused by the Host: extend its execution budget once (action 'extend'), continue after a repeated tool failure was stopped (action 'continue'), or stop it (action 'stop'). " +
      "Works report here when they settle; a paused Work waits for exactly this call. To split, stop it and delegate the remainder as smaller Works.",
    parameters: Type.Object({
      work_id: Type.String({ minLength: 1, maxLength: 128, description: "The paused Work's id" }),
      action: Type.Union([Type.Literal("extend"), Type.Literal("continue"), Type.Literal("stop")]),
      note: Type.Optional(Type.String({ maxLength: 2048, description: "One line of why, for the record and the stopped Work's reason" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = scopeOf(core, api);
        const work = scope.conversation.kind === "wake" ? requireOrigin(core, scope, args.work_id) : core.ledger.work(args.work_id);
        if (scope.conversation.kind === "wake" ? work.parentId !== null : work.originConversationId !== scope.conversation.id) throw forbidden("only the conversation this Work came from settles it");
        if (scope.ghost.state !== "active") throw forbidden("the originating Ghost is no longer active");
        if (work.activityId && !work.parentId) throw forbidden("only the owner resumes a paused activity root");
        if (scope.work) {
          requireWork(scope);
          if (!["running", "waiting"].includes(scope.work.state)) throw forbidden("the origin Work is no longer active");
          if (scope.work.activityId) core.activities.authorize(scope.work.id);
        }
        const next = core.works.decide(work.id, args.action, args.note);
        return {
          content: [{ type: "text", text: `Work "${next.title}" is ${next.state}.` }],
          ...(next.state === "cancelled" ? { control: { terminate: true } } : {}),
        } satisfies ToolExecutionResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}

/** `ask_owner` behaves identically in direct and work conversations. */
export function askOwnerTool(core: Core) {
  return defineTool({
    name: "ask_owner",
    description:
      "Ask the owner a question; the answer arrives as a new message. Use it when a decision is theirs, not yours. " +
      "The owner reads it on a phone card, in Korean unless they write otherwise: the first line is the question itself in one short plain sentence (it becomes the card's heading); " +
      "the following lines give only the context needed to decide (Markdown lists welcome, no ids, paths, tool names or JSON). " +
      "Each option is one complete, self-explanatory answer of a few words, mutually exclusive. " +
      "Set recommended to the option you would pick: the owner sees it first, and if the choice is reversible the main Ghost or the Host may take it when the owner does not answer in time. Leave recommended out when the choice spends money, sends something, deletes, or only the owner can know.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 8192, description: "First line: the question. Following lines: context." }),
      options: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 8, description: "Suggested answers, each a short complete choice" })),
      recommended: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "The option you recommend; must be one of options" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = scopeOf(core, api);
        if (scope.work?.activityId) core.activities.authorize(scope.work.id, "ask_owner");
        const { title, detail } = splitQuestion(args.question);
        const options = args.options ?? [];
        if (args.recommended !== undefined && !options.includes(args.recommended)) throw invalid("recommended must be one of options");
        const proposal = args.recommended ? { review: { recommend: "answer", answer: args.recommended, expiresAt: null } } : null;
        const decision = core.decisions.ask(scope.conversation.id, title, detail, options, idFor(scope.conversation.id, api.callId), proposal);
        return {
          content: [{ type: "text", text: `The owner was asked (${decision.id}). Their answer arrives as a message.` }],
        } satisfies ToolExecutionResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
