use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const FORMAT: &str = "ghost-recovery-bundle/2";
const MAX_FILES: usize = 10_000;
const MAX_BYTES: u64 = 536_870_912;
const MAX_OPERATOR_BYTES: u64 = 16 * 1024 * 1024 * 1024;

// Existing callers retain the 512 MiB cap. A real worker receipt journal can
// exceed it; an operator may select a bounded larger streaming budget for
// create/verify/restore without changing the bundle format or buffering files.
fn parse_byte_budget(value: Option<&str>) -> anyhow::Result<u64> {
    let bytes = value.map(str::parse::<u64>).transpose()?.unwrap_or(MAX_BYTES);
    anyhow::ensure!((MAX_BYTES..=MAX_OPERATOR_BYTES).contains(&bytes),
        "recovery byte budget must be between 512 MiB and 16 GiB");
    Ok(bytes)
}

fn configured_max_bytes() -> anyhow::Result<u64> {
    let value = std::env::var("GHOST_RECOVERY_MAX_BYTES");
    match value {
        Ok(value) => parse_byte_budget(Some(&value)),
        Err(std::env::VarError::NotPresent) => parse_byte_budget(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod byte_budget_tests {
    use super::*;
    #[test]
    fn operator_budget_is_explicit_bounded_and_preserves_the_default() {
        assert_eq!(parse_byte_budget(None).unwrap(), MAX_BYTES);
        assert_eq!(parse_byte_budget(Some("4294967296")).unwrap(), 4 * 1024 * 1024 * 1024);
        for invalid in ["", "0", "-1", "536870911", "17179869185", "18446744073709551616", "unlimited"] {
            assert!(parse_byte_budget(Some(invalid)).is_err());
        }
    }
}
const MAX_MANIFEST_BYTES: usize = 1_048_576;
const MAX_STREAM_BUFFER_BYTES: usize = 8192;
const MAX_AUTHORITY_EPOCH: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BundleRequest {
    pub roots: Vec<RootSpec>,
    pub host_label: String,
    pub release: ReleaseIdentity,
    pub home_browser_manifest: HomeBrowserManifest,
    pub external_document_references: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RootSpec {
    pub label: String,
    pub role: String,
    pub path: PathBuf,
    pub stopped_owner_pids: Vec<i32>,
    pub excluded_credential_paths: Vec<PathBuf>,
    pub credential_references: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReleaseIdentity {
    pub source_revision: String,
    pub dirty_snapshot_digest: String,
    pub component_digests: std::collections::BTreeMap<String, String>,
    pub schema_min: u32,
    pub schema_max: u32,
    pub protocol_revision: String,
    pub pinned_runtime_versions: std::collections::BTreeMap<String, String>,
    pub image_references: Vec<String>,
    pub config_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SelectedInventoryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SelectedInventoryEntry {
    /// Empty path denotes the selected component root directory.
    pub path: String,
    pub kind: SelectedInventoryKind,
    pub size: u64,
    pub mode: u32,
    pub sha256: Option<String>,
}

pub(crate) type SelectedComponentInventory =
    std::collections::BTreeMap<String, Vec<SelectedInventoryEntry>>;

pub(crate) struct CapturedSelectedComponents {
    pub package_path: PathBuf,
    pub manifest_sha256: String,
}


/// Per-registered-computer home and browser presence. The registry ledger is
/// the authority for this mapping; root labels name captured roots and never
/// invent computer identities. A restored browser profile stays unallocated
/// until an explicit computer rebind and browser service attach.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HomeBrowserManifest {
    pub computers: Vec<ComputerHomeBrowser>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ComputerHomeBrowser {
    pub computer_id: String,
    pub home: RootPresence,
    pub browser: RootPresence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum RootPresence {
    Present {
        root_label: String,
        /// Empty selects the whole component; nested roots stay in one inventory.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        relative_path: String,
    },
    Absent,
    Unallocated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RestoreReport {
    pub restored_roots: std::collections::BTreeMap<String, PathBuf>,
    pub restored_authority_epoch: u64,
    pub dispatch_enabled: bool,
    pub integrity_checks: Vec<String>,
    pub digest_facts: Vec<RestoreDigestFact>,
    pub home_lanes: Vec<RestoredHomeLanes>,
    pub quarantine_requirements: Vec<String>,
    pub reconciliation_requirements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RestoreDigestFact {
    pub root_label: String,
    pub path: String,
    pub bundle_sha256: String,
    pub copied_sha256: String,
    pub final_sha256: String,
    pub authority_row_adjusted: bool,
}

/// Post-restore privacy-lane admission for one captured computer home root.
/// Both lanes and any legacy originals are preserved byte-for-byte; only a
/// registry-committed layout with a matching sealed marker admits lanes, so
/// a legacy root — including one whose own directories are named
/// `public`/`private` — is reported as requiring the explicit operator
/// migration and is never silently reclassified.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RestoredHomeLanes {
    pub computer_id: String,
    pub root_label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub relative_path: String,
    /// `lane_isolated`, `layout_unverified` (no captured registry ledger to
    /// prove provenance), `provenance_mismatch_refused`,
    /// `legacy_requires_migration`, or `forged_refused`.
    pub admission: String,
}

/// Captures a stopped-only, caller-selected inventory into a new private bundle.
/// The caller supplies complete roots and owner PIDs; this function never discovers them.
pub fn create_bundle(request: &BundleRequest, destination: &Path) -> anyhow::Result<Value> {
    #[cfg(unix)]
    {
        imp::create_bundle(request, destination)
    }
    #[cfg(not(unix))]
    {
        let _ = (request, destination);
        anyhow::bail!("recovery bundles require Unix no-follow filesystem operations")
    }
}

/// Verifies a completed bundle's exact inventory, streamed digests, and SQLite state.
pub fn verify_bundle(source: &Path) -> anyhow::Result<Value> {
    #[cfg(unix)]
    {
        imp::verify_bundle(source)
    }
    #[cfg(not(unix))]
    {
        let _ = source;
        anyhow::bail!("recovery bundle verification requires Unix no-follow filesystem operations")
    }
}

/// Captures selected release components in the established private bundle
/// boundary and commits a caller-built, versioned manifest only after copying.
pub(crate) fn capture_selected_components<F>(
    request: &BundleRequest,
    destination: &Path,
    build_manifest: F,
) -> anyhow::Result<CapturedSelectedComponents>
where
    F: FnOnce(&SelectedComponentInventory) -> anyhow::Result<Vec<u8>>,
{
    #[cfg(unix)]
    {
        imp::capture_selected_components(request, destination, build_manifest)
    }
    #[cfg(not(unix))]
    {
        let _ = (request, destination, build_manifest);
        anyhow::bail!("release packages require Unix no-follow filesystem operations")
    }
}

/// Reads a bounded package manifest through the shared no-follow descriptor path.
pub(crate) fn read_selected_manifest(source: &Path) -> anyhow::Result<(PathBuf, Vec<u8>)> {
    #[cfg(unix)]
    {
        imp::read_selected_manifest(source)
    }
    #[cfg(not(unix))]
    {
        let _ = source;
        anyhow::bail!("release package verification requires Unix no-follow filesystem operations")
    }
}

/// Verifies the exact package tree and streams each copied component file once.
pub(crate) fn verify_selected_components(
    source: &Path,
    inventory: &SelectedComponentInventory,
    manifest_bytes: usize,
) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        imp::verify_selected_components(source, inventory, manifest_bytes)
    }
    #[cfg(not(unix))]
    {
        let _ = (source, inventory, manifest_bytes);
        anyhow::bail!("release package verification requires Unix no-follow filesystem operations")
    }
}

/// Restores a verified bundle into a new private root and leaves Host dispatch disabled.
pub fn restore_bundle(source: &Path, destination: &Path) -> anyhow::Result<RestoreReport> {
    #[cfg(unix)]
    {
        imp::restore_bundle(source, destination)
    }
    #[cfg(not(unix))]
    {
        let _ = (source, destination);
        anyhow::bail!("recovery restore requires Unix no-follow filesystem operations")
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use anyhow::{bail, ensure, Context};
    use rusqlite::{Connection, OpenFlags, TransactionBehavior};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::{BTreeMap, BTreeSet};
    use std::ffi::{CStr, CString, OsStr, OsString};
    use std::fs::{self, File, Metadata, OpenOptions};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Component, Path, PathBuf};
    use std::time::Duration;

    const DIRECTORY_FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK;
    const FILE_FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
    const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
    // Pi's exclusive SQLite lease carries process ownership, not conversation
    // data; a clean release may leave an empty file without a database header.
    const KNOWN_LOCK_FILES: [&str; 6] = [
        "workspace.lock",
        "supervisor.lock",
        ".runtime-lock.sqlite",
        ".runtime-lock.sqlite-wal",
        ".runtime-lock.sqlite-shm",
        ".runtime-lock.sqlite-journal",
    ];

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
    #[serde(rename_all = "snake_case")]
    enum EntryKind {
        Directory,
        File,
        Sqlite,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(deny_unknown_fields)]
    struct DatabaseFacts {
        user_version: i64,
        integrity_check: String,
        foreign_key_violations: u64,
        receipt_cursor_high_water: BTreeMap<String, i64>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(deny_unknown_fields)]
    struct ManifestRoot {
        label: String,
        role: String,
        credential_references: Vec<String>,
        stopped_owner_pid_checks: usize,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(deny_unknown_fields)]
    struct ManifestEntry {
        root_label: String,
        path: String,
        kind: EntryKind,
        byte_count: u64,
        sha256: Option<String>,
        database: Option<DatabaseFacts>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(deny_unknown_fields)]
    struct BundleManifest {
        format: String,
        complete: bool,
        host_label: String,
        release: ReleaseIdentity,
        home_browser_manifest: HomeBrowserManifest,
        external_document_references: Vec<String>,
        roots: Vec<ManifestRoot>,
        entries: Vec<ManifestEntry>,
        total_bytes: u64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Fingerprint {
        device: u64,
        inode: u64,
        links: u64,
        length: u64,
        mode: u32,
        modified_seconds: i64,
        modified_nanoseconds: i64,
        changed_seconds: i64,
        changed_nanoseconds: i64,
    }

    impl Fingerprint {
        fn from_metadata(metadata: &Metadata) -> Self {
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                links: metadata.nlink(),
                length: metadata.len(),
                mode: metadata.mode(),
                modified_seconds: metadata.mtime(),
                modified_nanoseconds: metadata.mtime_nsec(),
                changed_seconds: metadata.ctime(),
                changed_nanoseconds: metadata.ctime_nsec(),
            }
        }
    }

    struct PreparedRoot<'a> {
        spec: &'a RootSpec,
        path: PathBuf,
        directory: File,
        fingerprint: Fingerprint,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    enum ScannedKind {
        Directory,
        File,
        Sqlite,
        Sidecar,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ScannedEntry {
        relative: PathBuf,
        kind: ScannedKind,
        fingerprint: Fingerprint,
    }

    struct VerifiedBundle {
        path: PathBuf,
        directory: File,
        manifest: BundleManifest,
        manifest_bytes: usize,
    }
    struct NewDestination {
        path: PathBuf,
        parent: File,
        name: CString,
    }

    impl NewDestination {
        fn create(&self) -> anyhow::Result<File> {
            let parent_path = self.path.parent().context("destination parent is missing")?;
            ensure!(
                stat_matches_metadata(&stat_path(parent_path)?, &self.parent.metadata()?),
                "destination parent changed after validation"
            );
            let result = unsafe { libc::mkdirat(self.parent.as_raw_fd(), self.name.as_ptr(), 0o700) };
            ensure!(result == 0, "could not create new destination directory: {}", std::io::Error::last_os_error());
            let directory = open_at(self.parent.as_raw_fd(), &self.name, DIRECTORY_FLAGS)?;
            let mode_result = unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) };
            ensure!(mode_result == 0, "could not make destination private: {}", std::io::Error::last_os_error());
            ensure!(
                stat_matches_metadata(&stat_path(&self.path)?, &directory.metadata()?),
                "destination path changed during creation"
            );
            self.parent.sync_all()?;
            Ok(directory)
        }
    }


    pub(super) fn capture_selected_components<F>(
        request: &BundleRequest,
        destination: &Path,
        build_manifest: F,
    ) -> anyhow::Result<CapturedSelectedComponents>
    where
        F: FnOnce(&SelectedComponentInventory) -> anyhow::Result<Vec<u8>>,
    {
        validate_request(request)?;
        let mut roots = prepare_roots(request)?;
        validate_root_nonoverlap(&roots)?;
        roots.sort_by(|left, right| left.spec.label.cmp(&right.spec.label));
        check_all_owners_stopped(&roots)?;
        let destination_handle =
            validate_new_destination(destination, roots.iter().map(|root| root.path.as_path()))?;
        let package_path = destination_handle.path.clone();
        let mut scans = Vec::with_capacity(roots.len());
        let mut scanned_nodes = 0_usize;
        for root in &roots {
            validate_exact_exclusions(root)?;
            let entries = scan_root(root)?;
            ensure!(
                entries.iter().all(|entry| matches!(entry.kind, ScannedKind::Directory | ScannedKind::File)),
                "release components cannot contain SQLite databases or sidecars"
            );
            scanned_nodes = scanned_nodes
                .checked_add(entries.len())
                .context("selected component entry count overflow")?;
            ensure!(scanned_nodes <= MAX_FILES * 2, "selected components exceed the entry limit");
            verify_root_unchanged(root)?;
            scans.push(entries);
        }
        check_all_owners_stopped(&roots)?;

        let package_directory = destination_handle.create()?;
        set_directory_mode(&package_path)?;
        let components_path = package_path.join("components");
        fs::create_dir(&components_path)?;
        set_directory_mode(&components_path)?;

        let mut inventory = SelectedComponentInventory::new();
        let mut directory_modes = Vec::new();
        let mut total_bytes = 0_u64;
        let mut file_count = 0_usize;
        for (root, scanned) in roots.iter().zip(&scans) {
            let component_path = components_path.join(&root.spec.label);
            fs::create_dir(&component_path)?;
            set_directory_mode(&component_path)?;
            let component_mode = immutable_directory_mode(root.fingerprint.mode);
            directory_modes.push((component_path.clone(), component_mode));
            let mut component_entries = vec![SelectedInventoryEntry {
                path: String::new(),
                kind: SelectedInventoryKind::Directory,
                size: 0,
                mode: component_mode,
                sha256: None,
            }];

            for entry in scanned.iter().filter(|entry| entry.kind == ScannedKind::Directory) {
                let path = component_path.join(&entry.relative);
                fs::create_dir(&path)
                    .with_context(|| format!("creating selected component directory {}", entry.relative.display()))?;
                set_directory_mode(&path)?;
                let mode = immutable_directory_mode(entry.fingerprint.mode);
                directory_modes.push((path, mode));
                component_entries.push(SelectedInventoryEntry {
                    path: safe_relative(&entry.relative)?,
                    kind: SelectedInventoryKind::Directory,
                    size: 0,
                    mode,
                    sha256: None,
                });
            }

            for entry in scanned.iter().filter(|entry| entry.kind == ScannedKind::File) {
                file_count = file_count.checked_add(1).context("selected component file count overflow")?;
                ensure!(file_count < MAX_FILES, "release package including its manifest exceeds the file limit");
                let relative = &entry.relative;
                let mut input = open_relative_file(&root.directory, relative)?;
                let before = Fingerprint::from_metadata(&input.metadata()?);
                ensure!(before == entry.fingerprint && before.links == 1, "source file changed or is hard-linked before release capture");
                let target = component_path.join(relative);
                let mut output = create_private_file(&target)?;
                let (size, sha256) = stream_file(
                    &mut input,
                    Some(&mut output),
                    configured_max_bytes()?,
                    &mut total_bytes,
                )?;
                let mode = immutable_file_mode(entry.fingerprint.mode);
                fs::set_permissions(&target, fs::Permissions::from_mode(mode))?;
                output.sync_all()?;
                let copied = output.metadata()?;
                ensure!(
                    copied.is_file() && copied.nlink() == 1 && copied.len() == size && copied.mode() & 0o777 == mode,
                    "copied component file metadata differs from the streamed inventory"
                );
                ensure!(Fingerprint::from_metadata(&input.metadata()?) == before, "source file changed during release capture");
                verify_relative_file_binding(&root.directory, relative, before)?;
                component_entries.push(SelectedInventoryEntry {
                    path: safe_relative(relative)?,
                    kind: SelectedInventoryKind::File,
                    size,
                    mode,
                    sha256: Some(sha256),
                });
            }
            component_entries.sort_by(|left, right| left.path.cmp(&right.path));
            inventory.insert(root.spec.label.clone(), component_entries);
        }

        for (root, before) in roots.iter().zip(&scans) {
            verify_root_unchanged(root)?;
            let after = scan_root(root)?;
            ensure!(same_source_inventory(before, &after), "selected source inventory changed during release capture");
            ensure!(
                after.iter().all(|entry| matches!(entry.kind, ScannedKind::Directory | ScannedKind::File)),
                "selected release source acquired SQLite state during capture"
            );
        }
        check_all_owners_stopped(&roots)?;

        let manifest_bytes = build_manifest(&inventory)?;
        ensure!(manifest_bytes.len() <= MAX_MANIFEST_BYTES, "release package manifest exceeds 1 MiB");
        let total_package_bytes = total_bytes
            .checked_add(manifest_bytes.len() as u64)
            .context("release package byte count overflow")?;
        ensure!(total_package_bytes <= configured_max_bytes()?, "release package exceeds the configured byte limit");
        write_package_manifest_atomic(&package_path, &manifest_bytes)?;
        for (path, mode) in directory_modes.into_iter().rev() {
            fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
        }
        fs::set_permissions(&components_path, fs::Permissions::from_mode(0o555))?;
        sync_directory_tree(&package_path)?;
        fs::set_permissions(&package_path, fs::Permissions::from_mode(0o500))?;
        package_directory.sync_all()?;
        destination_handle.parent.sync_all()?;
        validate_selected_tree(&package_directory, &inventory, manifest_bytes.len(), false)?;
        ensure!(
            stat_matches_metadata(&stat_path(&package_path)?, &package_directory.metadata()?),
            "release package destination changed during commit"
        );
        Ok(CapturedSelectedComponents {
            package_path,
            manifest_sha256: format!("{:x}", Sha256::digest(&manifest_bytes)),
        })
    }

    pub(super) fn create_bundle(request: &BundleRequest, destination: &Path) -> anyhow::Result<Value> {
        validate_request(request)?;
        let roots = prepare_roots(request)?;
        validate_root_nonoverlap(&roots)?;
        check_all_owners_stopped(&roots)?;
        let destination_handle = validate_new_destination(destination, roots.iter().map(|root| root.path.as_path()))?;
        let destination = destination_handle.path.clone();
        let mut scans = Vec::with_capacity(roots.len());
        let mut scanned_nodes = 0_usize;
        for root in &roots {
            let scan = scan_root(root)?;
            scanned_nodes = scanned_nodes.checked_add(scan.len()).context("source entry count overflow")?;
            ensure!(scanned_nodes <= MAX_FILES * 2, "selected roots exceed the bundle entry limit");
            scans.push(scan);
        }
        for (root, entries) in roots.iter().zip(&scans) {
            validate_sqlite_sidecars(entries)?;
            verify_root_unchanged(root)?;
        }
        check_all_owners_stopped(&roots)?;
        let destination_directory = destination_handle.create()?;

        set_directory_mode(&destination)?;
        let mut manifest = BundleManifest {
            format: FORMAT.to_owned(),
            complete: false,
            host_label: request.host_label.clone(),
            release: request.release.clone(),
            home_browser_manifest: request.home_browser_manifest.clone(),
            external_document_references: request.external_document_references.clone(),
            roots: roots
                .iter()
                .map(|root| ManifestRoot {
                    label: root.spec.label.clone(),
                    role: root.spec.role.clone(),
                    credential_references: root.spec.credential_references.clone(),
                    stopped_owner_pid_checks: root.spec.stopped_owner_pids.len(),
                })
                .collect(),
            entries: Vec::new(),
            total_bytes: 0,
        };
        write_manifest_atomic(&destination, &manifest)?;
        let bundle_roots = destination.join("roots");
        fs::create_dir(&bundle_roots)?;
        set_directory_mode(&bundle_roots)?;

        let mut total_bytes = 0_u64;
        let mut file_count = 0_usize;
        for (root, scanned) in roots.iter().zip(&scans) {
            let target_root = bundle_roots.join(&root.spec.label);
            fs::create_dir(&target_root)?;
            set_directory_mode(&target_root)?;
            for entry in scanned.iter().filter(|entry| entry.kind == ScannedKind::Directory) {
                let target = target_root.join(&entry.relative);
                fs::create_dir(&target).with_context(|| format!("creating captured directory {}", entry.relative.display()))?;
                set_directory_mode(&target)?;
                manifest.entries.push(ManifestEntry {
                    root_label: root.spec.label.clone(),
                    path: manifest_path(&entry.relative)?,
                    kind: EntryKind::Directory,
                    byte_count: 0,
                    sha256: None,
                    database: None,
                });
            }
            for entry in scanned.iter().filter(|entry| matches!(entry.kind, ScannedKind::File | ScannedKind::Sqlite)) {
                file_count = file_count.checked_add(1).context("file count overflow")?;
                ensure!(file_count < MAX_FILES, "recovery bundle including its manifest exceeds the 10,000-file limit");
                let target = target_root.join(&entry.relative);
                let (byte_count, sha256, database) = match entry.kind {
                    ScannedKind::File => {
                        let parent = target.parent().context("captured file parent is missing")?;
                        let mut input = open_relative_file(&root.directory, &entry.relative)?;
                        let before = Fingerprint::from_metadata(&input.metadata()?);
                        ensure!(before == entry.fingerprint && before.links == 1, "source file changed or is hard-linked before capture");
                        let mut output = create_private_file(&target)?;
                        let (bytes, digest) = stream_file(
                            &mut input,
                            Some(&mut output),
                            configured_max_bytes()?,
                            &mut total_bytes,
                        )?;
                        output.sync_all()?;
                        let output_digest = digest_absolute_file(&target, configured_max_bytes()?)?;
                        ensure!(output_digest == digest, "captured file digest differs from source stream");
                        ensure!(fs::metadata(&target)?.len() == bytes, "captured file length differs from source stream");
                        ensure!(Fingerprint::from_metadata(&input.metadata()?) == before, "source file changed during capture");
                        verify_relative_file_binding(&root.directory, &entry.relative, before)?;
                        File::open(parent)?.sync_all()?;
                        (bytes, digest, None)
                    }
                    ScannedKind::Sqlite => {
                        let database = snapshot_sqlite_database(root, entry, scanned, &target, &mut total_bytes)?;
                        let bytes = fs::metadata(&target)?.len();
                        let digest = digest_absolute_file(&target, configured_max_bytes()?)?;
                        (bytes, digest, Some(database))
                    }
                    _ => unreachable!(),
                };
                ensure!(total_bytes <= configured_max_bytes()?, "recovery bundle exceeds the configured byte limit");
                manifest.entries.push(ManifestEntry {
                    root_label: root.spec.label.clone(),
                    path: manifest_path(&entry.relative)?,
                    kind: if entry.kind == ScannedKind::Sqlite { EntryKind::Sqlite } else { EntryKind::File },
                    byte_count,
                    sha256: Some(sha256),
                    database,
                });
            }
        }

        for (root, before) in roots.iter().zip(&scans) {
            verify_root_unchanged(root)?;
            let after = scan_root(root)?;
            ensure!(same_source_inventory(before, &after), "source inventory changed during recovery capture");
            validate_sqlite_sidecars(&after)?;
        }
        check_all_owners_stopped(&roots)?;
        manifest.entries.sort_by(|left, right| {
            (&left.root_label, &left.path, &left.kind).cmp(&(&right.root_label, &right.path, &right.kind))
        });
        manifest.total_bytes = total_bytes;
        validate_manifest(&manifest)?;
        let final_manifest_bytes = manifest_size(&manifest)?;
        ensure!(final_manifest_bytes <= MAX_MANIFEST_BYTES, "recovery manifest exceeds the 1 MiB limit");
        ensure!(
            total_bytes.checked_add(final_manifest_bytes as u64).unwrap_or(u64::MAX) <= configured_max_bytes()?,
            "recovery bundle exceeds the configured total byte limit"
        );
        validate_bundle_inventory(&destination_directory, &manifest, final_manifest_bytes)?;
        validate_bundle_entries(&destination_directory, &manifest, final_manifest_bytes)?;
        validate_host_database(&destination, &manifest)?;
        check_all_owners_stopped(&roots)?;
        sync_directory_tree(&destination)?;
        manifest.complete = true;
        write_manifest_atomic(&destination, &manifest)?;
        destination_directory.sync_all()?;
        destination_handle.parent.sync_all()?;

        Ok(json!({
            "format": FORMAT,
            "complete": true,
            "destination": destination,
            "host_label": manifest.host_label,
            "roots": manifest.roots.len(),
            "files": file_count,
            "bytes": manifest.total_bytes,
        }))
    }

    pub(super) fn verify_bundle(source: &Path) -> anyhow::Result<Value> {
        let verified = load_verified_bundle(source)?;
        let file_count = verified.manifest.entries.iter().filter(|entry| entry.kind != EntryKind::Directory).count();
        Ok(json!({
            "format": FORMAT,
            "complete": true,
            "host_label": verified.manifest.host_label,
            "roots": verified.manifest.roots.len(),
            "files": file_count,
            "bytes": verified.manifest.total_bytes,
            "manifest_bytes": verified.manifest_bytes,
        }))
    }

    pub(super) fn read_selected_manifest(source: &Path) -> anyhow::Result<(PathBuf, Vec<u8>)> {
        let path = canonical_real_directory(source, "release package source")?;
        let directory = open_absolute_directory(&path)?;
        ensure!(
            stat_matches_metadata(&stat_path(&path)?, &directory.metadata()?),
            "release package source changed while opening"
        );
        let before = Fingerprint::from_metadata(&directory.metadata()?);
        let bytes = read_manifest_bytes_from_directory(&directory)?;
        ensure!(
            Fingerprint::from_metadata(&directory.metadata()?) == before
                && stat_matches_metadata(&stat_path(&path)?, &directory.metadata()?),
            "release package root changed while reading its manifest"
        );
        Ok((path, bytes))
    }

    pub(super) fn verify_selected_components(
        source: &Path,
        inventory: &SelectedComponentInventory,
        manifest_bytes: usize,
    ) -> anyhow::Result<()> {
        let path = canonical_real_directory(source, "release package source")?;
        let directory = open_absolute_directory(&path)?;
        ensure!(
            stat_matches_metadata(&stat_path(&path)?, &directory.metadata()?),
            "release package source changed while opening"
        );
        let before = Fingerprint::from_metadata(&directory.metadata()?);
        validate_selected_tree(&directory, inventory, manifest_bytes, true)?;
        ensure!(
            Fingerprint::from_metadata(&directory.metadata()?) == before
                && stat_matches_metadata(&stat_path(&path)?, &directory.metadata()?),
            "release package root changed during verification"
        );
        Ok(())
    }

    pub(super) fn restore_bundle(source: &Path, destination: &Path) -> anyhow::Result<RestoreReport> {
        let verified = load_verified_bundle(source)?;
        let destination_handle = validate_new_destination(destination, [verified.path.as_path()])?;
        let destination = destination_handle.path.clone();
        let destination_directory = destination_handle.create()?;
        let roots_directory = destination.join("roots");
        fs::create_dir(&roots_directory)?;
        set_directory_mode(&roots_directory)?;

        let mut restored_roots = BTreeMap::new();
        for root in &verified.manifest.roots {
            let path = roots_directory.join(&root.label);
            fs::create_dir(&path)?;
            set_directory_mode(&path)?;
            restored_roots.insert(root.label.clone(), path);
        }
        let mut entries = verified.manifest.entries.clone();
        entries.sort_by(|left, right| {
            let left_depth = left.path.split('/').count();
            let right_depth = right.path.split('/').count();
            (&left.root_label, left_depth, &left.path).cmp(&(&right.root_label, right_depth, &right.path))
        });
        for entry in entries.iter().filter(|entry| entry.kind == EntryKind::Directory) {
            let root = restored_roots.get(&entry.root_label).context("manifest root disappeared")?;
            let path = root.join(safe_manifest_path(&entry.path)?);
            fs::create_dir(&path).with_context(|| format!("creating restored directory {}", entry.path))?;
            set_directory_mode(&path)?;
        }

        let mut total_bytes = 0_u64;
        let mut digest_facts = Vec::new();
        let mut database_entries = Vec::new();
        for entry in entries.iter().filter(|entry| entry.kind != EntryKind::Directory) {
            let root = restored_roots.get(&entry.root_label).context("manifest root disappeared")?;
            let relative = safe_manifest_path(&entry.path)?;
            let output = root.join(&relative);
            let bundle_relative = PathBuf::from("roots").join(&entry.root_label).join(&relative);
            let mut input = open_relative_file(&verified.directory, &bundle_relative)?;
            let source_before = Fingerprint::from_metadata(&input.metadata()?);
            ensure!(source_before.links == 1, "bundle file is hard-linked");
            let mut output_file = create_private_file(&output)?;
            let (copied_bytes, copied_digest) = stream_file(
                &mut input,
                Some(&mut output_file),
                configured_max_bytes()?,
                &mut total_bytes,
            )?;
            output_file.sync_all()?;
            ensure!(copied_bytes == entry.byte_count, "restored file byte count differs from manifest");
            ensure!(Some(copied_digest.as_str()) == entry.sha256.as_deref(), "restored file digest differs from manifest");
            let destination_digest = digest_absolute_file(&output, configured_max_bytes()?)?;
            ensure!(destination_digest == copied_digest, "restored destination digest differs from copied bytes");
            ensure!(Fingerprint::from_metadata(&input.metadata()?) == source_before, "bundle file changed during restore");
            verify_relative_file_binding(&verified.directory, &bundle_relative, source_before)?;
            File::open(output.parent().context("restored file parent is missing")?)?.sync_all()?;
            digest_facts.push(RestoreDigestFact {
                root_label: entry.root_label.clone(),
                path: entry.path.clone(),
                bundle_sha256: entry.sha256.clone().context("file digest missing from manifest")?,
                copied_sha256: destination_digest.clone(),
                final_sha256: destination_digest,
                authority_row_adjusted: false,
            });
            if entry.kind == EntryKind::Sqlite {
                database_entries.push((entry.clone(), output));
            }
        }

        let mut integrity_checks = Vec::new();
        for (entry, path) in &database_entries {
            let facts = database_facts(path)?;
            ensure!(Some(&facts) == entry.database.as_ref(), "restored SQLite facts differ from the bundle manifest");
            integrity_checks.push(format!("roots/{}/{}", entry.root_label, entry.path));
        }
        let host_path = restored_roots
            .get(&verified.manifest.host_label)
            .context("restored Host root is missing")?
            .join("workspace.db");
        let saved_authority_epoch = read_authority_epoch(&host_path)?;
        let restored_authority_epoch = isolate_restored_host(&host_path)?;
        ensure!(restored_authority_epoch == saved_authority_epoch + 1, "restored Host authority epoch did not advance exactly once");
        ensure!(!read_dispatch_enabled(&host_path)?, "restored Host dispatch is not disabled");
        let host_final_digest = digest_absolute_file(&host_path, configured_max_bytes()?)?;
        let host_fact = digest_facts
            .iter_mut()
            .find(|fact| fact.root_label == verified.manifest.host_label && fact.path == "workspace.db")
            .context("restored Host database digest fact is missing")?;
        host_fact.final_sha256 = host_final_digest;
        host_fact.authority_row_adjusted = true;
        verify_database_integrity_only(&host_path)?;
        File::open(&host_path)?.sync_all()?;
        File::open(host_path.parent().context("restored Host root is missing")?)?.sync_all()?;
        sync_directory_tree(&destination)?;
        destination_directory.sync_all()?;
        destination_handle.parent.sync_all()?;
        // Privacy-lane admission truth for every captured home root. Both
        // lanes and any legacy originals were restored byte-for-byte; the
        // same provenance rule governs new worker grants after restore: only
        // a registry-committed layout with a matching sealed marker admits
        // lanes, and every unproven entry — reserved names included — is
        // reported as legacy requiring the explicit operator migration.
        let ledger = verified
            .manifest
            .roots
            .iter()
            .find(|root| root.role == "computer-registry")
            .and_then(|root| restored_roots.get(&root.label))
            .and_then(|path| {
                Connection::open_with_flags(
                    path.join("computer-registry.sqlite3"),
                    OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .ok()
            });
        let committed_home_layout_id = |computer_id: &str| -> Option<String> {
            let connection = ledger.as_ref()?;
            connection
                .query_row(
                    "SELECT layout_id FROM computer_home_layouts
                     WHERE computer_id=?1 AND state='committed'",
                    [computer_id],
                    |row| row.get(0),
                )
                .ok()
        };
        let mut home_lanes = Vec::new();
        let mut lane_reconciliations = Vec::new();
        for computer in &verified.manifest.home_browser_manifest.computers {
            let RootPresence::Present { root_label, relative_path } = &computer.home else {
                continue;
            };
            let component = restored_roots
                .get(root_label)
                .context("restored home component is missing")?;
            let nested = (!relative_path.is_empty()).then(|| component.join(relative_path));
            let restored = nested.as_deref().unwrap_or(component.as_path());
            let admission =
                match crate::operations::home_lanes::open_layout_by_marker_at_root(
                    restored,
                    &computer.computer_id,
                ) {
                    Ok(layout) => match committed_home_layout_id(&computer.computer_id) {
                        Some(committed) if committed == layout.layout_id => "lane_isolated",
                        Some(_) => "provenance_mismatch_refused",
                        None => "layout_unverified",
                    },
                    Err(_) => {
                        // A lone layout whose marker exists but fails its
                        // identity check is forged; anything else is
                        // unproven legacy state for the operator migration.
                        let mut layout_entries = 0_usize;
                        let mut invalid_marker = false;
                        if let Ok(entries) = fs::read_dir(restored) {
                            for entry in entries.flatten() {
                                let name = entry.file_name().to_string_lossy().into_owned();
                                if !name.starts_with(crate::operations::home_lanes::LAYOUT_DIR_PREFIX)
                                {
                                    continue;
                                }
                                layout_entries += 1;
                                let layout_id = name
                                    .strip_prefix(crate::operations::home_lanes::LAYOUT_DIR_PREFIX)
                                    .unwrap_or_default();
                                if let Ok(raw) = fs::read_to_string(
                                    restored.join(&name).join(crate::operations::home_lanes::LAYOUT_MARKER_NAME),
                                ) {
                                    invalid_marker = crate::operations::home_lanes::validate_marker_bytes(
                                        &raw,
                                        layout_id,
                                        &computer.computer_id,
                                    )
                                    .is_err();
                                }
                            }
                        }
                        if layout_entries == 1 && invalid_marker {
                            "forged_refused"
                        } else {
                            lane_reconciliations.push(format!(
                                "restored home '{root_label}' for computer '{}' keeps unproven legacy originals (including any directories named 'public' or 'private'); run `ghost computers migrate-home` at the new authority epoch before granting worker homes",
                                computer.computer_id
                            ));
                            "legacy_requires_migration"
                        }
                    }
                };
            home_lanes.push(RestoredHomeLanes {
                computer_id: computer.computer_id.clone(),
                root_label: root_label.clone(),
                relative_path: relative_path.clone(),
                admission: admission.to_owned(),
            });
        }
        drop(ledger);
        let mut reconciliation_requirements = vec![
            "external effects and remote jobs require explicit reconciliation before dispatch".to_owned(),
            "legacy receipts and source-owner state require reconciliation against the restored high-water facts".to_owned(),
        ];
        reconciliation_requirements.extend(lane_reconciliations);
        Ok(RestoreReport {
            restored_roots,
            restored_authority_epoch,
            dispatch_enabled: false,
            integrity_checks,
            digest_facts,
            home_lanes,
            quarantine_requirements: vec![
                "old source owners remain stopped until root confirms real worker, broker, and publisher fence acknowledgements".to_owned(),
                "worker, broker, and publisher credentials require root-owned explicit rebinding; credential values are not in the bundle".to_owned(),
                "Pi storage mappings and historical artifact locators require explicit root-owned rebind".to_owned(),
                "restored browser profiles stay unallocated until explicit computer rebind and browser service attach at the new authority epoch".to_owned(),
                "old restored leases never resurrect; released and revoked reservations are terminal and cannot reacquire at the new epoch".to_owned(),
            ],
            reconciliation_requirements,
        })
    }

    fn validate_request(request: &BundleRequest) -> anyhow::Result<()> {
        ensure!(!request.roots.is_empty(), "recovery request has no roots");
        ensure!(request.roots.len() <= MAX_FILES, "recovery request has too many roots");
        ensure!(safe_label(&request.host_label), "Host label is unsafe");
        ensure!(!request.release.source_revision.trim().is_empty(), "release source revision is missing");
        ensure!(request.release.source_revision.len() <= 512 && !has_control(&request.release.source_revision), "release source revision is invalid");
        ensure!(valid_digest(&request.release.dirty_snapshot_digest), "dirty snapshot digest is malformed");
        ensure!(valid_digest(&request.release.config_digest), "release config digest is malformed");
        ensure!(request.release.schema_min <= request.release.schema_max, "release schema range is reversed");
        ensure!(!request.release.protocol_revision.trim().is_empty() && request.release.protocol_revision.len() <= 128, "protocol revision is missing or oversized");
        ensure!(!request.release.component_digests.is_empty(), "release component digests are missing");
        for (name, digest) in &request.release.component_digests {
            ensure!(safe_reference_name(name), "release component name is invalid");
            ensure!(valid_digest(digest), "release component digest is malformed");
        }
        for (name, version) in &request.release.pinned_runtime_versions {
            ensure!(safe_reference_name(name), "runtime pin name is invalid");
            ensure!(!version.trim().is_empty() && version.len() <= 512 && !has_control(version), "runtime pin is invalid");
        }
        for image in &request.release.image_references {
            ensure!(!image.trim().is_empty() && image.len() <= 1024 && !has_control(image), "image reference is invalid");
            ensure!(!contains_url_userinfo(image), "image reference contains embedded credentials");
        }
        for reference in &request.external_document_references {
            ensure!(
                !reference.trim().is_empty()
                    && reference.len() <= 4096
                    && !has_control(reference)
                    && !contains_url_userinfo(reference),
                "external document reference is invalid or contains embedded credentials"
            );
        }
        let mut labels = BTreeSet::new();
        for root in &request.roots {
            ensure!(safe_label(&root.label), "root label is unsafe");
            ensure!(safe_label(&root.role), "root role is unsafe");
            ensure!(labels.insert(root.label.as_str()), "duplicate root label");
            ensure!(!root.stopped_owner_pids.is_empty(), "each root requires nonempty stopped-owner PID coverage");
            let mut pids = BTreeSet::new();
            for pid in &root.stopped_owner_pids {
                ensure!(*pid > 0, "stopped-owner PID is malformed");
                ensure!(pids.insert(*pid), "duplicate stopped-owner PID in root");
            }
            let mut exclusions = BTreeSet::new();
            for path in &root.excluded_credential_paths {
                let value = safe_relative(path)?;
                ensure!(exclusions.insert(value), "duplicate credential exclusion path");
            }
            let mut references = BTreeSet::new();
            for reference in &root.credential_references {
                ensure!(safe_reference_name(reference), "credential reference must be a name, not a value or path");
                ensure!(references.insert(reference), "duplicate credential reference");
            }
            ensure!(
                root.excluded_credential_paths.is_empty() || !root.credential_references.is_empty(),
                "excluded credentials require reference names"
            );
        }
        ensure!(labels.contains(request.host_label.as_str()), "Host label does not identify a selected root");
        validate_home_browser_manifest(&request.home_browser_manifest, &labels)?;
        // The registry ledger is the authority for Ghost/computer mapping:
        // when the master registry root is captured, every manifest computer
        // must exist in it; invented labels are refused.
        let registry_root = request.roots.iter().find(|root| root.role == "computer-registry");
        if let Some(registry_root) = registry_root {
            let ledger = registry_root.path.join("computer-registry.sqlite3");
            ensure!(ledger.is_file(), "computer-registry root does not contain the registry ledger");
            let computers = manifest_computer_ids(&ledger)?;
            for entry in &request.home_browser_manifest.computers {
                ensure!(
                    computers.contains(&entry.computer_id),
                    "manifest computer '{}' is not registered in the captured registry ledger",
                    entry.computer_id
                );
            }
        }
        Ok(())
    }

    fn validate_home_browser_manifest(
        manifest: &HomeBrowserManifest,
        labels: &BTreeSet<&str>,
    ) -> anyhow::Result<()> {
        let mut computers = BTreeSet::new();
        for entry in &manifest.computers {
            ensure!(
                !entry.computer_id.is_empty()
                    && entry.computer_id.len() <= 180
                    && !entry.computer_id.starts_with('.')
                    && entry
                        .computer_id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
                "manifest computer identity is unsafe"
            );
            ensure!(computers.insert(entry.computer_id.as_str()), "duplicate manifest computer identity");
            validate_presence(&entry.home, labels)?;
            validate_presence(&entry.browser, labels)?;
        }
        Ok(())
    }

    /// Reads registered computer identities from a captured registry ledger.
    fn manifest_computer_ids(ledger: &Path) -> anyhow::Result<std::collections::BTreeSet<String>> {
        let connection = rusqlite::Connection::open_with_flags(
            ledger,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut statement = connection.prepare("SELECT computer_id FROM computer_bindings")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut computers = std::collections::BTreeSet::new();
        for row in rows {
            computers.insert(row?);
        }
        Ok(computers)
    }

    fn validate_presence(state: &RootPresence, labels: &BTreeSet<&str>) -> anyhow::Result<()> {
        if let RootPresence::Present { root_label, relative_path } = state {
            ensure!(safe_label(root_label) && labels.contains(root_label.as_str()), "present home/browser state must name a selected root");
            if !relative_path.is_empty() {
                safe_manifest_path(relative_path)?;
            }
        }
        Ok(())
    }

    fn prepare_roots(request: &BundleRequest) -> anyhow::Result<Vec<PreparedRoot<'_>>> {
        let mut roots = Vec::with_capacity(request.roots.len());
        for spec in &request.roots {
            let path = canonical_real_directory(&spec.path, "source root")?;
            let directory = open_absolute_directory(&path)
                .context("opening source root without following symlinks")?;
            let metadata = fs::symlink_metadata(&path)?;
            ensure!(stat_matches_metadata(&stat_path(&path)?, &directory.metadata()?), "source root changed while opening");
            ensure!(metadata.is_dir() && !metadata.file_type().is_symlink(), "source root is not a real directory");
            roots.push(PreparedRoot {
                spec,
                path,
                fingerprint: Fingerprint::from_metadata(&directory.metadata()?),
                directory,
            });
        }
        for computer in &request.home_browser_manifest.computers {
            for presence in [&computer.home, &computer.browser] {
                let RootPresence::Present { root_label, relative_path } = presence else {
                    continue;
                };
                if relative_path.is_empty() {
                    continue;
                }
                let root = roots.iter().find(|root| root.spec.label == *root_label)
                    .context("home/browser component is missing")?;
                let relative = safe_manifest_path(relative_path)?;
                ensure!(!root.spec.excluded_credential_paths.iter().any(|excluded| relative.starts_with(excluded)),
                    "home/browser path is excluded from the captured inventory");
                let stat = stat_relative(&root.directory, &relative)?;
                ensure!(stat.st_mode & libc::S_IFMT == libc::S_IFDIR,
                    "home/browser path must be a real directory inside its selected component");
            }
        }
        Ok(roots)
    }

    fn validate_root_nonoverlap(roots: &[PreparedRoot<'_>]) -> anyhow::Result<()> {
        for left in 0..roots.len() {
            for right in (left + 1)..roots.len() {
                ensure!(
                    !roots[left].path.starts_with(&roots[right].path)
                        && !roots[right].path.starts_with(&roots[left].path),
                    "selected roots overlap or nest"
                );
            }
        }
        Ok(())
    }

    fn validate_new_destination<'a>(
        destination: &Path,
        source_roots: impl IntoIterator<Item = &'a Path>,
    ) -> anyhow::Result<NewDestination> {
        ensure!(destination.is_absolute(), "destination must be absolute");
        let name = destination.file_name().context("destination name is missing")?;
        ensure!(name != OsStr::new(".") && name != OsStr::new(".."), "destination name is invalid");
        let parent = destination.parent().context("destination parent is missing")?;
        let canonical_parent = canonical_real_directory(parent, "destination parent")?;
        let parent_directory = open_absolute_directory(&canonical_parent)?;
        let canonical_destination = canonical_parent.join(name);
        match fs::symlink_metadata(&canonical_destination) {
            Ok(_) => bail!("destination already exists; refusing to overwrite it"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        for source in source_roots {
            ensure!(
                !canonical_destination.starts_with(source) && !source.starts_with(&canonical_destination),
                "source and destination roots overlap or nest"
            );
        }
        Ok(NewDestination {
            path: canonical_destination,
            parent: parent_directory,
            name: cstring(name.as_bytes(), "destination name")?,
        })
    }

    fn canonical_real_directory(path: &Path, label: &str) -> anyhow::Result<PathBuf> {
        ensure!(path.is_absolute(), "{label} must be absolute");
        let metadata = fs::symlink_metadata(path).with_context(|| format!("inspecting {label}"))?;
        ensure!(metadata.is_dir() && !metadata.file_type().is_symlink(), "{label} must be a real directory");
        path.canonicalize().with_context(|| format!("canonicalizing {label}"))
    }

    fn check_all_owners_stopped(roots: &[PreparedRoot<'_>]) -> anyhow::Result<()> {
        let current = std::process::id() as i32;
        for root in roots {
            ensure!(!root.spec.stopped_owner_pids.is_empty(), "source-owner PID coverage is missing");
            for pid in &root.spec.stopped_owner_pids {
                ensure!(*pid > 0 && *pid != current, "malformed or current-process source-owner PID");
                let result = unsafe { libc::kill(*pid as libc::pid_t, 0) };
                if result == 0 {
                    bail!("source owner PID {pid} is still live");
                }
                let error = std::io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::ESRCH) => {}
                    Some(libc::EPERM) => bail!("source owner PID {pid} is live or cannot be inspected"),
                    _ => bail!("source owner PID {pid} could not be verified absent: {error}"),
                }
            }
        }
        Ok(())
    }

    fn validate_exact_exclusions(root: &PreparedRoot<'_>) -> anyhow::Result<()> {
        for path in &root.spec.excluded_credential_paths {
            let stat = stat_relative(&root.directory, path)?;
            let kind = stat.st_mode & libc::S_IFMT;
            ensure!(
                kind == libc::S_IFDIR || (kind == libc::S_IFREG && stat.st_nlink == 1),
                "credential exclusion is not a real directory or singly-linked file"
            );
        }
        Ok(())
    }

    fn immutable_file_mode(source_mode: u32) -> u32 {
        (source_mode & 0o555) | 0o400
    }

    fn immutable_directory_mode(source_mode: u32) -> u32 {
        (source_mode & 0o555) | 0o500
    }

    fn scan_root(root: &PreparedRoot<'_>) -> anyhow::Result<Vec<ScannedEntry>> {
        let exclusions = root
            .spec
            .excluded_credential_paths
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut pending = vec![PathBuf::new()];
        let mut entries = Vec::new();
        let mut visited = 0_usize;
        while let Some(relative_directory) = pending.pop() {
            let directory = open_relative_directory(&root.directory, &relative_directory)?;
            let before_directory = Fingerprint::from_metadata(&directory.metadata()?);
            verify_directory_path_binding(root, &relative_directory, &directory)?;
            let mut names = directory_names(&directory)
                .with_context(|| format!("enumerating source directory {}", relative_directory.display()))?;
            names.sort();
            for name in names {
                visited += 1;
                ensure!(visited <= MAX_FILES * 2, "selected root exceeds the bundle entry limit");
                let relative = relative_directory.join(&name);
                let relative_text = safe_relative(&relative)?;
                let stat = stat_relative(&root.directory, &relative)?;
                let excluded = is_excluded(&relative, &exclusions);
                let basename = relative.file_name().and_then(OsStr::to_str).context("source path is not UTF-8")?;
                let file_type = stat.st_mode & libc::S_IFMT;
                if is_ephemeral_file(basename) {
                    ensure!(file_type == libc::S_IFREG, "runtime lock path has an unexpected filesystem type");
                }
                if is_known_socket_name(basename) {
                    ensure!(file_type == libc::S_IFSOCK, "socket path has an unexpected filesystem type");
                }
                if file_type == libc::S_IFDIR {
                    ensure!(!basename.ends_with("-wal") && !basename.ends_with("-shm") && !basename.ends_with("-journal"), "SQLite sidecar is not a regular file");
                    let child = open_relative_directory(&root.directory, &relative)?;
                    ensure!(stat_matches_metadata(&stat, &child.metadata()?), "source directory changed while scanning");
                    pending.push(relative.clone());
                    if !excluded {
                        entries.push(ScannedEntry {
                            relative,
                            kind: ScannedKind::Directory,
                            fingerprint: Fingerprint::from_metadata(&child.metadata()?),
                        });
                    }
                    continue;
                }
                if file_type == libc::S_IFSOCK {
                    ensure!(is_known_socket_name(basename), "unknown socket in selected root: {relative_text}");
                    continue;
                }
                ensure!(file_type == libc::S_IFREG, "special source file refused: {relative_text}");
                ensure!(stat.st_nlink == 1, "hard-linked source file refused: {relative_text}");
                let size = file_length(&stat)?;
                let mut file = open_relative_file(&root.directory, &relative)?;
                let fingerprint = Fingerprint::from_metadata(&file.metadata()?);
                ensure!(fingerprint.links == 1 && stat_matches_metadata(&stat, &file.metadata()?), "source file changed while scanning");
                if excluded {
                    continue;
                }
                if is_ephemeral_file(basename) {
                    continue;
                }
                if basename.ends_with("-journal") {
                    bail!("SQLite rollback journal requires owner recovery before capture: {relative_text}");
                }
                if basename.ends_with("-wal") || basename.ends_with("-shm") {
                    entries.push(ScannedEntry { relative, kind: ScannedKind::Sidecar, fingerprint });
                    continue;
                }
                ensure!(!credential_like(&relative), "credential-like file must be excluded by exact relative path: {relative_text}");
                let sqlite = detect_sqlite_file(&relative, &mut file)?;
                ensure!(size <= configured_max_bytes()?, "single source file exceeds recovery byte limit");
                entries.push(ScannedEntry {
                    relative,
                    kind: if sqlite { ScannedKind::Sqlite } else { ScannedKind::File },
                    fingerprint,
                });
            }
            ensure!(
                Fingerprint::from_metadata(&directory.metadata()?) == before_directory,
                "source directory changed during enumeration"
            );
            verify_directory_path_binding(root, &relative_directory, &directory)?;
        }
        entries.sort_by(|left, right| left.relative.cmp(&right.relative).then_with(|| left.kind.cmp(&right.kind)));
        let file_count = entries.iter().filter(|entry| matches!(entry.kind, ScannedKind::File | ScannedKind::Sqlite)).count();
        ensure!(file_count <= MAX_FILES, "selected root exceeds the 10,000-file limit");
        Ok(entries)
    }

    fn validate_sqlite_sidecars(entries: &[ScannedEntry]) -> anyhow::Result<()> {
        let databases = entries
            .iter()
            .filter(|entry| entry.kind == ScannedKind::Sqlite)
            .map(|entry| entry.relative.clone())
            .collect::<BTreeSet<_>>();
        for entry in entries.iter().filter(|entry| entry.kind == ScannedKind::Sidecar) {
            let text = entry.relative.to_str().context("SQLite sidecar path is not UTF-8")?;
            let base = text
                .strip_suffix("-wal")
                .or_else(|| text.strip_suffix("-shm"))
                .context("unrecognized SQLite sidecar")?;
            ensure!(databases.contains(Path::new(base)), "orphan SQLite WAL/shared-memory sidecar refused: {text}");
        }
        Ok(())
    }

    fn snapshot_sqlite_database(
        root: &PreparedRoot<'_>,
        entry: &ScannedEntry,
        scanned: &[ScannedEntry],
        destination: &Path,
        total_bytes: &mut u64,
    ) -> anyhow::Result<DatabaseFacts> {
        // A read-only SQLite open can still create/remove WAL/SHM beside the
        // original. immutable=1 avoids that but ignores committed WAL frames.
        // Copy the stopped, pinned DB and WAL into private scratch instead.
        let scratch = tempfile::Builder::new()
            .prefix(".sqlite-capture-")
            .tempdir_in(destination.parent().context("SQLite target parent is missing")?)?;
        let source_path = scratch.path().join("source.db");
        let mut scratch_bytes = 0;
        copy_sqlite_capture_input(root, entry, &source_path, &mut scratch_bytes)?;
        let mut wal_name = entry.relative.as_os_str().to_os_string();
        wal_name.push("-wal");
        let wal_relative = PathBuf::from(wal_name);
        if let Ok(index) = scanned.binary_search_by(|candidate| candidate.relative.cmp(&wal_relative)) {
            let wal = &scanned[index];
            ensure!(wal.kind == ScannedKind::Sidecar, "SQLite WAL is not a captured sidecar");
            copy_sqlite_capture_input(root, wal, &scratch.path().join("source.db-wal"), &mut scratch_bytes)?;
        }
        let source = Connection::open_with_flags(
            &source_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .with_context(|| format!("opening copied SQLite source {}", entry.relative.display()))?;
        let target_file = create_private_file(destination)?;
        target_file.sync_all()?;
        drop(target_file);
        let mut target = Connection::open(destination)?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
            backup.run_to_completion(128, Duration::from_millis(5), None)?;
        }
        // Backup preserves the source WAL header. A self-contained snapshot
        // must use rollback mode so read-only verification creates no sidecars.
        target.pragma_update(None, "journal_mode", "DELETE")?;
        drop(target);
        drop(source);
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600))?;
        let bytes = fs::metadata(destination)?.len();
        ensure!(
            total_bytes.checked_add(bytes).unwrap_or(u64::MAX) <= configured_max_bytes()?,
            "recovery bundle exceeds the configured byte limit"
        );
        *total_bytes += bytes;
        database_facts(destination)
    }

    fn copy_sqlite_capture_input(
        root: &PreparedRoot<'_>,
        entry: &ScannedEntry,
        destination: &Path,
        scratch_bytes: &mut u64,
    ) -> anyhow::Result<()> {
        let length = entry.fingerprint.length;
        let next_bytes = scratch_bytes.checked_add(length).context("SQLite capture byte count overflow")?;
        ensure!(next_bytes <= configured_max_bytes()?, "SQLite DB and WAL exceed the configured capture limit");
        let mut input = open_relative_file(&root.directory, &entry.relative)?;
        ensure!(
            Fingerprint::from_metadata(&input.metadata()?) == entry.fingerprint && entry.fingerprint.links == 1,
            "SQLite capture input changed or is hard-linked before copying"
        );
        let mut output = create_private_file(destination)?;
        let copied = std::io::copy(&mut (&mut input).take(length + 1), &mut output)?;
        ensure!(copied == length, "SQLite capture input length changed while copying");
        ensure!(
            Fingerprint::from_metadata(&input.metadata()?) == entry.fingerprint,
            "SQLite capture input changed while copying"
        );
        verify_relative_file_binding(&root.directory, &entry.relative, entry.fingerprint)?;
        *scratch_bytes = next_bytes;
        Ok(())
    }

    fn validate_host_database(root: &Path, manifest: &BundleManifest) -> anyhow::Result<()> {
        let host_entry = manifest
            .entries
            .iter()
            .find(|entry| entry.root_label == manifest.host_label && entry.path == "workspace.db")
            .context("Host root must contain workspace.db")?;
        ensure!(host_entry.kind == EntryKind::Sqlite, "Host workspace.db is not a SQLite snapshot");
        let facts = host_entry.database.as_ref().context("Host database facts are missing")?;
        ensure!(matches!(facts.user_version, 9..=14), "Host schema is unsupported; only schemas 9 through 14 are restorable");
        ensure!(
            facts.user_version >= manifest.release.schema_min as i64
                && facts.user_version <= manifest.release.schema_max as i64,
            "Host schema is outside the release's declared support range"
        );
        let path = root.join("roots").join(&manifest.host_label).join("workspace.db");
        let (epoch, dispatch_enabled) = authority_state(&path)?;
        ensure!(epoch > 0 && (epoch as u64) <= MAX_AUTHORITY_EPOCH, "Host authority epoch is invalid");
        ensure!(dispatch_enabled == 0 || dispatch_enabled == 1, "Host dispatch state is invalid");
        Ok(())
    }

    fn read_manifest_bytes_from_directory(directory: &File) -> anyhow::Result<Vec<u8>> {
        let relative = Path::new("manifest.json");
        let mut file = open_relative_file(directory, relative)?;
        let before = Fingerprint::from_metadata(&file.metadata()?);
        ensure!(
            before.links == 1 && before.length <= MAX_MANIFEST_BYTES as u64,
            "manifest is linked or oversized"
        );
        let mut bytes = Vec::with_capacity(before.length as usize);
        (&mut file)
            .take(MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= MAX_MANIFEST_BYTES, "manifest exceeds 1 MiB");
        ensure!(Fingerprint::from_metadata(&file.metadata()?) == before, "manifest changed while reading");
        verify_relative_file_binding(directory, relative, before)?;
        Ok(bytes)
    }

    fn validate_selected_tree(
        directory: &File,
        inventory: &SelectedComponentInventory,
        manifest_bytes: usize,
        verify_contents: bool,
    ) -> anyhow::Result<()> {
        let root_metadata = directory.metadata()?;
        let root_fingerprint = Fingerprint::from_metadata(&root_metadata);
        ensure!(
            root_metadata.is_dir() && root_metadata.mode() & 0o777 == 0o500,
            "release package root is not committed read-only"
        );
        ensure!(
            inventory.len() > 0 && inventory.len() <= MAX_FILES,
            "release component count is invalid"
        );
        let mut expected = BTreeMap::<String, (SelectedInventoryKind, u64, u32, Option<String>)>::new();
        expected.insert(
            "components".to_owned(),
            (SelectedInventoryKind::Directory, 0, 0o555, None),
        );
        let mut component_bytes = 0_u64;
        let mut file_count = 0_usize;
        let mut inventory_rows = 0_usize;
        for (component, entries) in inventory {
            ensure!(safe_label(component), "release component label is unsafe");
            ensure!(!entries.is_empty(), "release component inventory is empty");
            let mut paths = BTreeSet::new();
            let mut root_entry = None;
            for entry in entries {
                inventory_rows = inventory_rows.checked_add(1).context("component inventory row count overflow")?;
                ensure!(inventory_rows <= MAX_FILES * 2, "release component inventory exceeds the entry limit");
                if entry.path.is_empty() {
                    ensure!(root_entry.replace(entry).is_none(), "duplicate component root inventory row");
                    ensure!(
                        entry.kind == SelectedInventoryKind::Directory
                            && entry.size == 0
                            && entry.sha256.is_none()
                            && entry.mode <= 0o777
                            && entry.mode & 0o222 == 0
                            && entry.mode & 0o500 == 0o500,
                        "component root inventory row is invalid"
                    );
                    continue;
                }
                let relative = safe_manifest_path(&entry.path)?;
                ensure!(paths.insert(entry.path.as_str()), "duplicate component inventory path");
                ensure!(entry.mode <= 0o777 && entry.mode & 0o222 == 0, "component entry mode is writable or invalid");
                let full_path = format!("components/{component}/{}", entry.path);
                let (size, digest) = match &entry.kind {
                    SelectedInventoryKind::Directory => {
                        ensure!(
                            entry.size == 0
                                && entry.sha256.is_none()
                                && entry.mode & 0o500 == 0o500,
                            "component directory inventory row is invalid"
                        );
                        (0, None)
                    }
                    SelectedInventoryKind::File => {
                        file_count = file_count.checked_add(1).context("component file count overflow")?;
                        ensure!(file_count < MAX_FILES, "release package exceeds the file limit");
                        ensure!(
                            entry.mode & 0o400 == 0o400
                                && entry.sha256.as_deref().is_some_and(valid_digest),
                            "component file digest or mode is invalid"
                        );
                        let relative_path = relative;
                        ensure!(
                            !credential_like(&relative_path),
                            "credential-like path is present in a selected component"
                        );
                        component_bytes = component_bytes
                            .checked_add(entry.size)
                            .context("component byte count overflow")?;
                        ensure!(component_bytes <= configured_max_bytes()?, "release package exceeds the byte limit");
                        (entry.size, entry.sha256.clone())
                    }
                };
                ensure!(
                    expected
                        .insert(
                            full_path,
                            (entry.kind.clone(), size, entry.mode, digest)
                        )
                        .is_none(),
                    "duplicate release inventory path"
                );
            }
            let root_entry = root_entry.context("component root inventory row is missing")?;
            ensure!(
                expected
                    .insert(
                        format!("components/{component}"),
                        (
                            SelectedInventoryKind::Directory,
                            0,
                            root_entry.mode,
                            None,
                        )
                    )
                    .is_none(),
                "duplicate release component root"
            );
        }
        expected.insert(
            "manifest.json".to_owned(),
            (SelectedInventoryKind::File, manifest_bytes as u64, 0o444, None),
        );
        ensure!(manifest_bytes <= MAX_MANIFEST_BYTES, "release manifest exceeds 1 MiB");
        ensure!(
            component_bytes
                .checked_add(manifest_bytes as u64)
                .context("release package byte count overflow")?
                <= configured_max_bytes()?,
            "release package exceeds the byte limit"
        );

        let mut actual = BTreeSet::new();
        let mut pending = vec![PathBuf::new()];
        let mut directory_fingerprints = BTreeMap::new();
        let mut streamed_bytes = 0_u64;
        while let Some(relative_directory) = pending.pop() {
            let current = open_relative_directory(directory, &relative_directory)?;
            let mut names = directory_names(&current)?;
            names.sort();
            for name in names {
                let relative = relative_directory.join(&name);
                let value = safe_relative(&relative)?;
                let (expected_kind, expected_size, expected_mode, expected_digest) =
                    expected.get(&value).context("release package has an unlisted entry")?;
                let stat = stat_relative(directory, &relative)?;
                let kind = stat.st_mode & libc::S_IFMT;
                if kind == libc::S_IFDIR {
                    ensure!(
                        *expected_kind == SelectedInventoryKind::Directory,
                        "release package entry type differs from its manifest"
                    );
                    let child = open_relative_directory(directory, &relative)?;
                    let metadata = child.metadata()?;
                    ensure!(stat_matches_metadata(&stat, &metadata), "release package directory changed while scanning");
                    let mode = metadata.mode() & 0o777;
                    ensure!(
                        mode == *expected_mode && mode & 0o222 == 0,
                        "release package directory mode differs from its manifest"
                    );
                    ensure!(
                        directory_fingerprints
                            .insert(relative.clone(), Fingerprint::from_metadata(&metadata))
                            .is_none(),
                        "duplicate release package directory"
                    );
                    pending.push(relative.clone());
                } else {
                    ensure!(
                        kind == libc::S_IFREG && stat.st_nlink == 1,
                        "release package symlink, special file, or hard link refused"
                    );
                    ensure!(
                        *expected_kind == SelectedInventoryKind::File,
                        "release package entry type differs from its manifest"
                    );
                    if let Some(relative_component_path) = relative.strip_prefix("components").ok() {
                        let mut components = relative_component_path.components();
                        let _component = components.next().context("component file lacks a label")?;
                        let local_path = components.as_path();
                        if !local_path.as_os_str().is_empty() {
                            ensure!(
                                !credential_like(local_path),
                                "credential-like path is present in a selected component"
                            );
                        }
                    }
                    let mut file = open_relative_file(directory, &relative)?;
                    let before = Fingerprint::from_metadata(&file.metadata()?);
                    let mode = file.metadata()?.mode() & 0o777;
                    ensure!(
                        before.links == 1
                            && before.length == *expected_size
                            && mode == *expected_mode
                            && mode & 0o222 == 0,
                        "release package file metadata differs from its manifest"
                    );
                    if verify_contents && value != "manifest.json" {
                        let (bytes, digest) = stream_file(&mut file, None, configured_max_bytes()?, &mut streamed_bytes)?;
                        ensure!(
                            bytes == *expected_size && Some(digest.as_str()) == expected_digest.as_deref(),
                            "release component file digest differs from its manifest"
                        );
                        ensure!(
                            Fingerprint::from_metadata(&file.metadata()?) == before,
                            "release component file changed during verification"
                        );
                        verify_relative_file_binding(directory, &relative, before)?;
                    }
                }
                ensure!(actual.insert(value), "duplicate release package entry");
            }
        }
        let expected_paths = expected.keys().cloned().collect::<BTreeSet<_>>();
        ensure!(
            actual == expected_paths,
            "release package inventory is missing or contains extra entries"
        );
        if verify_contents {
            ensure!(streamed_bytes == component_bytes, "verified component byte count differs from its inventory");
        }
        ensure!(
            Fingerprint::from_metadata(&directory.metadata()?) == root_fingerprint,
            "release package root changed during inventory verification"
        );
        for (relative, expected_fingerprint) in directory_fingerprints {
            let current = open_relative_directory(directory, &relative)?;
            ensure!(
                Fingerprint::from_metadata(&current.metadata()?) == expected_fingerprint,
                "release package directory changed during inventory verification"
            );
        }
        Ok(())
    }

    fn load_verified_bundle(source: &Path) -> anyhow::Result<VerifiedBundle> {
        let path = canonical_real_directory(source, "bundle source")?;
        let directory = open_absolute_directory(&path)?;
        ensure!(stat_matches_metadata(&stat_path(&path)?, &directory.metadata()?), "bundle source changed while opening");
        let bytes = read_manifest_bytes_from_directory(&directory)?;
        let manifest: BundleManifest = serde_json::from_slice(&bytes)?;
        validate_manifest(&manifest)?;
        ensure!(manifest.format == FORMAT && manifest.complete, "incomplete or unsupported recovery bundle");
        validate_bundle_inventory(&directory, &manifest, bytes.len())?;
        validate_bundle_entries(&directory, &manifest, bytes.len())?;
        validate_host_database(&path, &manifest)?;
        // The captured registry ledger remains the authority for the
        // Ghost/computer mapping: manifest computers must exist in it.
        if let Some(root) = manifest.roots.iter().find(|root| root.role == "computer-registry") {
            let ledger = path
                .join("roots")
                .join(&root.label)
                .join("computer-registry.sqlite3");
            ensure!(ledger.is_file(), "captured computer-registry root lacks its ledger");
            let computers = manifest_computer_ids(&ledger)?;
            for entry in &manifest.home_browser_manifest.computers {
                ensure!(
                    computers.contains(&entry.computer_id),
                    "manifest computer '{}' is absent from the captured registry ledger",
                    entry.computer_id
                );
            }
        }
        Ok(VerifiedBundle { path, directory, manifest, manifest_bytes: bytes.len() })
    }

    fn validate_manifest(manifest: &BundleManifest) -> anyhow::Result<()> {
        ensure!(manifest.format == FORMAT, "unsupported recovery bundle format");
        ensure!(safe_label(&manifest.host_label), "manifest Host label is unsafe");
        ensure!(!manifest.roots.is_empty() && manifest.roots.len() <= MAX_FILES, "manifest root count is invalid");
        ensure!(manifest.entries.len() <= MAX_FILES * 2, "manifest has too many entries");
        ensure!(manifest.total_bytes <= configured_max_bytes()?, "manifest total bytes exceed the limit");
        ensure!(!manifest.release.source_revision.trim().is_empty(), "manifest release revision is missing");
        ensure!(valid_digest(&manifest.release.dirty_snapshot_digest), "manifest dirty snapshot digest is malformed");
        ensure!(valid_digest(&manifest.release.config_digest), "manifest config digest is malformed");
        ensure!(manifest.release.schema_min <= manifest.release.schema_max, "manifest schema range is reversed");
        ensure!(
            !manifest.release.source_revision.trim().is_empty()
                && manifest.release.source_revision.len() <= 512
                && !has_control(&manifest.release.source_revision),
            "manifest release revision is invalid"
        );
        ensure!(
            !manifest.release.protocol_revision.trim().is_empty()
                && manifest.release.protocol_revision.len() <= 128
                && !has_control(&manifest.release.protocol_revision),
            "manifest protocol revision is invalid"
        );
        for (name, version) in &manifest.release.pinned_runtime_versions {
            ensure!(safe_reference_name(name) && !version.trim().is_empty() && version.len() <= 512 && !has_control(version), "manifest runtime pin is invalid");
        }
        for image in &manifest.release.image_references {
            ensure!(!image.trim().is_empty() && image.len() <= 1024 && !has_control(image), "manifest image reference is invalid");
            ensure!(!contains_url_userinfo(image), "manifest image reference contains embedded credentials");
        }
        ensure!(!manifest.release.component_digests.is_empty(), "manifest component digests are missing");
        for (name, digest) in &manifest.release.component_digests {
            ensure!(safe_reference_name(name) && valid_digest(digest), "manifest component identity is invalid");
        }
        let mut labels = BTreeSet::new();
        for root in &manifest.roots {
            ensure!(safe_label(&root.label) && safe_label(&root.role), "manifest root identity is unsafe");
            ensure!(labels.insert(root.label.as_str()), "duplicate manifest root label");
            ensure!(root.stopped_owner_pid_checks > 0, "manifest root lacks stopped-owner PID coverage");
            for reference in &root.credential_references {
                ensure!(safe_reference_name(reference), "manifest credential reference is not a name");
            }
        }
        ensure!(labels.contains(manifest.host_label.as_str()), "manifest Host root is missing");
        validate_home_browser_manifest(&manifest.home_browser_manifest, &labels)?;
        for reference in &manifest.external_document_references {
            ensure!(
                !reference.trim().is_empty()
                    && reference.len() <= 4096
                    && !has_control(reference)
                    && !contains_url_userinfo(reference),
                "manifest external reference is invalid or contains embedded credentials"
            );
        }
        let mut paths = BTreeMap::new();
        let mut total = 0_u64;
        let mut files = 0_usize;
        for entry in &manifest.entries {
            ensure!(labels.contains(entry.root_label.as_str()), "manifest entry names an unknown root");
            let relative = safe_manifest_path(&entry.path)?;
            ensure!(paths.insert((entry.root_label.as_str(), entry.path.as_str()), &entry.kind).is_none(), "duplicate manifest path");
            ensure!(!is_ephemeral_path(&relative), "ephemeral runtime state must not appear in a bundle");
            match entry.kind {
                EntryKind::Directory => {
                    ensure!(entry.byte_count == 0 && entry.sha256.is_none() && entry.database.is_none(), "directory manifest facts are invalid");
                }
                EntryKind::File => {
                    files += 1;
                    ensure!(entry.byte_count <= configured_max_bytes()?, "file exceeds bundle limit");
                    ensure!(entry.sha256.as_deref().is_some_and(valid_digest), "file digest is malformed");
                    ensure!(entry.database.is_none(), "raw file contains fabricated database facts");
                    total = total.checked_add(entry.byte_count).context("manifest byte count overflow")?;
                }
                EntryKind::Sqlite => {
                    files += 1;
                    ensure!(entry.byte_count <= configured_max_bytes()?, "database exceeds bundle limit");
                    ensure!(entry.sha256.as_deref().is_some_and(valid_digest), "database digest is malformed");
                    let facts = entry.database.as_ref().context("SQLite database facts are missing")?;
                    ensure!(facts.integrity_check == "ok" && facts.foreign_key_violations == 0, "SQLite integrity facts are invalid");
                    total = total.checked_add(entry.byte_count).context("manifest byte count overflow")?;
                }
            }
        }
        for computer in &manifest.home_browser_manifest.computers {
            for presence in [&computer.home, &computer.browser] {
                if let RootPresence::Present { root_label, relative_path } = presence {
                    ensure!(relative_path.is_empty() || paths.get(&(root_label.as_str(), relative_path.as_str()))
                        .is_some_and(|kind| **kind == EntryKind::Directory),
                        "home/browser path is absent from the captured directory inventory");
                }
            }
        }
        ensure!(files <= MAX_FILES, "manifest exceeds the 10,000-file limit");
        ensure!(total == manifest.total_bytes, "manifest total byte count does not match entries");
        ensure!(total <= configured_max_bytes()?, "manifest byte limit exceeded");
        Ok(())
    }

    fn validate_bundle_inventory(directory: &File, manifest: &BundleManifest, manifest_bytes: usize) -> anyhow::Result<()> {
        let actual = scan_bundle_tree(directory, manifest)?;
        let mut expected = BTreeSet::new();
        expected.insert(("manifest.json".to_owned(), EntryKind::File));
        expected.insert(("roots".to_owned(), EntryKind::Directory));
        for root in &manifest.roots {
            expected.insert((format!("roots/{}", root.label), EntryKind::Directory));
        }
        for entry in &manifest.entries {
            let path = format!("roots/{}/{}", entry.root_label, entry.path);
            expected.insert((path, entry.kind.clone()));
        }
        ensure!(actual == expected, "bundle file inventory contains missing, extra, or mismatched entries; extra={:?}; missing={:?}",
            actual.difference(&expected).take(8).collect::<Vec<_>>(),
            expected.difference(&actual).take(8).collect::<Vec<_>>());
        let file_count = actual.iter().filter(|(_, kind)| *kind != EntryKind::Directory).count();
        ensure!(file_count <= MAX_FILES, "bundle exceeds the 10,000-file limit");
        let byte_count = manifest.total_bytes.checked_add(manifest_bytes as u64).unwrap_or(u64::MAX);
        ensure!(byte_count <= configured_max_bytes()?, "bundle including manifest exceeds the 512 MiB limit");
        Ok(())
    }

    fn scan_bundle_tree(directory: &File, manifest: &BundleManifest) -> anyhow::Result<BTreeSet<(String, EntryKind)>> {
        let manifest_kinds = manifest
            .entries
            .iter()
            .map(|entry| (format!("roots/{}/{}", entry.root_label, entry.path), entry.kind.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut pending = vec![PathBuf::new()];
        let mut actual = BTreeSet::new();
        while let Some(relative_directory) = pending.pop() {
            let dir = open_relative_directory(directory, &relative_directory)?;
            let path = if relative_directory.as_os_str().is_empty() {
                None
            } else {
                Some(relative_directory.clone())
            };
            let mut names = directory_names(&dir)?;
            names.sort();
            for name in names {
                ensure!(actual.len() < MAX_FILES * 2 + manifest.roots.len() + 2, "bundle exceeds the inventory entry limit");
                let relative = relative_directory.join(&name);
                let value = safe_relative(&relative)?;
                let stat = stat_relative(directory, &relative)?;
                let kind = stat.st_mode & libc::S_IFMT;
                if kind == libc::S_IFDIR {
                    let child = open_relative_directory(directory, &relative)?;
                    ensure!(stat_matches_metadata(&stat, &child.metadata()?), "bundle directory changed while scanning");
                    actual.insert((value, EntryKind::Directory));
                    pending.push(relative);
                } else {
                    ensure!(kind == libc::S_IFREG, "bundle symlink or special file refused");
                    ensure!(stat.st_nlink == 1, "bundle hard-linked file refused");
                    let file = open_relative_file(directory, &relative)?;
                    let metadata = file.metadata()?;
                    ensure!(metadata.len() <= configured_max_bytes()?, "bundle file exceeds byte limit");
                    let entry_kind = if value == "manifest.json" {
                        EntryKind::File
                    } else {
                        match manifest_kinds.get(&value) {
                            Some(EntryKind::Directory) => bail!("bundle manifest classifies a regular file as a directory"),
                            Some(kind) => kind.clone(),
                            None => EntryKind::File,
                        }
                    };
                    actual.insert((value, entry_kind));
                    let after = Fingerprint::from_metadata(&file.metadata()?);
                    ensure!(after == Fingerprint::from_metadata(&metadata), "bundle file changed while scanning");
                }
            }
            if let Some(path) = path {
                let current = open_relative_directory(directory, &path)?;
                ensure!(current.metadata()?.is_dir(), "bundle directory changed while scanning");
            }
            let _ = dir;
        }
        Ok(actual)
    }

    fn validate_bundle_entries(directory: &File, manifest: &BundleManifest, manifest_bytes: usize) -> anyhow::Result<()> {
        let mut total = 0_u64;
        let mut file_count = 0_usize;
        for entry in &manifest.entries {
            if entry.kind == EntryKind::Directory {
                continue;
            }
            file_count += 1;
            ensure!(file_count <= MAX_FILES, "bundle exceeds file count limit");
            let relative = PathBuf::from("roots").join(&entry.root_label).join(safe_manifest_path(&entry.path)?);
            let mut file = open_relative_file(directory, &relative)?;
            let before = Fingerprint::from_metadata(&file.metadata()?);
            ensure!(before.links == 1 && before.length == entry.byte_count, "bundle file length or link count differs from manifest");
            let detected_sqlite = detect_sqlite_file(&relative, &mut file)?;
            ensure!(detected_sqlite == (entry.kind == EntryKind::Sqlite), "SQLite database was misclassified in manifest");
            file.seek(SeekFrom::Start(0))?;
            let (bytes, digest, facts) = if entry.kind == EntryKind::Sqlite {
                let (bytes, digest, facts) = database_facts_from_pinned_file(&mut file, &mut total)?;
                (bytes, digest, Some(facts))
            } else {
                let (bytes, digest) = stream_file(&mut file, None, configured_max_bytes()?, &mut total)?;
                (bytes, digest, None)
            };
            ensure!(bytes == entry.byte_count, "bundle file byte count changed");
            ensure!(Some(digest.as_str()) == entry.sha256.as_deref(), "bundle file digest mismatch");
            ensure!(Fingerprint::from_metadata(&file.metadata()?) == before, "bundle file mutated during verification");
            verify_relative_file_binding(directory, &relative, before)?;
            if let Some(facts) = facts {
                ensure!(Some(&facts) == entry.database.as_ref(), "bundle SQLite integrity or high-water facts mismatch");
            }
        }
        ensure!(total == manifest.total_bytes, "verified bytes differ from manifest total");
        ensure!(total.checked_add(manifest_bytes as u64).unwrap_or(u64::MAX) <= configured_max_bytes()?, "bundle byte limit exceeded");
        Ok(())
    }

    fn database_facts_from_pinned_file(file: &mut File, total: &mut u64) -> anyhow::Result<(u64, String, DatabaseFacts)> {
        let length = file.metadata()?.len();
        ensure!(length > 0 && length <= configured_max_bytes()?, "SQLite image exceeds the byte limit");
        let next_total = total.checked_add(length).context("SQLite byte count overflow")?;
        ensure!(next_total <= configured_max_bytes()?, "bundle exceeds the byte limit");
        let size = usize::try_from(length).context("SQLite image exceeds addressable memory")?;
        // Freeze bytes from the already pinned descriptor. Reopening a pathname
        // races; mmap of an untrusted file can SIGBUS on concurrent truncation.
        // Allocate once without zero-filling or a second image copy.
        struct SqliteImage(*mut u8);
        impl Drop for SqliteImage {
            fn drop(&mut self) { unsafe { rusqlite::ffi::sqlite3_free(self.0.cast()); } }
        }
        let pointer = unsafe { rusqlite::ffi::sqlite3_malloc64(length) }.cast::<u8>();
        ensure!(!pointer.is_null(), "could not allocate the bounded SQLite image");
        let image = SqliteImage(pointer);
        let bytes = unsafe { std::slice::from_raw_parts_mut(image.0, size) };
        file.read_exact(bytes)?;
        let digest = format!("{:x}", Sha256::digest(&*bytes));
        let conn = Connection::open_in_memory()?;
        // No FREEONCLOSE: the image guard outlives this read-only connection.
        let result = unsafe { rusqlite::ffi::sqlite3_deserialize(conn.handle(), c"main".as_ptr(),
            image.0, length as i64, length as i64, rusqlite::ffi::SQLITE_DESERIALIZE_READONLY) };
        ensure!(result == rusqlite::ffi::SQLITE_OK, "could not open the pinned SQLite image: {result}");
        let facts = database_facts_connection(&conn)?;
        *total = next_total;
        Ok((length, digest, facts))
    }

    fn database_facts(path: &Path) -> anyhow::Result<DatabaseFacts> {
        let metadata = fs::symlink_metadata(path)?;
        ensure!(metadata.is_file() && !metadata.file_type().is_symlink() && metadata.nlink() == 1, "SQLite database path is unsafe");
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        database_facts_connection(&conn)
    }

    fn database_facts_connection(conn: &Connection) -> anyhow::Result<DatabaseFacts> {
        let user_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let mut integrity = conn.prepare("PRAGMA integrity_check")?;
        let mut integrity_rows = integrity.query([])?;
        let integrity_value: String = integrity_rows.next()?.context("SQLite integrity_check returned no result")?.get(0)?;
        ensure!(integrity_value == "ok" && integrity_rows.next()?.is_none(), "SQLite integrity_check did not return exactly ok");
        let mut foreign_keys = conn.prepare("PRAGMA foreign_key_check")?;
        let mut rows = foreign_keys.query([])?;
        ensure!(rows.next()?.is_none(), "SQLite foreign_key_check reported violations");
        let receipt_cursor_high_water = collect_high_water(&conn)?;
        Ok(DatabaseFacts {
            user_version,
            integrity_check: "ok".to_owned(),
            foreign_key_violations: 0,
            receipt_cursor_high_water,
        })
    }

    fn verify_database_integrity_only(path: &Path) -> anyhow::Result<()> {
        let facts = database_facts(path)?;
        ensure!(facts.integrity_check == "ok" && facts.foreign_key_violations == 0, "restored Host database failed integrity checks");
        Ok(())
    }

    fn collect_high_water(conn: &Connection) -> anyhow::Result<BTreeMap<String, i64>> {
        let mut facts = BTreeMap::new();
        add_max_if_present(conn, "lifetime_outbox", "id", "lifetime_outbox.id", &mut facts)?;
        add_max_if_present(conn, "lifetime_delivery_receipts", "outbox_id", "lifetime_delivery_receipts.outbox_id", &mut facts)?;
        add_max_if_present(conn, "lifetime_mailbox", "sequence", "lifetime_mailbox.sequence", &mut facts)?;
        if table_exists(conn, "lifetime_inbox")?
            && columns_exist(conn, "lifetime_inbox", &["producer", "epoch", "sequence"])?
        {
            let mut statement = conn.prepare(
                "SELECT producer,epoch,MAX(sequence) FROM lifetime_inbox GROUP BY producer,epoch ORDER BY producer,epoch",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
            })?;
            for row in rows {
                let (producer, epoch, sequence) = row?;
                let key = serde_json::to_string(&(producer, epoch))?;
                facts.insert(format!("lifetime_inbox[{key}].sequence"), sequence);
            }
        }
        if table_exists(conn, "executions")?
            && columns_exist(conn, "executions", &["execution_id", "last_sequence", "acknowledged_sequence", "authority_epoch"])?
        {
            let mut statement = conn.prepare(
                "SELECT execution_id,last_sequence,acknowledged_sequence,authority_epoch FROM executions ORDER BY execution_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
            })?;
            for row in rows {
                let (execution, last, acknowledged, epoch) = row?;
                let key = serde_json::to_string(&execution)?;
                facts.insert(format!("executions[{key}].last_sequence"), last);
                facts.insert(format!("executions[{key}].acknowledged_sequence"), acknowledged);
                facts.insert(format!("executions[{key}].authority_epoch"), epoch);
            }
        }
        if table_exists(conn, "events")?
            && columns_exist(conn, "events", &["execution_id", "sequence"])?
        {
            let mut statement = conn.prepare(
                "SELECT execution_id,MAX(sequence) FROM events GROUP BY execution_id ORDER BY execution_id",
            )?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
            for row in rows {
                let (execution, sequence) = row?;
                let key = serde_json::to_string(&execution)?;
                facts.insert(format!("events[{key}].sequence"), sequence);
            }
        }
        if table_exists(conn, "tool_receipts")? {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM tool_receipts", [], |row| row.get(0))?;
            facts.insert("tool_receipts.count".to_owned(), count);
        }
        Ok(facts)
    }

    fn table_exists(conn: &Connection, table: &str) -> anyhow::Result<bool> {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )?)
    }

    fn columns_exist(conn: &Connection, table: &str, wanted: &[&str]) -> anyhow::Result<bool> {
        let sql = format!("PRAGMA table_info(\"{table}\")");
        let mut statement = conn.prepare(&sql)?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?;
        Ok(wanted.iter().all(|column| columns.contains(*column)))
    }

    fn add_max_if_present(
        conn: &Connection,
        table: &str,
        column: &str,
        key: &str,
        facts: &mut BTreeMap<String, i64>,
    ) -> anyhow::Result<()> {
        if table_exists(conn, table)? && columns_exist(conn, table, &[column])? {
            let sql = format!("SELECT MAX(\"{column}\") FROM \"{table}\"");
            let high_water: Option<i64> = conn.query_row(&sql, [], |row| row.get(0))?;
            if let Some(high_water) = high_water {
                facts.insert(key.to_owned(), high_water);
            }
        }
        Ok(())
    }

    fn authority_state(path: &Path) -> anyhow::Result<(i64, i64)> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        ensure!(table_exists(&conn, "lifetime_authority")?, "Host lifetime_authority table is missing");
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM lifetime_authority WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        ensure!(count == 1, "Host lifetime_authority singleton row is missing");
        Ok(conn.query_row(
            "SELECT authority_epoch,dispatch_enabled FROM lifetime_authority WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }

    fn read_authority_epoch(path: &Path) -> anyhow::Result<u64> {
        let (epoch, _) = authority_state(path)?;
        ensure!(epoch > 0 && epoch as u64 <= MAX_AUTHORITY_EPOCH, "saved Host authority epoch is invalid");
        Ok(epoch as u64)
    }

    fn read_dispatch_enabled(path: &Path) -> anyhow::Result<bool> {
        let (_, enabled) = authority_state(path)?;
        ensure!(enabled == 0 || enabled == 1, "Host dispatch state is invalid");
        Ok(enabled == 1)
    }

    fn isolate_restored_host(path: &Path) -> anyhow::Result<u64> {
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (epoch, dispatch): (i64, i64) = tx.query_row(
            "SELECT authority_epoch,dispatch_enabled FROM lifetime_authority WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        ensure!(epoch > 0 && (epoch as u64) < MAX_AUTHORITY_EPOCH, "Host authority epoch cannot be advanced safely");
        ensure!(dispatch == 0 || dispatch == 1, "Host dispatch state is invalid");
        let next = epoch + 1;
        let changed = tx.execute(
            "UPDATE lifetime_authority SET authority_epoch=?1,dispatch_enabled=0 WHERE singleton=1 AND authority_epoch=?2",
            rusqlite::params![next, epoch],
        )?;
        ensure!(changed == 1, "Host authority row changed during restore");
        tx.commit()?;
        drop(conn);
        verify_database_integrity_only(path)?;
        File::open(path)?.sync_all()?;
        Ok(next as u64)
    }

    fn open_absolute_directory(path: &Path) -> anyhow::Result<File> {
        ensure!(path.is_absolute(), "directory path must be absolute");
        let root_name = cstring(b"/", "filesystem root")?;
        let mut current = open_at(libc::AT_FDCWD, &root_name, DIRECTORY_FLAGS)?;
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let name = cstring(name.as_bytes(), "absolute directory component")?;
                    let before = stat_at(current.as_raw_fd(), &name)?;
                    ensure!(is_directory(&before), "absolute directory path contains a symlink or non-directory");
                    let next = open_at(current.as_raw_fd(), &name, DIRECTORY_FLAGS)?;
                    ensure!(stat_matches_metadata(&before, &next.metadata()?), "absolute directory changed while opening");
                    current = next;
                }
                _ => bail!("absolute directory path is not normalized"),
            }
        }
        Ok(current)
    }

    fn open_relative_directory(root: &File, relative: &Path) -> anyhow::Result<File> {
        if relative.as_os_str().is_empty() {
            return Ok(root.try_clone()?);
        }
        safe_relative(relative)?;
        let mut current = root.try_clone()?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                bail!("unsafe directory component");
            };
            let name = cstring(name.as_bytes(), "directory component")?;
            let before = stat_at(current.as_raw_fd(), &name)?;
            ensure!(is_directory(&before), "directory path contains a symlink or non-directory");
            let next = open_at(current.as_raw_fd(), &name, DIRECTORY_FLAGS)?;
            ensure!(stat_matches_metadata(&before, &next.metadata()?), "directory changed while opening");
            current = next;
        }
        Ok(current)
    }

    fn open_relative_file(root: &File, relative: &Path) -> anyhow::Result<File> {
        safe_relative(relative)?;
        let name = relative.file_name().context("file path has no final component")?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let parent_directory = open_relative_directory(root, parent)?;
        let name = cstring(name.as_bytes(), "file component")?;
        let before = stat_at(parent_directory.as_raw_fd(), &name)?;
        ensure!(is_regular_file(&before), "file path is a symlink or non-regular file");
        ensure!(before.st_nlink == 1, "hard-linked file refused");
        let file = open_at(parent_directory.as_raw_fd(), &name, FILE_FLAGS)?;
        let metadata = file.metadata()?;
        ensure!(metadata.is_file() && metadata.nlink() == 1 && stat_matches_metadata(&before, &metadata), "file changed while opening");
        Ok(file)
    }

    fn stat_relative(root: &File, relative: &Path) -> anyhow::Result<libc::stat> {
        safe_relative(relative)?;
        let name = relative.file_name().context("path has no final component")?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let directory = open_relative_directory(root, parent)?;
        let name = cstring(name.as_bytes(), "path component")?;
        stat_at(directory.as_raw_fd(), &name)
    }

    fn verify_relative_file_binding(root: &File, relative: &Path, expected: Fingerprint) -> anyhow::Result<()> {
        let stat = stat_relative(root, relative)?;
        ensure!(is_regular_file(&stat) && stat.st_nlink == 1 && stat_matches_fingerprint(&stat, expected), "file path was replaced during verification");
        Ok(())
    }

    fn same_directory_identity(left: Fingerprint, right: Fingerprint) -> bool {
        left.device == right.device
            && left.inode == right.inode
            && left.links == right.links
            && left.mode == right.mode
    }

    fn is_shared_memory_sidecar(entry: &ScannedEntry) -> bool {
        entry.kind == ScannedKind::Sidecar
            && entry.relative.file_name().and_then(OsStr::to_str).is_some_and(|name| name.ends_with("-shm"))
    }

    fn same_source_inventory(before: &[ScannedEntry], after: &[ScannedEntry]) -> bool {
        let mut before = before.iter().filter(|entry| !is_shared_memory_sidecar(entry));
        let mut after = after.iter().filter(|entry| !is_shared_memory_sidecar(entry));
        loop {
            match (before.next(), after.next()) {
                (None, None) => return true,
                (Some(left), Some(right)) => {
                    if left.relative != right.relative || left.kind != right.kind {
                        return false;
                    }
                    let unchanged = if left.kind == ScannedKind::Directory {
                        same_directory_identity(left.fingerprint, right.fingerprint)
                    } else {
                        left.fingerprint == right.fingerprint
                    };
                    if !unchanged {
                        return false;
                    }
                }
                _ => return false,
            }
        }
    }

    fn verify_directory_path_binding(root: &PreparedRoot<'_>, relative: &Path, directory: &File) -> anyhow::Result<()> {
        if relative.as_os_str().is_empty() {
            let current = fs::symlink_metadata(&root.path)?;
            ensure!(current.is_dir() && !current.file_type().is_symlink(), "source root was replaced");
            ensure!(same_directory_identity(Fingerprint::from_metadata(&current), root.fingerprint), "source root changed");
        } else {
            let stat = stat_relative(&root.directory, relative)?;
            ensure!(is_directory(&stat) && stat_matches_metadata(&stat, &directory.metadata()?), "source directory was replaced");
        }
        Ok(())
    }

    fn verify_root_unchanged(root: &PreparedRoot<'_>) -> anyhow::Result<()> {
        let current = fs::symlink_metadata(&root.path)?;
        ensure!(current.is_dir() && !current.file_type().is_symlink(), "source root was replaced");
        ensure!(same_directory_identity(Fingerprint::from_metadata(&current), root.fingerprint), "source root changed during capture");
        ensure!(same_directory_identity(Fingerprint::from_metadata(&root.directory.metadata()?), root.fingerprint), "opened source root changed during capture");
        Ok(())
    }

    fn directory_names(directory: &File) -> anyhow::Result<Vec<OsString>> {
        // Open a fresh directory cursor: dup() would share offsets with the
        // pinned descriptor. /dev/fd paths are not directories on macOS.
        let cursor = open_at(directory.as_raw_fd(), c".", DIRECTORY_FLAGS)?;
        let stream = unsafe { libc::fdopendir(cursor.as_raw_fd()) };
        ensure!(!stream.is_null(), "opening directory stream: {}", std::io::Error::last_os_error());
        let _ = cursor.into_raw_fd();
        struct DirectoryStream(*mut libc::DIR);
        impl Drop for DirectoryStream {
            fn drop(&mut self) {
                unsafe { libc::closedir(self.0); }
            }
        }
        let stream = DirectoryStream(stream);
        let mut names = Vec::new();
        loop {
            errno::set_errno(errno::Errno(0));
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                let error = errno::errno();
                ensure!(error.0 == 0, "reading directory stream: {error}");
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." { continue; }
            ensure!(names.len() < MAX_FILES * 2, "directory exceeds bundle entry limit");
            names.push(OsString::from_vec(name.to_vec()));
        }
        Ok(names)
    }

    fn stat_path(path: &Path) -> anyhow::Result<libc::stat> {
        let name = cstring(path.as_os_str().as_bytes(), "absolute path")?;
        let mut metadata = MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                libc::AT_FDCWD,
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        ensure!(result == 0, "could not stat path without following its final symlink: {}", std::io::Error::last_os_error());
        Ok(unsafe { metadata.assume_init() })
    }

    fn open_at(directory: RawFd, name: &CStr, flags: libc::c_int) -> anyhow::Result<File> {
        let descriptor = unsafe { libc::openat(directory, name.as_ptr(), flags, 0) };
        ensure!(descriptor >= 0, "could not open path component: {}", std::io::Error::last_os_error());
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn stat_at(directory: RawFd, name: &CString) -> anyhow::Result<libc::stat> {
        let mut metadata = MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(directory, name.as_ptr(), metadata.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
        };
        ensure!(result == 0, "could not inspect path component: {}", std::io::Error::last_os_error());
        Ok(unsafe { metadata.assume_init() })
    }

    fn stat_matches_metadata(stat: &libc::stat, metadata: &Metadata) -> bool {
        // Ancestor directory entries may legitimately change while unrelated
        // captures create sibling fixtures. Pin identity/type/permissions;
        // selected-tree inventories enforce content stability separately.
        stat.st_dev as u64 == metadata.dev()
            && stat.st_ino as u64 == metadata.ino()
            && stat.st_mode as u32 == metadata.mode()
            && (is_directory(stat)
                || (u64::try_from(stat.st_size).ok() == Some(metadata.len())
                    && stat.st_nlink as u64 == metadata.nlink()))
    }

    fn stat_matches_fingerprint(stat: &libc::stat, expected: Fingerprint) -> bool {
        u64::try_from(stat.st_size).ok() == Some(expected.length)
            && stat.st_dev as u64 == expected.device
            && stat.st_ino as u64 == expected.inode
            && stat.st_nlink as u64 == expected.links
            && stat.st_mode as u32 == expected.mode
    }

    fn is_directory(stat: &libc::stat) -> bool {
        stat.st_mode & libc::S_IFMT == libc::S_IFDIR
    }

    fn is_regular_file(stat: &libc::stat) -> bool {
        stat.st_mode & libc::S_IFMT == libc::S_IFREG
    }

    fn file_length(stat: &libc::stat) -> anyhow::Result<u64> {
        u64::try_from(stat.st_size).context("file has a negative length")
    }

    fn cstring(bytes: &[u8], label: &str) -> anyhow::Result<CString> {
        CString::new(bytes).with_context(|| format!("{label} contains a NUL byte"))
    }

    fn create_private_file(path: &Path) -> anyhow::Result<File> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let file = options.open(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }

    fn set_directory_mode(path: &Path) -> anyhow::Result<()> {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    fn write_manifest_atomic(destination: &Path, manifest: &BundleManifest) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(manifest)?;
        write_manifest_bytes_atomic(destination, &bytes, 0o600)
    }

    fn write_package_manifest_atomic(destination: &Path, bytes: &[u8]) -> anyhow::Result<()> {
        write_manifest_bytes_atomic(destination, bytes, 0o444)
    }

    fn write_manifest_bytes_atomic(destination: &Path, bytes: &[u8], mode: u32) -> anyhow::Result<()> {
        ensure!(bytes.len() <= MAX_MANIFEST_BYTES, "manifest exceeds the 1 MiB limit");
        let temporary = destination.join(".manifest.tmp");
        let path = destination.join("manifest.json");
        let mut file = create_private_file(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path).context("committing manifest")?;
        fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
        File::open(destination)?.sync_all()?;
        Ok(())
    }

    fn sync_directory_tree(root: &Path) -> anyhow::Result<()> {
        let mut pending = vec![root.to_path_buf()];
        let mut directories = Vec::new();
        while let Some(directory) = pending.pop() {
            let metadata = fs::symlink_metadata(&directory)?;
            ensure!(metadata.is_dir() && !metadata.file_type().is_symlink(), "output directory became unsafe");
            directories.push(directory.clone());
            for entry in fs::read_dir(&directory)? {
                let entry = entry?;
                let metadata = fs::symlink_metadata(entry.path())?;
                ensure!(!metadata.file_type().is_symlink(), "output symlink refused");
                if metadata.is_dir() {
                    pending.push(entry.path());
                }
            }
        }
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            File::open(directory)?.sync_all()?;
        }
        Ok(())
    }

    fn stream_file(
        input: &mut File,
        mut output: Option<&mut File>,
        total_limit: u64,
        total: &mut u64,
    ) -> anyhow::Result<(u64, String)> {
        let mut buffer = [0_u8; MAX_STREAM_BUFFER_BYTES];
        let mut hash = Sha256::new();
        let mut file_bytes = 0_u64;
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            let count = count as u64;
            file_bytes = file_bytes.checked_add(count).context("file byte count overflow")?;
            *total = total.checked_add(count).context("bundle byte count overflow")?;
            ensure!(*total <= total_limit, "recovery bundle exceeds its byte limit");
            hash.update(&buffer[..count as usize]);
            if let Some(output) = output.as_deref_mut() {
                output.write_all(&buffer[..count as usize])?;
            }
        }
        Ok((file_bytes, format!("{:x}", hash.finalize())))
    }

    fn digest_absolute_file(path: &Path, limit: u64) -> anyhow::Result<String> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAGS)
            .open(path)?;
        let before = Fingerprint::from_metadata(&file.metadata()?);
        ensure!(before.links == 1 && before.length <= limit, "file is linked or exceeds the digest limit");
        let mut total = 0_u64;
        let (_, digest) = stream_file(&mut file, None, limit, &mut total)?;
        ensure!(Fingerprint::from_metadata(&file.metadata()?) == before, "file changed while hashing");
        Ok(digest)
    }

    fn detect_sqlite_file(relative: &Path, file: &mut File) -> anyhow::Result<bool> {
        file.seek(SeekFrom::Start(0))?;
        let mut header = [0_u8; 16];
        let mut read = 0;
        while read < header.len() {
            let count = file.read(&mut header[read..])?;
            if count == 0 {
                break;
            }
            read += count;
        }
        file.seek(SeekFrom::Start(0))?;
        let is_sqlite = read == header.len() && &header == SQLITE_MAGIC;
        let extension = relative.extension().and_then(OsStr::to_str).unwrap_or("").to_ascii_lowercase();
        let database_name = matches!(extension.as_str(), "db" | "sqlite" | "sqlite3");
        ensure!(!database_name || is_sqlite, "SQLite-named file has an invalid database header");
        Ok(is_sqlite)
    }


    fn manifest_size(manifest: &BundleManifest) -> anyhow::Result<usize> {
        Ok(serde_json::to_vec(manifest)?.len())
    }

    fn manifest_path(path: &Path) -> anyhow::Result<String> {
        safe_relative(path)
    }

    fn safe_manifest_path(value: &str) -> anyhow::Result<PathBuf> {
        let path = PathBuf::from(value);
        ensure!(safe_relative(&path)? == value, "manifest path is not canonical relative form");
        Ok(path)
    }

    fn safe_relative(path: &Path) -> anyhow::Result<String> {
        ensure!(!path.is_absolute(), "absolute inventory path refused");
        let value = path.to_str().context("non-UTF-8 inventory path is unsupported")?;
        ensure!(!value.is_empty() && !value.contains('\\') && !has_control(value), "inventory path is empty or non-portable");
        ensure!(value.split('/').all(|part| !part.is_empty() && part != "." && part != ".."), "inventory traversal path refused");
        for component in path.components() {
            ensure!(matches!(component, Component::Normal(_)), "inventory traversal component refused");
        }
        Ok(value.to_owned())
    }

    fn is_excluded(path: &Path, exclusions: &BTreeSet<PathBuf>) -> bool {
        exclusions.iter().any(|excluded| path == excluded || path.starts_with(excluded))
    }

    fn is_ephemeral_file(basename: &str) -> bool {
        basename == ".ghost-control.json" || KNOWN_LOCK_FILES.contains(&basename)
    }

    fn is_ephemeral_path(path: &Path) -> bool {
        path.file_name().and_then(OsStr::to_str).is_some_and(is_ephemeral_file)
            || path.to_str().is_some_and(|value| value.ends_with("-wal") || value.ends_with("-shm") || value.ends_with("-journal"))
    }

    fn is_known_socket_name(basename: &str) -> bool {
        basename == "worker.sock" || basename.ends_with(".sock")
    }

    fn credential_like(path: &Path) -> bool {
        let Some(value) = path.to_str() else { return true; };
        let lower = value.to_ascii_lowercase();
        let basename = path.file_name().and_then(OsStr::to_str).unwrap_or("").to_ascii_lowercase();
        lower.split('/').any(|part| matches!(part, ".ssh" | "credentials" | "secrets" | "private_keys"))
            || matches!(basename.as_str(), ".env" | "credentials.json" | "auth.json" | "auth.jsonl" | "token" | "token.json" | "access_token" | "refresh_token" | "id_rsa" | "id_ed25519")
            || [".env.", ".pem", ".p12", ".pfx", ".key", ".token"].iter().any(|suffix| basename.starts_with(suffix) || basename.ends_with(suffix))
    }

    fn safe_label(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 96
            && value != "."
            && value != ".."
            && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    }

    fn safe_reference_name(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
    }

    fn valid_digest(value: &str) -> bool {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn has_control(value: &str) -> bool {
        value.chars().any(char::is_control)
    }

    fn contains_url_userinfo(value: &str) -> bool {
        let Some((_, rest)) = value.split_once("://") else { return false; };
        let authority = rest.split('/').next().unwrap_or_default();
        authority.contains('@')
    }
}
