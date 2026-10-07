import io
import threading
import time
import unittest
from unittest.mock import patch
import wave

from fastapi.testclient import TestClient
from server import STT, TTS, SpeechError, create_app, decode_wav


def wav(seconds=0.05, rate=16000, channels=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\0\0" * int(rate * seconds) * channels)
    return output.getvalue()


class FakeEngine:
    ready = {STT: False, TTS: False}

    def cleanup(self):
        pass

    def transcribe(self, data, language, cancel):
        return {"text": "test-transcript"}

    def synthesize(self, text, voice, language, cancel):
        self.voice = voice
        self.language = language
        return wav()


class SpeechBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.client = TestClient(create_app(self.engine), base_url="http://127.0.0.1:62076")
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

    def test_default_voice_korean_and_english(self):
        for text, expected in [("안녕하세요", "Sohee"), ("Hello", "Ryan")]:
            response = self.client.post("/v1/audio/speech", json={"model": TTS, "input": text, "voice": "default", "response_format": "wav"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "audio/wav")
            self.assertEqual(self.engine.voice, expected)
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
        original = self.engine.synthesize

        def blocked(*args):
            entered.set()
            release.wait(2)
            return original(*args)

        self.engine.synthesize = blocked

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


if __name__ == "__main__":
    unittest.main()
