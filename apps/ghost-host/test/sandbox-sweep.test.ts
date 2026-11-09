import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Work } from "@ghost/contract";
import type { Config } from "../src/config.ts";
import { grantsKey } from "../src/sandbox/container.ts";
import { createSandbox, sweepReason, workspaceExpired, WORKSPACE_RETAIN_MS } from "../src/sandbox/index.ts";
import { ContainerTracker, IDLE_MS, TRUST_MS } from "../src/sandbox/tracker.ts";
import { MemoryArtifacts } from "./support.ts";

const DAY = 24 * 60 * 60_000;

function work(patch: Partial<Work> = {}): Work {
  const id = `work-${crypto.randomUUID()}`;
  return {
    id,
    parentId: null,
    rootId: id,
    ghostId: "ghost-1",
    originConversationId: "conversation-1",
    conversationId: null,
    title: "sweep",
    brief: "",
    acceptance: { criteria: "", checks: [], reviewer: null },
    state: "running",
    revision: 1,
    revisionsUsed: 0,
    deadlineAt: null,
    result: null,
    verdict: null,
    reason: null,
    createdAt: 0,
    startedAt: 0,
    endedAt: null,
    updatedAt: 0,
    ...patch,
  };
}

function clock(start = 1_000_000) {
  const state = { at: start };
  return { now: () => state.at, advance: (ms: number) => void (state.at += ms) };
}

