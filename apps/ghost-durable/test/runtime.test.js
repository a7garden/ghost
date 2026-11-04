import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { after, test } from "node:test";
import { payloadDigest } from "../src/contract.js";
import { openGhostRuntime } from "../src/runtime.js";
import { createFakeProvider } from "./fake-provider.js";
import { createBrokerModelProvider, createLocalModelProvider } from "../src/models.js";
import { openGhostIndex } from "../src/storage.js";
import { callbackCommandId } from "../src/host-transport.js";

const tempRoots = new Set();
const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const canaryRoot = join(repoRoot, ".lifetime-canary", "ghost-20261009T012047Z", "B6-tests");

// A test can own several reopened runtime handles. Close their SQLite
// connections via test teardown before removing the fixture directories.
after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
  tempRoots.clear();
});

async function setup(options = {}) {
  await mkdir(options.base ?? canaryRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(options.base ?? canaryRoot, "runtime-test-"));
  tempRoots.add(root);
  const provider = options.provider ?? createFakeProvider();
  const calls = options.calls ?? [];
  const controllerCalls = options.controllerCalls ?? [];
  const controllerRuns = options.controllerRuns ?? new Map();
  const externalHostToolTransport = options.hostToolTransport;
  const hostToolTransport = async (invocation, context) => {
    if (["conversation.turn.inspect", "conversation.turn_status"].includes(invocation.method)) {
      controllerCalls.push(invocation);
      const key = JSON.stringify([invocation.ghost_id, invocation.conversation_id, invocation.turn_id]);
      let run = controllerRuns.get(key);
      if (!run && invocation.method === "conversation.turn.inspect") {
        run = {
          turn_id: invocation.turn_id,
          ghost_id: invocation.ghost_id,
          conversation_id: invocation.conversation_id,
          state: "queued",
          cancel_requested: false,
          cancel_command_id: null,
          submission_id: null,
          entry_id: null,
          reason_code: null,
          latest_status_command_id: null,
          created_at_ms: 1,
          updated_at_ms: 1,
        };
        controllerRuns.set(key, run);
      }
      if (invocation.method === "conversation.turn.inspect") {
        const inspection = options.onControllerInspect?.(run, invocation);
        if (inspection !== undefined) return inspection;
        return { status: "success", data: { run: run ?? "not_found" } };
      }
      if (!run) {
        return { status: "error", error_code: "turn_not_found", retry_class: "never" };
      }
      run = {
        ...run,
        state: invocation.arguments.status,
        submission_id: invocation.arguments.submission_id,
        entry_id: invocation.arguments.entry_id,
        reason_code: invocation.arguments.reason_code,
        cancel_requested: invocation.arguments.status === "cancelled" ? true : run.cancel_requested,
        latest_status_command_id: callbackCommandId(invocation.ghost_id, invocation.conversation_id,
          invocation.invocation_id, "conversation.turn_status"),
        updated_at_ms: run.updated_at_ms + 1,
      };
      controllerRuns.set(key, run);
      options.onControllerStatus?.(run, invocation);
      return { status: "success", data: { run } };
    }
    if (externalHostToolTransport) return externalHostToolTransport(invocation, context);
    if (invocation.method === "inference.inspect") {
      return { status: "success", data: { inference_scope: invocation.inference_scope, authority_epoch: 1 } };
    }
    if (invocation.method === "memory.capabilities" || invocation.method === "documents.capabilities") {
      return { status: "success", data: { available_tools: [] } };
    }
    calls.push(invocation);
    return { status: "success", data: { execution_id: "execution-fixture-1", state: "queued" } };
  };
  const runtime = await openGhostRuntime({
    root,
    mode: options.mode ?? "fixture",
    modelProvider: provider,
    hostToolTransport,
  });
  return { root, provider, runtime, calls, controllerCalls, controllerRuns, hostToolTransport };
}

function envelope(commandId, body) {
  return {
    protocol_version: "ghost-lifetime/1",
    command_id: commandId,
    payload_digest: payloadDigest(body),
    actor_ref: "fixture-actor",
    authority_epoch: 1,
    expected_revision: null,
    correlation_id: commandId,
    body,
  };
}

function ensure(commandId = "ensure-1") {
  return envelope(commandId, {
    method: "conversation.ensure",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  });
}

function submit(commandId, prompt) {
  return envelope(commandId, {
    method: "conversation.submit",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
    prompt,
    privacy: "public",
    goal_id: "goal-fixture",
    goal_revision: 1,
  });
}

