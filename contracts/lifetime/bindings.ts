// Shared contract revision 1; coordinator-owned.

export const VERSION = "ghost-lifetime/1" as const;

export const CONTRACT_REVISION = 1;

export interface Artifact {
  digest: string;
  locator: string;
  privacy: "public" | "private" | "local_only";
  producing_attempt: string;
}

export interface Goal {
  id: string;
  revision: number;
  requirement_digest: string;
  prompt: string;
  accountable_ghost: string;
  reply_conversation: string;
  privacy: "public" | "private" | "local_only";
  state: string;
  acceptance_spec: Record<string, unknown>;
}

export interface Work {
  id: string;
  goal_id: string;
  goal_revision: number;
  owner: string;
  owner_revision: number;
  state: string;
  execution_id: string | null;
  cancellation: string;
  blocker: string | null;
}

export interface RuntimeBinding {
  conversation_id: string;
  ghost_id: string;
  runtime_kind: string;
  runtime_release: string;
  storage_ref: string;
}

// Canonical controller lifecycle/1; separate from the frozen global R1 Snapshot.
export interface ConversationRun {
  turn_id: string;
  ghost_id: string;
  conversation_id: string;
  state: "queued" | "running" | "answered" | "failed" | "cancelled" | "effect_unknown";
  cancel_requested: boolean;
  cancel_command_id: string | null;
  submission_id: string | null;
  entry_id: string | null;
  reason_code: string | null;
  latest_status_command_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface WorkerSpec {
  execution_id: string;
  work_id: string;
  work_revision: number;
  authority_epoch: number;
  computer_id: string;
  cwd: string;
  prompt: string;
  model: string;
  thinking: string;
  allowed_tools: string[];
  deadline_ms: number;
  max_progress_bytes: number;
}

export interface Check {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface Acceptance {
  work_id: string;
  goal_revision: number;
  requirement_digest: string;
  artifact_digest: string;
  verifier_revision: string;
  policy_revision: number;
  checks: Check[];
}

export interface ComputerBinding {
  computer_id: string;
  ghost_id: string;
  backend: string;
  host_id: string;
  epoch: number;
  capabilities: string[];
  accepted_capabilities: string[];
  grant_revision: number;
}

export interface Envelope {
  protocol_version: typeof VERSION;
  command_id: string;
  payload_digest: string;
  actor_ref: string;
  authority_epoch: number;
  expected_revision: number | null;
  correlation_id: string;
  body: Record<string, unknown>;
}

export interface Response {
  status: "success" | "warning" | "error";
  summary: string;
  object_refs: string[];
  artifacts: Artifact[];
  next_actions: string[];
  error_code: string | null;
  retry_class: "same_id" | "reconcile_first" | "new_revision" | "never";
  data: unknown;
}

export interface Snapshot {
  protocol_version: typeof VERSION;
  contract_revision: number;
  mode: string;
  goals: Goal[];
  work: Work[];
  bindings: RuntimeBinding[];
  artifacts: Artifact[];
  acceptances: Acceptance[];
}