describe("container tracker", () => {
  test("a container it started is trusted without listing, until a command fails or trust ages out", () => {
    const time = clock();
    const tracker = new ContainerTracker(time.now);
    expect(tracker.trusted("c", "g")).toBe(false);
    tracker.started("c", "g");
    expect(tracker.trusted("c", "g")).toBe(true);
    tracker.doubt("c");
    expect(tracker.trusted("c", "g")).toBe(false);
    tracker.started("c", "g");
    time.advance(TRUST_MS);
    expect(tracker.trusted("c", "g")).toBe(false);
  });

  test("other grants are not trusted, and a running container started with them is not adopted", () => {
    const tracker = new ContainerTracker();
    tracker.started("c", "old");
    expect(tracker.trusted("c", "new")).toBe(false);
    expect(tracker.adopt("c", "new")).toBe(false);
    expect(tracker.adopt("c", "old")).toBe(true);
  });

  test("after a restart a running container is adopted whatever it was started with", () => {
    const tracker = new ContainerTracker();
    expect(tracker.adopt("c", "any")).toBe(true);
    expect(tracker.trusted("c", "any")).toBe(true);
  });

  test("starts are single-flight per container", async () => {
    const tracker = new ContainerTracker();
    let runs = 0;
    const start = async () => {
      runs += 1;
      await Promise.resolve();
      return runs;
    };
    const [a, b] = await Promise.all([tracker.once("c", start), tracker.once("c", start)]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    expect(await tracker.once("c", start)).toBe(2);
  });

  test("idle counts from the last command, and never while one runs", () => {
    const time = clock();
    const tracker = new ContainerTracker(time.now);
    const end = tracker.begin("c");
    time.advance(IDLE_MS * 2);
    expect(tracker.idle("c")).toBe(false);
    end();
    expect(tracker.idle("c")).toBe(false);
    time.advance(IDLE_MS);
    expect(tracker.idle("c")).toBe(true);
  });

  test("a container first seen by a sweep starts its idle clock then", () => {
    const time = clock();
    const tracker = new ContainerTracker(time.now);
    expect(tracker.idle("c")).toBe(false);
    time.advance(IDLE_MS);
    expect(tracker.idle("c")).toBe(true);
  });

  test("a container is not retired while a command runs in it, and a later command waits for the retirement", async () => {
    const tracker = new ContainerTracker();
    const end = tracker.begin("c");
    let removed = 0;
    expect(await tracker.retire("c", async () => void (removed += 1))).toBe(false);
    end();

    const order: string[] = [];
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const retiring = tracker.retire("c", async () => {
      await gate;
      order.push("deleted");
    });
    const command = tracker.settled("c").then(() => order.push("command"));
    open();
    expect(await retiring).toBe(true);
    await command;
    expect(order).toEqual(["deleted", "command"]);
    expect(tracker.trusted("c", "g")).toBe(false);
  });
});

describe("sweep decisions", () => {
  test("containers of settled or unknown Works go, stopped ones go, running ones only when idle", () => {
    expect(sweepReason(null, "running", () => false)).toBe("settled");
    expect(sweepReason(work({ state: "done" }), "running", () => false)).toBe("settled");
    expect(sweepReason(work({ state: "waiting" }), "stopped", () => false)).toBe("stopped");
    expect(sweepReason(work({ state: "waiting" }), "running", () => true)).toBe("idle");
    expect(sweepReason(work({ state: "running" }), "running", () => false)).toBeNull();
  });

  test("workspaces go 30 days after the Work settled, except a failed root Work that can be resumed", () => {
    const now = 100 * DAY;
    const old = now - WORKSPACE_RETAIN_MS;
    expect(workspaceExpired(work({ state: "done", endedAt: old }), now)).toBe(true);
    expect(workspaceExpired(work({ state: "cancelled", endedAt: old }), now)).toBe(true);
    expect(workspaceExpired(work({ state: "failed", endedAt: old, parentId: "parent" }), now)).toBe(true);
    expect(workspaceExpired(work({ state: "failed", endedAt: old }), now)).toBe(false);
    expect(workspaceExpired(work({ state: "done", endedAt: old + 1 }), now)).toBe(false);
    expect(workspaceExpired(work({ state: "running" }), now)).toBe(false);
    expect(workspaceExpired(null, now)).toBe(false);
  });

  test("the grants key changes with every grant", () => {
    const base = { cli: "c", image: "i", name: "n", workspace: "/w", logicalRoot: "/workspace" };
    const keys = new Set([
      grantsKey(base),
      grantsKey({ ...base, network: true }),
      grantsKey({ ...base, mounts: [{ path: "/a", writable: false }] }),
      grantsKey({ ...base, cpus: 4 }),
      grantsKey({ ...base, memoryGiB: 8 }),
      grantsKey({ ...base, readOnly: true }),
    ]);
    expect(keys.size).toBe(6);
    expect(grantsKey({ ...base, network: false, cpus: 2, memoryGiB: 2 })).toBe(grantsKey(base));
  });
});

describe("sandbox sweep", () => {
  test("removes old workspaces of this state root and keeps the rest, at most once a minute", async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-sweep-"));
    const config: Config = {
      root,
      host: "127.0.0.1",
      port: 62063,
      publicOrigin: "http://127.0.0.1:62063",
      uiDir: null,
      sandbox: { kind: "local" },
      memory: null,
      voice: null,
      apns: null,
      skills: null,
      reach: null,
    };
    const sandbox = createSandbox(config, new MemoryArtifacts());
    const now = 100 * DAY;
    const old = work({ state: "done", endedAt: now - WORKSPACE_RETAIN_MS });
    const recent = work({ state: "done", endedAt: now - DAY });
    const resumable = work({ state: "failed", endedAt: now - WORKSPACE_RETAIN_MS });
    const works = new Map([old, recent, resumable].map((item) => [item.id, item]));
    const paths = [old, recent, resumable].map((item) => sandbox.workspacePath(item));

    const swept = await sandbox.sweep!(now, (id) => works.get(id) ?? null);
    expect(swept).toEqual({ containers: [], workspaces: [old.id], failures: [] });
    expect(paths.map((path) => existsSync(path))).toEqual([false, true, true]);

    const later = work({ state: "cancelled", endedAt: 0 });
    works.set(later.id, later);
    sandbox.workspacePath(later);
    expect((await sandbox.sweep!(now + 1000, (id) => works.get(id) ?? null)).workspaces).toEqual([]);
    expect((await sandbox.sweep!(now + 60_000, (id) => works.get(id) ?? null)).workspaces).toEqual([later.id]);
  });
});
