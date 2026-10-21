import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, afterEach } from "node:test";
import { createBrokerModelProvider, createLocalModelProvider } from "../src/models.js";
import { createHostToolTransport } from "../src/host-transport.js";
import { openGhostRuntime } from "../src/runtime.js";
import { openGhostIndex } from "../src/storage.js";
import { payloadDigest } from "../src/contract.js";

const GHOST_ID = "ghost-report-fixture";
const CONVERSATION_ID = "conversation-report-fixture";
const BROKER_MODEL = "minimax-code/MiniMax-M2.7";
const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const canaryRoot = join(repoRoot, ".lifetime-canary", "ghost-20261009T012047Z", "BReport1-tests", "work-reports");
const assignmentCanaryRoot = join(repoRoot, ".lifetime-canary", "ghost-20261009T012047Z", "BAssignment1-tests");
const LOCAL_MODEL_ID = "mlx-community/Qwen3.6-35B-A3B-4bit";
const LOCAL_BASE_URL = "http://127.0.0.1:8768/v1";
const tempRoots = new Set();
const runtimes = new Set();

afterEach(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => {});
  runtimes.clear();
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
  tempRoots.clear();
});

function lifetimeEnvelope(commandId, body) {
  return {
    protocol_version: "ghost-lifetime/1",
    command_id: commandId,
    payload_digest: payloadDigest(body),
    actor_ref: GHOST_ID,
    authority_epoch: 1,
    expected_revision: null,
    correlation_id: commandId,
    body,
  };
}

function ownerInput(commandId, turnId, prompt, privacy = "public") {
  return lifetimeEnvelope(commandId, {
    method: "conversation.input",
    ghost_id: GHOST_ID,
    conversation_id: CONVERSATION_ID,
    turn_id: turnId,
    prompt,
    privacy,
    attachments: [],
  });
}

function workReport(commandId, prompt, privacy = "public") {
  return lifetimeEnvelope(commandId, {
    method: "conversation.submit",
    ghost_id: GHOST_ID,
    conversation_id: CONVERSATION_ID,
    prompt,
    privacy,
    goal_id: "goal-report-fixture",
    goal_revision: 7,
  });
}

function assignmentEnvelope(commandId, prompt, privacy = "public") {
  return lifetimeEnvelope(commandId, {
    method: "conversation.assignment",
    ghost_id: GHOST_ID,
    conversation_id: CONVERSATION_ID,
    goal_id: "goal-assignment-fixture",
    goal_revision: 7,
    work_id: "work-assignment-fixture",
    prompt,
    privacy,
  });
}

function addAssignmentSource(assignments, envelope, {
  goalRevision = envelope.body.goal_revision,
  privacy = envelope.body.privacy,
  workId = envelope.body.work_id,
} = {}) {
  const { body } = envelope;
  assignments.set(envelope.command_id, {
    id: envelope.command_id,
    source_command_id: `host-origin-${envelope.command_id}`,
    ghost_id: body.ghost_id,
    conversation_id: body.conversation_id,
    goal_id: body.goal_id,
    goal_revision: goalRevision,
    work_id: workId,
    privacy,
    prompt: body.prompt,
    origin_kind: "owner_goal",
    parent_work_id: null,
    root_goal_id: body.goal_id,
  });
}

function addReportSource(reports, envelope) {
  const { body } = envelope;
  reports.set(envelope.command_id, {
    id: envelope.command_id,
    source_command_id: `host-origin-${envelope.command_id}`,
    ghost_id: body.ghost_id,
    conversation_id: body.conversation_id,
    goal_id: body.goal_id,
    goal_revision: body.goal_revision,
    privacy: body.privacy,
    prompt: body.prompt,
    reply: null,
  });
}

