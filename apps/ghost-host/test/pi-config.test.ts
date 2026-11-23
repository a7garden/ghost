import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, getSystemMessageText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { CodingSession, PiPackage, PiSettings } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import { CodingSessions } from "../src/coding/index.ts";
import { loadConfig } from "../src/config.ts";
import { hashSecret } from "../src/core/commands.ts";
import { Core } from "../src/core/core.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const owner = { kind: "owner" } as const;
const on = { extensions: true, skills: false, prompts: false };
const off = { extensions: false, skills: false, prompts: false };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ghost-pi-config-"));
  const root = join(dir, "host"), cwd = join(dir, "project");
  mkdirSync(root); mkdirSync(cwd);
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, log: console.error });
  core.attach(new FakeEngine());
  const faux = fauxProvider({ provider: "faux", models: [
    { id: "faux-1", name: "Faux 1", contextWindow: 16_000, maxTokens: 512, reasoning: true },
    { id: "faux-2", name: "Faux 2", contextWindow: 32_000, maxTokens: 512, reasoning: true },
  ] });
  ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Faux", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "faux-1", name: "Faux 1" }, { id: "faux-2", name: "Faux 2" }] });
  ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
  ledger.tx(() => ledger.insertDevice({ id: "pi-test-device", name: "Phone", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: Date.now(), lastSeenAt: null }, hashSecret("device-test")));
  secrets.put("faux", "test-key");
  const sessions = new CodingSessions({ root, ledger, settings: () => ledger.settings(), secrets, catalog: core.catalog, log: console.error,
    authorizeGhost: () => {}, provider: () => faux.provider });
  core.setCodingSessions(sessions);
  const server = startServer({ core, config: { ...loadConfig({}, root), host: "127.0.0.1", port: 0 }, ownerToken: "owner-test", documents: null, skills: null });
  const request = (path: string, method = "GET", content?: unknown, token = "owner-test", site?: string) => fetch(`http://127.0.0.1:${server.port}/api/pi${path}`, {
    method, headers: { ...(token && { authorization: `Bearer ${token}` }), "content-type": "application/json", ...(site && { "sec-fetch-site": site }) },
    body: content === undefined ? undefined : JSON.stringify(content),
  });
  const execute = async (id: string, text: string) => {
    const settled = Promise.withResolvers<string>();
    const disconnect = sessions.onSettled(event => { if (event.session.id === id && event.outcome !== "waiting") settled.resolve(event.outcome); });
    try {
      await sessions.prompt(id, { text });
      expect(await settled.promise, JSON.stringify(sessions.items(id).filter(item => item.kind === "notice"))).toBe("done");
    } finally { disconnect(); }
  };
  const entries = (session: CodingSession) => readFileSync(join(root, "coding-sessions", session.id, "session.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const install = async (source: string) => {
    const response = await request("/packages", "POST", { source, confirmed: true });
    if (response.status !== 201) throw new Error(`Install returned ${response.status}: ${await response.text()}`);
    return await response.json() as PiPackage;
  };
  return { cwd, dir, root, ledger, faux, sessions, request, execute, entries, install, hostPort: server.port,
    async close() { await server.stop(); await sessions.shutdown(); core.stop(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("changing compaction settings affects a running Pi and persists real compaction entries", async () => {
  const f = setup();
  try {
    const session = await f.sessions.create({ cwd: f.cwd }, owner);
    const route = `/sessions/${session.id}`;
    const overrides = { compaction: { enabled: false, reserveTokens: 15_999, keepRecentTokens: 1 } };
    expect((await f.request(route, "PUT", { overrides })).status).toBe(200);
    const long = "A detailed project note. ".repeat(180);
    f.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
    await f.execute(session.id, long);
    await f.execute(session.id, long);
    expect(f.entries(session).filter(entry => entry.type === "compaction")).toHaveLength(0);
    expect(f.faux.state.callCount).toBe(2);
    expect(f.sessions.piSession(session.id).context).toMatchObject({ contextWindow: 16_000, tokens: expect.any(Number) });

    overrides.compaction.enabled = true;
    expect((await f.request(route, "PUT", { overrides })).status).toBe(200);
    // Keeping one token cuts inside a user span, so Pi summarizes both the older turns and the split prefix.
    f.faux.setResponses([fauxAssistantMessage("summary of the older turns"), fauxAssistantMessage("summary of the split turn"), fauxAssistantMessage("third reply")]);
    await f.execute(session.id, "Continue");
    const compaction = f.entries(session).filter(entry => entry.type === "compaction");
    expect(compaction).toHaveLength(1);
    expect(compaction[0]).toMatchObject({ summary: expect.stringContaining("summary of the older turns") });
    expect(f.sessions.items(session.id)).toContainEqual(expect.objectContaining({ kind: "notice", text: "맥락을 압축했습니다." }));
    expect(f.ledger.setting<unknown>(`pi.session.settings:${session.id}`, null)).toEqual(overrides);

    overrides.compaction.enabled = false;
    expect((await f.request(route, "PUT", { overrides })).status).toBe(200);
    f.faux.setResponses([fauxAssistantMessage("fourth reply"), fauxAssistantMessage("manual history summary"), fauxAssistantMessage("manual split summary")]);
    await f.execute(session.id, long);
    expect(f.entries(session).filter(entry => entry.type === "compaction")).toHaveLength(1);
    const compact = await f.request(`${route}/compact`, "POST");
    expect(compact.status).toBe(200);
    expect(f.entries(session).filter(entry => entry.type === "compaction")).toHaveLength(2);
    expect(await compact.json()).toMatchObject({ context: { contextWindow: 16_000, tokens: null } });
  } finally { await f.close(); }
});

test("Pi model defaults and tool allowlist apply to subsequent turns; explicit session choices override defaults", async () => {
  const f = setup();
  try {
    const route = "/settings";
    const current = await (await f.request(route)).json() as { settings: PiSettings };
    const ref = { provider: "faux", model: "faux-2" };
    const settings = { ...current.settings, model: ref, thinking: "high", toolAllowlist: ["ls", "powershell"] };
    expect((await f.request(route, "PUT", settings)).status).toBe(200);
    expect(f.ledger.setting<unknown>("pi.settings", null)).toEqual(settings);
    const session = await f.sessions.create({ cwd: f.cwd }, owner);
    expect(session).toMatchObject({ model: ref, thinking: "high" });
    f.faux.setResponses([(context, _options, _state, model) => {
      expect(model.id).toBe("faux-2");
      expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["ls"]);
      return fauxAssistantMessage("first");
    }, (context, _options, _state, model) => {
      expect(model.id).toBe("faux-1");
      expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual([]);
      return fauxAssistantMessage("second");
    }]);
    await f.execute(session.id, "first");
    const overrides = { model: { provider: "faux", model: "faux-1" }, thinking: "off", toolAllowlist: [] };
    expect((await f.request(`/sessions/${session.id}`, "PUT", { overrides })).status).toBe(200);
    expect(f.sessions.get(session.id)).toMatchObject({ model: overrides.model, thinking: "off" });
    await f.execute(session.id, "second");
  } finally { await f.close(); }
});

test("owner-confirmed local extensions load only when enabled; tools, commands and isolated errors are recorded", async () => {
  const f = setup();
  try {
    const local = join(f.dir, "greet.ts"), broken = join(f.dir, "broken.ts");
    writeFileSync(local, `import { Type } from 'typebox';
      export default function(pi) {
        pi.registerCommand('hello', { description: 'Hello', handler: async () => {} });
        pi.registerTool({ name: 'pi_test_greet', label: 'Pi test greet', description: 'Say hello', parameters: Type.Object({}),
          async execute() { return { content: [{ type: 'text', text: 'hello from extension' }], details: {} }; } });
      }`);
    writeFileSync(broken, "export default function() { throw new Error('isolated fixture crash'); }");
    expect((await f.request("/packages", "POST", { source: local, confirmed: false })).status).toBe(400);
    expect((await f.request("/packages", "POST", { source: local, confirmed: true }, "device-test")).status).toBe(403);
    expect((await f.request("/packages", "POST", { source: local, confirmed: true }, "")).status).toBe(401);
    expect((await f.request("/packages", "POST", { source: local, confirmed: true }, "owner-test", "cross-site")).status).toBe(403);
    expect(f.sessions.piExtensions.list()).toEqual([]);
    const installed = await f.install(local), failed = await f.install(broken);
    expect(installed).toMatchObject({ enabled: off, tools: [], extensions: ["greet.ts"] });
    expect(f.sessions.piExtensions.list()).toHaveLength(2);
    writeFileSync(local, "throw new Error('changing the source must not change the installed snapshot');");
    const session = await f.sessions.create({ cwd: f.cwd }, owner);
    const packageRoute = `/packages/${installed.id}`;
    const sessionPackage = `/sessions/${session.id}/packages/${installed.id}`;
    for (const [path, method, body] of [[packageRoute, "PUT", on], [sessionPackage, "PUT", { extensions: true }], [packageRoute, "DELETE", undefined]] as const) {
      expect((await f.request(path, method, body, "device-test")).status).toBe(403);
    }
    const absent: FauxResponseFactory = context => {
      expect(getCurrentTools(context.messages).some(tool => tool.name === "pi_test_greet")).toBe(false);
      return fauxAssistantMessage("not loaded");
    };
    f.faux.setResponses([absent]);
    await f.execute(session.id, "Disabled");
    expect((await f.request(packageRoute, "PUT", on)).status).toBe(200);
    expect((await f.request(`/packages/${failed.id}`, "PUT", on)).status).toBe(200);
    f.faux.setResponses([context => {
      expect(getCurrentTools(context.messages).some(tool => tool.name === "pi_test_greet")).toBe(true);
      return fauxAssistantMessage(fauxToolCall("pi_test_greet", {}), { stopReason: "toolUse" });
    }, context => {
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "hello from extension" }] });
      return fauxAssistantMessage("Loaded");
    }, absent]);
    await f.execute(session.id, "Enabled");
    const packages = await (await f.request("/packages")).json() as PiPackage[];
    expect(packages.find(item => item.id === installed.id)).toMatchObject({ tools: ["pi_test_greet"], commands: ["hello"], error: null });
    expect(packages.find(item => item.id === failed.id)?.error).toContain("isolated fixture crash");
    expect((await f.request(sessionPackage, "PUT", { extensions: false })).status).toBe(200);
    await f.execute(session.id, "Disabled for this session");
    expect((await f.request(packageRoute, "DELETE")).status).toBe(200);
    expect(await (await f.request("/packages")).json()).toHaveLength(1);
    expect(f.sessions.piSession(session.id).packageOverrides).toEqual({});
  } finally { await f.close(); }
});

