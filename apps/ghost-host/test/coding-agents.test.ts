import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgents, pickCodingAgent } from "../src/integrations/coding-agents.ts";
import type { CodingAgentInfo } from "../src/integrations/ports.ts";

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

test("an agent that is a script finds its interpreter beside it even when the Host's PATH has none", async () => {
  const dir = bin({ fakeinterp: { body: "echo codex-cli 7.7.7", mode: 0o755 } });
  writeFileSync(join(dir, "codex"), "#!/usr/bin/env fakeinterp\n");
  chmodSync(join(dir, "codex"), 0o755);
  const agents = await new CodingAgents({ dirs: [dir] }).detect();
  expect(agents.map(({ id, version }) => ({ id, version }))).toEqual([{ id: "codex", version: "codex-cli 7.7.7" }]);
});

test("an agent whose login ended is listed as not ready, with the reason", async () => {
  const dir = bin({
    claude: { body: "case \"$1\" in --version) echo 2.1.0;; auth) echo '{\"loggedIn\":true,\"loginExpiresAt\":\"2020-01-01T00:00:00Z\"}';; esac", mode: 0o755 },
    codex: { body: "if [ \"$1\" = login ]; then exit 1; fi; echo codex-cli 1", mode: 0o755 },
    omp: { body: "echo omp/1", mode: 0o755 },
  });
  const agents = await new CodingAgents({ dirs: [dir] }).detect();
  const state = Object.fromEntries(agents.map(({ id, ready, note }) => [id, { ready, note }]));
  expect(state.omp).toEqual({ ready: true, note: null });
  expect(state.claude!.ready).toBe(false);
  expect(state.claude!.note).toContain("만료됐습니다");
  expect(state.codex).toEqual({ ready: false, note: "로그인이 필요합니다(codex login)." });
});

test("a login that ends later is still ready and says until when; a fresh look sees a new install", async () => {
  const dir = bin({ claude: { body: "case \"$1\" in --version) echo 2.1.0;; auth) echo '{\"loggedIn\":true,\"loginExpiresAt\":\"2099-06-01T00:00:00Z\"}';; esac", mode: 0o755 } });
  const coding = new CodingAgents({ dirs: [dir] });
  const [claude] = await coding.detect();
  expect(claude).toMatchObject({ id: "claude", ready: true });
  expect(claude!.note).toContain("2099");
  writeFileSync(join(dir, "omp"), "#!/bin/sh\necho omp/1\n");
  chmodSync(join(dir, "omp"), 0o755);
  expect((await coding.detect()).map((agent) => agent.id)).toEqual(["claude"]);
  expect((await coding.detect(true)).map((agent) => agent.id)).toEqual(["omp", "claude"]);
});

test("selection: a named agent or a reason, else the owner's default, else the first ready one", () => {
  const agent = (id: CodingAgentInfo["id"], ready = true): CodingAgentInfo => ({ id, name: id, path: `/bin/${id}`, version: "1", ready, note: ready ? null : "로그인이 필요합니다" });
  const all = [agent("omp"), agent("claude"), agent("codex", false)];
  const none = { default: null, disabled: [] };
  const id = (picked: ReturnType<typeof pickCodingAgent>) => ("agent" in picked ? picked.agent.id : picked.problem);
  expect(id(pickCodingAgent(all, none))).toBe("omp");
  expect(id(pickCodingAgent(all, { default: "claude", disabled: [] }))).toBe("claude");
  expect(id(pickCodingAgent(all, { default: "codex", disabled: [] }))).toBe("omp");
  expect(id(pickCodingAgent(all, { default: "omp", disabled: ["omp"] }))).toBe("claude");
  expect(id(pickCodingAgent(all, none, "claude"))).toBe("claude");
  expect(id(pickCodingAgent(all, none, "codex"))).toBe("codex is not ready: 로그인이 필요합니다");
  expect(id(pickCodingAgent(all, { default: null, disabled: ["claude"] }, "claude"))).toBe("claude is turned off by the owner in Settings");
  expect(id(pickCodingAgent([agent("omp")], none, "claude"))).toBe("claude is not installed on this Mac; code_agents lists what is");
  expect(id(pickCodingAgent([], none))).toBe("No coding agent is installed on this Mac");
  expect(id(pickCodingAgent(all, { default: null, disabled: ["omp", "claude"] }))).toContain("No coding agent can run now");
});
