import { expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, GenerationTask, Harness, UserEntry, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createEngine } from "../src/engine/index.ts";
import { FallbackRunsDoc } from "../src/engine/fallback.ts";
import { FakeEngine, harness, tempDir } from "./support.ts";

const ctx = BACKGROUND_CONTEXT;

test("recovery never attributes an older quota error to an aborted or unrelated released input", async () => {
  const path = tempDir();
  const f = harness(join(path, "ledger.db"));
  const ghost = f.core.createGhost({ name: "G", persona: "" });
  await f.core.idle();
  const id = ghost.directConversationId;
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "p", models: [{ id: "p-1", name: "P" }] }).provider);
  const pi = await Harness.open(await openNodeSqliteStorage(join(path, "pi.db")), { models, registry: createRegistry() }, ctx);
  const conversation = await pi.createConversation({ ownership: { kind: "ownerless" } }, ctx);
  f.ledger.tx(() => f.ledger.setPiConversationId(id, String(conversation.id)));
  const detail = "429 Token Plan usage limit reached";
  const oldError = await pi.commit(async (tx) => {
    const attempts = await tx.doc(FallbackRunsDoc, conversation.id);
    const oldInput = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "previous input", timestamp: 1 }] });
    const oldError = await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ ...fauxAssistantMessage("", { stopReason: "error", errorMessage: detail }), provider: "p", model: "p-1" }] });
    await tx.createSubmission({ type: "input", conversationId: conversation.id, requestId: "old", status: "unanswered", reason: "model_error", detail, entry: oldInput.id });
    await tx.createSubmission({ type: "input", conversationId: conversation.id, requestId: "aborted-unplaced", status: "unanswered", reason: "aborted" });
    const abortedInput = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "aborted", timestamp: 2 }] });
    await tx.createSubmission({ type: "input", conversationId: conversation.id, requestId: "aborted-placed", entry: abortedInput.id, status: "unanswered", reason: "aborted" });
    const unrelated = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "model failed without a quota response", timestamp: 3 }] });
    await tx.createSubmission({ type: "input", conversationId: conversation.id, requestId: "unrelated-model-error", entry: unrelated.id, status: "unanswered", reason: "model_error", detail });
    const current = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "new input", timestamp: 4 }] });
    await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ ...fauxAssistantMessage("", { stopReason: "error", errorMessage: detail }), provider: "p", model: "p-1" }] });
    await tx.createSubmission({ type: "input", conversationId: conversation.id, requestId: "current-quota", entry: current.id, status: "unanswered", reason: "model_error", detail });
    const cancelled = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "input whose fallback was cancelled", timestamp: 5 }] });
    const failedPrimary = await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ ...fauxAssistantMessage("", { stopReason: "error", errorMessage: detail }), provider: "p", model: "p-1" }] });
    await tx.createSubmission({ type: "input", conversationId: conversation.id, requestId: "aborted-fallback", entry: cancelled.id, status: "unanswered", reason: "model_error", detail });
    const taskId = await tx.createTask(GenerationTask, {}, { conversationId: conversation.id, ownership: { kind: "conversation" } });
    const task = tx.stagedTasks().find((task) => task.id === taskId);
    if (!task) throw new Error("fallback task missing");
    tx.setTask({ id: task.id, conversationId: task.conversationId, kind: task.kind, version: task.version, input: task.input, background: task.background, abortRequested: true, state: { status: "terminal", outcome: { status: "aborted" } } });
    attempts.byError[String(failedPrimary.id)] = { taskId };
    return oldError.id;
  }, ctx);
  await pi.close(ctx);
  const engine = await createEngine({
    core: f.core, storagePath: join(path, "pi.db"), models,
    sandbox: { envFor: async () => { throw new Error("no execution expected"); }, workspacePath: () => path, stageInputs: async () => {}, release: async () => {} },
    tools: { all: () => [], extensionsFor: () => [], instructionsFor: () => "" }, log: () => {},
  });
  f.core.attach(engine);
  try {
    for (const requestId of ["aborted-unplaced", "aborted-placed", "unrelated-model-error", "aborted-fallback"]) {
      expect(await engine.submissionRecovery!(id, requestId)).toMatchObject({ status: "unanswered", hit: null });
    }
    const correct = await engine.submissionRecovery!(id, "current-quota");
    expect(correct?.hit?.provider).toBe("p");
    expect(correct!.entryId).toBeGreaterThan(oldError);

    // Crash after release, then owner cancellation: the journal still names the previous error.
    // Inspecting that exact aborted request must advance the accepted queue, not freeze the probe.
    f.ledger.putSetting("quota", {
      entries: { p: { reason: detail, resumeAt: 1, failures: 1, probingBy: id } },
      records: [{ conversationId: id, attempts: 1, entryId: oldError, origin: "owner", priority: 0, providers: ["p"], queue: [
        { requestId: "aborted-unplaced", text: "resume", origin: "owner" },
        { requestId: "next-input", text: "next owner input", origin: "owner" },
      ], releasing: "aborted-unplaced", updatedAt: 1 }],
    });
    const delivery = new FakeEngine();
    delivery.submissionRecovery = engine.submissionRecovery!.bind(engine);
    f.core.attach(delivery);
    await f.core.quota.start();
    await f.core.idle();
    expect(delivery.to(id).map((input) => input.requestId)).toEqual(["next-input"]);
    f.core.quota.turnEnded(id, { entryId: 500, origin: "owner", providers: ["p"], serving: "p", hit: null });
    await f.core.idle();
    expect(f.core.quota.awaiting(id)).toBe(false);
  } finally { f.core.stop(); await f.core.idle(); await engine.close(); f.ledger.close(); }
});
