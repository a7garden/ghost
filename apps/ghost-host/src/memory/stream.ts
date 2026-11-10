import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export const MEMORY_OUTPUT_BYTES = 48 * 1024;

/** Memory-only provider adapter; cancellation remains an explicit aborted response, never a fallback. */
export function memoryModels(models: Models, deadline: number): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const controller = new AbortController();
    let partial: AssistantMessage | undefined;
    let ended = false;
    let bytes = 0;
    const cancelled = () => {
      if (ended) return;
      ended = true;
      const reason = controller.signal.reason;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "aborted", timestamp: partial?.timestamp ?? Date.now(),
        usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        errorMessage: reason instanceof Error ? reason.message : String(reason ?? "memory generation cancelled"),
      };
      output.push({ type: "error", reason: "aborted", error: message });
    };
    controller.signal.addEventListener("abort", cancelled, { once: true });
    const parentAbort = () => controller.abort(options?.signal?.reason ?? new Error("memory generation cancelled"));
    options?.signal?.addEventListener("abort", parentAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("memory generation deadline exceeded")), Math.max(0, deadline - Date.now()));
    if (options?.signal?.aborted) parentAbort();
    if (deadline <= Date.now()) controller.abort(new Error("memory generation deadline exceeded"));
    void (async () => {
      try {
        if (controller.signal.aborted) return;
        const source = models.streamSimple(model, context, { ...options, signal: controller.signal, maxTokens: 4096, maxRetries: 0, deferred: false, timeoutMs: Math.max(1, deadline - Date.now()) });
        for await (const event of source) {
          if (controller.signal.aborted) break;
          if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") bytes += Buffer.byteLength(event.delta);
          const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
          // Providers can emit complete content without deltas. Inspect boundaries, never rescan on every token.
          const boundaryBytes = event.type.endsWith("_delta") ? 0 : Buffer.byteLength(JSON.stringify(message.content));
          if (bytes > MEMORY_OUTPUT_BYTES || boundaryBytes > MEMORY_OUTPUT_BYTES) {
            controller.abort(new Error(`memory output exceeded ${MEMORY_OUTPUT_BYTES} bytes`));
            break;
          }
          if (event.type.startsWith("toolcall_") || (event.type === "done" && (event.message.stopReason === "deferred" || message.content.some((part) => part.type === "toolCall")))) {
            controller.abort(new Error("memory generation requested an unsupported deferred response or tool capability"));
            break;
          }
          partial = message;
          // Internal jobs need no live preview. Never leak the SDK's mutable growing partials into Pi.
          if (event.type === "done" || event.type === "error") { ended = true; output.push(event); }
        }
        if (!ended) {
          const result = await source.result();
          if (!controller.signal.aborted) {
            if (Buffer.byteLength(JSON.stringify(result.content)) > MEMORY_OUTPUT_BYTES) controller.abort(new Error(`memory output exceeded ${MEMORY_OUTPUT_BYTES} bytes`));
            else { ended = true; output.end(result); }
          }
        }
      } catch (error) {
        if (!ended) {
          ended = true;
          output.push({ type: "error", reason: "error", error: { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, errorMessage: error instanceof Error ? error.message : String(error) } });
        }
      } finally {
        clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", parentAbort);
        controller.signal.removeEventListener("abort", cancelled);
      }
    })();
    return output;
  };
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return streamSimple;
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
