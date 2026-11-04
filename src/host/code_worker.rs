//! A bounded Codex CLI worker for ordinary source-code tasks.
//!
//! The host resolves an owner-maintained project registry, clones only its
//! committed HEAD into a disposable local repository, and runs Codex with the
//! OS-enforced workspace-write sandbox. The original checkout is never edited.
//! Results are reviewable patches stored under Ghost's state root.
use crate::durable::durable::{ToolOutput, ToolStatus};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    task::JoinHandle,
    time::timeout,
};

const EXECUTABLE_ENV: &str = "GHOST_CODEX_EXECUTABLE";
const MODEL_ENV: &str = "GHOST_CODEX_MODEL";
const EFFORT_ENV: &str = "GHOST_CODEX_REASONING_EFFORT";
const PROJECTS_ENV: &str = "GHOST_CODEX_WORKSPACES_FILE";
const MAX_PROMPT_BYTES: usize = 32 * 1024;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TREE_INDEX_BYTES: usize = 64 * 1024 * 1024;
const MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 128 * 1024;
const MAX_FINAL_MESSAGE_BYTES: usize = 128 * 1024;
const MAX_PATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 50;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const CODEX_DEADLINE: Duration = Duration::from_secs(600);
const GIT_DEADLINE: Duration = Duration::from_secs(90);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceRegistry {
    schema: String,
    project_root: PathBuf,
    projects: Vec<ProjectEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectEntry {
    id: String,
    path: PathBuf,
    external_ai_allowed: bool,
}

#[derive(Debug, Serialize)]
struct ArtifactManifest<'a> {
    schema: &'static str,
    execution_id: &'a str,
    profile_id: &'a str,
    task_id: &'a str,
    call_id: &'a str,
    project_id: &'a str,
    base_commit: &'a str,
    model: &'a str,
    reasoning_effort: &'a str,
    codex_sha256: &'a str,
    created_ms: u64,
    patch_sha256: &'a str,
    patch_bytes: usize,
    changed_paths: &'a [String],
    summary: &'a str,
}

struct ProcessOutput {
    status: Option<std::process::ExitStatus>,
    stdout: Vec<u8>,
    timed_out: bool,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn model() -> Option<String> {
    let value = std::env::var(MODEL_ENV).ok()?;
    valid_model(&value).then_some(value)
}

fn reasoning_effort() -> Option<String> {
    let value = std::env::var(EFFORT_ENV).ok()?;
    matches!(value.as_str(), "low" | "medium" | "high" | "xhigh" | "max").then_some(value)
}

fn executable() -> Option<PathBuf> {
    let raw = std::env::var_os(EXECUTABLE_ENV)?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return None;
    }
    let resolved = path.canonicalize().ok()?;
    let metadata = resolved.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(resolved)
}

