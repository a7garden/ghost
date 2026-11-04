"""Authenticated, media-only SmallWebRTC sessions for Ghost conversations."""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import threading
import time
import uuid
import wave
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from aiortc.sdp import candidate_from_sdp
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pipecat.frames.frames import InputAudioRawFrame, InterruptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import RawAudioTrack, SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from speech_contract import LANGUAGES, MAX_BODY, MAX_TTS_CHUNK_BYTES, PLAYBACK_RATE, SpeechError, VOICES


MAX_ACTIVE_CALLS = 2
MAX_OFFER_BYTES = 64 * 1024
MAX_CONTROL_BYTES = 64 * 1024
MAX_CANDIDATES = 32
MAX_CANDIDATE_BYTES = 2048
MAX_AUDIO_SECONDS = 120
MAX_AUDIO_FRAME_BYTES = 64 * 1024
MAX_CALL_TURNS = 64
MAX_HOST_TURN_SECONDS = 120
MAX_TEXT_BYTES = 65_536
MAX_TTS_REPLY_SECONDS = 60
MAX_PENDING_AUDIO_FRAMES = 100
MAX_SHUTDOWN_SECONDS = 180
MAX_START_RECORDS = 64
START_RECORD_TTL_SECONDS = 24 * 3600
ENDED_TOMBSTONE_SECONDS = 3600
OFFER_CREATION_SECONDS = 10
INSTALLATION_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class MediaEvidenceError(Exception):
    """The evidence journal is unavailable, corrupt, or owned elsewhere."""


