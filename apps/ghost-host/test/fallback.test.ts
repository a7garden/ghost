import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ModelRef } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { createEngine } from "../src/engine/index.ts";
import { fallbackReason } from "../src/engine/fallback.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { WorkspaceEnv } from "../src/sandbox/workspace-env.ts";
import { MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const primary: ModelRef = { provider: "primary", model: "primary-1" };
const backup: ModelRef = { provider: "backup", model: "backup-1" };
const error = (reason: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage: reason });

/** Isolate engine run settlement from Work's idle-nudge policy. */
class RunCore extends Core {
  private readonly ended = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  count(id: string) { return this.ended.get(id) ?? 0; }
  settled(id: string, after = this.count(id)): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => {
      if (this.count(id) <= after) return;
      this.listeners.delete(check);
      resolve();
    };
    this.listeners.add(check);
    check();
    return promise;
  }
  override activity(id: string, busy: boolean, _at: number) {
    if (busy) return;
    this.ended.set(id, this.count(id) + 1);
    for (const listener of this.listeners) listener();
  }
}

async function fixture(fallbacks: ModelRef[] = [backup], missing: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "ghost-fallback-"));
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const core = new RunCore({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, log: () => {} });
  const models = createModels();
  const providers = [primary, backup, { provider: "third", model: "third-1" }].map((ref) => {
    const faux = fauxProvider({ provider: ref.provider, models: [{ id: ref.model, name: ref.model }] });
    models.setProvider(faux.provider);
    ledger.tx(() => ledger.putProvider({ id: ref.provider, kind: "openai_compatible", name: ref.provider, baseUrl: null, models: [{ id: ref.model, name: ref.model }] }));
    if (!missing.includes(ref.provider)) secrets.put(ref.provider, "test-key");
    return faux;
  });
  ledger.tx(() => ledger.putSetting("defaultModel", primary));
  let toolCalls = 0;
  const extension = defineExtension({ name: "ghost.fallback-test", tools: [defineTool({
    name: "count_effect", description: "Record one external effect.", parameters: Type.Object({}), replay: "unsafe",
    execute: async () => { toolCalls++; return { content: [{ type: "text", text: "effect recorded" }] }; },
  })] });
  const logs: string[] = [];
  const engine = await createEngine({
    core, storagePath: join(root, "pi.db"), models,
    sandbox: {
      envFor: async () => new WorkspaceEnv({ hostRoot: root, id: "fallback-test" }),
      workspacePath: () => root,
      stageInputs: async () => {},
      release: async () => {},
    },
    tools: { all: () => [extension], extensionsFor: () => [extension], instructionsFor: () => "Answer briefly." },
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } },
    log: (message) => logs.push(message),
  });
  core.attach(engine);
  const ghost = core.createGhost({ name: "Fallback Ghost", persona: "Be brief.", fallbacks });
  await core.idle();
  return {
    core, engine, ledger, ghost, logs, providers, secrets,
    toolCalls: () => toolCalls,
    async send(text = "answer", requestId: string = crypto.randomUUID()) {
      const settled = core.settled(ghost.directConversationId);
      await engine.submit(ghost.directConversationId, { text, requestId, origin: "owner" });
      await settled;
    },
    async raw(id = ghost.directConversationId) {
      // Read Pi's committed metadata through its public API, not the host projection.
      await engine.close();
      const harness = await Harness.open(await openNodeSqliteStorage(join(root, "pi.db")), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
      try {
        const conversation = await harness.conversation(Number(ledger.piConversationId(id)) as ConversationId, BACKGROUND_CONTEXT);
        return (await conversation!.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
      } finally { await harness.close(BACKGROUND_CONTEXT); }
    },
    async close() {
      core.stop(); await core.idle(); await engine.close(); ledger.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}

test("exhausted 429 falls back once without duplicating input; next turn returns to primary", async () => {
  const f = await fixture();
  try {
    f.providers[0]!.setResponses([error("429 rate limit"), error("429 rate limit")]);
    f.providers[1]!.setResponses([fauxAssistantMessage("backup answer")]);
    await f.send("one input", "same-request");
    let page = await f.engine.page(f.ghost.directConversationId, null, 50);
    expect(page.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(page.messages.filter((message) => message.role === "assistant" && message.text)).toHaveLength(1);
    expect(page.messages.at(-1)?.text).toBe("backup answer");
    expect(f.providers[0]!.getPendingResponseCount()).toBe(0); // Pi exhausted its own retry first.
    expect(f.logs.filter((line) => line.startsWith("fallback:"))).toHaveLength(1);
    await f.engine.submit(f.ghost.directConversationId, { text: "one input", requestId: "same-request", origin: "owner" });
    f.providers[0]!.setResponses([fauxAssistantMessage("primary again")]);
    await f.send("next input");
    page = await f.engine.page(f.ghost.directConversationId, null, 50);
    expect(page.messages.at(-1)?.text).toBe("primary again");
    const raw = await f.raw();
    const replies = raw.flatMap((entry) => entry.model ?? []).filter((message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "stop");
    expect(replies.map((message) => ({ provider: message.provider, model: message.model }))).toEqual([
      { provider: "primary", model: "primary-1" }, { provider: "backup", model: "backup-1" },
    ]);
  } finally { await f.close(); }
});

for (const [name, fallbacks, reason] of [
  ["empty fallback list preserves error", [], "429 rate limit"],
  ["invalid request does not fall back", [backup], "400 invalid request"],
  ["context overflow does not fall back", [backup], "maximum context length exceeded"],
] as const) {
  test(name, async () => {
    const f = await fixture([...fallbacks]);
    try {
      f.providers[0]!.setResponses([error(reason), error(reason)]);
      f.providers[1]!.setResponses([fauxAssistantMessage("must not run")]);
      await f.send();
      expect(f.logs.filter((line) => line.startsWith("fallback:"))).toHaveLength(0);
      expect(f.providers[1]!.getPendingResponseCount()).toBe(1);
      const raw = await f.raw();
      expect(raw.flatMap((entry) => entry.model ?? []).some((message) => message.role === "assistant" && message.stopReason === "error" && message.errorMessage === reason)).toBe(true);
    } finally { await f.close(); }
  });
}

test("work fallback retains completed unsafe tool results without replay", async () => {
  const f = await fixture();
  try {
    f.providers[0]!.setResponses([
      fauxAssistantMessage(fauxToolCall("count_effect", {}), { stopReason: "toolUse" }),
      error("429 rate limit"), error("429 rate limit"),
    ]);
    f.providers[1]!.setResponses([(context) => {
      expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
      return fauxAssistantMessage("finished with recorded effect");
    }]);
    const work = f.core.works.createRoot({ ghostId: f.ghost.id, originConversationId: f.ghost.directConversationId, title: "Effect", brief: "Record one effect." });
    await f.core.idle();
    const conversationId = f.ledger.work(work.id).conversationId!;
    if (f.core.count(conversationId) === 0) await f.core.settled(conversationId);
    const page = await f.engine.page(conversationId, null, 50);
    expect(f.ledger.conversation(conversationId).kind).toBe("work");
    expect(f.toolCalls()).toBe(1);
    expect(page.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(page.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(page.messages.at(-1)?.text).toBe("finished with recorded effect");
  } finally { await f.close(); }
});

test("missing credentials are skipped and an exhausted fallback advances in order", async () => {
  const third = { provider: "third", model: "third-1" };
  const f = await fixture([backup, third], ["primary"]);
  try {
    f.providers[1]!.setResponses([error("insufficient_quota: billing exhausted")]);
    f.providers[2]!.setResponses([fauxAssistantMessage("third answer")]);
    await f.send();
    expect(f.logs.filter((line) => line.startsWith("fallback:"))).toHaveLength(2);
    expect((await f.engine.page(f.ghost.directConversationId, null, 50)).messages.at(-1)?.text).toBe("third answer");
  } finally { await f.close(); }
});

test("a fallback provider without credentials is skipped", async () => {
  const f = await fixture([backup, { provider: "third", model: "third-1" }], ["backup"]);
  try {
    f.providers[0]!.setResponses([error("503 unavailable"), error("503 unavailable")]);
    f.providers[1]!.setResponses([fauxAssistantMessage("must not run")]);
    f.providers[2]!.setResponses([fauxAssistantMessage("third answer")]);
    await f.send();
    expect(f.providers[1]!.getPendingResponseCount()).toBe(1);
    expect((await f.engine.page(f.ghost.directConversationId, null, 50)).messages.at(-1)?.text).toBe("third answer");
    expect(f.logs.filter((line) => line.startsWith("fallback:"))).toHaveLength(1);
  } finally { await f.close(); }
});

test("exhausting every fallback leaves the final error", async () => {
  const f = await fixture();
  try {
    f.providers[0]!.setResponses([error("429 rate limit"), error("429 rate limit")]);
    f.providers[1]!.setResponses([error("insufficient_quota")]);
    await f.send();
    expect(f.logs.filter((line) => line.startsWith("fallback:"))).toHaveLength(1);
    const raw = await f.raw();
    const final = raw.flatMap((entry) => entry.model ?? []).find((message) => message.role === "assistant");
    expect(final).toMatchObject({ provider: "backup", model: "backup-1", stopReason: "error", errorMessage: "insufficient_quota" });
  } finally { await f.close(); }
});

test("an explicitly selected conversation model never falls back", async () => {
  const f = await fixture();
  try {
    f.ledger.tx(() => f.ledger.putConversation({ ...f.ledger.conversation(f.ghost.directConversationId), model: primary }));
    f.providers[0]!.setResponses([error("503 unavailable"), error("503 unavailable")]);
    f.providers[1]!.setResponses([fauxAssistantMessage("must not run")]);
    await f.send();
    expect(f.logs.filter((line) => line.startsWith("fallback:"))).toHaveLength(0);
    expect(f.providers[1]!.getPendingResponseCount()).toBe(1);
  } finally { await f.close(); }
});

test("fallback classification includes provider failures, but rejects bad requests and overflow", () => {
  for (const reason of ["529 overloaded", "503 service unavailable", "insufficient_quota", "billing exhausted", "fetch failed", "ECONNRESET", "No API key found for provider"]) {
    expect(fallbackReason(error(reason) as AssistantMessage)).toBe(reason);
  }
  for (const reason of ["400 invalid request", "maximum context length exceeded", "invalid_request_error: too many tokens"]) {
    expect(fallbackReason(error(reason) as AssistantMessage)).toBeNull();
  }
});
