import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Type, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Live, Message, MessageRole } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { CommandError } from "../src/core/errors.ts";
import { createEngine } from "../src/engine/index.ts";
import { applyProviders, buildModels } from "../src/engine/models.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { Engine } from "../src/core/ports.ts";
import type { SandboxEnvFactory } from "../src/integrations/ports.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (args) => ({ content: [{ type: "text", text: `echo:${args.text}` }] }),
});

const extension = defineExtension({ name: "ghost.test", tools: [echo] });

const tools: ToolSet = {
  all: () => [extension],
  extensionsFor: () => [extension],
  instructionsFor: () => "You are the test Ghost. Answer in one line.",
};

const sandbox: SandboxEnvFactory = {
  envFor: async () => {
    throw new Error("the engine tests do not run in a sandbox");
  },
  workspacePath: () => "",
  stageInputs: async () => {},
};

/** Records what the engine reports about a conversation's runs, and lets a test await them. */
class RecordingCore extends Core {
  readonly activities: { conversationId: string; busy: boolean }[] = [];
  private readonly waits: (() => boolean)[] = [];

  /** How many activities a conversation has seen so far. */
  activityCount(conversationId: string): number {
    return this.activities.filter((entry) => entry.conversationId === conversationId).length;
  }

  /** The activity of a conversation at position `after`, once the engine reports it. */
  nextActivity(conversationId: string, after: number): Promise<{ busy: boolean }> {
    const { promise, resolve } = Promise.withResolvers<{ busy: boolean }>();
    const deliver = () => {
      const entries = this.activities.filter((entry) => entry.conversationId === conversationId);
      const entry = entries[after];
      if (!entry) return false;
      resolve({ busy: entry.busy });
      return true;
    };
    if (!deliver()) this.waits.push(deliver);
    return promise;
  }

  override activity(conversationId: string, busy: boolean, at: number) {
    this.activities.push({ conversationId, busy });
    for (let index = this.waits.length - 1; index >= 0; index--) {
      if (this.waits[index]?.() === true) this.waits.splice(index, 1);
    }
    super.activity(conversationId, busy, at);
  }
}

interface Fixture {
  core: RecordingCore;
  engine: Engine;
  ledger: Ledger;
  root: string;
  ghostId: string;
  conversationId: string;
  faux: FauxProviderHandle;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "ghost-engine-"));
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const core = new RecordingCore({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, log: () => {} });
  ledger.tx(() => {
    ledger.putProvider({
      id: "faux",
      kind: "openai_compatible",
      name: "Faux",
      baseUrl: null,
      models: [{ id: "faux-1", name: "Faux 1" }],
      local: false,
    });
    ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
  });
  secrets.put("faux", "faux-key");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const engine = await createEngine({
    core,
    storagePath: join(root, "pi.db"),
    tools,
    sandbox,
    models,
    log: () => {},
  });
  core.attach(engine);
  const ghost = core.createGhost({ name: "Ghost", persona: "Be brief." });
  await core.idle();
  return { core, engine, ledger, root, ghostId: ghost.id, conversationId: ghost.directConversationId, faux };
}

/** The next message of a role, as the engine publishes it. */
function nextMessage(engine: Engine, conversationId: string, role: MessageRole): Promise<Message> {
  const { promise, resolve } = Promise.withResolvers<Message>();
  const stop = engine.watch(conversationId, (event) => {
    if (event.type !== "message" || event.message.role !== role) return;
    stop();
    resolve(event.message);
  });
  return promise;
}

/** The next live state that satisfies `wanted`. */
function nextLive(engine: Engine, conversationId: string, wanted: (live: Live) => boolean): Promise<Live> {
  const { promise, resolve } = Promise.withResolvers<Live>();
  const stop = engine.watch(conversationId, (event) => {
    if (event.type !== "live" || !wanted(event.live)) return;
    stop();
    resolve(event.live);
  });
  return promise;
}

