import { Type } from "typebox";
import { ADAPTATION_MAX_CHARS, CAPABILITY_DECLINE, CAPABILITY_GRANT, GhostToolList, HOST_TOOLS, type CapabilityRequest, type GhostTool } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { forbidden, invalid } from "../core/errors.ts";
import { idFor } from "../core/ids.ts";
import { errorResult, scopeOf, type Scope } from "./shared.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

/**
 * 2026-11-10 owner decision: a Ghost shared from elsewhere meets an environment that differs a little. It does not
 * wait for someone to fix it: it finds what works, records it, and asks for a missing capability instead of failing.
 */
export const ADAPT_INSTRUCTIONS = `Adapt to this environment. Your persona and skills may have been written for a different setup. When a path, a command form, a tool or a site does not behave the way you expected, work out what does work and finish the goal with it — do not repeat a failing call. Then record the working way with self_adapt (your full notes: short, concrete, about this environment, never secrets), so you start there next time.
When you lack a tool or PC execution that the goal genuinely needs, ask for it once with capability_request and a one-line reason, then end your turn; the answer arrives as a message and granted tools are yours from the next step. A refusal that names what is allowed tells you the way that works; take it instead of retrying.`;

function requireActive(scope: Scope, name: string): void {
  if (scope.conversation.kind === "review") throw forbidden(`${name} does not run in a review conversation`);
  if (scope.ghost.state !== "active") throw forbidden(`${scope.ghost.name} is ${scope.ghost.state}`);
}

/** Fixed in direct and work conversations: a Ghost's own notes and its way to ask for what it lacks. */
export function createSelfTools(core: Core): Extension {
  const selfAdapt = defineTool({
    name: "self_adapt",
    description:
      "Rewrite your notes about working in this owner's environment: what works here (paths, command forms, tools, sites, habits) where it differs from your persona or skills. " +
      "Send the complete new notes, not a diff; your current notes are in your instructions. Keep only what changes how you work; never secrets. Notes do not change your tools.",
    parameters: Type.Object({
      notes: Type.String({ maxLength: ADAPTATION_MAX_CHARS, description: "Your full notes after this change; empty clears them" }),
      reason: Type.String({ minLength: 1, maxLength: 500, description: "What happened that made this change worth keeping, in the owner's language" }),
    }),
    replay: "safe",
    async execute(args, api) {
      try {
        const scope = scopeOf(core, api);
        requireActive(scope, "self_adapt");
        const saved = core.adaptations.set(scope.ghost.id, args.notes, "self", args.reason, scope.conversation.id);
        return text(saved.notes ? `Saved (revision ${saved.revision}); your next conversations start from these notes.` : "Cleared your notes.");
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const capabilityRequest = defineTool({
    name: "capability_request",
    description:
      "Ask for tools you lack or for PC execution (Works that run directly on the owner's Mac), when the goal genuinely needs them. " +
      "The main Ghost or the owner decides; their answer arrives as a message and granted tools are yours from your next step. Ask once, then end your turn instead of retrying.",
    parameters: Type.Object({
      tools: Type.Optional(GhostToolList),
      host_execution: Type.Optional(Type.Boolean({ description: "PC execution: Works of yours may run files and shell on the owner's Mac" })),
      reason: Type.String({ minLength: 1, maxLength: 1000, description: "What you need it for, in one or two plain sentences in the owner's language" }),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = scopeOf(core, api);
        requireActive(scope, "capability_request");
        const ghost = scope.ghost;
        const tools = (args.tools ?? []).filter((tool) => !ghost.tools.includes(tool));
        const hostExecution = args.host_execution === true && !ghost.hostExecution;
        if (tools.length === 0 && !hostExecution) {
          const scoped = (args.tools ?? []).filter((tool) => scope.work?.toolScope && !scope.work.toolScope.includes(tool));
          if (scoped.length > 0) throw invalid(`you already hold ${scoped.join(", ")}; this Work's activity rule leaves them out, and only the owner changes that rule`);
          throw invalid(args.tools?.length || args.host_execution ? "you already hold everything you asked for; if a call is still refused, read the refusal: it names what is allowed" : "name the tools or host_execution you need");
        }
        const pending = core.ledger.pendingDecisions().find((decision) => {
          const asked = decision.proposal?.capability as CapabilityRequest | undefined;
          return decision.conversationId === scope.conversation.id && asked?.ghostId === ghost.id && tools.every((tool) => asked.tools.includes(tool)) && (!hostExecution || asked.hostExecution);
        });
        if (pending) return text(`You already asked for this (${pending.id}); the answer arrives as a message. End your turn or continue with what you can do now.`);
        const request: CapabilityRequest = { ghostId: ghost.id, tools, hostExecution };
        const labels = [...(hostExecution ? ["PC 직접 실행"] : []), ...tools];
        const opensMac = hostExecution || tools.some((tool) => (HOST_TOOLS as readonly GhostTool[]).includes(tool));
        const decision = core.decisions.ask(
          scope.conversation.id,
          `${ghost.name}에게 ${labels.join(", ")} 허용`.slice(0, 200),
          [args.reason.trim(), opensMac ? "허용하면 이 Ghost가 소유자의 Mac에서 파일·명령을 다룰 수 있습니다. 설정 › Ghost에서 언제든 되돌릴 수 있습니다." : "설정 › Ghost에서 언제든 되돌릴 수 있습니다."].join("\n\n"),
          [CAPABILITY_GRANT, CAPABILITY_DECLINE],
          idFor(scope.conversation.id, api.callId),
          { capability: request, review: { recommend: "answer", answer: CAPABILITY_GRANT, expiresAt: null } },
        );
        return text(`Asked (${decision.id}). The answer arrives as a message; end your turn now or continue with what you can do without it.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.self", tools: [selfAdapt, capabilityRequest] });
}
