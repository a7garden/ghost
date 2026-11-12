import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivitySourceItem, Connection } from "@ghost/contract";
import { ConnectionOAuth, type ConnectionOAuthFetch } from "../src/api/connection-oauth.ts";
import { Access } from "../src/core/access.ts";
import { execute, updateGhost } from "../src/core/commands.ts";
import { Core } from "../src/core/core.ts";
import { sha256 } from "../src/core/ids.ts";
import type { ActivitySourcePoll, ActivitySourcePort } from "../src/integrations/activity-sources.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "GOCSPRIVATE-client-secret-value";
const ACCESS = "OAUTH-ACCESS-TOKEN";
const ACCESS2 = "OAUTH-ACCESS-TOKEN-2";
const REFRESH = "OAUTH-REFRESH-TOKEN";
const REFRESH2 = "OAUTH-REFRESH-TOKEN-2";
const START_AT = Date.parse("2026-11-11T09:00:00.000Z");
const ORIGIN = "https://ghost.example.net";
const REDIRECT = `${ORIGIN}/api/connection-oauth/callback`;

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const OUTLOOK_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const X_TOKEN = "https://api.x.com/2/oauth2/token";
const NOTION_TOKEN = "https://api.notion.com/v1/oauth/token";
const SLACK_TOKEN = "https://slack.com/api/oauth.v2.access";

type Route = (init?: RequestInit) => Response | Promise<Response>;
interface Request { url: URL; init?: RequestInit }

const resources: { close(): void }[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});

/** Fixed identity test that records every probe; `fail` simulates the provider refusing the identity. */
class FakeSources implements ActivitySourcePort {
  readonly credentials = new Map<string, { value: string; version: string | null }>();
  refresher: ((connection: Connection) => Promise<void>) | null = null;
  readonly probes: string[] = [];
  fail = false;

  credentialPresent(): boolean { return true; }
  async setCredential(id: string, value: string | null, version: string | null): Promise<void> {
    if (value === null) this.credentials.delete(id);
    else this.credentials.set(id, { value, version });
  }
  async rotateCredential(id: string, value: string, version: string): Promise<void> {
    if (this.credentials.get(id)?.version !== version) throw new Error("changed account");
    this.credentials.set(id, { value, version });
  }
  setOAuthRefresher(refresh: ((connection: Connection) => Promise<void>) | null): void {
    this.refresher = refresh;
  }
  async test(connection: Connection): Promise<{ summary: string }> {
    this.probes.push(connection.id);
    if (this.fail) throw new Error("identity probe refused this token");
    return { summary: "identity ok" };
  }
  async poll(): Promise<ActivitySourcePoll> { throw new Error("unused"); }
  async read(): Promise<ActivitySourceItem> { throw new Error("unused"); }
  async act(): Promise<{ summary: string }> { throw new Error("unused"); }
  async close(): Promise<void> {}
}

function scriptFetch(routes: Map<string, Route>, requests: Request[]): ConnectionOAuthFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, init });
    const route = routes.get(url.toString());
    if (!route) throw new Error(`unexpected token endpoint fetch ${url}`);
    return route(init);
  }) as ConnectionOAuthFetch;
}

const TOKEN_BODY = (init?: RequestInit) => new URLSearchParams(String(init?.body));
const AUTH = (init?: RequestInit) => new Headers(init?.headers).get("authorization");
const JSON_BODY = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

