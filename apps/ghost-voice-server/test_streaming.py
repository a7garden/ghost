import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.transports.smallwebrtc.transport import RawAudioTrack

from streaming import (
    MAX_AUDIO_FRAME_BYTES,
    MAX_CANDIDATES,
    MAX_TEXT_BYTES,
    SAMPLE_RATE,
    PLAYBACK_RATE,
    ConversationTarget,
    MediaContext,
    MediaError,
    MediaEvidence,
    MediaEvidenceError,
    MediaSession,
    VoiceTurn,
    _AudioSegmenter,
    _valid_context,
    create_streaming_router,
)


class FakeSpeech:
    def __init__(self):
        self.tts_calls = 0

    def transcribe(self, data, language, cancelled):
        return {"text": "unused"}

    def iter_synthesize(self, text, voice, language, cancelled):
        self.tts_calls += 1
        return iter(())


class FakeHost:
    def __init__(self, state="effect_unknown", advisory=None):
        self.state = state
        self.advisory = advisory
        self.block_submit = False
        self.submit_started = asyncio.Event()
        self.submit_release = asyncio.Event()
        self.submissions = []
        self.cancellations = []
        self.inspect_calls = []

    async def submit(self, target, text, command_id):
        self.submissions.append((target, text, command_id))
        self.submit_started.set()
        if self.block_submit:
            await self.submit_release.wait()
        return VoiceTurn(
            command_id,
            target.ghost_id,
            target.conversation_id,
            self.state,
            self.advisory if self.state == "answered" else None,
        )

    async def inspect(self, target, turn_id):
        self.inspect_calls.append((target, turn_id))
        return VoiceTurn(
            turn_id, target.ghost_id, target.conversation_id, self.state,
            self.advisory if self.state == "answered" else None,
        )

    async def cancel(self, target, turn_id, command_id):
        self.cancellations.append((target, turn_id, command_id))
        self.state = "cancelled"
        return VoiceTurn(turn_id, target.ghost_id, target.conversation_id, "cancelled")


class FakeAuthority:
    def __init__(self, result=True):
        self.result = result
        self.calls = []

    async def __call__(self, installation, start_id):
        self.calls.append((installation, start_id))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class FakeOutput:
    def __init__(self):
        self.interruptions = 0
        self._audio_output_track = RawAudioTrack(PLAYBACK_RATE)
        self._client = self

    def output(self):
        return self

    async def queue_frame(self, frame, direction, callback=None):
        self.interruptions += 1
        if callback is not None:
            await callback(self, frame, direction)


class FakeConnection:
    pc_id = "test-pc"

    def is_connected(self):
        return True


class StreamingBehaviorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.target = ConversationTarget("ghost-a", "conversation-a", "local_only", 1)
        self.host = FakeHost()
        self.speech = FakeSpeech()
        self.context = MediaContext(self.target, self.host, self.speech)
        self.session = MediaSession(self.context)

    async def asyncTearDown(self):
        await self.session.hangup()
        await self.session.drain()

    async def test_hangup_drain_waits_for_inference_without_abandoning_it(self):
        entered, release = threading.Event(), threading.Event()
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        def inference():
            entered.set()
            release.wait(5)
            return b"synthetic inference result"

        task = asyncio.create_task(self.session._inference_call(record, inference))
        record.task = task
        self.session._track_task(self.session._turn_tasks, task)
        drain = None
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            await self.session.hangup()
            drain = asyncio.create_task(self.session.drain())
            await asyncio.sleep(0)
            self.assertFalse(drain.done())
            self.assertFalse(task.done())
            release.set()
            await asyncio.wait_for(drain, 2)
            self.assertTrue(task.done())
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            if drain is not None:
                await asyncio.gather(drain, return_exceptions=True)

    async def test_answered_turn_waits_for_committed_advisory_before_pcm_playback(self):
        class PcmSpeech(FakeSpeech):
            def iter_synthesize(self, text, voice, language, cancelled):
                yield (b"\xd2\x04" * 240, PLAYBACK_RATE)

        self.host.state = "answered"
        self.session.context = MediaContext(self.target, self.host, PcmSpeech())
        self.session.transport = FakeOutput()
        self.session.connection = FakeConnection()
        self.session._connected = True
        self.session._pipeline_ready.set()
        await self.session._voice_started(1)
        record = next(iter(self.session._records_by_speech.values()))

        async def receive_audible_frame():
            while True:
                frame = await self.session.transport._audio_output_track.recv()
                if frame.to_ndarray().any():
                    return frame

        receiver = asyncio.create_task(receive_audible_frame())
        submit = asyncio.create_task(self.session._submit_final_text(record, "Synthetic transcript"))
        try:
            await asyncio.wait_for(self.host.submit_started.wait(), 1)
            self.assertFalse(submit.done())
            self.assertFalse(receiver.done())
            self.host.advisory = "Committed synthetic advisory"
            await asyncio.wait_for(submit, 2)
            await asyncio.wait_for(receiver, 2)
            self.assertEqual(record.phase, "done")
            self.assertEqual(len(self.host.submissions), 1)
        finally:
            submit.cancel()
            receiver.cancel()
            await asyncio.gather(submit, receiver, return_exceptions=True)

    async def test_barge_before_submit_ack_cancels_original_command_only(self):
        self.host.state = "queued"
        self.host.block_submit = True
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        submit = asyncio.create_task(self.session._submit_final_text(record, "continue"))
        await asyncio.wait_for(self.host.submit_started.wait(), timeout=1)
        self.assertTrue(await self.session._voice_started(2))
        self.host.submit_release.set()
        await asyncio.wait_for(submit, timeout=1)

        self.assertEqual(len(self.host.submissions), 1)
        self.assertEqual(
            self.host.cancellations,
            [(self.target, record.command_id, record.cancel_command_id)],
        )
        self.assertEqual(record.owner_turn.state, "cancelled")

    async def test_late_audio_chunk_is_fenced_by_playback_epoch(self):
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))
        record.phase = "answered"
        record.owner_turn = VoiceTurn(
            record.command_id, self.target.ghost_id, self.target.conversation_id, "answered", "advisory"
        )
        self.session._playback_record = record
        self.session.transport = FakeOutput()
        self.session.connection = FakeConnection()
        self.session._connected = True
        self.session._pipeline_ready.set()
        output_track = self.session.transport._audio_output_track
        completion = output_track.add_audio_bytes(bytes(PLAYBACK_BYTES * 2))
        self.assertEqual(len(output_track._chunk_queue), 2)
        old_epoch = self.session.playback_epoch

        await self.session._voice_started(2)
        sent = await self.session._send_audio_frame(
            record, old_epoch, bytes(PLAYBACK_BYTES), PLAYBACK_RATE
        )

        self.assertFalse(sent)
        self.assertEqual(self.session.transport.interruptions, 1)
        self.assertEqual(len(output_track._chunk_queue), 0)
        self.assertTrue(completion.cancelled())

    async def test_stale_target_cannot_cancel_a_turn(self):
        record = self.session._new_record(1)
        record.owner_turn = VoiceTurn(
            record.command_id, self.target.ghost_id, self.target.conversation_id, "queued"
        )
        stale = MediaContext(
            ConversationTarget("ghost-a", "conversation-a", "local_only", 2),
            self.host,
            self.speech,
        )

        with self.assertRaisesRegex(MediaError, "voice_context_changed"):
            await self.session.cancel_turn(record.command_id, self.host, stale)

        self.assertEqual(self.host.cancellations, [])
        foreign = MediaContext(
            ConversationTarget("ghost-b", "conversation-b", "local_only", 1),
            self.host,
            self.speech,
        )
        with self.assertRaisesRegex(MediaError, "voice_context_changed"):
            self.session.require_context(foreign)

    async def test_ice_candidates_are_bounded_per_session(self):
        class FakePeer:
            def __init__(inner):
                inner.accepted = 0

            async def addIceCandidate(inner, candidate):
                inner.accepted += 1

        class FakeIceConnection:
            def __init__(inner):
                inner.pc = FakePeer()

        connection = FakeIceConnection()
        self.session.connection = connection
        await self.session.add_ice_candidates([object() for _ in range(MAX_CANDIDATES)])

        self.assertEqual(connection.pc.accepted, MAX_CANDIDATES)
        with self.assertRaisesRegex(MediaError, "ice_candidates_limit"):
            await self.session.add_ice_candidates([object()])
        self.assertEqual(connection.pc.accepted, MAX_CANDIDATES)

    async def test_hangup_does_not_cancel_durable_owner_work(self):
        record = self.session._new_record(1)
        record.owner_turn = VoiceTurn(
            record.command_id, self.target.ghost_id, self.target.conversation_id, "running"
        )

        await self.session.hangup()

        self.assertEqual(self.host.cancellations, [])
        self.assertEqual(record.owner_turn.state, "running")

    async def test_unknown_host_outcome_never_synthesizes_success(self):
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        await self.session._submit_final_text(record, "question")

        self.assertEqual(record.phase, "effect_unknown")
        self.assertEqual(self.speech.tts_calls, 0)
        self.assertEqual(self.host.submissions[0][2], record.command_id)

    async def test_foreign_host_turn_is_rejected_without_speech(self):
        class ForeignHost(FakeHost):
            async def submit(inner, target, text, command_id):
                inner.submissions.append((target, text, command_id))
                return VoiceTurn(command_id, "foreign-ghost", target.conversation_id, "answered", "text")

        self.host = ForeignHost()
        self.session = MediaSession(
            MediaContext(self.target, self.host, self.speech)
        )
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        await self.session._submit_final_text(record, "question")

        self.assertEqual(record.phase, "effect_unknown")
        self.assertEqual(self.speech.tts_calls, 0)

    async def test_installation_identity_fences_every_context_use(self):
        identity = str(uuid.uuid4())
        session = MediaSession(MediaContext(self.target, self.host, self.speech, installation=identity))
        try:
            session.require_context(MediaContext(self.target, self.host, self.speech, installation=identity))
            with self.assertRaisesRegex(MediaError, "voice_context_changed"):
                session.require_context(MediaContext(self.target, self.host, self.speech, installation=str(uuid.uuid4())))
            with self.assertRaisesRegex(MediaError, "voice_context_changed"):
                session.require_context(MediaContext(self.target, self.host, self.speech))
        finally:
            await session.hangup()

    async def test_revoked_authority_blocks_host_submission_before_dispatch(self):
        authority = FakeAuthority(result=False)
        start = str(uuid.uuid4())
        self.session = MediaSession(MediaContext(
            self.target, self.host, self.speech, installation=str(uuid.uuid4()), authority=authority
        ), start_id=start)
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        await self.session._submit_final_text(record, "question")

        self.assertEqual(self.host.submissions, [])
        self.assertEqual(record.phase, "failed")
        self.assertEqual(authority.calls, [(self.session.installation, start)])

    async def test_unknown_authority_stays_unknown_without_dispatch(self):
        authority = FakeAuthority(result=RuntimeError("gateway unreachable"))
        self.session = MediaSession(MediaContext(
            self.target, self.host, self.speech, installation=str(uuid.uuid4()), authority=authority
        ), start_id=str(uuid.uuid4()))
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        await self.session._submit_final_text(record, "question")

        self.assertEqual(self.host.submissions, [])
        self.assertEqual(record.phase, "effect_unknown")
        self.assertEqual(self.speech.tts_calls, 0)

    async def test_authority_lost_after_submit_stops_before_playback(self):
        class FlipAfterSubmit:
            def __init__(self):
                self.calls = 0

            async def __call__(self, installation, start_id):
                self.calls += 1
                return self.calls < 2  # pre-dispatch True, post-submit revoked

        class PcmSpeech(FakeSpeech):
            def __init__(self):
                super().__init__()

            def iter_synthesize(self, text, voice, language, cancelled):
                raise AssertionError("playback must never start for a revoked device")

        self.host.state = "answered"
        self.host.advisory = "Committed synthetic advisory"
        authority = FlipAfterSubmit()
        self.session = MediaSession(MediaContext(
            self.target, self.host, PcmSpeech(), installation=str(uuid.uuid4()), authority=authority
        ))
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        await self.session._submit_final_text(record, "question")

        # The submission stands (durable owner turn) but no audio effect runs
        # and the session tears down instead of playing to a revoked device.
        self.assertEqual(len(self.host.submissions), 1)
        self.assertIsNotNone(record.owner_turn)
        self.assertEqual(record.phase, "answered")

    async def test_oversized_audio_and_text_are_rejected_before_host_submit(self):
        segmenter = _AudioSegmenter()
        frame = InputAudioRawFrame(
            audio=bytes(MAX_AUDIO_FRAME_BYTES + 2),
            sample_rate=SAMPLE_RATE,
            num_channels=1,
        )
        with self.assertRaisesRegex(MediaError, "audio_frame_invalid"):
            segmenter.feed(frame)

        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))
        await self.session._submit_final_text(record, "x" * (MAX_TEXT_BYTES + 1))

        self.assertEqual(self.host.submissions, [])

    async def test_audio_segment_enforces_total_byte_bound(self):
        segmenter = _AudioSegmenter(sample_rate=48_000)
        loud_frame = InputAudioRawFrame(
            audio=b"\xe8\x03" * (MAX_AUDIO_FRAME_BYTES // 2),
            sample_rate=48_000,
            num_channels=1,
        )
        update = None
        for _ in range(80):
            update = segmenter.feed(loud_frame)

        self.assertIsNotNone(update)
        self.assertEqual(update.overflowed_sequence, 1)
        self.assertTrue(segmenter._discard_until_silence)

    async def test_duplicate_final_event_keeps_one_immutable_host_command(self):
        self.assertTrue(await self.session._voice_started(1))
        record = next(iter(self.session._records_by_speech.values()))

        await self.session._submit_final_text(record, "same text")
        await self.session._submit_final_text(record, "same text")

        self.assertEqual(len(self.host.submissions), 1)
        self.assertEqual(self.host.submissions[0][2], record.command_id)


PLAYBACK_BYTES = 24_000 * 2 // 100


class MediaEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "media-evidence.json")

    def test_second_live_owner_is_rejected(self):
        first = MediaEvidence(self.path)
        self.addCleanup(first.close)
        with self.assertRaisesRegex(MediaEvidenceError, "media_evidence_owner_alive"):
            MediaEvidence(self.path)

    def test_released_lock_does_not_prove_owner_death(self):
        first = MediaEvidence(self.path)
        start = str(uuid.uuid4())
        first.starts[start] = {
            "state": "live", "installation": str(uuid.uuid4()), "pc_id": "pc#1",
            "since": time.time(), "instance": first.instance,
        }
        first.save(first.starts, first.tombstones)
        first.close()
        with self.assertRaisesRegex(MediaEvidenceError, "media_evidence_owner_alive"):
            MediaEvidence(self.path)

    def test_restored_evidence_preserves_binding_after_actual_owner_exit(self):
        code = """
import sys, time, uuid
from streaming import MediaEvidence
evidence = MediaEvidence(sys.argv[1])
start = str(uuid.uuid4())
evidence.starts[start] = {
    "state": "live", "installation": str(uuid.uuid4()), "pc_id": "pc#1",
    "since": time.time(), "instance": evidence.instance,
}
evidence.save(evidence.starts, evidence.tombstones, strict=True)
print(start, flush=True)
"""
        result = subprocess.run(
            [sys.executable, "-c", code, self.path],
            cwd=os.path.dirname(__file__),
            capture_output=True, text=True, check=True, timeout=15,
        )
        restored = MediaEvidence(self.path)
        self.addCleanup(restored.close)
        self.assertEqual(restored.starts[result.stdout.strip()]["pc_id"], "pc#1")

    def test_corrupt_or_unknown_schema_fails_closed(self):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        with self.assertRaises(MediaEvidenceError):
            MediaEvidence(self.path)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"version": 99, "instance": "x", "pid": 1, "birth": 1.0}, handle)
        with self.assertRaises(MediaEvidenceError):
            MediaEvidence(self.path)

    def test_external_change_or_loss_poisons_instead_of_erasing(self):
        evidence = MediaEvidence(self.path)
        evidence.save(evidence.starts, evidence.tombstones)
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(" ")
        with self.assertRaises(MediaEvidenceError):
            evidence.save(evidence.starts, evidence.tombstones, strict=True)
        self.assertTrue(evidence.poisoned)
        os.unlink(self.path)
        with self.assertRaises(MediaEvidenceError):
            evidence.save(evidence.starts, evidence.tombstones, strict=True)

    def test_replaced_lock_refuses_new_effect_without_overwriting_journal(self):
        evidence = MediaEvidence(self.path)
        self.addCleanup(evidence.close)
        with open(self.path, "rb") as handle:
            original = handle.read()
        os.rename(evidence.lock_path, evidence.lock_path + ".original")
        fd = os.open(evidence.lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        with self.assertRaises(MediaEvidenceError):
            evidence.save(evidence.starts, evidence.tombstones, strict=True)
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read(), original)


