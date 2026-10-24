import { CONTRACT_REVISION, VERSION } from "../../../../contracts/lifetime/bindings.ts";
import type { Envelope, Goal, Response, Snapshot, Work } from "../../../../contracts/lifetime/bindings.ts";
import { isPrivacy, isRecord } from "./guards";
import { canonicalJson, digestValue, parseLifetimeEnvelope, parseLifetimeResponse, parseLifetimeSnapshot } from "./protocol";
import { createLifetimeClient } from "./client";
import type { LifetimeClient, LifetimeIdentity, LifetimeStorage, LifetimeTransport } from "./types";

const fixtureKey = `ghost:lifetime:${VERSION}:fixture-state`;
const fixtureIdentity: LifetimeIdentity = { actor_ref: "owner", authority_epoch: 1 };

interface FixtureReceipt {
  envelope: Envelope;
  response: Response;
}

interface FixtureState {
  snapshot: Snapshot;
  receipts: Record<string, FixtureReceipt>;
}


function emptyResponse(status: Response["status"], summary: string, retryClass: Response["retry_class"], errorCode: string | null = null, data: unknown = null, objectRefs: string[] = []): Response {
  return { status, summary, object_refs: objectRefs, artifacts: [], next_actions: [], error_code: errorCode, retry_class: retryClass, data };
}


async function parseFixtureState(value: unknown): Promise<FixtureState> {
  if (!isRecord(value) || !isRecord(value.receipts)) throw new Error("Lifetime fixture state is malformed.");
  const snapshot = parseLifetimeSnapshot(value.snapshot);
  const receipts: Record<string, FixtureReceipt> = {};
  for (const [id, item] of Object.entries(value.receipts)) {
    if (!isRecord(item)) throw new Error("Lifetime fixture receipt is malformed.");
    const envelope = await parseLifetimeEnvelope(item.envelope);
    const response = parseLifetimeResponse(item.response);
    if (envelope.command_id !== id) throw new Error("Lifetime fixture receipt identity is invalid.");
    receipts[id] = { envelope, response };
  }
  return { snapshot, receipts };
}

function goalRequirementDigest(prompt: string, acceptanceSpec: Record<string, unknown>): Promise<string> {
  return digestValue({ prompt, acceptance_spec: acceptanceSpec });
}


async function applyFixtureCommand(state: FixtureState, envelope: Envelope): Promise<Response> {
  const body = envelope.body;
  const method = body.method;
  if (method === "command.inspect") {
    const commandId = body.command_id;
    if (typeof commandId !== "string") return emptyResponse("error", "Receipt lookup requires a command ID.", "never", "invalid_command");
    const receipt = state.receipts[commandId];
    if (!receipt) return emptyResponse("warning", "No fixture receipt exists for this command ID.", "reconcile_first", "not_found", { command_id: commandId, found: false });
    return emptyResponse("success", "Fixture receipt found.", "same_id", null, {
      command_id: commandId,
      found: true,
      authority_epoch: receipt.envelope.authority_epoch,
      payload_digest: receipt.envelope.payload_digest,
      response: structuredClone(receipt.response),
    });
  }
  if (method === "goal.submit") {
    const ghostId = body.ghost_id;
    const conversationId = body.conversation_id;
    const prompt = body.prompt;
    const privacy = body.privacy;
    const acceptanceSpec = body.acceptance_spec;
    if (typeof ghostId !== "string" || typeof conversationId !== "string" || typeof prompt !== "string" || prompt.trim().length === 0 || !isPrivacy(privacy) || !isRecord(acceptanceSpec)) {
      return emptyResponse("error", "Fixture command is missing required goal fields.", "never", "invalid_command");
    }
    const goalId = crypto.randomUUID();
    const workId = crypto.randomUUID();
    const goal: Goal = {
      id: goalId,
      revision: 1,
      requirement_digest: await goalRequirementDigest(prompt, acceptanceSpec),
      prompt,
      accountable_ghost: ghostId,
      reply_conversation: conversationId,
      privacy,
      state: "queued",
      acceptance_spec: structuredClone(acceptanceSpec),
    };
    const work: Work = { id: workId, goal_id: goalId, goal_revision: 1, owner: ghostId, owner_revision: 1, state: "queued", execution_id: null, cancellation: "none", blocker: "Fixture mode; no live runtime is attached." };
    state.snapshot.goals.push(goal);
    state.snapshot.work.push(work);
    return emptyResponse("success", "Fixture goal was recorded locally; no live Host or worker was called.", "never", null, { goal_id: goalId, work_id: workId }, [goalId, workId]);
  }
  if (method === "goal.inspect") {
    const goal = state.snapshot.goals.find(item => item.id === body.goal_id);
    return goal ? emptyResponse("success", "Fixture goal loaded.", "never", null, goal, [goal.id]) : emptyResponse("error", "Fixture goal was not found.", "never", "not_found");
  }
  if (method === "goal.update") {
    const goal = state.snapshot.goals.find(item => item.id === body.goal_id);
    if (!goal) return emptyResponse("error", "Fixture goal was not found.", "never", "not_found");
    if (envelope.expected_revision !== goal.revision) return emptyResponse("error", "This fixture goal changed. The latest revision is shown; review it before updating again.", "new_revision", "revision_conflict");
    const prompt = body.prompt;
    const acceptanceSpec = body.acceptance_spec;
    if (typeof prompt !== "string" || prompt.trim().length === 0 || !isRecord(acceptanceSpec)) return emptyResponse("error", "Fixture goal update is missing required fields.", "never", "invalid_command");
    goal.revision += 1;
    goal.prompt = prompt;
    goal.requirement_digest = await goalRequirementDigest(prompt, acceptanceSpec);
    goal.acceptance_spec = structuredClone(acceptanceSpec);
    for (const work of state.snapshot.work.filter(item => item.goal_id === goal.id && item.state !== "accepted" && item.state !== "cancelled")) work.goal_revision = goal.revision;
    return emptyResponse("success", "Fixture goal revision updated locally; no live Host or worker was called.", "never", null, goal, [goal.id]);
  }
  if (method === "work.inspect") {
    const work = state.snapshot.work.find(item => item.id === body.work_id);
    if (!work) return emptyResponse("error", "Fixture work was not found.", "never", "not_found");
    return emptyResponse("success", `Fixture work is ${work.state}; cancellation is ${work.cancellation}.`, "never", null, work, [work.id]);
  }
  if (method === "work.steer") {
    const work = state.snapshot.work.find(item => item.id === body.work_id);
    if (!work) return emptyResponse("error", "Fixture work was not found.", "never", "not_found");
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) return emptyResponse("error", "A direction is required.", "never", "invalid_command");
    work.state = "steer_requested";
    work.blocker = "Fixture mode recorded the direction; no live worker received it.";
    // 로컬 기록은 동기로 완료되므로 success가 정직한 상태다. warning은 클라이언트
    // 정산 경로에서 영구 미해결로 남아 이후 모든 변이를 막는다.
    return emptyResponse("success", "Fixture direction recorded locally; no live worker was steered.", "never", null, work, [work.id]);
  }
  if (method === "work.cancel") {
    const work = state.snapshot.work.find(item => item.id === body.work_id);
    if (!work) return emptyResponse("error", "Fixture work was not found.", "never", "not_found");
    work.cancellation = "requested";
    work.blocker = "Fixture mode recorded the cancellation request; no live process was stopped.";
    return emptyResponse("warning", "Fixture cancellation request recorded locally; no live process was stopped.", "never", null, work, [work.id]);
  }
  return emptyResponse("error", "This command is not implemented by the lifetime fixture transport.", "never", "unsupported_fixture_command");
}

