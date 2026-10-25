use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
fn private(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn fixture(base: &Path) -> PathBuf {
    fs::set_permissions(base, fs::Permissions::from_mode(0o700)).unwrap();
    let source = base.join("native");
    private(&source);
    let db = source.join("brain.db");
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute_batch("CREATE TABLE originals(id TEXT PRIMARY KEY,value TEXT); INSERT INTO originals VALUES('stable-id','exact original'); PRAGMA user_version=19;").unwrap();
    drop(connection);
    fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(
        source.join("documents.toml"),
        b"# original registered roots\n",
    )
    .unwrap();
    fs::set_permissions(
        source.join("documents.toml"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let files=["brain.db","documents.toml"].map(|name|{let bytes=fs::read(source.join(name)).unwrap();serde_json::json!({"path":name,"bytes":bytes.len(),"blake3":blake3::hash(&bytes).to_hex().to_string()})});
    fs::write(source.join("manifest.json"),serde_json::to_vec_pretty(&serde_json::json!({"format":"oxibrain-backup/1","generation":"detached-fixture","created_at_utc_ms":1,"ledger_schema_version":19,"projection_version":1,"include_projection":false,"include_cache":false,"files":files,"exclusions":[]})).unwrap()).unwrap();
    fs::set_permissions(
        source.join("manifest.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    source
}
#[test]
fn immutable_native_artifact_roundtrip_preserves_database_and_manifest_bytes() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let source = fixture(&base);
    let archive = base.join("native.tar");
    let receipt = pack(&source, &archive).unwrap();
    let again = base.join("again.tar");
    assert_eq!(
        pack(&source, &again).unwrap().archive_sha256,
        receipt.archive_sha256
    );
    fs::rename(&source, base.join("quarantined-native")).unwrap();
    let restored = base.join("restored");
    unpack(&archive, &receipt.archive_sha256, &restored).unwrap();
    for name in NAMES {
        assert_eq!(
            fs::read(base.join("quarantined-native").join(name)).unwrap(),
            fs::read(restored.join(name)).unwrap()
        );
    }
    assert!(unpack(&archive, &receipt.archive_sha256, &restored).is_err());
    assert!(unpack(&archive, &"0".repeat(64), &base.join("wrong-digest")).is_err());
    assert!(!base.join("wrong-digest").exists());
}
#[test]
fn immutable_native_artifact_refuses_links_inventory_schema_and_digest_conflicts() {
    for kind in ["symlink", "hardlink", "extra", "digest", "cache", "schema"] {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let source = fixture(&base);
        assert!(
            pack(&source, &base.join("positive.tar")).is_ok(),
            "positive control: {kind}"
        );
        match kind {
            "symlink" => {
                fs::rename(source.join("brain.db"), base.join("original.db")).unwrap();
                symlink(base.join("original.db"), source.join("brain.db")).unwrap();
            }
            "hardlink" => {
                fs::hard_link(source.join("brain.db"), base.join("alias.db")).unwrap();
            }
            "extra" => {
                fs::write(source.join("unknown"), b"refused").unwrap();
            }
            "digest" => {
                fs::write(source.join("brain.db"), b"changed bytes").unwrap();
            }
            "cache" | "schema" => {
                let path = source.join("manifest.json");
                let mut m: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                if kind == "cache" {
                    m["include_cache"] = true.into();
                } else {
                    m["ledger_schema_version"] = 20.into();
                }
                fs::write(path, serde_json::to_vec(&m).unwrap()).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(pack(&source, &base.join("rejected.tar")).is_err(), "{kind}");
        assert!(!base.join("rejected.tar").exists());
    }
}
fn checksum(header: &mut [u8]) {
    header[148..156].fill(b' ');
    let sum = header.iter().map(|v| *v as u64).sum();
    octal(&mut header[148..156], sum).unwrap();
}
#[test]
fn immutable_native_artifact_refuses_duplicate_traversal_types_padding_and_oversize() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let source = fixture(&base);
    let archive = base.join("valid.tar");
    pack(&source, &archive).unwrap();
    let valid = fs::read(&archive).unwrap();
    let (_, db_size) = parse_header(valid[..512].try_into().unwrap()).unwrap();
    let first_record = 512 + db_size.div_ceil(512) as usize * 512;
    let (second_name, second_size) =
        parse_header(valid[first_record..first_record + 512].try_into().unwrap()).unwrap();
    assert_eq!(second_name, "documents.toml");
    assert_ne!(second_size % 512, 0);
    for (kind, reason) in [
        ("traversal", "unexpected, nested or escaping archive entry"),
        ("symlink", "unsupported USTAR header/type"),
        ("hardlink", "unsupported USTAR header/type"),
        ("duplicate", "duplicate or excessive archive entry"),
        ("padding", "nonzero archive padding"),
        ("trailing", "trailing archive data refused"),
        ("oversize", "archive entry too large"),
        ("truncated", "failed to fill whole buffer"),
    ] {
        let mut bytes = valid.clone();
        match kind {
            "traversal" => {
                bytes[..512].copy_from_slice(&header("../brain.db", db_size).unwrap());
            }
            "symlink" | "hardlink" => {
                bytes[156] = if kind == "symlink" { b'2' } else { b'1' };
                checksum(&mut bytes[..512]);
            }
            "duplicate" => {
                let whole = bytes[..first_record].to_vec();
                bytes.splice(first_record..first_record, whole);
            }
            "padding" => bytes[first_record + 512 + second_size as usize] = 1,
            "trailing" => bytes.push(1),
            "oversize" => bytes[..512].copy_from_slice(&header("brain.db", LIMIT + 1).unwrap()),
            "truncated" => {
                bytes.truncate(300);
            }
            _ => unreachable!(),
        }
        let path = base.join(format!("{kind}.tar"));
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let error = unpack(
            &path,
            &format!("{:x}", Sha256::digest(&bytes)),
            &base.join(format!("bad-{kind}")),
        )
        .unwrap_err();
        assert!(error.to_string().contains(reason), "{kind}: {error}");
        assert!(!base.join(format!("bad-{kind}")).exists());
    }
}
#[test]
fn immutable_native_artifact_publication_refuses_leaf_and_parent_replacement() {
    use super::super::recovery_bundle::publish_private_staged_before_rename;
    for replace in ["leaf", "parent"] {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let parent = base.join("publication");
        private(&parent);
        let source = parent.join("staged");
        fs::write(&source, b"pinned bytes").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        let held = File::open(&source).unwrap();
        let m = fs::metadata(&parent).unwrap();
        let destination = parent.join("final");
        let error = publish_private_staged_before_rename(
            &source,
            &destination,
            &held,
            (m.dev(), m.ino()),
            || {
                if replace == "leaf" {
                    fs::rename(&source, parent.join("original"))?;
                    fs::write(&source, b"pinned bytes")?;
                    fs::set_permissions(&source, fs::Permissions::from_mode(0o600))?;
                } else {
                    fs::rename(&parent, base.join("quarantined-parent"))?;
                    private(&parent);
                    fs::write(&source, b"pinned bytes")?;
                }
                Ok(())
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains(if replace == "leaf" {
                "staged inode binding changed"
            } else {
                "parent binding changed"
            }),
            "{error}"
        );
        assert!(!destination.exists());
        assert!(!base.join("quarantined-parent/final").exists());
    }
}

#[test]
fn immutable_native_artifact_frozen_archive_proof_refuses_coordinated_stage_substitution() {
    for replace in ["directory", "valid-content"] {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let source = fixture(&base);
        let archive = base.join("valid.tar");
        let pin = pack(&source, &archive).unwrap();
        let destination = base.join("output");
        let error = unpack_inner(&archive, &pin.archive_sha256, &destination, |stage| {
            if replace == "directory" {
                fs::rename(&stage.path, base.join("quarantined-stage"))?;
                private(&stage.path);
                for name in NAMES {
                    fs::copy(source.join(name), stage.path.join(name))?;
                }
            } else {
                let path = stage.path.join("brain.db");
                fs::write(&path, b"different but consistently manifested backup")?;
                let manifest_path = stage.path.join("manifest.json");
                let mut manifest: serde_json::Value =
                    serde_json::from_slice(&fs::read(&manifest_path)?)?;
                let bytes = fs::read(&path)?;
                manifest["files"][0]["bytes"] = serde_json::json!(bytes.len());
                manifest["files"][0]["blake3"] =
                    serde_json::json!(blake3::hash(&bytes).to_hex().to_string());
                fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
            }
            // Both substituted inventories are internally valid. The original
            // trusted archive identity, not self-consistency, must refuse them.
            validate_files(&stage.path)?;
            Ok(())
        })
        .unwrap_err();
        assert!(
            error.to_string().contains(if replace == "directory" {
                "stage inode binding changed"
            } else {
                "trusted archive inventory"
            }),
            "{replace}: {error}"
        );
        assert!(!destination.exists());
    }
}
