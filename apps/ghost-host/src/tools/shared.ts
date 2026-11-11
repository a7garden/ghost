import type { Conversation, Ghost, GhostTool, Work } from "@ghost/contract";
import { Type } from "typebox";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { CommandError, forbidden, invalid, notFound } from "../core/errors.ts";
import { NoEffect } from "../core/effects.ts";
import { idFor } from "../core/ids.ts";
import { NotFound } from "../ledger/ledger.ts";

/** What one tool call is bound to. Resolved from the ledger row of the calling conversation, never from model arguments. */
export interface Scope {
  conversation: Conversation;
  ghost: Ghost;
  work: Work | null;
}

/** The conversation kinds each selectable tool runs in; `Record<GhostTool, …>` stays exhaustive over the contract list. */
const TOOL_KINDS: Record<GhostTool, readonly Conversation["kind"][]> = {
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
  document_spaces: ["direct", "work"],
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
export function requireAllowed(core: Core, api: ToolExecutionApi, name: GhostTool): Scope {
  const scope = scopeOf(core, api);
  if (!TOOL_KINDS[name].includes(scope.conversation.kind)) throw forbidden(`${name} does not run in a ${scope.conversation.kind} conversation`);
  if (!scope.ghost.tools.includes(name)) throw forbidden(`${name} is not enabled for ${scope.ghost.name}; if the goal needs it, ask once with capability_request (tools: ["${name}"]) and end your turn`);
  if (scope.work?.toolScope && !scope.work.toolScope.includes(name)) throw forbidden(`${name} is outside this Work's activity rule, which only the owner changes; do the step with another tool or report it in complete`);
  if (scope.work?.execution?.kind === "host" && ["read", "write", "edit", "bash", "publish_artifact"].includes(name) && !scope.ghost.hostExecution) throw forbidden("direct PC execution was revoked by the owner");
  if (scope.work && scope.ghost.state !== "active") throw forbidden("the executing Ghost is no longer active");
  if (scope.work && !["running", "waiting"].includes(scope.work.state)) throw forbidden(`Work is ${scope.work.state}`);
  if (scope.work && scope.work.deadlineAt !== null && scope.work.deadlineAt <= Date.now()) throw forbidden("Work deadline has passed");
  if (scope.work?.activityId) core.activities.authorize(scope.work.id, name);
  return scope;
}

/** Resolve the calling conversation from the Pi conversation id the harness puts on every call. */
export function scopeOf(core: Core, api: ToolExecutionApi): Scope {
  const conversation = core.ledger.conversationByPiId(String(api.conversationId));
  if (!conversation) throw notFound(`conversation ${api.conversationId} is not in the ledger`);
  const ghost = core.ledger.ghost(conversation.ghostId);
  if (ghost.deletedAt !== null) throw forbidden(`${ghost.name} was deleted`);
  const work = conversation.workId ? core.ledger.work(conversation.workId) : null;
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
  if (root.originConversationId !== scope.conversation.id) throw forbidden("this Work does not originate from this conversation");
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
