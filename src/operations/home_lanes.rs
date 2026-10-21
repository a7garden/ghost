//! Per-Ghost persistent HOME privacy lanes shared by the computer registry
//! (provisioning and admission), the worker HOME mount path, and format-2
//! recovery. Boring filesystem rules only: no daemon, no config engine, no
//! classification input other than the trusted backend route chosen by the
//! sealed worker spec.

use anyhow::{bail, ensure, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// Home lanes live inside a uniquely allocated internal layout root under the
/// registered home volume — never directly at the volume root. A legacy HOME
/// may legitimately contain its own directories named `public` or `private`
/// (build output, notes); lane names alone therefore attest nothing. Only a
/// layout root whose identifier is committed in the registry AND whose sealed
/// provenance marker matches may be admitted or mounted. Every unproven
/// entry at the home volume root — including reserved `public`/`private`
/// names — is a legacy original that only the explicit operator migration
/// may move, and it always moves into the private lane.
pub const LAYOUT_DIR_PREFIX: &str = "ghost-home-layout-";
pub const LAYOUT_MARKER_NAME: &str = "provenance.json";
pub const LAYOUT_MARKER_FORMAT: &str = "ghost-home-layout/1";
pub const HOME_LANE_PUBLIC: &str = "public";
pub const HOME_LANE_PRIVATE: &str = "private";

/// Operator action that legally reclassifies a legacy unclassified home
/// root. Migration moves every original into the private lane; nothing is
/// deleted and nothing is automatically declassified.
pub const MIGRATION_INSTRUCTION: &str =
    "run `ghost computers migrate-home --config <config> --ghost <ghost> --computer <computer> --confirm`";

/// Which single lane a worker mounts, selected solely from the trusted
/// physical backend: subscription-native routes are public-classified and
/// local routes stay private even when they consume public-classified tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomePrivacyLane {
    Public,
    Private,
}

impl HomePrivacyLane {
    pub fn dir_name(self) -> &'static str {
        match self {
            Self::Public => HOME_LANE_PUBLIC,
            Self::Private => HOME_LANE_PRIVATE,
        }
    }
}

/// One registry-committed home layout: the uniquely named internal root with
/// its sealed provenance marker and exactly two lane directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeLayout {
    pub layout_id: String,
    pub layout_root: PathBuf,
    pub public: PathBuf,
    pub private: PathBuf,
}

impl HomeLayout {
    pub fn lane_directory(&self, lane: HomePrivacyLane) -> &Path {
        match lane {
            HomePrivacyLane::Public => &self.public,
            HomePrivacyLane::Private => &self.private,
        }
    }
}

pub fn layout_dir_name(layout_id: &str) -> String {
    format!("{LAYOUT_DIR_PREFIX}{layout_id}")
}

/// Sealed provenance marker bytes for one committed layout.
pub fn layout_marker_bytes(layout_id: &str, computer_id: &str) -> String {
    serde_json::json!({
        "format": LAYOUT_MARKER_FORMAT,
        "layout_id": layout_id,
        "computer_id": computer_id,
    })
    .to_string()
}

/// Lists the home volume root's entry names, sorted. Callers treat every
/// name they did not provision as an unproven legacy original.
#[cfg(unix)]
pub fn root_entry_names(home_volume: &Path) -> Result<Vec<String>> {
    root_entry_names_impl(home_volume)
}

#[cfg(unix)]
fn entry_name(entry: &std::fs::DirEntry) -> Result<String> {
    let name = entry.file_name();
    name.to_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("home volume entry name is not UTF-8"))
}

#[cfg(unix)]
fn root_entry_names_impl(home_volume: &Path) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(home_volume)
        .map_err(|error| anyhow::anyhow!("registered home root is not readable: {error}"))?
    {
        names.push(entry_name(&entry?)?);
    }
    names.sort();
    Ok(names)
}

