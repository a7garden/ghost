import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { orchestrationIssues, type OrchestrationView } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import { CodingSessions } from "../src/coding/index.ts";
import { loadConfig } from "../src/config.ts";
import { Core } from "../src/core/core.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { defaultOrchestration, OrchestrationStore, orchestrationStore } from "../src/orchestration/config.ts";
import { previewOmp } from "../src/orchestration/import-omp.ts";
import { createCodingTools } from "../src/tools/coding.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const owner = { kind: "owner" } as const;
const features = { provider: "faux", model: "sonar", thinking: "high" } as const;
const emptyInventory: Omit<OrchestrationView, "config"> = { providersWithCredentials: [], models: [] };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ghost-orchestration-test-"));
  const root = join(directory, "host"), checkout = join(directory, "checkout");
  mkdirSync(root); mkdirSync(checkout);
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, log: console.error });
  core.attach(new FakeEngine());
  const ids = ["parent", "sonar", "backup"];
  const faux = fauxProvider({ provider: "faux", models: ids.map(id => ({ id, name: id, input: ["text"], reasoning: true })) });
  ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Faux", baseUrl: "http://127.0.0.1:9/v1", models: ids.map(id => ({ id, name: id, reasoning: true })) });
  ledger.putSetting("defaultModel", { provider: "faux", model: "parent" });
  secrets.put("faux", "faux-key");
  const sessions = new CodingSessions({ root, ledger, settings: () => ledger.settings(), secrets, catalog: core.catalog, log: console.error,
    authorizeGhost: () => {}, provider: () => faux.provider });
  core.setCodingSessions(sessions);
  const store = orchestrationStore(ledger);
  return { root, checkout, ledger, core, sessions, faux, store,
    async close() { await sessions.shutdown(); core.stop(); ledger.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function turn(f: ReturnType<typeof fixture>, id: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const stop = f.sessions.subscribe(id, event => {
    if (event.type === "session" && event.session.state !== "working" && event.session.state !== "waiting") resolve();
  });
  try { await f.sessions.prompt(id, { text: "Run the configured delegation." }); await promise; }
  finally { stop(); }
}

function customConfig() {
  const config = defaultOrchestration();
  config.modelRoles.analysis = features;
  config.agents.push({ name: "analyst", description: "Trace the requested behavior", modelRole: "analysis", instructions: "ANALYST_INSTRUCTIONS",
    tools: ["read"], readOnly: true, canDelegateTo: [] });
  return config;
}

test("faux provider sees custom agent and its tool allowlist; quota walks the configured model chain", async () => {
  const f = fixture();
  try {
    const session = await f.sessions.create({ cwd: f.checkout }, owner);
    const config = customConfig();
    config.fallbackChains.analysis = [{ provider: "faux", model: "backup", thinking: "low" }];
    f.store.set(config); // Create happened already: model gets the new schema on the next prompt.
    const calls: string[] = [];
    f.faux.setResponses([
      context => {
        const tool = getCurrentTools(context.messages).find(tool => tool.name === "subagent");
        expect(tool?.description).toContain("analyst (read-only): Trace the requested behavior");
        return fauxAssistantMessage(fauxToolCall("subagent", { tasks: [{ agent: "analyst", task: "Trace it" }] }), { stopReason: "toolUse" });
      },
      (context, options, _state, model) => {
        calls.push(model.id);
        expect(options?.reasoning).toBe("high");
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["read"]);
        expect(context.messages.filter(message => message.role === "system").map(getSystemMessageText).join(" ")).toContain("ANALYST_INSTRUCTIONS");
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit; retry in 60s" });
      },
      (context, options, _state, model) => {
        calls.push(model.id);
        expect(options?.reasoning).toBe("low");
        expect(context.messages.filter(message => message.role === "user")).toHaveLength(1);
        return fauxAssistantMessage("Analysis done.");
      },
      fauxAssistantMessage("Accepted."),
    ]);
    await turn(f, session.id);
    expect(calls).toEqual(["sonar", "backup"]);
    expect(f.sessions.items(session.id).filter(item => item.kind === "subagent")).toMatchObject([{ role: "analyst", status: "done", summary: "Analysis done." }]);
  } finally { await f.close(); }
});

test("depth, delegation allowlist and concurrency restrict nested calls", async () => {
  const f = fixture();
  try {
    const config = customConfig();
    config.limits = { maxConcurrency: 2, maxDepth: 2 };
    config.agents.at(-1)!.canDelegateTo = ["scout"];
    f.store.set(config);
    const session = await f.sessions.create({ cwd: f.checkout }, owner);
    const call = (agent: string, count = 1) => fauxAssistantMessage(fauxToolCall("subagent", { tasks: Array.from({ length: count }, () => ({ agent, task: "Inspect" })) }), { stopReason: "toolUse" });
    f.faux.setResponses([
      call("analyst"),
      context => {
        const tool = getCurrentTools(context.messages).find(tool => tool.name === "subagent");
        expect(tool?.description).toContain("scout");
        expect(tool?.description).not.toContain("worker");
        return call("scout");
      },
      context => {
        expect(getCurrentTools(context.messages).some(tool => tool.name === "subagent")).toBe(false);
        return fauxAssistantMessage("Leaf finished.");
      },
      fauxAssistantMessage("Analyst finished."), fauxAssistantMessage("Root finished."),
    ]);
    await turn(f, session.id);
    expect(f.sessions.items(session.id).filter(item => item.kind === "subagent").map(item => item.role)).toEqual(["analyst", "scout"]);
    f.faux.setResponses([call("scout", 3), fauxAssistantMessage("The cap rejected the batch.")]);
    await turn(f, session.id);
    expect(f.sessions.items(session.id).filter(item => item.kind === "subagent")).toHaveLength(2);
    f.store.set({ ...config, limits: { ...config.limits, maxConcurrency: 1 } });
    f.faux.setResponses([
      call("analyst"), call("scout"),
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("concurrency limit reached") });
        return fauxAssistantMessage("No concurrent child slot.");
      },
      fauxAssistantMessage("Root finished."),
    ]);
    await turn(f, session.id);
    expect(f.sessions.items(session.id).filter(item => item.kind === "subagent").map(item => item.role)).toEqual(["analyst", "scout", "analyst"]);
    expect(f.sessions.items(session.id).filter(item => item.kind === "subagent").at(-1)?.status).toBe("done");
  } finally { await f.close(); }
});

