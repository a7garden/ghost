use crate::{
    adapters::computer::{ComputerBackend, ComputerCapabilities},
    lifetime_contract::{
        canonical_digest, ComputerBinding, Envelope, Response, ResponseStatus, RetryClass, VERSION,
    },
};
#[cfg(unix)]
use crate::operations::home_lanes;
use anyhow::{anyhow, bail, ensure, Context, Result};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

const DATABASE_NAME: &str = "computer-registry.sqlite3";
const COMPUTER_ROOT: &str = "computers";
const KNOWN_CAPABILITIES: [&str; 4] = [
    "browser",
    "human_control",
    "persistent_filesystem",
    "shell",
];
const NATIVE_WORKER_BACKEND_ID: &str = "apple-native-omp";
const NATIVE_WORKER_CAPABILITIES: ComputerCapabilities = ComputerCapabilities {
    browser: false,
    shell: true,
    human_control: false,
    persistent_filesystem: true,
};
const CAPABILITY_SHELL: u8 = 1;
const CAPABILITY_PERSISTENT_FILESYSTEM: u8 = 2;
const REQUIRED_HOME_CAPABILITIES: u8 = CAPABILITY_SHELL | CAPABILITY_PERSISTENT_FILESYSTEM;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HomeManifest {
    pub home_volume: PathBuf,
    pub task_snapshot_root: PathBuf,
    pub browser_profile: PathBuf,
    pub credential_broker: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeWorkerBackendFacts {
    pub configured: bool,
    pub available: bool,
}

/// Operator-observed runtime facts, probed at registration and never taken
/// from a command payload. Lifecycle authorization requires a durable,
/// per-epoch acceptance that still matches these facts exactly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeFacts {
    pub kind: String,
    pub executable_sha256: String,
}

impl RuntimeFacts {
    pub fn new(kind: impl Into<String>, executable_sha256: impl Into<String>) -> Result<Self> {
        let kind = kind.into();
        let executable_sha256 = executable_sha256.into();
        ensure!(
            !kind.is_empty()
                && kind.len() <= 64
                && kind
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "runtime kind must be a safe identifier"
        );
        ensure!(
            executable_sha256.len() == 64
                && executable_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "runtime executable digest must be lowercase hex sha256"
        );
        Ok(Self {
            kind,
            executable_sha256,
        })
    }
}

/// One browser control gate attached to an existing computer binding. It rides
/// the binding's authority epoch, carries its own grant revision, and is the
/// only path through which a `browser` lease can be granted for the computer.
/// The profile scope separates login-less public research profiles from
/// authenticated private profiles in the same home ledger: a public native
/// model route can never observe a private profile, and capture keeps both.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserServiceBinding {
    pub computer_id: String,
    pub ghost_id: String,
    pub backend: String,
    pub host_id: String,
    pub epoch: u64,
    pub grant_revision: u64,
    pub profile_scope: String,
    pub capabilities: Vec<String>,
    pub accepted_capabilities: Vec<String>,
}

impl BrowserServiceBinding {
    pub fn validate_profile_scope(scope: &str) -> Result<()> {
        ensure!(
            matches!(scope, "public" | "private"),
            "browser profile scope must be public or private"
        );
        Ok(())
    }
}

/// One precise owner-approved browser action requested by a worker
/// execution. The exact arguments digest, the proposing execution, and the
/// authority epoch are bound at proposal time; approval never widens them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserAction {
    pub action_id: String,
    pub computer_id: String,
    pub execution_id: String,
    pub arguments_digest: String,
    pub requested_epoch: u64,
    pub state: String,
    pub approved_by: Option<String>,
    pub detail: Value,
}

/// The one registered live browser instance for a computer, recorded by the
/// process that owns the child so another process (the Host) can stop the
/// exact instance by verified identity instead of guessing by PID.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserInstance {
    pub computer_id: String,
    pub pid: u32,
    pub process_group: i32,
    pub executable: String,
    pub start_identity: String,
    pub profile_dir: String,
    pub lease_execution_id: String,
    pub authority_epoch: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LeaseKind {
    Process,
    Browser,
    Collect,
}

