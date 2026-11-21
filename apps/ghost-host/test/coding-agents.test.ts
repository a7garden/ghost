import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgents } from "../src/integrations/coding-agents.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function bin(files: Record<string, { body: string; mode: number }>) {
  const dir = mkdtempSync(join(tmpdir(), "ghost-coding-agents-"));
  dirs.push(dir);
  for (const [name, { body, mode }] of Object.entries(files)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), mode);
  }
  return dir;
}

test("finds the agents that run, in preference order, and skips broken or non-executable ones", async () => {
  const first = bin({
    codex: { body: "echo codex-cli 0.9.0", mode: 0o755 },
    claude: { body: "exit 1", mode: 0o755 },
    omp: { body: "echo", mode: 0o644 },
  });
  const second = bin({ omp: { body: "echo omp/9.9.9", mode: 0o755 } });
  const agents = await new CodingAgents({ dirs: [join(first, "missing"), first, second] }).detect();
  expect(agents.map(({ id, name, version }) => ({ id, name, version }))).toEqual([
    { id: "omp", name: "omp", version: "omp/9.9.9" },
    { id: "codex", name: "Codex", version: "codex-cli 0.9.0" },
  ]);
  expect(agents[0]!.path).toBe(join(second, "omp"));
});

test("a run is one argv with the prompt as a single word, headless and in the given directory", async () => {
  const dir = bin({
    omp: { body: "echo omp/1", mode: 0o755 },
    claude: { body: "echo '2.1.0 (Claude Code)'", mode: 0o755 },
    codex: { body: "echo codex-cli 1", mode: 0o755 },
  });
  const coding = new CodingAgents({ dirs: [dir] });
  const prompt = "# Task\nfix `x`; rm -rf / $(whoami)";
  const argv = Object.fromEntries((await coding.detect()).map((agent) => [agent.id, coding.command(agent, prompt, "/work/tree")]));
  expect(argv.omp).toEqual([join(dir, "omp"), "-p", "--no-session", "--cwd", "/work/tree", "--thinking", "medium", prompt]);
  expect(argv.claude).toEqual([join(dir, "claude"), "-p", "--permission-mode", "bypassPermissions", prompt]);
  expect(argv.codex).toEqual([join(dir, "codex"), "exec", "--cd", "/work/tree", "--sandbox", "workspace-write", prompt]);
});

test("a Mac with no agent reports none", async () => {
  const empty = bin({});
  mkdirSync(join(empty, "sub"));
  expect(await new CodingAgents({ dirs: [empty, join(empty, "sub")] }).detect()).toEqual([]);
});
