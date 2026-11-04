//! Explicit, read-only path reconciliation for a stopped cross-host restore.
//! Stored commands, specs, receipts, artifact locators and their digests remain
//! unchanged. Only the operator-selected worker store is relocated at read time.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs::{self, OpenOptions}, io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt}, path::{Component, Path, PathBuf}};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Relocation {
    pub version: String,
    pub workspace_id: String,
    pub authority_epoch: u64,
    pub inventory_sha256: String,
    pub workers: Vec<WorkerRoot>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRoot {
    pub ghost_id: String,
    pub computer_id: String,
    pub source: PathBuf,
    pub destination: PathBuf,
}

fn normalized(path: &Path) -> bool {
    path.is_absolute() && path.components().skip(1).all(|part| matches!(part, Component::Normal(_)))
        && path.parent().is_some_and(|parent| parent != Path::new("/"))
}

impl Relocation {
    pub fn read(path: &Path) -> Result<Self> {
        ensure!(normalized(path) && path.canonicalize()? == path, "relocation manifest must be canonical");
        let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)?;
        let before = file.metadata()?;
        ensure!(before.is_file() && before.nlink() == 1 && before.uid() == unsafe { libc::geteuid() }
            && before.mode() & 0o077 == 0 && before.len() <= 65536, "relocation manifest must be a bounded private owned file");
        let mut bytes = Vec::new();
        file.by_ref().take(65537).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 65536, "relocation manifest exceeds limit");
        let result: Self = serde_json::from_slice(&bytes)?;
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(self.version == "ghost-worker-relocation/1" && self.authority_epoch > 1,
            "relocation requires an explicitly restored authority epoch");
        uuid::Uuid::parse_str(&self.workspace_id)?;
        ensure!(self.inventory_sha256.len() == 64 && self.inventory_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "relocation inventory digest is invalid");
        ensure!(!self.workers.is_empty() && self.workers.len() <= 64, "relocation requires 1..=64 worker roots");
        let mut computers = BTreeSet::new();
        for worker in &self.workers {
            uuid::Uuid::parse_str(&worker.ghost_id)?;
            ensure!(!worker.computer_id.is_empty() && worker.computer_id.len() <= 128
                && worker.computer_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                && computers.insert(&worker.computer_id), "invalid or duplicate relocation computer");
            ensure!(normalized(&worker.source) && normalized(&worker.destination)
                && worker.source != worker.destination, "relocation roots must be distinct normalized paths");
            let metadata = fs::symlink_metadata(&worker.destination)?;
            ensure!(metadata.is_dir() && !metadata.file_type().is_symlink()
                && metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
                && worker.destination.canonicalize()? == worker.destination,
                "relocated worker root must be a canonical private owned directory");
        }
        let roots: Vec<_> = self.workers.iter().flat_map(|worker| [&worker.source, &worker.destination]).collect();
        for (i, root) in roots.iter().enumerate() {
            ensure!(roots.iter().skip(i + 1).all(|other| !root.starts_with(other) && !other.starts_with(root)),
                "relocation worker roots overlap");
        }
        Ok(())
    }

    pub fn check_authority(&self, workspace_id: &str, epoch: u64) -> Result<()> {
        ensure!(self.workspace_id == workspace_id && self.authority_epoch == epoch,
            "relocation manifest belongs to a different workspace or authority");
        Ok(())
    }

    pub fn worker_root(&self, ghost_id: &str, computer_id: &str, original: &Path) -> Result<PathBuf> {
        let Some(worker) = self.workers.iter().find(|worker| worker.computer_id == computer_id) else {
            return Ok(original.to_path_buf());
        };
        ensure!(worker.ghost_id == ghost_id && worker.source == original,
            "relocation differs from committed worker origin");
        Ok(worker.destination.clone())
    }

    pub fn artifact_locator(&self, worker_root: &Path, original: &Path) -> Result<PathBuf> {
        if original.starts_with(worker_root) { return Ok(original.to_path_buf()); }
        let Some(worker) = self.workers.iter().find(|worker| worker.destination == worker_root) else {
            return Ok(original.to_path_buf());
        };
        let suffix = original.strip_prefix(&worker.source).context("historical artifact is outside its original worker store")?;
        ensure!(suffix.components().all(|part| matches!(part, Component::Normal(_)))
            && suffix.starts_with("artifacts"), "historical locator is not an immutable artifact");
        Ok(worker.destination.join(suffix))
    }
}

