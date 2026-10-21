//! Reviewable host operations. Backups use SQLite snapshots, never raw WAL
//! file copies. Restore always targets a new directory; external Spaces remain
//! external and are listed for the owner to back up separately.
use super::{now_ms, Host};
use crate::{adapters::documents::Space, store};
use anyhow::{anyhow, bail, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
    time::Duration,
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    format: String,
    complete: bool,
    created_ms: u64,
    files: Vec<BackupFile>,
    external_spaces: Vec<Space>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupFile {
    path: String,
    sha256: String,
}
fn digest(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut chunk = [0; 65536];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        hash.update(&chunk[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn integrity(path: &Path) -> Result<()> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let result: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if result != "ok" {
        bail!("backup database integrity failed");
    }
    Ok(())
}
fn sqlite_backup(source: &Connection, path: &Path) -> Result<()> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut target = Connection::open(path)?;
    {
        let backup = rusqlite::backup::Backup::new(source, &mut target)?;
        backup.run_to_completion(128, Duration::from_millis(5), None)?;
    }
    integrity(path)?;
    file.sync_all()?;
    Ok(())
}
fn manifest(path: &Path, backup: &Backup) -> Result<()> {
    // Only this newly created backup directory is replaced; fsync the result.
    let bytes = serde_json::to_vec_pretty(backup)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}
pub fn backup(app: &Host, destination: &Path) -> Result<Value> {
    if !destination.is_absolute() || destination.exists() || destination.is_symlink() {
        bail!("backup requires a new absolute directory");
    }
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow!("backup parent missing"))?
        .canonicalize()?;
    if parent.starts_with(&app.root) {
        bail!("place the backup outside the running host root");
    }
    let destination = parent.join(
        destination
            .file_name()
            .ok_or_else(|| anyhow!("backup name missing"))?,
    );
    fs::create_dir(&destination)?;
    let s = app.lock()?;
    let mut report = Backup {
        format: "ghost-backup/1".into(),
        complete: false,
        created_ms: now_ms(),
        files: vec![],
        external_spaces: s.journal.objects("space")?,
    };
    manifest(&destination.join("backup.json"), &report)?;
    fs::create_dir(destination.join("profiles"))?;
    for p in s.profiles.values() {
        store::validate_name(&p.name)?;
        let dir = destination.join("profiles").join(&p.name);
        fs::create_dir(&dir)?;
        sqlite_backup(
            &p.host
                .store
                .lock()
                .map_err(|_| anyhow!("profile unavailable"))?
                .conn,
            &dir.join("ghost.db"),
        )?;
        p.runtime.session.backup(dir.join("durable.db"))?;
        for name in ["ghost.db", "durable.db"] {
            let path = format!("profiles/{}/{name}", p.name);
            report.files.push(BackupFile {
                sha256: digest(&destination.join(&path))?,
                path,
            });
        }
        File::open(&dir)?.sync_all()?;
    }
    sqlite_backup(&s.journal.0, &destination.join("workspace.db"))?;
    report.files.push(BackupFile {
        path: "workspace.db".into(),
        sha256: digest(&destination.join("workspace.db"))?,
    });
    report.complete = true;
    manifest(&destination.join("backup.json"), &report)?;
    File::open(&destination)?.sync_all()?;
    File::open(parent)?.sync_all()?;
    Ok(
        json!({"destination":destination,"databases":report.files.len(),"external_spaces":report.external_spaces,"cross_database_atomic":false,"external_documents_copied":false}),
    )
}
fn safe_backup_file(root: &Path, relative: &str) -> Result<std::path::PathBuf> {
    let parts = Path::new(relative).components().collect::<Vec<_>>();
    if parts.iter().any(|p| !matches!(p, Component::Normal(_))) {
        bail!("invalid backup path");
    }
    if relative != "workspace.db" {
        if parts.len() != 3
            || parts[0].as_os_str() != "profiles"
            || !matches!(
                parts[2].as_os_str().to_str(),
                Some("ghost.db" | "durable.db")
            )
        {
            bail!("unexpected backup file");
        }
        store::validate_name(
            parts[1]
                .as_os_str()
                .to_str()
                .ok_or_else(|| anyhow!("invalid profile name"))?,
        )?;
    }
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
        if path.is_symlink() {
            bail!("backup symlink refused");
        }
    }
    Ok(path)
}
pub fn restore(source: &Path, destination: &Path) -> Result<Value> {
    if source.is_symlink()
        || !source.is_absolute()
        || !destination.is_absolute()
        || destination.exists()
        || destination.is_symlink()
    {
        bail!("restore requires an absolute backup and a new absolute root");
    }
    let source = source.canonicalize()?;
    let meta = source.join("backup.json");
    if meta.is_symlink() {
        bail!("backup manifest symlink refused");
    }
    let mut bytes = Vec::new();
    File::open(meta)?.take(1_048_577).read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        bail!("backup manifest size limit");
    }
    let report: Backup = serde_json::from_slice(&bytes)?;
    if report.format != "ghost-backup/1" || !report.complete || report.files.len() > 1025 {
        bail!("incomplete or unsupported backup");
    }
    let mut files = std::collections::BTreeSet::new();
    for f in &report.files {
        let path = safe_backup_file(&source, &f.path)?;
        if !files.insert(f.path.clone()) || digest(&path)? != f.sha256 {
            bail!("backup hash mismatch or duplicate file");
        }
        integrity(&path)?;
    }
    if !files.contains("workspace.db") {
        bail!("backup workspace database missing");
    }
    for path in &files {
        if path.starts_with("profiles/") {
            let alternate = if path.ends_with("ghost.db") {
                path.replace("ghost.db", "durable.db")
            } else {
                path.replace("durable.db", "ghost.db")
            };
            if !files.contains(&alternate) {
                bail!("incomplete profile backup");
            }
        }
    }
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow!("restore parent missing"))?
        .canonicalize()?;
    let destination = parent.join(
        destination
            .file_name()
            .ok_or_else(|| anyhow!("restore name missing"))?,
    );
    fs::create_dir(&destination)?;
    for f in &report.files {
        let path = destination.join(&f.path);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| anyhow!("restore directory missing"))?,
        )?;
        let db = Connection::open_with_flags(
            safe_backup_file(&source, &f.path)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        sqlite_backup(&db, &path)?;
        File::open(path.parent().unwrap())?.sync_all()?;
    }
    // The manifest distinguishes an interrupted restore from an untouched root.
    manifest(&destination.join("restored-from.json"), &report)?;
    File::open(&destination)?.sync_all()?;
    Ok(
        json!({"root":destination,"external_spaces":report.external_spaces,"pending_effects_require_normal_recovery":true}),
    )
}
pub fn service_spec(
    root: &Path,
    executable: &Path,
    port: u16,
    model: &str,
    platform: &str,
    headless: bool,
) -> Result<String> {
    service_spec_with_oxibrowser(root, executable, port, model, platform, headless, None)
}

