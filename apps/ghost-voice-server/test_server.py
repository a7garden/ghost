import io
import threading
import time
import unittest
from unittest.mock import patch
import wave

import os
import tempfile
from fastapi.testclient import TestClient
from korean_text import normalize
from local_speech import LocalSpeech
from server import create_app, decode_wav
from speech_contract import SpeechError, STT, TTS


def wav(seconds=0.05, rate=16000, channels=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\0\0" * int(rate * seconds) * channels)
    return output.getvalue()


class FakeSpeech:
    ready = {"stt": False, "tts": False}

    def refresh_health(self):
        return True

    def close(self):
        pass

    def transcribe(self, data, language, cancel):
        return {"text": "test-transcript"}

    def iter_synthesize(self, text, voice, language, cancel):
        self.voice = voice
        self.language = language
        yield b"\0\0" * 1200, 24000


class SpeechBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.speech = FakeSpeech()
        self.client = TestClient(create_app(self.speech), base_url="http://127.0.0.1:62076")
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def test_loopback_host_and_origin_enforced(self):
        self.assertEqual(self.client.get("/v1/models", headers={"Host": "evil.example"}).status_code, 403)
        self.assertEqual(self.client.get("/v1/models", headers={"Origin": "http://127.0.0.1:62073"}).status_code, 403)
        response = self.client.get("/v1/models")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"][0]["roles"], ["stt"])
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_multipart_wav_roundtrip(self):
        response = self.client.post("/v1/audio/transcriptions", data={"model": STT, "language": "ko"}, files={"file": ("input.wav", wav(), "audio/wav")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"text": "test-transcript"})

    def test_wrong_model_and_malformed_audio(self):
        response = self.client.post("/v1/audio/transcriptions", data={"model": "no-model"}, files={"file": ("input.wav", wav())})
        self.assertEqual(response.status_code, 404)
        response = self.client.post("/v1/audio/transcriptions", data={"model": STT}, files={"file": ("input.wav", b"private raw audio content")})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("private", response.text)

    def test_default_voice_is_f1(self):
        for text in ["안녕하세요", "Hello"]:
            response = self.client.post("/v1/audio/speech", json={"model": TTS, "input": text, "voice": "default", "response_format": "wav"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "audio/wav")
            self.assertEqual(self.speech.voice, "F1")
            decode_wav(response.content)

    def test_output_request_limits(self):
        for body in [{"model": TTS, "input": "x" * 501}, {"model": TTS, "input": "hello", "voice": "missing"}, {"model": TTS, "input": "hello", "response_format": "mp3"}]:
            self.assertEqual(self.client.post("/v1/audio/speech", json=body).status_code, 400)
        self.assertEqual(self.client.post("/v1/audio/speech", content=b"x" * (5 * 1024 * 1024 + 1)).status_code, 413)

    def test_long_speech_is_not_cut_at_twenty_seconds(self):
        self.assertEqual(self.client.post("/v1/audio/transcriptions", data={"model": STT}, files={"file": ("input.wav", wav(seconds=90), "audio/wav")}).status_code, 200)

    def test_duration_and_channels(self):
        for content in [wav(seconds=120.001), wav(channels=2)]:
            with self.assertRaises(SpeechError):
                decode_wav(content)

    def test_large_valid_audio_never_spools_to_disk(self):
        # More than Starlette's usual 1 MiB upload spool threshold, but within
        # our bounded WAV contract; runtime must keep this audio in memory.
        with patch("tempfile.TemporaryFile", side_effect=AssertionError("raw audio spooled to disk")):
            response = self.client.post("/v1/audio/transcriptions", data={"model": STT}, files={"file": ("input.wav", wav(seconds=12, rate=48000), "audio/wav")})
        self.assertEqual(response.status_code, 200)

    def test_inference_queue_is_bounded(self):
        release = threading.Event()
        entered = threading.Event()
        responses = []
        original = self.speech.iter_synthesize

        def blocked(*args, **kwargs):
            entered.set()
            release.wait(2)
            return original(*args, **kwargs)

        self.speech.iter_synthesize = blocked

        def post():
            responses.append(self.client.post("/v1/audio/speech", json={"model": TTS, "input": "hello"}).status_code)

        workers = [threading.Thread(target=post) for _ in range(3)]
        try:
            for worker in workers:
                worker.start()
            self.assertTrue(entered.wait(1))
            for _ in range(100):
                if self.client.get("/health").json()["queued_or_running"] == 3:
                    break
                time.sleep(.005)
            else:
                self.fail("three accepted requests never entered queue")
            response = self.client.post("/v1/audio/speech", json={"model": TTS, "input": "hello"})
            self.assertEqual(response.status_code, 429)
        finally:
            release.set()
            for worker in workers:
                worker.join(2)
        self.assertEqual(responses, [200, 200, 200])


class KoreanTextTests(unittest.TestCase):
    def test_numbers_links_and_markdown_become_speakable(self):
        cases = {
            "총 12,500원이고 15%예요.": "총 만이천오백원이고 십오퍼센트예요.",
            "내일 오후 3시 30분에 만나요": "내일 오후 세시 삼십분에 만나요",
            "2026년 9월 20명 3개": "이천이십육년 구월 스무명 세개",
            "https://example.com 열게요 **네**": "링크 열게요 네",
        }
        for text, expected in cases.items():
            self.assertEqual(normalize(text), expected)


class AppleHelperProtocolTests(unittest.TestCase):
    def helper(self, body):
        path = os.path.join(self.tmp.name, "helper")
        with open(path, "w") as file:
            file.write("#!/usr/bin/env python3\nimport sys, json\n" + body)
        os.chmod(path, 0o755)
        return path

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_transcribe_sends_path_and_locale_and_returns_text(self):
        helper = self.helper("for line in sys.stdin:\n    r = json.loads(line)\n    print(json.dumps({'ok': True} if 'ping' in r else {'text': ' ' + r['locale'] + ' ' + str(open(r['path'],'rb').read(4)) + ' '}), flush=True)\n")
        speech = LocalSpeech(helper)
        self.addCleanup(speech.close)
        self.assertTrue(speech._ping())
        out = speech.transcribe(wav(), "ko", threading.Event())
        self.assertEqual(out["text"], "ko_KR b'RIFF'")

    def test_a_helper_that_dies_is_replaced_once_then_fails_bounded(self):
        speech = LocalSpeech(self.helper("sys.exit(1)\n"))
        self.addCleanup(speech.close)
        with self.assertRaises(SpeechError) as raised:
            speech.transcribe(wav(), "ko", threading.Event())
        self.assertEqual(raised.exception.status, 503)

    def test_a_missing_helper_is_a_bounded_error(self):
        speech = LocalSpeech(os.path.join(self.tmp.name, "nope"))
        self.addCleanup(speech.close)
        with self.assertRaises(SpeechError) as raised:
            speech.transcribe(wav(), "ko", threading.Event())
        self.assertEqual(raised.exception.code, "stt_helper_missing")



if __name__ == "__main__":
    unittest.main()
