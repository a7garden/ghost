// Distinct-root recovery acceptance. Only disposable fixture roots are selected.
mod restore_fixture {
    use super::*;
    use crate::operations::recovery_bundle::{
        self, BundleRequest, ComputerHomeBrowser, HomeBrowserManifest, ReleaseIdentity,
        RootPresence, RootSpec,
    };
    use std::{
        collections::BTreeMap,
        fs,
        path::{Path, PathBuf},
    };

    const CHILD_TEST: &str =
        "host::bots_provisioning::tests::restore_fixture::a19_source_process_stage";
    fn root(label: &str, role: &str, path: PathBuf, pid: u32) -> RootSpec {
        RootSpec {
            label: label.into(),
            role: role.into(),
            path,
            stopped_owner_pids: vec![pid.try_into().unwrap()],
            excluded_credential_paths: vec![],
            credential_references: vec![],
        }
    }
    fn bundle_request(source: &Value, pid: u32) -> BundleRequest {
        let host = PathBuf::from(source["host_root"].as_str().unwrap());
        let mut host_root = root("host", "host", host, pid);
        host_root.excluded_credential_paths = vec![
            "brain/grants.json".into(),
            "a19-broker-credential.json".into(),
        ];
        host_root.credential_references = vec![
            "a19-disposable-broker".into(),
            "a19-native-rotated-read-grant".into(),
        ];
        let mut roots = vec![host_root];
        for (field, label, role) in [
            ("documents_root", "documents", "pdc"),
            ("native_backup", "native-backup", "memory-backup"),
        ] {
            if let Some(path) = source[field].as_str() {
                roots.push(root(label, role, path.into(), pid));
            }
        }
        let homes = source["computers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| {
                let id = id.as_str().unwrap();
                ComputerHomeBrowser {
                    computer_id: id.into(),
                    home: RootPresence::Present {
                        root_label: "host".into(),
                        relative_path: format!("registry/computers/{id}/home"),
                    },
                    browser: RootPresence::Unallocated,
                }
            })
            .collect();
        BundleRequest {
            roots,
            host_label: "host".into(),
            release: ReleaseIdentity {
                source_revision: "a19-disposable-source-test".into(),
                dirty_snapshot_digest: format!(
                    "{:x}",
                    Sha256::digest(fs::read(std::env::current_exe().unwrap()).unwrap())
                ),
                component_digests: BTreeMap::from([(
                    "fixture-binary".into(),
                    format!(
                        "{:x}",
                        Sha256::digest(fs::read(std::env::current_exe().unwrap()).unwrap())
                    ),
                )]),
                schema_min: 9,
                schema_max: 16,
                protocol_revision: crate::lifetime_contract::VERSION.into(),
                pinned_runtime_versions: BTreeMap::from([("pi".into(), "1.1.0".into())]),
                image_references: vec![],
                config_digest: canonical_digest(&json!({"fixture":"a19"})).unwrap(),
            },
            home_browser_manifest: HomeBrowserManifest { computers: homes },
            external_document_references: vec!["a19-stopped-generation".into()],
        }
    }
    fn spawn_source(parent: &Path, mode: &str) -> (u32, Value) {
        let temporary = parent.join("source-temporary");
        fs::create_dir_all(&temporary).unwrap();
        let log = fs::File::create(parent.join("source.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--ignored", "--nocapture"])
            .env("GHOST_A19_SOURCE_PARENT", parent)
            .env("GHOST_A19_SOURCE_MODE", mode)
            .env("TMPDIR", &temporary)
            .env_remove("GHOST_LIFETIME_MODE")
            .env_remove("GHOST_PI_COMPUTERS_CONFIG")
            .env_remove("GHOST_LIFETIME_NATIVE_WORKERS_CONFIG")
            .env_remove("GHOST_LIFETIME_LOCAL_MODEL_URL")
            .env_remove("GHOST_LIFETIME_LOCAL_MODEL_ID")
            .env_remove("GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS")
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        let pid = child.id();
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(match mode {"native-sdk"=>360,"native"=>180,_=>60});
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("A19 source child deadline exceeded; source.log preserved, no capture attempted");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        assert!(
            status.success(),
            "A19 disposable source child failed; inspect source.log"
        );
        let receipt: Value =
            serde_json::from_slice(&fs::read(parent.join("source.json")).unwrap()).unwrap();
        assert_eq!(receipt["owner_pid"], pid);
        assert_eq!(
            unsafe { libc::kill(pid.try_into().unwrap(), 0) },
            -1,
            "source owner must have actually exited"
        );
        (pid, receipt)
    }
    fn artifact_snapshot(f: &HostFixture, c: &Candidate) -> Value {
        let state = f.host.lock().unwrap();
        let (execution, artifact) = evaluation_artifact(&state.journal.0, c).unwrap();
        json!({"execution_id":execution,"artifact":artifact,"candidate":c})
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "internal A19 source-stage subprocess; requires explicit private parent root"]
    async fn a19_source_process_stage() {
        let parent = PathBuf::from(
            std::env::var_os("GHOST_A19_SOURCE_PARENT")
                .expect("only explicit A19 child invocation"),
        );
        assert!(parent.is_absolute() && parent.is_dir());
        if std::env::var("GHOST_A19_SOURCE_MODE").is_ok_and(|mode|mode == "native" || mode == "native-sdk") {
            native_source_stage(&parent).await;
            return;
        }
        let (f, c) = lifecycle_fixture().await;
        let artifact = artifact_snapshot(&f, &c);
        f.host
            .lock()
            .unwrap()
            .journal
            .put("meta", "workspace_id", &uuid::Uuid::new_v4().to_string())
            .unwrap();
        let computers = f.host.native_computers.as_ref().unwrap();
        let primary = computers.pi_computer(&f.ghost).unwrap();
        let bot = computers.pi_computer(&c.definition.ghost_id).unwrap();
        let receipt = json!({"owner_pid":std::process::id(),"host_root":f.root.path(),"primary":f.ghost,"primary_conversation":f.conversation,"computers":[primary,bot],"snapshots":[artifact]});
        fs::write(
            f.root.path().join("a19-broker-credential.json"),
            b"A19_EXCLUDED_BROKER_SECRET",
        )
        .unwrap();
        f.host.shutdown().await.unwrap();
        let HostFixture { root, host, .. } = f;
        drop(host);
        let _preserved = root.keep();
        fs::write(
            parent.join("source.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
    }
    #[tokio::test]
    async fn a19_distinct_root_artifact_requires_explicit_mapping_after_old_tree_quarantine() {
        let parent = tempfile::tempdir().unwrap();
        let (_, mut environment, _, _) =
            crate::adapters::memory::tests::scoped_fixture(parent.path(), "a19-mapping").await;
        environment.capture_extra(&["GHOST_PI_ARTIFACT_RELOCATION_FILE"]);
        std::env::remove_var("GHOST_PI_ARTIFACT_RELOCATION_FILE");
        let (pid, source) = spawn_source(parent.path(), "component");
        let bundle = parent.path().join("bundle");
        recovery_bundle::create_bundle(&bundle_request(&source, pid), &bundle).unwrap();
        assert_eq!(
            recovery_bundle::verify_bundle(&bundle).unwrap()["complete"],
            true
        );
        let restored =
            recovery_bundle::restore_bundle(&bundle, &parent.path().join("restore")).unwrap();
        let original = PathBuf::from(source["host_root"].as_str().unwrap());
        fs::rename(&original, parent.path().join("quarantined-original-host")).unwrap();
        assert!(!original.exists());
        assert_eq!(restored.restored_authority_epoch, 2);
        assert!(!restored.dispatch_enabled);
        let snapshot = &source["snapshots"][0];
        let artifact: crate::lifetime_contract::Artifact =
            serde_json::from_value(snapshot["artifact"].clone()).unwrap();
        let root = restored.restored_roots["host"].join("pi-execution");
        let bytes = crate::worker::journal::read_verified_artifact(
            &root,
            snapshot["execution_id"].as_str().unwrap(),
            &artifact.digest,
            Path::new(&artifact.locator),
        );
        assert!(
            bytes.is_err(),
            "historical absolute locator cannot silently fall back to original root"
        );
        assert!(!restored.restored_roots["host"]
            .join("a19-broker-credential.json")
            .exists());
        let workspace: String = {
            let db = Journal::open(&restored.restored_roots["host"].join("workspace.db")).unwrap();
            db.get("meta", "workspace_id").unwrap().unwrap()
        };
        let mapping = crate::operations::pi_artifact_relocation::PiArtifactRelocation {
            version: "ghost-pi-artifact-relocation/1".into(),
            workspace_id: workspace,
            authority_epoch: 2,
            bundle_manifest_sha256: format!(
                "{:x}",
                Sha256::digest(fs::read(bundle.join("manifest.json")).unwrap())
            ),
            bundle_path: bundle.canonicalize().unwrap(),
            host_root_label: "host".into(),
            source_pi_root: original.join("pi-execution"),
            destination_pi_root: root.clone(),
        };
        let file = parent
            .path()
            .canonicalize()
            .unwrap()
            .join("pi-artifacts.json");
        write_mapping(&file, &mapping);
        std::env::set_var("GHOST_PI_ARTIFACT_RELOCATION_FILE", &file);
        let authority =
            Journal::open(&restored.restored_roots["host"].join("workspace.db")).unwrap();
        let historical_before = historical_rows(&authority.0);
        let read = || {
            crate::worker::journal::read_verified_pi_artifact(
                &restored.restored_roots["host"],
                &authority.0,
                snapshot["execution_id"].as_str().unwrap(),
                &artifact.digest,
                Path::new(&artifact.locator),
            )
        };
        let expected = read().unwrap();
        assert!(!expected.is_empty());
        let owner_host = Host::open(
            &restored.restored_roots["host"],
            tokio::runtime::Handle::current(),
            Some("mock"),
        )
        .unwrap();
        let original_candidate: Candidate =
            serde_json::from_value(snapshot["candidate"].clone()).unwrap();
        let work = progress(
            &owner_host.lock().unwrap().journal.0,
            &original_candidate.id,
        )
        .unwrap()
        .evaluation_work_id
        .unwrap();
        let mut request = env(
            "a19-owner-restored-artifact",
            json!({"method":"work.artifact","work_id":work,"execution_id":snapshot["execution_id"],"digest":artifact.digest,"locator":artifact.locator}),
        );
        request.authority_epoch = 2;
        let response = owner_host.lifetime_action(&request).unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        use base64::Engine;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(response["result"]["data"]["data"].as_str().unwrap())
                .unwrap(),
            expected
        );
        owner_host.shutdown().await.unwrap();
        drop(owner_host);
        let foreign = rusqlite::Connection::open_in_memory().unwrap();
        foreign.execute_batch("CREATE TABLE lifetime_authority(singleton INTEGER PRIMARY KEY,authority_epoch INTEGER);INSERT INTO lifetime_authority VALUES(1,2);CREATE TABLE workspace_objects(kind TEXT,id TEXT,payload TEXT);").unwrap();
        foreign
            .execute(
                "INSERT INTO workspace_objects VALUES('meta','workspace_id',?1)",
                [serde_json::to_string(&uuid::Uuid::new_v4().to_string()).unwrap()],
            )
            .unwrap();
        assert!(crate::worker::journal::read_verified_pi_artifact(
            &restored.restored_roots["host"],
            &foreign,
            snapshot["execution_id"].as_str().unwrap(),
            &artifact.digest,
            Path::new(&artifact.locator)
        )
        .is_err());
        for variant in [
            "workspace",
            "epoch",
            "hash",
            "label",
            "prefix",
            "destination",
            "version",
        ] {
            let mut changed = mapping.clone();
            match variant {
                "workspace" => changed.workspace_id = uuid::Uuid::new_v4().to_string(),
                "epoch" => changed.authority_epoch = 3,
                "hash" => changed.bundle_manifest_sha256 = "f".repeat(64),
                "label" => changed.host_root_label = "documents".into(),
                "prefix" => changed.source_pi_root = original.join("foreign/pi-execution"),
                "destination" => {
                    changed.destination_pi_root = restored.restored_roots["host"].clone()
                }
                _ => changed.version = "ghost-pi-artifact-relocation/2".into(),
            }
            write_mapping(&file, &changed);
            assert!(read().is_err(), "{variant}");
        }
        write_mapping(&file, &mapping);
        let escaped = Path::new(&artifact.locator)
            .parent()
            .unwrap()
            .join("../outside.json");
        assert!(crate::worker::journal::read_verified_pi_artifact(
            &restored.restored_roots["host"],
            &authority.0,
            snapshot["execution_id"].as_str().unwrap(),
            &artifact.digest,
            &escaped
        )
        .is_err());
        let relative = Path::new(&artifact.locator)
            .strip_prefix(&mapping.source_pi_root)
            .unwrap();
        let destination = root.join(relative);
        let before = fs::read(&destination).unwrap();
        fs::write(&destination, b"changed restored artifact").unwrap();
        assert!(read().is_err());
        fs::write(&destination, before).unwrap();
        assert_eq!(read().unwrap(), expected);
        let captured = bundle.join("roots/host/pi-execution").join(relative);
        let before = fs::read(&captured).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&captured, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&captured, b"changed captured artifact").unwrap();
        assert!(read().is_err());
        fs::write(&captured, before).unwrap();
        assert_eq!(read().unwrap(), expected);
        authority
            .0
            .execute(
                "UPDATE lifetime_authority SET authority_epoch=3 WHERE singleton=1",
                [],
            )
            .unwrap();
        assert!(read().is_err());
        authority
            .0
            .execute(
                "UPDATE lifetime_authority SET authority_epoch=2 WHERE singleton=1",
                [],
            )
            .unwrap();
        assert_eq!(read().unwrap(), expected);
        assert_eq!(
            historical_rows(&authority.0),
            historical_before,
            "read mapping must not rewrite historical pins/definitions/effect receipts"
        );
        let unsupported = parent.path().join("unsupported-schema");
        fs::create_dir(&unsupported).unwrap();
        fs::copy(
            restored.restored_roots["host"].join("workspace.db"),
            unsupported.join("workspace.db"),
        )
        .unwrap();
        let db = rusqlite::Connection::open(unsupported.join("workspace.db")).unwrap();
        db.pragma_update(None, "user_version", 17).unwrap();
        drop(db);
        let mut req = bundle_request(&json!({"host_root":unsupported,"computers":[]}), pid);
        req.release.schema_max = 17;
        let error = recovery_bundle::create_bundle(&req, &parent.path().join("unsupported-bundle"))
            .unwrap_err();
        assert!(
            error.to_string().contains("only schemas 9 through 16"),
            "{error:#}"
        );
    }
    fn historical_rows(conn: &rusqlite::Connection) -> Vec<String> {
        let mut out = Vec::new();
        for query in ["SELECT kind||':'||id||':'||payload FROM workspace_objects WHERE kind LIKE 'bot_definition%' OR kind LIKE 'work_memory_%' ORDER BY kind,id", "SELECT execution_id||':'||task_id||':'||call_id||':'||input_digest||':'||arguments_json||':'||state||':'||COALESCE(response_json,'') FROM lifetime_pi_effects ORDER BY execution_id,task_id,call_id"] {
            let mut q=conn.prepare(query).unwrap();out.extend(q.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap());
        }
        out
    }
    fn write_mapping(
        path: &Path,
        mapping: &crate::operations::pi_artifact_relocation::PiArtifactRelocation,
    ) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, serde_json::to_vec(mapping).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[test]
    fn a19_bound_reads_refuse_symlink_hardlink_and_replacement_during_delivery() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let parent = root.join("parent");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let file = parent.join("artifact.json");
        let saved = root.join("saved-artifact");
        fs::write(&file, b"immutable captured bytes").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let read = || crate::operations::recovery_bundle::read_private_bound_file(&file, 1024);
        assert_eq!(read().unwrap(), b"immutable captured bytes");
        fs::hard_link(&file, &saved).unwrap();
        assert!(read().is_err());
        fs::remove_file(&saved).unwrap();
        fs::rename(&file, &saved).unwrap();
        symlink(&saved, &file).unwrap();
        assert!(read().is_err());
        fs::remove_file(&file).unwrap();
        fs::rename(&saved, &file).unwrap();
        let replacement = crate::operations::recovery_bundle::read_private_bound_file_after_read(
            &file,
            1024,
            || {
                fs::rename(&file, &saved)?;
                fs::write(&file, b"immutable captured bytes")?;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
                Ok(())
            },
        );
        assert!(replacement.is_err());
        fs::remove_file(&file).unwrap();
        fs::rename(&saved, &file).unwrap();
        let old_parent = root.join("old-parent");
        let replacement = crate::operations::recovery_bundle::read_private_bound_file_after_read(
            &file,
            1024,
            || {
                fs::rename(&parent, &old_parent)?;
                fs::create_dir(&parent)?;
                fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))?;
                fs::write(&file, b"immutable captured bytes")?;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
                Ok(())
            },
        );
        assert!(replacement.is_err());
        fs::remove_dir_all(&parent).unwrap();
        fs::rename(&old_parent, &parent).unwrap();
        fs::rename(&parent, &old_parent).unwrap();
        symlink(&old_parent, &parent).unwrap();
        assert!(read().is_err());
    }
    #[cfg(all(feature = "memory", feature = "documents"))]
    include!("bots_restore_native_tests.rs");
    #[cfg(feature = "memory")]
    include!("bots_restore_sdk_tests.rs");
    #[cfg(not(all(feature = "memory", feature = "documents")))]
    async fn native_source_stage(_parent: &Path) {
        panic!("native A19 requires memory,documents features");
    }
}
