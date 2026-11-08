import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, Provider as ContractProvider } from "@ghost/contract";
import { ProviderCatalog, supportsAutomaticModels } from "../src/integrations/provider-catalog.ts";

// Behavior of the externally refreshed provider catalog: models.dev snapshots
// validated into presets/modelsFor, endpoint mapping, OAuth separation, and a
// disk cache that survives offline and malformed refreshes.

const entry = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id.toUpperCase(),
  tool_call: true,
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 200_000, output: 32_768 },
  ...overrides,
});

const payloadOf = (providers: Record<string, Record<string, Record<string, unknown>>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(providers).map(([key, models]) => [key, { id: key, name: key, models }]));

const fetchServing = (payload: unknown) => {
  let calls = 0;
  const serve = async (): Promise<Response> => {
    calls += 1;
    return Response.json(payload);
  };
  return { fetch: serve, calls: () => calls };
};

const fetchOffline = () => (async () => { throw new Error("offline"); });
const fetchHtml = () => (async () => new Response("<html>not json</html>", { status: 200 }));
const fetchUnrelated = () => (async () => Response.json({ unrelated: true }));
const fetchRedirect = () => (async () => Response.redirect("https://models.dev/api.json", 302));
/** One byte over the 32 MiB body cap. */
const fetchHuge = () => (async () => new Response("x".repeat(33 * 1024 * 1024), { status: 200 }));

/** Yields one macrotask so start()'s already-scheduled tick has run; no duration is being guessed. */
const flush = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const providerOf = (spec: Partial<ContractProvider> & Pick<ContractProvider, "id" | "kind">): ContractProvider => ({
  name: spec.id,
  baseUrl: null,
  models: [],
  hasCredential: true,
  ...spec,
});

test("a newly released model reaches modelsFor from the remote snapshot without source edits", async () => {
  const payload = payloadOf({
    "zai-coding-plan": { "glm-next": entry("glm-next", { limit: { context: 262_144, output: 16_384 }, modalities: { input: ["text", "image"], output: ["text"] } }) },
  });
  const { fetch, calls } = fetchServing(payload);
  const catalog = new ProviderCatalog({ fetch });
  const zai = providerOf({ id: "zai", kind: "zai" });
  expect(catalog.modelsFor(zai).some((model) => model.id === "glm-next")).toBe(false);
  expect(await catalog.refresh()).toBe(true);
  const released = catalog.modelsFor(zai).find((model) => model.id === "glm-next");
  expect(released).toMatchObject({ name: "GLM-NEXT", contextWindow: 262_144, maxTokens: 16_384, input: ["text", "image"] });
  expect(catalog.presets.find((preset) => preset.id === "zai")?.models.some((model) => model.id === "glm-next")).toBe(true);
  // An explicit refresh always fetches and compares; only effective change flips the result.
  expect(await catalog.refresh()).toBe(false);
  expect(calls()).toBe(2);
  await catalog.close();
});

test("catalog metadata is authoritative for known ids while manual-only metadata is preserved", async () => {
  const stored: ModelInfo[] = [
    { id: "glm-5.3", name: "Old GLM", contextWindow: 99 },
    { id: "custom-vision", name: "My Vision", input: ["text", "image"] },
    { id: "custom-text", name: "My Text" },
  ];
  const payload = payloadOf({ "zai-coding-plan": { "glm-5.3": entry("glm-5.3", { limit: { context: 1_000_000, output: 131_072 }, reasoning: true }) } });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const models = catalog.modelsFor(providerOf({ id: "zai", kind: "zai", models: stored }));
  expect(models[0]).toEqual({ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, maxTokens: 131_072, input: ["text"], reasoning: true });
  expect(models.find((model) => model.id === "custom-vision")).toEqual({ id: "custom-vision", name: "My Vision", input: ["text", "image"] });
  expect(models.find((model) => model.id === "custom-text")).toEqual({ id: "custom-text", name: "My Text" });
  await catalog.close();
});

