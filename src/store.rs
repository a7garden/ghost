//! Per-profile durable state: identity metadata, sessions, tasks (which double
//! as the inbox queue), inbox deduplication by message id, effects ledger,
//! outbox, grants (capability policy) and an audit trail. One writer at a time
//! is enforced with an exclusive lock file held for the store's lifetime.

use anyhow::{anyhow, bail, Context, Result};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::tools;

pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("profile name must not be empty");
    }
    if name == "." || name == ".." {
        bail!("profile name must not be '.' or '..'");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("profile name may only contain ASCII alphanumerics, '-' and '_'");
    }
    Ok(())
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string()
}

struct LockGuard(fs::File);
impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct Session {
    pub id: i64,
    pub uuid: String,
    pub created_at: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Task {
    pub id: i64,
    pub uuid: String,
    pub session_id: String,
    pub message_id: String,
    pub prompt: String,
    pub read_path: Option<String>,
    pub write_path: Option<String>,
    pub write_content: Option<String>,
    pub status: String,
    pub output: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct OutboxRow {
    pub task_id: i64,
    pub task_uuid: String,
    pub message_id: String,
    pub session_id: String,
    pub profile_uuid: String,
    pub content: Option<String>,
    pub status: String,
    pub created_at: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Grant {
    pub id: i64,
    pub path: String,
    pub operation: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

pub struct ProfileStore {
    /// Public for tests and advanced tooling; normal use goes through methods.
    pub conn: Connection,
    _guard: LockGuard,
    pub root: PathBuf,
    pub dir: PathBuf,
    pub name: String,
    pub uuid: String,
    pub persona: String,
}

impl ProfileStore {
    fn open_internal(
        root: &Path,
        name: &str,
        create_persona: Option<&str>,
        requested_uuid: Option<&str>,
    ) -> Result<ProfileStore> {
        validate_name(name)?;
        let profiles_dir = root.join("profiles");

        // Reject profile state directory symlinks to avoid alias duplicate writers.
        if profiles_dir.symlink_metadata().is_ok() && profiles_dir.is_symlink() {
            bail!("profiles directory must not be a symlink");
        }

        // Check existence before creating for open_profile path.
        if create_persona.is_none() && !profiles_dir.is_dir() {
            bail!("profile '{}' not found", name);
        }

        fs::create_dir_all(&profiles_dir).context("creating profiles directory")?;
        let lock_path = profiles_dir.join(format!("{}.lock", name));

        // Reject lock file symlinks.
        if lock_path.symlink_metadata().is_ok() && lock_path.is_symlink() {
            bail!("lock file path must not be a symlink");
        }

        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("opening lock file {}", lock_path.display()))?;
        lock_file
            .try_lock_exclusive()
            .map_err(|_| anyhow!("profile '{}' is locked by another writer", name))?;

        let dir = profiles_dir.join(name);

        // For open (no create_persona), check dir exists without creating.
        if create_persona.is_none() && !dir.is_dir() {
            // Release lock before error.
            drop(lock_file);
            bail!("profile '{}' not found", name);
        }

        fs::create_dir_all(&dir)?;

        // Reject profile state directory symlinks.
        if dir.symlink_metadata().is_ok() && dir.is_symlink() {
            drop(lock_file);
            bail!("profile state directory must not be a symlink");
        }

        let conn = Connection::open(dir.join("ghost.db"))?;
        conn.execute_batch(SCHEMA)?;

        let uuid: Option<String> = conn
            .query_row("SELECT uuid FROM meta WHERE id=1", [], |r| r.get(0))
            .optional()?;
        let uuid = match (uuid, create_persona) {
            (Some(u), Some(persona)) if requested_uuid==Some(u.as_str()) => {
                let existing:String=conn.query_row("SELECT persona FROM meta WHERE id=1",[],|r|r.get(0))?;
                if existing!=persona {bail!("provisioned profile purpose conflicts with the original identity");}
                u
            }
            (Some(_), Some(_)) => bail!("profile '{}' already exists", name),
            (Some(u), None) => u,
            (None, Some(persona)) => {
                let u = match requested_uuid { Some(id) => { let parsed=uuid::Uuid::parse_str(id)?; if parsed.is_nil(){bail!("profile identity must not be nil");} parsed.to_string() }, None => uuid::Uuid::new_v4().to_string() };
                conn.execute(
                    "INSERT INTO meta(id, uuid, name, persona, created_at) VALUES(1, ?1, ?2, ?3, ?4)",
                    params![u, name, persona, now()],
                )?;
                u
            }
            (None, None) => bail!("profile '{}' not found", name),
        };
        let persona: String =
            conn.query_row("SELECT persona FROM meta WHERE id=1", [], |r| r.get(0))?;
        let root_c = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let store = ProfileStore {
            conn,
            _guard: LockGuard(lock_file),
            root: root_c,
            dir,
            name: name.to_string(),
            uuid,
            persona,
        };
        store.recover_interrupted()?;
        Ok(store)
    }

    pub fn create_profile(root: &Path, name: &str, persona: &str) -> Result<ProfileStore> {
        Self::open_internal(root, name, Some(persona), None)
    }

    /// Host provisioning pins identity before external filesystem effects.
    /// Existing create/open contracts retain their original behavior.
    pub(crate) fn create_profile_with_id(root: &Path, name: &str, persona: &str, id: &str) -> Result<ProfileStore> {
        Self::open_internal(root, name, Some(persona), Some(id))
    }

    pub fn open_profile(root: &Path, name: &str) -> Result<ProfileStore> {
        Self::open_internal(root, name, None, None)
    }

    /// Crash recovery: any task left 'running' or effect left 'started' by a
    /// previous process is conservatively marked 'uncertain' with correlated
    /// outbox and audit. Nothing is ever automatically replayed.
    pub fn recover_interrupted(&self) -> Result<()> {
        // Single real SQLite transaction (RAII guard): on any failure the guard
        // drops and rolls back, so no status/effect/outbox change survives.
        let tx = self.conn.unchecked_transaction()?;
        let affected: Vec<i64> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM tasks WHERE status='running' \
                 OR (status='uncertain' AND id NOT IN (SELECT task_id FROM outbox))",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let t = tx.execute(
            "UPDATE tasks SET status='uncertain', \
             output=COALESCE(output, 'crash recovery: effect may or may not have occurred; manual reconciliation required; no automatic replay'), \
             updated_at=?1 WHERE status='running'",
            params![now()],
        )?;
        let e = tx.execute(
            "UPDATE effects SET status='uncertain', finished_at=?1 WHERE status='started'",
            params![now()],
        )?;
        // Repair partial previous recoveries: any uncertain task still missing
        // its correlated outbox row gets one inside this same transaction.
        tx.execute(
            "INSERT INTO outbox(task_id, task_uuid, message_id, session_id, profile_uuid, content, status, created_at) \
             SELECT id, uuid, message_id, session_id, ?1, \
             COALESCE(output, 'uncertain; manual reconciliation required; no automatic replay'), \
             'uncertain', ?2 \
             FROM tasks WHERE status='uncertain' AND id NOT IN (SELECT task_id FROM outbox)",
            params![self.uuid, now()],
        )?;
        for id in affected {
            tx.execute(
                "INSERT INTO audit(task_id, event, detail, at) VALUES(?1,?2,?3,?4)",
                params![
                    Some(id),
                    "task_uncertain_recovery",
                    "task marked uncertain with correlated outbox; no automatic replay",
                    now()
                ],
            )?;
        }
        if t + e > 0 {
            tx.execute(
                "INSERT INTO audit(task_id, event, detail, at) VALUES(NULL,?1,?2,?3)",
                params![
                    "recovery",
                    format!(
                        "{} tasks and {} effects marked uncertain; no automatic replay",
                        t, e
                    ),
                    now()
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn create_session(&self) -> Result<Session> {
        let uuid = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO sessions(uuid, created_at) VALUES(?1, ?2)",
            params![uuid, now()],
        )?;
        self.audit(None, "session_created", &uuid)?;
        self.session(&uuid)?
            .ok_or_else(|| anyhow!("session insert failed"))
    }

    pub fn session(&self, uuid: &str) -> Result<Option<Session>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, uuid, created_at FROM sessions WHERE uuid=?1",
                params![uuid],
                |r| {
                    Ok(Session {
                        id: r.get(0)?,
                        uuid: r.get(1)?,
                        created_at: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn sessions(&self) -> Result<Vec<Session>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, uuid, created_at FROM sessions ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(Session {
                id: r.get(0)?,
                uuid: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Inbox submit with durable deduplication: an identical duplicate of a
    /// known message id returns the existing task; a mismatched reuse of a
    /// message id is rejected.
    pub fn submit(
        &self,
        session_uuid: &str,
        message_id: &str,
        prompt: &str,
        read_path: Option<&str>,
        write_path: Option<&str>,
        write_content: Option<&str>,
    ) -> Result<(Task, bool)> {
        if read_path.is_some() && write_path.is_some() {
            bail!("a task may carry at most one of --read / --write");
        }
        if message_id.trim().is_empty() {
            bail!("message id must not be empty");
        }
        if self.session(session_uuid)?.is_none() {
            bail!("unknown session {}", session_uuid);
        }
        if let Some(existing) = self.task_by_message(message_id)? {
            let same = existing.session_id == session_uuid
                && existing.prompt == prompt
                && existing.read_path.as_deref() == read_path
                && existing.write_path.as_deref() == write_path
                && existing.write_content.as_deref() == write_content;
            if !same {
                bail!(
                    "message id '{}' was already used with different content; refusing mismatched duplicate",
                    message_id
                );
            }
            return Ok((existing, false));
        }
        let task_uuid = uuid::Uuid::new_v4().to_string();
        let t = now();
        self.conn.execute(
            "INSERT INTO tasks(uuid, session_id, message_id, prompt, read_path, write_path, write_content, status, created_at, updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,'queued',?8,?8)",
            params![
                task_uuid,
                session_uuid,
                message_id,
                prompt,
                read_path,
                write_path,
                write_content,
                t
            ],
        )?;
        let task = self
            .task_by_message(message_id)?
            .ok_or_else(|| anyhow!("task insert failed"))?;
        self.audit(Some(task.id), "task_queued", message_id)?;
        Ok((task, true))
    }

    fn row_to_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
        Ok(Task {
            id: r.get(0)?,
            uuid: r.get(1)?,
            session_id: r.get(2)?,
            message_id: r.get(3)?,
            prompt: r.get(4)?,
            read_path: r.get(5)?,
            write_path: r.get(6)?,
            write_content: r.get(7)?,
            status: r.get(8)?,
            output: r.get(9)?,
            created_at: r.get(10)?,
            updated_at: r.get(11)?,
        })
    }

    const TASK_COLS: &'static str =
        "id, uuid, session_id, message_id, prompt, read_path, write_path, write_content, status, output, created_at, updated_at";

    pub fn task_by_message(&self, message_id: &str) -> Result<Option<Task>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {} FROM tasks WHERE message_id=?1", Self::TASK_COLS),
                params![message_id],
                Self::row_to_task,
            )
            .optional()?)
    }

    pub fn task_by_id(&self, id: i64) -> Result<Option<Task>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {} FROM tasks WHERE id=?1", Self::TASK_COLS),
                params![id],
                Self::row_to_task,
            )
            .optional()?)
    }

    /// Lookup by task uuid, message id, or numeric id.
    pub fn task(&self, ident: &str) -> Result<Option<Task>> {
        if let Some(t) = self
            .conn
            .query_row(
                &format!("SELECT {} FROM tasks WHERE uuid=?1", Self::TASK_COLS),
                params![ident],
                Self::row_to_task,
            )
            .optional()?
        {
            return Ok(Some(t));
        }
        if let Some(t) = self.task_by_message(ident)? {
            return Ok(Some(t));
        }
        if let Ok(n) = ident.parse::<i64>() {
            return self.task_by_id(n);
        }
        Ok(None)
    }

    pub fn tasks(&self) -> Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} FROM tasks ORDER BY id",
            Self::TASK_COLS
        ))?;
        let rows = stmt.query_map([], Self::row_to_task)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn queued_task_ids(&self) -> Result<Vec<i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM tasks WHERE status='queued' ORDER BY id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn set_status(&self, id: i64, status: &str, output: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE tasks SET status=?1, output=?2, updated_at=?3 WHERE id=?4",
            params![status, output, now(), id],
        )?;
        Ok(())
    }

    /// Cancel a queued task. Cancellation is terminal with correlated outbox.
    pub fn cancel(&self, ident: &str) -> Result<Task> {
        let t = self
            .task(ident)?
            .ok_or_else(|| anyhow!("task not found: {}", ident))?;
        if t.status != "queued" {
            bail!(
                "task {} cannot be cancelled from status '{}' (running tasks become 'uncertain' only via crash recovery)",
                t.uuid,
                t.status
            );
        }
        self.conn.execute("PRAGMA foreign_keys=ON", [])?;
        self.conn.execute("BEGIN IMMEDIATE", [])?;
        let res = (|| {
            let n = self.conn.execute(
                "UPDATE tasks SET status='cancelled', updated_at=?1 WHERE id=?2 AND status='queued'",
                params![now(), t.id],
            )?;
            if n == 0 {
                bail!(
                    "task {} cannot be cancelled from status '{}'",
                    t.uuid,
                    t.status
                );
            }
            self.conn.execute(
                "INSERT INTO outbox(task_id, task_uuid, message_id, session_id, profile_uuid, content, status, created_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,'cancelled',?7)",
                params![t.id, t.uuid, t.message_id, t.session_id, self.uuid, t.output.as_deref().unwrap_or(""), now()],
            )?;
            self.conn.execute(
                "INSERT INTO audit(task_id, event, detail, at) VALUES(?1,?2,?3,?4)",
                params![Some(t.id), "task_cancelled", "", now()],
            )?;
            Ok::<(), anyhow::Error>(())
        })();
        match res {
            Ok(()) => {
                self.conn.execute("COMMIT", [])?;
            }
            Err(e) => {
                self.conn.execute("ROLLBACK", [])?;
                return Err(e);
            }
        }
        Ok(self.task(&t.uuid)?.unwrap())
    }

    /// Atomically finish a task with terminal status: update task, insert outbox,
    /// and audit in a single transaction. Correlates status+outbox+audit.
    pub fn finish_task(
        &self,
        task: &Task,
        status: &str,
        output: Option<&str>,
        counter: &mut usize,
    ) -> Result<()> {
        if !matches!(status, "completed" | "denied" | "failed" | "uncertain") {
            anyhow::bail!("invalid terminal status: {}", status);
        }
        let tx = self.conn.unchecked_transaction()?;
        let res = (|| {
            let n = tx.execute(
                "UPDATE tasks SET status=?1, output=?2, updated_at=?3 WHERE id=?4 AND status='running'",
                params![status, output, now(), task.id],
            )?;
            if n != 1 {
                anyhow::bail!("task {} is not running", task.id);
            }
            tx.execute(
                "INSERT INTO outbox(task_id, task_uuid, message_id, session_id, profile_uuid, content, status, created_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![task.id, task.uuid, task.message_id, task.session_id, self.uuid, output, status, now()],
            )?;
            tx.execute(
                "INSERT INTO audit(task_id, event, detail, at) VALUES(?1,?2,?3,?4)",
                params![
                    Some(task.id),
                    format!("task_{}", status),
                    output.unwrap_or(""),
                    now()
                ],
            )?;
            Ok::<(), anyhow::Error>(())
        })();
        match res {
            Ok(()) => {
                tx.commit()?;
                *counter += 1;
            }
            Err(e) => return Err(e),
        }
        Ok(())
    }

    pub fn audit(&self, task_id: Option<i64>, event: &str, detail: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO audit(task_id, event, detail, at) VALUES(?1,?2,?3,?4)",
            params![task_id, event, detail, now()],
        )?;
        Ok(())
    }

    // ---- capability grants ----

    /// Add a capability grant. Grant id is captured BEFORE audit to avoid
    /// last_insert_rowid being disturbed. Grant and audit in transaction.
    pub fn allow(&self, path: &Path, operation: &str) -> Result<Grant> {
        if operation != "read" && operation != "write" {
            bail!("operation must be 'read' or 'write'");
        }
        let lex = tools::lexical_abs(path)?;
        let canon = lex
            .canonicalize()
            .with_context(|| format!("policy path does not exist: {}", lex.display()))?;
        if !canon.is_dir() {
            bail!("policy path must be an existing directory");
        }
        if canon == Path::new("/") {
            bail!("refusing to grant the filesystem root");
        }
        if canon.starts_with(&self.root) {
            bail!("refusing to grant paths inside the Ghost root (identity/policy artifacts are protected)");
        }
        self.conn.execute("BEGIN IMMEDIATE", [])?;
        let res = (|| {
            self.conn.execute(
                "INSERT INTO grants(path, operation, created_at) VALUES(?1,?2,?3)",
                params![canon.to_string_lossy(), operation, now()],
            )?;
            // Capture id immediately before audit.
            let id = self.conn.last_insert_rowid();
            self.conn.execute(
                "INSERT INTO audit(task_id, event, detail, at) VALUES(NULL,?1,?2,?3)",
                params![
                    "grant_added",
                    format!("{} {}", operation, canon.display()),
                    now()
                ],
            )?;
            Ok::<i64, anyhow::Error>(id)
        })();
        match res {
            Ok(id) => {
                self.conn.execute("COMMIT", [])?;
                Ok(self.grant_by_id(id)?.unwrap())
            }
            Err(e) => {
                self.conn.execute("ROLLBACK", [])?;
                Err(e)
            }
        }
    }

    fn grant_by_id(&self, id: i64) -> Result<Option<Grant>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, path, operation, created_at, revoked_at FROM grants WHERE id=?1",
                params![id],
                Self::row_to_grant,
            )
            .optional()?)
    }

    fn row_to_grant(r: &rusqlite::Row) -> rusqlite::Result<Grant> {
        Ok(Grant {
            id: r.get(0)?,
            path: r.get(1)?,
            operation: r.get(2)?,
            created_at: r.get(3)?,
            revoked_at: r.get(4)?,
        })
    }

    pub fn grants(&self) -> Result<Vec<Grant>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, operation, created_at, revoked_at FROM grants ORDER BY id",
        )?;
        let rows = stmt.query_map([], Self::row_to_grant)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Revoke a grant. Revocation and audit in transaction.
    pub fn revoke(&self, id: i64) -> Result<Grant> {
        self.conn.execute("BEGIN IMMEDIATE", [])?;
        let res = (|| {
            let n = self.conn.execute(
                "UPDATE grants SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL",
                params![now(), id],
            )?;
            if n == 0 {
                bail!("no active grant {}", id);
            }
            self.conn.execute(
                "INSERT INTO audit(task_id, event, detail, at) VALUES(NULL,?1,?2,?3)",
                params!["grant_revoked", id.to_string(), now()],
            )?;
            Ok::<(), anyhow::Error>(())
        })();
        match res {
            Ok(()) => {
                self.conn.execute("COMMIT", [])?;
                Ok(self.grant_by_id(id)?.unwrap())
            }
            Err(e) => {
                self.conn.execute("ROLLBACK", [])?;
                Err(e)
            }
        }
    }

    /// Find an active grant whose canonical directory covers `target`.
    /// Eligibility is re-checked at every execution; revocation removes it.
    /// Canonicalized grant directory must equal persisted canonical path;
    /// denies stored canonical folder retargeted through a replaced symlink.
    pub fn grant_for(&self, operation: &str, target: &Path) -> Option<Grant> {
        let Ok(target) = tools::lexical_abs(target) else {
            return None;
        };
        let Ok(grants) = self.grants() else {
            return None;
        };
        grants
            .into_iter()
            .filter(|g| g.operation == operation && g.revoked_at.is_none())
            .find(|g| {
                // Compare canonical existing grant path with target canonical.
                // This denies a grant whose stored canonical folder was retargeted
                // through a replaced symlink above it.
                match Path::new(&g.path).canonicalize() {
                    Ok(canon) => canon.is_dir() && target.starts_with(&canon),
                    Err(_) => false,
                }
            })
    }

    // ---- effects ledger ----

    pub fn start_effect(
        &self,
        task_id: i64,
        action: &str,
        target: &str,
        grant_id: i64,
    ) -> Result<i64> {
        if let Some((_id, status)) = self
            .conn
            .query_row(
                "SELECT id, status FROM effects WHERE task_id=?1 AND action=?2",
                params![task_id, action],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        {
            bail!(
                "effect '{}' for task {} already attempted (status {}); no automatic retry",
                action,
                task_id,
                status
            );
        }
        self.conn.execute(
            "INSERT INTO effects(task_id, action, target, grant_id, status, started_at) \
             VALUES(?1,?2,?3,?4,'started',?5)",
            params![task_id, action, target, grant_id, now()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn finish_effect(&self, id: i64, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE effects SET status=?1, finished_at=?2 WHERE id=?3",
            params![status, now(), id],
        )?;
        Ok(())
    }

    // ---- outbox ----

    pub fn insert_outbox(&self, task: &Task, status: &str, content: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO outbox(task_id, task_uuid, message_id, session_id, profile_uuid, content, status, created_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                task.id,
                task.uuid,
                task.message_id,
                task.session_id,
                self.uuid,
                content,
                status,
                now()
            ],
        )?;
        Ok(())
    }

    pub fn outbox(&self) -> Result<Vec<OutboxRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT task_id, task_uuid, message_id, session_id, profile_uuid, content, status, created_at FROM outbox ORDER BY task_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(OutboxRow {
                task_id: r.get(0)?,
                task_uuid: r.get(1)?,
                message_id: r.get(2)?,
                session_id: r.get(3)?,
                profile_uuid: r.get(4)?,
                content: r.get(5)?,
                status: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

pub fn list_profiles(root: &Path) -> Result<Vec<String>> {
    let dir = root.join("profiles");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut names = vec![];
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip symlinks to avoid aliasing issues.
        if entry.path().is_dir() && !entry.path().is_symlink() && validate_name(&name).is_ok() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

const SCHEMA: &str = r#"
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS meta(
  id INTEGER PRIMARY KEY CHECK(id=1),
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(uuid),
  message_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  read_path TEXT,
  write_path TEXT,
  write_content TEXT,
  status TEXT NOT NULL,
  output TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- tasks double as the durable inbox: message ids are UNIQUE per profile.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_unique ON tasks(message_id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS effects(
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  grant_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(task_id, action)
);
CREATE TABLE IF NOT EXISTS outbox(
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
  task_uuid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  profile_uuid TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grants(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  task_id INTEGER,
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
"#;
