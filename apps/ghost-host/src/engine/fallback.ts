import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Ghost, ModelRef, Settings } from "@ghost/contract";

/** A restart must not continue the same exhausted generation twice. */
export const FallbackDoc = defineDoc({
  kind: "ghost.fallback",
  version: 1,
  scope: "conversation",
  initial: () => ({ lastError: 0 }),
  history: "latest",
  fork: "initial",
});

/** An internal Pi input receipt follows every generation handoff without adding a transcript input. */
export const FallbackReceiptsDoc = defineDoc<{ byInput: Record<string, { errorId: number; requestId: string; provider: string }> }>({
  kind: "ghost.fallback-receipts",
  version: 1,
  scope: "conversation",
  initial: () => ({ byInput: {} }),
  history: "latest",
  fork: "initial",
});

/** A provider quota the model itself reported: a condition to wait out, not a Ghost stopping. */
export interface QuotaHit {
  /** Shortened provider message, kept for the owner's status line. */
  reason: string;
  /** When the provider said it resets; null when it did not, so the Host probes with growing gaps. */
  resumeAt: number | null;
}

/** R1: classify a generation error as a provider quota (usage limit, token plan, rate limit). */
export function quotaHit(message: AssistantMessage, now = Date.now()): QuotaHit | null {
  if (message.stopReason !== "error") return null;
  return quotaError(message.errorMessage ?? "", now);
}

/** Classify the provider's exact durable model-error settlement without searching unrelated transcript text. */
export function quotaError(error: string, now = Date.now()): QuotaHit | null {
  if (!/(?:^|[^\d])429(?:[^\d]|$)|usage[_ .-]?limit|token[_ .-]?plan|rate[_ .-]?limit/i.test(error)) return null;
  // Validation talk about budgets, tokens or quotas is a bad request, not an exhausted account.
  if (/invalid[_ -]?request|bad request|budget_tokens|max_tokens|must be|unsupported|parameter/i.test(error)) return null;
  return { reason: error.replaceAll(/\s+/g, " ").trim().slice(0, 300), resumeAt: parseResumeAt(error, now) };
}

/** When the provider's message says it resets: an ISO time (GLM names one in UTC+8), or a retry delay. */
function parseResumeAt(error: string, now: number): number | null {
  const iso = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?/.exec(error);
  if (iso) {
    const stamp = Date.parse(`${iso[1]?.replace(" ", "T")}${iso[2]?.toUpperCase() === "Z" ? "Z" : iso[2] ?? "+08:00"}`);
    if (Number.isFinite(stamp)) return bounded(stamp, now);
  }
  const retry = /(?:retry|try again)(?:\s+\w+)?\s+in\s+(\d{1,6})\s*(seconds?|sec|s|minutes?|min|m)\b/i.exec(error);
  if (retry) {
    const count = Number(retry[1]);
    const seconds = /^m/i.test(retry[2] ?? "") ? count * 60 : count;
    return bounded(now + seconds * 1000, now);
  }
  return null;
}

/** A resume time in the past is no information; one beyond a week is clipped to a week. */
function bounded(at: number, now: number): number | null {
  if (at <= now) return null;
  return Math.min(at, now + 7 * 24 * 60 * 60_000);
}

export function fallbackReason(message: AssistantMessage): string | null {
  if (message.stopReason !== "error" || isContextOverflow(message)) return null;
  const error = message.errorMessage ?? "";
  // Billing failures can use HTTP 400 / invalid_request_error despite valid input.
  if (/insufficient[_ -](?:quota|credits?|balance|funds)|credit balance|billing|exceeded (?:your )?(?:current )?quota|(?:quota|budget|credits?) (?:exceeded|exhausted|depleted)|usage[_ .-]?limit|available balance|out of (?:budget|credits?)|not enough credits?/i.test(error)) return error;
  // A token count of 400 in a rate-limit report is not an HTTP status.
  if (/^\s*(?:(?:http(?:\/\d(?:\.\d)?)?|error|status(?: code)?)\s*:?\s*)?400\b|invalid[_ -]?request|bad request/i.test(error)) return null;
  if (isRetryableAssistantError(message)) return error || "retryable provider error";
  return /\b(429|529|503)\b|overload|provider.{0,20}unavailable|no (?:api key|credential)|missing.{0,20}(?:api key|credential)|credential.{0,20}(?:missing|not found)|ECONNRESET|ECONNREFUSED|ENETUNREACH/i.test(error)
    ? error
    : null;
}

/**
 * A Ghost's own fallbacks, or the owner's default list when it has none and the owner did not turn fallback off for it.
 * 2026.11.11 : 기본 대체 모델을 더했다. Ghost 마다 같은 목록을 되풀이해 적지 않도록, 자기 목록이 비었을 때만 따른다.
 * 빈 목록이 늘 「기본을 따름」이면 한 공급자에 묶어 둔 Ghost 도 사용 한도에서 기본 대체 모델로 넘어가 대화가 다른 공급자로 간다 —
 * 그래서 「대체 모델 없음」을 noFallbackGhosts 로 따로 고른다.
 */
export function fallbackListFor(ghost: Ghost, settings: Pick<Settings, "defaultFallbacks" | "noFallbackGhosts">): ModelRef[] {
  if (ghost.fallbacks.length > 0) return ghost.fallbacks;
  return settings.noFallbackGhosts?.includes(ghost.id) ? [] : (settings.defaultFallbacks ?? []);
}

/** The primary and duplicate entries cannot create a fallback cycle. */
export function fallbackModels(ghost: Ghost, primary: ModelRef, settings: Pick<Settings, "defaultFallbacks" | "noFallbackGhosts"> = {}): ModelRef[] {
  const seen = new Set([`${primary.provider}/${primary.model}`]);
  return fallbackListFor(ghost, settings).filter((model) => {
    const key = `${model.provider}/${model.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
