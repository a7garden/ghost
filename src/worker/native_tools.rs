use std::{
    ffi::CString,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::{fd::{AsRawFd, FromRawFd}, unix::fs::{MetadataExt, OpenOptionsExt}},
    path::{Component, Path, PathBuf},
};
#[cfg(unix)]
pub(crate) fn create_execution_workspace(task_snapshot_root: &Path, directory_name: &str) -> Result<PathBuf, NativeToolFailure> {
    if directory_name.len() != 64
        || !directory_name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(NativeToolFailure::new("tool_scope_rejected"));
    }
    let parent = NativeWorkspace::open(task_snapshot_root)?;
    let parent_metadata = parent.root.metadata().map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
    if parent_metadata.uid() != unsafe { libc::geteuid() } || parent_metadata.mode() & 0o777 != 0o700 {
        return Err(NativeToolFailure::new("tool_scope_rejected"));
    }
    let name = CString::new(directory_name).map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
    let created = unsafe { libc::mkdirat(parent.root.as_raw_fd(), name.as_ptr(), 0o700) };
    if created != 0 {
        return Err(NativeToolFailure::new("tool_scope_rejected"));
    }
    let child = open_directory_at(&parent.root, directory_name)?;
    if unsafe { libc::fchmod(child.as_raw_fd(), 0o700) } != 0 {
        return Err(NativeToolFailure::new("tool_scope_rejected"));
    }
    let metadata = child.metadata().map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
    if metadata.uid() != parent_metadata.uid() || metadata.mode() & 0o777 != 0o700 {
        return Err(NativeToolFailure::new("tool_scope_rejected"));
    }
    Ok(task_snapshot_root.join(directory_name))
}




pub(crate) const PUBLISH_ARTIFACT_TOOL: &str = "publish_artifact";
pub(crate) const ALL_WORKER_TOOL_NAMES: [&str; 11] = [
    "read", "write", "edit", "bash", "grep", "glob", "ast_grep", "ast_edit", "eval", "todo",
    PUBLISH_ARTIFACT_TOOL,
];
pub(crate) const MAX_ARTIFACT_FILE_BYTES: usize = 1_048_576;
const MAX_ARTIFACT_PATH_BYTES: usize = 4096;
const MAX_PATH_COMPONENTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NativeToolFailure {
    pub code: &'static str,
}

impl NativeToolFailure {
    fn new(code: &'static str) -> Self { Self { code } }
}

pub(crate) fn is_exact_worker_tool_scope(tools: &[String]) -> bool {
    (tools.len() == ALL_WORKER_TOOL_NAMES.len()
        || (tools.len() == ALL_WORKER_TOOL_NAMES.len() + 1
            && tools[ALL_WORKER_TOOL_NAMES.len()] == "browser"))
        && tools.iter().zip(ALL_WORKER_TOOL_NAMES).all(|(tool, expected)| tool == expected)
}

pub(crate) struct NativeWorkspace {
    root: File,
}

impl NativeWorkspace {
    pub(crate) fn open(path: &Path) -> Result<Self, NativeToolFailure> {
        if !path.is_absolute() {
            return Err(NativeToolFailure::new("tool_scope_rejected"));
        }
        let before = fs::symlink_metadata(path).map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
        if before.file_type().is_symlink() || !before.is_dir() {
            return Err(NativeToolFailure::new("tool_scope_rejected"));
        }
        let canonical = fs::canonicalize(path).map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
        if canonical != path {
            return Err(NativeToolFailure::new("tool_scope_rejected"));
        }
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical)
            .map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
        let opened = root.metadata().map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
        if !opened.is_dir() || before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(NativeToolFailure::new("tool_scope_rejected"));
        }
        Ok(Self { root })
    }

    pub(crate) fn read_artifact(&self, relative: &str) -> Result<Vec<u8>, NativeToolFailure> {
        let components = relative_components(relative)?;
        let (leaf, parents) = components.split_last().ok_or_else(|| NativeToolFailure::new("tool_path_invalid"))?;
        let mut parent = self.root.try_clone().map_err(|_| NativeToolFailure::new("tool_scope_rejected"))?;
        for component in parents {
            parent = open_directory_at(&parent, component)?;
        }
        let leaf = CString::new(leaf.as_bytes()).map_err(|_| NativeToolFailure::new("tool_path_invalid"))?;
        let mut file = open_file_at(&parent, &leaf)?;
        let before = file.metadata().map_err(|_| NativeToolFailure::new("tool_file_rejected"))?;
        validate_artifact_metadata(&before)?;
        let mut bytes = Vec::with_capacity(before.len() as usize);
        Read::by_ref(&mut file)
            .take((MAX_ARTIFACT_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| NativeToolFailure::new("tool_file_rejected"))?;
        if bytes.len() > MAX_ARTIFACT_FILE_BYTES {
            return Err(NativeToolFailure::new("tool_file_too_large"));
        }
        let after = file.metadata().map_err(|_| NativeToolFailure::new("tool_file_rejected"))?;
        if !same_file_state(&before, &after) {
            return Err(NativeToolFailure::new("tool_file_changed_during_read"));
        }
        let current = open_file_at(&parent, &leaf)?;
        let current = current.metadata().map_err(|_| NativeToolFailure::new("tool_file_rejected"))?;
        if !same_file_state(&before, &current) {
            return Err(NativeToolFailure::new("tool_file_changed_during_read"));
        }
        Ok(bytes)
    }
}

