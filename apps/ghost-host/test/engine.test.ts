import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Type, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxProviderHandle, type UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool, type LiveState } from "@earendil-works/pi-durable";
import type { Live, Message, MessageRole } from "@ghost/contract";
import { GHOST_TOOLS, parseInteractiveUi, readInteractiveUi } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { Access } from "../src/core/access.ts";
import { execute, settingsView } from "../src/core/commands.ts";
import { createToolSet } from "../src/tools/index.ts";
import { CommandError } from "../src/core/errors.ts";
import { createEngine } from "../src/engine/index.ts";
import { cutAttachmentBlock, liveFrom, renderUserContent, sameLive } from "../src/engine/messages.ts";
import { applyProviders, buildModels } from "../src/engine/models.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { Engine } from "../src/core/ports.ts";
import type { SandboxEnvFactory } from "../src/integrations/ports.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";
import { ProviderCatalog } from "../src/integrations/provider-catalog.ts";
import { createDocuments } from "../src/integrations/documents.ts";

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
  readonly activityLog: { conversationId: string; busy: boolean }[] = [];
  private readonly waits: (() => boolean)[] = [];

  /** How many activities a conversation has seen so far. */
  activityCount(conversationId: string): number {
    return this.activityLog.filter((entry) => entry.conversationId === conversationId).length;
  }

  /** The activity of a conversation at position `after`, once the engine reports it. */
  nextActivity(conversationId: string, after: number): Promise<{ busy: boolean }> {
    const { promise, resolve } = Promise.withResolvers<{ busy: boolean }>();
    const deliver = () => {
      const entries = this.activityLog.filter((entry) => entry.conversationId === conversationId);
      const entry = entries[after];
      if (!entry) return false;
      resolve({ busy: entry.busy });
      return true;
    };
    if (!deliver()) this.waits.push(deliver);
    return promise;
  }

  override activity(conversationId: string, busy: boolean, at: number) {
    this.activityLog.push({ conversationId, busy });
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
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", input: ["text", "image"] }] });
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

test("owner attachment bytes reach the model as images and fenced text, while binary remains a reference", async () => {
  const { core, engine, ledger, root, conversationId, faux } = await fixture();
  try {
    const png = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=");
    const attachments = [
      await core.artifacts.put(png, "pixel.png", "image/png"),
      await core.artifacts.put(new TextEncoder().encode("실제 파일 내용\n```not a closing fence"), "notes.txt", "text/plain"),
      await core.artifacts.put(new Uint8Array([0, 255, 42]), "unknown.bin", "application/octet-stream"),
    ];
    let input: UserMessage["content"] | undefined;
    faux.setResponses([(context) => {
      input = context.messages.find((message) => message.role === "user")?.content as UserMessage["content"] | undefined;
      return fauxAssistantMessage(fauxText("첨부 확인"));
    }]);
    const answered = nextMessage(engine, conversationId, "assistant");
    await core.sendMessage(conversationId, "첨부를 봐 주세요", "attachments", attachments);
    await answered;
    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) throw new Error("expected multimodal input");
    expect(input).toContainEqual({ type: "image", mimeType: "image/png", data: Buffer.from(png).toString("base64") });
    const text = input.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    expect(text).toContain('File: "notes.txt"\n````\n실제 파일 내용');
    expect(text).toContain(`- unknown.bin (application/octet-stream, sha256:${attachments[2]!.digest})`);
    expect(text).not.toContain('File: "unknown.bin"');
    const page = await engine.page(conversationId, null, 50);
    const owner = page.messages.find((message) => message.role === "user");
    expect(owner?.text).toBe("첨부를 봐 주세요");
    expect(owner?.attachments).toEqual(attachments);
  } finally {
    core.stop();
    await core.idle();
    await engine.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment previews bound text and images and only inline valid UTF-8", async () => {
  const store = new MemoryArtifacts();
  const attachments = [
    await store.put(new TextEncoder().encode("a".repeat(100 * 1024 - 1) + "한" + "hidden"), "long.md", "application/octet-stream"),
    await store.put(new TextEncoder().encode("export const value = 42;"), "source.ts", "application/octet-stream"),
    await store.put(new Uint8Array([255, 254]), "invalid.txt", "text/plain"),
    await store.put(new Uint8Array(5 * 1024 * 1024 + 1), "large.png", "image/png"),
  ];
  const content = await renderUserContent("owner", attachments, store);
  expect(typeof content).toBe("string");
  expect(content).toContain('[첨부 일부 생략: "long.md" — 처음 102400바이트만 포함]');
  expect(content).not.toContain("hidden");
  expect(content).not.toContain("\ufffd");
  expect(content).toContain("export const value = 42;");
  expect(content).not.toContain('File: "invalid.txt"');
  expect(content).toContain("- large.png (image/png, sha256:");
  expect(content).toContain('[첨부 생략: "invalid.txt" — UTF-8 텍스트가 아님]');
  expect(content).toContain('[첨부 생략: "large.png" — 이미지 크기 제한');
  expect(cutAttachmentBlock(content as string)).toBe("owner");
});

test("attachment budgets use stored sizes, bound reads, and explain every omission", async () => {
  class RecordingArtifacts extends MemoryArtifacts {
    readonly reads: { digest: string; maxBytes: number | undefined }[] = [];
    override async read(digest: string, maxBytes?: number) {
      this.reads.push({ digest, maxBytes });
      return super.read(digest, maxBytes);
    }
  }
  const store = new RecordingArtifacts();
  const image = new Uint8Array(4 * 1024 * 1024);
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const first = await store.put(image, "first.jpg", "image/jpeg");
  const second = { ...first, name: "second.png" };
  const third = { ...first, name: "third.png" };
  const oversized = await store.put(new Uint8Array(4 * 1024 * 1024 + 1), "oversized.png", "image/png");
  const invalid = await store.put(new TextEncoder().encode("not an image"), "invalid.png", "image/png");
  const text = await store.put(new TextEncoder().encode("t".repeat(100 * 1024)), "first.txt", "text/plain");
  const binary = await store.put(new Uint8Array([0, 255]), "unknown.bin", "application/octet-stream");
  const content = await renderUserContent("owner", [
    { ...oversized, size: 1 }, first, second, third, invalid, text,
    { ...text, name: "second.txt" }, { ...text, name: "third.txt" }, binary,
  ], store);
  if (!Array.isArray(content)) throw new Error("expected image parts");
  const images = content.filter((part) => part.type === "image");
  expect(images).toHaveLength(2);
  expect(images.every((part) => part.mimeType === "image/png")).toBe(true);
  const rendered = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  expect(rendered).toContain('[첨부 생략: "oversized.png" — 이미지 크기 제한');
  expect(rendered).toContain('[첨부 생략: "third.png" — 이미지 크기 제한');
  // Once the image budget is spent, even an invalid candidate is skipped before reading.
  expect(rendered).toContain('[첨부 생략: "invalid.png" — 이미지 크기 제한');
  expect(rendered).toContain('[첨부 생략: "third.txt" — 메시지 텍스트 크기 제한');
  expect(rendered).toContain('[첨부 생략: "unknown.bin" — 지원하지 않는 파일 형식');
  expect(store.reads).toEqual([
    { digest: first.digest, maxBytes: 4 * 1024 * 1024 },
    { digest: first.digest, maxBytes: 4 * 1024 * 1024 },
    { digest: text.digest, maxBytes: 100 * 1024 },
    { digest: text.digest, maxBytes: 100 * 1024 },
  ]);
  const mismatched = await renderUserContent("owner", [invalid], store);
  expect(mismatched).toContain('[첨부 생략: "invalid.png" — 지원하는 이미지 형식이 아님]');
});

test("image magic bytes determine the provider media type", async () => {
  const store = new MemoryArtifacts();
  const headers = [
    { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: "image/png" },
    { bytes: [0xff, 0xd8, 0xff], type: "image/jpeg" },
    { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], type: "image/gif" },
    { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], type: "image/gif" },
    { bytes: [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], type: "image/webp" },
  ];
  for (const header of headers) {
    const artifact = await store.put(new Uint8Array(header.bytes), "mislabelled.png", "image/png");
    const content = await renderUserContent("owner", [artifact], store);
    expect(content).toContainEqual({ type: "image", mimeType: header.type, data: Buffer.from(header.bytes).toString("base64") });
  }
});

