import {
  CALL_CONNECT_SECONDS,
  CALL_MAX_SECONDS,
  CallVoicePreview,
  DEFAULT_VOICE,
  parse,
  type Call,
  type CallEndReason,
  type CallEngine,
  type VoiceSettings,
} from "@ghost/contract";
import type { Core } from "./core.ts";
import type { Access } from "./access.ts";
import { CommandError, conflict, invalid, notFound } from "./errors.ts";
import { newId } from "./ids.ts";

/** Voice samples kept in memory; each is a few seconds of audio. */
const MAX_SAMPLES = 48;
/** What a voice preview says. Korean, since that is the language a call is held in. */
export const VOICE_SAMPLE_TEXT = "안녕하세요, Ghost예요. 지금 들으시는 목소리로 통화할게요.";

/** Persisted in `settings` (`calls`): no ledger migration, so a release rollback keeps its storage fingerprint. */
const KEY = "calls";
/** Ended calls kept for the snapshot; live calls are never trimmed. */
const KEPT = 50;

/**
 * Tells the model that this turn was spoken and what it writes is read aloud. Kept short and static per engine.
 * Local: the Host reads its words as they stream, so the model answers first and then works; silence while it
 * works is dead air on a phone. Realtime: a voice model already acknowledged the caller and paraphrases the
 * final text, so the Ghost only returns the result.
 */
export function voiceTurnNote(engine: CallEngine | undefined): string {
  if (engine === "realtime") {
    return "<host-voice-call> This request was spoken in a live voice call and a voice assistant already told the caller you are on it. Do not announce that you are starting. Write the result in one or two short, plain spoken sentences: no markdown, lists, tables, code blocks, links or emoji. If it is long, give the gist and say the details are in the conversation.";
  }
  return "<host-voice-call> This message was spoken in a live voice call and your words are read aloud as you write them. Use short, plain spoken sentences: no markdown, lists, tables, code blocks, links or emoji. Answer first: before you call a tool or think at length, open with one short sentence that answers or says what you are about to do, because the caller hears nothing while you work. Do not repeat that sentence afterwards. When the work is done, give the result in a sentence or two; if it is long, give the gist and say the details are in the conversation.";
}

/**
 * What an engine lends the call layer. `unavailable` is synchronous because a call starts inside one
 * ledger transaction: an engine that must probe something keeps its last answer fresh in the background.
 */
export interface CallEnginePort {
  /** Why this engine cannot take a call right now, in words the owner can act on; null when it can. */
  unavailable(): string | null;
  /** Release the engine's side of a call that has ended. A failure is logged and never reopens the call. */
  hangup(call: Call): Promise<void>;
  /** The engine's own `/api/calls/:id/...` routes; null when the request is not one of them. The caller is already authenticated. */
  serve?(request: Request, url: URL, access: Access): Promise<Response | null>;
  /** One spoken sample of `voice` as mono PCM16 WAV, outside any call. Engines that cannot say it leave this out or throw `invalid`. */
  preview?(voice: string): Promise<Uint8Array>;
}

const live = (call: Call) => call.status === "connecting" || call.status === "active";

/**
 * Voice calls. This owns the lifecycle and the limits (one live call, a connect deadline, a time limit);
 * engines only carry speech. A call survives no Host restart: whatever was live is failed on startup,
 * never resumed, because the engine's media is gone.
 */
