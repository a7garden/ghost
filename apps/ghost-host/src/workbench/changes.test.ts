import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingSession, Scope } from "@ghost/contract";
import { Ledger } from "../ledger/ledger.ts";
import { serveWorkbench } from "./http.ts";
import { Workbench } from "./service.ts";

const owners = { kind: "device", deviceId: "test", name: "전화" } as const;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function git(cwd: string, ...args: string[]) {
  const child = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!child.success) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}

function fixture(withGit: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ghost-workbench-changes-")));
  const stateRoot = join(root, "state"), repo = join(root, "source");
  mkdirSync(stateRoot); mkdirSync(repo);
  const ledger = new Ledger(join(stateRoot, "ledger.db"));
  cleanups.push(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  if (withGit) {
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "tracked.txt"), "original\n");
    git(repo, "add", "--", "tracked.txt");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "initial");
  }
  const session = (id: string, cwd: string): CodingSession => ({
    id, title: id, cwd, repo: null, branch: null, base: null, workId: null, ghostId: null, turn: 0,
    model: { provider: "test", model: "test" }, state: "idle", thinking: "off", pendingDialog: null,
    usage: { input: 0, output: 0, cost: 0 }, createdAt: 0, updatedAt: 0,
  });
  const known = new Map([["one", session("one", repo)]]);
  const sessions = { get: (id: string) => known.get(id) ?? null, list: () => [...known.values()] };
  const workbench = new Workbench(ledger, sessions);
  const changesPath = (folder: string, file?: string) => `/api/workbench/changes?${new URLSearchParams({ root: folder, ...(file ? { path: file } : {}) })}`;
  const request = (path: string, method = "GET", body?: object) => serveWorkbench(workbench, owners, new Request(`http://localhost${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
  }), path.split("?")[0]!);
  return { root, repo, ledger, session, sessions, known, workbench, changesPath, request };
}

function makeScope(ledger: Ledger, id: string, paths: string[]): Scope {
  const scope: Scope = { id, name: id, ghostId: null, paths, vaultPath: null, state: "active", attachments: [], limits: {}, createdAt: 1, updatedAt: 1 };
  ledger.tx(() => ledger.putScope(scope));
  return scope;
}

test("changes reads only a project folder or a coding session's working folder", async () => {
  const { root, repo, ledger, session, known, request, changesPath } = fixture(true);
  makeScope(ledger, "scope-src", [repo]);
  mkdirSync(join(repo, "sub"));
  await expect(request(changesPath(repo))).resolves.toEqual({ branch: "main", files: [], truncated: false });
  await expect(request(changesPath(join(repo, "sub")))).resolves.toEqual({ branch: "main", files: [], truncated: false });
  // A coding session's own working folder is readable even when no project covers it.
  const plain = join(root, "plain");
  mkdirSync(plain);
  git(plain, "init", "-b", "main");
  known.set("plain", session("plain", plain));
  await expect(request(changesPath(plain))).resolves.toEqual({ branch: "main", files: [], truncated: false });
  await expect(request("/api/workbench/changes")).rejects.toMatchObject({ code: "invalid" });
  await expect(request(changesPath("relative/path"))).rejects.toMatchObject({ code: "invalid" });
  await expect(request(changesPath(join(root, "elsewhere")))).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("코딩 세션 작업 폴더") });
  await expect(serveWorkbench(new Workbench(ledger, null), owners, new Request(`http://localhost${changesPath(repo)}`), "/api/workbench/changes")).resolves.toMatchObject({ branch: "main" });
});

test("rejects changes for a non-Git directory", async () => {
  const { repo, ledger, request, changesPath } = fixture(false);
  makeScope(ledger, "scope-plain", [repo]);
  await expect(request(changesPath(repo))).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("Git 저장소가 아닙니다") });
});

test("changes exposes bounded index and working-tree diffs only for literal changed paths", async () => {
  const { repo, ledger, workbench, request, changesPath } = fixture(true);
  makeScope(ledger, "scope-src", [repo]);
  const path = changesPath(repo);
  const get = (file: string) => request(changesPath(repo, file));
  await expect(request(path)).resolves.toEqual({ branch: "main", files: [], truncated: false });

  writeFileSync(join(repo, "tracked.txt"), "original\nstaged\n");
  git(repo, "add", "--", "tracked.txt");
  writeFileSync(join(repo, "tracked.txt"), "original\nstaged\nunstaged\n");
  const untracked = "-new[1]\tfile.txt";
  writeFileSync(join(repo, untracked), "new content\n");
  await expect(request(path)).resolves.toEqual({
    branch: "main", truncated: false, files: [
      { path: "tracked.txt", xy: "MM", status: "modified", additions: 2, deletions: 0 },
      { path: untracked, xy: "??", status: "untracked", additions: null, deletions: null },
    ],
  });
  await expect(get("tracked.txt")).resolves.toMatchObject({
    path: "tracked.txt", staged: expect.stringContaining("+staged"), unstaged: expect.stringContaining("+unstaged"), truncated: false,
  });
  await expect(get(untracked)).resolves.toMatchObject({ path: untracked, unstaged: expect.stringContaining("+new content"), staged: "" });
  await expect(get("*.txt")).rejects.toMatchObject({ code: "not_found" });
  await expect(get("../ledger.db")).rejects.toMatchObject({ code: "invalid" });
  await expect(serveWorkbench(workbench, { kind: "ghost" }, new Request(`http://localhost${path}`), path)).rejects.toMatchObject({ code: "forbidden" });

  writeFileSync(join(repo, "tracked.txt"), "x".repeat(50_000));
  const diff = await get("tracked.txt");
  expect(diff).toMatchObject({ truncated: true });
  expect("unstaged" in diff && Buffer.byteLength(diff.unstaged)).toBe(40_000);
  expect(git(repo, "diff", "--cached", "--", "tracked.txt")).toContain("+staged");
});

test("reads changes without running the checkout's content filters", async () => {
  const { repo, ledger, request, changesPath } = fixture(true);
  writeFileSync(join(repo, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(repo, "config", "filter.fixture.clean", "/usr/bin/false");
  git(repo, "config", "filter.fixture.process", "/usr/bin/false");
  git(repo, "config", "filter.fixture.required", "true");
  writeFileSync(join(repo, "tracked.txt"), "original\nchanged without filter\n");
  makeScope(ledger, "scope-src", [repo]);
  await expect(request(changesPath(repo))).resolves.toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" })]) });
  await expect(request(changesPath(repo, "tracked.txt"))).resolves.toMatchObject({ unstaged: expect.stringContaining("+changed without filter") });
});

