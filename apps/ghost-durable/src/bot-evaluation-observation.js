import { createHash } from "node:crypto";

// Model-facing metadata only. The complete Host receipt remains ToolResult.details;
// the producer's immutable evaluation inputs are not a second Owner observation.
export function botEvaluationObservation(receipt) {
  if (!["success", "warning"].includes(receipt?.status)) return receipt;
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
  const project = (value, fields) => Object.fromEntries(fields.flatMap(([key, valid]) =>
    valid(value?.[key]) ? [[key, value[key]]] : []));
  const text = value => typeof value === "string";
  const nullableText = value => value === null || text(value);
  const revision = value => Number.isSafeInteger(value) && value > 0;
  const data = project(receipt.data, [
    ["candidate_id", text], ["candidate_digest", text], ["state", text],
    ["activation_requested", value => typeof value === "boolean"],
    ["evaluation_goal_id", nullableText], ["evaluation_work_id", nullableText],
  ]);
  if (receipt.data?.goal && typeof receipt.data.goal === "object") {
    data.goal = project(receipt.data.goal, [["id", text], ["revision", revision], ["state", text]]);
  }
  if (receipt.data?.work && typeof receipt.data.work === "object") {
    data.work = project(receipt.data.work, [["id", text], ["goal_id", text], ["goal_revision", revision],
      ["owner_revision", revision], ["state", text], ["execution_id", nullableText]]);
  }
  return {
    status: receipt.status,
    summary: typeof receipt.summary === "string" ? receipt.summary : "Host evaluation receipt; inspect its retained metadata before further action.",
    next_actions: strings(receipt.next_actions),
    artifacts: Array.isArray(receipt.artifacts) ? receipt.artifacts.map(artifact => project(artifact,
      [["digest", text], ["locator", text], ["privacy", text], ["producing_attempt", text]])) : [],
    ...project(receipt, [["error_code", nullableText], ["retry_class", text]]),
    object_refs: strings(receipt.object_refs),
    data,
  };
}
// Only the exact requirements already supplied by the fresh authenticated
// assignment may be replaced in the model view. Ambiguous/foreign receipts pass
// through unchanged; this is neither authority validation nor a new receipt.
export function assignmentGoalObservation(receipt, { scope, assignment, args, ghostId, conversationId } = {}) {
  const goal = receipt?.data?.goal;
  if (receipt?.status !== "success" || scope?.originKind !== "goal_assignment"
    || typeof assignment?.id !== "string" || assignment.id !== scope.assignmentId
    || assignment.ghost_id !== ghostId || assignment.conversation_id !== conversationId
    || assignment.work_id !== scope.workId || assignment.goal_id !== scope.goalId
    || assignment.goal_revision !== scope.goalRevision || args?.goal_id !== assignment.goal_id
    || goal?.id !== assignment.goal_id || goal.revision !== assignment.goal_revision
    || goal.accountable_ghost !== ghostId || goal.reply_conversation !== conversationId
    || typeof assignment.prompt !== "string" || goal.prompt !== assignment.prompt) return receipt;
  const { prompt, ...observedGoal } = goal;
  return { ...receipt, data: { ...receipt.data, goal: observedGoal,
    supplied_requirements: { kind: "ghost.assignment-requirements/1", source: "current_assignment.requirements",
      assignment_id: assignment.id, goal_id: assignment.goal_id, goal_revision: assignment.goal_revision,
      work_id: assignment.work_id, sha256: createHash("sha256").update(prompt, "utf8").digest("hex") } } };
}