export function createLifetimeFixtureTransport(storage?: LifetimeStorage, initial?: Snapshot): LifetimeTransport {
  const initialSnapshot: Snapshot = initial ? { ...parseLifetimeSnapshot(initial), mode: "fixture" } : { protocol_version: VERSION, contract_revision: CONTRACT_REVISION, mode: "fixture", goals: [], work: [], bindings: [], artifacts: [], acceptances: [] };
  let memory: FixtureState = { snapshot: initialSnapshot, receipts: {} };
  let serial: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation);
    serial = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async (): Promise<FixtureState> => {
    const encoded = await storage?.getItem(fixtureKey);
    if (encoded === null || encoded === undefined) return structuredClone(memory);
    try {
      return await parseFixtureState(JSON.parse(encoded));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Lifetime fixture storage is not valid JSON.");
      throw error;
    }
  };
  const save = async (state: FixtureState) => {
    if (storage) await storage.setItem(fixtureKey, JSON.stringify(state));
    memory = structuredClone(state);
  };
  return {
    identity: { ...fixtureIdentity },
    async request(value) {
      return serialized(async () => {
        const envelope = await parseLifetimeEnvelope(value);
        if (envelope.actor_ref !== fixtureIdentity.actor_ref || envelope.authority_epoch !== fixtureIdentity.authority_epoch) {
          return emptyResponse("error", "Fixture identity does not match the configured owner epoch.", "never", "unauthorized");
        }
        const state = await load();
        const prior = state.receipts[envelope.command_id];
        if (prior) return canonicalJson(prior.envelope) === canonicalJson(envelope) ? structuredClone(prior.response) : emptyResponse("error", "The same fixture command ID was reused with different content.", "never", "idempotency_conflict");
        const next = structuredClone(state);
        const response = await applyFixtureCommand(next, envelope);
        next.receipts[envelope.command_id] = { envelope, response };
        await save(next);
        return structuredClone(response);
      });
    },
    async snapshot() {
      return serialized(async () => parseLifetimeSnapshot((await load()).snapshot));
    },
  };
}

export function createLifetimeFixtureClient(storage: LifetimeStorage, initial?: Snapshot): LifetimeClient {
  const transport = createLifetimeFixtureTransport(storage, initial);
  return createLifetimeClient(transport, storage, { ...fixtureIdentity, workspace_id: "fixture", dispatch_enabled: true });
}
