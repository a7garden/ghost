#!/usr/bin/env python3
"""Read-only legacy execution inventory; never authorizes or performs cutover."""
import argparse
import hashlib
import json
import os
import sqlite3
import stat
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def snapshot(path):
    path = Path(path).absolute()
    if path.is_symlink() or not path.is_file():
        raise ValueError("journal must be an existing regular non-symlink file")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        yield connection
    finally:
        connection.close()


def has_table(connection, name):
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


# The legacy worker wrapped these exact failures with the same generic code
# used for cleanup-unknown. Review the sites before expanding the allowlist.
KNOWN_PRESPAWN_FAILURES = {
    "another execution has an active or revoked process or collection reservation",
    "computer backend is unavailable, downgraded, or lacks accepted home capabilities",
    "credentialless Linux OMP guest launch failed: guest runtime configuration rejected",
    "tool_scope_rejected",
}


def terminal_evidence(db, item):
    execution = item["execution_id"]
    row = db.execute(
        "SELECT pid,process_group,process_start_identity,prompt_intent,prompt_acknowledged,authority_epoch,spec_json,spec_digest "
        "FROM executions WHERE execution_id=?", (execution,)
    ).fetchone()
    spec = json.loads(row["spec_json"])
    if (canonical_digest(spec) != row["spec_digest"] or spec["execution_id"] != execution
            or spec["authority_epoch"] != row["authority_epoch"]):
        return None
    binding = {"worker_epoch": row["authority_epoch"], "admitted_work_id": spec["work_id"],
               "admitted_revision": spec["work_revision"], "worker_spec_sha256": row["spec_digest"]}
    events = db.execute(
        "SELECT sequence,kind FROM events WHERE execution_id=? ORDER BY sequence", (execution,)
    ).fetchall()
    kinds = [event["kind"] for event in events]
    last = item["last_sequence"]
    ack = item["acknowledged_sequence"]
    if not events or events[-1]["sequence"] != last or not 0 <= ack <= last:
        return None
    if (any(not 1 <= event["sequence"] <= last for event in events)
            or sum(event["sequence"] > ack for event in events) != last - ack):
        return None
    if (item["state"] == "failed" and item["process_exited"] == item["collected"] == 0
            and list(row)[:5] == [None, None, None, 0, 0]
            and kinds in (["admitted", "process_starting", "runner_failure"], ["admitted", "runner_failure"])
            and ack == 0
            and not db.execute("SELECT 1 FROM tool_receipts WHERE execution_id=?", (execution,)).fetchone()):
        failure = json.loads(db.execute(
            "SELECT payload_json FROM events WHERE execution_id=? AND sequence=?", (execution, last)
        ).fetchone()[0])
        if (failure["error_code"] == "worker_actor_failed"
                and failure["detail"] in KNOWN_PRESPAWN_FAILURES):
            binding["terminal_evidence"] = "never_started"
        else:
            return None
    elif (item["state"] == "collected" and item["process_exited"] == item["collected"] == 1
            and all(row[field] is not None for field in ("pid", "process_group", "process_start_identity"))
            and kinds.count("process_started") == kinds.count("process_exit") == kinds.count("collected") == 1
            and kinds.index("process_started") < kinds.index("process_exit") < len(kinds) - 1
            and kinds[-1] == "collected" and "runner_failure" not in kinds):
        started = json.loads(db.execute(
            "SELECT payload_json FROM events WHERE execution_id=? AND kind='process_started'", (execution,)
        ).fetchone()[0])
        if (started["pid"], started["process_group"], started["start_identity"]) != tuple(row)[:3]:
            return None
        binding["terminal_evidence"] = "collected"
    else:
        return None
    history = hashlib.sha256()
    for event in db.execute(
        "SELECT sequence,kind,payload_json FROM events WHERE execution_id=? ORDER BY sequence", (execution,)
    ):
        history.update(canonical_digest(list(event)).encode())
    return {**binding, "worker_event_history_sha256": history.hexdigest()}


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def verify_artifacts(root, execution, artifacts):
    if not isinstance(artifacts, list):
        raise ValueError("invalid artifact list")
    digests = []
    for artifact in artifacts:
        digest = artifact["digest"]
        if (not isinstance(digest, str) or len(digest) != 64
                or any(c not in "0123456789abcdef" for c in digest)
                or artifact["producing_attempt"] != execution or artifact["privacy"] not in {"public", "private", "local_only"}):
            raise ValueError("invalid legacy artifact binding")
        path = root / "artifacts" / hashlib.sha256(execution.encode()).hexdigest() / (digest + ".json")
        if (path.resolve() != path or artifact["locator"] != str(path)
                or any(not stat.S_ISDIR(parent.lstat().st_mode) for parent in (path.parent, path.parent.parent))):
            raise ValueError("legacy artifact is outside its original journal root")
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
            metadata = os.fstat(stream.fileno())
            limit = 1_048_576  # Worker INLINE_FRAME_LIMIT
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > limit:
                raise ValueError("legacy artifact must be a bounded regular file")
            contents = stream.read(limit + 1)
            after = os.fstat(stream.fileno())
            if (len(contents) != metadata.st_size or after.st_size != metadata.st_size
                    or after.st_mtime_ns != metadata.st_mtime_ns or after.st_nlink != 1
                    or hashlib.sha256(contents).hexdigest() != digest):
                raise ValueError("legacy artifact digest mismatch")
        digests.append(digest)
    return digests


