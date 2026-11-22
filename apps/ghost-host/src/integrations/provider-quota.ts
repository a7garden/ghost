import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderQuota, ProviderQuotaWindow } from "@ghost/contract";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Secrets } from "../core/ports.ts";

/** What one provider reported: a plan label and its usage windows. */
export interface QuotaReading { plan: string | null; windows: ProviderQuotaWindow[] }

/** The Claude Code login on this Mac. Read-only: the token is never refreshed or stored by Ghost. */
export interface ClaudeLogin { accessToken: string; expiresAt: number; subscriptionType: string | null; rateLimitTier: string | null }

export type QuotaFetch = (input: string, init: RequestInit) => Promise<Response>;

interface Options {
  providers: () => Provider[];
  secrets: Secrets;
  fetch?: QuotaFetch;
  now?: () => number;
  /** Null when Claude Code is not signed in on this Mac; throws when the login cannot be read. */
  claudeLogin?: () => Promise<ClaudeLogin | null>;
  codexAuth?: OAuthAuth;
}

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 256 * 1024;
/** Usage endpoints are unofficial and rate limit; a forced refresh still waits this long between attempts. */
const MIN_RETRY_MS = 15_000;
const TTL_MS = 60_000;
/** Anthropic's usage endpoint answers 429 to frequent callers. */
const CLAUDE_TTL_MS = 180_000;
const CLAUDE_ID = "claude-code";
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** A failure whose message is safe to show the owner; response bodies and tokens never reach it. */
class QuotaError extends Error {}
const rejected = (name: string) => new QuotaError(`${name} 인증이 거부되었거나 만료되었습니다.`);
const unavailable = () => new QuotaError("사용량을 불러오지 못했습니다.");

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percent = (value: number) => Math.min(100, Math.max(0, Math.round(value * 10) / 10));

/** "5시간", "주간", "월간", "3일" for a window length. */
function span(seconds: number): string {
  const day = 86_400;
  if (seconds >= 28 * day && seconds <= 31 * day) return "월간";
  if (seconds % (7 * day) === 0) return seconds === 7 * day ? "주간" : `${seconds / (7 * day)}주`;
  if (seconds === day) return "일간";
  if (seconds % day === 0) return `${seconds / day}일`;
  if (seconds % 3600 === 0) return `${seconds / 3600}시간`;
  return `${Math.max(1, Math.round(seconds / 60))}분`;
}

const capitalized = (value: string) => value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

function codexWindow(prefix: string, value: unknown, now: number): ProviderQuotaWindow | null {
  if (!record(value) || !finite(value.used_percent)) return null;
  const length = finite(value.limit_window_seconds) && value.limit_window_seconds > 0 ? span(value.limit_window_seconds) : "사용량";
  const resetsAt = finite(value.reset_at) ? value.reset_at * 1000 : finite(value.reset_after_seconds) ? now + value.reset_after_seconds * 1000 : null;
  return { label: `${prefix}${length}`, usedPercent: percent(value.used_percent), resetsAt };
}

const CODEX_PLANS: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

export function parseCodex(body: unknown, now: number): QuotaReading {
  if (!record(body)) throw unavailable();
  const windows: ProviderQuotaWindow[] = [];
  for (const [prefix, limit] of [["", body.rate_limit], ["코드 리뷰 ", body.code_review_rate_limit]] as const) {
    if (!record(limit)) continue;
    for (const key of ["primary_window", "secondary_window"]) {
      const window = codexWindow(prefix, limit[key], now);
      if (window) windows.push(window);
    }
  }
  if (windows.length === 0) throw unavailable();
  const plan = typeof body.plan_type === "string" && body.plan_type !== "" ? (CODEX_PLANS[body.plan_type] ?? capitalized(body.plan_type)).slice(0, 64) : null;
  return { plan, windows };
}

const CLAUDE_WINDOWS = [["five_hour", "5시간"], ["seven_day", "주간"], ["seven_day_opus", "Opus 주간"], ["seven_day_sonnet", "Sonnet 주간"]] as const;