fn relative_components(relative: &str) -> Result<Vec<&str>, NativeToolFailure> {
    if relative.is_empty() || relative.len() > MAX_ARTIFACT_PATH_BYTES || relative.ends_with('/') || relative.as_bytes().contains(&0) {
        return Err(NativeToolFailure::new("tool_path_invalid"));
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err(NativeToolFailure::new("tool_path_invalid"));
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) if !name.is_empty() && name.len() <= 255 => {
                components.push(name.to_str().ok_or_else(|| NativeToolFailure::new("tool_path_invalid"))?);
                if components.len() > MAX_PATH_COMPONENTS {
                    return Err(NativeToolFailure::new("tool_path_invalid"));
                }
            }
            _ => return Err(NativeToolFailure::new("tool_path_invalid")),
        }
    }
    if components.is_empty() {
        return Err(NativeToolFailure::new("tool_path_invalid"));
    }
    Ok(components)
}

fn open_directory_at(parent: &File, component: &str) -> Result<File, NativeToolFailure> {
    let name = CString::new(component.as_bytes()).map_err(|_| NativeToolFailure::new("tool_path_invalid"))?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(NativeToolFailure::new(if std::io::Error::last_os_error().raw_os_error() == Some(libc::ELOOP) {
            "tool_symlink_rejected"
        } else {
            "tool_scope_rejected"
        }));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_file_at(parent: &File, leaf: &CString) -> Result<File, NativeToolFailure> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            leaf.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        return Err(NativeToolFailure::new(match error.raw_os_error() {
            Some(libc::ELOOP) => "tool_symlink_rejected",
            Some(libc::ENOENT) => "tool_file_not_found",
            _ => "tool_file_rejected",
        }));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn validate_artifact_metadata(metadata: &Metadata) -> Result<(), NativeToolFailure> {
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(NativeToolFailure::new("tool_file_rejected"));
    }
    if metadata.len() > MAX_ARTIFACT_FILE_BYTES as u64 {
        return Err(NativeToolFailure::new("tool_file_too_large"));
    }
    Ok(())
}

fn same_file_state(before: &Metadata, after: &Metadata) -> bool {
    before.is_file()
        && after.is_file()
        && before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.nlink() == after.nlink()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

#[cfg(test)]
mod tests {
    use super::{NativeWorkspace, MAX_ARTIFACT_FILE_BYTES};
    use std::{fs, os::unix::fs::symlink};
    use tempfile::TempDir;

    fn workspace() -> (TempDir, NativeWorkspace) {
        let root = TempDir::new().unwrap();
        fs::set_permissions(root.path(), std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        let workspace = NativeWorkspace::open(&root.path().canonicalize().unwrap()).unwrap();
        (root, workspace)
    }

    #[test]
    fn reads_exact_binary_bytes_from_the_workspace() {
        let (root, workspace) = workspace();
        let payload = [0, 255, 1, 128, 10];
        fs::write(root.path().join("artifact.bin"), payload).unwrap();

        assert_eq!(workspace.read_artifact("artifact.bin").unwrap(), payload);
    }

    #[test]
    fn rejects_traversal_symlinks_hardlinks_and_non_regular_files() {
        let (root, workspace) = workspace();
        fs::write(root.path().join("source.bin"), b"private").unwrap();
        symlink(root.path().join("source.bin"), root.path().join("link.bin")).unwrap();
        fs::hard_link(root.path().join("source.bin"), root.path().join("hardlink.bin")).unwrap();
        fs::create_dir(root.path().join("directory")).unwrap();

        assert!(workspace.read_artifact("../source.bin").is_err());
        assert!(workspace.read_artifact("link.bin").is_err());
        assert!(workspace.read_artifact("hardlink.bin").is_err());
        assert!(workspace.read_artifact("directory").is_err());
    }

    #[test]
    fn rejects_files_over_the_publication_limit() {
        let (root, workspace) = workspace();
        fs::write(root.path().join("oversized.bin"), vec![0; MAX_ARTIFACT_FILE_BYTES + 1]).unwrap();

        assert!(workspace.read_artifact("oversized.bin").is_err());
    }
}
