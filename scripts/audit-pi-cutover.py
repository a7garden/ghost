#!/usr/bin/env python3
"""Read-only legacy execution inventory; never authorizes or performs cutover."""
import argparse
import json
import sqlite3
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


def audit(host_path, worker_paths):
    """Return metadata only. Each database has its own read transaction.

    A clean inventory is not a cross-store snapshot or proof of process exit.
    The operator must fence admission and repeat it against quiesced journals.
    """
    issues, workers, host_work, pi_ids = [], {}, [], set()
    seen_paths = set()
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
                    if not (item["state"] == "collected" and item["collected"] == 1
                            and item["process_exited"] == 1
                            and item["acknowledged_sequence"] == item["last_sequence"]):
                        issues.append({"kind": "legacy_execution_not_reconciled", "execution_id": execution})
        except (sqlite3.Error, ValueError, OSError):
            # Do not echo paths or SQL/serialized payloads from private journals.
            issues.append({"kind": "worker_journal_unreadable_or_unsupported", "journal_index": index})
    try:
        with snapshot(host_path) as db:
            host_work = [dict(row) for row in db.execute(
                "SELECT id,execution_id,state,cancellation FROM lifetime_work WHERE execution_id IS NOT NULL ORDER BY id"
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
                if work["state"] not in {"completed", "accepted", "failed", "cancelled"} or work["cancellation"] not in {"none", "confirmed"}:
                    issues.append({"kind": "legacy_host_work_not_reconciled", "work_id": work["id"]})
    except (sqlite3.Error, ValueError, OSError):
        issues.append({"kind": "host_journal_unreadable_or_unsupported"})
    host_ids = {row["execution_id"] for row in host_work}
    for execution in workers.keys() - host_ids:
        issues.append({"kind": "orphan_legacy_execution", "execution_id": execution})
    return {
        "contract": "ghost-pi-cutover-inventory/1",
        "inventory_clear": not issues,
        "cutover_authorized": False,
        "consistency": "per-database read transactions; admission/process fencing not observed",
        "host_execution_count": len(host_work),
        "pi_execution_count": len(pi_ids),
        "legacy_executions": sorted(workers.values(), key=lambda row: row["execution_id"]),
        "issues": issues,
        "remaining_gates": ["complete journal inventory", "admission fencing", "process identity/exit verification", "artifact integrity", "backup and restore", "OMP-free deployment acceptance"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-db", type=Path, required=True)
    parser.add_argument("--worker-db", type=Path, action="append", default=[])
    args = parser.parse_args()
    result = audit(args.host_db, args.worker_db)
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0 if result["inventory_clear"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
