import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { ProtocolError } from "./contract.js";
import { memoryQueryProperties } from "./memory-query.js";
export const WORK_MEMORY_METHODS = Object.freeze({ work_memory_recall: "work.memory.recall", work_memory_record: "work.memory.record" });
export const WORK_MEMORY_TOOLS = Object.freeze(Object.keys(WORK_MEMORY_METHODS));
export function validateWorkMemoryDescriptor(value) {
  if (value === undefined || value === null) return { available_tools: [], required: false, status: "unconfigured" };
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["available_tools", "context_revision", "required", "status", "reason"].includes(key))
    || !Array.isArray(value.available_tools) || new Set(value.available_tools).size !== value.available_tools.length
    || value.available_tools.some(name => !WORK_MEMORY_TOOLS.includes(name)) || typeof value.required !== "boolean"
    || typeof value.status !== "string" || value.status.length > 100 || (value.reason !== undefined && value.reason !== null && (typeof value.reason !== "string" || value.reason.length > 1000))
    || (value.context_revision !== undefined && (typeof value.context_revision !== "string" || !/^[a-f0-9]{64}$/u.test(value.context_revision)))
    || (value.available_tools.length > 0 && (!["ready", "requires_live_authentication"].includes(value.status) || value.context_revision === undefined))) {
    throw new ProtocolError("work_memory_descriptor_invalid", "Host Work memory capability descriptor is invalid.", "never");
  }
  return { ...value, available_tools: [...value.available_tools] };
}
function denied(summary) { const details = { status: "error", summary, error_code: "work_memory_unavailable", retry_class: "never", artifacts: [], next_actions: ["Inspect the exact Work grant and original receipt. Do not use Owner memory or another Work as fallback."] }; return { isError: true, content: [{ type: "text", text: JSON.stringify(details) }], details }; }
export function createWorkMemoryTools({ hostToolTransport, ghostId, conversationId, resolveToolScope, controllerContext }) {
  const schemas = {
    work_memory_recall: Type.Object({ query: Type.String({ maxLength: 8192 }), token_budget: Type.Optional(Type.Integer({ minimum: 128, maximum: 2048 })), ...memoryQueryProperties() }, { additionalProperties: false }),
    work_memory_record: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 16384 }), limitations: Type.String({ maxLength: 8192 }), artifact_digests: Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), { minItems: 1, maxItems: 8, uniqueItems: true }) }, { additionalProperties: false }),
  };
  return WORK_MEMORY_TOOLS.map(name => defineTool({ name, parameters: schemas[name], replay: "unsafe", executionMode: "sequential",
    description: name === "work_memory_recall" ? "Recall only this Work's explicitly granted shared evidence. Optional as_of/known_at are integer epoch milliseconds; temporal requests default to memory only and documents temporal filters return unsupported. Preserve evidence and abstain when absent. Owner/private memory is never a fallback."
      : "Propose a bounded generated experience candidate linked to this Work's actual published artifact digests. Host derives provenance, verification and PDC outbox; this never records personal facts or directly ingests a memory session.",
    execute: async (args, api, context) => {
      let scope; try { scope = await resolveToolScope(); } catch { return denied("Work memory authority is unavailable; no request was sent."); }
      const assignment = controllerContext.assignment;
      if (scope.originKind !== "goal_assignment" || assignment?.id !== scope.assignmentId || assignment?.work_id !== scope.workId
        || !assignment.workMemory?.available_tools.includes(name) || typeof hostToolTransport !== "function" || context?.abortSignal?.aborted) return denied("This exact Work has no current capability for the memory operation; no request was sent.");
      if ((name === "work_memory_recall" && Buffer.byteLength(args.query, "utf8") > 8192)
        || (name === "work_memory_record" && (Buffer.byteLength(args.summary, "utf8") > 16384 || Buffer.byteLength(args.limitations, "utf8") > 8192))) return denied("Work memory text exceeds its UTF-8 budget; no request was sent.");
      const invocationId = JSON.stringify(["ghost-work-memory/1", ghostId, conversationId, scope.assignmentId, scope.workId, api.taskId, api.callId]);
      try {
        await controllerContext.memoryContext.validate();
        if (name === "work_memory_record") await controllerContext.memoryContext.beginWorkEffect(scope, invocationId);
        let result = await hostToolTransport({ method: WORK_MEMORY_METHODS[name], invocation_id: invocationId, ghost_id: ghostId, conversation_id: conversationId,
          assignment_id: scope.assignmentId, work_id: scope.workId, inference_scope: scope.inferenceScope, conversation_disclosure: scope.conversationDisclosure, arguments: args }, context);
        result = await controllerContext.memoryContext.recordWork({ name, result, api, invocationId, scope });
        if (name === "work_memory_record" && (result?.status === "success" || result?.host_effect_class === "no_effect")) await controllerContext.memoryContext.settleWorkEffect(scope, invocationId);
        return { isError: result?.status === "error", content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch { return denied("The Work memory result or experience receipt could not be authorized; bytes were withheld. Reconcile the original invocation instead of creating a replacement effect."); }
    },
  }));
}
