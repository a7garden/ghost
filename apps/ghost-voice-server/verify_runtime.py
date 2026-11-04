"""Real synthetic speech acceptance against the local speech adapter.

The adapter protocol is unchanged, but the only speech backend is the
Dyno-owned :7730 process through RemoteSpeech; this script exercises the
bounded HTTP boundary and never loads model weights itself. Separate from
fake boundary tests: real TTS audio is synthesized, transcribed back, and a
disconnect mid-generation must cancel and drain the single queue.
"""
import argparse
import hashlib
import http.client
import io
import json
import socket
import time
import urllib.request
import wave
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=62076)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    args.evidence.mkdir(parents=True, exist_ok=True)
    base = f"http://127.0.0.1:{args.port}"
    report = {"real_models": True, "human_microphone": False, "external_audio_provider": False, "tests": []}

    def health():
        return json.load(urllib.request.urlopen(base + "/health", timeout=5))

    def stt(name, audio, language):
        boundary = "ghost-synthetic-verification-boundary"
        body = b""
        for key, value in [("model", "whisper-large-v3-turbo"), ("language", language)]:
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + audio + f"\r\n--{boundary}--\r\n".encode()
        start = time.monotonic()
        response = urllib.request.urlopen(urllib.request.Request(base + "/v1/audio/transcriptions", body, {"Content-Type": "multipart/form-data; boundary=" + boundary}), timeout=125)
        result = json.load(response)
        result.update(test=name, operation="stt", elapsed_seconds=time.monotonic() - start, sha256=hashlib.sha256(audio).hexdigest())
        report["tests"].append(result)
        return result

    report["health_before"] = health()
    for name, text, language in [("korean", "안녕하세요. 고스트 음성 연결을 확인합니다.", "ko"), ("english", "Hello. Ghost is checking the local voice connection.", "en")]:
        body = json.dumps({"model": "qwen3-tts-0.6b-customvoice", "input": text, "voice": "default", "response_format": "wav"}).encode()
        start = time.monotonic()
        response = urllib.request.urlopen(urllib.request.Request(base + "/v1/audio/speech", body, {"Content-Type": "application/json"}), timeout=125)
        audio = response.read()
        assert response.headers["content-type"] == "audio/wav"
        with wave.open(io.BytesIO(audio)) as reader:
            result = {"test": name, "operation": "tts", "elapsed_seconds": time.monotonic() - start, "sample_rate": reader.getframerate(), "duration_seconds": reader.getnframes() / reader.getframerate(), "bytes": len(audio), "sha256": hashlib.sha256(audio).hexdigest()}
        assert result["sample_rate"] == 24000 and 0 < result["duration_seconds"] < 60
        report["tests"].append(result)
        (args.evidence / f"{name}.wav").write_bytes(audio)
        transcript = stt(name, audio, language)
        assert ("고스트" in transcript["text"] and "음성" in transcript["text"]) if language == "ko" else "ghost" in transcript["text"].lower()

    # Disconnect our own HTTP client during real TTS generation; the health
    # counters must show discarded computation and a drained single queue.
    before = health()
    conn = http.client.HTTPConnection("127.0.0.1", args.port, timeout=5)
    body = json.dumps({"model": "qwen3-tts-0.6b-customvoice", "input": "고스트가 긴 음성 출력 도중 사용자의 말을 듣고 멈추는 경로를 확인합니다. " * 8, "voice": "default"})
    conn.request("POST", "/v1/audio/speech", body, {"Content-Type": "application/json"})
    for _ in range(100):
        if health()["queued_or_running"] > 0:
            break
        time.sleep(.02)
    else:
        raise AssertionError("cancellation request was not accepted")
    start = time.monotonic()
    conn.sock.shutdown(socket.SHUT_RDWR)
    conn.close()
    for _ in range(600):
        after = health()
        if after["queued_or_running"] == 0 and after["requests"]["cancelled"] > before["requests"]["cancelled"]:
            break
        time.sleep(.05)
    else:
        raise AssertionError("disconnected inference failed to cancel/drain within 30s")
    report["tests"].append({"test": "real_tts_disconnect", "operation": "cancel", "elapsed_seconds": time.monotonic() - start, "before": before["requests"], "after": after["requests"], "pass": True, "physical_playback_interruption_verified": False})
    stt("after_cancel", (args.evidence / "korean.wav").read_bytes(), "ko")
    report["health_after"] = health()
    report["pass"] = True
    (args.evidence / "real-inference.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
