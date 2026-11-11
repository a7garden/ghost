import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Conversation, Ghost, Work } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { execute } from "../src/core/commands.ts";
import { Access } from "../src/core/access.ts";
import { DAILY_WAKES } from "../src/core/autonomy.ts";
import type { Core } from "../src/core/core.ts";
import { idFor } from "../src/core/ids.ts";
import type { ConversationSetup } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { SandboxEnvFactory } from "../src/integrations/ports.ts";
import { createToolSet } from "../src/tools/index.ts";
import { FakeEngine, harness, tempDir } from "./support.ts";

const MINUTE = 60_000;
const context = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;
const textOf = (result: ToolExecutionResult) => (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");

const sandbox: SandboxEnvFactory = {
  envFor: async () => {
    throw new Error("team tests never execute sandbox commands");
  },
  workspacePath: () => "/team-test",
  stageInputs: async () => {},
  release: async () => {},
};

interface Fixture {
  core: Core;
  engine: FakeEngine;
  ledger: Ledger;
  main: Ghost;
  alice: Ghost;
  bob: Ghost;
  mainDirect: Conversation;
  aliceDirect: Conversation;
  bobDirect: Conversation;
  use: (conversation: Conversation, name: string) => (args: unknown, callId: string) => Promise<ToolExecutionResult>;
}

const opened: { core: Core; ledger: Ledger }[] = [];
const files: string[] = [];
afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.core.idle();
    item.core.stop();
    item.ledger.close();
  }
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One main Ghost plus two teammates, each with a direct conversation bound to a Pi id the tools resolve. */
function team(path?: string): Fixture {
  const h = harness(path);
  opened.push(h);
  const tools = createToolSet({ core: h.core, sandbox, memory: null, documents: null, skills: null });
  // The first Ghost is the default: it is the main until the owner says otherwise.
  const main = h.core.createGhost({ name: "Main", persona: "You connect the team." });
  const alice = h.core.createGhost({ name: "Alice", persona: "You research." });
  const bob = h.core.createGhost({ name: "Bob", persona: "You implement.", model: { provider: "test", model: "test-model" } });
  // Only the main is due in these scenarios; unrelated random first-look offsets cannot steal the hook.
  for (const ghost of [alice, bob]) h.ledger.putSetting(`autonomy:${ghost.id}`, { nextAt: Date.now() + 3 * 24 * 60 * MINUTE });
  const bind = (ghost: Ghost) => {
    const conversation = h.ledger.conversation(ghost.directConversationId);
    h.ledger.setPiConversationId(conversation.id, `pi-${ghost.name}`);
    return conversation;
  };
  const use = (conversation: Conversation, name: string) => {
    const ghost = h.ledger.ghost(conversation.ghostId);
    const tool = tools
      .extensionsFor(conversation, ghost, null)
      .flatMap((extension) => extension.tools ?? [])
      .find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} is not offered to ${ghost.name}`);
    return (args: unknown, callId: string) =>
      tool.execute(args as never, { conversationId: `pi-${ghost.name}`, callId, output: () => {}, diagnostic: () => {} } as unknown as ToolExecutionApi, context());
  };
  return { ...h, main, alice, bob, mainDirect: bind(main), aliceDirect: bind(alice), bobDirect: bind(bob), use };
}

/** A live root Work of one teammate, created through the real direct-conversation tool. */
async function peerWork(f: Fixture, requester: Conversation, assignee: Ghost, extra: Record<string, unknown> = {}): Promise<Work> {
  const create = f.use(requester, "work_create");
  const callId = `create-${Math.random()}`;
  const result = await create({ title: "Team task", brief: "Collect the numbers", deadline_minutes: 30, ghost_id: assignee.id, ...extra }, callId);
  expect(result.isError).toBeFalsy();
  await f.core.idle();
  const work = f.ledger.work(idFor(requester.id, callId));
  expect(work.state).toBe("running");
  return work;
}

/** An owner-approved, bounded Activity run, not an ordinary Work with an ignored tool argument. */
async function activityWork(f: Fixture): Promise<Work> {
  const owner = new Access({ kind: "owner" });
  const commandContext = { publicOrigin: "http://localhost", documents: null };
  const key = `activity-${f.ledger.activities().length}`;
  const created = await execute(f.core, owner, {
    requestId: `${key}:create`,
    command: {
      type: "activity.create",
      config: {
        ghostId: f.bob.id, name: "Bound scheduled task", prompt: "Collect only the scheduled numbers.", acceptanceCriteria: "Verify the numbers.",
        execution: { kind: "container" }, tools: [], source: { kind: "schedule", spec: { kind: "at", at: Date.now() + MINUTE } },
        policy: { maxRunsPerDay: 2, maxConcurrent: 1, runTimeoutSeconds: 300, allowSelfCheck: false, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" },
      },
    },
  }, commandContext);
  const admitted = await execute(f.core, owner, {
    requestId: `${key}:run`,
    command: { type: "activity.run", activityId: created.activityId as string },
  }, commandContext);
  const run = f.ledger.findActivityRun((admitted.runIds as string[])[0]!)!;
  await f.core.idle();
  const work = f.ledger.work(run.workId!);
  expect(work).toMatchObject({ state: "running", activityId: created.activityId, activityRunId: run.id, execution: { kind: "container" }, toolScope: [] });
  return work;
}

/** Pi as the Ghost sees it; `once` runs the owner's main switch inside the first awaited conversation open. */
class SwitchingEngine extends FakeEngine {
  fired = false;
  constructor(
    private readonly core: Core,
    private readonly newMainId: string,
  ) {
    super();
  }
  override async open(setup: ConversationSetup) {
    await super.open(setup);
    if (this.fired) return;
    this.fired = true;
    await execute(this.core, new Access({ kind: "owner" }), { requestId: `switch:${this.newMainId}`, command: { type: "ghost.set_default", ghostId: this.newMainId } }, { publicOrigin: "http://localhost", documents: null });
  }
}

/** Pi admitting a wake while the world moves: `change` runs after each wake submission lands. */
class MidFlightEngine extends FakeEngine {
  change: (() => Promise<void> | void) | null = null;
  override async submit(conversationId: string, submission: Parameters<FakeEngine["submit"]>[1]) {
    await super.submit(conversationId, submission);
    if (submission.requestId.startsWith("autonomy:") && this.change) {
      const change = this.change;
      this.change = null;
      await change();
    }
  }
}

/** Stop one fixture's host and close its ledger so the same file can be reopened cleanly. */
async function detach(f: { core: Core; ledger: Ledger }) {
  await f.core.idle();
  f.core.stop();
  f.ledger.close();
  const index = opened.findIndex((item) => item.core === f.core);
  if (index >= 0) opened.splice(index, 1);
}

/** Any direct model turn the connector might have opened; the design allows none. */
const teamSignals = (engine: FakeEngine) => [...engine.submissions.values()].filter((item) => item.submission.requestId.startsWith("team-"));
const planOf = (f: Fixture, ghost: Ghost) => f.core.autonomy.view().find((plan) => plan.ghostId === ghost.id)!;
const scheduled = (engine: FakeEngine, conversationId: string) => engine.to(conversationId).filter((item) => item.origin === "schedule");

describe("a settled teammate Work reaches the main through the autonomous wake", () => {
  test("a settled peer root pulls the main's next look instead of opening a model turn", async () => {
    const f = team();
    const work = await peerWork(f, f.aliceDirect, f.bob);
    f.core.works.fail(work.id, "stale credentials");
    await f.core.idle();
    await f.core.autonomy.tick(Date.now());
    await f.core.idle();
    // No new direct submission path: the connector never messages anyone about the outcome.
    expect(teamSignals(f.engine)).toHaveLength(0);
    // The owner-requested origin report stays immediate and unmetered.
    const report = f.engine.to(f.aliceDirect.id).find((item) => item.requestId === `work:${work.id}:report:failed:1`);
    expect(report?.origin).toBe("report");
    expect(report?.text).toContain("stale credentials");
    expect(report?.text).toContain(work.id);
    // The pull was admitted as an ordinary autonomous wake carrying ledger evidence.
    const wakes = scheduled(f.engine, f.mainDirect.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.origin).toBe("schedule");
    expect(wakes[0]!.requestId).toMatch(new RegExp(`^autonomy:${f.main.id}:1:`));
    expect(wakes[0]!.text).toContain(`"${work.title}" (${work.id})`);
    expect(wakes[0]!.text).toContain("stale credentials");
    expect(wakes[0]!.text).toContain("Team settled Work: 1");
    expect(planOf(f, f.main)).toMatchObject({ enabled: true, lastWakeAt: expect.any(Number) });
  });

  test("a root whose origin is the main's own conversation does not pull an extra look", async () => {
    const f = team();
    const work = await peerWork(f, f.mainDirect, f.bob);
    f.core.works.fail(work.id, "no source found");
    await f.core.idle();
    await f.core.autonomy.tick(Date.now());
    expect(teamSignals(f.engine)).toHaveLength(0);
    const report = f.engine.to(f.mainDirect.id).find((item) => item.requestId === `work:${work.id}:report:failed:1`);
    expect(report?.text).toContain("no source found");
    // A normal first-look plan may be seeded, but the outcome adds no proactive turn.
    expect(scheduled(f.engine, f.mainDirect.id)).toHaveLength(0);
  });

  test("Activity outcomes never signal the main", async () => {
    const f = team();
    const settled = await activityWork(f);
    f.core.works.fail(settled.id, "the scheduled run failed");
    await f.core.idle();
    const blocked = await activityWork(f);
    f.core.works.block(blocked.id, "activity paused");
    await f.core.idle();
    expect(f.ledger.work(settled.id).state).toBe("failed");
    expect(f.ledger.work(blocked.id).state).toBe("blocked");
    await f.core.autonomy.tick(Date.now());
    expect(teamSignals(f.engine)).toHaveLength(0);
    expect(scheduled(f.engine, f.mainDirect.id)).toHaveLength(0);
    expect(f.engine.to(f.bobDirect.id).filter((item) => item.origin === "report")).toHaveLength(0);
  });

  test("several changes coalesce into one look", async () => {
    const f = team();
    const first = await peerWork(f, f.aliceDirect, f.bob);
    const second = await peerWork(f, f.bobDirect, f.alice);
    // Off duty, pulls stay pending and nothing installs a fallback, so the coalescing is observable.
    f.core.duty.switch(false);
    f.core.works.fail(first.id, "stale credentials");
    await f.core.idle();
    const pulled = planOf(f, f.main).nextAt!;
    f.core.works.fail(second.id, "wrong file written");
    await f.core.idle();
    expect(planOf(f, f.main).nextAt).toBe(pulled);
    await f.core.autonomy.tick(Date.now());
    f.core.duty.switch(true);
    await f.core.autonomy.tick(Date.now());
    const wakes = scheduled(f.engine, f.mainDirect.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain("Team settled Work: 2");
    expect(wakes[0]!.text).toContain(`"${first.title}" (${first.id})`);
    expect(wakes[0]!.text).toContain(`"${second.title}" (${second.id})`);
  });

  test("the daily budget still bounds the pulled look", async () => {
    const f = team();
    const now = Date.now();
    f.ledger.putSetting(`autonomy:${f.main.id}`, { day: new Date(now).toLocaleDateString("en-CA"), wakesToday: DAILY_WAKES, nextAt: now - MINUTE });
    const work = await peerWork(f, f.aliceDirect, f.bob);
    f.core.works.fail(work.id, "stale credentials");
    await f.core.idle();
    await f.core.autonomy.tick(Date.now());
    await f.core.idle();
    expect(scheduled(f.engine, f.mainDirect.id)).toHaveLength(0);
    // The due look was pushed past now instead of being admitted over budget.
    expect(planOf(f, f.main).nextAt!).toBeGreaterThan(now);
  });

  test("an off-duty hour waits, a disabled main never generates proactively", async () => {
    const f = team();
    const work = await peerWork(f, f.aliceDirect, f.bob);
    f.core.duty.switch(false);
    f.core.works.fail(work.id, "stale credentials");
    await f.core.idle();
    await f.core.autonomy.tick(Date.now());
    expect(scheduled(f.engine, f.mainDirect.id)).toHaveLength(0);
    // Back on duty, the pulled plan is admitted once.
    f.core.duty.switch(true);
    await f.core.autonomy.tick(Date.now());
    expect(scheduled(f.engine, f.mainDirect.id)).toHaveLength(1);
    expect(scheduled(f.engine, f.mainDirect.id)[0]!.text).toContain("stale credentials");
    // The owner switching the main's drive off suppresses every later proactive generation.
    f.core.autonomy.setEnabled(f.main.id, false);
    const second = await peerWork(f, f.aliceDirect, f.bob);
    f.core.works.block(second.id, "needs the owner's reconciliation");
    await f.core.team.blocked(f.ledger.work(second.id));
    await f.core.autonomy.tick(Date.now());
    expect(scheduled(f.engine, f.mainDirect.id)).toHaveLength(1);
    expect(planOf(f, f.main)).toMatchObject({ enabled: false, nextAt: null });
  });

  test("the signal follows the current main, never a former one", async () => {
    const f = team();
    // Drain role-change seeding before the outcome, with proactive admission held off duty.
    f.core.duty.switch(false);
    const work = await peerWork(f, f.bobDirect, f.bob);
    await execute(f.core, new Access({ kind: "owner" }), { requestId: "promote-alice", command: { type: "ghost.set_default", ghostId: f.alice.id } }, { publicOrigin: "http://localhost", documents: null });
    await f.core.idle();
    await f.core.autonomy.tick(Date.now());
    f.core.works.fail(work.id, "stale credentials");
    await f.core.idle();
    await f.core.autonomy.tick(Date.now());
    f.core.duty.switch(true);
    await f.core.autonomy.tick(Date.now());
    expect(scheduled(f.engine, f.mainDirect.id)).toHaveLength(0);
    const wakes = scheduled(f.engine, f.aliceDirect.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.origin).toBe("schedule");
    expect(wakes[0]!.text).toContain(`"${work.title}" (${work.id})`);
    expect(wakes[0]!.text).toContain("stale credentials");
  });

  test("a change during admission remains due for one follow-up look", async () => {
    const f = team();
    const settled = await peerWork(f, f.aliceDirect, f.bob);
    const late = await peerWork(f, f.aliceDirect, f.bob);
    f.core.duty.switch(false);
    // The teammate result settles while the main's wake is already being admitted.
    const hook = new MidFlightEngine();
    hook.change = async () => {
      f.core.works.fail(late.id, "late blocker");
      await f.core.idle();
    };
    f.core.attach(hook);
    f.core.works.fail(settled.id, "stale credentials");
    await f.core.idle();
    await f.core.autonomy.tick(Date.now());
    f.core.duty.switch(true);
    await f.core.autonomy.tick(Date.now());
    await f.core.idle();
    const admitted = scheduled(hook, f.mainDirect.id);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.text).not.toContain("late blocker");
    // The admission kept a due follow-up instead of installing the day-long fallback.
    expect(planOf(f, f.main).nextAt!).toBeLessThanOrEqual(Date.now());
    await f.core.autonomy.tick(Date.now() + MINUTE);
    const followUps = scheduled(hook, f.mainDirect.id);
    expect(followUps).toHaveLength(2);
    expect(followUps[1]!.text).toContain(`"${late.title}" (${late.id})`);
    expect(followUps[1]!.text).toContain("late blocker");
    // The follow-up's evidence window starts at the prepared prompt, so only the late result is new.
    expect(followUps[1]!.text).toContain("Team settled Work: 1");
    expect(followUps[1]!.text).not.toContain("stale credentials");
  });

  test("same-millisecond feedback is ordered by the durable ledger, not the clock", async () => {
    const f = team();
    const first = await peerWork(f, f.aliceDirect, f.bob);
    const late = await peerWork(f, f.aliceDirect, f.bob);
    const now = Date.now() + MINUTE;
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      f.core.duty.switch(false);
      const hook = new MidFlightEngine();
      hook.change = async () => {
        f.core.works.fail(late.id, "same-tick failure");
        await f.core.idle();
      };
      f.core.attach(hook);
      f.core.works.fail(first.id, "first failure");
      await f.core.idle();
      f.core.duty.switch(true);
      await f.core.autonomy.tick(now);
      await f.core.idle();
      expect(hook.to(f.mainDirect.id)).toHaveLength(1);
      expect(hook.to(f.mainDirect.id)[0]!.text).not.toContain("same-tick failure");
      await f.core.autonomy.tick(now + MINUTE);
      const wakes = hook.to(f.mainDirect.id);
      expect(wakes).toHaveLength(2);
      expect(wakes[1]!.text).toContain(late.id);
      expect(wakes[1]!.text).toContain("same-tick failure");
      expect(wakes[1]!.text).not.toContain(first.id);
      await f.core.team.report(f.ledger.work(late.id));
      await f.core.autonomy.tick(now + 2 * MINUTE);
      expect(hook.to(f.mainDirect.id)).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("settled root counts survive more than forty roots and newer child churn", async () => {
    const f = team();
    f.core.duty.switch(false);
    for (let i = 0; i < 45; i++) {
      const work = await peerWork(f, f.aliceDirect, f.bob, { title: `Outcome ${i}` });
      f.core.works.fail(work.id, `root finding ${i}`);
      await f.core.idle();
    }
    for (let tree = 0; tree < 2; tree++) {
      const parent = await peerWork(f, f.aliceDirect, f.bob);
      for (let i = 0; i < 25; i++) {
        const child = f.core.works.delegate(parent.id, { ghostId: f.alice.id, title: `Child churn ${i}`, brief: "One independent part" });
        await f.core.idle();
        f.core.works.fail(child.id, "child-only finding");
        await f.core.idle();
      }
    }
    f.core.duty.switch(true);
    await f.core.autonomy.tick(Date.now());
    const wakes = f.engine.to(f.mainDirect.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain("Team settled Work: 45");
    expect(wakes[0]!.text).toContain("+33 more:");
    expect(wakes[0]!.text).not.toContain("child-only finding");
  });

  test("the pulled plan survives a restart, and recovery re-derivation adds no generation", async () => {
    const dir = tempDir();
    files.push(dir);
    const path = join(dir, "ledger.sqlite");
    const f = team(path);
    // Off duty, the signal still writes durably; only the admission waits.
    f.core.duty.switch(false);
    const work = await peerWork(f, f.aliceDirect, f.bob);
    f.core.works.fail(work.id, "stale credentials");
    await f.core.idle();
    expect(teamSignals(f.engine)).toHaveLength(0);
    expect(f.engine.to(f.mainDirect.id)).toHaveLength(0);
    expect(planOf(f, f.main).nextAt).not.toBeNull();
    await detach(f);
    const restarted = harness(path);
    opened.push(restarted);
    restarted.core.duty.switch(true);
    await restarted.core.autonomy.tick(Date.now());
    await restarted.core.idle();
    const wakes = restarted.engine.to(f.mainDirect.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain(`"${work.title}" (${work.id})`);
    expect(wakes[0]!.text).toContain("stale credentials");
    // Recovery re-deriving the settled report cannot stack another look: the evidence is observed.
    await restarted.core.team.report(restarted.ledger.work(work.id));
    await restarted.core.autonomy.tick(Date.now() + MINUTE);
    expect(restarted.engine.to(f.mainDirect.id)).toHaveLength(1);
  });
});

describe("work_steer", () => {
  const steer = async (f: Fixture, workId: string, instruction: string, callId: string) =>
    f.use(f.mainDirect, "work_steer")({ work_id: workId, instruction }, callId);

  test("the main steers a running ordinary Work once per call", async () => {
    const f = team();
    const work = await peerWork(f, f.aliceDirect, f.bob);
    const instruction = "Skip the second source;\nthe export matters more";
    const assignee = f.ledger.ghost(work.ghostId);
    const result = await steer(f, work.id, instruction, "steer-1");
    expect(result.isError).toBeFalsy();
    const requestId = idFor(f.mainDirect.id, "steer-1");
    const sent = f.engine.to(work.conversationId!).filter((item) => item.requestId === requestId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.steer).toBe(true);
    expect(sent[0]!.origin).toBe("work");
    expect(sent[0]!.text).toContain(instruction);
    // A replayed call finds the submission it already made.
    expect((await steer(f, work.id, instruction, "steer-1")).isError).toBeFalsy();
    expect(f.engine.to(work.conversationId!).filter((item) => item.requestId === requestId)).toHaveLength(1);
    // Advice cannot change the Work's authority, scope, deadline, acceptance or lifecycle.
    expect(f.ledger.work(work.id)).toEqual(work);
    expect(f.ledger.ghost(work.ghostId)).toEqual(assignee);
  });

  test("the main may steer a waiting Work", async () => {
    const f = team();
    const parent = await peerWork(f, f.aliceDirect, f.alice);
    const child = f.core.works.delegate(parent.id, { ghostId: f.bob.id, title: "Part", brief: "B" });
    await f.core.idle();
    f.core.activity(parent.conversationId!, false, Date.now());
    await f.core.idle();
    expect(f.ledger.work(parent.id).state).toBe("waiting");
    const result = await steer(f, parent.id, "Bob's part covers the export; you take the summary", "steer-wait");
    expect(result.isError).toBeFalsy();
  });

  test("steering refuses activities, blocked Work and passed deadlines", async () => {
    const f = team();
    const activity = await activityWork(f);
    expect((await steer(f, activity.id, "hurry", "s-activity")).isError).toBe(true);

    const work = await peerWork(f, f.aliceDirect, f.bob);
    const effect = f.core.effects.begin({ conversationId: work.conversationId!, callId: "purchase-1", tool: "browser_propose", input: { selector: "#buy" }, summary: "purchase outcome" });
    f.core.effects.unknown(effect.effect!.id, "the connection dropped");
    await f.core.idle();
    expect(f.ledger.work(work.id).state).toBe("blocked");
    const blocked = f.ledger.work(work.id);
    const unresolved = f.core.effects.unresolved(work.id);
    expect((await steer(f, work.id, "try again", "s-blocked")).isError).toBe(true);
    expect(f.ledger.work(work.id)).toEqual(blocked);
    expect(f.core.effects.unresolved(work.id)).toEqual(unresolved);

    const expired = await peerWork(f, f.aliceDirect, f.bob, { deadline_minutes: 1 });
    f.ledger.tx(() => f.ledger.putWork({ ...f.ledger.work(expired.id), deadlineAt: Date.now() - MINUTE }));
    const expiredBefore = f.ledger.work(expired.id);
    expect((await steer(f, expired.id, "hurry", "s-expired")).isError).toBe(true);
    expect(f.ledger.work(expired.id)).toEqual(expiredBefore);
    expect(f.ledger.work(activity.id)).toEqual(activity);
    // Startup submissions remain; none of the refused steering identities was admitted.
    for (const [target, callId] of [[activity, "s-activity"], [work, "s-blocked"], [expired, "s-expired"]] as const) {
      expect(f.engine.to(target.conversationId!).some((item) => item.requestId === idFor(f.mainDirect.id, callId))).toBe(false);
    }
  });

  test("steering refuses settled Work", async () => {
    const f = team();
    const work = f.core.works.createRoot({
      ghostId: f.bob.id,
      title: "Checked task",
      brief: "Write the number down",
      originConversationId: f.aliceDirect.id,
      acceptance: { criteria: "", checks: [{ kind: "artifact_contains", name: "out.txt", text: "42" }], reviewer: null },
      deadlineAt: Date.now() + 30 * MINUTE,
    });
    await f.core.idle();
    const ref = await f.core.artifacts.put(new TextEncoder().encode("total 42"), "out.txt", "text/plain");
    f.ledger.tx(() => f.ledger.addArtifact(work.id, ref));
    f.core.works.complete(work.id, { summary: "The number is written", artifacts: [ref] });
    await f.core.idle();
    expect(f.ledger.work(work.id).state).toBe("done");
    expect((await steer(f, work.id, "one more pass", "s-done")).isError).toBe(true);
    const settled = f.ledger.work(work.id);
    expect(f.engine.to(settled.conversationId!).some((item) => item.requestId === idFor(f.mainDirect.id, "s-done"))).toBe(false);
    expect(settled.state).toBe("done");
  });

  test("steering rechecks the main role after the awaited open", async () => {
    const f = team();
    const work = await peerWork(f, f.aliceDirect, f.bob);
    const engine = new SwitchingEngine(f.core, f.alice.id);
    f.core.attach(engine);
    const result = await steer(f, work.id, "switch happens first", "s-switch");
    expect(result.isError).toBe(true);
    expect(f.ledger.defaultGhost()?.id).toBe(f.alice.id);
    expect(engine.to(work.conversationId!).some((item) => item.requestId === idFor(f.mainDirect.id, "s-switch"))).toBe(false);
    expect(f.ledger.work(work.id)).toEqual(work);
  });

  test("only the current main is offered or admits work_steer", async () => {
    const f = team();
    const work = await peerWork(f, f.aliceDirect, f.bob);
    expect(() => f.use(f.aliceDirect, "work_steer")).toThrow("not offered");
    const api = { conversationId: `pi-${f.alice.name}`, callId: "s-peer", output: () => {} } as unknown as ToolExecutionApi;
    const tools = createToolSet({ core: f.core, sandbox, memory: null, documents: null, skills: null });
    const steerTool = tools
      .all()
      .flatMap((extension) => extension.tools ?? [])
      .find((candidate) => candidate.name === "work_steer")!;
    const refused = await steerTool.execute({ work_id: work.id, instruction: "do it differently" } as never, api, context());
    expect(refused.isError).toBe(true);
    expect(f.engine.to(work.conversationId!).some((item) => item.requestId === idFor(f.aliceDirect.id, "s-peer"))).toBe(false);
  });
});

describe("main-only team visibility", () => {
  test("work_list and work_inspect widen for the current main only, resolved at execution", async () => {
    const f = team();
    const aliceWork = await peerWork(f, f.aliceDirect, f.bob);
    const bobCreate = f.use(f.bobDirect, "work_create");
    await bobCreate({ title: "Bob's own", brief: "B", deadline_minutes: 30 }, "bob-own");
    await f.core.idle();
    const bobWork = f.ledger.worksForState().find((work) => work.title === "Bob's own")!;

    expect(textOf(await f.use(f.mainDirect, "work_list")({}, "list-1"))).toContain("Team task");
    expect(textOf(await f.use(f.mainDirect, "work_list")({}, "list-2"))).toContain("Bob's own");
    const aliceList = textOf(await f.use(f.aliceDirect, "work_list")({}, "list-3"));
    expect(aliceList).toContain("Team task");
    expect(aliceList).not.toContain("Bob's own");
    expect(textOf(await f.use(f.mainDirect, "work_inspect")({ work_id: aliceWork.id }, "insp-1"))).toContain("Collect the numbers");
    expect(textOf(await f.use(f.bobDirect, "work_inspect")({ work_id: aliceWork.id }, "insp-2"))).toContain("Collect the numbers");
    expect((await f.use(f.aliceDirect, "work_inspect")({ work_id: bobWork.id }, "insp-unrelated")).isError).toBe(true);

    // The owner hands the main designation to Bob: visibility moves with the role, not the Ghost.
    await execute(f.core, new Access({ kind: "owner" }), { requestId: "promote-bob", command: { type: "ghost.set_default", ghostId: f.bob.id } }, { publicOrigin: "http://localhost", documents: null });
    await f.core.idle();
    // The former main is back to its own scope: nothing of the team's Work.
    const formerList = textOf(await f.use(f.mainDirect, "work_list")({}, "list-4"));
    expect(formerList).not.toContain("Team task");
    expect(formerList).not.toContain("Bob's own");
    expect((await f.use(f.mainDirect, "work_inspect")({ work_id: bobWork.id }, "insp-former")).isError).toBe(true);
    const newList = textOf(await f.use(f.bobDirect, "work_list")({}, "list-5"));
    expect(newList).toContain("Team task");
    expect(newList).toContain("Bob's own");
    expect(textOf(await f.use(f.bobDirect, "work_inspect")({ work_id: bobWork.id }, "insp-3"))).toContain("Bob's own");
  });
});

describe("the main wake sees the live team", () => {
  test("teammate Work and blockers appear in the main's wake, not in teammates' wakes", async () => {
    const f = team();
    const now = new Date(2030, 0, 15, 12).getTime();
    await peerWork(f, f.aliceDirect, f.alice);
    const stuck = await peerWork(f, f.bobDirect, f.bob);
    f.core.works.block(stuck.id, "waiting on the owner's vault answer");
    await f.core.idle();
    // The blocker may have admitted a main wake automatically; finish it before replacing plans.
    await f.core.autonomy.tick(Date.now());
    await f.core.autonomy.plan(f.main, f.main.id, { at: now + 60 * MINUTE, intent: "Check the team" }, now);
    await f.core.autonomy.plan(f.alice, f.alice.id, { at: now + 60 * MINUTE, intent: "Do my research" }, now);
    await f.core.autonomy.plan(f.bob, f.bob.id, { at: now + 120 * MINUTE, intent: "Look later" }, now);
    await f.core.autonomy.tick(now + 61 * MINUTE);

    const mainWake = scheduled(f.engine, f.mainDirect.id).at(-1)!.text;
    expect(mainWake).toContain("Live team Work");
    expect(mainWake).toContain("blocked 1");
    expect(mainWake).toContain("Team task");
    expect(mainWake).toContain("waiting on the owner's vault answer");
    const aliceWakes = scheduled(f.engine, f.aliceDirect.id);
    expect(aliceWakes).toHaveLength(1);
    const aliceWake = aliceWakes[0]!.text;
    expect(aliceWake).not.toContain("Live team Work");
    expect(aliceWake).not.toContain("waiting on the owner's vault answer");
  });
});
