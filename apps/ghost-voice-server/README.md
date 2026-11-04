# Ghost local speech server

Local-only STT and TTS adapter for Ghost. The wire protocol is unchanged, but
the only speech backend is the Dyno-owned MLX process at `http://127.0.0.1:7730`
through `remote_speech.RemoteSpeech` — the same backend the streaming media
path uses. This process never loads model weights and never falls back to local
inference: an unavailable or ambiguous speech outcome is a bounded error. No
real microphone or speaker is accessed by this server; Ghost owns capture,
playback, conversations, tasks, and authorization.

`whisper-large-v3-turbo` and `qwen3-tts-0.6b-customvoice` are protocol
identifiers kept for callers (the Rust host voice roles); they are not local
model loads.

## Installation and lifecycle

From this directory, create the isolated runtime using an existing Python 3.12:

```sh
uv venv --python /Users/garden/.local/share/uv/python/cpython-3.12.14-macos-aarch64-none/bin/python3 .venv
uv pip sync --python .venv/bin/python --offline requirements.lock
.venv/bin/python server.py --port 62076
```

Offline installation requires every pinned wheel in the existing uv cache.
`--offline` fails instead of fetching missing dependencies.
The adapter environment contains no MLX/Torch/Hugging Face inference stack;
`sync` removes obsolete adapter packages without touching Dyno's environment,
model weights or caches.
The adapter talks only to loopback: `--speech-url` (default `http://127.0.0.1:7730`) is validated
as loopback HTTP and the client never trusts proxy environment variables or
follows redirects. Run in the foreground, or have an owning Ghost native
supervisor launch that exact command. Stop only the process launched by that
owner with SIGTERM/Ctrl-C; never search-and-kill other Python or model
processes. The server is not a launchd service and does not change permanent
device permissions.

## API contract

Base URL: `http://127.0.0.1:62076/v1`.

- `GET /models`: `whisper-large-v3-turbo` with role `stt`, and
  `qwen3-tts-0.6b-customvoice` with role `tts`.
- `POST /audio/transcriptions`: multipart `model`, `file` (mono PCM16 WAV,
  8–48 kHz, at most 120 seconds), optional `language` (`ko`, `en`, etc.). Returns
  JSON `{ "text": "..." }`.
- `POST /audio/speech`: JSON `model`, `input` (1–500 characters), optional
  `voice`, `language`, and `response_format: "wav"`. Returns `audio/wav`, mono
  PCM16 at 24 kHz, at most 60 seconds. Streaming synthesis is collected under
  byte/duration/deadline bounds before one bounded WAV response.