function brokerProvider(invoke) {
  return createBrokerModelProvider({ modelRef: BROKER_MODEL, invoke });
}
function localRoutedProvider(respond) {
  const requests = [];
  const localModelProvider = createLocalModelProvider({
    baseUrl: LOCAL_BASE_URL,
    modelId: LOCAL_MODEL_ID,
    fetchImpl: async (url, options) => {
      const request = { url, body: JSON.parse(options.body) };
      requests.push(request);
      if (!(request.body.messages ?? []).some((message) => message.role === "user")) {
        return new Response(JSON.stringify({
          error: { message: "TemplateError: No user query found in messages.", type: "internal_error" },
        }), { status: 500, headers: { "content-type": "application/json" } });
      }
      const message = await respond(request, requests.length);
      return new Response(JSON.stringify({
        id: `local-completion-${requests.length}`,
        object: "chat.completion",
        model: LOCAL_MODEL_ID,
        choices: [{
          index: 0,
          message,
          finish_reason: Array.isArray(message.tool_calls) ? "tool_calls" : "stop",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return {
    requests,
    provider: createBrokerModelProvider({
      modelRef: BROKER_MODEL,
      localModelProvider,
      invoke: async () => { throw new Error("private assignment unexpectedly selected the public broker"); },
    }),
  };
}


function completion(request, message) {
  return {
    id: request.id,
    status: 200,
    body: {
      id: `completion-${request.id}`,
      object: "chat.completion",
      model: BROKER_MODEL,
      created: 1,
      choices: [{
        index: 0,
        message,
        finish_reason: Array.isArray(message.tool_calls) ? "tool_calls" : "stop",
      }],
    },
  };
}

function createHostTransport(reports, {
  afterReportReply,
  assignments = new Map(),
  afterAssignmentInspect,
  works = new Map(),
  afterWorkSubmit,
} = {}) {
  const calls = [];
  const controllerRuns = new Map();
  const committedWorkSubmits = new Map();
  const workEffects = [];
  const committedWorkMatches = (assignment, work, submission) => Boolean(
    submission?.successful === true
      && submission.ghost_id === assignment.ghost_id
      && submission.conversation_id === assignment.conversation_id
      && submission.goal_id === assignment.goal_id
      && submission.goal_revision === assignment.goal_revision
      && submission.work_id === assignment.work_id
      && submission.work_revision === assignment.goal_revision
      && submission.authority_epoch === 1
      && submission.execution_id === work.execution_id
      && submission.execution_id === `pi-${createHash("sha256").update(submission.invocation_id, "utf8").digest("hex")}`
      && submission.prompt === assignment.prompt,
  );
  const runKey = (invocation) => JSON.stringify([
    invocation.ghost_id,
    invocation.conversation_id,
    invocation.turn_id,
  ]);
  const emptyRun = (invocation) => ({
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
  });
  const transport = async (invocation) => {
    calls.push(invocation);
    switch (invocation.method) {
      case "inference.inspect":
        return { status: "success", data: { inference_scope: invocation.inference_scope, authority_epoch: 1 } };
      case "memory.capabilities":
      case "documents.capabilities":
        return { status: "success", data: { available_tools: [] } };
      case "conversation.assignment.inspect": {
        const assignment = assignments.get(invocation.assignment_id);
        if (!assignment) return { status: "error", error_code: "not_found", retry_class: "never" };
        if (invocation.inference_scope === "public" && assignment.privacy !== "public") {
          return { status: "error", error_code: "disclosure_blocked", retry_class: "never" };
        }
        const work = works.get(assignment.work_id);
        if (work && work.execution_id !== null
          && !committedWorkMatches(assignment, work, committedWorkSubmits.get(work.id))) {
          return { status: "error", error_code: "work_submission_unverified", retry_class: "never" };
        }
        const receipt = { status: "success", data: { assignment: { ...assignment } } };
        return afterAssignmentInspect?.(invocation, receipt) ?? receipt;
      }
      case "work.submit": {
        const { work_id: workId } = invocation.arguments;
        const assignment = [...assignments.values()].find((candidate) =>
          candidate.work_id === workId
            && candidate.ghost_id === invocation.ghost_id
            && candidate.conversation_id === invocation.conversation_id);
        const work = works.get(workId);
        if (!assignment || !work || work.goal_id !== assignment.goal_id
          || work.goal_revision !== assignment.goal_revision || work.owner !== invocation.ghost_id
          || Object.keys(invocation.arguments).length !== 1) {
          return { status: "error", error_code: "work_submission_scope_conflict", retry_class: "never" };
        }
        if (work.execution_id !== null) {
          const prior = committedWorkSubmits.get(work.id);
          if (!committedWorkMatches(assignment, work, prior)
            || prior.invocation_id !== invocation.invocation_id
            || prior.prompt !== assignment.prompt) {
            return { status: "error", error_code: "work_submission_conflict", retry_class: "never" };
          }
          return { status: "success", data: { work: { ...work }, execution_id: work.execution_id } };
        }
        if (work.state !== "queued" || work.cancellation !== "none" || work.blocker !== null) {
          return { status: "error", error_code: "work_not_queued", retry_class: "never" };
        }
        const executionId = `pi-${createHash("sha256").update(invocation.invocation_id, "utf8").digest("hex")}`;
        const submission = {
          successful: true,
          invocation_id: invocation.invocation_id,
          ghost_id: invocation.ghost_id,
          conversation_id: invocation.conversation_id,
          goal_id: assignment.goal_id,
          goal_revision: assignment.goal_revision,
          work_id: work.id,
          work_revision: assignment.goal_revision,
          authority_epoch: 1,
          execution_id: executionId,
          prompt: assignment.prompt,
        };
        work.execution_id = executionId;
        work.state = "submitted";
        committedWorkSubmits.set(work.id, submission);
        workEffects.push(submission);
        const receipt = { status: "success", data: { work: { ...work }, execution_id: executionId } };
        return afterWorkSubmit ? afterWorkSubmit(invocation, receipt) : receipt;
      }
      case "work.delegate": {
        const parent = works.get(invocation.arguments.parent_work_id);
        const assignment = [...assignments.values()].find((candidate) =>
          candidate.work_id === invocation.arguments.parent_work_id
            && candidate.ghost_id === invocation.ghost_id
            && candidate.conversation_id === invocation.conversation_id);
        if (!parent || !assignment || parent.goal_id !== assignment.goal_id
          || parent.goal_revision !== assignment.goal_revision
          || Object.keys(invocation.arguments).length !== 5) {
          return { status: "error", error_code: "delegation_scope_conflict", retry_class: "never" };
        }
        const childId = `child-of-${parent.id}-${works.size}`;
        works.set(childId, {
          id: childId,
          goal_id: parent.goal_id,
          goal_revision: parent.goal_revision,
          owner: invocation.arguments.target_ghost_id,
          owner_revision: 1,
          state: "queued",
          cancellation: "none",
          execution_id: null,
          blocker: null,
        });
        return { status: "success", data: { parent_work_id: parent.id, work: { ...works.get(childId) } } };
      }
      case "work.wait": {
        const work = works.get(invocation.arguments.work_id);
        const assignment = [...assignments.values()].find((candidate) =>
          candidate.work_id === invocation.arguments.work_id
            && candidate.ghost_id === invocation.ghost_id
            && candidate.conversation_id === invocation.conversation_id);
        if (!work || !assignment || !Array.isArray(invocation.arguments.wait_for)
          || invocation.arguments.wait_for.some((childId) => works.get(childId)?.goal_id !== work.goal_id)) {
          return { status: "error", error_code: "wait_scope_conflict", retry_class: "never" };
        }
        work.blocker = `waiting:${JSON.stringify(invocation.arguments.wait_for)}`;
        return { status: "success", data: { work: { ...work } } };
      }
      case "work.inspect": {
        const work = works.get(invocation.arguments.work_id);
        const assignment = [...assignments.values()].find((candidate) =>
          candidate.work_id === invocation.arguments.work_id
            && candidate.ghost_id === invocation.ghost_id
            && candidate.conversation_id === invocation.conversation_id);
        if (!work || !assignment
          || (work.execution_id !== null
            && !committedWorkMatches(assignment, work, committedWorkSubmits.get(work.id)))) {
          return { status: "error", error_code: "work_not_found_or_unverified", retry_class: "never" };
        }
        return { status: "success", data: { work: { ...work }, result: null, acceptance: null } };
      }
      case "conversation.report.inspect": {
        const report = reports.get(invocation.report_id);
        return report
          ? { status: "success", data: { report: { ...report } } }
          : { status: "error", error_code: "not_found", retry_class: "never" };
      }
      case "conversation.report.reply": {
        const report = reports.get(invocation.report_id);
        if (!report) return { status: "error", error_code: "not_found", retry_class: "never" };
        if (report.reply && report.reply.text !== invocation.arguments.text) {
          return { status: "error", error_code: "conflict", retry_class: "never" };
        }
        const replayed = report.reply !== null;
        if (!report.reply) {
          report.reply = {
            turn_id: `host-advisory-${invocation.report_id}`,
            sequence: 1,
            text: invocation.arguments.text,
            text_digest: createHash("sha256").update(invocation.arguments.text, "utf8").digest("hex"),
          };
        }
        const receipt = {
          status: "success",
          data: {
            report_id: invocation.report_id,
            reply_id: report.reply.turn_id,
            sequence: report.reply.sequence,
            replayed,
          },
        };
        return afterReportReply ? afterReportReply(invocation, receipt) : receipt;
      }
      case "conversation.turn.inspect": {
        const key = runKey(invocation);
        let run = controllerRuns.get(key);
        if (!run) {
          run = emptyRun(invocation);
          controllerRuns.set(key, run);
        }
        return { status: "success", data: { run } };
      }
      case "conversation.turn_status": {
        const key = runKey(invocation);
        const prior = controllerRuns.get(key) ?? emptyRun(invocation);
        const run = {
          ...prior,
          state: invocation.arguments.status,
          submission_id: invocation.arguments.submission_id,
          entry_id: invocation.arguments.entry_id,
          reason_code: invocation.arguments.reason_code,
          cancel_requested: invocation.arguments.status === "cancelled" || prior.cancel_requested,
          latest_status_command_id: invocation.invocation_id,
          updated_at_ms: prior.updated_at_ms + 1,
        };
        controllerRuns.set(key, run);
        return { status: "success", data: { run } };
      }
      case "conversation.reply":
        return { status: "success", data: { turn_id: invocation.turn_id } };
      default:
        return { status: "error", error_code: "unexpected_fixture_action", retry_class: "never" };
    }
  };
  return { calls, transport, committedWorkSubmits, workEffects };
}

async function createRuntime({
  root,
  mode = "broker",
  provider,
  hostToolTransport,
  base = canaryRoot,
}) {
  if (!root) {
    await mkdir(base, { recursive: true, mode: 0o700 });
    root = await mkdtemp(join(base, "report-test-"));
    tempRoots.add(root);
  }
  const runtime = await openGhostRuntime({ root, mode, modelProvider: provider, hostToolTransport });
  runtimes.add(runtime);
  return { root, runtime };
}

async function readRun(root, turnId) {
  const index = await openGhostIndex(root, GHOST_ID);
  try {
    return await index.get(
      "SELECT status, submission_id, entry_id FROM ghost_canonical_turn_runs WHERE turn_id = ? AND conversation_id = ?",
      turnId,
      CONVERSATION_ID,
    );
  } finally {
    await index.close();
  }
}

async function readTurn(root, turnId) {
  const index = await openGhostIndex(root, GHOST_ID);
  try {
    return await index.get(
      "SELECT origin_kind, reply_state, reply_invocation_id, reply_text_digest FROM ghost_canonical_turns WHERE turn_id = ? AND conversation_id = ?",
      turnId,
      CONVERSATION_ID,
    );
  } finally {
    await index.close();
  }
}

async function readAssignment(root, assignmentId) {
  const index = await openGhostIndex(root, GHOST_ID);
  try {
    return await index.get(
      `SELECT origin_kind, privacy, identity_digest, sdk_task_id, sdk_entry_id
       FROM ghost_canonical_assignments WHERE assignment_id = ? AND conversation_id = ?`,
      assignmentId,
      CONVERSATION_ID,
    );
  } finally {
    await index.close();
  }
}

function within(promise, milliseconds = 5_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Work report fixture did not reach its expected state.")), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}


test("a Work report is ACKed while an Owner turn runs and admitted only after that turn", async () => {
  const reports = new Map();
  const host = createHostTransport(reports);
  const modelCalls = [];
  let ownerStarted;
  let releaseOwner;
  const started = new Promise((resolve) => { ownerStarted = resolve; });
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
  const provider = brokerProvider(async (request) => {
    modelCalls.push(request);
    if (modelCalls.length === 1) {
      ownerStarted();
      await ownerGate;
      return completion(request, { role: "assistant", content: "Owner reply committed." });
    }
    return completion(request, { role: "assistant", content: "Work report advisory committed." });
  });
  const { root, runtime } = await createRuntime({ provider, hostToolTransport: host.transport });

  try {
    const owner = await within(runtime.handle(ownerInput("owner-queue-request", "owner-queue-turn", "A real Owner turn.")));
    assert.equal(owner.status, "success");
    await within(started);

    const report = workReport("work-report-queued", "Authoritative metadata-only Work report.");
    addReportSource(reports, report);
    const admitted = await within(runtime.handle(report));
    assert.equal(admitted.status, "success");
    assert.equal(admitted.data.submission_id, null);
    assert.equal(modelCalls.length, 1);
    assert.equal((await readRun(root, report.command_id)).status, "queued");

    const replay = await within(runtime.handle(report));
    assert.equal(replay.status, "success");
    assert.equal((await readRun(root, report.command_id)).status, "queued");
    assert.equal(modelCalls.length, 1);

    releaseOwner();
    await within(runtime.waitForIdle(GHOST_ID, CONVERSATION_ID));
    assert.equal(modelCalls.length, 2);
    assert.equal(host.calls.filter(({ method }) => method === "conversation.report.reply").length, 1);
    assert.equal((await readRun(root, report.command_id)).status, "answered");
    assert.equal((await readTurn(root, report.command_id)).reply_state, "sent");
  } finally {
    releaseOwner();
  }
});

test("a report requiring a new Goal revision cannot block the current report before admission", async () => {
  const reports = new Map();
  const host = createHostTransport(reports);
  const old = workReport("superseded-queued-report", "Old revision result.");
  const current = lifetimeEnvelope("current-queued-report", {
    ...old.body, goal_revision: 8, prompt: "Current revision accepted result.",
  });
  addReportSource(reports, old);
  addReportSource(reports, current);
  let stale = false, releaseOwner, ownerStarted;
  const started = new Promise((resolve) => { ownerStarted = resolve; });
  const gate = new Promise((resolve) => { releaseOwner = resolve; });
  const calls = [];
  const provider = brokerProvider(async (request) => {
    calls.push(request);
    if (calls.length === 1) { ownerStarted(); await gate; }
    return completion(request, { role: "assistant", content: `Verified advisory ${calls.length}.` });
  });
  const hostToolTransport = (invocation) => stale && invocation.method === "conversation.report.inspect"
    && invocation.report_id === old.command_id
    ? Promise.resolve({ status: "error", error_code: "conflict", retry_class: "new_revision" })
    : host.transport(invocation);
  const { root, runtime } = await createRuntime({ provider, hostToolTransport });
  try {
    assert.equal((await runtime.handle(ownerInput("revision-owner", "revision-owner-turn", "Owner input."))).status, "success");
    await within(started);
    assert.equal((await runtime.handle(old)).status, "success");
    stale = true;
    assert.equal((await runtime.handle(current)).status, "success");
    releaseOwner();
    await within(runtime.waitForIdle(GHOST_ID, CONVERSATION_ID));
    assert.equal((await readRun(root, old.command_id)).status, "failed");
    assert.equal((await readTurn(root, old.command_id)).reply_state, "blocked");
    assert.equal((await readTurn(root, current.command_id)).reply_state, "sent");
    assert.equal(calls.length, 2, "the obsolete report must never invoke a model");
    assert.deepEqual(host.calls.filter((x) => x.method === "conversation.report.reply").map((x) => x.report_id), [current.command_id]);
  } finally { releaseOwner(); }
});

test("a report superseded during generation is blocked without withholding the next report", async () => {
  const reports = new Map();
  const host = createHostTransport(reports);
  const old = workReport("superseded-running-report", "Old revision result.");
  const current = lifetimeEnvelope("current-running-report", {
    ...old.body, goal_revision: 8, prompt: "Current revision accepted result.",
  });
  addReportSource(reports, old);
  addReportSource(reports, current);
  let stale = false, releaseOld, oldStarted;
  const started = new Promise((resolve) => { oldStarted = resolve; });
  const gate = new Promise((resolve) => { releaseOld = resolve; });
  let calls = 0;
  const provider = brokerProvider(async (request) => {
    calls += 1;
    if (calls === 1) { oldStarted(); await gate; }
    return completion(request, { role: "assistant", content: `Verified advisory ${calls}.` });
  });
  const hostToolTransport = (invocation) => stale && invocation.method === "conversation.report.inspect"
    && invocation.report_id === old.command_id
    ? Promise.resolve({ status: "error", error_code: "conflict", retry_class: "new_revision" })
    : host.transport(invocation);
  const { root, runtime } = await createRuntime({ provider, hostToolTransport });
  try {
    assert.equal((await runtime.handle(old)).status, "success");
    await within(started);
    assert.equal((await runtime.handle(current)).status, "success");
    stale = true;
    releaseOld();
    await within(runtime.waitForIdle(GHOST_ID, CONVERSATION_ID));
    assert.equal((await readTurn(root, old.command_id)).reply_state, "blocked");
    assert.equal((await readTurn(root, current.command_id)).reply_state, "sent");
    assert.equal(calls, 2);
    assert.deepEqual(host.calls.filter((x) => x.method === "conversation.report.reply").map((x) => x.report_id), [current.command_id]);
    await runtime.close();
    const reopened = await createRuntime({ root, provider, hostToolTransport });
    await within(reopened.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID));
    assert.equal(calls, 2, "reopening cannot replay either generation");
  } finally { releaseOld(); }
});

test("Work report model requests expose no memory tools and cannot send Goal or Work mutations", async () => {
  const reports = new Map();
  const host = createHostTransport(reports);
  const modelRequests = [];
  let modelTurn = 0;
  const provider = brokerProvider(async (request) => {
    modelRequests.push(request);
    if (modelTurn++ === 0) {
      return completion(request, {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "work-report-mutation-attempt",
          type: "function",
          function: {
            name: "work_submit",
            arguments: JSON.stringify({ work_id: "unrelated-work" }),
          },
        }],
      });
    }
    return completion(request, { role: "assistant", content: "The notification was read without mutation." });
  });
  const { root, runtime } = await createRuntime({ provider, hostToolTransport: host.transport });
  const report = workReport("work-report-no-owner-capability", "Report a completed worker result; do not start another execution.");
  addReportSource(reports, report);

  assert.equal((await runtime.handle(report)).status, "success");
  await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

  assert.equal(modelRequests.length, 2);
  assert.equal((modelRequests[0].body.tools ?? []).some((tool) => tool?.function?.name?.startsWith("memory_")), false);
  assert.equal(modelRequests[0].body.tools.some((tool) => tool?.function?.name === "work_submit"), true);
  assert.equal(host.calls.some(({ method }) => method === "memory.capabilities"), false);
  assert.equal(host.calls.some(({ method }) => [
    "goal.create", "goal.update", "work.submit", "work.steer", "work.cancel",
    "work.delegate", "work.wait", "mailbox.send",
  ].includes(method)), false);
  assert.equal(host.calls.some(({ method }) => method === "conversation.turn_status"), false);
  assert.equal(host.calls.filter(({ method }) => method === "conversation.report.reply").length, 1);
});

test("cached successful receiver admission imports the completed original SDK request without another inference", async () => {
  const reports = new Map();
  const host = createHostTransport(reports);
  const firstCalls = [];
  const firstProvider = brokerProvider(async (request) => {
    firstCalls.push(request);
    return completion(request, { role: "assistant", content: "Original completed SDK report answer." });
  });
  const first = await createRuntime({ mode: "fixture", provider: firstProvider, hostToolTransport: host.transport });
  const report = workReport("legacy-work-report-receiver", "An already admitted original report.");
  addReportSource(reports, report);

  const admitted = await first.runtime.handle(report);
  assert.equal(admitted.status, "success");
  await first.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);
  assert.equal(firstCalls.length, 1);
  await first.runtime.close();
  runtimes.delete(first.runtime);

  const recoveryCalls = [];
  const recoveryProvider = brokerProvider(async (request) => {
    recoveryCalls.push(request);
    return completion(request, { role: "assistant", content: "Must not replace the original answer." });
  });
  const reopened = await createRuntime({ root: first.root, mode: "broker", provider: recoveryProvider, hostToolTransport: host.transport });
  const replay = await reopened.runtime.handle(report);
  assert.equal(replay.status, "success");
  assert.equal(replay.data.submission_id, admitted.data.submission_id);
  assert.equal(recoveryCalls.length, 0);

  const reconciled = await reopened.runtime.handle(lifetimeEnvelope("recover-original-work-report", {
    method: "runtime.reconcile",
    ghost_id: GHOST_ID,
    conversation_id: CONVERSATION_ID,
  }));
  assert.equal(reconciled.status, "success");
  await reopened.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

  const reportReplies = host.calls.filter(({ method }) => method === "conversation.report.reply");
  assert.equal(reportReplies.length, 1);
  assert.equal(reportReplies[0].arguments.text, "Original completed SDK report answer.");
  assert.equal(Object.hasOwn(reportReplies[0], "turn_id"), false);
  assert.equal(recoveryCalls.length, 0);
  assert.equal((await readRun(first.root, report.command_id)).status, "answered");
  assert.equal((await readTurn(first.root, report.command_id)).reply_state, "sent");
});

test("lost report-reply ACK reconciles the original advisory without another reply or inference", async () => {
  const reports = new Map();
  let replyAttempts = 0;
  const host = createHostTransport(reports, {
    afterReportReply(_invocation, receipt) {
      replyAttempts += 1;
      if (replyAttempts === 1) throw new Error("simulated lost ACK after Host commit");
      return receipt;
    },
  });
  const firstCalls = [];
  const firstProvider = brokerProvider(async (request) => {
    firstCalls.push(request);
    return completion(request, { role: "assistant", content: "Exact original Work report advisory." });
  });
  const first = await createRuntime({ provider: firstProvider, hostToolTransport: host.transport });
  const report = workReport("work-report-lost-reply-ack", "Project the original committed SDK answer once.");
  addReportSource(reports, report);

  assert.equal((await first.runtime.handle(report)).status, "success");
  await first.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);
  assert.equal(firstCalls.length, 1);
  assert.equal(replyAttempts, 1);
  assert.equal((await readTurn(first.root, report.command_id)).reply_state, "pending");
  await first.runtime.close();
  runtimes.delete(first.runtime);

  const recoveryCalls = [];
  const recoveryProvider = brokerProvider(async (request) => {
    recoveryCalls.push(request);
    return completion(request, { role: "assistant", content: "Must not infer a replacement answer." });
  });
  const reopened = await createRuntime({ root: first.root, provider: recoveryProvider, hostToolTransport: host.transport });
  const reconciled = await reopened.runtime.handle(lifetimeEnvelope("reconcile-lost-work-report-ack", {
    method: "runtime.reconcile",
    ghost_id: GHOST_ID,
    conversation_id: CONVERSATION_ID,
  }));
  assert.equal(reconciled.status, "success");
  await reopened.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

  const turn = await readTurn(first.root, report.command_id);
  assert.equal(turn.reply_state, "sent");
  assert.equal(turn.reply_invocation_id, host.calls.find(({ method }) => method === "conversation.report.reply").invocation_id);
  assert.equal(recoveryCalls.length, 0);
  assert.equal(replyAttempts, 1);
  assert.equal(reports.get(report.command_id).reply.text, "Exact original Work report advisory.");
});
test("assignment reinspection blocks a stale Goal revision before any model request", async () => {
  const assignments = new Map();
  let inspections = 0;
  const host = createHostTransport(new Map(), {
    assignments,
    afterAssignmentInspect(_invocation, receipt) {
      inspections += 1;
      if (inspections !== 2) return receipt;
      return {
        ...receipt,
        data: {
          assignment: { ...receipt.data.assignment, goal_revision: receipt.data.assignment.goal_revision + 1 },
        },
      };
    },
  });
  const modelRequests = [];
  const provider = brokerProvider(async (request) => {
    modelRequests.push(request);
    return completion(request, { role: "assistant", content: "Must not run against a stale revision." });
  });
  const { root, runtime } = await createRuntime({
    provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });
  const assignment = assignmentEnvelope("stale-assignment-revision", "Work only at the admitted revision.");
  addAssignmentSource(assignments, assignment);

  const admitted = await runtime.handle(assignment);
  assert.equal(admitted.status, "success");
  assert.equal(admitted.data.submission_id, null);
  await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

  assert.equal(modelRequests.length, 0);
  assert.equal((await readRun(root, assignment.command_id)).status, "failed");
  assert.equal((await readAssignment(root, assignment.command_id)).sdk_task_id, null);
  assert.equal(host.calls.some(({ method }) => [
    "conversation.turn_status", "conversation.reply", "conversation.report.reply",
  ].includes(method)), false);
});

test("unknown persisted context is made private and blocks a new Goal assignment", async () => {
  const assignments = new Map();
  const host = createHostTransport(new Map(), { assignments });
  const firstRoute = localRoutedProvider((_request, index) => ({
    role: "assistant",
    content: `Existing private conversation ${index}.`,
  }));
  const first = await createRuntime({
    provider: firstRoute.provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });
  const prior = ownerInput("unknown-floor-prior", "unknown-floor-prior-turn", "Persisted private context.", "private");
  assert.equal((await first.runtime.handle(prior)).status, "success");
  await first.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);
  await first.runtime.close();
  runtimes.delete(first.runtime);

  const index = await openGhostIndex(first.root, GHOST_ID);
  try {
    await index.run("UPDATE ghost_conversations SET privacy = 'unknown' WHERE external_id = ?", CONVERSATION_ID);
  } finally {
    await index.close();
  }
  const recoveryRoute = localRoutedProvider(() => ({ role: "assistant", content: "Must not run." }));
  const reopened = await createRuntime({
    root: first.root,
    provider: recoveryRoute.provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });
  const assignment = assignmentEnvelope("unknown-floor-assignment", "Do not inherit unknown history.", "public");
  addAssignmentSource(assignments, assignment);

  const rejected = await reopened.runtime.handle(assignment);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.error_code, "disclosure_blocked");
  assert.equal(recoveryRoute.requests.length, 0);
  assert.equal(host.calls.some(({ method }) => method === "conversation.assignment.inspect"), false);
  const reopenedIndex = await openGhostIndex(first.root, GHOST_ID);
  try {
    const privacy = await reopenedIndex.get(
      "SELECT privacy FROM ghost_conversations WHERE external_id = ?",
      CONVERSATION_ID,
    );
    assert.equal(privacy.privacy, "non_public");
  } finally {
    await reopenedIndex.close();
  }
});

test("assignment replay isolates Owner context and rejects foreign Work, extra controls, and duplicate Goal mutations", async () => {
  const assignments = new Map();
  const host = createHostTransport(new Map(), { assignments });
  let assignmentRequestStarted;
  const assignmentStarted = new Promise((resolve) => { assignmentRequestStarted = resolve; });
  let releaseAssignment;
  const assignmentGate = new Promise((resolve) => { releaseAssignment = resolve; });
  const assignmentPrompt = "Work only on the existing assigned Goal and Work.";
  const privateRoute = localRoutedProvider(async (_request, index) => {
    if (index === 1) return { role: "assistant", content: "Owner-only history was committed." };
    if (index === 2) {
      assignmentRequestStarted();
      await assignmentGate;
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "assignment-foreign-work-attempt",
            type: "function",
            function: {
              name: "work_submit",
              arguments: JSON.stringify({ work_id: "foreign-work" }),
            },
          },
          {
            id: "assignment-extra-work-prompt-control",
            type: "function",
            function: {
              name: "work_submit",
              arguments: JSON.stringify({ work_id: "work-assignment-fixture", prompt: "Substitute a different task." }),
            },
          },
          {
            id: "assignment-forged-work-steer",
            type: "function",
            function: {
              name: "work_steer",
              arguments: JSON.stringify({
                work_id: "work-assignment-fixture",
                prompt: "Steer work without Owner authority.",
              }),
            },
          },
          {
            id: "assignment-duplicate-goal-attempt",
            type: "function",
            function: {
              name: "goal_create",
              arguments: JSON.stringify({ prompt: assignmentPrompt, acceptance_spec: {} }),
            },
          },
        ],
      };
    }
    throw new Error("Assignment fixture model dispatch failed after the Host-boundary checks.");
  });
  const { root, runtime } = await createRuntime({
    provider: privateRoute.provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });
  try {
    const prior = ownerInput(
      "assignment-private-parent",
      "assignment-private-parent-turn",
      "PRIVATE_PARENT_HISTORY_SECRET",
      "private",
    );
    assert.equal((await runtime.handle(prior)).status, "success");
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);
    const assignment = assignmentEnvelope(
      "isolated-goal-assignment",
      assignmentPrompt,
      "private",
    );
    addAssignmentSource(assignments, assignment);

    const admitted = await runtime.handle(assignment);
    assert.equal(admitted.status, "success");
    assert.equal(admitted.data.submission_id, null);
    await within(assignmentStarted);
    const original = await readAssignment(root, assignment.command_id);
    assert.notEqual(original.sdk_task_id, null);

    const replay = await runtime.handle(assignment);
    assert.equal(replay.status, "success");
    assert.equal((await readAssignment(root, assignment.command_id)).sdk_task_id, original.sdk_task_id);
    assert.equal(privateRoute.requests.length, 2);
    releaseAssignment();
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    const assignmentRequest = privateRoute.requests[1];
    assert.equal(JSON.stringify(assignmentRequest.body.messages).includes("PRIVATE_PARENT_HISTORY_SECRET"), false);
    const requirements = assignmentRequest.body.messages
      .filter((message) => message.role === "user")
      .map((message) => { try { return JSON.parse(message.content); } catch { return null; } })
      .find((message) => message?.native_worker_requirements !== undefined);
    assert.equal(requirements.native_worker_requirements, assignmentPrompt);
    assert.equal(requirements.assigned_work_id, "work-assignment-fixture");
    assert.match(requirements.controller_task, /After submission.*finish/);
    assert.equal(host.calls.some(({ method }) => [
      "work.submit", "goal.create", "goal.update", "work.steer", "work.cancel", "work.delegate",
    ].includes(method)), false);
    assert.equal(host.calls.some(({ method, turn_id }) =>
      method === "conversation.turn_status" && turn_id === assignment.command_id), false);
    assert.equal(host.calls.some(({ method, turn_id, report_id }) =>
      (method === "conversation.reply" && turn_id === assignment.command_id)
      || (method === "conversation.report.reply" && report_id === assignment.command_id)), false);
    const run = await readRun(root, assignment.command_id);
    const stored = await readAssignment(root, assignment.command_id);
    assert.equal(run.status, "failed");
    assert.equal(run.submission_id, null);
    assert.notEqual(stored.sdk_task_id, null);
    assert.equal(stored.sdk_entry_id, null);

    const inspected = await runtime.handle(lifetimeEnvelope("inspect-isolated-assignment", {
      method: "conversation.inspect",
      ghost_id: GHOST_ID,
      conversation_id: CONVERSATION_ID,
    }));
    assert.equal(inspected.status, "success");
    const assignmentUserEntries = inspected.data.committed_view.entries.filter((entry) =>
      entry.model?.some((message) => message.role === "user"
        && JSON.stringify(message).includes(assignment.body.prompt)));
    assert.equal(assignmentUserEntries.length, 0);
  } finally {
    releaseAssignment();
  }
});

