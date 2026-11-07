import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Type, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Live, Message, MessageRole } from "@ghost/contract";
import { GHOST_TOOLS, parseInteractiveUi, readInteractiveUi } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { createToolSet } from "../src/tools/index.ts";
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
  release: async () => {},
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

async function fixture(toolFactory: (core: Core) => ToolSet = () => tools): Promise<Fixture> {
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
    tools: toolFactory(core),
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

test("present_ui persists through the real tool journal without optional privileges, alongside ordinary text", async () => {
  const { core, engine, ledger, root, faux } = await fixture(
    (core) => createToolSet({ core, sandbox, memory: null, documents: null }),
  );
  let active: Engine | null = engine;
  const ghost = core.createGhost({ name: "Presenter", persona: "사용자의 자료를 그대로 보여 주세요.", tools: [] });
  await core.idle();
  const ui = parseInteractiveUi({
    version: "ghost-ui/1",
    title: "사용자가 제공한 과일 수량",
    blocks: [
      { type: "text", id: "source", text: "출처: 이 대화에서 사용자가 제공한 수량입니다." },
      { type: "chart", id: "fruit", title: "과일 수량", kind: "bar", unit: "개", series: [{ name: "수량", points: [{ label: "사과", value: 2 }, { label: "배", value: 3 }] }] },
      { type: "choices", id: "next", title: "다음 보기", options: [{ id: "table", label: "표로 보기" }, { id: "keep", label: "차트 유지" }] },
      { type: "html", id: "large", title: "큰 정적 응답", html: `<p>${"가".repeat(20000)}</p>` },
    ],
  });
  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("present_ui", ui), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("다른 자료가 있으면 알려 주세요.")),
    ]);
    const called = nextMessage(engine, ghost.directConversationId, "tool");
    const settled = core.nextActivity(ghost.directConversationId, core.activityCount(ghost.directConversationId) + 1);
    await core.sendMessage(ghost.directConversationId, "사과 2개와 배 3개를 차트로 보여 주세요.", "ui-request");
    const result = await called;
    await settled;
    expect(new TextEncoder().encode(result.text).byteLength).toBe(new TextEncoder().encode(JSON.stringify(ui)).byteLength);
    expect(result.tool?.name).toBe("present_ui");
    expect(result.tool?.isError).toBeFalsy();
    expect(result.text).toBe(JSON.stringify(ui));
    expect(readInteractiveUi(result.text)).toEqual(ui);
    expect(ledger.ghost(ghost.id).tools).toEqual([]);
    expect(ledger.worksForState()).toHaveLength(0);
    await engine.close();
    active = null;

    const models = createModels();
    const restartedProvider = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
    models.setProvider(restartedProvider.provider);
    active = await createEngine({
      core,
      storagePath: join(root, "pi.db"),
      tools: createToolSet({ core, sandbox, memory: null, documents: null }),
      sandbox,
      models,
      log: () => {},
    });
    core.attach(active);
    const page = await active.page(ghost.directConversationId, null, 50);
    const persisted = page.messages.find((message) => message.role === "tool" && message.tool?.name === "present_ui");
    expect(persisted?.id).toBe(result.id);
    expect(persisted?.text).toBe(JSON.stringify(ui));
    expect(readInteractiveUi(persisted!.text)).toEqual(ui);
    expect(page.messages.some((message) => message.role === "assistant" && message.text === "다른 자료가 있으면 알려 주세요.")).toBe(true);
  } finally {
    core.stop();
    await core.idle();
    await active?.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
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

test("changing the main Ghost transfers real management authority without restarting conversations", async () => {
  const { core, engine, ledger, root, ghostId, conversationId, faux } = await fixture(
    (core) => createToolSet({ core, sandbox, memory: null, documents: null }),
  );
  const helper = core.createGhost({ name: "Helper", persona: "Original helper.", tools: [] });
  await core.idle();
  const manage = async (actor: string, target: string, persona: string) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ghost_update", { ghost_id: target, persona }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("finished")),
    ]);
    const toolResult = nextMessage(engine, actor, "tool");
    const settled = core.nextActivity(actor, core.activityCount(actor) + 1);
    await core.sendMessage(actor, "Update the requested Ghost.", crypto.randomUUID());
    await toolResult;
    await settled;
  };
  try {
    await manage(conversationId, helper.id, "Managed before the switch.");
    expect(ledger.ghost(helper.id).persona).toBe("Managed before the switch.");

    await execute(core, new Access(ledger, { kind: "owner" }), {
      requestId: crypto.randomUUID(),
      command: { type: "ghost.set_default", ghostId: helper.id },
    }, { publicOrigin: "http://localhost", documents: null });
    await core.idle();

    await manage(conversationId, helper.id, "Unauthorized former main.");
    expect(ledger.ghost(helper.id).persona).toBe("Managed before the switch.");
    await manage(helper.directConversationId, ghostId, "Managed by the new main.");
    expect(ledger.ghost(ghostId).persona).toBe("Managed by the new main.");
    await manage(helper.directConversationId, helper.id, "Unauthorized self edit.");
    expect(ledger.ghost(helper.id).persona).toBe("Managed before the switch.");
  } finally {
    core.stop();
    await core.idle();
    await engine.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real model request offers only granted selectable tools after live permission changes", async () => {
  const { core, engine, ledger, root, faux } = await fixture(
    (core) => createToolSet({ core, sandbox, memory: null, documents: null }),
  );
  const helper = core.createGhost({ name: "Restricted", persona: "Only use granted tools.", tools: [] });
  await core.idle();
  const offered = async (): Promise<string[]> => {
    let names: string[] = [];
    faux.setResponses([(context) => {
      const available = new Set<string>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsRemoved ?? []) available.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) available.add(tool.name);
      }
      names = [...available].filter((name) => GHOST_TOOLS.some((tool) => tool === name)).sort();
      return fauxAssistantMessage(fauxText("finished"));
    }]);
    const answered = nextMessage(engine, helper.directConversationId, "assistant");
    const settled = core.nextActivity(helper.directConversationId, core.activityCount(helper.directConversationId) + 1);
    await core.sendMessage(helper.directConversationId, "What can you do?", crypto.randomUUID());
    await answered;
    await settled;
    return names;
  };
  const update = async (tools: [] | ["work_list"]) => {
    await execute(core, new Access(ledger, { kind: "owner" }), {
      requestId: crypto.randomUUID(),
      command: { type: "ghost.update", ghostId: helper.id, tools },
    }, { publicOrigin: "http://localhost", documents: null });
    await core.idle();
  };
  try {
    expect(await offered()).toEqual([]);
    await update(["work_list"]);
    expect(await offered()).toEqual(["work_list"]);
    await update([]);
    expect(await offered()).toEqual([]);
  } finally {
    core.stop();
    await core.idle();
    await engine.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
