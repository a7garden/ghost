import { CallSpeechRequest, CallTranscript, ContractError, parse, type Call } from "@ghost/contract";
import type { Core } from "../core/core.ts";
import type { CallEnginePort } from "../core/calls.ts";
import { CommandError, invalid, notFound } from "../core/errors.ts";

/** `ghost-voice-server` wire identifiers (speech_contract.py); the Host never loads models itself. */
const STT_MODEL = "apple-speechanalyzer";
const TTS_MODEL = "supertonic-3";
/** The speech server refuses larger bodies before parsing (MAX_BODY), so the Host never forwards one. */
const MAX_WAV_BYTES = 5 * 1024 * 1024;
/** `CallSpeechRequest` text is ≤500 characters; the JSON wrapper only needs a small bound. */
const MAX_SPEECH_JSON_BYTES = 16 * 1024;
const LANGUAGES = new Set(["ko", "en", "ja", "zh"]);
/** The speech server queues three and runs one at a time; the Host keeps headroom instead of piling up. */
const MAX_INFLIGHT = 2;
const STT_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

const STATUS: Record<CommandError["code"], number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 };

/** The local engine: the client captures and plays audio, the Host only proxies to the loopback speech server. */
export type LocalCallEngine = CallEnginePort & { start(): void; stop(): void };

/** Loopback HTTP only, mirroring the Python side's `loopback_speech_url`: no credentials, path, query or fragment. */
function loopbackSpeechUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("speechUrl must be loopback http (127.0.0.1, localhost or ::1)");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "http:" || !loopback || parsed.username !== "" || parsed.password !== "" || (parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search !== "" || parsed.hash !== "") {
    throw invalid("speechUrl must be loopback http (127.0.0.1, localhost or ::1)");
  }
  return parsed;
}

/** Reading the request body failed only because it is over the bound; reported as 413 like the mail routes. */
class BodyTooLarge extends Error {}

type Health = "pending" | "down" | "loading" | "ready";

/** `/health` is trusted only when it is our service and carries boolean backend load flags (lazy first load). */
function isOurHealth(value: unknown): value is { service: unknown; model_loaded: { stt: boolean; tts: boolean } } {
  if (typeof value !== "object" || value === null || !("service" in value) || !("model_loaded" in value)) return false;
  const flags = value.model_loaded;
  if (typeof flags !== "object" || flags === null || !("stt" in flags) || !("tts" in flags)) return false;
  return value.service === "ghost-local-speech" && typeof flags.stt === "boolean" && typeof flags.tts === "boolean";
}

/** One in-flight upstream request; `controller` is what a hangup cuts. */
class Attempt {
  readonly controller = new AbortController();
  constructor(readonly callId: string) {}
}

