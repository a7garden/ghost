import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@ghost/contract";
import { CodexCatalog } from "../src/integrations/codex-catalog.ts";
import { ProviderCatalog } from "../src/integrations/provider-catalog.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

const HOUR = 60 * 60 * 1000;
const provider: Provider = { id: "codex", kind: "openai", name: "Codex", baseUrl: null, models: [], hasCredential: true };
const discovered = (id = "future-codex") => ({
  slug: id, display_name: "Future Codex", visibility: "list", supported_in_api: true,
  context_window: 700_000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }],
  base_instructions: "REMOTE INSTRUCTIONS MUST NOT BE USED", tools: [{ name: "untrusted" }],
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ghost-codex-catalog-"));
  const secrets = new FileSecrets(root);
  let now = Date.now();
  const login = async (account = "one") => secrets.modify("codex", async () => ({ type: "oauth", access: `access-${account}`, refresh: `refresh-${account}`, expires: now + 24 * HOUR, accountId: account }));
  await login();
  const catalog = new ProviderCatalog();
  const cachePath = join(root, "cache", "codex-models.json");
  return { root, secrets, login, catalog, cachePath, now: () => now, advance: () => { now += 7 * HOUR; } };
}

test("Codex discovery makes future account models selectable with capabilities and caches only metadata", async () => {
  const f = await fixture();
  const service = new CodexCatalog({ ...f, providers: () => [provider], fetch: (async (url, init) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.159.0");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-one");
    expect(headers.get("chatgpt-account-id")).toBe("one");
    return Response.json({ models: [discovered(), { ...discovered("hidden"), visibility: "hide" }, { ...discovered("api-disabled"), supported_in_api: false }] });
  }) });
  try {
    expect(await service.refresh()).toBe(true);
    const models = f.catalog.modelsFor(provider, "oauth");
    expect(models.find((model) => model.id === "future-codex")).toMatchObject({ contextWindow: 700_000, reasoning: true, input: ["text", "image"] });
    expect(models.some((model) => model.id === "hidden")).toBe(false);
    expect(models.some((model) => model.id === "api-disabled")).toBe(true);
    const cache = readFileSync(f.cachePath, "utf8");
    for (const excluded of ["access-one", "refresh-one", "REMOTE INSTRUCTIONS", "untrusted", "base_instructions"]) expect(cache).not.toContain(excluded);
    const offlineCatalog = new ProviderCatalog();
    const offline = new CodexCatalog({ ...f, catalog: offlineCatalog, providers: () => [provider] });
    offline.sync();
    expect(offlineCatalog.modelsFor(provider, "oauth").find((model) => model.id === "future-codex")).toMatchObject({ input: ["text", "image"], contextWindow: 700_000 });
    await offline.close();
  } finally { await service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a later account catalog adds models without source changes and invalid responses retain last good state", async () => {
  const f = await fixture();
  let response: unknown = { models: [discovered()] };
  const service = new CodexCatalog({ ...f, providers: () => [provider], fetch: (async () => Response.json(response)) });
  try {
    await service.refresh();
    f.advance();
    response = { models: [discovered(), discovered("brand-new-codex")] };
    expect(await service.refresh()).toBe(true);
    expect(f.catalog.modelsFor(provider, "oauth").some((model) => model.id === "brand-new-codex")).toBe(true);
    const good = readFileSync(f.cachePath, "utf8");
    f.advance();
    response = { models: [{ slug: "broken" }] };
    expect(await service.refresh()).toBe(false);
    expect(f.catalog.modelsFor(provider, "oauth").some((model) => model.id === "brand-new-codex")).toBe(true);
    expect(readFileSync(f.cachePath, "utf8")).toBe(good);
  } finally { await service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("account replacement and logout never reuse another account's cached catalog", async () => {
  const f = await fixture();
  const service = new CodexCatalog({ ...f, providers: () => [provider], fetch: (async () => Response.json({ models: [discovered()] })) });
  try {
    await service.refresh();
    await f.login("two");
    service.sync();
    expect(f.catalog.modelsFor(provider, "oauth").some((model) => model.id === "future-codex")).toBe(false);
    const restartedCatalog = new ProviderCatalog();
    const restarted = new CodexCatalog({ ...f, catalog: restartedCatalog, providers: () => [provider] });
    restarted.sync();
    expect(restartedCatalog.modelsFor(provider, "oauth").some((model) => model.id === "future-codex")).toBe(false);
    await restarted.close();
    await service.refresh();
    expect(f.catalog.modelsFor(provider, "oauth").some((model) => model.id === "future-codex")).toBe(true);
    await f.secrets.delete("codex");
    service.sync();
    expect(f.catalog.modelsFor(provider, "oauth").some((model) => model.id === "future-codex")).toBe(false);
  } finally { await service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an in-flight response cannot publish models after account replacement", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const service = new CodexCatalog({ ...f, providers: () => [provider], fetch: (async () => {
    started.resolve(); await release.promise;
    return Response.json({ models: [discovered()] });
  }) });
  try {
    const pending = service.refresh();
    await started.promise;
    await f.login("two");
    service.sync();
    release.resolve();
    expect(await pending).toBe(false);
    expect(f.catalog.modelsFor(provider, "oauth").some((model) => model.id === "future-codex")).toBe(false);
  } finally { release.resolve(); await service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("only OAuth-backed OpenAI providers may send credentials to the fixed catalog endpoint", async () => {
  const f = await fixture();
  let contacted = false;
  const service = new CodexCatalog({ ...f, providers: () => [{ ...provider, kind: "openai_compatible", baseUrl: "https://untrusted.invalid/v1" }], fetch: (async () => {
    contacted = true; throw new Error("unexpected network request");
  }) });
  try { await service.refresh(); expect(contacted).toBe(false); }
  finally { await service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a streaming error response is cancelled while the last good account catalog stays usable", async () => {
  const f = await fixture();
  let fail = false;
  let cancelled = false;
  const service = new CodexCatalog({ ...f, providers: () => [provider], fetch: async () => {
    if (!fail) return Response.json({ models: [discovered()] });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("rate limited")); },
      cancel() { cancelled = true; },
    }), { status: 429 });
  } });
  try {
    await service.refresh();
    f.advance();
    fail = true;
    expect(await service.refresh()).toBe(false);
    expect(cancelled).toBe(true);
    expect(f.catalog.modelsFor(provider, "oauth").some(model => model.id === "future-codex")).toBe(true);
  } finally { await service.close(); rmSync(f.root, { recursive: true, force: true }); }
});
