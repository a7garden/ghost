import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Provider, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelInfo, Provider as ContractProvider, Thinking } from "@ghost/contract";
import { createHostProvider } from "../src/engine/models.ts";
import { ProviderCatalog } from "../src/integrations/provider-catalog.ts";

const providerOf = (kind: ContractProvider["kind"], models: ModelInfo[] = []): ContractProvider => ({
  id: kind, kind, name: kind, baseUrl: null, models, hasCredential: true,
});

const entry = (id: string, reasoning_options?: unknown) => ({
  id, name: id, reasoning: true, tool_call: true,
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 200_000, output: 32_768 },
  ...(reasoning_options !== undefined ? { reasoning_options } : {}),
});

const context = normalizeContext({ messages: [{ role: "user", content: "Say OK", timestamp: 0 }] });

/** Exercise real SDK shaping and HTTP dispatch; only the remote response is substituted. */
async function requestPayload(provider: Provider, id: string, thinking: Thinking | ThinkingLevel): Promise<Record<string, unknown>> {
  const model = provider.getModels().find((model) => model.id === id)!;
  expect(model).toBeDefined();
  let payload: Record<string, unknown> | undefined;
  let sent = false;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent = true;
    if (model.api !== "openai-codex-responses") {
      const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
      payload = JSON.parse(String(body));
    }
    if (model.api !== "anthropic-messages") {
      return Response.json({ error: { message: "Captured request", type: "invalid_request_error" } }, { status: 400 });
    }
    const events = [
      { type: "message_start", message: { id: "msg-test", model: id, role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof globalThis.fetch;
  // This is durable's off representation: the stored choice is not rewritten.
  const result = await provider.streamSimple(model, context, {
    apiKey: model.api === "openai-codex-responses"
      ? `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`
      : "test-key",
    fetch, maxRetries: 0, transport: "sse",
    // Codex may compress its HTTP body; inspect the SDK's native request before compression.
    onPayload: model.api === "openai-codex-responses" ? (body) => { payload = body as Record<string, unknown>; } : undefined,
    ...(thinking === "off" ? {} : { reasoning: thinking }),
  }).result();
  expect(sent).toBe(true);
  expect(payload).toBeDefined();
  if (model.api === "anthropic-messages") expect(result.stopReason).toBe("stop");
  return payload!;
}

test("future effort-only releases retain declarations through the disk cache and execute off as adaptive lowest effort", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-reasoning-"));
  const id = "future-reasoner-2099";
  const cachePath = join(root, "catalog.json");
  const writer = new ProviderCatalog({ cachePath, fetch: async () => Response.json({
    "minimax-coding-plan": { models: {
      [id]: entry(id, [{ type: "effort", values: ["max", "high", "low", "medium", "xhigh", "low", "invalid"] }]),
      "future-cached-toggle": entry("future-cached-toggle", [{ type: "toggle" }]),
    } },
  }) });
  let restored: ProviderCatalog | undefined;
  try {
    await writer.refresh();
    restored = new ProviderCatalog({ cachePath, fetch: async () => { throw new Error("offline"); } });
    const row = providerOf("minimax");
    expect(restored.modelsFor(row).find((model) => model.id === id)).toMatchObject({
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(restored.modelsFor(row).find((model) => model.id === "future-cached-toggle")).toMatchObject({ reasoningToggle: true });
    const provider = createHostProvider(row, undefined, restored)!;
    for (const [requested, effort] of [["off", "low"], ["low", "low"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]] as const) {
      const payload = await requestPayload(provider, id, requested);
      expect(payload.thinking).toMatchObject({ type: "adaptive" });
      expect(payload.output_config).toEqual({ effort });
    }
  } finally {
    await writer.close();
    await restored?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("toggle-only releases preserve off and enable adaptive thinking without a tunable effort", async () => {
  const id = "future-toggle-2099";
  const catalog = new ProviderCatalog({ fetch: async () => Response.json({
    "minimax-coding-plan": { models: { [id]: entry(id, [{ type: "toggle" }]) } },
  }) });
  try {
    await catalog.refresh();
    const row = providerOf("minimax");
    expect(catalog.modelsFor(row).find((model) => model.id === id)?.reasoningToggle).toBe(true);
    const provider = createHostProvider(row, undefined, catalog)!;
    expect((await requestPayload(provider, id, "off")).thinking).toEqual({ type: "disabled" });
    for (const level of ["low", "high"] as const) {
      const payload = await requestPayload(provider, id, level);
      expect(payload.thinking).toMatchObject({ type: "adaptive" });
      expect(payload).not.toHaveProperty("output_config");
    }
  } finally {
    await catalog.close();
  }
});

test("Anthropic protocol declarations support none or a toggle alongside effort without model-name rules", async () => {
  const catalog = new ProviderCatalog();
  try {
    for (const metadata of [
      { reasoningEfforts: ["none", "low", "high"] as const },
      { reasoningEfforts: ["low", "high"] as const, reasoningToggle: true },
    ]) {
      const info: ModelInfo = { id: "unknown-vendor-future", name: "Future", reasoning: true, ...metadata, reasoningEfforts: [...metadata.reasoningEfforts] };
      const provider = createHostProvider(providerOf("anthropic", [info]), undefined, catalog)!;
      expect((await requestPayload(provider, info.id, "off")).thinking).toEqual({ type: "disabled" });
      const payload = await requestPayload(provider, info.id, "high");
      expect(payload.thinking).toMatchObject({ type: "adaptive" });
      expect(payload.output_config).toEqual({ effort: "high" });
    }
  } finally {
    await catalog.close();
  }
});

test("absent declarations retain legacy Anthropic budget thinking and explicit off", async () => {
  const catalog = new ProviderCatalog();
  try {
    const info: ModelInfo = { id: "legacy-unknown", name: "Legacy", reasoning: true };
    const provider = createHostProvider(providerOf("anthropic", [info]), undefined, catalog)!;
    expect((await requestPayload(provider, info.id, "off")).thinking).toEqual({ type: "disabled" });
    const payload = await requestPayload(provider, info.id, "high");
    expect(payload.thinking).toMatchObject({ type: "enabled" });
    expect(payload).not.toHaveProperty("output_config");
  } finally {
    await catalog.close();
  }
});

test("reasoning declarations leave OpenAI, Codex, and ZAI off requests unchanged", async () => {
  const catalog = new ProviderCatalog();
  try {
    for (const transport of ["openai", "codex", "zai"] as const) {
      const info: ModelInfo = { id: "future-other-protocol", name: "Future", reasoning: true, reasoningEfforts: ["low", "high"] };
      const row = providerOf(transport === "codex" ? "openai" : transport, [info]);
      const credential = transport === "codex" ? { type: "oauth" as const, access: "test-key", refresh: "refresh", expires: Date.now() + 60_000 } : undefined;
      const provider = createHostProvider(row, credential, catalog)!;
      const runtime = provider.getModels().find((model) => model.id === info.id)!;
      expect(runtime.thinkingLevelMap).toBeUndefined();
      expect(runtime.compat).toBeUndefined();
      const payload = await requestPayload(provider, info.id, "off");
      if (transport === "zai") expect(payload.thinking).toEqual({ type: "disabled" });
      else expect(payload.reasoning).toEqual({ effort: "none" });
    }
  } finally {
    await catalog.close();
  }
});