def historical_closure(db, work, item, evidence, root):
    kind = evidence["terminal_evidence"]
    epoch = evidence["worker_epoch"]
    work_id, revision = evidence["admitted_work_id"], evidence["admitted_revision"]
    execution = item["execution_id"]
    record = db.execute(
        "SELECT r.work_id,r.goal_revision,r.payload_digest,r.payload,g.revision "
        "FROM lifetime_results r JOIN lifetime_work w ON w.id=r.work_id "
        "JOIN lifetime_goals g ON g.id=w.goal_id WHERE r.execution_id=?", (execution,)
    ).fetchone()
    if (work_id, revision) != (work["id"], work["goal_revision"]):
        raise ValueError("worker admission belongs to another work revision")
    if not record or record["work_id"] != work["id"] or record["goal_revision"] != work["goal_revision"]:
        raise ValueError("legacy result is missing or belongs to another work revision")
    payload = json.loads(record["payload"])
    event = payload["event"]
    digest = canonical_digest(event)
    producer = "worker:" + execution
    state = event["state"]
    artifacts = event["artifacts"]
    if (digest != record["payload_digest"] or payload["epoch"] != epoch
            or payload["producer"] != producer or event["producer"] != producer
            or payload["sequence"] != item["last_sequence"] or event["sequence"] != item["last_sequence"]
            or event["execution_id"] != execution or event["method"] != "work.result"
            or event["goal_revision"] != work["goal_revision"]
            or state not in {"completed", "failed", "cancelled"}
            or (kind == "never_started" and (state != "failed" or artifacts))):
        raise ValueError("legacy result does not match the worker terminal receipt")
    if work["state"] == "stale":
        if work["goal_revision"] >= record["revision"] or work["cancellation"] not in {"none", "confirmed"}:
            raise ValueError("stale work has no superseding revision or cancellation is pending")
    else:
        expected = {"accepted": "completed", "completed": "completed", "failed": "failed", "cancelled": "cancelled"}
        if expected.get(work["state"]) != state or work["cancellation"] != ("confirmed" if state == "cancelled" else "none"):
            raise ValueError("Host Work does not match its terminal result")
    return {**evidence, "execution_id": execution, "work_id": work["id"], "work_state": work["state"],
            "result_state": state, "result_sha256": digest, "journal_index": item["journal_index"],
            "worker_sequence": item["last_sequence"], "worker_acknowledged_sequence": item["acknowledged_sequence"],
            "artifact_sha256": verify_artifacts(root, execution, artifacts)}