/// Opens the committed layout for one home volume, trusting the caller's
/// registry-committed `layout_id`. The home root must contain exactly the
/// one layout directory; every other entry — including directories named
/// `public` or `private` — is reported as an unproven legacy original
/// instead of ever being admitted or mounted. The layout's marker, lanes,
/// and identity are validated without following symlinks.
#[cfg(unix)]
pub fn open_committed_layout(
    home_volume: &Path,
    layout_id: &str,
    computer_id: &str,
) -> Result<HomeLayout> {
    let expected = layout_dir_name(layout_id);
    let mut extra = Vec::new();
    for name in root_entry_names(home_volume)? {
        if name != expected {
            extra.push(name);
        }
    }
    if !extra.is_empty() {
        return Err(legacy_home_error(home_volume, &extra));
    }
    let layout_root = home_volume.join(&expected);
    let layout = open_layout_by_marker(&layout_root, layout_id, computer_id)
        .map_err(|error| anyhow::anyhow!("committed home layout '{expected}' rejected: {error}"))?;
    Ok(layout)
}

/// Opens an on-disk layout for restore inspection, not registry adoption.
/// Exactly one `ghost-home-layout-*` child and its matching marker are required;
/// marker consistency alone does not authorize a worker grant or migration.
#[cfg(unix)]
pub fn open_layout_by_marker_at_root(
    home_volume: &Path,
    computer_id: &str,
) -> Result<HomeLayout> {
    let entries = root_entry_names(home_volume)?;
    let mut layouts = Vec::new();
    for name in &entries {
        if name.starts_with(LAYOUT_DIR_PREFIX) {
            layouts.push(name.clone());
        }
    }
    if layouts.len() != entries.len() {
        return Err(legacy_home_error(home_volume, &entries));
    }
    match layouts.len() {
        1 => {
            let name = layouts.pop().context("home layout entry disappeared")?;
            let layout_id = name
                .strip_prefix(LAYOUT_DIR_PREFIX)
                .context("home layout entry lacks its identifier prefix")?
                .to_owned();
            let layout_root = home_volume.join(&name);
            open_layout_by_marker(&layout_root, &layout_id, computer_id)
        }
        0 => Err(legacy_home_error(home_volume, &root_entry_names(home_volume)?)),
        _ => bail!(
            "home volume carries {} competing layout roots {:?}; worker home grants fail closed ({})",
            layouts.len(),
            layouts,
            MIGRATION_INSTRUCTION
        ),
    }
}

/// Validates one layout root's marker and lane structure.
#[cfg(unix)]
pub fn open_layout_by_marker(
    layout_root: &Path,
    layout_id: &str,
    computer_id: &str,
) -> Result<HomeLayout> {
    let direct = fs::symlink_metadata(layout_root)?;
    ensure!(
        !direct.file_type().is_symlink() && direct.is_dir(),
        "home layout root is not a real directory"
    );
    ensure_layout_directory_identity(layout_root, "home layout root")?;

    let mut names = Vec::new();
    for entry in fs::read_dir(layout_root)? {
        names.push(entry_name(&entry?)?);
    }
    names.sort();
    let mut missing = ["public", "private", LAYOUT_MARKER_NAME]
        .iter()
        .filter(|name| !names.contains(&(**name).to_owned()))
        .collect::<Vec<_>>();
    let extra: Vec<String> = names
        .iter()
        .filter(|name| {
            !matches!(name.as_str(), "public" | "private") && name.as_str() != LAYOUT_MARKER_NAME
        })
        .cloned()
        .collect();
    if !missing.is_empty() || !extra.is_empty() {
        missing.sort();
        bail!(
            "home layout contents diverge from its committed shape: missing {:?}, extra {:?}",
            missing,
            extra
        );
    }

    let marker_path = layout_root.join(LAYOUT_MARKER_NAME);
    let marker_metadata = fs::symlink_metadata(&marker_path)?;
    ensure!(
        marker_metadata.is_file() && !marker_metadata.file_type().is_symlink(),
        "home layout provenance marker is not a regular file"
    );
    validate_marker_bytes(
        &fs::read_to_string(&marker_path)
            .context("home layout provenance marker is unreadable")?,
        layout_id,
        computer_id,
    )?;

    let public = validate_lane_directory(&layout_root.join(HOME_LANE_PUBLIC), HOME_LANE_PUBLIC)?;
    let private =
        validate_lane_directory(&layout_root.join(HOME_LANE_PRIVATE), HOME_LANE_PRIVATE)?;
    Ok(HomeLayout {
        layout_id: layout_id.to_owned(),
        layout_root: layout_root.to_path_buf(),
        public,
        private,
    })
}