- `GET /health` outside `/v1`: service/version/PID, backend LOADED flags (the
  remote owner process's lazy-load state), queue depth, and request outcome
  counts; no audio or transcript content.

`voice: "default"` chooses Sohee/Korean for Hangul text and Ryan/English
otherwise. Explicit supported speaker and language are available in `/models`.
Other languages should pass the explicit language and appropriate speaker.

The server binds only `127.0.0.1`, validates the exact loopback Host/port, rejects
all requests carrying Origin, and enables no CORS. Ghost's authenticated bridge
is the UI entry point. This local service creates no persistent credential and
should not be exposed on a public interface.

One executor performs backend calls serially, with at most three accepted
requests running/queued. Disconnect/timeout cancels queued work; the affected
request's result is discarded, and an in-flight backend HTTP call cannot be
interrupted mid-flight — the single executor waits for it before the next
request. Barge-in playback interruption is Ghost's responsibility and must
happen immediately at the device.

Audio and multipart parsing stay in memory. No scratch directories exist.
Access logs are disabled, library output is suppressed, and errors return
bounded codes without echoing input text/audio. Synthetic verification audio
may be saved by the test client as explicit evidence; this is not runtime
audio persistence.

## Verification

```sh
.venv/bin/python -m unittest -v test_server.py
```

Boundary tests inject fake speech backends and do not prove model inference.
Real synthetic speech proof against the Dyno-owned backend is a separate,
explicitly owned gate (`verify_runtime.py`); a successful STT/TTS request does
not prove Ghost conversation/task, physical microphone, or speaker E2E.

## Streaming conversation media

`serve_streaming.py` is a separate owned loopback entry, not an upgrade of the
batch WAV endpoints. It requires `--port`, `--host-origin`, `--ghost-id`,
`--conversation-id`, `--authority-epoch`, and `--actor-ref`, plus task-scoped
`GHOST_VOICE_HOST_TOKEN` and `GHOST_VOICE_CONTROL_TOKEN` in its environment.
Tokens are not command-line arguments or persisted by this service.

The entry validates the registered `local_only` conversation and current writer
epoch before serving. Every HTTP operation requires the exact loopback Host,
`Authorization: Bearer <control token>` and `X-Ghost-CSRF: <control token>`.
Origin must be absent or this exact loopback origin; CORS is not enabled.

- `POST /offer`: exactly `{sdp, type: "offer", start_id}`; `start_id` is one
  canonical lowercase UUID per call attempt. A retried or reconciling offer with
  a known start never creates a second session: live replays the original
  answer, ended replays `{"state":"ended","pc_id":...}`, and a duplicate
  in-flight creation is `409 voice_offer_in_progress`. Returns
  `{sdp, type, pc_id}` on first admission.
- `GET /starts/{start_id}`: start observation for reconciliation;
  `200 {"state":"live"|"ended","pc_id":...}` for the owning installation,
  `404 voice_start_unknown` (trustworthy absence: evidence is persisted before
  any offer effect), `409 voice_offer_in_progress` while unresolved, `403
  voice_start_foreign` for another installation. Historical live records answer
  `ended` only after the recorded owner's actual process death is established;
  a live, reused or uninspectable PID remains fenced. Lock release alone never
  proves death, and an accepted owner turn is never re-run.
- `PATCH /sessions/{pc_id}/ice`: `{candidates: [...]}`; each candidate has
  `candidate`, `sdp_mid`, and `sdp_mline_index`.
- `POST /sessions/{pc_id}/cancel_turn`: `{turn_id}` targeting the original
  acknowledged Owner command, never the newest turn or background Work.
- `POST /sessions/{pc_id}/hangup`: empty body; ends media only. Repeated
  hangup of the same historically owned terminal session is idempotent
  (`200 {"state":"ended","already_ended":true}`) via owner-bound ended
  tombstones; a foreign installation or unknown id stays `403/404`.
- `GET /health`: authenticated transport/model-readiness metadata.

The gateway stamps every media request with the authenticated device
installation (`X-Ghost-Media-Device`); sessions, controls, and observations are
fenced to that identity for their whole lifetime, so controls from any other
principal are refused even when they arrive through the same control token.
Effect-time authority: immediately before every Host transcript submission and
playback start — and again after the submit await — the session re-checks the
installation against the gateway revocation source over authenticated loopback
(`POST /internal/v1/voice/authority`, control token; wired via the required
`--gateway-listen` and `--gateway-origin`). The ask binds to the session's own
admission `start_id`: only that exact, non-ended record under the device's
current authority generation authorizes it, so an old call can never borrow a
newer call's authorization on the same device. The whole exchange runs under
one absolute 3-second deadline with a 256-byte streamed read. A definitely
revoked installation never dispatches and the call tears down; an unverifiable
answer keeps the turn `effect_unknown` instead of dispatching blind. The
periodic sweep is cleanup, not the authorization boundary.

Start evidence is a fail-closed, single-owner journal (`--state-path`,
required) written before any offer effect and after every state change: strict
schema (corruption or an unknown version refuses operation instead of proving
absence), a process-lifetime exclusive flock (a second owner is rejected),
recorded pid/birth, and an explicit dead-process check before historical live
records become `ended`. A released lock with a live, reused or uninspectable
PID refuses admission. The regular owner-private single-link lock inode stays
open and is revalidated; records use atomic rename plus file/parent fsync,
no symlinks and 0600. A journal that changes or
vanishes after ownership poisons the evidence: new offers and observations
refuse with 503 `media_evidence_unavailable` rather than overwrite uncertain
history. Offer creation is hard-cancelled after 10 seconds, but cancellation
alone never deletes evidence: cleanup is verified first (a learned peer stays
bound and retained for real verified hangup), and unresolved records close
only on the media service's own evidence or deliberate operator resolution
(`node devices.mjs media-resolve <devices.json> <start_id> confirm`). The
gateway never ages an unresolved fence into a definite absence, and no new
call is admitted while an old fence remains unclosed.

Treat `pc_id` as an opaque string and percent-encode it as one URL path segment.
SmallWebRTC identifiers can contain `#`; an unencoded fragment never reaches
the server.

Pipecat 1.12 SmallWebRTC carries mono PCM audio. Local energy VAD produces a
bounded final segment for backend STT; it is not streaming recognition.
That text enters the same Host Owner conversation once. Only its matching
committed assistant advisory is synthesized through real backend PCM chunks.
There is no second LLM, speech cloud, STUN/TURN default, or transcript recorder.
An Owner turn can become `answered` before its advisory projection is committed.
The same bounded readonly inspection loop waits for that matching advisory;
it does not resubmit the input or synthesize an uncommitted answer.

Barge-in fences the playback epoch, clears queued output, and binds cancellation
to the original turn even before its submit ACK. Hangup does not cancel durable
Owner responsibility or Work. Closed calls still consume the two-call quota
until owned inference/RPC tasks drain. Service shutdown awaits that drain before
closing the Host bridge. A 180-second unknown
drain preserves ownership/resources and fails teardown; it is not clean shutdown.

Run `python -m unittest -v test_server test_streaming` in the pinned isolated
runtime. On 2026-10-11 all 39 behavior tests passed after the clean dependency
cutover and lazy media-journal binding fix. A real factory/lifespan smoke used
an actual registered Host Ghost/conversation and the shared backend; startup,
health and fail-closed control authentication passed. Ownership lookup rejects
another device's durable start record with 403, not a false “unknown” response.
A real Ghost adapter → shared Dyno smoke generated 24 kHz mono PCM16
Korean (5.28 s) and English (6.8 s), transcribed both correctly, drained a
disconnected synthesis for 18.422 s and then transcribed again. Evidence:
`../../.lifetime-canary/voice20261011-deployed-speech/real-inference.json`.
This proves loopback model inference and executor drainage, not actual RTP,
iPhone microphone/playback, Bluetooth/background/cellular operation, external
push delivery or mini acceptance; those remain separate integration gates.
