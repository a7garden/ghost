import { createHash } from "node:crypto";

import {
  openGuestBrokerFileClient,
  type GuestBrokerFileClient,
  type SubscriptionGuestConfig,
} from "./guest-broker-client.ts";
import type { WorkerToolName } from "./native-tool-policy.ts";

const CUSTOM_PROVIDER = "ghost-subscription-native";
const CUSTOM_API = "ghost-guest-subscription-native";
const SOURCE_ID = "ghost-c2d-subscription-native";
const FAKE_BASE_URL = "http://guest-subscription-broker.invalid";
const NATIVE_STREAM_URL = `${FAKE_BASE_URL}/v1/pi/stream`;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_REQUEST_FILE_BYTES = 2 * MAX_PAYLOAD_BYTES + 65_536;
const MAX_MESSAGE_BYTES = 4_194_304;
const MAX_RESPONSE_FILE_BYTES = 2 * MAX_MESSAGE_BYTES + 65_536;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

interface GuestModelRegistry {
  find(provider: string, modelId: string): unknown;
  registerProvider(provider: string, config: Record<string, unknown>, sourceId: string): void;
  unregisterProvider?(provider: string): void;
}

interface NativeEventStream {
  push(event: Record<string, unknown>): void;
  fail(error: unknown): void;
  end(): void;
  result(): Promise<unknown>;
}

interface PiNativeRuntime {
  streamPiNative: unknown;
  toolWireSchema: unknown;
  createAssistantMessageEventStream: unknown;
  NO_AUTH_SENTINEL: unknown;
}

interface ModelResponse {
  version: 1;
  kind: "model_response";
  request_id: string;
  execution_id: string;
  authority_epoch: number;
  payload_sha256: string;
  status: "completed" | "rejected" | "effect_unknown";
  message_json: string | null;
  message_sha256: string | null;
  reason_code: string | null;
}

