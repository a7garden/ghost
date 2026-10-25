// Included inside the existing provisioning tests; no model or live service calls.
struct MemoryBotFixture {
    root: tempfile::TempDir,
    host: std::sync::Arc<Host>,
    c: Candidate,
    engine: std::path::PathBuf,
    _environment: crate::adapters::memory::tests::SourceEnvGuard,
}
async fn memory_bot_fixture(required: bool) -> MemoryBotFixture {
    let mut f = host_fixture();
    let command = "future-memory-bot";
    let plan = f
        .host
        .lifetime_action(&env(
            "plan-memory-bot",
            json!({"method":"bot.creation.plan","creation_command_id":command}),
        ))
        .unwrap();
    assert_eq!(plan["result"]["status"], "success", "{plan}");
    let planned = plan["result"]["data"].clone();
    let target = planned["ghost_id"].as_str().unwrap();
    let (brain, environment, engine, _) =
        crate::adapters::memory::tests::scoped_fixture(f.root.path(), target).await;
    f.host.brain = brain;
    f.host.pi_local_route = Some(host::lifetime_runtime::LocalPiRoute {
        base_url: "http://127.0.0.1:9/v1".into(),
        model_id: "fixture".into(),
        max_output_tokens: 1024,
        callback_token: "fixture".into(),
    });
    f.host
        .native_computers
        .as_mut()
        .unwrap()
        .pi_fixture_allow_private(&f.ghost)
        .unwrap();
    let configured=f.host.lifetime_action(&env("future-memory-configure",json!({"method":"work.memory.profile.configure","ghost_id":target,"binding_ids":["shared"],"required":required,"experience_space_id":null,"creation_command_id":command}))).unwrap();
    assert_eq!(configured["result"]["status"], "success", "{configured}");
    assert_eq!(configured["result"]["data"]["permission_granted"], false);
    assert!(!f.host.lock().unwrap().profiles.contains_key(target));
    assert!(f.host.lifetime_action(&env("conflicting-future-configure",json!({"method":"work.memory.profile.configure","ghost_id":target,"binding_ids":[],"required":false,"creation_command_id":command}))).unwrap()["ok"]==false);
    let text = "---\nprivacy: public\n---\nFollow the exact Owner procedure for each new input.";
    {
        let state = f.host.lock().unwrap();
        config(&state.journal.0);
        host::skills::save(
            &state,
            f.root.path(),
            "memory-bot-instruction",
            &f.ghost,
            "instructions",
            text,
            None,
        )
        .unwrap();
    }
    let mut prepared = {
        let state = f.host.lock().unwrap();
        prepared(&state.journal.0).0
    };
    prepared.command_id = command.into();
    prepared.correlation_id = command.into();
    prepared.body["content"]["instruction_ref"]["namespace"] = json!(f.ghost);
    prepared.body["content"]["instruction_ref"]["digest"] =
        json!(format!("{:x}", Sha256::digest(text.as_bytes())));
    prepared.body["content"]["memory_profile_ref"] =
        configured["result"]["data"]["profile_ref"].clone();
    prepared.payload_digest = canonical_digest(&prepared.body).unwrap();
    let response = f.host.lifetime_action(&prepared).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    let c = {
        let state = f.host.lock().unwrap();
        candidate(&state.journal.0, planned["candidate_id"].as_str().unwrap()).unwrap()
    };
    assert_eq!(c.definition.ghost_id, target);
    assert_eq!(c.privacy, "private");
    let evaluated = f
        .host
        .lifetime_action(&request("memory-bot-evaluate", "bot.evaluate", &c))
        .unwrap();
    assert_eq!(evaluated["result"]["status"], "success", "{evaluated}");
    let (work, assignment) = {
        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        let work = p.evaluation_work_id.unwrap();
        let assignment:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&work],|r|r.get(0)).unwrap();
        (work, assignment)
    };
    for (task, call, operation, args) in [
        (
            10,
            "write",
            "write",
            json!({"path":"bot-evaluation.json","content":String::from_utf8(bytes(&c)).unwrap()}),
        ),
        (
            11,
            "publish",
            "publish_artifact",
            json!({"path":"bot-evaluation.json","privacy":"private"}),
        ),
    ] {
        let mut e = env(
            &format!("memory-tool-{call}"),
            json!({"method":"work.execute","assignment_id":assignment,"work_id":work,"generation_task_id":7,"task_id":task,"call_id":call,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":args})).unwrap(),"arguments":args}),
        );
        e.actor_ref = f.ghost.clone();
        let response = f
            .host
            .lifetime_pi_execution_action(
                &lifetime::PiToolRequest {
                    context_ref: None, ghost_id: f.ghost.clone(),
                    conversation_id: f.conversation.clone(),
                    envelope: e,
                },
                lifetime::PiInferenceScope::Local,
            )
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    }
    let mut e = env(
        "memory-evaluation-complete",
        json!({"method":"work.execution.complete","assignment_id":assignment,"work_id":work,"task_id":7,"summary":"Independent exact fixture artifact"}),
    );
    e.actor_ref = f.ghost.clone();
    let response = f
        .host
        .lifetime_pi_execution_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: f.ghost.clone(),
                conversation_id: f.conversation.clone(),
                envelope: e,
            },
            lifetime::PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    f.host.verify_bot_evaluation(&c).unwrap();
    let provision = f
        .host
        .lifetime_action(&request("memory-bot-provision", "bot.provision", &c))
        .unwrap();
    assert_eq!(provision["result"]["status"], "success", "{provision}");
    let pending = {
        let state = f.host.lock().unwrap();
        lifetime::pending_outbox(&state.journal.0)
            .unwrap()
            .into_iter()
            .find(|o| {
                o.payload["body"]["method"] == "conversation.ensure"
                    && o.payload["body"]["ghost_id"] == c.definition.ghost_id
            })
            .unwrap()
    };
    let entry =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/ghost-durable/src/main.js");
    let mut pi = host::lifetime_runtime::PiProcess::start(
        &entry,
        &f.root.path().join("memory-pi"),
        f.root.path(),
        "fixture",
        "fixture-callback",
        1,
        None,
    )
    .await
    .unwrap();
    let receipt = pi
        .request(&serde_json::from_value(pending.payload).unwrap())
        .await
        .unwrap();
    pi.close().await.unwrap();
    {
        let state = f.host.lock().unwrap();
        lifetime::ack_outbox(
            &state.journal.0,
            pending.id,
            &serde_json::to_value(receipt).unwrap(),
        )
        .unwrap();
    }
    MemoryBotFixture {
        root: f.root,
        host: std::sync::Arc::new(f.host),
        c,
        engine,
        _environment: environment,
    }
}
fn memory_owner_policy(f: &MemoryBotFixture, allowed: bool) {
    let result = f
        .host
        .action(crate::control::api::Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: crate::control::api::Command::Workspace {
                action: crate::control::api::OwnerAction::Policy {
                    profile_id: f.c.definition.ghost_id.clone(),
                    policy: crate::domain::Policy {
                        memory: allowed,
                        ..Default::default()
                    },
                },
            },
        })
        .unwrap();
    assert_eq!(result["ok"], true, "{result}");
}
#[tokio::test]
async fn required_memory_future_owner_plan_live_auth_activation_and_definition_pin_survive_head_update(
) {
    let f = memory_bot_fixture(true).await;
    f.host.validate_bot_memory(&f.c).await.unwrap();
    assert!(f
        .host
        .lifetime_action(&request("memory-activate", "bot.activate", &f.c))
        .is_err());
    {
        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &f.c.id).unwrap();
        assert_eq!(p.state, "provisioning");
        assert_eq!(p.receipts["blocker"], "memory_permission_missing");
    }
    memory_owner_policy(&f, true);
    f.host.validate_bot_memory(&f.c).await.unwrap();
    let active = f
        .host
        .lifetime_action(&request("memory-activate", "bot.activate", &f.c))
        .unwrap();
    assert_eq!(active["result"]["status"], "success", "{active}");
    let original_pin = f.c.definition.content.memory_profile_ref.as_ref().unwrap();
    {
        let state = f.host.lock().unwrap();
        assert!(host::bots_memory::definition_current(&state.journal.0, &f.c.definition).unwrap());
        for field in ["owner", "revision", "digest"] {
            let mut wrong = original_pin.clone();
            match field {
                "owner" => wrong.namespace = f.c.id.clone(),
                "revision" => wrong.revision += 1,
                _ => wrong.digest = "f".repeat(64),
            };
            assert!(host::work_memory::resolve_definition_profile(
                &state.journal.0,
                &f.c.definition.ghost_id,
                &wrong
            )
            .is_err());
        }
    }
    let admit = |id: &str| {
        f.host.lifetime_action(&env(id,json!({"method":"goal.submit","ghost_id":f.c.definition.ghost_id,"conversation_id":f.c.conversation_id,"prompt":"Use exact pinned memory selection","privacy":"public","acceptance_spec":{}}))).unwrap()
    };
    let first = admit("memory-work-one");
    assert_eq!(first["result"]["status"], "success", "{first}");
    let w1: Work = serde_json::from_value(first["result"]["data"]["work"].clone()).unwrap();
    let raw_grant = |w: &Work| {
        let state = f.host.lock().unwrap();
        state
            .journal
            .0
            .query_row(
                "SELECT payload FROM workspace_objects WHERE kind='work_memory_grant_v1' AND id=?1",
                [format!("{}:{}:{}", w.id, w.goal_revision, w.owner_revision)],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
    };
    let before = raw_grant(&w1);
    let mut next = env(
        "memory-head-v2",
        json!({"method":"work.memory.profile.configure","ghost_id":f.c.definition.ghost_id,"binding_ids":[],"required":false,"experience_space_id":null}),
    );
    next.expected_revision = Some(1);
    assert_eq!(
        f.host.lifetime_action(&next).unwrap()["result"]["status"],
        "success"
    );
    assert_eq!(before, raw_grant(&w1));
    let second = admit("memory-work-two");
    assert_eq!(second["result"]["status"], "success", "{second}");
    let w2: Work = serde_json::from_value(second["result"]["data"]["work"].clone()).unwrap();
    let g2: Value = serde_json::from_str(&raw_grant(&w2)).unwrap();
    assert_eq!(g2["required"], true);
    assert_eq!(g2["profile"]["bindings"][0]["id"], "shared");
    // Reopen durable metadata at the same root: no inspection migration or v2 adoption.
    let reopened = Journal::open(&f.root.path().join("workspace.db")).unwrap();
    assert!(host::work_memory::resolve_definition_profile(
        &reopened.0,
        &f.c.definition.ghost_id,
        original_pin
    )
    .is_ok());
    assert_eq!(
        bots_store::definition_for_work(&reopened.0, &w1)
            .unwrap()
            .unwrap()
            .content
            .memory_profile_ref
            .as_ref(),
        Some(original_pin)
    );
    drop(reopened);
    let path = f.engine.join("grants.json");
    let original = std::fs::read(&path).unwrap();
    let mut grants: Value = serde_json::from_slice(&original).unwrap();
    grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token");
    std::fs::write(&path, serde_json::to_vec(&grants).unwrap()).unwrap();
    f.host.validate_bot_memory(&f.c).await.unwrap();
    {
        let state = f.host.lock().unwrap();
        assert!(!host::bots_memory::definition_current(&state.journal.0, &f.c.definition).unwrap());
        assert_eq!(raw_grant_no_lock(&state.journal.0, &w1), before);
    }
    // The engine fixture rejects an expired token on authentication, as native Oxibrain does.
    let script = f.engine.join("brain-fixture");
    let text = std::fs::read_to_string(&script).unwrap().replace(
        "if grant is None:deny(req);continue",
        "if grant is None or grant.get('expires_at',10**30)<time.time():deny(req);continue",
    );
    std::fs::write(&script, text).unwrap();
    let mut expired: Value = serde_json::from_slice(&original).unwrap();
    expired["shared-fixture-token"]["expires_at"] = json!(1);
    std::fs::write(&path, serde_json::to_vec(&expired).unwrap()).unwrap();
    f.host.validate_bot_memory(&f.c).await.unwrap();
    assert_eq!(
        host::bots_memory::readiness(&f.host.lock().unwrap().journal.0, &f.c, 1).unwrap()
            ["verified"],
        false
    );
    std::fs::write(&path, original).unwrap();
    f.host.validate_bot_memory(&f.c).await.unwrap();
    assert_eq!(
        host::bots_memory::readiness(&f.host.lock().unwrap().journal.0, &f.c, 1).unwrap()
            ["verified"],
        true
    );
}
fn raw_grant_no_lock(conn: &Connection, w: &Work) -> String {
    conn.query_row(
        "SELECT payload FROM workspace_objects WHERE kind='work_memory_grant_v1' AND id=?1",
        [format!("{}:{}:{}", w.id, w.goal_revision, w.owner_revision)],
        |r| r.get(0),
    )
    .unwrap()
}
#[tokio::test]
async fn optional_declared_memory_is_explicitly_degraded_without_permission_and_never_grants_read()
{
    let f = memory_bot_fixture(false).await;
    f.host.validate_bot_memory(&f.c).await.unwrap();
    let active = f
        .host
        .lifetime_action(&request("optional-memory-activate", "bot.activate", &f.c))
        .unwrap();
    assert_eq!(active["result"]["status"], "success", "{active}");
    assert_eq!(active["result"]["data"]["memory"]["state"], "degraded");
    assert_eq!(
        active["result"]["data"]["memory"]["reason"],
        "memory_permission_missing"
    );
    assert!(f
        .host
        .lock()
        .unwrap()
        .journal
        .get::<crate::domain::Policy>("policy", &f.c.definition.ghost_id)
        .unwrap()
        .is_none());
}
#[tokio::test]
async fn required_memory_exact_sixteen_first_hang_advances_cursor_and_cancel_prevents_late_proof() {
    let f = memory_bot_fixture(true).await;
    memory_owner_policy(&f, true);
    let mut ids = vec![];
    {
        let state = f.host.lock().unwrap();
        let original = progress(&state.journal.0, &f.c.id).unwrap();
        state.journal.0.execute("DELETE FROM workspace_objects WHERE kind IN ('bot_candidate_v1','bot_provisioning_v1') AND id=?1",[&f.c.id]).unwrap();
        for n in 1..=16 {
            let mut c = f.c.clone();
            c.id = uuid::Uuid::from_u128(n).to_string();
            c.digest = c.expected_digest().unwrap();
            let mut p = original.clone();
            p.candidate_id = c.id.clone();
            p.candidate_digest = c.digest.clone();
            p.operation_id = format!("bot-provision/1:{}", c.id);
            save(&state.journal.0, CANDIDATES, &c.id, &c).unwrap();
            save(&state.journal.0, PROGRESS, &c.id, &p).unwrap();
            ids.push(c.id);
        }
    }
    let script = f.engine.join("brain-fixture");
    let code=std::fs::read_to_string(&script).unwrap().replace("if method=='auth':","if method=='auth':\n  if (root/'hang-first-auth').exists():\n   (root/'hang-first-auth').unlink();(root/'auth-started').write_text('yes');time.sleep(60)");
    std::fs::write(&script, code).unwrap();
    std::fs::write(f.engine.join("hang-first-auth"), b"once").unwrap();
    let host = std::sync::Arc::clone(&f.host);
    let job = tokio::spawn(async move { host.advance_bot_memory_readiness().await });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !f.engine.join("auth-started").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    {
        let state = f.host.lock().unwrap();
        let cursor: Value = state
            .journal
            .get("bot_memory_readiness_cursor_v1", "workspace")
            .unwrap()
            .unwrap();
        assert_eq!(cursor["after"], ids[0]);
    }
    job.abort();
    assert!(job.await.unwrap_err().is_cancelled());
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_memory_readiness_v1'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    // Next pass begins at candidate2, rather than restarting the hung first.
    tokio::time::timeout(
        std::time::Duration::from_secs(8),
        f.host.advance_bot_memory_readiness(),
    )
    .await
    .unwrap()
    .unwrap();
    {
        let state = f.host.lock().unwrap();
        for id in ids.iter().skip(1) {
            let proof: Value = state
                .journal
                .get("bot_memory_readiness_v1", id)
                .unwrap()
                .unwrap();
            assert_eq!(proof["state"], "verified");
        }
    }
}
#[tokio::test]
async fn required_memory_corrupt_policy_is_operational_error_not_permission_absence() {
    let f = memory_bot_fixture(true).await;
    {
        let state = f.host.lock().unwrap();
        state.journal.0.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES('policy',?1,'invalid-json') ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",[&f.c.definition.ghost_id]).unwrap();
    }
    assert!(f.host.validate_bot_memory(&f.c).await.is_err());
    let state = f.host.lock().unwrap();
    assert!(state
        .journal
        .get::<Value>("bot_memory_readiness_v1", &f.c.id)
        .unwrap()
        .is_none());
}
#[tokio::test]
async fn required_memory_policy_revoked_during_auth_cannot_commit_stale_readiness() {
    let f = memory_bot_fixture(true).await;
    memory_owner_policy(&f, true);
    let script = f.engine.join("brain-fixture");
    let code = std::fs::read_to_string(&script).unwrap().replace(
        "if method=='auth':",
        "if method=='auth':\n  (root/'auth-started').write_text('yes');time.sleep(0.2)",
    );
    std::fs::write(&script, code).unwrap();
    let validation = f.host.validate_bot_memory(&f.c);
    let revoke = async {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !f.engine.join("auth-started").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        memory_owner_policy(&f, false);
    };
    let (validated, ()) = tokio::join!(validation, revoke);
    assert!(validated.is_err());
    let state = f.host.lock().unwrap();
    assert!(state
        .journal
        .get::<Value>("bot_memory_readiness_v1", &f.c.id)
        .unwrap()
        .is_none());
    assert_eq!(
        progress(&state.journal.0, &f.c.id).unwrap().state,
        "provisioning"
    );
    assert_eq!(
        host::bots_memory::readiness(&state.journal.0, &f.c, 1).unwrap()["reason"],
        "memory_permission_missing"
    );
}
