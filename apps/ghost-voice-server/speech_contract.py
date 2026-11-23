"""Shared speech wire contract; no server, transport, or inference imports."""

STT = "apple-speechanalyzer"
TTS = "supertonic-3"
LANGUAGES = {"ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese", "ru": "Russian"}
VOICES = {"f1", "f2", "f3", "f4", "f5", "m1", "m2", "m3", "m4", "m5"}
MAX_BODY = 5 * 1024 * 1024
MAX_SPEECH_SECONDS = 60
MAX_TTS_CHUNK_BYTES = 256 * 1024
PLAYBACK_RATE = 24_000


class SpeechError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