test("endpoint mapping stays exact: zai coding default, generic url, minimax dual catalog, custom none", async () => {
  const payload = payloadOf({
    "zai-coding-plan": { "glm-coding": entry("glm-coding") },
    zai: { "glm-generic": entry("glm-generic") },
    minimax: { "MiniMax-API": entry("MiniMax-API") },
    "minimax-coding-plan": {
      "MiniMax-Old": entry("MiniMax-Old", { status: "deprecated" }),
      "MiniMax-M3.1-Flash-Preview": entry("MiniMax-M3.1-Flash-Preview", { name: "MiniMax M3.1 Flash Preview" }),
    },
  });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const ids = (provider: ContractProvider) => catalog.modelsFor(provider).map((model) => model.id);
  expect(ids(providerOf({ id: "zai", kind: "zai" }))).toEqual(["glm-coding"]);
  expect(ids(providerOf({ id: "zai", kind: "zai", baseUrl: "https://api.z.ai/api/paas/v4" }))).toEqual(["glm-generic"]);
  const minimaxIds = ids(providerOf({ id: "minimax", kind: "minimax", baseUrl: "https://api.minimax.io/anthropic" }));
  expect(minimaxIds).toContain("MiniMax-API");
  expect(minimaxIds).toContain("MiniMax-M3.1-Flash-Preview");
  expect(minimaxIds).not.toContain("MiniMax-Old");
  expect(ids(providerOf({ id: "custom", kind: "openai_compatible", baseUrl: "http://localhost:1234/v1" }))).toEqual([]);
  expect(supportsAutomaticModels(providerOf({ id: "zai", kind: "zai" }))).toBe(true);
  expect(supportsAutomaticModels(providerOf({ id: "zai", kind: "zai", baseUrl: "https://api.z.ai/api/paas/v4" }))).toBe(true);
  expect(supportsAutomaticModels(providerOf({ id: "minimax", kind: "minimax", baseUrl: "https://api.minimax.io/anthropic" }))).toBe(true);
  expect(supportsAutomaticModels(providerOf({ id: "custom", kind: "openai_compatible", baseUrl: "http://localhost:1234/v1" }))).toBe(false);
  expect(supportsAutomaticModels(providerOf({ id: "openai", kind: "openai", baseUrl: "https://proxy.example.com/v1" }))).toBe(false);
  expect(supportsAutomaticModels(providerOf({ id: "openai", kind: "openai", baseUrl: "https://chatgpt.com/backend-api" }))).toBe(false);
  await catalog.close();
});

test("an OpenAI-compatible endpoint never expands, even on the official address", async () => {
  const payload = payloadOf({ openai: { "gpt-fake": entry("gpt-fake") } });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const relay = providerOf({ id: "relay", kind: "openai_compatible", baseUrl: "https://api.openai.com/v1" });
  expect(catalog.modelsFor(relay)).toEqual([]);
  expect(supportsAutomaticModels(relay)).toBe(false);
  await catalog.close();
});

test("OAuth stays separated from the API-key catalog and live metadata layers over the base", async () => {
  const payload = payloadOf({
    openai: {
      "gpt-5.3-codex-spark": entry("gpt-5.3-codex-spark", { limit: { context: 272_000, output: 128_000 } }),
      "gpt-api-only": entry("gpt-api-only"),
    },
  });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const codex = providerOf({ id: "codex", kind: "openai", models: [{ id: "team-model", name: "Team Model" }] });
  const fallback = catalog.modelsFor(codex, "oauth");
  expect(fallback.find((model) => model.id === "gpt-5.3-codex-spark")).toMatchObject({ contextWindow: 272_000, maxTokens: 128_000 });
  expect(fallback.some((model) => model.id === "gpt-api-only")).toBe(false);
  expect(fallback.some((model) => model.id === "team-model")).toBe(true);
  expect(catalog.modelsFor(codex, "api_key").some((model) => model.id === "gpt-api-only")).toBe(true);

  const live: ModelInfo[] = [
    { id: "gpt-live", name: "Live Only", contextWindow: 100_000 },
    { id: "gpt-5.3-codex-spark", name: "Codex Live", contextWindow: 400_000, input: ["text"] },
  ];
  expect(catalog.setOAuthModels("codex", live)).toBe(true);
  expect(catalog.setOAuthModels("codex", live)).toBe(false);
  const updated = catalog.modelsFor(codex, "oauth");
  expect(updated.find((model) => model.id === "gpt-live")).toEqual({ id: "gpt-live", name: "Live Only", contextWindow: 100_000 });
  expect(updated.find((model) => model.id === "gpt-5.3-codex-spark")).toEqual({ id: "gpt-5.3-codex-spark", name: "Codex Live", contextWindow: 400_000, maxTokens: 128_000, input: ["text"] });
  expect(updated.some((model) => model.id === "gpt-api-only")).toBe(false);
  expect(catalog.presets.find((preset) => preset.id === "openai")?.oauthModels.some((model) => model.id === "gpt-live")).toBe(false);
  expect(catalog.setOAuthModels("OpenAI", [{ id: "x", name: "X" }])).toBe(false);
  expect(catalog.setOAuthModels("codex", [{ name: "No Id" }] as unknown as ModelInfo[])).toBe(false);
  expect(catalog.clearOAuthModels("codex")).toBe(true);
  expect(catalog.clearOAuthModels("codex")).toBe(false);
  expect(catalog.modelsFor(codex, "oauth").some((model) => model.id === "gpt-live")).toBe(false);
  await catalog.close();
});

