import type { Artifact, ConversationRun, Response } from "../../../../contracts/lifetime/bindings.ts";
import { isArtifact, isPrivacy, isRecord } from "./guards";

const encoder = new TextEncoder();

export interface RegistryConversation {
  ghost_id: string;
  kind: "primary" | "specialist";
  conversation_id: string;
  roles: string[];
  mode: "active" | "draining";
  secondary?: true;
}

export interface ConversationTurn {
  id: string;
  sequence: number;
  sender_kind: string;
  sender_ref: string;
  text: string;
  privacy: Artifact["privacy"];
  kind: "user" | "assistant_advisory" | "host_fact";
  source_turn_id: string | null;
  origin_report_id?: string | null;
  work_thread_ids?: string[];
  attachments: Artifact[];
  created_at_ms: number;
}

export interface ConversationPage {
  ghost_id: string;
  conversation_id: string;
  privacy: Artifact["privacy"];
  turns: ConversationTurn[];
  turn_runs: ConversationRun[];
  has_older: boolean;
  oldest_sequence: number | null;
}

export function conversationTargetKey(target: Pick<RegistryConversation, "ghost_id" | "conversation_id">): string {
  return JSON.stringify([target.ghost_id, target.conversation_id]);
}

export function defaultRegistryConversation(entries: RegistryConversation[]): RegistryConversation | undefined {
  const activePrimary = entries.filter(entry => entry.kind === "primary" && entry.mode === "active" && !entry.secondary);
  return activePrimary.length === 1 ? activePrimary[0] : undefined;
}

export function defaultRegistryGhostId(entries: RegistryConversation[]): string | null {
  return defaultRegistryConversation(entries)?.ghost_id ?? null;
}

export function findRegisteredConversation(entries: RegistryConversation[], ghostId: string, conversationId?: string): RegistryConversation | undefined {
  return entries.find(entry => entry.ghost_id === ghostId
    && (conversationId !== undefined ? entry.conversation_id === conversationId : !entry.secondary));
}

export function parseRegistryResponse(response: Response): RegistryConversation[] {
  if (response.status !== "success" || !isRecord(response.data) || !Array.isArray(response.data.registry)) {
    throw new Error(response.summary || "등록된 대화 대상을 확인하지 못했습니다.");
  }
  const pairs = new Map<string, RegistryConversation>();
  for (const item of response.data.registry) {
    if (!isRecord(item)
      || typeof item.ghost_id !== "string" || !item.ghost_id.trim()
      || typeof item.conversation_id !== "string" || !item.conversation_id.trim()
      || (item.kind !== "primary" && item.kind !== "specialist")
      || (item.mode !== "active" && item.mode !== "draining")
      || (item.secondary !== undefined && typeof item.secondary !== "boolean")
      || !Array.isArray(item.roles) || !item.roles.every(role => typeof role === "string" && role.trim())) {
      throw new Error("Host가 반환한 등록 대화 목록에 올바르지 않은 항목이 있습니다.");
    }
    const entry: RegistryConversation = {
      ghost_id: item.ghost_id,
      kind: item.kind,
      conversation_id: item.conversation_id,
      roles: item.roles,
      mode: item.mode,
      ...(item.secondary === true ? { secondary: true } : {}),
    };
    const key = conversationTargetKey(entry);
    const previous = pairs.get(key);
    if (previous && (previous.kind !== entry.kind || previous.mode !== entry.mode || previous.secondary !== entry.secondary || previous.roles.join("\u0000") !== entry.roles.join("\u0000"))) {
      throw new Error("Host registry returned conflicting metadata for one conversation target.");
    }
    pairs.set(key, entry);
  }
  return [...pairs.values()].sort((left, right) => conversationTargetKey(left).localeCompare(conversationTargetKey(right)));
}

function parseTurn(value: unknown): ConversationTurn {
  if (!isRecord(value)
    || typeof value.id !== "string" || !value.id
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || typeof value.sender_kind !== "string" || !value.sender_kind
    || typeof value.sender_ref !== "string" || !value.sender_ref
    || typeof value.text !== "string"
    || !isPrivacy(value.privacy)
    || (value.kind !== "user" && value.kind !== "assistant_advisory" && value.kind !== "host_fact")
    || (value.source_turn_id !== null && !nullableIdentity(value.source_turn_id))
    || value.origin_report_id !== undefined && (
      !nullableIdentity(value.origin_report_id)
      || value.origin_report_id !== null && (
        value.kind !== "assistant_advisory" || value.sender_kind !== "ghost" || value.source_turn_id !== null
      )
    )
    || value.work_thread_ids !== undefined && (
      !Array.isArray(value.work_thread_ids) || !value.work_thread_ids.every(id => id !== null && nullableIdentity(id))
      || value.work_thread_ids.length > 0 && value.kind !== "user" && !value.origin_report_id
    )
    || !Array.isArray(value.attachments) || !value.attachments.every(isArtifact)
    || !Number.isSafeInteger(value.created_at_ms) || (value.created_at_ms as number) < 0) {
    throw new Error("Host returned a malformed canonical conversation turn.");
  }
  return value as unknown as ConversationTurn;
}

