import io
import threading
import time
import unittest
from unittest.mock import patch
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi.testclient import TestClient
import remote_speech
from remote_speech import RemoteSpeech
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

    def test_default_voice_korean_and_english(self):
        for text, expected in [("안녕하세요", "Sohee"), ("Hello", "Ryan")]:
            response = self.client.post("/v1/audio/speech", json={"model": TTS, "input": text, "voice": "default", "response_format": "wav"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "audio/wav")
            self.assertEqual(self.speech.voice, expected)
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


class StreamingWavTests(unittest.TestCase):
    def encoded(self, rate=24000, frames=4, channels=1):
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(channels)
            writer.setsampwidth(2)
            writer.setframerate(rate)
            writer.writeframes(b"\x01\x02" * frames * channels)
        return output.getvalue()

    def test_incremental_decode_across_chunk_boundaries(self):
        decoder = remote_speech._StreamingWav()
        payload = self.encoded()
        split = payload.index(b"data") + 5  # a split inside the chunk headers
        decoder.feed(payload[:split])
        decoder.feed(payload[split:])
        pcm, rate = decoder.finish()
        self.assertEqual(rate, 24000)
        self.assertEqual(pcm, b"\x01\x02" * 4)

    def test_truncated_or_headerless_responses_are_rejected(self):
        decoder = remote_speech._StreamingWav()
        decoder.feed(self.encoded(frames=100)[:30])
        with self.assertRaises(SpeechError):
            decoder.finish()
        short = remote_speech._StreamingWav()
        short.feed(b"RIFF")
        with self.assertRaises(SpeechError):
            short.finish()

    def test_wrong_format_is_rejected_before_pcm_is_trusted(self):
        decoder = remote_speech._StreamingWav()
        with self.assertRaises(SpeechError):
            decoder.feed(self.encoded(channels=2))
        float_header = bytearray(self.encoded())
        float_header[20:22] = (3).to_bytes(2, "little")  # WAVE_FORMAT_IEEE_FLOAT
        decoder = remote_speech._StreamingWav()
        with self.assertRaises(SpeechError):
            decoder.feed(bytes(float_header))

    def test_pcm_beyond_the_declared_data_chunk_is_rejected(self):
        decoder = remote_speech._StreamingWav()
        payload = self.encoded(frames=8)
        decoder.feed(payload)
        with self.assertRaises(SpeechError):
            decoder.feed(b"\x00\x00")  # beyond the declared data size
        with self.assertRaises(SpeechError):
            remote_speech._StreamingWav().feed(payload + b"\x00\x00")


class RemoteSpeechWireTests(unittest.TestCase):
    def test_provider_wav_becomes_exact_pcm_through_the_streaming_consumer(self):
        pcm = bytes(range(256)) * 16
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(24000)
            writer.writeframes(pcm)
        payload = output.getvalue()

        class Provider(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                for index in range(0, len(payload), 31):
                    self.wfile.write(payload[index:index + 31])

            def log_message(self, *_):
                pass

        provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        thread = threading.Thread(target=provider.serve_forever, daemon=True)
        thread.start()
        speech = RemoteSpeech(f"http://127.0.0.1:{provider.server_port}")
        try:
            chunks = list(speech.iter_synthesize("wire regression", "Sohee", "ko", threading.Event()))
            self.assertEqual(b"".join(chunk for chunk, _ in chunks), pcm)
            self.assertEqual({rate for _, rate in chunks}, {24000})
        finally:
            speech.close()
            provider.shutdown()
            provider.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