fn registry() -> Result<Vec<ProjectEntry>> {
    let raw_path = std::env::var_os(PROJECTS_ENV)
        .ok_or_else(|| anyhow!("Codex code-workspace registry is not configured"))?;
    let path = PathBuf::from(raw_path);
    if !path.is_absolute() || std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
        bail!("Codex code-workspace registry must be a non-symlink absolute file");
    }
    let bytes = std::fs::read(&path)?;
    if bytes.len() > 64 * 1024 {
        bail!("Codex code-workspace registry exceeds 64 KiB");
    }
    let registry: WorkspaceRegistry = serde_json::from_slice(&bytes)?;
    if registry.schema != "ghost-code-workspaces/1" || registry.projects.len() > 32 {
        bail!("Codex code-workspace registry schema or project count is invalid");
    }
    let root = registry.project_root;
    if !root.is_absolute() || std::fs::symlink_metadata(&root)?.file_type().is_symlink() {
        bail!("canonical Projects root must be an absolute non-symlink directory");
    }
    let root = root.canonicalize()?;
    if !root.is_dir() {
        bail!("canonical Projects root is not a directory");
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut allowed = Vec::new();
    for project in registry.projects {
        if !valid_id(&project.id) || !seen.insert(project.id.clone()) {
            bail!("Codex project IDs must be unique lowercase slugs");
        }
        if !project.external_ai_allowed {
            continue;
        }
        if !project.path.is_absolute()
            || std::fs::symlink_metadata(&project.path)?
                .file_type()
                .is_symlink()
        {
            bail!("allowlisted project paths must be absolute non-symlink directories");
        }
        let path = project.path.canonicalize()?;
        let git_metadata = std::fs::symlink_metadata(path.join(".git")).ok();
        if path.parent() != Some(root.as_path())
            || path.file_name().and_then(|name| name.to_str()) != Some(project.id.as_str())
            || !path.is_dir()
            || !git_metadata.is_some_and(|metadata| metadata.file_type().is_dir())
            || path.join(".codex").exists()
        {
            bail!(
                "allowlisted projects must be direct Git roots without project Codex configuration"
            );
        }
        // Submodules and user-defined filters need a separate checkout contract.
        if path.join(".gitmodules").exists() {
            bail!("submodule projects are not enabled for the initial code worker");
        }
        allowed.push(ProjectEntry {
            id: project.id,
            path,
            external_ai_allowed: true,
        });
    }
    if allowed.is_empty() {
        bail!("no general-development projects are enabled for Codex");
    }
    Ok(allowed)
}

pub(crate) fn project_ids() -> Vec<String> {
    if executable().is_none() || model().is_none() || reasoning_effort().is_none() {
        return Vec::new();
    }
    registry()
        .map(|projects| projects.into_iter().map(|project| project.id).collect())
        .unwrap_or_default()
}

pub(crate) fn configured() -> bool {
    executable().is_some()
        && model().is_some()
        && reasoning_effort().is_some()
        && !project_ids().is_empty()
}

