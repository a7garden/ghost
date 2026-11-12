import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { DEFAULT_GHOST_TOOLS } from "@ghost/contract";
import { createVault, type Vault } from "../src/stores/vault.ts";
import { TOSS_ORIGIN, TossClient, tossQuery, tossRoute, type TossCredential, type TossPort } from "../src/integrations/toss.ts";
import { createTossTools } from "../src/tools/toss.ts";
import { harness, tempDir, hostTaskId } from "./support.ts";

const SECRET = "SYNTHETIC-toss-client-secret-never-shown", CLIENT = "tsck_live_synthetic";
const roots: string[] = [], vaults: Vault[] = [];
afterEach(() => { for (const vault of vaults.splice(0)) vault.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function openVault() { const root = tempDir(); roots.push(root); const vault = createVault(root); vaults.push(vault); return vault; }
const apiItem = (ghostIds: string[]) => ({ kind: "api" as const, title: "토스증권", origin: "https://OPENAPI.tossinvest.com:443/", username: CLIENT, value: SECRET, ghostIds });

describe("vault api credentials", () => {
  test("need an origin and a value, keep the client id as metadata and never fill a page", () => {
    const vault = openVault();
    const item = vault.create(apiItem(["ghost-a"]));
    expect(item).toMatchObject({ kind: "api", origin: TOSS_ORIGIN, username: CLIENT, hasPassword: false });
    expect(JSON.stringify(vault.list())).not.toContain(SECRET);
    expect(() => vault.reveal("ghost-a", item.id, "value")).toThrow("only by Host integrations");
    expect(() => vault.reveal("ghost-a", item.id, "username")).toThrow("only by Host integrations");
    expect(() => vault.create({ kind: "api", title: "no origin", value: SECRET })).toThrow("requires an HTTPS origin");
    expect(() => vault.create({ kind: "api", title: "no value", origin: TOSS_ORIGIN })).toThrow("required vault fields are missing");
    for (const extra of [{ password: SECRET }, { totp: "JBSWY3DPEHPK3PXP" }, { extraOrigins: ["https://other.example"] }]) expect(() => vault.create({ ...apiItem([]), ...extra })).toThrow("fields do not belong");
    expect(() => vault.create({ kind: "secret", title: "s", value: SECRET, username: "x" })).toThrow("fields do not belong");
  });

  test("give integrations exactly one granted credential, current after every edit", () => {
    const vault = openVault();
    expect(() => vault.apiCredential("ghost-a", TOSS_ORIGIN)).toThrow("no API key");
    const item = vault.create(apiItem(["ghost-a"]));
    expect(() => vault.apiCredential("ghost-b", TOSS_ORIGIN)).toThrow("no API key");
    expect(vault.apiCredential("ghost-a", TOSS_ORIGIN)).toEqual({ keyId: CLIENT, secret: SECRET });
    vault.update(item.id, { value: "SYNTHETIC-rotated-secret" });
    expect(vault.apiCredential("ghost-a", TOSS_ORIGIN)).toEqual({ keyId: CLIENT, secret: "SYNTHETIC-rotated-secret" });
    vault.create({ kind: "secret", title: "same origin, other kind", origin: TOSS_ORIGIN, value: "x", ghostIds: ["ghost-a"] });
    expect(vault.apiCredential("ghost-a", TOSS_ORIGIN).secret).toBe("SYNTHETIC-rotated-secret");
    vault.create(apiItem(["ghost-a"]));
    expect(() => vault.apiCredential("ghost-a", TOSS_ORIGIN)).toThrow("more than one");
  });
});

describe("Toss read routes", () => {
  test("allow only GET read routes and say which need an account", () => {
    expect(tossRoute("/api/v1/accounts")).toEqual({ account: false });
    expect(tossRoute("/api/v1/holdings")).toEqual({ account: true });
    expect(tossRoute("/api/v1/orders/ord_9-x.Y")).toEqual({ account: true });
    expect(tossRoute("/api/v1/stocks/BRK.B/warnings")).toEqual({ account: false });
    expect(tossRoute("/api/v1/market-calendar/US")).toEqual({ account: false });
    for (const path of ["/oauth2/token", "/api/v1/orders/abc/cancel", "/api/v1/orders/abc/modify", "/api/v1/orders/../holdings", "/api/v1/orders/.", "/api/v1/conditional-orders/x/modify", "/ws/v1", "/api/v1/holdings?x=1", "/api/v1/holdings/", "//evil.example/api/v1/accounts", "/api/v1/stocks/%2e%2e/warnings", "https://openapi.tossinvest.com/api/v1/accounts"]) {
      expect(() => tossRoute(path)).toThrow("not a read route");
    }
  });
  test("accept bounded query strings only", () => {
    expect(tossQuery("symbols=005930,000660&count=10").toString()).toBe("symbols=005930%2C000660&count=10");
    expect(tossQuery("?limit=5").get("limit")).toBe("5");
    for (const raw of ["a=1&a=2", "bad-name=1", `x=${"9".repeat(2049)}`, Array.from({ length: 17 }, (_, n) => `k${n}=1`).join("&")]) expect(() => tossQuery(raw)).toThrow("toss_read query");
  });
});

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
function fakeToss(handler: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    return handler(call, calls);
  }) as typeof fetch;
  return { calls, fetcher };
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const credential = (): TossCredential => ({ keyId: CLIENT, secret: SECRET });

describe("Toss client", () => {
  test("issues one token for concurrent calls, reuses it, and sends the account header only for account routes", async () => {
    let issued = 0;
    const gate = Promise.withResolvers<void>();
    const { calls, fetcher } = fakeToss(async (call) => {
      if (call.url.endsWith("/oauth2/token")) { issued++; await gate.promise; return json({ access_token: `token-${issued}`, token_type: "Bearer", expires_in: 86400 }); }
      return json({ result: call.url });
    });
    const client = new TossClient({ fetch: fetcher });
    const pending = [client.get(credential, "/api/v1/accounts", new URLSearchParams(), null), client.get(credential, "/api/v1/holdings", new URLSearchParams(), 3)];
    gate.resolve();
    await Promise.all(pending);
    await client.get(credential, "/api/v1/prices", tossQuery("symbols=005930"), null);
    expect(issued).toBe(1);
    const token = calls.find((call) => call.url.endsWith("/oauth2/token"))!;
    expect(token.method).toBe("POST");
    expect(new URLSearchParams(token.body).get("client_secret")).toBe(SECRET);
    const reads = calls.filter((call) => !call.url.endsWith("/oauth2/token"));
    expect(reads.every((call) => call.method === "GET" && call.headers.authorization === "Bearer token-1" && call.url.startsWith(`${TOSS_ORIGIN}/api/v1/`))).toBe(true);
    expect(reads.find((call) => call.url.endsWith("/holdings"))!.headers["x-tossinvest-account"]).toBe("3");
    expect(reads.find((call) => call.url.endsWith("/accounts"))!.headers["x-tossinvest-account"]).toBeUndefined();
    expect(reads.find((call) => call.url.includes("/prices"))!.url).toBe(`${TOSS_ORIGIN}/api/v1/prices?symbols=005930`);
    await expect(client.get(credential, "/api/v1/orders/x/cancel", new URLSearchParams(), 3)).rejects.toThrow("not a read route");
    await expect(client.get(credential, "/api/v1/holdings", new URLSearchParams(), null)).rejects.toThrow("account must be given");
  });

  test("re-issues once after a revoked token, after expiry and for a different secret", async () => {
    let now = 1_000_000, issued = 0, current = credential();
    const { calls, fetcher } = fakeToss((call) => {
      if (call.url.endsWith("/oauth2/token")) return json({ access_token: `token-${++issued}`, expires_in: 3600 });
      if (call.headers.authorization === "Bearer token-1" && calls.filter((entry) => entry.headers.authorization === "Bearer token-1").length === 2) return json({ error: { code: "token-revoked", message: "replaced" } }, 401);
      return json({ ok: call.headers.authorization });
    });
    const client = new TossClient({ fetch: fetcher, now: () => now });
    const load = () => current;
    expect((await client.get(load, "/api/v1/accounts", new URLSearchParams(), null)).body).toContain("token-1");
    expect((await client.get(load, "/api/v1/accounts", new URLSearchParams(), null)).body).toContain("token-2");
    now += 3600 * 1000;
    expect((await client.get(load, "/api/v1/accounts", new URLSearchParams(), null)).body).toContain("token-3");
    // A rotated secret, or a deleted and recreated item for the same client, never receives the old token.
    current = { keyId: CLIENT, secret: "SYNTHETIC-rotated-secret" };
    expect((await client.get(load, "/api/v1/accounts", new URLSearchParams(), null)).body).toContain("token-4");
    expect(new URLSearchParams(calls.at(-2)!.body).get("client_secret")).toBe("SYNTHETIC-rotated-secret");
    expect(issued).toBe(4);
  });

  test("reads the vault again before re-issuing, so a key edited mid-call is used for the retry", async () => {
    let current = credential();
    const { calls, fetcher } = fakeToss((call) => {
      if (call.url.endsWith("/oauth2/token")) return json({ access_token: `issued-with-${new URLSearchParams(call.body).get("client_secret")}`, expires_in: 3600 });
      if (call.headers.authorization === `Bearer issued-with-${SECRET}`) {
        current = { keyId: CLIENT, secret: "SYNTHETIC-new-secret" };
        return json({ error: { code: "token-revoked" } }, 401);
      }
      return json({ ok: call.headers.authorization });
    });
    const response = await new TossClient({ fetch: fetcher }).get(() => current, "/api/v1/accounts", new URLSearchParams(), null);
    expect(response.body).toContain("issued-with-SYNTHETIC-new-secret");
    expect(calls.filter((call) => call.url.endsWith("/oauth2/token")).map((call) => new URLSearchParams(call.body).get("client_secret"))).toEqual([SECRET, "SYNTHETIC-new-secret"]);
  });

  test("stops after one re-issue when the new token is refused too", async () => {
    const persistent = fakeToss((call) => call.url.endsWith("/oauth2/token") ? json({ access_token: "t", expires_in: 3600 }) : json({ error: { code: "invalid-token" } }, 401));
    const response = await new TossClient({ fetch: persistent.fetcher }).get(credential, "/api/v1/accounts", new URLSearchParams(), null);
    expect(response.status).toBe(401);
    expect(persistent.calls.filter((call) => call.url.endsWith("/oauth2/token")).length).toBe(2);
  });

  test("explains IP and key refusals without echoing the secret", async () => {
    for (const [status, message] of [[403, "허용 IP"], [401, "rejected the API key"]] as const) {
      const { fetcher } = fakeToss(() => json({ error: "access_denied", error_description: SECRET }, status));
      const error = await new TossClient({ fetch: fetcher }).get(credential, "/api/v1/accounts", new URLSearchParams(), null).catch((e: Error) => e);
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain(SECRET);
    }
    const { fetcher } = fakeToss(() => { throw new Error(SECRET); });
    const error = await new TossClient({ fetch: fetcher }).get(credential, "/api/v1/accounts", new URLSearchParams(), null).catch((e: Error) => e);
    expect(String(error)).toContain("unreachable");
    expect(String(error)).not.toContain(SECRET);
    await expect(new TossClient({ fetch: fetcher }).get(() => ({ ...credential(), keyId: "" }), "/api/v1/accounts", new URLSearchParams(), null)).rejects.toThrow("no client ID");
  });
});

describe("toss_read tool", () => {
  function fixture(port: TossPort, tools = [...DEFAULT_GHOST_TOOLS, "toss_read" as const]) {
    const h = harness(), vault = openVault();
    const ghost = h.core.createGhost({ name: "Assets", persona: "", tools });
    h.ledger.setPiConversationId(ghost.directConversationId, "pi-toss-test");
    const extension = createTossTools(h.core, vault, port);
    const call = async (args: unknown) => {
      const execute = extension.tools![0]!.execute as (args: unknown, api: ToolExecutionApi, context: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
      const result = await execute(args, { conversationId: "pi-toss-test", callId: "c", taskId: hostTaskId() } as unknown as ToolExecutionApi, {});
      return { error: result.isError === true, text: result.content.map((part) => part.text).join("\n") };
    };
    return { h, vault, ghost, call };
  }
  const echo: TossPort = { async get(credential, path, query, account) { return { status: 200, body: JSON.stringify({ path, query: query.toString(), account, key: credential().keyId }), retryAfter: null }; } };

  test("is not a default tool and refuses a Ghost without it", async () => {
    expect(DEFAULT_GHOST_TOOLS).not.toContain("toss_read");
    const { call } = fixture(echo, [...DEFAULT_GHOST_TOOLS]);
    expect(await call({ path: "/api/v1/accounts" })).toMatchObject({ error: true, text: expect.stringContaining("toss_read is not enabled") });
  });

  test("needs a granted key, then reads with it and never returns the secret", async () => {
    const { vault, ghost, call } = fixture(echo);
    expect(await call({ path: "/api/v1/accounts" })).toMatchObject({ error: true, text: expect.stringContaining("No Toss Securities API key is granted") });
    vault.create(apiItem([ghost.id]));
    const accounts = await call({ path: "/api/v1/accounts" });
    expect(accounts.error).toBe(false);
    expect(JSON.parse(accounts.text)).toEqual({ path: "/api/v1/accounts", query: "", account: null, key: CLIENT });
    const holdings = await call({ path: "/api/v1/holdings", query: "symbol=005930", account: 2 });
    expect(JSON.parse(holdings.text)).toMatchObject({ account: 2, query: "symbol=005930" });
    expect(JSON.parse((await call({ path: "/api/v1/prices", query: "symbols=AAPL", account: 2 })).text).account).toBeNull();
    expect(await call({ path: "/api/v1/holdings" })).toMatchObject({ error: true, text: expect.stringContaining("needs account") });
    expect(await call({ path: "/api/v1/orders/x/cancel", account: 2 })).toMatchObject({ error: true, text: expect.stringContaining("not a read route") });
    for (const result of [accounts, holdings]) expect(result.text).not.toContain(SECRET);
  });

  test("reports Toss refusals by code and message", async () => {
    let reply = { status: 403, body: JSON.stringify({ error: { code: "ip-not-allowed", message: "x" } }), retryAfter: null as string | null };
    const port: TossPort = { async get() { return reply; } };
    const { vault, ghost, call } = fixture(port);
    vault.create(apiItem([ghost.id]));
    expect((await call({ path: "/api/v1/accounts" })).text).toContain("허용 IP");
    reply = { status: 429, body: JSON.stringify({ error: { code: "rate-limit-exceeded", message: "slow down" } }), retryAfter: "2" };
    expect((await call({ path: "/api/v1/accounts" })).text).toContain("Toss 429 rate-limit-exceeded: slow down. Rate limited; retry after 2s.");
    reply = { status: 404, body: JSON.stringify({ error: { code: "account-not-found", message: "없는 계좌" } }), retryAfter: null };
    expect(await call({ path: "/api/v1/holdings", account: 9 })).toMatchObject({ error: true, text: expect.stringContaining("Toss 404 account-not-found: 없는 계좌") });
  });
});
