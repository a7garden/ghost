import { Type, type Static } from "typebox";
import { CallEngine, Id, Timestamp, nullable, type VoiceSettings } from "./entities.ts";

/**
 * Voice call (owner decision 2026-11-23). A call is a session attached to a Ghost's direct conversation, not a
 * conversation kind: what is said lands in that conversation as ordinary messages, and the Ghost thinks and uses
 * tools there. The engine only listens and speaks. One call at a time per Host.
 */

/** Defaults until the owner changes them in settings. */
export const DEFAULT_VOICE: VoiceSettings = { engine: "realtime", voice: "default" };

/** An app call ends by itself after this long. */
export const CALL_MAX_SECONDS = 15 * 60;
/** A call that never becomes active within this long failed to connect. */
export const CALL_CONNECT_SECONDS = 30;

export const CallStatus = Type.Union([Type.Literal("connecting"), Type.Literal("active"), Type.Literal("ended"), Type.Literal("failed")]);
export type CallStatus = Static<typeof CallStatus>;

/**
 * hangup: the owner ended it. limit: the time limit. interrupted: the Host stopped while it ran.
 * error: the engine failed. unavailable: the engine could not connect.
 */
export const CallEndReason = Type.Union([
  Type.Literal("hangup"),
  Type.Literal("limit"),
  Type.Literal("interrupted"),
  Type.Literal("error"),
  Type.Literal("unavailable"),
]);
export type CallEndReason = Static<typeof CallEndReason>;

export const Call = Type.Object({
  id: Id,
  ghostId: Id,
  /** The Ghost's direct conversation the call speaks into. */
  conversationId: Id,
  engine: CallEngine,
  status: CallStatus,
  startedAt: Timestamp,
  /** When the engine connected and speech could flow. */
  answeredAt: nullable(Timestamp),
  endedAt: nullable(Timestamp),
  /** Billable speech seconds: what the engine reported, else answered-to-ended wall time. Null until it ends. */
  seconds: nullable(Type.Integer({ minimum: 0 })),
  endReason: nullable(CallEndReason),
  /** Why a failed call failed, in words the owner can act on. */
  error: nullable(Type.String({ maxLength: 512 })),
});
export type Call = Static<typeof Call>;

/** `POST /api/calls/:id/offer` (realtime engine): the browser's SDP offer for the call's media session. */
export const CallOffer = Type.Object({ sdp: Type.String({ minLength: 1, maxLength: 100_000 }) });
export type CallOffer = Static<typeof CallOffer>;

/** The reply to an offer: the engine's SDP answer. */
export const CallAnswer = Type.Object({ sdp: Type.String({ minLength: 1, maxLength: 100_000 }) });
export type CallAnswer = Static<typeof CallAnswer>;

/** `POST /api/calls/:id/transcribe` (local engine): the body is one utterance as mono PCM16 WAV (`audio/wav`); the reply is its text. */
export const CallTranscript = Type.Object({ text: Type.String() });
export type CallTranscript = Static<typeof CallTranscript>;

/** `POST /api/calls/:id/speech` (local engine): one sentence to speak; the reply body is `audio/wav`, mono PCM16. */
export const CallSpeechRequest = Type.Object({ text: Type.String({ minLength: 1, maxLength: 500 }) });
export type CallSpeechRequest = Static<typeof CallSpeechRequest>;

/**
 * `POST /api/calls/preview`: hear a voice outside a call. The reply body is `audio/wav`, mono PCM16.
 * Voice names are lowercase identifiers (`default`, `f1`, `marin`); the engine refuses a name it does not know.
 */
export const CallVoicePreview = Type.Object({ engine: CallEngine, voice: Type.String({ pattern: "^[a-z0-9_-]{1,32}$" }) });
export type CallVoicePreview = Static<typeof CallVoicePreview>;