const runStates = new Set(["queued", "running", "answered", "failed", "cancelled", "effect_unknown"]);
const runReasons = new Set([
  "model_request_failed", "runtime_failure", "admission_blocked", "answer_unprojectable",
  "owner_cancelled", "effect_unconfirmed", "reply_delivery_unconfirmed", "authority_revoked",
]);

function nullableIdentity(value: unknown): boolean {
  return value === null || typeof value === "string" && value.length > 0 && encoder.encode(value).length <= 512;
}

function parseRun(value: unknown, target: Pick<RegistryConversation, "ghost_id" | "conversation_id">): ConversationRun {
  if (!isRecord(value)
    || typeof value.turn_id !== "string" || !value.turn_id
    || value.ghost_id !== target.ghost_id || value.conversation_id !== target.conversation_id
    || typeof value.state !== "string" || !runStates.has(value.state)
    || typeof value.cancel_requested !== "boolean"
    || !nullableIdentity(value.cancel_command_id) || !nullableIdentity(value.submission_id)
    || !nullableIdentity(value.entry_id) || !nullableIdentity(value.latest_status_command_id)
    || value.reason_code !== null && (typeof value.reason_code !== "string" || !runReasons.has(value.reason_code))
    || value.cancel_requested && value.cancel_command_id === null
    || !Number.isSafeInteger(value.created_at_ms) || (value.created_at_ms as number) < 0
    || !Number.isSafeInteger(value.updated_at_ms) || (value.updated_at_ms as number) < (value.created_at_ms as number)) {
    throw new Error("Host returned a malformed or foreign controller turn state.");
  }
  return value as unknown as ConversationRun;
}

export function parseConversationPage(response: Response, target: Pick<RegistryConversation, "ghost_id" | "conversation_id">): ConversationPage {
  const value = response.data;
  if (response.status !== "success" || !isRecord(value)
    || value.ghost_id !== target.ghost_id || value.conversation_id !== target.conversation_id
    || !isPrivacy(value.privacy) || !Array.isArray(value.turns) || !Array.isArray(value.turn_runs)
    || typeof value.has_older !== "boolean"
    || (value.oldest_sequence !== null && (!Number.isSafeInteger(value.oldest_sequence) || (value.oldest_sequence as number) < 1))) {
    throw new Error(response.summary || "Host returned an invalid conversation page.");
  }
  const turns = value.turns.map(parseTurn);
  for (let index = 1; index < turns.length; index++) {
    if (turns[index - 1]!.sequence >= turns[index]!.sequence) throw new Error("Host conversation turns are not in canonical sequence order.");
  }
  if (turns.length > 0 && value.oldest_sequence !== turns[0]!.sequence) {
    throw new Error("Host conversation page has an inconsistent oldest sequence.");
  }
  if (turns.length === 0 && value.oldest_sequence !== null) {
    throw new Error("An empty Host conversation page cannot advertise an oldest sequence.");
  }
  const referenced = new Set(turns.flatMap(turn => [
    ...(turn.kind === "user" ? [turn.id] : []),
    ...(turn.source_turn_id ? [turn.source_turn_id] : []),
  ]));
  const nonOwners = new Set(turns.filter(turn => turn.kind !== "user").map(turn => turn.id));
  const runIDs = new Set<string>();
  const turnRuns = value.turn_runs.map(item => {
    const run = parseRun(item, target);
    if (!referenced.has(run.turn_id) || nonOwners.has(run.turn_id) || runIDs.has(run.turn_id)) {
      throw new Error("Host returned an unrelated or duplicate controller turn state.");
    }
    runIDs.add(run.turn_id);
    return run;
  });
  return {
    ghost_id: value.ghost_id,
    conversation_id: value.conversation_id,
    privacy: value.privacy,
    turns,
    turn_runs: turnRuns,
    has_older: value.has_older,
    oldest_sequence: value.oldest_sequence as number | null,
  };
}

export function mergeConversationRuns(current: ReadonlyMap<string, ConversationRun>, incoming: readonly ConversationRun[]) {
  const merged = new Map(current);
  for (const run of incoming) {
    const previous = merged.get(run.turn_id);
    if (previous && run.updated_at_ms <= previous.updated_at_ms) continue;
    merged.set(run.turn_id, run);
  }
  return merged;
}

// Thread associations are additive. A slower response or an older Host may
// omit an association that another page already observed for the same turn.
export function mergeConversationTurns(current: readonly ConversationTurn[], incoming: readonly ConversationTurn[]): ConversationTurn[] {
  const merged = new Map(current.map(turn => [turn.id, turn]));
  for (const turn of incoming) {
    const previous = merged.get(turn.id);
    const links = new Set([...(previous?.work_thread_ids ?? []), ...(turn.work_thread_ids ?? [])]);
    merged.set(turn.id, links.size ? { ...turn, work_thread_ids: [...links] } : turn);
  }
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
}

const privacyRank: Record<Artifact["privacy"], number> = { public: 0, private: 1, local_only: 2 };

export function atLeastPrivacy(...values: Artifact["privacy"][]): Artifact["privacy"] {
  return values.reduce((result, value) => privacyRank[value] > privacyRank[result] ? value : result, "public");
}
