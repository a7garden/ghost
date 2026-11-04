"""Remote-only speech backend for the streaming and batch speech paths.

The single Dyno-owned MLX process (:7730) owns the Whisper/Qwen TTS weights.
This process never loads model weights and never falls back to local
inference: an unavailable or ambiguous speech outcome is a bounded 503 and
the affected segment/turn fails without any automatic replay.

Every HTTP exchange is a bounded streaming read: byte accounting and total
deadlines run before allocation grows, an overflowing or stalling response is
closed immediately, and only the bounded collected body is decoded. The
client never trusts proxy environment variables and never follows redirects.
Health validation checks `ok` plus the boolean model flag shape. Those flags
are the owner process's LOADED state (lazy first load), never the `service`
display name, so false is normal before the first speech request.
"""

from __future__ import annotations

import json
import time
from urllib.parse import urlsplit

import httpx

from speech_contract import LANGUAGES, MAX_SPEECH_SECONDS, MAX_TTS_CHUNK_BYTES, PLAYBACK_RATE, SpeechError, VOICES

MAX_STT_REQUEST_BYTES = 4 * 1024 * 1024
MAX_STT_TEXT_BYTES = 65_536
MAX_TTS_REPLY_BYTES = 8 * 1024 * 1024
MAX_HEALTH_BYTES = 4096
STT_TOTAL_SECONDS = 120.0
TTS_TOTAL_SECONDS = 90.0
HEALTH_TOTAL_SECONDS = 10.0
STREAM_CHUNK_BYTES = 64 * 1024
STT_TIMEOUT = httpx.Timeout(connect=2.0, read=90.0, write=10.0, pool=2.0)
TTS_TIMEOUT = httpx.Timeout(connect=2.0, read=45.0, write=5.0, pool=2.0)
HEALTH_TIMEOUT = httpx.Timeout(connect=2.0, read=5.0, write=2.0, pool=2.0)


def loopback_speech_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
        or parsed.username
        or parsed.password
        or (parsed.path not in ("", "/"))
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("speech_url_must_be_loopback_http")
    return f"http://{parsed.netloc}"


class _StreamingWav:
    """Incremental RIFF reader for bounded PCM16 mono WAV responses.

    Bytes are decoded as they arrive; the fmt chunk must promise mono PCM16,
    and the data chunk must deliver exactly the PCM it declared. No full
    response is ever materialized before validation.
    """

    def __init__(self):
        self.rate: int | None = None
        self.pcm = bytearray()
        self._buffer = bytearray()
        self._data_declared: int | None = None
        self._data_seen = 0

    def feed(self, chunk: bytes) -> None:
        if self._data_declared is not None:
            self._accept_pcm(chunk)
            return
        self._buffer.extend(chunk)
        if len(self._buffer) > MAX_TTS_REPLY_BYTES:
            raise SpeechError("media_speech_unavailable", 503)
        while True:
            if self.rate is None:
                if len(self._buffer) < 44:
                    return
                if (
                    bytes(self._buffer[0:4]) != b"RIFF"
                    or bytes(self._buffer[8:12]) != b"WAVE"
                    or bytes(self._buffer[12:16]) != b"fmt "
                ):
                    raise SpeechError("media_speech_unavailable", 503)
                fmt_size = int.from_bytes(self._buffer[16:20], "little")
                if fmt_size < 16:
                    raise SpeechError("media_speech_unavailable", 503)
                if len(self._buffer) < 20 + fmt_size:
                    return
                audio_format = int.from_bytes(self._buffer[20:22], "little")
                channels = int.from_bytes(self._buffer[22:24], "little")
                rate = int.from_bytes(self._buffer[24:28], "little")
                bits = int.from_bytes(self._buffer[34:36], "little")
                if audio_format != 1 or channels != 1 or bits != 16:
                    raise SpeechError("media_speech_unavailable", 503)
                if not 8000 <= rate <= 48000:
                    raise SpeechError("media_speech_unavailable", 503)
                self.rate = rate
                del self._buffer[: 20 + fmt_size]
                continue
            if len(self._buffer) < 8:
                return
            if bytes(self._buffer[0:4]) != b"data":
                # Skip unknown chunks ( LIST , fact , ... ) without buffering them.
                declared = int.from_bytes(self._buffer[4:8], "little")
                if len(self._buffer) < 8 + declared:
                    return
                del self._buffer[: 8 + declared]
                continue
            self._data_declared = int.from_bytes(self._buffer[4:8], "little")
            del self._buffer[:8]
            break
        payload = bytes(self._buffer)
        self._buffer.clear()
        self._accept_pcm(payload)

    def finish(self) -> tuple[bytes, int]:
        if self.rate is None or self._data_declared is None:
            raise SpeechError("media_speech_unavailable", 503)
        if self._data_seen != self._data_declared:
            raise SpeechError("media_speech_unavailable", 503)
        return bytes(self.pcm), self.rate

    def _accept_pcm(self, part: bytes) -> None:
        if not part:
            return
        remaining = self._data_declared - self._data_seen
        if remaining <= 0 or len(part) > remaining:
            raise SpeechError("media_speech_unavailable", 503)
        self._data_seen += len(part)
        if len(self.pcm) + len(part) > MAX_TTS_REPLY_BYTES:
            raise SpeechError("media_speech_unavailable", 503)
        self.pcm.extend(part)


