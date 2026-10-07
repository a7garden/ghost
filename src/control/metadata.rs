use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const FILE_NAME: &str = ".ghost-control.json";
pub(super) const PROTOCOL: &str = "ghost-control";
pub(super) const VERSION: u32 = 1;
const MAX_METADATA_BYTES: u64 = 8 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Discovery {
    pub protocol: String,
    pub protocol_version: u32,
    pub host: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub started_ms: u64,
}

impl Discovery {
    pub fn endpoint(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub fn validate(&self) -> Result<()> {
        if self.protocol != PROTOCOL
            || self.protocol_version != VERSION
            || self.host != "127.0.0.1"
            || self.port == 0
            || self.pid == 0
            || self.token.len() != 64
            || !self.token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            bail!("invalid Ghost control discovery metadata");
        }
        Ok(())
    }
}

pub(super) fn canonical_root(root: &Path, create: bool) -> Result<PathBuf> {
    if root.is_symlink() {
        bail!("Ghost root must not be a symlink");
    }
    if create {
        fs::create_dir_all(root)?;
    }
    if !root.is_dir() {
        bail!("Ghost root does not exist or is not a directory");
    }
    Ok(root.canonicalize()?)
}

pub(super) fn write(root: &Path, port: u16, token: String, started_ms: u64) -> Result<Discovery> {
    cleanup_temps(root)?;
    let path = root.join(FILE_NAME);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("Ghost control discovery path must be a regular file");
        }
    }

    let discovery = Discovery {
        protocol: PROTOCOL.into(),
        protocol_version: VERSION,
        host: "127.0.0.1".into(),
        port,
        token,
        pid: std::process::id(),
        started_ms,
    };
    discovery.validate()?;
    let bytes = serde_json::to_vec(&discovery)?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        bail!("control metadata size limit");
    }

    let temp = root.join(format!(
        ".ghost-control.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&temp, &path)?;
        File::open(root)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    Ok(discovery)
}

fn cleanup_temps(root: &Path) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(id) = name
            .strip_prefix(".ghost-control.")
            .and_then(|name| name.strip_suffix(".tmp"))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_file() || metadata.file_type().is_symlink() {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

pub(super) fn read(root: &Path) -> Result<Discovery> {
    let path = root.join(FILE_NAME);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| anyhow!("no local Ghost host discovery file in this root"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_METADATA_BYTES
    {
        bail!("Ghost control discovery file is unsafe or too large");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            bail!("Ghost control discovery file permissions are not private");
        }
    }
    let file = File::open(&path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_METADATA_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        bail!("Ghost control discovery file is too large");
    }
    let discovery: Discovery = serde_json::from_slice(&bytes)?;
    discovery.validate()?;
    Ok(discovery)
}

pub(super) fn remove_if_owned(root: &Path, token: &str) {
    let path = root.join(FILE_NAME);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return;
    }
    let Ok(current) = read(root) else {
        return;
    };
    if current.token == token {
        let _ = fs::remove_file(path);
        let _ = File::open(root).and_then(|directory| directory.sync_all());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn discovery_requires_private_file_and_current_owner_for_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let token = "a".repeat(64);
        write(dir.path(), 12345, token.clone(), 1).unwrap();
        let path = dir.path().join(FILE_NAME);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(read(dir.path()).is_ok());
        remove_if_owned(dir.path(), &"b".repeat(64));
        assert!(
            path.exists(),
            "an older server must not remove a new server's endpoint"
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read(dir.path()).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        remove_if_owned(dir.path(), &token);
        assert!(!path.exists());
    }

    #[test]
    fn discovery_rejects_symlinks_without_overwriting_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("owner-file");
        fs::write(&target, "preserve me").unwrap();
        symlink(&target, dir.path().join(FILE_NAME)).unwrap();
        assert!(read(dir.path()).is_err());
        assert!(write(dir.path(), 12345, "a".repeat(64), 1).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "preserve me");
    }
}
