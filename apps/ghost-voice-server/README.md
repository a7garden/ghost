# Ghost local speech server

On-device STT and TTS for Ghost's local voice-call engine. The Host (`apps/ghost-host/src/integrations/calls-local.ts`, `voice.speechUrl` in the Host config, default `http://127.0.0.1:62076`) posts each utterance and each spoken sentence here. Nothing leaves this Mac; no audio or text is persisted or logged.

| Role | Engine | Notes |
| --- | --- | --- |
| STT | Apple SpeechAnalyzer through `bin/apple-stt` (Swift, macOS 26+) | OS-managed model, no weights of ours; Korean CER 3.3% on FLEURS, about 0.13 s per 12 s utterance |
| TTS | Supertonic 3 (99M, ONNX Runtime) | 31 languages, 44.1 kHz, voices F1–F5 / M1–M5; `korean_text.py` turns digits, units and links into speakable words first |

`apple-speechanalyzer` and `supertonic-3` are the wire model identifiers (`speech_contract.py`).

## Install and run

```sh
swift/build.sh                                   # builds bin/apple-stt (needs the Swift toolchain)
uv venv --python 3.12 .venv
uv pip sync --python .venv/bin/python requirements.lock
.venv/bin/python server.py --port 62076          # first start downloads the Supertonic weights (~380 MB) to ~/.cache/supertonic3
```

The Speech framework downloads the Korean on-device language asset on first use. Ghost runs this as the LaunchAgent `com.a7.ghost-voice` (`launchd/com.a7.ghost-voice.plist`).

## API contract

Base URL `http://127.0.0.1:62076/v1`; the server binds only `127.0.0.1`, checks the exact Host header, rejects any request carrying `Origin`, and enables no CORS.

- `GET /models`: `apple-speechanalyzer` (`stt`) and `supertonic-3` (`tts`, default voice `F1`).
- `POST /audio/transcriptions`: multipart `model`, `file` (mono PCM16 WAV, 8–48 kHz, at most 120 s), optional `language` (`ko`, `en`, …). Returns `{ "text": "..." }`.
- `POST /audio/speech`: JSON `model`, `input` (1–500 characters), optional `voice` (`default` or `f1`…`m5`), `language`, `response_format: "wav"`. Returns `audio/wav`, mono PCM16 (44.1 kHz).
- `GET /health` (outside `/v1`): service, PID, `model_loaded` (`stt`: the helper answers; `tts`: Supertonic loaded), queue depth and outcome counts.

One executor runs requests serially with at most three accepted; a disconnect cancels queued work. Failures are bounded error codes, never an echo of text or audio.

## Verification

```sh
.venv/bin/python -m unittest -v test_server
```

Tests inject a fake speech backend and a fake helper process; they do not prove inference. Real proof: speak a sentence through `/v1/audio/speech`, send the WAV back through `/v1/audio/transcriptions`, and compare.