class RemoteSpeech:
    """Same executor-facing surface as the local engine, backed by :7730 HTTP."""

    def __init__(self, base_url: str):
        self.base = loopback_speech_url(base_url)
        self.ready = {"stt": False, "tts": False}
        self._client = httpx.Client(
            base_url=self.base,
            timeout=STT_TIMEOUT,
            trust_env=False,
            follow_redirects=False,
        )

    @staticmethod
    def loopback(value: str) -> str:
        return loopback_speech_url(value)

    def close(self):
        self._client.close()

    def _deadline(self, total_seconds: float) -> float:
        return time.monotonic() + total_seconds

    def _expired(self, deadline: float) -> bool:
        return time.monotonic() >= deadline

    def _bounded_body(self, method: str, path: str, *, timeout, total_seconds, max_bytes, request_kwargs) -> bytes:
        """Stream a response body under a hard byte bound and total deadline.

        The response is closed the moment either bound is exceeded; only the
        bounded collected body is ever decoded. Redirects are protocol errors
        and proxy environment variables are never consulted.
        """
        deadline = self._deadline(total_seconds)
        try:
            with self._client.stream(method, path, timeout=timeout, **request_kwargs) as response:
                if response.status_code != 200:
                    raise SpeechError("media_speech_unavailable", 503)
                parts: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes(chunk_size=STREAM_CHUNK_BYTES):
                    size += len(chunk)
                    if size > max_bytes or self._expired(deadline):
                        raise SpeechError("media_speech_unavailable", 503)
                    parts.append(chunk)
                return b"".join(parts)
        except SpeechError:
            raise
        except Exception:
            raise SpeechError("media_speech_unavailable", 503) from None

    def refresh_health(self) -> bool:
        """Startup gate: `ok` plus boolean model flags. The flags are the
        owner process's LOADED state and lazy-load on first /stt or /tts, so
        false is normal before the first speech request and must never block
        startup or force a second weights load here."""
        try:
            body = self._bounded_body(
                "GET", "/health", timeout=HEALTH_TIMEOUT,
                total_seconds=HEALTH_TOTAL_SECONDS, max_bytes=MAX_HEALTH_BYTES,
                request_kwargs={},
            )
        except Exception:
            self.ready = {"stt": False, "tts": False}
            return False
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            self.ready = {"stt": False, "tts": False}
            return False
        models = payload.get("models") if isinstance(payload, dict) else None
        shape_ok = (
            isinstance(payload, dict)
            and payload.get("ok") is True
            and isinstance(models, dict)
            and type(models.get("stt")) is bool
            and type(models.get("tts")) is bool
        )
        self.ready = {"stt": models.get("stt", False), "tts": models.get("tts", False)} if shape_ok else {"stt": False, "tts": False}
        return shape_ok

    # -- Executor surface -------------------------------------------------

    def transcribe(self, data: bytes, language: str, cancelled) -> dict:
        if cancelled.is_set():
            raise SpeechError("cancelled", 499)
        if not isinstance(data, bytes) or not data or len(data) > MAX_STT_REQUEST_BYTES:
            raise SpeechError("speech_audio_size_invalid", 413)
        headers = {"Content-Type": "application/octet-stream"}
        if language:
            if language not in LANGUAGES:
                raise SpeechError("language_not_supported")
            headers["X-Dyno-Speech-Language"] = language
        body = self._bounded_body(
            "POST", "/stt", timeout=STT_TIMEOUT,
            total_seconds=STT_TOTAL_SECONDS, max_bytes=MAX_STT_TEXT_BYTES + 64,
            request_kwargs={"content": data, "headers": headers},
        )
        if cancelled.is_set():
            raise SpeechError("cancelled", 499)
        try:
            payload = json.loads(body.decode("utf-8"))
            text = payload["text"]
        except Exception:
            raise SpeechError("media_speech_unavailable", 503) from None
        if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_STT_TEXT_BYTES:
            raise SpeechError("media_speech_unavailable", 503)
        return {"text": text.strip()}

    def iter_synthesize(self, text, voice, language, cancelled):
        if not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise SpeechError("speech_text_size_invalid")
        if not isinstance(voice, str) or voice.lower() not in VOICES:
            raise SpeechError("voice_not_supported")
        language = LANGUAGES.get(language, language)
        if language not in LANGUAGES.values():
            raise SpeechError("language_not_supported")
        if cancelled.is_set():
            raise SpeechError("cancelled", 499)
        deadline = self._deadline(TTS_TOTAL_SECONDS)
        decoder = _StreamingWav()
        pending = bytearray()
        emitted_bytes = 0
        try:
            with self._client.stream(
                "POST", "/tts", timeout=TTS_TIMEOUT,
                json={"text": text, "speaker": voice, "language": language}, headers={"Content-Type": "application/json"},
            ) as response:
                if response.status_code != 200:
                    raise SpeechError("media_speech_unavailable", 503)
                for chunk in response.iter_bytes(chunk_size=STREAM_CHUNK_BYTES):
                    if cancelled.is_set():
                        raise SpeechError("cancelled", 499)
                    if self._expired(deadline):
                        raise SpeechError("media_speech_unavailable", 503)
                    decoder.feed(chunk)
                    pending.extend(decoder.pcm)
                    decoder.pcm.clear()
                    if decoder.rate is not None and decoder.rate != PLAYBACK_RATE:
                        raise SpeechError("media_speech_unavailable", 503)
                    if emitted_bytes + len(pending) > PLAYBACK_RATE * 2 * MAX_SPEECH_SECONDS:
                        raise SpeechError("speech_output_too_long", 413)
                    # MAX_TTS_CHUNK_BYTES is even, so every slice keeps PCM16
                    # byte parity; an odd trailing byte waits for the next feed.
                    while len(pending) >= MAX_TTS_CHUNK_BYTES:
                        piece = bytes(pending[:MAX_TTS_CHUNK_BYTES])
                        del pending[:MAX_TTS_CHUNK_BYTES]
                        emitted_bytes += len(piece)
                        yield piece, decoder.rate
        except SpeechError:
            raise
        except Exception:
            raise SpeechError("media_speech_unavailable", 503) from None
        if cancelled.is_set():
            raise SpeechError("cancelled", 499)
        decoder.finish()
        if decoder.rate != PLAYBACK_RATE or len(pending) % 2:
            raise SpeechError("media_speech_unavailable", 503)
        if pending:
            yield bytes(pending), decoder.rate
