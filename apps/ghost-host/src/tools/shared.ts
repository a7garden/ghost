import type { Conversation, Ghost, GhostTool, Work } from "@ghost/contract";
import { Type } from "typebox";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { CommandError, forbidden, notFound } from "../core/errors.ts";
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
  read: ["work"],
  write: ["work"],
  edit: ["work"],
  bash: ["work"],
  publish_artifact: ["work"],
  delegate: ["work"],
  memory_search: ["direct", "work"],
  memory_recall: ["direct", "work"],
  memory_retain: ["direct", "work"],
  document_spaces: ["direct"],
  document_list: ["direct"],
  document_read: ["direct"],
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
};

/**
 * Execution-time authorization for a selectable tool: resolve the caller from the ledger now, then
 * require conversation kind ∩ the Ghost's persisted allow-list. A call configured before a revocation
 * still passes through here before any effect, so revocation stops even in-flight stale calls.
 */
export function requireAllowed(core: Core, api: ToolExecutionApi, name: GhostTool): Scope {
  const scope = scopeOf(core, api);
  if (!TOOL_KINDS[name].includes(scope.conversation.kind)) throw forbidden(`${name} does not run in a ${scope.conversation.kind} conversation`);
  if (!scope.ghost.tools.includes(name)) throw forbidden(`${name} is not enabled for ${scope.ghost.name}`);
  return scope;
}

/** Resolve the calling conversation from the Pi conversation id the harness puts on every call. */
export function scopeOf(core: Core, api: ToolExecutionApi): Scope {
  const conversation = core.ledger.conversationByPiId(String(api.conversationId));
  if (!conversation) throw notFound(`conversation ${api.conversationId} is not in the ledger`);
  const ghost = core.ledger.ghost(conversation.ghostId);
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

/** `ask_owner` behaves identically in direct and work conversations. */
export function askOwnerTool(core: Core) {
  return defineTool({
    name: "ask_owner",
    description: "Ask the owner a question; the answer arrives as a new message. Use it when a decision is theirs, not yours.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 8192 }),
      options: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 8, description: "Suggested answers" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = scopeOf(core, api);
        const decision = core.decisions.ask(scope.conversation.id, firstLine(args.question), args.question, args.options ?? [], idFor(scope.conversation.id, api.callId));
        return {
          content: [{ type: "text", text: `The owner was asked (${decision.id}). Their answer arrives as a message.` }],
        } satisfies ToolExecutionResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
