import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModels } from "../src/engine/models.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

// Exercise the installed SDK's refresh lock with real file persistence, not a fake resolver.
test("concurrent model auth rotates an expired OAuth credential once and persists the rotation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-oauth-models-"));
  const originalFetch = globalThis.fetch;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let refreshes = 0;
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
  try {
    const secrets = new FileSecrets(root);
    await secrets.modify("codex", async () => ({ type: "oauth", access: "expired", refresh: "old-refresh", expires: 1, accountId: "test-account" }));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://auth.openai.com/oauth/token") return originalFetch(input, init);
      refreshes++;
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("old-refresh");
      started.resolve();
      await release.promise;
      return Response.json({ access_token: token, refresh_token: "rotated-refresh", expires_in: 3600 });
    }) as typeof fetch;
    const models = buildModels({ defaultModel: null, reviewModel: null, providers: [{ id: "codex", kind: "openai", name: "Codex", baseUrl: null, models: [{ id: "test", name: "Test" }], hasCredential: true }] }, secrets);
    const pending = [models.getAuth("codex"), models.getAuth("codex")];
    await started.promise;
    release.resolve();
    const results = await Promise.all(pending);
    expect(refreshes).toBe(1);
    expect(results.map(result => result?.auth.apiKey)).toEqual([token, token]);
    expect(new FileSecrets(root).credential("codex")).toMatchObject({ type: "oauth", access: token, refresh: "rotated-refresh" });
  } finally {
    release.resolve();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
