import importlib.util
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
        self.root = Path(self.temp.name)
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
