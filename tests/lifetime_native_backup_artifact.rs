#![cfg(all(unix, feature = "lifetime"))]
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};
fn cli(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_ghost"))
        .arg("--root")
        .arg(root.join("unused-state"))
        .arg("recovery")
        .args(args)
        .output()
        .unwrap()
}
#[test]
fn public_native_backup_pack_unpack_cli_preserves_raw_sqlite_and_inner_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
    let source = base.join("source");
    fs::create_dir(&source).unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
    let path = source.join("brain.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE original(id TEXT PRIMARY KEY,value TEXT);INSERT INTO original VALUES('original-id','raw backup bytes');PRAGMA user_version=19;").unwrap();
    drop(db);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let bytes = fs::read(&path).unwrap();
    let manifest=serde_json::to_vec_pretty(&json!({"format":"oxibrain-backup/1","generation":"public-cli-preservation","created_at_utc_ms":1,"ledger_schema_version":19,"projection_version":1,"include_projection":false,"include_cache":false,"files":[{"path":"brain.db","bytes":bytes.len(),"blake3":blake3::hash(&bytes).to_hex().to_string()}],"exclusions":[]})).unwrap();
    fs::write(source.join("manifest.json"), &manifest).unwrap();
    fs::set_permissions(
        source.join("manifest.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let archive = base.join("native-backup.tar");
    let output = cli(
        &base,
        &[
            "pack-native-backup",
            "--source",
            source.to_str().unwrap(),
            "--destination",
            archive.to_str().unwrap(),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    fs::rename(&source, base.join("quarantined-original")).unwrap();
    let restored = base.join("restored");
    let output = cli(
        &base,
        &[
            "unpack-native-backup",
            "--archive",
            archive.to_str().unwrap(),
            "--sha256",
            receipt["archive_sha256"].as_str().unwrap(),
            "--destination",
            restored.to_str().unwrap(),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read(restored.join("brain.db")).unwrap(), bytes);
    assert_eq!(fs::read(restored.join("manifest.json")).unwrap(), manifest);
    let denied = cli(
        &base,
        &[
            "unpack-native-backup",
            "--archive",
            archive.to_str().unwrap(),
            "--sha256",
            &"0".repeat(64),
            "--destination",
            base.join("bad").to_str().unwrap(),
        ],
    );
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("archive digest mismatch"));
    assert!(!base.join("bad").exists());
    let help = cli(&base, &["pack-native-backup", "--help"]);
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("--source"));
}