export function parseClaude(body: unknown, login: ClaudeLogin): QuotaReading {
  if (!record(body)) throw unavailable();
  const windows: ProviderQuotaWindow[] = [];
  for (const [key, label] of CLAUDE_WINDOWS) {
    const value = body[key];
    if (!record(value) || !finite(value.utilization)) continue;
    const resets = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : Number.NaN;
    windows.push({ label, usedPercent: percent(value.utilization), resetsAt: Number.isFinite(resets) ? resets : null });
  }
  if (windows.length === 0) throw unavailable();
  const tier = /(\d+x)$/.exec(login.rateLimitTier ?? "")?.[1];
  const plan = login.subscriptionType ? `${capitalized(login.subscriptionType)}${tier ? ` ${tier}` : ""}`.slice(0, 64) : null;
  return { plan, windows };
}

/** Z.AI Coding Plan: `unit` 3 = hours, 5 = months, 6 = weeks; `percentage` is already used/limit. */
const ZAI_UNITS: Record<number, number> = { 1: 86_400, 3: 3600, 6: 7 * 86_400 };

export function parseZai(body: unknown): QuotaReading {
  if (!record(body)) throw unavailable();
  if (body.success === false) throw body.code === 401 ? rejected("Z.AI") : unavailable();
  const data = body.data;
  if (!record(data) || !Array.isArray(data.limits)) throw unavailable();
  const windows: ProviderQuotaWindow[] = [];
  for (const limit of data.limits) {
    if (!record(limit) || !finite(limit.percentage) || (limit.type !== "TOKENS_LIMIT" && limit.type !== "TIME_LIMIT")) continue;
    const unit = finite(limit.unit) ? limit.unit : 0;
    const number = finite(limit.number) && limit.number > 0 ? limit.number : 1;
    const length = unit === 5 ? "월간" : ZAI_UNITS[unit] ? span(ZAI_UNITS[unit]! * number) : "사용량";
    windows.push({
      label: limit.type === "TIME_LIMIT" ? `도구 ${length}` : length,
      usedPercent: percent(limit.percentage),
      resetsAt: finite(limit.nextResetTime) ? limit.nextResetTime : null,
    });
  }
  if (windows.length === 0) throw unavailable();
  // Rolling token windows first, the monthly tool allowance last.
  windows.sort((a, b) => Number(a.label.startsWith("도구")) - Number(b.label.startsWith("도구")));
  return { plan: typeof data.level === "string" && data.level !== "" && data.level !== "unknown" ? capitalized(data.level).slice(0, 64) : null, windows };
}

/** MiniMax Coding Plan. Status 3 at 100% remaining is an allowance that has not started; only `general` is always shown. */
export function parseMinimax(body: unknown): QuotaReading {
  if (!record(body) || !Array.isArray(body.model_remains)) throw unavailable();
  if (record(body.base_resp) && finite(body.base_resp.status_code) && body.base_resp.status_code !== 0) throw unavailable();
  const windows: ProviderQuotaWindow[] = [];
  for (const item of body.model_remains) {
    if (!record(item) || typeof item.model_name !== "string") continue;
    const prefix = item.model_name === "general" ? "" : `${item.model_name.slice(0, 32)} `;
    for (const [remaining, status, start, end] of [
      [item.current_interval_remaining_percent, item.current_interval_status, item.start_time, item.end_time],
      [item.current_weekly_remaining_percent, item.current_weekly_status, item.weekly_start_time, item.weekly_end_time],
    ] as const) {
      if (!finite(remaining)) continue;
      if (item.model_name !== "general" && status === 3 && remaining >= 100) continue;
      const length = finite(start) && finite(end) && end > start ? span(Math.round((end - start) / 1000)) : "사용량";
      windows.push({ label: `${prefix}${length}`, usedPercent: percent(100 - remaining), resetsAt: finite(end) ? end : null });
    }
  }
  if (windows.length === 0) throw unavailable();
  return { plan: null, windows };
}