pub(crate) fn configured() -> Result<Option<Relocation>> {
    std::env::var_os("GHOST_WORKER_RELOCATION_FILE").map(|path| Relocation::read(Path::new(&path))).transpose()
}

/// Disable a stopped writer under its existing workspace lock. Replaying the
/// same operator handoff returns its original fence; no model work is resumed.
/// This does not claim worker/broker ACKs: those remain a separate cutover gate.
pub fn fence_stopped_host(root: &Path, expected_epoch: u64, operation_id: &str) -> Result<serde_json::Value> {
    use fs2::FileExt;
    use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
    ensure!(root.canonicalize()? == root, "Host fence requires a canonical root");
    ensure!(expected_epoch > 0 && expected_epoch < 9_007_199_254_740_991,
        "invalid expected authority epoch");
    ensure!(!operation_id.is_empty() && operation_id.len() <= 128
        && operation_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':')),
        "invalid handoff operation ID");
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(root.join("workspace.lock"))?;
    lock.try_lock_exclusive().context("Host is still running; stop it before fencing")?;
    let database = root.join("workspace.db");
    ensure!(!fs::symlink_metadata(&database)?.file_type().is_symlink(), "Host database must not be a symlink");
    let mut conn = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let key = format!("authority_fence:{operation_id}");
    let previous: Option<String> = tx.query_row(
        "SELECT payload FROM workspace_objects WHERE kind='meta' AND id=?1", [&key], |row| row.get(0)).optional()?;
    let (epoch, dispatch): (u64, bool) = tx.query_row(
        "SELECT authority_epoch,dispatch_enabled FROM lifetime_authority WHERE singleton=1", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
    if let Some(previous) = previous {
        let receipt: serde_json::Value = serde_json::from_str(&previous)?;
        ensure!(receipt["expected_epoch"] == expected_epoch && receipt["authority_epoch"] == epoch && !dispatch,
            "handoff ID conflicts with the current authority");
        tx.commit()?;
        return Ok(receipt);
    }
    ensure!(epoch == expected_epoch, "Host authority changed before fencing");
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE state IN ('queued','running','effect_unknown'))
         OR EXISTS(SELECT 1 FROM lifetime_work WHERE state IN ('submitted','running','active','steering','cancelling','unknown'))",
        [], |row| row.get(0))?;
    ensure!(!active, "reconcile active or unknown work before fencing the Host");
    let next = epoch + 1;
    tx.execute("UPDATE lifetime_authority SET authority_epoch=?1,dispatch_enabled=0 WHERE singleton=1", [next])?;
    let receipt = serde_json::json!({"operation_id":operation_id,"expected_epoch":epoch,"authority_epoch":next,
        "dispatch_enabled":false,"worker_broker_fences_required":true});
    tx.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES('meta',?1,?2)", [&key, &receipt.to_string()])?;
    tx.commit()?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture(root: &Path) -> Relocation {
        let destination = root.join("restored-worker"); fs::create_dir(&destination).unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o700)).unwrap();
        Relocation { version: "ghost-worker-relocation/1".into(), workspace_id: uuid::Uuid::new_v4().to_string(),
            authority_epoch: 2, inventory_sha256: "a".repeat(64), workers: vec![WorkerRoot {
                ghost_id: uuid::Uuid::new_v4().to_string(), computer_id: "studio-primary".into(),
                source: PathBuf::from("/old-host/state/worker"), destination }] }
    }
    #[test]
    fn relocation_is_bound_to_exact_origin_and_restored_authority() {
        let temp = tempfile::tempdir().unwrap(); let data = fixture(&temp.path().canonicalize().unwrap()); data.validate().unwrap();
        let worker = &data.workers[0];
        assert_eq!(data.worker_root(&worker.ghost_id, &worker.computer_id, &worker.source).unwrap(), worker.destination);
        assert!(data.worker_root(&uuid::Uuid::new_v4().to_string(), &worker.computer_id, &worker.source).is_err());
        assert!(data.worker_root(&worker.ghost_id, &worker.computer_id, Path::new("/other/worker")).is_err());
        assert!(data.check_authority(&data.workspace_id, 1).is_err());
        assert!(data.check_authority(&uuid::Uuid::new_v4().to_string(), 2).is_err());
        data.check_authority(&data.workspace_id, 2).unwrap();
    }
    #[test]
    fn only_the_original_immutable_artifact_store_is_translated() {
        let temp = tempfile::tempdir().unwrap(); let data = fixture(&temp.path().canonicalize().unwrap()); let worker = &data.workers[0];
        let original = worker.source.join("artifacts/execution/digest.json");
        assert_eq!(data.artifact_locator(&worker.destination, &original).unwrap(), worker.destination.join("artifacts/execution/digest.json"));
        for path in [worker.source.join("sessions/file"), worker.source.join("artifacts/../../secret"), PathBuf::from("/old-host/state/worker-foreign/artifacts/file")] {
            assert!(data.artifact_locator(&worker.destination, &path).is_err());
        }
        let new = worker.destination.join("artifacts/new/digest.json");
        assert_eq!(data.artifact_locator(&worker.destination, &new).unwrap(), new);
    }
    #[test]
    fn overlapping_roots_and_public_or_symlink_targets_are_refused() {
        let temp = tempfile::tempdir().unwrap(); let mut data = fixture(&temp.path().canonicalize().unwrap());
        data.workers[0].source = data.workers[0].destination.join("nested"); assert!(data.validate().is_err());
        data.workers[0].source = PathBuf::from("/old-host/state/worker");
        fs::set_permissions(&data.workers[0].destination, fs::Permissions::from_mode(0o755)).unwrap(); assert!(data.validate().is_err());
        fs::set_permissions(&data.workers[0].destination, fs::Permissions::from_mode(0o700)).unwrap();
        let link = temp.path().join("link"); symlink(&data.workers[0].destination, &link).unwrap(); data.workers[0].destination = link;
        assert!(data.validate().is_err());
    }
    #[test]
    fn manifest_permissions_and_unknown_fields_fail_closed() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap(); let data = fixture(&root);
        let path = root.join("relocation.json"); let bytes = serde_json::to_vec(&data).unwrap(); fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(); assert!(Relocation::read(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap(); Relocation::read(&path).unwrap();
        let mut value = serde_json::to_value(&data).unwrap(); value["extra"] = serde_json::json!(true); fs::write(&path, value.to_string()).unwrap();
        assert!(Relocation::read(&path).is_err());
    }
    #[test]
    fn stopped_host_fence_is_cas_idempotent_and_refuses_a_live_writer() {
        use fs2::FileExt;
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        let connection = rusqlite::Connection::open(root.join("workspace.db")).unwrap();
        connection.execute_batch("CREATE TABLE lifetime_authority(singleton INTEGER,authority_epoch INTEGER,dispatch_enabled INTEGER);
            INSERT INTO lifetime_authority VALUES(1,1,1);
            CREATE TABLE workspace_objects(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id));
            CREATE TABLE lifetime_turn_runs(state TEXT);CREATE TABLE lifetime_work(state TEXT);").unwrap();
        let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(root.join("workspace.lock")).unwrap();
        lock.try_lock_exclusive().unwrap(); assert!(fence_stopped_host(&root,1,"handoff-a").is_err());
        FileExt::unlock(&lock).unwrap();
        connection.execute("INSERT INTO lifetime_turn_runs VALUES('running')", []).unwrap();
        assert!(fence_stopped_host(&root,1,"handoff-a").is_err());
        connection.execute("DELETE FROM lifetime_turn_runs", []).unwrap();
        let first = fence_stopped_host(&root,1,"handoff-a").unwrap();
        assert_eq!(first["authority_epoch"],2);assert_eq!(first["dispatch_enabled"],false);
        assert_eq!(fence_stopped_host(&root,1,"handoff-a").unwrap(),first);
        assert!(fence_stopped_host(&root,1,"handoff-b").is_err());
        assert!(fence_stopped_host(&root,2,"handoff-a").is_err());
    }
}
