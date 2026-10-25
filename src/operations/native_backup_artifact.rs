//! Opaque, byte-preserving USTAR packaging of the supported immutable native
//! no-cache backup subset. The native CLI remains the restore/schema authority.
use super::recovery_bundle::{
    open_bound_directory, publish_private_staged, read_private_bound_file, with_private_bound_file,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
const LIMIT: u64 = 536_870_912;
const MANIFEST_LIMIT: u64 = 1_048_576;
const BLOCK: usize = 512;
const NAMES: [&str; 3] = ["brain.db", "documents.toml", "manifest.json"];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeManifest {
    format: String,
    generation: String,
    created_at_utc_ms: i64,
    ledger_schema_version: i64,
    projection_version: i64,
    include_projection: bool,
    include_cache: bool,
    files: Vec<NativeFile>,
    exclusions: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeFile {
    path: String,
    bytes: u64,
    blake3: String,
}
#[derive(Debug, Serialize)]
pub struct ArtifactReceipt {
    pub archive_sha256: String,
    pub bytes: u64,
    pub files: Vec<String>,
}
fn manifest(bytes: &[u8]) -> Result<NativeManifest> {
    let m: NativeManifest = serde_json::from_slice(bytes)?;
    ensure!(
        m.format == "oxibrain-backup/1"
            && (1..=19).contains(&m.ledger_schema_version)
            && m.projection_version == 1,
        "unsupported native backup format/schema"
    );
    ensure!(
        !m.include_cache && !m.include_projection,
        "only native --no-cache --no-projection backups are supported"
    );
    ensure!(
        !m.generation.is_empty() && m.created_at_utc_ms > 0 && m.exclusions.len() <= 64,
        "invalid native backup metadata"
    );
    let mut names = BTreeSet::new();
    let mut bytes = 0u64;
    for f in &m.files {
        ensure!(
            matches!(f.path.as_str(), "brain.db" | "documents.toml")
                && names.insert(f.path.as_str()),
            "unsupported or duplicate native backup entry"
        );
        ensure!(
            f.blake3.len() == 64
                && f.blake3
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid native digest"
        );
        ensure!(f.path != "brain.db" || f.bytes > 0, "empty native database");
        bytes = bytes
            .checked_add(f.bytes)
            .context("native backup size overflow")?;
        ensure!(
            bytes <= LIMIT - MANIFEST_LIMIT - 4096,
            "native backup exceeds immutable artifact bound"
        );
    }
    ensure!(names.contains("brain.db"), "native backup has no brain.db");
    Ok(m)
}
fn normalized(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute()
            && path.components().all(|c| matches!(
                c,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )),
        "artifact path must be normalized absolute"
    );
    Ok(())
}
fn inventory(source: &Path) -> Result<BTreeSet<String>> {
    normalized(source)?;
    let meta = fs::symlink_metadata(source)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink() && meta.mode() & 0o077 == 0,
        "native backup root must be a private real directory"
    );
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(source)? {
        ensure!(
            names.len() < 3,
            "unexpected native backup inventory: fourth entry"
        );
        let name = entry?
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("non-UTF8 backup entry"))?;
        ensure!(
            NAMES.contains(&name.as_str()) && names.insert(name),
            "unexpected native backup inventory"
        );
    }
    ensure!(
        names.len() <= 3
            && names.contains("manifest.json")
            && names.contains("brain.db")
            && names.iter().all(|n| NAMES.contains(&n.as_str())),
        "unexpected native backup inventory"
    );
    Ok(names)
}
fn validate_files(source: &Path) -> Result<BTreeSet<String>> {
    let before = inventory(source)?;
    let m = manifest(&read_private_bound_file(
        &source.join("manifest.json"),
        MANIFEST_LIMIT,
    )?)?;
    let expected = m
        .files
        .iter()
        .map(|f| f.path.clone())
        .chain(["manifest.json".into()])
        .collect::<BTreeSet<_>>();
    ensure!(before == expected, "native manifest and inventory differ");
    for entry in m.files {
        with_private_bound_file(&source.join(&entry.path), LIMIT, |file| {
            let (bytes, _, blake3) = stream(file, None, LIMIT)?;
            ensure!(
                bytes == entry.bytes && blake3 == entry.blake3,
                "native backup entry digest mismatch"
            );
            Ok(())
        })?;
    }
    ensure!(
        inventory(source)? == before,
        "native backup inventory changed"
    );
    Ok(before)
}
fn stream(
    input: &mut impl Read,
    mut output: Option<&mut dyn Write>,
    limit: u64,
) -> Result<(u64, String, String)> {
    let mut buffer = [0u8; 8192];
    let mut total = 0u64;
    let mut sha = Sha256::new();
    let mut b3 = blake3::Hasher::new();
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n as u64)
            .context("artifact length overflow")?;
        ensure!(total <= limit, "artifact exceeds byte bound");
        sha.update(&buffer[..n]);
        b3.update(&buffer[..n]);
        if let Some(out) = output.as_mut() {
            out.write_all(&buffer[..n])?;
        }
    }
    Ok((
        total,
        format!("{:x}", sha.finalize()),
        b3.finalize().to_hex().to_string(),
    ))
}
fn octal(field: &mut [u8], value: u64) -> Result<()> {
    let value = format!("{value:0width$o}", width = field.len() - 1);
    ensure!(value.len() == field.len() - 1, "USTAR numeric overflow");
    field[..value.len()].copy_from_slice(value.as_bytes());
    Ok(())
}
fn header(name: &str, size: u64) -> Result<[u8; BLOCK]> {
    let mut h = [0u8; BLOCK];
    h[..name.len()].copy_from_slice(name.as_bytes());
    octal(&mut h[100..108], 0o600)?;
    octal(&mut h[108..116], 0)?;
    octal(&mut h[116..124], 0)?;
    octal(&mut h[124..136], size)?;
    octal(&mut h[136..148], 0)?;
    h[148..156].fill(b' ');
    h[156] = b'0';
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    let sum = h.iter().map(|v| *v as u64).sum();
    octal(&mut h[148..156], sum)?;
    Ok(h)
}
fn parse_header(h: &[u8; BLOCK]) -> Result<(String, u64)> {
    let end = h[..100]
        .iter()
        .position(|b| *b == 0)
        .context("unbounded USTAR name")?;
    let name = std::str::from_utf8(&h[..end])?.to_owned();
    ensure!(
        NAMES.contains(&name.as_str()),
        "unexpected, nested or escaping archive entry"
    );
    let field = &h[124..136];
    ensure!(
        field[11] == 0 && field[..11].iter().all(|v| (b'0'..=b'7').contains(v)),
        "invalid USTAR size"
    );
    let size = u64::from_str_radix(std::str::from_utf8(&field[..11])?, 8)?;
    ensure!(
        *h == header(&name, size)?,
        "unsupported USTAR header/type/metadata or checksum"
    );
    ensure!(size <= LIMIT, "archive entry too large");
    Ok((name, size))
}
fn output_parent(path: &Path) -> Result<(PathBuf, (u64, u64))> {
    normalized(path)?;
    ensure!(
        fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
        "destination already exists or is inaccessible"
    );
    let parent = path.parent().context("artifact parent missing")?;
    ensure!(
        fs::canonicalize(parent)? == parent,
        "artifact parent must be canonical"
    );
    let m = fs::symlink_metadata(parent)?;
    ensure!(
        m.is_dir() && !m.file_type().is_symlink() && m.mode() & 0o077 == 0,
        "artifact parent must be private"
    );
    Ok((parent.into(), (m.dev(), m.ino())))
}
fn same_parent(parent: &Path, before: (u64, u64)) -> Result<()> {
    let m = fs::symlink_metadata(parent)?;
    ensure!(
        m.is_dir() && (m.dev(), m.ino()) == before && fs::canonicalize(parent)? == parent,
        "artifact parent binding changed"
    );
    Ok(())
}
type FrozenInventory = std::collections::BTreeMap<String, (u64, String)>;
struct Stage {
    path: PathBuf,
    directory: File,
    parent: File,
    leaf: std::ffi::CString,
}
fn file_at(directory: &File, name: &str, write: bool) -> Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name)?;
    let flags = libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | if write {
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL
        } else {
            libc::O_RDONLY | libc::O_NONBLOCK
        };
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags, 0o600) };
    ensure!(
        fd >= 0,
        "private staged file open failed: {}",
        std::io::Error::last_os_error()
    );
    let file = unsafe { File::from_raw_fd(fd) };
    let m = file.metadata()?;
    ensure!(
        m.is_file()
            && m.nlink() == 1
            && m.mode() & 0o077 == 0
            && m.uid() == unsafe { libc::geteuid() },
        "private staged entry type/links/owner refused"
    );
    Ok(file)
}
impl Stage {
    fn new(parent: &Path, binding: (u64, u64)) -> Result<Self> {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            },
        };
        let held_parent = open_bound_directory(parent)?;
        let m = held_parent.metadata()?;
        ensure!(
            (m.dev(), m.ino()) == binding,
            "staging parent identity changed"
        );
        let path = tempfile::tempdir_in(parent)?.keep();
        let leaf = CString::new(path.file_name().unwrap().as_bytes())?;
        let fd = unsafe {
            libc::openat(
                held_parent.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        ensure!(fd >= 0, "staging directory binding changed");
        let directory = unsafe { File::from_raw_fd(fd) };
        directory.set_permissions(fs::Permissions::from_mode(0o700))?;
        same_parent(parent, binding)?;
        let stage = Self {
            path,
            directory,
            parent: held_parent,
            leaf,
        };
        stage.bound()?;
        Ok(stage)
    }
    fn bound(&self) -> Result<()> {
        let current = open_bound_directory(&self.path)?;
        let a = self.directory.metadata()?;
        let b = current.metadata()?;
        ensure!(
            (a.dev(), a.ino()) == (b.dev(), b.ino()),
            "extraction stage inode binding changed"
        );
        Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                self.parent.as_raw_fd(),
                self.leaf.as_ptr(),
                st.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        let Ok(held) = self.directory.metadata() else {
            return;
        };
        if result != 0 {
            return;
        }
        let st = unsafe { st.assume_init() };
        if st.st_dev as u64 != held.dev() || st.st_ino as u64 != held.ino() {
            return;
        }
        for name in NAMES {
            let name = std::ffi::CString::new(name).unwrap();
            unsafe {
                libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0);
            }
        }
        unsafe {
            libc::unlinkat(
                self.parent.as_raw_fd(),
                self.leaf.as_ptr(),
                libc::AT_REMOVEDIR,
            );
        }
    }
}
fn frozen_matches(path: &Path, expected: &FrozenInventory) -> Result<()> {
    ensure!(
        inventory(path)? == expected.keys().cloned().collect(),
        "frozen archive inventory changed"
    );
    for (name, (bytes, digest)) in expected {
        with_private_bound_file(&path.join(name), LIMIT, |file| {
            let actual = stream(file, None, LIMIT)?;
            ensure!(
                actual.0 == *bytes && actual.1 == *digest,
                "extracted bytes differ from trusted archive inventory"
            );
            Ok(())
        })?;
    }
    Ok(())
}
/// Package exact native bytes, never a SQLite snapshot. Output is deterministic
/// USTAR with no extensions, links, directories or metadata restoration.
pub fn pack(source: &Path, destination: &Path) -> Result<ArtifactReceipt> {
    let names = validate_files(source)?;
    let manifest_before = read_private_bound_file(&source.join("manifest.json"), MANIFEST_LIMIT)?;
    let (parent, binding) = output_parent(destination)?;
    ensure!(
        !destination.starts_with(source),
        "archive must be outside its source root"
    );
    let mut output = tempfile::NamedTempFile::new_in(&parent)?;
    fs::set_permissions(output.path(), fs::Permissions::from_mode(0o600))?;
    let held = output.as_file().metadata()?;
    with_private_bound_file(output.path(), 0, |file| {
        let current = file.metadata()?;
        ensure!(
            (current.dev(), current.ino()) == (held.dev(), held.ino()),
            "new staged archive inode changed"
        );
        Ok(())
    })?;
    same_parent(&parent, binding)?;
    for name in &names {
        with_private_bound_file(&source.join(name), LIMIT, |input| {
            let size = input.metadata()?.len();
            output.write_all(&header(name, size)?)?;
            let (bytes, _, _) = stream(input, Some(&mut output), LIMIT)?;
            ensure!(bytes == size, "native file size changed");
            output.write_all(&vec![0; (BLOCK - (size as usize % BLOCK)) % BLOCK])?;
            Ok(())
        })?;
    }
    output.write_all(&[0; BLOCK * 2])?;
    output.as_file().sync_all()?;
    validate_files(source)?;
    ensure!(
        read_private_bound_file(&source.join("manifest.json"), MANIFEST_LIMIT)? == manifest_before,
        "native manifest changed during packaging"
    );
    same_parent(&parent, binding)?;
    // Independently parse and verify the archive's native manifest before publish.
    let scratch = Stage::new(&parent, binding)?;
    let mut f = output.reopen()?;
    let proof = extract(&mut f, &scratch)?;
    ensure!(
        proof.keys().cloned().collect::<BTreeSet<_>>() == names,
        "archive inventory differs"
    );
    output.as_file_mut().seek(SeekFrom::Start(0))?;
    let (bytes, archive_sha256, _) = stream(output.as_file_mut(), None, LIMIT)?;
    same_parent(&parent, binding)?;
    publish_private_staged(output.path(), destination, output.as_file(), binding)?;
    let published = with_private_bound_file(destination, LIMIT, |file| stream(file, None, LIMIT))?;
    ensure!(
        published.0 == bytes && published.1 == archive_sha256,
        "published archive bytes changed"
    );
    same_parent(&parent, binding)?;
    Ok(ArtifactReceipt {
        archive_sha256,
        bytes,
        files: names.into_iter().collect(),
    })
}
fn extract(input: &mut File, stage: &Stage) -> Result<FrozenInventory> {
    let mut names = BTreeSet::new();
    let mut proof = FrozenInventory::new();
    let mut total = 0u64;
    loop {
        let mut h = [0u8; BLOCK];
        input.read_exact(&mut h)?;
        if h == [0; BLOCK] {
            let mut last = [0u8; BLOCK];
            input.read_exact(&mut last)?;
            ensure!(last == [0; BLOCK], "archive end marker malformed");
            let mut tail = [0u8; 1];
            ensure!(input.read(&mut tail)? == 0, "trailing archive data refused");
            break;
        }
        let (name, size) = parse_header(&h)?;
        ensure!(
            name != "manifest.json" || size <= MANIFEST_LIMIT,
            "native manifest too large"
        );
        ensure!(
            names.len() < 3 && names.insert(name.clone()),
            "duplicate or excessive archive entry"
        );
        total = total.checked_add(size).context("archive size overflow")?;
        ensure!(total <= LIMIT - MANIFEST_LIMIT, "archive payload too large");
        let mut output = file_at(&stage.directory, &name, true)?;
        let (copied, sha, _) = stream(&mut (&mut *input).take(size), Some(&mut output), size)?;
        ensure!(copied == size, "truncated archive entry");
        proof.insert(name, (copied, sha));
        output.sync_all()?;
        let mut padding = vec![0; (BLOCK - (size as usize % BLOCK)) % BLOCK];
        input.read_exact(&mut padding)?;
        ensure!(padding.iter().all(|b| *b == 0), "nonzero archive padding");
    }
    ensure!(
        validate_files(&stage.path)? == names,
        "archive/native inventory mismatch"
    );
    stage.bound()?;
    frozen_matches(&stage.path, &proof)?;
    Ok(proof)
}
/// Restore only into an absent private root, using the archive SHA256 returned
/// by pack or the independently verified recovery-bundle inventory.
pub fn unpack(
    archive: &Path,
    expected_sha256: &str,
    destination: &Path,
) -> Result<ArtifactReceipt> {
    unpack_inner(archive, expected_sha256, destination, |_| Ok(()))
}
fn unpack_inner(
    archive: &Path,
    expected_sha256: &str,
    destination: &Path,
    before_publish: impl FnOnce(&Stage) -> Result<()>,
) -> Result<ArtifactReceipt> {
    ensure!(
        expected_sha256.len() == 64
            && expected_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid trusted archive digest"
    );
    let (parent, binding) = output_parent(destination)?;
    let stage = Stage::new(&parent, binding)?;
    let (receipt, proof) = with_private_bound_file(archive, LIMIT, |file| {
        let (bytes, digest, _) = stream(file, None, LIMIT)?;
        ensure!(digest == expected_sha256, "archive digest mismatch");
        file.seek(SeekFrom::Start(0))?;
        let proof = extract(file, &stage)?;
        file.seek(SeekFrom::Start(0))?;
        ensure!(
            stream(file, None, LIMIT)?.1 == expected_sha256,
            "archive changed during extraction"
        );
        Ok((
            ArtifactReceipt {
                archive_sha256: digest,
                bytes,
                files: proof.keys().cloned().collect(),
            },
            proof,
        ))
    })?;
    before_publish(&stage)?;
    same_parent(&parent, binding)?;
    ensure!(
        fs::symlink_metadata(destination).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
        "extraction destination appeared"
    );
    stage.bound()?;
    frozen_matches(&stage.path, &proof)?;
    publish_private_staged(&stage.path, destination, &stage.directory, binding)?;
    frozen_matches(destination, &proof)?;
    validate_files(destination)?;
    same_parent(&parent, binding)?;
    File::open(destination)?.sync_all()?;
    File::open(parent)?.sync_all()?;
    Ok(receipt)
}
#[cfg(test)]
#[path = "native_backup_artifact_tests.rs"]
mod tests;