/** Claude Code stores its login in the macOS Keychain, or in `.credentials.json` elsewhere. */
export async function readClaudeLogin(): Promise<ClaudeLogin | null> {
  let raw: string | null = null;
  if (process.platform === "darwin") {
    const child = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    // A Keychain prompt nobody answers must not hang the request.
    const timer = setTimeout(() => child.kill(), KEYCHAIN_TIMEOUT_MS);
    try {
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code === 0) raw = text;
      else if (code !== 44) throw new QuotaError("Claude Code 로그인 정보를 읽지 못했습니다.");
    } finally { clearTimeout(timer); }
  }
  if (raw === null) {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    try { raw = await readFile(join(dir, ".credentials.json"), "utf8"); } catch { return null; }
  }
  let oauth: unknown;
  try { oauth = (JSON.parse(raw) as { claudeAiOauth?: unknown }).claudeAiOauth; } catch { throw new QuotaError("Claude Code 로그인 정보를 읽지 못했습니다."); }
  if (!record(oauth) || typeof oauth.accessToken !== "string" || oauth.accessToken === "" || !finite(oauth.expiresAt)) return null;
  return {
    accessToken: oauth.accessToken, expiresAt: oauth.expiresAt,
    subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    rateLimitTier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : null,
  };
}

interface Source {
  id: string;
  name: string;
  ttl: number;
  /** Changes when the account behind the source changes, so a new login never shows the old reading. */
  identity: string;
  /** Null when the source does not apply on this machine. */
  read(): Promise<QuotaReading | null>;
}

interface Entry {
  identity: string;
  attemptedAt: number;
  fetchedAt: number | null;
  reading: QuotaReading | null;
  absent: boolean;
  error: string | null;
  pending: Promise<void> | null;
}

const host = (baseUrl: string | null) => { try { return baseUrl ? new URL(baseUrl).hostname : null; } catch { return null; } };