function canonicalInput(commandId, turnId, prompt, privacy = "public", attachments = []) {
  return envelope(commandId, {
    method: "conversation.input",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
    turn_id: turnId,
    prompt,
    privacy,
    attachments,
  });
}
function cancelTurn(commandId, turnId) {
  return envelope(commandId, {
    method: "conversation.cancel_turn",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
    turn_id: turnId,
  });
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

async function waitForCancellationIntent(root, turnId) {
  const index = await openGhostIndex(root, "ghost-fixture");
  try {
    await waitFor(async () => {
      const run = await index.get(
        "SELECT cancel_requested FROM ghost_canonical_turn_runs WHERE turn_id = ?",
        turnId,
      );
      return run?.cancel_requested === 1;
    }, "canonical cancellation intent was not durable");
  } finally {
    await index.close();
  }
}
const LOCAL_MODEL_ID = "mlx-community/Qwen3.6-35B-A3B-4bit";
const LOCAL_BASE_URL = "http://127.0.0.1:8768/v1";

function createRoutedProvider({ brokerCalls = [], localCalls = [], localReply, localUsage } = {}) {
  const localModelProvider = createLocalModelProvider({
    baseUrl: LOCAL_BASE_URL,
    modelId: LOCAL_MODEL_ID,
    fetchImpl: async (url, options) => {
      const call = { url, body: JSON.parse(options.body) };
      localCalls.push(call);
      const choice = localReply?.(call, localCalls.length) ?? {
        message: { role: "assistant", content: "LOCAL_MODEL_REPLY" },
        finish_reason: "stop",
      };
      return new Response(JSON.stringify({
        id: `local-completion-${localCalls.length}`,
        object: "chat.completion",
        model: LOCAL_MODEL_ID,
        ...(localUsage ? { usage: localUsage(localCalls.length) } : {}),
        choices: [{ index: 0, ...choice }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return createBrokerModelProvider({
    modelRef: "minimax-code/MiniMax-M2.7",
    localModelProvider,
    invoke: async (request) => {
      brokerCalls.push(request);
      return {
        id: request.id,
        status: 200,
        body: {
          id: "public-broker-completion",
          object: "chat.completion",
          model: "minimax-code/MiniMax-M2.7",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "PUBLIC_MODEL_REPLY" },
            finish_reason: "stop",
          }],
        },
      };
    },
  });
}


test("real Pi Harness persists text→tool→result→final and replays the same requestId", async (t) => {
  const provider = createFakeProvider([
    fauxAssistantMessage([
      fauxToolCall("registry_inspect", {}),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Work was durably admitted.")]),
  ]);
  const calls = [];
  const { runtime } = await setup({ provider, calls });
  t.after(() => runtime.close());

  const first = await runtime.handle(ensure());
  assert.equal(first.status, "success");

  const request = submit("submit-tool-1", "Create the canary result");
  const admitted = await runtime.handle(request);
  assert.equal(admitted.status, "success");
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");

  const replay = await runtime.handle(request);
  assert.equal(replay.data.submission_id, admitted.data.submission_id);

  const inspected = await runtime.handle(envelope("inspect-tool-1", {
    method: "conversation.inspect",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  }));
  assert.equal(inspected.status, "success");
  assert.equal(inspected.data.durable_results.length, 1);

  const conflictBody = { ...request.body, prompt: "Changed content under the same command id" };
  const conflict = await runtime.handle(envelope(request.command_id, conflictBody));
  assert.equal(conflict.status, "error");
  assert.equal(conflict.error_code, "conflict");
  for (const changed of [
    { ...request, actor_ref: "other-authenticated-actor" },
    { ...request, authority_epoch: 2 },
  ]) {
    const rejected = await runtime.handle(changed);
    assert.equal(rejected.status, "error");
    assert.equal(rejected.error_code, "conflict");
  }
  assert.equal(calls.length, 1);
  assert.equal(provider.faux.state.callCount, 2);
});

test("broker mode moves a sticky private conversation to local without replacing Pi identity", async (t) => {
  const brokerCalls = [];
  const localCalls = [];
  const provider = createRoutedProvider({ brokerCalls, localCalls });
  const { runtime } = await setup({ mode: "broker", provider });
  t.after(() => runtime.close());

  const ensured = await runtime.handle(ensure("ensure-route-1"));
  assert.equal(ensured.status, "success");
  const originalPiId = ensured.data.pi_conversation_id;

  const publicRequest = canonicalInput("submit-public-before-private-1", "turn-public-before-private-1", "PUBLIC_CANARY_SENTINEL");
  const publicAdmission = await runtime.handle(publicRequest);
  assert.equal(publicAdmission.status, "success");
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(brokerCalls.length, 1);
  assert.equal(localCalls.length, 0);

  const privateRequest = canonicalInput("submit-private-1", "turn-private-1", "PRIVATE_CANARY_SENTINEL", "private");
  const privateAdmission = await runtime.handle(privateRequest);
  assert.equal(privateAdmission.status, "success");
  assert.equal(privateAdmission.data.pi_conversation_id, originalPiId);
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].body.messages.some((message) => JSON.stringify(message).includes("PRIVATE_CANARY_SENTINEL")), true);
  assert.equal(JSON.stringify(brokerCalls).includes("PRIVATE_CANARY_SENTINEL"), false);

  const laterPublic = await runtime.handle(canonicalInput(
    "submit-public-after-private-1",
    "turn-public-after-private-1",
    "PUBLIC_AFTER_PRIVATE_SENTINEL",
  ));
  assert.equal(laterPublic.status, "success");
  assert.equal(laterPublic.data.pi_conversation_id, originalPiId);
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(localCalls.length, 2);
  assert.equal(brokerCalls.length, 1);
  assert.equal(JSON.stringify(localCalls[1].body.messages).includes("PUBLIC_AFTER_PRIVATE_SENTINEL"), true);

  const inspected = await runtime.handle(envelope("inspect-private-route-1", {
    method: "conversation.inspect",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  }));
  assert.equal(inspected.data.agent.model.provider, "ghost-local");
});
test("missing local provider terminally blocks queued private input without broker fallback", async (t) => {
  const brokerCalls = [];
  const provider = createBrokerModelProvider({
    modelRef: "minimax-code/MiniMax-M2.7",
    invoke: async (request) => {
      brokerCalls.push(request);
      return { id: request.id, status: 200, body: {} };
    },
  });
  const { runtime, root } = await setup({ mode: "broker", provider });
  t.after(() => runtime.close());
  const privateRequest = canonicalInput(
    "submit-without-local-1",
    "turn-submit-without-local-1",
    "PRIVATE_WITHOUT_LOCAL_SENTINEL",
    "private",
  );

  const blocked = await runtime.handle(privateRequest);
  assert.equal(blocked.status, "success");
  assert.equal(blocked.data.turn_status, "queued");
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal((await runtime.handle(privateRequest)).data.turn_status, "queued");
  const laterPublic = await runtime.handle(canonicalInput(
    "submit-after-local-block-1",
    "turn-submit-after-local-block-1",
    "No public fallback.",
  ));
  assert.equal(laterPublic.status, "success");
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  const index = await openGhostIndex(root, "ghost-fixture");
  const privateRun = await index.get(
    "SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ? AND conversation_id = ?",
    "turn-submit-without-local-1",
    "conversation-fixture",
  );
  const laterRun = await index.get(
    "SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ? AND conversation_id = ?",
    "turn-submit-after-local-block-1",
    "conversation-fixture",
  );
  await index.close();
  assert.equal(privateRun.status, "failed");
  assert.equal(laterRun.status, "failed");
  assert.equal(brokerCalls.length, 0);
});

test("persisted Pi history with unknown disclosure is blocked before local or public generation", async (t) => {
  const first = await setup({
    provider: createFakeProvider([fauxAssistantMessage([fauxText("Unattributed persisted answer.")])]),
  });
  const prior = await first.runtime.handle(canonicalInput(
    "unknown-history-seed-1",
    "turn-unknown-history-seed-1",
    "UNATTRIBUTED_HISTORY_SENTINEL",
  ));
  assert.equal(prior.status, "success");
  await first.runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  await first.runtime.close();

  const index = await openGhostIndex(first.root, "ghost-fixture");
  await index.run("UPDATE ghost_conversations SET privacy = 'unknown' WHERE external_id = ?", "conversation-fixture");
  await index.close();

  const brokerCalls = [];
  const localCalls = [];
  const provider = createRoutedProvider({ brokerCalls, localCalls });
  const reopened = await openGhostRuntime({
    root: first.root, mode: "broker", modelProvider: provider, hostToolTransport: first.hostToolTransport,
  });
  t.after(() => reopened.close());
  const blocked = await reopened.handle(canonicalInput(
    "unknown-history-after-reopen-1",
    "turn-unknown-history-after-reopen-1",
    "PUBLIC_BUT_UNATTRIBUTED_SENTINEL",
  ));

  assert.equal(blocked.status, "error");
  assert.equal(blocked.error_code, "disclosure_blocked");
  await reopened.waitForIdle("ghost-fixture", "conversation-fixture");
  const blockedRun = first.controllerRuns.get(JSON.stringify([
    "ghost-fixture", "conversation-fixture", "turn-unknown-history-after-reopen-1",
  ]));
  assert.equal(blockedRun.state, "failed");
  assert.equal(blockedRun.reason_code, "admission_blocked");
  assert.equal(brokerCalls.length, 0);
  assert.equal(localCalls.length, 0);
});

test("each public model invocation rechecks the bound conversation disclosure", async () => {
  const brokerCalls = [];
  const provider = createBrokerModelProvider({
    modelRef: "minimax-code/MiniMax-M2.7",
    invoke: async (request) => {
      brokerCalls.push(request);
      return {
        id: request.id,
        status: 200,
        body: {
          id: "guarded-broker-completion",
          object: "chat.completion",
          model: "minimax-code/MiniMax-M2.7",
          choices: [{ index: 0, message: { role: "assistant", content: "PUBLIC_GUARDED_REPLY" }, finish_reason: "stop" }],
        },
      };
    },
  });
  let disclosure = "public";
  const bound = provider.forConversation(async () => {
    if (disclosure !== "public") throw new Error("conversation disclosure changed");
  });
  const model = bound.models.getModel("ghost-broker", "minimax-code/MiniMax-M2.7");
  const context = (content) => ({
    messages: [{ role: "user", content, timestamp: 1 }],
  });

  const publicResult = await bound.models.complete(model, context("public input"), bound.streamOptions);
  assert.equal(publicResult.stopReason, "stop");
  disclosure = "non_public";
  const blockedResult = await bound.models.complete(model, context("must not reach broker"), bound.streamOptions);
  assert.equal(blockedResult.stopReason, "error");
  assert.equal(brokerCalls.length, 1);
});

test("runtime.reconcile reads committed Pi state independently of watcher delivery", async (t) => {
  const provider = createFakeProvider([
    fauxAssistantMessage([fauxText("committed final after a lost watcher event")]),
  ]);
  const { runtime } = await setup({ provider });
  t.after(() => runtime.close());

  await runtime.handle(ensure("ensure-reconcile-1"));
  const admitted = await runtime.handle(submit("submit-reconcile-1", "Run the reconcile conformance case."));
  assert.equal(admitted.status, "success");
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");

  const reconciled = await runtime.handle(envelope("reconcile-1", {
    method: "runtime.reconcile",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  }));
  assert.equal(reconciled.status, "success");
  assert.equal(
    JSON.stringify(reconciled.data.committed_view).includes("committed final after a lost watcher event"),
    true,
  );
});

test("exact cancellation quiesces its owner turn without cancelling accepted Host work or the next turn", async (t) => {
  let releaseFirstWork;
  let releaseSecondWork;
  let firstWorkStarted = false;
  let secondWorkStarted = false;
  let firstWorkInvocationId = null;
  const firstBlocked = new Promise((resolve) => { releaseFirstWork = resolve; });
  const secondBlocked = new Promise((resolve) => { releaseSecondWork = resolve; });
  const calls = [];
  let workCalls = 0;
  const hostToolTransport = async (invocation) => {
    if (invocation.method === "inference.inspect") {
      return { status: "success", data: { inference_scope: invocation.inference_scope, authority_epoch: 1 } };
    }
    if (invocation.method === "memory.capabilities" || invocation.method === "documents.capabilities") {
      return { status: "success", data: { available_tools: [] } };
    }
    calls.push(invocation);
    if (invocation.method !== "conversation.reply") {
      workCalls += 1;
      if (workCalls === 1) {
        firstWorkStarted = true;
        firstWorkInvocationId = invocation.invocation_id;
        await firstBlocked;
      } else if (workCalls === 2) {
        secondWorkStarted = true;
        await secondBlocked;
      }
    }
    return { status: "success", data: { execution_id: `execution-background-${workCalls}`, state: "queued" } };
  };
  const provider = createFakeProvider([
    fauxAssistantMessage([
      fauxToolCall("goal_create", { prompt: "work-background-1", acceptance_spec: { required_checks: ["independent_review"] } }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([
      fauxToolCall("goal_create", { prompt: "work-background-2", acceptance_spec: { required_checks: ["independent_review"] } }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("The later owner turn completed.")]),
  ]);
  const { root, runtime, controllerRuns } = await setup({ provider, calls, hostToolTransport });
  t.after(async () => {
    releaseFirstWork?.();
    releaseSecondWork?.();
    await runtime.close();
  });

  await runtime.handle(ensure());
  const firstTurnId = "owner-turn-background";
  const admitted = await runtime.handle(canonicalInput(
    "submit-background-1",
    firstTurnId,
    "Run in the background",
  ));
  assert.equal(admitted.status, "success");
  assert.equal(admitted.data.submission_id, null);
  await waitFor(() => firstWorkStarted, "first accepted Host Work did not start");
  const nextTurnId = "owner-turn-background-next";
  const nextQueued = await runtime.handle(canonicalInput(
    "background-report-1",
    nextTurnId,
    "The Host reports the background work is complete.",
  ));
  assert.equal(nextQueued.status, "success");
  assert.equal(nextQueued.data.submission_id, null);

  const cancelPromise = runtime.handle(cancelTurn("cancel-turn-1", firstTurnId));
  await waitForCancellationIntent(root, firstTurnId);
  let cancellationResponse;
  let cancellationError;
  let cancellationSettled = false;
  void cancelPromise.then(
    (response) => { cancellationResponse = response; cancellationSettled = true; },
    (error) => { cancellationError = error; cancellationSettled = true; },
  );
  await waitFor(() => cancellationSettled, "exact cancellation response waited for the blocked model task");
  if (cancellationError) throw cancellationError;
  const cancelled = cancellationResponse;
  assert.equal(cancelled.status, "success");
  releaseFirstWork();
  await waitFor(() => secondWorkStarted, "the queued next owner turn did not start after quiescence");

  const staleCancel = await runtime.handle(cancelTurn("stale-cancel-1", firstTurnId));
  assert.equal(staleCancel.status, "success");
  assert.equal(staleCancel.data.already_terminal, true);
  releaseSecondWork();
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");

  const firstRun = controllerRuns.get(JSON.stringify(["ghost-fixture", "conversation-fixture", firstTurnId]));
  const nextRun = controllerRuns.get(JSON.stringify(["ghost-fixture", "conversation-fixture", nextTurnId]));
  assert.equal(firstRun.state, "cancelled");
  assert.equal(nextRun.state, "answered");
  assert.equal(typeof firstRun.cancel_requested, "boolean");
  assert.equal(firstRun.cancel_requested, true);
  assert.equal(typeof nextRun.cancel_requested, "boolean");
  assert.equal(calls[0].invocation_id, firstWorkInvocationId);
  assert.equal(calls.some((call) => call.method === "work.cancel"), false);
});

test("queued exact cancellation persists through reopen without calling the model", async (t) => {
  let releaseFirstWork;
  let firstWorkStarted = false;
  let cancellationReported = false;
  const firstBlocked = new Promise((resolve) => { releaseFirstWork = resolve; });
  const controllerRuns = new Map();
  const provider = createFakeProvider([
    fauxAssistantMessage([
      fauxToolCall("goal_create", { prompt: "first-owner-work", acceptance_spec: { required_checks: ["independent_review"] } }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("The preceding owner turn completed.")]),
  ]);
  const hostToolTransport = async (invocation) => {
    if (invocation.method === "inference.inspect") {
      return { status: "success", data: { inference_scope: invocation.inference_scope, authority_epoch: 1 } };
    }
    if (invocation.method === "memory.capabilities" || invocation.method === "documents.capabilities") {
      return { status: "success", data: { available_tools: [] } };
    }
    if (invocation.method === "goal.create") {
      firstWorkStarted = true;
      await firstBlocked;
      return { status: "success", data: { execution_id: "first-owner-work", state: "queued" } };
    }
    return { status: "success", data: {} };
  };
  const { root, runtime, hostToolTransport: fixtureTransport } = await setup({
    provider,
    hostToolTransport,
    controllerRuns,
    onControllerStatus: (run) => {
      if (run.state === "cancelled") cancellationReported = true;
    },
  });
  let firstClosed = false;
  t.after(async () => {
    releaseFirstWork?.();
    if (!firstClosed) await runtime.close();
  });

  const noTarget = await runtime.handle(envelope("cancel-without-target", {
    method: "conversation.cancel_turn",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  }));
  assert.equal(noTarget.status, "error");
  assert.equal(noTarget.error_code, "invalid_envelope");
  const firstTurnId = "owner-turn-before-queued-cancel";
  assert.equal((await runtime.handle(canonicalInput(
    "first-turn-before-queued-cancel",
    firstTurnId,
    "Hold the preceding turn.",
  ))).status, "success");
  await waitFor(() => firstWorkStarted, "preceding owner turn did not reach its durable tool slot");
  const turnId = "owner-turn-cancel-before-submit";
  const admitted = await runtime.handle(canonicalInput(
    "queued-before-submit",
    turnId,
    "Cancel before SDK admission.",
  ));
  assert.equal(admitted.status, "success");
  assert.equal(admitted.data.submission_id, null);
  const cancellation = await runtime.handle(cancelTurn("cancel-before-submit", turnId));
  assert.equal(cancellation.status, "success");
  await waitFor(() => cancellationReported, "queued cancellation did not report completion");
  assert.equal(provider.faux.state.callCount, 1);
  releaseFirstWork();
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(provider.faux.state.callCount, 2);
  assert.equal(controllerRuns.get(JSON.stringify(["ghost-fixture", "conversation-fixture", firstTurnId])).state, "answered");
  const run = controllerRuns.get(JSON.stringify(["ghost-fixture", "conversation-fixture", turnId]));
  assert.equal(run.state, "cancelled");
  assert.equal(run.submission_id, null);
  assert.equal(run.cancel_requested, true);
  await runtime.close();
  firstClosed = true;
  const providerAfterReopen = createFakeProvider([fauxAssistantMessage([fauxText("must not resume cancelled work")])]);
  const reopened = await openGhostRuntime({
    root,
    mode: "fixture",
    modelProvider: providerAfterReopen,
    hostToolTransport: fixtureTransport,
  });
  t.after(() => reopened.close());
  const replay = await reopened.handle(cancelTurn("cancel-before-submit", turnId));
  assert.equal(replay.status, "success");
  assert.equal(replay.data.cancel_requested, true);
  assert.equal(replay.data.cancel_command_id, cancellation.data.cancel_command_id);
  await reopened.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(providerAfterReopen.faux.state.callCount, 0);
  assert.equal(controllerRuns.get(JSON.stringify(["ghost-fixture", "conversation-fixture", turnId])).state, "cancelled");
});

test("reopening preserves conversation mapping and runtime lock rejects a competing owner", async (t) => {
  const first = await setup();
  const ensureResponse = await first.runtime.handle(ensure("ensure-reopen-1"));
  assert.equal(ensureResponse.status, "success");
  const piConversationId = ensureResponse.data.pi_conversation_id;
  const competing = await openGhostRuntime({
    root: first.root,
    mode: "fixture",
    modelProvider: createFakeProvider(),
    hostToolTransport: async () => ({ status: "success" }),
  });
  const blocked = await competing.handle(ensure("ensure-competing-1"));
  assert.equal(blocked.status, "error");
  assert.equal(blocked.error_code, "runtime_unavailable");
  await competing.close();
  await first.runtime.close();

  const reopened = await openGhostRuntime({
    root: first.root,
    mode: "fixture",
    modelProvider: first.provider,
    hostToolTransport: async () => ({ status: "success" }),
  });
  t.after(() => reopened.close());
  const resumed = await reopened.handle(ensure("ensure-reopen-2"));
  assert.equal(resumed.status, "success");
  assert.equal(resumed.data.pi_conversation_id, piConversationId);
});

test("broker reopen resumes sticky private history only through the configured local provider", async (t) => {
  const first = await setup({
    provider: createFakeProvider([fauxAssistantMessage([fauxText("Fixture-local response.")])]),
  });
  const privateAdmission = await first.runtime.handle(canonicalInput(
    "private-history",
    "turn-private-history",
    "PRIVATE_CANARY_SENTINEL",
    "private",
  ));
  assert.equal(privateAdmission.status, "success");
  await first.runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  await first.runtime.close();

  const brokerCalls = [];
  const localCalls = [];
  const provider = createRoutedProvider({ brokerCalls, localCalls });
  const broker = await openGhostRuntime({
    root: first.root, mode: "broker", modelProvider: provider, hostToolTransport: first.hostToolTransport,
  });
  t.after(() => broker.close());
  const result = await broker.handle(canonicalInput(
    "public-after-reopen",
    "turn-public-after-reopen",
    "PUBLIC_AFTER_REOPEN_SENTINEL",
  ));
  assert.equal(result.status, "success");
  assert.equal(result.data.pi_conversation_id, privateAdmission.data.pi_conversation_id);
  await broker.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(brokerCalls.length, 0);
  assert.equal(localCalls.length, 1);
  assert.equal(JSON.stringify(localCalls[0].body.messages).includes("PRIVATE_CANARY_SENTINEL"), true);
  assert.equal(JSON.stringify(localCalls[0].body.messages).includes("PUBLIC_AFTER_REOPEN_SENTINEL"), true);
});

test("terminal generation failure stays observable by its exact durable request after reopen", async (t) => {
  const first = await setup({ provider: createFakeProvider() });
  const request = canonicalInput(
    "durable-failed-request",
    "turn-durable-failed-request",
    "Public synthetic generation with an exhausted deterministic provider.",
  );
  assert.equal((await first.runtime.handle(request)).status, "success");
  await first.runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  const statusBody = {
    method: "conversation.status", ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture", request_id: request.command_id,
  };
  const failed = await first.runtime.handle(envelope("status-failed-1", statusBody));
  assert.equal(failed.status, "success");
  assert.equal(failed.data.status, "unanswered");
  await first.runtime.close();
  const provider = createFakeProvider([fauxAssistantMessage([fauxText("Must not silently resume failed work.")])]);
  const reopened = await openGhostRuntime({ root: first.root, mode: "fixture", modelProvider: provider });
  t.after(() => reopened.close());
  const recovered = await reopened.handle(envelope("status-failed-2", statusBody));
  assert.equal(recovered.data.submission_id, failed.data.submission_id);
  assert.equal(recovered.data.status, "unanswered");
  const wrongConversation = await reopened.handle(envelope("status-wrong-conversation", {
    ...statusBody, conversation_id: "another-conversation",
  }));
  assert.equal(wrongConversation.error_code, "submission_not_found");
  assert.equal(provider.faux.state.callCount, 0);
});

test("canonical model_error commits a truthful failed controller status", async (t) => {
  const provider = createFakeProvider();
  const { runtime, controllerRuns } = await setup({ provider });
  t.after(() => runtime.close());

  const turnId = "owner-turn-model-error";
  const admitted = await runtime.handle(canonicalInput(
    "canonical-model-error",
    turnId,
    "This deterministic provider has no successful response.",
  ));
  assert.equal(admitted.status, "success");
  assert.equal(admitted.data.submission_id, null);
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");

  const run = controllerRuns.get(JSON.stringify(["ghost-fixture", "conversation-fixture", turnId]));
  assert.equal(run.state, "failed");
  assert.equal(run.reason_code, "model_request_failed");
  assert.equal(run.entry_id, null);
  assert.equal(typeof run.submission_id, "string");
  assert.equal(typeof run.cancel_requested, "boolean");
  assert.equal(provider.faux.state.callCount, 1);
});


test("canonical owner input persists and replays without another model turn", async (t) => {
  const provider = createFakeProvider([
    fauxAssistantMessage([fauxText("Canonical assistant advisory.")]),
  ]);
  const callbacks = [];
  const receipts = new Map();
  const hostToolTransport = async (invocation) => {
    if (invocation.method === "inference.inspect") {
      return { status: "success", data: { inference_scope: invocation.inference_scope, authority_epoch: 1 } };
    }
    if (invocation.method === "memory.capabilities" || invocation.method === "documents.capabilities") {
      return { status: "success", data: { available_tools: [] } };
    }
    callbacks.push(invocation);
    if (invocation.method === "conversation.reply") {
      const existing = receipts.get(invocation.invocation_id);
      if (existing) return existing;
      const receipt = { status: "success", data: { turn_id: invocation.turn_id, kind: "assistant_advisory" } };
      receipts.set(invocation.invocation_id, receipt);
      return receipt;
    }
    return { status: "success", data: {} };
  };
  const { runtime, controllerRuns } = await setup({ base: canaryRoot, provider, hostToolTransport });
  t.after(() => runtime.close());

  const ensured = await runtime.handle(ensure("ensure-canonical-conversation"));
  const request = canonicalInput("canonical-input-1", "owner-turn-1", "ORIGINAL_CANONICAL_PROMPT");
  const admitted = await runtime.handle(request);
  assert.equal(admitted.status, "success");
  assert.equal(admitted.data.turn_id, "owner-turn-1");
  assert.equal(admitted.data.turn_status, "queued");
  assert.equal(admitted.data.submission_id, null);
  assert.equal(admitted.data.pi_conversation_id, ensured.data.pi_conversation_id);
  await runtime.waitForIdle("ghost-fixture", "conversation-fixture");

  const key = JSON.stringify(["ghost-fixture", "conversation-fixture", "owner-turn-1"]);
  const run = controllerRuns.get(key);
  assert.equal(run.state, "answered");
  assert.equal(run.cancel_requested, false);
  assert.equal(run.submission_id !== null, true);
  assert.equal(run.entry_id !== null, true);
  assert.equal(receipts.size, 1);

  const replay = await runtime.handle(request);
  assert.equal(replay.data.submission_id, null);
  assert.equal(controllerRuns.get(key).submission_id, run.submission_id);
  assert.equal(callbacks.filter((call) => call.method === "conversation.reply").length, 1);
  const conflict = await runtime.handle(canonicalInput("canonical-input-1", "owner-turn-1", "MUTATED_CANONICAL_PROMPT"));
  assert.equal(conflict.status, "error");
  assert.equal(conflict.error_code, "conflict");
  const inspected = await runtime.handle(envelope("inspect-canonical-pi", {
    method: "conversation.inspect",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  }));
  assert.match(JSON.stringify(inspected.data.committed_view), /ORIGINAL_CANONICAL_PROMPT/u);
  assert.equal(provider.faux.state.callCount, 1);
});

test("a lost advisory callback reopens with the same immutable reply identity", async (t) => {
  const receipts = new Map();
  const invocationIds = [];
  const hostToolTransport = async (invocation) => {
    if (invocation.method === "inference.inspect") {
      return { status: "success", data: { inference_scope: invocation.inference_scope, authority_epoch: 1 } };
    }
    if (invocation.method === "memory.capabilities" || invocation.method === "documents.capabilities") {
      return { status: "success", data: { available_tools: [] } };
    }
    if (invocation.method !== "conversation.reply") return { status: "success", data: {} };
    invocationIds.push(invocation.invocation_id);
    const existing = receipts.get(invocation.invocation_id);
    if (existing) return existing;
    const receipt = { status: "success", data: { turn_id: invocation.turn_id, kind: "assistant_advisory" } };
    receipts.set(invocation.invocation_id, receipt);
    throw new Error("Simulated lost response after the Host committed the advisory turn.");
  };
  const first = await setup({
    base: canaryRoot,
    provider: createFakeProvider([fauxAssistantMessage([fauxText("Durable advisory after restart.")])]),
    hostToolTransport,
  });
  const request = canonicalInput("canonical-lost-reply", "owner-turn-lost-reply", "Persist one canonical turn.");
  assert.equal((await first.runtime.handle(request)).status, "success");
  await first.runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(invocationIds.length, 1);
  await first.runtime.close();

  const reopened = await openGhostRuntime({
    root: first.root,
    mode: "fixture",
    modelProvider: createFakeProvider(),
    hostToolTransport,
  });
  t.after(() => reopened.close());
  const reconciled = await reopened.handle(envelope("reconcile-canonical-reply", {
    method: "runtime.reconcile",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  }));
  assert.equal(reconciled.status, "success");
  await reopened.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(invocationIds.length, 2);
  assert.equal(invocationIds[1], invocationIds[0]);
  assert.equal(receipts.size, 1);
});

test("committed turn status with a lost ACK is observed after reopen without another inference", async (t) => {
  let statusAckLost = false;
  let hideCommittedState = true;
  const first = await setup({
    provider: createFakeProvider([fauxAssistantMessage([fauxText("Persisted answer, recovered by status inspection.")])]),
    onControllerStatus(run) {
      if (run.state === "answered" && !statusAckLost) {
        statusAckLost = true;
        throw new Error("Simulated lost response after the Host committed turn status.");
      }
    },
    onControllerInspect(run) {
      if (statusAckLost && hideCommittedState && run?.state === "answered") {
        return { status: "error", error_code: "fixture_inspection_unavailable", retry_class: "retry" };
      }
      return undefined;
    },
  });
  let firstClosed = false;
  t.after(async () => { if (!firstClosed) await first.runtime.close(); });
  const turnId = "owner-turn-lost-status-ack";
  const request = canonicalInput("canonical-lost-status", turnId, "Persist this answer once.");
  assert.equal((await first.runtime.handle(request)).status, "success");
  await first.runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  assert.equal(statusAckLost, true);
  assert.equal(first.provider.faux.state.callCount, 1);

  const key = JSON.stringify(["ghost-fixture", "conversation-fixture", turnId]);
  const committedRun = first.controllerRuns.get(key);
  const originalSubmissionId = committedRun.submission_id;
  const originalEntryId = committedRun.entry_id;
  assert.equal(typeof originalSubmissionId, "string");
  assert.equal(typeof originalEntryId, "string");
  assert.equal(committedRun.state, "answered");
  const originalStatusCall = first.controllerCalls.find((call) => call.method === "conversation.turn_status" && call.arguments.status === "answered");
  assert.equal(typeof originalStatusCall.invocation_id, "string");
  assert.equal(committedRun.latest_status_command_id, callbackCommandId("ghost-fixture", "conversation-fixture",
    originalStatusCall.invocation_id, "conversation.turn_status"), "Host inspection exposes the committed callback command identity");
  assert.equal(first.calls.some((call) => call.method === "conversation.reply"), false);
  await first.runtime.close();
  firstClosed = true;

  hideCommittedState = false;
  const providerAfterReopen = createFakeProvider();
  const reopened = await openGhostRuntime({
    root: first.root,
    mode: "fixture",
    modelProvider: providerAfterReopen,
    hostToolTransport: first.hostToolTransport,
  });
  t.after(() => reopened.close());
  const reconciled = await reopened.handle(envelope("reconcile-lost-status", {
    method: "runtime.reconcile",
    ghost_id: "ghost-fixture",
    conversation_id: "conversation-fixture",
  }));
  assert.equal(reconciled.status, "success");
  await reopened.waitForIdle("ghost-fixture", "conversation-fixture");

  const statusCalls = first.controllerCalls.filter((call) => call.method === "conversation.turn_status" && call.arguments.status === "answered");
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].invocation_id, originalStatusCall.invocation_id);
  assert.equal(first.controllerRuns.get(key).submission_id, originalSubmissionId);
  assert.equal(first.controllerRuns.get(key).entry_id, originalEntryId);
  assert.equal(first.controllerRuns.get(key).state, "answered");
  assert.equal(providerAfterReopen.faux.state.callCount, 0);
  assert.equal(first.calls.filter((call) => call.method === "conversation.reply").length, 1);
});

test("canonical input enforces the UTF-8 prompt boundary before Pi admission", async (t) => {
  const provider = createFakeProvider();
  const { runtime } = await setup({ base: canaryRoot, provider });
  t.after(() => runtime.close());
  const rejected = await runtime.handle(canonicalInput(
    "canonical-input-too-large",
    "owner-turn-too-large",
    "é".repeat(32_769),
  ));
  assert.equal(rejected.status, "error");
  assert.equal(rejected.error_code, "invalid_envelope");
  assert.equal(provider.faux.state.callCount, 0);
});

test("a 16k local conversation compacts old history before SDK clamps its answer to one token", async (t) => {
  const localCalls = [], brokerCalls = [];
  const provider = createRoutedProvider({ localCalls, brokerCalls,
    localUsage: (n) => ({ prompt_tokens: n === 1 ? 9000 : n === 2 ? 14618 : 2500, completion_tokens: 10, total_tokens: n === 1 ? 9010 : n === 2 ? 14628 : 2510 }),
  });
  const { runtime } = await setup({ mode: "broker", provider });
  t.after(() => runtime.close());
  await runtime.handle(ensure());
  for (let n = 1; n <= 3; n += 1) {
    const input = n < 3 ? `Historical turn ${n}: ${"bounded history. ".repeat(620)}` : "A new short question after the context grew";
    const admitted = await runtime.handle(canonicalInput(`context-${n}`, `context-turn-${n}`, input, "local_only"));
    assert.equal(admitted.status, "success");
    await runtime.waitForIdle("ghost-fixture", "conversation-fixture");
  }
  assert.equal(brokerCalls.length, 0);
  const summaryCall = localCalls.find((call) => JSON.stringify(call.body.messages).includes("context summarization assistant"));
  assert.ok(summaryCall, "the old 20k keep-recent default cannot select this prefix");
  assert.equal(summaryCall.body.max_tokens, 1024);
  assert.equal(localCalls.at(-1).body.max_tokens, 1024);
  assert.equal(JSON.stringify(localCalls.at(-1).body.messages).includes("A new short question"), true);
  const inspected = await runtime.handle(envelope("inspect-compacted-history", {
    method: "conversation.inspect", ghost_id: "ghost-fixture", conversation_id: "conversation-fixture",
  }));
  assert.ok(inspected.data.committed_view.entries.some((entry) => entry.kind === "pi.compaction"));
});


test("selected Owner task compacts only a no-tool history summary before its fresh current generation", async t => {
  const localCalls=[],brokerCalls=[],taskRef=`ot-${"9".repeat(64)}`;
  const provider=createRoutedProvider({localCalls,brokerCalls,localUsage:n=>({prompt_tokens:n===1?9000:n===2?14618:2500,completion_tokens:10,total_tokens:n===1?9010:n===2?14628:2510})});
  const {runtime}=await setup({mode:"broker",provider,onControllerInspect:(run,invocation)=>({status:"success",data:{run,task_contract:invocation.turn_id==="selected-context-3"?{task_contract_ref:taskRef,mode:"direct",input_digest:"8".repeat(64)}:null,task_admission:invocation.turn_id==="selected-context-3"?{kind:"owner-task-admission/1",turn_id:invocation.turn_id,ghost_id:"ghost-fixture",conversation_id:"conversation-fixture",task_contract_ref:taskRef,input_digest:"8".repeat(64),state:"admitted",goal_id:"existing-goal",goal_revision:1,work_id:"existing-work",work_state:"queued"}:null}})});
  t.after(()=>runtime.close());await runtime.handle(ensure());
  for(let n=1;n<=3;n++) {
    const prompt=n<3?`Authorized old history ${n}: ${"bounded history. ".repeat(620)}`:"Compare the newly selected immutable task input.";
    assert.equal((await runtime.handle(canonicalInput(`selected-context-command-${n}`,`selected-context-${n}`,prompt,"local_only"))).status,"success");
    await runtime.waitForIdle("ghost-fixture","conversation-fixture");
  }
  assert.equal(brokerCalls.length,0);
  const summary=localCalls.find(call=>JSON.stringify(call.body.messages).includes("context summarization assistant"));
  assert.ok(summary,"the selected task did not permanently block SDK compaction");
  assert.equal(summary.body.tools?.length??0,0,"SDK summary has no action tools");
  assert.equal(JSON.stringify(summary.body.messages).includes(taskRef),false,"ephemeral Owner descriptor did not enter historical summary text");
  assert.ok(JSON.stringify(localCalls.at(-1).body.messages).includes(taskRef),"real generation received the current freshly checked selected task");
  const inspected=await runtime.handle(envelope("inspect-selected-task-compaction",{method:"conversation.inspect",ghost_id:"ghost-fixture",conversation_id:"conversation-fixture"}));
  assert.ok(inspected.data.committed_view.entries.some(entry=>entry.kind==="pi.compaction"));
  assert.equal(JSON.stringify(inspected.data.committed_view).includes(taskRef),false,"descriptor was not persisted as ambient system authority");
});
