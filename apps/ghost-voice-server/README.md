# Ghost local speech server

Local-only STT and TTS adapter for Ghost's local voice-call engine. The Host
(`apps/ghost-host/src/integrations/calls-local.ts`, `speechUrl` in the Host
config, default `http://127.0.0.1:62076`) calls it for each utterance and each
spoken sentence. The only speech backend is the Dyno-owned MLX process at
`http://127.0.0.1:7730` through `remote_speech.RemoteSpeech`. This process never
loads model weights and never falls back to local inference: an unavailable or
ambiguous speech outcome is a bounded error. No real microphone or speaker is
accessed by this server; the Ghost UI owns capture and playback, and the Host
owns conversations, calls and authorization.

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