export class Calls {
  private readonly engines = new Map<CallEngine, CallEnginePort>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly samples = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly core: Core) {}

  private get ledger() {
    return this.core.ledger;
  }

  register(engine: CallEngine, port: CallEnginePort) {
    this.engines.set(engine, port);
  }

  /** Newest first. */
  list(): Call[] {
    return this.ledger.setting<Call[]>(KEY, []);
  }

  find(callId: string): Call | null {
    return this.list().find((call) => call.id === callId) ?? null;
  }

  get(callId: string): Call {
    const call = this.find(callId);
    if (!call) throw notFound(`call ${callId} not found`);
    return call;
  }

  active(): Call | null {
    return this.list().find(live) ?? null;
  }

  /** The call a spoken message names must be live and speak into that conversation. */
  requireLive(callId: string, conversationId: string): Call {
    const call = this.find(callId);
    if (!call || call.conversationId !== conversationId) throw invalid(`call ${callId} is not a call in this conversation`);
    if (!live(call)) throw conflict("the call has ended");
    return call;
  }

  /** Offer an authenticated `/api/calls/...` request to each engine in turn; `preview` is the Host's own route. */
  async serve(request: Request, url: URL, access: Access): Promise<Response | null> {
    if (url.pathname === "/api/calls/preview") return this.servePreview(request);
    for (const port of this.engines.values()) {
      const response = await port.serve?.(request, url, access);
      if (response) return response;
    }
    return null;
  }

  /** Hear a voice before choosing it. One sample per engine and voice is kept, so a repeat costs nothing. */
  private async servePreview(request: Request): Promise<Response> {
    if (request.method !== "POST") throw invalid("음성 미리 듣기는 POST로 보내 주세요.");
    const body: unknown = await request.json().catch(() => { throw invalid("음성 미리 듣기 요청은 JSON으로 보내 주세요."); });
    const { engine, voice } = parse(CallVoicePreview, body);
    const port = this.engines.get(engine);
    const unavailable = port?.preview ? port.unavailable() : `The ${engine} voice engine cannot preview voices.`;
    if (unavailable !== null || !port?.preview) throw new CommandError("unavailable", unavailable ?? "preview unavailable");
    const key = `${engine}:${voice}`;
    let sample = this.samples.get(key);
    if (sample) {
      this.samples.delete(key);
      this.samples.set(key, sample);
    } else {
      sample = port.preview(voice);
      this.samples.set(key, sample);
      // A failed or refused sample is never kept: the next tap tries again.
      sample.catch(() => { if (this.samples.get(key) === sample) this.samples.delete(key); });
      while (this.samples.size > MAX_SAMPLES) this.samples.delete(this.samples.keys().next().value!);
    }
    const wav = await sample;
    return new Response(new Uint8Array(wav), { headers: { "cache-control": "no-store", "content-type": "audio/wav", "x-content-type-options": "nosniff" } });
  }

  voice(): VoiceSettings {
    return { ...DEFAULT_VOICE, ...this.ledger.setting<Partial<VoiceSettings>>("voice", {}) };
  }

  /** Persist the owner's voice defaults. The caller publishes the settings change. */
  setVoice(patch: Partial<VoiceSettings>) {
    this.ledger.putSetting("voice", { ...this.voice(), ...patch });
  }

  start(ghostId: string, engine?: CallEngine): Call {
    const ghost = this.ledger.ghost(ghostId);
    if (ghost.deletedAt !== null || ghost.state === "retired") throw conflict(`${ghost.name} cannot take calls`);
    const chosen = engine ?? this.voice().engine;
    const port = this.engines.get(chosen);
    const unavailable = port ? port.unavailable() : `The ${chosen} voice engine is not installed.`;
    if (unavailable !== null) throw new CommandError("unavailable", unavailable);
    if (this.active()) throw conflict("End the current call before starting another.");
    const call: Call = {
      id: newId(),
      ghostId,
      conversationId: ghost.directConversationId,
      engine: chosen,
      status: "connecting",
      startedAt: Date.now(),
      answeredAt: null,
      endedAt: null,
      seconds: null,
      endReason: null,
      error: null,
    };
    this.put(call);
    this.arm(call.id, CALL_CONNECT_SECONDS);
    // Loading the conversation and compacting an over-long context would otherwise land inside the owner's first sentence.
    this.ledger.afterCommit(() => {
      try {
        void this.core.engine.prepare?.(call.conversationId).catch((error) => this.core.log("call prepare failed", { callId: call.id, error: error instanceof Error ? error.message : String(error) }));
      } catch {
        // No engine is attached; there is nothing to prepare.
      }
    });
    return call;
  }

  /** The engine connected: connecting → active, and the time limit starts. Repeating it changes nothing. */
  activate(callId: string): Call {
    const call = this.get(callId);
    if (call.status === "active") return call;
    if (call.status !== "connecting") throw conflict("the call has ended");
    const next: Call = { ...call, status: "active", answeredAt: Date.now() };
    this.put(next);
    this.arm(callId, CALL_MAX_SECONDS);
    return next;
  }

  /**
   * Close a live call. `reason` decides the final state: error, unavailable and interrupted calls failed,
   * hangup and limit ended. Closing a closed call changes nothing. `seconds` is the engine's own count when it has one.
   */
  end(callId: string, reason: CallEndReason, detail: { seconds?: number; error?: string } = {}): Call {
    const call = this.get(callId);
    if (!live(call)) return call;
    const now = Date.now();
    const failed = reason === "error" || reason === "unavailable" || reason === "interrupted";
    const next: Call = {
      ...call,
      status: failed ? "failed" : "ended",
      endedAt: now,
      seconds: detail.seconds ?? (call.answeredAt === null ? 0 : Math.max(0, Math.round((now - call.answeredAt) / 1000))),
      endReason: reason,
      error: failed ? (detail.error ?? "The call stopped.") : null,
    };
    this.put(next);
    this.disarm(callId);
    // The engine hears about it only once the ending is durable.
    this.ledger.afterCommit(() => {
      const port = this.engines.get(call.engine);
      if (reason !== "interrupted" && port) void port.hangup(next).catch((error) => this.core.log("call hangup failed", { callId, error: error instanceof Error ? error.message : String(error) }));
    });
    return next;
  }

  /**
   * The engine's final usage arrives after the call closed (the provider reports it on its own close).
   * Corrects a closed call's seconds; a live call is closed with `end`, never by this. No engine hook runs.
   */
  recordUsage(callId: string, seconds: number): Call {
    const call = this.get(callId);
    if (live(call)) throw conflict("the call is still live; end it first");
    if (!Number.isInteger(seconds) || seconds < 0) throw invalid("seconds must be a non-negative integer");
    if (call.seconds === seconds) return call;
    const next: Call = { ...call, seconds };
    this.put(next);
    return next;
  }

  /** A connect or time deadline fired. */
  expire(callId: string) {
    const call = this.find(callId);
    if (!call || !live(call)) return;
    this.ledger.tx(() => {
      if (call.status === "connecting") this.end(callId, "unavailable", { error: "The call did not connect." });
      else this.end(callId, "limit");
    });
  }

  /** Startup: every call that was live lost its media with the old process. */
  recover() {
    for (const call of this.list()) {
      if (live(call)) this.ledger.tx(() => this.end(call.id, "interrupted", { error: "The Host restarted during the call." }));
    }
  }

  stop() {
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
  }

  private put(call: Call) {
    this.ledger.tx(() => {
      const rest = this.list().filter((item) => item.id !== call.id);
      const all = [call, ...rest].sort((a, b) => b.startedAt - a.startedAt);
      const liveCalls = all.filter(live);
      const ended = all.filter((item) => !live(item)).slice(0, KEPT);
      this.ledger.putSetting(KEY, [...liveCalls, ...ended].sort((a, b) => b.startedAt - a.startedAt));
      this.ledger.emit({ type: "call", call });
    });
  }

  private arm(callId: string, seconds: number) {
    this.disarm(callId);
    // Armed only once the change is durable, so a rolled-back start leaves no timer behind.
    this.ledger.afterCommit(() => {
      const timer = setTimeout(() => {
        this.deadlines.delete(callId);
        try {
          this.expire(callId);
        } catch (error) {
          this.core.log("call deadline failed", { callId, error: error instanceof Error ? error.message : String(error) });
        }
      }, seconds * 1000);
      timer.unref?.();
      this.deadlines.set(callId, timer);
    });
  }

  private disarm(callId: string) {
    clearTimeout(this.deadlines.get(callId));
    this.deadlines.delete(callId);
  }
}
