import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderQuotas as ProviderQuotasView, parse, type Provider } from "@ghost/contract";
import { ProviderQuotas, type ClaudeLogin, type QuotaFetch } from "../src/integrations/provider-quota.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

const provider = (id: string, kind: Provider["kind"], baseUrl: string | null = null): Provider => ({ id, kind, name: id, baseUrl, models: [], hasCredential: true });
const NOW = Date.UTC(2026, 10, 22, 0, 0, 0);

const codexBody = { plan_type: "prolite", rate_limit: { allowed: true, primary_window: { used_percent: 27, limit_window_seconds: 604800, reset_after_seconds: 510208, reset_at: 1795843805 }, secondary_window: null }, code_review_rate_limit: null };
const claudeBody = { five_hour: { utilization: 22.0, resets_at: "2026-11-22T10:30:00.320536+00:00" }, seven_day: { utilization: 53.0, resets_at: "2026-11-25T19:00:00+00:00" }, seven_day_opus: null, seven_day_sonnet: null, tangelo: null };
const zaiBody = { code: 200, success: true, data: { level: "pro", limits: [
  { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 0, remaining: 1000, percentage: 0, nextResetTime: 1795358473999 },
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1795350724105 },
] } };
const minimaxBody = { base_resp: { status_code: 0, status_msg: "success" }, model_remains: [
  { model_name: "general", start_time: 1795323600000, end_time: 1795341600000, current_interval_status: 1, current_interval_remaining_percent: 93, weekly_start_time: 1794787200000, weekly_end_time: 1795392000000, current_weekly_status: 3, current_weekly_remaining_percent: 100 },
  { model_name: "video", start_time: 1795305600000, end_time: 1795392000000, current_interval_status: 3, current_interval_remaining_percent: 100, weekly_start_time: 1794787200000, weekly_end_time: 1795392000000, current_weekly_status: 3, current_weekly_remaining_percent: 100 },
] };

