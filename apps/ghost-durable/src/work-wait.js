import { defineTask } from "@earendil-works/pi-durable";
import { payloadDigest } from "./contract.js";
import { callbackCommandId } from "./host-transport.js";

const unknown = () => ({ status: "error", summary: "The exact original Work wait could not be reconciled. Stop and inspect its receipt.", error_code: "pi_wait_unconfirmed", retry_class: "never", artifacts: [], next_actions: [] });
export function workWaitBody(request) {
  return { method: "work.wait", ...request.arguments, assignment_id: request.assignment_id, generation_task_id: request.generation_task_id,
    ...(request.work_memory_context_revision === undefined ? {} : { work_memory_context_revision: request.work_memory_context_revision }) };
}
export function verifiedWorkWaitReceipt(receipt, request) {
  return Boolean(receipt && receipt.kind === "pi-work-wait/1"
    && receipt.assignment_id === request.assignment_id && receipt.work_id === request.work_id
    && receipt.generation_task_id === request.generation_task_id && receipt.goal_revision === request.wait_goal_revision
    && Number.isSafeInteger(receipt.owner_revision) && receipt.owner_revision > 0
    && Number.isSafeInteger(receipt.authority_epoch) && receipt.authority_epoch > 0
    && receipt.wait_command_id === callbackCommandId(request.ghost_id, request.conversation_id, request.invocation_id, "work.wait")
    && receipt.wait_payload_digest === payloadDigest(workWaitBody(request))
    && JSON.stringify(receipt.wait_for) === JSON.stringify(request.arguments.wait_for)
    && (receipt.execution_id === null || typeof receipt.execution_id === "string" && receipt.execution_id.length > 0));
}
export function validateWorkWaitProjection(projection, request) {
  if (projection == null) return null;
  if (!["waiting", "resolved"].includes(projection.phase) || !verifiedWorkWaitReceipt(projection.receipt, request)) throw new Error("Original Work wait projection changed or is unknown");
  return projection;
}
// The child is committed before its first Host dispatch. It can only replay the
// original internal wait transaction and inspect that exact durable receipt.
export function createWorkWaitTask({ dispatch, validate, pollMs = 1000, doc }) {
  const terminal=async(task,runtime,result,context)=>runtime.commit(async tx=>{
    if(doc && result?.error_code==="pi_wait_unconfirmed") {
      const run=await tx.doc(doc,runtime.conversationId);
      if(run.assignment_id===task.input.request.assignment_id) run.wait_failed=task.input.request.invocation_id;
    }
    return {status:"terminal",outcome:{status:"completed",result}};
  },context);
  return defineTask({ name: "ghost.pi.work-wait", version: 1, initial: () => ({ phase: "admit" }), phases: {
    admit: async (task, runtime, context) => {
      try { await validate(task.input.request); } catch {
        await terminal(task,runtime,unknown(),context); return;
      }
      try {
        const result = await dispatch(task.input.request, context);
        if (result?.status !== "success" || !verifiedWorkWaitReceipt(result.data?.wait_receipt, task.input.request)) {
          await terminal(task,runtime,unknown(),context); return;
        }
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "poll", receipt: result.data.wait_receipt } }), context);
      } catch(error) {
        if(error?.code==="host_callback_rejected") {await terminal(task,runtime,unknown(),context);return;}
        // A missing ACK cannot authorize another identity. Reconcile only this
        // original safe internal transaction after a durable sleep checkpoint.
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "retry", until: runtime.now() + pollMs } }), context);
      }
    },
    retry: async (task, runtime, context) => {
      await runtime.sleep(task.state.checkpoint.until, context);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "admit" } }), context);
    },
    poll: async (task, runtime, context) => {
      let result;
      try {
        await validate(task.input.request);
        const r = task.state.checkpoint.receipt;
        result = await dispatch({ ...task.input.request, method: "work.wait.inspect", invocation_id: `${task.input.request.invocation_id}:inspect`,
          arguments: { wait_command_id: r.wait_command_id, wait_payload_digest: r.wait_payload_digest, wait_for: r.wait_for } }, context);
        if (result?.status !== "success" || !verifiedWorkWaitReceipt(result.data?.wait_receipt, task.input.request)
          || JSON.stringify(result.data.wait_receipt) !== JSON.stringify(r)) throw Error("Wait receipt mismatch");
        if (result.data.phase === "waiting") {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "sleep", receipt: r, until: runtime.now() + pollMs } }), context); return;
        }
        if (result.data.phase !== "resolved") throw Error("Wait is not resolved");
      } catch { result = unknown(); }
      await terminal(task,runtime,result,context);
    },
    sleep: async (task, runtime, context) => {
      await runtime.sleep(task.state.checkpoint.until, context);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "poll", receipt: task.state.checkpoint.receipt } }), context);
    },
  }, abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context) });
}
export async function waitForWork({ api, task, request, context, doc }) {
  const childId = await api.commit(async tx => {
    const run = await tx.doc(doc, api.conversationId);
    if (run.assignment_id !== request.assignment_id || String(run.generation_task_id) !== String(request.generation_task_id)) throw Error("Wait generation changed");
    let cursor, matches = [];
    do {
      const page = await tx.scanTasks({ conversationId: api.conversationId, kind: task.definition.name }, 100, cursor);
      matches.push(...page.items.filter(record => record.owner === api.taskId && record.input?.request?.invocation_id === request.invocation_id)); cursor = page.next;
    } while (cursor);
    if (matches.length > 1) throw Error("Duplicate original Work waiter");
    if (matches.length === 1) {
      if (JSON.stringify(matches[0].input.request) !== JSON.stringify(request)) throw Error("Original Work wait input changed");
      return matches[0].id;
    }
    run.wait_intent = request;
    return tx.createTask(task, { request }, { ownership: { kind: "task", taskId: api.taskId } });
  }, context);
  const settled = await api.waitForTask(childId, context);
  return settled.state.outcome.status === "completed" ? settled.state.outcome.result : unknown();
}
