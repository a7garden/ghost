import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeModels, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { ClaudeModelCatalog } from "../src/integrations/claude-models.ts";
import { Herdr } from "../src/integrations/herdr.ts";
import { harness, tempDir } from "./support.ts";

const row = (model: string, timestamp?: string, type = "assistant") => JSON.stringify({ type, timestamp, message: { model } });
const aliases = ["default", "opus", "sonnet", "haiku", "opusplan", "sonnet[1m]", "opus[1m]"];

test("orders distinct Claude model IDs by last use, scans nested transcripts, and appends the configured selector", async () => {
  const dir = tempDir();
  try {
    const claude = join(dir, ".claude");
    const project = join(claude, "projects", "sample");
    const nested = join(project, "run", "subagents");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, "session.jsonl"), [
      row("claude-opus-5-5", "2026-11-20T00:00:00Z"),
      row("claude-sonnet-4-6", "2026-11-21T00:00:00Z"),
      row("claude-opus-5-5", "2026-11-22T00:00:00Z"),
      row("<synthetic>", "2026-11-23T00:00:00Z"),
      row("gpt-6.2", "2026-11-23T00:00:00Z"),
      row("claude-not-an-assistant", "2026-11-23T00:00:00Z", "user"),
      "{malformed}",
    ].join("\n"));
    writeFileSync(join(nested, "subagent.jsonl"), row("claude-fable-5-2", "2026-11-23T00:00:00Z"));
    writeFileSync(join(dir, "outside.jsonl"), row("claude-not-in-projects"));
    symlinkSync(join(dir, "outside.jsonl"), join(project, "escape.jsonl"));
    writeFileSync(join(claude, "settings.json"), '{"model":"company-bedrock-deployment","notModel":"secret"}');
    const { models } = parse(ClaudeModels, await new ClaudeModelCatalog(dir).list());
    expect(models.slice(0, aliases.length).map((model) => model.selector)).toEqual(aliases);
    expect(models.slice(aliases.length)).toEqual([
      { selector: "claude-fable-5-2", name: "Fable 5.2", provider: "Claude" },
      { selector: "claude-opus-5-5", name: "Opus 5.5", provider: "Claude" },
      { selector: "claude-sonnet-4-6", name: "Sonnet 4.6", provider: "Claude" },
      { selector: "company-bedrock-deployment", name: "company-bedrock-deployment", provider: "Claude" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("limits reads to the 40 newest file tails and refreshes after ten minutes", async () => {
  const dir = tempDir();
  try {
    const claude = join(dir, ".claude");
    const project = join(claude, "projects", "sample");
    mkdirSync(project, { recursive: true });
    for (let i = 0; i < 41; i++) {
      const path = join(project, `${i}.jsonl`);
      writeFileSync(path, `${row(i === 0 ? "claude-oldest" : "claude-haiku-4-5-20251001")}\n`);
      utimesSync(path, 1, i + 1);
    }
    const latest = join(project, "latest.jsonl");
    writeFileSync(latest, `${row("claude-before-tail")}\n${"x".repeat(256 * 1024)}\n${row("claude-newest")}\n${row("claude-later")}\n`);
    writeFileSync(join(claude, "settings.json"), '{"model":"claude-newest"}');
    let now = 1_000;
    const catalog = new ClaudeModelCatalog(dir, () => now);
    const selectors = async () => (await catalog.list()).models.slice(aliases.length).map((model) => model.selector);
    expect(await selectors()).toEqual(["claude-later", "claude-newest", "claude-haiku-4-5-20251001"]);
    writeFileSync(latest, `${row("claude-sonnet-5-5")}\n`);
    writeFileSync(join(claude, "settings.json"), '{"model":"opus"}');
    now += 599_999;
    expect(await selectors()).toEqual(["claude-later", "claude-newest", "claude-haiku-4-5-20251001"]);
    now++;
    expect(await selectors()).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("authenticates the model route and reads only the catalog's HOME, not request paths", async () => {
  const dir = tempDir();
  const h = harness(":memory:");
  const config: Config = { root: dir, host: "127.0.0.1", port: 0, publicOrigin: null, uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: "owner", documents: null, skills: null, herdr: new Herdr(null), claudeModels: new ClaudeModelCatalog(dir) });
  const url = `http://127.0.0.1:${server.port}/api/herdr/claude-models?home=/ignored`;
  try {
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { authorization: "Bearer owner" } });
    expect(response.status).toBe(200);
    expect(parse(ClaudeModels, await response.json()).models.map((model) => model.selector)).toEqual(aliases);
    expect(h.ledger.seq()).toBe(0);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
