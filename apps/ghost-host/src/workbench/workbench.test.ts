import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingSession, Scope } from "@ghost/contract";
import { Ledger } from "../ledger/ledger.ts";
import { serveWorkbench } from "./http.ts";
import { ownerScopeCreator, Workbench } from "./service.ts";
import { harness } from "../../test/support.ts";

const roots: string[] = [];
const ledgers = new Set<Ledger>();
afterEach(() => {
  for (const ledger of ledgers) ledger.close();
  ledgers.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeScope(ledger: Ledger, id: string, paths: string[]): Scope {
  const scope: Scope = { id, name: id, ghostId: null, paths, vaultPath: null, state: "active", attachments: [], limits: {}, createdAt: 1, updatedAt: 1 };
  ledger.tx(() => ledger.putScope(scope));
  return scope;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ghost-workbench-test-")));
  roots.push(root);
  const path = join(root, "ledger.db");
  const ledger = new Ledger(path);
  ledgers.add(ledger);
  const session = (id: string): CodingSession => ({
    id, title: id, cwd: root, repo: null, branch: null, base: null, workId: null, ghostId: null, turn: 0,
    model: { provider: "test", model: "test" }, state: "idle", thinking: "off", pendingDialog: null,
    usage: { input: 0, output: 0, cost: 0 }, createdAt: 0, updatedAt: 0,
  });
  const known = new Map(["one", "two", "three"].map(id => [id, session(id)]));
  const sessions = { get: (id: string) => known.get(id) ?? null, list: () => [...known.values()] };
  return { root, path, ledger, sessions, workbench: new Workbench(ledger, sessions) };
}

test("lists agents per project, remembers each project's agent and survives a ledger reopen", () => {
  const { root, path, ledger, sessions, workbench } = fixture();
  const scope = makeScope(ledger, "scope-a", [root]);
  expect(() => workbench.addAgent({ version: 0, sessionId: "one", scopeId: "missing" })).toThrow(expect.objectContaining({ code: "not_found" }));
  workbench.addAgent({ version: 0, sessionId: "one", scopeId: scope.id });
  workbench.addAgent({ version: 1, sessionId: "two", scopeId: scope.id });
  expect(workbench.focus({ version: 2, scopeId: null }).focus).toEqual({ scopeId: null, sessionId: null });
  // Returning to a project reopens the agent shown last, not the first one.
  expect(workbench.focus({ version: 3, scopeId: scope.id }).focus).toEqual({ scopeId: scope.id, sessionId: "two" });
  workbench.focus({ version: 4, scopeId: scope.id, sessionId: "one" });
  workbench.focus({ version: 5, scopeId: null });
  const snapshot = workbench.focus({ version: 6, scopeId: scope.id });
  expect(snapshot.focus).toEqual({ scopeId: scope.id, sessionId: "one" });
  expect(snapshot.agents).toEqual([{ sessionId: "one", scopeId: scope.id }, { sessionId: "two", scopeId: scope.id }]);
  ledger.close();
  ledgers.delete(ledger);

  const restarted = new Ledger(path);
  ledgers.add(restarted);
  expect(new Workbench(restarted, sessions).read()).toEqual(snapshot);
});

test("a project's folders lead with the repository its docs path sits in", async () => {
  const { root, ledger, workbench } = fixture();
  const repo = join(root, "repo");
  const docs = join(repo, "docs");
  const plain = join(root, "plain");
  mkdirSync(docs, { recursive: true });
  mkdirSync(plain);
  Bun.spawnSync(["git", "init", "-q", repo]);
  makeScope(ledger, "scope-docs", [docs, plain]);
  expect(await workbench.folders("scope-docs")).toEqual([repo, docs, plain]);
  await expect(workbench.folders("missing")).rejects.toMatchObject({ code: "not_found" });
});

test("an agent belongs to one project, must be a real session, and removing it never closes the session", () => {
  const { ledger, sessions, workbench } = fixture();
  const a = makeScope(ledger, "scope-a", []);
  const b = makeScope(ledger, "scope-b", []);
  expect(() => workbench.addAgent({ version: 0, sessionId: "missing", scopeId: a.id })).toThrow(expect.objectContaining({ code: "not_found" }));
  workbench.addAgent({ version: 0, sessionId: "one", scopeId: a.id });
  expect(() => workbench.addAgent({ version: 1, sessionId: "one", scopeId: b.id })).toThrow(expect.objectContaining({ code: "invalid" }));
  // Adding it again to the same project only focuses it.
  expect(workbench.addAgent({ version: 1, sessionId: "one", scopeId: a.id }).agents).toHaveLength(1);
  expect(() => workbench.focus({ version: 2, scopeId: a.id, sessionId: "missing" })).toThrow(expect.objectContaining({ code: "not_found" }));
  workbench.addAgent({ version: 2, sessionId: "two", scopeId: a.id });
  const removed = workbench.removeAgent("two", 3);
  expect(removed.focus).toEqual({ scopeId: a.id, sessionId: "one" });
  expect(workbench.removeAgent("one", 4).focus).toEqual({ scopeId: a.id, sessionId: null });
  expect(() => workbench.removeAgent("one", 5)).toThrow(expect.objectContaining({ code: "not_found" }));
  expect(sessions.get("one")).not.toBeNull();
});

test("an agent moves between projects, and a Ghost's unlisted session can be focused", () => {
  const { ledger, workbench } = fixture();
  const a = makeScope(ledger, "scope-a", []);
  const b = makeScope(ledger, "scope-b", []);
  workbench.addAgent({ version: 0, sessionId: "one", scopeId: a.id });
  expect(workbench.moveAgent("one", { version: 1, scopeId: b.id }).agents).toEqual([{ sessionId: "one", scopeId: b.id }]);
  expect(workbench.moveAgent("one", { version: 2, scopeId: null }).agents).toEqual([{ sessionId: "one", scopeId: null }]);
  expect(workbench.moveAgent("one", { version: 3, scopeId: null }).version).toBe(3);
  expect(() => workbench.moveAgent("one", { version: 3, scopeId: "missing" })).toThrow(expect.objectContaining({ code: "not_found" }));
  // A session a Ghost started is not an agent, but the owner can still show it in a project.
  expect(workbench.focus({ version: 3, scopeId: a.id, sessionId: "three" }).focus).toEqual({ scopeId: a.id, sessionId: "three" });
  expect(workbench.focus({ version: 4, scopeId: a.id }).focus).toEqual({ scopeId: a.id, sessionId: "three" });
});

test("a deleted Scope reads as 프로젝트 없음 for its agents and focus", () => {
  const { ledger, workbench } = fixture();
  const a = makeScope(ledger, "scope-a", []);
  workbench.addAgent({ version: 0, sessionId: "one", scopeId: a.id });
  ledger.tx(() => ledger.deleteScope(a.id));
  expect(workbench.read()).toEqual({ version: 1, agents: [{ sessionId: "one", scopeId: null }], focus: { scopeId: null, sessionId: "one" } });
});

test("reads the tab and pane state of older releases as agents and drops terminals", () => {
  const { root, ledger, sessions } = fixture();
  ledger.putSetting("workbench.state", {
    version: 9,
    spaces: [{ id: "s1", title: "저장소", root, createdAt: 1 }, { id: "s2", title: "비어 있음", root: null, createdAt: 2 }],
    tabs: [{ id: "t1", spaceId: "s1", title: "구현", layout: null, focusedPaneId: "p2" }, { id: "t2", spaceId: "s1", title: "셸", layout: null, focusedPaneId: null }],
    panes: [
      { id: "p1", tabId: "t1", kind: "terminal", terminalSpec: { cwd: root } },
      { id: "p2", tabId: "t1", kind: "session", sessionId: "one" },
      { id: "p3", tabId: "t2", kind: "session", sessionId: "two" },
      { id: "p4", tabId: "t2", kind: "session", sessionId: "one" },
    ],
    focus: { spaceId: "s1", tabId: "t1", paneId: "p2" },
  });
  const workbench = new Workbench(ledger, sessions);
  const expected = { version: 9, agents: [{ sessionId: "one", scopeId: null }, { sessionId: "two", scopeId: null }], focus: { scopeId: null, sessionId: "one" } };
  expect(workbench.read()).toEqual(expected);
  // The migration persists the project shape once and stays idempotent.
  expect(Object.keys(ledger.setting<object>("workbench.state", {})).sort()).toEqual(["agents", "focus", "version"]);
  expect(new Workbench(ledger, sessions).read()).toEqual(expected);
});

test("the one-time migration maps spaces to projects, creating a Scope for an unmatched existing root", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ghost-workbench-migrate-")));
  roots.push(dir);
  mkdirSync(join(dir, "monorepo", "pkg"), { recursive: true });
  mkdirSync(join(dir, "twillroom"));
  mkdirSync(join(dir, "site", "docs"), { recursive: true });
  const { ledger, core } = harness(join(dir, "ledger.db"));
  ledgers.add(ledger);
  const linked = makeScope(ledger, "scope-linked", [join(dir, "monorepo")]);
  // A project that points at a repository's docs folder is the project of a space rooted at that repository.
  const docs = makeScope(ledger, "scope-docs", [join(dir, "site", "docs")]);
  ledger.putSetting("workbench.state", {
    version: 4,
    spaces: [
      { id: "s-linked", title: "모노레포 안", root: join(dir, "monorepo", "pkg"), createdAt: 1 },
      { id: "s-new", title: "Twillroom", root: join(dir, "twillroom"), createdAt: 2, lastSessionId: "two" },
      { id: "s-none", title: "루트 없음", root: null, createdAt: 3 },
      { id: "s-gone", title: "사라진 폴더", root: join(dir, "gone"), createdAt: 4 },
      { id: "s-site", title: "사이트", root: join(dir, "site"), createdAt: 5 },
    ],
    agents: [{ sessionId: "one", spaceId: "s-linked" }, { sessionId: "two", spaceId: "s-new" }, { sessionId: "three", spaceId: "s-none" }, { sessionId: "four", spaceId: "s-site" }],
    focus: { spaceId: "s-new", sessionId: "two" },
  });
  const sessions = { get: () => null, list: () => [] as CodingSession[] };
  const workbench = new Workbench(ledger, sessions, { createScope: ownerScopeCreator(core) });
  const state = workbench.read();
  const created = ledger.scopes().find(scope => scope.id !== linked.id && scope.id !== docs.id)!;
  expect(created).toMatchObject({ name: "Twillroom", ghostId: null, paths: [join(dir, "twillroom")], vaultPath: null, state: "active", attachments: [], limits: {} });
  expect(state.agents).toEqual([
    { sessionId: "one", scopeId: linked.id },
    { sessionId: "two", scopeId: created.id },
    { sessionId: "three", scopeId: null },
    { sessionId: "four", scopeId: docs.id },
  ]);
  expect(state.focus).toEqual({ scopeId: created.id, sessionId: "two" });
  // The Scope went through the owner's scope.create path: a configuration revision remembers it.
  expect(ledger.configRevisions("scope", created.id)).toHaveLength(1);
  // Reading again does not create another Scope or another revision.
  expect(new Workbench(ledger, sessions, { createScope: ownerScopeCreator(core) }).read()).toEqual(state);
  expect(ledger.scopes()).toHaveLength(3);
  expect(ledger.configRevisions("scope", created.id)).toHaveLength(1);
});

test("only the owner or an owner-equivalent paired device can arrange the workbench", async () => {
  const { workbench } = fixture();
  const path = "/api/workbench/agents";
  const request = () => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify({ version: 0, sessionId: "one", scopeId: null }) });
  await expect(serveWorkbench(workbench, { kind: "ghost" }, request(), path)).rejects.toMatchObject({ code: "forbidden" });
  expect(workbench.read().agents).toHaveLength(0);
  await expect(serveWorkbench(workbench, { kind: "device", deviceId: "test", name: "전화" }, request(), path)).resolves.toMatchObject({
    agents: [{ sessionId: "one", scopeId: null }],
  });
});