export async function registerSubscriptionGuestModel(options: {
  config: SubscriptionGuestConfig;
  modelRegistry: GuestModelRegistry;
  piNative: PiNativeRuntime;
}): Promise<{ model: unknown; close: () => Promise<void> }> {
  const { config, modelRegistry, piNative } = options;
  if (typeof piNative.streamPiNative !== "function"
    || typeof piNative.createAssistantMessageEventStream !== "function"
    || typeof piNative.toolWireSchema !== "function"
    || typeof piNative.NO_AUTH_SENTINEL !== "string"
    || piNative.NO_AUTH_SENTINEL !== "N/A") {
    throw new Error("pinned Pi Native keyless API is unavailable");
  }
  const noAuthSentinel = piNative.NO_AUTH_SENTINEL;
  const streamPiNative = piNative.streamPiNative as (
    model: Record<string, unknown>,
    context: unknown,
    options: Record<string, unknown>,
  ) => NativeEventStream;
  const createEventStream = piNative.createAssistantMessageEventStream as () => NativeEventStream;
  const toolWireSchema = piNative.toolWireSchema as (tool: Record<string, unknown>) => unknown;
  const catalogModel = asRecord(modelRegistry.find(config.provider, config.model_id));
  validateCatalogModel(catalogModel, config);
  const fileClient = await openGuestBrokerFileClient(config, {
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    maxRequestFileBytes: MAX_REQUEST_FILE_BYTES,
    maxResponseFileBytes: MAX_RESPONSE_FILE_BYTES,
  });

  let closed = false;
  let codexProviderRegistered = false;
  let customProviderRegistered = false;
  const streamSimple = (
    modelValue: unknown,
    contextValue: unknown,
    streamOptionsValue?: unknown,
  ): unknown => {
    if (closed) throw new Error("guest subscription model is closed");
    const model = asRecord(modelValue);
    const streamOptions = streamOptionsValue === undefined ? {} : asRecord(streamOptionsValue);
    if (model.provider !== config.provider
      || model.id !== config.model_id
      || model.api !== CUSTOM_API) {
      throw new Error("guest subscription model selector rejected");
    }
    if (streamOptions.apiKey !== undefined && streamOptions.apiKey !== noAuthSentinel) {
      throw new Error("guest subscription credential rejected");
    }
    if (streamOptions.reasoning !== config.resolved_reasoning
      || (streamOptions.maxTokens !== undefined && streamOptions.maxTokens !== config.max_tokens)
      || streamOptions.disableReasoning === true
      || streamOptions.forceReasoningOff === true) {
      throw new Error("guest subscription effort or output limit rejected");
    }
    const signal = isAbortSignal(streamOptions.signal) ? streamOptions.signal : undefined;
    const context = asRecord(contextValue);
    const nativeContext: Record<string, unknown> = { ...context };
    if (context.tools !== undefined) {
      if (!Array.isArray(context.tools)) throw new Error("guest subscription tools rejected");
      // Pi AI Tool fields only. OMP's local label/runner/execute metadata is not
      // native model Context; message objects and opaque signatures stay intact.
      nativeContext.tools = context.tools.map((value) => {
        const tool = asRecord(value);
        const descriptor: Record<string, unknown> = {
          parameters: asRecord(toolWireSchema(tool)),
        };
        for (const key of [
          "name", "description", "strict", "deferLoading",
          "customFormat", "customWireName", "native", "examples",
        ]) {
          if (tool[key] !== undefined) descriptor[key] = tool[key];
        }
        return descriptor;
      });
    }
    const nativeModel = {
      ...catalogModel,
      provider: config.provider,
      id: config.model_id,
      api: catalogModel.api,
      transport: "pi-native",
      baseUrl: FAKE_BASE_URL,
      headers: undefined,
      resolveHeaders: undefined,
      contextWindow: config.context_window,
      maxContextWindow: config.context_window,
      maxTokens: config.max_tokens,
    };
    let fetchCalls = 0;
    const guardedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (fetchCalls !== 0) throw new Error("guest subscription transport is one-shot");
      fetchCalls += 1;
      return brokerFetch(fileClient, config, input, init);
    };
    const nativeStream = streamPiNative(nativeModel, nativeContext, {
      maxTokens: config.max_tokens,
      reasoning: config.resolved_reasoning,
      ...(signal === undefined ? {} : { signal }),
      fetch: guardedFetch,
    });
    const output = createEventStream();
    void (async () => {
      try {
        const message = asRecord(await nativeStream.result());
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          output.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          // SDK tool dispatch requires lifecycle events, but progress must not
          // repeat opaque provider signatures on every partial. The canonical
          // message remains untouched for done/result and model continuation.
          let progress: Record<string, unknown> = {
            role: message.role,
            api: message.api,
            provider: message.provider,
            model: message.model,
            usage: message.usage,
            stopReason: message.stopReason,
            timestamp: message.timestamp,
            content: [],
          };
          output.push({ type: "start", partial: progress });
          for (const [contentIndex, block] of (message.content as Record<string, unknown>[]).entries()) {
            const visible = block.type === "toolCall"
              ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
              : block.type === "image"
                ? { type: block.type, data: block.data, mimeType: block.mimeType }
                : { type: block.type, [block.type as string]: block[block.type as string] };
            progress = {
              ...progress,
              content: [...progress.content as Record<string, unknown>[], visible],
            };
            const partial = { contentIndex, partial: progress };
            if (block.type === "toolCall") {
              output.push({ type: "toolcall_start", ...partial });
              output.push({ type: "toolcall_delta", delta: JSON.stringify(block.arguments), ...partial });
              output.push({ type: "toolcall_end", toolCall: visible, ...partial });
            } else if (block.type === "text" || block.type === "thinking") {
              const type = block.type;
              output.push({ type: `${type}_start`, ...partial });
              output.push({ type: `${type}_delta`, delta: block[type], ...partial });
              output.push({ type: `${type}_end`, content: block[type], ...partial });
            } else if (block.type === "image") {
              output.push({ type: "image_end", content: visible, ...partial });
            }
          }
          output.push({ type: "done", reason: message.stopReason, message });
        }
        output.end();
      } catch (error) {
        output.fail(error);
      }
    })();
    return output;
  };

  try {
    // N/A exists only in the isolated registry. The Pi Native call below gets
    // neither this sentinel nor any other API key or Authorization header.
    modelRegistry.registerProvider("openai-codex", { apiKey: noAuthSentinel }, SOURCE_ID);
    codexProviderRegistered = true;
    modelRegistry.registerProvider(CUSTOM_PROVIDER, {
      api: CUSTOM_API,
      apiKey: noAuthSentinel,
      baseUrl: FAKE_BASE_URL,
      streamSimple,
    }, SOURCE_ID);
    customProviderRegistered = true;
    const model = {
      ...catalogModel,
      api: CUSTOM_API,
      baseUrl: FAKE_BASE_URL,
      headers: undefined,
      resolveHeaders: undefined,
      transport: undefined,
      contextWindow: config.context_window,
      maxContextWindow: config.context_window,
      maxTokens: config.max_tokens,
    };
    return {
      model,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          if (customProviderRegistered) modelRegistry.unregisterProvider?.(CUSTOM_PROVIDER);
        } finally {
          try {
            if (codexProviderRegistered) modelRegistry.unregisterProvider?.("openai-codex");
          } finally {
            await fileClient.close();
          }
        }
      },
    };
  } catch (error) {
    closed = true;
    try {
      if (customProviderRegistered) modelRegistry.unregisterProvider?.(CUSTOM_PROVIDER);
    } finally {
      try {
        if (codexProviderRegistered) modelRegistry.unregisterProvider?.("openai-codex");
      } finally {
        await fileClient.close();
      }
    }
    throw error;
  }
}

