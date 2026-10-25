// Capture only a configured model confirmed by the runtime's existing route
// selection. Disclosure scope is deliberately absent from this policy API.
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";

const LOCAL_PROVIDER = 'ghost-local';
const LOCAL_CONTEXT_WINDOW = 16_384;
const TUNED = Object.freeze({ enabled: true, reserveTokens: 6_144, keepRecentTokens: 2_048, backgroundTokens: 0 });
const DISABLED = Object.freeze({ enabled: false });

// Threshold compaction runs only when a generation prepares. A generation's
// tool loop rechecks nothing, so one long Work round can still overflow the
// local window and die as a one-token remainder. When the projected request
// would leave less than the captured output budget, drop the oldest whole
// rounds from the wire request: never the leading system header, never a
// suffix that starts with an orphaned tool result, never the exact current
// final input. The durable SDK ledger keeps every entry — this bounds only
// what is sent, like compaction itself. Guarded scopes and unconfirmed routes
// are returned unchanged.
// The SDK's own estimate; assistant entries without a usage record (unit
// fixtures only — real entries always carry one) cannot anchor and fall
// through to the per-message estimate, keeping the bound aligned with the
// clamp that would otherwise floor max_tokens at one token.
function estimateWireTokens(messages) {
  return estimateContextTokens(messages.map(message => message.usage ? message
    : { ...message, usage: { totalTokens: 0 } })).tokens;
}

function boundMessages(messages, contextWindow, maxOutputTokens) {
  // pi-ai clamps max_tokens to window − estimate − 4096 safety tokens and
  // floors it at one token; staying under that margin keeps the full captured
  // output budget instead of a one-token remainder.
  const ceiling = contextWindow - maxOutputTokens - 4_096;
  if (!Array.isArray(messages) || estimateWireTokens(messages) <= ceiling) return messages;
  let keep = 0;
  while (keep < messages.length && messages[keep].role === 'system') keep++;
  // The first user round is the assignment's exact task input; it defines the
  // Work for the whole generation and is never dropped, like the system header.
  if (keep < messages.length && messages[keep].role === 'user') keep++;
  const head = messages.slice(0, keep);
  const tail = messages.slice(keep);
  for (let start = 0; start < tail.length; start++) {
    if (tail[start].role === 'toolResult') continue;
    const candidate = start === 0 ? messages : [...head, ...tail.slice(start)];
    if (estimateWireTokens(candidate) <= ceiling) return candidate;
  }
  return messages;
}

export function createControllerCompactionPolicy() {
  let captured = null;
  return {
    clear() { captured = null; },
    capture(metadata = {}) {
      captured = null;
      const { configuredModel, models, localRouteConfig } = metadata ?? {};
      if (configuredModel?.provider !== LOCAL_PROVIDER || typeof configuredModel.modelId !== 'string'
        || configuredModel.modelId.length === 0 || typeof models?.getModel !== 'function'
        || typeof localRouteConfig?.identity !== 'string' || !/^[a-f0-9]{64}$/u.test(localRouteConfig.identity)
        || !Number.isSafeInteger(localRouteConfig.maxOutputTokens) || localRouteConfig.maxOutputTokens < 1
        || localRouteConfig.maxOutputTokens > LOCAL_CONTEXT_WINDOW / 4) return false;
      let model;
      try { model = models.getModel(configuredModel.provider, configuredModel.modelId); }
      catch { return false; }
      if (model?.provider !== LOCAL_PROVIDER || model.id !== configuredModel.modelId
        || model.contextWindow !== LOCAL_CONTEXT_WINDOW || model.maxTokens !== localRouteConfig.maxOutputTokens) return false;
      captured = Object.freeze({ provider: model.provider, modelId: model.id, contextWindow: model.contextWindow,
        routeIdentity: localRouteConfig.identity, maxOutputTokens: model.maxTokens });
      return true;
    },
    policy({ contaminated, requiresWorkGate } = {}) {
      // Work assignments compact like the controller once the local route is
      // confirmed: an overflowing assignment that cannot summarize dies with a
      // one-token remainder. Work-context stores are seal-identified, so the
      // unknown-history floor routes those conversations to canonical sessions
      // before this policy ever runs. Memory-derived and work-gated histories
      // still never compact.
      if (contaminated || requiresWorkGate) return DISABLED;
      return captured === null ? undefined : TUNED;
    },
    bound(guard, result) {
      if (!result || !Array.isArray(result.messages) || this.policy(guard) !== TUNED) return result;
      return { ...result, messages: boundMessages(result.messages, captured.contextWindow, captured.maxOutputTokens) };
    },
  };
}
