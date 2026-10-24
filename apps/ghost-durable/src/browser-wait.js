import { defineTask } from "@earendil-works/pi-durable";

const unknown = () => ({ status: "error", summary: "The original browser action could not be reconciled; stop and inspect its original receipt.", error_code: "pi_effect_unconfirmed", retry_class: "never", artifacts: [], next_actions: [] });
export function isBrowserOwnerWait(response) {
  return response?.status === "warning" && response?.data?.receipt?.state === "waiting_owner"
    && typeof response.data.action_id === "string" && response.data.action_id.length > 0 && response.data.action_id.length <= 400;
}

// A deterministic child advances only the exact Host receipt. It has no model,
// shell, browser credentials or authority to approve an action.
export function createBrowserWaitTask({ dispatch, validate, verifyReceipt, pollMs = 1000 }) {
  return defineTask({
    name: "ghost.pi.browser-owner-wait", version: 1,
    initial: () => ({ phase: "poll" }),
    phases: {
      poll: async (task, runtime, context) => {
        let response;
        try {
          await validate(task.input.request);
          response = await dispatch(task.input.request, context);
        } catch { response = unknown(); }
        if (!verifyReceipt(response, task.input.request)) response = unknown();
        if (isBrowserOwnerWait(response)) {
          if (response.data.action_id !== task.input.action_id) response = unknown();
          else {
            await runtime.commit(() => ({ status: "running", checkpoint: { phase: "sleep", until: runtime.now() + pollMs } }), context);
            return;
          }
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: response } }), context);
      },
      sleep: async (task, runtime, context) => {
        await runtime.sleep(task.state.checkpoint.until, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "poll" } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export async function waitForBrowserOwner({ api, task, input, response, context }) {
  const childId = await api.commit(async tx => {
    let cursor, matching = [];
    do {
      const page = await tx.scanTasks({ conversationId: api.conversationId, kind: task.definition.name }, 100, cursor);
      matching.push(...page.items.filter(record => record.owner === api.taskId && record.input?.request?.invocation_id === input.invocation_id));
      cursor = page.next;
    } while (cursor);
    if (matching.length > 1) throw new Error("Duplicate browser approval child identity");
    if (matching.length === 1) {
      if (JSON.stringify(matching[0].input.request) !== JSON.stringify(input) || matching[0].input.action_id !== response.data.action_id) throw new Error("Browser approval child input changed");
      return matching[0].id;
    }
    return tx.createTask(task, { request: input, action_id: response.data.action_id }, { ownership: { kind: "task", taskId: api.taskId } });
  }, context);
  const settled = await api.waitForTask(childId, context);
  return settled.state.outcome.status === "completed" ? settled.state.outcome.result : unknown();
}
