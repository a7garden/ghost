"""On-device speech backend: Apple SpeechAnalyzer for STT, Supertonic 3 (ONNX) for TTS.

Same interface the HTTP adapter used for the old remote backend: `ready`, `refresh_health`,
`transcribe`, `iter_synthesize`, `close`. Nothing leaves the machine and no text or audio is logged.
"""
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np

from korean_text import normalize
from speech_contract import LANGUAGES, SpeechError

HELPER = Path(os.environ.get("GHOST_APPLE_STT", Path(__file__).parent / "bin" / "apple-stt"))
LOCALES = {"ko": "ko_KR", "en": "en_US", "ja": "ja_JP", "zh": "zh_CN", "de": "de_DE", "fr": "fr_FR", "es": "es_ES", "it": "it_IT", "pt": "pt_BR", "ru": "ru_RU"}
STT_TIMEOUT = 30
TTS_STEPS = 5
VOICE_STYLES = {"F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"}


class LocalSpeech:
    def __init__(self, helper=HELPER):
        self.helper = Path(helper)
        self.ready = {"stt": False, "tts": False}
        self._proc = None
        self._stt_lock = threading.Lock()
        self._tts = None
        self._styles = {}
        self._tts_lock = threading.Lock()
        self._scratch = tempfile.TemporaryDirectory(prefix="ghost-stt-")

    # -- health --------------------------------------------------------------------------------

    def refresh_health(self) -> bool:
        self.ready["stt"] = self._ping()
        self.ready["tts"] = self._load_tts(quiet=True)
        return all(self.ready.values())

    def _ping(self) -> bool:
        with self._stt_lock:
            try:
                return self._ask({"ping": True}).get("ok") is True
            except SpeechError:
                return False

    def _load_tts(self, quiet=False) -> bool:
        with self._tts_lock:
            if self._tts is None:
                try:
                    from supertonic import TTS

                    self._tts = TTS(model="supertonic-3")
                except Exception:
                    if quiet:
                        return False
                    raise SpeechError("speech_inference_failed", 503) from None
            return True

    # -- STT -----------------------------------------------------------------------------------

    def _spawn(self):
        if not self.helper.is_file():
            raise SpeechError("stt_helper_missing", 503)
        return subprocess.Popen([str(self.helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)

    def _ask(self, request: dict) -> dict:
        """One request/response line. The caller holds `_stt_lock`; a dead or silent helper is replaced."""
        for attempt in (0, 1):
            if self._proc is None or self._proc.poll() is not None:
                self._proc = self._spawn()
            proc = self._proc
            timer = threading.Timer(STT_TIMEOUT, proc.kill)
            timer.start()
            try:
                proc.stdin.write(json.dumps(request) + "\n")
                proc.stdin.flush()
                line = proc.stdout.readline()
            except (BrokenPipeError, OSError):
                line = ""
            finally:
                timer.cancel()
            if line:
                try:
                    return json.loads(line)
                except ValueError:
                    pass
            proc.kill()
            self._proc = None
            if attempt:
                break
        raise SpeechError("speech_inference_failed", 503)

    def transcribe(self, data: bytes, language: str, cancelled) -> dict:
        locale = LOCALES.get(language or "ko", "ko_KR")
        path = os.path.join(self._scratch.name, f"{threading.get_ident()}.wav")
        with open(path, "wb") as file:
            file.write(data)
        try:
            with self._stt_lock:
                if cancelled.is_set():
                    raise SpeechError("cancelled", 499)
                reply = self._ask({"path": path, "locale": locale})
        finally:
            os.unlink(path)
        if "text" not in reply:
            raise SpeechError("speech_inference_failed", 503)
        self.ready["stt"] = True
        return {"text": reply["text"].strip()}

    # -- TTS -----------------------------------------------------------------------------------

    def iter_synthesize(self, text, voice, language, cancelled):
        self._load_tts()
        code = next((k for k, v in LANGUAGES.items() if v == language), "ko")
        name = voice.upper()
        if name not in VOICE_STYLES:
            raise SpeechError("voice_not_supported")
        spoken = normalize(text)
        if not spoken:
            raise SpeechError("speech_text_size_invalid")
        with self._tts_lock:
            if cancelled.is_set():
                raise SpeechError("cancelled", 499)
            style = self._styles.get(name) or self._styles.setdefault(name, self._tts.get_voice_style(name))
            wav, _ = self._tts.synthesize(spoken, voice_style=style, lang=code, total_steps=TTS_STEPS)
            rate = self._tts.sample_rate
        self.ready["tts"] = True
        samples = np.clip(np.asarray(wav, dtype=np.float32).reshape(-1), -1.0, 1.0)
        if samples.size == 0:
            raise SpeechError("speech_output_empty", 503)
        yield (samples * 32767).astype("<i2").tobytes(), rate

    def close(self):
        proc, self._proc = self._proc, None
        if proc and proc.poll() is None:
            proc.kill()
        self._scratch.cleanup()
