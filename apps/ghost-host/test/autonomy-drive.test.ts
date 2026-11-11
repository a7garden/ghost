import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../src/core/core.ts";
import { DAILY_WAKES, repositoryHead } from "../src/core/autonomy.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { createToolSet } from "../src/tools/index.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox, tempDir } from "./support.ts";

const MINUTE = 60_000;

function fixture(options: { onHead?: (path: string) => void; onCommits?: () => Promise<void> } = {}) {
  const heads = new Map<string, string>();
  const ledger = new Ledger(":memory:");
  const core = new Core({
    ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {},
    autonomy: {
      head: async (path) => {
        options.onHead?.(path);
        return heads.get(path) ?? null;
      },
      commits: async () => {
        await options.onCommits?.();
        return ["Fix the save button", "Add export"];
      },
    },
  });
  const engine = new HookedEngine();
  core.attach(engine);
  const model = { provider: "test", model: "test-model" };
  const main = core.createGhost({ name: "Main", persona: "Lead", model, isDefault: true });
  const mate = core.createGhost({ name: "Mate", persona: "Research", model });
  const plan = (ghostId: string) => core.autonomy.view().find((item) => item.ghostId === ghostId)!;
  const wakes = (ghostId: string) => engine.to(ledger.ghost(ghostId).directConversationId);
  const setBusy = (ghostId: string, busy: boolean) => {
    const conversation = ledger.conversation(ledger.ghost(ghostId).directConversationId);
    ledger.tx(() => ledger.putConversation({ ...conversation, busy }));
  };
  return { ledger, core, engine, main, mate, heads, plan, wakes, setBusy };
}

/** Pi as the Ghost sees it: a hook runs while the wake is being admitted. */
class HookedEngine extends FakeEngine {
  onSubmit: ((conversationId: string) => Promise<void> | void) | null = null;
  override async submit(conversationId: string, submission: Parameters<FakeEngine["submit"]>[1]) {
    await super.submit(conversationId, submission);
    await this.onSubmit?.(conversationId);
  }
}
/** Local midnight of a fixed day, so per-day limits are deterministic. */
const day = (hours = 0) => new Date(2030, 0, 15, hours).getTime();

test("a teammate outcome during watched-project reads is included in the next admitted look", async () => {
  const probes: { onCommits?: () => Promise<void> } = {};
  const f = fixture(probes);
  try {
    f.core.duty.switch(false);
    f.core.autonomy.setEnabled(f.mate.id, false);
    const work = f.core.works.createRoot({
      ghostId: f.mate.id, originConversationId: f.mate.directConversationId,
      title: "Late project result", brief: "Collect the project result",
    });
    await f.core.idle();
    const now = Date.now();
    const spaceId = "11111111-1111-4111-8111-111111111111";
    f.ledger.tx(() => {
      f.ledger.putSpace({ id: spaceId, name: "Twill", path: "/work/twill", createdAt: now });
      f.ledger.putSetting(`autonomy:${f.main.id}`, {
        enabled: true, nextAt: now, intent: "Inspect the project", setBy: "host", watch: [spaceId],
        lastWakeAt: null, wakesToday: 0, day: "", heads: { [spaceId]: `main@${"a".repeat(40)}` },
        revision: 1, wakes: 0, pending: null,
      });
    });
    f.heads.set("/work/twill", `main@${"b".repeat(40)}`);
    probes.onCommits = async () => {
      delete probes.onCommits;
      f.core.works.fail(work.id, "credentials changed during project inspection");
      await f.core.idle();
    };
    f.core.duty.switch(true);
    await f.core.autonomy.tick(now);
    expect(f.wakes(f.main.id)).toHaveLength(0);
    expect(f.plan(f.main.id).nextAt!).toBeLessThanOrEqual(Date.now());
    await f.core.autonomy.tick(Date.now() + MINUTE);
    const wakes = f.wakes(f.main.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain(work.id);
    expect(wakes[0]!.text).toContain("credentials changed during project inspection");
  } finally {
    await f.core.idle();
    f.core.stop();
    f.ledger.close();
  }
});

test("a Ghost's planned time wakes it once in its direct conversation; without a new plan the Host looks again a day later", async () => {
  const f = fixture();
  const start = day(9);
  await f.core.autonomy.tick(start);
  const first = f.plan(f.mate.id).nextAt!;
  expect(first).toBeGreaterThanOrEqual(start);
  expect(first).toBeLessThan(start + 2 * 60 * MINUTE);
  expect(f.wakes(f.mate.id)).toEqual([]);

  await f.core.autonomy.tick(first);
  await f.core.autonomy.tick(first + MINUTE);
  const [wake, ...rest] = f.wakes(f.mate.id);
  expect(rest).toEqual([]);
  expect(wake).toMatchObject({ origin: "schedule", requestId: `autonomy:${f.mate.id}:1:${first}` });
  expect(wake!.text.startsWith("[Autonomous wake]")).toBe(true);
  expect(f.plan(f.mate.id)).toMatchObject({ nextAt: first + 24 * 60 * MINUTE, setBy: "host", lastWakeAt: first, wakesToday: 1 });
});

test("plans are bounded, the main Ghost may plan a teammate, and an owner switch-off stops both plans and wakes", async () => {
  const f = fixture();
  const now = day(10);
  await expect(f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 2 * MINUTE, intent: "soon" }, now)).rejects.toThrow("at least 10 minutes");
  await expect(f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 15 * 24 * 60 * MINUTE, intent: "later" }, now)).rejects.toThrow("14 days");
  await expect(f.core.autonomy.plan(f.mate, f.main.id, { at: now + 60 * MINUTE, intent: "boss" }, now)).rejects.toThrow("only the main Ghost");

  const planned = await f.core.autonomy.plan(f.main, f.mate.id, { at: now + 60 * MINUTE, intent: "Compare the two export libraries" }, now);
  expect(planned).toMatchObject({ setBy: "main", nextAt: now + 60 * MINUTE, intent: "Compare the two export libraries" });
  await f.core.autonomy.tick(now + 60 * MINUTE);
  expect(f.wakes(f.mate.id)[0]!.text).toContain("Plan (set by the main Ghost Main): Compare the two export libraries");

  f.core.autonomy.setEnabled(f.mate.id, false);
  expect(f.plan(f.mate.id)).toMatchObject({ enabled: false, nextAt: null });
  await expect(f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 3 * 60 * MINUTE, intent: "again" }, now)).rejects.toThrow("switched off");
  await f.core.autonomy.tick(now + 30 * 60 * MINUTE);
  expect(f.wakes(f.mate.id)).toHaveLength(1);
});

