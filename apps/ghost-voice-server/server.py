"""Ghost remote speech adapter. No local model loads or audio persistence.

The local batch endpoint protocol is unchanged for its callers (the Rust host
posts OpenAI-style /v1/audio/* requests here), but the only speech backend is
the Dyno-owned MLX process (:7730) through RemoteSpeech — the same backend the
streaming media path uses. This process never loads model weights and never
falls back to local inference: an unavailable or ambiguous speech outcome is a
bounded error and the affected request fails without replay.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from email.parser import BytesParser
from email import policy

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from remote_speech import RemoteSpeech
from speech_contract import LANGUAGES, MAX_BODY, MAX_SPEECH_SECONDS, SpeechError, STT, TTS, VOICES




def decode_wav(data):
    if len(data) > MAX_BODY:
        raise SpeechError("audio_too_large", 413)
    try:
        with wave.open(io.BytesIO(data), "rb") as reader:
            rate = reader.getframerate()
            frames = reader.getnframes()
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getcomptype() != "NONE":
                raise SpeechError("audio_requires_mono_pcm16_wav")
            if not 8000 <= rate <= 48000 or frames <= 0 or frames / rate > 120:
                raise SpeechError("audio_duration_or_rate_invalid")
            pcm = reader.readframes(frames)
            if len(pcm) != frames * 2:
                raise SpeechError("audio_truncated")
    except (wave.Error, EOFError):
        raise SpeechError("audio_requires_mono_pcm16_wav") from None
    return pcm, rate


def synthesize_wav(speech, text, voice, language, cancelled):
    """Collect one bounded streaming synthesis into a whole WAV response."""
    chunks, rate, frames = [], None, 0
    for chunk, next_rate in speech.iter_synthesize(text, voice, language, cancelled):
        if rate is not None and rate != next_rate:
            raise SpeechError("audio_rate_changed", 503)
        rate = next_rate
        frames += len(chunk) // 2
        if frames > rate * MAX_SPEECH_SECONDS or frames * 2 + 44 > MAX_BODY:
            raise SpeechError("speech_output_too_long", 413)
        chunks.append(chunk)
    if not chunks or rate is None:
        raise SpeechError("speech_output_empty", 503)
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"".join(chunks))
    return output.getvalue()


def create_app(speech=None, port=62076, speech_url="http://127.0.0.1:7730"):
    speech = speech or RemoteSpeech(speech_url)
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ghost-speech")
    state = {"pending": 0, "completed": 0, "cancelled": 0, "failed": 0}

    @asynccontextmanager
    async def lifespan(app):
        yield
        executor.shutdown(wait=True, cancel_futures=True)
        speech.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    class LoopbackBoundary:
        # Pure ASGI retains the original disconnect receive stream. A
        # BaseHTTPMiddleware receive proxy can consume/disguise that event.
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return await self.app(scope, receive, send)
            request = Request(scope, receive)
            error = None
            if request.headers.get("host") not in {f"127.0.0.1:{port}", f"localhost:{port}"} or request.headers.get("origin"):
                error = JSONResponse({"error": {"code": "loopback_boundary"}}, status_code=403)
            length = request.headers.get("content-length")
            if not error and request.method == "POST" and (not length or not length.isdecimal() or int(length) > MAX_BODY):
                error = JSONResponse({"error": {"code": "body_size_invalid"}}, status_code=413)

            async def send_headers(message):
                if message["type"] == "http.response.start":
                    message["headers"] = list(message.get("headers", [])) + [(b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")]
                await send(message)

            if error:
                return await error(scope, receive, send_headers)
            await self.app(scope, receive, send_headers)

    app.add_middleware(LoopbackBoundary)

    @app.exception_handler(SpeechError)
    async def speech_error(request, error):
        return JSONResponse({"error": {"code": error.code}}, status_code=error.status)

    @app.get("/health")
    async def health():
        # `offline` means this adapter never leaves loopback; the model flags
        # describe the remote owner process's LOADED state (lazy first load).
        await asyncio.to_thread(speech.refresh_health)
        return {"service": "ghost-local-speech", "version": 1, "pid": os.getpid(), "offline": True, "model_loaded": speech.ready, "queued_or_running": state["pending"], "requests": {k: state[k] for k in ("completed", "cancelled", "failed")}}

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": STT, "object": "model", "owned_by": "local", "roles": ["stt"]}, {"id": TTS, "object": "model", "owned_by": "local", "roles": ["tts"], "default_voice": "Sohee", "voices": sorted(VOICES), "languages": list(LANGUAGES.values())}]}

    async def infer(request, operation):
        if state["pending"] >= 3:
            raise SpeechError("speech_queue_full", 429)
        state["pending"] += 1
        cancelled = threading.Event()

        def run():
            if cancelled.is_set():
                raise SpeechError("cancelled", 499)
            # The backend never logs request text or audio; only our bounded
            # status metadata appears in HTTP responses.
            with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                return operation(cancelled)

        async def watch():
            while not cancelled.is_set():
                message = await request.receive()
                if message["type"] == "http.disconnect":
                    cancelled.set()
                    return

        watcher = asyncio.create_task(watch())
        future = asyncio.get_running_loop().run_in_executor(executor, run)
        # pending includes cancelled computations until they leave the single
        # executor, so disconnects cannot produce an unbounded work queue.
        def completed(result):
            state["pending"] -= 1
            error = result.exception()  # consume late failures after disconnect
            key = "cancelled" if cancelled.is_set() else "failed" if error else "completed"
            state[key] += 1
        future.add_done_callback(completed)
        try:
            return await asyncio.wait_for(asyncio.shield(future), 120)
        except asyncio.TimeoutError:
            cancelled.set()
            raise SpeechError("speech_timeout", 504) from None
        except SpeechError:
            raise
        except Exception:
            raise SpeechError("speech_inference_failed", 503) from None
        finally:
            cancelled.set()
            watcher.cancel()

    async def bounded_body(request):
        parts, size = [], 0
        async for part in request.stream():
            size += len(part)
            if size > MAX_BODY:
                raise SpeechError("body_size_invalid", 413)
            parts.append(part)
        return b"".join(parts)

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(request: Request):
        content_type = request.headers.get("content-type", "")
        if not content_type.startswith("multipart/form-data;") or len(content_type) > 512 or "\n" in content_type or "\r" in content_type:
            raise SpeechError("multipart_required")
        body = await bounded_body(request)
        try:
            message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
        except (UnicodeError, ValueError):
            raise SpeechError("multipart_invalid") from None
        if not message.is_multipart() or message.defects:
            raise SpeechError("multipart_invalid")
        form = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if part.is_multipart() or part.defects or name not in {"file", "model", "language", "response_format"} or name in form:
                raise SpeechError("multipart_invalid")
            if len(form) >= 4:
                raise SpeechError("multipart_invalid")
            data = part.get_payload(decode=True)
            if name == "file":
                form[name] = data
            else:
                if len(data) > 100:
                    raise SpeechError("multipart_invalid")
                try:
                    form[name] = data.decode("utf-8")
                except UnicodeDecodeError:
                    raise SpeechError("multipart_invalid") from None
        if form.get("model") != STT:
            raise SpeechError("stt_model_not_found", 404)
        language = form.get("language", "")
        if language and language not in LANGUAGES:
            raise SpeechError("language_not_supported")
        data = form.get("file")
        if not isinstance(data, bytes):
            raise SpeechError("audio_file_required")
        decode_wav(data)
        result = await infer(request, lambda cancel: speech.transcribe(data, language, cancel))
        return JSONResponse(result)

    @app.post("/v1/audio/speech")
    async def audio_speech(request: Request):
        try:
            value = json.loads(await bounded_body(request))
        except Exception:
            raise SpeechError("invalid_json") from None
        if not isinstance(value, dict) or value.get("model") != TTS:
            raise SpeechError("tts_model_not_found", 404)
        text = value.get("input")
        if not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise SpeechError("speech_text_size_invalid")
        if value.get("response_format", "wav") != "wav":
            raise SpeechError("speech_format_requires_wav")
        voice = value.get("voice", "default")
        if voice == "default":
            voice = "Sohee" if any("\uac00" <= c <= "\ud7a3" for c in text) else "Ryan"
        if not isinstance(voice, str) or voice.lower() not in VOICES:
            raise SpeechError("voice_not_supported")
        language = value.get("language") or ("Korean" if any("\uac00" <= c <= "\ud7a3" for c in text) else "English")
        language = LANGUAGES.get(language, language)
        if language not in LANGUAGES.values():
            raise SpeechError("language_not_supported")
        audio = await infer(request, lambda cancel: synthesize_wav(speech, text, voice, language, cancel))
        return Response(audio, media_type="audio/wav")

    return app


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=62076)
    parser.add_argument("--speech-url", default="http://127.0.0.1:7730")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    import uvicorn
    uvicorn.run(create_app(port=args.port, speech_url=args.speech_url), host="127.0.0.1", port=args.port, access_log=False, log_level="warning", timeout_graceful_shutdown=10)