impl LeaseKind {
    fn parse(raw: &str) -> std::result::Result<Self, Rejected> {
        match raw {
            "process" => Ok(Self::Process),
            "browser" => Ok(Self::Browser),
            "collect" => Ok(Self::Collect),
            _ => Err(Rejected::new(
                "invalid_lease_kind",
                "lease kind must be process, browser, or collect",
                RetryClass::Never,
                Value::Null,
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Process => "process",
            Self::Browser => "browser",
            Self::Collect => "collect",
        }
    }

    fn required_capability(self) -> &'static str {
        match self {
            Self::Process => "shell",
            Self::Browser => "browser",
            Self::Collect => "persistent_filesystem",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LeaseView {
    pub computer_id: String,
    pub execution_id: String,
    pub kind: LeaseKind,
    pub epoch: u64,
    pub state: String,
}

enum BackendRegistration {
    ComputerBackend {
        backend: Arc<dyn ComputerBackend>,
        available: bool,
    },
    NativeWorker(NativeWorkerBackendFacts),
}

struct RegisteredBackend {
    registration: BackendRegistration,
    accepted_capabilities: BTreeSet<String>,
    runtime: Option<RuntimeFacts>,
}

impl RegisteredBackend {
    fn capabilities(&self) -> ComputerCapabilities {
        match &self.registration {
            BackendRegistration::ComputerBackend { backend, .. } => backend.capabilities(),
            BackendRegistration::NativeWorker(_) => NATIVE_WORKER_CAPABILITIES,
        }
    }

    fn configured(&self) -> bool {
        match &self.registration {
            BackendRegistration::ComputerBackend { backend, .. } => backend.configured(),
            BackendRegistration::NativeWorker(facts) => facts.configured,
        }
    }

    fn available(&self) -> bool {
        match &self.registration {
            BackendRegistration::ComputerBackend { available, .. } => *available,
            BackendRegistration::NativeWorker(facts) => facts.available,
        }
    }

    fn is_native_worker(&self) -> bool {
        matches!(&self.registration, BackendRegistration::NativeWorker(_))
    }
}

pub struct ComputerRegistry {
    root: PathBuf,
    db: Connection,
    backends: BTreeMap<String, RegisteredBackend>,
}

impl ComputerRegistry {
    /// Open a private registry and its rooted computer-volume namespace.
    pub fn open(root: &Path) -> Result<Self> {
        ensure_directory(root)?;
        let root = root.canonicalize()?;
        let computers = root.join(COMPUTER_ROOT);
        ensure_directory(&computers)?;
        set_private_permissions(&computers)?;
        let computers = computers.canonicalize()?;
        if !computers.starts_with(&root) {
            bail!("computer volume root escaped the registry root");
        }
        // WAL activation races on a cold database even with SQLite's busy timeout.
        // Serialize schema setup only; execution and lease transactions keep their own locks.
        let initialization_lock_path = root.join(".computer-registry-init.lock");
        reject_symlink_if_present(&initialization_lock_path)?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).mode(0o600);
        }
        let initialization_lock = options.open(&initialization_lock_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = initialization_lock.metadata()?;
            ensure!(metadata.is_file() && metadata.nlink() == 1
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0, "registry initialization lock is not private");
        }
        FileExt::lock_exclusive(&initialization_lock)?;


        let db_path = root.join(DATABASE_NAME);
        reject_symlink_if_present(&db_path)?;
        let db = Connection::open(&db_path)?;
        set_private_file_permissions(&db_path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS computer_bindings (
                 computer_id TEXT PRIMARY KEY NOT NULL,
                 ghost_id TEXT NOT NULL,
                 backend TEXT NOT NULL,
                 state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
                 payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS computer_bindings_by_ghost
                 ON computer_bindings(ghost_id, computer_id);
             CREATE TABLE IF NOT EXISTS computer_leases (
                 computer_id TEXT NOT NULL,
                 execution_id TEXT NOT NULL,
                 kind TEXT NOT NULL CHECK(kind IN ('process', 'browser', 'collect')),
                 epoch INTEGER NOT NULL,
                 state TEXT NOT NULL CHECK(state IN ('active', 'released', 'revoked')),
                 PRIMARY KEY(computer_id, execution_id, kind)
             );
             CREATE INDEX IF NOT EXISTS computer_leases_active
                 ON computer_leases(computer_id, state, kind);
             CREATE TABLE IF NOT EXISTS computer_commands (
                 command_id TEXT PRIMARY KEY NOT NULL,
                 payload_digest TEXT NOT NULL,
                 actor_ref TEXT NOT NULL,
                 authority_epoch INTEGER NOT NULL,
                 response TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS computer_browser_services (
                 computer_id TEXT PRIMARY KEY NOT NULL
                     REFERENCES computer_bindings(computer_id),
                 backend TEXT NOT NULL,
                 state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
                 payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS computer_runtime_acceptance (
                 computer_id TEXT PRIMARY KEY
                     REFERENCES computer_bindings(computer_id),
                 runtime_kind TEXT NOT NULL,
                 executable_sha256 TEXT NOT NULL,
                 accepted_epoch INTEGER NOT NULL,
                 grant_revision INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS computer_lifecycle_attempts (
                 attempt_id TEXT PRIMARY KEY NOT NULL,
                 computer_id TEXT NOT NULL
                     REFERENCES computer_bindings(computer_id),
                 operation TEXT NOT NULL,
                 actor_ref TEXT NOT NULL,
                 authority_epoch INTEGER NOT NULL,
                 state TEXT NOT NULL
                     CHECK(state IN ('authorized','completed','resolved')),
                 instance_json TEXT,
                 outcome_json TEXT,
                 started_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS computer_home_layouts (
                 computer_id TEXT PRIMARY KEY
                     REFERENCES computer_bindings(computer_id),
                 layout_id TEXT NOT NULL,
                 state TEXT NOT NULL
                     CHECK(state IN ('committed')),
                 recorded_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS computer_browser_contamination (
                 computer_id TEXT PRIMARY KEY
                     REFERENCES computer_bindings(computer_id),
                 marked_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS computer_browser_instances (
                 computer_id TEXT PRIMARY KEY
                     REFERENCES computer_bindings(computer_id),
                 pid INTEGER NOT NULL,
                 process_group INTEGER NOT NULL,
                 executable TEXT NOT NULL,
                 start_identity TEXT NOT NULL,
                 profile_dir TEXT NOT NULL,
                 lease_execution_id TEXT NOT NULL,
                 authority_epoch INTEGER NOT NULL,
                 registered_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS computer_browser_actions (
                 action_id TEXT PRIMARY KEY NOT NULL,
                 computer_id TEXT NOT NULL
                     REFERENCES computer_bindings(computer_id),
                 execution_id TEXT NOT NULL,
                 arguments_digest TEXT NOT NULL,
                 requested_epoch INTEGER NOT NULL,
                 state TEXT NOT NULL
                     CHECK(state IN ('pending','approved','denied','executed','expired')),
                 approved_by TEXT,
                 proposed_at_ms INTEGER NOT NULL,
                 detail_json TEXT NOT NULL
             );",
        )?;
        // Conservative migration for a registry created before exact browser
        // action details were persisted: `CREATE TABLE IF NOT EXISTS` cannot
        // add the column to a preexisting table. The column is added WITHOUT
        // a default, so historical rows keep NULL — a NULL detail is an
        // uncertifiable proposal that must be refused at decision time, never
        // backfilled with a fabricated `{}` approval surface. History (every
        // row, including pending ones) is preserved verbatim.
        let detail_columns: i64 = db.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('computer_browser_actions')
             WHERE name='detail_json'",
            [],
            |row| row.get(0),
        )?;
        if detail_columns == 0 {
            db.execute_batch(
                "ALTER TABLE computer_browser_actions ADD COLUMN detail_json TEXT;",
            )?;
        }
        drop(initialization_lock);
        Ok(Self {
            root,
            db,
            backends: BTreeMap::new(),
        })
    }

    /// Register runtime backend facts and an operator-trusted capability set.
    /// The accepted set is never taken from a command payload.
    pub fn register_backend(
        &mut self,
        backend: Arc<dyn ComputerBackend>,
        available: bool,
        accepted_capabilities: Vec<String>,
    ) -> Result<()> {
        self.register_backend_with_runtime(
            backend,
            available,
            accepted_capabilities,
            None,
        )
    }

    /// Register a backend together with operator-probed runtime facts so the
    /// computer can accept an explicit runtime and execute its lifecycle.
    pub fn register_backend_with_runtime(
        &mut self,
        backend: Arc<dyn ComputerBackend>,
        available: bool,
        accepted_capabilities: Vec<String>,
        runtime: Option<RuntimeFacts>,
    ) -> Result<()> {
        let identity = backend.identity();
        if !valid_component(identity) || identity == NATIVE_WORKER_BACKEND_ID {
            bail!("backend identity is invalid or reserved for native workers");
        }
        let offered = capability_names(backend.capabilities());
        let accepted = trusted_capability_set(accepted_capabilities)?;
        if !accepted.is_subset(&offered) {
            bail!("backend acceptance includes a capability it does not offer");
        }
        if available && !backend.configured() {
            bail!("an unconfigured backend cannot be registered as available");
        }
        self.backends.insert(
            identity.to_owned(),
            RegisteredBackend {
                registration: BackendRegistration::ComputerBackend { backend, available },
                accepted_capabilities: accepted,
                runtime,
            },
        );
        Ok(())
    }

    /// Register verified native-worker facts under the fixed, distinct backend identity.
    pub fn register_native_worker_backend(
        &mut self,
        facts: NativeWorkerBackendFacts,
        accepted_capabilities: Vec<String>,
    ) -> Result<()> {
        self.register_native_worker_backend_with_runtime(
            facts,
            accepted_capabilities,
            None,
        )
    }

    /// Register native-worker facts with probed container runtime facts for
    /// explicit lifecycle acceptance.
    pub fn register_native_worker_backend_with_runtime(
        &mut self,
        facts: NativeWorkerBackendFacts,
        accepted_capabilities: Vec<String>,
        runtime: Option<RuntimeFacts>,
    ) -> Result<()> {
        if facts.available && !facts.configured {
            bail!("an unconfigured native worker cannot be registered as available");
        }
        let accepted = trusted_capability_set(accepted_capabilities)?;
        if capability_mask_for_values(&accepted)? & !capability_mask(NATIVE_WORKER_CAPABILITIES) != 0 {
            bail!("native worker acceptance includes an unoffered capability");
        }
        self.backends.insert(
            NATIVE_WORKER_BACKEND_ID.to_owned(),
            RegisteredBackend {
                registration: BackendRegistration::NativeWorker(facts),
                accepted_capabilities: accepted,
                runtime,
            },
        );
        Ok(())
    }

    /// Inspect the native home for Host grant preparation without creating leases or paths.
    pub(crate) fn inspect_worker_home(
        &self,
        computer_id: &str,
        ghost_id: &str,
        authority_epoch: u64,
    ) -> Result<Option<HomeManifest>> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        if i64::try_from(authority_epoch).is_err() {
            return Ok(None);
        }

        let tx = self.db.unchecked_transaction()?;
        let result = (|| -> Result<Option<HomeManifest>> {
            let Some((binding, state)) = stored_binding(&tx, computer_id)? else {
                return Ok(None);
            };
            if !home_binding_matches(
                &binding,
                &state,
                computer_id,
                ghost_id,
                authority_epoch,
            ) || binding.backend != NATIVE_WORKER_BACKEND_ID
            {
                return Ok(None);
            }
            let Some(registration) = self.backends.get(&binding.backend) else {
                return Ok(None);
            };
            if !registration.is_native_worker()
                || !home_backend_is_current(&binding, registration)?
            {
                return Ok(None);
            }
            let manifest = existing_manifest(&self.root, computer_id)?;
            Ok(manifest_roots_are_disjoint(&manifest).then_some(manifest))
        })();
        tx.commit()?;
        result
    }

    /// Atomically grants the process and artifact-collection leases for one execution.
    pub fn acquire_worker_home(
        &mut self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<HomeManifest> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let epoch = i64::try_from(authority_epoch)
            .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (binding, state) = stored_binding(&tx, computer_id)?
            .ok_or_else(|| anyhow!("computer binding is missing"))?;
        ensure!(
            home_binding_matches(&binding, &state, computer_id, ghost_id, authority_epoch),
            "computer binding is foreign, revoked, or at a different authority epoch"
        );
        let registration = self
            .backends
            .get(&binding.backend)
            .ok_or_else(|| anyhow!("computer backend is not currently registered"))?;
        ensure!(
            home_backend_is_current(&binding, registration)?,
            "computer backend is unavailable, downgraded, or lacks accepted home capabilities"
        );
        let manifest = existing_manifest(&self.root, computer_id)?;
        ensure!(
            manifest_roots_are_disjoint(&manifest),
            "computer home, task, and browser roots overlap"
        );
        // Privacy-lane admission: only a registry-committed layout with a
        // matching sealed marker and exactly-shaped root may be granted. A
        // legacy root — including one whose own directories happen to be
        // named public/private — fails closed until the operator migration.
        #[cfg(unix)]
        committed_home_layout(&tx, computer_id, &manifest.home_volume)?;

        let leases = worker_home_lease_rows(&tx, computer_id, execution_id, epoch)?;
        ensure!(
            !leases.competing_held,
            "another execution has an active or revoked process or collection reservation"
        );
        if leases.is_active_pair(epoch) {
            tx.commit()?;
            return Ok(manifest);
        }
        ensure!(
            !leases.has_records(),
            "released, revoked, or partial execution home leases cannot be resurrected"
        );

        tx.execute(
            "INSERT INTO computer_leases(computer_id, execution_id, kind, epoch, state)
             VALUES (?1, ?2, 'process', ?3, 'active')",
            params![computer_id, execution_id, epoch],
        )?;
        tx.execute(
            "INSERT INTO computer_leases(computer_id, execution_id, kind, epoch, state)
             VALUES (?1, ?2, 'collect', ?3, 'active')",
            params![computer_id, execution_id, epoch],
        )?;
        tx.commit()?;
        Ok(manifest)
    }

    /// Reports whether this exact execution still owns both current home leases.
    pub fn worker_home_is_current(
        &self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<bool> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let Ok(epoch) = i64::try_from(authority_epoch) else {
            return Ok(false);
        };

        let tx = self.db.unchecked_transaction()?;
        let current = (|| -> Result<bool> {
            let Some((binding, state)) = stored_binding(&tx, computer_id)? else {
                return Ok(false);
            };
            if !home_binding_matches(
                &binding,
                &state,
                computer_id,
                ghost_id,
                authority_epoch,
            ) {
                return Ok(false);
            }
            let Some(registration) = self.backends.get(&binding.backend) else {
                return Ok(false);
            };
            if !home_backend_is_current(&binding, registration)? {
                return Ok(false);
            }
            let leases = worker_home_lease_rows(&tx, computer_id, execution_id, epoch)?;
            if !leases.is_active_pair(epoch) || leases.competing_held {
                return Ok(false);
            }
            let Ok(manifest) = existing_manifest(&self.root, computer_id) else {
                return Ok(false);
            };
            if !manifest_roots_are_disjoint(&manifest) {
                return Ok(false);
            }
            #[cfg(unix)]
            if committed_home_layout(&tx, computer_id, &manifest.home_volume).is_err() {
                return Ok(false);
            }
            Ok(true)
        })();
        tx.commit()?;
        current
    }

    /// Resolves the one registry-committed privacy lane directory a worker
    /// execution may mount as HOME. The full admission discipline is
    /// re-checked at mount time: current binding and backend, the exact
    /// active process/collection lease pair, disjoint roots, and the
    /// committed home layout with its sealed provenance marker. The
    /// containing home root and the sibling lane are never returned.
    #[cfg(unix)]
    pub fn worker_home_lane_directory(
        &self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
        lane: crate::operations::home_lanes::HomePrivacyLane,
    ) -> Result<PathBuf> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let epoch = i64::try_from(authority_epoch)
            .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?;
        let tx = self.db.unchecked_transaction()?;
        let lane_directory = (|| -> Result<PathBuf> {
            let Some((binding, state)) = stored_binding(&tx, computer_id)? else {
                bail!("computer binding is missing");
            };
            ensure!(
                home_binding_matches(&binding, &state, computer_id, ghost_id, authority_epoch),
                "computer binding is foreign, revoked, or at a different authority epoch"
            );
            let registration = self
                .backends
                .get(&binding.backend)
                .ok_or_else(|| anyhow!("computer backend is not currently registered"))?;
            ensure!(
                home_backend_is_current(&binding, registration)?,
                "computer backend is unavailable, downgraded, or lacks accepted home capabilities"
            );
            let leases = worker_home_lease_rows(&tx, computer_id, execution_id, epoch)?;
            ensure!(
                leases.is_active_pair(epoch) && !leases.competing_held,
                "worker home lane resolution requires the exact active process and collection lease pair"
            );
            let manifest = existing_manifest(&self.root, computer_id)?;
            ensure!(
                manifest_roots_are_disjoint(&manifest),
                "computer home, task, and browser roots overlap"
            );
            let layout = committed_home_layout(&tx, computer_id, &manifest.home_volume)?;
            Ok(layout.lane_directory(lane).to_path_buf())
        })();
        tx.commit()?;
        lane_directory
    }

    /// Cleanup permission is narrower than a fresh compute grant and survives fencing.
    pub fn worker_home_cleanup_is_authorized(
        &self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<bool> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let Ok(epoch) = i64::try_from(authority_epoch) else {
            return Ok(false);
        };
        let tx = self.db.unchecked_transaction()?;
        let authorized = (|| -> Result<bool> {
            let Some((binding, state)) = stored_binding(&tx, computer_id)? else {
                return Ok(false);
            };
            if binding.ghost_id != ghost_id
                || !matches!(state.as_str(), "active" | "revoked")
                || authority_epoch > binding.epoch
            {
                return Ok(false);
            }
            let leases = worker_home_lease_rows(&tx, computer_id, execution_id, epoch)?;
            Ok(leases.is_active_pair(epoch)
                || leases.is_revoked_pair(epoch)
                || leases.is_released_pair(epoch))
        })();
        tx.commit()?;
        authorized
    }

    /// Releases the exact active or revoked pair after caller-proven cleanup, even after fencing.
    pub fn release_worker_home(
        &mut self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<()> {
        self.release_worker_home_inner(computer_id, ghost_id, execution_id, authority_epoch, false)
    }

    /// Cleanup may precede lease acquisition after native effects are fenced.
    pub(crate) fn release_worker_home_if_acquired(
        &mut self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<()> {
        self.release_worker_home_inner(computer_id, ghost_id, execution_id, authority_epoch, true)
    }

    fn release_worker_home_inner(
        &mut self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
        allow_absent: bool,
    ) -> Result<()> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let epoch = i64::try_from(authority_epoch)
            .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let leases = worker_home_lease_rows(&tx, computer_id, execution_id, epoch)?;
        if allow_absent && !leases.has_records() {
            tx.commit()?;
            return Ok(());
        }
        let (binding, state) = stored_binding(&tx, computer_id)?
            .ok_or_else(|| anyhow!("computer binding is missing"))?;
        ensure!(
            binding.ghost_id == ghost_id && (state == "active" || state == "revoked"),
            "computer binding belongs to a different Ghost or has an invalid state"
        );
        ensure!(
            authority_epoch <= binding.epoch,
            "cleanup lease epoch is in the future"
        );
        ensure!(
            leases.process_epoch == Some(epoch) && leases.collect_epoch == Some(epoch),
            "exact process and collection lease pair is missing"
        );
        if leases.is_released_pair(epoch) {
            tx.commit()?;
            return Ok(());
        }
        ensure!(
            leases.is_active_pair(epoch) || leases.is_revoked_pair(epoch),
            "home lease pair is incomplete or is not uniformly active or revoked"
        );

        let process_changed = tx.execute(
            "UPDATE computer_leases SET state='released'
             WHERE computer_id=?1 AND execution_id=?2 AND kind='process'
               AND epoch=?3 AND state IN ('active','revoked')",
            params![computer_id, execution_id, epoch],
        )?;
        let collect_changed = tx.execute(
            "UPDATE computer_leases SET state='released'
             WHERE computer_id=?1 AND execution_id=?2 AND kind='collect'
               AND epoch=?3 AND state IN ('active','revoked')",
            params![computer_id, execution_id, epoch],
        )?;
        ensure!(
            process_changed == 1 && collect_changed == 1,
            "home lease pair changed during release"
        );
        tx.commit()?;
        Ok(())
    }

    /// Resolves the durable home manifest for a current browser service. The
    /// browser profile root always comes from the registry manifest — never
    /// from a parallel or caller-supplied path.
    pub fn browser_service_manifest(
        &self,
        computer_id: &str,
        ghost_id: &str,
        authority_epoch: u64,
    ) -> Result<Option<HomeManifest>> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        if i64::try_from(authority_epoch).is_err() {
            return Ok(None);
        }
        let tx = self.db.unchecked_transaction()?;
        let manifest = (|| -> Result<Option<HomeManifest>> {
            let Some((binding, state)) = stored_binding(&tx, computer_id)? else {
                return Ok(None);
            };
            if !home_binding_matches(&binding, &state, computer_id, ghost_id, authority_epoch) {
                return Ok(None);
            }
            let Some((service, service_state)) = stored_browser_service(&tx, computer_id)? else {
                return Ok(None);
            };
            if service_state != "active" || service.epoch != binding.epoch {
                return Ok(None);
            }
            let Some(registration) = self.backends.get(&service.backend) else {
                return Ok(None);
            };
            if !registration.configured() || !registration.available() {
                return Ok(None);
            }
            let offered = capability_mask(registration.capabilities());
            let bound = capability_mask_for_values(&service.capabilities)?;
            let accepted = capability_mask_for_values(&service.accepted_capabilities)?;
            let trusted = capability_mask_for_values(&registration.accepted_capabilities)?;
            if !(bound & !offered == 0
                && accepted & !bound == 0
                && accepted & !offered == 0
                && accepted & !trusted == 0
                && accepted & (1 << 2) != 0)
            {
                return Ok(None);
            }
            let manifest = existing_manifest(&self.root, computer_id)?;
            if !manifest_roots_are_disjoint(&manifest) {
                return Ok(None);
            }
            // The profile root is always the registry manifest's browser root
            // scoped by the service's declared profile scope; never a
            // parallel path and never a caller-supplied directory.
            Ok(Some(HomeManifest {
                browser_profile: manifest.browser_profile.join(&service.profile_scope),
                ..manifest
            }))
        })();
        tx.commit()?;
        manifest
    }

    /// Grants the single browser-writer lease for one Ghost session on this
    /// computer. Another active writer conflicts; a released, revoked, or
    /// stale-epoch browser lease can never be resurrected.
    pub fn acquire_browser_lease(
        &mut self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<HomeManifest> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let epoch = i64::try_from(authority_epoch)
            .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure!(
            browser_service_is_current(&tx, &self.backends, computer_id, ghost_id, authority_epoch)?,
            "browser service is missing, foreign, revoked, stale, downgraded, or unavailable"
        );
        let manifest = existing_manifest(&self.root, computer_id)?;
        ensure!(
            manifest_roots_are_disjoint(&manifest),
            "computer home, task, and browser roots overlap"
        );
        let existing: Option<(i64, String)> = tx
            .query_row(
                "SELECT epoch, state FROM computer_leases
                 WHERE computer_id=?1 AND execution_id=?2 AND kind='browser'",
                params![computer_id, execution_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let scope = browser_service_scope_of(&tx, computer_id)?;
        let mut manifest = manifest;
        if let Some(scope) = scope {
            manifest.browser_profile = manifest.browser_profile.join(&scope);
        }
        match existing {
            Some((lease_epoch, state)) if lease_epoch == epoch && state == "active" => {
                tx.commit()?;
                return Ok(manifest);
            }
            Some(_) => bail!("browser lease cannot be resurrected"),
            None => {}
        }
        let other_writer: Option<String> = tx
            .query_row(
                "SELECT execution_id FROM computer_leases
                 WHERE computer_id=?1 AND kind='browser' AND state='active'
                 ORDER BY execution_id LIMIT 1",
                [&computer_id],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            other_writer.is_none(),
            "browser profile already has an active writer"
        );
        tx.execute(
            "INSERT INTO computer_leases(computer_id, execution_id, kind, epoch, state)
             VALUES (?1, ?2, 'browser', ?3, 'active')",
            params![computer_id, execution_id, epoch],
        )?;
        tx.commit()?;
        Ok(manifest)
    }

    /// Reports whether this exact Ghost session still owns the current browser
    /// lease with a current service and manifest. Read-only.
    pub fn browser_lease_is_current(
        &self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<bool> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let Ok(epoch) = i64::try_from(authority_epoch) else {
            return Ok(false);
        };
        let tx = self.db.unchecked_transaction()?;
        let current = (|| -> Result<bool> {
            if !browser_service_is_current(&tx, &self.backends, computer_id, ghost_id, authority_epoch)? {
                return Ok(false);
            }
            let lease: Option<(i64, String)> = tx
                .query_row(
                    "SELECT epoch, state FROM computer_leases
                     WHERE computer_id=?1 AND execution_id=?2 AND kind='browser'",
                    params![computer_id, execution_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if lease != Some((epoch, "active".to_owned())) {
                return Ok(false);
            }
            let manifest = existing_manifest(&self.root, computer_id)?;
            Ok(manifest_roots_are_disjoint(&manifest))
        })();
        tx.commit()?;
        current
    }

    /// Releases the exact active browser lease at the current epoch.
    pub fn release_browser_lease(
        &mut self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        authority_epoch: u64,
    ) -> Result<()> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        let epoch = i64::try_from(authority_epoch)
            .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (binding, state) = stored_binding(&tx, computer_id)?
            .ok_or_else(|| anyhow!("computer binding is missing"))?;
        ensure!(
            binding.ghost_id == ghost_id && state == "active" && binding.epoch == authority_epoch,
            "computer binding is foreign, revoked, or at a different authority epoch"
        );
        let changed = tx.execute(
            "UPDATE computer_leases SET state='released'
             WHERE computer_id=?1 AND execution_id=?2 AND kind='browser'
               AND epoch=?3 AND state='active'",
            params![computer_id, execution_id, epoch],
        )?;
        tx.commit()?;
        ensure!(changed == 1, "browser lease is not currently active");
        Ok(())
    }

    /// Apply one authenticated, deduplicated computer-registry command.
    pub fn handle(
        &mut self,
        request: &Envelope,
        authenticated_principal: &str,
    ) -> Result<Response> {
        if let Err(error) = request.validate() {
            return Ok(error_response(
                "invalid_envelope",
                error.to_string(),
                RetryClass::Never,
                Value::Null,
            ));
        }
        if authenticated_principal.is_empty() || request.actor_ref != authenticated_principal {
            return Ok(error_response(
                "unauthorized",
                "authenticated principal does not match envelope actor",
                RetryClass::Never,
                Value::Null,
            ));
        }
        let authority_epoch = match i64::try_from(request.authority_epoch) {
            Ok(epoch) => epoch,
            Err(_) => {
                return Ok(error_response(
                    "invalid_authority_epoch",
                    "authority epoch exceeds the durable registry range",
                    RetryClass::Never,
                    Value::Null,
                ));
            }
        };

        let Self { root, db, backends } = self;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<(String, String, i64, String)> = tx
            .query_row(
                "SELECT payload_digest, actor_ref, authority_epoch, response
                   FROM computer_commands WHERE command_id=?1",
                [&request.command_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((digest, actor, old_epoch, response)) = prior {
            if digest != request.payload_digest
                || actor != authenticated_principal
                || old_epoch != authority_epoch
            {
                tx.commit()?;
                return Ok(error_response(
                    "conflict",
                    "command ID was already used with a different body, actor, or authority epoch",
                    RetryClass::Never,
                    Value::Null,
                ));
            }
            let cached: Response = serde_json::from_str(&response)?;
            tx.commit()?;
            return Ok(cached);
        }

        let response = match dispatch(&tx, root, backends, request, authenticated_principal) {
            Ok(response) => response,
            Err(error) => match error.downcast_ref::<Rejected>() {
                Some(rejection) => rejection.response(),
                None => return Err(error),
            },
        };
        tx.execute(
            "INSERT INTO computer_commands
                 (command_id, payload_digest, actor_ref, authority_epoch, response)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                request.command_id,
                request.payload_digest,
                authenticated_principal,
                authority_epoch,
                serde_json::to_string(&response)?,
            ],
        )?;
        tx.commit()?;
        Ok(response)
    }

    /// Authorizes and executes one computer lifecycle operation. The envelope
    /// method must be `idle_stop` or `recreate`. Authorization is durable and
    /// deduplicated by the caller's command ID; the effect is executed only
    /// once per authorization and its outcome is recorded under a derived
    /// `<command_id>:effect` receipt. A crash between the effect and its
    /// completion re-executes the effect on retry: idle_stop is idempotent
    /// and recreate restarts the local runtime, both documented in
    /// contracts/lifetime/owned-browser-v1.json.
    pub fn handle_lifecycle(
        &mut self,
        request: &Envelope,
        authenticated_principal: &str,
        executor: &dyn ComputerLifecycle,
    ) -> Result<Response> {
        ensure!(
            matches!(
                request.body.get("method").and_then(Value::as_str),
                Some("idle_stop" | "recreate")
            ),
            "lifecycle orchestration requires an idle_stop or recreate envelope"
        );
        let computer_id = request
            .body
            .get("computer_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("lifecycle envelope requires computer_id"))?;
        check_component_arg("computer_id", computer_id)?;
        ensure!(
            request.command_id.len() <= 393,
            "lifecycle command ID leaves no room for its effect receipt"
        );
        let effect_command_id = format!("{}:effect", request.command_id);
        if let Some(completion) = self.cached_response(&effect_command_id)? {
            return Ok(completion);
        }
        let operation = request
            .body
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let authorization = self.handle(request, authenticated_principal)?;
        if authorization.status != ResponseStatus::Success
            || authorization.data.get("authorized").and_then(Value::as_bool) != Some(true)
        {
            return Ok(authorization);
        }
        // Unknown-outcome discipline: the attempt (with the executor's current
        // instance identity) is durable BEFORE the effect. A crash between the
        // attempt and its completion leaves the outcome UNKNOWN — never
        // re-executed; the exact recorded instance must be reconciled first,
        // and no new lifecycle effect runs on this computer until then.
        if let Some(unknown) = self.unknown_lifecycle_attempt(computer_id)? {
            return Ok(warning_response(
                "lifecycle_outcome_unknown",
                "a previous lifecycle attempt has an unknown outcome; reconcile its recorded runtime instance before any new effect",
                RetryClass::ReconcileFirst,
                json!({
                    "computer_id": computer_id,
                    "attempt": unknown,
                    "next_actions": ["reconcile the recorded runtime instance", "resolve the attempt with its verified outcome"],
                }),
            ));
        }
        let instance = executor
            .instance(computer_id)
            .unwrap_or_else(|error| json!({"error": error.to_string()}));
        {
            let tx = self
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO computer_lifecycle_attempts(
                     attempt_id, computer_id, operation, actor_ref, authority_epoch,
                     state, instance_json, outcome_json, started_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'authorized', ?6, NULL, ?7)",
                params![
                    effect_command_id,
                    computer_id,
                    operation,
                    authenticated_principal,
                    i64::try_from(request.authority_epoch)
                        .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?,
                    serde_json::to_string(&instance)?,
                    now_ms()?,
                ],
            )?;
            tx.commit()?;
        }
        let outcome = match operation.as_str() {
            "idle_stop" => executor.idle_stop(computer_id),
            _ => executor.recreate(computer_id),
        }
        .unwrap_or_else(|error| json!({"error": error.to_string()}));
        {
            let changed = self.db.execute(
                "UPDATE computer_lifecycle_attempts SET state='completed', outcome_json=?1
                 WHERE attempt_id=?2 AND state='authorized'",
                params![serde_json::to_string(&outcome)?, effect_command_id],
            )?;
            ensure!(changed == 1, "lifecycle attempt changed during effect");
        }
        let effect_body = json!({
            "method": "lifecycle_effect",
            "computer_id": computer_id,
            "operation": operation,
            "lifecycle_command_id": request.command_id,
            "outcome": outcome,
        });
        let effect = Envelope {
            protocol_version: VERSION.to_owned(),
            command_id: effect_command_id,
            payload_digest: canonical_digest(&effect_body)?,
            actor_ref: request.actor_ref.clone(),
            authority_epoch: request.authority_epoch,
            expected_revision: request.expected_revision,
            correlation_id: request.correlation_id.clone(),
            body: effect_body,
        };
        self.handle(&effect, authenticated_principal)
    }

    /// Authorizes and executes one home privacy-lane migration. The envelope
    /// method must be `migrate_home`. Authorization is durable and
    /// deduplicated by the caller's command ID; the effect runs only once per
    /// authorization and its outcome is recorded under the derived
    /// `<command_id>:effect` receipt. Every unproven original found at the
    /// home root — reserved `public`/`private` names included — is renamed
    /// into the private lane of a uniquely allocated internal layout root
    /// with its inode identity verified: nothing is deleted, nothing is
    /// declassified, and nothing is forwarded anywhere. The pre-effect
    /// inventory recorded on the attempt is the reconciliation truth: a
    /// crash or failed effect leaves the outcome UNKNOWN and refuses every
    /// new lifecycle effect on this computer until the operator resolves
    /// that attempt with the verified outcome. The layout identifier is
    /// committed only by the same transaction that completes the attempt.
    #[cfg(unix)]
    pub fn migrate_home(
        &mut self,
        request: &Envelope,
        authenticated_principal: &str,
    ) -> Result<Response> {
        ensure!(
            request.body.get("method").and_then(Value::as_str) == Some("migrate_home"),
            "home migration requires a migrate_home envelope"
        );
        let computer_id = request
            .body
            .get("computer_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("migration envelope requires computer_id"))?;
        check_component_arg("computer_id", computer_id)?;
        ensure!(
            request.command_id.len() <= 393,
            "migration command ID leaves no room for its effect receipt"
        );
        let effect_command_id = format!("{}:effect", request.command_id);
        if let Some(completion) = self.cached_response(&effect_command_id)? {
            return Ok(completion);
        }
        let authorization = self.handle(request, authenticated_principal)?;
        if authorization.status != ResponseStatus::Success
            || authorization.data.get("authorized").and_then(Value::as_bool) != Some(true)
        {
            return Ok(authorization);
        }
        // Unknown-outcome discipline shared with idle_stop/recreate: the
        // attempt is durable BEFORE the effect and blocks every new effect
        // until the recorded home inventory is reconciled.
        if let Some(unknown) = self.unknown_lifecycle_attempt(computer_id)? {
            return Ok(warning_response(
                "lifecycle_outcome_unknown",
                "a previous lifecycle or migration attempt has an unknown outcome; reconcile its recorded home inventory before any new effect",
                RetryClass::ReconcileFirst,
                json!({
                    "computer_id": computer_id,
                    "attempt": unknown,
                    "next_actions": [
                        "verify the recorded home root entries on disk",
                        "resolve the attempt with its verified outcome",
                    ],
                }),
            ));
        }
        let home_root = existing_manifest(&self.root, computer_id)?.home_volume;
        let mut inventory = home_root_inventory(&home_root)?;
        inventory["committed_layout_id"] = authorization.data["home_lane_state"]["layout_id"].clone();
        {
            let tx = self
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO computer_lifecycle_attempts(
                     attempt_id, computer_id, operation, actor_ref, authority_epoch,
                     state, instance_json, outcome_json, started_at_ms)
                 VALUES (?1, ?2, 'migrate_home', ?3, ?4, 'authorized', ?5, NULL, ?6)",
                params![
                    effect_command_id,
                    computer_id,
                    authenticated_principal,
                    i64::try_from(request.authority_epoch)
                        .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?,
                    serde_json::to_string(&inventory)?,
                    now_ms()?,
                ],
            )?;
            tx.commit()?;
        }
        let outcome = match execute_home_lane_migration(&home_root, computer_id, &inventory) {
            Ok(outcome) => outcome,
            Err(error) => {
                // The attempt stays authorized on purpose: a partially moved
                // home is an UNKNOWN outcome. Only an explicit operator
                // resolution closes it; re-running is refused, never blindly
                // replayed.
                return Ok(warning_response(
                    "migration_outcome_unknown",
                    "home migration effect failed partway; its recorded inventory is the reconciliation truth and blocks every new effect until resolved",
                    RetryClass::ReconcileFirst,
                    json!({
                        "computer_id": computer_id,
                        "attempt_id": effect_command_id,
                        "error": error.to_string(),
                        "next_actions": [
                            "verify which recorded entries are already inside the private lane",
                            "resolve the attempt with the verified outcome",
                        ],
                    }),
                ));
            }
        };
        // The layout identity is committed in the same transaction that
        // completes the attempt: admission authority exists exactly when the
        // migration truth does.
        let layout_id = outcome["layout_id"]
            .as_str()
            .context("migration outcome lacks its layout identity")?
            .to_owned();
        {
            let tx = self
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed = tx.execute(
                "UPDATE computer_lifecycle_attempts SET state='completed', outcome_json=?1
                 WHERE attempt_id=?2 AND state='authorized'",
                params![serde_json::to_string(&outcome)?, effect_command_id],
            )?;
            ensure!(changed == 1, "migration attempt changed during effect");
            tx.execute(
                "INSERT INTO computer_home_layouts(computer_id, layout_id, state, recorded_at_ms)
                 VALUES (?1, ?2, 'committed', ?3)
                 ON CONFLICT(computer_id) DO UPDATE SET
                     layout_id=excluded.layout_id, state='committed',
                     recorded_at_ms=excluded.recorded_at_ms",
                params![computer_id, layout_id, now_ms()?],
            )?;
            tx.commit()?;
        }
        let effect_body = json!({
            "method": "migrate_home_effect",
            "computer_id": computer_id,
            "operation": "migrate_home",
            "migration_command_id": request.command_id,
            "outcome": outcome,
        });
        let effect = Envelope {
            protocol_version: VERSION.to_owned(),
            command_id: effect_command_id,
            payload_digest: canonical_digest(&effect_body)?,
            actor_ref: request.actor_ref.clone(),
            authority_epoch: request.authority_epoch,
            expected_revision: request.expected_revision,
            correlation_id: request.correlation_id.clone(),
            body: effect_body,
        };
        self.handle(&effect, authenticated_principal)
    }

    fn lifecycle_attempt_row(
        &self,
        attempt_id: &str,
    ) -> Result<Option<(String, String, String, i64, String, Option<String>, Option<String>)>> {
        self.db
            .query_row(
                "SELECT computer_id, operation, actor_ref, authority_epoch, state,
                        instance_json, outcome_json
                 FROM computer_lifecycle_attempts WHERE attempt_id=?1",
                [attempt_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn unknown_lifecycle_attempt(&self, computer_id: &str) -> Result<Option<Value>> {
        let row: Option<(String, String, String, i64, Option<String>)> = self
            .db
            .query_row(
                "SELECT attempt_id, operation, actor_ref, authority_epoch, instance_json
                 FROM computer_lifecycle_attempts
                 WHERE computer_id=?1 AND state='authorized'
                 ORDER BY started_at_ms DESC LIMIT 1",
                [computer_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(|(attempt_id, operation, actor, epoch, instance)| {
            json!({
                "attempt_id": attempt_id,
                "operation": operation,
                "actor_ref": actor,
                "authority_epoch": epoch,
                "recorded_instance": instance
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .unwrap_or(Value::Null),
            })
        }))
    }

    /// Records the verified outcome of an unknown lifecycle attempt after the
    /// exact recorded runtime instance was reconciled. Only then can a new
    /// lifecycle effect be authorized for this computer.
    pub fn resolve_lifecycle_attempt(
        &mut self,
        attempt_id: &str,
        resolution: Value,
        resolved_by: &str,
    ) -> Result<()> {
        ensure!(!resolved_by.is_empty() && resolved_by.len() <= 180, "resolver identity is required");
        if canonical_digest(&resolution).is_err() {
            bail!("lifecycle resolution must be a canonical JSON value");
        }
        let Some((computer_id, _, _, _, state, _, _)) = self.lifecycle_attempt_row(attempt_id)?
        else {
            bail!("unknown lifecycle attempt");
        };
        ensure!(state == "authorized", "lifecycle attempt is already {state}");
        let changed = self.db.execute(
            "UPDATE computer_lifecycle_attempts SET state='resolved', outcome_json=?1
             WHERE attempt_id=?2 AND state='authorized'",
            params![
                serde_json::to_string(&json!({"resolution": resolution, "resolved_by": resolved_by}))?,
                attempt_id,
            ],
        )?;
        ensure!(changed == 1, "lifecycle attempt changed during resolution");
        let _ = computer_id;
        Ok(())
    }

    fn cached_response(&self, command_id: &str) -> Result<Option<Response>> {
        let stored: Option<String> = self
            .db
            .query_row(
                "SELECT response FROM computer_commands WHERE command_id=?1",
                [command_id],
                |row| row.get(0),
            )
            .optional()?;
        stored.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
    }

    /// Reads the attached browser service's profile scope. The worker relay
    /// refuses to open a profile whose scope is not its declared grant.
    pub fn browser_service_scope(
        &self,
        computer_id: &str,
        ghost_id: &str,
        authority_epoch: u64,
    ) -> Result<Option<String>> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        let tx = self.db.unchecked_transaction()?;
        let scope = (|| -> Result<Option<String>> {
            let Some((binding, state)) = stored_binding(&tx, computer_id)? else {
                return Ok(None);
            };
            if !home_binding_matches(&binding, &state, computer_id, ghost_id, authority_epoch) {
                return Ok(None);
            }
            let Some((service, service_state)) = stored_browser_service(&tx, computer_id)? else {
                return Ok(None);
            };
            if service_state != "active" || service.epoch != binding.epoch {
                return Ok(None);
            }
            Ok(Some(service.profile_scope))
        })();
        tx.commit()?;
        scope
    }

    /// Records a precise worker browser action proposal. The proposing
    /// execution must hold the current browser lease at the current binding
    /// epoch; the exact arguments digest is bound at proposal time.
    pub fn propose_browser_action(
        &mut self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        arguments_digest: &str,
        authority_epoch: u64,
        detail: &Value,
    ) -> Result<String> {
        check_component_arg("computer_id", computer_id)?;
        check_component_arg("ghost_id", ghost_id)?;
        check_component_arg("execution_id", execution_id)?;
        ensure!(
            arguments_digest.len() == 64
                && arguments_digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "browser action arguments digest must be sha256 hex"
        );
        let epoch = i64::try_from(authority_epoch)
            .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?;
        if canonical_digest(detail).is_err() {
            bail!("browser action detail must be a canonical JSON value");
        }
        ensure!(
            !detail.is_null(),
            "browser action proposal requires the exact operation detail, not a null placeholder"
        );
        let current = self.browser_lease_is_current(computer_id, ghost_id, execution_id, authority_epoch)?;
        ensure!(current, "browser action proposal requires the current browser lease");
        let action_id = format!("ba-{}", uuid::Uuid::now_v7());
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Expire stale proposals: their proposing epoch has moved on.
        tx.execute(
            "UPDATE computer_browser_actions SET state='expired'
             WHERE state='pending' AND computer_id=?2 AND requested_epoch<>?1",
            params![epoch, computer_id],
        )?;
        // One pending proposal per exact execution+arguments: retries reuse
        // the original action identity instead of multiplying requests. The
        // reuse is only valid while the stored detail is EXACTLY the new
        // proposal: a conflicting stored detail means the owner is already
        // reviewing a different question under this identity, and this
        // proposal fails closed rather than silently overwriting it (or
        // returning an approval surface that differs from what was asked).
        let existing: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT action_id, detail_json FROM computer_browser_actions
                 WHERE computer_id=?1 AND execution_id=?2 AND arguments_digest=?3
                   AND requested_epoch=?4 AND state='pending'",
                params![computer_id, execution_id, arguments_digest, epoch],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_id, existing_detail_json)) = existing {
            let stored_digest = existing_detail_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .filter(|value| !value.is_null())
                .map(|value| canonical_digest(&value))
                .transpose()?;
            ensure!(
                stored_digest.as_deref() == Some(canonical_digest(detail)?.as_str()),
                "a pending browser action with the same execution and arguments \
                 already exists with a different stored detail; refusing to \
                 overwrite the proposal under owner review",
            );
            tx.commit()?;
            return Ok(existing_id);
        }
        tx.execute(
            "INSERT INTO computer_browser_actions(
                 action_id, computer_id, execution_id, arguments_digest,
                 requested_epoch, state, approved_by, proposed_at_ms, detail_json)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, ?6, ?7)",
            params![
                action_id,
                computer_id,
                execution_id,
                arguments_digest,
                epoch,
                now_ms()?,
                serde_json::to_string(detail)?,
            ],
        )?;
        tx.commit()?;
        Ok(action_id)
    }

    /// Owner decision on one precise action. Approval requires the exact
    /// pending proposal whose execution still holds its browser and worker
    /// home leases at the same epoch; the approver is recorded for provenance.
    pub fn decide_browser_action(
        &mut self,
        action_id: &str,
        approver: &str,
        approve: bool,
    ) -> Result<BrowserAction> {
        ensure!(
            !approver.is_empty() && approver.len() <= 180,
            "approver identity is required"
        );
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String, String, i64, String)> = tx
            .query_row(
                "SELECT computer_id, execution_id, arguments_digest, requested_epoch, state
                 FROM computer_browser_actions WHERE action_id=?1",
                [action_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((computer_id, execution_id, arguments_digest, requested_epoch, state)) = row
        else {
            bail!("unknown browser action");
        };
        ensure!(state == "pending", "browser action is already {state}");
        let (binding, binding_state) = stored_binding(&tx, &computer_id)?
            .ok_or_else(|| anyhow!("computer binding is missing"))?;
        let requested_epoch_u64 = u64::try_from(requested_epoch)
            .map_err(|_| anyhow!("browser action epoch is invalid"))?;
        let still_current = home_binding_matches(
            &binding,
            &binding_state,
            &computer_id,
            &binding.ghost_id,
            requested_epoch_u64,
        ) && Self::browser_lease_is_current_inner(
                &tx,
                &computer_id,
                &binding.ghost_id,
                &execution_id,
                requested_epoch,
            )?
            && worker_home_lease_rows(&tx, &computer_id, &execution_id, requested_epoch)?
                .is_active_pair(requested_epoch);
        ensure!(
            still_current,
            "browser action proposal is stale; its execution or epoch is no longer current"
        );
        let detail_raw: Option<String> = tx
            .query_row(
                "SELECT detail_json FROM computer_browser_actions WHERE action_id=?1",
                [action_id],
                |row| row.get(0),
            )?;
        // A missing (pre-migration legacy) or null detail is an uncertifiable
        // proposal: the owner can never know what they are approving. The
        // decision is refused and the row stays pending — history is kept,
        // never expired or backfilled with a fabricated empty detail.
        let detail: Value = detail_raw
            .as_deref()
            .map(|raw| serde_json::from_str::<Value>(raw))
            .transpose()?
            .filter(|value| !value.is_null())
            .ok_or_else(|| {
                anyhow!("browser action has no exact stored detail; a legacy or unqualified proposal cannot be certified for approval")
            })?;
        let next_state = if approve { "approved" } else { "denied" };
        let changed = tx.execute(
            "UPDATE computer_browser_actions SET state=?1, approved_by=?2
             WHERE action_id=?3 AND state='pending'",
            params![next_state, approver, action_id],
        )?;
        ensure!(changed == 1, "browser action changed during decision");
        tx.commit()?;
        Ok(BrowserAction {
            action_id: action_id.to_owned(),
            computer_id,
            execution_id,
            arguments_digest,
            requested_epoch: requested_epoch_u64,
            state: next_state.to_owned(),
            approved_by: Some(approver.to_owned()),
            detail,
        })
    }

    /// Expires one pending action: the question was superseded (execution
    /// paused, settled, or fenced). A superseded action can never be approved
    /// or executed; resuming the SAME work creates a fresh exact proposal.
    pub fn expire_browser_action(&mut self, action_id: &str, reason: &str) -> Result<()> {
        ensure!(!reason.is_empty() && reason.len() <= 512, "expiry reason is required");
        let changed = self.db.execute(
            "UPDATE computer_browser_actions SET state='expired', approved_by=?2
             WHERE action_id=?1 AND state='pending'",
            params![action_id, format!("expired:{reason}")],
        )?;
        ensure!(changed == 1, "browser action is not pending");
        Ok(())
    }

    /// Lists pending actions for one computer with their exact normalized
    /// details — the owner's approval surface reads these, never a bare hash.
    pub fn pending_browser_actions(
        &self,
        computer_id: &str,
    ) -> Result<Vec<BrowserAction>> {
        let mut statement = self.db.prepare(
            "SELECT action_id, execution_id, arguments_digest, requested_epoch, approved_by, detail_json
             FROM computer_browser_actions
             WHERE computer_id=?1 AND state='pending' ORDER BY proposed_at_ms",
        )?;
        let rows = statement.query_map([computer_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        let mut actions = Vec::new();
        for row in rows {
            let (action_id, execution_id, arguments_digest, requested_epoch, approved_by, detail_json) = row?;
            actions.push(BrowserAction {
                action_id,
                computer_id: computer_id.to_owned(),
                execution_id,
                arguments_digest,
                requested_epoch: u64::try_from(requested_epoch)
                    .map_err(|_| anyhow!("browser action epoch is invalid"))?,
                state: "pending".to_owned(),
                approved_by,
                detail: detail_json.as_deref().map(serde_json::from_str).transpose()?.unwrap_or(Value::Null),
            });
        }
        Ok(actions)
    }

    /// Sticky-private marker: after human takeover touched a public-scope
    /// profile, it is conservatively treated as private until an explicit
    /// operator reset. No silent declassification, no cookie deletion.
    pub fn mark_browser_profile_contaminated(&mut self, computer_id: &str) -> Result<()> {
        self.db.execute(
            "INSERT INTO computer_browser_contamination(computer_id, marked_at_ms)
             VALUES (?1, ?2)
             ON CONFLICT(computer_id) DO UPDATE SET marked_at_ms=excluded.marked_at_ms",
            params![computer_id, now_ms()?],
        )?;
        Ok(())
    }

    pub fn browser_profile_contaminated(&self, computer_id: &str) -> Result<bool> {
        let marked: Option<i64> = self
            .db
            .query_row(
                "SELECT marked_at_ms FROM computer_browser_contamination WHERE computer_id=?1",
                [computer_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(marked.is_some())
    }

    /// Explicit operator reset: fresh clean public profile. The old contents
    /// are rotated aside (never silently deleted or declassified) and the
    /// sticky marker clears.
    pub fn reset_public_profile(&mut self, computer_id: &str) -> Result<()> {
        let marked = self.browser_profile_contaminated(computer_id)?;
        ensure!(marked, "public profile is not marked contaminated");
        let manifest = existing_manifest(&self.root, computer_id)?;
        let public_dir = manifest.browser_profile.join("public");
        if public_dir.is_dir() {
            let tainted = manifest
                .browser_profile
                .join(format!("private-tainted-{}", now_ms()?));
            std::fs::rename(&public_dir, &tainted)?;
            std::fs::create_dir_all(&public_dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&public_dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        self.db.execute(
            "DELETE FROM computer_browser_contamination WHERE computer_id=?1",
            [computer_id],
        )?;
        Ok(())
    }

    /// Registers (or replaces) the live browser instance a process owns for
    /// this computer. The record is the cross-process stop authority.
    pub fn register_browser_instance(
        &mut self,
        instance: &BrowserInstance,
    ) -> Result<()> {
        self.db.execute(
            "INSERT INTO computer_browser_instances(
                 computer_id, pid, process_group, executable, start_identity, profile_dir,
                 lease_execution_id, authority_epoch, registered_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(computer_id) DO UPDATE SET
                 pid=excluded.pid, process_group=excluded.process_group,
                 executable=excluded.executable, start_identity=excluded.start_identity,
                 profile_dir=excluded.profile_dir,
                 lease_execution_id=excluded.lease_execution_id,
                 authority_epoch=excluded.authority_epoch,
                 registered_at_ms=excluded.registered_at_ms",
            params![
                instance.computer_id,
                instance.pid as i64,
                instance.process_group,
                instance.executable,
                instance.start_identity,
                instance.profile_dir,
                instance.lease_execution_id,
                i64::try_from(instance.authority_epoch)
                    .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?,
                now_ms()?,
            ],
        )?;
        Ok(())
    }

    pub fn browser_instance(&self, computer_id: &str) -> Result<Option<BrowserInstance>> {
        let row: Option<(i64, i64, String, String, String, String, i64)> = self
            .db
            .query_row(
                "SELECT pid, process_group, executable, start_identity, profile_dir, lease_execution_id, authority_epoch
                 FROM computer_browser_instances WHERE computer_id=?1",
                [computer_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(pid, process_group, executable, start_identity, profile_dir, lease_execution_id, authority_epoch)| {
            Ok(BrowserInstance {
                computer_id: computer_id.to_owned(),
                pid: u32::try_from(pid).map_err(|_| anyhow!("registered pid is invalid"))?,
                process_group: i32::try_from(process_group)
                    .map_err(|_| anyhow!("registered process group is invalid"))?,
                executable,
                start_identity,
                profile_dir,
                lease_execution_id,
                authority_epoch: u64::try_from(authority_epoch)
                    .map_err(|_| anyhow!("registered epoch is invalid"))?,
            })
        })
        .transpose()
    }

    /// Clears the instance record only when it still names the exact known
    /// instance; a replaced record refuses so identity is never lost.
    pub fn clear_browser_instance(
        &mut self,
        computer_id: &str,
        pid: u32,
    ) -> Result<()> {
        let changed = self.db.execute(
            "DELETE FROM computer_browser_instances
             WHERE computer_id=?1 AND pid=?2",
            params![computer_id, pid as i64],
        )?;
        ensure!(changed == 1, "browser instance record changed; re-verify before clearing");
        Ok(())
    }

    /// Fetches one browser action's durable state, including the normalized
    /// exact-action detail the owner approved.
    /// Latest immutable proposal for exact Pi effect input, including decisions.
    pub fn browser_action_for_input(&self,computer:&str,execution:&str,digest:&str,epoch:u64)->Result<Option<BrowserAction>> {
        let id:Option<String>=self.db.query_row("SELECT action_id FROM computer_browser_actions WHERE computer_id=?1 AND execution_id=?2 AND arguments_digest=?3 AND requested_epoch=?4 ORDER BY proposed_at_ms DESC LIMIT 1",params![computer,execution,digest,epoch],|r|r.get(0)).optional()?;
        id.map(|id|self.browser_action(&id)).transpose().map(Option::flatten)
    }

    pub fn browser_action(&self, action_id: &str) -> Result<Option<BrowserAction>> {
        let row: Option<(String, String, String, i64, String, Option<String>, Option<String>)> = self
            .db
            .query_row(
                "SELECT computer_id, execution_id, arguments_digest, requested_epoch, state, approved_by, detail_json
                 FROM computer_browser_actions WHERE action_id=?1",
                [action_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(computer_id, execution_id, arguments_digest, requested_epoch, state, approved_by, detail_json)| {
                Ok(BrowserAction {
                    action_id: action_id.to_owned(),
                    computer_id,
                    execution_id,
                    arguments_digest,
                    requested_epoch: u64::try_from(requested_epoch)
                        .map_err(|_| anyhow!("browser action epoch is invalid"))?,
                    state,
                    approved_by,
                    detail: detail_json.as_deref().map(serde_json::from_str).transpose()?.unwrap_or(Value::Null),
                })
            },
        )
        .transpose()
    }

    /// Marks one approved action executed. The caller must present the exact
    /// arguments digest it was approved for; a changed digest refuses.
    pub fn record_browser_action_effect(
        &self,
        action_id: &str,
        arguments_digest: &str,
    ) -> Result<()> {
        let changed = self.db.execute(
            "UPDATE computer_browser_actions SET state='executed'
             WHERE action_id=?1 AND state='approved' AND arguments_digest=?2",
            params![action_id, arguments_digest],
        )?;
        ensure!(changed == 1, "browser action is not in an approved state for this digest");
        Ok(())
    }

    fn browser_lease_is_current_inner(
        tx: &Transaction<'_>,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
        epoch: i64,
    ) -> Result<bool> {
        let Some((binding, state)) = stored_binding(tx, computer_id)? else {
            return Ok(false);
        };
        if !home_binding_matches(&binding, &state, computer_id, ghost_id, epoch as u64) {
            return Ok(false);
        }
        let Some((service, service_state)) = stored_browser_service(tx, computer_id)? else {
            return Ok(false);
        };
        if service_state != "active" || service.epoch != binding.epoch {
            return Ok(false);
        }
        let lease: Option<(i64, String)> = tx
            .query_row(
                "SELECT epoch, state FROM computer_leases
                 WHERE computer_id=?1 AND execution_id=?2 AND kind='browser'",
                params![computer_id, execution_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(lease == Some((epoch, "active".to_owned())))
    }

    /// Explicit dispatch-acceptance precondition: every registered computer
    /// must be active at the exact authority epoch with a runtime acceptance
    /// recorded for that epoch. Returns each offender with its reason.
    pub fn dispatch_ready_computers(&self, epoch: u64) -> Result<BTreeMap<String, String>> {
        let epoch_i = i64::try_from(epoch)
            .map_err(|_| anyhow!("authority epoch exceeds the durable registry range"))?;
        let mut statement = self.db.prepare(
            "SELECT computer_id, state, payload FROM computer_bindings ORDER BY computer_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut offenders = BTreeMap::new();
        for row in rows {
            let (computer_id, state, payload) = row?;
            let binding: ComputerBinding = serde_json::from_str(&payload)?;
            if state != "active" {
                offenders.insert(computer_id.clone(), "binding is revoked; explicit rebind required".to_owned());
                continue;
            }
            if binding.epoch != epoch {
                offenders.insert(
                    computer_id,
                    format!("binding epoch {} does not match authority epoch {epoch_i}", binding.epoch),
                );
                continue;
            }
            let acceptance = self
                .db
                .query_row(
                    "SELECT accepted_epoch FROM computer_runtime_acceptance WHERE computer_id=?1",
                    [&computer_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            match acceptance {
                None => {
                    offenders.insert(computer_id, "no runtime acceptance for this computer".to_owned());
                }
                Some(accepted_epoch) if accepted_epoch != epoch_i => {
                    offenders.insert(
                        computer_id,
                        format!("runtime acceptance epoch {accepted_epoch} does not match authority epoch {epoch_i}"),
                    );
                }
                Some(_) => {}
            }
        }
        Ok(offenders)
    }
}

/// Local runtime effects for an authorized lifecycle operation. Implemented by
/// the process that actually owns the runtime (the Host's owned browser
/// session); a caller without a live runtime must not pretend to execute.
pub trait ComputerLifecycle: Send + Sync {
    fn idle_stop(&self, computer_id: &str) -> Result<Value>;
    fn recreate(&self, computer_id: &str) -> Result<Value>;
    /// Identity of the runtime instance this executor currently owns, recorded
    /// durably BEFORE the effect so a crash leaves a reconcilable attempt
    /// instead of an unknown re-execution.
    fn instance(&self, computer_id: &str) -> Result<Value>;
}

struct HomeLeaseRows {
    process_epoch: Option<i64>,
    process_state: Option<i64>,
    collect_epoch: Option<i64>,
    collect_state: Option<i64>,
    competing_held: bool,
}

impl HomeLeaseRows {
    fn has_records(&self) -> bool {
        self.process_epoch.is_some()
            || self.process_state.is_some()
            || self.collect_epoch.is_some()
            || self.collect_state.is_some()
    }

    fn is_active_pair(&self, epoch: i64) -> bool {
        self.process_epoch == Some(epoch)
            && self.process_state == Some(1)
            && self.collect_epoch == Some(epoch)
            && self.collect_state == Some(1)
    }

    fn is_released_pair(&self, epoch: i64) -> bool {
        self.process_epoch == Some(epoch)
            && self.process_state == Some(2)
            && self.collect_epoch == Some(epoch)
            && self.collect_state == Some(2)
    }

    fn is_revoked_pair(&self, epoch: i64) -> bool {
        self.process_epoch == Some(epoch)
            && self.process_state == Some(3)
            && self.collect_epoch == Some(epoch)
            && self.collect_state == Some(3)
    }
}

fn worker_home_lease_rows(
    tx: &Transaction<'_>,
    computer_id: &str,
    execution_id: &str,
    epoch: i64,
) -> Result<HomeLeaseRows> {
    Ok(tx.query_row(
        "SELECT
             (SELECT epoch FROM computer_leases
              WHERE computer_id=?1 AND execution_id=?2 AND kind='process'),
             (SELECT CASE state WHEN 'active' THEN 1 WHEN 'released' THEN 2
                                WHEN 'revoked' THEN 3 ELSE 0 END
              FROM computer_leases
              WHERE computer_id=?1 AND execution_id=?2 AND kind='process'),
             (SELECT epoch FROM computer_leases
              WHERE computer_id=?1 AND execution_id=?2 AND kind='collect'),
             (SELECT CASE state WHEN 'active' THEN 1 WHEN 'released' THEN 2
                                WHEN 'revoked' THEN 3 ELSE 0 END
              FROM computer_leases
              WHERE computer_id=?1 AND execution_id=?2 AND kind='collect'),
             EXISTS(
                 SELECT 1 FROM computer_leases
                 WHERE computer_id=?1 AND kind IN ('process','collect')
                   AND state IN ('active','revoked')
                   AND (execution_id<>?2 OR epoch<>?3)
             )",
        params![computer_id, execution_id, epoch],
        |row| {
            Ok(HomeLeaseRows {
                process_epoch: row.get(0)?,
                process_state: row.get(1)?,
                collect_epoch: row.get(2)?,
                collect_state: row.get(3)?,
                competing_held: row.get(4)?,
            })
        },
    )?)
}

fn home_binding_matches(
    binding: &ComputerBinding,
    state: &str,
    computer_id: &str,
    ghost_id: &str,
    authority_epoch: u64,
) -> bool {
    state == "active"
        && binding.computer_id == computer_id
        && binding.ghost_id == ghost_id
        && binding.epoch == authority_epoch
}

fn home_backend_is_current(
    binding: &ComputerBinding,
    registration: &RegisteredBackend,
) -> Result<bool> {
    if !registration.configured() || !registration.available() {
        return Ok(false);
    }
    let offered = capability_mask(registration.capabilities());
    let bound = capability_mask_for_values(&binding.capabilities)?;
    let accepted = capability_mask_for_values(&binding.accepted_capabilities)?;
    let trusted = capability_mask_for_values(&registration.accepted_capabilities)?;
    Ok(bound & !offered == 0
        && accepted & !bound == 0
        && accepted & !offered == 0
        && accepted & !trusted == 0
        && accepted & REQUIRED_HOME_CAPABILITIES == REQUIRED_HOME_CAPABILITIES)
}

fn capability_mask(capabilities: ComputerCapabilities) -> u8 {
    let mut mask = 0;
    if capabilities.shell {
        mask |= CAPABILITY_SHELL;
    }
    if capabilities.persistent_filesystem {
        mask |= CAPABILITY_PERSISTENT_FILESYSTEM;
    }
    if capabilities.browser {
        mask |= 1 << 2;
    }
    if capabilities.human_control {
        mask |= 1 << 3;
    }
    mask
}

fn capability_mask_for_values<'a>(
    values: impl IntoIterator<Item = &'a String>,
) -> Result<u8> {
    let mut mask = 0;
    for value in values {
        let bit = match value.as_str() {
            "shell" => CAPABILITY_SHELL,
            "persistent_filesystem" => CAPABILITY_PERSISTENT_FILESYSTEM,
            "browser" => 1 << 2,
            "human_control" => 1 << 3,
            _ => bail!("computer registry contains an invalid capability"),
        };
        if mask & bit != 0 {
            bail!("computer registry contains a duplicate capability");
        }
        mask |= bit;
    }
    Ok(mask)
}

fn manifest_roots_are_disjoint(manifest: &HomeManifest) -> bool {
    let roots = [
        manifest.home_volume.as_path(),
        manifest.task_snapshot_root.as_path(),
        manifest.browser_profile.as_path(),
    ];
    for left in 0..roots.len() {
        for right in (left + 1)..roots.len() {
            if roots[left] == roots[right]
                || roots[left].starts_with(roots[right])
                || roots[right].starts_with(roots[left])
            {
                return false;
            }
        }
    }
    true
}

fn dispatch(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    let method = request
        .body
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::Error::new(Rejected::new(
            "invalid_command",
            "command method is required",
            RetryClass::Never,
            Value::Null,
        )))?;
    match method {
        "bind" => bind(tx, root, backends, request, principal),
        "inspect" => {
            require_shape(&request.body, &["method", "computer_id"])?;
            let id = required_string(&request.body, "computer_id")?;
            check_component_arg("computer_id", &id)?;
            let (binding, state) = owned_binding(tx, &id, principal)?;
            let view = computer_view(tx, root, backends, &binding, &state)?;
            Ok(view_response(view, "computer inspected"))
        }
        "list" => {
            require_shape(&request.body, &["method"])?;
            list(tx, root, backends, principal)
        }
        "lease" => lease(tx, root, backends, request, principal),
        "release" => release(tx, root, backends, request, principal),
        "revoke" => revoke(tx, root, backends, request, principal),
        "recreate" => lifecycle_plan(tx, root, backends, request, principal, "recreate"),
        "idle_stop" => lifecycle_plan(tx, root, backends, request, principal, "idle_stop"),
        #[cfg(unix)]
        "migrate_home" => migrate_home_plan(tx, root, backends, request, principal),
        #[cfg(unix)]
        "migrate_home_effect" => migrate_home_effect(tx, root, backends, request, principal),
        "attach_browser" => attach_browser(tx, root, backends, request, principal),
        "detach_browser" => detach_browser(tx, root, backends, request, principal),
        "accept_runtime" => accept_runtime(tx, root, backends, request, principal),
        "lifecycle_effect" => lifecycle_effect(tx, root, backends, request, principal),
        _ => Err(anyhow::Error::new(Rejected::new(
            "unsupported_command",
            "unsupported computer registry command",
            RetryClass::Never,
            Value::Null,
        ))),
    }
}

fn bind(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(&request.body, &["method", "binding"])?;
    let binding_value = request.body.get("binding").cloned().ok_or_else(|| {
        anyhow::Error::new(Rejected::new(
            "invalid_command",
            "binding is required",
            RetryClass::Never,
            Value::Null,
        ))
    })?;
    let mut binding: ComputerBinding = serde_json::from_value(binding_value).map_err(|_| {
        anyhow::Error::new(Rejected::new(
            "invalid_binding",
            "binding does not match the frozen ComputerBinding contract",
            RetryClass::Never,
            Value::Null,
        ))
    })?;
    check_component_arg("computer_id", &binding.computer_id)?;
    if binding.ghost_id != principal {
        return reject(
            "unauthorized",
            "binding Ghost does not match the authenticated principal",
            RetryClass::Never,
            Value::Null,
        );
    }
    if binding.ghost_id.is_empty() || binding.host_id.is_empty() {
        return reject(
            "invalid_binding",
            "binding Ghost and host IDs must be nonempty",
            RetryClass::Never,
            Value::Null,
        );
    }
    let registration = backends.get(&binding.backend).ok_or_else(|| {
        anyhow::Error::new(Rejected::new(
            "unknown_backend",
            "binding names an unregistered backend",
            RetryClass::ReconcileFirst,
            Value::Null,
        ))
    })?;
    let offered = capability_names(registration.capabilities());
    let requested_capabilities = request_capability_set(&binding.capabilities)?;
    let requested_accepted = request_capability_set(&binding.accepted_capabilities)?;
    if requested_capabilities != offered {
        return reject(
            "capability_mismatch",
            "binding capabilities must exactly match the backend's current offered set",
            RetryClass::NewRevision,
            json!({"offered_capabilities": strings(&offered)}),
        );
    }
    if !requested_accepted.is_subset(&offered)
        || !requested_accepted.is_subset(&registration.accepted_capabilities)
    {
        return reject(
            "capability_not_accepted",
            "binding requests a capability outside the backend's trusted acceptance set",
            RetryClass::Never,
            json!({
                "offered_capabilities": strings(&offered),
                "trusted_accepted_capabilities": strings(&registration.accepted_capabilities),
            }),
        );
    }
    binding.capabilities = strings(&requested_capabilities);
    binding.accepted_capabilities = strings(&requested_accepted);

    let previous = stored_binding(tx, &binding.computer_id)?;
    match previous {
        None => {
            if request.expected_revision.is_some()
                || binding.epoch != request.authority_epoch
                || binding.epoch != 1
                || binding.grant_revision != 1
            {
                return reject(
                    "revision_conflict",
                    "a new binding starts at epoch 1 and grant revision 1 without an expected revision",
                    RetryClass::NewRevision,
                    Value::Null,
                );
            }
            let (_, home_layout_id) = create_manifest(root, &binding.computer_id)?;
            tx.execute(
                "INSERT INTO computer_bindings(computer_id, ghost_id, backend, state, payload)
                 VALUES (?1, ?2, ?3, 'active', ?4)",
                params![
                    binding.computer_id,
                    binding.ghost_id,
                    binding.backend,
                    serde_json::to_string(&binding)?,
                ],
            )?;
            tx.execute(
                "INSERT INTO computer_home_layouts(computer_id, layout_id, state, recorded_at_ms)
                 VALUES (?1, ?2, 'committed', ?3)
                 ON CONFLICT(computer_id) DO UPDATE SET
                     layout_id=excluded.layout_id, state='committed',
                     recorded_at_ms=excluded.recorded_at_ms",
                params![binding.computer_id, home_layout_id, now_ms()?],
            )?;
        }
        Some((old, state)) => {
            if old.ghost_id != principal {
                return reject(
                    "unauthorized",
                    "computer is not bound to the authenticated principal",
                    RetryClass::Never,
                    Value::Null,
                );
            }
            check_epoch(request, &old)?;
            let next_epoch = next_revision(old.epoch, "binding epoch")?;
            let next_grant_revision = next_revision(old.grant_revision, "grant revision")?;
            if request.expected_revision != Some(old.grant_revision)
                || binding.epoch != next_epoch
                || binding.grant_revision != next_grant_revision
            {
                return reject(
                    "revision_conflict",
                    "binding update must advance the expected grant revision and epoch by one",
                    RetryClass::NewRevision,
                    json!({"binding": old}),
                );
            }
            if has_active_leases(tx, &binding.computer_id)? {
                return reject(
                    "leases_active",
                    "binding cannot change while process, browser, or collection leases are active",
                    RetryClass::ReconcileFirst,
                    json!({"computer_id": binding.computer_id}),
                );
            }
            if state != "active" && state != "revoked" {
                bail!("computer registry contains an invalid binding state");
            }
            // Rebind repairs the binding only; it never provisions lanes and
            // never inspects home contents. A legacy root stays exactly as it
            // is: home admission (acquire and mount) fails closed until the
            // explicit operator migration, which requires this active
            // binding.
            ensure_existing_roots(root, &binding.computer_id)?;
            tx.execute(
                "UPDATE computer_bindings SET ghost_id=?1, backend=?2, state='active', payload=?3
                 WHERE computer_id=?4",
                params![
                    binding.ghost_id,
                    binding.backend,
                    serde_json::to_string(&binding)?,
                    binding.computer_id,
                ],
            )?;
        }
    }
    let view = computer_view(tx, root, backends, &binding, "active")?;
    Ok(view_response(view, "computer binding stored"))
}

fn lease(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(
        &request.body,
        &["method", "computer_id", "execution_id", "kind"],
    )?;
    let id = required_string(&request.body, "computer_id")?;
    let execution_id = required_string(&request.body, "execution_id")?;
    check_component_arg("computer_id", &id)?;
    check_component_arg("execution_id", &execution_id)?;
    let kind_raw = required_string(&request.body, "kind")?;
    let kind = LeaseKind::parse(&kind_raw).map_err(anyhow::Error::new)?;
    let (binding, state) = owned_binding(tx, &id, principal)?;
    ensure_active_epoch(request, &binding, &state)?;
    ensure_optional_revision(request, &binding)?;
    let registration = backends.get(&binding.backend).ok_or_else(|| {
        anyhow::Error::new(Rejected::new(
            "backend_unavailable",
            "computer backend is not registered in this process",
            RetryClass::ReconcileFirst,
            Value::Null,
        ))
    })?;
    if registration.is_native_worker()
        && matches!(kind, LeaseKind::Process | LeaseKind::Collect)
    {
        return reject(
            "atomic_home_lease_required",
            "native process and collection leases require atomic worker-home acquisition",
            RetryClass::Never,
            json!({"required_api": "acquire_worker_home"}),
        );
    }
    if kind == LeaseKind::Browser {
        // Browser work is granted only through the attached browser service,
        // never through the computer's primary home backend.
        if !browser_service_is_current(tx, backends, &id, principal, request.authority_epoch)? {
            return reject(
                "browser_service_unavailable",
                "browser leases require a current attached browser service at the binding epoch",
                RetryClass::ReconcileFirst,
                json!({"computer_id": id}),
            );
        }
        let other_writer: Option<String> = tx
            .query_row(
                "SELECT execution_id FROM computer_leases
                 WHERE computer_id=?1 AND kind='browser' AND state='active'
                 ORDER BY execution_id LIMIT 1",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(owner) = other_writer {
            if owner != execution_id {
                return reject(
                    "lease_conflict",
                    "browser profile already has an active writer",
                    RetryClass::ReconcileFirst,
                    json!({"active_execution_id": owner}),
                );
            }
        }
        let epoch = i64::try_from(binding.epoch)
            .map_err(|_| anyhow!("binding epoch exceeds SQLite integer range"))?;
        tx.execute(
            "INSERT INTO computer_leases(computer_id, execution_id, kind, epoch, state)
             VALUES (?1, ?2, ?3, ?4, 'active')
             ON CONFLICT(computer_id, execution_id, kind) DO UPDATE SET
                 epoch=excluded.epoch, state='active'",
            params![id, execution_id, kind.as_str(), epoch],
        )?;
        let lease = LeaseView {
            computer_id: id.clone(),
            execution_id,
            kind,
            epoch: binding.epoch,
            state: "active".to_owned(),
        };
        let mut view = computer_view(tx, root, backends, &binding, &state)?;
        view["lease"] = serde_json::to_value(lease)?;
        return Ok(view_response(view, "computer lease granted"));
    }
    let offered = capability_names(registration.capabilities());
    let bound_capabilities = capability_set_stored(&binding.capabilities)?;
    let accepted = capability_set_stored(&binding.accepted_capabilities)?;
    if !bound_capabilities.is_subset(&offered)
        || !accepted.is_subset(&offered)
        || !accepted.is_subset(&registration.accepted_capabilities)
    {
        return reject(
            "capability_downgrade",
            "backend capabilities changed; inspect and explicitly rebind before leasing",
            RetryClass::NewRevision,
            json!({"offered_capabilities": strings(&offered)}),
        );
    }
    if !registration.configured() || !registration.available() {
        return reject(
            "backend_unavailable",
            "computer backend is configured or available only for inspection; execution is unavailable",
            RetryClass::ReconcileFirst,
            json!({
                "configured": registration.configured(),
                "available": registration.available(),
            }),
        );
    }
    let required = kind.required_capability();
    if !accepted.contains(required) {
        return reject(
            "capability_not_accepted",
            "lease requires a capability that is not currently accepted",
            RetryClass::Never,
            json!({
                "required_capability": required,
                "offered_capabilities": strings(&offered),
                "accepted_capabilities": strings(&accepted),
            }),
        );
    }
    let epoch = i64::try_from(binding.epoch)
        .map_err(|_| anyhow!("binding epoch exceeds SQLite integer range"))?;
    tx.execute(
        "INSERT INTO computer_leases(computer_id, execution_id, kind, epoch, state)
         VALUES (?1, ?2, ?3, ?4, 'active')
         ON CONFLICT(computer_id, execution_id, kind) DO UPDATE SET
             epoch=excluded.epoch, state='active'",
        params![id, execution_id, kind.as_str(), epoch],
    )?;
    let lease = LeaseView {
        computer_id: id.clone(),
        execution_id,
        kind,
        epoch: binding.epoch,
        state: "active".to_owned(),
    };
    let mut view = computer_view(tx, root, backends, &binding, &state)?;
    view["lease"] = serde_json::to_value(lease)?;
    Ok(view_response(view, "computer lease granted"))
}

fn release(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(
        &request.body,
        &["method", "computer_id", "execution_id", "kind"],
    )?;
    let id = required_string(&request.body, "computer_id")?;
    let execution_id = required_string(&request.body, "execution_id")?;
    check_component_arg("computer_id", &id)?;
    check_component_arg("execution_id", &execution_id)?;
    let kind = LeaseKind::parse(&required_string(&request.body, "kind")?)
        .map_err(anyhow::Error::new)?;
    let (binding, state) = owned_binding(tx, &id, principal)?;
    ensure_active_epoch(request, &binding, &state)?;
    ensure_optional_revision(request, &binding)?;
    let changed = tx.execute(
        "UPDATE computer_leases SET state='released'
         WHERE computer_id=?1 AND execution_id=?2 AND kind=?3 AND epoch=?4 AND state='active'",
        params![
            id,
            execution_id,
            kind.as_str(),
            i64::try_from(binding.epoch)
                .map_err(|_| anyhow!("binding epoch exceeds SQLite integer range"))?,
        ],
    )?;
    let mut view = computer_view(tx, root, backends, &binding, &state)?;
    view["released"] = Value::Bool(changed == 1);
    Ok(view_response(view, "computer lease released or already inactive"))
}

fn revoke(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(&request.body, &["method", "computer_id"])?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let (mut binding, state) = owned_binding(tx, &id, principal)?;
    check_epoch(request, &binding)?;
    if request.expected_revision != Some(binding.grant_revision) {
        return reject(
            "revision_conflict",
            "revoke requires the current grant revision",
            RetryClass::NewRevision,
            json!({"grant_revision": binding.grant_revision}),
        );
    }
    if state == "revoked" {
        let view = computer_view(tx, root, backends, &binding, &state)?;
        return Ok(view_response(view, "computer was already revoked"));
    }
    let prior_epoch = binding.epoch;
    binding.epoch = next_revision(binding.epoch, "binding epoch")?;
    binding.grant_revision = next_revision(binding.grant_revision, "grant revision")?;
    binding.accepted_capabilities.clear();
    tx.execute(
        "UPDATE computer_bindings SET state='revoked', payload=?1 WHERE computer_id=?2",
        params![serde_json::to_string(&binding)?, id],
    )?;
    tx.execute(
        "UPDATE computer_leases SET state='revoked'
         WHERE computer_id=?1 AND state='active'",
        [&id],
    )?;
    // The attached browser gate rides the same authority: revoke fences it and
    // it can only return through an explicit attach at the next epoch.
    if let Some((mut service, service_state)) = stored_browser_service(tx, &id)? {
        if service_state == "active" {
            service.epoch = binding.epoch;
            service.grant_revision = next_revision(
                service.grant_revision,
                "browser service grant revision",
            )?;
            service.accepted_capabilities.clear();
            tx.execute(
                "UPDATE computer_browser_services SET state='revoked', payload=?1
                 WHERE computer_id=?2",
                params![serde_json::to_string(&service)?, id],
            )?;
        }
    }
    let view = computer_view(tx, root, backends, &binding, "revoked")?;
    Ok(view_response(
        view,
        format!("computer revoked from epoch {prior_epoch}"),
    ))
}

fn lifecycle_plan(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
    operation: &str,
) -> Result<Response> {
    require_shape(&request.body, &["method", "computer_id"])?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let (binding, state) = owned_binding(tx, &id, principal)?;
    ensure_active_epoch(request, &binding, &state)?;
    ensure_optional_revision(request, &binding)?;
    // Browser leases belong to the runtime being stopped or recreated; they
    // are released by the effect itself. Worker compute must not be running.
    let compute_active: Vec<LeaseView> = active_leases(tx, &id)?
        .into_iter()
        .filter(|lease| !matches!(lease.kind, LeaseKind::Browser))
        .collect();
    if !compute_active.is_empty() {
        return reject(
            "leases_active",
            "recreate and idle_stop are refused while any process or collection lease is active",
            RetryClass::ReconcileFirst,
            json!({"leases": compute_active}),
        );
    }
    let registration = backends.get(&binding.backend);
    let Some(acceptance) = stored_runtime_acceptance(tx, &id)? else {
        let mut data = computer_view(tx, root, backends, &binding, &state)?;
        data["operation"] = Value::String(operation.to_owned());
        data["executed"] = Value::Bool(false);
        data["authorized"] = Value::Bool(false);
        return Ok(warning_response(
            "runtime_not_accepted",
            format!("{operation} was not authorized; no runtime has been explicitly accepted for this computer epoch"),
            RetryClass::ReconcileFirst,
            data,
        ));
    };
    let Some(facts) = registration.and_then(|registered| registered.runtime.as_ref()) else {
        return reject(
            "runtime_unavailable",
            "accepted runtime has no currently probed registration; reconcile the backend before lifecycle execution",
            RetryClass::ReconcileFirst,
            json!({"accepted_runtime_kind": acceptance.runtime_kind}),
        );
    };
    if acceptance.runtime_kind != facts.kind
        || acceptance.executable_sha256 != facts.executable_sha256
    {
        return reject(
            "runtime_changed",
            "the accepted runtime no longer matches its probed registration; accept the current runtime explicitly",
            RetryClass::ReconcileFirst,
            json!({
                "accepted_runtime_kind": acceptance.runtime_kind,
                "probed_runtime_kind": facts.kind,
            }),
        );
    }
    if acceptance.accepted_epoch
        != i64::try_from(binding.epoch)
            .map_err(|_| anyhow!("binding epoch exceeds SQLite integer range"))?
    {
        return reject(
            "stale_runtime_acceptance",
            "runtime acceptance predates the current binding epoch; accept the runtime for this epoch",
            RetryClass::NewRevision,
            json!({
                "accepted_epoch": acceptance.accepted_epoch,
                "binding_epoch": binding.epoch,
            }),
        );
    }
    let mut data = computer_view(tx, root, backends, &binding, &state)?;
    data["operation"] = Value::String(operation.to_owned());
    data["executed"] = Value::Bool(false);
    data["authorized"] = Value::Bool(true);
    data["runtime"] = json!({
        "kind": facts.kind,
        "executable_sha256": facts.executable_sha256,
        "accepted_epoch": acceptance.accepted_epoch,
    });
    Ok(success_response(
        format!("{operation} authorized for the accepted runtime; the lifecycle executor must confirm the effect"),
        data,
    ))
}

/// Authorization for one home privacy-lane migration: the binding must be
/// current and native-worker, no execution may hold or reserve the home, and
/// divergence from the committed layout (for example a replaced marker or a
/// forged extra entry) is refused before any attempt is recorded.
#[cfg(unix)]
fn migrate_home_plan(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    use std::os::unix::fs::MetadataExt;

    require_shape(&request.body, &["method", "computer_id"])?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let (binding, state) = owned_binding(tx, &id, principal)?;
    ensure_active_epoch(request, &binding, &state)?;
    ensure_optional_revision(request, &binding)?;
    if binding.backend != NATIVE_WORKER_BACKEND_ID {
        return reject(
            "backend_unsupported",
            "home privacy lanes exist only for the native worker home backend",
            RetryClass::Never,
            json!({"backend": binding.backend}),
        );
    }
    // Stopped boundary: migration is refused while any execution still holds
    // or reserves the home. A revoked reservation is a cleanup tombstone
    // whose home may still be mounted, so it blocks exactly like an active
    // lease.
    let mut held = Vec::new();
    {
        let mut statement = tx.prepare(
            "SELECT execution_id, kind, epoch, state FROM computer_leases
             WHERE computer_id=?1 AND kind IN ('process','collect')
               AND state IN ('active','revoked')
             ORDER BY execution_id, kind",
        )?;
        let mut rows = statement.query_map([id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        while let Some(row) = rows.next() {
            let (execution_id, kind, epoch, lease_state) = row?;
            held.push(json!({
                "execution_id": execution_id,
                "kind": kind,
                "epoch": u64::try_from(epoch).unwrap_or(0),
                "state": lease_state,
            }));
        }
    }
    if !held.is_empty() {
        return reject(
            "home_lease_held",
            "home migration is refused while any process or collection lease is active or revoked; stop and settle the original worker first",
            RetryClass::ReconcileFirst,
            json!({"computer_id": id, "leases": held}),
        );
    }
    let home_root = existing_manifest(root, &id)?.home_volume;
    let metadata = fs::symlink_metadata(&home_root)?;
    ensure!(
        !metadata.file_type().is_symlink()
            && metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() },
        "registered home root identity rejected during migration planning"
    );
    // The registry-attested layout itself must remain valid. Stray root
    // entries are unclassified originals, not grounds to reject the explicit
    // operator action that is required to move them into its private lane.
    let committed: Option<String> = tx
        .query_row(
            "SELECT layout_id FROM computer_home_layouts
             WHERE computer_id=?1 AND state='committed'",
            [id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let home_lane_state = match committed {
        Some(layout_id) => match home_lanes::open_layout_by_marker(
            &home_root.join(home_lanes::layout_dir_name(&layout_id)), &layout_id, &id,
        ) {
            Ok(_) => json!({"state": "committed", "layout_id": layout_id}),
            Err(error) => {
                return reject(
                    "home_root_forged",
                    format!("committed home layout no longer matches its registry identity: {error}"),
                    RetryClass::Never,
                    json!({"computer_id": id}),
                );
            }
        },
        None => {
            for name in home_lanes::root_entry_names(&home_root)? {
                let entry_metadata = fs::symlink_metadata(home_root.join(&name))?;
                let kind = entry_metadata.file_type();
                ensure!(
                    kind.is_dir() || kind.is_file() || kind.is_symlink(),
                    "home root entry '{name}' is an unsupported special file"
                );
            }
            json!({"state": "legacy_unclassified"})
        }
    };
    let mut data = computer_view(tx, root, backends, &binding, &state)?;
    data["operation"] = Value::String("migrate_home".to_owned());
    data["executed"] = Value::Bool(false);
    data["authorized"] = Value::Bool(true);
    data["home_lane_state"] = home_lane_state;
    Ok(success_response(
        "home lane migration authorized; the registry must record and confirm the effect",
        data,
    ))
}

#[cfg(unix)]
fn migrate_home_effect(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(
        &request.body,
        &["method", "computer_id", "operation", "migration_command_id", "outcome"],
    )?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let operation = required_string(&request.body, "operation")?;
    if operation != "migrate_home" {
        return reject(
            "invalid_command",
            "migration effect operation must be migrate_home",
            RetryClass::Never,
            Value::Null,
        );
    }
    let migration_command_id = required_string(&request.body, "migration_command_id")?;
    let outcome = request.body.get("outcome").cloned().unwrap_or(Value::Null);
    if canonical_digest(&outcome).is_err() {
        return reject(
            "invalid_command",
            "migration outcome must be a canonical JSON value without floating points",
            RetryClass::Never,
            Value::Null,
        );
    }
    let (binding, state) = owned_binding(tx, &id, principal)?;
    // The effect may already have run when this completion arrives; it is
    // recorded truthfully, including whether authority moved underneath it.
    let fenced = state != "active" || binding.epoch != request.authority_epoch;
    let authorization = tx
        .query_row(
            "SELECT actor_ref, authority_epoch, response FROM computer_commands
             WHERE command_id=?1",
            [&migration_command_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .filter(|(actor, epoch, _)| {
            actor == principal
                && *epoch
                    == i64::try_from(request.authority_epoch)
                        .unwrap_or_default()
        })
        .map(|(_, _, response)| response)
        .and_then(|response| serde_json::from_str::<Response>(&response).ok())
        .filter(|response| {
            response.data.get("authorized").and_then(Value::as_bool) == Some(true)
                && response.data.get("operation").and_then(Value::as_str) == Some("migrate_home")
        });
    if authorization.is_none() {
        return reject(
            "unknown_migration_authorization",
            "migration effect names no matching authorized command for this actor and epoch",
            RetryClass::Never,
            Value::Null,
        );
    }
    let mut data = computer_view(tx, root, backends, &binding, &state)?;
    data["operation"] = Value::String(operation.clone());
    data["executed"] = Value::Bool(!fenced);
    data["authorized"] = Value::Bool(true);
    data["fenced"] = Value::Bool(fenced);
    data["migration_command_id"] = Value::String(migration_command_id);
    data["outcome"] = outcome;
    if fenced {
        Ok(warning_response(
            "migration_fenced",
            "migration effect was recorded after its authority was fenced",
            RetryClass::NewRevision,
            data,
        ))
    } else {
        Ok(success_response(
            "home lane migration effect recorded",
            data,
        ))
    }
}

fn attach_browser(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(&request.body, &["method", "computer_id", "service"])?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let service: BrowserServiceBinding = serde_json::from_value(
        request
            .body
            .get("service")
            .cloned()
            .ok_or_else(|| anyhow::Error::new(Rejected::new(
                "invalid_command",
                "service is required",
                RetryClass::Never,
                Value::Null,
            )))?,
    )
    .map_err(|_| {
        anyhow::Error::new(Rejected::new(
            "invalid_service",
            "service does not match the browser service contract",
            RetryClass::Never,
            Value::Null,
        ))
    })?;
    let (binding, state) = owned_binding(tx, &id, principal)?;
    ensure_active_epoch(request, &binding, &state)?;
    // The binding epoch fences authority. expected_revision belongs to the
    // browser service below, not the independently versioned computer grant.
    BrowserServiceBinding::validate_profile_scope(&service.profile_scope).map_err(|_| {
        anyhow::Error::new(Rejected::new(
            "invalid_service",
            "browser service profile scope must be public or private",
            RetryClass::Never,
            Value::Null,
        ))
    })?;
    if service.computer_id != id || service.ghost_id != principal {
        return reject(
            "unauthorized",
            "browser service must address its own authenticated computer binding",
            RetryClass::Never,
            Value::Null,
        );
    }
    if service.host_id.is_empty() || service.host_id != binding.host_id {
        return reject(
            "invalid_service",
            "browser service host differs from the computer binding host",
            RetryClass::Never,
            Value::Null,
        );
    }
    if service.epoch != binding.epoch {
        return reject(
            "stale_epoch",
            "browser service must ride the current binding epoch",
            RetryClass::NewRevision,
            json!({"binding_epoch": binding.epoch}),
        );
    }
    let registration = backends.get(&service.backend).ok_or_else(|| {
        anyhow::Error::new(Rejected::new(
            "unknown_backend",
            "browser service names an unregistered backend",
            RetryClass::ReconcileFirst,
            Value::Null,
        ))
    })?;
    let offered = capability_names(registration.capabilities());
    let requested_capabilities = request_capability_set(&service.capabilities)?;
    let requested_accepted = request_capability_set(&service.accepted_capabilities)?;
    if requested_capabilities != offered {
        return reject(
            "capability_mismatch",
            "browser service capabilities must exactly match the backend's current offered set",
            RetryClass::NewRevision,
            json!({"offered_capabilities": strings(&offered)}),
        );
    }
    if !requested_accepted.contains("browser")
        || !requested_accepted.is_subset(&offered)
        || !requested_accepted.is_subset(&registration.accepted_capabilities)
    {
        return reject(
            "capability_not_accepted",
            "browser service requests a capability outside the backend's trusted acceptance set",
            RetryClass::Never,
            json!({
                "offered_capabilities": strings(&offered),
                "trusted_accepted_capabilities": strings(&registration.accepted_capabilities),
            }),
        );
    }
    let mut service = service;
    service.capabilities = strings(&requested_capabilities);
    service.accepted_capabilities = strings(&requested_accepted);
    let previous = stored_browser_service(tx, &id)?;
    match previous {
        None => {
            ensure!(
                service.grant_revision == 1,
                "a new browser service starts at grant revision 1"
            );
        }
        Some((old, previous_state)) => {
            ensure!(
                matches!(previous_state.as_str(), "active" | "revoked"),
                "computer registry contains an invalid browser service state"
            );
            let next = next_revision(old.grant_revision, "browser service grant revision")?;
            if request.expected_revision != Some(old.grant_revision)
                || service.grant_revision != next
            {
                return reject(
                    "revision_conflict",
                    "browser service update must advance the expected grant revision by one",
                    RetryClass::NewRevision,
                    json!({"service": old}),
                );
            }
            let writer: Option<String> = tx
                .query_row(
                    "SELECT execution_id FROM computer_leases
                     WHERE computer_id=?1 AND kind='browser' AND state='active'
                     ORDER BY execution_id LIMIT 1",
                    [&id],
                    |row| row.get(0),
                )
                .optional()?;
            ensure!(
                writer.is_none(),
                "browser service cannot change while a browser lease is active"
            );
        }
    }
    if !registration.configured() || !registration.available() {
        return reject(
            "backend_unavailable",
            "browser service backend is not currently configured or available",
            RetryClass::ReconcileFirst,
            json!({
                "configured": registration.configured(),
                "available": registration.available(),
            }),
        );
    }
    let service_state = if state == "active" { "active" } else { "revoked" };
    tx.execute(
        "INSERT INTO computer_browser_services(computer_id, backend, state, payload)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(computer_id) DO UPDATE SET
             backend=excluded.backend, state=excluded.state, payload=excluded.payload",
        params![
            id,
            service.backend,
            service_state,
            serde_json::to_string(&service)?,
        ],
    )?;
    let view = browser_service_view(Some(&service), service_state, tx, &id)?;
    let mut data = computer_view(tx, root, backends, &binding, &state)?;
    data["browser_service"] = view;
    Ok(view_response(data, "browser service attached"))
}

fn detach_browser(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(
        &request.body,
        &["method", "computer_id", "expected_revision"],
    )?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let expected_revision = request
        .body
        .get("expected_revision")
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| anyhow::Error::new(Rejected::new(
            "invalid_command",
            "expected_revision must be a positive revision",
            RetryClass::Never,
            Value::Null,
        )))?;
    let (binding, state) = owned_binding(tx, &id, principal)?;
    ensure_active_epoch(request, &binding, &state)?;
    let Some((mut service, service_state)) = stored_browser_service(tx, &id)? else {
        return reject(
            "not_found",
            "computer has no attached browser service",
            RetryClass::Never,
            Value::Null,
        );
    };
    if service_state == "revoked" {
        let view = browser_service_view(Some(&service), &service_state, tx, &id)?;
        let mut data = computer_view(tx, root, backends, &binding, &state)?;
        data["browser_service"] = view;
        return Ok(view_response(data, "browser service was already detached"));
    }
    if expected_revision != service.grant_revision {
        return reject(
            "revision_conflict",
            "detach requires the current browser service grant revision",
            RetryClass::NewRevision,
            json!({"grant_revision": service.grant_revision}),
        );
    }
    service.grant_revision = next_revision(service.grant_revision, "browser service grant revision")?;
    service.accepted_capabilities.clear();
    tx.execute(
        "UPDATE computer_browser_services SET state='revoked', payload=?1 WHERE computer_id=?2",
        params![serde_json::to_string(&service)?, id],
    )?;
    // Fencing: every live browser writer loses its lease immediately.
    tx.execute(
        "UPDATE computer_leases SET state='revoked'
         WHERE computer_id=?1 AND kind='browser' AND state='active'",
        [&id],
    )?;
    let view = browser_service_view(Some(&service), "revoked", tx, &id)?;
    let mut data = computer_view(tx, root, backends, &binding, &state)?;
    data["browser_service"] = view;
    Ok(view_response(data, "browser service detached; browser writers are fenced"))
}

fn accept_runtime(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(&request.body, &["method", "computer_id", "runtime"])?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let declared: RuntimeFacts = serde_json::from_value(
        request
            .body
            .get("runtime")
            .cloned()
            .ok_or_else(|| anyhow::Error::new(Rejected::new(
                "invalid_command",
                "runtime is required",
                RetryClass::Never,
                Value::Null,
            )))?,
    )
    .map_err(|_| {
        anyhow::Error::new(Rejected::new(
            "invalid_runtime",
            "runtime does not match the runtime facts contract",
            RetryClass::Never,
            Value::Null,
        ))
    })?;
    let (binding, state) = owned_binding(tx, &id, principal)?;
    ensure_active_epoch(request, &binding, &state)?;
    ensure_optional_revision(request, &binding)?;
    // The declared runtime is cross-checked against the operator-probed
    // registration facts; a command payload can never attest a runtime.
    let registration = backends.get(&binding.backend);
    let Some(facts) = registration.and_then(|registered| registered.runtime.as_ref()) else {
        return reject(
            "runtime_unavailable",
            "the bound backend has no probed runtime facts to accept",
            RetryClass::ReconcileFirst,
            Value::Null,
        );
    };
    if declared.kind != facts.kind || declared.executable_sha256 != facts.executable_sha256 {
        return reject(
            "runtime_mismatch",
            "declared runtime differs from the probed backend registration",
            RetryClass::Never,
            json!({
                "probed_runtime_kind": facts.kind,
                "probed_executable_sha256": facts.executable_sha256,
            }),
        );
    }
    tx.execute(
        "INSERT INTO computer_runtime_acceptance(
             computer_id, runtime_kind, executable_sha256, accepted_epoch, grant_revision)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(computer_id) DO UPDATE SET
             runtime_kind=excluded.runtime_kind,
             executable_sha256=excluded.executable_sha256,
             accepted_epoch=excluded.accepted_epoch,
             grant_revision=excluded.grant_revision",
        params![
            id,
            facts.kind,
            facts.executable_sha256,
            i64::try_from(binding.epoch)
                .map_err(|_| anyhow!("binding epoch exceeds SQLite integer range"))?,
            i64::try_from(binding.grant_revision)
                .map_err(|_| anyhow!("grant revision exceeds SQLite integer range"))?,
        ],
    )?;
    let mut data = computer_view(tx, root, backends, &binding, &state)?;
    data["runtime"] = json!({
        "kind": facts.kind,
        "executable_sha256": facts.executable_sha256,
        "accepted_epoch": binding.epoch,
    });
    Ok(view_response(data, "runtime accepted for the current binding epoch"))
}

fn lifecycle_effect(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    request: &Envelope,
    principal: &str,
) -> Result<Response> {
    require_shape(
        &request.body,
        &["method", "computer_id", "operation", "lifecycle_command_id", "outcome"],
    )?;
    let id = required_string(&request.body, "computer_id")?;
    check_component_arg("computer_id", &id)?;
    let operation = required_string(&request.body, "operation")?;
    if !matches!(operation.as_str(), "idle_stop" | "recreate") {
        return reject(
            "invalid_command",
            "lifecycle operation must be idle_stop or recreate",
            RetryClass::Never,
            Value::Null,
        );
    }
    let lifecycle_command_id = required_string(&request.body, "lifecycle_command_id")?;
    let outcome = request.body.get("outcome").cloned().unwrap_or(Value::Null);
    if canonical_digest(&outcome).is_err() {
        return reject(
            "invalid_command",
            "lifecycle outcome must be a canonical JSON value without floating points",
            RetryClass::Never,
            Value::Null,
        );
    }
    let (binding, state) = owned_binding(tx, &id, principal)?;
    // The effect may already have run when this completion arrives; it is
    // recorded truthfully, including whether authority moved underneath it.
    let fenced = state != "active" || binding.epoch != request.authority_epoch;
    let authorization = tx
        .query_row(
            "SELECT actor_ref, authority_epoch, response FROM computer_commands
             WHERE command_id=?1",
            [&lifecycle_command_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .filter(|(actor, epoch, _)| {
            actor == principal
                && *epoch
                    == i64::try_from(request.authority_epoch)
                        .unwrap_or_default()
        })
        .map(|(_, _, response)| response)
        .and_then(|response| serde_json::from_str::<Response>(&response).ok())
        .filter(|response| {
            response.data.get("authorized").and_then(Value::as_bool) == Some(true)
                && response.data.get("operation").and_then(Value::as_str) == Some(operation.as_str())
        });
    if authorization.is_none() {
        return reject(
            "unknown_lifecycle_authorization",
            "lifecycle effect names no matching authorized command for this actor and epoch",
            RetryClass::Never,
            Value::Null,
        );
    }
    let mut data = computer_view(tx, root, backends, &binding, &state)?;
    data["operation"] = Value::String(operation.clone());
    data["executed"] = Value::Bool(!fenced);
    data["authorized"] = Value::Bool(true);
    data["fenced"] = Value::Bool(fenced);
    data["lifecycle_command_id"] = Value::String(lifecycle_command_id);
    data["outcome"] = outcome;
    if fenced {
        Ok(warning_response(
            "lifecycle_fenced",
            "lifecycle effect was recorded after its authority was fenced",
            RetryClass::NewRevision,
            data,
        ))
    } else {
        Ok(success_response(
            format!("{operation} effect recorded"),
            data,
        ))
    }
}

fn list(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    principal: &str,
) -> Result<Response> {
    let mut statement = tx.prepare(
        "SELECT payload, state FROM computer_bindings
         WHERE ghost_id=?1 ORDER BY computer_id",
    )?;
    let rows = statement.query_map([principal], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut stored = Vec::new();
    for row in rows {
        let (raw, state) = row?;
        stored.push((serde_json::from_str::<ComputerBinding>(&raw)?, state));
    }
    drop(statement);

    let mut views = Vec::with_capacity(stored.len());
    let mut refs = Vec::with_capacity(stored.len());
    let mut needs_warning = false;
    let mut warning_code = "backend_unavailable";
    for (binding, state) in stored {
        let view = computer_view(tx, root, backends, &binding, &state)?;
        if view["capability_downgrade"] == true {
            needs_warning = true;
            warning_code = "capability_downgrade";
        }
        if view["backend_registered"] != true || view["available"] != true {
            needs_warning = true;
        }
        refs.push(format!("computer:{}", binding.computer_id));
        views.push(view);
    }
    let data = json!({"computers": views});
    if needs_warning {
        Ok(warning_response(
            warning_code,
            "computer list includes unregistered, unavailable, or downgraded backend state",
            RetryClass::ReconcileFirst,
            data,
        )
        .with_refs(refs))
    } else {
        Ok(success_response("computers listed", data).with_refs(refs))
    }
}

fn owned_binding(
    tx: &Transaction<'_>,
    computer_id: &str,
    principal: &str,
) -> Result<(ComputerBinding, String)> {
    let (binding, state) = stored_binding(tx, computer_id)?.ok_or_else(|| {
        anyhow::Error::new(Rejected::new(
            "not_found",
            "computer not found for authenticated principal",
            RetryClass::Never,
            Value::Null,
        ))
    })?;
    if binding.ghost_id != principal {
        return reject(
            "not_found",
            "computer not found for authenticated principal",
            RetryClass::Never,
            Value::Null,
        );
    }
    Ok((binding, state))
}

fn stored_binding(
    tx: &Transaction<'_>,
    computer_id: &str,
) -> Result<Option<(ComputerBinding, String)>> {
    let stored: Option<(String, String)> = tx
        .query_row(
            "SELECT payload, state FROM computer_bindings WHERE computer_id=?1",
            [computer_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    stored
        .map(|(raw, state)| {
            let binding = serde_json::from_str::<ComputerBinding>(&raw)?;
            Ok::<_, anyhow::Error>((binding, state))
        })
        .transpose()
}

#[derive(Debug, Clone)]
struct RuntimeAcceptance {
    runtime_kind: String,
    executable_sha256: String,
    accepted_epoch: i64,
    grant_revision: i64,
}

fn stored_runtime_acceptance(
    tx: &Transaction<'_>,
    computer_id: &str,
) -> Result<Option<RuntimeAcceptance>> {
    tx.query_row(
        "SELECT runtime_kind, executable_sha256, accepted_epoch, grant_revision
         FROM computer_runtime_acceptance WHERE computer_id=?1",
        [computer_id],
        |row| {
            Ok(RuntimeAcceptance {
                runtime_kind: row.get(0)?,
                executable_sha256: row.get(1)?,
                accepted_epoch: row.get(2)?,
                grant_revision: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn stored_browser_service(
    tx: &Transaction<'_>,
    computer_id: &str,
) -> Result<Option<(BrowserServiceBinding, String)>> {
    let stored: Option<(String, String)> = tx
        .query_row(
            "SELECT payload, state FROM computer_browser_services WHERE computer_id=?1",
            [computer_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    stored
        .map(|(raw, state)| {
            let service = serde_json::from_str::<BrowserServiceBinding>(&raw)?;
            Ok::<_, anyhow::Error>((service, state))
        })
        .transpose()
}

/// Full currency check for browser work: active binding at the exact epoch,
/// active attached service at the same epoch, backend currently registered,
/// configured, available, and still trusted for `browser`.
fn browser_service_scope_of(
    tx: &Transaction<'_>,
    computer_id: &str,
) -> Result<Option<String>> {
    let stored: Option<String> = tx
        .query_row(
            "SELECT json_extract(payload,'$.profile_scope') FROM computer_browser_services
             WHERE computer_id=?1 AND state='active'",
            [computer_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stored)
}

fn browser_service_is_current(
    tx: &Transaction<'_>,
    backends: &BTreeMap<String, RegisteredBackend>,
    computer_id: &str,
    ghost_id: &str,
    authority_epoch: u64,
) -> Result<bool> {
    let Some((binding, state)) = stored_binding(tx, computer_id)? else {
        return Ok(false);
    };
    if !home_binding_matches(&binding, &state, computer_id, ghost_id, authority_epoch) {
        return Ok(false);
    }
    let Some((service, service_state)) = stored_browser_service(tx, computer_id)? else {
        return Ok(false);
    };
    if service_state != "active"
        || service.epoch != binding.epoch
        || service.ghost_id != ghost_id
    {
        return Ok(false);
    }
    let Some(registration) = backends.get(&service.backend) else {
        return Ok(false);
    };
    if !registration.configured() || !registration.available() {
        return Ok(false);
    }
    let offered = capability_mask(registration.capabilities());
    let bound = capability_mask_for_values(&service.capabilities)?;
    let accepted = capability_mask_for_values(&service.accepted_capabilities)?;
    let trusted = capability_mask_for_values(&registration.accepted_capabilities)?;
    Ok(bound & !offered == 0
        && accepted & !bound == 0
        && accepted & !offered == 0
        && accepted & !trusted == 0
        && accepted & (1 << 2) != 0)
}

fn browser_service_view(
    service: Option<&BrowserServiceBinding>,
    state: &str,
    tx: &Transaction<'_>,
    computer_id: &str,
) -> Result<Value> {
    let Some(service) = service else {
        return Ok(Value::Null);
    };
    let writer: Option<String> = tx
        .query_row(
            "SELECT execution_id FROM computer_leases
             WHERE computer_id=?1 AND kind='browser' AND state='active'
             ORDER BY execution_id LIMIT 1",
            [computer_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json!({
        "service": service,
        "state": state,
        "revoked": state == "revoked",
        "active_writer": writer,
    }))
}

fn computer_view(
    tx: &Transaction<'_>,
    root: &Path,
    backends: &BTreeMap<String, RegisteredBackend>,
    stored_binding: &ComputerBinding,
    state: &str,
) -> Result<Value> {
    let registration = backends.get(&stored_binding.backend);
    let offered = registration
        .map(|registered| capability_names(registered.capabilities()))
        .unwrap_or_default();
    let trusted = registration
        .map(|registered| registered.accepted_capabilities.clone())
        .unwrap_or_default();
    let bound = capability_set_stored(&stored_binding.capabilities)?;
    let stored_accepted = capability_set_stored(&stored_binding.accepted_capabilities)?;
    let capability_downgrade = registration.is_some()
        && (!bound.is_subset(&offered)
            || !stored_accepted.is_subset(&offered)
            || !stored_accepted.is_subset(&trusted));
    let accepted = if state == "active" && registration.is_some() {
        stored_accepted
            .intersection(&offered)
            .filter(|cap| trusted.contains(*cap))
            .cloned()
            .collect::<BTreeSet<_>>()
    } else {
        BTreeSet::new()
    };
    let mut binding = stored_binding.clone();
    binding.capabilities = strings(&offered);
    binding.accepted_capabilities = strings(&accepted);
    let leases = active_leases(tx, &stored_binding.computer_id)?;
    let home_manifest = existing_manifest(root, &stored_binding.computer_id)?;
    let browser_service = stored_browser_service(tx, &stored_binding.computer_id)?;
    let browser_service_view = match &browser_service {
        Some((service, service_state)) => {
            browser_service_view(Some(service), service_state, tx, &stored_binding.computer_id)?
        }
        None => Value::Null,
    };
    Ok(json!({
        "binding": binding,
        "configured": registration.map(|item| item.configured()).unwrap_or(false),
        "available": registration.map(|item| item.available()).unwrap_or(false),
        "accepted_capabilities": strings(&accepted),
        "home_manifest": home_manifest,
        "leases": leases,
        "browser_service": browser_service_view,
        "backend_registered": registration.is_some(),
        "capability_truth": if registration.is_some() { "observed" } else { "unknown" },
        "capability_downgrade": capability_downgrade,
        "revoked": state == "revoked",
    }))
}

fn active_leases(tx: &Transaction<'_>, computer_id: &str) -> Result<Vec<LeaseView>> {
    let mut statement = tx.prepare(
        "SELECT execution_id, kind, epoch, state FROM computer_leases
         WHERE computer_id=?1 AND state='active' ORDER BY kind, execution_id",
    )?;
    let rows = statement.query_map([computer_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut leases = Vec::new();
    for row in rows {
        let (execution_id, raw_kind, epoch, state) = row?;
        let kind = LeaseKind::parse(&raw_kind).map_err(anyhow::Error::new)?;
        leases.push(LeaseView {
            computer_id: computer_id.to_owned(),
            execution_id,
            kind,
            epoch: u64::try_from(epoch).map_err(|_| anyhow!("invalid persisted lease epoch"))?,
            state,
        });
    }
    Ok(leases)
}

fn has_active_leases(tx: &Transaction<'_>, computer_id: &str) -> Result<bool> {
    let active: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM computer_leases
             WHERE computer_id=?1 AND state='active' LIMIT 1",
            [computer_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(active.is_some())
}

fn ensure_active_epoch(
    request: &Envelope,
    binding: &ComputerBinding,
    state: &str,
) -> Result<()> {
    if state != "active" {
        return reject(
            "revoked",
            "computer binding is revoked",
            RetryClass::NewRevision,
            json!({"current_epoch": binding.epoch}),
        );
    }
    check_epoch(request, binding)
}

fn check_epoch(request: &Envelope, binding: &ComputerBinding) -> Result<()> {
    if request.authority_epoch != binding.epoch {
        return reject(
            "stale_epoch",
            "computer command was fenced by a newer binding epoch",
            RetryClass::NewRevision,
            json!({"current_epoch": binding.epoch}),
        );
    }
    Ok(())
}

fn ensure_optional_revision(request: &Envelope, binding: &ComputerBinding) -> Result<()> {
    if let Some(expected) = request.expected_revision {
        if expected != binding.grant_revision {
            return reject(
                "revision_conflict",
                "computer grant revision changed",
                RetryClass::NewRevision,
                json!({"grant_revision": binding.grant_revision}),
            );
        }
    }
    Ok(())
}

fn require_shape(body: &Value, fields: &[&str]) -> Result<()> {
    let object = body.as_object().ok_or_else(|| {
        anyhow::Error::new(Rejected::new(
            "invalid_command",
            "command body must be an object",
            RetryClass::Never,
            Value::Null,
        ))
    })?;
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) {
        return reject(
            "invalid_command",
            "command body does not match the frozen command shape",
            RetryClass::Never,
            Value::Null,
        );
    }
    Ok(())
}

fn required_string(body: &Value, key: &str) -> Result<String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            anyhow::Error::new(Rejected::new(
                "invalid_command",
                format!("{key} must be a nonempty string"),
                RetryClass::Never,
                Value::Null,
            ))
        })
}

fn check_component_arg(field: &str, value: &str) -> Result<()> {
    if valid_component(value) {
        Ok(())
    } else {
        reject(
            "invalid_identifier",
            format!("{field} is not a safe rooted identifier"),
            RetryClass::Never,
            Value::Null,
        )
    }
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn capability_names(capabilities: ComputerCapabilities) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    if capabilities.browser {
        names.insert("browser".to_owned());
    }
    if capabilities.human_control {
        names.insert("human_control".to_owned());
    }
    if capabilities.persistent_filesystem {
        names.insert("persistent_filesystem".to_owned());
    }
    if capabilities.shell {
        names.insert("shell".to_owned());
    }
    names
}

fn trusted_capability_set(values: Vec<String>) -> Result<BTreeSet<String>> {
    let mut set = BTreeSet::new();
    for value in values {
        if !KNOWN_CAPABILITIES.contains(&value.as_str()) {
            bail!("unknown trusted computer capability");
        }
        if !set.insert(value) {
            bail!("duplicate trusted computer capability");
        }
    }
    Ok(set)
}

fn request_capability_set(values: &[String]) -> Result<BTreeSet<String>> {
    let mut set = BTreeSet::new();
    for value in values {
        if !KNOWN_CAPABILITIES.contains(&value.as_str()) {
            return reject(
                "invalid_capability",
                "binding contains an unknown capability",
                RetryClass::Never,
                Value::Null,
            );
        }
        if !set.insert(value.clone()) {
            return reject(
                "invalid_capability",
                "binding contains a duplicate capability",
                RetryClass::Never,
                Value::Null,
            );
        }
    }
    Ok(set)
}

fn capability_set_stored(values: &[String]) -> Result<BTreeSet<String>> {
    let mut set = BTreeSet::new();
    for value in values {
        if !KNOWN_CAPABILITIES.contains(&value.as_str()) || !set.insert(value.clone()) {
            bail!("computer registry contains an invalid persisted capability set");
        }
    }
    Ok(set)
}

fn strings(values: &BTreeSet<String>) -> Vec<String> {
    values.iter().cloned().collect()
}

fn next_revision(value: u64, label: &str) -> Result<u64> {
    let next = value
        .checked_add(1)
        .ok_or_else(|| anyhow!("{label} exhausted"))?;
    i64::try_from(next).map_err(|_| anyhow!("{label} exceeds SQLite integer range"))?;
    Ok(next)
}

fn now_ms() -> Result<i64> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| anyhow!("system clock is before the Unix epoch"))?;
    i64::try_from(now.as_millis()).map_err(|_| anyhow!("timestamp exceeds the durable range"))
}

#[cfg(unix)]
const MAX_HOME_ROOT_ENTRIES: usize = 4096;
#[cfg(unix)]
const MIGRATION_DIGEST_LIMIT: u64 = 64 * 1024 * 1024;

/// Captures the byte/identity inventory of one home volume root: every root
/// entry with its kind, mode, owner, filesystem identity, and (bounded)
/// content digest. This inventory is recorded durably BEFORE the migration
/// effect and is the only reconciliation truth for an interrupted migration.
#[cfg(unix)]
fn home_root_inventory(home_root: &Path) -> Result<Value> {
    use std::os::unix::fs::MetadataExt;

    let mut entries = Vec::new();
    for entry in fs::read_dir(home_root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(home_root.join(&name))?;
        let kind = if metadata.file_type().is_symlink() {
            "symlink"
        } else if metadata.is_dir() {
            "dir"
        } else if metadata.is_file() {
            "file"
        } else {
            bail!("home root entry '{name}' is an unsupported special file");
        };
        let mut record = json!({
            "name": name,
            "kind": kind,
            "mode": metadata.mode() & 0o7777,
            "uid": metadata.uid(),
            "dev": metadata.dev(),
            "ino": metadata.ino(),
        });
        if kind == "file" {
            record["size"] = json!(metadata.len());
            if metadata.len() <= MIGRATION_DIGEST_LIMIT {
                record["sha256"] = json!(digest_file(&home_root.join(&name))?);
            } else {
                record["digest_omitted"] = json!(true);
            }
        }
        entries.push(record);
        ensure!(
            entries.len() <= MAX_HOME_ROOT_ENTRIES,
            "home root exceeds the migration inventory entry limit"
        );
    }
    entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok(json!({
        "home_root": home_root,
        "entries": entries,
    }))
}

#[cfg(unix)]
fn digest_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Executes an authorized, inode-verified migration. Only a registry-attested
/// layout may be reused. Unregistered marker-shaped directories are originals,
/// never authority, and move intact into a fresh private lane. Existing
/// destinations are never overwritten. A partial effect remains unknown.
#[cfg(unix)]
fn execute_home_lane_migration(
    home_root: &Path,
    computer_id: &str,
    inventory: &Value,
) -> Result<Value> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    ensure!(
        inventory["home_root"].as_str() == Some(home_root.to_string_lossy().as_ref()),
        "migration inventory names a different home root"
    );
    let root_metadata = fs::symlink_metadata(home_root)?;
    ensure!(
        !root_metadata.file_type().is_symlink()
            && root_metadata.is_dir()
            && root_metadata.uid() == unsafe { libc::geteuid() }
            && root_metadata.mode() & 0o777 == 0o700,
        "registered home root identity or permissions rejected during migration"
    );
    let recorded = inventory["entries"]
        .as_array()
        .context("migration inventory lacks its original entries")?;
    let mut current: BTreeMap<String, (&str, u64, u64)> = BTreeMap::new();
    for entry in fs::read_dir(home_root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(home_root.join(&name))?;
        let kind = if metadata.file_type().is_symlink() {
            "symlink"
        } else if metadata.is_dir() {
            "dir"
        } else if metadata.is_file() {
            "file"
        } else {
            bail!("home root entry '{name}' is an unsupported special file");
        };
        current.insert(name, (kind, metadata.dev(), metadata.ino()));
    }
    ensure!(
        current.len() == recorded.len(),
        "home root changed after authorization: recorded {} entries, found {}",
        recorded.len(),
        current.len()
    );
    for record in recorded {
        let name = record["name"]
            .as_str()
            .context("migration inventory entry lacks a name")?;
        let found = current
            .get(name)
            .context("home root changed after authorization: a recorded entry disappeared")?;
        ensure!(
            found.0 == record["kind"].as_str().unwrap_or_default()
                && found.1 == record["dev"].as_u64().unwrap_or_default()
                && found.2 == record["ino"].as_u64().unwrap_or_default(),
            "home root entry '{name}' changed after authorization; resolve the recorded attempt inventory first"
        );
    }

    let layout_id = inventory["committed_layout_id"].as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
    let layout_dir_name = home_lanes::layout_dir_name(&layout_id);
    let layout_root = home_root.join(&layout_dir_name);
    let mut created = Vec::new();
    if !current.contains_key(&layout_dir_name) {
        fs::create_dir(&layout_root)?;
        fs::set_permissions(&layout_root, fs::Permissions::from_mode(0o700))?;
        created.push(layout_dir_name.clone());
    }
    // Sealed provenance: written for a fresh layout, or for an interrupted
    // attempt whose marker never landed. An existing marker must already
    // match; it is never overwritten.
    let marker_path = layout_root.join(home_lanes::LAYOUT_MARKER_NAME);
    match fs::symlink_metadata(&marker_path) {
        Ok(metadata) => {
            ensure!(
                !metadata.file_type().is_symlink() && metadata.is_file(),
                "home layout provenance marker is not a regular file"
            );
            home_lanes::validate_marker_bytes(
                &fs::read_to_string(&marker_path)?,
                &layout_id,
                computer_id,
            )?;
        }
        Err(_) => home_lanes::write_layout_marker(&layout_root, &layout_id, computer_id)?,
    }
    let private_root = layout_root.join(home_lanes::HOME_LANE_PRIVATE);
    home_lanes::ensure_lane(&layout_root, home_lanes::HOME_LANE_PRIVATE)?;

    let mut moved = Vec::new();
    for record in recorded {
        let name = record["name"]
            .as_str()
            .context("migration inventory entry lacks a name")?;
        if name == &layout_dir_name {
            continue;
        }
        let source = home_root.join(name);
        let target = private_root.join(name);
        move_home_original_noclobber(&source, &target)?;
        let after = fs::symlink_metadata(&target)?;
        ensure!(
            after.dev() == record["dev"].as_u64().unwrap_or_default()
                && after.ino() == record["ino"].as_u64().unwrap_or_default(),
            "moved entry '{name}' did not preserve its filesystem identity"
        );
        moved.push(name.to_owned());
    }
    home_lanes::ensure_lane(&layout_root, home_lanes::HOME_LANE_PUBLIC)?;
    let layout = home_lanes::open_layout_by_marker(&layout_root, &layout_id, computer_id)?;
    let final_root_entries = home_lanes::root_entry_names(home_root)?;
    ensure!(
        final_root_entries == vec![layout_dir_name.clone()],
        "home root did not converge to exactly its internal home layout"
    );
    let status = if moved.is_empty() && created.is_empty() {
        "already_migrated"
    } else {
        "migrated"
    };
    Ok(json!({
        "status": status,
        "home_root": home_root,
        "layout_id": layout_id,
        "layout_root": layout.layout_root,
        "inventory": inventory,
        "moved": moved,
        "created_lanes": created,
        "preserved_identity": true,
        "final_root_entries": final_root_entries,
    }))
}

#[cfg(unix)]
fn move_home_original_noclobber(source: &Path, target: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let target = std::ffi::CString::new(target.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(libc::AT_FDCWD, source.as_ptr(),
            libc::AT_FDCWD, target.as_ptr(), libc::RENAME_EXCL)
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(libc::AT_FDCWD, source.as_ptr(),
            libc::AT_FDCWD, target.as_ptr(), libc::RENAME_NOREPLACE)
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    anyhow::bail!("atomic no-overwrite Home migration is unavailable on this platform");
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    ensure!(result == 0, "Home original move refused without overwrite: {}", std::io::Error::last_os_error());
    Ok(())
}

/// Provisions one fresh, registry-committable home layout for a new
/// computer: a uniquely allocated internal layout root with its sealed
/// provenance marker and exactly two empty privacy lanes (UID-owned, 0700).
/// The returned layout identifier must be committed in the registry by the
/// same transaction that inserts the binding. An existing legacy root is
/// never silently lane-provisioned here: its originals — including any
/// directories named `public` or `private` — require the explicit operator
/// migration, because automatic provisioning could make unclassified data
/// appear public or hide it.
#[cfg(unix)]
fn create_manifest(root: &Path, computer_id: &str) -> Result<(HomeManifest, String)> {
    let computer_root = ensure_child_directory(&root.join(COMPUTER_ROOT), computer_id, true)?;
    let home_volume = ensure_child_directory(&computer_root, "home", true)?;
    // Disk names or a marker cannot attest unclassified originals. An
    // interrupted registration is reconciled explicitly, never adopted as
    // public data merely because it resembles a provisioned layout.
    let entries = home_lanes::root_entry_names(&home_volume)?;
    ensure!(entries.is_empty(),
        "fresh computer home root carries unproven originals; refusing to provision or adopt lanes over existing data");
    let layout = home_lanes::create_layout(
        &home_volume,
        &Uuid::new_v4().simple().to_string(),
        computer_id,
    )?;
    let task_snapshot_root = ensure_child_directory(&computer_root, "tasks", true)?;
    let browser_profile = ensure_child_directory(&computer_root, "browser-profile", true)?;
    Ok((
        HomeManifest {
            home_volume,
            task_snapshot_root,
            browser_profile,
            credential_broker: None,
        },
        layout.layout_id,
    ))
}

#[cfg(not(unix))]
fn create_manifest(_root: &Path, _computer_id: &str) -> Result<(HomeManifest, String)> {
    bail!("home privacy lanes require Unix filesystem semantics")
}

/// Rebind-time root verification: the registered computer roots must exist
/// as real rooted directories, but home contents are never inspected or
/// provisioned here.
fn ensure_existing_roots(root: &Path, computer_id: &str) -> Result<()> {
    let computer_root = ensure_child_directory(&root.join(COMPUTER_ROOT), computer_id, false)?;
    ensure_child_directory(&computer_root, "home", false)?;
    ensure_child_directory(&computer_root, "tasks", false)?;
    ensure_child_directory(&computer_root, "browser-profile", false)?;
    Ok(())
}

/// Registry-committed layout authority: the durable row is the only proof
/// that a home volume's internal layout was provisioned or migrated by this
/// registry. Without it, every entry at the home root — reserved names
/// included — is an unproven legacy original.
#[cfg(unix)]
fn committed_home_layout(
    tx: &Transaction<'_>,
    computer_id: &str,
    home_volume: &Path,
) -> Result<home_lanes::HomeLayout> {
    let layout_id: Option<String> = tx
        .query_row(
            "SELECT layout_id FROM computer_home_layouts
             WHERE computer_id=?1 AND state='committed'",
            [computer_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(layout_id) = layout_id else {
        let entries = home_lanes::root_entry_names(home_volume)?;
        return Err(home_lanes::legacy_home_error(home_volume, &entries));
    };
    home_lanes::open_committed_layout(home_volume, &layout_id, computer_id)
}

fn existing_manifest(root: &Path, computer_id: &str) -> Result<HomeManifest> {
    let computer_root = ensure_child_directory(&root.join(COMPUTER_ROOT), computer_id, false)?;
    let home_volume = ensure_child_directory(&computer_root, "home", false)?;
    let task_snapshot_root = ensure_child_directory(&computer_root, "tasks", false)?;
    let browser_profile = ensure_child_directory(&computer_root, "browser-profile", false)?;
    Ok(HomeManifest {
        home_volume,
        task_snapshot_root,
        browser_profile,
        credential_broker: None,
    })
}

fn ensure_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("computer registry root must be a real directory");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("computer registry root changed during creation");
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn reject_symlink_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("computer registry database must not be a symlink")
        }
        Ok(metadata) if !metadata.is_file() => {
            bail!("computer registry database path is not a regular file")
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_child_directory(parent: &Path, name: &str, create: bool) -> Result<PathBuf> {
    if !valid_component(name) {
        bail!("invalid computer volume path component");
    }
    let parent = parent.canonicalize()?;
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("computer volume path must be a real directory");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            match fs::create_dir(&path) {
                Ok(()) => set_private_permissions(&path)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("computer volume path changed during creation");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            bail!("computer volume manifest directory is missing")
        }
        Err(error) => return Err(error.into()),
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&parent) {
        bail!("computer volume path escaped its rooted parent");
    }
    Ok(canonical)
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn error_response(
    code: &str,
    summary: impl Into<String>,
    retry_class: RetryClass,
    data: Value,
) -> Response {
    Response {
        status: ResponseStatus::Error,
        summary: summary.into(),
        object_refs: Vec::new(),
        artifacts: Vec::new(),
        next_actions: Vec::new(),
        error_code: Some(code.to_owned()),
        retry_class,
        data,
    }
}

fn warning_response(
    code: &str,
    summary: impl Into<String>,
    retry_class: RetryClass,
    data: Value,
) -> Response {
    Response {
        status: ResponseStatus::Warning,
        summary: summary.into(),
        object_refs: Vec::new(),
        artifacts: Vec::new(),
        next_actions: Vec::new(),
        error_code: Some(code.to_owned()),
        retry_class,
        data,
    }
}

fn success_response(summary: impl Into<String>, data: Value) -> Response {
    Response {
        status: ResponseStatus::Success,
        summary: summary.into(),
        object_refs: Vec::new(),
        artifacts: Vec::new(),
        next_actions: Vec::new(),
        error_code: None,
        retry_class: RetryClass::SameId,
        data,
    }
}

fn view_response(view: Value, summary: impl Into<String>) -> Response {
    if view["capability_downgrade"] == true {
        warning_response(
            "capability_downgrade",
            "backend capabilities changed; acceptance was not silently retained",
            RetryClass::NewRevision,
            view,
        )
    } else if view["backend_registered"] != true || view["available"] != true {
        warning_response(
            "backend_unavailable",
            "binding is durable but its backend is not currently available",
            RetryClass::ReconcileFirst,
            view,
        )
    } else {
        success_response(summary, view)
    }
}

trait ResponseRefs {
    fn with_refs(self, refs: Vec<String>) -> Self;
}

impl ResponseRefs for Response {
    fn with_refs(mut self, refs: Vec<String>) -> Self {
        self.object_refs = refs;
        self
    }
}

fn reject<T>(
    code: &'static str,
    summary: impl Into<String>,
    retry_class: RetryClass,
    data: Value,
) -> Result<T> {
    Err(anyhow::Error::new(Rejected::new(
        code,
        summary,
        retry_class,
        data,
    )))
}

#[derive(Debug)]
struct Rejected {
    code: &'static str,
    summary: String,
    retry_class: RetryClass,
    data: Value,
}

impl Rejected {
    fn new(
        code: &'static str,
        summary: impl Into<String>,
        retry_class: RetryClass,
        data: Value,
    ) -> Self {
        Self {
            code,
            summary: summary.into(),
            retry_class,
            data,
        }
    }

    fn response(&self) -> Response {
        error_response(
            self.code,
            self.summary.clone(),
            self.retry_class.clone(),
            self.data.clone(),
        )
    }
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.summary)
    }
}

impl std::error::Error for Rejected {}
