import { payloadDigest, ProtocolError } from "./contract.js";

const fields = ["kind", "ref", "assignment_id", "work_id", "goal_revision", "owner_revision", "authority_epoch"];
const invalid = () => new ProtocolError("work_context_invalid", "Host did not confirm this exact immutable Work context.", "never");

export function validateWorkContext(value, expected) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key)) || value.kind !== "ghost-work-context/1"
    || typeof value.ref !== "string" || !/^wc-[a-f0-9]{64}$/u.test(value.ref)
    || value.assignment_id !== expected.assignmentId || value.work_id !== expected.workId
    || value.goal_revision !== expected.goalRevision
    || (expected.authorityEpoch !== undefined && value.authority_epoch !== expected.authorityEpoch)
    || !Number.isSafeInteger(value.owner_revision) || value.owner_revision < 1
    || !Number.isSafeInteger(value.authority_epoch) || value.authority_epoch < 1) throw invalid();
  return Object.freeze(Object.fromEntries(fields.map(key=>[key,value[key]])));
}

export async function initializeWorkContexts(index) {
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_work_contexts (
    assignment_id TEXT PRIMARY KEY, context_ref TEXT NOT NULL UNIQUE,
    canonical_conversation_id TEXT NOT NULL, binding_json TEXT NOT NULL,
    binding_digest TEXT NOT NULL, storage_ref TEXT, pi_id INTEGER, provider_session_id TEXT, callback_scope TEXT
  )`);
  if(!(await index.all("PRAGMA table_info(ghost_work_contexts)")).some(column=>column.name==="callback_scope")) await index.exec("ALTER TABLE ghost_work_contexts ADD COLUMN callback_scope TEXT");
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_assignment_completion_intents (
    assignment_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, request_digest TEXT NOT NULL,
    generation_task_id INTEGER NOT NULL, entry_id INTEGER NOT NULL
  )`);
  const columns = await index.all("PRAGMA table_info(ghost_canonical_turns)");
  if (!columns.some(column => column.name === "context_ref")) {
    await index.transaction(async tx => {
      await tx.exec("ALTER TABLE ghost_canonical_turns ADD COLUMN context_ref TEXT NOT NULL DEFAULT 'owner'");
      await tx.exec("DROP INDEX IF EXISTS ghost_one_active_canonical_turn");
      await tx.exec("CREATE UNIQUE INDEX ghost_one_active_canonical_turn ON ghost_canonical_turns (conversation_id, context_ref) WHERE state IN ('admitting', 'running')");
    });
  }
}

// The plan is committed before a clean store is opened. Existing canonical
// assignments without a mapping remain in their original mixed-history store.
export async function planWorkContext(index, conversationId, descriptor) {
  return index.transaction(async tx => {
    const existing = await tx.get("SELECT * FROM ghost_work_contexts WHERE assignment_id=?", descriptor.assignment_id);
    const binding = JSON.stringify(descriptor), digest = payloadDigest(descriptor);
    if (existing) {
      if (existing.canonical_conversation_id !== conversationId || existing.context_ref !== descriptor.ref
        || existing.binding_digest !== digest || existing.binding_json !== binding) throw invalid();
      return descriptor;
    }
    if (await tx.get("SELECT assignment_id FROM ghost_canonical_assignments WHERE assignment_id=?", descriptor.assignment_id)) return null;
    await tx.run("INSERT INTO ghost_work_contexts (assignment_id,context_ref,canonical_conversation_id,binding_json,binding_digest) VALUES (?,?,?,?,?)",
      descriptor.assignment_id, descriptor.ref, conversationId, binding, digest);
    return descriptor;
  });
}

export async function persistWorkContextStore(index, descriptor, storageRef, piId, providerSessionId) {
  if (typeof providerSessionId !== "string" || !providerSessionId.length) throw invalid();
  await index.transaction(async tx => {
    const row = await tx.get("SELECT * FROM ghost_work_contexts WHERE assignment_id=?", descriptor.assignment_id);
    if (!row || row.context_ref !== descriptor.ref || row.binding_digest !== payloadDigest(descriptor)) throw invalid();
    if (row.storage_ref !== null && (row.storage_ref !== storageRef || row.pi_id !== piId || row.provider_session_id !== providerSessionId)) throw invalid();
    await tx.run("UPDATE ghost_work_contexts SET storage_ref=?,pi_id=?,provider_session_id=? WHERE assignment_id=?",
      storageRef, piId, providerSessionId, descriptor.assignment_id);
  });
}

export async function storedWorkContext(index, conversationId, assignmentId) {
  const row = await index.get("SELECT binding_json,binding_digest FROM ghost_work_contexts WHERE canonical_conversation_id=? AND assignment_id=?", conversationId, assignmentId);
  if (!row) return null;
  const value = JSON.parse(row.binding_json);
  if (payloadDigest(value) !== row.binding_digest) throw invalid();
  return validateWorkContext(value, { assignmentId, workId: value.work_id, goalRevision: value.goal_revision });
}