function validateCatalogModel(model: Record<string, unknown>, config: SubscriptionGuestConfig): void {
  const identity = asRecord(model.identity);
  const thinking = asRecord(model.thinking);
  const efforts = thinking.efforts;
  if (model.provider !== config.provider
    || model.id !== config.model_id
    || model.api !== "openai-codex-responses"
    || identity.class !== "openai"
    || model.reasoning !== true
    || thinking.mode !== "effort"
    || !Array.isArray(efforts)
    || efforts.length === 0
    || efforts[efforts.length - 1] !== "max"
    || !efforts.includes(config.resolved_reasoning)
    || config.thinking !== "max"
    || config.resolved_reasoning !== "max"
    || model.supportsTools === false
    || !Number.isSafeInteger(model.contextWindow)
    || (model.contextWindow as number) < config.context_window
    || !Number.isSafeInteger(model.maxTokens)
    || (model.maxTokens as number) < config.max_tokens) {
    throw new Error("pinned Luna catalog or maximum effort mismatch");
  }
}

async function brokerFetch(
  fileClient: GuestBrokerFileClient,
  config: SubscriptionGuestConfig,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (request.method !== "POST"
    || url.href !== NATIVE_STREAM_URL
    || url.search !== ""
    || url.hash !== "") {
    throw new Error("guest subscription native route rejected");
  }
  for (const header of ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-auth-token"]) {
    if (request.headers.has(header)) throw new Error("guest subscription credential header rejected");
  }
  const payloadBytes = new Uint8Array(await request.arrayBuffer());
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("guest subscription request size rejected");
  }
  const payload = parseNativePayload(payloadBytes, config);
  const receipt = await fileClient.exchange(payloadBytes, request.signal);
  const message = parseModelResponse(receipt.responseBytes, receipt, config);
  validateAssistantMessage(message, payload.context, config);
  const event = { type: "done", reason: message.stopReason, message };
  const body = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseNativePayload(
  bytes: Uint8Array,
  config: SubscriptionGuestConfig,
): { context: Record<string, unknown> } {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("guest subscription native payload is malformed");
  }
  const payload = asRecord(value);
  requireExactKeys(payload, ["modelId", "context", "options", "stream"], "guest subscription payload");
  if (payload.modelId !== `${config.provider}/${config.model_id}` || payload.stream !== true) {
    throw new Error("guest subscription model binding rejected");
  }
  const options = asRecord(payload.options);
  requireExactKeys(options, ["maxTokens", "reasoning"], "guest subscription options");
  if (options.maxTokens !== config.max_tokens || options.reasoning !== config.resolved_reasoning) {
    throw new Error("guest subscription normalized effort rejected");
  }
  return { context: validateContext(payload.context, config) };
}