class MediaEvidence:
    """Crash-safe, single-owner start/tombstone evidence journal.

    Fail-closed by construction: the journal file must exist in exactly the
    accepted schema or the media service refuses to operate — corruption or
    an unknown schema never proves absence and never erases history. A
    process-lifetime exclusive flock rejects a second holder. Lock acquisition
    alone is NOT proof of process death: a live process can release its lock.
    Nonterminal restored records additionally require the recorded PID to be
    absent; an alive, reused, or uninspectable PID remains blocked. Cross-host
    restore still requires the recovery contract's verified stopped owners.
    Stored accepted turns are never re-run. Records use atomic rename + fsync,
    no symlinks, and owner-only files.
    """

    VERSION = 2
    MAX_RECORDS = 64

    def __init__(self, path: str):
        self.path = path
        self.lock_path = f"{path}.lock"
        self.instance = str(uuid.uuid4())
        self.pid = os.getpid()
        self.birth = time.time()
        self.starts: dict[str, dict] = {}
        self.tombstones: dict[str, dict] = {}
        self.poisoned = False
        self.reason = None
        self._lock_fd: int | None = None
        self._last_payload: bytes | None = None
        self._acquire()

    # -- ownership --------------------------------------------------------

    def _acquire(self) -> None:
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            self._lock_fd = os.open(self.lock_path, flags, 0o600)
        except OSError as error:
            raise MediaEvidenceError("media_evidence_lock_unavailable") from error
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(self._lock_fd)
            self._lock_fd = None
            raise MediaEvidenceError("media_evidence_owner_alive") from error
        try:
            self._assert_owned_lock()
            self._load_strict()
        except Exception:
            self._release_lock()
            raise

    def _release_lock(self) -> None:
        if self._lock_fd is not None:
            with contextlib.suppress(OSError):
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            with contextlib.suppress(OSError):
                os.close(self._lock_fd)
            self._lock_fd = None

    def _assert_owned_lock(self) -> None:
        try:
            held = os.fstat(self._lock_fd)
            entry = os.stat(self.lock_path, follow_symlinks=False)
        except (OSError, TypeError) as error:
            raise MediaEvidenceError("media_evidence_lock_unavailable") from error
        if (
            not stat.S_ISREG(held.st_mode) or held.st_uid != os.getuid()
            or held.st_mode & 0o077 or held.st_nlink != 1
            or not stat.S_ISREG(entry.st_mode)
            or (held.st_dev, held.st_ino) != (entry.st_dev, entry.st_ino)
        ):
            raise MediaEvidenceError("media_evidence_lock_changed")

    # -- strict schema ----------------------------------------------------

    def _read_journal(self) -> bytes | None:
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise MediaEvidenceError("media_evidence_unreadable") from error
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or metadata.st_nlink != 1:
                raise MediaEvidenceError("media_evidence_unreadable")
            chunks = []
            size = 0
            while size <= 4 * 1024 * 1024:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                size += len(chunk)
                chunks.append(chunk)
            if size > 4 * 1024 * 1024:
                raise MediaEvidenceError("media_evidence_oversized")
            return b"".join(chunks)
        finally:
            os.close(fd)

    def _load_strict(self) -> None:
        raw = self._read_journal()
        if raw is None:
            self._initialize_fresh()
            return
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise MediaEvidenceError("media_evidence_schema_invalid") from error
        self._validate_payload_or_fail(payload)
        if any(record["state"] != "ended" for record in payload["starts"].values()):
            try:
                os.kill(payload["pid"], 0)
            except ProcessLookupError:
                pass
            except (OSError, OverflowError) as error:
                raise MediaEvidenceError("media_evidence_owner_unconfirmed") from error
            else:
                raise MediaEvidenceError("media_evidence_owner_alive")
        self._last_payload = raw
        for start_id, record in payload["starts"].items():
            restored = dict(record)
            restored["answer"] = None
            self.starts[start_id] = restored
        self.tombstones.update(payload["tombstones"])

    def _initialize_fresh(self) -> None:
        payload = self._payload({}, {})
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self._write_atomic(raw)
        self._last_payload = raw

    def _payload(self, starts: dict, tombstones: dict) -> dict:
        return {
            "version": self.VERSION,
            "instance": self.instance,
            "pid": self.pid,
            "birth": self.birth,
            "starts": {
                key: {k: v for k, v in record.items() if k != "answer"}
                for key, record in list(starts.items())[: self.MAX_RECORDS]
            },
            "tombstones": dict(list(tombstones.items())[: self.MAX_RECORDS]),
        }

    def _validate_payload_or_fail(self, payload: dict) -> None:
        def invalid() -> MediaEvidenceError:
            return MediaEvidenceError("media_evidence_schema_invalid")

        if not isinstance(payload, dict) or set(payload) != {"version", "instance", "pid", "birth", "starts", "tombstones"} or payload.get("version") != self.VERSION:
            raise invalid()
        if not isinstance(payload.get("instance"), str) or not payload["instance"]:
            raise invalid()
        if type(payload.get("pid")) is not int or not 0 < payload["pid"] <= 2_147_483_647:
            raise invalid()
        if type(payload.get("birth")) is not float and type(payload.get("birth")) is not int:
            raise invalid()
        starts, tombstones = payload.get("starts"), payload.get("tombstones")
        if not isinstance(starts, dict) or not isinstance(tombstones, dict):
            raise invalid()
        if len(starts) > self.MAX_RECORDS or len(tombstones) > self.MAX_RECORDS:
            raise invalid()
        for start_id, record in starts.items():
            if not isinstance(start_id, str) or INSTALLATION_PATTERN.fullmatch(start_id) is None:
                raise invalid()
            if not isinstance(record, dict) or set(record) != {"state", "installation", "pc_id", "since", "instance"}:
                raise invalid()
            if record["state"] not in ("creating", "live", "ended"):
                raise invalid()
            if not isinstance(record["installation"], str) or not record["installation"] or len(record["installation"]) > 128:
                raise invalid()
            pc_id = record["pc_id"]
            if pc_id is not None and (not isinstance(pc_id, str) or not pc_id or len(pc_id) > 128):
                raise invalid()
            if type(record["since"]) is not float and type(record["since"]) is not int:
                raise invalid()
            if not isinstance(record["instance"], str) or not record["instance"]:
                raise invalid()
        for pc_id, tombstone in tombstones.items():
            if not isinstance(pc_id, str) or not pc_id or len(pc_id) > 128:
                raise invalid()
            if not isinstance(tombstone, dict) or set(tombstone) != {"installation", "target", "since"}:
                raise invalid()
            if not isinstance(tombstone["installation"], str) or not tombstone["installation"] or len(tombstone["installation"]) > 128:
                raise invalid()
            target = tombstone["target"]
            if not isinstance(target, dict) or set(target) != {"ghost_id", "conversation_id", "privacy", "authority_epoch"}:
                raise invalid()
            if type(tombstone["since"]) is not float and type(tombstone["since"]) is not int:
                raise invalid()

    # -- writes -----------------------------------------------------------

    def _write_atomic(self, raw: bytes) -> None:
        temp = f"{self.path}.{uuid.uuid4().hex}.tmp"
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                view = memoryview(raw)
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        raise OSError("media evidence write made no progress")
                    view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temp, self.path)
            directory_fd = os.open(os.path.dirname(self.path) or ".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError as error:
            with contextlib.suppress(OSError):
                os.unlink(temp)
            raise MediaEvidenceError("media_evidence_write_failed") from error

    def save(self, starts: dict, tombstones: dict, *, strict: bool = False) -> None:
        """Persist the working evidence.

        strict=True is used before any new effect: a failed or externally
        changed journal poisons the evidence and raises, refusing the effect.
        strict=False (teardown/housekeeping paths) poisons without raising so
        ending media can never be blocked by the journal.
        """
        if self.poisoned:
            if strict:
                raise MediaEvidenceError(self.reason or "media_evidence_poisoned")
            return
        raw = json.dumps(self._payload(starts, tombstones), separators=(",", ":")).encode("utf-8")
        try:
            self._assert_owned_lock()
            current = self._read_journal()
        except MediaEvidenceError as error:
            self._poison(str(error))
            if strict:
                raise
            return
        if current is None or current != self._last_payload:
            # A journal that vanished or changed after ownership was acquired
            # is tamper/loss evidence: fail closed, never overwrite uncertain
            # history with our working copy.
            self._poison(
                "media_evidence_journal_missing" if current is None
                else "media_evidence_changed_externally"
            )
            if strict:
                raise MediaEvidenceError(self.reason)
            return
        try:
            self._write_atomic(raw)
        except MediaEvidenceError as error:
            self._poison(str(error))
            if strict:
                raise
            return
        self._last_payload = raw

    def _poison(self, reason: str) -> None:
        self.poisoned = True
        self.reason = reason

    def close(self) -> None:
        self._poison("media_evidence_owner_closed")
        self._release_lock()


SAMPLE_RATE = 16_000
VAD_RMS_THRESHOLD = 350.0
VAD_SILENCE_SECONDS = 0.65
VAD_PREROLL_SECONDS = 0.20
VAD_MIN_SPEECH_SECONDS = 0.16
TTS_TEXT_LIMIT = 500
_STREAMING_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ghost-voice-stream")


@dataclass(frozen=True)
class ConversationTarget:
    ghost_id: str
    conversation_id: str
    privacy: str
    authority_epoch: int


@dataclass(frozen=True)
class VoiceTurn:
    turn_id: str
    ghost_id: str
    conversation_id: str
    state: str
    advisory_text: str | None = None


class HostVoice(Protocol):
    async def submit(self, target: ConversationTarget, text: str, command_id: str) -> VoiceTurn: ...

    async def inspect(self, target: ConversationTarget, turn_id: str) -> VoiceTurn: ...

    async def cancel(
        self, target: ConversationTarget, turn_id: str, command_id: str
    ) -> VoiceTurn: ...


class SpeechBackend(Protocol):
    """Executor-facing speech surface; the remote Dyno-owned backend (:7730)
    is the only wired implementation. No local weights are loaded here."""

    ready: dict

    def transcribe(self, data: bytes, language: str, cancelled) -> dict: ...

    def iter_synthesize(self, text, voice, language, cancelled): ...


@dataclass(frozen=True)
class MediaContext:
    target: ConversationTarget
    host: HostVoice
    speech: SpeechBackend
    language: str = "ko"
    voice: str = "Sohee"
    # The gateway-supplied device installation that owns this session. Every
    # admission, control, and observation is fenced to this identity.
    installation: str = ""
    # Async callable (installation) -> bool against the revocation source,
    # checked immediately before every Host effect and playback start. HTTP
    # admission requires it; effects without it would outlive revocation.
    authority: Any = None


class MediaError(ValueError):
    """A safe media boundary error code; never carries request or model text."""


@dataclass(frozen=True)
class _AudioSegment:
    sequence: int
    pcm: bytes
    sample_rate: int


@dataclass(frozen=True)
class _AudioFeed:
    started_sequence: int | None = None
    completed: _AudioSegment | None = None
    overflowed_sequence: int | None = None


class _AudioSegmenter:
    """Bounded local energy VAD; each segment uses final-segment batch STT."""

    def __init__(self, sample_rate: int = SAMPLE_RATE):
        self.sample_rate = sample_rate
        self._sequence = 0
        self._pre_roll: deque[bytes] = deque()
        self._pre_roll_bytes = 0
        self._chunks: list[bytes] = []
        self._segment_bytes = 0
        self._speech_samples = 0
        self._silence_samples = 0
        self._active_sequence: int | None = None
        self._discard_until_silence = False

    def reset(self) -> None:
        self._pre_roll.clear()
        self._pre_roll_bytes = 0
        self._chunks.clear()
        self._segment_bytes = 0
        self._speech_samples = 0
        self._silence_samples = 0
        self._active_sequence = None
        self._discard_until_silence = False

    def discard_active(self) -> None:
        self._pre_roll.clear()
        self._pre_roll_bytes = 0
        self._chunks.clear()
        self._segment_bytes = 0
        self._speech_samples = 0
        self._silence_samples = 0
        self._active_sequence = None
        self._discard_until_silence = True

    def _is_speech(self, pcm: bytes) -> bool:
        import numpy as np

        samples = np.frombuffer(pcm, dtype="<i2")
        if not samples.size:
            return False
        rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
        return rms >= VAD_RMS_THRESHOLD

    def _append_preroll(self, pcm: bytes) -> None:
        maximum = int(self.sample_rate * 2 * VAD_PREROLL_SECONDS)
        if len(pcm) >= maximum:
            self._pre_roll.clear()
            self._pre_roll.append(pcm[-maximum:])
            self._pre_roll_bytes = maximum
            return
        self._pre_roll.append(pcm)
        self._pre_roll_bytes += len(pcm)
        while self._pre_roll_bytes > maximum and self._pre_roll:
            excess = self._pre_roll_bytes - maximum
            first = self._pre_roll.popleft()
            self._pre_roll_bytes -= len(first)
            if len(first) > excess:
                retained = first[excess:]
                self._pre_roll.appendleft(retained)
                self._pre_roll_bytes += len(retained)

    def feed(self, frame: InputAudioRawFrame) -> _AudioFeed:
        pcm = frame.audio
        if (
            not isinstance(pcm, bytes)
            or not pcm
            or len(pcm) > MAX_AUDIO_FRAME_BYTES
            or len(pcm) % 2
            or frame.num_channels != 1
            or frame.sample_rate != self.sample_rate
        ):
            raise MediaError("audio_frame_invalid")

        voiced = self._is_speech(pcm)
        samples = len(pcm) // 2
        if self._discard_until_silence:
            if not voiced:
                self._discard_until_silence = False
                self._append_preroll(pcm)
            return _AudioFeed()

        started_sequence = None
        if self._active_sequence is None:
            if not voiced:
                self._append_preroll(pcm)
                return _AudioFeed()
            self._sequence += 1
            self._active_sequence = self._sequence
            self._chunks = list(self._pre_roll)
            self._segment_bytes = self._pre_roll_bytes
            self._pre_roll.clear()
            self._pre_roll_bytes = 0
            started_sequence = self._active_sequence

        if (
            self._segment_bytes + len(pcm) > MAX_BODY - 44
            or self._speech_samples + (samples if voiced else 0)
            > self.sample_rate * MAX_AUDIO_SECONDS
        ):
            overflowed = self._active_sequence
            self.discard_active()
            return _AudioFeed(started_sequence, None, overflowed)

        self._chunks.append(pcm)
        self._segment_bytes += len(pcm)
        if voiced:
            self._speech_samples += samples
            self._silence_samples = 0
        else:
            self._silence_samples += samples

        if self._silence_samples < int(self.sample_rate * VAD_SILENCE_SECONDS):
            return _AudioFeed(started_sequence)

        sequence = self._active_sequence
        silence_bytes = self._silence_samples * 2
        audio = b"".join(self._chunks)
        payload = audio[:-silence_bytes] if silence_bytes else audio
        completed = None
        if self._speech_samples >= int(self.sample_rate * VAD_MIN_SPEECH_SECONDS):
            completed = _AudioSegment(sequence, payload, self.sample_rate)

        preroll = audio[-int(self.sample_rate * 2 * VAD_PREROLL_SECONDS):]
        self._pre_roll.clear()
        self._pre_roll_bytes = 0
        self._chunks.clear()
        self._segment_bytes = 0
        self._speech_samples = 0
        self._silence_samples = 0
        self._active_sequence = None
        if preroll:
            self._append_preroll(preroll)
        return _AudioFeed(started_sequence, completed)


@dataclass
class _TurnRecord:
    sequence: int
    speech_turn_id: str
    command_id: str
    cancel_command_id: str
    local_cancel: threading.Event = field(default_factory=threading.Event)
    audio_digest: str | None = None
    transcript: str | None = None
    phase: str = "capturing"
    owner_turn: VoiceTurn | None = None
    submission_started: bool = False
    cancel_requested: bool = False
    cancel_sent: bool = False
    task: asyncio.Task | None = None
    cancel_watch: asyncio.Task | None = None


def _next_synthesis_chunk(generator):
    with open(os.devnull, "w") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            try:
                return next(generator)
            except StopIteration:
                return None


def _close_synthesis_generator(generator) -> None:
    close = getattr(generator, "close", None)
    if close is not None:
        with open(os.devnull, "w") as sink:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                close()


def _quiet_call(operation, *args):
    with open(os.devnull, "w") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            return operation(*args)


def _pcm_wav(pcm: bytes, sample_rate: int) -> bytes:
    if (
        not pcm
        or len(pcm) > MAX_BODY - 44
        or len(pcm) % 2
        or not 8000 <= sample_rate <= 48000
        or len(pcm) // 2 > sample_rate * MAX_AUDIO_SECONDS
    ):
        raise MediaError("audio_segment_invalid")
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm)
    return output.getvalue()