test("a submission produces an assistant message in the transcript", async () => {
  const { engine, conversationId, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  const answered = nextMessage(engine, conversationId, "assistant");
  await engine.submit(conversationId, { text: "hi", origin: "owner", requestId: "r1" });
  const answer = await answered;
  expect(answer.text).toContain("hello there");
  const page = await engine.page(conversationId, null, 50);
  expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(page.messages[0]?.text).toBe("hi");
  expect(page.messages[0]?.origin).toBe("owner");
  await engine.close();
});

test("the same request id is admitted once", async () => {
  const { engine, conversationId, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  const answered = nextMessage(engine, conversationId, "assistant");
  await engine.submit(conversationId, { text: "hi", origin: "owner", requestId: "same" });
  await engine.submit(conversationId, { text: "hi", origin: "owner", requestId: "same" });
  await answered;
  const page = await engine.page(conversationId, null, 50);
  expect(page.messages.filter((message) => message.role === "user")).toHaveLength(1);
  await engine.close();
});

test("the engine reports a run as busy and then idle", async () => {
  const { core, engine, conversationId, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  const settled = nextLive(engine, conversationId, (live) => !live.running);
  await engine.submit(conversationId, { text: "hi", origin: "owner", requestId: "r1" });
  await settled;
  expect(core.activities.filter((entry) => entry.conversationId === conversationId).map((entry) => entry.busy)).toEqual([true, false]);
  await engine.close();
});

test("a run is reported as busy and idle without a watcher", async () => {
  const { core, engine, conversationId, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  const before = core.activityCount(conversationId);
  await engine.submit(conversationId, { text: "hi", origin: "owner", requestId: "r1" });
  expect(await core.nextActivity(conversationId, before)).toEqual({ busy: true });
  expect(await core.nextActivity(conversationId, before + 1)).toEqual({ busy: false });

  // A second run after the first settled, still without a watcher.
  faux.setResponses([fauxAssistantMessage(fauxText("hello again"))]);
  await engine.submit(conversationId, { text: "hi again", origin: "owner", requestId: "r2" });
  expect(await core.nextActivity(conversationId, before + 2)).toEqual({ busy: true });
  expect(await core.nextActivity(conversationId, before + 3)).toEqual({ busy: false });
  expect(core.activities.filter((entry) => entry.conversationId === conversationId).map((entry) => entry.busy)).toEqual([
    true,
    false,
    true,
    false,
  ]);
  await engine.close();
});

test("a tool call shows up as a tool message", async () => {
  const { engine, conversationId, faux } = await fixture();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", { text: "ping" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  const called = nextMessage(engine, conversationId, "tool");
  await engine.submit(conversationId, { text: "use the tool", origin: "owner", requestId: "r1" });
  const tool = await called;
  expect(tool.tool?.name).toBe("echo");
  expect(tool.text).toContain("echo:ping");
  const page = await engine.page(conversationId, null, 50);
  expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  await engine.close();
});

test("an origin survives a restart of the engine", async () => {
  const { core, engine, ledger, root, conversationId, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  const answered = nextMessage(engine, conversationId, "assistant");
  await engine.submit(conversationId, { text: "hi", origin: "schedule", requestId: "r1" });
  await answered;
  await engine.close();

  const models = createModels();
  const fauxAgain = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
  models.setProvider(fauxAgain.provider);
  const reopened = await createEngine({
    core,
    storagePath: join(root, "pi.db"),
    tools,
    sandbox,
    models,
    log: () => {},
  });
  core.attach(reopened);
  const page = await reopened.page(conversationId, null, 50);
  const user = page.messages.find((message) => message.role === "user");
  expect(user?.origin).toBe("schedule");
  expect(user?.text).toBe("hi");
  await reopened.close();
  ledger.close();
});

test("a local conversation refuses a provider that is not local", async () => {
  const { core, engine, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  const local = core.createDirectConversation(core.ledger.ghosts()[0]!.id, "local chat", "local");
  await core.idle();
  let refusal: unknown;
  try {
    await engine.submit(local.id, { text: "hi", origin: "owner", requestId: "r1" });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(CommandError);
  expect((refusal as CommandError).code).toBe("unavailable");
  const page = await engine.page(local.id, null, 50);
  expect(page.messages).toHaveLength(0);
  await engine.close();
});

test("the transcript pages backwards", async () => {
  const { engine, conversationId, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  const answered = nextMessage(engine, conversationId, "assistant");
  await engine.submit(conversationId, { text: "hi", origin: "owner", requestId: "r1" });
  await answered;
  const newest = await engine.page(conversationId, null, 1);
  expect(newest.messages.map((message) => message.role)).toEqual(["assistant"]);
  expect(newest.before).not.toBeNull();
  const older = await engine.page(conversationId, newest.before, 1);
  expect(older.messages.map((message) => message.role)).toEqual(["user"]);
  expect(older.before).toBeNull();
  await engine.close();
});

test("imported history is in the transcript without a model call", async () => {
  const { engine, conversationId } = await fixture();
  await engine.appendHistory(conversationId, [
    { role: "user", text: "what is the weather?", at: 1_700_000_000_000 },
    { role: "assistant", text: "it is raining", at: 1_700_000_001_000 },
  ]);
  const page = await engine.page(conversationId, null, 50);
  expect(page.messages.map((message) => message.text)).toEqual(["what is the weather?", "it is raining"]);
  expect(page.messages.every((message) => message.origin === null)).toBe(true);
  await engine.close();
});

test("the engine is ready when the default provider has a credential", async () => {
  const { engine } = await fixture();
  expect(engine.status()).toEqual({ ready: true, detail: "provider faux is ready" });
  await engine.close();
});

test("the model catalog follows the configured providers", async () => {
  const secrets = new MemorySecrets();
  secrets.put("faux", "faux-key");
  const settings = {
    defaultModel: { provider: "faux", model: "faux-1" },
    reviewModel: null,
    providers: [
      {
        id: "faux",
        kind: "openai_compatible" as const,
        name: "Faux",
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "faux-1", name: "Faux 1" }],
        local: false,
        hasCredential: false,
      },
    ],
  };
  const models = buildModels(settings, secrets);
  expect(models.getModel("faux", "faux-1")?.baseUrl).toBe("http://127.0.0.1:9/v1");
  expect(await models.getAuth("faux")).toEqual({ auth: { apiKey: "faux-key" }, source: "Ghost secrets" });
  applyProviders(models, { ...settings, providers: [] }, secrets);
  expect(models.getProviders()).toHaveLength(0);
});