def audit(host_path, worker_paths, *, preserve_history=False):
    """Return metadata only. Each database has its own read transaction.

    A clean inventory is not a cross-store snapshot or proof of process exit.
    The operator must fence admission and repeat it against quiesced journals.
    """
    issues, workers, host_work, pi_ids = [], {}, [], set()
    seen_paths = set()
    terminal, closures = {}, []
    for index, path in enumerate(worker_paths):
        canonical = Path(path).resolve()
        if canonical in seen_paths:
            issues.append({"kind": "duplicate_journal", "journal_index": index})
            continue
        seen_paths.add(canonical)
        try:
            with snapshot(path) as db:
                if db.execute("PRAGMA user_version").fetchone()[0] != 1:
                    raise ValueError("unsupported worker schema")
                rows = db.execute(
                    "SELECT execution_id,state,process_exited,collected,"
                    "last_sequence,acknowledged_sequence FROM executions ORDER BY execution_id"
                ).fetchall()
                pending = db.execute("SELECT COUNT(*) FROM commands WHERE state<>'complete'").fetchone()[0]
                if pending:
                    issues.append({"kind": "pending_worker_commands", "journal_index": index, "count": pending})
                # Older schema-1 journals can predate effect receipts. Absence
                # cannot establish that all external effects were reconciled.
                if not has_table(db, "tool_receipts"):
                    issues.append({"kind": "missing_effect_receipts", "journal_index": index})
                else:
                    for row in db.execute("SELECT execution_id,COUNT(*) AS count FROM tool_receipts WHERE status<>'complete' GROUP BY execution_id"):
                        issues.append({"kind": "unresolved_legacy_effects", **dict(row), "journal_index": index})
                for row in rows:
                    item = dict(row)
                    item["journal_index"] = index
                    execution = item["execution_id"]
                    if execution in workers:
                        issues.append({"kind": "duplicate_execution", "execution_id": execution})
                    workers[execution] = item
                    if preserve_history and has_table(db, "tool_receipts"):
                        try:
                            proof = terminal_evidence(db, item)
                        except (KeyError, TypeError, ValueError):
                            proof = None
                        if proof:
                            terminal[execution] = proof, canonical.parent
                    if not (item["state"] == "collected" and item["collected"] == 1
                            and item["process_exited"] == 1
                            and item["acknowledged_sequence"] == item["last_sequence"]) and not (preserve_history and execution in terminal):
                        issues.append({"kind": "legacy_execution_not_reconciled", "execution_id": execution})
        except (sqlite3.Error, ValueError, OSError):
            # Do not echo paths or SQL/serialized payloads from private journals.
            issues.append({"kind": "worker_journal_unreadable_or_unsupported", "journal_index": index})
    try:
        with snapshot(host_path) as db:
            revision_column = ",goal_revision" if preserve_history else ""
            host_work = [dict(row) for row in db.execute(
                f"SELECT id,execution_id,state,cancellation{revision_column} FROM lifetime_work WHERE execution_id IS NOT NULL ORDER BY id"
            )]
            if has_table(db, "lifetime_pi_executions"):
                pi_ids = {row[0] for row in db.execute("SELECT execution_id FROM lifetime_pi_executions")}
            pending = db.execute(
                "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker' AND acknowledged=0"
            ).fetchone()[0]
            if pending:
                issues.append({"kind": "pending_worker_outbox", "count": pending})
            for work in host_work:
                execution = work["execution_id"]
                if execution in pi_ids:
                    if execution in workers:
                        issues.append({"kind": "pi_legacy_identity_collision", "execution_id": execution})
                    continue
                if execution not in workers:
                    issues.append({"kind": "missing_original_worker_journal", "work_id": work["id"], "execution_id": execution})
                if preserve_history:
                    if execution in terminal:
                        proof, root = terminal[execution]
                        try:
                            closures.append(historical_closure(db, work, workers[execution], proof, root))
                        except (KeyError, TypeError, ValueError, OSError):
                            issues.append({"kind": "legacy_historical_evidence_mismatch", "work_id": work["id"]})
                    else:
                        issues.append({"kind": "legacy_host_work_not_reconciled", "work_id": work["id"]})
                    continue
                if work["state"] not in {"completed", "accepted", "failed", "cancelled"} or work["cancellation"] not in {"none", "confirmed"}:
                    issues.append({"kind": "legacy_host_work_not_reconciled", "work_id": work["id"]})
    except (sqlite3.Error, ValueError, OSError):
        issues.append({"kind": "host_journal_unreadable_or_unsupported"})
    host_ids = {row["execution_id"] for row in host_work}
    for execution in workers.keys() - host_ids:
        issues.append({"kind": "orphan_legacy_execution", "execution_id": execution})
    return {
        "contract": "ghost-pi-cutover-inventory/1",
        "mode": "preserve_history" if preserve_history else "strict_ack",
        "inventory_clear": not issues,
        "cutover_authorized": False,
        "consistency": "per-database read transactions; admission/process fencing not observed",
        "host_execution_count": len(host_work),
        "pi_execution_count": len(pi_ids),
        "legacy_executions": sorted(workers.values(), key=lambda row: row["execution_id"]),
        "issues": issues,
        "historical_closures": closures,
        "remaining_gates": ["complete journal inventory", "admission fencing", "process identity/exit verification", "artifact integrity", "backup and restore", "OMP-free deployment acceptance"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-db", type=Path, required=True)
    parser.add_argument("--worker-db", type=Path, action="append", default=[])
    parser.add_argument("--preserve-history", action="store_true",
                        help="verify terminal history, Host result bindings and original artifacts without advancing ACKs")
    args = parser.parse_args()
    result = audit(args.host_db, args.worker_db, preserve_history=args.preserve_history)
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0 if result["inventory_clear"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