test("custom writers cannot overlap on the same checkout, even across parent sessions", async () => {
  const f = fixture();
  const { promise: holding, resolve: started } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  try {
    const config = customConfig();
    config.agents.at(-1)!.readOnly = false;
    f.store.set(config);
    const first = await f.sessions.create({ cwd: f.checkout }, owner);
    const second = await f.sessions.create({ cwd: f.checkout }, owner);
    const ask = fauxAssistantMessage(fauxToolCall("subagent", { chain: [{ agent: "analyst", task: "Write within the checkout" }] }), { stopReason: "toolUse" });
    f.faux.setResponses([
      ask,
      async () => { started(); await released; return fauxAssistantMessage("First writer stopped."); },
      ask,
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("another worker is writing") });
        return fauxAssistantMessage("The checkout is in use.");
      },
      fauxAssistantMessage("Finished."),
    ]);
    const writing = turn(f, first.id);
    await holding;
    await turn(f, second.id);
    expect(f.sessions.get(second.id)?.state).toBe("idle");
    expect(f.sessions.items(second.id).some(item => item.kind === "subagent")).toBe(false);
    release();
    await writing;
    expect(f.sessions.items(first.id).filter(item => item.kind === "subagent")).toMatchObject([{ role: "analyst", status: "done" }]);
  } finally { release(); await f.close(); }
});

