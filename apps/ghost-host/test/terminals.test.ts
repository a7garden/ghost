import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalAgentEvent, TerminalServerFrame } from "@ghost/contract";
import { Terminals } from "../src/terminal/index.ts";
import { TERMINAL_HISTORY_BYTES } from "../src/terminal/replay.ts";

const dimensions = { cols: 80, rows: 24 };
async function eventually<T>(find: () => T | false | undefined, timeout = 5_000): Promise<T> {
  const deadline = performance.now() + timeout;
  do {
    const result = find();
    if (result) return result;
    await Bun.sleep(20);
  } while (performance.now() < deadline);
  throw new Error("timed out waiting for real PTY");
}

function fixture(options?: ConstructorParameters<typeof Terminals>[1]) {
  const cwd = mkdtempSync(join(tmpdir(), "ghost-pty-test-"));
  const root = join(cwd, "ghost-root");
  mkdirSync(root);
  const terminals = new Terminals(root, options);
  return { cwd, root, terminals, async close() { try { await terminals.shutdown(); } finally { rmSync(cwd, { recursive: true, force: true }); } } };
}

function capture(terminals: Terminals, id: string, after?: number) {
  const frames: TerminalServerFrame[] = [];
  const decoder = new TextDecoder();
  let text = "";
  let count = 0;
  const detach = terminals.attach(id, after, frame => {
    if (frame instanceof Uint8Array) {
      count += frame.length;
      text += decoder.decode(frame, { stream: true });
    } else frames.push(frame);
  });
  return { frames, detach, text: () => text, count: () => count };
}

function alive(pid: number): boolean {
  const ps = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "stat="]);
  return ps.success && !ps.stdout.toString().trimStart().startsWith("Z");
}

test("login shell, stty resize, multiple attachers, reconnect cursor, and retained exit code", async () => {
  const f = fixture();
  const before = process.env.SHELL;
  const previousHome = process.env.HOME;
  process.env.HOME = f.cwd;
  process.env.SHELL = "unknown"; // Bun reports this when a launchd environment omits SHELL.
  try {
    const { terminals } = f;
    const id = terminals.create({ cwd: f.cwd, ...dimensions });
    const first = capture(terminals, id);
    // Use an isolated HOME rather than sourcing the owner's login profile.
    terminals.input(id, "printf 'ECHO:%s\\n' READY; stty size\r");
    await eventually(() => first.text().includes("ECHO:READY") && first.text().includes("24 80"));
    const offset = first.count();
    first.detach();
    terminals.resize(id, { cols: 92, rows: 31 });
    const late = capture(terminals, id);
    const resumed = capture(terminals, id, offset);
    expect(late.text()).toContain("ECHO:READY");
    expect(resumed.frames).toEqual([{ type: "ready", reset: false, offset, cols: 92, rows: 31 }, { type: "replay-end" }]);
    terminals.input(id, "stty size; exit 7\r");
    await eventually(() => late.frames.some(frame => frame.type === "exit"));
    expect(late.text()).toContain("31 92");
    expect(resumed.text()).toContain("31 92");
    expect(resumed.text()).not.toContain("ECHO:READY");
    expect(resumed.frames.at(-1)).toEqual({ type: "exit", code: 7 });
    expect(terminals.list()).toEqual([{ id, cwd: realpathSync(f.cwd), cols: 92, rows: 31, agent: null, state: "exited", exitCode: 7 }]);
  } finally {
    if (before === undefined) delete process.env.SHELL; else process.env.SHELL = before;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await f.close();
  }
});

test("short-lived PTY commands can immediately write and exit with a private startup descriptor", async () => {
  const f = fixture();
  try {
    // The old inline spawn deadlocks intermittently when a fast child finishes
    // before Bun registers its exit watch. Exercise several active PTY lanes.
    await Promise.all(Array.from({ length: 4 }, async (_, lane) => {
      for (let run = 0; run < 8; run++) {
        const marker = `fast ${lane}:${run}`;
        const id = f.terminals.create({
          cwd: f.cwd, ...dimensions, command: "/bin/sh",
          args: ["-c", "test -t 0 && test ! -e /dev/fd/3 && printf '%s\\n' \"$1\"", "probe", marker],
        });
        const out = capture(f.terminals, id);
        await eventually(() => out.frames.some(frame => frame.type === "exit"));
        expect(out.text()).toBe(`${marker}\r\n`);
        expect(out.frames.at(-1)).toEqual({ type: "exit", code: 0 });
        await f.terminals.closeTerminal(id);
      }
    }));
  } finally { await f.close(); }
});

