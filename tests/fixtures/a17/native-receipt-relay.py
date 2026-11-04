#!/usr/bin/python3
"""Observe real native stdio; drop exactly one actual committed ingest ACK.

No engine result, write outcome, or database row is synthesized. A caller-owned
supervisor reaps the native child even if BrainClient kills its relay wrapper.
Credentials, request content, auth frames and raw native errors are never logged.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

state = Path(os.environ["GHOST_A17_RELAY_STATE"])
relay_pid = os.getpid()


def event(kind, **fields):
    encoded = (json.dumps({"event": kind, "relay_pid": relay_pid,
                          "supervisor_pid": os.getpid(), **fields}) + "\n").encode()
    descriptor = os.open(state / "events.jsonl", os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, encoded)
    finally:
        os.close(descriptor)


def wait_gate(prefix, nonce):
    deadline = time.monotonic() + 15
    while not (state / (prefix + nonce)).exists():
        if time.monotonic() >= deadline:
            event("native_test_gate_expired", gate=prefix, attempt_nonce=nonce)
            raise TimeoutError("bounded test fault gate expired")
        time.sleep(0.01)


def episode_id(value):
    return (isinstance(value, str) and len(value) == 64
            and all(c in "0123456789abcdef" for c in value))


def dropped_episode_ids():
    # Only prior real native ACK-drop receipts supply expected IDs. Never read
    # a store or infer an episode from content equality or a fixture counter.
    try:
        with (state / "events.jsonl").open("rb") as stream:
            data = stream.read(65537)
        if len(data) > 65536:
            return set()
        values = [json.loads(line) for line in data.splitlines()]
        return {value["episode_id"] for value in values
                if value.get("event") == "native_committed_ack_dropped" and episode_id(value.get("episode_id"))}
    except (OSError, ValueError, KeyError, TypeError):
        return set()


def observe_recovery_response(request, response):
    """Safe shape observations only; never alter a request or engine frame."""
    params = request.get("params", {})
    recall = request.get("method") == "tools/call" and params.get("name") == "recall"
    uri = params.get("uri")
    resource = request.get("method") == "resources/read" and isinstance(uri, str) and uri.startswith("episode://")
    if not recall and not resource:
        return
    kind = "native_recall_observation" if recall else "native_episode_resource_observation"
    try:
        result = response.get("result", {})
        failed = "error" in response or result.get("isError") is True
        expected = dropped_episode_ids()
        if recall:
            counts = {name: 0 for name in ("bareid", "episodeURI", "sessionURI", "docURI", "malformed")}
            facts = {"status": "error" if failed else "success", "layer_count": None,
                     "provenance_kinds": counts, "provenance_capped": False,
                     "expected_context_available": bool(expected),
                     "bareid_matches_expected": False if expected else None,
                     "episodeURI_matches_expected": False if expected else None}
            if not failed:
                text = next(item["text"] for item in result.get("content", []) if isinstance(item.get("text"), str))
                envelope = json.loads(text)
                layers = envelope.get("data", {}).get("layers")
                facts["layer_count"] = len(layers) if isinstance(layers, list) else None
                examined = 0
                for layer in layers if isinstance(layers, list) else []:
                    provenance = layer.get("provenance", []) if isinstance(layer, dict) else []
                    for reference in provenance if isinstance(provenance, list) else []:
                        if examined >= 256:
                            facts["provenance_capped"] = True
                            break
                        examined += 1
                        candidate = reference[10:] if isinstance(reference, str) and reference.startswith("episode://") else None
                        if episode_id(reference):
                            counts["bareid"] += 1
                            if expected and reference in expected:
                                facts["bareid_matches_expected"] = True
                        elif episode_id(candidate):
                            counts["episodeURI"] += 1
                            if expected and candidate in expected:
                                facts["episodeURI_matches_expected"] = True
                        elif isinstance(reference, str) and reference.startswith("session://"):
                            counts["sessionURI"] += 1
                        elif isinstance(reference, str) and reference.startswith(("doc://", "document://")):
                            counts["docURI"] += 1
                        else:
                            counts["malformed"] += 1
                    if facts["provenance_capped"]:
                        break
            event(kind, **facts)
        else:
            requested = uri[10:].split("?", 1)[0]
            facts = {"status": "error" if failed else "success", "expected_context_available": bool(expected),
                     "requested_id_valid": episode_id(requested),
                     "requested_id_matches_expected": requested in expected if expected else None,
                     "returned_id_matches_requested": None, "returned_id_matches_expected": None}
            if not failed:
                contents = result.get("contents", [])
                text = next(item["text"] for item in contents if isinstance(item.get("text"), str))
                returned = json.loads(text).get("id")
                facts["returned_id_matches_requested"] = episode_id(requested) and returned == requested
                facts["returned_id_matches_expected"] = returned in expected if expected and isinstance(returned, str) else None
            event(kind, **facts)
    except Exception:
        # Diagnostic parsing cannot replace native behavior or expose raw data.
        event(kind, status="diagnostic_shape_unavailable")


def native_session(lifeline):
    with tempfile.TemporaryFile() as diagnostic:
        child = subprocess.Popen(
            [os.environ["GHOST_A17_NATIVE_BINARY"], *sys.argv[1:]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostic,
        )
        event("native_started", native_pid=child.pid)
        cleanup = threading.Lock()
        reaped = False

        def reap():
            nonlocal reaped
            with cleanup:
                if reaped:
                    return
                event("native_cleanup_started", native_pid=child.pid)
                try:
                    child.stdin.close()
                except BrokenPipeError:
                    pass
                try:
                    code = child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    event("native_terminate_requested", native_pid=child.pid)
                    child.terminate()
                    try:
                        code = child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        event("native_kill_requested", native_pid=child.pid)
                        child.kill()
                        code = child.wait(timeout=2)
                event("native_reaped", native_pid=child.pid, exit_code=code)
                reaped = True

        def parent_gone():
            # Only the BrainClient-owned wrapper holds the write endpoint.
            # SIGKILL of that wrapper closes this lifeline as well.
            os.read(lifeline, 1)
            event("relay_owner_closed", native_pid=child.pid)
            reap()
            os._exit(0)

        threading.Thread(target=parent_gone, daemon=True).start()

        def stop_stalled_native():
            if child.poll() is None:
                event("native_watchdog_expired", native_pid=child.pid)
                reap()

        watchdog = threading.Timer(45, stop_stalled_native)
        watchdog.daemon = True
        watchdog.start()
        authenticated = False
        try:
            for line in sys.stdin.buffer:
                request = json.loads(line)
                ingest = request.get("method") == "tools/call" and request.get("params", {}).get("name") == "ingest"
                if ingest:
                    args = request["params"]["arguments"]
                    request_proof = request["params"].get("_meta", {}).get("oxibrain.episode_write_request", {})
                    attempt_nonce = request_proof.get("attempt_nonce")
                    observed_nonce = attempt_nonce if (isinstance(attempt_nonce, str) and len(attempt_nonce) == 32
                                                       and all(c in "0123456789abcdef" for c in attempt_nonce)) else None
                    gate_ingest = (state / "collision-phase").exists()
                    if gate_ingest:
                        if observed_nonce is None or not authenticated:
                            raise ValueError("collision request lacks authenticated native attempt identity")
                        # Auth, handshake, scope and tool discovery have already
                        # completed. No startup lock is held by a Brain handle.
                        event("native_ingest_ready", source_locator=args["source_path"],
                              attempt_nonce=observed_nonce, authenticated=True,
                              content_sha256=hashlib.sha256(args["content"].encode()).hexdigest())
                        wait_gate("forward-ingest-", observed_nonce)
                    event("ingest_forwarded", source_locator=args["source_path"],
                          attempt_nonce=observed_nonce,
                          content_sha256=hashlib.sha256(args["content"].encode()).hexdigest())
                try:
                    pending = memoryview(line)
                    while pending:
                        pending = pending[os.write(child.stdin.fileno(), pending):]
                except OSError:
                    return
                while True:
                    response_line = child.stdout.readline()
                    if not response_line:
                        return
                    response = json.loads(response_line)
                    matched = response.get("id") == request.get("id")
                    if matched:
                        try:
                            observe_recovery_response(request, response)
                        except Exception:
                            pass  # Optional diagnostics must not alter native transport.
                    if matched and request.get("method") == "auth":
                        authenticated = response.get("result", {}).get("authenticated") is True
                    if matched and ingest:
                        result = response.get("result", {})
                        proof = result.get("_meta", {}).get("oxibrain.episode_write", {})
                        known_busy = False
                        if (result.get("isError") is True and proof.get("version") == "oxibrain.episode-write/1"
                                and proof.get("tool") == "ingest" and proof.get("status") == "episode_not_committed"
                                and proof.get("reason") == "writer_busy"
                                and request_proof.get("version") == "oxibrain.episode-write/1"
                                and isinstance(attempt_nonce, str) and len(attempt_nonce) == 32
                                and all(c in "0123456789abcdef" for c in attempt_nonce)
                                and proof.get("attempt_nonce") == attempt_nonce
                                and proof.get("phase") in ("source_registration", "episode_writer_acquire")
                                and proof.get("episode_id") is None
                                and proof.get("source", {}).get("kind") == "note"
                                and proof["source"].get("source_path") == args["source_path"]):
                            observed = {key: proof.get(key) for key in (
                                "version", "tool", "status", "reason", "phase", "space", "space_id",
                                "request_digest", "content_digest", "episode_id", "attempt_nonce")}
                            observed["source"] = {key: proof["source"].get(key) for key in (
                                "kind", "source_path", "occurrence_id")}
                            event("native_ingest_not_committed_locked", source_locator=args["source_path"],
                                  request_attempt_nonce=attempt_nonce, proof=observed)
                            known_busy = True
                        if gate_ingest:
                            # Hold the real native frame until the fixture has
                            # released its lock. finish_source's next fresh auth
                            # may itself briefly need the native writer lock.
                            event("native_ingest_outcome_held", source_locator=args["source_path"],
                                  attempt_nonce=observed_nonce, known_busy=known_busy,
                                  tool_error=result.get("isError") is True)
                            wait_gate("return-outcome-", observed_nonce)
                        texts = [item.get("text", "") for item in result.get("content", [])]
                        episodes = [value.removeprefix("Ingested as episode: ").strip()
                                    for value in texts if value.startswith("Ingested as episode: ")]
                        if result.get("isError") is not True and len(episodes) == 1:
                            episode = episodes[0]
                            if len(episode) != 64 or any(c not in "0123456789abcdef" for c in episode):
                                raise ValueError("native commit receipt unavailable")
                            if (state / "drop-next-ingest-ack").exists():
                                os.rename(state / "drop-next-ingest-ack", state / "ingest-ack-dropped")
                                event("native_committed_ack_dropped", episode_id=episode, source_locator=args["source_path"], attempt_nonce=observed_nonce)
                                reap()
                                return
                            event("native_ingest_committed", episode_id=episode, source_locator=args["source_path"], attempt_nonce=observed_nonce)
                    # Every forwarded engine frame is byte-for-byte original.
                    sys.stdout.buffer.write(response_line)
                    sys.stdout.buffer.flush()
                    if matched:
                        break
        finally:
            watchdog.cancel()
            reap()


read_lifeline, write_lifeline = os.pipe()
supervisor = os.fork()
if supervisor:
    os.close(read_lifeline)
    # The wrapper never handles protocol frames. Its child owns the native
    # process and detects abrupt wrapper death through the separate pipe.
    _, status = os.waitpid(supervisor, 0)
    os.close(write_lifeline)
    sys.exit(os.waitstatus_to_exitcode(status))
os.close(write_lifeline)
native_session(read_lifeline)
os.close(read_lifeline)
