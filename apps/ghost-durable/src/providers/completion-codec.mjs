import { randomUUID } from "node:crypto";

export function completionToSse(completion, fallbackModel) {
  if (completion === null || typeof completion !== "object" || !Array.isArray(completion.choices)) {
    throw new Error("OMP broker returned an invalid chat completion.");
  }
  const id = typeof completion.id === "string" ? completion.id : `chatcmpl-${randomUUID()}`;
  const created = Number.isSafeInteger(completion.created) ? completion.created : Math.floor(Date.now() / 1_000);
  const model = typeof completion.model === "string" ? completion.model : fallbackModel;
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: completion.choices.map((choice, index) => {
      const message = choice?.message ?? {};
      const delta = { role: "assistant" };
      if (typeof message.content === "string") delta.content = message.content;
      else if (Array.isArray(message.content)) {
        const text = message.content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("");
        if (text.length > 0) delta.content = text;
      }
      if (Array.isArray(message.tool_calls)) {
        delta.tool_calls = message.tool_calls.map((call, callIndex) => ({
          index: callIndex,
          id: call.id,
          type: "function",
          function: {
            name: call.function?.name,
            arguments: typeof call.function?.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
          },
        }));
      }
      return {
        index: Number.isSafeInteger(choice?.index) ? choice.index : index,
        delta,
        finish_reason: choice?.finish_reason ?? (delta.tool_calls ? "tool_calls" : "stop"),
      };
    }),
  };
  const frames = [`data: ${JSON.stringify(chunk)}\n\n`];
  if (completion.usage && typeof completion.usage === "object") {
    frames.push(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: completion.usage,
    })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}
export function validateLocalCompletion(completion, modelId, allowedTools) {
  const invalid = (reason) => {
    const error = new Error("Local inference response was empty, malformed, or truncated.");
    error.code = "invalid_local_completion";
    error.reason = reason;
    throw error;
  };
  if (!Array.isArray(allowedTools) || completion === null || typeof completion !== "object" || completion.model !== modelId
    || !Array.isArray(completion.choices) || completion.choices.length !== 1) {
    invalid(completion?.model !== modelId ? "model_mismatch" : "completion_shape");
  }
  const choice = completion.choices[0];
  if (choice?.message?.role !== "assistant") {
    invalid("assistant_role");
  }
  const message = choice?.message;
  const hasText = typeof message?.content === "string"
    ? message.content.trim().length > 0
    : Array.isArray(message?.content)
      && message.content.some((part) => typeof part?.text === "string" && part.text.trim().length > 0);
  const toolCalls = message?.tool_calls;
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (choice.finish_reason === "length") invalid("output_truncated");
  if (!["stop", "tool_calls"].includes(choice.finish_reason)) invalid("finish_reason");
  if (toolCalls !== undefined && !hasTools) invalid("tool_calls_shape");
  const validTools = hasTools && toolCalls.every((call) => {
    if (typeof call?.id !== "string" || call.id.length === 0 || call.type !== "function"
      || typeof call.function?.name !== "string" || call.function.name.length === 0
      || typeof call.function.arguments !== "string") invalid("tool_call_shape");
    if (!allowedTools.includes(call.function.name)) invalid("tool_not_exposed");
    let argumentsValue;
    try { argumentsValue = JSON.parse(call.function.arguments); } catch {
      invalid("tool_arguments_json");
    }
    if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
      invalid("tool_arguments_shape");
    }
    return true;
  });
  if ((!hasText && !validTools) || !["stop", "tool_calls"].includes(choice?.finish_reason)
    || (toolCalls !== undefined && !hasTools)
    || (hasTools && (!validTools || choice.finish_reason !== "tool_calls"))
    || (!hasTools && choice.finish_reason === "tool_calls")) {
    invalid(hasTools || choice.finish_reason === "tool_calls" ? "tool_finish_mismatch" : "empty_content");
  }
}