test("assignment work_children is a read-only inspection of only the exact assigned Work", async () => {
  const assignments = new Map();
  const works = new Map();
  const host = createHostTransport(new Map(), { assignments, works });
  let assignmentRequestStarted;
  const assignmentStarted = new Promise((resolve) => { assignmentRequestStarted = resolve; });
  let releaseAssignment;
  const assignmentGate = new Promise((resolve) => { releaseAssignment = resolve; });
  const assignmentPrompt = "Inspect the assigned Work graph with work_children.";
  const privateRoute = localRoutedProvider(async (_request, index) => {
    if (index === 1) return { role: "assistant", content: "Owner-only history was committed." };
    if (index === 2) {
      assignmentRequestStarted();
      await assignmentGate;
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "assignment-children-exact",
            type: "function",
            function: {
              name: "work_children",
              arguments: JSON.stringify({ work_id: "work-assignment-fixture" }),
            },
          },
          {
            id: "assignment-children-foreign",
            type: "function",
            function: {
              name: "work_children",
              arguments: JSON.stringify({ work_id: "foreign-work" }),
            },
          },
        ],
      };
    }
    if (index === 3) return { role: "assistant", content: "Only the assigned Work graph was inspected." };
    throw new Error("Assignment fixture model dispatch failed after the boundary checks.");
  });
  const { runtime } = await createRuntime({
    provider: privateRoute.provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });
  try {
    const prior = ownerInput(
      "assignment-children-owner",
      "assignment-children-owner-turn",
      "PRIVATE_PARENT_HISTORY_SECRET",
      "private",
    );
    assert.equal((await runtime.handle(prior)).status, "success");
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    const assignment = assignmentEnvelope(
      "children-scoped-assignment",
      assignmentPrompt,
      "private",
    );
    addAssignmentSource(assignments, assignment);
    works.set(assignment.body.work_id, {
      id: assignment.body.work_id,
      goal_id: assignment.body.goal_id,
      goal_revision: assignment.body.goal_revision,
      owner: GHOST_ID,
      owner_revision: 1,
      state: "queued",
      cancellation: "none",
      execution_id: null,
      blocker: null,
    });

    const admitted = await runtime.handle(assignment);
    assert.equal(admitted.status, "success");
    assert.equal(admitted.data.submission_id, null);
    await within(assignmentStarted);
    releaseAssignment();
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    // The exact assigned Work was inspected read-only; the foreign Work ID was
    // denied at the boundary and never reached the Host.
    const childrenCalls = host.calls.filter(({ method }) => method === "work.children");
    assert.equal(childrenCalls.length, 1);
    assert.equal(childrenCalls[0].arguments.work_id, "work-assignment-fixture");
    assert.deepEqual(Object.keys(childrenCalls[0].arguments), ["work_id"]);
    assert.equal(host.calls.some(({ method }) => [
      "work.submit", "work.steer", "work.cancel", "work.delegate",
      "goal.create", "goal.update", "mailbox.send",
    ].includes(method)), false);
    assert.equal(privateRoute.requests.length, 3);
    assert.equal(JSON.stringify(privateRoute.requests[2].body.messages).includes("PRIVATE_PARENT_HISTORY_SECRET"), false);
  } finally {
    releaseAssignment();
  }
});