test("static model capabilities downgrade images for text-only and unknown models, not vision models", async () => {
  const requests: { model: string; messages: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json() as { model: string; messages: unknown });
      const frame = (delta: Record<string, unknown>, finishReason: string | null) => `data: ${JSON.stringify({
        id: "attachment-modalities", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
      return new Response(frame({ role: "assistant", content: "received" }, null) + frame({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const secrets = new MemorySecrets();
    secrets.put("compatible", "key");
    secrets.put("zai", "key");
    const settings = {
      defaultModel: null,
      reviewModel: null,
      providers: [
        { id: "compatible", kind: "openai_compatible" as const, name: "Compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: "gpt-4.1", name: "Vision" }, { id: "unknown", name: "Unknown" }], hasCredential: true },
        { id: "zai", kind: "zai" as const, name: "Z.AI", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [{ id: "glm-5.3", name: "Text" }], hasCredential: true },
      ],
    };
    const models = buildModels(settings, secrets);
    const original: UserMessage = { role: "user", timestamp: 1, content: [
      { type: "text", text: "Read the image" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" },
    ] };
    for (const [provider, id, vision] of [["zai", "glm-5.3", false], ["compatible", "unknown", false], ["compatible", "gpt-4.1", true]] as const) {
      const model = models.getModel(provider, id);
      if (!model) throw new Error(`missing ${id}`);
      expect(model.input.includes("image")).toBe(vision);
      const result = await models.completeSimple(model, { messages: [original] });
      expect(result.stopReason).toBe("stop");
      const request = JSON.stringify(requests.at(-1));
      expect(request.includes('"image_url"')).toBe(vision);
      expect(request.includes("(image omitted: model does not support images)")).toBe(!vision);
      // Provider conversion must not remove the persisted original image.
      expect(original.content).toContainEqual(expect.objectContaining({ type: "image" }));
    }
  } finally {
    server.stop(true);
  }
});

test("reasoning stays on the assistant message, apart from its text", async () => {
  const { engine, conversationId, faux } = await fixture();
  faux.setResponses([fauxAssistantMessage([fauxThinking("weighing two options"), fauxText("option two")])]);
  const answered = nextMessage(engine, conversationId, "assistant");
  await engine.submit(conversationId, { text: "pick one", origin: "owner", requestId: "r1" });
  const answer = await answered;
  expect(answer.thinking).toBe("weighing two options");
  expect(answer.text).toBe("option two");
  const page = await engine.page(conversationId, null, 50);
  expect(page.messages.find((message) => message.role === "assistant")?.thinking).toBe("weighing two options");
  expect(page.messages.find((message) => message.role === "user")?.thinking).toBeUndefined();
  await engine.close();
});

test("the live state streams reasoning separately and ignores redacted blocks", () => {
  const generation = (content: unknown[]) => ({ run: {}, generation: { message: { role: "assistant", content } }, tools: [] }) as unknown as LiveState;
  const thinking = liveFrom(generation([{ type: "thinking", thinking: "first step" }]), "c1");
  expect(thinking).toMatchObject({ running: true, partial: null, thinking: "first step" });
  const answering = liveFrom(generation([{ type: "thinking", thinking: "first step" }, { type: "text", text: "done" }]), "c1");
  expect(answering).toMatchObject({ partial: "done", thinking: "first step" });
  expect(sameLive(thinking, answering)).toBe(false);
  expect(liveFrom(generation([{ type: "thinking", thinking: "secret", redacted: true }]), "c1").thinking).toBeUndefined();
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
  expect(core.activityLog.filter((entry) => entry.conversationId === conversationId).map((entry) => entry.busy)).toEqual([true, false]);
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
  expect(core.activityLog.filter((entry) => entry.conversationId === conversationId).map((entry) => entry.busy)).toEqual([
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
    (core) => createToolSet({ core, sandbox, memory: null, documents: null, skills: null }),
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
      tools: createToolSet({ core, sandbox, memory: null, documents: null, skills: null }),
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

test("project context reaches the model while original text and chips survive restart and project deletion", async () => {
  const { core, engine, ledger, root, conversationId, faux } = await fixture();
  let active = engine;
  try {
    ledger.tx(() => ledger.putSpace({ id: "project", name: "비행 기록", path: root, createdAt: 1 }));
    let modelInput = "";
    faux.setResponses([(context) => {
      modelInput = String(context.messages.find(message => message.role === "user")?.content);
      return fauxAssistantMessage(fauxText("확인했어요"));
    }]);
    const answered = nextMessage(active, conversationId, "assistant");
    const settled = core.nextActivity(conversationId, core.activityCount(conversationId) + 1);
    await core.sendMessage(conversationId, "계획을 알려줘", "project-message", [], ["project"]);
    await answered;
    await settled;
    expect(modelInput).toContain('"name":"비행 기록","spaceId":"project"');
    expect(modelInput).toContain("document_list and document_read");
    expect(modelInput.endsWith("계획을 알려줘")).toBe(true);
    ledger.tx(() => ledger.deleteSpace("project"));
    await active.close();
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] }).provider);
    active = await createEngine({ core, storagePath: join(root, "pi.db"), tools, sandbox, models, log: () => {} });
    core.attach(active);
    const owner = (await active.page(conversationId, null, 50)).messages.find(message => message.origin === "owner");
    expect(owner?.text).toBe("계획을 알려줘");
    expect(owner?.spaces).toEqual([{ id: "project", name: "비행 기록" }]);
  } finally {
    core.stop(); await core.idle(); await active.close(); ledger.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a Ghost can propose in any project but still opens owner review without writing", async () => {
  const { core, engine, ledger, root, conversationId, faux } = await fixture(
    core => createToolSet({ core, sandbox, memory: null, documents: createDocuments(core), skills: null }),
  );
  try {
    ledger.tx(() => ledger.putSpace({ id: "project", name: "Docs", path: root, createdAt: 1 }));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("document_propose", { space_id: "project", title: "Plan", body: "Proposed body" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("검토를 기다려요")),
    ]);
    const called = nextMessage(engine, conversationId, "tool");
    const settled = core.nextActivity(conversationId, core.activityCount(conversationId) + 1);
    await core.sendMessage(conversationId, "계획을 제안해줘", "project-proposal");
    const result = await called;
    await settled;
    expect(result.tool?.isError).toBe(false);
    expect(result.text).toContain("awaiting owner review");
    expect(ledger.pendingDecisions()).toContainEqual(expect.objectContaining({ kind: "document_review", state: "pending" }));
    expect(await createDocuments(core).listPages("project", null)).toEqual([]);
  } finally {
    core.stop(); await core.idle(); await engine.close(); ledger.close(); rmSync(root, { recursive: true, force: true });
  }
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

test("a catalog refresh makes a newly released model executable without rewriting saved models or replaying turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-live-catalog-"));
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const catalog = new ProviderCatalog({
    fetch: (async () => Response.json({
      "zai-coding-plan": { id: "zai-coding-plan", models: {
        "glm-future": {
          id: "glm-future", name: "GLM Future", tool_call: true, reasoning: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 262_144, output: 16_384 },
        },
      } },
    })),
  });
  const core = new RecordingCore({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, catalog, log: () => {} });
  ledger.tx(() => {
    ledger.putProvider({ id: "zai", kind: "zai", name: "Z.AI", baseUrl: null, models: [{ id: "legacy-manual", name: "Legacy" }] });
    ledger.putSetting("defaultModel", { provider: "zai", model: "legacy-manual" });
  });
  secrets.put("zai", "private-key");
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://api.z.ai/api/coding/paas/v4/chat/completions") return originalFetch(input, init);
    const body = input instanceof Request ? await input.json() : JSON.parse(String(init?.body));
    requests.push(body);
    const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
      id: "catalog-response", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
    return new Response(frame({ role: "assistant", content: "catalog answer" }, null) + frame({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  let engine: Engine | undefined;
  try {
    engine = await createEngine({ core, storagePath: join(root, "pi.db"), tools, sandbox, log: () => {} });
    core.attach(engine);
    const ghost = core.createGhost({ name: "Catalog Ghost", persona: "" });
    await core.idle();
    const first = nextMessage(engine, ghost.directConversationId, "assistant");
    await core.sendMessage(ghost.directConversationId, "first turn", "before-refresh");
    await first;
    const refreshed = Promise.withResolvers<void>();
    catalog.start(() => {
      ledger.tx(() => ledger.emit({ type: "settings", settings: settingsView(core) }));
      refreshed.resolve();
    });
    await refreshed.promise;
    expect(requests).toHaveLength(1);
    expect(ledger.settings().providers[0]?.models).toEqual([{ id: "legacy-manual", name: "Legacy" }]);
    const projected = settingsView(core).providers[0];
    expect(projected?.models.find(model => model.id === "glm-future")).toMatchObject({
      input: ["text", "image"], reasoning: true, contextWindow: 262_144, maxTokens: 16_384,
    });
    const executable = buildModels(ledger.settings(), secrets, catalog).getModel("zai", "glm-future");
    expect(executable).toMatchObject({ input: ["text", "image"], reasoning: true, contextWindow: 262_144, maxTokens: 16_384 });
    await execute(core, new Access({ kind: "owner" }), {
      requestId: crypto.randomUUID(), command: { type: "settings.update", defaultModel: { provider: "zai", model: "glm-future", thinking: "high" } },
    }, { publicOrigin: "http://localhost", documents: null });
    await core.idle();
    const image = await core.artifacts.put(Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), "pixel.png", "image/png");
    const next = nextMessage(engine, ghost.directConversationId, "assistant");
    await engine.submit(ghost.directConversationId, { text: "inspect", attachments: [image], origin: "owner", requestId: "after-refresh" });
    await next;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ model: "glm-future", thinking: { type: "enabled" } });
    expect(JSON.stringify(requests[1]?.messages)).toContain('"image_url"');
  } finally {
    await catalog.close();
    await core.codexCatalog.close();
    core.stop();
    await core.idle();
    await engine?.close();
    globalThis.fetch = originalFetch;
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
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
    (core) => createToolSet({ core, sandbox, memory: null, documents: null, skills: null }),
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

    await execute(core, new Access({ kind: "owner" }), {
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
    (core) => createToolSet({ core, sandbox, memory: null, documents: null, skills: null }),
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
    await execute(core, new Access({ kind: "owner" }), {
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