pub fn service_spec_with_oxibrowser(
    root: &Path,
    executable: &Path,
    port: u16,
    model: &str,
    platform: &str,
    headless: bool,
    oxibrowser_executable: Option<&Path>,
) -> Result<String> {
    service_spec_with_tools(
        root,
        executable,
        port,
        model,
        platform,
        headless,
        oxibrowser_executable,
        None,
        None,
    )
}

pub fn service_spec_with_tools(
    root: &Path,
    executable: &Path,
    port: u16,
    model: &str,
    platform: &str,
    headless: bool,
    oxibrowser_executable: Option<&Path>,
    omp_executable: Option<&Path>,
    omp_model: Option<&str>,
) -> Result<String> {
    if !root.is_absolute()
        || !executable.is_absolute()
        || port == 0
        || model.is_empty()
        || [
            root.to_string_lossy().as_ref(),
            executable.to_string_lossy().as_ref(),
            model,
        ]
        .iter()
        .any(|v| v.chars().any(char::is_control))
    {
        bail!("service requires absolute paths, a fixed port, and printable model identifier");
    }
    if oxibrowser_executable.is_some_and(|path| {
        !path.is_absolute() || path.to_string_lossy().chars().any(char::is_control)
    }) {
        bail!("OxiBrowser requires an absolute executable path");
    }
    if omp_executable.is_some_and(|path| {
        !path.is_absolute() || path.to_string_lossy().chars().any(char::is_control)
    }) {
        bail!("OMP requires an absolute executable path");
    }
    if omp_executable.is_some() != omp_model.is_some() {
        bail!("configure both the OMP executable and provider/model, or neither");
    }
    if let Some(model) = omp_model {
        let valid = |part: &str| {
            !part.is_empty()
                && part.len() <= 120
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        };
        let Some((provider, model_id)) = model.split_once('/') else {
            bail!("OMP model must be a provider-qualified MiniMax Code model");
        };
        if provider != "minimax-code"
            || !valid(provider)
            || !valid(model_id)
            || model.starts_with('-')
        {
            bail!("OMP model must use the minimax-code subscription provider and a valid model id");
        }
    }
    let args = vec![
        executable.to_string_lossy().into_owned(),
        "--root".into(),
        root.to_string_lossy().into_owned(),
        "run".into(),
        "--port".into(),
        port.to_string(),
        "--model".into(),
        model.into(),
    ];
    let args = if headless {
        args
    } else {
        [args, vec!["--ui".into()]].concat()
    };
    match platform {
        "launchd" => {
            let escape = |v: &str| {
                v.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
                    .replace('\'', "&apos;")
            };
            let args = args
                .iter()
                .map(|v| format!("<string>{}</string>", escape(v)))
                .collect::<String>();
            let mut values = Vec::new();
            if let Some(path) = oxibrowser_executable {
                values.push((
                    "GHOST_OXIBROWSER_EXECUTABLE",
                    path.to_string_lossy().into_owned(),
                ));
            }
            if let Some(path) = omp_executable {
                values.push(("GHOST_OMP_EXECUTABLE", path.to_string_lossy().into_owned()));
            }
            if let Some(model) = omp_model {
                values.push(("GHOST_OMP_MODEL", model.to_string()));
            }
            let environment = if values.is_empty() {
                String::new()
            } else {
                format!(
                    "<key>EnvironmentVariables</key><dict>{}</dict>",
                    values
                        .iter()
                        .map(|(key, value)| format!(
                            "<key>{}</key><string>{}</string>",
                            escape(key),
                            escape(value)
                        ))
                        .collect::<String>()
                )
            };
            Ok(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.a7.ghost</string><key>ProgramArguments</key><array>{args}</array>{environment}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ProcessType</key><string>Background</string></dict></plist>\n"))
        }
        "systemd" => {
            let quote = |v: &str| {
                format!(
                    "\"{}\"",
                    v.replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('%', "%%")
                        .replace('$', "$$")
                )
            };
            let mut environment = String::new();
            if let Some(path) = oxibrowser_executable {
                environment.push_str(&format!(
                    "Environment=GHOST_OXIBROWSER_EXECUTABLE={}\n",
                    quote(&path.to_string_lossy())
                ));
            }
            if let Some(path) = omp_executable {
                environment.push_str(&format!(
                    "Environment=GHOST_OMP_EXECUTABLE={}\n",
                    quote(&path.to_string_lossy())
                ));
            }
            if let Some(model) = omp_model {
                environment.push_str(&format!("Environment=GHOST_OMP_MODEL={}\n", quote(model)));
            }
            Ok(format!("[Unit]\nDescription=Ghost durable host\n[Service]\nType=simple\nExecStart={}\n{}Restart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n[Install]\nWantedBy=default.target\n",args.iter().map(|v|quote(v)).collect::<Vec<_>>().join(" "),environment))
        }
        _ => bail!("choose launchd or systemd"),
    }
}
