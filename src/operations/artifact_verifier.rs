use crate::lifetime_contract::Artifact;
use anyhow::ensure;
use sha2::{Digest, Sha256};
use std::path::Path;

const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;

/// Independently verifies the immutable worker artifact's locator, execution,
/// raw bytes, and SHA-256 digest without allocating the artifact contents.
pub fn verify_artifact(
    worker_root: &Path,
    artifact: &Artifact,
    expected_execution: &str,
    expected_contents: &[u8],
) -> anyhow::Result<()> {
    ensure!(
        expected_contents.len() <= MAX_ARTIFACT_BYTES,
        "expected artifact contents exceed the 1 MiB verification limit"
    );

    #[cfg(unix)]
    {
        let opened = unix::open_artifact(worker_root, artifact, expected_execution)?;
        unix::verify_opened_artifact(opened, &artifact.digest, expected_contents)
    }

    #[cfg(not(unix))]
    {
        let _ = (worker_root, artifact, expected_execution, expected_contents);
        Err(anyhow::anyhow!(
            "immutable artifact verification requires Unix no-follow file operations"
        ))
    }
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(unix)]
mod unix {
    use super::{sha256_hex, valid_digest, Artifact, MAX_ARTIFACT_BYTES};
    use anyhow::{ensure, Context};
    use sha2::{Digest, Sha256};
    use std::ffi::CString;
    use std::fs::{self, File, Metadata};
    use std::io::Read;
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};

    const DIRECTORY_FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK;
    const FILE_FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
    const READ_BUFFER_BYTES: usize = 8192;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct FileSnapshot {
        device: u64,
        inode: u64,
        length: u64,
        links: u64,
        mode: u32,
        modified_seconds: i64,
        modified_nanoseconds: i64,
        changed_seconds: i64,
        changed_nanoseconds: i64,
    }

    impl FileSnapshot {
        fn from_metadata(metadata: &Metadata) -> Self {
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                length: metadata.len(),
                links: metadata.nlink(),
                mode: metadata.mode(),
                modified_seconds: metadata.mtime(),
                modified_nanoseconds: metadata.mtime_nsec(),
                changed_seconds: metadata.ctime(),
                changed_nanoseconds: metadata.ctime_nsec(),
            }
        }
    }

    pub(super) struct OpenedArtifact {
        root_path: PathBuf,
        root: File,
        artifacts_name: CString,
        artifacts: File,
        execution_name: CString,
        execution_directory: File,
        artifact_name: CString,
        file: File,
        initial_file: FileSnapshot,
    }

    pub(super) fn open_artifact(
        worker_root: &Path,
        artifact: &Artifact,
        expected_execution: &str,
    ) -> anyhow::Result<OpenedArtifact> {
        ensure!(
            artifact.producing_attempt == expected_execution,
            "artifact producing attempt does not match the expected execution"
        );
        ensure!(valid_digest(&artifact.digest), "artifact digest is malformed");

        let execution_key = sha256_hex(expected_execution.as_bytes());
        let artifact_name_text = format!("{}.json", artifact.digest);
        let expected_path = worker_root
            .join("artifacts")
            .join(&execution_key)
            .join(&artifact_name_text);
        let expected_locator = expected_path.to_str().context("artifact path is not UTF-8")?;
        ensure!(
            artifact.locator == expected_locator,
            "artifact locator does not identify the expected immutable worker file"
        );

        let root_path = root_entry_path(worker_root);
        let root_metadata = fs::symlink_metadata(&root_path)
            .context("could not inspect worker root without following its final symlink")?;
        ensure!(
            root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
            "worker root is not a real directory"
        );
        let root_name = cstring(root_path.as_os_str().as_bytes(), "worker root path")?;
        let root = open_at(libc::AT_FDCWD, &root_name, DIRECTORY_FLAGS)
            .context("could not open worker root without following its final symlink")?;
        let opened_root_metadata = root.metadata()?;
        ensure!(
            same_identity(&root_metadata, &opened_root_metadata),
            "worker root changed while being opened"
        );

        let artifacts_name = CString::new("artifacts").expect("static path has no NUL byte");
        let artifacts = open_child_directory(&root, &artifacts_name, "artifacts directory")?;
        let execution_name = cstring(execution_key.as_bytes(), "execution directory")?;
        let execution_directory = open_child_directory(
            &artifacts,
            &execution_name,
            "execution artifact directory",
        )?;
        let artifact_name = cstring(artifact_name_text.as_bytes(), "artifact file")?;
        let path_metadata = stat_at(execution_directory.as_raw_fd(), &artifact_name)
            .context("could not inspect immutable artifact file")?;
        ensure!(
            is_regular_file(&path_metadata),
            "immutable artifact is not a regular file"
        );
        ensure!(
            path_metadata.st_nlink == 1,
            "immutable artifact has more than one hard link"
        );
        ensure!(
            file_length(&path_metadata)? <= MAX_ARTIFACT_BYTES as u64,
            "immutable artifact exceeds the 1 MiB verification limit"
        );

        let file = open_at(
            execution_directory.as_raw_fd(),
            &artifact_name,
            FILE_FLAGS,
        )
        .context("could not open immutable artifact without following its final symlink")?;
        let opened_file_metadata = file.metadata()?;
        ensure!(
            opened_file_metadata.is_file()
                && opened_file_metadata.nlink() == 1
                && opened_file_metadata.len() <= MAX_ARTIFACT_BYTES as u64
                && stat_matches_metadata(&path_metadata, &opened_file_metadata),
            "immutable artifact changed or is unsafe while being opened"
        );
        let initial_file = FileSnapshot::from_metadata(&opened_file_metadata);

        Ok(OpenedArtifact {
            root_path,
            root,
            artifacts_name,
            artifacts,
            execution_name,
            execution_directory,
            artifact_name,
            file,
            initial_file,
        })
    }

    pub(super) fn verify_opened_artifact(
        mut opened: OpenedArtifact,
        expected_digest: &str,
        expected_contents: &[u8],
    ) -> anyhow::Result<()> {
        ensure!(
            expected_contents.len() <= MAX_ARTIFACT_BYTES,
            "expected artifact contents exceed the 1 MiB verification limit"
        );

        let mut hash = Sha256::new();
        let mut buffer = [0_u8; READ_BUFFER_BYTES];
        let mut total = 0_usize;
        let mut contents_match = true;
        loop {
            let count = opened.file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            let next_total = total
                .checked_add(count)
                .context("artifact byte count overflowed")?;
            ensure!(
                next_total <= MAX_ARTIFACT_BYTES,
                "immutable artifact exceeds the 1 MiB verification limit"
            );
            hash.update(&buffer[..count]);
            match expected_contents.get(total..next_total) {
                Some(expected) if expected == &buffer[..count] => {}
                _ => contents_match = false,
            }
            total = next_total;
        }

        let after_read = FileSnapshot::from_metadata(&opened.file.metadata()?);
        ensure!(
            after_read == opened.initial_file && after_read.links == 1,
            "immutable artifact changed during verification"
        );
        let final_path_metadata = stat_at(
            opened.execution_directory.as_raw_fd(),
            &opened.artifact_name,
        )?;
        ensure!(
            is_regular_file(&final_path_metadata)
                && final_path_metadata.st_nlink == 1
                && stat_matches_snapshot(&final_path_metadata, after_read),
            "immutable artifact was replaced during verification"
        );
        verify_directory_binding(
            opened.root.as_raw_fd(),
            &opened.artifacts_name,
            &opened.artifacts,
            "artifacts directory",
        )?;
        verify_directory_binding(
            opened.artifacts.as_raw_fd(),
            &opened.execution_name,
            &opened.execution_directory,
            "execution artifact directory",
        )?;
        verify_root_binding(&opened.root_path, &opened.root)?;

        let actual_digest = format!("{:x}", hash.finalize());
        ensure!(
            contents_match && total == expected_contents.len(),
            "immutable artifact bytes do not match the expected contents"
        );
        ensure!(
            actual_digest == expected_digest,
            "immutable artifact SHA-256 does not match its locator digest"
        );
        Ok(())
    }

    fn root_entry_path(worker_root: &Path) -> PathBuf {
        match worker_root.file_name() {
            Some(name) => worker_root
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .join(name),
            None => worker_root.to_path_buf(),
        }
    }

    fn cstring(bytes: &[u8], label: &str) -> anyhow::Result<CString> {
        CString::new(bytes).with_context(|| format!("{label} contains a NUL byte"))
    }

    fn open_at(directory: RawFd, name: &CString, flags: libc::c_int) -> anyhow::Result<File> {
        let descriptor = unsafe { libc::openat(directory, name.as_ptr(), flags, 0) };
        ensure!(
            descriptor >= 0,
            "could not open path component: {}",
            std::io::Error::last_os_error()
        );
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn stat_at(directory: RawFd, name: &CString) -> anyhow::Result<libc::stat> {
        let mut metadata = MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                directory,
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        ensure!(
            result == 0,
            "could not inspect path component: {}",
            std::io::Error::last_os_error()
        );
        Ok(unsafe { metadata.assume_init() })
    }

    fn open_child_directory(
        parent: &File,
        name: &CString,
        label: &str,
    ) -> anyhow::Result<File> {
        let before = stat_at(parent.as_raw_fd(), name)
            .with_context(|| format!("could not inspect {label}"))?;
        ensure!(is_directory(&before), "{label} is not a real directory");
        let directory = open_at(parent.as_raw_fd(), name, DIRECTORY_FLAGS)
            .with_context(|| format!("could not open {label} without following symlinks"))?;
        ensure!(
            stat_matches_directory(&before, &directory.metadata()?),
            "{label} changed while being opened"
        );
        Ok(directory)
    }

    fn verify_directory_binding(
        parent: RawFd,
        name: &CString,
        directory: &File,
        label: &str,
    ) -> anyhow::Result<()> {
        let current = stat_at(parent, name)
            .with_context(|| format!("could not recheck {label} after verification"))?;
        ensure!(
            is_directory(&current)
                && stat_matches_directory(&current, &directory.metadata()?),
            "{label} was replaced during verification"
        );
        Ok(())
    }

    fn verify_root_binding(root_path: &Path, root: &File) -> anyhow::Result<()> {
        let current = fs::symlink_metadata(root_path)
            .context("could not recheck worker root after verification")?;
        ensure!(
            current.is_dir()
                && !current.file_type().is_symlink()
                && same_identity(&current, &root.metadata()?),
            "worker root was replaced during verification"
        );
        Ok(())
    }

    fn file_length(metadata: &libc::stat) -> anyhow::Result<u64> {
        u64::try_from(metadata.st_size).context("artifact has a negative file length")
    }

    fn is_directory(metadata: &libc::stat) -> bool {
        metadata.st_mode & libc::S_IFMT == libc::S_IFDIR
    }

    fn stat_matches_directory(stat: &libc::stat, metadata: &Metadata) -> bool {
        is_directory(stat)
            && metadata.is_dir()
            && stat.st_dev as u64 == metadata.dev()
            && stat.st_ino as u64 == metadata.ino()
    }

    fn is_regular_file(metadata: &libc::stat) -> bool {
        metadata.st_mode & libc::S_IFMT == libc::S_IFREG
    }

    fn stat_matches_metadata(stat: &libc::stat, metadata: &Metadata) -> bool {
        u64::try_from(stat.st_size).ok() == Some(metadata.len())
            && stat.st_dev as u64 == metadata.dev()
            && stat.st_ino as u64 == metadata.ino()
            && stat.st_nlink as u64 == metadata.nlink()
            && stat.st_mode as u32 == metadata.mode()
    }

    fn stat_matches_snapshot(stat: &libc::stat, snapshot: FileSnapshot) -> bool {
        u64::try_from(stat.st_size).ok() == Some(snapshot.length)
            && stat.st_dev as u64 == snapshot.device
            && stat.st_ino as u64 == snapshot.inode
            && stat.st_nlink as u64 == snapshot.links
            && stat.st_mode as u32 == snapshot.mode
    }

    fn same_identity(left: &Metadata, right: &Metadata) -> bool {
        left.is_dir()
            && right.is_dir()
            && left.dev() == right.dev()
            && left.ino() == right.ino()
    }

    #[cfg(test)]
    pub(super) fn test_path_for(root: &Path, execution: &str, digest: &str) -> PathBuf {
        root.join("artifacts")
            .join(sha256_hex(execution.as_bytes()))
            .join(format!("{digest}.json"))
    }
}

#[cfg(all(test, unix))]
mod replacement_tests {
    use super::{sha256_hex, unix};
    use crate::lifetime_contract::Artifact;
    use std::fs;

    #[test]
    fn rejects_same_bytes_replaced_after_open_and_before_verification() {
        let temporary = tempfile::tempdir().unwrap();
        let execution = "replacement-boundary-attempt";
        let contents = b"identical bytes do not make a replaced inode trustworthy";
        let digest = sha256_hex(contents);
        let path = unix::test_path_for(temporary.path(), execution, &digest);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        let artifact = Artifact {
            digest: digest.clone(),
            locator: path.to_string_lossy().into_owned(),
            privacy: "local_only".to_owned(),
            producing_attempt: execution.to_owned(),
        };

        let opened = unix::open_artifact(temporary.path(), &artifact, execution).unwrap();
        let replacement = path.with_extension("replacement");
        fs::write(&replacement, contents).unwrap();
        fs::rename(&replacement, &path).unwrap();

        assert!(unix::verify_opened_artifact(opened, &digest, contents).is_err());
    }
}
