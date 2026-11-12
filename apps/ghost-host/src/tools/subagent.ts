import { Type } from "typebox";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { forbidden } from "../core/errors.ts";
import { errorResult, scopeOf } from "./shared.ts";

/** Explicitly read-only built-ins. A tool declaring safe replay is not proof that it is a read. */
export const SUBAGENT_READ_TOOLS: Readonly<Record<string, true>> = {
  web_search: true, web_read: true, reach: true, document_scopes: true, document_list: true, document_read: true, skill_read: true,
  source_list: true, source_check: true, host_status: true, host_services: true, host_disk_scan: true, host_disk_usage: true,
  host_list: true, host_read: true, host_nodes: true, memory_search: true, memory_read: true,
};
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
        const scope = scopeOf(core, api);
        if (!["direct", "wake", "work"].includes(scope.conversation.kind)) throw forbidden("subagent_run is available only in direct, wake and work conversations");
        if (!core.engine.runSubagent) throw forbidden("the engine does not support subagents");
        const result = await core.engine.runSubagent(scope.conversation.id, args, api, context);
        return { content: [{ type: "text", text: result }] };
      } catch (error) { return errorResult(error); }
    },
  })] });
}
