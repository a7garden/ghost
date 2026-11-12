import { Type } from "typebox";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { forbidden } from "../core/errors.ts";
import { errorResult, requireAllowed } from "./shared.ts";

export function createSubagentTools(core: Core): Extension {
  return defineExtension({ name: "ghost.subagent", tools: [defineTool({
    name: "subagent_run",
    description: "Run an independent read-only research helper and await its final answer. Helpers cannot mutate state, run shell commands, create Works or spawn helpers. Parallel calls run independently. Supply only the read tools the task needs.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 24000 }),
      tools: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 })),
      max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      max_tokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 64000 })),
    }),
    replay: "safe",
    executionMode: "parallel",
    async execute(args, api, context) {
      try {
        const scope = requireAllowed(core, api, "subagent_run");
        if (!["direct", "wake", "work"].includes(scope.conversation.kind)) throw forbidden("subagent_run is available only in direct, wake and work conversations");
        if (!core.engine.runSubagent) throw forbidden("the engine does not support subagents");
        const result = await core.engine.runSubagent(scope.conversation.id, args, api, context);
        return { content: [{ type: "text", text: result }] };
      } catch (error) { return errorResult(error); }
    },
  })] });
}
