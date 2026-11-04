// Public SDK observations only. Marking a generation that owns several inputs
// would cancel all of them; waiting enables the entire Harness scheduler.
export function originalGenerationAbortTarget(view, inspection, submissionId, conversationId) {
  const run = view?.docs?.['pi.live']?.run;
  if (!run || !Array.isArray(run.inputs) || run.inputs.length !== 1 || run.inputs[0] !== submissionId
    || !Number.isSafeInteger(run.taskId) || run.taskId < 1) return null;
  const task = inspection.tasks.find(({ record }) => record.id === run.taskId && record.kind === 'pi.generation'
    && record.conversationId === conversationId && record.state.status !== 'terminal');
  if (!task) return null;
  const inbox = view.docs?.['pi.inbox']?.items;
  const tools = view.docs?.['pi.live']?.tools;
  const isolated = inspection.scheduling === 'paused' && inspection.tasks.length === 1
    && inspection.submissions.length === 1 && inspection.submissions[0].id === submissionId
    && inspection.submissions[0].conversationId === conversationId && inspection.submissions[0].status === 'placed'
    && Array.isArray(inbox) && inbox.length === 0 && (tools === undefined || Array.isArray(tools) && tools.length === 0)
    && ['prepare', 'request'].includes(task.record.state.checkpoint?.phase);
  return { taskId: run.taskId, isolated };
}
