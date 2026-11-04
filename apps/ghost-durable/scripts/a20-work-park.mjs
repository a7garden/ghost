// A command ACK may return while its exact durable GenerationTask is parked.
// It is never an inference completion or artifact acceptance signal.
export function verifiedA20WorkPark(command, request, frame) {
  const body=command?.body, inspected=request?.envelope?.body, result=frame?.result, receipt=result?.data?.wait_receipt;
  if (body?.method !== 'conversation.assignment' || request?.ghost_id !== body.ghost_id || request?.conversation_id !== body.conversation_id
    || inspected?.method !== 'work.wait.inspect' || frame?.ok !== true || result?.status !== 'success' || result?.data?.phase !== 'waiting'
    || receipt?.kind !== 'pi-work-wait/1' || receipt.assignment_id !== command.command_id || receipt.assignment_id !== inspected.assignment_id
    || receipt.work_id !== body.work_id || receipt.work_id !== inspected.work_id || receipt.goal_revision !== body.goal_revision
    || !Number.isSafeInteger(receipt.owner_revision) || receipt.owner_revision < 1
    || !Number.isSafeInteger(receipt.generation_task_id) || receipt.generation_task_id < 1 || receipt.generation_task_id !== inspected.generation_task_id
    || receipt.authority_epoch !== request.envelope.authority_epoch || receipt.authority_epoch !== command.authority_epoch
    || !Number.isSafeInteger(receipt.goal_revision) || receipt.goal_revision < 1
    || !Number.isSafeInteger(receipt.authority_epoch) || receipt.authority_epoch < 1
    || typeof receipt.wait_command_id !== 'string' || receipt.wait_command_id.length === 0 || !/^[a-f0-9]{64}$/u.test(receipt.wait_payload_digest)
    || receipt.wait_command_id !== inspected.wait_command_id || receipt.wait_payload_digest !== inspected.wait_payload_digest
    || !Array.isArray(receipt.wait_for) || receipt.wait_for.length < 1 || receipt.wait_for.length > 4
    || receipt.wait_for.some(id=>typeof id !== 'string' || id.length === 0) || new Set(receipt.wait_for).size !== receipt.wait_for.length
    || JSON.stringify(receipt.wait_for) !== JSON.stringify(inspected.wait_for)
    || !(receipt.execution_id === null || typeof receipt.execution_id === 'string' && receipt.execution_id.length > 0)) return null;
  return receipt;
}
