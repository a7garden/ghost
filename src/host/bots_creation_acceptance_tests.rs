// A02: one authenticated creation survives concurrent delivery and lost ACKs.
// All roots and execution transports are disposable; no model is called.
mod creation_acceptance {
    use super::*;

    fn race(host: &Host, requests: &[lifetime::PiToolRequest]) -> Vec<Response> {
        let barrier = std::sync::Barrier::new(requests.len());
        std::thread::scope(|scope| {
            let threads: Vec<_> = requests
                .iter()
                .map(|request| {
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        host.scoped_bot_action(request, lifetime::PiInferenceScope::Public)
                            .unwrap()
                    })
                })
                .collect();
            threads.into_iter().map(|t| t.join().unwrap()).collect()
        })
    }

    // Drop every Host/profile/journal/registry handle, then use the production
    // profile loader and dynamic-route restore path. Authority epoch stays 1:
    // epoch transfer and permission reacceptance are separate A19 coverage.
    fn reopen(f: HostFixture) -> HostFixture {
        let HostFixture {
            root,
            host,
            ghost,
            conversation,
        } = f;
        drop(host);
        let profiles: BTreeMap<_, _> = crate::store::list_profiles(root.path())
            .unwrap()
            .into_iter()
            .map(|name| {
                let profile =
                    Host::profile(ProfileStore::open_profile(root.path(), &name).unwrap()).unwrap();
                (profile.id.clone(), profile)
            })
            .collect();
        let journal = Journal::open(&root.path().join("workspace.db")).unwrap();
        let computers = host::lifetime_computers::NativeComputers::pi_fixture(
            &root.path().join("registry"),
            &ghost,
        )
        .unwrap();
        computers
            .restore_provisioned_pi_routes(&journal.0, &profiles)
            .unwrap();
        let app = Host {
            root: root.path().to_path_buf(),
            state: Mutex::new(State { profiles, journal }),
            handle: tokio::runtime::Handle::current(),
            default_model: "mock".into(),
            _lock: host::WorkspaceLock(File::create(root.path().join("test.lock")).unwrap()),
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
        };
        HostFixture {
            root,
            host: app,
            ghost,
            conversation,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a02_concurrent_creation_lost_runtime_ack_and_cold_host_reopen_keep_one_identity() {
        let mut f = host_fixture();
        config(&f.host.lock().unwrap().journal.0);
        owner_create_turn(&f, "이 요구사항으로 봇을 만들어줘");

        let prepare = scoped(&f, "a02-prepare", "bot.prepare", creation_args());
        let mut prepares = vec![prepare.clone(), prepare.clone()];
        for id in ["a02-prepare-retry-1", "a02-prepare-retry-2"] {
            prepares.push(scoped(&f, id, "bot.prepare", creation_args()));
        }
        let prepared = race(&f.host, &prepares);
        assert!(prepared.iter().all(|r| r.status == ResponseStatus::Success));
        assert!(prepared.iter().all(|r| r == &prepared[0]));
        let c = candidate(
            &f.host.lock().unwrap().journal.0,
            prepared[0].data["candidate_id"].as_str().unwrap(),
        )
        .unwrap();
        let initial = progress(&f.host.lock().unwrap().journal.0, &c.id).unwrap();

        let evaluate = scoped(
            &f,
            "a02-evaluate",
            "bot.evaluate",
            json!({"candidate_id":c.id,"candidate_digest":c.digest}),
        );
        let mut evaluations = vec![evaluate.clone(), evaluate.clone()];
        evaluations.push(scoped(
            &f,
            "a02-evaluate-retry",
            "bot.evaluate",
            json!({"candidate_id":c.id,"candidate_digest":c.digest}),
        ));
        let evaluated = race(&f.host, &evaluations);
        assert!(evaluated
            .iter()
            .all(|r| r.status == ResponseStatus::Success));
        let work = evaluated[0].data["evaluation_work_id"].clone();
        assert!(work.is_string());
        assert!(evaluated
            .iter()
            .all(|r| r.data["evaluation_work_id"] == work));
        let evaluate_receipt = f
            .host
            .scoped_bot_action(&evaluate, lifetime::PiInferenceScope::Public)
            .unwrap();
        complete_repair_evaluation(&f, &c, true).await;

        let pending = {
            let state = f.host.lock().unwrap();
            assert_eq!(
                progress(&state.journal.0, &c.id).unwrap().state,
                "provisioning"
            );
            lifetime::pending_outbox(&state.journal.0)
                .unwrap()
                .into_iter()
                .find(|item| {
                    item.payload["body"]["method"] == "conversation.ensure"
                        && item.payload["body"]["ghost_id"] == c.definition.ghost_id
                })
                .unwrap()
        };
        let command: Envelope = serde_json::from_value(pending.payload.clone()).unwrap();
        let home = f
            .host
            .native_computers
            .as_ref()
            .unwrap()
            .pi_fixture_snapshot(&c.definition.ghost_id, "identity-only", 1)
            .unwrap();
        let entry =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/ghost-durable/src/main.js");
        let pi_root = f.root.path().join("a02-pi");
        let mut pi = host::lifetime_runtime::PiProcess::start(
            &entry,
            &pi_root,
            f.root.path(),
            "fixture",
            "fixture-callback",
            1,
            None,
        )
        .await
        .unwrap();
        let lost = pi.request(&command).await.unwrap();
        assert_eq!(lost.status, ResponseStatus::Success);
        pi.close().await.unwrap();
        // Receiver has committed, but the Host never sees this first receipt.
        f.host.advance_bot_provisioning().unwrap();
        {
            let state = f.host.lock().unwrap();
            assert!(!status::runtime_ready(&state.journal.0, &c, 1).unwrap());
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
        }
        f = reopen(f);
        assert_eq!(
            f.host
                .scoped_bot_action(&prepare, lifetime::PiInferenceScope::Public)
                .unwrap(),
            prepared[0]
        );
        assert_eq!(
            f.host
                .scoped_bot_action(&evaluate, lifetime::PiInferenceScope::Public)
                .unwrap(),
            evaluate_receipt
        );
        f.host.advance_bot_provisioning().unwrap();
        {
            let state = f.host.lock().unwrap();
            let again = lifetime::pending_outbox(&state.journal.0)
                .unwrap()
                .into_iter()
                .find(|item| item.id == pending.id)
                .unwrap();
            assert_eq!(again, pending);
        }
        let mut pi = host::lifetime_runtime::PiProcess::start(
            &entry,
            &pi_root,
            f.root.path(),
            "fixture",
            "fixture-callback",
            1,
            None,
        )
        .await
        .unwrap();
        let recovered = pi.request(&command).await.unwrap();
        pi.close().await.unwrap();
        assert_eq!(
            serde_json::to_value(&recovered).unwrap(),
            serde_json::to_value(&lost).unwrap()
        );
        let receipt = serde_json::to_value(recovered).unwrap();
        {
            let state = f.host.lock().unwrap();
            lifetime::ack_outbox(&state.journal.0, pending.id, &receipt).unwrap();
            lifetime::ack_outbox(&state.journal.0, pending.id, &receipt).unwrap();
        }
        f.host.advance_bot_provisioning().unwrap();
        assert_eq!(
            progress(&f.host.lock().unwrap().journal.0, &c.id)
                .unwrap()
                .state,
            "ready"
        );
        let provision = request("a02-owner-provision", "bot.provision", &c);
        let activate = request("a02-owner-activate", "bot.activate", &c);
        let provision_receipt = f.host.lifetime_action(&provision).unwrap();
        let activate_receipt = f.host.lifetime_action(&activate).unwrap();
        f = reopen(f);
        assert_eq!(
            f.host.lifetime_action(&provision).unwrap(),
            provision_receipt
        );
        assert_eq!(f.host.lifetime_action(&activate).unwrap(), activate_receipt);
        f.host.advance_bot_provisioning().unwrap();

        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        assert_eq!(candidate(&state.journal.0, &c.id).unwrap(), c);
        assert_eq!(p.candidate_digest, initial.candidate_digest);
        assert_eq!(p.operation_id, initial.operation_id);
        assert_eq!(p.ghost_id, initial.ghost_id);
        assert_eq!(p.conversation_id, initial.conversation_id);
        assert_eq!(p.evaluation_work_id.as_deref(), work.as_str());
        assert_eq!(p.state, "ready");
        assert_eq!(state.profiles.len(), 2);
        assert_eq!(crate::store::list_profiles(f.root.path()).unwrap().len(), 2);
        assert_eq!(
            f.host
                .native_computers
                .as_ref()
                .unwrap()
                .pi_fixture_snapshot(&c.definition.ghost_id, "identity-only", 1)
                .unwrap(),
            home
        );
        for sql in [
            "SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_candidate_v1'",
            "SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_provisioning_v1'",
            "SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_provisioned_route'",
            "SELECT COUNT(*) FROM lifetime_registry WHERE kind='specialist' AND mode='active'",
            "SELECT COUNT(*) FROM lifetime_work",
            "SELECT COUNT(*) FROM lifetime_pi_executions",
            "SELECT COUNT(*) FROM lifetime_acceptances",
            "SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.ensure'",
            "SELECT COUNT(*) FROM lifetime_delivery_receipts",
        ] {
            assert_eq!(state.journal.0.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{sql}");
        }
        let index = Connection::open_with_flags(
            pi_root
                .join(format!(
                    "{:x}",
                    Sha256::digest(c.definition.ghost_id.as_bytes())
                ))
                .join("runtime.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        for sql in [
            "SELECT COUNT(*) FROM ghost_command_receipts",
            "SELECT COUNT(*) FROM ghost_conversations",
        ] {
            assert_eq!(
                index.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap(),
                1,
                "{sql}"
            );
        }
        let claimed: (String, String, u64) = index.query_row(
            "SELECT payload_digest,actor_ref,authority_epoch FROM ghost_command_receipts WHERE command_id=?1",
            [&command.command_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(
            claimed,
            (
                command.payload_digest,
                command.actor_ref,
                command.authority_epoch
            )
        );
        // Ensure re-inspects its stable mapping; its command claim, rather than
        // the query response, is durable on the receiver. The Host retains the
        // exact acknowledged response and accepts its duplicate ACK unchanged.
        let stored: String = state
            .journal
            .0
            .query_row(
                "SELECT payload FROM lifetime_delivery_receipts WHERE outbox_id=?1",
                [pending.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), receipt);
        assert!(f.host.profile_workers.lock().unwrap().is_empty());
    }
}