class ContextAdmissionTests(unittest.TestCase):
    def test_admission_requires_a_canonical_device_installation_identity(self):
        target = ConversationTarget("ghost-a", "conversation-a", "local_only", 1)
        canonical = str(uuid.uuid4())
        for installation, expected in [
            ("", False),
            ("short", False),
            (canonical.upper(), False),
            (canonical.replace("-", ""), False),
            (canonical, True),
        ]:
            context = MediaContext(target, FakeHost(), FakeSpeech(), installation=installation,
                                   authority=FakeAuthority())
            self.assertEqual(_valid_context(context), expected, installation)

    def test_admission_requires_a_live_authority_callback(self):
        target = ConversationTarget("ghost-a", "conversation-a", "local_only", 1)
        context = MediaContext(target, FakeHost(), FakeSpeech(),
                               installation=str(uuid.uuid4()))
        self.assertFalse(_valid_context(context))


class MediaRouterOwnershipTests(unittest.TestCase):
    def test_foreign_start_is_not_reported_as_trustworthy_absence(self):
        owner, foreign, start = (str(uuid.uuid4()) for _ in range(3))
        target = ConversationTarget("ghost-a", "conversation-a", "local_only", 1)
        state = {}
        with tempfile.TemporaryDirectory() as directory:
            @asynccontextmanager
            async def lifespan(app):
                evidence = MediaEvidence(os.path.join(directory, "starts.json"))
                evidence.starts[start] = {
                    "state": "ended", "installation": owner, "pc_id": "pc#owned",
                    "since": time.time(), "instance": evidence.instance,
                }
                evidence.save(evidence.starts, evidence.tombstones, strict=True)
                state["evidence"] = evidence
                try:
                    yield
                finally:
                    evidence.close()

            async def context(request):
                return MediaContext(target, FakeHost(), FakeSpeech(),
                    installation=request.headers["X-Ghost-Media-Device"], authority=FakeAuthority())

            app = FastAPI(lifespan=lifespan)
            app.include_router(create_streaming_router(context, lambda: state["evidence"]))
            with TestClient(app) as client:
                denied = client.get(f"/starts/{start}", headers={"X-Ghost-Media-Device": foreign})
                self.assertEqual(denied.status_code, 403)
                self.assertEqual(denied.json(), {"detail": "voice_start_foreign"})
                observed = client.get(f"/starts/{start}", headers={"X-Ghost-Media-Device": owner})
                self.assertEqual(observed.json(), {"state": "ended", "pc_id": "pc#owned"})
                missing = client.get(f"/starts/{uuid.uuid4()}", headers={"X-Ghost-Media-Device": owner})
                self.assertEqual(missing.status_code, 404)
                self.assertEqual(missing.json(), {"detail": "voice_start_unknown"})
                self.assertEqual(state["evidence"].starts[start]["installation"], owner)
                self.assertEqual(state["evidence"].starts[start]["pc_id"], "pc#owned")


if __name__ == "__main__":
    unittest.main()
