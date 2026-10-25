async fn lifecycle_finish_ready(f: &HostFixture, c: &Candidate) {
    for _ in 0..4 {
        let pending = {
            let state = f.host.lock().unwrap();
            if progress(&state.journal.0, &c.id).unwrap().state == "ready" {
                return;
            }
            lifetime::pending_outbox(&state.journal.0)
                .unwrap()
                .into_iter()
                .find(|v| {
                    v.payload["body"]["method"] == "conversation.ensure"
                        && v.payload["body"]["ghost_id"] == c.definition.ghost_id
                })
        };
        if let Some(pending) = pending {
            let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("apps/ghost-durable/src/main.js");
            let mut pi = super::super::lifetime_runtime::PiProcess::start(
                &entry,
                &f.root.path().join("lifecycle-pi"),
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
            let state = f.host.lock().unwrap();
            lifetime::ack_outbox(
                &state.journal.0,
                pending.id,
                &serde_json::to_value(receipt).unwrap(),
            )
            .unwrap();
        }
        f.host.advance_bot_provisioning().unwrap();
    }
    let state = f.host.lock().unwrap();
    assert_eq!(progress(&state.journal.0, &c.id).unwrap().state, "ready");
}
async fn lifecycle_fixture() -> (HostFixture, Candidate) {
    let (f, c) = repair_fixture().await;
    complete_repair_evaluation(&f, &c, true).await;
    lifecycle_finish_ready(&f, &c).await;
    (f, c)
}
fn lifecycle_prepare(
    f: &HostFixture,
    c: &Candidate,
    id: &str,
    clone: bool,
) -> (Envelope, Value, Candidate) {
    let pointer = bots_store::DefinitionPointer::from(&c.definition);
    let body = if clone {
        json!({"method":"bot.clone.prepare","ghost_id":c.definition.ghost_id,"definition_ref":pointer,"display_name":"cloned fixture"})
    } else {
        json!({"method":"bot.update.prepare","ghost_id":c.definition.ghost_id,"definition_ref":pointer,"instructions":format!("Exact replacement procedure {id}; no private source history")})
    };
    let command = env(id, body);
    let response = f.host.lifetime_action(&command).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    let state = f.host.lock().unwrap();
    let candidate = candidate(
        &state.journal.0,
        response["result"]["data"]["candidate_id"].as_str().unwrap(),
    )
    .unwrap();
    (command, response, candidate)
}
fn lifecycle_goal(f: &HostFixture, c: &Candidate, id: &str) -> Value {
    f.host.lifetime_action(&env(id,json!({"method":"goal.submit","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"prompt":"Independent new input","privacy":"public","acceptance_spec":{}}))).unwrap()
}
fn lifecycle_mode(
    f: &HostFixture,
    c: &Candidate,
    id: &str,
    mode: &str,
    expected: Option<u64>,
) -> Value {
    let mut e = env(
        id,
        json!({"method":"bot.lifecycle.set","ghost_id":c.definition.ghost_id,"mode":mode}),
    );
    e.expected_revision = expected;
    f.host.lifetime_action(&e).unwrap()
}
async fn lifecycle_execute(
    f: &HostFixture,
    c: &Candidate,
    work: &Work,
    id: &str,
    task: u64,
    operation: &str,
    args: Value,
) -> Result<Response> {
    let assignment = {
        let state = f.host.lock().unwrap();
        state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[&work.id],|r|r.get::<_,String>(0)).unwrap()
    };
    let mut e = env(
        id,
        json!({"method":"work.execute","assignment_id":assignment,"work_id":work.id,"generation_task_id":7,"task_id":task,"call_id":id,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":args})).unwrap(),"arguments":args}),
    );
    e.actor_ref = c.definition.ghost_id.clone();
    e.authority_epoch = f.host.authority_epoch;
    f.host
        .lifetime_pi_execution_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                conversation_id: c.conversation_id.clone(),
                envelope: e,
            },
            lifetime::PiInferenceScope::Public,
        )
        .await
}
#[tokio::test]
async fn lifecycle_update_is_evaluated_before_cas_and_old_work_keeps_immutable_assets() {
    let (f, old) = lifecycle_fixture().await;
    let admitted = lifecycle_goal(&f, &old, "old-work");
    assert_eq!(admitted["result"]["status"], "success", "{admitted}");
    let old_work: Work =
        serde_json::from_value(admitted["result"]["data"]["work"].clone()).unwrap();
    let (command, response, new) = lifecycle_prepare(&f, &old, "update-one", false);
    assert_eq!(new.definition.ghost_id, old.definition.ghost_id);
    assert_eq!(new.definition.revision, 2);
    assert_eq!(new.profile_name, old.profile_name);
    assert_eq!(new.conversation_id, old.conversation_id);
    assert_ne!(new.assets[0].content, old.assets[0].content);
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            bots_store::active_definition(&state.journal.0, &old.definition.ghost_id)
                .unwrap()
                .unwrap(),
            old.definition
        );
        assert_eq!(candidate(&state.journal.0, &old.id).unwrap(), old);
    }
    complete_repair_evaluation(&f, &new, true).await;
    lifecycle_finish_ready(&f, &new).await;
    assert_eq!(f.host.lifetime_action(&command).unwrap(), response);
    let admitted = lifecycle_goal(&f, &new, "new-work");
    assert_eq!(admitted["result"]["status"], "success", "{admitted}");
    let new_work: Work =
        serde_json::from_value(admitted["result"]["data"]["work"].clone()).unwrap();
    let state = f.host.lock().unwrap();
    assert_eq!(
        bots_store::active_definition(&state.journal.0, &new.definition.ghost_id)
            .unwrap()
            .unwrap(),
        new.definition
    );
    assert_eq!(
        bots_store::definition_for_work(&state.journal.0, &old_work)
            .unwrap()
            .unwrap(),
        old.definition
    );
    assert_eq!(
        assets_for_work(&state.journal.0, &old_work).unwrap()[0]["content"],
        old.assets[0].content
    );
    assert_eq!(
        assets_for_work(&state.journal.0, &new_work).unwrap()[0]["content"],
        new.assets[0].content
    );
    assert_eq!(state.profiles.len(), 2);
}
#[tokio::test]
async fn lifecycle_concurrent_updates_cannot_overwrite_the_first_accepted_revision() {
    let (f, old) = lifecycle_fixture().await;
    let (first_command, _, first) = lifecycle_prepare(&f, &old, "race-first", false);
    let second_response = f
        .host
        .lifetime_action(&env("race-second", first_command.body))
        .unwrap();
    assert_eq!(
        second_response["result"]["status"], "success",
        "{second_response}"
    );
    let second = {
        let state = f.host.lock().unwrap();
        candidate(
            &state.journal.0,
            second_response["result"]["data"]["candidate_id"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    assert_ne!(first.id, second.id);
    assert_eq!(first.definition, second.definition);
    complete_repair_evaluation(&f, &first, true).await;
    lifecycle_finish_ready(&f, &first).await;
    complete_repair_evaluation(&f, &second, true).await;
    f.host.advance_bot_provisioning().unwrap();
    let admitted = lifecycle_goal(&f, &first, "identical-race-new-work");
    assert_eq!(admitted["result"]["status"], "success", "{admitted}");
    let work: Work = serde_json::from_value(admitted["result"]["data"]["work"].clone()).unwrap();
    let state = f.host.lock().unwrap();
    assert_eq!(
        assets_for_work(&state.journal.0, &work).unwrap()[0]["content"],
        first.assets[0].content
    );
    assert_eq!(
        progress(&state.journal.0, &second.id).unwrap().state,
        "failed"
    );
    assert_eq!(
        progress(&state.journal.0, &second.id).unwrap().receipts["blocker"],
        "definition_conflict"
    );
    assert_eq!(
        bots_store::active_definition(&state.journal.0, &old.definition.ghost_id)
            .unwrap()
            .unwrap(),
        first.definition
    );
    assert_eq!(state.profiles.len(), 2);
}
#[tokio::test]
async fn lifecycle_clone_lost_ack_reopen_copies_only_definition_assets_to_one_new_identity() {
    let (f, old) = lifecycle_fixture().await;
    let secret = "synthetic-private-history-never-copy";
    let input=f.host.lifetime_action(&env("source-private-history",json!({"method":"conversation.input","ghost_id":old.definition.ghost_id,"conversation_id":old.conversation_id,"text":secret,"privacy":"local_only","attachments":[]}))).unwrap();
    assert_eq!(input["result"]["status"], "success", "{input}");
    let synthetic_credentials = f
        .root
        .path()
        .join("profiles")
        .join(&old.profile_name)
        .join("synthetic-credentials.fixture");
    std::fs::write(&synthetic_credentials, "SYNTHETIC_NOT_A_REAL_SECRET").unwrap();
    let (command, response, new) = lifecycle_prepare(&f, &old, "clone-one", true);
    assert_ne!(new.definition.ghost_id, old.definition.ghost_id);
    assert_ne!(new.conversation_id, old.conversation_id);
    assert_eq!(new.definition.revision, 1);
    assert_eq!(new.assets, old.assets);
    assert_eq!(new.definition.content, old.definition.content);
    assert!(new.source_work_ids.is_empty());
    assert_eq!(f.host.lifetime_action(&command).unwrap(), response);
    complete_repair_evaluation(&f, &new, true).await;
    lifecycle_finish_ready(&f, &new).await;
    assert_eq!(f.host.lifetime_action(&command).unwrap(), response);
    {
        let state = f.host.lock().unwrap();
        assert_eq!(state.profiles.len(), 3);
        assert!(!f
            .root
            .path()
            .join("profiles")
            .join(&new.profile_name)
            .join("synthetic-credentials.fixture")
            .exists());
        assert_eq!(
            std::fs::read_to_string(&synthetic_credentials).unwrap(),
            "SYNTHETIC_NOT_A_REAL_SECRET"
        );
        assert!(state.profiles[&new.definition.ghost_id]
            .runtime
            .session
            .committed()
            .unwrap()
            .conversations
            .is_empty());
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT count(*) FROM lifetime_turns WHERE ghost_id=?1 AND text=?2",
                    params![new.definition.ghost_id, secret],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        assert!(new.definition.content.memory_profile_ref.is_none());
    }
    let reopened = Journal::open(&f.root.path().join("workspace.db")).unwrap();
    assert_eq!(
        serde_json::to_value(lifetime::apply(&reopened.0, &command, "owner").unwrap()).unwrap(),
        response["result"]
    );
    assert_eq!(
        reopened
            .0
            .query_row(
                "SELECT count(*) FROM workspace_objects WHERE kind='bot_candidate_v1' AND id=?1",
                [&new.id],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn lifecycle_pause_resume_and_retire_deny_new_starts_but_keep_bound_work_and_history() {
    let (f, c) = lifecycle_fixture().await;
    let first = lifecycle_goal(&f, &c, "running-work");
    let running: Work = serde_json::from_value(first["result"]["data"]["work"].clone()).unwrap();
    let queued = lifecycle_goal(&f, &c, "queued-work");
    let queued: Work = serde_json::from_value(queued["result"]["data"]["work"].clone()).unwrap();
    assert_eq!(
        lifecycle_execute(
            &f,
            &c,
            &running,
            "bind-running",
            10,
            "write",
            json!({"path":"answer.txt","content":"started"})
        )
        .await
        .unwrap()
        .status,
        ResponseStatus::Success
    );
    let inspected = f
        .host
        .lifetime_action(&env(
            "initial-lifecycle-inspect",
            json!({"method":"bot.lifecycle.inspect","ghost_id":c.definition.ghost_id}),
        ))
        .unwrap();
    let initial_revision = inspected["result"]["data"]["expected_revision"].as_u64();
    assert!(initial_revision.is_none());
    assert_eq!(inspected["result"]["data"]["revision"], 0);
    assert_eq!(
        lifecycle_mode(&f, &c, "pause", "paused", initial_revision)["result"]["status"],
        "success"
    );
    assert_eq!(
        lifecycle_goal(&f, &c, "new-paused")["result"]["error_code"],
        "bot_unavailable"
    );
    assert!(lifecycle_execute(
        &f,
        &c,
        &queued,
        "paused-queued",
        10,
        "write",
        json!({"path":"must-not-exist","content":"denied"})
    )
    .await
    .is_err());
    assert_eq!(
        lifecycle_execute(
            &f,
            &c,
            &running,
            "paused-running",
            11,
            "write",
            json!({"path":"answer.txt","content":"continued during pause"})
        )
        .await
        .unwrap()
        .status,
        ResponseStatus::Success
    );
    assert_eq!(
        lifecycle_mode(&f, &c, "stale-resume", "active", None)["result"]["error_code"],
        "conflict"
    );
    assert_eq!(
        lifecycle_mode(&f, &c, "resume", "active", Some(1))["result"]["status"],
        "success"
    );
    assert_eq!(
        lifecycle_goal(&f, &c, "resumed-work")["result"]["status"],
        "success"
    );
    assert_eq!(
        lifecycle_mode(&f, &c, "retire", "retired", Some(2))["result"]["status"],
        "success"
    );
    assert_eq!(
        lifecycle_mode(&f, &c, "ordinary-retired-toggle", "active", Some(3))["result"]
            ["error_code"],
        "bot_retired"
    );
    assert_eq!(
        lifecycle_goal(&f, &c, "new-retired")["result"]["error_code"],
        "bot_unavailable"
    );
    assert_eq!(
        lifecycle_execute(
            &f,
            &c,
            &running,
            "retired-running",
            12,
            "publish_artifact",
            json!({"path":"answer.txt","privacy":"public"})
        )
        .await
        .unwrap()
        .status,
        ResponseStatus::Success
    );
    let assignment = {
        let state = f.host.lock().unwrap();
        state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[&running.id],|r|r.get::<_,String>(0)).unwrap()
    };
    let mut completion = env(
        "retired-running-complete",
        json!({"method":"work.execution.complete","assignment_id":assignment,"work_id":running.id,"task_id":7,"summary":"Bound Work finished after retirement; published artifact retained"}),
    );
    completion.actor_ref = c.definition.ghost_id.clone();
    assert_eq!(
        f.host
            .lifetime_pi_execution_action(
                &lifetime::PiToolRequest {
                    context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                    conversation_id: c.conversation_id.clone(),
                    envelope: completion
                },
                lifetime::PiInferenceScope::Public
            )
            .await
            .unwrap()
            .status,
        ResponseStatus::Success
    );
    let historical = f
        .host
        .lifetime_action(&env(
            "retired-historical-work",
            json!({"method":"work.inspect","work_id":running.id}),
        ))
        .unwrap();
    assert_eq!(historical["result"]["status"], "success", "{historical}");
    let state = f.host.lock().unwrap();
    let finished: String = state
        .journal
        .0
        .query_row(
            "SELECT state FROM lifetime_work WHERE id=?1",
            [&running.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(finished, "completed");
    let queued_execution: Option<String> = state
        .journal
        .0
        .query_row(
            "SELECT json_extract(payload,'$.execution_id') FROM lifetime_work WHERE id=?1",
            [&queued.id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(queued_execution.is_none());
    assert_eq!(
        bots_store::active_definition(&state.journal.0, &c.definition.ghost_id)
            .unwrap()
            .unwrap(),
        c.definition
    );
    assert_eq!(
        bots_store::definition_for_work(&state.journal.0, &running)
            .unwrap()
            .unwrap(),
        c.definition
    );
    assert_eq!(
        discover(
            &state.journal.0,
            &env(
                "roster-retired",
                json!({"method":"bot.discover","required_capabilities":[]})
            ),
            "owner"
        )
        .unwrap()
        .data["bots"],
        json!([])
    );
}
#[tokio::test]
async fn lifecycle_surface_is_source_scoped_fresh_and_available_while_dispatch_is_off() {
    let (mut f, c) = lifecycle_fixture().await;
    let command = env(
        "surface",
        json!({"method":"bot.surface.inspect","ghost_id":f.ghost,"conversation_id":f.conversation}),
    );
    let response = f.host.lifetime_action(&command).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    if let Ok(path) = std::env::var("GHOST_BOT_SURFACE_CONTRACT_OUT") {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&response["result"]["data"]).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(
        response["result"]["data"]["operations"][0]["source_turn_id"],
        "create-turn"
    );
    assert_eq!(
        response["result"]["data"]["bots"][0]["admission_allowed"],
        true
    );
    lifecycle_mode(&f, &c, "surface-pause", "paused", None);
    let refreshed = f.host.lifetime_action(&command).unwrap();
    assert_eq!(refreshed["result"]["data"]["bots"][0]["mode"], "paused");
    assert_eq!(
        refreshed["result"]["data"]["bots"][0]["admission_allowed"],
        false
    );
    let other = uuid::Uuid::new_v4().to_string();
    let invalid = f
        .host
        .lifetime_action(&env(
            "foreign-surface",
            json!({"method":"bot.surface.inspect","ghost_id":f.ghost,"conversation_id":other}),
        ))
        .unwrap();
    assert_eq!(invalid["ok"], false);
    let foreign_ghost = uuid::Uuid::new_v4().to_string();
    let foreign_conversation = uuid::Uuid::new_v4().to_string();
    {
        let state = f.host.lock().unwrap();
        let receipt=lifetime::apply(&state.journal.0,&env("foreign-registry",json!({"method":"registry.ensure","ghost_id":foreign_ghost,"conversation_id":foreign_conversation,"kind":"specialist","roles":[]})),"owner").unwrap();
        assert_eq!(receipt.status, ResponseStatus::Success);
    }
    let unrelated=f.host.lifetime_action(&env("unrelated-surface",json!({"method":"bot.surface.inspect","ghost_id":foreign_ghost,"conversation_id":foreign_conversation}))).unwrap();
    assert_eq!(unrelated["result"]["data"]["bots"], json!([]));
    assert_eq!(unrelated["result"]["data"]["operations"], json!([]));
    let mut forged = command.clone();
    forged.actor_ref = f.ghost.clone();
    assert_eq!(
        f.host.lifetime_action(&forged).unwrap()["result"]["error_code"],
        "unauthorized"
    );
    {
        let state = f.host.lock().unwrap();
        state
            .journal
            .0
            .execute(
                "UPDATE lifetime_authority SET dispatch_enabled=0 WHERE singleton=1",
                [],
            )
            .unwrap();
    }
    f.host.dispatch_enabled = false;
    assert_eq!(
        f.host.lifetime_action(&command).unwrap()["result"]["status"],
        "success"
    );
    f.host.native_computers = None;
    assert_eq!(
        f.host.lifetime_action(&command).unwrap()["result"]["data"]["bots"][0]["admission_allowed"],
        false
    );
}

#[tokio::test]
async fn lifecycle_failed_update_preserves_selected_ready_definition_and_policy_change_removes_readiness(
) {
    let (f, old) = lifecycle_fixture().await;
    let (_, _, failed) = lifecycle_prepare(&f, &old, "failed-update", false);
    complete_repair_evaluation(&f, &failed, false).await;
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            progress(&state.journal.0, &failed.id).unwrap().state,
            "failed"
        );
        assert_eq!(
            bots_store::active_definition(&state.journal.0, &old.definition.ghost_id)
                .unwrap()
                .unwrap(),
            old.definition
        );
        assert!(super::super::bot_lifecycle::admission_allowed(
            &state.journal.0,
            &old.definition.ghost_id
        )
        .unwrap());
        state.journal.0.execute("UPDATE lifetime_verification_policy SET policy_revision=policy_revision+1 WHERE singleton=1",[]).unwrap();
        assert!(!super::super::bot_lifecycle::admission_allowed(
            &state.journal.0,
            &old.definition.ghost_id
        )
        .unwrap());
        assert!(discovery_records(&state.journal.0, &[], true)
            .unwrap()
            .is_empty());
    }
    let surfaced=f.host.lifetime_action(&env("changed-policy-surface",json!({"method":"bot.surface.inspect","ghost_id":f.ghost,"conversation_id":f.conversation}))).unwrap();
    assert_eq!(
        surfaced["result"]["data"]["bots"][0]["admission_allowed"],
        false
    );
    assert_eq!(
        lifecycle_goal(&f, &old, "changed-policy-new-work")["result"]["error_code"],
        "bot_unavailable"
    );
}

#[tokio::test]
async fn lifecycle_assignment_rechecks_owner_target_and_recovers_after_a_rejected_scope() {
    let (f, old) = lifecycle_fixture().await;
    let (_, _, new) = lifecycle_prepare(&f, &old, "bound-owner-target", false);
    let (assignment, original) = {
        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &new.id).unwrap();
        let assignment:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[p.evaluation_work_id],|r|r.get(0)).unwrap();
        let original:String=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind='bot_candidate_target_v1' AND id=?1",[&new.id],|r|r.get(0)).unwrap();
        let mut corrupted: Value = serde_json::from_str(&original).unwrap();
        corrupted["source_digest"] = json!("f".repeat(64));
        state.journal.0.execute("UPDATE workspace_objects SET payload=?1 WHERE kind='bot_candidate_target_v1' AND id=?2",params![corrupted.to_string(),new.id]).unwrap();
        (assignment, original)
    };
    for (id, restored) in [
        ("changed-owner-target", false),
        ("restored-owner-target", true),
    ] {
        if restored {
            let state = f.host.lock().unwrap();
            state.journal.0.execute("UPDATE workspace_objects SET payload=?1 WHERE kind='bot_candidate_target_v1' AND id=?2",params![original,new.id]).unwrap();
        }
        let mut envelope = env(
            id,
            json!({"method":"conversation.assignment.inspect","assignment_id":assignment,"ghost_id":f.ghost,"conversation_id":f.conversation}),
        );
        envelope.actor_ref = f.ghost.clone();
        let response = f
            .host
            .lifetime_pi_action(
                &lifetime::PiToolRequest {
                    context_ref: None, ghost_id: f.ghost.clone(),
                    conversation_id: f.conversation.clone(),
                    envelope,
                },
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        if restored {
            assert_eq!(response["result"]["status"], "success", "{response}");
        } else {
            assert_eq!(response["ok"], false, "{response}");
            assert!(response["error"]
                .as_str()
                .unwrap()
                .contains("immutable Owner source reference"));
        }
    }
    let state = f.host.lock().unwrap();
    assert_eq!(state.journal.0.query_row("SELECT count(*) FROM lifetime_pi_effects e JOIN lifetime_pi_executions x ON x.execution_id=e.execution_id WHERE x.work_id=?1",[progress(&state.journal.0,&new.id).unwrap().evaluation_work_id],|r|r.get::<_,u64>(0)).unwrap(),0);
}

#[tokio::test]
async fn lifecycle_reopen_keeps_accepted_definition_evidence_but_requires_current_host_and_home_authority(
) {
    let (mut f, c) = lifecycle_fixture().await;
    let old_goal = lifecycle_goal(&f, &c, "old-epoch-queued");
    let old_work: Work =
        serde_json::from_value(old_goal["result"]["data"]["work"].clone()).unwrap();
    let assignment = {
        let state = f.host.lock().unwrap();
        state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[&old_work.id],|r|r.get::<_,String>(0)).unwrap()
    };
    let args = json!({"path":"stale-must-not-exist.txt","content":"never written"});
    let mut envelope = env(
        "fenced-old-callback",
        json!({"method":"work.execute","assignment_id":assignment,"work_id":old_work.id,"generation_task_id":7,"task_id":10,"call_id":"fenced-old-call","operation":"write","input_digest":canonical_digest(&json!({"operation":"write","arguments":args})).unwrap(),"arguments":args}),
    );
    envelope.actor_ref = c.definition.ghost_id.clone();
    let old_callback = lifetime::PiToolRequest {
        context_ref: None, ghost_id: c.definition.ghost_id.clone(),
        conversation_id: c.conversation_id.clone(),
        envelope,
    };
    {
        let state = f.host.lock().unwrap();
        state
            .journal
            .0
            .execute(
                "UPDATE lifetime_authority SET authority_epoch=2 WHERE singleton=1",
                [],
            )
            .unwrap();
    }
    assert_eq!(
        lifecycle_goal(&f, &c, "fenced-old-owner")["result"]["error_code"],
        "authority_fenced"
    );
    assert_eq!(
        f.host
            .lifetime_pi_action(&old_callback, lifetime::PiInferenceScope::Public)
            .await
            .unwrap()["result"]["error_code"],
        "authority_fenced"
    );
    let old = f.host.native_computers.take().unwrap();
    let original_home = old
        .pi_fixture_snapshot(&c.definition.ghost_id, "identity-only", 1)
        .unwrap();
    old.pi_fixture_accept_next_epoch().unwrap();
    assert!(!old
        .pi_available(&c.definition.ghost_id, 1, "public")
        .unwrap());
    assert!(!old
        .pi_available(&c.definition.ghost_id, 2, "public")
        .unwrap());
    drop(old);
    let current = host::lifetime_computers::NativeComputers::pi_fixture_at(
        &f.root.path().join("registry"),
        &f.ghost,
        2,
    )
    .unwrap();
    assert!(!current
        .pi_available(&c.definition.ghost_id, 2, "public")
        .unwrap());
    f.host.authority_epoch = 2;
    f.host.native_computers = Some(current);
    let mut source = env(
        "current-source-surface",
        json!({"method":"bot.surface.inspect","ghost_id":f.ghost,"conversation_id":f.conversation}),
    );
    source.authority_epoch = 2;
    assert_eq!(
        f.host.lifetime_action(&source).unwrap()["result"]["data"]["bots"][0]["admission_allowed"],
        false
    );
    let current = f.host.native_computers.take().unwrap();
    {
        let mut state = f.host.lock().unwrap();
        state.journal = Journal::open(&f.root.path().join("workspace.db")).unwrap();
        current
            .restore_provisioned_pi_routes(&state.journal.0, &state.profiles)
            .unwrap();
        assert_eq!(
            progress(&state.journal.0, &c.id).unwrap().receipts["resources"]["authority_epoch"],
            1
        );
    }
    assert_eq!(
        current
            .pi_fixture_snapshot(&c.definition.ghost_id, "identity-only", 2)
            .unwrap(),
        original_home
    );
    f.host.native_computers = Some(current);
    f.host.authority_epoch = 2;
    assert_eq!(
        f.host
            .lifetime_pi_action(&old_callback, lifetime::PiInferenceScope::Public)
            .await
            .unwrap()["result"]["error_code"],
        "authority_fenced"
    );
    let surfaced = f.host.lifetime_action(&source).unwrap();
    assert_eq!(
        surfaced["result"]["data"]["bots"][0]["admission_allowed"], true,
        "{surfaced}"
    );
    let mut request = env(
        "current-epoch-new-work",
        json!({"method":"goal.submit","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"prompt":"New current epoch input","privacy":"public","acceptance_spec":{}}),
    );
    request.authority_epoch = 2;
    let admitted = f.host.lifetime_action(&request).unwrap();
    assert_eq!(admitted["result"]["status"], "success", "{admitted}");
    let work: Work = serde_json::from_value(admitted["result"]["data"]["work"].clone()).unwrap();
    assert_eq!(
        lifecycle_execute(
            &f,
            &c,
            &work,
            "current-epoch-write",
            10,
            "write",
            json!({"path":"answer.txt","content":"current accepted home"})
        )
        .await
        .unwrap()
        .status,
        ResponseStatus::Success
    );
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            bots_store::definition_for_work(&state.journal.0, &work)
                .unwrap()
                .unwrap(),
            c.definition
        );
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT count(*) FROM lifetime_pi_effects WHERE call_id='fenced-old-call'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        state.journal.0.execute("UPDATE lifetime_verification_policy SET policy_revision=policy_revision+1 WHERE singleton=1",[]).unwrap();
    }
    assert_eq!(
        f.host.lifetime_action(&source).unwrap()["result"]["data"]["bots"][0]["admission_allowed"],
        false
    );
    request.command_id = "changed-policy-current-work".into();
    assert_eq!(
        f.host.lifetime_action(&request).unwrap()["result"]["error_code"],
        "bot_unavailable"
    );
}
