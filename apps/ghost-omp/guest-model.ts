import { createHash } from "node:crypto";
import { openGuestBrokerFileClient, type GuestModelConfig } from "./guest-broker-client.ts";
import { completionToSse, validateLocalCompletion } from "./completion-codec.mjs";

const CONTRACT_VERSION = 1;
const CUSTOM_API = "ghost-guest-model-broker";
const LOCAL_BASE_URL = "http://127.0.0.1/v1";
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_COMPLETION_BYTES = 4_194_304;
const MAX_REQUEST_FILE_BYTES = 2 * MAX_PAYLOAD_BYTES + 65_536;
const MAX_RESPONSE_FILE_BYTES = 2 * MAX_COMPLETION_BYTES + 65_536;

interface GuestModelRegistry {
  registerProvider(provider: string, config: Record<string, unknown>, sourceId: string): void;
  unregisterProvider?(provider: string): void;
  find(provider: string, modelId: string): unknown;
}

interface PiAiRuntime {
  streamSimple: unknown;
  NO_AUTH_SENTINEL: unknown;
}


interface GuestResponse {
  version: number;
  request_id: string;
  payload_sha256: string;
  status: "completed" | "rejected" | "effect_unknown";
  http_status: number | null;
  completion_json: string | null;
  response_sha256: string | null;
  reason_code: string | null;
}


export async function registerGuestModel(options: {
  config: GuestModelConfig;
  modelRegistry: GuestModelRegistry;
  piAi: PiAiRuntime;
}): Promise<{ model: unknown; close: () => Promise<void> }> {
  const { config, modelRegistry, piAi } = options;
  if (typeof piAi.streamSimple !== "function" || typeof piAi.NO_AUTH_SENTINEL !== "string" || piAi.NO_AUTH_SENTINEL !== "N/A") {
    throw new Error("pinned Pi AI keyless streaming API is unavailable");
  }
  const noAuthSentinel = piAi.NO_AUTH_SENTINEL;
  const streamSimple = piAi.streamSimple as (
    model: Record<string, unknown>,
    context: unknown,
    options: Record<string, unknown>,
  ) => unknown;
  const fileClient = await openGuestBrokerFileClient(config, {
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    maxRequestFileBytes: MAX_REQUEST_FILE_BYTES,
    maxResponseFileBytes: MAX_RESPONSE_FILE_BYTES,
  });
  let closed = false;
  const brokerFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (closed) throw new Error("guest model transport is closed");
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST"
      || url.origin !== new URL(LOCAL_BASE_URL).origin
      || url.pathname !== "/v1/chat/completions"
      || url.search !== ""
      || url.hash !== "") {
      throw new Error("guest model request route rejected");
    }
    for (const header of ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]) {
      if (request.headers.has(header)) throw new Error("guest model credential header rejected");
    }
    const payloadBytes = new Uint8Array(await request.arrayBuffer());
    if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
      throw new Error("guest model request size rejected");
    }
    const receipt = await fileClient.exchange(payloadBytes, request.signal);
    const response = parseResponse(receipt.responseBytes, receipt.requestId, receipt.payloadSha256);
    if (response.status !== "completed" || response.completion_json === null) {
      return guestModelFailure(response.reason_code ?? "unknown", response.http_status);
    }
    if (Buffer.byteLength(response.completion_json, "utf8") > MAX_COMPLETION_BYTES
      || response.response_sha256 !== sha256(Buffer.from(response.completion_json, "utf8"))) {
      throw new Error("guest model completion binding rejected");
    }
    let completion: unknown;
    try {
      completion = JSON.parse(response.completion_json);
      validateLocalCompletion(completion, config.model_id, config.allowed_tools);
    } catch (error) {
      const reason = error instanceof Error && "reason" in error
        ? String(error.reason) : "invalid_json";
      return guestModelFailure(`completion_${reason}`);
    }
    return new Response(completionToSse(completion, config.model_id), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };

  try {
    modelRegistry.registerProvider(
      "local",
      {
        api: CUSTOM_API,
        apiKey: noAuthSentinel,
        baseUrl: LOCAL_BASE_URL,
        streamSimple: (modelValue: unknown, context: unknown, streamOptions?: unknown) => {
          const model = asRecord(modelValue);
          const currentOptions = streamOptions === undefined ? {} : asRecord(streamOptions);
          if (model.provider !== "local" || model.id !== config.model_id || model.api !== CUSTOM_API) {
            throw new Error("guest model selector mismatch");
          }
          const apiKey = currentOptions.apiKey;
          if (apiKey !== undefined && apiKey !== noAuthSentinel) {
            throw new Error("guest model keyless provider received a credential");
          }
          if (currentOptions.reasoning !== undefined && currentOptions.reasoning !== "off") {
            throw new Error("protected local model does not accept a reasoning effort");
          }
          const signal = isAbortSignal(currentOptions.signal) ? currentOptions.signal : undefined;
          const nativeModel = {
            ...model,
            api: "openai-completions",
            provider: "local",
            baseUrl: LOCAL_BASE_URL,
            headers: undefined,
            apiKey: undefined,
            // Custom APIs have only sparse compatConfig; the pinned native
            // streamer resolves its OpenAI policy on this request-local clone.
            compat: undefined,
            compatConfig: {
              ...asRecord(model.compatConfig),
              maxTokensField: "max_tokens",
              supportsUsageInStreaming: true,
              supportsSamplingParams: false,
              supportsPenaltyAndStopParams: false,
              supportsStore: false,
              supportsReasoningEffort: false,
            },
          };
          const oneShotFetch = createOneShotGuestFetch(brokerFetch);
          return streamSimple(nativeModel, context, {
            apiKey: noAuthSentinel,
            maxTokens: config.max_tokens,
            maxTokensExplicit: true,
            disableReasoning: true,
            signal,
            fetch: oneShotFetch,
          });
        },
        models: [{
          id: config.model_id,
          name: `Pinned local ${config.model_id} via Ghost guest broker`,
          api: CUSTOM_API,
          baseUrl: LOCAL_BASE_URL,
          reasoning: false,
          input: ["text"],
          supportsTools: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: config.context_window,
          maxTokens: config.max_tokens,
          compat: {
            maxTokensField: "max_tokens",
            supportsUsageInStreaming: true,
            supportsReasoningEffort: false,
            supportsSamplingParams: false,
            supportsPenaltyAndStopParams: false,
            supportsStore: false,
          },
        }],
      },
      "ghost-c2b-guest-model",
    );
    const model = modelRegistry.find("local", config.model_id);
    if (model === undefined) throw new Error("pinned guest model registration failed");
    return {
      model,
      close: async () => {
        if (closed) return;
        closed = true;
        modelRegistry.unregisterProvider?.("local");
        await fileClient.close();
      },
    };
  } catch (error) {
    closed = true;
    await fileClient.close();
    throw error;
  }
}