test("assignment inspection reservation blocks legacy SDK admission before Host authority is confirmed", async () => {
  const assignments = new Map();
  let inspectionStarted;
  const assignmentInspectionStarted = new Promise((resolve) => { inspectionStarted = resolve; });
  let releaseInspection;
  const inspectionGate = new Promise((resolve) => { releaseInspection = resolve; });
  const host = createHostTransport(new Map(), {
    assignments,
    afterAssignmentInspect: async (_invocation, receipt) => {
      inspectionStarted();
      await inspectionGate;
      return receipt;
    },
  });
  const modelRequests = [];
  const provider = brokerProvider(async (request) => {
    modelRequests.push(request);
    throw new Error("Assignment fixture model dispatch began only after authority confirmation.");
  });
  const { root, runtime } = await createRuntime({
    mode: "fixture",
    provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });
  const assignment = assignmentEnvelope("assignment-admission-reservation", "Start only the authorized assigned Work.");
  addAssignmentSource(assignments, assignment);

  try {
    const admission = runtime.handle(assignment);
    await within(assignmentInspectionStarted);

    const legacy = await runtime.handle(workReport(
      "legacy-submit-during-assignment-inspection",
      "This legacy SDK submission must not interleave.",
    ));
    assert.equal(legacy.status, "error");
    assert.equal(legacy.error_code, "canonical_turn_active");
    assert.equal(modelRequests.length, 0);

    releaseInspection();
    assert.equal((await within(admission)).status, "success");
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);
    assert.equal(modelRequests.length, 1);
    assert.equal((await readRun(root, assignment.command_id)).status, "failed");
    assert.equal(host.calls.some(({ method }) => method === "conversation.report.inspect"), false);
  } finally {
    releaseInspection();
  }
});
test("authorized Goal assignment preserves the exact Work handle across a lost ACK and reopen", async () => {
  const assignments = new Map();
  const works = new Map();
  const assignmentPrompt = "Execute only the exact current Goal prompt bytes.";
  let lostWorkAck = 0;
  const host = createHostTransport(new Map(), {
    assignments,
    works,
    afterWorkSubmit(_invocation, receipt) {
      lostWorkAck += 1;
      if (lostWorkAck === 1) throw new Error("simulated lost ACK after durable Work submission");
      return receipt;
    },
  });
  let assignmentRequestStarted;
  const assignmentStarted = new Promise((resolve) => { assignmentRequestStarted = resolve; });
  let releaseAssignment;
  const assignmentGate = new Promise((resolve) => { releaseAssignment = resolve; });
  const localRoute = localRoutedProvider(async (_request, index) => {
    if (index === 1) return { role: "assistant", content: "Private Owner history remains committed." };
    if (index === 2) {
      assignmentRequestStarted();
      await assignmentGate;
      return {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "authorized-original-work-submit",
          type: "function",
          function: {
            name: "work_submit",
            arguments: JSON.stringify({ work_id: "work-assignment-fixture" }),
          },
        }],
      };
    }
    if (index === 3) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "inspect-original-work-after-lost-ack",
          type: "function",
          function: {
            name: "work_inspect",
            arguments: JSON.stringify({ work_id: "work-assignment-fixture" }),
          },
        }],
      };
    }
    if (index === 4) {
      return { role: "assistant", content: "The original submitted Work handle remains active; no result acceptance is claimed." };
    }
    throw new Error("A completed cached assignment must not request another model turn.");
  });
  const first = await createRuntime({
    provider: localRoute.provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });

  try {
    const prior = ownerInput(
      "assignment-recovery-private-owner",
      "assignment-recovery-private-owner-turn",
      "PRIVATE_PARENT_HISTORY_SECRET",
      "private",
    );
    assert.equal((await first.runtime.handle(prior)).status, "success");
    await first.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    const assignment = assignmentEnvelope(
      "authorized-existing-work-assignment",
      assignmentPrompt,
      "private",
    );
    addAssignmentSource(assignments, assignment);
    works.set(assignment.body.work_id, {
      id: assignment.body.work_id,
      goal_id: assignment.body.goal_id,
      goal_revision: assignment.body.goal_revision,
      owner: GHOST_ID,
      owner_revision: 1,
      state: "queued",
      cancellation: "none",
      execution_id: null,
      blocker: null,
    });

    const admitted = await first.runtime.handle(assignment);
    assert.equal(admitted.status, "success");
    assert.equal(admitted.data.submission_id, null);
    await within(assignmentStarted);
    const original = await readAssignment(first.root, assignment.command_id);
    assert.notEqual(original.sdk_task_id, null);

    const replay = await first.runtime.handle(assignment);
    assert.equal(replay.status, "success");
    assert.equal((await readAssignment(first.root, assignment.command_id)).sdk_task_id, original.sdk_task_id);
    assert.equal(localRoute.requests.length, 2);
    releaseAssignment();
    await first.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    assert.equal(localRoute.requests.length, 4);
    for (const request of localRoute.requests.slice(1)) {
      const messages = request.body.messages ?? [];
      assert.equal(JSON.stringify(messages).includes("PRIVATE_PARENT_HISTORY_SECRET"), false);
    }

    const submitCalls = host.calls.filter(({ method }) => method === "work.submit");
    assert.equal(submitCalls.length, 1);
    assert.equal(lostWorkAck, 1);
    assert.equal(host.workEffects.length, 1);
    const committed = host.committedWorkSubmits.get(assignment.body.work_id);
    assert.equal(committed.successful, true);
    assert.equal(committed.invocation_id, submitCalls[0].invocation_id);
    assert.equal(committed.ghost_id, GHOST_ID);
    assert.equal(committed.conversation_id, CONVERSATION_ID);
    assert.equal(committed.goal_id, assignment.body.goal_id);
    assert.equal(committed.goal_revision, assignment.body.goal_revision);
    assert.equal(committed.work_revision, assignment.body.goal_revision);
    assert.equal(committed.authority_epoch, assignment.authority_epoch);
    assert.equal(committed.execution_id, `pi-${createHash("sha256").update(submitCalls[0].invocation_id, "utf8").digest("hex")}`);
    assert.equal(committed.prompt, assignmentPrompt);
    assert.equal(works.get(assignment.body.work_id).state, "submitted");
    assert.equal(host.calls.some(({ method, turn_id }) =>
      method === "conversation.turn_status" && turn_id === assignment.command_id), false);
    assert.equal(host.calls.some(({ method, turn_id, report_id }) =>
      (method === "conversation.reply" && turn_id === assignment.command_id)
      || (method === "conversation.report.reply" && report_id === assignment.command_id)), false);

    const run = await readRun(first.root, assignment.command_id);
    const stored = await readAssignment(first.root, assignment.command_id);
    assert.equal(run.status, "answered");
    assert.equal(run.submission_id, null);
    assert.notEqual(run.entry_id, null);
    assert.notEqual(stored.sdk_task_id, null);
    assert.notEqual(stored.sdk_entry_id, null);

    const inspected = await first.runtime.handle(lifetimeEnvelope("inspect-assignment-owner-history", {
      method: "conversation.inspect",
      ghost_id: GHOST_ID,
      conversation_id: CONVERSATION_ID,
    }));
    assert.equal(inspected.status, "success");
    assert.equal(JSON.stringify(inspected.data.committed_view.entries).includes("PRIVATE_PARENT_HISTORY_SECRET"), true);
    const assignmentUserEntries = inspected.data.committed_view.entries.filter((entry) =>
      entry.model?.some((message) => message.role === "user"
        && JSON.stringify(message).includes(assignmentPrompt)));
    assert.equal(assignmentUserEntries.length, 0);

    await first.runtime.close();
    runtimes.delete(first.runtime);
    const recoveryRoute = localRoutedProvider(() => {
      throw new Error("A committed assignment must not infer again after reopen.");
    });
    const reopened = await createRuntime({
      root: first.root,
      provider: recoveryRoute.provider,
      hostToolTransport: host.transport,
    });
    const cached = await reopened.runtime.handle(assignment);
    assert.equal(cached.status, "success");
    assert.equal(cached.data.submission_id, null);
    const reconciled = await reopened.runtime.handle(lifetimeEnvelope("reconcile-assignment-after-reopen", {
      method: "runtime.reconcile",
      ghost_id: GHOST_ID,
      conversation_id: CONVERSATION_ID,
    }));
    assert.equal(reconciled.status, "success");
    await reopened.runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);
    const recovered = await readAssignment(first.root, assignment.command_id);
    assert.equal(recovered.sdk_task_id, stored.sdk_task_id);
    assert.equal(recovered.sdk_entry_id, stored.sdk_entry_id);
    assert.equal(recoveryRoute.requests.length, 0);
    assert.equal(host.workEffects.length, 1);
    assert.equal(host.calls.filter(({ method }) => method === "work.submit").length, 1);
    assert.equal((await readRun(first.root, assignment.command_id)).submission_id, null);
  } finally {
    releaseAssignment();
  }
});

