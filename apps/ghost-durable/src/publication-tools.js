import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { PUBLICATION_TOOLS, validatePublicationDescriptor } from "./publication-context.js";
function denied() { const details = { status: "error", summary: "Published source authority could not be revalidated; bytes were withheld.", error_code: "publication_context_unavailable", retry_class: "never" }; return { isError: true, content: [{ type: "text", text: JSON.stringify(details) }], details }; }
export function createPublicationTools({ hostToolTransport, ghostId, conversationId, resolveToolScope, controllerContext }) {
  return PUBLICATION_TOOLS.map(name => defineTool({ name, replay: "unsafe", executionMode: "sequential",
    parameters: name === "source_view_list" ? Type.Object({}, { additionalProperties: false }) : Type.Object({ reference: Type.String({ minLength: 1, maxLength: 400 }) }, { additionalProperties: false }),
    description: name === "source_view_list" ? "List source-view references explicitly granted to this exact Ghost and Work or Owner turn. This grants no new audience access."
      : "Read one Host-issued published source reference. Preserve its publication citation, view revision and uncertainty. The view is source evidence, has no independent support, and must not be ingested as a new fact or source family.",
    execute: async (args, api, context) => {
      try {
        const scope = await resolveToolScope(), work = scope.originKind === "goal_assignment";
        if (!["owner", "goal_assignment"].includes(scope.originKind) || scope.inferenceScope !== "local" || typeof hostToolTransport !== "function" || context?.abortSignal?.aborted) return denied();
        if (work && (controllerContext.assignment?.id !== scope.assignmentId || controllerContext.assignment?.work_id !== scope.workId)) return denied();
        await controllerContext.memoryContext.validate();
        const invocationId = `publication-${createHash("sha256").update(JSON.stringify([ghostId, conversationId, work ? scope.assignmentId : scope.turnId, api.taskId, api.callId, name])).digest("hex")}`;
        let result = await hostToolTransport({ method: name === "source_view_list" ? "memory.publication.capabilities" : "memory.publication.read", invocation_id: invocationId,
          ghost_id: ghostId, conversation_id: conversationId, ...(work ? { assignment_id: scope.assignmentId, work_id: scope.workId } : { turn_id: scope.turnId }),
          inference_scope: scope.inferenceScope, conversation_disclosure: scope.conversationDisclosure, arguments: args }, context);
        if (result?.status !== "success") return denied();
        if (name === "source_view_read") result = await controllerContext.memoryContext.publications.record({ result, scope, invocationId });
        else {
          const descriptor = validatePublicationDescriptor({ ...result.data, required: false });
          result = { status: "success", data: { version: descriptor.version, references: descriptor.references } };
        }
        if (context?.abortSignal?.aborted) return denied();
        return { isError: result?.status !== "success", content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch { return denied(); }
    },
  }));
}
