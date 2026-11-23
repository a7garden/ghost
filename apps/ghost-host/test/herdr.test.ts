import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CodingSetup, HerdrChanges, HerdrFrame, HerdrOutput, HerdrPaneView, HerdrUpload, HerdrView, OmpInfo, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { ansiText, codingPrefs, gitReport, Herdr, HerdrStartError, mergeFrames, terminalText } from "../src/integrations/herdr.ts";
import { OmpInfoProvider } from "../src/integrations/omp.ts";
import { CodingWatcher } from "../src/integrations/coding-watch.ts";
import { saveUpload, safeUploadName } from "../src/integrations/uploads.ts";
import type { HerdrPort } from "../src/integrations/ports.ts";
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
  "--session default api snapshot"|"--session work api snapshot") cat "$D/snapshot.json"; if [ -e "$D/next-snapshot.json" ]; then mv "$D/next-snapshot.json" "$D/snapshot.json"; fi ;;
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
  "--session default pane send-text "*|"--session default pane send-keys "*|"--session default agent send-keys "*) echo '{"result":{}}' ;;
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
    expect(view.workspaces[0]!.tabs[0]!.panes[0]).toEqual({ id: "w1:pA", workspaceId: "w1", tabId: "w1:t1", workspace: "ghost", tab: "로그인 고치기", agent: "claude", status: "blocked", cwd: "/work/tree", title: "로그인 고치기", focused: true, owned: false });
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
    expect((await new Herdr(fake.path, { prefs: () => ({ session: "work", agent: null, notify: "blocked" }) }).overview()).session).toBe("work");
    const runs = await fake.runs();
    expect(runs.some((run) => run.join(" ") === "--session work api snapshot")).toBe(true);
    const missing = await new Herdr(fake.path, { prefs: () => ({ session: "nope", agent: null, notify: "blocked" }) }).overview();
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
    const herdr = new Herdr(fake.path, { agentDirs: [bin], prefs: () => ({ session: null, agent: "codex", notify: "blocked" }) });
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

