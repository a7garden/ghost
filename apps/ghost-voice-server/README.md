# Ghost local speech server

Local-only STT and TTS adapter for Ghost. It uses the already cached Whisper
large-v3-turbo and Qwen3 TTS 0.6B CustomVoice weights. Model downloads are disabled
before library imports. No real microphone or speaker is accessed by this server;
Ghost owns capture, playback, conversations, tasks, and authorization.

The existing Knock voice worker provided the known-compatible Whisper config
mapping and Qwen streaming API reference. Knock source, virtual environment,
processes, credentials, and operating data remain unchanged. Ghost uses its own
virtual environment.

## Installation and lifecycle

From this directory, create the isolated runtime using an existing Python 3.12:

```sh
uv venv --python /Users/garden/.local/share/uv/python/cpython-3.12.14-macos-aarch64-none/bin/python3 .venv
uv pip install --python .venv/bin/python --offline -r requirements.lock
.venv/bin/python server.py --port 62076
```

This Mac has all required wheels in its existing uv cache. `--offline` fails
instead of silently fetching missing dependencies. `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` always apply during inference. Model caches must contain
the original model weights, configs, tokenizers, and Qwen speech-tokenizer
weights. A cache directory name alone is insufficient evidence of readiness.

Run in the foreground, or have an owning Ghost native supervisor launch that
exact command. Stop only the process launched by that owner with SIGTERM/Ctrl-C;
never search-and-kill other Python or model processes. The server is not a
launchd service and does not change permanent device permissions.

## API contract

Base URL: `http://127.0.0.1:62076/v1`.

- `GET /models`: `whisper-large-v3-turbo` with role `stt`, and
  `qwen3-tts-0.6b-customvoice` with role `tts`.
- `POST /audio/transcriptions`: multipart `model`, `file` (mono PCM16 WAV,
  8–48 kHz, at most 120 seconds), optional `language` (`ko`, `en`, etc.). Returns
  JSON `{ "text": "..." }`. Audio is resampled to 16 kHz in memory for Whisper.
- `POST /audio/speech`: JSON `model`, `input` (1–500 characters), optional
  `voice`, `language`, and `response_format: "wav"`. Returns `audio/wav`, mono
  PCM16 at 24 kHz, at most 60 seconds/6 MiB.
- `GET /health` outside `/v1`: service/version/PID, loaded-model flags, queue
  depth, and request outcome counts; no audio or transcript content.

`voice: "default"` chooses Sohee/Korean for Hangul text and Ryan/English
otherwise. Explicit supported speaker and language are available in `/models`.
Other languages should pass the explicit language and appropriate speaker.

The server binds only `127.0.0.1`, validates the exact loopback Host/port, rejects
all requests carrying Origin, and enables no CORS. Ghost's authenticated bridge
is the UI entry point. This local service creates no persistent credential and
should not be exposed on a public interface.

One executor performs inference serially, with at most three accepted requests
running/queued. Disconnect/timeout cancels queued work; running TTS stops between
chunks, and a running blocking Whisper call discards its result. Disconnect does
not instantly interrupt a GPU kernel. The next request waits until the previous
computation leaves the single executor. Barge-in playback interruption is
Ghost's responsibility and must happen immediately at the device.

Audio and multipart parsing stay in memory. The only temporary directory holds
Whisper config and symlinks to existing weights; shutdown removes it. Access logs
are disabled, library output is suppressed, and errors return bounded codes
without echoing input text/audio. Synthetic verification audio may be saved by
the test client as explicit evidence; this is not runtime audio persistence.

## Verification

```sh
.venv/bin/python -m unittest -v test_server.py
```

Boundary tests inject fake engines and do not prove model inference. Separate
synthetic Korean and English Qwen→Whisper inference was executed on this Mac;
evidence records the source revision, runtime versions, hashes, durations, and
the fact that no human microphone was tested. A successful STT/TTS request does
not prove Ghost conversation/task, physical microphone, or speaker E2E.