test("scrollback retains exactly the newest MiB and resets a stale resume cursor", async () => {
  const f = fixture();
  try {
    const id = f.terminals.create({ cwd: f.cwd, ...dimensions, command: "/bin/sh", args: ["-c", "printf 'OLD'; head -c 1100000 /dev/zero | tr '\\000' 'x'; printf 'END'"] });
    await eventually(() => f.terminals.list()[0]?.state === "exited");
    const replay = capture(f.terminals, id, 0);
    expect(replay.count()).toBe(TERMINAL_HISTORY_BYTES);
    expect(replay.text().startsWith("x")).toBe(true);
    expect(replay.text().endsWith("END")).toBe(true);
    expect(replay.frames).toEqual([
      { type: "ready", reset: true, offset: 1_100_006 - TERMINAL_HISTORY_BYTES, ...dimensions },
      { type: "replay-end" }, { type: "exit", code: 0 },
    ]);
  } finally { await f.close(); }
});

test("DELETE and shutdown kill separate foreground and background job groups", async () => {
  const f = fixture();
  try {
    for (const action of ["delete", "shutdown"] as const) {
      const id = f.terminals.create({ cwd: f.cwd, ...dimensions, command: "/bin/bash", args: ["--noprofile", "--norc", "-i"] });
      const out = capture(f.terminals, id);
      f.terminals.input(id, "set +H\r");
      f.terminals.input(id, `/bin/sleep 60 & printf 'BG:%s\\n' "$!"; /bin/sh -c 'printf "FG:%s\\n" "$$"; exec /bin/sleep 60'\r`);
      const background = await eventually(() => out.text().match(/BG:(\d+)/)?.[1]);
      const foreground = await eventually(() => out.text().match(/FG:(\d+)/)?.[1]);
      expect(alive(Number(background))).toBe(true);
      expect(alive(Number(foreground))).toBe(true);
      if (action === "delete") await f.terminals.closeTerminal(id); else await f.terminals.shutdown();
      await eventually(() => !alive(Number(background)) && !alive(Number(foreground)));
      expect(out.frames.at(-1)).toMatchObject({ type: "exit" });
      expect(f.terminals.has(id)).toBe(false);
    }
  } finally { await f.close(); }
});

test("terminal cwd refuses state root, aliases and missing paths; environment does not carry Host secrets", async () => {
  const f = fixture();
  const vars = { GHOST_OWNER_TOKEN: "owner-test-secret-marker", GHOST_ROOT: f.root, ANTHROPIC_API_KEY: "api-test-secret-marker", TMPDIR: join(f.root, "secrets") };
  const original = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    symlinkSync(f.root, join(f.cwd, "alias"));
    mkdirSync(join(f.root, "private"));
    for (const cwd of [f.root, join(f.root, "private"), join(f.cwd, "alias"), join(f.cwd, "missing"), "."]) {
      expect(() => f.terminals.create({ cwd, ...dimensions })).toThrow();
    }
    const id = f.terminals.create({ cwd: f.cwd, ...dimensions, command: "/usr/bin/env" });
    const out = capture(f.terminals, id);
    await eventually(() => out.frames.some(frame => frame.type === "exit"));
    expect(out.text()).toContain("TERM=xterm-256color");
    for (const key of ["GHOST_OWNER_TOKEN", "GHOST_ROOT", "ANTHROPIC_API_KEY", "TMPDIR"]) expect(out.text()).not.toContain(`${key}=`);
    for (const value of Object.values(vars)) expect(out.text()).not.toContain(value);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await f.close();
  }
});

