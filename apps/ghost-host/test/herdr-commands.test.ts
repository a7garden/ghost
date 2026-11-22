import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrCommands, parse } from "@ghost/contract";
import { HerdrCommandsProvider } from "../src/integrations/herdr-commands.ts";
import { tempDir } from "./support.ts";

test("uses a no-session omp RPC child, keeps TUI commands, and shares listings for the same directory", async () => {
  const dir = tempDir();
  try {
    const omp = join(dir, "omp");
    const other = join(dir, "other");
    mkdirSync(other);
    const raw = [
      { name: "model", source: "builtin", description: "Change the model", input: { hint: "provider/model" } },
      { name: "skill:read-docs", source: "skill", description: "Read docs" },
      { name: "run-checks", source: "file", input: { hint: " [target] " } },
      { name: "lint", source: "extension", description: "l".repeat(500), input: { hint: "x".repeat(140) } },
      { name: "report", source: "custom" },
      { name: "mcp-lookup", source: "mcp_prompt" },
      { name: "mcp:remote", source: "mcp_prompt" },
      { name: "two words", source: "custom" },
      { name: "with\nnewline", source: "custom" },
      { name: "/prefixed", source: "builtin" },
      { name: "hidden", source: "rpc_only" },
      { name: "model", source: "file", description: "Duplicate" },
    ];
    const frame = JSON.stringify({ id: "ghost-commands", type: "response", command: "get_available_commands", success: true, data: { commands: raw } });
    writeFileSync(omp, `#!/bin/sh
[ "$*" = '--mode rpc --no-session' ] || exit 1
printf '%s\n' "$$" >> rpc-pids
printf '%s\n' 'startup noise' '{"type":"ready","protocolVersion":1}'
IFS= read -r request
[ "$request" = '{"id":"ghost-commands","type":"get_available_commands"}' ] || exit 2
printf '%s\n' '{"id":"other","type":"response","command":"get_available_commands","success":false}' '${frame}'
IFS= read -r unused
`, { mode: 0o700 });
    const catalogs = new HerdrCommandsProvider(() => omp, dir);
    const [first, simultaneous] = await Promise.all([catalogs.list("omp", dir), catalogs.list("omp", dir)]);
    expect(parse(HerdrCommands, first)).toEqual({ commands: [
      { name: "model", source: "builtin", description: "Change the model", hint: "provider/model" },
      { name: "skill:read-docs", source: "skill", description: "Read docs", hint: null },
      { name: "run-checks", source: "custom", description: "", hint: "[target]" },
      { name: "lint", source: "custom", description: "l".repeat(300), hint: "x".repeat(120) },
      { name: "report", source: "custom", description: "", hint: null },
      { name: "mcp-lookup", source: "custom", description: "", hint: null },
    ] });
    expect(simultaneous).toEqual(first);
    expect(await catalogs.list("omp", dir)).toEqual(first);
    expect(await catalogs.list("omp", other)).toEqual(first);
    for (const cwd of [dir, other]) {
      const pids = readFileSync(join(cwd, "rpc-pids"), "utf8").trim().split("\n");
      expect(pids).toHaveLength(1);
      expect(() => process.kill(Number(pids[0]), 0)).toThrow();
    }
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("logs an omp RPC failure and returns an empty list", async () => {
  const dir = tempDir();
  try {
    const omp = join(dir, "omp");
    writeFileSync(omp, `#!/bin/sh
printf '%s\n' '{"type":"ready","protocolVersion":1}'
IFS= read -r request
printf '%s\n' '{"id":"ghost-commands","type":"response","command":"get_available_commands","success":false}'
IFS= read -r unused
`, { mode: 0o700 });
    const logged: unknown[] = [];
    const catalogs = new HerdrCommandsProvider(() => omp, dir, (_message, error) => { logged.push(error); });
    expect(await catalogs.list("omp", dir)).toEqual({ commands: [] });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(new Error("omp RPC command listing failed"));
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("lists Claude built-ins and user and project Markdown commands without spawning an agent", async () => {
  const dir = tempDir();
  try {
    const home = join(dir, "home");
    const cwd = join(dir, "checkout");
    const personal = join(home, ".claude", "commands");
    const project = join(cwd, ".claude", "commands");
    mkdirSync(personal, { recursive: true });
    mkdirSync(join(project, "review"), { recursive: true });
    writeFileSync(join(personal, "changelog.md"), '---\ndescription: "Write a changelog # safely"\n---\nDo not leak the prompt');
    writeFileSync(join(project, "changelog.md"), "---\ndescription: Override\n---\nOther prompt");
    writeFileSync(join(project, "review", "docs.md"), "---\r\ndescription: >-\r\n  Check docs\r\n  for errors.\r\nargument-hint: '[path]'\r\n---\r\nPrompt");
    writeFileSync(join(project, "plain.md"), "No frontmatter\n---\ndescription: Not metadata\n---");
    writeFileSync(join(project, "hidden.md"), "---\nuser-invocable: false\n---\nPrompt");
    writeFileSync(join(project, "notes.txt"), "Not a Markdown command");
    symlinkSync(join(personal, "changelog.md"), join(project, "link.md"));
    const catalogs = new HerdrCommandsProvider(() => { throw new Error("must not spawn"); }, home);
    for (const agent of [null, "codex"]) expect(await catalogs.list(agent, cwd)).toEqual({ commands: [] });
    const { commands } = parse(HerdrCommands, await catalogs.list("claude", cwd));
    expect(commands).toContainEqual({ name: "model", description: "Choose the model", hint: "[model]", source: "builtin" });
    expect(commands.filter((command) => command.source === "custom")).toEqual([
      { name: "changelog", description: "Write a changelog # safely", hint: null, source: "custom" },
      { name: "plain", description: "", hint: null, source: "custom" },
      { name: "review:docs", description: "Check docs for errors.", hint: "[path]", source: "custom" },
    ]);
    expect(JSON.stringify(commands)).not.toContain("Do not leak the prompt");
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