async function fixture(options: { claude?: ClaudeLogin | null; respond?: (url: string, headers: Headers) => Response } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ghost-quota-"));
  const secrets = new FileSecrets(root);
  await secrets.modify("codex", async () => ({ type: "oauth", access: "codex-access", refresh: "codex-refresh", expires: NOW + 86_400_000, accountId: "acct-1" }));
  secrets.put("zai-coding", "zai-key");
  secrets.put("minimax", "minimax-key");
  secrets.put("plain-openai", "sk-plain");
  secrets.put("anthropic", "sk-ant");
  const providers = [provider("codex", "openai"), provider("zai-coding", "zai"), provider("minimax", "minimax"), provider("plain-openai", "openai"), provider("anthropic", "anthropic")];
  const calls: { url: string; headers: Headers }[] = [];
  let now = NOW;
  const respond = options.respond ?? ((url) => Response.json(
    url.includes("wham") ? codexBody : url.includes("anthropic") ? claudeBody : url.includes("z.ai") ? zaiBody : minimaxBody));
  const fetch: QuotaFetch = async (url, init) => { const headers = new Headers(init.headers); calls.push({ url, headers }); return respond(url, headers); };
  const quotas = new ProviderQuotas({
    providers: () => providers, secrets, fetch, now: () => now,
    claudeLogin: async () => options.claude === undefined ? { accessToken: "claude-token", expiresAt: NOW + 3_600_000, subscriptionType: "max", rateLimitTier: "default_claude_max_5x" } : options.claude,
  });
  return { quotas, calls, secrets, advance: (ms: number) => { now += ms; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("each provider's account usage is read with its own credential; providers without a usage API are absent", async () => {
  const f = await fixture();
  try {
    const result = await f.quotas.read();
    expect(parse(ProviderQuotasView, result)).toEqual(result);
    expect(result.map((item) => item.id)).toEqual(["claude-code", "codex", "zai-coding", "minimax"]);
    expect(result[0]).toMatchObject({ name: "Claude", plan: "Max 5x", error: null, windows: [
      { label: "5시간", usedPercent: 22, resetsAt: Date.parse("2026-11-22T10:30:00.320536+00:00") },
      { label: "주간", usedPercent: 53 },
    ] });
    expect(result[1]).toMatchObject({ plan: "Pro Lite", windows: [{ label: "주간", usedPercent: 27, resetsAt: 1795843805000 }] });
    // Rolling token window before the monthly tool allowance, whatever the provider's order.
    expect(result[2]).toMatchObject({ plan: "Pro", windows: [{ label: "5시간", usedPercent: 1, resetsAt: 1795350724105 }, { label: "도구 월간", usedPercent: 0 }] });
    // `general` keeps both windows; the unstarted `video` allowance is dropped.
    expect(result[3]!.windows).toEqual([{ label: "5시간", usedPercent: 7, resetsAt: 1795341600000 }, { label: "주간", usedPercent: 0, resetsAt: 1795392000000 }]);
    const byUrl = (part: string) => f.calls.find((call) => call.url.includes(part))!;
    expect(byUrl("wham").headers.get("authorization")).toBe("Bearer codex-access");
    expect(byUrl("wham").headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(byUrl("api.anthropic.com").headers.get("authorization")).toBe("Bearer claude-token");
    expect(byUrl("api.anthropic.com").headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(byUrl("api.z.ai").headers.get("authorization")).toBe("Bearer zai-key");
    expect(byUrl("api.minimax.io").headers.get("authorization")).toBe("Bearer minimax-key");
    expect(f.calls).toHaveLength(4);
  } finally { f.cleanup(); }
});

test("readings are cached; a forced refresh still waits out the retry floor", async () => {
  const f = await fixture();
  try {
    await f.quotas.read();
    await f.quotas.read();
    expect(f.calls).toHaveLength(4);
    f.advance(5_000);
    await f.quotas.read(true);
    expect(f.calls).toHaveLength(4);
    f.advance(15_000);
    await f.quotas.read(true);
    expect(f.calls).toHaveLength(8);
    f.advance(61_000);
    await f.quotas.read();
    // Claude's endpoint rate limits, so it keeps its longer cache.
    expect(f.calls.filter((call) => call.url.includes("anthropic"))).toHaveLength(2);
    expect(f.calls).toHaveLength(11);
  } finally { f.cleanup(); }
});

test("a failed read keeps the last good windows, names the rejection and never carries the response body or token", async () => {
  let reject = false;
  const f = await fixture({ respond: (url) => reject && url.includes("z.ai") ? new Response("secret-body zai-key", { status: 401 }) : Response.json(url.includes("z.ai") ? zaiBody : minimaxBody) });
  try {
    await f.quotas.read();
    reject = true;
    f.advance(61_000);
    const zai = (await f.quotas.read()).find((item) => item.id === "zai-coding")!;
    expect(zai.error).toBe("zai-coding 인증이 거부되었거나 만료되었습니다.");
    expect(zai.windows).toHaveLength(2);
    expect(zai.fetchedAt).toBe(NOW);
    expect(JSON.stringify(zai)).not.toContain("secret-body");
  } finally { f.cleanup(); }
});

test("Claude is absent without a Claude Code login and reports an expired one without calling Anthropic", async () => {
  const none = await fixture({ claude: null });
  try {
    expect((await none.quotas.read()).map((item) => item.id)).toEqual(["codex", "zai-coding", "minimax"]);
  } finally { none.cleanup(); }
  const expired = await fixture({ claude: { accessToken: "old", expiresAt: NOW - 1, subscriptionType: "pro", rateLimitTier: null } });
  try {
    const claude = (await expired.quotas.read())[0]!;
    expect(claude).toMatchObject({ id: "claude-code", windows: [], fetchedAt: null, error: "Claude Code 로그인이 만료되었습니다. Claude Code를 한 번 실행해 주세요." });
    expect(expired.calls.some((call) => call.url.includes("anthropic"))).toBe(false);
  } finally { expired.cleanup(); }
});

test("a replaced credential is read again at once instead of showing the previous account's reading", async () => {
  const f = await fixture();
  try {
    await f.quotas.read();
    f.secrets.put("minimax", "other-account-key");
    f.advance(1_000);
    await f.quotas.read();
    const minimax = f.calls.filter((call) => call.url.includes("minimax"));
    expect(minimax.map((call) => call.headers.get("authorization"))).toEqual(["Bearer minimax-key", "Bearer other-account-key"]);
  } finally { f.cleanup(); }
});
