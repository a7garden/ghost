import type { Message, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";

const RETRY_WINDOW = 8;

function repeatedWithoutProgress(messages: readonly Message[]): boolean {
  // Tool results are ordered after the assistant's calls. A fresh input, real
  // observation or different error gives the model a new opportunity to proceed.
  const recent = messages.slice(-RETRY_WINDOW * 3);
  const attempts = new Map<string, number>();
  let count = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    const result = recent[index]!;
    if (result.role === "user") return false;
    if (result.role !== "toolResult") continue;
    const timedWait = result.toolName === "browser_wait" && recent.slice(0, index).some((message) =>
      message.role === "assistant" && message.content.some((call) =>
        call.type === "toolCall" && call.id === result.toolCallId && typeof call.arguments.ms === "number",
      ),
    );
    if (!result.isError && !timedWait) return false;
    const key = JSON.stringify([result.toolName, result.content]);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (++count === RETRY_WINDOW) return attempts.size <= 2 && [...attempts.values()].every((n) => n >= 3);
  }
  return false;
}

/** Finish through Pi's normal idle boundary without contacting a provider. */
export function workGuard(core: Core, models: Models) {
  // The request hook cannot finish a turn itself. Pi shallow-copies the request
  // messages into streamSimple. Mark only that request, never the transcript.
  const stops = new WeakMap<Message, string>();
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const last = context.messages.at(-1);
    const reason = last && stops.get(last);
    if (!reason) return models.streamSimple(model, context, options);
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: reason }],
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    return stream;
  };
  const guarded = new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return streamSimple;
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const extension = defineExtension({
    name: "ghost.work-guard",
    hooks: [hook(GenerationTask, {
      beforeRequest({ messages }, api) {
        const conversation = core.ledger.conversationByPiId(String(api.conversationId));
        if (conversation?.kind !== "work" || !conversation.workId) return;
        const pending = core.ledger.pendingDecisions({ conversationId: conversation.id })
          .some((decision) => decision.kind === "approve_effect");
        const reason = pending ? "승인 또는 거절을 기다리고 있습니다."
          : repeatedWithoutProgress(messages) ? "같은 오류 또는 대기가 반복돼 이번 실행을 멈췄습니다."
          : null;
        if (!reason) return;
        const marker: Message = { role: "user", content: "", timestamp: Date.now() };
        stops.set(marker, reason);
        return { messages: [...messages, marker] };
      },
    })],
  });
  return { models: guarded, extension };
}
