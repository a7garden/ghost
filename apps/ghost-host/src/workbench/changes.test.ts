import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../ledger/ledger.ts";
import { serveWorkbench } from "./http.ts";
import { Workbench } from "./service.ts";

const owners = { kind: "device", deviceId: "test", name: "전화" } as const;
const spacesPath = "/api/workbench/spaces";
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
  const workbench = new Workbench(ledger, null, null, stateRoot);
  const request = (path: string, method = "GET", body?: object) => serveWorkbench(workbench, owners, new Request(`http://localhost${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
  }), path.split("?")[0]!);
  return { repo, workbench, request };
}

test("creates an isolated space checkout and leaves its branch and files on disk after deletion", async () => {
  const { repo, workbench, request } = fixture(true);
  writeFileSync(join(repo, "tracked.txt"), "uncommitted change in original\n");
  const post = (version: number) => request(spacesPath, "POST", { title: "Topic", root: repo, version, worktree: { branch: "workbench/topic" } });
  await post(0);
  const state = workbench.read(), space = state.spaces[0]!;
  expect(space.worktree).toEqual({ repo, branch: "workbench/topic" });
  const checkout = space.root!;
  expect(checkout).not.toBe(repo);
  expect(git(checkout, "branch", "--show-current")).toBe("workbench/topic");
  expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");

  await expect(post(state.version)).rejects.toMatchObject({ code: "invalid" });
  expect(workbench.read()).toEqual(state);
  writeFileSync(join(checkout, "tracked.txt"), "kept after deletion\n");
  await request(`${spacesPath}/${space.id}`, "DELETE", { version: state.version });
  expect(workbench.read().spaces).toEqual([]);
  expect(git(repo, "rev-parse", "refs/heads/workbench/topic")).toBe(git(repo, "rev-parse", "HEAD"));
  expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("kept after deletion\n");
});

test("rejects worktree creation and Git changes for a non-Git directory", async () => {
  const { repo, workbench, request } = fixture(false);
  await expect(request(spacesPath, "POST", { title: "Folder", root: repo, version: 0, worktree: { branch: "topic" } }))
    .rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("Git 저장소") });
  expect(workbench.read().version).toBe(0);
  const space = workbench.createSpace({ title: "Folder", root: repo, version: 0 }).spaces[0]!;
  await expect(request(`${spacesPath}/${space.id}/changes`))
    .rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("Git 저장소가 아닙니다") });
});

test("space changes exposes bounded index and working-tree diffs only for literal changed paths", async () => {
  const { repo, workbench, request } = fixture(true);
  const space = workbench.createSpace({ title: "Source", root: repo, version: 0 }).spaces[0]!;
  const path = `${spacesPath}/${space.id}/changes`;
  const get = (file: string) => request(`${path}?${new URLSearchParams({ path: file })}`);
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
  const { repo, workbench, request } = fixture(true);
  writeFileSync(join(repo, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(repo, "config", "filter.fixture.clean", "/usr/bin/false");
  git(repo, "config", "filter.fixture.process", "/usr/bin/false");
  git(repo, "config", "filter.fixture.required", "true");
  writeFileSync(join(repo, "tracked.txt"), "original\nchanged without filter\n");
  const space = workbench.createSpace({ title: "Source", root: repo, version: 0 }).spaces[0]!;
  const path = `${spacesPath}/${space.id}/changes`;
  await expect(request(path)).resolves.toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" })]) });
  await expect(request(`${path}?path=tracked.txt`)).resolves.toMatchObject({ unstaged: expect.stringContaining("+changed without filter") });
});
