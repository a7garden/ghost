import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  connectionCredentialScope,
  ConnectionOAuthClientInput,
  ConnectionOAuthStart,
  ConnectionOAuthMetadata,
  validate,
  parse,
  type Command,
  type Connection,
  type ConnectionConfig,
  type ConnectionOAuthServiceId,
  type ConnectionOAuthView,
} from "@ghost/contract";
import { Access } from "../core/access.ts";
import { execute } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { CommandError, invalid } from "../core/errors.ts";
import { digestOf } from "../core/ids.ts";
import { validateConnectionConfig } from "../integrations/activity-sources.ts";

export type ConnectionOAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ConnectionOAuthDependencies {
  /** Test seam only; TLS and fixed endpoints are never relaxed. */
  fetch?: ConnectionOAuthFetch;
  now?: () => number;
}

const CALLBACK_PATH = "/api/connection-oauth/callback";
const STATE_TTL = 15 * 60 * 1000;
const EXCHANGE_TIMEOUT = 15_000;
const MAX_TOKEN_BODY = 128 * 1024;
/** Refresh this long before the provider's own expiry, so a scheduled poll never runs on a dead token. */
const REFRESH_AHEAD = 120_000;

/** Fixed host wording; provider error bodies, client secrets and tokens never enter any message, log or row. */
const MESSAGE = {
  bodyMalformed: "malformed JSON body",
  inputInvalid: "요청 형식이 올바르지 않습니다.",
  method: "use GET, PUT, POST or DELETE",
  internal: "요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  clientRequired: "이 서비스에는 먼저 OAuth 앱(client ID) 등록이 필요합니다.",
  secretRequired: "이 서비스는 client secret이 필요합니다. 앱 구성에 secret을 저장한 뒤 다시 시도해 주세요.",
  usernameRequired: "Outlook 메일 연결에는 로그인할 이메일 주소 전체가 필요합니다.",
  usernameInvalid: "올바른 이메일 주소를 입력해 주세요.",
  ghostMissing: "권한을 줄 Ghost를 찾을 수 없습니다. 목록을 새로고침해 주세요.",
  originInvalid: "publicOrigin 설정을 확인해 주세요.",
  expired: "로그인 시간이 만료되었습니다. 다시 로그인해 주세요.",
  cancelled: "로그인이 취소되었거나 거부되었습니다. 다시 시도해 주세요.",
  clientChanged: "앱 구성이 변경되어 로그인이 중단되었습니다. 다시 로그인해 주세요.",
  deviceRevoked: "연결된 기기가 해제되어 로그인이 중단되었습니다.",
  exchangeFailed: "로그인 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  noRefresh: "갱신 토큰이 없어 연결을 유지할 수 없습니다. 앱의 오프라인 접근(offline access) 설정을 확인한 뒤 다시 로그인해 주세요.",
  registerFailed: "연결 등록에 실패했습니다. 다시 로그인해 주세요.",
  testFailed: "연결은 만들어졌지만 확인에 실패했습니다. 앱 권한(스코프)을 점검한 뒤 다시 로그인해 주세요.",
  refreshFailed: "OAuth 액세스 토큰 갱신에 실패했습니다. 이 계정을 다시 로그인해 주세요.",
  relink: "이 연결은 이전 앱 구성으로 만들어졌습니다. 다시 로그인해 주세요.",
  unknownState: "invalid or expired login state",
  closed: "connection OAuth manager is closed",
} as const;

/** The owner's OAuth app registration for one service; the secret lives only in this 0600 file. */
interface ClientApp {
  clientId: string;
  clientSecret: string | null;
  /** Bumped on every content change; refresh bindings recorded under an older generation stop auto-refreshing. */
  generation: number;
  updatedAt: number;
  provider?: ConnectionOAuthMetadata;
}

/** A persisted refresh token, bound to the connection row it may renew — never resurrected. */
interface RefreshBinding {
  serviceId: ConnectionOAuthServiceId;
  connectionId: string;
  credentialVersion: string;
  configDigest: string;
  appGeneration: number;
  refreshToken: string | null;
  expiresAt: number | null;
  /** Originally granted scopes; a refresh grant must not widen them. */
  scope: string | null;
  /** Persisted before token exchange; an interrupted/uncertain rotating grant is never resent. */
  refreshState: "ready" | "pending";
  updatedAt: number;
}

interface TokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

