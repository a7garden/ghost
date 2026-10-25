// Host evidence metadata only. This projection grants no model/tool authority.
export function verificationContext(value) {
  if (value === null || value === undefined) return null;
  const identity = text => typeof text === "string" && text.length > 0 && text.length <= 400;
  const status = text => ["pending", "failed", "unknown", "passed"].includes(text);
  if (value.version !== "ghost-independent-verification/1" || !identity(value.work_id)
    || !(value.execution_id === null || identity(value.execution_id))
    || !status(value.status) || !status(value.historical_status)
    || typeof value.current_scope !== "boolean" || typeof value.accepted !== "boolean"
    || value.authorizes_inference_or_effects !== false || value.automatic_retry !== false
    || !(value.receipt_ref === null || identity(value.receipt_ref))) {
    throw new Error("Host independent verification projection is invalid.");
  }
  return { version: value.version, work_id: value.work_id, execution_id: value.execution_id,
    status: value.status, historical_status: value.historical_status, current_scope: value.current_scope,
    accepted: value.accepted, receipt_ref: value.receipt_ref,
    authorizes_inference_or_effects: false, automatic_retry: false };
}