test("exact committed Work submission recovers without a current grant or another Host mutation", async (t) => {
  await mkdir(assignmentCanaryRoot, { recursive: true, mode: 0o700 });
  const hostRoot = await mkdtemp(join(assignmentCanaryRoot, "transport-recovery-"));
  tempRoots.add(hostRoot);
  const controlToken = "a".repeat(64);
  await writeFile(join(hostRoot, ".ghost-control.json"), JSON.stringify({
    protocol: "ghost-control",
    protocol_version: 1,
    host: "127.0.0.1",
    port: 9,
    token: controlToken,
  }), { mode: 0o600 });

  const invocationId = "committed-original-work-submit";
  const executionId = `pi-${createHash("sha256").update(invocationId, "utf8").digest("hex")}`;
  const workId = "work-transport-recovery";
  const goalId = "goal-transport-recovery";
  const prompt = "Run only the exact immutable Goal prompt.";
  const grantForAnotherRoute = {
    ghost_id: GHOST_ID,
    authority_epoch: 1,
    computer_id: "replacement-computer",
    task_snapshot_root: "/tmp/replacement-task-root",
    model: "replacement-model",
    thinking: "max",
    allowed_tools: ["work_read"],
    privacy_classes: ["public"],
    deadline_ms: 30_000,
    max_progress_bytes: 4096,
  };
  let current;
  let mutationCount = 0;
  const response = (data) => new Response(JSON.stringify({
    ok: true,
    result: {
      status: "success",
      summary: "fixture Host response",
      artifacts: [],
      next_actions: [],
      data,
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/v1/bootstrap/")) {
      const nonce = parsed.pathname.slice("/api/v1/bootstrap/".length);
      const proof = createHmac("sha256", controlToken)
        .update("ghost-control-bootstrap-v1\0")
        .update(nonce)
        .digest("hex");
      return new Response(JSON.stringify({ protocol: "ghost-control", version: 1, proof }), { status: 200 });
    }
    assert.equal(parsed.pathname, "/api/v1/pi/action");
    const request = JSON.parse(options.body);
    const method = request.envelope.body.method;
    if (method === "work.inspect") {
      const data = { work: { ...current.work }, result: null, acceptance: null };
      if (Object.hasOwn(current, "grant")) data.worker_grant = current.grant;
      return response(data);
    }
    if (method === "goal.inspect") return response({ goal: { ...current.goal } });
    if (method === "work.submit") {
      mutationCount += 1;
      return response({
        work: { ...current.work, state: "submitted", execution_id: executionId },
        execution_id: executionId,
      });
    }
    throw new Error(`Unexpected Host callback ${method}.`);
  });

  const transport = createHostToolTransport({
    hostRoot,
    callbackToken: "fixture-callback-token",
    authorityEpoch: 1,
  });
  const resetCurrent = (workChanges = {}, goalChanges = {}, grant) => {
    current = {
      work: {
        id: workId,
        goal_id: goalId,
        goal_revision: 7,
        owner: GHOST_ID,
        owner_revision: 1,
        state: "running",
        execution_id: executionId,
        cancellation: "none",
        blocker: null,
        ...workChanges,
      },
      goal: {
        id: goalId,
        revision: 7,
        prompt,
        accountable_ghost: GHOST_ID,
        reply_conversation: CONVERSATION_ID,
        privacy: "public",
        ...goalChanges,
      },
    };
    if (grant !== undefined) current.grant = grant;
  };
  const submit = (overrides = {}) => transport({
    method: "work.submit",
    invocation_id: overrides.invocationId ?? invocationId,
    ghost_id: GHOST_ID,
    conversation_id: CONVERSATION_ID,
    inference_scope: "public",
    conversation_disclosure: "public",
    arguments: {
      work_id: overrides.workId ?? workId,
      ...(overrides.extraArguments ?? {}),
    },
  });

  resetCurrent();
  const recovered = await submit();
  assert.equal(recovered.status, "success");
  assert.equal(mutationCount, 0);
  current.grant = grantForAnotherRoute;
  const recoveredAfterRouteChange = await submit();
  assert.equal(recoveredAfterRouteChange.status, "success");
  assert.equal(mutationCount, 0);
  const deniedReuseCases = [
    { extraArguments: { prompt: `${prompt} changed` } },
    { extraArguments: { model: "forged-model" } },
    { invocationId: "different-invocation" },
    { workId: "different-work" },
    { workChanges: { cancellation: "requested" } },
    { workChanges: { state: "stale" } },
    { workChanges: { blocker: "parent-incomplete" } },
    { workChanges: { owner: "foreign-ghost" } },
    { goalChanges: { revision: 8 } },
    { goalChanges: { accountable_ghost: "foreign-ghost" } },
    { goalChanges: { reply_conversation: "foreign-conversation" } },
    { goalChanges: { id: "different-goal" } },
  ];
  for (const { invocationId: requestId, workId: requestWorkId, extraArguments, workChanges, goalChanges } of deniedReuseCases) {
    resetCurrent(workChanges, goalChanges);
    await assert.rejects(submit({ invocationId: requestId, workId: requestWorkId, extraArguments }));
    assert.equal(mutationCount, 0);
  }

  resetCurrent({ state: "queued", execution_id: null });
  await assert.rejects(submit(), (error) => error instanceof Error
    && error.code === "ghost_native_grant_missing");
  assert.equal(mutationCount, 0);
});

test("assignment coordination delegates from and waits on only the exact assigned Work", async () => {
  const assignments = new Map();
  const works = new Map();
  const host = createHostTransport(new Map(), { assignments, works });
  const assignmentPrompt = "Coordinate this exact assigned Work with the approved operations role.";
  const OPS_GHOST = "ghost-operations-fixture";
  let assignmentRequestStarted;
  const assignmentStarted = new Promise((resolve) => { assignmentRequestStarted = resolve; });
  let releaseAssignment;
  const assignmentGate = new Promise((resolve) => { releaseAssignment = resolve; });
  const privateRoute = localRoutedProvider(async (_request, index) => {
    if (index === 1) return { role: "assistant", content: "Private Owner history was committed." };
    if (index === 2) {
      assignmentRequestStarted();
      await assignmentGate;
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "assignment-exact-delegate",
            type: "function",
            function: {
              name: "work_delegate",
              arguments: JSON.stringify({
                parent_work_id: "work-assignment-fixture",
                target_ghost_id: OPS_GHOST,
                summary: "Operations diagnoses the assigned incident read-only within the approved boundary.",
                artifact_refs: [],
                acceptance_spec: { required_checks: ["source_links"] },
              }),
            },
          },
          {
            id: "assignment-foreign-delegate",
            type: "function",
            function: {
              name: "work_delegate",
              arguments: JSON.stringify({
                parent_work_id: "foreign-work",
                target_ghost_id: OPS_GHOST,
                summary: "Cross-Work delegation attempt outside the assignment.",
                artifact_refs: [],
                acceptance_spec: {},
              }),
            },
          },
          {
            id: "assignment-exact-wait",
            type: "function",
            function: {
              name: "work_wait",
              arguments: JSON.stringify({
                work_id: "work-assignment-fixture",
                wait_for: ["prepared-child-work"],
              }),
            },
          },
          {
            id: "assignment-foreign-wait",
            type: "function",
            function: {
              name: "work_wait",
              arguments: JSON.stringify({
                work_id: "foreign-work",
                wait_for: [],
              }),
            },
          },
        ],
      };
    }
    if (index === 3) {
      return { role: "assistant", content: "The assigned Work was coordinated without touching another Work." };
    }
    throw new Error("Assignment coordination fixture dispatched an unexpected model turn.");
  });
  const { root, runtime } = await createRuntime({
    provider: privateRoute.provider,
    hostToolTransport: host.transport,
    base: assignmentCanaryRoot,
  });
  try {
    const prior = ownerInput(
      "coordination-private-parent",
      "coordination-private-parent-turn",
      "PRIVATE_PARENT_HISTORY_SECRET",
      "private",
    );
    assert.equal((await runtime.handle(prior)).status, "success");
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    const assignment = assignmentEnvelope("coordinated-goal-assignment", assignmentPrompt, "private");
    addAssignmentSource(assignments, assignment);
    works.set(assignment.body.work_id, {
      id: assignment.body.work_id,
      goal_id: assignment.body.goal_id,
      goal_revision: assignment.body.goal_revision,
      owner: GHOST_ID,
      owner_revision: 1,
      state: "queued",
      cancellation: "none",
      execution_id: null,
      blocker: null,
    });
    works.set("prepared-child-work", {
      id: "prepared-child-work",
      goal_id: assignment.body.goal_id,
      goal_revision: assignment.body.goal_revision,
      owner: OPS_GHOST,
      owner_revision: 1,
      state: "queued",
      cancellation: "none",
      execution_id: null,
      blocker: null,
    });

    assert.equal((await runtime.handle(assignment)).status, "success");
    await within(assignmentStarted);
    releaseAssignment();
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);


    const delegateCalls = host.calls.filter(({ method }) => method === "work.delegate");
    assert.equal(delegateCalls.length, 1);
    assert.equal(delegateCalls[0].arguments.parent_work_id, assignment.body.work_id);
    assert.equal(delegateCalls[0].arguments.target_ghost_id, OPS_GHOST);
    const waitCalls = host.calls.filter(({ method }) => method === "work.wait");
    assert.equal(waitCalls.length, 1);
    assert.equal(waitCalls[0].arguments.work_id, assignment.body.work_id);
    assert.equal(host.calls.some(({ method }) => [
      "work.submit", "goal.create", "goal.update", "work.steer", "work.cancel",
      "mailbox.send", "mailbox.inspect",
    ].includes(method)), false);

    const run = await readRun(root, assignment.command_id);
    assert.equal(run.status, "answered");
    assert.equal(run.submission_id, null);

  } finally {
    releaseAssignment();
  }
});