function validateContext(value: unknown, config: SubscriptionGuestConfig): Record<string, unknown> {
  const context = asRecord(value);
  const allowedFields = ["systemPrompt", "messages", "tools"];
  if (Object.keys(context).some((key) => !allowedFields.includes(key))) {
    throw new Error("guest subscription Context fields rejected");
  }
  if (context.systemPrompt !== undefined
    && (!Array.isArray(context.systemPrompt) || context.systemPrompt.some((item) => typeof item !== "string"))) {
    throw new Error("guest subscription system prompt rejected");
  }
  if (!Array.isArray(context.messages) || context.messages.length === 0) {
    throw new Error("guest subscription message context rejected");
  }
  if (context.tools !== undefined) {
    if (!Array.isArray(context.tools) || context.tools.length > config.allowed_tools.length) {
      throw new Error("guest subscription tool context rejected");
    }
    const seen = new Set<string>();
    for (const toolValue of context.tools) {
      const tool = asRecord(toolValue);
      if (typeof tool.name !== "string"
        || !config.allowed_tools.includes(tool.name as WorkerToolName)
        || seen.has(tool.name)) {
        throw new Error("guest subscription tool scope rejected");
      }
      seen.add(tool.name);
    }
  }
  return context;
}

function parseModelResponse(
  bytes: Uint8Array,
  receipt: { requestId: string; payloadSha256: string },
  config: SubscriptionGuestConfig,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("guest subscription response is malformed");
  }
  const object = asRecord(value);
  requireExactKeys(object, [
    "version",
    "kind",
    "request_id",
    "execution_id",
    "authority_epoch",
    "payload_sha256",
    "status",
    "message_json",
    "message_sha256",
    "reason_code",
  ], "guest subscription response");
  const status = object.status;
  if (object.version !== 1
    || object.kind !== "model_response"
    || object.request_id !== receipt.requestId
    || object.execution_id !== config.execution_id
    || object.authority_epoch !== config.authority_epoch
    || object.payload_sha256 !== receipt.payloadSha256
    || (status !== "completed" && status !== "rejected" && status !== "effect_unknown")) {
    throw new Error("guest subscription response binding rejected");
  }
  const messageJson = object.message_json;
  const messageSha256 = object.message_sha256;
  const reasonCode = object.reason_code;
  if ((messageJson !== null && typeof messageJson !== "string")
    || (messageSha256 !== null && typeof messageSha256 !== "string")
    || (reasonCode !== null && typeof reasonCode !== "string")) {
    throw new Error("guest subscription response value types rejected");
  }
  const response: ModelResponse = {
    version: 1,
    kind: "model_response",
    request_id: receipt.requestId,
    execution_id: config.execution_id,
    authority_epoch: config.authority_epoch,
    payload_sha256: receipt.payloadSha256,
    status,
    message_json: messageJson,
    message_sha256: messageSha256,
    reason_code: reasonCode,
  };
  if (status !== "completed") {
    if (response.message_json !== null
      || response.message_sha256 !== null
      || response.reason_code === null
      || !/^[a-z][a-z0-9_]{0,63}$/.test(response.reason_code)) {
      throw new Error("guest subscription failure receipt rejected");
    }
    throw new Error("guest subscription broker returned no completed model response");
  }
  if (response.message_json === null
    || response.message_sha256 === null
    || !SHA256_RE.test(response.message_sha256)
    || response.reason_code !== null
    || Buffer.byteLength(response.message_json, "utf8") > MAX_MESSAGE_BYTES
    || sha256(response.message_json) !== response.message_sha256) {
    throw new Error("guest subscription completion binding rejected");
  }
  let message: unknown;
  try {
    message = JSON.parse(response.message_json);
  } catch {
    throw new Error("guest subscription AssistantMessage is malformed");
  }
  return asRecord(message);
}