async function readBytes(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) throw invalid("음성 요청 본문이 비어 있습니다.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new BodyTooLarge("음성 데이터가 너무 큽니다.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The local voice engine: `unavailable` is a cached background probe (`start` refreshes it), and `serve`
 * proxies the two authenticated call routes to the loopback speech server. Nothing here activates a call
 * or submits a turn — the client transcribes, sends `message.send` itself, and speaks the reply sentence
 * by sentence, so a first transcription or spoken reply is never an activation.
 */
export function createLocalCallEngine(deps: { core: Core; speechUrl: string; fetch?: typeof fetch; probeEveryMs?: number }): LocalCallEngine {
  const { core } = deps;
  const speechUrl = loopbackSpeechUrl(deps.speechUrl);
  const doFetch: (input: string, init?: RequestInit) => Promise<Response> = deps.fetch ?? ((input, init) => fetch(input, init));

  let health: Health = "pending";
  let probeTimer: Timer | undefined;

  async function probe(): Promise<void> {
    health = "down";
    try {
      const response = await doFetch(new URL("/health", speechUrl).href, { redirect: "error", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const body: unknown = response.ok ? await response.json() : null;
      if (isOurHealth(body)) health = body.model_loaded.stt && body.model_loaded.tts ? "ready" : "loading";
    } catch {
      // An unreachable or malformed health answer stays "down": the message below says where to look.
    }
  }

  const attempts = new Map<string, Set<Attempt>>();
  let inflight = 0;

  return {
    start() {
      clearInterval(probeTimer);
      void probe();
      probeTimer = setInterval(() => void probe(), deps.probeEveryMs ?? 10_000);
      probeTimer.unref?.();
    },
    stop() {
      clearInterval(probeTimer);
      probeTimer = undefined;
    },
    unavailable(): string | null {
      if (health === "ready") return null;
      if (health === "pending") return "음성 서버 상태를 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
      if (health === "down") return `음성 서버가 ${speechUrl.href} 에서 실행되고 있지 않습니다.`;
      return "음성 모델이 아직 로드되지 않았습니다. 잠시 후 다시 시도해 주세요.";
    },
    /** Nothing to release server-side; only this call's in-flight upstream fetches are cut, once. */
    async hangup(call: Call): Promise<void> {
      const live = attempts.get(call.id);
      if (!live) return;
      attempts.delete(call.id);
      for (const attempt of live) attempt.controller.abort(new Error("hangup"));
    },
    async serve(request: Request, url: URL): Promise<Response | null> {
      const match = /^\/api\/calls\/([^/]{1,128})\/(transcribe|speech)$/.exec(url.pathname);
      if (!match) return null;
      const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
      const callId = decodeURIComponent(match[1]!);
      let attempt: Attempt | null = null;
      // Never follow redirects and never consult a proxy: loopback only, like the Python client.
      const send = (target: Attempt, path: string, timeoutMs: number, init: RequestInit): Promise<Response> => {
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), timeoutMs);
        timer.unref?.();
        return doFetch(new URL(path, speechUrl).href, { ...init, redirect: "error", signal: AbortSignal.any([request.signal, target.controller.signal, deadline.signal]) }).finally(() => clearTimeout(timer));
      };
      try {
        if (request.method !== "POST") return json({ ok: false, error: { code: "invalid", message: "음성 요청은 POST로 보내 주세요." } }, 405);
        const call = core.calls.find(callId);
        if (!call) throw notFound("통화를 찾을 수 없습니다.");
        if (call.engine !== "local") throw new CommandError("conflict", "이 통화는 local 음성 엔진의 통화가 아닙니다.");
        if (call.status !== "connecting" && call.status !== "active") throw new CommandError("conflict", "통화가 이미 종료되었습니다.");
        if (inflight >= MAX_INFLIGHT) return json({ ok: false, error: { code: "unavailable", message: "음성 처리가 몰려 있습니다. 잠시 후 다시 시도해 주세요." } }, 429, { "retry-after": "1" });

        attempt = new Attempt(callId);
        const live = attempts.get(callId);
        if (live) live.add(attempt);
        else attempts.set(callId, new Set([attempt]));
        inflight += 1;

        if (match[2] === "transcribe") {
          const wav = await readBytes(request, MAX_WAV_BYTES);
          const raw = url.searchParams.get("language");
          const language = raw === null || raw === "" ? undefined : raw;
          if (language !== undefined && !LANGUAGES.has(language)) throw invalid("language 값은 ko, en, ja, zh 중 하나여야 합니다.");
          const form = new FormData();
          form.append("model", STT_MODEL);
          if (language !== undefined) form.append("language", language);
          form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
          const response = await send(attempt, "/v1/audio/transcriptions", STT_TIMEOUT_MS, { method: "POST", body: form });
          if (!response.ok) throw new CommandError("unavailable", "음성 서버가 응답하지 않아 받아쓰지 못했습니다.");
          const body: unknown = await response.json();
          return json({ text: parse(CallTranscript, body).text } satisfies CallTranscript);
        }
        const speech = parse(CallSpeechRequest, JSON.parse(new TextDecoder().decode(await readBytes(request, MAX_SPEECH_JSON_BYTES))));
        const response = await send(attempt, "/v1/audio/speech", TTS_TIMEOUT_MS, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: TTS_MODEL, input: speech.text, voice: core.calls.voice().voice, response_format: "wav" }),
        });
        if (!response.ok) throw new CommandError("unavailable", "음성 서버가 응답하지 않아 말하지 못했습니다.");
        return new Response(new Uint8Array(await response.arrayBuffer()), { headers: { "cache-control": "no-store", "content-type": "audio/wav", "x-content-type-options": "nosniff" } });
      } catch (error) {
        if (error instanceof BodyTooLarge) return json({ ok: false, error: { code: "invalid", message: error.message } }, 413);
        if (error instanceof CommandError) return json({ ok: false, error: { code: error.code, message: error.message } }, STATUS[error.code]);
        if (attempt?.controller.signal.aborted) return json({ ok: false, error: { code: "conflict", message: "통화가 종료되어 음성 처리를 중단했습니다." } }, 409);
        if (error instanceof ContractError || error instanceof SyntaxError) return json({ ok: false, error: { code: "invalid", message: "음성 요청 본문이 올바르지 않습니다." } }, 400);
        // Client disconnects, upstream timeouts and network failures all stay bounded; upstream bodies are never echoed.
        core.log("local call speech failed", { callId, error: error instanceof Error ? error.message : String(error) });
        return json({ ok: false, error: { code: "unavailable", message: "음성 처리를 제때 끝내지 못했습니다. 잠시 후 다시 시도해 주세요." } }, 503);
      } finally {
        if (attempt !== null) {
          const live = attempts.get(attempt.callId);
          live?.delete(attempt);
          if (live?.size === 0) attempts.delete(attempt.callId);
          inflight -= 1;
        }
      }
    },
  };
}