test("only a typed pre-submit refusal proves no effect; unknown failures stay ambiguous and redact diagnostics", async () => {
  for (const [code, expectedEffectClass] of [
    ["ghost_native_grant_missing", "no_effect"],
    [undefined, undefined],
  ]) {
  const assignments = new Map();
  const works = new Map();
  const host = createHostTransport(new Map(), { assignments, works });
  const privateDiagnostic = "PRIVATE_MUTATION_TRANSPORT_DIAGNOSTIC";
  const grantlessTransport = async (invocation) => {
    if (invocation.method === "work.submit") {
      throw Object.assign(new Error(privateDiagnostic), { code });
    }
    return host.transport(invocation);
  };
  const assignmentPrompt = "Submit only this exact Work when a current native grant exists.";
  let assignmentRequestStarted;
  const assignmentStarted = new Promise((resolve) => { assignmentRequestStarted = resolve; });
  let releaseAssignment;
  const assignmentGate = new Promise((resolve) => { releaseAssignment = resolve; });
  const privateRoute = localRoutedProvider(async (_request, index) => {
    if (index === 1) return { role: "assistant", content: "Private Owner history was committed." };
    if (index === 2) {
      assignmentRequestStarted();
      await assignmentGate;
      return {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "grantless-work-submit",
          type: "function",
          function: {
            name: "work_submit",
            arguments: JSON.stringify({ work_id: "work-assignment-fixture" }),
          },
        }],
      };
    }
    if (index === 3) {
      return { role: "assistant", content: "The exact Work has no current native grant; the missing prerequisite was reported." };
    }
    throw new Error("Grant-less submission fixture dispatched an unexpected model turn.");
  });
  const { root, runtime } = await createRuntime({
    provider: privateRoute.provider,
    hostToolTransport: grantlessTransport,
    base: assignmentCanaryRoot,
  });
  try {
    const prior = ownerInput(
      "grantless-private-parent",
      "grantless-private-parent-turn",
      "PRIVATE_PARENT_HISTORY_SECRET",
      "private",
    );
    assert.equal((await runtime.handle(prior)).status, "success");
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    const assignment = assignmentEnvelope("grantless-goal-assignment", assignmentPrompt, "private");
    addAssignmentSource(assignments, assignment);
    works.set(assignment.body.work_id, {
      id: assignment.body.work_id,
      goal_id: assignment.body.goal_id,
      goal_revision: assignment.body.goal_revision,
      owner: GHOST_ID,
      owner_revision: 1,
      state: "queued",
      cancellation: "none",
      execution_id: null,
      blocker: null,
    });

    assert.equal((await runtime.handle(assignment)).status, "success");
    await within(assignmentStarted);
    releaseAssignment();
    await runtime.waitForIdle(GHOST_ID, CONVERSATION_ID);

    assert.equal(host.calls.some(({ method }) => method === "work.submit"), false);
    const inspected = await runtime.handle(lifetimeEnvelope("inspect-grantless-assignment", {
      method: "conversation.inspect",
      ghost_id: GHOST_ID,
      conversation_id: CONVERSATION_ID,
    }));
    assert.equal(inspected.status, "success");
    const toolMessage = privateRoute.requests.at(-1).body.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "grantless-work-submit",
    );
    const toolResult = JSON.parse(toolMessage.content);
    assert.equal(toolResult.status, "error");
    assert.equal(toolResult.data?.host_effect_class, expectedEffectClass);
    assert.equal(JSON.stringify(inspected.data.committed_view.entries).includes(privateDiagnostic), false);
    const run = await readRun(root, assignment.command_id);
    assert.equal(run.status, "answered");
    assert.equal(works.get(assignment.body.work_id).execution_id, null);
  } finally {
    releaseAssignment();
  }
  }
});