interface Attempt {
  service: ConnectionOAuthServiceId;
  state: "pending" | "connected" | "error";
  authorizationUrl: string | null;
  message: string | null;
  connectionId: string | null;
  /** The random single-use state parameter; also the deterministic registration request id. */
  token: string;
  verifier: string;
  /** Started-at clock, a belt alongside the TTL timer for expiring stale states at callback time. */
  createdAt: number;
  appGeneration: number;
  /** Exactly the scope string sent to the provider; the refresh grant repeats it verbatim. */
  scope: string | null;
  start: { name: string; ghostIds: string[]; username: string | null };
  principal: { kind: "owner" } | { kind: "device"; deviceId: string; deviceName: string };
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

/** A failed login whose wording is fixed host text; provider bodies never reach it. */
class LoginFailure extends Error {}
class TokenRejected extends LoginFailure {}

interface ProviderSpec {
  authorize: string;
  token: string;
  /** Minimum scopes for this connection's use; the owner's app registration must allow them. */
  scope: string | null;
  /** Token endpoint body encoding; Notion documents JSON with Basic auth. */
  body: "form" | "json";
  /** How the client app authenticates at the token endpoint. */
  clientAuth: "secret-body" | "basic" | "secret-basic";
  /** Login is refused before any network call when the owner has not stored a secret for this service. */
  requiresSecret: boolean;
  /** Login is refused without a refresh token; the connection would die within hours without one. */
  requiresRefreshToken: boolean;
  requiresUsername: boolean;
  /** The registered row carries `ghostIds` (api kind); the Outlook mail row does not. */
  ghostScoped: boolean;
}

const PROVIDERS: Record<ConnectionOAuthServiceId, ProviderSpec> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email",
    body: "form",
    clientAuth: "secret-body",
    requiresSecret: true,
    requiresRefreshToken: true,
    requiresUsername: false,
    ghostScoped: true,
  },
  outlook: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
    body: "form",
    clientAuth: "secret-body",
    requiresSecret: true,
    requiresRefreshToken: true,
    requiresUsername: true,
    ghostScoped: false,
  },
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    scope: "tweet.read users.read offline.access",
    body: "form",
    clientAuth: "secret-basic",
    requiresSecret: false,
    requiresRefreshToken: true,
    requiresUsername: false,
    ghostScoped: true,
  },
  notion: {
    authorize: "https://api.notion.com/v1/oauth/authorize",
    token: "https://api.notion.com/v1/oauth/token",
    // Capabilities are chosen on the integration, not in the URL.
    scope: null,
    body: "json",
    clientAuth: "basic",
    requiresSecret: true,
    requiresRefreshToken: false,
    requiresUsername: false,
    ghostScoped: true,
  },
  slack: {
    authorize: "https://slack.com/oauth/v2/authorize",
    token: "https://slack.com/api/oauth.v2.access",
    scope: "channels:read",
    body: "form",
    clientAuth: "basic",
    requiresSecret: true,
    requiresRefreshToken: false,
    requiresUsername: false,
    ghostScoped: true,
  },
};

const isService = (value: unknown): value is ConnectionOAuthServiceId =>
  typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);

const EMAIL = /^[^\s<>@,;:\r\n]+@[^\s<>@,;:\r\n]+$/;