test("a watched project's new commits wake a Ghost early with what changed, at most hourly", async () => {
  const f = fixture();
  const now = day(11);
  f.ledger.tx(() => f.ledger.putSpace({ id: "11111111-1111-4111-8111-111111111111", name: "Twill", path: "/work/twill", createdAt: 1 }));
  f.heads.set("/work/twill", `main@${"a".repeat(40)}`);
  await f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 10 * 60 * MINUTE, intent: "Weekly look", watch: ["11111111-1111-4111-8111-111111111111"] }, now);

  await f.core.autonomy.tick(now + MINUTE);
  expect(f.wakes(f.mate.id)).toEqual([]);

  f.heads.set("/work/twill", `main@${"b".repeat(40)}`);
  await f.core.autonomy.tick(now + 2 * MINUTE);
  const [early] = f.wakes(f.mate.id);
  expect(early!.text).toContain("Trigger: a project you watch changed (Twill)");
  expect(early!.text).toContain("Project Twill: Fix the save button · Add export");

  await f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 10 * 60 * MINUTE, intent: "Weekly look" }, now + 3 * MINUTE);
  f.heads.set("/work/twill", `main@${"c".repeat(40)}`);
  await f.core.autonomy.tick(now + 20 * MINUTE);
  expect(f.wakes(f.mate.id)).toHaveLength(1);
  await f.core.autonomy.tick(now + 63 * MINUTE);
  expect(f.wakes(f.mate.id)).toHaveLength(2);
});

test("a Ghost wakes at most the daily limit; the next due plan moves to tomorrow", async () => {
  const f = fixture();
  let now = day(1);
  for (let index = 0; index < DAILY_WAKES; index++) {
    await f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 10 * MINUTE, intent: `look ${index}` }, now);
    now += 10 * MINUTE;
    await f.core.autonomy.tick(now);
  }
  expect(f.wakes(f.mate.id)).toHaveLength(DAILY_WAKES);
  await f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 10 * MINUTE, intent: "one more" }, now);
  await f.core.autonomy.tick(now + 10 * MINUTE);
  expect(f.wakes(f.mate.id)).toHaveLength(DAILY_WAKES);
  expect(f.plan(f.mate.id).nextAt!).toBeGreaterThanOrEqual(day(24));
});

