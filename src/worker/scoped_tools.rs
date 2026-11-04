use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{fd::{AsRawFd, FromRawFd}, unix::fs::{OpenOptionsExt, PermissionsExt}},
    path::{Component, Path, PathBuf},
};

pub(crate) const MAX_TOOL_CONTENT_BYTES: usize = 64 * 1024;
const MAX_TOOL_PATH_BYTES: usize = 4096;
const MAX_PATH_COMPONENTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ToolFailure {
    pub code: &'static str,
}

impl ToolFailure {
    fn new(code: &'static str) -> Self { Self { code } }
}

#[derive(Debug, Clone)]
pub(crate) struct ScopedWorkspace {
    root: PathBuf,
    cwd_components: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct FileStamp {
    device: u64,
    inode: u64,
    links: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanos: i64,
    sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteReconciliation {
    Applied,
    NotApplied,
    Unknown,
}

impl ScopedWorkspace {
    pub(crate) fn new(root: &Path, cwd: &str) -> Result<Self> {
        ensure!(root.is_absolute(), "worker root must be absolute");
        let root = root.canonicalize()?;
        let workspaces = root.join("workspaces");
        let metadata = fs::symlink_metadata(&workspaces)?;
        ensure!(!metadata.file_type().is_symlink() && metadata.is_dir(), "worker workspaces root is unsafe");

        let cwd_path = PathBuf::from(cwd);
        ensure!(cwd_path.is_absolute(), "worker cwd must be absolute");
        let canonical_cwd = cwd_path.canonicalize()?;
        ensure!(canonical_cwd.to_string_lossy() == cwd, "worker cwd must use its canonical path");
        let relative = canonical_cwd.strip_prefix(&workspaces).map_err(|_| anyhow::anyhow!("worker cwd is outside its workspace root"))?;
        ensure!(!relative.as_os_str().is_empty(), "worker cwd must be a child of the workspace root");
        let cwd_components = normal_components(relative)?;

        let scope = Self { root: root.join("workspaces"), cwd_components };
        let _ = scope.open_cwd().map_err(|error| anyhow::anyhow!(error.code))?;
        Ok(scope)
    }

    /// Host-derived canonical task directory. No model-supplied root is accepted.
    pub(crate) fn for_task(path: &Path) -> Result<Self> {
        ensure!(path.is_absolute() && path.canonicalize()? == path, "task path must be canonical");
        let scope = Self { root: path.to_path_buf(), cwd_components: vec![] };
        let _ = scope.open_cwd().map_err(|error| anyhow::anyhow!(error.code))?;
        Ok(scope)
    }

    /// Creates an immutable-input candidate without overwriting existing data.
    /// Callers verify its digest through NativeWorkspace before reuse.
    pub(crate) fn create_input(&self, relative:&str, bytes:&[u8]) -> std::result::Result<(),ToolFailure> {
        validate_relative_path(relative)?;
        if bytes.len()>super::native_tools::MAX_ARTIFACT_FILE_BYTES { return Err(ToolFailure::new("tool_file_too_large")); }
        self.atomic_write(relative,bytes,None)
    }

    pub(crate) fn read_utf8(&self, relative: &str) -> std::result::Result<(String, String), ToolFailure> {
        let (stamp, bytes) = self.snapshot(relative)?.ok_or_else(|| ToolFailure::new("tool_file_not_found"))?;
        let content = String::from_utf8(bytes).map_err(|_| ToolFailure::new("tool_file_not_utf8"))?;
        Ok((content, stamp.sha256))
    }

    pub(crate) fn plan_write(&self, relative: &str, content: &str) -> std::result::Result<Value, ToolFailure> {
        validate_relative_path(relative)?;
        ensure_tool_size(content.len())?;
        let before = match self.snapshot(relative)? {
            Some((stamp,_)) => Some(serde_json::to_value(stamp).map_err(|_| ToolFailure::new("tool_write_failed"))?),
            None => None,
        };
        Ok(json!({"phase":"write_planned","path":relative,"desired_sha256":digest(content.as_bytes()),"before":before}))
    }

    pub(crate) fn write_from_intent(&self, relative: &str, content: &str, intent: &Value) -> std::result::Result<String, ToolFailure> {
        validate_relative_path(relative)?;
        ensure_tool_size(content.len())?;
        if intent["phase"].as_str() != Some("write_planned") || intent["path"].as_str() != Some(relative) || intent["desired_sha256"].as_str() != Some(digest(content.as_bytes()).as_str()) {
            return Err(ToolFailure::new("tool_receipt_conflict"));
        }
        let before: Option<FileStamp> = match &intent["before"] {
            Value::Null => None,
            value => Some(serde_json::from_value(value.clone()).map_err(|_| ToolFailure::new("tool_receipt_unknown"))?),
        };
        let desired = digest(content.as_bytes());
        let current = self.snapshot(relative)?;
        if current.as_ref().map(|(stamp, _)| stamp.sha256.as_str()) == Some(desired.as_str()) {
            return Ok(desired);
        }
        if current.as_ref().map(|(stamp, _)| stamp) != before.as_ref() {
            return Err(ToolFailure::new("tool_effect_unknown"));
        }
        self.atomic_write(relative, content.as_bytes(), before.as_ref())?;
        let after = match self.snapshot(relative) {
            Ok(Some(after)) => after,
            _ => return Err(ToolFailure::new("tool_effect_unknown")),
        };
        if after.0.sha256 != desired {
            return Err(ToolFailure::new("tool_effect_unknown"));
        }
        Ok(desired)
    }

    pub(crate) fn reconcile_write(&self, relative: &str, content: &str, intent: &Value) -> std::result::Result<WriteReconciliation, ToolFailure> {
        validate_relative_path(relative)?;
        ensure_tool_size(content.len())?;
        if intent["phase"].as_str() != Some("write_planned")
            || intent["path"].as_str() != Some(relative)
            || intent["desired_sha256"].as_str() != Some(digest(content.as_bytes()).as_str()) {
            return Ok(WriteReconciliation::Unknown);
        }
        let before: Option<FileStamp> = match &intent["before"] {
            Value::Null => None,
            value => Some(serde_json::from_value(value.clone()).map_err(|_| ToolFailure::new("tool_receipt_unknown"))?),
        };
        let current = self.snapshot(relative)?;
        if current.as_ref().map(|(stamp,_)| stamp.sha256.as_str()) == intent["desired_sha256"].as_str() {
            return Ok(WriteReconciliation::Applied);
        }
        if current.as_ref().map(|(stamp,_)| stamp) == before.as_ref() {
            Ok(WriteReconciliation::NotApplied)
        } else {
            Ok(WriteReconciliation::Unknown)
        }
    }

    fn open_cwd(&self) -> std::result::Result<File, ToolFailure> {
        let workspaces = &self.root;
        let mut current = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(workspaces)
            .map_err(|_| ToolFailure::new("tool_scope_rejected"))?;
        for component in &self.cwd_components {
            current = open_directory_at(&current, component)?;
        }
        Ok(current)
    }

    fn open_parent(&self, relative: &str) -> std::result::Result<(File, CString), ToolFailure> {
        let components = validate_relative_path(relative)?;
        let (leaf, parents) = components.split_last().ok_or_else(|| ToolFailure::new("tool_path_invalid"))?;
        let mut parent = self.open_cwd()?;
        for component in parents {
            parent = open_directory_at(&parent, component)?;
        }
        let leaf = CString::new(leaf.as_bytes()).map_err(|_| ToolFailure::new("tool_path_invalid"))?;
        Ok((parent, leaf))
    }

    fn snapshot(&self, relative: &str) -> std::result::Result<Option<(FileStamp, Vec<u8>)>, ToolFailure> {
        let (parent, leaf) = self.open_parent(relative)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOENT) { return Ok(None); }
            return Err(ToolFailure::new(if error.raw_os_error() == Some(libc::ELOOP) { "tool_symlink_rejected" } else { "tool_file_rejected" }));
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let before = file_stamp(&file)?;
        ensure_regular_single_link(&before)?;
        if before.size > MAX_TOOL_CONTENT_BYTES as u64 { return Err(ToolFailure::new("tool_file_too_large")); }
        let mut bytes = Vec::with_capacity(before.size as usize);
        Read::by_ref(&mut file).take((MAX_TOOL_CONTENT_BYTES + 1) as u64)
            .read_to_end(&mut bytes).map_err(|_| ToolFailure::new("tool_file_rejected"))?;
        if bytes.len() > MAX_TOOL_CONTENT_BYTES { return Err(ToolFailure::new("tool_file_too_large")); }
        let after = file_stamp(&file)?;
        if before.device != after.device || before.inode != after.inode || before.links != after.links || before.size != after.size
            || before.modified_seconds != after.modified_seconds || before.modified_nanos != after.modified_nanos {
            return Err(ToolFailure::new("tool_file_changed_during_read"));
        }
        let stamp = FileStamp { sha256: digest(&bytes), ..after };
        Ok(Some((stamp, bytes)))
    }

    fn atomic_write(&self, relative: &str, bytes: &[u8], expected: Option<&FileStamp>) -> std::result::Result<(), ToolFailure> {
        let (parent, leaf) = self.open_parent(relative)?;
        let temporary_name = CString::new(format!(".ghost-canary-{}.tmp", uuid::Uuid::new_v4()))
            .map_err(|_| ToolFailure::new("tool_write_failed"))?;
        let temp_fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if temp_fd < 0 { return Err(ToolFailure::new("tool_write_failed")); }
        let mut temporary = unsafe { File::from_raw_fd(temp_fd) };
        let write_result = (|| -> std::io::Result<()> {
            temporary.write_all(bytes)?;
            temporary.sync_all()
        })();
        if write_result.is_err() {
            drop(temporary);
            unlink_at(&parent, &temporary_name);
            return Err(ToolFailure::new("tool_write_failed"));
        }
        drop(temporary);

        let current = match self.snapshot(relative) {
            Ok(current) => current,
            Err(error) => {
                unlink_at(&parent, &temporary_name);
                return Err(error);
            }
        };
        if current.as_ref().map(|(stamp, _)| stamp) != expected {
            unlink_at(&parent, &temporary_name);
            return Err(ToolFailure::new("tool_effect_unknown"));
        }
        let result = if expected.is_some() {
            let status = unsafe { libc::renameat(parent.as_raw_fd(), temporary_name.as_ptr(), parent.as_raw_fd(), leaf.as_ptr()) };
            if status == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
        } else {
            let status = unsafe { libc::linkat(parent.as_raw_fd(), temporary_name.as_ptr(), parent.as_raw_fd(), leaf.as_ptr(), 0) };
            if status == 0 {
                if unsafe { libc::unlinkat(parent.as_raw_fd(), temporary_name.as_ptr(), 0) } == 0 { Ok(()) }
                else { Err(std::io::Error::last_os_error()) }
            } else { Err(std::io::Error::last_os_error()) }
        };
        if result.is_err() {
            unlink_at(&parent, &temporary_name);
            return Err(ToolFailure::new("tool_effect_unknown"));
        }
        if parent.sync_all().is_err() { return Err(ToolFailure::new("tool_effect_unknown")); }
        Ok(())
    }
}

pub(crate) fn ensure_workspace_root(root: &Path) -> Result<()> {
    let workspaces = root.join("workspaces");
    match fs::symlink_metadata(&workspaces) {
        Ok(metadata) => ensure!(!metadata.file_type().is_symlink() && metadata.is_dir(), "worker workspaces root is unsafe"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&workspaces)?,
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    fs::set_permissions(&workspaces, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn normal_components(path: &Path) -> Result<Vec<String>> {
    path.components().map(|component| match component {
        Component::Normal(name) => name.to_str().map(str::to_owned).ok_or_else(|| anyhow::anyhow!("workspace path is not UTF-8")),
        _ => Err(anyhow::anyhow!("workspace path contains a non-normal component")),
    }).collect()
}

pub(crate) fn validate_relative_path(path: &str) -> std::result::Result<Vec<String>, ToolFailure> {
    if path.is_empty() || path.len() > MAX_TOOL_PATH_BYTES || path.starts_with('/') || path.contains('\\') || path.contains(':') || path.contains('\0') {
        return Err(ToolFailure::new("tool_path_invalid"));
    }
    let components: Vec<String> = path.split('/').map(str::to_owned).collect();
    if components.is_empty() || components.len() > MAX_PATH_COMPONENTS || components.iter().any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(ToolFailure::new("tool_path_invalid"));
    }
    Ok(components)
}

fn open_directory_at(parent: &File, component: &str) -> std::result::Result<File, ToolFailure> {
    let name = CString::new(component.as_bytes()).map_err(|_| ToolFailure::new("tool_path_invalid"))?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        return Err(ToolFailure::new(if error.raw_os_error() == Some(libc::ELOOP) { "tool_symlink_rejected" } else { "tool_scope_rejected" }));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn file_stamp(file: &File) -> std::result::Result<FileStamp, ToolFailure> {
    let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
    if unsafe { libc::fstat(file.as_raw_fd(), &mut metadata) } != 0 { return Err(ToolFailure::new("tool_file_rejected")); }
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG { return Err(ToolFailure::new("tool_file_not_regular")); }
    let (modified_seconds, modified_nanos) = modified_time(&metadata);
    Ok(FileStamp {
        device: metadata.st_dev as u64,
        inode: metadata.st_ino as u64,
        links: metadata.st_nlink as u64,
        size: metadata.st_size.max(0) as u64,
        modified_seconds,
        modified_nanos,
        sha256: String::new(),
    })
}

fn ensure_regular_single_link(stamp: &FileStamp) -> std::result::Result<(), ToolFailure> {
    if stamp.links != 1 { return Err(ToolFailure::new("tool_hardlink_rejected")); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn modified_time(metadata: &libc::stat) -> (i64, i64) {
    (metadata.st_mtime as i64, metadata.st_mtime_nsec as i64)
}

#[cfg(target_os = "linux")]
fn modified_time(metadata: &libc::stat) -> (i64, i64) {
    (metadata.st_mtime as i64, metadata.st_mtime_nsec as i64)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn modified_time(_metadata: &libc::stat) -> (i64, i64) { (0, 0) }

fn unlink_at(parent: &File, name: &CString) {
    unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0); }
}

fn ensure_tool_size(length: usize) -> std::result::Result<(), ToolFailure> {
    if length > MAX_TOOL_CONTENT_BYTES { return Err(ToolFailure::new("tool_content_too_large")); }
    Ok(())
}

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

#[cfg(test)]
mod tests {
    use super::{ensure_workspace_root, ScopedWorkspace, WriteReconciliation, MAX_TOOL_CONTENT_BYTES};
    use std::{fs, path::PathBuf};
    use tempfile::TempDir;

    fn scoped_workspace() -> (TempDir, PathBuf, ScopedWorkspace) {
        let root = TempDir::new().unwrap();
        ensure_workspace_root(root.path()).unwrap();
        let cwd = root.path().join("workspaces").join("attempt");
        fs::create_dir(&cwd).unwrap();
        let cwd = fs::canonicalize(cwd).unwrap();
        let scope = ScopedWorkspace::new(root.path(),cwd.to_str().unwrap()).unwrap();
        (root,cwd,scope)
    }

    #[test]
    fn canonical_cwd_and_relative_paths_cannot_escape_workspace() {
        let (root,cwd,scope) = scoped_workspace();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let alias = root.path().join("workspaces").join("alias");
        std::os::unix::fs::symlink(&cwd,&alias).unwrap();
        assert!(ScopedWorkspace::new(root.path(),alias.to_str().unwrap()).is_err());
        assert!(ScopedWorkspace::new(root.path(),outside.to_str().unwrap()).is_err());
        for path in ["", "/etc/passwd", "../outside", "sub/../outside", "file:///etc/passwd", "skill://private", "omp://worker.db", "a\\b"] {
            assert_eq!(scope.read_utf8(path).unwrap_err().code,"tool_path_invalid");
        }
    }

    #[test]
    fn symlink_hardlink_and_nonregular_targets_are_rejected() {
        let (root,cwd,scope) = scoped_workspace();
        let outside = root.path().join("outside.txt");
        fs::write(&outside,"private").unwrap();
        std::os::unix::fs::symlink(&outside,cwd.join("symlink.txt")).unwrap();
        assert_eq!(scope.read_utf8("symlink.txt").unwrap_err().code,"tool_symlink_rejected");

        let shared = cwd.join("hardlink.txt");
        fs::hard_link(&outside,&shared).unwrap();
        assert_eq!(scope.read_utf8("hardlink.txt").unwrap_err().code,"tool_hardlink_rejected");

        fs::create_dir(cwd.join("directory")).unwrap();
        assert_eq!(scope.read_utf8("directory").unwrap_err().code,"tool_file_not_regular");

        std::os::unix::fs::symlink(&outside,cwd.join("linked-parent")).unwrap();
        assert!(matches!(scope.read_utf8("linked-parent/private.txt").unwrap_err().code,"tool_symlink_rejected"|"tool_scope_rejected"));
    }

    #[test]
    fn atomic_write_receipt_replays_without_changing_digest() {
        let (_root,_cwd,scope) = scoped_workspace();
        let content = "durable worker artifact";
        let plan_error = scope.plan_write("nested/result.txt",content).unwrap_err();
        assert_eq!(plan_error.code,"tool_scope_rejected");
        let intent = scope.plan_write("result.txt",content).unwrap();
        let digest = scope.write_from_intent("result.txt",content,&intent).unwrap();
        assert_eq!(scope.read_utf8("result.txt").unwrap(),(content.to_owned(),digest.clone()));
        assert_eq!(scope.write_from_intent("result.txt",content,&intent).unwrap(),digest);
        assert_eq!(scope.plan_write("large.txt",&"x".repeat(MAX_TOOL_CONTENT_BYTES+1)).unwrap_err().code,"tool_content_too_large");
    }

    #[test]
    fn persisted_write_intent_reconciles_without_retrying_unknown_effects() {
        let (_root,cwd,scope) = scoped_workspace();
        let path = cwd.join("result.txt");
        fs::write(&path,"before").unwrap();
        let content = "requested";
        let intent = scope.plan_write("result.txt",content).unwrap();
        assert_eq!(scope.reconcile_write("result.txt",content,&intent).unwrap(),WriteReconciliation::NotApplied);
        scope.write_from_intent("result.txt",content,&intent).unwrap();
        assert_eq!(scope.reconcile_write("result.txt",content,&intent).unwrap(),WriteReconciliation::Applied);
        fs::write(&path,"intervening").unwrap();
        assert_eq!(scope.reconcile_write("result.txt",content,&intent).unwrap(),WriteReconciliation::Unknown);
    }
}
