import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingSession, Layout } from "@ghost/contract";
import { Ledger } from "../ledger/ledger.ts";
import { serveWorkbench } from "./http.ts";
import { closePane, movePane, resizeSplit, splitPane } from "./layout.ts";
import { Workbench } from "./service.ts";
import type { WorkbenchTerminals } from "./ports.ts";

const pane = (paneId: string): Layout => ({ type: "pane", paneId });
const row = splitPane(pane("a"), "b", { target: "a", id: "row", direction: "right" });
const nested = splitPane(row, "c", { target: "b", id: "column", direction: "down" });

const roots: string[] = [];
const ledgers = new Set<Ledger>();
afterEach(() => {
  for (const ledger of ledgers) ledger.close();
  ledgers.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ghost-workbench-test-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  const ledger = new Ledger(path);
  ledgers.add(ledger);
  const created: { id: string; spec: Parameters<WorkbenchTerminals["create"]>[0] }[] = [];
  const closed: string[] = [];
  const terminals: WorkbenchTerminals = {
    create(spec) { const id = `term-${created.length}`; created.push({ id, spec }); return id; },
    async closeTerminal(id) { closed.push(id); },
  };
  const session: CodingSession = {
    id: "preserved", title: "세션", cwd: root, repo: null, branch: null, base: null, workId: null, turn: 0,
    model: { provider: "test", model: "test" }, state: "idle", thinking: "off", pendingDialog: null,
    usage: { input: 0, output: 0, cost: 0 }, createdAt: 0, updatedAt: 0,
  };
  const sessions = { get: (id: string) => id === session.id ? session : null };
  const workbench = new Workbench(ledger, sessions, terminals, root);
  return { root, path, ledger, workbench, created, closed, sessions, terminals };
}

test("split only an existing leaf, preserve the other branch, and collapse closed leaves", () => {
  expect(nested).toEqual({ type: "split", id: "row", direction: "row", ratio: 0.5, first: pane("a"), second: {
    type: "split", id: "column", direction: "column", ratio: 0.5, first: pane("b"), second: pane("c"),
  } });
  expect(closePane(nested, "unknown")).toBe(nested);
  expect(closePane(nested, "c")).toEqual(row);
  expect(closePane(closePane(nested, "c"), "a")).toEqual(pane("b"));
  expect(closePane(pane("only"), "only")).toBeNull();
  expect(splitPane(null, "first")).toEqual(pane("first"));
  expect(() => splitPane(row, "second")).toThrow();
  expect(() => splitPane(row, "d", { target: "unknown", direction: "down", id: "no" })).toThrow();
});

test("move trades slots non-destructively and resize preserves both child subtrees", () => {
  expect(movePane(nested, "a", "a")).toBe(nested);
  expect(() => movePane(nested, "a", "missing")).toThrow();
  expect(movePane(nested, "a", "c")).toEqual({ type: "split", id: "row", direction: "row", ratio: 0.5, first: pane("c"), second: {
    type: "split", id: "column", direction: "column", ratio: 0.5, first: pane("b"), second: pane("a"),
  } });
  expect(resizeSplit(nested, "row", 0.5)).toBe(nested);
  expect(resizeSplit(nested, "row", -5)).toMatchObject({ ratio: 0.1 });
  expect(resizeSplit(nested, "column", 5)).toMatchObject({ ratio: 0.5, second: { ratio: 0.9 } });
  expect(() => resizeSplit(nested, "row", Number.NaN)).toThrow();
  expect(() => resizeSplit(nested, "bad", 0.3)).toThrow();
});

test("persists layout, spec and focus across ledger reopen; rejects stale writes and never persists a PTY id", async () => {
  const { root, path, ledger, workbench, created, closed, sessions, terminals } = fixture();
  const space = workbench.createSpace({ version: 0, title: " 저장소 ", root }).spaces[0]!;
  expect(space.title).toBe("저장소");
  const tab = workbench.createTab(space.id, 1, "구현").tabs[0]!;
  expect(() => workbench.renameTab(tab.id, 1, "stale")).toThrow(expect.objectContaining({ code: "conflict" }));
  const left = workbench.addPane(tab.id, { version: 2, pane: { kind: "session", sessionId: "preserved" } }).panes[0]!;
  const snapshot = workbench.addPane(tab.id, { version: 3, targetPaneId: left.id, direction: "right", pane: { kind: "terminal" } });
  const right = snapshot.panes[1]!;
  const [binding, duplicate] = await Promise.all([workbench.openTerminal(right.id), workbench.openTerminal(right.id)]);
  expect(binding).toEqual({ id: "term-0" });
  expect(duplicate).toEqual(binding);
  expect(created).toHaveLength(1);
  expect(created[0]?.spec.cwd).toBe(root);
  expect(JSON.stringify(ledger.setting("workbench.state", null))).not.toContain(binding.id!);
  expect(workbench.focusTerminal(binding.id!, snapshot.version)).toEqual(snapshot);
  ledger.close();
  ledgers.delete(ledger);

  const restarted = new Ledger(path);
  ledgers.add(restarted);
  const resumed = new Workbench(restarted, sessions, terminals, root);
  expect(resumed.read()).toEqual(snapshot);
  await expect(resumed.openTerminal(right.id)).resolves.toEqual({ id: "term-1" });
  const afterTerminal = await resumed.deletePane(right.id, 4);
  expect(afterTerminal.focus?.paneId).toBe(left.id);
  expect(closed).toEqual(["term-1"]);
  expect((await resumed.deletePane(left.id, 5)).tabs[0]?.layout).toBeNull();
  expect(sessions.get("preserved")).not.toBeNull();
  expect(closed).toEqual(["term-1"]);
});

test("an agent pane carries argv to the PTY but only launches again on owner request after restart", async () => {
  const { root, ledger, workbench, created, sessions, terminals } = fixture();
  const space = workbench.createSpace({ version: 0, title: "저장소", root }).spaces[0]!;
  const tab = workbench.createTab(space.id, 1, "CLI").tabs[0]!;
  const terminalSpec = { cwd: root, command: "omp", args: ["--resume", "session id", "--approval-mode", "write"] };
  const snapshot = workbench.addPane(tab.id, { version: 2, pane: { kind: "terminal", terminalSpec } });
  const pane = snapshot.panes[0]!;
  expect(pane).toMatchObject({ kind: "terminal", terminalSpec });
  await expect(workbench.openTerminal(pane.id)).resolves.toEqual({ id: "term-0" });
  expect(created[0]?.spec).toEqual({ ...terminalSpec, cols: 80, rows: 24 });

  const resumed = new Workbench(ledger, sessions, terminals, root);
  await expect(resumed.openTerminal(pane.id)).resolves.toEqual({ id: null });
  await expect(resumed.openTerminal(pane.id, "term-0")).resolves.toEqual({ id: null });
  expect(created).toHaveLength(1);
  await expect(resumed.openTerminal(pane.id, undefined, true)).resolves.toEqual({ id: "term-1" });
  expect(created[1]?.spec).toEqual(created[0]?.spec);
});

test("closes terminal bindings on tab and space deletion and forbids cross-tab moves", async () => {
  const { workbench, closed } = fixture();
  const space = workbench.createSpace({ version: 0, title: "스페이스", root: null }).spaces[0]!;
  const a = workbench.createTab(space.id, 1, "A").tabs[0]!;
  const b = workbench.createTab(space.id, 2, "B").tabs[1]!;
  const left = workbench.addPane(a.id, { version: 3, pane: { kind: "terminal" } }).panes[0]!;
  const right = workbench.addPane(b.id, { version: 4, pane: { kind: "terminal" } }).panes[1]!;
  expect(() => workbench.move(left.id, right.id, 5)).toThrow();
  const pt1 = await workbench.openTerminal(left.id), pt2 = await workbench.openTerminal(right.id);
  const tabRemoved = await workbench.deleteTab(b.id, 5);
  expect(tabRemoved.focus).toEqual({ spaceId: space.id, tabId: a.id, paneId: left.id });
  const allRemoved = await workbench.deleteSpace(space.id, 6);
  expect(allRemoved).toEqual({ version: 7, spaces: [], tabs: [], panes: [], focus: null });
  expect(closed).toEqual([pt2.id!, pt1.id!]);
});

test("a pending or failed terminal teardown cannot lose the saved pane or restart it", async () => {
  const { workbench, terminals } = fixture();
  const space = workbench.createSpace({ version: 0, title: "Owners", root: null }).spaces[0]!;
  const tab = workbench.createTab(space.id, 1, "Terminal").tabs[0]!;
  const snapshot = workbench.addPane(tab.id, { version: 2, pane: { kind: "terminal" } });
  const pane = snapshot.panes[0]!;
  const binding = await workbench.openTerminal(pane.id);
  const gate = Promise.withResolvers<void>();
  terminals.closeTerminal = () => gate.promise;
  const removal = workbench.deletePane(pane.id, snapshot.version);
  await expect(workbench.openTerminal(pane.id, binding.id!)).rejects.toMatchObject({ code: "conflict" });
  expect(() => workbench.renameTab(tab.id, snapshot.version, "Too soon")).toThrow(expect.objectContaining({ code: "conflict" }));
  gate.reject(new Error("PTY removal failed"));
  await expect(removal).rejects.toThrow("PTY removal failed");
  expect(workbench.read()).toEqual(snapshot);
  await expect(workbench.openTerminal(pane.id)).resolves.toEqual(binding);
});

test("only the owner or an owner-equivalent paired device can open a workbench terminal", async () => {
  const { workbench, created } = fixture();
  const space = workbench.createSpace({ version: 0, title: "Owners", root: null }).spaces[0]!;
  const tab = workbench.createTab(space.id, 1, "Terminal").tabs[0]!;
  const terminal = workbench.addPane(tab.id, { version: 2, pane: { kind: "terminal" } }).panes[0]!;
  const path = `/api/workbench/panes/${terminal.id}/terminal`;
  const request = () => new Request(`http://localhost${path}`, { method: "POST", body: "{}" });
  await expect(serveWorkbench(workbench, { kind: "ghost" }, request(), path)).rejects.toMatchObject({ code: "forbidden" });
  expect(created).toHaveLength(0);
  await expect(serveWorkbench(workbench, { kind: "device", deviceId: "test", name: "전화" }, request(), path)).resolves.toEqual({ id: "term-0" });
});
