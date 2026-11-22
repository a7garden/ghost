import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CodingSetup, HerdrFrame, HerdrOutput, HerdrPaneView, HerdrView, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { codingPrefs, Herdr, HerdrStartError, terminalText } from "../src/integrations/herdr.ts";
import { harness, tempDir } from "./support.ts";

const OWNER = "owner-herdr-token";

const snapshot = {
  id: "cli:api:snapshot",
  result: { snapshot: {
    workspaces: [
      { workspace_id: "w1", label: "ghost", number: 1, agent_status: "blocked" },
      { workspace_id: "w2", label: "fix", number: 2, agent_status: "idle", worktree: { checkout_path: "/wt/repo-fix", branch: "ghost/fix" } },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "로그인 고치기", number: 1, agent_status: "blocked" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "shell", number: 2, agent_status: "unknown" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "1", number: 1, agent_status: "idle" },
    ],
    panes: [
      { pane_id: "w1:pA", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "blocked", focused: true, cwd: "/work", foreground_cwd: "/work/tree", terminal_title_stripped: "x" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", agent: null, agent_status: "unknown", cwd: "/work" },
      // herdr leaves the key out of a pane that never had an agent.
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", agent_status: "unknown", cwd: "/work" },
      { pane_id: "w9:p1", workspace_id: "w2", tab_id: "w2:t1", agent: "omp", agent_status: "idle", cwd: "/work/new" },
      { pane_id: "w9:p5", workspace_id: "w2", tab_id: "w2:t1", agent_status: "unknown", cwd: "/work/new" },
      { pane_id: "w9:p6", workspace_id: "w2", tab_id: "w2:t1", agent_status: "unknown", cwd: "/work/new" },
    ],
  } },
};

const STATUS_RUNNING = "client:\n  version: 0.9.5\n\nserver:\n  status: running\n  version: 0.9.5\n  endpoint_compatible: yes\n  private_protocol: 22\n  private_protocol_compatible: yes\n\nupdate:\n  restart_needed: no\n  server_binary_stale: no\n";

/**
 * A stand-in `herdr`. It answers what the Host asks, fails the way herdr does (JSON error on stdout, exit 1) and
 * records every invocation, arguments separated by \x1f and invocations by \x1e, so a test can say exactly what the Host ran.
 */
