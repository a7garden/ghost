import { expect, spyOn, test } from "bun:test";
import type { ActivityConfig, ActivitySourceItem, Connection } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import type { ActivitySourcePort } from "../src/integrations/activity-sources.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

/** Run actual scheduler callbacks against a clock without waiting through minute-long polls. */
function clock() {
  const nativeSetTimeout = globalThis.setTimeout;
  let now = Date.now();
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, run: () => callback(...args) });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((id) => { timers.delete(Number(id)); });
  const settle = async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    nativeSetTimeout(resolve, 0);
    await promise;
  };
  return {
    get now() { return now; },
    async advance(milliseconds: number) {
      const target = now + milliseconds;
      let fired = 0;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++fired > 100) throw new Error("scheduler is spinning instead of waiting for a meaningful wake");
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await settle();
      }
      now = target;
      await settle();
      return fired;
    },
    restore() { clear.mockRestore(); set.mockRestore(); date.mockRestore(); },
  };
}

class GatedSource implements ActivitySourcePort {
  gate = Promise.withResolvers<void>();
  polls = 0;
  active = 0;
  peak = 0;
  credentialPresent() { return true; }
  async setCredential() {}
  async test() { return { summary: "connected" }; }
  async poll() {
    this.polls++;
    this.peak = Math.max(this.peak, ++this.active);
    try {
      await this.gate.promise;
      return { items: [], exclusions: [], cursor: "after" };
    } finally { this.active--; }
  }
  async read(_connection: Connection, item: ActivitySourceItem) { return item; }
  async act() { return { summary: "unused" }; }
  async close() { this.gate.resolve(); }
}