function validateAssistantMessage(
  message: Record<string, unknown>,
  context: Record<string, unknown>,
  config: SubscriptionGuestConfig,
): void {
  if (message.role !== "assistant"
    || message.api !== "openai-codex-responses"
    || message.provider !== config.provider
    || message.model !== config.model_id
    || !Number.isSafeInteger(message.timestamp)
    || (message.timestamp as number) < 0
    || (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse")
    || message.retryRecovery !== undefined
    || message.errorMessage !== undefined
    || message.errorStatus !== undefined
    || message.errorId !== undefined
    || (message.disabledFeatures !== undefined
      && (!Array.isArray(message.disabledFeatures) || message.disabledFeatures.length !== 0))) {
    throw new Error("guest subscription AssistantMessage identity rejected");
  }
  const usage = asRecord(message.usage);
  for (const field of TOKEN_FIELDS) {
    if (!isNonnegativeInteger(usage[field])) throw new Error("guest subscription usage rejected");
  }
  const cost = asRecord(usage.cost);
  for (const field of COST_FIELDS) {
    if (!isNonnegativeFinite(cost[field])) throw new Error("guest subscription cost rejected");
  }
  if (!Array.isArray(message.content) || message.content.length > 16_384) {
    throw new Error("guest subscription AssistantMessage content rejected");
  }
  const contextTools = context.tools;
  const allowedTools = new Set<string>();
  if (Array.isArray(contextTools)) {
    for (const tool of contextTools) {
      const name = asRecord(tool).name;
      if (typeof name === "string") allowedTools.add(name);
    }
  }
  const toolCallIds = new Set<string>();
  let toolCalls = 0;
  for (const itemValue of message.content) {
    const item = asRecord(itemValue);
    switch (item.type) {
      case "text":
        requireString(item.text, "guest subscription text content rejected");
        break;
      case "thinking":
        requireString(item.thinking, "guest subscription thinking content rejected");
        break;
      case "redactedThinking":
        requireString(item.data, "guest subscription redacted thinking rejected");
        break;
      case "image":
        requireString(item.data, "guest subscription image data rejected");
        requireString(item.mimeType, "guest subscription image MIME type rejected");
        break;
      case "toolCall": {
        if (typeof item.id !== "string"
          || item.id.length < 1
          || item.id.length > 256
          || typeof item.name !== "string"
          || !allowedTools.has(item.name)
          || !config.allowed_tools.includes(item.name as WorkerToolName)
          || toolCallIds.has(item.id)) {
          throw new Error("guest subscription tool call rejected");
        }
        asRecord(item.arguments);
        toolCallIds.add(item.id);
        toolCalls += 1;
        break;
      }
      default:
        throw new Error("guest subscription native content type rejected");
    }
  }
  if ((message.stopReason === "toolUse") !== (toolCalls > 0)) {
    throw new Error("guest subscription tool completion state rejected");
  }
}

function requireExactKeys(object: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(object).length !== keys.length || Object.keys(object).some((key) => !keys.includes(key))) {
    throw new Error(`${label} fields rejected`);
  }
}

function requireString(value: unknown, error: string): void {
  if (typeof value !== "string") throw new Error(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guest subscription value must be an object");
  }
  return value as Record<string, unknown>;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null
    && typeof value === "object"
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
