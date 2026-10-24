import { CONTRACT_REVISION, VERSION } from "../../../../contracts/lifetime/bindings.ts";
import type { Acceptance, Artifact, Check, Envelope, Goal, Response, RuntimeBinding, Snapshot, Work } from "../../../../contracts/lifetime/bindings.ts";

const digestPattern = /^[a-f0-9]{64}$/;
const artifactFields = ["digest", "locator", "privacy", "producing_attempt"];
const goalFields = ["id", "revision", "requirement_digest", "prompt", "accountable_ghost", "reply_conversation", "privacy", "state", "acceptance_spec"];
const workFields = ["id", "goal_id", "goal_revision", "owner", "owner_revision", "state", "execution_id", "cancellation", "blocker"];
const runtimeBindingFields = ["conversation_id", "ghost_id", "runtime_kind", "runtime_release", "storage_ref"];
const checkFields = ["id", "passed", "evidence"];
const acceptanceFields = ["work_id", "goal_revision", "requirement_digest", "artifact_digest", "verifier_revision", "policy_revision", "checks"];
const envelopeFields = ["protocol_version", "command_id", "payload_digest", "actor_ref", "authority_epoch", "expected_revision", "correlation_id", "body"];
const responseFields = ["status", "summary", "object_refs", "artifacts", "next_actions", "error_code", "retry_class", "data"];
const snapshotFields = ["protocol_version", "contract_revision", "mode", "goals", "work", "bindings", "artifacts", "acceptances"];

function hasExactFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
}
/** Canonical object guard for the lifetime package's untrusted JSON boundaries. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function isPrivacy(value: unknown): value is Artifact["privacy"] {
  return value === "public" || value === "private" || value === "local_only";
}

export function isArtifact(value: unknown): value is Artifact {
  return isRecord(value)
    && hasExactFields(value, artifactFields)
    && isDigest(value.digest)
    && typeof value.locator === "string"
    && isPrivacy(value.privacy)
    && typeof value.producing_attempt === "string";
}

export function isGoal(value: unknown): value is Goal {
  return isRecord(value)
    && hasExactFields(value, goalFields)
    && typeof value.id === "string"
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && isDigest(value.requirement_digest)
    && typeof value.prompt === "string"
    && typeof value.accountable_ghost === "string"
    && typeof value.reply_conversation === "string"
    && isPrivacy(value.privacy)
    && typeof value.state === "string"
    && isRecord(value.acceptance_spec);
}

export function isWork(value: unknown): value is Work {
  return isRecord(value)
    && hasExactFields(value, workFields)
    && typeof value.id === "string"
    && typeof value.goal_id === "string"
    && Number.isSafeInteger(value.goal_revision) && (value.goal_revision as number) >= 1
    && typeof value.owner === "string"
    && Number.isSafeInteger(value.owner_revision) && (value.owner_revision as number) >= 1
    && typeof value.state === "string"
    && (typeof value.execution_id === "string" || value.execution_id === null)
    && typeof value.cancellation === "string"
    && (typeof value.blocker === "string" || value.blocker === null);
}

export function isRuntimeBinding(value: unknown): value is RuntimeBinding {
  return isRecord(value)
    && hasExactFields(value, runtimeBindingFields)
    && typeof value.conversation_id === "string"
    && typeof value.ghost_id === "string"
    && typeof value.runtime_kind === "string"
    && typeof value.runtime_release === "string"
    && typeof value.storage_ref === "string";
}

function isCheck(value: unknown): value is Check {
  return isRecord(value)
    && hasExactFields(value, checkFields)
    && typeof value.id === "string"
    && typeof value.passed === "boolean"
    && typeof value.evidence === "string";
}

export function isAcceptance(value: unknown): value is Acceptance {
  return isRecord(value)
    && hasExactFields(value, acceptanceFields)
    && typeof value.work_id === "string"
    && Number.isSafeInteger(value.goal_revision) && (value.goal_revision as number) >= 1
    && isDigest(value.requirement_digest)
    && isDigest(value.artifact_digest)
    && typeof value.verifier_revision === "string"
    && Number.isSafeInteger(value.policy_revision) && (value.policy_revision as number) >= 1
    && Array.isArray(value.checks)
    && value.checks.every(isCheck);
}

export function isLifetimeEnvelope(value: unknown): value is Envelope {
  if (!isRecord(value) || !hasExactFields(value, envelopeFields)) return false;
  return value.protocol_version === VERSION
    && typeof value.command_id === "string" && value.command_id.length > 0
    && isDigest(value.payload_digest)
    && typeof value.actor_ref === "string" && value.actor_ref.length > 0
    && Number.isSafeInteger(value.authority_epoch) && (value.authority_epoch as number) >= 1
    && (value.expected_revision === null || (Number.isSafeInteger(value.expected_revision) && (value.expected_revision as number) >= 1))
    && typeof value.correlation_id === "string" && value.correlation_id.length > 0
    && isRecord(value.body);
}

export function isLifetimeResponse(value: unknown): value is Response {
  return isRecord(value)
    && hasExactFields(value, responseFields)
    && (value.status === "success" || value.status === "warning" || value.status === "error")
    && typeof value.summary === "string"
    && Array.isArray(value.object_refs) && value.object_refs.every(item => typeof item === "string")
    && Array.isArray(value.artifacts) && value.artifacts.every(isArtifact)
    && Array.isArray(value.next_actions) && value.next_actions.every(item => typeof item === "string")
    && (typeof value.error_code === "string" || value.error_code === null)
    && (value.retry_class === "same_id" || value.retry_class === "reconcile_first" || value.retry_class === "new_revision" || value.retry_class === "never")
    && "data" in value;
}

export function isLifetimeSnapshot(value: unknown): value is Snapshot {
  return isRecord(value)
    && hasExactFields(value, snapshotFields)
    && value.protocol_version === VERSION
    && value.contract_revision === CONTRACT_REVISION
    && (value.mode === "fixture" || value.mode === "live")
    && Array.isArray(value.goals) && value.goals.every(isGoal)
    && Array.isArray(value.work) && value.work.every(isWork)
    && Array.isArray(value.bindings) && value.bindings.every(isRuntimeBinding)
    && Array.isArray(value.artifacts) && value.artifacts.every(isArtifact)
    && Array.isArray(value.acceptances) && value.acceptances.every(isAcceptance);
}
