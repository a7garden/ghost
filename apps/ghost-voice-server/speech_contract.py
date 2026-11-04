"""Shared speech wire contract; no server, transport, or inference imports."""

STT = "whisper-large-v3-turbo"
TTS = "qwen3-tts-0.6b-customvoice"
LANGUAGES = {"ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese", "ru": "Russian"}
VOICES = {"sohee", "ryan", "aiden", "vivian", "serena", "ono_anna", "uncle_fu", "eric", "dylan"}
MAX_BODY = 5 * 1024 * 1024
MAX_SPEECH_SECONDS = 60
MAX_TTS_CHUNK_BYTES = 256 * 1024
PLAYBACK_RATE = 24_000


class SpeechError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