function fixture() {
  const source = new GatedSource();
  const ledger = new Ledger(":memory:");
  const errors: unknown[] = [];
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), activitySources: source, log: (_message, error) => errors.push(error) });
  const engine = new FakeEngine();
  core.attach(engine);
  const ghost = core.createGhost({ name: "Watcher", persona: "Observe", model: { provider: "test", model: "test-model" }, tools: [] });
  const connection: Connection = { id: crypto.randomUUID(), name: "Account", config: { kind: "github", baseUrl: "https://api.github.com" }, hasCredential: true, credentialVersion: "one", createdAt: Date.now(), updatedAt: Date.now() };
  ledger.tx(() => ledger.putConnection(connection));
  const config: ActivityConfig = { ghostId: ghost.id, name: "Gated source", prompt: "Observe", acceptanceCriteria: "Report", execution: { kind: "container" }, tools: [], source: { kind: "pull_request", connectionId: connection.id, repository: "owner/repo", baseBranch: null, labels: [], includeDrafts: false, includeExisting: true, pollSeconds: 60 }, policy: { maxRunsPerDay: 20, maxConcurrent: 1, runTimeoutSeconds: 300, allowSelfCheck: true, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" } };
  return {
    core, ledger, source, engine, ghost, config, errors,
    async close() {
      // Match Host shutdown: stop admission, abort/close transports, then drain core lanes.
      core.stop();
      await source.close();
      await core.idle();
      ledger.close();
    },
  };
}

test("a gated source cannot stall unrelated schedule delivery, Work expiry, or shutdown", async () => {
  const time = clock();
  const f = fixture();
  try {
    f.core.activities.create(f.config);
    const schedule = f.core.schedules.create({ ghostId: f.ghost.id, prompt: "Unrelated scheduled message", spec: { kind: "at", at: time.now + 2000 } });
    const work = f.core.works.createRoot({ ghostId: f.ghost.id, title: "Deadline", brief: "Expire independently", originConversationId: f.ghost.directConversationId, deadlineAt: time.now + 1500 });
    await f.core.start();
    await time.advance(1000);
    expect(f.source.active).toBe(1);
    expect(f.ledger.schedule(schedule.id).state).toBe("active");
    expect(f.ledger.work(work.id).state).toBe("running");

    await time.advance(1000);
    expect(f.source.active).toBe(1);
    expect(f.ledger.schedule(schedule.id).state).toBe("done");
    expect(f.engine.to(f.ghost.directConversationId).filter((entry) => entry.origin === "schedule").map((entry) => entry.text)).toEqual(["Unrelated scheduled message"]);
    expect(f.ledger.work(work.id).state).toBe("failed");
    expect(f.ledger.work(work.id).reason).toContain("deadline");
    expect(f.engine.aborted).toContain(f.ledger.work(work.id).conversationId!);

    // The same pending poll spans several deadline-maintenance wakes, not one launch per wake.
    expect(await time.advance(90_000)).toBeLessThanOrEqual(3);
    expect(f.source.polls).toBe(1);
    expect(f.source.peak).toBe(1);
    expect(f.source.active).toBe(1);

    // Releasing a slow request must not flush a backlog of poll launches.
    f.source.gate.resolve();
    await f.core.idle();
    expect(f.source.polls).toBe(1);
    expect(f.source.active).toBe(0);
    f.source.gate = Promise.withResolvers<void>();
    await time.advance(1000);
    expect(f.source.polls).toBe(1);
    await time.advance(59_000);
    expect(f.source.polls).toBe(2);
    expect(f.source.active).toBe(1);
    expect(f.source.peak).toBe(1);
    let drained = false;
    const drain = f.core.idle().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    f.core.stop();
    await f.source.close();
    await drain;
    expect(drained).toBe(true);
    expect(f.source.active).toBe(0);
    await time.advance(90_000);
    expect(f.source.polls).toBe(2);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
    time.restore();
  }
});

test("scheduled Activities and bounded self-checks progress while another source remains gated", async () => {
  const time = clock();
  const f = fixture();
  try {
    f.core.activities.create(f.config);
    const activity = f.core.activities.create({ ...f.config, source: { kind: "schedule", spec: { kind: "at", at: time.now + 1000 } } });
    const later = f.core.activities.create({ ...f.config, name: "Later scheduled activity", source: { kind: "schedule", spec: { kind: "at", at: time.now + 2000 } } });
    await f.core.start();
    await time.advance(1000);
    expect(f.source.active).toBe(1);
    const run = f.ledger.activityRuns(activity.id)[0]!;
    const checkAt = time.now + 65_000;
    f.core.activities.requestNextCheck(run.workId!, checkAt, "Revisit the result");
    f.core.works.complete(run.workId!, { summary: "No changes", artifacts: [], noChange: true });
    await time.advance(0);
    f.core.works.applyVerdict(run.workId!, { outcome: "pass", source: "review", reasons: "Meets the criteria", at: time.now });
    await time.advance(0);
    expect(f.ledger.activity(activity.id).nextAt).toBeNull();
    expect(f.ledger.work(run.workId!).state).toBe("done");

    await time.advance(1000);
    const scheduled = f.ledger.activityRuns(later.id);
    expect(scheduled).toHaveLength(1);
    expect(f.ledger.work(scheduled[0]!.workId!).state).toBe("running");
    expect(f.source.active).toBe(1);
    await time.advance(63_000);
    expect(f.ledger.activityRuns(activity.id)).toHaveLength(1);
    await time.advance(1000);
    const followups = f.ledger.activityRuns(activity.id).filter((entry) => entry.trigger === "self_check");
    expect(followups).toHaveLength(1);
    expect(followups[0]!.createdAt).toBe(checkAt);
    expect(followups[0]!.followupOf).toBe(run.id);
    expect(f.ledger.work(followups[0]!.workId!).state).toBe("running");
    expect(f.ledger.findActivityRun(run.id)!.nextCheckAt).toBeNull();
    expect(f.source.active).toBe(1);
    expect(f.source.polls).toBe(1);
    expect(f.source.peak).toBe(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
    time.restore();
  }
});