pub(crate) fn execution_id(owner: &str, task_id: &str, call_id: &str) -> String {
    let digest = Sha256::digest(format!("{owner}\0{task_id}\0{call_id}").as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn read_bounded<R: AsyncRead + Unpin>(reader: R, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

fn start_reader<R: AsyncRead + Unpin + Send + 'static>(
    reader: R,
    limit: usize,
) -> JoinHandle<io::Result<Vec<u8>>> {
    tokio::spawn(read_bounded(reader, limit))
}

async fn stop(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn run_process(
    mut command: Command,
    input: Option<&[u8]>,
    deadline: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<ProcessOutput> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| anyhow!("worker process could not start"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("worker stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("worker stderr unavailable"))?;
    let stdout_task = start_reader(stdout, stdout_limit);
    let stderr_task = start_reader(stderr, stderr_limit);
    if let Some(input) = input {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("worker stdin unavailable"))?;
        if stdin.write_all(input).await.is_err() || stdin.shutdown().await.is_err() {
            stop(&mut child).await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            bail!("worker prompt handoff was interrupted");
        }
    }
    let (status, timed_out) = match timeout(deadline, child.wait()).await {
        Ok(Ok(status)) => (status, false),
        Ok(Err(_)) => {
            stop(&mut child).await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            bail!("worker process exited before its status was confirmed");
        }
        Err(_) => {
            stop(&mut child).await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Ok(ProcessOutput {
                status: None,
                stdout: Vec::new(),
                timed_out: true,
            });
        }
    };
    let stdout = stdout_task.await??;
    let stderr = stderr_task.await??;
    if stdout.len() > stdout_limit || stderr.len() > stderr_limit {
        bail!("worker output exceeded its bounded size");
    }
    Ok(ProcessOutput {
        status: Some(status),
        stdout,
        timed_out,
    })
}

fn git_command() -> Command {
    let mut command = Command::new("/usr/bin/git");
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", "/var/empty")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", "/dev/null");
    command
}

async fn git_output(cwd: &Path, args: &[&str], output_limit: usize) -> Result<ProcessOutput> {
    let mut command = git_command();
    command.current_dir(cwd).args(args);
    run_process(command, None, GIT_DEADLINE, output_limit, 32 * 1024).await
}

async fn git_checked(cwd: &Path, args: &[&str], output_limit: usize) -> Result<Vec<u8>> {
    let output = git_output(cwd, args, output_limit).await?;
    if !output.status.is_some_and(|status| status.success()) || output.timed_out {
        bail!("isolated Git workspace preparation failed");
    }
    Ok(output.stdout)
}

fn make_private_dir(path: &Path) -> Result<()> {
    if path.exists() {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            bail!("code-worker directory must not be a symlink");
        }
        if !path.is_dir() {
            bail!("code-worker path is not a directory");
        }
    } else {
        std::fs::create_dir_all(path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn artifact_capacity(path: &Path) -> Result<()> {
    let mut count = 0usize;
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_file() && entry.path().extension().is_some_and(|ext| ext == "patch") {
            count += 1;
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    if count >= MAX_ARTIFACTS || bytes >= MAX_ARTIFACT_BYTES {
        bail!("code-worker patch archive is full; review and remove accepted artifacts before starting more work");
    }
    Ok(())
}

fn safe_remove(path: &Path) -> Result<()> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        bail!("refusing to remove a symlinked code-worker path");
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn parse_changed_paths(status: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    for field in status.split(|byte| *byte == 0) {
        if field.len() > 3 {
            paths.push(String::from_utf8_lossy(&field[3..]).into_owned());
        }
        if paths.len() >= 200 {
            break;
        }
    }
    paths
}

fn final_message(path: &Path) -> String {
    let mut bytes = Vec::new();
    let read = std::fs::File::open(path).and_then(|file| {
        use std::io::Read;
        file.take((MAX_FINAL_MESSAGE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
    });
    if read.is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_FINAL_MESSAGE_BYTES)])
        .trim()
        .chars()
        .take(32_000)
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

async fn prepare_workspace(source: &Path, run_root: &Path) -> Result<(PathBuf, String)> {
    let branch = git_checked(source, &["symbolic-ref", "--short", "HEAD"], 4 * 1024).await?;
    let branch = String::from_utf8(branch)
        .map_err(|_| anyhow!("project branch name is not UTF-8"))?
        .trim()
        .to_string();
    if branch.is_empty() || branch.starts_with('-') || branch.contains('\n') {
        bail!("allowlisted project needs a named current branch");
    }
    let tree = git_checked(
        source,
        &["ls-tree", "-r", "-l", "-z", "HEAD"],
        MAX_TREE_INDEX_BYTES,
    )
    .await?;
    let mut total_bytes = 0u64;
    let mut file_count = 0usize;
    for entry in tree
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let separator = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| anyhow!("project Git tree entry is malformed"))?;
        let (header, _) = entry.split_at(separator);
        let fields = header
            .split(|byte| *byte == b' ')
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        if fields.len() < 3 || fields[1] == b"commit" {
            bail!("submodule project entries are not enabled for the initial code worker");
        }
        if fields[0] == b"120000" {
            bail!("symlink files are not enabled in code-worker workspaces");
        }
        if fields[1] == b"blob" {
            let size = fields
                .get(3)
                .ok_or_else(|| anyhow!("project Git blob is missing its size"))?
                .iter()
                .try_fold(0u64, |size, byte| {
                    if !byte.is_ascii_digit() {
                        None
                    } else {
                        size.checked_mul(10)?.checked_add((*byte - b'0') as u64)
                    }
                })
                .ok_or_else(|| anyhow!("project Git blob size is invalid"))?;
            total_bytes = total_bytes.saturating_add(size);
            file_count += 1;
            if total_bytes > MAX_SOURCE_BYTES || file_count > 200_000 {
                bail!("project exceeds the 2 GiB or 200,000-file disposable workspace limit");
            }
        }
    }
    let checkout = run_root.join("repo");
    let template = run_root.join("git-template");
    make_private_dir(&template)?;
    let mut clone = git_command();
    clone
        .current_dir(run_root)
        .arg("clone")
        .arg("--shared")
        .arg("--dissociate")
        .arg("--depth=1")
        .arg("--no-checkout")
        .arg("--no-tags")
        .arg("--single-branch")
        .arg("--template")
        .arg(&template)
        .arg("--branch")
        .arg(&branch)
        .arg("--")
        .arg(source)
        .arg(&checkout);
    let output = run_process(clone, None, GIT_DEADLINE, 64 * 1024, 32 * 1024).await?;
    if !output.status.is_some_and(|status| status.success()) || output.timed_out {
        bail!("could not clone the committed project into a disposable workspace");
    }
    git_checked(
        &checkout,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "checkout",
            "--detach",
            "HEAD",
        ],
        64 * 1024,
    )
    .await?;
    // The worker never needs a route back to the owner's private Git host.
    let remote = git_output(&checkout, &["remote", "remove", "origin"], 8 * 1024).await?;
    if !remote.status.is_some_and(|status| status.success()) {
        bail!("could not remove the isolated clone's origin remote");
    }
    let commit = git_checked(&checkout, &["rev-parse", "HEAD"], 4 * 1024).await?;
    let commit = String::from_utf8(commit)
        .map_err(|_| anyhow!("project HEAD is not UTF-8"))?
        .trim()
        .to_string();
    if commit.len() != 40 && commit.len() != 64 {
        bail!("project HEAD did not resolve to a commit hash");
    }
    Ok((checkout, commit))
}

fn codex_command(
    executable: &Path,
    model: &str,
    effort: &str,
    checkout: &Path,
    temp_home: &Path,
    temp_dir: &Path,
    final_path: &Path,
) -> Result<Command> {
    let home =
        std::env::var_os("HOME").ok_or_else(|| anyhow!("Codex login home is unavailable"))?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&home).join(".codex"));
    let path = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    .join(":");
    let mut command = Command::new(executable);
    command
        .env_clear()
        .env("HOME", &home)
        .env("CODEX_HOME", codex_home)
        .env("PATH", &path)
        .env("TMPDIR", temp_dir)
        .env("NO_COLOR", "1")
        .current_dir(checkout)
        .arg("exec")
        .arg("--model")
        .arg(model)
        .arg("--sandbox")
        .arg("workspace-write")
        .arg("--ignore-user-config")
        .arg("--ignore-rules")
        .arg("--ephemeral")
        .arg("--strict-config")
        .arg("--json")
        .arg("--output-last-message")
        .arg(final_path)
        .arg("--config")
        .arg("approval_policy=\"never\"")
        .arg("--config")
        .arg("sandbox_mode=\"workspace-write\"")
        .arg("--config")
        .arg("sandbox_workspace_write.network_access=false")
        .arg("--config")
        .arg("web_search=\"disabled\"")
        .arg("--config")
        .arg(format!("model_reasoning_effort=\"{effort}\""))
        .arg("--config")
        .arg("allow_login_shell=false")
        .arg("--config")
        .arg("shell_environment_policy.inherit=\"none\"");
    for (name, value) in [
        ("PATH", path.as_str()),
        (
            "HOME",
            temp_home
                .to_str()
                .ok_or_else(|| anyhow!("workspace path is not UTF-8"))?,
        ),
        (
            "TMPDIR",
            temp_dir
                .to_str()
                .ok_or_else(|| anyhow!("temporary path is not UTF-8"))?,
        ),
        ("LANG", "C.UTF-8"),
        ("LC_ALL", "C.UTF-8"),
        ("NO_COLOR", "1"),
    ] {
        command.arg("--config").arg(format!(
            "shell_environment_policy.set.{name}={}",
            serde_json::to_string(value)?
        ));
    }
    command.arg("--cd").arg(checkout).arg("-");
    Ok(command)
}

fn output_payload(
    project_id: &str,
    base_commit: &str,
    model: &str,
    effort: &str,
    execution_id: &str,
    summary: &str,
    patch_path: Option<&Path>,
    patch_hash: Option<&str>,
    changed_paths: &[String],
    status: &str,
) -> Value {
    json!({
        "schema":"ghost-code-worker-result/1",
        "execution_id":execution_id,
        "project_id":project_id,
        "base_commit":base_commit,
        "model":model,
        "reasoning_effort":effort,
        "status":status,
        "summary":summary,
        "changed_paths":changed_paths,
        "patch_path":patch_path.map(|path|path.display().to_string()),
        "patch_sha256":patch_hash,
    })
}

pub(crate) async fn execute(
    owner: &str,
    task_id: &str,
    call_id: &str,
    project_id: &str,
    prompt: &str,
    state_root: &Path,
) -> Result<ToolOutput> {
    if prompt.trim().is_empty() || prompt.len() > MAX_PROMPT_BYTES {
        bail!("code-worker prompt is empty or exceeds the 32 KiB limit");
    }
    let Some(executable) = executable() else {
        return Ok(ToolOutput::error(
            ToolStatus::Failed,
            "Codex code worker is not configured with an absolute executable path",
        ));
    };
    let Some(model) = model() else {
        return Ok(ToolOutput::error(
            ToolStatus::Failed,
            "Codex model is not configured",
        ));
    };
    let Some(effort) = reasoning_effort() else {
        return Ok(ToolOutput::error(
            ToolStatus::Failed,
            "Codex reasoning effort is not configured to a supported value",
        ));
    };
    let project = match registry()?
        .into_iter()
        .find(|project| project.id == project_id)
    {
        Some(project) => project,
        None => {
            return Ok(ToolOutput::error(
                ToolStatus::Denied,
                "project is not allowlisted for external code work",
            ))
        }
    };
    let executable_for_hash = executable.clone();
    let codex_sha256 = tokio::task::spawn_blocking(move || {
        std::fs::read(executable_for_hash).map(|bytes| format!("{:x}", Sha256::digest(bytes)))
    })
    .await
    .map_err(|_| anyhow!("Codex CLI fingerprint task failed"))??;
    let execution_id = execution_id(owner, task_id, call_id);
    let base = state_root.join("code-worker");
    let workspace_root = base.join("workspaces");
    let artifact_root = base.join("artifacts");
    make_private_dir(&base)?;
    make_private_dir(&workspace_root)?;
    make_private_dir(&artifact_root)?;
    artifact_capacity(&artifact_root)?;
    let temp = tempfile::Builder::new()
        .prefix(&format!("run-{execution_id}-"))
        .tempdir_in(&workspace_root)?;
    let run_root = temp.path().to_path_buf();
    let (checkout, base_commit) = match prepare_workspace(&project.path, &run_root).await {
        Ok(workspace) => workspace,
        Err(error) => {
            return Ok(ToolOutput::error(
                ToolStatus::Failed,
                format!("could not prepare a disposable committed workspace: {error}"),
            ));
        }
    };
    let temp_home = checkout.join(".ghost-home");
    let temp_dir = checkout.join(".ghost-tmp");
    make_private_dir(&temp_home)?;
    make_private_dir(&temp_dir)?;
    let final_path = checkout.join(".ghost-final-message.txt");
    let command = codex_command(
        &executable,
        &model,
        &effort,
        &checkout,
        &temp_home,
        &temp_dir,
        &final_path,
    )?;
    let output = run_process(
        command,
        Some(prompt.as_bytes()),
        CODEX_DEADLINE,
        MAX_STDOUT_BYTES,
        MAX_STDERR_BYTES,
    )
    .await;
    let (worker_status, timed_out) = match output {
        Ok(output) => (
            output.status.is_some_and(|status| status.success()),
            output.timed_out,
        ),
        Err(_) => (false, false),
    };
    // Never include task output in subprocess environment or persistent stderr.
    let summary = final_message(&final_path);
    let _ = safe_remove(&temp_home);
    let _ = safe_remove(&temp_dir);
    let _ = safe_remove(&final_path);
    let status = git_output(
        &checkout,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        1024 * 1024,
    )
    .await?;
    if !status.status.is_some_and(|status| status.success()) {
        return Ok(ToolOutput::error(
            ToolStatus::Uncertain,
            "Codex exited, but Ghost could not inspect its disposable workspace; no patch was saved",
        ));
    }
    let changed_paths = parse_changed_paths(&status.stdout);
    let mut patch = Vec::new();
    if !changed_paths.is_empty() {
        let added = git_output(&checkout, &["add", "--intent-to-add", "--all"], 32 * 1024).await?;
        if !added.status.is_some_and(|status| status.success()) {
            return Ok(ToolOutput::error(
                ToolStatus::Uncertain,
                "Codex changed files, but Ghost could not prepare a review patch; the disposable workspace was discarded",
            ));
        }
        let diff = git_output(
            &checkout,
            &[
                "diff",
                "--binary",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
            ],
            MAX_PATCH_BYTES,
        )
        .await?;
        if !diff.status.is_some_and(|status| status.success())
            || diff.stdout.len() > MAX_PATCH_BYTES
        {
            return Ok(ToolOutput::error(
                ToolStatus::Uncertain,
                "Ghost could not create a review patch within its size limit; the disposable workspace was discarded",
            ));
        }
        patch = diff.stdout;
    }
    let result_ok = worker_status && !timed_out;
    let created = now_ms();
    let mut artifact_refs = Vec::new();
    let mut patch_path = None;
    let mut patch_hash = None;
    if !patch.is_empty() {
        let hash = format!("{:x}", Sha256::digest(&patch));
        let path = artifact_root.join(format!("{execution_id}.patch"));
        let manifest_path = artifact_root.join(format!("{execution_id}.json"));
        let changed = changed_paths.clone();
        let manifest = ArtifactManifest {
            schema: "ghost-code-worker-artifact/1",
            execution_id: &execution_id,
            profile_id: owner,
            task_id,
            call_id,
            project_id,
            base_commit: &base_commit,
            model: &model,
            reasoning_effort: &effort,
            codex_sha256: &codex_sha256,
            created_ms: created,
            patch_sha256: &hash,
            patch_bytes: patch.len(),
            changed_paths: &changed,
            summary: &summary,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
        write_private(&path, &patch)?;
        if let Err(error) = write_private(&manifest_path, &manifest_bytes) {
            let _ = safe_remove(&path);
            return Err(error);
        }
        patch_hash = Some(hash);
        patch_path = Some(path.clone());
        artifact_refs.push(path.display().to_string());
        artifact_refs.push(manifest_path.display().to_string());
    }
    let payload = output_payload(
        project_id,
        &base_commit,
        &model,
        &effort,
        &execution_id,
        &summary,
        patch_path.as_deref(),
        patch_hash.as_deref(),
        &changed_paths,
        if result_ok {
            "completed"
        } else if timed_out {
            "uncertain"
        } else {
            "failed"
        },
    );
    let _ = safe_remove(&run_root);
    let mut result = if result_ok {
        ToolOutput::success(
            if patch_path.is_some() {
                "Codex completed in a disposable workspace; review the patch artifact before applying it"
            } else {
                "Codex completed in a disposable workspace and reported no source changes"
            },
            payload,
        )
    } else if timed_out {
        let mut result = ToolOutput::error(
            ToolStatus::Uncertain,
            "Codex exceeded the deadline; inspect the saved patch and do not retry this invocation blindly",
        );
        result.content = payload;
        result
    } else {
        let mut result = ToolOutput::error(
            ToolStatus::Failed,
            "Codex did not complete successfully; inspect any saved partial patch before retrying",
        );
        result.content = payload;
        result
    };
    result.artifacts = artifact_refs;
    Ok(result)
}
