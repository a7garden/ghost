import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodingRun, parse } from "@ghost/contract";
import { loadConfig } from "../src/config.ts";
import { workDetail } from "../src/core/state.ts";
import { harness, tempDir } from "./support.ts";

test("an installed ledger retains historical terminal runs and releases abandoned reservations", async () => {
  const root = tempDir();
  const path = join(root, "ledger.db");
  const before = harness(path);
  try {
    const ghost = before.core.createGhost({ name: "Builder", persona: "", hostExecution: true, tools: ["code_run"] });
    const work = before.core.works.createRoot({ ghostId: ghost.id, originConversationId: ghost.directConversationId, title: "Earlier Work", brief: "Keep the history", execution: { kind: "host", cwd: root } });
    await before.core.idle();
    const now = Date.now();
    const conversationId = before.ledger.work(work.id).conversationId!;
    const savedPrefs = { session: "owner", agent: "omp", notify: "blocked" };
    const oldRun: CodingRun = {
      id: crypto.randomUUID(), workId: work.id, session: "owner", pane: "w1:p1", terminalId: "terminal-1", agent: "omp",
      branch: "ghost/earlier", checkout: join(root, "wt"), base: "abc", state: "working", turn: 1, deliveredTurn: 0,
      startedAt: now, updatedAt: now, seenWorking: true, prompt: "Old prompt", cursor: "40", report: null, stopPending: false,
    };
    const completed: CodingRun = {
      ...oldRun, id: crypto.randomUUID(), pane: "w2:p1", terminalId: "terminal-2", state: "settled", deliveredTurn: 1,
      report: JSON.stringify({ claim: "Historical result" }),
    };
    const binding = {
      effectId: "older-call", conversationId, rootId: work.id, identity: "old-identity", attempt: "old-attempt", turnsInAttempt: 4,
      opening: false, acknowledged: true, claim: null, blockedNoticeAt: null, finishing: null,
    };
    before.ledger.tx(() => {
      before.ledger.putSetting("coding", savedPrefs);
      before.ledger.putCodingRun({ ...binding, run: oldRun, pending: true, reserved: true });
      before.ledger.putCodingRun({ ...binding, run: completed, pending: false, reserved: false });
    });
    before.core.stop();
    await before.core.idle();
    before.ledger.close();
    const after = harness(path);
    try {
      after.core.coding.recover();
      await after.core.idle();
      const rows = workDetail(after.core, work.id).codingRuns!.map(run => parse(CodingRun, run));
      expect(rows.find(run => run.id === oldRun.id)).toEqual({ ...oldRun, state: "uncertain" });
      expect(rows.find(run => run.id === completed.id)).toEqual(completed);
      expect(after.ledger.setting<typeof savedPrefs | null>("coding", null)).toEqual(savedPrefs);
      expect(after.ledger.codingRunsToReconcile()).toEqual([]);
      expect(after.core.coding.pending(work.id)).toBe(false);
      expect(after.core.coding.working(work.id)).toBe(false);
    } finally {
      after.core.stop();
      await after.core.idle();
      after.ledger.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only coding false disables the workbench, including when loading an older config", () => {
  const root = tempDir();
  const configPath = join(root, "config.json");
  try {
    expect(loadConfig({}, root).coding).toBe(true);
    writeFileSync(configPath, JSON.stringify({ coding: { session: "owner", agent: "omp" } }));
    expect(loadConfig({}, root).coding).toBe(true);
    writeFileSync(configPath, JSON.stringify({ coding: false }));
    expect(loadConfig({}, root).coding).toBe(false);
    writeFileSync(configPath, JSON.stringify({ codign: false }));
    expect(() => loadConfig({}, root)).toThrow("unknown key codign");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
