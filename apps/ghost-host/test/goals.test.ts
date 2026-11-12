import { describe, expect, test } from "bun:test";
import { GOAL_ADOPT, reviewOf, type Conversation, type Ghost, type Goal, type GoalProposal } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { createToolSet } from "../src/tools/index.ts";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { harness } from "./support.ts";

const context = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;
const textOf = (result: ToolExecutionResult) => (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");

function team() {
  const h = harness();
  const tools = createToolSet({ core: h.core, sandbox: { envFor: async () => undefined, workspacePath: () => "/nonexistent", stageInputs: async () => {}, release: async () => {} } as never, memory: null, documents: null, skills: null });
  const model = { provider: "test", model: "test-model" };
  const main = h.core.createGhost({ name: "Main", persona: "You lead.", model, isDefault: true });
  const mate = h.core.createGhost({ name: "Mate", persona: "You research.", model });
  const bind = (ghost: Ghost) => {
    const conversation = h.ledger.conversation(ghost.directConversationId);
    h.ledger.setPiConversationId(conversation.id, `pi-${ghost.name}`);
    return conversation;
  };
  const use = (conversation: Conversation, name: string) => {
    const ghost = h.ledger.ghost(conversation.ghostId);
    const tool = tools.extensionsFor(conversation, ghost, null).flatMap((extension) => extension.tools ?? []).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} is not offered`);
    return (args: unknown, callId: string) =>
      tool.execute(args as never, { conversationId: `pi-${ghost.name}`, callId, output: () => {}, diagnostic: () => {} } as unknown as ToolExecutionApi, context());
  };
  const finish = (workId: string) => h.ledger.tx(() => h.ledger.putWork({ ...h.ledger.work(workId), state: "done" }));
  return { ...h, tools, main, mate, mainDirect: bind(main), mateDirect: bind(mate), use, finish };
}

const proposal = { title: "작은 수입원 만들기", why: "올해 100달러라도 직접 벌어 보고 싶다고 하셨습니다.", boundaries: "원치 않는 메시지 발송, 사실과 다른 주장, 지출", signal: "첫 수입" };

describe("goal proposals", () => {
  test("only the owner adopts a proposed goal, once, and the main hears the goal id", async () => {
    const t = team();
    const propose = t.use(t.mainDirect, "goal_propose");
    expect((await propose(proposal, "p1")).isError).toBeFalsy();
    const decision = t.ledger.pendingDecisions().find((item) => item.proposal?.goal)!;
    expect(decision.options).toEqual([GOAL_ADOPT, "거절"]);
    // No recommendation means no auto-settle on silence and nothing the main may decide for the owner.
    expect(reviewOf(decision.proposal)).toBeNull();
    expect(t.core.decisions.reversible(decision)).toBe(false);
    expect(() => t.core.decisions.resolveState(decision.id, { outcome: "answer", answer: GOAL_ADOPT }, "main")).toThrow("only the owner");
    // A second proposal waits until the first is settled.
    expect(textOf(await propose({ ...proposal, title: "다른 방향" }, "p2"))).toContain("already waiting");

    await t.core.decisions.resolve(decision.id, { outcome: "answer", answer: GOAL_ADOPT });
    const goals = t.core.goals.goals();
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ title: proposal.title, boundaries: proposal.boundaries, state: "active", proposedBy: t.main.id });
    expect((t.ledger.decision(decision.id).proposal!.goal as GoalProposal).goalId).toBe(goals[0]!.id);
    expect(t.engine.to(t.mainDirect.id).at(-1)?.text).toContain(`Adopted as goal ${goals[0]!.id}`);

    // Settling again after a crash finds the marker instead of adding a second goal.
    expect(t.core.goals.settleProposal(t.ledger.decision(decision.id))).toContain(goals[0]!.id);
    expect(t.core.goals.goals()).toHaveLength(1);
  });

  test("a decline is not an adoption and pauses further proposals", async () => {
    const t = team();
    const propose = t.use(t.mainDirect, "goal_propose");
    await propose(proposal, "p1");
    const decision = t.ledger.pendingDecisions().find((item) => item.proposal?.goal)!;
    await t.core.decisions.resolve(decision.id, { outcome: "answer", answer: "등록하지 마세요" });
    expect(t.core.goals.goals()).toEqual([]);
    expect(t.engine.to(t.mainDirect.id).at(-1)?.text).toContain("not adopted");
    expect(textOf(await propose({ ...proposal, title: "다른 방향" }, "p2"))).toContain("for 3 days");
  });

  test("goal tools stay with the current main", () => {
    const t = team();
    for (const name of ["goal_propose", "goal_list", "milestone_plan", "milestone_update"]) expect(() => t.use(t.mateDirect, name)).toThrow("not offered");
  });

  test("three open goals is the limit for the owner and for proposals", async () => {
    const t = team();
    for (const title of ["하나", "둘", "셋"]) t.core.goals.create({ title });
    expect(() => t.core.goals.create({ title: "넷" })).toThrow("at most 3");
    expect(textOf(await t.use(t.mainDirect, "goal_propose")(proposal, "p1"))).toContain("3 open goals");
    // A paused goal still counts; a closed one frees its place.
    const [first] = t.core.goals.goals();
    t.core.goals.update(first!.id, { state: "paused" });
    expect(() => t.core.goals.create({ title: "넷" })).toThrow("at most 3");
    t.core.goals.update(first!.id, { state: "closed" });
    expect(t.core.goals.create({ title: "넷" }).state).toBe("active");
    expect(() => t.core.goals.update(first!.id, { state: "active" })).toThrow("closed goal cannot change");
  });
});

describe("the milestone line", () => {
  function withGoal() {
    const t = team();
    const goal: Goal = t.core.goals.create({ title: "작은 수입원 만들기", boundaries: "원치 않는 메시지 발송" });
    return { ...t, goal, plan: t.use(t.mainDirect, "milestone_plan"), move: t.use(t.mainDirect, "milestone_update") };
  }

  test("plans only the near road and runs at most two milestones at once", async () => {
    const t = withGoal();
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      expect((await t.plan({ goal_id: t.goal.id, title: `단계 ${index}`, hypothesis: "가설", exit: "증거" }, `m${index}`)).isError).toBeFalsy();
      ids.push(t.core.goals.milestones().at(-1)!.id);
    }
    expect(textOf(await t.plan({ goal_id: t.goal.id, title: "먼 길", hypothesis: "가설", exit: "증거" }, "m5"))).toContain("already planned");
    // The same call replayed finds its milestone.
    await t.plan({ goal_id: t.goal.id, title: "단계 0", hypothesis: "가설", exit: "증거" }, "m0");
    expect(t.core.goals.milestones()).toHaveLength(4);

    expect((await t.move({ milestone_id: ids[0], state: "active" }, "a0")).isError).toBeFalsy();
    expect((await t.move({ milestone_id: ids[1], state: "active" }, "a1")).isError).toBeFalsy();
    expect(textOf(await t.move({ milestone_id: ids[2], state: "active" }, "a2"))).toContain("already active");
  });

  test("a milestone finishes only with an accepted linked Work; a dropped one keeps its reason", async () => {
    const t = withGoal();
    await t.plan({ goal_id: t.goal.id, title: "판매 페이지", hypothesis: "템플릿 수요가 있다", exit: "공개 URL과 첫 방문" }, "m1");
    const milestone = t.core.goals.milestones()[0]!;
    const create = t.use(t.mateDirect, "work_create");
    // A planned milestone takes no Work yet.
    const early = await create({ title: "판매 페이지", brief: "만든다", initiative: true, milestone_id: milestone.id }, "w0");
    expect(textOf(early)).toContain("only an active milestone");
    expect(t.ledger.worksForState()).toHaveLength(0);

    await t.move({ milestone_id: milestone.id, state: "active" }, "a1");
    expect(textOf(await t.move({ milestone_id: milestone.id, state: "done", outcome: "다 했습니다" }, "d0"))).toContain("accepted Work");

    expect((await create({ title: "판매 페이지", brief: "만든다", initiative: true, milestone_id: milestone.id }, "w1")).isError).toBeFalsy();
    const work = t.ledger.worksForState()[0]!;
    expect(t.core.goals.milestone(milestone.id).workIds).toEqual([work.id]);
    // The goal's boundaries reach the Work's own instructions.
    const instructions = t.tools.instructionsFor({ kind: "work", ghostId: t.mate.id, workId: work.id } as unknown as Conversation, t.mate, work);
    expect(instructions).toContain("never use 원치 않는 메시지 발송");

    expect(textOf(await t.move({ milestone_id: milestone.id, state: "done", outcome: "다 했습니다" }, "d1"))).toContain("accepted Work");
    t.finish(work.id);
    expect((await t.move({ milestone_id: milestone.id, state: "done", outcome: "공개 URL 확인" }, "d2")).isError).toBeFalsy();
    expect(t.core.goals.milestone(milestone.id)).toMatchObject({ state: "done", outcome: "공개 URL 확인", settledBy: t.main.id });

    await t.plan({ goal_id: t.goal.id, title: "광고 수익", hypothesis: "트래픽", exit: "광고 수익 1달러" }, "m2");
    const ads = t.core.goals.milestones().at(-1)!;
    expect(textOf(await t.move({ milestone_id: ads.id, state: "dropped" }, "x0"))).toContain("why the path is dropped");
    await t.move({ milestone_id: ads.id, state: "dropped", outcome: "트래픽이 없습니다" }, "x1");
    expect(t.core.goals.milestone(ads.id)).toMatchObject({ state: "dropped", outcome: "트래픽이 없습니다" });
    expect(textOf(await t.move({ milestone_id: ads.id, state: "active" }, "x2"))).toContain("already dropped");
  });

  test("closing a goal drops its open milestones and freezes the line", async () => {
    const t = withGoal();
    await t.plan({ goal_id: t.goal.id, title: "판매 페이지", hypothesis: "h", exit: "e" }, "m1");
    await t.plan({ goal_id: t.goal.id, title: "두 번째", hypothesis: "h", exit: "e" }, "m2");
    const [first, second] = t.core.goals.milestones();
    t.core.goals.settleByOwner(first!.id, "done", "제가 확인했습니다");
    t.core.goals.update(t.goal.id, { state: "closed" });
    expect(t.core.goals.milestone(first!.id).state).toBe("done");
    expect(t.core.goals.milestone(second!.id)).toMatchObject({ state: "dropped", settledBy: "owner" });
    expect(textOf(await t.plan({ goal_id: t.goal.id, title: "새 단계", hypothesis: "h", exit: "e" }, "m3"))).toContain("goal is closed");
  });

  test("a replayed work_create never links Work to a goal the owner paused meanwhile", async () => {
    const t = withGoal();
    await t.plan({ goal_id: t.goal.id, title: "판매 페이지", hypothesis: "h", exit: "e" }, "m1");
    const milestone = t.core.goals.milestones()[0]!;
    await t.move({ milestone_id: milestone.id, state: "active" }, "a1");
    // The Work exists but its link did not commit (a crash between them in an older build).
    const create = t.use(t.mateDirect, "work_create");
    await create({ title: "판매 페이지", brief: "만든다", initiative: true }, "w1");
    t.core.goals.update(t.goal.id, { state: "paused" });
    const replay = await create({ title: "판매 페이지", brief: "만든다", initiative: true, milestone_id: milestone.id }, "w1");
    expect(textOf(replay)).toContain("goal is paused");
    expect(t.core.goals.milestone(milestone.id).workIds).toEqual([]);
  });

  test("long boundaries reach the wake whole", async () => {
    const t = team();
    const boundaries = `${"원치 않는 메시지 발송 금지. ".repeat(40)}마지막 경계: 지출 금지`;
    t.core.goals.create({ title: "작은 수입원 만들기", boundaries });
    t.core.duty.switch(true);
    t.core.autonomy.setEnabled(t.main.id, false);
    await t.core.autonomy.plan(t.mate, t.mate.id, { at: Date.now() + 10 * 60_000, intent: "look" });
    await t.core.autonomy.tick(Date.now() + 11 * 60_000);
    expect(t.engine.to(t.mateDirect.id).at(-1)!.text).toContain("마지막 경계: 지출 금지");
  });

  test("a new goal keeps the main's look due even when a wake was already prepared", async () => {
    const t = team();
    t.core.duty.switch(true);
    // Let the look the duty switch may have started finish before recording the old wake.
    await t.core.autonomy.tick();
    const key = `autonomy:${t.main.id}`;
    const now = Date.now();
    const stored = t.ledger.setting<Record<string, unknown>>(key, {});
    // A wake recorded before the goal existed: its text cannot mention it.
    t.ledger.tx(() => t.ledger.putSetting(key, { ...stored, ghostId: t.main.id, enabled: true, nextAt: now + 24 * 60 * 60_000, revision: 5, wakes: 0, heads: {}, watch: [], pending: { requestId: `autonomy:${t.main.id}:1:${now}`, text: "[Autonomous wake] old", at: now, heads: {}, revision: 5 } }));
    t.core.goals.create({ title: "작은 수입원 만들기" });
    t.core.autonomy.goalsChanged();
    await t.core.autonomy.tick();
    expect(t.engine.to(t.mainDirect.id).at(-1)?.text).toBe("[Autonomous wake] old");
    // Not the day-long fallback: the main looks again soon and that look carries the goal.
    expect(t.core.autonomy.view().find((plan) => plan.ghostId === t.main.id)!.nextAt!).toBeLessThanOrEqual(Date.now());
  });

  test("every self-directed wake carries open goals, boundaries and active milestone ids", async () => {
    const t = withGoal();
    const paused = t.core.goals.create({ title: "건강한 루틴" });
    t.core.goals.update(paused.id, { state: "paused" });
    await t.plan({ goal_id: t.goal.id, title: "판매 페이지", hypothesis: "h", exit: "공개 URL" }, "m1");
    const milestone = t.core.goals.milestones()[0]!;
    await t.move({ milestone_id: milestone.id, state: "active" }, "a1");
    t.core.duty.switch(true);
    t.core.autonomy.setEnabled(t.main.id, false);
    await t.core.autonomy.plan(t.mate, t.mate.id, { at: Date.now() + 10 * 60_000, intent: "look" });
    await t.core.autonomy.tick(Date.now() + 11 * 60_000);
    const wake = t.engine.to(t.mateDirect.id).at(-1)!.text;
    expect(wake).toContain(`"작은 수입원 만들기" (${t.goal.id})`);
    expect(wake).toContain("Never use: 원치 않는 메시지 발송");
    expect(wake).toContain(`Active milestone: "판매 페이지" (${milestone.id})`);
    expect(wake).toContain("paused by the owner: do not act on it");
  });
});

describe("owner commands", () => {
  test("a new goal reaches subscribers before the main's plan change it causes", async () => {
    const t = team();
    t.core.duty.switch(true);
    await t.core.autonomy.tick();
    const seen: { seq: number; type: string }[] = [];
    const stop = t.ledger.subscribe((event) => seen.push({ seq: event.seq, type: event.data.type }));
    await execute(t.core, new Access({ kind: "owner" }), { requestId: crypto.randomUUID(), command: { type: "goal.create", title: "작은 수입원 만들기" } }, { publicOrigin: "http://localhost", documents: null });
    await t.core.autonomy.tick();
    stop();
    // A seq-ordered stream (the device SSE) drops anything older than what it already sent.
    expect(seen.map((event) => event.seq)).toEqual([...seen.map((event) => event.seq)].sort((a, b) => a - b));
    expect(seen[0]?.type).toBe("goal");
    expect(seen.some((event) => event.type === "autonomy")).toBe(true);
  });
});
