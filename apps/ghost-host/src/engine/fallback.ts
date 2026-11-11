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
