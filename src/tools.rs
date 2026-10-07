//! Host-enforced filesystem tools. All capabilities are disabled by default;
//! a read/write occurs only inside a canonical user-granted directory, with
//! symlink components below the granted directory denied, root/sibling escapes
//! rejected lexically, and writes refusing to overwrite existing paths.
//!
//! MVP security posture: paths below the granted directory are checked with
//! symlink_metadata immediately before open, and writes use atomic create_new,
//! but we do NOT claim protection against hostile concurrent directory
//! mutation (TOCTOU above the final component). This is a local single-user
//! skeleton, not a production sandbox. A hardened build should move to
//! handle-relative opens (e.g. cap-std) with symlink denial.

use anyhow::{bail, Context, Result};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

pub const MAX_READ_BYTES: u64 = 1024 * 1024;

/// Normalize Mac standard temp path aliases: /var -> /private/var and
/// /tmp -> /private/tmp. Preserves directory boundary - does not permit
/// symlink children below grant.
fn normalize_mac_aliases(p: PathBuf) -> PathBuf {
    #[cfg(all(unix, target_os = "macos"))]
    {
        // Component-aware prefix mapping, only at the filesystem root:
        // /var -> /private/var and /tmp -> /private/tmp. Prefixes like
        // /variant or /tmpSibling are NOT aliased.
        let var = Path::new("/var");
        let tmp = Path::new("/tmp");
        if p.starts_with(var) {
            return Path::new("/private/var").join(p.strip_prefix(var).expect("checked"));
        }
        if p.starts_with(tmp) {
            return Path::new("/private/tmp").join(p.strip_prefix(tmp).expect("checked"));
        }
        p
    }
    #[cfg(not(all(unix, target_os = "macos")))]
    {
        p
    }
}

/// Lexically absolute path (resolves `.`/`..` without touching the filesystem).
pub fn lexical_abs(p: &Path) -> Result<PathBuf> {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()?.join(p)
    };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    bail!("path escapes the filesystem root");
                }
            }
            Component::Normal(n) => out.push(n),
        }
    }
    // Normalize Mac temp aliases.
    let out = normalize_mac_aliases(out);
    Ok(out)
}

fn comps(p: &Path) -> Vec<OsString> {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_os_string()),
            _ => None,
        })
        .collect()
}

/// Resolve `requested` strictly inside the canonical `allowed` directory.
/// Rejects root/sibling/prefix escapes and any symlink component below
/// `allowed`. For writes the final path must not exist (no overwrites).
///
/// Security note: TOCTOU caveat applies above the final component - a
/// concurrent mutation above the grant could change what canonical parent
/// is resolved. This MVP assumes no hostile concurrent directory mutation.
pub fn resolve(allowed: &Path, requested: &Path, write: bool) -> Result<PathBuf> {
    let allowed_c = allowed
        .canonicalize()
        .with_context(|| format!("allowed directory unavailable: {}", allowed.display()))?;
    let abs = lexical_abs(requested)?;
    let ac = comps(&allowed_c);
    let tc = comps(&abs);
    if tc.len() <= ac.len() || tc[..ac.len()] != ac[..] {
        bail!(
            "target {} escapes the allowed directory {}",
            abs.display(),
            allowed_c.display()
        );
    }
    let mut cur = allowed_c.clone();
    let below = &tc[ac.len()..];
    for (i, c) in below.iter().enumerate() {
        cur.push(c);
        let last = i == below.len() - 1;
        match fs::symlink_metadata(&cur) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    bail!("symlink in path denied: {}", cur.display());
                }
                if last {
                    if md.is_dir() {
                        bail!("target is a directory: {}", cur.display());
                    }
                    if write {
                        bail!("refusing to overwrite existing path: {}", cur.display());
                    }
                } else if !md.is_dir() {
                    bail!("component is not a directory: {}", cur.display());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !last {
                    bail!("missing directory component: {}", cur.display());
                }
                if !write {
                    bail!("read target does not exist: {}", cur.display());
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(cur)
}

/// Read a file with enforced byte limit. Uses streaming read (take) to enforce
/// limit while reading, rejecting non-regular special files to avoid blocking
/// on pipes/devices.
pub fn read_bounded(path: &Path) -> Result<String> {
    // Check regular-file status BEFORE opening: opening a FIFO or device
    // would block in File::open. symlink_metadata does not follow the final
    // symlink; the post-open metadata check below covers that.
    // Caveat: a concurrent mutation between these checks and the read is
    // still possible (TOCTOU); this is not a production sandbox.
    if let Ok(md) = fs::symlink_metadata(path) {
        if !md.is_file() {
            bail!("target is not a regular file: {}", path.display());
        }
    }
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let md = file.metadata()?;

    // Reject non-regular special files to avoid blocking on pipes/devices.
    if !md.is_file() {
        bail!("target is not a regular file: {}", path.display());
    }

    // Use streaming read with take to enforce limit while reading.
    // This is not racy like metadata-only size check.
    let mut reader = BufReader::new(file).take(MAX_READ_BYTES + 1);
    let mut s = String::new();
    let read = reader.read_to_string(&mut s)?;
    if read as u64 > MAX_READ_BYTES {
        bail!(
            "file {} read {} bytes, over the {} byte limit",
            path.display(),
            read,
            MAX_READ_BYTES
        );
    }
    Ok(s)
}

/// Atomic create-new write with sync_all so failure is reported before
/// completion. Refuses to touch existing files.
pub fn write_new(path: &Path, content: &str) -> Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    f.write_all(content.as_bytes())?;
    // sync_all ensures data is on disk before we report success.
    f.sync_all()?;
    Ok(())
}