/** The fixed per-service connection row this login registers; the credential is the access token. */
function connectionConfig(service: ConnectionOAuthServiceId, username: string, ghostIds: string[], provider?: ConnectionOAuthMetadata): ConnectionConfig {
  if (provider) return { ...provider.connection, ghostIds };
  switch (service) {
    case "google":
      return { kind: "api", baseUrl: "https://www.googleapis.com/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "oauth2/v3/userinfo", headers: {}, ghostIds };
    case "x":
      return { kind: "api", baseUrl: "https://api.x.com/2/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "users/me", headers: {}, ghostIds };
    case "notion":
      return { kind: "api", baseUrl: "https://api.notion.com/v1/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "users/me", headers: { "Notion-Version": "2026-03-11" }, ghostIds };
    case "slack":
      return { kind: "api", baseUrl: "https://slack.com/api/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "auth.test", headers: {}, ghostIds };
    case "outlook":
      return { kind: "mail", host: "outlook.office365.com", port: 993, username, mailbox: "INBOX", smtpHost: "smtp-mail.outlook.com", smtpPort: 587, smtpSecure: false, authType: "oauth2" };
  }
  throw invalid("Configure OAuth provider metadata before connecting this service");
}

function providerSpec(service: string, client: ClientApp): ProviderSpec {
  if (client.provider) return { ...client.provider, requiresUsername: false, ghostScoped: true };
  const spec = Object.hasOwn(PROVIDERS, service) ? PROVIDERS[service] : undefined;
  if (!spec) throw invalid("Configure OAuth provider metadata before connecting this service");
  return spec;
}

/** Bounded token response reading; a parse or shape failure is a fixed login failure, never raw provider text. */
function readToken(payload: unknown, now: number): TokenResult {
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  if (!accessToken || accessToken.length > 8192 || /[\r\n\0]/.test(accessToken)) throw new LoginFailure(MESSAGE.exchangeFailed);
  const refreshToken = typeof record.refresh_token === "string" && record.refresh_token.length <= 8192 && !/[\r\n\0]/.test(record.refresh_token)
    ? record.refresh_token
    : null;
  const expiresAt = typeof record.expires_in === "number" && Number.isFinite(record.expires_in) && record.expires_in > 0
    ? now + Math.min(Math.round(record.expires_in), 2_592_000) * 1000
    : null;
  return { accessToken, refreshToken, expiresAt };
}

const jsonView = (view: ConnectionOAuthView) =>
  new Response(JSON.stringify(view), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

const error = (code: "invalid" | "forbidden" | "not_found", message: string, status: number) =>
  new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Real OAuth authorization-code + PKCE logins for the built-in services that cannot be pasted as tokens.
 *
 * Ephemeral attempts are bound to the initiating principal and a random single-use state; the durable
 * facts are the client app registration and the refresh binding — both 0600 files under
 * `<root>/secrets/connection-oauth`, never ledger rows. Registration goes through the ordinary
 * owner `connection.upsert` journal path, and the access token is only claimed connected after the
 * source port's identity test passes. `refresh` is the ActivitySourcePort refresher: it fails loudly,
 * never retries an uncertain exchange, and never resurrects a deleted or replaced connection.
 */
export class ConnectionOAuth {
  private readonly attempts = new Map<ConnectionOAuthServiceId, Attempt>();
  private readonly byState = new Map<string, Attempt>();
  private readonly refreshFlights = new Map<string, Promise<void>>();
  private readonly unwatch: () => void;
  private readonly fetch: ConnectionOAuthFetch;
  private readonly now: () => number;
  private readonly dir: string;
  private readonly redirectUri: string;
  private closed = false;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly core: Core,
    private readonly config: { root: string; publicOrigin: string },
    dependencies?: ConnectionOAuthDependencies,
  ) {
    this.fetch = dependencies?.fetch ?? ((input, init) => fetch(input, init));
    this.now = dependencies?.now ?? (() => Date.now());
    this.dir = join(config.root, "secrets", "connection-oauth");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    try {
      this.redirectUri = new URL(CALLBACK_PATH, config.publicOrigin).toString();
    } catch {
      this.redirectUri = `${config.publicOrigin}${CALLBACK_PATH}`;
    }
    // A revoked device stops its in-flight login immediately.
    this.unwatch = core.ledger.subscribe(event => {
      try {
        if (event.data.type === "connection.removed") {
          this.deleteBinding(event.data.id);
          return;
        }
        if (event.data.type === "connection") {
          const connection = event.data.connection;
          const binding = this.loadBinding(connection.id);
          if (binding && (!connection.hasCredential || connection.credentialVersion !== binding.credentialVersion || digestOf(connectionCredentialScope(connection.config)) !== binding.configDigest)) this.deleteBinding(connection.id);
          return;
        }
      } catch {
        core.log("OAuth refresh-secret cleanup failed; the account authority remains revoked.");
        return;
      }
      if (event.data.type !== "device.removed") return;
      for (const attempt of this.attempts.values()) {
        if (attempt.state === "pending" && attempt.principal.kind === "device" && attempt.principal.deviceId === event.data.id) {
          this.failAttempt(attempt, MESSAGE.deviceRevoked);
        }
      }
    });
  }

  /** Owns `/api/connection-oauth/:service` and the unauthenticated single-use `/api/connection-oauth/callback`; null elsewhere. */
  async handle(request: Request, url: URL, access: Access | null): Promise<Response | null> {
    if (url.pathname === CALLBACK_PATH) {
      if (request.method !== "GET") return null;
      return this.callback(url);
    }
    const match = /^\/api\/connection-oauth\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(url.pathname);
    if (match === null) return null;
    const service = match[1]!;
    if (!isService(service)) return error("not_found", "not found", 404);
    if (!access) return error("forbidden", "missing or invalid bearer token", 401);
    if (request.method !== "PUT" && !Object.hasOwn(PROVIDERS, service) && this.loadClient(service) === null) return error("not_found", "not found", 404);
    try {
      if (request.method === "GET") return jsonView(this.view(service));
      if (request.method === "PUT") return jsonView(await this.configure(service, request));
      if (request.method === "POST") return jsonView(await this.start(service, request, access));
      if (request.method === "DELETE") return jsonView(this.cancel(service));
      return error("invalid", MESSAGE.method, 405);
    } catch (caught) {
      if (caught instanceof CommandError) throw caught;
      // Local failures (filesystem) are sanitized; nothing from a provider or a secret file escapes here.
      throw new CommandError("unavailable", MESSAGE.internal);
    }
  }

  /** ActivitySourcePort refresher: cheap no-op unless this row is an expiring OAuth login of ours. */
  async refresh(connection: Connection): Promise<void> {
    if (this.closed) throw new CommandError("unavailable", MESSAGE.closed);
    const previous = this.refreshFlights.get(connection.id);
    if (previous) return previous;
    const flight = this.core.run(`connection:${connection.id}`, async () => {
      const binding = this.loadBinding(connection.id);
      if (binding === null) return;
      const current = this.core.ledger.findConnection(connection.id);
      if (current === null || !current.hasCredential || current.credentialVersion !== binding.credentialVersion || digestOf(connectionCredentialScope(current.config)) !== binding.configDigest) {
        this.deleteBinding(connection.id);
        return;
      }
      const client = this.loadClient(binding.serviceId);
      if (client === null || client.generation !== binding.appGeneration) throw new CommandError("unavailable", MESSAGE.relink);
      if (binding.refreshState !== "ready") throw new CommandError("unavailable", MESSAGE.refreshFailed);
      if ((binding.expiresAt ?? Number.MAX_SAFE_INTEGER) - REFRESH_AHEAD > this.now()) return;
      if (binding.refreshToken === null) throw new CommandError("unavailable", MESSAGE.refreshFailed);
      await this.refreshToken(current, binding, client);
    });
    this.refreshFlights.set(connection.id, flight);
    void flight.catch(() => {}).finally(() => {
      if (this.refreshFlights.get(connection.id) === flight) this.refreshFlights.delete(connection.id);
    });
    return flight;
  }

  /** Aborts in-flight logins and timers and unsets the source refresher. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdown.abort();
    this.unwatch();
    for (const attempt of this.attempts.values()) {
      clearTimeout(attempt.timer);
      attempt.controller.abort();
    }
    this.attempts.clear();
    this.byState.clear();
    this.refreshFlights.clear();
    this.core.activitySources?.setOAuthRefresher?.(null);
  }

  // Views

  private view(service: ConnectionOAuthServiceId): ConnectionOAuthView {
    const client = this.loadClient(service);
    const attempt = this.attempts.get(service);
    const connection = this.newestConnection(service);
    const binding = connection === null ? null : this.loadBinding(connection.id);
    const view: ConnectionOAuthView = {
      serviceId: service,
      configured: client !== null,
      clientId: client?.clientId ?? null,
      redirectUri: this.redirectUri,
      state: "idle",
      authorizationUrl: null,
      connectionId: connection?.id ?? null,
      message: null,
      provider: client?.provider ?? null,
    };
    if (binding !== null && connection?.hasCredential && connection.credentialVersion === binding.credentialVersion && digestOf(connectionCredentialScope(connection.config)) === binding.configDigest) {
      if (client === null || client.generation !== binding.appGeneration) {
        view.state = "error";
        view.message = MESSAGE.relink;
      } else if (binding.refreshState !== "ready") {
        view.state = "error";
        view.message = MESSAGE.refreshFailed;
      } else {
        view.state = "connected";
      }
    }
    if (attempt !== undefined && attempt.state !== "connected") {
      view.state = attempt.state;
      view.message = attempt.message;
      view.authorizationUrl = attempt.state === "pending" ? attempt.authorizationUrl : null;
      if (attempt.connectionId !== null) view.connectionId = attempt.connectionId;
    }
    return view;
  }

  private newestConnection(service: ConnectionOAuthServiceId): Connection | null {
    let newest: Connection | null = null;
    for (const connection of this.core.ledger.connections()) {
      if (connection.serviceId !== service) continue;
      if (newest === null || connection.updatedAt > newest.updatedAt || (connection.updatedAt === newest.updatedAt && connection.id > newest.id)) newest = connection;
    }
    return newest;
  }

  // Owner routes

  private async configure(service: ConnectionOAuthServiceId, request: Request): Promise<ConnectionOAuthView> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalid(MESSAGE.bodyMalformed);
    }
    let input: ConnectionOAuthClientInput;
    try {
      input = parse(ConnectionOAuthClientInput, body);
    } catch {
      throw invalid(MESSAGE.inputInvalid);
    }
    const previous = this.loadClient(service);
    // Omitted secret keeps the stored one for the same client id; a new client id starts without one.
    const clientSecret = input.clientSecret === undefined
      ? previous !== null && previous.clientId === input.clientId ? previous.clientSecret : null
      : input.clientSecret;
    const provider = input.provider ?? previous?.provider;
    if (provider) {
      if (["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"].some(key => Object.hasOwn(provider.authorizationParams ?? {}, key))) throw invalid("OAuth authorization parameters cannot override PKCE, identity, state or scope");
      for (const endpoint of [provider.authorize, provider.token]) {
        let url: URL;
        try { url = new URL(endpoint); } catch { throw invalid("OAuth endpoints must be HTTPS URLs"); }
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw invalid("OAuth endpoints must be HTTPS URLs without credentials, queries or fragments");
      }
      validateConnectionConfig({ ...provider.connection, ghostIds: [] });
    } else if (!Object.hasOwn(PROVIDERS, service)) throw invalid("A new service needs OAuth provider metadata");
    const changed = previous === null || previous.clientId !== input.clientId || (previous.clientSecret ?? null) !== (clientSecret ?? null) || digestOf(previous.provider ?? null) !== digestOf(provider ?? null);
    const generation = changed ? (previous?.generation ?? 0) + 1 : previous!.generation;
    this.writeJson(this.clientFile(service), { clientId: input.clientId, clientSecret, generation, updatedAt: this.now(), ...(provider ? { provider } : {}) } satisfies ClientApp);
    if (changed) {
      const attempt = this.attempts.get(service);
      if (attempt !== undefined && attempt.state === "pending") this.failAttempt(attempt, MESSAGE.clientChanged);
    }
    return this.view(service);
  }

  private async start(service: ConnectionOAuthServiceId, request: Request, access: Access): Promise<ConnectionOAuthView> {
    const client = this.loadClient(service);
    if (client === null) throw invalid(MESSAGE.clientRequired);
    const spec = providerSpec(service, client);
    const pending = this.attempts.get(service);
    // A running login is joined, not duplicated; only a settled attempt is replaced.
    if (pending !== undefined && pending.state === "pending") return this.view(service);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalid(MESSAGE.bodyMalformed);
    }
    let input: ConnectionOAuthStart;
    try {
      input = parse(ConnectionOAuthStart, body);
    } catch {
      throw invalid(MESSAGE.inputInvalid);
    }
    const name = input.name.trim();
    if (!name) throw invalid(MESSAGE.inputInvalid);
    const username = input.username?.trim() ?? null;
    if (spec.requiresUsername) {
      if (!username) throw invalid(MESSAGE.usernameRequired);
      if (!EMAIL.test(username)) throw invalid(MESSAGE.usernameInvalid);
    }
    if (spec.requiresSecret && client.clientSecret === null) throw invalid(MESSAGE.secretRequired);
    for (const id of input.ghostIds ?? []) if (!this.ghostLive(id)) throw invalid(MESSAGE.ghostMissing);
    try {
      new URL(CALLBACK_PATH, this.config.publicOrigin);
    } catch {
      throw new CommandError("invalid", MESSAGE.originInvalid);
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const scope = client.provider || service !== "google" || input.googleDrive !== true
      ? spec.scope
      : `${spec.scope} https://www.googleapis.com/auth/drive.readonly`;
    const params = new URLSearchParams({
      ...client.provider?.authorizationParams,
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: this.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(scope === null ? {} : { scope }),
      ...(!client.provider && service === "google" ? { access_type: "offline", prompt: "consent" } : {}),
      ...(!client.provider && service === "notion" ? { owner: "user" } : {}),
    });
    const principal = access.principal.kind === "owner"
      ? ({ kind: "owner" } as const)
      : { kind: "device" as const, deviceId: access.principal.deviceId, deviceName: access.principal.name };
    const attempt: Attempt = {
      service,
      state: "pending",
      authorizationUrl: `${spec.authorize}?${params.toString()}`,
      message: null,
      connectionId: null,
      token: state,
      verifier,
      createdAt: this.now(),
      appGeneration: client.generation,
      scope,
      start: { name, ghostIds: input.ghostIds ?? [], username },
      principal,
      controller: new AbortController(),
      timer: setTimeout(() => {
        if (attempt.state === "pending") this.failAttempt(attempt, MESSAGE.expired);
      }, STATE_TTL),
    };
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.controller.abort();
      this.byState.delete(pending.token);
    }
    this.attempts.set(service, attempt);
    this.byState.set(state, attempt);
    return this.view(service);
  }

  private cancel(service: ConnectionOAuthServiceId): ConnectionOAuthView {
    const attempt = this.attempts.get(service);
    if (attempt !== undefined) {
      clearTimeout(attempt.timer);
      attempt.controller.abort();
      this.byState.delete(attempt.token);
      this.attempts.delete(service);
    }
    return this.view(service);
  }

  // Callback

  /** Settles a pending attempt into the error state; its single-use state can never be redeemed again. */
  private failAttempt(attempt: Attempt, message: string): void {
    if (attempt.state !== "pending") return;
    attempt.state = "error";
    attempt.message = message;
    attempt.authorizationUrl = null;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    this.byState.delete(attempt.token);
  }

  private callback(url: URL): Response {
    const state = url.searchParams.get("state") ?? "";
    const attempt = state.length > 0 && state.length <= 128 ? this.byState.get(state) : undefined;
    if (attempt === undefined || attempt.state !== "pending") return error("invalid", MESSAGE.unknownState, 400);
    // Single use: consumed before the code exchange, so a replayed or reused callback never runs again.
    this.byState.delete(state);
    clearTimeout(attempt.timer);
    if (this.now() - attempt.createdAt > STATE_TTL) {
      this.failAttempt(attempt, MESSAGE.expired);
      return error("invalid", MESSAGE.unknownState, 400);
    }
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.has("error") || code.length === 0 || code.length > 1024) {
      // Provider error descriptions are never echoed; the wording is fixed.
      this.failAttempt(attempt, MESSAGE.cancelled);
    } else {
      void this.complete(attempt, code);
    }
    return this.callbackPage();
  }

  /** The browser is released at once; registration completes server-side and the app's status poll observes it. */
  private callbackPage(): Response {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Ghost 연결</title><p>로그인 응답을 받았습니다. Ghost 앱으로 돌아가 연결 결과를 확인해 주세요.</p>',
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } },
    );
  }

  private async complete(attempt: Attempt, code: string): Promise<void> {
    const active = () => this.attempts.get(attempt.service) === attempt && attempt.state === "pending" && !attempt.controller.signal.aborted;
    try {
      const client = this.activeClient(attempt);
      const token = await this.exchange(attempt, client, code);
      if (!active()) return;
      // The initiating principal must still exist after the awaited network round-trip.
      this.activeClient(attempt);
      const spec = providerSpec(attempt.service, client);
      if (spec.requiresRefreshToken && token.refreshToken === null) throw new LoginFailure(MESSAGE.noRefresh);
      const ghostIds = spec.ghostScoped ? attempt.start.ghostIds : [];
      const config = connectionConfig(attempt.service, attempt.start.username ?? "", ghostIds, client.provider);
      const connectionId = await this.register(attempt, config, token.accessToken);
      attempt.connectionId = connectionId;
      if (!active()) return;
      const row = this.core.ledger.connection(connectionId);
      if (!row.credentialVersion) throw new LoginFailure(MESSAGE.registerFailed);
      const sources = this.core.activitySources;
      // Connected is only claimed after the provider answers the real identity probe.
      if (sources === null) throw new LoginFailure(MESSAGE.testFailed);
      try { await sources.test(row); }
      catch { throw new LoginFailure(MESSAGE.testFailed); }
      if (!active()) return;
      this.activeClient(attempt);
      const current = this.core.ledger.findConnection(connectionId);
      if (!current?.hasCredential || current.credentialVersion !== row.credentialVersion || digestOf(connectionCredentialScope(current.config)) !== digestOf(connectionCredentialScope(row.config))) throw new LoginFailure(MESSAGE.registerFailed);
      this.writeJson(this.bindingFile(connectionId), {
        serviceId: attempt.service,
        connectionId,
        credentialVersion: row.credentialVersion,
        configDigest: digestOf(connectionCredentialScope(row.config)),
        appGeneration: client.generation,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scope: attempt.scope,
        refreshState: "ready",
        updatedAt: this.now(),
      } satisfies RefreshBinding);
      attempt.state = "connected";
      attempt.message = null;
      attempt.authorizationUrl = null;
      attempt.connectionId = connectionId;
      clearTimeout(attempt.timer);
    } catch (caught) {
      if (!active()) return;
      this.failAttempt(attempt, caught instanceof LoginFailure ? caught.message : MESSAGE.exchangeFailed);
    }
  }

  private activeClient(attempt: Attempt): ClientApp {
    if (this.closed || attempt.controller.signal.aborted || this.attempts.get(attempt.service) !== attempt || attempt.state !== "pending") throw new LoginFailure(MESSAGE.cancelled);
    this.checkPrincipalLive(attempt);
    const client = this.loadClient(attempt.service);
    if (client === null || client.generation !== attempt.appGeneration) throw new LoginFailure(MESSAGE.clientChanged);
    if (attempt.start.ghostIds.some(id => !this.ghostLive(id))) throw new LoginFailure(MESSAGE.ghostMissing);
    return client;
  }

  private checkPrincipalLive(attempt: Attempt): void {
    if (attempt.principal.kind !== "device") return;
    try {
      this.core.ledger.device(attempt.principal.deviceId);
    } catch {
      throw new LoginFailure(MESSAGE.deviceRevoked);
    }
  }

  private async exchange(attempt: Attempt, client: ClientApp, code: string): Promise<TokenResult> {
    const spec = providerSpec(attempt.service, client);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: client.clientId,
      code_verifier: attempt.verifier,
    });
    const headers = new Headers({ accept: "application/json" });
    headers.set("content-type", spec.body === "form" ? "application/x-www-form-urlencoded" : "application/json");
    this.clientAuth(spec, client, headers, form);
    const body = spec.body === "json"
      ? JSON.stringify(client.provider ? Object.fromEntries(form) : { grant_type: "authorization_code", code, redirect_uri: this.redirectUri })
      : form.toString();
    const ghost = this.core.ledger.defaultGhost();
    if (!ghost) throw new LoginFailure(MESSAGE.registerFailed);
    const journal = this.core.effects.beginCommand({
      conversationId: ghost.directConversationId,
      requestId: `connection-oauth:exchange:${attempt.token}`,
      tool: "connection.oauth",
      input: { service: attempt.service, appGeneration: client.generation, stage: "exchange" },
      summary: `${attempt.service} OAuth 로그인`,
    });
    if (journal.kind === "replay") throw new LoginFailure(MESSAGE.expired);
    try {
      const payload = await this.tokenJson(spec.token, {
        method: "POST", redirect: "error", headers, body,
        signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(EXCHANGE_TIMEOUT)]),
      });
      const token = readToken(payload, this.now());
      this.core.effects.finish(journal.effect.id, "OAuth token exchange completed; account authentication is checked separately.");
      return token;
    } catch (caught) {
      if (!this.closed) {
        if (caught instanceof TokenRejected) this.core.effects.deny(journal.effect.id, "The OAuth provider rejected this login. Start a new login.");
        else this.core.effects.unknown(journal.effect.id, "OAuth login exchange could not be confirmed. Do not reuse the authorization code; inspect connected accounts and start a new login.");
      }
      throw new LoginFailure(MESSAGE.exchangeFailed);
    }
  }

  private clientAuth(spec: ProviderSpec, client: ClientApp, headers: Headers, form: URLSearchParams): void {
    if (spec.clientAuth === "secret-body") {
      if (client.clientSecret !== null) form.set("client_secret", client.clientSecret);
      return;
    }
    if (client.clientSecret === null) {
      // Notion and Slack have no public fallback; X falls back to the public PKCE client_id already in the body.
      if (spec.clientAuth === "basic") throw new LoginFailure(MESSAGE.secretRequired);
      return;
    }
    headers.set("authorization", `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`);
  }

  private async tokenJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch {
      throw new LoginFailure(MESSAGE.exchangeFailed);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw response.status >= 400 && response.status < 500 ? new TokenRejected(MESSAGE.exchangeFailed) : new LoginFailure(MESSAGE.exchangeFailed);
    }
    const type = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      await response.body?.cancel();
      throw new LoginFailure(MESSAGE.exchangeFailed);
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_TOKEN_BODY) {
      await response.body?.cancel();
      throw new LoginFailure(MESSAGE.exchangeFailed);
    }
    const text = await this.boundedText(response, MAX_TOKEN_BODY);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LoginFailure(MESSAGE.exchangeFailed);
    }
  }

  private async boundedText(response: Response, max: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          chunks.push(value);
          size += value.byteLength;
        }
        if (size > max) throw new LoginFailure(MESSAGE.exchangeFailed);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size).toString("utf8");
  }

  // Registration

  private async register(attempt: Attempt, config: ConnectionConfig, accessToken: string): Promise<string> {
    // Catalog login adds an independently identifiable account, never replaces another account.
    const command: Command = {
      type: "connection.upsert",
      // No connectionId: a second login to this service creates a second account.
      name: attempt.start.name,
      config,
      credential: accessToken,
      serviceId: attempt.service,
    };
    const access = attempt.principal.kind === "owner"
      ? new Access({ kind: "owner" })
      : new Access({ kind: "device", deviceId: attempt.principal.deviceId, name: attempt.principal.deviceName });
    const result = await execute(this.core, access, { requestId: `connection-oauth:${attempt.token}`, command }, { publicOrigin: this.config.publicOrigin, documents: null, authorize: () => { this.activeClient(attempt); } });
    const connectionId = "connectionId" in result ? result.connectionId : undefined;
    if (typeof connectionId !== "string" || connectionId.length === 0) throw new LoginFailure(MESSAGE.registerFailed);
    return connectionId;
  }

  private ghostLive(id: string): boolean {
    try {
      const ghost = this.core.ledger.ghost(id);
      return ghost.deletedAt === null && ghost.state === "active";
    } catch {
      return false;
    }
  }

  // Refresh transport

  private async refreshToken(connection: Connection, binding: RefreshBinding, client: ClientApp): Promise<void> {
    const stored = binding.refreshToken;
    if (stored === null) throw new CommandError("unavailable", MESSAGE.refreshFailed);
    const spec = providerSpec(binding.serviceId, client);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored,
      client_id: client.clientId,
      // Google: repeat the originally granted scopes; the grant must never widen them.
      ...(binding.serviceId === "google" && binding.scope !== null ? { scope: binding.scope } : {}),
    });
    const headers = new Headers({ accept: "application/json" });
    headers.set("content-type", spec.body === "form" ? "application/x-www-form-urlencoded" : "application/json");
    try {
      this.clientAuth(spec, client, headers, form);
    } catch {
      throw new CommandError("unavailable", MESSAGE.refreshFailed);
    }
    const body = spec.body === "json"
      ? JSON.stringify(client.provider ? Object.fromEntries(form) : { grant_type: "refresh_token", refresh_token: stored })
      : form.toString();
    let payload: unknown;
    if (this.closed) throw new CommandError("unavailable", MESSAGE.closed);
    this.writeJson(this.bindingFile(connection.id), { ...binding, refreshState: "pending", updatedAt: this.now() } satisfies RefreshBinding);
    try {
      payload = await this.tokenJson(spec.token, {
        method: "POST", redirect: "error", headers, body,
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(EXCHANGE_TIMEOUT)]),
      });
    } catch {
      // The persisted pending state blocks reuse of a possibly consumed rotating refresh token.
      throw new CommandError("unavailable", MESSAGE.refreshFailed);
    }
    const token = readToken(payload, this.now());
    if (this.closed) throw new CommandError("unavailable", MESSAGE.closed);
    // The binding may have died while the exchange was awaited; a stale authority never receives the result.
    const current = this.core.ledger.findConnection(connection.id);
    if (current === null || !current.hasCredential || current.credentialVersion !== binding.credentialVersion || digestOf(connectionCredentialScope(current.config)) !== binding.configDigest) {
      this.deleteBinding(connection.id);
      return;
    }
    const clientNow = this.loadClient(binding.serviceId);
    if (clientNow === null || clientNow.generation !== binding.appGeneration) {
      throw new CommandError("unavailable", MESSAGE.relink);
    }
    const sources = this.core.activitySources;
    if (!sources?.rotateCredential) throw new CommandError("unavailable", MESSAGE.refreshFailed);
    try {
      // Access rotation preserves the account's cursor/target signing key.
      await sources.rotateCredential(connection.id, token.accessToken, binding.credentialVersion);
      if (this.closed) throw new CommandError("unavailable", MESSAGE.closed);
    } catch {
      throw new CommandError("unavailable", MESSAGE.refreshFailed);
    }
    // An absent refresh_token in the response keeps the stored one; rotation only replaces it.
    this.writeJson(this.bindingFile(connection.id), {
      ...binding,
      refreshToken: token.refreshToken ?? binding.refreshToken,
      expiresAt: token.expiresAt ?? binding.expiresAt,
      refreshState: "ready",
      updatedAt: this.now(),
    } satisfies RefreshBinding);
  }

  // Local secret store

  private clientFile(service: string): string {
    return join(this.dir, `client-${service}.json`);
  }

  private bindingFile(connectionId: string): string {
    return join(this.dir, `binding-${createHash("sha256").update(connectionId).digest("hex")}.json`);
  }

  private loadClient(service: ConnectionOAuthServiceId): ClientApp | null {
    const stored = this.readJson(this.clientFile(service));
    if (stored === null) return null;
    const { clientId, clientSecret, generation, updatedAt } = stored;
    if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 256) return null;
    if (clientSecret !== null && (typeof clientSecret !== "string" || clientSecret.length === 0 || clientSecret.length > 512)) return null;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return null;
    if (stored.provider !== undefined && !validate(ConnectionOAuthMetadata, stored.provider)) return null;
    return {
      clientId,
      clientSecret: clientSecret === null ? null : clientSecret,
      generation,
      updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
      ...(stored.provider === undefined ? {} : { provider: parse(ConnectionOAuthMetadata, stored.provider) }),
    };
  }

  private loadBinding(connectionId: string): RefreshBinding | null {
    const stored = this.readJson(this.bindingFile(connectionId));
    if (stored === null) return null;
    const { serviceId, connectionId: bound, credentialVersion, configDigest, appGeneration, refreshToken, expiresAt, scope, refreshState, updatedAt } = stored;
    if (!isService(serviceId)) return null;
    if (bound !== connectionId) return null;
    if (typeof credentialVersion !== "string" || credentialVersion.length === 0 || credentialVersion.length > 128) return null;
    if (typeof configDigest !== "string" || !/^[a-f0-9]{64}$/.test(configDigest)) return null;
    if (typeof appGeneration !== "number" || !Number.isSafeInteger(appGeneration) || appGeneration < 1) return null;
    if (refreshToken !== null && (typeof refreshToken !== "string" || refreshToken.length === 0 || refreshToken.length > 8192)) return null;
    if (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) return null;
    if (scope !== null && (typeof scope !== "string" || scope.length === 0 || scope.length > 512)) return null;
    if (refreshState !== "ready" && refreshState !== "pending") return null;
    return {
      serviceId,
      connectionId: bound,
      credentialVersion,
      configDigest,
      appGeneration,
      refreshToken: refreshToken === null ? null : refreshToken,
      expiresAt: expiresAt === null ? null : expiresAt,
      scope: scope === null ? null : scope,
      refreshState,
      updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
    };
  }

  private readJson(path: string): Record<string, unknown> | null {
    try {
      const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
      return stored !== null && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** 0600 bytes written through an exclusive temp file and an atomic rename; readers never see partial JSON. */
  private writeJson(path: string, value: unknown): void {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary);
        } catch {
          // The rename already succeeded; nothing else to clean up.
        }
      }
    }
  }

  private deleteBinding(connectionId: string): void {
    try {
      unlinkSync(this.bindingFile(connectionId));
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught;
    }
  }
}