test("live OAuth reasoning false overrides the remote base", async () => {
  const payload = payloadOf({ openai: { "gpt-base": entry("gpt-base", { reasoning: true }) } });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const provider = providerOf({ id: "acct", kind: "openai" });
  expect(catalog.setOAuthModels("acct", [{ id: "gpt-base", name: "Base", reasoning: false }])).toBe(true);
  expect(catalog.modelsFor(provider, "oauth").find((model) => model.id === "gpt-base")).toMatchObject({ reasoning: false, input: ["text"] });
  await catalog.close();
});

test("disk cache restores the catalog offline and failed refreshes preserve it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-catalog-"));
  const cachePath = join(root, "nested", "models.json");
  try {
    const payload = payloadOf({ "zai-coding-plan": { "glm-cached": entry("glm-cached") } });
    const writer = new ProviderCatalog({ cachePath, fetch: fetchServing(payload).fetch });
    expect(await writer.refresh()).toBe(true);
    const original = readFileSync(cachePath, "utf8");
    const cache = JSON.parse(original) as { version: number; fetchedAt: number; providers: Record<string, { id: string }[]> };
    expect(cache.version).toBe(1);
    expect(cache.fetchedAt).toBeGreaterThan(0);
    expect(cache.providers["zai-coding-plan"]?.some((model) => model.id === "glm-cached")).toBe(true);
    expect(existsSync(`${cachePath}.tmp`)).toBe(false);
    expect(writer.setOAuthModels("openai", [{ id: "gpt-live-quiet", name: "Quiet" }])).toBe(true);
    expect(readFileSync(cachePath, "utf8")).toBe(original);

    const offline = new ProviderCatalog({ cachePath, fetch: fetchOffline() });
    expect(offline.modelsFor(providerOf({ id: "zai", kind: "zai" })).some((model) => model.id === "glm-cached")).toBe(true);
    expect(await offline.refresh()).toBe(false);
    expect(readFileSync(cachePath, "utf8")).toBe(original);

    for (const fetch of [fetchHtml(), fetchUnrelated(), fetchRedirect(), fetchHuge()]) {
      const broken = new ProviderCatalog({ cachePath, fetch });
      expect(await broken.refresh()).toBe(false);
      expect(broken.modelsFor(providerOf({ id: "zai", kind: "zai" })).some((model) => model.id === "glm-cached")).toBe(true);
      expect(readFileSync(cachePath, "utf8")).toBe(original);
    }

    writeFileSync(cachePath, "{ truncated");
    const corrupt = new ProviderCatalog({ cachePath, fetch: fetchOffline() });
    expect(corrupt.modelsFor(providerOf({ id: "zai", kind: "zai" })).some((model) => model.id === "glm-cached")).toBe(false);
    expect(corrupt.modelsFor(providerOf({ id: "zai", kind: "zai" })).some((model) => model.id === "glm-4.7")).toBe(true);

    writeFileSync(cachePath, JSON.stringify({ ...JSON.parse(original), fetchedAt: Date.now() + 600_000 }));
    const future = new ProviderCatalog({ cachePath, fetch: fetchOffline() });
    expect(future.modelsFor(providerOf({ id: "zai", kind: "zai" })).some((model) => model.id === "glm-cached")).toBe(false);
    expect(future.modelsFor(providerOf({ id: "zai", kind: "zai" })).some((model) => model.id === "glm-4.7")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start refreshes only due caches and close settles in-flight work", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-catalog-start-"));
  const cachePath = join(root, "models.json");
  const baseTime = 1_700_000_000_000;
  const hour = 60 * 60 * 1000;
  try {
    const seedPayload = payloadOf({ "zai-coding-plan": { "glm-v1": entry("glm-v1") } });
    const seed = new ProviderCatalog({ cachePath, fetch: fetchServing(seedPayload).fetch, now: () => baseTime });
    expect(await seed.refresh()).toBe(true);
    await seed.close();

    // Fresh cache: the due check passes without touching the network.
    let freshCalls = 0;
    let freshChanges = 0;
    const fresh = new ProviderCatalog({ cachePath, fetch: (async () => { freshCalls += 1; return Response.json(seedPayload); }), now: () => baseTime });
    fresh.start(() => { freshChanges += 1; });
    await flush();
    expect(freshCalls).toBe(0);
    expect(freshChanges).toBe(0);
    await fresh.close();

    // Stale cache: the initial due check refreshes; the callback fires once on effective change.
    const nextPayload = payloadOf({ "zai-coding-plan": { "glm-v2": entry("glm-v2") } });
    const started = Promise.withResolvers<void>();
    const changed = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    let changes = 0;
    const stale = new ProviderCatalog({
      cachePath,
      fetch: (async () => { calls += 1; started.resolve(); await gate.promise; return Response.json(nextPayload); }),
      now: () => baseTime + 7 * hour,
    });
    stale.start(() => { changes += 1; changed.resolve(); });
    await started.promise;
    expect(changes).toBe(0);
    gate.resolve();
    await changed.promise;
    expect(changes).toBe(1);
    await stale.close();

    // Close settles an in-flight refresh; no callback afterwards, cache still updated atomically.
    const thirdPayload = payloadOf({ "zai-coding-plan": { "glm-v3": entry("glm-v3") } });
    const started2 = Promise.withResolvers<void>();
    const gate2 = Promise.withResolvers<void>();
    let calls2 = 0;
    let closingChanges = 0;
    const closing = new ProviderCatalog({
      cachePath,
      fetch: (async () => { calls2 += 1; started2.resolve(); await gate2.promise; return Response.json(thirdPayload); }),
      now: () => baseTime + 14 * hour,
    });
    closing.start(() => { closingChanges += 1; });
    await started2.promise;
    const done = closing.close();
    gate2.resolve();
    await done;
    expect(calls2).toBe(1);
    expect(closingChanges).toBe(0);
    await flush();
    expect(closingChanges).toBe(0);
    const restarted = new ProviderCatalog({ cachePath, fetch: fetchOffline(), now: () => baseTime + 14 * hour });
    expect(restarted.modelsFor(providerOf({ id: "zai", kind: "zai" })).some((model) => model.id === "glm-v3")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent refreshes share one flight", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const payload = payloadOf({ openai: { "gpt-x": entry("gpt-x") } });
  const catalog = new ProviderCatalog({
    fetch: (async () => { calls += 1; await gate.promise; return Response.json(payload); }),
  });
  const first = catalog.refresh();
  const second = catalog.refresh();
  gate.resolve();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(calls).toBe(1);
  await catalog.close();
});