test("skills/templates load independently and only read enabled skill files; Ghost sessions never receive them", async () => {
  const f = setup();
  try {
    const root = join(f.dir, "resources"), skill = join(root, "skills", "test-skill");
    mkdirSync(skill, { recursive: true });
    mkdirSync(join(root, "prompts"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-test-resources", version: "1.0.0" }));
    writeFileSync(join(skill, "SKILL.md"), "---\nname: test-skill\ndescription: Test an owner-managed skill\n---\nSKILL_INSTRUCTIONS");
    writeFileSync(join(skill, "data.txt"), "ENABLED_SKILL_SUPPORT");
    writeFileSync(join(root, "private.txt"), "NOT_SKILL_SUPPORT");
    writeFileSync(join(root, "prompts", "hello.md"), "TEMPLATE_INSTRUCTIONS");
    const pack = await f.install(root);
    expect(pack).toMatchObject({ name: "pi-test-resources", version: "1.0.0", skills: ["test-skill"], prompts: ["hello"], enabled: off });
    expect((await f.request(`/packages/${pack.id}`, "PUT", { ...off, skills: true, prompts: true })).status).toBe(200);
    const session = await f.sessions.create({ cwd: f.cwd }, owner);
    const stored = join(f.root, "pi", "packages", pack.id, "resources");
    const support = join(stored, "skills", "test-skill", "data.txt");
    const secret = join(stored, "private.txt");
    f.faux.setResponses([context => {
      expect(context.messages.filter(message => message.role === "system").map(getSystemMessageText).join("\n")).toContain("test-skill");
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "TEMPLATE_INSTRUCTIONS" }] });
      return fauxAssistantMessage([
        fauxToolCall("read", { path: support }, { id: "skill-read" }), fauxToolCall("write", { path: support, content: "NO" }, { id: "skill-write" }),
        fauxToolCall("read", { path: secret }, { id: "outside-skill" }),
      ], { stopReason: "toolUse" });
    }, context => {
      const results = context.messages.filter(message => message.role === "toolResult");
      expect(results.find(message => message.toolCallId === "skill-read")).toMatchObject({ isError: false, content: [{ type: "text", text: "ENABLED_SKILL_SUPPORT" }] });
      expect(results.find(message => message.toolCallId === "skill-write")).toMatchObject({ isError: true });
      expect(results.find(message => message.toolCallId === "outside-skill")).toMatchObject({ isError: true });
      return fauxAssistantMessage("done");
    }]);
    await f.execute(session.id, "/hello");
    expect(readFileSync(support, "utf8")).toBe("ENABLED_SKILL_SUPPORT");

    const git = Bun.spawnSync(["git", "-C", f.cwd, "init", "-q"]);
    if (!git.success) throw new Error(git.stderr.toString());
    const base = Bun.spawnSync(["git", "-C", f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"]);
    if (!base.success) throw new Error(base.stderr.toString());
    const ghost = await f.sessions.create({ repo: f.cwd }, { kind: "ghost", ghostId: "ghost", workId: "test", callId: "call" });
    expect((await f.request(`/sessions/${ghost.id}/packages/${pack.id}`, "PUT", { skills: true })).status).toBe(409);
    f.faux.setResponses([context => {
      expect(context.messages.filter(message => message.role === "system").map(getSystemMessageText).join("\n")).not.toContain("test-skill");
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "/hello" }] });
      return fauxAssistantMessage("done");
    }]);
    await f.execute(ghost.id, "/hello");
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "darwin")("coding bash cannot reach the Host's owner listener but can reach another loopback service", async () => {
  const f = setup();
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("allowed service") });
  try {
    const session = await f.sessions.create({ cwd: f.cwd }, owner);
    expect((await fetch(`http://127.0.0.1:${f.hostPort}/api/health`)).ok).toBe(true);
    f.faux.setResponses([fauxAssistantMessage([
      fauxToolCall("bash", { command: `/usr/bin/curl -fsS --max-time 1 http://127.0.0.1:${f.hostPort}/api/health` }, { id: "host" }),
      fauxToolCall("bash", { command: `/usr/bin/curl -fsS --max-time 1 ${other.url}` }, { id: "other" }),
    ], { stopReason: "toolUse" }), context => {
      const results = context.messages.filter(message => message.role === "toolResult");
      expect(results.find(message => message.toolCallId === "host")).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("Couldn't connect") }] });
      expect(results.find(message => message.toolCallId === "other")).toMatchObject({ isError: false, content: [{ type: "text", text: "allowed service" }] });
      return fauxAssistantMessage("done");
    }]);
    await f.execute(session.id, "Check the confined network destinations");
  } finally { other.stop(true); await f.close(); }
});

