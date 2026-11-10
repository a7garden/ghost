import { Type } from "typebox";
import { FallbackList, GhostState, GhostToolList, HOST_TOOLS, Look, ModelRef, SkillList, nullable, type Ghost } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { updateGhost } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { forbidden, invalid } from "../core/errors.ts";
import { errorResult, scopeOf, type Scope } from "./shared.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

/** The target's full configuration, structured so the caller can inspect and edit it faithfully. */
function renderGhost(ghost: Ghost): string {
  return JSON.stringify(
    {
      id: ghost.id,
      name: ghost.name,
      state: ghost.state,
      model: ghost.model,
      look: ghost.look,
      tools: ghost.tools,
      fallbacks: ghost.fallbacks,
      skills: ghost.skills,
      persona: ghost.persona,
      directConversationId: ghost.directConversationId,
      createdAt: ghost.createdAt,
      updatedAt: ghost.updatedAt,
    },
    null,
    2,
  );
}

/**
 * Resolve the caller and the target of a main-only management call, straight from the ledger at
 * execution time: the caller must be the current main Ghost — direct conversation, isDefault,
 * active — and the target must be another, non-default Ghost. A stale main loses authority here
 * the moment the owner designates another Ghost, without any replay or caller-chosen identity.
 */
function requireMain(core: Core, api: ToolExecutionApi, targetId: string): Scope & { target: Ghost } {
  const scope = scopeOf(core, api);
  if (scope.conversation.kind !== "direct") throw forbidden("ghost_inspect and ghost_update run only in a direct conversation");
  if (!scope.ghost.isDefault) throw forbidden("only the current main Ghost may inspect or update other Ghosts");
  if (scope.ghost.state !== "active") throw forbidden(`${scope.ghost.name} is ${scope.ghost.state}`);
  const target = core.ledger.ghost(targetId);
  if (target.id === scope.ghost.id) throw forbidden("a Ghost cannot manage itself; its own settings belong to the owner");
  if (target.isDefault) throw forbidden("the main designation stays with the owner");
  return { ...scope, target };
}

/** `ghost_inspect` and `ghost_update`: main-only, never selectable, never granted to work or review conversations. */
export function createMainTools(core: Core): Extension {
  const ghostInspect = defineTool({
    name: "ghost_inspect",
    description: "Show another Ghost's full configuration: name, persona, look, model, state and tool allow-list. Main Ghost only.",
    parameters: Type.Object({
      ghost_id: Type.String({ minLength: 1, description: "The Ghost to inspect" }),
    }),
    replay: "safe",
    async execute(args, api) {
      try {
        const { target } = requireMain(core, api, args.ghost_id);
        return text(renderGhost(target));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const ghostUpdate = defineTool({
    name: "ghost_update",
    description:
      "Change another Ghost's name, persona, model, fallback models, skills, look, state, tool allow-list (host tools included) or direct PC execution, and re-apply its conversations. Main Ghost only; the main designation and credentials stay with the owner. Grant PC execution or host tools only when a concrete task needs them; the owner is told about every such grant.",
    parameters: Type.Object({
      ghost_id: Type.String({ minLength: 1, description: "The Ghost to update" }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      persona: Type.Optional(Type.String({ maxLength: 8192 })),
      model: Type.Optional(nullable(ModelRef)),
      look: Type.Optional(Look),
      state: Type.Optional(GhostState),
      tools: Type.Optional(GhostToolList),
      fallbacks: Type.Optional(FallbackList),
      skills: Type.Optional(SkillList),
      host_execution: Type.Optional(Type.Boolean({ description: "Allow Works of this Ghost to run directly on the owner's Mac (files and shell under the owner's account)" })),
      self_directed: Type.Optional(Type.Boolean({ description: "Whether this Ghost wakes on its own plans (plan_next) without the owner writing" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const { target, ...scope } = requireMain(core, api, args.ghost_id);
        if (target.deletedAt !== null) throw forbidden(`${target.name} was deleted`);
        const granted = [
          ...(args.host_execution === true && !target.hostExecution ? ["PC 직접 실행"] : []),
          ...HOST_TOOLS.filter((tool) => args.tools?.includes(tool) && !target.tools.includes(tool)),
        ];
        // The Mac is the owner's: the main Ghost may open it to a teammate, but never silently —
        // the grant and its notification commit together.
        const next = core.ledger.tx(() => {
          const updated = updateGhost(core, target.id, {
            name: args.name,
            persona: args.persona,
            model: args.model === undefined ? undefined : args.model,
            look: args.look,
            state: args.state,
            tools: args.tools,
            fallbacks: args.fallbacks,
            skills: args.skills,
            hostExecution: args.host_execution,
          });
          if (args.self_directed !== undefined) core.autonomy.setEnabled(target.id, args.self_directed);
          if (granted.length > 0) {
            core.notify({
              id: `grant:${scope.conversation.id}:${api.callId}`,
              kind: "message",
              ghostId: scope.ghost.id,
              conversationId: scope.conversation.id,
              workId: scope.work?.id ?? null,
              decisionId: null,
              title: `${updated.name}에게 ${granted.join(", ")} 허용`,
              body: `${scope.ghost.name}이(가) 작업에 필요해 허용했습니다. 설정 › Ghost에서 되돌릴 수 있습니다.`,
            });
          }
          return updated;
        });
        return text(`Updated.\n${renderGhost(next)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // 2026-11-10 owner decision: the main may settle another Ghost's reversible decisions for the owner.
  // The Host decides what is reversible (Decisions.reversible); sending, spending, card entry and deletion stay with the owner.
  const decisionSettle = defineTool({
    name: "decision_settle",
    description:
      "Settle another Ghost's reversible decision for the owner (it arrives as a [Decision review] message): approve, deny or answer it, or leave it for the owner with your recommendation. " +
      "Write note in the owner's language: one sentence the owner reads about what you decided and why. Main Ghost only; the Host refuses anything that is not reversible.",
    parameters: Type.Object({
      decision_id: Type.String({ minLength: 1, maxLength: 128 }),
      outcome: Type.Union([Type.Literal("approve"), Type.Literal("deny"), Type.Literal("answer"), Type.Literal("leave")]),
      answer: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "The answer, for a question" })),
      note: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = scopeOf(core, api);
        if (scope.conversation.kind !== "direct" || !scope.ghost.isDefault || scope.ghost.state !== "active") throw forbidden("only the current main Ghost may settle decisions for the owner");
        if (args.outcome === "answer" && !args.answer) throw invalid("answer is required to answer a question");
        return text(await core.decisions.settleForOwner(scope.ghost.id, args.decision_id, { outcome: args.outcome, answer: args.answer, note: args.note }));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.main", tools: [ghostInspect, ghostUpdate, decisionSettle] });
}
