import { CommandError, forbidden, invalid } from "../core/errors.ts";

/**
 * Toss Securities Open API, read-only (https://openapi.tossinvest.com/openapi-docs/overview.md, 2026-11-11).
 * The key it uses can also place orders; this client never sends anything but GET to the allow-listed read routes
 * below, so ordering, modifying and cancelling are not reachable from a Ghost.
 */
export const TOSS_ORIGIN = "https://openapi.tossinvest.com";

/** The owner's vault credential: `keyId` is the client_id, `secret` the client_secret. */
export interface TossCredential { itemId: string; version: number; keyId: string; secret: string }
export interface TossResponse { status: number; body: string; retryAfter: string | null }
export interface TossPort {
  get(credential: TossCredential, path: string, query: URLSearchParams, account: number | null, signal?: AbortSignal): Promise<TossResponse>;
}

/** Never `.` or `..`: those would be normalized into another route by URL parsing. */
const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}";
/** Every GET route of the spec except the WebSocket. `account` routes need the X-Tossinvest-Account header. */
const ROUTES: readonly { pattern: RegExp; account: boolean }[] = [
  ...["orderbook", "prices", "trades", "price-limits", "candles", "stocks", "stocks/all", `stocks/${SEGMENT}/(?:warnings|investor-trading|program-trades|short-selling|credit-trades|securities-lending)`,
    "exchange-rate", "market-calendar/(?:KR|US)", "rankings", "rankings/investor-trading", "market-indicators/prices", `market-indicators/${SEGMENT}/(?:candles|investor-trading)`,
    "sectors", "sectors/rankings", `sectors/${SEGMENT}`, `sectors/${SEGMENT}/(?:stocks|etfs)`, "accounts"].map((route) => ({ pattern: new RegExp(`^/api/v1/${route}$`), account: false })),
  ...["holdings", "transactions", "orders", `orders/${SEGMENT}`, "conditional-orders", `conditional-orders/${SEGMENT}`, "buying-power", "sellable-quantity", "commissions"]
    .map((route) => ({ pattern: new RegExp(`^/api/v1/${route}$`), account: true })),
];

/** The read route a path names, or a refusal. */
export function tossRoute(path: string): { account: boolean } {
  const route = typeof path === "string" ? ROUTES.find((entry) => entry.pattern.test(path)) : undefined;
  if (!route) throw invalid("toss_read path is not a read route of the Toss Securities API; see the tool description");
  return { account: route.account };
}

/** `a=1&b=x,y` → validated parameters; names are the spec's camelCase identifiers. */
export function tossQuery(raw: string | undefined): URLSearchParams {
  const query = new URLSearchParams(raw?.replace(/^\?/, "") ?? "");
  const names = [...query.keys()];
  if (names.length > 16 || new Set(names).size !== names.length || names.some((name) => !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) || [...query.values()].some((value) => value.length > 2048)) {
    throw invalid("toss_read query must be up to 16 distinct name=value pairs (lists comma-separated)");
  }
  return query;
}

const TIMEOUT_MS = 20_000;
/** `stocks/all` is the largest listing; anything beyond this is cut off rather than buffered. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Re-issue this long before the stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;
/** Toss keeps one valid token per client; these codes mean ours was replaced or ran out. */
const STALE_TOKEN_CODES: Record<string, true> = { "invalid-token": true, "expired-token": true, "token-revoked": true };

type Token = { value: string; expiresAt: number };
type TokenEntry = { version: number; token: Promise<Token> };

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw invalid("Toss response is too large; narrow the query"); }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError("unavailable", "Toss Securities API response was interrupted");
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `error.code` of Toss's error envelope, or OAuth's `error`, when it is a plain identifier. */
export function tossErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : undefined;
    const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^[a-z0-9_-]{1,64}$/i.test(code) ? code : null;
  } catch { return null; }
}

/**
 * Issues one token per credential version and reuses it across Ghosts until shortly before expiry; issuing a second
 * one would revoke the first, so concurrent calls share the pending issuance.
 */
export class TossClient implements TossPort {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    return this.fetcher(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      .catch(() => { throw new CommandError("unavailable", "Toss Securities API is unreachable"); });
  }

  /** Not bound to one caller's abort signal: concurrent calls share this issuance. */
  private async issue(credential: TossCredential): Promise<Token> {
    if (!credential.keyId) throw forbidden("The Toss Securities API key in the vault has no client ID; the owner adds it to that vault item");
    const response = await this.request(`${TOSS_ORIGIN}/oauth2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: credential.keyId, client_secret: credential.secret }).toString(),
    });
    const body = await boundedText(response);
    if (response.status === 403) throw forbidden("Toss refused this Mac's IP address; the owner registers its public IP under 토스증권 WTS › 설정 › Open API › 허용 IP 관리");
    if (response.status === 400 || response.status === 401) throw forbidden("Toss rejected the API key in the vault; the owner checks or reissues it");
    if (!response.ok) throw new CommandError("unavailable", `Toss token issuance failed (${response.status})`);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new CommandError("unavailable", "Toss token response was not JSON"); }
    const value = parsed && typeof parsed === "object" && "access_token" in parsed ? parsed.access_token : undefined;
    const seconds = parsed && typeof parsed === "object" && "expires_in" in parsed ? parsed.expires_in : undefined;
    if (typeof value !== "string" || !value || typeof seconds !== "number" || !(seconds > 0)) throw new CommandError("unavailable", "Toss token response was malformed");
    const lifetime = seconds * 1000;
    return { value, expiresAt: this.now() + Math.max(lifetime - EXPIRY_MARGIN_MS, lifetime / 2) };
  }

  private async token(credential: TossCredential): Promise<{ value: string; entry: TokenEntry }> {
    for (;;) {
      let entry = this.tokens.get(credential.itemId);
      if (!entry || entry.version !== credential.version) {
        entry = { version: credential.version, token: this.issue(credential) };
        this.tokens.set(credential.itemId, entry);
      }
      let token: Token;
      try { token = await entry.token; }
      catch (error) { this.discard(credential, entry); throw error; }
      if (token.expiresAt > this.now()) return { value: token.value, entry };
      this.discard(credential, entry);
    }
  }

  /** Forget a token only if no newer issuance replaced it meanwhile. */
  private discard(credential: TossCredential, entry: TokenEntry) {
    if (this.tokens.get(credential.itemId) === entry) this.tokens.delete(credential.itemId);
  }

  async get(credential: TossCredential, path: string, query: URLSearchParams, account: number | null, signal?: AbortSignal): Promise<TossResponse> {
    if (tossRoute(path).account !== (account !== null)) throw invalid("account must be given exactly for account routes");
    const url = `${TOSS_ORIGIN}${path}${query.size ? `?${query}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      const { value: token, entry } = await this.token(credential);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
      if (account !== null) headers["x-tossinvest-account"] = String(account);
      const response = await this.request(url, { method: "GET", headers }, signal);
      const body = await boundedText(response);
      if (response.status === 401 && attempt === 0 && STALE_TOKEN_CODES[tossErrorCode(body) ?? ""]) {
        this.discard(credential, entry);
        continue;
      }
      return { status: response.status, body, retryAfter: response.headers.get("retry-after") };
    }
  }
}

export function createToss(): TossPort { return new TossClient(); }
