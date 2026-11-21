import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingSessionDetail } from "@ghost/contract";
import { CodingAgents } from "../src/integrations/coding-agents.ts";

/** An `omp` that speaks its JSON event stream: a session id, then what it was asked to resume, and it waits when told to. */
const FAKE_OMP = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "omp/9.9"; exit 0; fi
resume=""; prev=""
for arg in "$@"; do if [ "$prev" = "--resume" ]; then resume="$arg"; fi; prev="$arg"; done
echo '{"type":"session","id":"native-1"}'
echo "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"resume=$resume cwd=$PWD\\"}]}}"
case "\${@: -1}" in *wait*) sleep 30;; esac
case "\${@: -1}" in *fail*) echo "boom" >&2; exit 3;; esac
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ghost-runner-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "omp"), FAKE_OMP);
  chmodSync(join(bin, "omp"), 0o755);
  const agents = new CodingAgents(join(root, "sessions"), { dirs: [bin] });
  return { root, agents };
}

async function settled(agents: CodingAgents, id: string): Promise<CodingSessionDetail> {
  await agents.run.settled(id);
  return agents.sessions.get(id)!;
}

const texts = (detail: CodingSessionDetail) => detail.steps.map((step) => `${step.kind}: ${step.text}`);

test("the owner starts a session, sends a follow-up that resumes the same conversation, and the transcript keeps both turns", async () => {
  const { root, agents } = fixture();
  try {
    const dir = join(root, "plain");
    mkdirSync(dir);
    const started = await agents.run.start({ repo: dir, task: "first thing" });
    expect(started.session).toMatchObject({ agent: "omp", workId: null, state: "running" });
    const first = await settled(agents, started.session.id);
    expect(first.session).toMatchObject({ state: "done", nativeId: "native-1", branch: null });
    expect(texts(first)).toEqual(["user: first thing", expect.stringMatching(/^say: resume= cwd=.*plain$/)]);

    const second = await agents.run.send(started.session.id, "and then this");
    expect(second.session.state).toBe("running");
    const done = await settled(agents, started.session.id);
    expect(done.session.state).toBe("done");
    expect(texts(done).slice(2)).toEqual(["user: and then this", expect.stringMatching(/^say: resume=native-1 cwd=.*plain$/)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("in a git repository the session works in its own branch worktree and the checkout stays untouched", async () => {
  const { root, agents } = fixture();
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["/usr/bin/git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const started = await agents.run.start({ repo, task: "fix the login", branch: "fix-login" });
    const detail = await settled(agents, started.session.id);
    expect(detail.session.branch).toBe("ghost/fix-login");
    expect(detail.session.cwd).toBe(join(realpathSync(root), "wt", "repo-fix-login"));
    expect(existsSync(detail.session.cwd)).toBe(true);
    expect(texts(detail)[1]).toContain(`cwd=${detail.session.cwd}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running session refuses another message, and stopping it ends it as a stop rather than a failure of the agent", async () => {
  const { root, agents } = fixture();
  try {
    const dir = join(root, "plain");
    mkdirSync(dir);
    const started = await agents.run.start({ repo: dir, task: "wait here" });
    await expect(agents.run.send(started.session.id, "hurry")).rejects.toThrow("still working");
    agents.run.stop(started.session.id);
    const detail = await settled(agents, started.session.id);
    expect(detail.session).toMatchObject({ state: "failed", exitCode: 130 });
    expect(texts(detail).at(-1)).toBe("note: 중지했습니다.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent that exits non-zero is a failed session whose error output the owner can read", async () => {
  const { root, agents } = fixture();
  try {
    const dir = join(root, "plain");
    mkdirSync(dir);
    const started = await agents.run.start({ repo: dir, task: "please fail" });
    const detail = await settled(agents, started.session.id);
    expect(detail.session).toMatchObject({ state: "failed", exitCode: 3 });
    expect(texts(detail).at(-1)).toContain("boom");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run a Ghost started cannot be stopped from here, and nothing about it changes", async () => {
  const { root, agents } = fixture();
  try {
    const ghostRun = agents.sessions.open({ agent: "omp", workId: "w1", callId: "c1", task: "ghost task", cwd: root, branch: null, base: null });
    expect(() => agents.run.stop(ghostRun.id)).toThrow("cancel the Work");
    ghostRun.end(0);
    expect(agents.run.stop(ghostRun.id).session.state).toBe("done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that does not exist, a session that does not exist and a fifth concurrent run are refused", async () => {
  const { root, agents } = fixture();
  try {
    await expect(agents.run.start({ repo: join(root, "missing"), task: "x" })).rejects.toThrow("not an absolute path of an existing directory");
    await expect(agents.run.start({ repo: "relative", task: "x" })).rejects.toThrow("not an absolute path");
    await expect(agents.run.send("0".repeat(32), "x")).rejects.toThrow("coding session");
    const dir = join(root, "plain");
    mkdirSync(dir);
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) ids.push((await agents.run.start({ repo: dir, task: "wait" })).session.id);
    await expect(agents.run.start({ repo: dir, task: "wait" })).rejects.toThrow("already working");
    agents.run.stopAll();
    for (const id of ids) await settled(agents, id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