function setup(options: { routes?: Map<string, Route>; requests?: Request[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ghost-connection-oauth-"));
  mkdirSync(join(root, "secrets"), { recursive: true, mode: 0o700 });
  const sources = new FakeSources();
  const core = new Core({ ledger: new Ledger(":memory:"), artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), activitySources: sources, log: () => {} });
  core.attach(new FakeEngine());
  core.createGhost({ name: "본체", persona: "테스트" });
  let clock = START_AT;
  const requests = options.requests ?? [];
  const manager = new ConnectionOAuth(
    core,
    { root, publicOrigin: ORIGIN },
    { now: () => clock, fetch: scriptFetch(options.routes ?? new Map(), requests) },
  );
  resources.push({
    close: () => {
      manager.close();
      core.ledger.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  const owner = new Access({ kind: "owner" });
  core.ledger.tx(() => core.ledger.insertDevice({ id: "device-1", name: "iPhone", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: clock, lastSeenAt: null }, sha256("device-token")));
  const deviceAccess = new Access({ kind: "device", deviceId: "device-1", name: "iPhone" });
  const ghost = core.ledger.ghosts()[0]!;
  return { core, ledger: core.ledger, sources, manager, root, owner, deviceAccess, ghost, requests, tick: (seconds: number) => { clock += seconds * 1000; } };
}

const serviceUrl = (service: string) => new URL(`/api/connection-oauth/${service}`, ORIGIN);

async function view(manager: ConnectionOAuth, service: string, access: Access) {
  const response = await manager.handle(new Request(serviceUrl(service)), serviceUrl(service), access);
  if (response === null) throw new Error("route not owned");
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

async function jsonRequest(manager: ConnectionOAuth, method: string, service: string, access: Access, payload?: unknown) {
  const response = await manager.handle(
    new Request(serviceUrl(service), { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { "content-type": "application/json" } }) }),
    serviceUrl(service),
    access,
  );
  if (response === null) throw new Error("route not owned");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function configure(manager: ConnectionOAuth, service: string, access: Access, clientId: string, clientSecret?: string | null) {
  const payload = clientSecret === undefined ? { clientId } : { clientId, clientSecret };
  const configured = await jsonRequest(manager, "PUT", service, access, payload);
  expect(configured.status).toBe(200);
  return configured;
}

async function startLogin(manager: ConnectionOAuth, service: string, access: Access, payload: Record<string, unknown> = { name: "업무 계정", ghostIds: [] }) {
  const started = await jsonRequest(manager, "POST", service, access, payload);
  expect(started.status).toBe(200);
  expect(started.body.state).toBe("pending");
  return started;
}

function stateOf(started: Awaited<ReturnType<typeof startLogin>>): string {
  return new URL(String(started.body.authorizationUrl)).searchParams.get("state")!;
}

function callbackUrl(started: Awaited<ReturnType<typeof startLogin>>, query: Record<string, string>): URL {
  const params = new URLSearchParams({ state: stateOf(started), ...query });
  return new URL(`/api/connection-oauth/callback?${params.toString()}`, ORIGIN);
}

async function runCallback(manager: ConnectionOAuth, url: URL, access: Access | null = null) {
  const response = await manager.handle(new Request(url), url, access);
  if (response === null) throw new Error("route not owned");
  return response;
}

/** Polls status until the detached callback flow settles; every turn is a microtask, never a wall-clock wait. */
async function settled(manager: ConnectionOAuth, service: string, access: Access) {
  for (let turn = 0; turn < 300; turn++) {
    const current = await view(manager, service, access);
    if (current.body.state !== "pending") return current;
    await Promise.resolve();
  }
  throw new Error("login did not settle");
}

const bindingPath = (root: string, connectionId: string) => join(root, "secrets", "connection-oauth", `binding-${sha256(connectionId)}.json`);

function requireId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("no connectionId in status view");
  return value;
}

test("unconfigured service reports configured=false and refuses a login", async () => {
  const { manager } = setup();
  const status = await view(manager, "google", new Access({ kind: "owner" }));
  expect(status.body.configured).toBe(false);
  expect(status.body.state).toBe("idle");
  expect(status.body.clientId).toBeNull();
  expect(status.body.redirectUri).toBe(REDIRECT);
  await expect(jsonRequest(manager, "POST", "google", new Access({ kind: "owner" }), { name: "x" })).rejects.toThrow("OAuth 앱");
});

test("client configuration is a 0600 local secret and never appears in any response", async () => {
  const { manager, root } = setup();
  const configured = await configure(manager, "google", new Access({ kind: "owner" }), CLIENT_ID, CLIENT_SECRET);
  expect(configured.body.configured).toBe(true);
  expect(configured.body.clientId).toBe(CLIENT_ID);
  const file = join(root, "secrets", "connection-oauth", "client-google.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain(CLIENT_SECRET);
  expect(JSON.stringify(configured.body)).not.toContain(CLIENT_SECRET);
  const again = await view(manager, "google", new Access({ kind: "owner" }));
  expect(JSON.stringify(again.body)).not.toContain(CLIENT_SECRET);
});

test("omitted secret keeps the stored one for the same client; a new client id starts without one", async () => {
  const { manager, owner } = setup();
  await configure(manager, "notion", owner, CLIENT_ID, CLIENT_SECRET);
  const kept = await startLogin(manager, "notion", owner);
  expect(kept.body.state).toBe("pending");
  await jsonRequest(manager, "DELETE", "notion", owner);
  await configure(manager, "notion", owner, "client-two");
  await expect(startLogin(manager, "notion", owner)).rejects.toThrow("client secret");
});

test("google login registers a verified connection with binding, receipt and no leaked tokens", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, init => {
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = TOKEN_BODY(init);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect((form.get("code_verifier") ?? "").length).toBeGreaterThanOrEqual(43);
    return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: "Bearer" });
  }]]);
  const { manager, ledger, sources, ghost, root, owner, requests } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner, { name: "구글 계정", ghostIds: [ghost.id] });
  const authorization = new URL(String(started.body.authorizationUrl));
  expect(`${authorization.origin}${authorization.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(authorization.searchParams.get("response_type")).toBe("code");
  expect(authorization.searchParams.get("scope")).toBe("openid email");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("redirect_uri")).toBe(REDIRECT);
  const page = await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  const final = await settled(manager, "google", owner);
  expect(final.body.state).toBe("connected");
  expect(final.body.authorizationUrl).toBeNull();
  const row = ledger.connections().find(connection => connection.serviceId === "google")!;
  expect(row.name).toBe("구글 계정");
  expect(row.hasCredential).toBe(true);
  expect(sources.credentials.get(row.id)).toEqual({ value: ACCESS, version: row.credentialVersion });
  expect(sources.probes).toEqual([row.id]);
  expect(final.body.connectionId).toBe(row.id);
  const binding: Record<string, unknown> = JSON.parse(readFileSync(bindingPath(root, row.id), "utf8"));
  expect(binding.refreshToken).toBe(REFRESH);
  expect(binding.scope).toBe("openid email");
  expect(binding.serviceId).toBe("google");
  expect(binding.credentialVersion).toBe(row.credentialVersion);
  expect(statSync(bindingPath(root, row.id)).mode & 0o777).toBe(0o600);
  const requestId = `connection-oauth:${stateOf(started)}`;
  const receipt = ledger.request(requestId);
  expect(receipt?.state).toBe("done");
  const effect = ledger.effectByCall(ghost.directConversationId, `api:${requestId}`);
  expect(effect?.state).toBe("done");
  const secretFree = JSON.stringify([ledger.connections(), receipt, effect, final.body]);
  expect(secretFree).not.toContain(ACCESS);
  expect(secretFree).not.toContain(REFRESH);
  expect(secretFree).not.toContain(CLIENT_SECRET);
  // A replayed callback is refused and never triggers a second exchange.
  expect((await runCallback(manager, callbackUrl(started, { code: "code-1" }))).status).toBe(400);
  expect(requests.length).toBe(1);
});

test("google drive scope is only granted when the start request asks for it", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, init => {
    return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
  }]]);
  const { manager, owner, root, ledger } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const withDrive = await startLogin(manager, "google", owner, { name: "드라이브", ghostIds: [], googleDrive: true });
  const authorization = new URL(String(withDrive.body.authorizationUrl));
  expect(authorization.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.readonly");
  await runCallback(manager, callbackUrl(withDrive, { code: "code-1" }));
  const done = await settled(manager, "google", owner);
  expect(done.body.state).toBe("connected");
  const row = ledger.connections().find(connection => connection.serviceId === "google")!;
  const binding: Record<string, unknown> = JSON.parse(readFileSync(bindingPath(root, row.id), "utf8"));
  expect(binding.scope).toBe("openid email https://www.googleapis.com/auth/drive.readonly");
  // The default stays identity-only.
  const plain = await startLogin(manager, "google", owner, { name: "두번째", ghostIds: [] });
  expect(new URL(String(plain.body.authorizationUrl)).searchParams.get("scope")).toBe("openid email");
});

test("unknown, reused and expired states are refused without any exchange", async () => {
  const { manager, owner, requests, tick } = setup();
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const foreign = new URL(`/api/connection-oauth/callback?state=${"A".repeat(43)}&code=x`, ORIGIN);
  expect((await runCallback(manager, foreign)).status).toBe(400);
  const started = await startLogin(manager, "google", owner);
  tick(16 * 60);
  expect((await runCallback(manager, callbackUrl(started, { code: "code-1" }))).status).toBe(400);
  const expired = await view(manager, "google", owner);
  expect(expired.body.state).toBe("error");
  expect(expired.body.message).toContain("만료");
  // A fresh login works again; its state is then consumed once.
  const fresh = await startLogin(manager, "google", owner);
  expect(requests.length).toBe(0);
  expect((await runCallback(manager, callbackUrl(fresh, { code: "late" }))).status).toBe(200);
  const done = await settled(manager, "google", owner);
  expect(done.body.state).toBe("error"); // no token route configured for this login
  expect(done.body.message).toContain("로그인 처리에 실패");
  expect((await runCallback(manager, callbackUrl(fresh, { code: "late" }))).status).toBe(400);
  expect(requests.length).toBe(1);
});

test("provider error parameters never reach the status view", async () => {
  const { manager, owner, requests } = setup();
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner);
  const page = await runCallback(manager, callbackUrl(started, { error: "access_denied", error_description: "RAW-PROVIDER-WORDS" }));
  expect(page.status).toBe(200);
  const done = await view(manager, "google", owner);
  expect(done.body.state).toBe("error");
  expect(done.body.message).toContain("취소");
  expect(JSON.stringify(done.body)).not.toContain("RAW-PROVIDER-WORDS");
  expect(requests.length).toBe(0);
});

test("a failed exchange reports one attempt, keeps no connection and never auto-repeats", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => new Response("upstream exploded", { status: 500 })]]);
  const { manager, owner, ledger, requests } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const done = await settled(manager, "google", owner);
  expect(done.body.state).toBe("error");
  expect(done.body.message).toContain("로그인 처리에 실패");
  expect(ledger.connections()).toEqual([]);
  expect(requests.length).toBe(1);
});

test("google refuses a login that would expire without a refresh token", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, expires_in: 3600 })]]);
  const { manager, owner, ledger, requests } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const done = await settled(manager, "google", owner);
  expect(done.body.state).toBe("error");
  expect(done.body.message).toContain("갱신 토큰");
  expect(ledger.connections()).toEqual([]);
  expect(requests.length).toBe(1);
});

test("a connection whose identity test fails is stored but never claimed connected", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, owner, ledger, sources, root, requests } = setup({ routes });
  sources.fail = true;
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const done = await settled(manager, "google", owner);
  expect(done.body.state).toBe("error");
  const row = ledger.connections().find(connection => connection.serviceId === "google")!;
  expect(done.body.connectionId).toBe(row.id);
  expect(sources.credentials.get(row.id)?.value).toBe(ACCESS);
  expect(existsSync(bindingPath(root, row.id))).toBe(false);
  expect(requests.length).toBe(1);
});

test("notion exchanges JSON over Basic auth and registers the catalog configuration", async () => {
  const routes = new Map<string, Route>([[NOTION_TOKEN, init => {
    expect(AUTH(init)).toBe(basic(CLIENT_ID, CLIENT_SECRET));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    const body = JSON_BODY(init);
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("code-1");
    expect(body.redirect_uri).toBe(REDIRECT);
    expect(body.client_id).toBeUndefined();
    return Response.json({ access_token: ACCESS, workspace_name: "workspace" });
  }]]);
  const { manager, owner, ledger, ghost, root } = setup({ routes });
  await configure(manager, "notion", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "notion", owner, { name: "노션", ghostIds: [ghost.id] });
  expect(new URL(String(started.body.authorizationUrl)).searchParams.get("scope")).toBeNull();
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const done = await settled(manager, "notion", owner);
  expect(done.body.state).toBe("connected");
  const row = ledger.connections().find(connection => connection.serviceId === "notion")!;
  const binding: Record<string, unknown> = JSON.parse(readFileSync(bindingPath(root, row.id), "utf8"));
  // Notion tokens do not expire; the binding exists but carries no refresh material.
  expect(binding.refreshToken).toBeNull();
  expect(binding.scope).toBeNull();
});

test("slack exchanges form bodies over Basic auth", async () => {
  const routes = new Map<string, Route>([[SLACK_TOKEN, init => {
    expect(AUTH(init)).toBe(basic(CLIENT_ID, CLIENT_SECRET));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = TOKEN_BODY(init);
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    return Response.json({ ok: true, access_token: ACCESS, token_type: "bot", team: { id: "T1" } });
  }]]);
  const { manager, owner, ledger } = setup({ routes });
  await configure(manager, "slack", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "slack", owner);
  expect(new URL(String(started.body.authorizationUrl)).searchParams.get("scope")).toBe("channels:read");
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const done = await settled(manager, "slack", owner);
  expect(done.body.state).toBe("connected");
  const row = ledger.connections().find(connection => connection.serviceId === "slack")!;
  if (row.config.kind !== "api") throw new Error("expected an api connection");
  expect(row.config.baseUrl).toBe("https://slack.com/api/");
});

test("x works as a public PKCE client without a secret and uses Basic auth when one exists", async () => {
  const publicRoutes = new Map<string, Route>([[X_TOKEN, init => {
    expect(AUTH(init)).toBeNull();
    const form = TOKEN_BODY(init);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBeNull();
    expect(form.get("code_verifier")).not.toBeNull();
    return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 7200 });
  }]]);
  const { manager, owner, ledger } = setup({ routes: publicRoutes });
  await configure(manager, "x", new Access({ kind: "owner" }), CLIENT_ID);
  const started = await startLogin(manager, "x", new Access({ kind: "owner" }));
  expect(new URL(String(started.body.authorizationUrl)).searchParams.get("scope")).toBe("tweet.read users.read offline.access");
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  expect((await settled(manager, "x", new Access({ kind: "owner" }))).body.state).toBe("connected");
  const row = ledger.connections().find(connection => connection.serviceId === "x")!;
  if (row.config.kind !== "api") throw new Error("expected an api connection");
  expect(row.config.baseUrl).toBe("https://api.x.com/2/");
  // A confidential X client authenticates its exchange with Basic auth instead.
  const confidentialRoutes = new Map<string, Route>([[X_TOKEN, init => {
    expect(AUTH(init)).toBe(basic(CLIENT_ID, CLIENT_SECRET));
    return Response.json({ access_token: ACCESS2, refresh_token: REFRESH2, expires_in: 7200 });
  }]]);
  const confidential = setup({ routes: confidentialRoutes });
  await configure(confidential.manager, "x", confidential.owner, CLIENT_ID, CLIENT_SECRET);
  const retry = await startLogin(confidential.manager, "x", confidential.owner);
  await runCallback(confidential.manager, callbackUrl(retry, { code: "code-2" }));
  expect((await settled(confidential.manager, "x", confidential.owner)).body.state).toBe("connected");
});

test("outlook requires the full username and registers the oauth2 mail preset", async () => {
  const routes = new Map<string, Route>([[OUTLOOK_TOKEN, init => {
    const form = TOKEN_BODY(init);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect((form.get("code_verifier") ?? "").length).toBeGreaterThanOrEqual(43);
    return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
  }]]);
  const { manager, owner, ledger, sources, root, tick } = setup({ routes });
  await configure(manager, "outlook", owner, CLIENT_ID, CLIENT_SECRET);
  await expect(startLogin(manager, "outlook", owner, { name: "메일", ghostIds: [] })).rejects.toThrow("이메일 주소 전체");
  await expect(startLogin(manager, "outlook", owner, { name: "메일", ghostIds: [], username: "not-an-address" })).rejects.toThrow("올바른 이메일");
  const started = await startLogin(manager, "outlook", owner, { name: "메일", ghostIds: [], username: "owner@outlook.com" });
  expect(new URL(String(started.body.authorizationUrl)).searchParams.get("scope")).toBe("offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send");
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const done = await settled(manager, "outlook", owner);
  expect(done.body.state).toBe("connected");
  const row = ledger.connections().find(connection => connection.serviceId === "outlook")!;
  expect(row.config).toEqual({ kind: "mail", host: "outlook.office365.com", port: 993, username: "owner@outlook.com", mailbox: "INBOX", smtpHost: "smtp-mail.outlook.com", smtpPort: 587, smtpSecure: false, authType: "oauth2" });
  expect(sources.credentials.get(row.id)).toEqual({ value: ACCESS, version: row.credentialVersion });
  // Expired access tokens refresh single-flight on the same credential epoch.
  routes.set(OUTLOOK_TOKEN, init => {
    const form = TOKEN_BODY(init);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    return Response.json({ access_token: ACCESS2, refresh_token: REFRESH2, expires_in: 3600 });
  });
  tick(3600);
  await manager.refresh(ledger.connection(row.id));
  expect(sources.credentials.get(row.id)).toEqual({ value: ACCESS2, version: row.credentialVersion });
  const binding: Record<string, unknown> = JSON.parse(readFileSync(bindingPath(root, row.id), "utf8"));
  expect(binding.refreshToken).toBe(REFRESH2);
});

test("refresh keeps the stored refresh token and granted scope when the response omits them", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, owner, ledger, sources, root, requests, tick } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner, { name: "드라이브", ghostIds: [], googleDrive: true });
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  await settled(manager, "google", owner);
  const row = ledger.connections().find(connection => connection.serviceId === "google")!;
  routes.set(GOOGLE_TOKEN, init => {
    const form = TOKEN_BODY(init);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.readonly");
    expect(form.has("refresh_token")).toBe(true);
    return Response.json({ access_token: ACCESS2, expires_in: 3600 });
  });
  tick(3600);
  await manager.refresh(ledger.connection(row.id));
  expect(sources.credentials.get(row.id)).toEqual({ value: ACCESS2, version: row.credentialVersion });
  const binding: Record<string, unknown> = JSON.parse(readFileSync(bindingPath(root, row.id), "utf8"));
  expect(binding.refreshToken).toBe(REFRESH);
  expect(requests.length).toBe(2);
});

test("a failed refresh fails loudly, sanitized and unrepeated", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, owner, ledger, requests, tick } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const row = ledger.connection(requireId((await settled(manager, "google", owner)).body.connectionId));
  routes.set(GOOGLE_TOKEN, () => {
    throw new Error(`network down while sending ${REFRESH}`);
  });
  tick(3600);
  const failure = await manager.refresh(row).then(() => null, (error: Error) => error);
  expect(failure).not.toBeNull();
  expect(failure!.message).toContain("갱신에 실패");
  expect(failure!.message).not.toContain(REFRESH);
  expect(requests.length).toBe(2);
});

test("a deleted connection loses its refresh binding and never refreshes again", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, core, owner, ledger, root, requests, tick } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const row = ledger.connection(requireId((await settled(manager, "google", owner)).body.connectionId));
  tick(3600);
  await execute(core, owner, { requestId: "manual-del-1", command: { type: "connection.delete", connectionId: row.id } }, { publicOrigin: ORIGIN, documents: null });
  expect(requests.length).toBe(1);
  await manager.refresh(row);
  expect(requests.length).toBe(1);
  expect(existsSync(bindingPath(root, row.id))).toBe(false);
});

test("a replaced credential epoch or client app stops auto-refresh and asks for a relink", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, core, owner, ledger, root, requests, tick } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const row = ledger.connection(requireId((await settled(manager, "google", owner)).body.connectionId));
  tick(3600);
  // Owner replaced the credential manually: the epoch moved, so the binding is dead.
  await execute(core, owner, { requestId: "manual-upsert-1", command: { type: "connection.upsert", connectionId: row.id, name: row.name, config: row.config, credential: "manual-pasted-token", serviceId: "google" } }, { publicOrigin: ORIGIN, documents: null });
  await manager.refresh(row);
  expect(requests.length).toBe(1);
  expect(existsSync(bindingPath(root, row.id))).toBe(false);
  // A replaced client app keeps the stale binding only as the relink signal; refresh is refused.
  const second = setup({ routes });
  await configure(second.manager, "google", second.owner, CLIENT_ID, CLIENT_SECRET);
  const retry = await startLogin(second.manager, "google", second.owner);
  await runCallback(second.manager, callbackUrl(retry, { code: "code-2" }));
  const secondRow = second.ledger.connection(requireId((await settled(second.manager, "google", second.owner)).body.connectionId));
  await configure(second.manager, "google", second.owner, "client-two", CLIENT_SECRET);
  const status = await view(second.manager, "google", second.owner);
  expect(status.body.state).toBe("error");
  expect(status.body.message).toContain("다시 로그인");
  second.tick(3600);
  await expect(second.manager.refresh(secondRow)).rejects.toThrow();
  expect(second.requests.length).toBe(1);
  expect(existsSync(bindingPath(second.root, secondRow.id))).toBe(true);
});

test("revoking the initiating device stops the in-flight exchange", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, init => {
    const gate = Promise.withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => gate.reject(new Error("aborted")), { once: true });
    return gate.promise;
  }]]);
  const { manager, ledger, sources, deviceAccess, owner } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", deviceAccess, { name: "기기 로그인", ghostIds: [] });
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  ledger.tx(() => ledger.revokeDevice("device-1", Date.now()));
  const done = await settled(manager, "google", owner);
  expect(done.body.state).toBe("error");
  expect(done.body.message).toContain("해제");
  expect(ledger.connections()).toEqual([]);
  expect(sources.credentials.size).toBe(0);
});

test("a changed Ghost grant set aborts login instead of silently changing the approved scope", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, core, owner, ledger } = setup({ routes });
  const extra = core.createGhost({ name: "보조", persona: "도움" });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const started = await startLogin(manager, "google", owner, { name: "필터", ghostIds: [ledger.ghosts()[0]!.id, extra.id] });
  // The ghost disappears while the login is in flight.
  updateGhost(core, extra.id, { state: "retired" });
  await runCallback(manager, callbackUrl(started, { code: "code-1" }));
  const done = await settled(manager, "google", owner);
  expect(done.body.state).toBe("error");
  expect(ledger.connections()).toEqual([]);
});

test("route ownership, methods and authentication follow the contract", async () => {
  const { manager } = setup();
  const principal = new Access({ kind: "owner" });
  expect((await manager.handle(new Request(serviceUrl("unknown")), serviceUrl("unknown"), principal))?.status).toBe(404);
  expect(await manager.handle(new Request(new URL(`${ORIGIN}/api/other`)), new URL(`${ORIGIN}/api/other`), principal)).toBeNull();
  expect((await manager.handle(new Request(serviceUrl("google"), { method: "PATCH" }), serviceUrl("google"), principal))?.status).toBe(405);
  expect((await manager.handle(new Request(serviceUrl("google")), serviceUrl("google"), null))?.status).toBe(401);
  const post = new Request(new URL(`${ORIGIN}/api/connection-oauth/callback`), { method: "POST" });
  expect(await manager.handle(post, new URL(`${ORIGIN}/api/connection-oauth/callback`), principal)).toBeNull();
});

test("malformed inputs are rejected with sanitized messages", async () => {
  const { manager, owner } = setup();
  const broken = new Request(serviceUrl("google"), { method: "PUT", body: "{broken", headers: { "content-type": "application/json" } });
  await expect(manager.handle(broken, serviceUrl("google"), owner)).rejects.toThrow("malformed JSON body");
  await expect(jsonRequest(manager, "PUT", "google", owner, { clientId: "" })).rejects.toThrow("요청 형식");
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  await expect(startLogin(manager, "google", owner, { name: "x", ghostIds: ["missing-ghost"] })).rejects.toThrow("Ghost");
  const joined = await startLogin(manager, "google", owner);
  const again = await startLogin(manager, "google", owner);
  expect(again.body.authorizationUrl).toBe(joined.body.authorizationUrl);
});

test("a second login adds an independent service account without replacing the first", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, init => Response.json({ access_token: TOKEN_BODY(init).get("code") === "first" ? ACCESS : ACCESS2, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, owner, ledger, sources } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const first = await startLogin(manager, "google", owner, { name: "개인", ghostIds: [] });
  await runCallback(manager, callbackUrl(first, { code: "first" }));
  const firstId = requireId((await settled(manager, "google", owner)).body.connectionId);
  const second = await startLogin(manager, "google", owner, { name: "업무", ghostIds: [] });
  await runCallback(manager, callbackUrl(second, { code: "second" }));
  const secondId = requireId((await settled(manager, "google", owner)).body.connectionId);
  expect(secondId).not.toBe(firstId);
  expect(ledger.connection(firstId).name).toBe("개인");
  expect(ledger.connection(secondId).name).toBe("업무");
  expect(sources.credentials.get(firstId)?.value).toBe(ACCESS);
  expect(sources.credentials.get(secondId)?.value).toBe(ACCESS2);
});

test("an uncertain rotating refresh is not resent by another operation or a manager restart", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, core, root, owner, ledger, requests, tick } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const login = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(login, { code: "first" }));
  const row = ledger.connection(requireId((await settled(manager, "google", owner)).body.connectionId));
  routes.set(GOOGLE_TOKEN, () => { throw new Error("uncertain provider delivery"); });
  tick(3600);
  await expect(manager.refresh(row)).rejects.toThrow();
  await expect(manager.refresh(row)).rejects.toThrow();
  expect(requests).toHaveLength(2);
  manager.close();
  let repeated = false;
  const restarted = new ConnectionOAuth(core, { root, publicOrigin: ORIGIN }, { fetch: (async () => { repeated = true; return Response.json({ access_token: ACCESS2 }); }) as ConnectionOAuthFetch });
  try {
    await expect(restarted.refresh(row)).rejects.toThrow();
    expect(repeated).toBe(false);
    expect((await view(restarted, "google", owner)).body.state).toBe("error");
  } finally { restarted.close(); }
});

test("API grant revocation preserves OAuth renewal and explicit icon removal", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, core, root, owner, ghost, ledger, sources, tick } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const login = await startLogin(manager, "google", owner, { name: "계정", ghostIds: [ghost.id] });
  await runCallback(manager, callbackUrl(login, { code: "first" }));
  const row = ledger.connection(requireId((await settled(manager, "google", owner)).body.connectionId));
  if (row.config.kind !== "api") throw new Error("API row required");
  await execute(core, owner, { requestId: "set-icon", command: { type: "connection.upsert", connectionId: row.id, name: row.name, config: row.config, iconUrl: "https://example.com/icon.svg" } }, { publicOrigin: ORIGIN, documents: null });
  await execute(core, owner, { requestId: "revoke-grant", command: { type: "connection.upsert", connectionId: row.id, name: row.name, config: { ...row.config, ghostIds: [] }, iconUrl: null } }, { publicOrigin: ORIGIN, documents: null });
  const revoked = ledger.connection(row.id);
  expect(revoked.hasCredential).toBe(true);
  expect(revoked.credentialVersion).toBe(row.credentialVersion);
  expect(revoked.iconUrl).toBeUndefined();
  expect(existsSync(bindingPath(root, row.id))).toBe(true);
  routes.set(GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS2, refresh_token: REFRESH2, expires_in: 3600 }));
  tick(3600);
  await manager.refresh(revoked);
  expect(sources.credentials.get(row.id)?.value).toBe(ACCESS2);
  await execute(core, owner, { requestId: "delete-oauth", command: { type: "connection.delete", connectionId: row.id } }, { publicOrigin: ORIGIN, documents: null });
  expect(existsSync(bindingPath(root, row.id))).toBe(false);
});

test("a definite provider rejection settles the exchange without an owner uncertainty card", async () => {
  const { manager, owner, ledger } = setup({ routes: new Map([[GOOGLE_TOKEN, () => Response.json({ error: "invalid_grant" }, { status: 400 })]]) });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const login = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(login, { code: "rejected" }));
  expect((await settled(manager, "google", owner)).body.state).toBe("error");
  const effect = ledger.effectByCall(ledger.defaultGhost()!.directConversationId, `api:connection-oauth:exchange:${stateOf(login)}`);
  expect(effect?.state).toBe("denied");
  expect(ledger.pendingDecisions().some(decision => decision.kind === "reconcile_effect")).toBe(false);
});

test("OAuth binding cleanup failure cannot turn a committed account deletion into an unknown effect", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, core, root, owner, ledger } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const login = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(login, { code: "first" }));
  const id = requireId((await settled(manager, "google", owner)).body.connectionId);
  rmSync(bindingPath(root, id));
  mkdirSync(bindingPath(root, id));
  const observed: string[] = [];
  const unwatch = ledger.subscribe(event => { observed.push(event.data.type); });
  try {
    await execute(core, owner, { requestId: "delete-with-cleanup-fault", command: { type: "connection.delete", connectionId: id } }, { publicOrigin: ORIGIN, documents: null });
    expect(ledger.findConnection(id)).toBeNull();
    expect(ledger.request("delete-with-cleanup-fault")?.state).toBe("done");
    expect(ledger.effectByCall(ledger.defaultGhost()!.directConversationId, "api:delete-with-cleanup-fault")?.state).toBe("done");
    expect(observed).toContain("connection.removed");
  } finally { unwatch(); }
});

test("an owner authentication probe can renew OAuth without re-entering its own account lane", async () => {
  const routes = new Map<string, Route>([[GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 })]]);
  const { manager, core, owner, ledger, sources, tick, requests } = setup({ routes });
  await configure(manager, "google", owner, CLIENT_ID, CLIENT_SECRET);
  const login = await startLogin(manager, "google", owner);
  await runCallback(manager, callbackUrl(login, { code: "first" }));
  const row = ledger.connection(requireId((await settled(manager, "google", owner)).body.connectionId));
  sources.test = async connection => {
    await manager.refresh(connection);
    return { summary: "authenticated" };
  };
  routes.set(GOOGLE_TOKEN, () => Response.json({ access_token: ACCESS2, refresh_token: REFRESH2, expires_in: 3600 }));
  tick(3600);
  await execute(core, owner, { requestId: "probe-with-renewal", command: { type: "connection.test", connectionId: row.id } }, { publicOrigin: ORIGIN, documents: null });
  expect(ledger.request("probe-with-renewal")?.state).toBe("done");
  expect(sources.credentials.get(row.id)?.value).toBe(ACCESS2);
  expect(requests).toHaveLength(2);
});

test("owner metadata connects and refreshes an unknown OAuth API without a provider-specific Host path", async () => {
  const tokenUrl = "https://calendar.example/token";
  let exchanges = 0;
  const routes = new Map<string, Route>([[tokenUrl, init => {
    const body = JSON_BODY(init);
    expect(body.client_id).toBe(CLIENT_ID);
    if (++exchanges === 1) {
      expect(body.code_verifier).toBeString();
      expect(body.grant_type).toBe("authorization_code");
      return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    }
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe(REFRESH);
    return Response.json({ access_token: ACCESS2, refresh_token: REFRESH2, expires_in: 3600 });
  }]]);
  const s = setup({ routes });
  const provider = {
    authorize: "https://calendar.example/authorize", token: tokenUrl, scope: "events.read events.write",
    body: "json", clientAuth: "secret-body", requiresSecret: false, requiresRefreshToken: true,
    authorizationParams: { access_type: "offline" },
    connection: { kind: "api", baseUrl: "https://calendar.example/api/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "users/me", headers: {}, readPaths: [{ method: "POST", path: "/events/search" }] },
  };
  expect((await jsonRequest(s.manager, "PUT", "calendar", s.owner, { clientId: CLIENT_ID, provider })).status).toBe(200);
  const started = await startLogin(s.manager, "calendar", s.owner, { name: "Calendar", ghostIds: [s.ghost.id] });
  const authorize = new URL(String(started.body.authorizationUrl));
  expect(authorize.origin).toBe("https://calendar.example");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("access_type")).toBe("offline");
  await runCallback(s.manager, callbackUrl(started, { code: "owner-code" }));
  const connected = await settled(s.manager, "calendar", s.owner);
  expect(connected.body.state).toBe("connected");
  const connection = s.ledger.connection(requireId(connected.body.connectionId));
  expect(connection.config).toMatchObject({ ...provider.connection, ghostIds: [s.ghost.id] });
  expect(JSON.stringify(connected.body)).not.toContain(ACCESS);
  s.tick(3500);
  await s.manager.refresh(connection);
  expect(s.sources.credentials.get(connection.id)?.value).toBe(ACCESS2);
});

test("generic OAuth metadata cannot overwrite state or PKCE parameters", async () => {
  const s = setup();
  await expect(jsonRequest(s.manager, "PUT", "custom", s.owner, {
    clientId: CLIENT_ID,
    provider: { authorize: "https://example.com/authorize", token: "https://example.com/token", scope: null, body: "form", clientAuth: "secret-body", requiresSecret: false, requiresRefreshToken: false, authorizationParams: { state: "predictable" }, connection: { kind: "api", baseUrl: "https://example.com/api", authHeader: "Authorization", authPrefix: "Bearer", testPath: "me", headers: {} } },
  })).rejects.toThrow("cannot override");
});
