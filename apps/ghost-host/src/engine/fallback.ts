import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Ghost, ModelRef } from "@ghost/contract";

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
  // Invalid input never improves by spending a different provider's quota.
  if (/\b400\b|invalid[_ -]?request|bad request/i.test(error)) return null;
  if (isRetryableAssistantError(message)) return error || "retryable provider error";
  return /\b(429|529|503)\b|quota|billing|budget|credit|usage.?limit|available balance|overload|provider.{0,20}unavailable|no (?:api key|credential)|missing.{0,20}(?:api key|credential)|credential.{0,20}(?:missing|not found)|ECONNRESET|ECONNREFUSED|ENETUNREACH/i.test(error)
    ? error
    : null;
}

/** The primary and duplicate entries cannot create a fallback cycle. */
export function fallbackModels(ghost: Ghost, primary: ModelRef): ModelRef[] {
  const seen = new Set([`${primary.provider}/${primary.model}`]);
  return ghost.fallbacks.filter((model) => {
    const key = `${model.provider}/${model.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