function fakeHerdr(dir: string, extra: { status?: string; integrations?: string; configFails?: boolean; agentStart?: string } = {}) {
  const path = join(dir, "herdr");
  const log = join(dir, "argv.log");
  const created = (pane: string, checkout?: string) => JSON.stringify({ id: "x", result: { root_pane: { pane_id: pane }, workspace: checkout ? { worktree: { checkout_path: checkout } } : {} } });
  writeFileSync(join(dir, "status.txt"), extra.status ?? STATUS_RUNNING);
  writeFileSync(join(dir, "integrations.txt"), extra.integrations ?? "omp: current (v10) (/x)\nclaude: not installed (/y)\ncodex: current (v3) (/z)\n");
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot));
  writeFileSync(path, `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> '${log}'; printf '\\036' >> '${log}'
D='${dir}'
case "$*" in
  "--version") echo "herdr 0.9.5" ;;
  "config check") ${extra.configFails ? `echo "config.toml: keys.prefix is not a key" ; exit 1` : `echo "config: ok"`} ;;
  "session list --json") echo '{"sessions":[{"name":"default","running":true},{"name":"work","running":true},{"name":"old","running":false}]}' ;;
  "--session default status"|"--session work status") cat "$D/status.txt" ;;
  "integration status") cat "$D/integrations.txt" ;;
  "integration install claude") echo installed ;;
  "integration install codex") echo '{"error":{"code":"install_failed","message":"cannot write ~/.codex"}}'; exit 1 ;;
  "--session default api snapshot"|"--session work api snapshot") cat "$D/snapshot.json" ;;
  "--session default pane read w1:pA "*) printf '\\n\\n  working on it   \\n\\033[31mred\\n\\n' ;;
  "--session default pane read "*) echo '{"error":{"code":"pane_not_found","message":"gone"}}'; exit 1 ;;
  "--session default worktree create "*"--branch ghost/dup "*) if [ -e "$D/dup" ]; then echo '${created("w9:p1", "/wt/repo-dup-2")}'; else touch "$D/dup"; echo '{"error":{"code":"worktree_create_failed","message":"fatal: already exists"}}'; exit 1; fi ;;
  "--session default worktree create "*) echo '${created("w9:p1", "/wt/repo-fix")}' ;;
  "--session default workspace create "*) echo '${created("w9:p1")}' ;;
  "--session default agent start "*) ${extra.agentStart ?? "echo '{\"result\":{}}'"} ;;
  "--session default agent prompt w1:pA "*) echo '{"error":{"code":"agent_blocked","message":"agent w1:pA is waiting at a dialog"}}'; exit 1 ;;
  "--session default agent prompt "*) echo '{"result":{}}' ;;
  "--session default tab create "*) echo '${created("w9:p5")}' ;;
  "--session default pane split "*) echo '{"id":"x","result":{"pane":{"pane_id":"w9:p6"}}}' ;;
  "--session default workspace close w1") echo '{"error":{"code":"workspace_group_close_required","message":"close the linked worktree workspaces first"}}'; exit 1 ;;
  "--session default workspace rename "*|"--session default tab rename "*|"--session default pane rename "*|"--session default workspace close "*|"--session default tab close "*|"--session default pane close "*) echo '{"result":{}}' ;;
  "--session default pane send-keys w1:p2 nonsense") echo '{"error":{"code":"invalid_params","message":"unknown key nonsense"}}'; exit 1 ;;
  "--session default pane send-text "*|"--session default pane send-keys "*) echo '{"result":{}}' ;;
  "--session default terminal session observe w1:pA "*) printf '{"bytes":"aGk=","encoding":"ansi","full":true,"height":24,"seq":1,"type":"terminal.frame","width":80}\n{"bytes":"IQ==","encoding":"ansi","full":false,"height":24,"seq":2,"type":"terminal.frame","width":80}\n{"reason":"terminal attach ended: gone","type":"terminal.closed"}\n' ;;
  "--session default terminal session observe w1:p2 "*) printf '{"bytes":"aGk=","encoding":"ansi","full":true,"height":24,"seq":1,"type":"terminal.frame","width":80}\n' ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`);
  chmodSync(path, 0o755);
  return {
    path,
    runs: async () => (await Bun.file(log).text().catch(() => "")).split("\x1e").filter(Boolean).map((run) => run.split("\x1f").filter((arg, index, all) => index < all.length - 1 || arg !== "")),
  };
}

const gitRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("/usr/bin/git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
};