test("a recovered cache writer persists the latest snapshot even when its metadata has not changed again", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-catalog-write-"));
  const cachePath = join(root, "models.json");
  let payload = payloadOf({ "zai-coding-plan": { "glm-before": entry("glm-before") } });
  const catalog = new ProviderCatalog({ cachePath, fetch: async () => Response.json(payload) });
  try {
    await catalog.refresh();
    mkdirSync(`${cachePath}.tmp`);
    payload = payloadOf({ "zai-coding-plan": { "glm-after": entry("glm-after") } });
    await catalog.refresh();
    expect(catalog.modelsFor(providerOf({ id: "zai", kind: "zai" })).map(model => model.id)).toEqual(["glm-after"]);
    rmSync(`${cachePath}.tmp`, { recursive: true });
    await catalog.refresh();
    const restarted = new ProviderCatalog({ cachePath, fetch: fetchOffline() });
    expect(restarted.modelsFor(providerOf({ id: "zai", kind: "zai" })).map(model => model.id)).toEqual(["glm-after"]);
    await restarted.close();
  } finally { await catalog.close(); rmSync(root, { recursive: true, force: true }); }
});


test("the 256 cap keeps stored models first", async () => {
  const stored: ModelInfo[] = Array.from({ length: 250 }, (_, index) => ({ id: `kept-${String(index).padStart(3, "0")}`, name: `Kept ${index}` }));
  const additions = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`new-${String(index).padStart(2, "0")}`, entry(`new-${String(index).padStart(2, "0")}`)]));
  const catalog = new ProviderCatalog({ fetch: fetchServing(payloadOf({ openai: additions })).fetch });
  await catalog.refresh();
  const models = catalog.modelsFor(providerOf({ id: "relay", kind: "openai", baseUrl: "https://api.openai.com/v1", models: stored }));
  expect(models.length).toBe(256);
  expect(models.slice(0, 250).map((model) => model.id)).toEqual(stored.map((model) => model.id));
  expect(models.slice(250).every((model) => model.id.startsWith("new-"))).toBe(true);
  await catalog.close();
});