/// Validates sealed marker bytes against the expected layout identity.
#[cfg(unix)]
pub fn validate_marker_bytes(raw: &str, layout_id: &str, computer_id: &str) -> Result<()> {
    let marker: serde_json::Value =
        serde_json::from_str(raw).context("home layout provenance marker is not valid JSON")?;
    ensure!(
        marker["format"] == serde_json::json!(LAYOUT_MARKER_FORMAT)
            && marker["layout_id"] == serde_json::json!(layout_id)
            && marker["computer_id"] == serde_json::json!(computer_id),
        "home layout provenance marker does not match its committed identity"
    );
    Ok(())
}

/// Writes the sealed provenance marker for a layout root that does not have
/// one yet (fresh provisioning, or an interrupted migration adopting the
/// layout it created moments earlier). Refuses to overwrite.
#[cfg(unix)]
pub fn write_layout_marker(
    layout_root: &Path,
    layout_id: &str,
    computer_id: &str,
) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let marker = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(layout_root.join(LAYOUT_MARKER_NAME))?;
    marker.set_permissions(fs::Permissions::from_mode(0o600))?;
    let mut marker = marker;
    marker.write_all(layout_marker_bytes(layout_id, computer_id).as_bytes())?;
    marker.sync_all()?;
    Ok(())
}

/// Ensures one lane directory exists inside a layout root (fresh creation
/// during migration or validation of an existing lane).
#[cfg(unix)]
pub fn ensure_lane(layout_root: &Path, lane: &str) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    match fs::symlink_metadata(layout_root.join(lane)) {
        Ok(metadata) => {
            ensure!(
                !metadata.file_type().is_symlink() && metadata.is_dir(),
                "home lane '{lane}' is not a real directory"
            );
        }
        Err(_) => {
            fs::create_dir(layout_root.join(lane))?;
            fs::set_permissions(layout_root.join(lane), fs::Permissions::from_mode(0o700))?;
        }
    }
    validate_lane_directory(&layout_root.join(lane), lane)
}

/// Legacy refusal: the home root carries unproven originals (names included,
/// reserved or not) and fails closed until the operator migration moves all
/// of them into the private lane.
#[cfg(unix)]
pub fn legacy_home_error(home_volume: &Path, entries: &[String]) -> anyhow::Error {
    anyhow::anyhow!(
        "registered home root {} is not lane-isolated: {} unproven legacy entries {:?} (including any directories named 'public' or 'private'); \
         worker home grants fail closed until an explicit operator migration moves every original into the private lane ({})",
        home_volume.display(),
        entries.len(),
        entries.iter().take(5).collect::<Vec<_>>(),
        MIGRATION_INSTRUCTION
    )
}

/// Validates one lane directory: real, canonical, owner-UID, 0700.
#[cfg(unix)]
pub fn validate_lane_directory(lane_root: &Path, lane: &str) -> Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let direct = fs::symlink_metadata(lane_root)?;
    ensure!(
        !direct.file_type().is_symlink() && direct.is_dir(),
        "home lane '{lane}' is not a real directory"
    );
    let canonical = lane_root.canonicalize()?;
    ensure!(canonical == lane_root, "home lane '{lane}' is not canonical");
    let metadata = fs::metadata(&canonical)?;
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o777 == 0o700,
        "home lane '{lane}' permissions or identity rejected"
    );
    Ok(canonical)
}

#[cfg(unix)]
fn ensure_layout_directory_identity(layout_root: &Path, label: &str) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(layout_root)?;
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o777 == 0o700,
        "{label} permissions or identity rejected"
    );
    Ok(())
}

/// Creates one fresh layout root with its provenance marker and empty lanes
/// under an existing home volume. Returns the layout. Fails if the target
/// already exists — adoption of an existing layout is a separate, explicitly
/// validated migration path.
#[cfg(unix)]
pub fn create_layout(home_volume: &Path, layout_id: &str, computer_id: &str) -> Result<HomeLayout> {
    use std::os::unix::fs::PermissionsExt;

    let layout_root = home_volume.join(layout_dir_name(layout_id));
    fs::create_dir(&layout_root)?;
    fs::set_permissions(&layout_root, fs::Permissions::from_mode(0o700))?;
    ensure_layout_directory_identity(&layout_root, "home layout root")?;
    write_layout_marker(&layout_root, layout_id, computer_id)?;
    ensure_lane(&layout_root, HOME_LANE_PUBLIC)?;
    ensure_lane(&layout_root, HOME_LANE_PRIVATE)?;
    open_layout_by_marker(&layout_root, layout_id, computer_id)
}
