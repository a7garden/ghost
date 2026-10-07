"""Ghost local speech adapter. Cached weights only; no audio persistence.

Whisper config adaptation follows the existing Knock voice worker; its
environment, files, processes, and audio devices are never modified.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import os
import shutil
import tempfile
import threading
import time
import wave
from email import policy
from email.parser import BytesParser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

STT = "whisper-large-v3-turbo"
TTS = "qwen3-tts-0.6b-customvoice"
REPOS = {
    STT: "mlx-community/whisper-large-v3-turbo-asr-fp16",
    TTS: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16",
}
LANGUAGES = {"ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese", "ru": "Russian"}
VOICES = {"sohee", "ryan", "aiden", "vivian", "serena", "ono_anna", "uncle_fu", "eric", "dylan"}
MAX_BODY = 5 * 1024 * 1024


class SpeechError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status


def snapshot(repo):
    root = Path(os.environ.get("HF_HUB_CACHE", str(Path.home() / ".cache/huggingface/hub"))) / ("models--" + repo.replace("/", "--"))
    revision = (root / "refs/main").read_text().strip()
    if not revision or not all(c in "0123456789abcdef" for c in revision):
        raise SpeechError("model_cache_invalid", 503)
    path = root / "snapshots" / revision
    for filename in ("config.json", "model.safetensors"):
        if not (path / filename).is_file():
            raise SpeechError("model_cache_incomplete", 503)
    return path


def whisper_config(source, target):
    raw = json.loads((source / "config.json").read_text())
    for child in source.iterdir():
        if child.name != "config.json":
            (target / child.name).symlink_to(child.resolve())
    (target / "weights.safetensors").symlink_to((source / "model.safetensors").resolve())
    fields = {"n_mels": "num_mel_bins", "n_audio_ctx": "max_source_positions", "n_audio_state": "d_model", "n_audio_head": "encoder_attention_heads", "n_audio_layer": "encoder_layers", "n_vocab": "vocab_size", "n_text_ctx": "max_target_positions", "n_text_state": "d_model", "n_text_head": "decoder_attention_heads", "n_text_layer": "decoder_layers"}
    (target / "config.json").write_text(json.dumps({key: raw[value] for key, value in fields.items()}))


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


class Engines:
    def __init__(self):
        self.asr_path = None
        self.tts_model = None
        self.scratch = None
        self.ready = {STT: False, TTS: False}

    def cleanup(self):
        if self.scratch:
            shutil.rmtree(self.scratch, ignore_errors=True)

    def transcribe(self, data, language, cancelled):
        import numpy as np
        import mlx_whisper
        pcm, rate = decode_wav(data)
        if self.asr_path is None:
            self.scratch = Path(tempfile.mkdtemp(prefix="ghost-whisper-config-"))
            whisper_config(snapshot(REPOS[STT]), self.scratch)
            self.asr_path = self.scratch
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        if rate != 16000:
            from scipy.signal import resample_poly
            from math import gcd
            divisor = gcd(rate, 16000)
            audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
        if cancelled.is_set():
            raise SpeechError("cancelled", 499)
        result = mlx_whisper.transcribe(audio, path_or_hf_repo=str(self.asr_path), language=language or None, condition_on_previous_text=False, verbose=False)
        self.ready[STT] = True
        if cancelled.is_set():
            raise SpeechError("cancelled", 499)
        return {"text": result["text"].strip()}

    def synthesize(self, text, voice, language, cancelled):
        import numpy as np
        from mlx_audio.tts.utils import load_model
        if self.tts_model is None:
            path = snapshot(REPOS[TTS])
            if not (path / "speech_tokenizer/model.safetensors").is_file():
                raise SpeechError("model_cache_incomplete", 503)
            self.tts_model = load_model(path)
        chunks, rate, frames = [], None, 0
        for item in self.tts_model.generate_custom_voice(text=text, speaker=voice, language=language, stream=True, streaming_interval=0.32, max_tokens=720):
            if cancelled.is_set():
                raise SpeechError("cancelled", 499)
            next_rate = int(item.sample_rate)
            if rate is not None and rate != next_rate:
                raise SpeechError("audio_rate_changed", 503)
            rate = next_rate
            audio = np.asarray(item.audio, dtype=np.float32).reshape(-1)
            if not np.isfinite(audio).all():
                raise SpeechError("audio_invalid", 503)
            frames += audio.size
            if frames > rate * 60 or frames * 2 + 44 > 6 * 1024 * 1024:
                raise SpeechError("speech_output_too_long", 413)
            chunks.append((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        if not frames or cancelled.is_set():
            raise SpeechError("cancelled" if cancelled.is_set() else "speech_output_empty", 499 if cancelled.is_set() else 503)
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(rate)
            writer.writeframes(b"".join(chunks))
        self.ready[TTS] = True
        return output.getvalue()


def create_app(engine=None, port=62076):
    engine = engine or Engines()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ghost-speech")
    state = {"pending": 0, "completed": 0, "cancelled": 0, "failed": 0}

    @contextlib.asynccontextmanager
    async def lifespan(app):
        yield
        executor.shutdown(wait=True, cancel_futures=True)
        engine.cleanup()

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
        return {"service": "ghost-local-speech", "version": 1, "pid": os.getpid(), "offline": True, "model_loaded": engine.ready, "queued_or_running": state["pending"], "requests": {k: state[k] for k in ("completed", "cancelled", "failed")}}

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
            # Model libraries must never log request text or audio; only our
            # bounded status metadata appears in HTTP responses.
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
        result = await infer(request, lambda cancel: engine.transcribe(data, language, cancel))
        return JSONResponse(result)

    @app.post("/v1/audio/speech")
    async def speech(request: Request):
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
        audio = await infer(request, lambda cancel: engine.synthesize(text, voice, language, cancel))
        return Response(audio, media_type="audio/wav")

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=62076)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    import uvicorn
    uvicorn.run(create_app(port=args.port), host="127.0.0.1", port=args.port, access_log=False, log_level="warning", timeout_graceful_shutdown=10)
