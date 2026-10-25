//! Explicit Owner-selected historical Pi artifact reads after distinct-root
//! restore. No execution, receipt, identity or stored locator is rewritten.
use anyhow::{ensure, Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PiArtifactRelocation {
    pub version: String,
    pub workspace_id: String,
    pub authority_epoch: u64,
    pub bundle_manifest_sha256: String,
    pub bundle_path: PathBuf,
    pub host_root_label: String,
    /// Explicit Owner declaration: bundles deliberately omit original roots.
    pub source_pi_root: PathBuf,
    pub destination_pi_root: PathBuf,
}
fn normalized(path: &Path) -> bool {
    path.is_absolute()
        && path.parent().is_some_and(|p| p != Path::new("/"))
        && path
            .components()
            .skip(1)
            .all(|c| matches!(c, Component::Normal(_)))
}
fn private_directory(path: &Path) -> Result<()> {
    ensure!(
        normalized(path) && path.canonicalize()? == path,
        "Pi relocation directory is not canonical"
    );
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_dir()
            && !m.file_type().is_symlink()
            && m.uid() == unsafe { libc::geteuid() }
            && m.mode() & 0o077 == 0,
        "Pi relocation directory is not private and owned"
    );
    Ok(())
}
fn read_private(path: &Path, limit: u64) -> Result<Vec<u8>> {
    super::recovery_bundle::read_private_bound_file(path, limit)
}

impl PiArtifactRelocation {
    pub fn read(path: &Path) -> Result<Self> {
        let value: Self = serde_json::from_slice(&read_private(path, 65536)?)?;
        ensure!(
            value.version == "ghost-pi-artifact-relocation/1" && value.authority_epoch > 1,
            "Pi relocation version/restore epoch invalid"
        );
        ensure!(
            !uuid::Uuid::parse_str(&value.workspace_id)?.is_nil(),
            "Pi relocation workspace invalid"
        );
        ensure!(
            value.bundle_manifest_sha256.len() == 64
                && value
                    .bundle_manifest_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Pi relocation manifest digest invalid"
        );
        ensure!(
            !value.host_root_label.is_empty()
                && value.host_root_label.len() <= 128
                && value
                    .host_root_label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "Pi relocation root label invalid"
        );
        ensure!(
            normalized(&value.source_pi_root)
                && value.source_pi_root != value.destination_pi_root
                && value.source_pi_root.file_name().and_then(|s| s.to_str())
                    == Some("pi-execution"),
            "Pi relocation source must name the original Pi store"
        );
        private_directory(&value.destination_pi_root)?;
        private_directory(&value.bundle_path)?;
        Ok(value)
    }
    fn resolve(
        &self,
        current_pi_root: &Path,
        authority: &Connection,
        locator: &Path,
        expected_digest: &str,
    ) -> Result<PathBuf> {
        ensure!(
            current_pi_root == self.destination_pi_root
                && current_pi_root.file_name().and_then(|v| v.to_str()) == Some("pi-execution"),
            "Pi relocation destination differs from current Host store"
        );
        let host = current_pi_root
            .parent()
            .context("Pi relocation Host root missing")?;
        private_directory(host)?;
        let epoch: u64 = authority.query_row(
            "SELECT authority_epoch FROM lifetime_authority WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        let raw: String = authority.query_row(
            "SELECT payload FROM workspace_objects WHERE kind='meta' AND id='workspace_id'",
            [],
            |r| r.get(0),
        )?;
        let workspace: String = serde_json::from_str(&raw)?;
        ensure!(
            epoch == self.authority_epoch && workspace == self.workspace_id,
            "Pi relocation workspace/epoch is not current"
        );
        let relative = locator
            .strip_prefix(&self.source_pi_root)
            .context("Historical Pi locator differs from Owner-declared original root")?;
        let parts: Vec<_> = relative.components().collect();
        ensure!(
            parts.len() == 3
                && parts.iter().all(|v| matches!(v, Component::Normal(_)))
                && parts[0].as_os_str() == "artifacts"
                && parts[1].as_os_str().to_str().is_some_and(|s| s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
                && parts[2].as_os_str() == format!("{expected_digest}.json").as_str(),
            "Historical Pi locator is outside an immutable artifact"
        );
        let bytes = read_private(&self.bundle_path.join("manifest.json"), 1_048_576)?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == self.bundle_manifest_sha256,
            "Pi relocation bundle manifest changed"
        );
        let manifest: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            manifest["format"] == "ghost-recovery-bundle/2"
                && manifest["complete"] == true
                && manifest["host_label"] == self.host_root_label,
            "Pi relocation requires a completed captured Host root"
        );
        let roots = manifest["roots"]
            .as_array()
            .context("Pi relocation bundle roots missing")?;
        ensure!(
            roots
                .iter()
                .filter(|r| r["label"] == self.host_root_label && r["role"] == "host")
                .count()
                == 1,
            "Pi relocation Host inventory root is ambiguous"
        );
        let entry_path = Path::new("pi-execution")
            .join(relative)
            .to_str()
            .context("Pi relocation inventory path is not UTF-8")?
            .replace('\\', "/");
        let entries = manifest["entries"]
            .as_array()
            .context("Pi relocation bundle entries missing")?;
        let matches: Vec<_> = entries
            .iter()
            .filter(|entry| {
                entry["root_label"] == self.host_root_label && entry["path"] == entry_path
            })
            .collect();
        ensure!(
            matches.len() == 1
                && matches[0]["kind"] == "file"
                && matches[0]["sha256"] == expected_digest,
            "Pi relocation artifact is not in pinned captured inventory"
        );
        let captured = self
            .bundle_path
            .join("roots")
            .join(&self.host_root_label)
            .join(&entry_path);
        ensure!(
            captured.canonicalize()? == captured,
            "Captured Pi artifact path changed"
        );
        let captured_bytes = read_private(&captured, 1_048_576)?;
        ensure!(
            format!("{:x}", Sha256::digest(&captured_bytes)) == expected_digest
                && matches[0]["byte_count"].as_u64() == Some(captured_bytes.len() as u64),
            "Captured Pi artifact differs from its inventory"
        );
        ensure!(
            read_private(&self.bundle_path.join("manifest.json"), 1_048_576)? == bytes,
            "Pi relocation manifest changed before artifact resolution"
        );
        Ok(current_pi_root.join(relative))
    }
}
pub(crate) fn configured_artifact_locator(
    current_pi_root: &Path,
    authority: &Connection,
    locator: &Path,
    expected_digest: &str,
) -> Result<Option<PathBuf>> {
    if locator.starts_with(current_pi_root) {
        return Ok(None);
    }
    std::env::var_os("GHOST_PI_ARTIFACT_RELOCATION_FILE")
        .map(|path| {
            PiArtifactRelocation::read(Path::new(&path))?.resolve(
                current_pi_root,
                authority,
                locator,
                expected_digest,
            )
        })
        .transpose()
}