test("Goal delegation must target the operations ghost approved by Host inspection", async (t) => {
  await mkdir(assignmentCanaryRoot, { recursive: true, mode: 0o700 });
  const hostRoot = await mkdtemp(join(assignmentCanaryRoot, "delegate-policy-"));
  tempRoots.add(hostRoot);
  const controlToken = "b".repeat(64);
  await writeFile(join(hostRoot, ".ghost-control.json"), JSON.stringify({
    protocol: "ghost-control",
    protocol_version: 1,
    host: "127.0.0.1",
    port: 9,
    token: controlToken,
  }), { mode: 0o600 });

  const OPS_GHOST = "ghost-operations-approved";
  const workId = "work-delegate-policy";
  const goalId = "goal-delegate-policy";
  const operationsPolicy = {
    approved_operations_ghost: OPS_GHOST,
    boundary: "read_only_diagnosis_owner_approved_recovery",
    role: "operations",
  };
  let acceptanceSpec = {};
  const delegateRequests = [];
  const response = (data) => new Response(JSON.stringify({
    ok: true,
    result: { status: "success", summary: "fixture Host response", artifacts: [], next_actions: [], data },
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/v1/bootstrap/")) {
      const nonce = parsed.pathname.slice("/api/v1/bootstrap/".length);
      const proof = createHmac("sha256", controlToken)
        .update("ghost-control-bootstrap-v1\0")
        .update(nonce)
        .digest("hex");
      return new Response(JSON.stringify({ protocol: "ghost-control", version: 1, proof }), { status: 200 });
    }
    assert.equal(parsed.pathname, "/api/v1/pi/action");
    const request = JSON.parse(options.body);
    const method = request.envelope.body.method;
    if (method === "work.inspect") {
      return response({
        work: {
          id: workId,
          goal_id: goalId,
          goal_revision: 7,
          owner: GHOST_ID,
          owner_revision: 1,
          state: "queued",
          execution_id: null,
          cancellation: "none",
          blocker: null,
        },
        result: null,
        acceptance: null,
        worker_grant: null,
      });
    }
    if (method === "goal.inspect") {
      return response({
        goal: {
          id: goalId,
          revision: 7,
          prompt: "Diagnose the incident through the approved operations role.",
          accountable_ghost: GHOST_ID,
          reply_conversation: CONVERSATION_ID,
          privacy: "public",
          acceptance_spec: acceptanceSpec,
        },
      });
    }
    if (method === "work.delegate") {
      delegateRequests.push(request);
      return response({
        parent_work_id: workId,
        work: {
          id: `child-of-${workId}`,
          goal_id: goalId,
          goal_revision: 7,
          owner: request.envelope.body.target_ghost_id,
          owner_revision: 1,
          state: "queued",
          execution_id: null,
          cancellation: "none",
          blocker: null,
        },
      });
    }
    throw new Error(`Unexpected Host callback ${method}.`);
  });

  const transport = createHostToolTransport({
    hostRoot,
    callbackToken: "fixture-callback-token",
    authorityEpoch: 1,
  });
  const delegate = (overrides = {}) => transport({
    method: "work.delegate",
    invocation_id: "delegation-policy-invocation",
    ghost_id: GHOST_ID,
    conversation_id: CONVERSATION_ID,
    inference_scope: "public",
    conversation_disclosure: "public",
    arguments: {
      parent_work_id: workId,
      target_ghost_id: OPS_GHOST,
      summary: "Read-only operations diagnosis inside the approved boundary.",
      artifact_refs: [],
      acceptance_spec: { required_checks: ["source_links"] },
      ...overrides,
    },
  });

  acceptanceSpec = { operations_policy: operationsPolicy };
  const delegated = await delegate();
  assert.equal(delegated.status, "success");
  assert.equal(delegateRequests.length, 1);
  assert.equal(delegateRequests[0].envelope.expected_revision, 7);
  assert.equal(delegateRequests[0].envelope.body.method, "work.delegate");
  assert.equal(delegateRequests[0].envelope.body.target_ghost_id, OPS_GHOST);
  assert.equal(delegateRequests[0].envelope.body.parent_work_id, workId);

  await assert.rejects(delegate({ target_ghost_id: "ghost-unapproved-specialist" }), (error) =>
    error instanceof Error
    && error.message === "Delegation for this Goal must target the operations ghost approved by its Host inspection; no delegate request was sent.");
  assert.equal(delegateRequests.length, 1);

  acceptanceSpec = {};
  const hostRouted = await delegate({ target_ghost_id: "ghost-registered-specialist" });
  assert.equal(hostRouted.status, "success");
  assert.equal(delegateRequests.length, 2);
  assert.equal(delegateRequests[1].envelope.body.target_ghost_id, "ghost-registered-specialist");
});