test("detects a foreground omp in a shell, reports quiet once, and ignores an agent named only in command arguments", async () => {
  const events: TerminalAgentEvent[] = [];
  const f = fixture({ pollMs: 40, quietMs: 650, onEvent: (_terminal, event) => events.push(event) });
  try {
    const omp = join(f.cwd, "omp");
    writeFileSync(omp, "#!/bin/sh\nprintf 'turn started\\n'\n/bin/sleep 2\n", { mode: 0o700 });
    const id = f.terminals.create({ cwd: f.cwd, ...dimensions, command: "/bin/bash", args: ["--noprofile", "--norc", "-i"] });
    f.terminals.input(id, `/bin/sleep 0.35 # ${omp}\r`);
    const out = capture(f.terminals, id);
    await eventually(() => out.text().includes("# ") && out.text().split("$ ").length >= 2);
    expect(f.terminals.list()[0]?.agent).toBeNull();
    f.terminals.input(id, `"${omp}"; printf 'RETURNED:%s\\n' TO_SHELL\r`);
    await eventually(() => f.terminals.list()[0]?.agent === "omp" && f.terminals.list()[0]?.state === "working");
    await eventually(() => events.length === 1);
    expect(events).toEqual([{ type: "finished", agent: "omp", reason: "quiet" }]);
    await eventually(() => f.terminals.list()[0]?.agent === null && out.text().includes("RETURNED:TO_SHELL"));
    expect(events).toHaveLength(1);
  } finally { await f.close(); }
});

test("a Claude permission dialog waits once; clearing it resumes work and allows a single completion", async () => {
  const events: TerminalAgentEvent[] = [];
  const f = fixture({ pollMs: 40, quietMs: 1_000, onEvent: (_terminal, event) => events.push(event) });
  try {
    const claude = join(f.cwd, "claude");
    writeFileSync(claude, "#!/bin/sh\nprintf '\\033[2J\\033[HExecute this command? [y/N]'\nread answer\nprintf '\\033[2J\\033[Hanswer received\\n'\n/bin/sleep 2\n", { mode: 0o700 });
    const id = f.terminals.create({ cwd: f.cwd, ...dimensions, command: claude });
    await eventually(() => events.length === 1);
    expect(events).toEqual([{ type: "waiting", agent: "claude", reason: "prompt" }]);
    expect(f.terminals.list()[0]?.agent).toBe("claude");
    expect(f.terminals.list()[0]?.state).toBe("idle");
    // The unchanged real prompt must survive several actual process polling cycles.
    await Bun.sleep(200);
    expect(events).toHaveLength(1);
    f.terminals.input(id, "y\r");
    await eventually(() => f.terminals.list()[0]?.state === "exited");
    expect(events).toEqual([{ type: "waiting", agent: "claude", reason: "prompt" }, { type: "finished", agent: "claude", reason: "quiet" }]);
  } finally { await f.close(); }
});

test("an agent that exits before the quiet interval finishes once on exit", async () => {
  const events: TerminalAgentEvent[] = [];
  const f = fixture({ onEvent: (_terminal, event) => events.push(event) });
  try {
    const codex = join(f.cwd, "codex");
    writeFileSync(codex, "#!/bin/sh\nprintf 'closing\\n'\nexit 13\n", { mode: 0o700 });
    const id = f.terminals.create({ cwd: f.cwd, ...dimensions, command: codex });
    const out = capture(f.terminals, id);
    await eventually(() => out.frames.some(frame => frame.type === "exit"));
    expect(out.text()).toContain("closing");
    expect(out.frames.at(-1)).toEqual({ type: "exit", code: 13 });
    expect(events).toEqual([{ type: "finished", agent: "codex", reason: "exit" }]);
  } finally { await f.close(); }
});

test("Ghost tools cannot import the owner terminal service", () => {
  const tools = new URL("../src/tools/", import.meta.url);
  const imports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'][^"']*\/terminal(?:\/|["'])/;
  const files = readdirSync(tools, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect(readFileSync(new URL(file, tools), "utf8"), file).not.toMatch(imports);
});