test("herdr shows the session as its sidebar does, and reads any pane's terminal as plain text", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    const herdr = new Herdr(fake.path);
    const view = await herdr.overview();
    expect(view).toMatchObject({ available: true, session: "default", note: null });
    expect(view.workspaces.map((workspace) => [workspace.id, workspace.label, workspace.status, workspace.worktree])).toEqual([
      ["w1", "ghost", "blocked", null],
      ["w2", "fix", "idle", { path: "/wt/repo-fix", branch: "ghost/fix" }],
    ]);
    expect(view.workspaces[0]!.tabs.map((tab) => [tab.id, tab.label, tab.panes.map((pane) => pane.id)])).toEqual([["w1:t1", "로그인 고치기", ["w1:pA"]], ["w1:t2", "shell", ["w1:p2", "w1:p3"]]]);
    expect(view.workspaces[0]!.tabs[0]!.panes[0]).toEqual({ id: "w1:pA", workspaceId: "w1", tabId: "w1:t1", workspace: "ghost", tab: "로그인 고치기", agent: "claude", status: "blocked", cwd: "/work/tree", title: "로그인 고치기", focused: true });
    // A plain shell is a pane too, with no agent.
    expect(view.workspaces[0]!.tabs[1]!.panes[0]).toMatchObject({ id: "w1:p2", agent: null, status: "unknown", focused: false, title: "work" });

    expect((await herdr.output("w1:pA")).text).toBe("  working on it\nred");
    expect((await herdr.output("w1:pA")).pane.status).toBe("blocked");
    await expect(herdr.output("w1:pZ")).rejects.toMatchObject({ code: "not_found" });
    await expect(herdr.output("w1:pA --raw")).rejects.toMatchObject({ code: "invalid" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the session in use is the owner's choice, herdr's default otherwise, and an absent server is a note rather than a failure", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    expect((await new Herdr(fake.path, { prefs: () => ({ session: "work", agent: null }) }).overview()).session).toBe("work");
    const runs = await fake.runs();
    expect(runs.some((run) => run.join(" ") === "--session work api snapshot")).toBe(true);
    const missing = await new Herdr(fake.path, { prefs: () => ({ session: "nope", agent: null }) }).overview();
    expect(missing).toMatchObject({ available: true, session: "nope", workspaces: [] });
    expect(missing.note).toContain("unexpected");
    expect(await new Herdr(null).overview()).toEqual({ available: false, session: "default", note: null, workspaces: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup reads what the connection depends on, and installs only the integration the owner asks for", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["omp", "claude"]) { writeFileSync(join(bin, name), "#!/bin/sh\n"); chmodSync(join(bin, name), 0o755); }
  try {
    const herdr = new Herdr(fake.path, { agentDirs: [bin] });
    const ready = await herdr.setup();
    expect(parse(CodingSetup, ready)).toMatchObject({
      herdr: { path: fake.path, version: "0.9.5" },
      config: { ok: true, note: null },
      session: "default",
      sessions: [{ name: "default", running: true }, { name: "work", running: true }, { name: "old", running: false }],
      server: { version: "0.9.5", compatible: true, restartNeeded: false },
      agents: [
        { id: "omp", path: join(bin, "omp"), integration: "current" },
        { id: "claude", path: join(bin, "claude"), integration: "missing" },
        { id: "codex", path: null, integration: "current" },
      ],
    });

    await herdr.installIntegration("claude");
    await expect(herdr.installIntegration("codex")).rejects.toThrow("cannot write ~/.codex");
    const runs = (await fake.runs()).map((run) => run.join(" "));
    expect(runs).toContain("integration install claude");
    // Nothing that starts, stops or reloads a server is ever run.
    expect(runs.some((run) => /\bserver\b|session attach/.test(run))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup tells a stopped server, an outdated server and a rejected config apart from a healthy one", async () => {
  const dir = tempDir();
  try {
    const [a, b] = [join(dir, "a"), join(dir, "b")];
    mkdirSync(a); mkdirSync(b);
    const stopped = fakeHerdr(a, { status: "client:\n  version: 0.9.5\n\nserver:\n  status: not running\n  socket: /x\n\nupdate:\n  restart_needed: no\n" });
    expect((await new Herdr(stopped.path).setup()).server).toBeNull();
    const stale = fakeHerdr(b, { status: STATUS_RUNNING.replace("restart_needed: no", "restart_needed: yes").replace("endpoint_compatible: yes", "endpoint_compatible: no"), integrations: "omp: v9 outdated (/x)\n", configFails: true });
    const setup = await new Herdr(stale.path).setup();
    expect(setup.server).toEqual({ version: "0.9.5", compatible: false, restartNeeded: true });
    expect(setup.config).toEqual({ ok: false, note: "config.toml: keys.prefix is not a key" });
    expect(setup.agents.find((agent) => agent.id === "omp")!.integration).toBe("outdated");
    const none = await new Herdr(null).setup();
    expect(none).toMatchObject({ herdr: { path: null, version: null }, server: null, sessions: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("starting an agent opens a worktree workspace in herdr, starts the agent there and prompts it", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["omp", "codex"]) { writeFileSync(join(bin, name), "#!/bin/sh\n"); chmodSync(join(bin, name), 0o755); }
  const repo = join(dir, "repo");
  gitRepo(repo);
  try {
    const herdr = new Herdr(fake.path, { agentDirs: [bin], prefs: () => ({ session: null, agent: "codex" }) });
    const started = await herdr.start({ repo, task: "Fix the login\nwith care", branch: "fix" });
    expect(started).toMatchObject({ checkout: "/wt/repo-fix", branch: "ghost/fix", settled: "unwaited", pane: { id: "w9:p1", agent: "omp" } });
    expect(started.base).toMatch(/^[0-9a-f]{40}$/);

    const runs = await fake.runs();
    const worktree = runs.find((run) => run.includes("worktree"))!;
    expect(worktree.slice(0, 4)).toEqual(["--session", "default", "worktree", "create"]);
    expect(worktree.slice(6)).toEqual(["--branch", "ghost/fix", "--no-focus"]);
    const start = runs.find((run) => run.includes("start"))!;
    expect(start.slice(0, 4)).toEqual(["--session", "default", "agent", "start"]);
    expect(start[4]).toMatch(/^ghost-fix-[0-9a-f]{4}$/);
    expect(start.slice(5, 9)).toEqual(["--kind", "codex", "--pane", "w9:p1"]);
    const prompt = runs.find((run) => run.includes("prompt"))!;
    expect(prompt.slice(0, 6)).toEqual(["--session", "default", "agent", "prompt", "w9:p1", prompt[5]!]);
    expect(prompt[5]).toContain("# Task\nFix the login\nwith care");
    expect(prompt[5]).toContain("git worktree on branch ghost/fix");
    expect(prompt).not.toContain("--wait");

    const waited = await herdr.start({ repo, task: "again", branch: "fix", agent: "omp" }, { timeoutMs: 60_000 });
    expect(waited.settled).toBe("settled");
    expect((await fake.runs()).filter((run) => run.includes("start")).at(-1)!.slice(5, 7)).toEqual(["--kind", "omp"]);
    expect((await fake.runs()).filter((run) => run.includes("prompt")).at(-1)!.slice(-3)).toEqual(["--wait", "--timeout", "60000"]);

    await expect(herdr.start({ repo, task: "x", agent: "claude" })).rejects.toMatchObject({ code: "invalid", message: "Claude Code is not installed on this Mac" });
    await expect(herdr.start({ repo: "relative/path", task: "x" })).rejects.toMatchObject({ code: "invalid" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch name that is taken gets the next free one; a directory that is not a repository opens a plain workspace", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "omp"), "#!/bin/sh\n");
  chmodSync(join(bin, "omp"), 0o755);
  const repo = join(dir, "repo");
  gitRepo(repo);
  const plain = join(dir, "plain");
  mkdirSync(plain);
  try {
    const herdr = new Herdr(fake.path, { agentDirs: [bin] });
    const retried = await herdr.start({ repo, task: "dup", branch: "dup" });
    expect(retried.branch).toBe("ghost/dup-2");

    const loose = await herdr.start({ repo: plain, task: "tidy" });
    expect(loose).toMatchObject({ branch: null, base: null });
    expect((await fake.runs()).some((run) => run.includes("workspace") && run.includes("create"))).toBe(true);
    // Not a repository: the agent is not told it is in a worktree.
    expect((await fake.runs()).filter((run) => run.includes("prompt")).at(-1)![5]).toContain("not a git worktree made for this task");

    const noWorktree = await herdr.start({ repo, task: "in place", worktree: false });
    expect(noWorktree.branch).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent that stops at startup is a start error that names the pane herdr opened", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir, { agentStart: `echo '{"error":{"code":"agent_not_ready","message":"claude is waiting at a login prompt"}}'; exit 1` });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "omp"), "#!/bin/sh\n");
  chmodSync(join(bin, "omp"), 0o755);
  const plain = join(dir, "plain");
  mkdirSync(plain);
  try {
    const error = await new Herdr(fake.path, { agentDirs: [bin] }).start({ repo: plain, task: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HerdrStartError);
    expect(error).toMatchObject({ pane: "w9:p1", message: "claude is waiting at a login prompt" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prompt reaches only an agent, and a blocked agent's refusal is the owner's to read", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    const herdr = new Herdr(fake.path);
    await expect(herdr.prompt("w1:pA", "go on")).rejects.toMatchObject({ code: "conflict", message: "agent w1:pA is waiting at a dialog" });
    const prompted = await herdr.prompt("w9:p1", "-x go on");
    expect(prompted.pane.id).toBe("w9:p1");
    // A word that starts like a flag would be read as one by herdr.
    expect((await fake.runs()).filter((run) => run.includes("prompt")).at(-1)).toEqual(["--session", "default", "agent", "prompt", "w9:p1", " -x go on"]);
    await expect(herdr.prompt("w1:p3", "x")).rejects.toMatchObject({ code: "invalid" });
    await expect(herdr.prompt("w1:pZ", "x")).rejects.toMatchObject({ code: "not_found" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the keyboard of a pane's terminal sends text exactly as typed, then named keys, to any pane", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    const herdr = new Herdr(fake.path);
    await herdr.input({ pane: "w1:p2", text: "ls -la\r\u001b[A\u0003\0", keys: ["enter", "shift+tab"] });
    const runs = (await fake.runs()).filter((run) => run.includes("send-text") || run.includes("send-keys"));
    expect(runs).toEqual([
      ["--session", "default", "pane", "send-text", "w1:p2", "ls -la\r\u001b[A\u0003"],
      ["--session", "default", "pane", "send-keys", "w1:p2", "enter", "shift+tab"],
    ]);
    await expect(herdr.input({ pane: "w1:p2" })).rejects.toMatchObject({ code: "invalid" });
    await expect(herdr.input({ pane: "w1:p2 x", text: "a" })).rejects.toMatchObject({ code: "invalid" });
    await expect(herdr.input({ pane: "w1:p2", keys: ["nonsense"] })).rejects.toMatchObject({ code: "invalid", message: "unknown key nonsense" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner creates workspaces, tabs, panes and agents in herdr, with an agent and a first instruction when asked", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const plain = join(dir, "plain");
  mkdirSync(plain);
  const repo = join(dir, "repo");
  gitRepo(repo);
  try {
    const herdr = new Herdr(fake.path);
    const bare = await herdr.createWorkspace({ cwd: plain, label: "ops" });
    expect(bare.id).toBe("w9:p1");
    let runs = (await fake.runs()).map((run) => run.slice(2));
    expect(runs.find((run) => run[0] === "workspace")).toEqual(["workspace", "create", "--cwd", realpathSync(plain), "--label", "ops", "--no-focus"]);
    expect(runs.some((run) => run[0] === "agent")).toBe(false);

    await herdr.createWorkspace({ cwd: plain, agent: "gemini", task: "look around" });
    runs = (await fake.runs()).map((run) => run.slice(2));
    expect(runs.filter((run) => run[0] === "agent" && run[1] === "start").at(-1)!.slice(3, 7)).toEqual(["--kind", "gemini", "--pane", "w9:p1"]);
    // Not a worktree: the instruction goes as the owner wrote it.
    expect(runs.filter((run) => run[1] === "prompt").at(-1)).toEqual(["agent", "prompt", "w9:p1", "look around"]);

    const made = await herdr.createWorkspace({ cwd: repo, worktree: true, branch: "spike", agent: "omp", task: "try it" });
    expect(made.id).toBe("w9:p1");
    runs = (await fake.runs()).map((run) => run.slice(2));
    expect(runs.find((run) => run[0] === "worktree")!.slice(4)).toEqual(["--branch", "ghost/spike", "--no-focus"]);
    expect(runs.filter((run) => run[1] === "prompt").at(-1)![3]).toContain("git worktree on branch ghost/spike");

    await expect(herdr.createWorkspace({ cwd: plain, task: "orphan" })).rejects.toMatchObject({ code: "invalid" });
    await expect(herdr.createWorkspace({ cwd: "relative" })).rejects.toMatchObject({ code: "invalid" });

    const tab = await herdr.createTab({ workspace: "w2", label: "logs", cwd: plain });
    expect(tab.id).toBe("w9:p5");
    expect((await fake.runs()).map((run) => run.slice(2)).find((run) => run[0] === "tab" && run[1] === "create")).toEqual(["tab", "create", "--workspace", "w2", "--cwd", realpathSync(plain), "--label", "logs", "--no-focus"]);
    await expect(herdr.createTab({ workspace: "w2 x" })).rejects.toMatchObject({ code: "invalid" });

    const split = await herdr.split({ pane: "w1:p2", direction: "down", agent: "claude" });
    expect(split.id).toBe("w9:p6");
    runs = (await fake.runs()).map((run) => run.slice(2));
    expect(runs.find((run) => run[0] === "pane" && run[1] === "split")).toEqual(["pane", "split", "w1:p2", "--direction", "down", "--no-focus"]);
    expect(runs.filter((run) => run[1] === "start").at(-1)!.slice(3, 7)).toEqual(["--kind", "claude", "--pane", "w9:p6"]);

    expect((await herdr.startAgent({ pane: "w1:p2", agent: "codex" })).id).toBe("w1:p2");
    await expect(herdr.startAgent({ pane: "w1:pA", agent: "codex" })).rejects.toMatchObject({ code: "invalid" });
    await expect(herdr.split({ pane: "w1:pZ", direction: "right" })).rejects.toMatchObject({ code: "not_found" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renaming and closing pass herdr's own words through, including a refusal", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    const herdr = new Herdr(fake.path);
    await herdr.rename({ target: "workspace", id: "w2", label: "새 이름" });
    await herdr.rename({ target: "tab", id: "w2:t1", label: "logs" });
    await herdr.rename({ target: "pane", id: "w1:p2", label: "server" });
    await herdr.close({ target: "tab", id: "w1:t2" });
    await herdr.close({ target: "pane", id: "w1:p3" });
    await herdr.close({ target: "workspace", id: "w2" });
    expect((await fake.runs()).map((run) => run.slice(2).join(" "))).toEqual(["workspace rename w2 새 이름", "tab rename w2:t1 logs", "pane rename w1:p2 server", "tab close w1:t2", "pane close w1:p3", "workspace close w2"]);
    await expect(herdr.close({ target: "workspace", id: "w1" })).rejects.toMatchObject({ message: "close the linked worktree workspaces first" });
    await expect(herdr.rename({ target: "tab", id: "w2", label: "x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(herdr.rename({ target: "workspace", id: "w2", label: "-rf" })).rejects.toMatchObject({ code: "invalid" });
    await expect(herdr.close({ target: "pane", id: "w2" })).rejects.toMatchObject({ code: "invalid" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pane's live terminal arrives as frames at the size asked for, and a pane that is not there is refused", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    const herdr = new Herdr(fake.path);
    const abort = new AbortController();
    const frames: { seq: number; full: boolean; text: string }[] = [];
    for await (const frame of await herdr.terminal("w1:pA", 100, 30, abort.signal)) frames.push({ seq: frame.seq, full: frame.full, text: Buffer.from(frame.bytes, "base64").toString() });
    expect(frames).toEqual([{ seq: 1, full: true, text: "hi" }, { seq: 2, full: false, text: "!" }]);
    const run = (await fake.runs()).find((entry) => entry.includes("observe"))!;
    expect(run.slice(2)).toEqual(["terminal", "session", "observe", "w1:pA", "--cols", "100", "--rows", "30"]);
    // A size outside what a terminal can be is brought into range, not passed on.
    for await (const _ of await herdr.terminal("w1:pA", 5, 999, abort.signal)) break;
    expect((await fake.runs()).filter((entry) => entry.includes("observe")).at(-1)!.slice(-4)).toEqual(["--cols", "20", "--rows", "120"]);
    // A stream that ends without herdr saying the pane closed is not the pane's end: the viewer is told to try again.
    const dropped = await herdr.terminal("w1:p2", 80, 24, abort.signal);
    await expect((async () => { for await (const _ of dropped) { /* frames */ } })()).rejects.toMatchObject({ code: "unavailable", message: "the terminal stream stopped" });
    await expect(herdr.terminal("w1:pZ", 80, 24, abort.signal)).rejects.toMatchObject({ code: "not_found" });
    await expect(herdr.terminal("nope", 80, 24, abort.signal)).rejects.toMatchObject({ code: "invalid" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal text keeps the end, drops control bytes and trailing blanks", () => {
  expect(terminalText("\n\na  \n\u001b[0mb\u001b]0;title\u0007c\n\n")).toBe("a\nbc");
  const long = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  const kept = terminalText(long).split("\n");
  expect(kept).toHaveLength(300);
  expect(kept.at(-1)).toBe("line 499");
});

test("a choice saved before coding became herdr keeps its default agent and drops the rest", () => {
  expect(codingPrefs({ default: "claude", disabled: ["omp"] })).toEqual({ session: null, agent: "claude" });
  expect(codingPrefs({ session: "work", agent: "codex" })).toEqual({ session: "work", agent: "codex" });
  expect(codingPrefs({ session: "../x", agent: "vim" })).toEqual({ session: null, agent: null });
  expect(codingPrefs(null)).toEqual({ session: null, agent: null });
});

test("the herdr routes need the owner token and answer with the contract's shapes", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "omp"), "#!/bin/sh\n");
  chmodSync(join(bin, "omp"), 0o755);
  const plain = join(dir, "plain");
  mkdirSync(plain);
  const h = harness(":memory:");
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null, herdr: new Herdr(fake.path, { agentDirs: [bin] }) });
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  const post = (path: string, body: unknown, token = OWNER) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const path of ["/api/coding", "/api/herdr", "/api/herdr/output?pane=w1%3ApA"]) expect((await get(path)).status).toBe(401);
    expect((await post("/api/herdr/prompt", { pane: "w9:p1", text: "x" }, "wrong")).status).toBe(401);

    expect(parse(CodingSetup, await (await get("/api/coding", OWNER)).json()).herdr.version).toBe("0.9.5");
    expect(parse(HerdrView, await (await get("/api/herdr", OWNER)).json()).workspaces).toHaveLength(2);
    expect(parse(HerdrOutput, await (await get("/api/herdr/output?pane=w1%3ApA", OWNER)).json()).text).toBe("  working on it\nred");
    expect((await get("/api/herdr/output?pane=w1%3ApZ", OWNER)).status).toBe(404);
    expect((await get("/api/herdr/output?pane=nope", OWNER)).status).toBe(400);

    expect(parse(HerdrPaneView, await (await post("/api/herdr/start", { repo: plain, task: "tidy" })).json()).id).toBe("w9:p1");
    expect((await post("/api/herdr/start", { repo: plain })).status).toBe(400);
    expect(parse(HerdrPaneView, await (await post("/api/herdr/workspaces", { cwd: plain, label: "ops" })).json()).id).toBe("w9:p1");
    expect((await post("/api/herdr/workspaces", { cwd: plain, task: "x" })).status).toBe(400);
    expect(parse(HerdrPaneView, await (await post("/api/herdr/tabs", { workspace: "w2" })).json()).id).toBe("w9:p5");
    expect(parse(HerdrPaneView, await (await post("/api/herdr/split", { pane: "w1:p2", direction: "right" })).json()).id).toBe("w9:p6");
    expect((await post("/api/herdr/split", { pane: "w1:p2", direction: "left" })).status).toBe(400);
    expect(parse(HerdrPaneView, await (await post("/api/herdr/agents", { pane: "w1:p2", agent: "codex" })).json()).id).toBe("w1:p2");
    expect((await post("/api/herdr/agents", { pane: "w1:p2", agent: "vim" })).status).toBe(400);
    expect((await post("/api/herdr/rename", { target: "tab", id: "w2:t1", label: "logs" })).status).toBe(200);
    expect((await post("/api/herdr/close", { target: "pane", id: "w1:p3" })).status).toBe(200);
    expect((await post("/api/herdr/close", { target: "workspace", id: "w1" })).status).toBe(503);
    expect((await post("/api/herdr/prompt", { pane: "w1:pA", text: "x" })).status).toBe(409);
    expect((await post("/api/herdr/prompt", { pane: "w9:p1", text: "keep going" })).status).toBe(200);
    expect((await post("/api/herdr/input", { pane: "w1:pA", text: "\r", keys: ["enter"] })).status).toBe(200);
    expect((await post("/api/herdr/input", { pane: "w1:pA", keys: ["rm -rf"] })).status).toBe(400);
    expect((await post("/api/herdr/input", { pane: "w1:pA" }, "wrong")).status).toBe(401);
    expect((await post("/api/herdr/nothing", {})).status).toBe(404);

    const live = await get("/api/herdr/terminal?pane=w1%3ApA&cols=100&rows=30", OWNER);
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toBe("text/event-stream");
    const events = (await live.text()).split("\n\n").filter((entry) => entry.startsWith("event:"));
    expect(events.map((entry) => entry.split("\n")[0])).toEqual(["event: frame", "event: frame", "event: end"]);
    expect(parse(HerdrFrame, JSON.parse(events[0]!.split("\n")[1]!.slice("data: ".length))).full).toBe(true);
    expect((await get("/api/herdr/terminal?pane=w1%3ApZ", OWNER)).status).toBe(404);
    expect((await get("/api/herdr/terminal?pane=w1%3ApA")).status).toBe(401);
    expect(parse(CodingSetup, await (await post("/api/coding/integrations", { agent: "claude" })).json()).agents).toHaveLength(3);
    expect((await post("/api/coding/integrations", { agent: "codex" })).status).toBe(503);
    expect((await post("/api/coding/integrations", { agent: "vim" })).status).toBe(400);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("a Host without the herdr port says so", async () => {
  const h = harness(":memory:");
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null });
  try {
    for (const path of ["/api/herdr", "/api/coding"]) expect((await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${OWNER}` } })).status).toBe(503);
  } finally {
    await server.stop();
    rmSync(config.root, { recursive: true, force: true });
  }
});