/** Reads subscription usage from each provider's account, cached so the endpoints are not hammered. */
export class ProviderQuotas {
  private readonly entries = new Map<string, Entry>();
  private readonly fetchImpl: QuotaFetch;
  private readonly now: () => number;
  private readonly claudeLogin: () => Promise<ClaudeLogin | null>;
  private codexAuth: OAuthAuth | undefined;

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.claudeLogin = options.claudeLogin ?? readClaudeLogin;
    this.codexAuth = options.codexAuth;
  }

  /** Claude first, then the configured providers in settings order. `refresh` skips the cache but not the retry floor. */
  async read(refresh = false): Promise<ProviderQuota[]> {
    const sources = this.sources();
    const live = new Set(sources.map(source => source.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    const results = await Promise.all(sources.map(async (source): Promise<ProviderQuota | null> => {
      const entry = await this.settle(source, refresh);
      if (entry.absent) return null;
      return { id: source.id, name: source.name, plan: entry.reading?.plan ?? null, windows: entry.reading?.windows ?? [], error: entry.error, fetchedAt: entry.fetchedAt };
    }));
    return results.filter((item): item is ProviderQuota => item !== null);
  }

  private async settle(source: Source, refresh: boolean): Promise<Entry> {
    let entry = this.entries.get(source.id);
    if (entry && entry.identity !== source.identity && !entry.pending) entry = undefined;
    if (!entry) {
      entry = { identity: source.identity, attemptedAt: 0, fetchedAt: null, reading: null, absent: false, error: null, pending: null };
      this.entries.set(source.id, entry);
    }
    const age = this.now() - entry.attemptedAt;
    if (!entry.pending && age >= (refresh ? MIN_RETRY_MS : source.ttl)) {
      const target = entry;
      target.attemptedAt = this.now();
      target.pending = source.read().then(reading => {
        target.absent = reading === null;
        target.reading = reading ?? target.reading;
        target.fetchedAt = reading ? this.now() : target.fetchedAt;
        target.error = null;
      }, (caught: unknown) => {
        target.absent = false;
        target.error = caught instanceof QuotaError ? caught.message : unavailable().message;
      }).finally(() => { target.pending = null; });
    }
    await entry.pending;
    return entry;
  }

  private sources(): Source[] {
    const sources: Source[] = [{ id: CLAUDE_ID, name: "Claude", ttl: CLAUDE_TTL_MS, identity: CLAUDE_ID, read: () => this.claude() }];
    for (const provider of this.options.providers()) {
      const credential = this.options.secrets.credential(provider.id);
      if (!credential) continue;
      const identity = createHash("sha256").update(JSON.stringify(credential.type === "api_key" ? credential.key : [credential.refresh, credential.accountId])).digest("hex");
      const base = { id: provider.id, name: provider.name, ttl: TTL_MS, identity };
      if (provider.kind === "openai" && provider.baseUrl === null && credential.type === "oauth") sources.push({ ...base, read: () => this.codex(provider) });
      else if (credential.type === "api_key" && credential.key) {
        const key = credential.key;
        if (provider.kind === "zai") sources.push({ ...base, read: () => this.zai(provider, key) });
        else if (provider.kind === "minimax") sources.push({ ...base, read: () => this.minimax(provider, key) });
      }
    }
    return sources;
  }

  private async get(url: string, headers: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers: { Accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch { throw unavailable(); }
    const text = response.ok ? await response.text().catch(() => "") : (await response.body?.cancel(), "");
    if (response.status === 401 || response.status === 403) throw new QuotaError("authentication rejected");
    if (!response.ok || text.length > MAX_BYTES) throw response.status === 429 ? new QuotaError("요청이 많아 잠시 뒤 다시 시도합니다.") : unavailable();
    try { return JSON.parse(text); } catch { throw unavailable(); }
  }

  /** A 401/403 from the provider becomes a named, owner-readable rejection. */
  private async authorized(name: string, url: string, headers: Record<string, string>): Promise<unknown> {
    try { return await this.get(url, headers); }
    catch (caught) { throw caught instanceof QuotaError && caught.message === "authentication rejected" ? rejected(name) : caught; }
  }

  private async codex(provider: Provider): Promise<QuotaReading> {
    const auth = (this.codexAuth ??= openaiCodexProvider().auth.oauth!);
    const credential = await this.options.secrets.modify(provider.id, async current => {
      if (current?.type !== "oauth" || current.expires > this.now() + 60_000) return current;
      return auth.refresh(current, AbortSignal.timeout(TIMEOUT_MS));
    }).catch(() => { throw rejected(provider.name); });
    if (credential?.type !== "oauth") throw rejected(provider.name);
    const body = await this.authorized(provider.name, "https://chatgpt.com/backend-api/wham/usage", {
      Authorization: `Bearer ${credential.access}`, ...(typeof credential.accountId === "string" ? { "ChatGPT-Account-Id": credential.accountId } : {}),
    });
    return parseCodex(body, this.now());
  }

  private async claude(): Promise<QuotaReading | null> {
    const login = await this.claudeLogin();
    if (!login) return null;
    if (login.expiresAt <= this.now()) throw new QuotaError("Claude Code 로그인이 만료되었습니다. Claude Code를 한 번 실행해 주세요.");
    const body = await this.authorized("Claude", "https://api.anthropic.com/api/oauth/usage", {
      Authorization: `Bearer ${login.accessToken}`, "anthropic-beta": "oauth-2025-04-20",
    });
    return parseClaude(body, login);
  }

  private async zai(provider: Provider, key: string): Promise<QuotaReading> {
    const origin = host(provider.baseUrl) === "open.bigmodel.cn" ? "https://open.bigmodel.cn" : "https://api.z.ai";
    return parseZai(await this.authorized(provider.name, `${origin}/api/monitor/usage/quota/limit`, { Authorization: `Bearer ${key}` }));
  }

  private async minimax(provider: Provider, key: string): Promise<QuotaReading> {
    const origin = host(provider.baseUrl) === "api.minimaxi.com" ? "https://api.minimaxi.com" : "https://api.minimax.io";
    return parseMinimax(await this.authorized(provider.name, `${origin}/v1/api/openplatform/coding_plan/remains`, { Authorization: `Bearer ${key}` }));
  }
}