test("omp /model with a selector uses the session-only /switch command; bare /model and Claude are unchanged", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const pane = "w9:p1";
  const herdr = new Herdr(fake.path);
  const view = structuredClone(snapshot);
  const target = view.result.snapshot.panes.find(p => p.pane_id === pane)!;
  try {
    for (const [agent, status, text, delivery, sent] of [
      ["omp", "idle", "/model anthropic/claude-opus-5-5:high", undefined, "/switch anthropic/claude-opus-5-5:high"],
      ["omp", "working", "/models @smol", "queue", "/switch @smol"],
      ["omp", "idle", "/model", undefined, "/model"],
      ["omp", "idle", "/model  ", undefined, "/model  "],
      ["omp", "idle", "/modelpreset switch", undefined, "/modelpreset switch"],
      ["omp", "idle", "/model options\nExplain these settings", undefined, "/model options\nExplain these settings"],
      ["claude", "idle", "/model haiku", undefined, "/model haiku"],
    ] as const) {
      target.agent = agent;
      target.agent_status = status;
      writeFileSync(join(dir, "snapshot.json"), JSON.stringify(view));
      const previous = (await fake.runs()).length;
      await herdr.prompt(pane, text, undefined, undefined, delivery);
      expect((await fake.runs()).slice(previous).filter(run => run[2] !== "api")).toEqual([
        ["--session", "default", "agent", "prompt", pane, sent],
      ]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only a working omp receives a queued prompt as one multiline paste with the follow-up chord", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const h = harness();
  const config: Config = { root: dir, host: "127.0.0.1", port: 0, publicOrigin: null, uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null, herdr: new Herdr(fake.path) });
  const pane = "w9:p1";
  const text = "계속해\n두 번째 줄";
  const request = (delivery?: "steer" | "queue") => fetch(`http://127.0.0.1:${server.port}/api/herdr/prompt`, {
    method: "POST", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" }, body: JSON.stringify({ pane, text, delivery }),
  });
  try {
    for (const [agent, status, delivery, queued] of [
      ["omp", "working", "queue", true],
      ["omp", "working", "steer", false],
      ["omp", "working", undefined, false],
      ["omp", "idle", "queue", false],
      ["omp", "done", "queue", false],
      ["claude", "working", "queue", false],
    ] as const) {
      const view = structuredClone(snapshot);
      const target = view.result.snapshot.panes.find(p => p.pane_id === pane)!;
      target.agent = agent;
      target.agent_status = status;
      writeFileSync(join(dir, "snapshot.json"), JSON.stringify(view));
      const previous = (await fake.runs()).length;
      const response = await request(delivery);
      expect(response.status).toBe(200);
      expect(parse(HerdrPaneView, await response.json()).id).toBe(pane);
      const writes = (await fake.runs()).slice(previous).filter(run => run[2] !== "api");
      expect(writes).toEqual(queued
        ? [["--session", "default", "pane", "send-text", pane, `\x1b[200~${text}\x1b[201~\x11`]]
        : [["--session", "default", "agent", "prompt", pane, text]]);
    }
    const working = structuredClone(snapshot);
    const target = working.result.snapshot.panes.find(p => p.pane_id === pane)!;
    target.agent_status = "working";
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify(working));
    target.agent_status = "blocked";
    writeFileSync(join(dir, "next-snapshot.json"), JSON.stringify(working));
    const previous = (await fake.runs()).length;
    expect((await request("queue")).status).toBe(200);
    expect((await fake.runs()).slice(previous).filter(run => run[2] !== "api")).toEqual([
      ["--session", "default", "agent", "prompt", pane, text],
    ]);
  } finally {
    await server.stop();
    h.ledger.close();
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
  expect(codingPrefs({ default: "claude", disabled: ["omp"] })).toEqual({ session: null, agent: "claude", notify: "blocked" });
  expect(codingPrefs({ session: "work", agent: "codex", notify: "all" })).toEqual({ session: "work", agent: "codex", notify: "all" });
  expect(codingPrefs({ session: "../x", agent: "vim", notify: "sometimes" })).toEqual({ session: null, agent: null, notify: "blocked" });
  expect(codingPrefs(null)).toEqual({ session: null, agent: null, notify: "blocked" });
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
    // The two frames the fake sends arrive together, so they leave as one: still a repaint, with both writes in order.
    expect(events.map((entry) => entry.split("\n")[0])).toEqual(["event: frame", "event: end"]);
    const first = parse(HerdrFrame, JSON.parse(events[0]!.split("\n")[1]!.slice("data: ".length)));
    expect(first).toMatchObject({ full: true, seq: 2 });
    expect(Buffer.from(first.bytes, "base64").toString()).toBe("hi!");
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

test("an agent's own arguments go after `--`, and only to an agent", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const plain = join(dir, "plain");
  mkdirSync(plain);
  try {
    const herdr = new Herdr(fake.path);
    await herdr.createWorkspace({ cwd: plain, agent: "omp", args: ["--resume", "01a2", "--model", "anthropic/claude x", "--thinking", "high"] });
    const start = (await fake.runs()).filter((run) => run.includes("start")).at(-1)!;
    expect(start.slice(start.indexOf("--timeout") + 2)).toEqual(["--", "--resume", "01a2", "--model", "anthropic/claude x", "--thinking", "high"]);
    await herdr.createWorkspace({ cwd: plain, agent: "omp" });
    expect((await fake.runs()).filter((run) => run.includes("start")).at(-1)).not.toContain("--");
    await expect(herdr.createWorkspace({ cwd: plain, args: ["--continue"] })).rejects.toMatchObject({ code: "invalid" });
    await herdr.startAgent({ pane: "w1:p2", agent: "claude", args: ["--continue"] });
    expect((await fake.runs()).filter((run) => run.includes("start")).at(-1)!.slice(-2)).toEqual(["--", "--continue"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the history view keeps the colours and reaches back as far as asked, within limits", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    const herdr = new Herdr(fake.path);
    const history = await herdr.output("w1:pA", { ansi: true, lines: 99_999 });
    expect(history.text).toBe("  working on it\n\u001b[31mred");
    const run = (await fake.runs()).filter((entry) => entry.includes("read")).at(-1)!;
    expect(run.slice(-4)).toEqual(["--lines", "2000", "--format", "ansi"]);
    expect((await herdr.output("w1:pA", { lines: 5 })).text).toBe("working on it\nred".replace("working", "  working"));
    expect((await fake.runs()).filter((entry) => entry.includes("read")).at(-1)!.slice(-2)).toEqual(["--lines", "5"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ansiText keeps colours and drops every other escape sequence", () => {
  expect(ansiText("\u001b[2J\u001b[1;1H\u001b[1;31mred\u001b[0m  \n\u001b]8;;http://x\u0007link\u001b]8;;\u0007\u001b[?25l\u001b[38;2;1;2;3mtrue\u001b[m\u0007\n\n", 10, 1000)).toBe("\u001b[1;31mred\u001b[0m\nlink\u001b[38;2;1;2;3mtrue\u001b[m");
  expect(ansiText(["a", "b", "c", "d"].join("\n"), 2, 1000)).toBe("c\nd");
  // Cut by size, it starts at a line and never inside a sequence.
  const cut = ansiText(Array.from({ length: 50 }, (_, index) => `\u001b[32mline ${index}\u001b[0m`).join("\n"), 100, 200);
  expect(cut.startsWith("\u001b[32mline ")).toBe(true);
  expect(cut.length).toBeLessThanOrEqual(200);
});

test("frames that arrive together are one write, and a full repaint replaces what came before it", () => {
  const frame = (seq: number, text: string, full = false, width = 80): { seq: number; full: boolean; width: number; height: number; bytes: string } => ({ seq, full, width, height: 24, bytes: Buffer.from(text).toString("base64") });
  const text = (value: { bytes: string }) => Buffer.from(value.bytes, "base64").toString();
  let pending = mergeFrames(null, frame(1, "a"));
  pending = mergeFrames(pending, frame(2, "b"));
  expect(text(pending)).toBe("ab");
  expect(pending).toMatchObject({ seq: 2, full: false });
  pending = mergeFrames(pending, frame(3, "FULL", true));
  expect(text(pending)).toBe("FULL");
  expect(pending.full).toBe(true);
  // What follows a repaint joins it and the whole is still a repaint, since it starts with one.
  expect(mergeFrames(pending, frame(4, "!"))).toMatchObject({ full: true, seq: 4 });
  expect(text(mergeFrames(pending, frame(4, "!")))).toBe("FULL!");
  // A different size is a different screen: nothing is joined across it.
  expect(text(mergeFrames(frame(5, "x"), frame(6, "y", false, 100)))).toBe("y");
});

test("what a pane's agent changed is read from git against the commit its worktree was cut from", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  mkdirSync(join(dir, "repo"));
  const repo = realpathSync(join(dir, "repo"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "keep.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "old.txt"), "gone\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const tree = join(realpathSync(dir), "wt-fix");
  git(repo, "worktree", "add", "-q", "-b", "ghost/fix", tree);
  writeFileSync(join(tree, "new.txt"), "added\n");
  git(tree, "add", "new.txt");
  git(tree, "commit", "-qm", "Add new");
  writeFileSync(join(tree, "keep.txt"), "one\nTWO\nthree\n");
  git(tree, "rm", "-q", "old.txt");
  writeFileSync(join(tree, "loose.txt"), "untracked\nlines\n");
  const setCwd = (cwd: string | null) => writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ ...snapshot, result: { snapshot: { ...snapshot.result.snapshot, panes: snapshot.result.snapshot.panes.map((pane) => (pane.pane_id === "w1:pA" ? { ...pane, foreground_cwd: cwd, cwd } : pane)) } } }));
  try {
    const herdr = new Herdr(fake.path);
    setCwd(tree);
    const changes = await herdr.changes("w1:pA");
    expect(changes).toMatchObject({ git: true, branch: "ghost/fix", truncated: false });
    expect(changes.commits.map((commit) => commit.subject)).toEqual(["Add new"]);
    expect(changes.base).toBe(git(repo, "rev-parse", "HEAD").trim().slice(0, 12));
    expect(Object.fromEntries(changes.files.map((file) => [file.path, [file.status, file.additions, file.deletions]]))).toEqual({
      "keep.txt": ["modified", 2, 1],
      "new.txt": ["added", 1, 0],
      "old.txt": ["deleted", 0, 1],
      "loose.txt": ["untracked", null, null],
    });
    expect((await herdr.diff("w1:pA", "keep.txt")).diff).toContain("+TWO");
    expect((await herdr.diff("w1:pA", "new.txt")).diff).toContain("+added");
    expect((await herdr.diff("w1:pA", "loose.txt")).diff).toContain("+untracked");
    // Only a path the change list names is answered.
    await expect(herdr.diff("w1:pA", "../../etc/passwd")).rejects.toMatchObject({ code: "not_found" });
    await expect(herdr.diff("w1:pA", "untouched.txt")).rejects.toMatchObject({ code: "not_found" });
    await expect(herdr.diff("w1:pA", "--output=/tmp/x")).rejects.toMatchObject({ code: "not_found" });

    // The main checkout is measured from its own HEAD: only what is uncommitted.
    writeFileSync(join(repo, "keep.txt"), "one\ntwo\nmain edit\n");
    setCwd(repo);
    const main = await herdr.changes("w1:pA");
    expect(main.files.map((file) => [file.path, file.status])).toEqual([["keep.txt", "modified"]]);
    expect(main.commits).toEqual([]);

    setCwd(dir);
    expect(await herdr.changes("w1:pA")).toEqual({ git: false, branch: null, base: null, commits: [], files: [], truncated: false });
    setCwd(null);
    expect((await herdr.changes("w1:pA")).git).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omp offers its models and a directory's recent conversations, newest first, without reading whole conversations", () => {
  const dir = tempDir();
  const home = realpathSync(dir);
  const sessions = join(home, ".omp/agent/sessions");
  const projects = join(home, "Work/app");
  mkdirSync(projects, { recursive: true });
  const folder = join(sessions, "-Work-app");
  mkdirSync(folder, { recursive: true });
  const write = (name: string, id: string, title: string, at: number) => {
    const path = join(folder, name);
    writeFileSync(path, `${JSON.stringify({ type: "title", title, pad: " ".repeat(40) })}\n${JSON.stringify({ type: "session", id, cwd: projects })}\n${"x".repeat(2_000_000)}\n`);
    utimesSync(path, at / 1000, at / 1000);
  };
  write("a.jsonl", "01aaaaaa-0000-7000-8000-000000000001", "older", 1_000_000);
  write("b.jsonl", "01bbbbbb-0000-7000-8000-000000000002", "title>newer", 2_000_000);
  writeFileSync(join(folder, "broken.jsonl"), "not json\n");
  writeFileSync(join(folder, "notes.txt"), "x");
  const outside = join(sessions, "--private-tmp-elsewhere--");
  try {
    const provider = new OmpInfoProvider({ executable: null, home });
    expect(provider.sessionsDir(projects)).toBe(folder);
    expect(provider.sessionsDir("/private/tmp/elsewhere")).toBe(outside);
    return provider.info(projects).then((info) => {
      expect(info.sessions).toEqual([
        { id: "01bbbbbb-0000-7000-8000-000000000002", title: "newer", updatedAt: 2_000_000 },
        { id: "01aaaaaa-0000-7000-8000-000000000001", title: "older", updatedAt: 1_000_000 },
      ]);
      expect(info.models).toEqual([]);
      return provider.info(join(home, "Work/none")).then((none) => expect(none.sessions).toEqual([]));
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
});

test("omp's models come from omp itself, chat models only, and a broken omp is no models rather than an error", async () => {
  const dir = tempDir();
  const script = join(dir, "omp");
  writeFileSync(script, `#!/bin/sh
echo '{"models":[{"provider":"anthropic","kind":"chat","selector":"anthropic/claude-x","name":"Claude X","thinking":["low","high"]},{"provider":"voyage","kind":"embedding","selector":"voyage/e","name":"E"},{"provider":"openai","selector":"openai/gpt-y","thinking":null}]}'
`);
  chmodSync(script, 0o755);
  const bad = join(dir, "bad");
  mkdirSync(bad);
  writeFileSync(join(bad, "omp"), "#!/bin/sh\necho nope; exit 3\n");
  chmodSync(join(bad, "omp"), 0o755);
  try {
    const info = await new OmpInfoProvider({ executable: script, home: dir }).info(dir);
    expect(info.models).toEqual([
      { selector: "anthropic/claude-x", name: "Claude X", provider: "anthropic", thinking: ["low", "high"] },
      { selector: "openai/gpt-y", name: "openai/gpt-y", provider: "openai", thinking: [] },
    ]);
    expect((await new OmpInfoProvider({ executable: join(bad, "omp"), home: dir }).info(dir)).models).toEqual([]);
    await expect(new OmpInfoProvider({ executable: null }).info("relative")).rejects.toMatchObject({ code: "invalid" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file sent from the app is saved where an agent can read it, under a name that is safe as a path", () => {
  const root = tempDir();
  try {
    expect(safeUploadName("../../etc/Screen Shot 2026.png")).toBe("Screen-Shot-2026.png");
    expect(safeUploadName("-rf")).toBe("rf");
    expect(safeUploadName("화면 캡처.png")).toBe("화면-캡처.png");
    expect(safeUploadName("...")).toBe("file");
    const saved = saveUpload(root, "../shot one.png", new Uint8Array([1, 2, 3]));
    expect(saved).toMatchObject({ name: "shot-one.png", size: 3 });
    expect(saved.path.startsWith(join(root, "uploads"))).toBe(true);
    expect([...readFileSync(saved.path)]).toEqual([1, 2, 3]);
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(() => saveUpload(root, "x", new Uint8Array(0))).toThrow("empty");
    expect(() => saveUpload(root, "x", new Uint8Array(10 * 1024 * 1024 + 1))).toThrow("larger than 10 MB");
    // A week later it is gone when the next one arrives, and the new one is not.
    const later = saveUpload(root, "next.png", new Uint8Array([9]), Date.now() + 8 * 24 * 3600_000);
    expect(existsSync(saved.path)).toBe(false);
    expect(existsSync(later.path)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the watcher tells the owner once when an agent that was working starts waiting for an answer, and only as the owner chose", async () => {
  const h = harness(":memory:");
  const ghost = h.core.createGhost({ name: "Main", persona: "" });
  type Status = "idle" | "working" | "blocked" | "done" | "unknown";
  const state: { panes: [string, Status, string | null][]; session: string } = { panes: [["w1:pA", "working", "claude"], ["w1:p2", "unknown", null]], session: "default" };
  const herdr = {
    overview: async () => ({
      available: true, session: state.session, note: null,
      workspaces: [{ id: "w1", label: "ghost", status: "idle" as const, worktree: null, tabs: [{ id: "w1:t1", label: "로그인 고치기", status: "idle" as const, panes: state.panes.map(([id, status, agent]) => ({ id, workspaceId: "w1", tabId: "w1:t1", workspace: "ghost", tab: "로그인 고치기", agent, status, cwd: "/work", title: "로그인 고치기", focused: false, owned: false })) }] }],
    }),
  } as unknown as HerdrPort;
  let time = 1_000_000;
  const watcher = new CodingWatcher(h.core, herdr, { clock: { now: () => time, repeat: () => () => {} } });
  const told = () => h.ledger.notificationsForState().filter((entry) => entry.id.startsWith("coding:"));
  const set = (status: Status) => { state.panes[0]![1] = status; };
  try {
    await watcher.poll();
    expect(told()).toEqual([]);
    set("blocked");
    await watcher.poll();
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatchObject({ kind: "message", ghostId: ghost.id, conversationId: ghost.directConversationId, title: "에이전트가 답을 기다려요", body: "로그인 고치기\nclaude · ghost" });
    // Still blocked, or answered and blocked again within a minute: not another one.
    await watcher.poll();
    set("working"); await watcher.poll();
    time += 10_000; set("blocked"); await watcher.poll();
    expect(told()).toHaveLength(1);
    // Finishing is only news when the owner asked for it.
    time += 120_000; set("working"); await watcher.poll();
    set("done"); await watcher.poll();
    expect(told()).toHaveLength(1);
    h.ledger.tx(() => h.ledger.putSetting("coding", { session: null, agent: null, notify: "all" }));
    time += 120_000; set("working"); await watcher.poll();
    set("done"); await watcher.poll();
    expect(told().map((entry) => entry.title).sort()).toEqual(["에이전트가 끝났어요", "에이전트가 답을 기다려요"]);
    // Off is off, and a plain shell is never news.
    h.ledger.tx(() => h.ledger.putSetting("coding", { session: null, agent: null, notify: "off" }));
    time += 120_000; set("working"); await watcher.poll();
    set("blocked"); await watcher.poll();
    state.panes[1]![1] = "working"; await watcher.poll(); state.panes[1]![1] = "blocked"; await watcher.poll();
    expect(told()).toHaveLength(2);
  } finally {
    h.core.stop();
    h.ledger.close();
  }
});

test("the history, change, omp and upload routes need the owner token, answer in the contract's shapes and refuse bad input", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const h = harness(":memory:");
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null, herdr: new Herdr(fake.path), omp: new OmpInfoProvider({ executable: null, home: dir }) });
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, token: string | null = OWNER) => fetch(`${base}${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  const upload = (name: string, body: BodyInit, token: string | null = OWNER) => fetch(`${base}/api/herdr/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: token === null ? {} : { authorization: `Bearer ${token}` }, body });
  try {
    for (const path of ["/api/herdr/changes?pane=w1%3ApA", "/api/herdr/diff?pane=w1%3ApA&path=a", `/api/coding/omp?cwd=${encodeURIComponent(dir)}`]) expect((await get(path, null)).status).toBe(401);
    expect((await upload("a.png", new Uint8Array([1]), null)).status).toBe(401);

    const history = parse(HerdrOutput, await (await get("/api/herdr/output?pane=w1%3ApA&format=ansi&lines=2000")).json());
    expect(history.text).toContain("\u001b[31mred");
    expect(parse(HerdrChanges, await (await get("/api/herdr/changes?pane=w1%3ApA")).json()).git).toBe(false);
    expect((await get("/api/herdr/changes?pane=w1%3ApZ")).status).toBe(404);
    expect((await get("/api/herdr/diff?pane=w1%3ApA&path=a.txt")).status).toBe(404);
    expect(parse(OmpInfo, await (await get(`/api/coding/omp?cwd=${encodeURIComponent(dir)}`)).json())).toEqual({ models: [], sessions: [] });
    expect((await get("/api/coding/omp?cwd=relative")).status).toBe(400);

    const saved = parse(HerdrUpload, await (await upload("../shot one.png", new Uint8Array([1, 2, 3]))).json());
    expect(saved).toMatchObject({ name: "shot-one.png", size: 3 });
    expect([...readFileSync(saved.path)]).toEqual([1, 2, 3]);
    expect((await upload("empty.png", new Uint8Array(0))).status).toBe(400);
    expect((await upload("big.bin", new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(400);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("coding reads bind the recorded session and guarded input refuses replaced or busy terminals", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const panes = structuredClone(snapshot);
  Object.assign(panes.result.snapshot.panes[0]!, { terminal_id: "terminal-original", agent_status: "idle" });
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(panes));
  const herdr = new Herdr(fake.path, { prefs: () => ({ session: "work", agent: null, notify: "off" }) });
  try {
    expect((await herdr.overview("default")).session).toBe("default");
    expect((await herdr.output("w1:pA", { session: "default" })).text).toContain("working on it");
    let admitted = 0;
    const guard = { session: "default", terminalId: "terminal-new", agent: "claude", authorize: () => { admitted++; } };
    await expect(herdr.prompt("w1:pA", "do not send", undefined, guard)).rejects.toThrow("replaced");
    expect(admitted).toBe(0);
    Object.assign(panes.result.snapshot.panes[0]!, { agent_status: "working" });
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify(panes));
    await expect(herdr.prompt("w1:pA", "do not queue", undefined, { ...guard, terminalId: "terminal-original" })).rejects.toThrow("not ready");
    await expect(herdr.interrupt("default", "w1:pA", "terminal-new")).rejects.toThrow("replaced");
    await expect(herdr.interrupt("default", "w1:pA", "terminal-original", { agent: "claude", authorize: () => { throw new Error("cancel target changed"); } })).rejects.toThrow("cancel target changed");
    const calls = await fake.runs();
    expect(calls.some((args) => args.includes("prompt") || args.includes("send-keys"))).toBe(false);
    await herdr.interrupt("default", "w1:pA", "terminal-original");
    expect((await fake.runs()).at(-1)).toEqual(["--session", "default", "agent", "send-keys", "w1:pA", "Ctrl+c"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coding start records the opened terminal before launch and rechecks authority before mutations", async () => {
  const dir = tempDir();
  const repo = join(dir, "repo");
  gitRepo(repo);
  const fake = fakeHerdr(dir);
  writeFileSync(join(dir, "omp"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "omp"), 0o755);
  const panes = structuredClone(snapshot);
  Object.assign(panes.result.snapshot.panes[3]!, { terminal_id: "terminal-created" });
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(panes));
  const herdr = new Herdr(fake.path, { agentDirs: [dir] });
  try {
    const stages: string[] = [];
    await expect(herdr.start({ repo, task: "fix", agent: "omp" }, undefined, (opened) => {
      expect(opened.pane).toMatchObject({ terminalId: "terminal-created", agent: "omp" });
      stages.push("opened");
    }, { session: "default", authorize(stage) { if (stage) stages.push(stage); if (stage === "launch") throw new Error("authority revoked"); } })).rejects.toThrow("authority revoked");
    expect(stages).toEqual(["open", "opened", "launch"]);
    expect((await fake.runs()).some((args) => args.includes("start") || args.includes("prompt"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coding reports publication as local observations rather than claiming who pushed", async () => {
  const dir = tempDir();
  const repo = join(dir, "repo");
  gitRepo(repo);
  try {
    execFileSync("/usr/bin/git", ["update-ref", "refs/remotes/example/main", "HEAD"], { cwd: repo });
    const report = await gitReport(repo, null);
    expect(report.publication).toMatchObject({ upstream: null, remoteRefsContainingHead: ["example/main"] });
    expect((report.publication as { basis: string }).basis).toContain("does not prove this agent pushed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
