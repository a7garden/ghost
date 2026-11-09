import { Type } from "typebox";
import { FallbackList, GhostState, GhostToolList, HOST_TOOLS, Look, ModelRef, SkillList, nullable, type Ghost } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { updateGhost } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { forbidden } from "../core/errors.ts";
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
      "Change another Ghost's name, persona, model, fallback models, skills, look, state or tool allow-list, and re-apply its conversations. Main Ghost only; the main designation, host tools and credentials stay with the owner.",
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
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const { target } = requireMain(core, api, args.ghost_id);
        if (target.deletedAt !== null) throw forbidden(`${target.name} was deleted`);
        // Host tools reach the owner's Mac outside the sandbox: only the owner grants or revokes them.
        if (args.tools !== undefined && HOST_TOOLS.some((tool) => args.tools!.includes(tool) !== target.tools.includes(tool))) {
          throw forbidden("host tools are granted or revoked only by the owner");
        }
        const next = updateGhost(core, target.id, {
          name: args.name,
          persona: args.persona,
          model: args.model === undefined ? undefined : args.model,
          look: args.look,
          state: args.state,
          tools: args.tools,
          fallbacks: args.fallbacks,
          skills: args.skills,
        });
        return text(`Updated.\n${renderGhost(next)}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.main", tools: [ghostInspect, ghostUpdate] });
}