test("master and per-session switches remove the tool without changing file tools or granting policy tools", async () => {
  const f = fixture();
  try {
    const session = await f.sessions.create({ cwd: f.checkout }, owner);
    const expected: boolean[] = [true, false, true, false, true];
    for (const [index, hasDelegation] of expected.entries()) {
      if (index === 1 || index === 2) f.store.set({ ...f.store.get(), enabled: index === 2 });
      if (index === 3 || index === 4) f.store.setSessionEnabled(session.id, index === 4);
      f.faux.setResponses([context => {
        const names = getCurrentTools(context.messages).map(tool => tool.name);
        expect(names.includes("subagent")).toBe(hasDelegation);
        expect(names).toContain("read");
        expect(names).not.toContain("orchestration.config");
        return fauxAssistantMessage("Confirmed.");
      }]);
      await turn(f, session.id);
      expect(f.sessions.get(session.id)?.state).toBe("idle");
    }
    const ghostTools = createCodingTools(f.core);
    expect(ghostTools.tools?.map(tool => tool.name).sort()).toEqual(["code_agents", "code_run"]);
  } finally { await f.close(); }
});

test("owner route validates writes and persists config and session override without accepting unauthenticated edits", async () => {
  const f = fixture();
  const server = startServer({ core: f.core, config: { ...loadConfig({}, f.root), host: "127.0.0.1", port: 0 }, ownerToken: "orchestration-owner-test", documents: null, skills: null });
  const base = `http://127.0.0.1:${server.port}/api/orchestration`;
  const write = (path: string, body: unknown, authorization?: string, crossSite = false) => fetch(base + path, { method: "PUT", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}), ...(crossSite ? { "sec-fetch-site": "cross-site" } : {}) } });
  const auth = "Bearer orchestration-owner-test";
  try {
    const config = customConfig();
    expect((await write("/config", config)).status).toBe(401);
    expect((await write("/config", config, auth, true)).status).toBe(403);
    expect((await write("/config", config, auth)).status).toBe(200);
    const session = await f.sessions.create({ cwd: f.checkout }, owner);
    expect((await write(`/sessions/${session.id}`, { enabled: false }, auth)).status).toBe(200);
    const reopened = new Ledger(join(f.root, "ledger.db"));
    try {
      const restored = new OrchestrationStore(reopened);
      expect(restored.get()).toEqual(config);
      expect(restored.sessionEnabled(session.id)).toBe(false);
    } finally { reopened.close(); }
    config.agents[0]!.canDelegateTo = [config.agents[0]!.name];
    expect((await write("/config", config, auth)).status).toBe(400);
    expect(f.store.get().agents[0]!.canDelegateTo).toEqual([]);
  } finally { await server.stop(); await f.close(); }
});

test("omp preview maps the sanitized owner config, including role overrides and missing credentials", () => {
  const directory = fileURLToPath(new URL("./fixtures/orchestration-omp", import.meta.url));
  const { config, issues, unmappable } = previewOmp(emptyInventory, directory);
  expect(config.limits).toEqual({ maxConcurrency: 4, maxDepth: 1 });
  expect(Object.keys(config.modelRoles)).toContain("worker_sol");
  expect(config.modelRoles.worker_sol).toEqual({ provider: "openai-codex", model: "gpt-6.2-sol", thinking: "high" });
  expect(config.fallbackChains.worker?.map(ref => "model" in ref && ref.model)).toEqual(["MiniMax-M3.1-Flash", "gpt-6-luna"]);
  expect(config.agents.find(agent => agent.name === "task-hard")).toMatchObject({ modelRole: "worker_hard", readOnly: true, instructions: expect.stringContaining("Implement only the assigned scope.") });
  expect(config.agents.find(agent => agent.name === "scout")?.modelRole).toBe("chore");
  expect(config.agents.find(agent => agent.name === "art-hard")?.modelRole).toBe("slow");
  expect(unmappable).toContain("retry.fallbackChains.anthropic/*");
  expect(unmappable).toContain("task.agentModelOverrides.sonic");
  expect(issues).toContainEqual({ kind: "role", name: "worker_sol", code: "credential", ref: "openai-codex/gpt-6.2-sol" });
  expect(orchestrationIssues(config)).toEqual([]);
});
