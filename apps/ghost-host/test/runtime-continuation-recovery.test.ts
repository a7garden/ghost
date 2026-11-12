import { expect, test } from "bun:test";
import { join } from "node:path";
import { Core } from "../src/core/core.ts";
import type { ArtifactStore } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FakeEngine, harness, MemorySecrets, noSandbox, tempDir } from "./support.ts";

async function restart(path: string, artifacts: ArtifactStore, previous: FakeEngine) {
  const ledger = new Ledger(path);
  const core = new Core({ ledger, artifacts, sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {} });
  const engine = new FakeEngine();
  for (const [key, input] of previous.submissions) engine.submissions.set(key, input);
  for (const [key, outcome] of previous.outcomes) engine.outcomes.set(key, outcome);
  core.attach(engine);
  await core.start();
  await core.idle();
  core.stop();
  return { ledger, core, engine };
}

test("a completed extension cannot shadow a newer revise verdict lost before admission", async () => {
  const path = join(tempDir(), "continuation.db");
  const f = harness(path);
  const ghost = f.core.createGhost({ name: "G", persona: "" });
  const work = f.core.works.createRoot({ ghostId: ghost.id, title: "Task", brief: "B", originConversationId: ghost.directConversationId });
  await f.core.idle();
  const conversationId = f.ledger.work(work.id).conversationId!;
  f.core.works.pauseForBudget(work.id);
  await f.core.idle();
  f.core.works.decide(work.id, "extend");
  await f.core.idle();
  const extension = f.engine.to(conversationId).find((input) => input.requestId.includes(":budget:extend:"))!;
  // Pi has settled the continuation; its Host settlement callback was cut off by the crash.
  f.engine.outcomes.set(extension.requestId, { status: "done", entryId: 100, serving: "p", hit: null });
  f.core.works.complete(work.id, { summary: "first result", artifacts: [] });
  await f.core.idle();
  expect(f.ledger.setting(`work-continuation:${work.id}`, null)).toBeNull();

  const send = f.engine.submit.bind(f.engine);
  const verdictId = `work:${work.id}:verdict:1`;
  f.engine.submit = async (id, input) => {
    if (input.requestId === verdictId) throw new Error("crash before verdict admission");
    await send(id, input);
  };
  f.core.works.applyVerdict(work.id, { outcome: "revise", source: "owner", reasons: "Use the newest attachment", scope: "Revise the report only", at: Date.now() });
  await f.core.idle();
  // A late callback for the old extension must not erase the new verdict journal.
  f.core.works.settleContinuation(conversationId, extension.requestId);
  f.core.stop(); f.ledger.close();

  const second = await restart(path, f.artifacts, f.engine);
  expect(second.ledger.work(work.id)).toMatchObject({ state: "running", revisionsUsed: 1 });
  const verdicts = second.engine.to(conversationId).filter((input) => input.requestId === verdictId);
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]!).toMatchObject({ origin: "verdict" });
  expect(verdicts[0]!.text).toContain("Use the newest attachment");
  expect(verdicts[0]!.text).toContain("Revise the report only");
  expect(second.engine.to(conversationId).filter((input) => input.requestId.includes(":recover:"))).toEqual([]);
  second.ledger.close();

  const third = await restart(path, f.artifacts, second.engine);
  expect(third.engine.to(conversationId).filter((input) => input.requestId === verdictId)).toHaveLength(1);
  expect(third.engine.to(conversationId).filter((input) => input.requestId === extension.requestId)).toHaveLength(1);
  third.ledger.close();
});

test("a settled continuation with a missed Host callback permits one generic recovery instead of stranding running Work", async () => {
  const path = join(tempDir(), "settled-continuation.db");
  const f = harness(path);
  const ghost = f.core.createGhost({ name: "G", persona: "" });
  const work = f.core.works.createRoot({ ghostId: ghost.id, title: "Task", brief: "B", originConversationId: ghost.directConversationId });
  await f.core.idle();
  const conversationId = f.ledger.work(work.id).conversationId!;
  f.core.works.blockForRepeat(work.id, "repeated refusal");
  await f.core.idle();
  f.core.works.decide(work.id, "continue");
  await f.core.idle();
  const continued = f.engine.to(conversationId).find((input) => input.requestId.includes(":repeat:continue:"))!;
  f.engine.outcomes.set(continued.requestId, { status: "done", entryId: 200, serving: "p", hit: null });
  f.core.stop(); f.ledger.close();

  const second = await restart(path, f.artifacts, f.engine);
  expect(second.engine.to(conversationId).filter((input) => input.requestId === continued.requestId)).toHaveLength(1);
  expect(second.engine.to(conversationId).filter((input) => input.requestId.includes(":recover:"))).toHaveLength(1);
  expect(second.ledger.setting(`work-continuation:${work.id}`, null)).toBeNull();
  second.ledger.close();
  const third = await restart(path, f.artifacts, second.engine);
  expect(third.engine.to(conversationId).filter((input) => input.requestId.includes(":recover:"))).toHaveLength(1);
  third.ledger.close();
});