test("live follow-up mode batches owner prompts without losing their order", async () => {
  const f = setup();
  const began = Promise.withResolvers<void>(), respond = Promise.withResolvers<void>();
  try {
    const session = await f.sessions.create({ cwd: f.cwd }, owner);
    f.faux.setResponses([async () => {
      began.resolve();
      await respond.promise;
      return fauxAssistantMessage("first answer");
    }, context => {
      const followUps = context.messages.filter(message => message.role === "user").slice(-2);
      expect(followUps.map(message => message.content)).toEqual([
        [{ type: "text", text: "Follow-up A" }],
        [{ type: "text", text: "Follow-up B" }],
      ]);
      return fauxAssistantMessage("group answer");
    }]);
    const run = f.execute(session.id, "Start");
    await began.promise;
    expect((await f.request(`/sessions/${session.id}`, "PUT", { overrides: { followUpMode: "all" } })).ok).toBe(true);
    expect(await f.sessions.prompt(session.id, { text: "Follow-up A", mode: "follow_up" })).toEqual({ disposition: "queued" });
    expect(await f.sessions.prompt(session.id, { text: "Follow-up B", mode: "follow_up" })).toEqual({ disposition: "queued" });
    respond.resolve();
    await run;
    expect(f.faux.state.callCount).toBe(2);
    expect(f.sessions.get(session.id)).toMatchObject({ turn: 3, state: "idle" });
  } finally { respond.resolve(); await f.close(); }
});