test("remote additions must prove chat behavior; deprecated new ids are excluded", async () => {
  const payload = payloadOf({
    google: {
      "gemini-good": entry("gemini-good", { modalities: { input: ["text", "image", "video"], output: ["text"] } }),
      "gemini-image-input": entry("gemini-image-input", { modalities: { input: ["text", "image"], output: ["text"] } }),
      "gemini-no-tools": entry("gemini-no-tools", { tool_call: false }),
      "gemini-audio-out": entry("gemini-audio-out", { modalities: { input: ["text"], output: ["audio"] } }),
      "gemini-no-modalities": entry("gemini-no-modalities", { modalities: undefined }),
      "gemini-zero-output": entry("gemini-zero-output", { limit: { context: 1000, output: 0 } }),
      "gemini-deprecated": entry("gemini-deprecated", { deprecated: true }),
      "gemini-status-deprecated": entry("gemini-status-deprecated", { status: "deprecated" }),
    },
  });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const models = catalog.modelsFor(providerOf({ id: "google", kind: "google" }));
  const ids = models.map((model) => model.id);
  expect(ids).toContain("gemini-good");
  expect(ids).toContain("gemini-image-input");
  expect(ids).not.toContain("gemini-no-tools");
  expect(ids).not.toContain("gemini-audio-out");
  expect(ids).not.toContain("gemini-no-modalities");
  expect(ids).not.toContain("gemini-zero-output");
  expect(ids).not.toContain("gemini-deprecated");
  expect(ids).not.toContain("gemini-status-deprecated");
  expect(models.find((model) => model.id === "gemini-good")?.input).toEqual(["text", "image"]);
  await catalog.close();
});

test("presets mirror the active remote catalog, not the SDK seed, when a snapshot exists", async () => {
  const payload = payloadOf({
    "zai-coding-plan": {
      "glm-5.3": entry("glm-5.3", { status: "deprecated" }),
      "glm-live": entry("glm-live"),
    },
  });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const zai = providerOf({ id: "zai", kind: "zai" });
  const ids = catalog.modelsFor(zai).map((model) => model.id);
  expect(ids).toEqual(["glm-live"]);
  expect(catalog.presets.find((preset) => preset.id === "zai")?.models.map((model) => model.id)).toEqual(ids);
  await catalog.close();
});

test("explicitly saved deprecated ids stay listed and refresh their metadata", async () => {
  const payload = payloadOf({ "zai-coding-plan": { "glm-old": entry("glm-old", { status: "deprecated", limit: { context: 128_000, output: 8_000 } }) } });
  const catalog = new ProviderCatalog({ fetch: fetchServing(payload).fetch });
  await catalog.refresh();
  const models = catalog.modelsFor(providerOf({ id: "zai", kind: "zai", models: [{ id: "glm-old", name: "GLM Old", contextWindow: 1 }] }));
  expect(models).toEqual([{ id: "glm-old", name: "GLM-OLD", contextWindow: 128_000, maxTokens: 8_000, input: ["text"] }]);
  await catalog.close();
});
