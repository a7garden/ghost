import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingSession } from "@ghost/contract";
import { Ledger } from "../ledger/ledger.ts";
import { serveWorkbench } from "./http.ts";
import { Workbench } from "./service.ts";

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
  const session = (id: string): CodingSession => ({
    id, title: id, cwd: root, repo: null, branch: null, base: null, workId: null, turn: 0,
    model: { provider: "test", model: "test" }, state: "idle", thinking: "off", pendingDialog: null,
    usage: { input: 0, output: 0, cost: 0 }, createdAt: 0, updatedAt: 0,
  });
  const known = new Map(["one", "two", "three"].map(id => [id, session(id)]));
  const sessions = { get: (id: string) => known.get(id) ?? null };
  return { root, path, ledger, sessions, workbench: new Workbench(ledger, sessions, root) };
}

test("lists agents per space, remembers each space's agent and survives a ledger reopen", () => {
  const { root, path, ledger, sessions, workbench } = fixture();
  const first = workbench.createSpace({ version: 0, title: " 저장소 ", root }).spaces[0]!;
  expect(first.title).toBe("저장소");
  expect(() => workbench.renameSpace(first.id, 0, "stale")).toThrow(expect.objectContaining({ code: "conflict" }));
  workbench.addAgent(first.id, { version: 1, sessionId: "one" });
  workbench.addAgent(first.id, { version: 2, sessionId: "two" });
  const second = workbench.createSpace({ version: 3, title: "다른 곳", root: null }).spaces[1]!;
  expect(workbench.read().focus).toEqual({ spaceId: second.id, sessionId: null });
  // Returning to a space reopens the agent shown last, not the first one.
  expect(workbench.focus({ version: 4, spaceId: first.id }).focus).toEqual({ spaceId: first.id, sessionId: "two" });
  workbench.focus({ version: 5, spaceId: first.id, sessionId: "one" });
  workbench.focus({ version: 6, spaceId: second.id });
  const snapshot = workbench.focus({ version: 7, spaceId: first.id });
  expect(snapshot.focus).toEqual({ spaceId: first.id, sessionId: "one" });
  expect(snapshot.agents).toEqual([{ sessionId: "one", spaceId: first.id }, { sessionId: "two", spaceId: first.id }]);
  ledger.close();
  ledgers.delete(ledger);

  const restarted = new Ledger(path);
  ledgers.add(restarted);
  expect(new Workbench(restarted, sessions, root).read()).toEqual(snapshot);
});

test("an agent belongs to one space, must be a real session, and removing it never closes the session", () => {
  const { sessions, workbench } = fixture();
  const a = workbench.createSpace({ version: 0, title: "A", root: null }).spaces[0]!;
  const b = workbench.createSpace({ version: 1, title: "B", root: null }).spaces[1]!;
  expect(() => workbench.addAgent(a.id, { version: 2, sessionId: "missing" })).toThrow(expect.objectContaining({ code: "not_found" }));
  workbench.addAgent(a.id, { version: 2, sessionId: "one" });
  expect(() => workbench.addAgent(b.id, { version: 3, sessionId: "one" })).toThrow(expect.objectContaining({ code: "invalid" }));
  // Adding it again to the same space only focuses it.
  expect(workbench.addAgent(a.id, { version: 3, sessionId: "one" }).agents).toHaveLength(1);
  expect(() => workbench.focus({ version: 4, spaceId: b.id, sessionId: "one" })).toThrow(expect.objectContaining({ code: "invalid" }));
  workbench.addAgent(a.id, { version: 4, sessionId: "two" });
  const removed = workbench.removeAgent("two", 5);
  expect(removed.focus).toEqual({ spaceId: a.id, sessionId: "one" });
  expect(workbench.removeAgent("one", 6).focus).toEqual({ spaceId: a.id, sessionId: null });
  expect(() => workbench.removeAgent("one", 7)).toThrow(expect.objectContaining({ code: "not_found" }));
  expect(sessions.get("one")).not.toBeNull();
});

test("deleting a space drops its agents and moves focus to another space", () => {
  const { workbench } = fixture();
  const a = workbench.createSpace({ version: 0, title: "A", root: null }).spaces[0]!;
  workbench.addAgent(a.id, { version: 1, sessionId: "one" });
  const b = workbench.createSpace({ version: 2, title: "B", root: null }).spaces[1]!;
  workbench.addAgent(b.id, { version: 3, sessionId: "two" });
  const afterB = workbench.deleteSpace(b.id, 4);
  expect(afterB.agents).toEqual([{ sessionId: "one", spaceId: a.id }]);
  expect(afterB.focus).toEqual({ spaceId: a.id, sessionId: "one" });
  expect(workbench.deleteSpace(a.id, 5)).toMatchObject({ spaces: [], agents: [], focus: null });
});

test("reads the tab and pane state of older releases as agents and drops terminals", () => {
  const { root, ledger, sessions } = fixture();
  const space = { id: "s1", title: "저장소", root, createdAt: 1 };
  ledger.putSetting("workbench.state", {
    version: 9,
    spaces: [space, { id: "s2", title: "비어 있음", root: null, createdAt: 2 }],
    tabs: [{ id: "t1", spaceId: "s1", title: "구현", layout: null, focusedPaneId: "p2" }, { id: "t2", spaceId: "s1", title: "셸", layout: null, focusedPaneId: null }],
    panes: [
      { id: "p1", tabId: "t1", kind: "terminal", terminalSpec: { cwd: root } },
      { id: "p2", tabId: "t1", kind: "session", sessionId: "one" },
      { id: "p3", tabId: "t2", kind: "session", sessionId: "two" },
      { id: "p4", tabId: "t2", kind: "session", sessionId: "one" },
    ],
    focus: { spaceId: "s1", tabId: "t1", paneId: "p2" },
  });
  const workbench = new Workbench(ledger, sessions, root);
  expect(workbench.read()).toEqual({
    version: 9, spaces: [space, { id: "s2", title: "비어 있음", root: null, createdAt: 2 }],
    agents: [{ sessionId: "one", spaceId: "s1" }, { sessionId: "two", spaceId: "s1" }],
    focus: { spaceId: "s1", sessionId: "one" },
  });
  // The first change after the upgrade writes the new shape.
  workbench.renameSpace("s2", 9, "이름");
  expect(Object.keys(ledger.setting<object>("workbench.state", {})).sort()).toEqual(["agents", "focus", "spaces", "version"]);
});

test("only the owner or an owner-equivalent paired device can arrange the workbench", async () => {
  const { workbench } = fixture();
  const space = workbench.createSpace({ version: 0, title: "Owners", root: null }).spaces[0]!;
  const path = `/api/workbench/spaces/${space.id}/agents`;
  const request = () => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify({ version: 1, sessionId: "one" }) });
  await expect(serveWorkbench(workbench, { kind: "ghost" }, request(), path)).rejects.toMatchObject({ code: "forbidden" });
  expect(workbench.read().agents).toHaveLength(0);
  await expect(serveWorkbench(workbench, { kind: "device", deviceId: "test", name: "전화" }, request(), path)).resolves.toMatchObject({
    agents: [{ sessionId: "one", spaceId: space.id }],
  });
});