test("repository positions come from Git's files: branch refs, packed refs and linked worktrees", async () => {
  const root = tempDir();
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git/refs/heads"), { recursive: true });
  mkdirSync(join(repo, "docs/deep"), { recursive: true });
  writeFileSync(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, ".git/refs/heads/main"), `${"1".repeat(40)}\n`);
  expect(await repositoryHead(join(repo, "docs/deep"))).toBe(`main@${"1".repeat(40)}`);

  writeFileSync(join(repo, ".git/HEAD"), "ref: refs/heads/release\n");
  writeFileSync(join(repo, ".git/packed-refs"), `# pack-refs\n${"2".repeat(40)} refs/heads/release\n`);
  expect(await repositoryHead(repo)).toBe(`release@${"2".repeat(40)}`);

  const worktree = join(root, "wt");
  mkdirSync(join(repo, ".git/worktrees/wt"), { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git/worktrees/wt")}\n`);
  writeFileSync(join(repo, ".git/worktrees/wt/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, ".git/worktrees/wt/commondir"), "../..\n");
  expect(await repositoryHead(worktree)).toBe(`main@${"1".repeat(40)}`);
  expect(await repositoryHead("/")).toBeNull();
});

test("a switch-off or a new plan made while a wake is prepared or admitted is never undone", async () => {
  let disable: (() => void) | null = null;
  const f = fixture({ onHead: () => disable?.() });
  const now = day(12);
  // Keep the main Ghost's ID-spread first wake out of this admission race.
  await f.core.autonomy.plan(f.main, f.main.id, { at: now + 6 * 60 * MINUTE, intent: "look later" }, now);
  f.ledger.tx(() => f.ledger.putSpace({ id: "11111111-1111-4111-8111-111111111111", name: "Twill", path: "/work/twill", createdAt: 1 }));
  await f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 10 * MINUTE, intent: "first", watch: ["11111111-1111-4111-8111-111111111111"] }, now);
  disable = () => f.core.autonomy.setEnabled(f.mate.id, false);
  await f.core.autonomy.tick(now + 10 * MINUTE);
  expect(f.wakes(f.mate.id)).toEqual([]);
  expect(f.plan(f.mate.id)).toMatchObject({ enabled: false, nextAt: null });

  disable = null;
  f.core.autonomy.setEnabled(f.mate.id, true);
  await f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 20 * MINUTE, intent: "second" }, now + 10 * MINUTE);
  let replans = 0;
  f.engine.onSubmit = async (conversationId) => {
    if (conversationId !== f.mate.directConversationId) return;
    replans++;
    await f.core.autonomy.plan(f.mate, f.mate.id, { at: now + 5 * 60 * MINUTE, intent: "follow the release" }, now + 20 * MINUTE);
  };
  await f.core.autonomy.tick(now + 20 * MINUTE);
  expect(f.wakes(f.mate.id)).toHaveLength(1);
  expect(replans).toBe(1);
  expect(f.wakes(f.main.id)).toEqual([]);
  expect(f.plan(f.mate.id)).toMatchObject({ nextAt: now + 5 * 60 * MINUTE, intent: "follow the release", setBy: "self", lastWakeAt: now + 20 * MINUTE });
});

test("at most two self-directed turns run at once, however long they take", async () => {
  const f = fixture();
  const now = day(13);
  const third = f.core.createGhost({ name: "Third", persona: "Design", model: { provider: "test", model: "test-model" } });
  for (const ghost of [f.main, f.mate, third]) await f.core.autonomy.plan(ghost, ghost.id, { at: now + 10 * MINUTE, intent: "look" }, now);
  f.engine.onSubmit = (conversationId) => {
    const ghost = f.ledger.ghosts().find((item) => item.directConversationId === conversationId)!;
    f.setBusy(ghost.id, true);
  };
  await f.core.autonomy.tick(now + 10 * MINUTE);
  const woken = () => [f.main, f.mate, third].filter((ghost) => f.wakes(ghost.id).length > 0);
  expect(woken()).toHaveLength(2);
  await f.core.autonomy.tick(now + 3 * 60 * MINUTE);
  expect(woken()).toHaveLength(2);
  f.setBusy(woken()[0]!.id, false);
  await f.core.autonomy.tick(now + 3 * 60 * MINUTE + MINUTE);
  expect(woken()).toHaveLength(3);
});