// The SDK treats thrown fetch errors as transient network failures. Surface a
// broker/validation rejection as a terminal adapter response instead, retaining
// the broker's reason and HTTP status without exposing upstream response text.
// 422 is this adapter's status, not a claim about the upstream HTTP response.
export function guestModelFailure(reason: string, upstreamHttpStatus: number | null = null): Response {
  const safeReason = /^[a-z_]{1,96}$/.test(reason) ? reason : "invalid_failure_reason";
  return new Response(JSON.stringify({ error: {
    type: "ghost_model_broker_error",
    code: safeReason,
    message: `Ghost model broker: ${safeReason}${upstreamHttpStatus === null ? "" : ` (upstream HTTP ${upstreamHttpStatus})`}`,
    upstream_http_status: upstreamHttpStatus,
  } }), { status: 422, headers: { "content-type": "application/json" } });
}

export function createOneShotGuestFetch(fetchOnce: typeof fetch): typeof fetch {
  let attempt: Promise<Response> | undefined;
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (attempt !== undefined) {
      return attempt.then(response => {
        // Re-reading a terminal rejection cannot invoke the broker again, even
        // when a pinned SDK revision tries to retry it internally.
        if (!response.ok) return response.clone();
        throw new Error("guest model duplicate request blocked after completed response");
      });
    }
    attempt = Promise.resolve().then(() => fetchOnce(input, init));
    return attempt.then(response => response.clone());
  }) as typeof fetch;
}


function parseResponse(bytes: Uint8Array, requestId: string, digest: string): GuestResponse {
  let response: unknown;
  try {
    response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("guest broker response is malformed");
  }
  const object = asRecord(response);
  const keys = [
    "version",
    "request_id",
    "payload_sha256",
    "status",
    "http_status",
    "completion_json",
    "response_sha256",
    "reason_code",
  ];
  if (Object.keys(object).length !== keys.length || Object.keys(object).some((key) => !keys.includes(key))) {
    throw new Error("guest broker response fields rejected");
  }
  const status = object.status;
  if (object.version !== CONTRACT_VERSION
    || object.request_id !== requestId
    || object.payload_sha256 !== digest
    || (status !== "completed" && status !== "rejected" && status !== "effect_unknown")
    || (object.http_status !== null && (!Number.isInteger(object.http_status) || (object.http_status as number) < 100 || (object.http_status as number) > 599))) {
    throw new Error("guest broker response binding rejected");
  }
  const responseValue: GuestResponse = {
    version: CONTRACT_VERSION,
    request_id: requestId,
    payload_sha256: digest,
    status,
    http_status: object.http_status as number | null,
    completion_json: typeof object.completion_json === "string" ? object.completion_json : null,
    response_sha256: typeof object.response_sha256 === "string" ? object.response_sha256 : null,
    reason_code: typeof object.reason_code === "string" ? object.reason_code : null,
  };
  if (status === "completed") {
    if (responseValue.completion_json === null
      || responseValue.response_sha256 === null
      || responseValue.reason_code !== null
      || responseValue.http_status === null
      || responseValue.http_status < 200
      || responseValue.http_status >= 300) {
      throw new Error("guest broker completion receipt rejected");
    }
  } else if (responseValue.completion_json !== null
    || responseValue.response_sha256 !== null
    || responseValue.reason_code === null
    || !isReasonCode(responseValue.reason_code)) {
    throw new Error("guest broker failure receipt rejected");
  }
  return responseValue;
}

function isReasonCode(value: string): boolean {
  return [
    "invalid_payload",
    "request_limit",
    "authorization_denied",
    "cancelled_before_io",
    "cancelled_in_flight",
    "deadline_before_io",
    "upstream_timeout",
    "upstream_transport_error",
    "upstream_http_error",
    "upstream_invalid_response",
    "restart_pending",
    "broker_stopped",
    "scope_revoked",
  ].includes(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guest model value must be an object");
  }
  return value as Record<string, unknown>;
}



function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null
    && typeof value === "object"
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}