def _speech_chunks(text: str):
    remaining = text.strip()
    while remaining:
        if len(remaining) <= TTS_TEXT_LIMIT:
            yield remaining
            return
        split_at = max(
            remaining.rfind(" ", 0, TTS_TEXT_LIMIT + 1),
            remaining.rfind("\n", 0, TTS_TEXT_LIMIT + 1),
        )
        if split_at <= 0:
            split_at = TTS_TEXT_LIMIT
        chunk = remaining[:split_at].strip()
        if chunk:
            yield chunk
        remaining = remaining[split_at:].lstrip()


class _InputProcessor(FrameProcessor):
    def __init__(self, session: MediaSession):
        super().__init__(name="ghost-voice-segmenter", enable_direct_mode=True)
        self._session = session

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            try:
                update = self._session._segmenter.feed(frame)
            except MediaError:
                asyncio.create_task(self._session.hangup())
                return
            if update.started_sequence is not None:
                accepted = await self._session._voice_started(update.started_sequence)
                if not accepted:
                    self._session._segmenter.discard_active()
            if update.overflowed_sequence is not None:
                self._session._mark_input_overflow(update.overflowed_sequence)
            if update.completed is not None:
                self._session._accept_segment(update.completed)
            return
        await self.push_frame(frame, direction)