test("a wake recorded before a crash is retried with its own identity, and a repeated project position still wakes", async () => {
  const f = fixture();
  const now = day(14);
  const recorded = { requestId: `autonomy:${f.mate.id}:1:${now}`, text: "[Autonomous wake] recorded", at: now, heads: {}, revision: 1 };
  f.ledger.tx(() => f.ledger.putSetting(`autonomy:${f.mate.id}`, {
    ghostId: f.mate.id, enabled: true, nextAt: now, intent: "", setBy: "host", watch: [], lastWakeAt: null, wakesToday: 0,
    day: "", heads: {}, revision: 1, wakes: 0, pending: recorded,
  }));
  await f.core.autonomy.tick(now + 5 * MINUTE);
  expect(f.wakes(f.mate.id)).toEqual([expect.objectContaining({ requestId: recorded.requestId, text: recorded.text })]);
  // Counted from when it was actually admitted, not when it was recorded before the crash.
  expect(f.plan(f.mate.id)).toMatchObject({ lastWakeAt: now + 5 * MINUTE, nextAt: now + 5 * MINUTE + 24 * 60 * MINUTE });

  f.ledger.tx(() => f.ledger.putSpace({ id: "11111111-1111-4111-8111-111111111111", name: "Twill", path: "/work/twill", createdAt: 1 }));
  const [a, b] = [`main@${"a".repeat(40)}`, `feature@${"b".repeat(40)}`];
  f.heads.set("/work/twill", a);
  let at = now + 10 * MINUTE;
  await f.core.autonomy.plan(f.mate, f.mate.id, { at: at + 10 * 24 * 60 * MINUTE, intent: "watch", watch: ["11111111-1111-4111-8111-111111111111"] }, at);
  for (const position of [b, a, b]) {
    at += 61 * MINUTE;
    f.heads.set("/work/twill", position);
    await f.core.autonomy.tick(at);
  }
  const ids = f.wakes(f.mate.id).slice(1).map((wake) => wake.requestId);
  expect(new Set(ids).size).toBe(3);
});

test("after a restart, self-directed turns that are still running keep their slots", async () => {
  const f = fixture();
  const now = day(15);
  const third = f.core.createGhost({ name: "Third", persona: "Design", model: { provider: "test", model: "test-model" } });
  for (const ghost of [f.main, f.mate]) {
    f.ledger.tx(() => f.ledger.putSetting(`autonomy:${ghost.id}`, {
      ghostId: ghost.id, enabled: true, nextAt: now + 24 * 60 * MINUTE, intent: "", setBy: "host", watch: [], lastWakeAt: now - 40 * MINUTE,
      wakesToday: 1, day: "", heads: {}, revision: 3, wakes: 1, pending: null,
    }));
    f.setBusy(ghost.id, true);
  }
  await f.core.autonomy.plan(third, third.id, { at: now + 10 * MINUTE, intent: "look" }, now);
  await f.core.autonomy.tick(now + 10 * MINUTE);
  expect(f.wakes(third.id)).toEqual([]);
  f.setBusy(f.mate.id, false);
  await f.core.autonomy.tick(now + 11 * MINUTE);
  expect(f.wakes(third.id)).toHaveLength(1);
});

test("a Ghost whose drive is off is never told to plan_next, and the main Ghost keeps plan_next only while someone can be planned", () => {
  const f = fixture();
  const tools = createToolSet({ core: f.core, sandbox: noSandbox as never, memory: null, documents: null, skills: null });
  const direct = (ghostId: string) => f.ledger.conversation(f.ledger.ghost(ghostId).directConversationId);
  expect(tools.instructionsFor(direct(f.mate.id), f.ledger.ghost(f.mate.id), null)).toContain("call plan_next once");

  f.core.autonomy.setEnabled(f.mate.id, false);
  const mate = tools.instructionsFor(direct(f.mate.id), f.ledger.ghost(f.mate.id), null);
  expect(mate).not.toContain("call plan_next once");
  expect(mate).toContain("You have no plan_next");
  const main = tools.instructionsFor(direct(f.main.id), f.ledger.ghost(f.main.id), null);
  expect(main).toContain("call plan_next once");
  expect(main).toContain("each wake shows the team's plans");
  // 꺼진 동료 이름은 싣지 않는다 — 동료를 켜고 끌 때마다 메인의 프롬프트 캐시가 깨진다.
  expect(main).not.toContain("Mate");

  // 메인도 꺼지고 구동이 켜진 동료도 없으면 plan_next 는 어디에도 쓸 수 없다: 도구도 약속도 없다.
  f.core.autonomy.setEnabled(f.main.id, false);
  const idle = tools.instructionsFor(direct(f.main.id), f.ledger.ghost(f.main.id), null);
  expect(f.core.autonomy.offersPlanning(f.ledger.ghost(f.main.id))).toBe(false);
  expect(idle).toContain("You have no plan_next");
  expect(idle).not.toContain("each wake shows the team's plans");

  f.core.autonomy.setEnabled(f.mate.id, true);
  const planner = tools.instructionsFor(direct(f.main.id), f.ledger.ghost(f.main.id), null);
  expect(f.core.autonomy.offersPlanning(f.ledger.ghost(f.main.id))).toBe(true);
  expect(planner).toContain("never for yourself");
  expect(planner).not.toContain("each wake shows the team's plans");
});
