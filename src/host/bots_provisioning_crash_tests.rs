// Genuine child process loss; never synthesize a persisted interrupted phase.
mod crash_acceptance {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    const CHILD_TEST: &str =
        "host::bots_provisioning::tests::crash_acceptance::a03_external_phase_crash_child";

    fn environment_evidence(
        root: &std::path::Path,
        ghost: &str,
    ) -> Vec<(String, String, String, String, i64)> {
        let registry = Connection::open_with_flags(
            root.join("registry/computer-registry.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut query = registry.prepare(
            "SELECT b.computer_id,b.payload,h.layout_id,h.state,h.recorded_at_ms FROM computer_bindings b JOIN computer_home_layouts h ON h.computer_id=b.computer_id WHERE b.ghost_id=?1 ORDER BY b.computer_id",
        ).unwrap();
        let evidence = query
            .query_map([ghost], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        evidence
    }

    fn open_crashed_host(root: &std::path::Path, ghost: &str) -> Host {
        let profiles: BTreeMap<_, _> = crate::store::list_profiles(root)
            .unwrap()
            .into_iter()
            .map(|name| {
                let profile =
                    Host::profile(ProfileStore::open_profile(root, &name).unwrap()).unwrap();
                (profile.id.clone(), profile)
            })
            .collect();
        let journal = Journal::open(&root.join("workspace.db")).unwrap();
        let computers =
            host::lifetime_computers::NativeComputers::pi_fixture(&root.join("registry"), ghost)
                .unwrap();
        computers
            .restore_provisioned_pi_routes(&journal.0, &profiles)
            .unwrap();
        Host {
            root: root.to_path_buf(),
            state: Mutex::new(State { profiles, journal }),
            handle: tokio::runtime::Handle::current(),
            default_model: "mock".into(),
            _lock: host::WorkspaceLock(File::create(root.join("test.lock")).unwrap()),
            brain: crate::adapters::memory::Brain::default(),
            computer: crate::adapters::computer::default_backend(),
            integrations: host::integrations::Connections::default(),
            workers: Mutex::new(vec![]),
            profile_workers: Mutex::new(BTreeMap::new()),
            recovery: tokio::sync::Mutex::new(()),
            stopping: AtomicBool::new(false),
            legacy_fixture_reasoning: AtomicBool::new(false),
            dispatch_enabled: true,
            pi_callback_token: "fixture-callback".into(),
            pi_local_route: None,
            authority_epoch: 1,
            native_computers: Some(computers),
        }
    }

    #[tokio::test]
    #[ignore = "internal A03 abrupt-exit child; requires an explicit private parent root"]
    async fn a03_external_phase_crash_child() {
        let parent = std::path::PathBuf::from(
            std::env::var_os("GHOST_A03_CRASH_PARENT")
                .expect("only the A03 parent may invoke this"),
        );
        assert!(parent.is_absolute() && parent.is_dir());
        let stage = std::env::var("GHOST_A03_CRASH_STAGE").expect("explicit crash boundary");
        assert!(matches!(
            stage.as_str(),
            "profile" | "environment" | "environment_registry_commit"
        ));
        let (f, c) = repair_fixture().await;
        assert!(
            f.root.path().starts_with(&parent),
            "child must use only its private TMPDIR"
        );
        std::fs::write(
            parent.join("source.json"),
            serde_json::to_vec(&json!({
                "host_root":f.root.path(),"ghost_id":f.ghost,"conversation_id":f.conversation,
                "candidate":c,"owner_pid":std::process::id(),"stage":stage
            }))
            .unwrap(),
        )
        .unwrap();
        {
            let state = f.host.lock().unwrap();
            save(
                &state.journal.0,
                "bot_provisioning_test_fault",
                &c.id,
                &json!({"stage":stage,"behavior":"exit-process","parent_root":parent}),
            )
            .unwrap();
        }
        complete_repair_evaluation(&f, &c, true).await;
        panic!("post-{stage} process exit must happen before completion returns");
    }

    #[tokio::test]
    async fn a03_real_post_profile_crash_premature_activate_cannot_poison_original_recovery() {
        real_external_phase_crash("profile").await;
    }

    #[tokio::test]
    async fn a03_real_post_environment_crash_reconciles_original_home_without_duplicate_provisioning(
    ) {
        real_external_phase_crash("environment").await;
    }

    #[tokio::test]
    async fn a03_real_registry_home_commit_crash_preserves_unresolved_original_effect() {
        real_external_phase_crash("environment_registry_commit").await;
    }

    async fn real_external_phase_crash(stage: &str) {
        let interrupted_phase = if stage == "environment_registry_commit" {
            "environment"
        } else {
            stage
        };
        let parent = tempfile::tempdir().unwrap();
        let temporary = parent.path().join("source-temporary");
        std::fs::create_dir(&temporary).unwrap();
        let output = File::create(parent.path().join("source.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--ignored", "--nocapture"])
            .env("GHOST_A03_CRASH_PARENT", parent.path())
            .env("GHOST_A03_CRASH_STAGE", stage)
            .env("TMPDIR", &temporary)
            .env_remove("GHOST_LIFETIME_MODE")
            .env_remove("GHOST_PI_COMPUTERS_CONFIG")
            .env_remove("GHOST_LIFETIME_NATIVE_WORKERS_CONFIG")
            .env_remove("GHOST_LIFETIME_LOCAL_MODEL_URL")
            .env_remove("GHOST_LIFETIME_LOCAL_MODEL_ID")
            .env_remove("GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS")
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
        let exit = loop {
            if let Some(exit) = child.try_wait().unwrap() {
                break exit;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!(
                    "A03 child deadline exceeded: {}",
                    std::fs::read_to_string(parent.path().join("source.log")).unwrap()
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };
        assert_eq!(
            exit.code(),
            Some(73),
            "{}",
            std::fs::read_to_string(parent.path().join("source.log")).unwrap()
        );
        let source: Value =
            serde_json::from_slice(&std::fs::read(parent.path().join("source.json")).unwrap())
                .unwrap();
        assert_eq!(source["stage"], stage);
        let root = std::path::Path::new(source["host_root"].as_str().unwrap());
        let c: Candidate = serde_json::from_value(source["candidate"].clone()).unwrap();
        let original_route = {
            let journal = Journal::open(&root.join("workspace.db")).unwrap();
            load::<Value>(&journal.0, "pi_provisioned_route", &c.definition.ghost_id).unwrap()
        };
        assert_eq!(original_route.is_some(), stage == "environment");
        let original_environment = environment_evidence(root, &c.definition.ghost_id);
        assert_eq!(original_environment.len(), usize::from(stage != "profile"));
        let volume_names = || {
            let mut names: Vec<_> = std::fs::read_dir(root.join("registry/computers"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let original_volume_names = volume_names();
        let original_home_identity = original_environment.first().map(|environment| {
            let path = root
                .join("registry/computers")
                .join(&environment.0)
                .join("home");
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
            (path, metadata.dev(), metadata.ino())
        });
        let host = open_crashed_host(root, source["ghost_id"].as_str().unwrap());
        let original_home = (stage == "environment").then(|| {
            host.native_computers
                .as_ref()
                .unwrap()
                .pi_fixture_snapshot(&c.definition.ghost_id, "identity-only", 1)
                .unwrap()
        });
        let original = {
            let state = host.lock().unwrap();
            let p = progress(&state.journal.0, &c.id).unwrap();
            assert_eq!(p.state, "provisioning");
            assert_eq!(
                p.receipts["phases"][interrupted_phase]["certainty"],
                "started"
            );
            if stage == "profile" {
                assert!(p.receipts["phases"]["environment"].is_null());
            } else {
                assert_eq!(
                    p.receipts["phases"]["profile"]["certainty"],
                    "known_complete"
                );
                assert_eq!(
                    load::<Value>(
                        &state.journal.0,
                        "pi_provisioned_route",
                        &c.definition.ghost_id
                    )
                    .unwrap(),
                    original_route
                );
            }
            assert!(state.profiles.contains_key(&c.definition.ghost_id));
            p
        };
        let original_phase_source: (String, String) = {
            let state = host.lock().unwrap();
            state
                .journal
                .0
                .query_row(
                    "SELECT request,response FROM lifetime_commands WHERE command_id=?1",
                    [original.receipts["phases"][interrupted_phase]["command_id"]
                        .as_str()
                        .unwrap()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap()
        };
        let premature =
            host.lifetime_action(&request("a03-premature-owner-activate", "bot.activate", &c));
        {
            let state = host.lock().unwrap();
            assert_eq!(
                progress(&state.journal.0, &c.id).unwrap(),
                original,
                "premature activation must not alter the original phase ledger"
            );
            assert_eq!(
                state
                    .journal
                    .0
                    .query_row(
                        "SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_provisioned_route'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                i64::from(stage == "environment"),
                "premature activation must not create or replace an environment"
            );
            assert_eq!(state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_commands WHERE command_id='a03-premature-owner-activate'",
                [], |r| r.get::<_, i64>(0)).unwrap(), 0,
                "rejected activation must not manufacture a source receipt");
            assert_eq!(state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.ghost_id')=?1",
                [&c.definition.ghost_id], |r| r.get::<_, i64>(0)).unwrap(), 0);
        }
        let resumed = host.advance_bot_provisioning();
        let state = host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        assert!(resumed.is_ok(), "premature activation {premature:?} must not poison original recovery: {resumed:?}; progress={p:?}");
        if stage == "environment_registry_commit" {
            let error = premature
                .as_ref()
                .expect_err("unprepared activation must be rejected");
            assert!(
                error
                    .downcast_ref::<status::PrerequisiteUnavailable>()
                    .is_some(),
                "premature activation must fail only for its missing readiness proof: {error:#}"
            );
        }
        assert!(
            premature.is_err() || premature.as_ref().unwrap()["result"]["status"] == "error",
            "activation without a prepared/acknowledged runtime must be a no-effect rejection"
        );
        assert_eq!(p.operation_id, original.operation_id);
        assert_eq!(p.ghost_id, original.ghost_id);
        assert_eq!(p.candidate_digest, original.candidate_digest);
        assert_eq!(p.evaluation_work_id, original.evaluation_work_id);
        assert_eq!(candidate(&state.journal.0, &c.id).unwrap(), c);
        assert_eq!(p.state, "reconcile_required");
        assert_eq!(
            p.receipts["phases"][interrupted_phase]["certainty"],
            "started"
        );
        if stage == "profile" {
            assert!(p.receipts["phases"]["environment"].is_null());
        } else {
            assert_eq!(
                p.receipts["phases"]["profile"]["certainty"],
                "known_complete"
            );
            assert_eq!(
                load::<Value>(
                    &state.journal.0,
                    "pi_provisioned_route",
                    &c.definition.ghost_id
                )
                .unwrap(),
                original_route
            );
        }
        assert_eq!(state.profiles.len(), 2);
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM lifetime_registry WHERE ghost_id=?1",
                    [&c.definition.ghost_id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(state);
        // Repeated autonomous ticks do not reinterpret a started external phase
        // as permission to run it again, even when its home is observable.
        for _ in 0..3 {
            host.advance_bot_provisioning().unwrap();
            let state = host.lock().unwrap();
            assert_eq!(progress(&state.journal.0, &c.id).unwrap(), p);
            assert_eq!(
                load::<Value>(
                    &state.journal.0,
                    "pi_provisioned_route",
                    &c.definition.ghost_id
                )
                .unwrap(),
                original_route
            );
            assert_eq!(
                environment_evidence(root, &c.definition.ghost_id),
                original_environment
            );
        }
        // Explicit Owner reconciliation is allowed to observe the original
        // external effect; it must continue using the committed operation.
        let reconcile_id = format!("a03-owner-reconcile-{stage}");
        let reconcile = request(&reconcile_id, "bot.provision", &c);
        let reconciled = host.lifetime_action(&reconcile);
        if stage == "environment_registry_commit" {
            let (home_volume, home_dev, home_ino) = original_home_identity.as_ref().unwrap();
            let assert_reconciliation_required = |result: Result<Value>| {
                let error =
                    result.expect_err("an unrecorded route must remain explicitly unresolved");
                assert!(
                    error
                        .downcast_ref::<status::ReconciliationRequired>()
                        .is_some(),
                    "only the original phase ambiguity is expected, not another failure: {error:#}"
                );
                assert_eq!(
                    error.to_string(),
                    "original provisioning phase requires reconciliation"
                );
            };
            assert_reconciliation_required(reconciled);
            let assert_uncertain = |host: &Host| {
                let state = host.lock().unwrap();
                let current = progress(&state.journal.0, &c.id).unwrap();
                assert_eq!(current.state, "reconcile_required");
                assert_eq!(
                    current.receipts["blocker"],
                    "provisioning_effect_unconfirmed"
                );
                assert_eq!(current, p);
                assert_eq!(candidate(&state.journal.0, &c.id).unwrap(), c);
                let source: (String, String) = state
                    .journal
                    .0
                    .query_row(
                        "SELECT request,response FROM lifetime_commands WHERE command_id=?1",
                        [original.receipts["phases"]["environment"]["command_id"]
                            .as_str()
                            .unwrap()],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap();
                assert_eq!(source, original_phase_source);
                assert_eq!(state.profiles.len(), 2);
                assert_eq!(crate::store::list_profiles(root).unwrap().len(), 2);
                for sql in [
                    "SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_candidate_v1'",
                    "SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_provisioning_v1'",
                    "SELECT COUNT(*) FROM lifetime_pi_executions",
                ] {
                    assert_eq!(
                        state
                            .journal
                            .0
                            .query_row(sql, [], |r| r.get::<_, i64>(0))
                            .unwrap(),
                        1,
                        "{sql}"
                    );
                }
                for sql in ["SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_provisioned_route'",
                    "SELECT COUNT(*) FROM lifetime_registry WHERE kind='specialist'",
                    "SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.ensure'"] {
                    assert_eq!(state.journal.0.query_row(sql,[],|r|r.get::<_,i64>(0)).unwrap(),0,"{sql}");
                }
                assert!(host
                    .native_computers
                    .as_ref()
                    .unwrap()
                    .pi_computer(&c.definition.ghost_id)
                    .is_none());
                assert_eq!(
                    environment_evidence(root, &c.definition.ghost_id),
                    original_environment,
                    "the original registry binding/home must not be rebound, duplicated or deleted"
                );
                let metadata = std::fs::symlink_metadata(home_volume).unwrap();
                assert_eq!((metadata.dev(), metadata.ino()), (*home_dev, *home_ino));
                assert_eq!(volume_names(), original_volume_names);
            };
            assert_uncertain(&host);
            assert_reconciliation_required(host.lifetime_action(&reconcile));
            assert_uncertain(&host);
            let distinct_reconcile =
                request(&format!("{reconcile_id}-distinct"), "bot.provision", &c);
            assert_reconciliation_required(host.lifetime_action(&distinct_reconcile));
            assert_uncertain(&host);
            for _ in 0..3 {
                host.advance_bot_provisioning().unwrap();
                assert_uncertain(&host);
            }
            drop(host);
            let host = open_crashed_host(root, source["ghost_id"].as_str().unwrap());
            assert_uncertain(&host);
            assert_reconciliation_required(host.lifetime_action(&reconcile));
            assert_uncertain(&host);
            host.advance_bot_provisioning().unwrap();
            assert_uncertain(&host);
            return;
        }
        let reconciled = reconciled.unwrap();
        assert_eq!(reconciled["result"]["status"], "success", "{reconciled}");
        host.advance_bot_provisioning().unwrap();
        let state = host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        assert_eq!(p.operation_id, original.operation_id);
        assert_eq!(p.ghost_id, original.ghost_id);
        assert_eq!(p.state, "provisioning");
        assert_eq!(p.receipts["blocker"], "runtime_prepare_pending");
        assert_eq!(
            p.receipts["phases"][stage]["command_id"],
            original.receipts["phases"][stage]["command_id"]
        );
        assert_eq!(p.receipts["phases"][stage]["reconciled_by"], reconcile_id);
        assert_eq!(state.profiles.len(), 2);
        assert_eq!(crate::store::list_profiles(root).unwrap().len(), 2);
        assert_eq!(environment_evidence(root, &c.definition.ghost_id).len(), 1);
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM lifetime_registry WHERE ghost_id=?1",
                    [&c.definition.ghost_id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        if let Some(home) = original_home {
            assert_eq!(
                environment_evidence(root, &c.definition.ghost_id),
                original_environment
            );
            assert_eq!(
                host.native_computers
                    .as_ref()
                    .unwrap()
                    .pi_fixture_snapshot(&c.definition.ghost_id, "identity-only", 1)
                    .unwrap(),
                home
            );
            assert_eq!(
                load::<Value>(
                    &state.journal.0,
                    "pi_provisioned_route",
                    &c.definition.ghost_id
                )
                .unwrap(),
                original_route
            );
        }
        for stage in ["profile", "environment"] {
            assert_eq!(p.receipts["phases"][stage]["certainty"], "known_complete");
            let command = p.receipts["phases"][stage]["command_id"].as_str().unwrap();
            assert_eq!(
                state
                    .journal
                    .0
                    .query_row(
                        "SELECT COUNT(*) FROM lifetime_commands WHERE command_id=?1",
                        [command],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
        for sql in ["SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_candidate_v1'",
            "SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_provisioning_v1'",
            "SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_provisioned_route'",
            "SELECT COUNT(*) FROM lifetime_pi_executions",
            "SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.ensure'"] {
            assert_eq!(state.journal.0.query_row(sql, [], |r|r.get::<_,i64>(0)).unwrap(), 1, "{sql}");
        }
    }
}
