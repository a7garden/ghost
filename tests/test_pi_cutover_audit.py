import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("cutover", Path(__file__).resolve().parents[1] / "scripts/audit-pi-cutover.py")
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


class CutoverAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.host, self.worker = self.root / "host.db", self.root / "worker.db"
        with sqlite3.connect(self.host) as db:
            db.executescript("CREATE TABLE lifetime_work(id TEXT,execution_id TEXT,state TEXT,cancellation TEXT); CREATE TABLE lifetime_outbox(target TEXT,acknowledged INTEGER); CREATE TABLE lifetime_pi_executions(execution_id TEXT);")
            db.execute("INSERT INTO lifetime_work VALUES('work','legacy','completed','none')")
        with sqlite3.connect(self.worker) as db:
            db.executescript("PRAGMA user_version=1; CREATE TABLE executions(execution_id TEXT,state TEXT,process_exited INTEGER,collected INTEGER,last_sequence INTEGER,acknowledged_sequence INTEGER); CREATE TABLE commands(state TEXT); CREATE TABLE tool_receipts(execution_id TEXT,status TEXT);")
            db.execute("INSERT INTO executions VALUES('legacy','collected',1,1,5,5)")

    def run_audit(self):
        return cutover.audit(self.host, [self.worker])

    def test_reconciled_inventory_is_read_only_and_does_not_authorize_cutover(self):
        before = [path.read_bytes() for path in [self.host, self.worker]]
        result = self.run_audit()
        self.assertTrue(result["inventory_clear"])
        self.assertFalse(result["cutover_authorized"])
        self.assertEqual(before, [path.read_bytes() for path in [self.host, self.worker]])

    def add_historical_evidence(self, *, collected=False):
        spec = {"execution_id": "legacy", "work_id": "work", "work_revision": 1, "authority_epoch": 1}
        artifact = []
        self.artifact_path = None
        if collected:
            import hashlib
            directory = self.root / "artifacts" / hashlib.sha256(b"legacy").hexdigest()
            directory.mkdir(parents=True)
            digest = hashlib.sha256(b"{}").hexdigest()
            self.artifact_path = directory / (digest + ".json")
            self.artifact_path.write_bytes(b"{}")
            artifact = [{"digest": digest, "locator": str(self.artifact_path),
                         "privacy": "private", "producing_attempt": "legacy"}]
        event = {"execution_id": "legacy", "method": "work.result", "producer": "worker:legacy",
                 "sequence": 3, "goal_revision": 1, "state": "completed" if collected else "failed",
                 "artifacts": artifact}
        with sqlite3.connect(self.host) as db:
            db.executescript("""
                ALTER TABLE lifetime_work ADD COLUMN goal_revision INTEGER DEFAULT 1;
                ALTER TABLE lifetime_work ADD COLUMN goal_id TEXT DEFAULT 'goal';
                UPDATE lifetime_work SET state='stale';
                CREATE TABLE lifetime_goals(id TEXT, revision INTEGER);
                INSERT INTO lifetime_goals VALUES('goal',2);
                CREATE TABLE lifetime_results(execution_id TEXT, work_id TEXT, goal_revision INTEGER,
                    payload_digest TEXT, payload TEXT);
            """)
            db.execute("INSERT INTO lifetime_results VALUES('legacy','work',1,?,?)", (
                cutover.canonical_digest(event),
                json.dumps({"event": event, "epoch": 1, "producer": "worker:legacy", "sequence": 3}),
            ))
        with sqlite3.connect(self.worker) as db:
            db.executescript("""
                ALTER TABLE executions ADD COLUMN pid INTEGER;
                ALTER TABLE executions ADD COLUMN process_group INTEGER;
                ALTER TABLE executions ADD COLUMN process_start_identity TEXT;
                ALTER TABLE executions ADD COLUMN prompt_intent INTEGER DEFAULT 0;
                ALTER TABLE executions ADD COLUMN prompt_acknowledged INTEGER DEFAULT 0;
                ALTER TABLE executions ADD COLUMN authority_epoch INTEGER DEFAULT 1;
                ALTER TABLE executions ADD COLUMN spec_json TEXT;
                ALTER TABLE executions ADD COLUMN spec_digest TEXT;
                CREATE TABLE events(execution_id TEXT, sequence INTEGER, kind TEXT, payload_json TEXT,
                    PRIMARY KEY(execution_id, sequence));
                UPDATE executions SET last_sequence=3, acknowledged_sequence=0;
            """)
            db.execute("UPDATE executions SET spec_json=?,spec_digest=?", (json.dumps(spec), cutover.canonical_digest(spec)))
            if collected:
                db.execute("UPDATE executions SET pid=5,process_group=5,process_start_identity='start'")
                kinds = ["process_started", "process_exit", "collected"]
                started = {"pid": 5, "process_group": 5, "start_identity": "start"}
            else:
                db.execute("UPDATE executions SET state='failed',process_exited=0,collected=0")
                kinds = ["admitted", "process_starting", "runner_failure"]
                started = {}
            failed = {"error_code": "worker_actor_failed", "detail": "tool_scope_rejected"}
            db.executemany("INSERT INTO events VALUES('legacy',?,?,?)", [
                (seq, kind, json.dumps({"process_started": started, "runner_failure": failed}.get(kind, {})))
                for seq, kind in enumerate(kinds, 1)
            ])

    def history_audit(self):
        return cutover.audit(self.host, [self.worker], preserve_history=True)

    def test_prestart_and_stale_close_without_worker_ack_or_host_rewrite(self):
        self.add_historical_evidence()
        before = [path.read_bytes() for path in (self.host, self.worker)]
        result = self.history_audit()
        self.assertTrue(result["inventory_clear"])
        self.assertFalse(result["cutover_authorized"])
        self.assertEqual(result["historical_closures"][0]["terminal_evidence"], "never_started")
        self.assertEqual(before, [path.read_bytes() for path in (self.host, self.worker)])
        self.assertFalse(self.run_audit()["inventory_clear"])

    def test_prestart_evidence_rejects_even_completed_effect(self):
        self.add_historical_evidence()
        with sqlite3.connect(self.worker) as db:
            db.execute("INSERT INTO tool_receipts VALUES('legacy','complete')")
        self.assertFalse(self.history_audit()["inventory_clear"])

    def test_generic_failure_with_unknown_cleanup_does_not_close(self):
        self.add_historical_evidence()
        with sqlite3.connect(self.worker) as db:
            db.execute("UPDATE events SET payload_json=? WHERE kind='runner_failure'", (json.dumps({
                "error_code": "worker_actor_failed",
                "detail": "credentialless Linux OMP guest launch failed: guest runtime cleanup is effect_unknown",
            }),))
        self.assertFalse(self.history_audit()["inventory_clear"])

    def test_stale_requires_later_revision_and_correct_result_binding(self):
        self.add_historical_evidence()
        with sqlite3.connect(self.host) as db:
            db.execute("UPDATE lifetime_goals SET revision=1")
        self.assertFalse(self.history_audit()["inventory_clear"])
        with sqlite3.connect(self.host) as db:
            db.execute("UPDATE lifetime_goals SET revision=2")
            db.execute("UPDATE lifetime_results SET payload_digest='bad'")
        self.assertFalse(self.history_audit()["inventory_clear"])

    def test_collected_closure_rejects_missing_or_changed_artifact(self):
        self.add_historical_evidence(collected=True)
        result = self.history_audit()
        self.assertTrue(result["inventory_clear"])
        self.assertEqual(len(result["historical_closures"][0]["artifact_sha256"]), 1)
        self.artifact_path.write_bytes(b"changed")
        self.assertFalse(self.history_audit()["inventory_clear"])
        self.artifact_path.unlink()
        self.assertFalse(self.history_audit()["inventory_clear"])

    def test_settled_process_and_unknown_effect_still_block(self):
        with sqlite3.connect(self.worker) as db:
            db.execute("UPDATE executions SET state='settled',process_exited=0")
            db.execute("INSERT INTO tool_receipts VALUES('legacy','unknown')")
        kinds = {issue["kind"] for issue in self.run_audit()["issues"]}
        self.assertIn("legacy_execution_not_reconciled", kinds)
        self.assertIn("unresolved_legacy_effects", kinds)

    def test_cancel_requires_confirmed_host_state_and_collected_process(self):
        with sqlite3.connect(self.host) as db:
            db.execute("UPDATE lifetime_work SET state='cancelled',cancellation='requested'")
        self.assertFalse(self.run_audit()["inventory_clear"])
        with sqlite3.connect(self.host) as db:
            db.execute("UPDATE lifetime_work SET cancellation='confirmed'")
        self.assertTrue(self.run_audit()["inventory_clear"])

    def test_missing_original_journal_pending_admission_and_collision_block(self):
        self.assertFalse(cutover.audit(self.host, [])["inventory_clear"])
        with sqlite3.connect(self.host) as db:
            db.execute("INSERT INTO lifetime_outbox VALUES('worker',0)")
            db.execute("INSERT INTO lifetime_pi_executions VALUES('legacy')")
        kinds = {issue["kind"] for issue in self.run_audit()["issues"]}
        self.assertIn("pending_worker_outbox", kinds)
        self.assertIn("pi_legacy_identity_collision", kinds)

    def test_unknown_schema_missing_receipts_and_missing_files_fail_closed(self):
        with sqlite3.connect(self.worker) as db:
            db.execute("DROP TABLE tool_receipts")
        self.assertFalse(self.run_audit()["inventory_clear"])
        with sqlite3.connect(self.worker) as db:
            db.execute("PRAGMA user_version=99")
        self.assertFalse(self.run_audit()["inventory_clear"])
        absent = self.root / "absent.db"
        self.assertFalse(cutover.audit(absent, [absent])["inventory_clear"])
        self.assertFalse(absent.exists())

    def test_orphans_and_duplicate_journals_cannot_hide_inventory_gaps(self):
        with sqlite3.connect(self.worker) as db:
            db.execute("INSERT INTO executions VALUES('orphan','collected',1,1,0,0)")
        result = cutover.audit(self.host, [self.worker, self.worker])
        kinds = {issue["kind"] for issue in result["issues"]}
        self.assertIn("orphan_legacy_execution", kinds)
        self.assertIn("duplicate_journal", kinds)


if __name__ == "__main__":
    unittest.main()