class MediaSession:
    """One authenticated call; the Host remains the only conversation owner."""

    def __init__(
        self,
        context: MediaContext,
        pc_id: str | None = None,
        on_close: Callable[[str], None] | None = None,
        inference_lock: asyncio.Lock | None = None,
        start_id: str = "",
    ):
        self.context = context
        self.installation = context.installation
        # The immutable admission identity of this session: every authority
        # ask binds to it, so an old call can never borrow a newer call's
        # authorization on the same device.
        self.start_id = start_id
        self.pc_id = pc_id
        self._on_close = on_close
        self._inference_lock = inference_lock or asyncio.Lock()
        self.connection: SmallWebRTCConnection | None = None
        self.transport: SmallWebRTCTransport | None = None
        self.worker: PipelineTask | None = None
        self.runner: WorkerRunner | None = None
        self._runner_task: asyncio.Task | None = None
        self._pipeline_ready = asyncio.Event()
        self._pipeline_failed = asyncio.Event()
        self._connected = False
        self._closed = False
        self._segmenter = _AudioSegmenter()
        self._namespace = uuid.uuid4()
        self._records_by_speech: dict[str, _TurnRecord] = {}
        self._records_by_command: dict[str, _TurnRecord] = {}
        self._active_record: _TurnRecord | None = None
        self._playback_record: _TurnRecord | None = None
        self.playback_epoch = 0
        self._turn_tasks: set[asyncio.Task] = set()
        self._ice_candidate_count = 0
        self._ice_candidate_lock = asyncio.Lock()
        self._cancel_tasks: set[asyncio.Task] = set()

    def require_context(self, context: MediaContext) -> None:
        if (
            context.installation != self.context.installation
            or context.target != self.context.target
            or context.host is not self.context.host
            or context.speech is not self.context.speech
            or context.language != self.context.language
            or context.voice != self.context.voice
        ):
            raise MediaError("voice_context_changed")

    async def _authority_current(self) -> bool | None:
        """True authorized, False definitely revoked, None unverifiable.

        Production admission always wires an authority callback; only bare
        unit-constructed sessions run without one, and they fence nothing.
        The ask binds to this session's exact admission start_id.
        """
        check = self.context.authority
        if check is None:
            return True
        try:
            result = await check(self.installation, self.start_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            return None
        return result if isinstance(result, bool) else None

    async def _stop_after_lost_authority(self, revoked: bool) -> None:
        # The dispatch decision already happened; end local media without
        # claiming any further turn outcome. Teardown wins over state.
        self.playback_epoch += 1
        self._playback_record = None
        with contextlib.suppress(Exception):
            await self._clear_output()
        if revoked:
            asyncio.create_task(self.hangup())

    async def add_ice_candidates(self, candidates: list[Any]) -> None:
        if not isinstance(candidates, list) or not candidates:
            raise MediaError("ice_candidates_invalid")
        async with self._ice_candidate_lock:
            if self._closed or self.connection is None:
                raise MediaError("voice_session_not_found")
            if self._ice_candidate_count + len(candidates) > MAX_CANDIDATES:
                raise MediaError("ice_candidates_limit")
            for candidate in candidates:
                try:
                    # Pipecat's wrapper logs remote ICE candidates at DEBUG.
                    await self.connection.pc.addIceCandidate(candidate)
                except Exception:
                    raise MediaError("ice_candidate_invalid") from None
                self._ice_candidate_count += 1

    async def start(self, connection: SmallWebRTCConnection) -> None:
        self.connection = connection
        self.pc_id = connection.pc_id
        self.transport = SmallWebRTCTransport(
            webrtc_connection=connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_sample_rate=SAMPLE_RATE,
                audio_in_channels=1,
                audio_out_enabled=True,
                audio_out_sample_rate=PLAYBACK_RATE,
                audio_out_channels=1,
                audio_out_10ms_chunks=1,
                video_in_enabled=False,
                video_out_enabled=False,
            ),
        )
        pipeline = Pipeline(
            [self.transport.input(), _InputProcessor(self), self.transport.output()]
        )
        self.worker = PipelineTask(
            pipeline,
            name=f"ghost-voice-{self.pc_id}",
            params=PipelineParams(
                audio_in_sample_rate=SAMPLE_RATE,
                audio_out_sample_rate=PLAYBACK_RATE,
                enable_metrics=False,
                enable_usage_metrics=False,
            ),
            idle_timeout_secs=None,
            enable_turn_tracking=False,
        )

        @self.worker.event_handler("on_pipeline_started")
        async def pipeline_started(worker, frame):
            self._pipeline_ready.set()

        @self.worker.event_handler("on_pipeline_error")
        async def pipeline_error(worker, frame):
            self._pipeline_failed.set()

        @connection.event_handler("connected")
        async def connection_connected(current):
            if not self._closed:
                self._connected = True

        @connection.event_handler("disconnected")
        async def connection_disconnected(current):
            self._connected = False
            await self.hangup(close_connection=False)

        @connection.event_handler("failed")
        async def connection_failed(current):
            self._connected = False
            await self.hangup(close_connection=False)

        @connection.event_handler("closed")
        async def connection_closed(current):
            self._connected = False
            await self.hangup(close_connection=False)

        @connection.event_handler("app-message")
        async def connection_app_message(current, message):
            await self.handle_app_message(message, current.pc_id)

        self._connected = connection.is_connected()

        self.runner = WorkerRunner(
            name=f"ghost-voice-{self.pc_id}",
            handle_sigint=False,
            handle_sigterm=False,
        )
        await self.runner.add_workers(self.worker)
        self._runner_task = asyncio.create_task(self.runner.run(auto_end=False))
        ready_task = asyncio.create_task(self._pipeline_ready.wait())
        failed_task = asyncio.create_task(self._pipeline_failed.wait())
        try:
            done, _ = await asyncio.wait(
                {ready_task, failed_task, self._runner_task},
                timeout=10,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if self._runner_task in done or failed_task in done or not done:
                raise MediaError("media_pipeline_unavailable")
            if ready_task not in done or not self._pipeline_ready.is_set():
                raise MediaError("media_pipeline_unavailable")
        finally:
            for task in (ready_task, failed_task):
                if not task.done():
                    task.cancel()

    def _new_record(self, sequence: int) -> _TurnRecord | None:
        if not 1 <= sequence <= MAX_CALL_TURNS:
            return None
        speech_id = str(uuid.uuid5(self._namespace, f"speech:{sequence}"))
        existing = self._records_by_speech.get(speech_id)
        if existing is not None:
            return existing
        command_id = str(uuid.uuid5(self._namespace, f"owner:{sequence}"))
        record = _TurnRecord(
            sequence=sequence,
            speech_turn_id=speech_id,
            command_id=command_id,
            cancel_command_id=str(uuid.uuid5(self._namespace, f"cancel:{sequence}")),
        )
        self._records_by_speech[speech_id] = record
        self._records_by_command[command_id] = record
        return record

    async def _voice_started(self, sequence: int) -> bool:
        if self._closed or sequence > MAX_CALL_TURNS:
            return False
        record = self._new_record(sequence)
        if record is None:
            return False
        await self._barge_in()
        self._active_record = record
        return True

    def _accept_segment(self, segment: _AudioSegment) -> None:
        speech_id = str(uuid.uuid5(self._namespace, f"speech:{segment.sequence}"))
        record = self._records_by_speech.get(speech_id)
        if record is None or self._closed:
            return
        digest = hashlib.sha256(segment.pcm).hexdigest()
        if record.audio_digest is not None:
            if record.audio_digest != digest:
                self._request_owner_cancel(record, self.context.host)
                record.phase = "failed"
                self._emit_phase(record, "failed")
            return
        if any(not active.done() for active in self._turn_tasks):
            record.phase = "failed"
            self._emit_phase(record, "failed")
            return
        record.audio_digest = digest
        task = asyncio.create_task(
            self._process_segment(record, segment.pcm, segment.sample_rate)
        )
        record.task = task
        self._track_task(self._turn_tasks, task)

    def _mark_input_overflow(self, sequence: int) -> None:
        speech_id = str(uuid.uuid5(self._namespace, f"speech:{sequence}"))
        record = self._records_by_speech.get(speech_id)
        if record is not None:
            record.phase = "failed"
            record.local_cancel.set()
            self._emit_phase(record, "failed")

    def _track_task(self, tasks: set[asyncio.Task], task: asyncio.Task) -> None:
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    async def _inference_call(self, record: _TurnRecord, operation, *args):
        async with self._inference_lock:
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(
                _STREAMING_EXECUTOR, _quiet_call, operation, *args
            )
            try:
                return await asyncio.shield(future)
            except asyncio.CancelledError:
                record.local_cancel.set()
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await asyncio.shield(future)
                raise

    async def _process_segment(self, record: _TurnRecord, pcm: bytes, sample_rate: int) -> None:
        if self._closed or record.cancel_requested:
            return
        record.phase = "transcribing"
        try:
            wav_data = _pcm_wav(pcm, sample_rate)
            result = await self._inference_call(
                record,
                self.context.speech.transcribe,
                wav_data,
                self.context.language,
                record.local_cancel,
            )
            if record.cancel_requested or self._closed:
                return
            if not isinstance(result, dict) or not isinstance(result.get("text"), str):
                raise MediaError("transcription_invalid")
            await self._submit_final_text(record, result["text"])
        except asyncio.CancelledError:
            raise
        except Exception:
            record.phase = "failed"
            self._emit_phase(record, "failed")

    async def _submit_final_text(self, record: _TurnRecord, text: str) -> None:
        if self._closed or record.cancel_requested:
            return
        if not isinstance(text, str):
            record.phase = "failed"
            self._emit_phase(record, "failed")
            return
        transcript = text.strip()
        try:
            encoded = transcript.encode("utf-8")
        except UnicodeEncodeError:
            record.phase = "failed"
            self._emit_phase(record, "failed")
            return
        if not transcript or len(encoded) > MAX_TEXT_BYTES:
            record.phase = "failed"
            self._emit_phase(record, "failed")
            return
        if record.transcript is not None and record.transcript != transcript:
            self._request_owner_cancel(record, self.context.host)
            record.phase = "failed"
            self._emit_phase(record, "failed")
            return
        record.transcript = transcript
        if record.submission_started:
            return
        record.submission_started = True
        record.phase = "submitting"
        self._emit_phase(record, "submitting")
        # Effect-time device authority: check immediately before the Host
        # write. A definitely revoked installation never dispatches; an
        # unverifiable one stays unknown instead of dispatching blind.
        current = await self._authority_current()
        if current is False:
            record.phase = "failed"
            self._emit_phase(record, "failed")
            await self._stop_after_lost_authority(revoked=True)
            return
        if current is None:
            record.phase = "effect_unknown"
            self._emit_phase(record, "effect_unknown")
            return
        try:
            turn = await self.context.host.submit(
                self.context.target, transcript, record.command_id
            )
            record.owner_turn = _validate_voice_turn(
                turn, self.context.target, record.command_id
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            record.phase = "effect_unknown"
            self._emit_phase(record, "effect_unknown")
            return
        # The submission effect stands; re-check before any further effect.
        current = await self._authority_current()
        if current is not True:
            record.phase = record.owner_turn.state if record.owner_turn else record.phase
            self._emit_turn(record)
            await self._stop_after_lost_authority(revoked=current is False)
            return

        record.phase = record.owner_turn.state
        self._emit_turn(record)
        if record.cancel_requested:
            await self._apply_owner_cancel(record, self.context.host)
            if record.owner_turn and record.owner_turn.state in {"queued", "running"}:
                self._schedule_cancel_watch(record, self.context.host)
            return
        if self._closed:
            return
        if record.owner_turn.state in {"queued", "running"} or (
            record.owner_turn.state == "answered" and not record.owner_turn.advisory_text
        ):
            await self._wait_for_owner_turn(record)
            return
        if record.owner_turn.state == "answered" and record.owner_turn.advisory_text:
            await self._speak_advisory(record, record.owner_turn.advisory_text)

    async def _wait_for_owner_turn(self, record: _TurnRecord) -> None:
        deadline = asyncio.get_running_loop().time() + MAX_HOST_TURN_SECONDS
        while record.owner_turn and (
            record.owner_turn.state in {"queued", "running"} or
            (record.owner_turn.state == "answered" and not record.owner_turn.advisory_text)
        ):
            if self._closed:
                return
            if record.cancel_requested:
                await self._apply_owner_cancel(record, self.context.host)
                if record.owner_turn and record.owner_turn.state in {"queued", "running"}:
                    self._schedule_cancel_watch(record, self.context.host)
                return
            if asyncio.get_running_loop().time() >= deadline:
                record.phase = "effect_unknown"
                self._emit_phase(record, "effect_unknown")
                return
            await asyncio.sleep(0.5)
            if self._closed:
                return
            try:
                turn = await self.context.host.inspect(
                    self.context.target, record.command_id
                )
                record.owner_turn = _validate_voice_turn(
                    turn, self.context.target, record.command_id
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                record.phase = "effect_unknown"
                self._emit_phase(record, "effect_unknown")
                return
            record.phase = record.owner_turn.state
            self._emit_turn(record)
        if (
            not self._closed
            and not record.cancel_requested
            and record.owner_turn is not None
            and record.owner_turn.state == "answered"
            and record.owner_turn.advisory_text
        ):
            await self._speak_advisory(record, record.owner_turn.advisory_text)

    async def _apply_owner_cancel(self, record: _TurnRecord, host: HostVoice) -> VoiceTurn | None:
        current = record.owner_turn
        if record.cancel_sent or current is None or current.state not in {"queued", "running"}:
            return current
        record.cancel_sent = True
        try:
            cancelled = await host.cancel(
                self.context.target, record.command_id, record.cancel_command_id
            )
            record.owner_turn = _validate_voice_turn(
                cancelled, self.context.target, record.command_id
            )
            record.phase = record.owner_turn.state
            self._emit_turn(record)
            return record.owner_turn
        except asyncio.CancelledError:
            raise
        except Exception:
            record.phase = "effect_unknown"
            self._emit_phase(record, "effect_unknown")
            return None

    def _schedule_cancel_watch(self, record: _TurnRecord, host: HostVoice) -> None:
        if record.cancel_watch is not None and not record.cancel_watch.done():
            return
        task = asyncio.create_task(self._watch_cancel(record, host))
        record.cancel_watch = task
        self._track_task(self._cancel_tasks, task)

    async def _watch_cancel(self, record: _TurnRecord, host: HostVoice) -> None:
        deadline = asyncio.get_running_loop().time() + MAX_HOST_TURN_SECONDS
        while (
            not self._closed
            and record.owner_turn is not None
            and record.owner_turn.state in {"queued", "running"}
            and asyncio.get_running_loop().time() < deadline
        ):
            await asyncio.sleep(0.5)
            if self._closed:
                return
            try:
                turn = await host.inspect(self.context.target, record.command_id)
                record.owner_turn = _validate_voice_turn(
                    turn, self.context.target, record.command_id
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                record.phase = "effect_unknown"
                self._emit_phase(record, "effect_unknown")
                return
            record.phase = record.owner_turn.state
            self._emit_turn(record)
        if (
            record.owner_turn is not None
            and record.owner_turn.state in {"queued", "running"}
            and not self._closed
        ):
            record.phase = "effect_unknown"
            self._emit_phase(record, "effect_unknown")

    def _request_owner_cancel(self, record: _TurnRecord, host: HostVoice) -> None:
        if record.cancel_requested or record.phase in {
            "done", "failed", "effect_unknown", "cancelled"
        }:
            return
        record.cancel_requested = True
        record.local_cancel.set()
        if record.owner_turn is not None and record.owner_turn.state in {"queued", "running"}:
            task = asyncio.create_task(self._apply_owner_cancel(record, host))
            self._track_task(self._cancel_tasks, task)

    async def _barge_in(self) -> None:
        if self._closed:
            return
        self.playback_epoch += 1
        if self._playback_record is not None:
            self._playback_record.local_cancel.set()
        if self._active_record is not None:
            self._request_owner_cancel(self._active_record, self.context.host)
        await self._clear_output()
        self._playback_record = None

    async def cancel_turn(
        self, turn_id: str, host: HostVoice, context: MediaContext | None = None
    ) -> dict[str, Any]:
        if context is not None:
            self.require_context(context)
        if not isinstance(turn_id, str) or len(turn_id) != 36:
            raise MediaError("turn_target_invalid")
        try:
            normalized = str(uuid.UUID(turn_id))
        except (ValueError, AttributeError):
            raise MediaError("turn_target_invalid") from None
        if normalized != turn_id:
            raise MediaError("turn_target_invalid")
        record = self._records_by_command.get(turn_id)
        if record is None:
            raise MediaError("turn_target_unknown")
        if record.owner_turn is not None and record.owner_turn.state not in {"queued", "running"}:
            raise MediaError("turn_target_terminal")
        record.cancel_requested = True
        record.local_cancel.set()
        if self._playback_record is record:
            self.playback_epoch += 1
            await self._clear_output()
            self._playback_record = None
        if record.owner_turn is not None:
            await self._apply_owner_cancel(record, host)
            if record.owner_turn and record.owner_turn.state in {"queued", "running"}:
                self._schedule_cancel_watch(record, host)
        return {
            "turn_id": record.command_id,
            "state": record.owner_turn.state if record.owner_turn else record.phase,
            "cancel_requested": record.cancel_requested,
            "cancel_completed": bool(record.owner_turn and record.owner_turn.state == "cancelled"),
        }

    async def _speak_advisory(self, record: _TurnRecord, text: str) -> None:
        if self._closed or record.cancel_requested or not text:
            return
        # Playback is the audio effect toward the device: never start it for a
        # definitely revoked installation, nor under unverifiable authority.
        current = await self._authority_current()
        if current is not True:
            await self._stop_after_lost_authority(revoked=current is False)
            return
        try:
            if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
                raise SpeechError("host_advisory_invalid", 413)
        except UnicodeEncodeError:
            raise SpeechError("host_advisory_invalid", 413) from None

        self._playback_record = record
        epoch = self.playback_epoch
        audio_buffer = bytearray()
        sample_rate = None
        generated_bytes = 0
        generated_samples = 0
        frame_bytes = PLAYBACK_RATE * 2 // 100
        loop = asyncio.get_running_loop()
        try:
            async with self._inference_lock:
                for speech in _speech_chunks(text):
                    if not self._playback_is_current(record, epoch):
                        return
                    generator = self.context.speech.iter_synthesize(
                        speech, self.context.voice, self.context.language, record.local_cancel
                    )
                    try:
                        while True:
                            if not self._playback_is_current(record, epoch):
                                return
                            step = loop.run_in_executor(
                                _STREAMING_EXECUTOR, _next_synthesis_chunk, generator
                            )
                            try:
                                item = await asyncio.shield(step)
                            except asyncio.CancelledError:
                                record.local_cancel.set()
                                with contextlib.suppress(Exception, asyncio.CancelledError):
                                    await asyncio.shield(step)
                                raise
                            if item is None:
                                break
                            if not self._playback_is_current(record, epoch):
                                return
                            chunk, next_rate = item
                            if (
                                not isinstance(chunk, bytes)
                                or not chunk
                                or len(chunk) % 2
                                or len(chunk) > MAX_TTS_CHUNK_BYTES
                                or type(next_rate) is not int
                                or next_rate != PLAYBACK_RATE
                            ):
                                raise SpeechError("audio_output_invalid", 503)
                            if sample_rate is not None and sample_rate != next_rate:
                                raise SpeechError("audio_rate_changed", 503)
                            sample_rate = next_rate
                            generated_bytes += len(chunk)
                            generated_samples += len(chunk) // 2
                            if (
                                generated_bytes > MAX_BODY - 44
                                or generated_samples > PLAYBACK_RATE * MAX_TTS_REPLY_SECONDS
                            ):
                                raise SpeechError("speech_output_too_long", 413)
                            audio_buffer.extend(chunk)
                            while len(audio_buffer) >= frame_bytes:
                                if not self._playback_is_current(record, epoch):
                                    return
                                pcm = bytes(audio_buffer[:frame_bytes])
                                del audio_buffer[:frame_bytes]
                                sent = await self._send_audio_frame(
                                    record, epoch, pcm, next_rate
                                )
                                if not sent:
                                    if not self._playback_is_current(record, epoch):
                                        return
                                    raise SpeechError("audio_output_unavailable", 503)
                    finally:
                        close_future = loop.run_in_executor(
                            _STREAMING_EXECUTOR, _close_synthesis_generator, generator
                        )
                        with contextlib.suppress(Exception, asyncio.CancelledError):
                            await asyncio.shield(close_future)
            if audio_buffer and sample_rate is not None and self._playback_is_current(record, epoch):
                audio_buffer.extend(bytes(frame_bytes - len(audio_buffer)))
                sent = await self._send_audio_frame(
                    record, epoch, bytes(audio_buffer), sample_rate
                )
                if not sent and self._playback_is_current(record, epoch):
                    raise SpeechError("audio_output_unavailable", 503)
            if self._playback_is_current(record, epoch):
                record.phase = "done"
        except asyncio.CancelledError:
            raise
        except Exception:
            if self._playback_record is record and self.playback_epoch == epoch:
                await self._clear_output()
            if not record.cancel_requested:
                record.phase = "failed"
                self._emit_phase(record, "failed")
        finally:
            if self._playback_record is record:
                self._playback_record = None
            if self._active_record is record and record.phase in {
                "done", "failed", "effect_unknown", "cancelled"
            }:
                self._active_record = None

    def _playback_is_current(self, record: _TurnRecord, epoch: int) -> bool:
        return (
            not self._closed
            and not record.cancel_requested
            and not record.local_cancel.is_set()
            and self._playback_record is record
            and self.playback_epoch == epoch
        )

    # Pipecat 1.12 stores RTP chunks on the shared SmallWebRTCClient, outside
    # BaseOutput's interruption queue; this pinned track boundary paces and clears them.
    def _audio_output_track(self) -> RawAudioTrack | None:
        if self.transport is None:
            return None
        client = getattr(self.transport, "_client", None)
        track = getattr(client, "_audio_output_track", None)
        if track is None:
            return None
        if not isinstance(track, RawAudioTrack) or not isinstance(track._chunk_queue, deque):
            raise MediaError("audio_track_invalid")
        return track

    async def _send_audio_frame(
        self, record: _TurnRecord, epoch: int, pcm: bytes, sample_rate: int
    ) -> bool:
        if (
            not self._playback_is_current(record, epoch)
            or self.transport is None
            or not self._pipeline_ready.is_set()
            or not self._connected
        ):
            return False
        if sample_rate != PLAYBACK_RATE or len(pcm) != PLAYBACK_RATE * 2 // 100:
            return False
        if self.connection is None or not self.connection.is_connected():
            return False
        track = self._audio_output_track()
        if track is None or len(track._chunk_queue) >= MAX_PENDING_AUDIO_FRAMES:
            return False
        completion = track.add_audio_bytes(pcm)
        try:
            await asyncio.wait_for(asyncio.shield(completion), timeout=1)
        except asyncio.TimeoutError:
            return False
        except asyncio.CancelledError:
            if not self._playback_is_current(record, epoch):
                return False
            raise
        return self._playback_is_current(record, epoch)

    async def _clear_output(self) -> None:
        track = None
        try:
            track = self._audio_output_track()
        except Exception:
            if not self._closed:
                asyncio.create_task(self.hangup())

        if self.transport is not None and self._pipeline_ready.is_set():
            try:
                output = self.transport.output()
                processed = asyncio.Event()

                async def cleared(processor, frame, direction):
                    processed.set()

                await output.queue_frame(
                    InterruptionFrame(),
                    FrameDirection.DOWNSTREAM,
                    callback=cleared,
                )
                await asyncio.wait_for(processed.wait(), timeout=2)
            except Exception:
                if not self._closed:
                    asyncio.create_task(self.hangup())

        if track is None:
            with contextlib.suppress(Exception):
                track = self._audio_output_track()
        if track is not None:
            while track._chunk_queue:
                _, completed = track._chunk_queue.popleft()
                if completed is not None and not completed.done():
                    completed.cancel()


    def _emit_phase(self, record: _TurnRecord, phase: str) -> None:
        if self.connection is None or self._closed:
            return
        try:
            self.connection.send_app_message(
                {
                    "type": "ghost.voice.turn",
                    "speech_turn_id": record.speech_turn_id,
                    "turn_id": record.command_id,
                    "phase": phase,
                    "cancel_requested": record.cancel_requested,
                }
            )
        except Exception:
            return

    def _emit_turn(self, record: _TurnRecord) -> None:
        if self.connection is None or self._closed or record.owner_turn is None:
            return
        turn = record.owner_turn
        try:
            self.connection.send_app_message(
                {
                    "type": "ghost.voice.turn",
                    "speech_turn_id": record.speech_turn_id,
                    "turn_id": turn.turn_id,
                    "state": turn.state,
                    "cancel_requested": record.cancel_requested,
                }
            )
        except Exception:
            return

    async def handle_app_message(self, message: Any, sender: str) -> None:
        if self._closed or sender != self.pc_id or not isinstance(message, dict):
            return
        if message == {"type": "hangup"}:
            await self.hangup()
            return
        if set(message) == {"type", "turn_id"} and message.get("type") == "cancel_turn":
            try:
                await self.cancel_turn(message["turn_id"], self.context.host)
            except MediaError:
                return

    async def hangup(self, close_connection: bool = True) -> None:
        if self._closed:
            return
        self._closed = True
        self._connected = False
        self._segmenter.reset()
        for record in self._records_by_speech.values():
            record.local_cancel.set()
        await self._clear_output()
        current = asyncio.current_task()
        for record in self._records_by_speech.values():
            task = record.task
            if (
                task is not None
                and task is not current
                and not task.done()
                and not (record.cancel_requested and record.submission_started and record.owner_turn is None)
            ):
                task.cancel()
        for task in tuple(self._cancel_tasks):
            if task is not current and not task.done():
                task.cancel()
        if self.runner is not None:
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await self.runner.cancel()
        if close_connection and self.connection is not None:
            with contextlib.suppress(Exception):
                await self.connection.disconnect()
        if self._on_close is not None and self.pc_id is not None:
            self._on_close(self.pc_id)

    async def drain(self) -> None:
        """Wait for owned inference/RPC tasks without cancelling their drain."""
        deadline = asyncio.get_running_loop().time() + MAX_SHUTDOWN_SECONDS
        current = asyncio.current_task()
        while True:
            tasks = {
                task for task in self._turn_tasks | self._cancel_tasks
                if task is not current and not task.done()
            }
            if self._runner_task is not None and self._runner_task is not current and not self._runner_task.done():
                tasks.add(self._runner_task)
            if not tasks:
                return
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise MediaError("media_shutdown_unknown")
            completed, pending = await asyncio.wait(tasks, timeout=remaining)
            if completed:
                await asyncio.gather(*completed, return_exceptions=True)
            if pending:
                raise MediaError("media_shutdown_unknown")


_VALID_TURN_STATES = {
    "queued", "running", "answered", "failed", "cancelled", "effect_unknown"
}


def _validate_voice_turn(
    turn: VoiceTurn, target: ConversationTarget, expected_turn_id: str
) -> VoiceTurn:
    if (
        not isinstance(turn, VoiceTurn)
        or not isinstance(turn.state, str)
        or turn.turn_id != expected_turn_id
        or turn.ghost_id != target.ghost_id
        or turn.conversation_id != target.conversation_id
        or turn.state not in _VALID_TURN_STATES
        or (turn.advisory_text is not None and not isinstance(turn.advisory_text, str))
    ):
        raise MediaError("host_turn_scope_invalid")
    if turn.advisory_text is not None:
        try:
            if len(turn.advisory_text.encode("utf-8")) > MAX_TEXT_BYTES:
                raise MediaError("host_advisory_invalid")
        except UnicodeEncodeError:
            raise MediaError("host_advisory_invalid") from None
    if turn.state != "answered" and turn.advisory_text is not None:
        raise MediaError("host_advisory_state_invalid")
    return turn


def _valid_context(context: Any) -> bool:
    if not isinstance(context, MediaContext) or not isinstance(context.target, ConversationTarget):
        return False
    target = context.target
    try:
        identifiers_valid = all(
            isinstance(value, str) and value and len(value.encode("utf-8")) <= 512
            for value in (target.ghost_id, target.conversation_id)
        )
    except UnicodeEncodeError:
        return False
    return (
        identifiers_valid
        and target.privacy == "local_only"
        and type(target.authority_epoch) is int
        and 0 < target.authority_epoch <= 9_007_199_254_740_991
        and isinstance(context.installation, str)
        and INSTALLATION_PATTERN.fullmatch(context.installation) is not None
        and callable(context.authority)
        and callable(getattr(context.host, "submit", None))
        and callable(getattr(context.host, "inspect", None))
        and callable(getattr(context.host, "cancel", None))
        and callable(getattr(context.speech, "transcribe", None))
        and callable(getattr(context.speech, "iter_synthesize", None))
        and isinstance(context.language, str)
        and context.language in (set(LANGUAGES) | set(LANGUAGES.values()))
        and isinstance(context.voice, str)
        and context.voice.lower() in VOICES
    )


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _bounded_json_value(value: str):
    raise ValueError("invalid_json_constant")


async def _bounded_json(request: Request, maximum: int, allow_empty: bool = False) -> dict:
    declared = request.headers.get("content-length")
    if declared is not None and (
        not declared.isdecimal() or len(declared) > 10 or int(declared) > maximum
    ):
        raise HTTPException(status_code=413, detail="request_too_large")
    body = bytearray()
    async for part in request.stream():
        if len(body) + len(part) > maximum:
            raise HTTPException(status_code=413, detail="request_too_large")
        body.extend(part)
    if not body and allow_empty:
        return {}
    try:
        value = json.loads(
            body,
            object_pairs_hook=_no_duplicate_keys,
            parse_constant=_bounded_json_value,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid_json") from None
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="invalid_json")
    return value


def create_streaming_router(
    resolve_context: Callable[[Request], Awaitable[MediaContext]],
    resolve_evidence: Callable[[], MediaEvidence],
) -> APIRouter:
    sessions: dict[str, MediaSession] = {}
    owned_sessions: set[MediaSession] = set()
    drain_tasks: set[asyncio.Task] = set()
    session_lock = asyncio.Lock()
    inference_lock = asyncio.Lock()
    reserved_sessions = 0
    closing = False
    evidence: MediaEvidence | None = None
    instance_id: str | None = None
    # The enclosing app owns and opens the journal in its lifespan. Bind its
    # already-validated working state only after that parent startup completes.
    start_records: dict[str, dict] = {}
    ended_sessions: dict[str, dict] = {}
    # Retain failed offers' real peer connections for verified cleanup.
    orphans: dict[str, SmallWebRTCConnection] = {}

    def evidence_fenced() -> None:
        if evidence is None or evidence.poisoned:
            raise HTTPException(status_code=503, detail="media_evidence_unavailable")

    def persist(*, strict: bool = False) -> None:
        evidence_fenced()
        evidence.save(start_records, ended_sessions, strict=strict)

    def record_state(record: dict) -> str:
        # MediaEvidence already verified the historical owner's actual death;
        # acquiring a released journal lock alone never establishes this.
        if record.get("instance") != instance_id and record["state"] in ("creating", "live"):
            return "ended"
        return record["state"]

    def prune_evidence(now: float) -> None:
        # Only terminal evidence ages: ended receipts and tombstones are
        # bounded housekeeping. Creating and live records are never removed by
        # age — a wait_for cancellation does not prove a dead effect, so
        # unresolved evidence leaves the creating state only through verified
        # cleanup, media proof, or operator resolution on the gateway side.
        for start_id in [
            key for key, record in start_records.items()
            if record["state"] == "ended" and now - record["since"] > START_RECORD_TTL_SECONDS
        ]:
            del start_records[start_id]
        for pc_id in [
            key for key, tombstone in ended_sessions.items()
            if now - tombstone["since"] > ENDED_TOMBSTONE_SECONDS
        ]:
            del ended_sessions[pc_id]
        while len(start_records) > MAX_START_RECORDS:
            ended = [key for key, record in start_records.items() if record["state"] == "ended"]
            victim = min(ended or start_records.keys(), key=lambda key: start_records[key]["since"])
            del start_records[victim]
        while len(ended_sessions) > MAX_START_RECORDS:
            del ended_sessions[min(ended_sessions.keys(), key=lambda key: ended_sessions[key]["since"])]
        persist()

    def record_start(start_id: str, installation: str, state: str, now: float, *, pc_id=None, answer=None, strict: bool = False) -> dict:
        record = {"state": state, "installation": installation, "pc_id": pc_id, "answer": answer,
                  "since": now, "instance": instance_id}
        start_records[start_id] = record
        persist(strict=strict)
        return record

    @contextlib.asynccontextmanager
    async def lifespan(app):
        nonlocal closing, evidence, instance_id, start_records, ended_sessions
        evidence = resolve_evidence()
        instance_id = evidence.instance
        start_records = evidence.starts
        ended_sessions = evidence.tombstones
        closing = False
        try:
            yield
        finally:
            closing = True
            await asyncio.gather(*(session.hangup() for session in tuple(owned_sessions)))
            if drain_tasks:
                # Closed calls stay owned until their inference and original
                # pre-ACK cancellation have actually drained.
                await asyncio.gather(*tuple(drain_tasks))

    router = APIRouter(lifespan=lifespan)

    async def authorized_context(request: Request) -> MediaContext:
        try:
            context = await resolve_context(request)
        except HTTPException as error:
            status_code = (
                error.status_code
                if 400 <= error.status_code < 500
                else 403
            )
            raise HTTPException(
                status_code=status_code,
                detail="voice_context_invalid",
                headers=error.headers if status_code == error.status_code else None,
            ) from None
        except Exception:
            raise HTTPException(status_code=403, detail="voice_context_invalid") from None
        if not _valid_context(context):
            raise HTTPException(status_code=403, detail="voice_context_invalid")
        return context

    async def authorized_session(
        request: Request, pc_id: str
    ) -> tuple[MediaContext, MediaSession]:
        context = await authorized_context(request)
        if not isinstance(pc_id, str) or not pc_id or len(pc_id) > 128:
            raise HTTPException(status_code=404, detail="voice_session_not_found")
        session = sessions.get(pc_id)
        if session is None:
            raise HTTPException(status_code=404, detail="voice_session_not_found")
        if session.context.installation != context.installation:
            raise HTTPException(status_code=403, detail="voice_session_foreign")
        try:
            session.require_context(context)
        except MediaError as error:
            raise HTTPException(status_code=409, detail=str(error)) from None
        return context, session

    @router.get("/starts/{start_id}")
    async def observe_start(start_id: str, request: Request):
        evidence_fenced()
        context = await authorized_context(request)
        prune_evidence(time.time())
        record = start_records.get(start_id)
        if record is None:
            # Evidence is persisted before any offer effect, so absence for
            # this authenticated scope is trustworthy across restarts.
            raise HTTPException(status_code=404, detail="voice_start_unknown")
        if record["installation"] != context.installation:
            # A foreign record is not evidence that the caller's attempt ended.
            raise HTTPException(status_code=403, detail="voice_start_foreign")
        state = record_state(record)
        if state == "creating":
            raise HTTPException(status_code=409, detail="voice_offer_in_progress")
        return JSONResponse({"state": state, "pc_id": record["pc_id"]})

    @router.post("/offer")
    async def offer(request: Request):
        nonlocal reserved_sessions
        evidence_fenced()
        context = await authorized_context(request)
        body = await _bounded_json(request, MAX_OFFER_BYTES)
        if set(body) != {"sdp", "type", "start_id"}:
            raise HTTPException(status_code=400, detail="offer_fields_invalid")
        sdp = body.get("sdp")
        kind = body.get("type")
        start_id = body.get("start_id")
        if not isinstance(sdp, str) or not sdp or kind != "offer":
            raise HTTPException(status_code=400, detail="offer_invalid")
        if not isinstance(start_id, str) or INSTALLATION_PATTERN.fullmatch(start_id) is None:
            raise HTTPException(status_code=400, detail="offer_invalid")
        try:
            if len(sdp.encode("utf-8")) > MAX_OFFER_BYTES:
                raise HTTPException(status_code=413, detail="request_too_large")
        except UnicodeEncodeError:
            raise HTTPException(status_code=400, detail="offer_invalid") from None
        now = time.time()
        prune_evidence(now)
        try:
            async with session_lock:
                existing = start_records.get(start_id)
                if existing is not None:
                    if existing["installation"] != context.installation:
                        raise HTTPException(status_code=403, detail="voice_start_foreign")
                    state = record_state(existing)
                    if state == "creating":
                        raise HTTPException(status_code=409, detail="voice_offer_in_progress")
                    if state == "live":
                        # One start identity admits one session: replay the same
                        # answer. Only a same-instance live record can replay —
                        # restored evidence is provably dead and answers ended.
                        return JSONResponse(existing["answer"])
                    return JSONResponse({"state": "ended", "pc_id": existing["pc_id"]})
                if closing:
                    raise HTTPException(status_code=503, detail="media_shutting_down")
                if len(owned_sessions) + reserved_sessions >= MAX_ACTIVE_CALLS:
                    raise HTTPException(status_code=429, detail="voice_call_limit")
                reserved_sessions += 1
                # Strict: the pre-effect record must durably land before the
                # offer is forwarded; a broken journal refuses the call.
                record_start(start_id, context.installation, "creating", now, strict=True)
        except MediaEvidenceError:
            raise HTTPException(status_code=503, detail="media_evidence_unavailable") from None

        connection: SmallWebRTCConnection | None = None
        session: MediaSession | None = None
        offer_fenced = False
        try:
            connection = SmallWebRTCConnection(ice_servers=[], connection_timeout_secs=30)
            try:
                # Hard creation deadline. Cancellation alone does not prove a
                # dead effect: the timeout path below verifies cleanup before
                # touching the evidence record.
                await asyncio.wait_for(
                    connection.initialize(sdp=sdp, type=kind), timeout=OFFER_CREATION_SECONDS
                )
            except asyncio.TimeoutError:
                # Verify cleanup before deleting evidence: a cancelled
                # initialize may still have produced a live peer connection.
                learned = None
                with contextlib.suppress(Exception):
                    candidate = connection.get_answer()
                    if isinstance(candidate, dict) and isinstance(candidate.get("pc_id"), str) \
                            and candidate["pc_id"] and len(candidate["pc_id"]) <= 128:
                        learned = candidate["pc_id"]
                cleaned = False
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(connection.disconnect(), timeout=5)
                    cleaned = True
                record = start_records.get(start_id)
                if cleaned and learned is None:
                    # Verified: no peer exists, so the creating record is
                    # deleted and only the gateway's own pre-effect evidence
                    # remains, provable absent by the media service.
                    if record is not None and record["state"] == "creating":
                        del start_records[start_id]
                        persist()
                elif record is not None and record["state"] == "creating":
                    # Unknown cleanup or a learned peer: stay fenced, bind an
                    # actual pc_id if one was learned, and retain the peer so
                    # hangup performs real verified teardown.
                    offer_fenced = True
                    if learned is not None:
                        record["pc_id"] = learned
                        orphans[learned] = connection
                    persist()
                raise HTTPException(status_code=503, detail="voice_offer_unavailable") from None
            except Exception:
                raise HTTPException(status_code=400, detail="offer_invalid") from None
            answer = connection.get_answer()
            if (
                not isinstance(answer, dict)
                or set(answer) != {"sdp", "type", "pc_id"}
                or not isinstance(answer.get("sdp"), str)
                or len(answer["sdp"].encode("utf-8")) > MAX_OFFER_BYTES
                or answer.get("type") != "answer"
                or not isinstance(answer.get("pc_id"), str)
                or not answer["pc_id"]
                or len(answer["pc_id"]) > 128
            ):
                raise HTTPException(status_code=503, detail="voice_answer_unavailable")
            pc_id = answer["pc_id"]
            if closing:
                raise HTTPException(status_code=503, detail="media_shutting_down")

            def remove_session(identifier: str) -> None:
                if sessions.get(identifier) is session:
                    sessions.pop(identifier, None)
                    # Owner-bound ended evidence: a lost hangup response for
                    # this exact session can still be confirmed ended.
                    ended_sessions[identifier] = {
                        "installation": session.context.installation,
                        "target": {
                            "ghost_id": session.context.target.ghost_id,
                            "conversation_id": session.context.target.conversation_id,
                            "privacy": session.context.target.privacy,
                            "authority_epoch": session.context.target.authority_epoch,
                        },
                        "since": time.time(),
                    }
                    record = start_records.get(start_id)
                    if record is not None and record["state"] == "live":
                        record["state"] = "ended"
                        record["answer"] = None
                    persist()
                    task = asyncio.create_task(session.drain())
                    drain_tasks.add(task)

                    def drained(completed: asyncio.Task) -> None:
                        if not completed.cancelled() and completed.exception() is None:
                            drain_tasks.discard(completed)
                            owned_sessions.discard(session)

                    task.add_done_callback(drained)

            session = MediaSession(
                context, pc_id=pc_id, on_close=remove_session, inference_lock=inference_lock,
                start_id=start_id,
            )
            sessions[pc_id] = session
            owned_sessions.add(session)
            record = start_records.get(start_id)
            if record is not None and record["state"] == "creating":
                # Bind the answered peer before pipeline start so any failure
                # below leaves a hangup-able fence, never an unresolvable one.
                record["pc_id"] = pc_id
                persist(strict=True)
            try:
                await session.start(connection)
            except Exception:
                raise HTTPException(status_code=503, detail="media_pipeline_unavailable") from None
            record = start_records.get(start_id)
            if record is not None and record["state"] == "creating":
                record["state"] = "live"
                record["answer"] = answer
                persist(strict=True)
            return JSONResponse(answer)
        except asyncio.CancelledError:
            if session is not None:
                await session.hangup()
            elif connection is not None:
                with contextlib.suppress(Exception):
                    await connection.disconnect()
            raise
        except HTTPException:
            if session is not None:
                await session.hangup()
            elif connection is not None:
                with contextlib.suppress(Exception):
                    await connection.disconnect()
            record = start_records.get(start_id)
            if record is not None and record["state"] == "creating" and not offer_fenced:
                # Creation failed before any session existed and cleanup was
                # verified (direct 4xx paths): drop the record so only the
                # gateway's own pre-effect evidence remains, provable absent by
                # the media service.
                del start_records[start_id]
                persist()
            raise
        except Exception:
            if session is not None:
                await session.hangup()
            elif connection is not None:
                with contextlib.suppress(Exception):
                    await connection.disconnect()
            # Cleanup here cannot be verified beyond suppression: the record
            # keeps its bound pc (bound before pipeline start) and stays
            # fenced. The peer connection is retained so a later hangup of
            # this exact pc performs real verified teardown instead of the
            # route guessing closure.
            record = start_records.get(start_id)
            if connection is not None and record is not None and record["pc_id"] is not None:
                orphans[record["pc_id"]] = connection
                while len(orphans) > MAX_START_RECORDS:
                    oldest = next(iter(orphans))
                    with contextlib.suppress(Exception):
                        victim = orphans.pop(oldest)
                        await asyncio.wait_for(victim.disconnect(), timeout=5)
            raise HTTPException(status_code=503, detail="voice_offer_unavailable") from None
        finally:
            async with session_lock:
                reserved_sessions -= 1

    @router.patch("/sessions/{pc_id}/ice")
    async def add_ice_candidates(pc_id: str, request: Request):
        _, session = await authorized_session(request, pc_id)
        body = await _bounded_json(request, MAX_CONTROL_BYTES)
        if set(body) != {"candidates"} or not isinstance(body.get("candidates"), list):
            raise HTTPException(status_code=400, detail="ice_candidates_invalid")
        values = body["candidates"]
        if not values or len(values) > MAX_CANDIDATES:
            raise HTTPException(status_code=413, detail="ice_candidates_limit")
        candidates = []
        for value in values:
            if (
                not isinstance(value, dict)
                or set(value) != {"candidate", "sdp_mid", "sdp_mline_index"}
                or not isinstance(value.get("candidate"), str)
                or not isinstance(value.get("sdp_mid"), str)
                or len(value["sdp_mid"]) > 128
                or type(value.get("sdp_mline_index")) is not int
                or not 0 <= value["sdp_mline_index"] <= 16
            ):
                raise HTTPException(status_code=400, detail="ice_candidate_invalid")
            try:
                candidate_text = value["candidate"]
                if len(candidate_text.encode("utf-8")) > MAX_CANDIDATE_BYTES:
                    raise ValueError("candidate_size")
                candidate = candidate_from_sdp(candidate_text) if candidate_text else None
                if candidate is not None:
                    candidate.sdpMid = value["sdp_mid"]
                    candidate.sdpMLineIndex = value["sdp_mline_index"]
                candidates.append(candidate)
            except Exception:
                raise HTTPException(status_code=400, detail="ice_candidate_invalid") from None

        try:
            await session.add_ice_candidates(candidates)
        except MediaError as error:
            status_code = {
                "voice_session_not_found": 404,
                "ice_candidates_limit": 413,
            }.get(str(error), 400)
            raise HTTPException(status_code=status_code, detail=str(error)) from None
        return JSONResponse({"accepted": len(values)})

    @router.post("/sessions/{pc_id}/cancel_turn")
    async def cancel_turn(pc_id: str, request: Request):
        context, session = await authorized_session(request, pc_id)
        body = await _bounded_json(request, MAX_CONTROL_BYTES)
        if set(body) != {"turn_id"}:
            raise HTTPException(status_code=400, detail="turn_target_invalid")
        try:
            result = await session.cancel_turn(body["turn_id"], context.host, context)
        except MediaError as error:
            raise HTTPException(status_code=409, detail=str(error)) from None
        return JSONResponse(result)

    @router.post("/sessions/{pc_id}/hangup")
    async def hangup(pc_id: str, request: Request):
        context = await authorized_context(request)
        body = await _bounded_json(request, MAX_CONTROL_BYTES, allow_empty=True)
        if body:
            raise HTTPException(status_code=400, detail="hangup_body_invalid")
        if not isinstance(pc_id, str) or not pc_id or len(pc_id) > 128:
            raise HTTPException(status_code=404, detail="voice_session_not_found")
        session = sessions.get(pc_id)
        if session is not None:
            if session.context.installation != context.installation:
                raise HTTPException(status_code=403, detail="voice_session_foreign")
            try:
                session.require_context(context)
            except MediaError as error:
                raise HTTPException(status_code=409, detail=str(error)) from None
            await session.hangup()
            return JSONResponse({"state": "ended"})
        prune_evidence(time.time())
        tombstone = ended_sessions.get(pc_id)
        if tombstone is not None and tombstone["installation"] == context.installation:
            # Idempotent end of the same historically owned terminal session.
            return JSONResponse({"state": "ended", "already_ended": True})
        # Verified teardown of an orphaned peer retained after a failed offer:
        # disconnect completing IS the proof of end; failure stays unknown.
        orphan = orphans.get(pc_id)
        if orphan is not None:
            try:
                await asyncio.wait_for(orphan.disconnect(), timeout=10)
            except Exception:
                raise HTTPException(
                    status_code=502, detail="voice_media_unavailable_or_outcome_unknown"
                ) from None
            orphans.pop(pc_id, None)
            for record in start_records.values():
                if record["pc_id"] == pc_id and record["state"] != "ended":
                    record["state"] = "ended"
                    record["answer"] = None
            persist()
            return JSONResponse({"state": "ended", "already_ended": True})
        # A previous owner's nonterminal record with this pc is provably dead:
        # this process holds the exclusive journal lock that owner held for
        # its lifetime. Reconcile the exact pc without rerunning anything.
        for record in start_records.values():
            if record["pc_id"] == pc_id and record.get("instance") != instance_id \
                    and record["installation"] == context.installation \
                    and record["state"] != "ended":
                record["state"] = "ended"
                record["answer"] = None
                persist()
                return JSONResponse({"state": "ended", "already_ended": True})
        raise HTTPException(status_code=404, detail="voice_session_not_found")
    return router
