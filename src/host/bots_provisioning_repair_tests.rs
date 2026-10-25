async fn repair_fixture() -> (HostFixture, Candidate) {
    let f = host_fixture();
    {
        let state = f.host.lock().unwrap();
        config(&state.journal.0);
    }
    owner_create_turn(&f, "이 요구사항으로 봇을 만들어줘");
    let prepared = f
        .host
        .lifetime_pi_action(
            &scoped(&f, "repair-prepare", "bot.prepare", creation_args()),
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    let c = {
        let state = f.host.lock().unwrap();
        candidate(
            &state.journal.0,
            prepared["result"]["data"]["candidate_id"].as_str().unwrap(),
        )
        .unwrap()
    };
    let evaluated = f
        .host
        .lifetime_pi_action(
            &scoped(
                &f,
                "repair-evaluate",
                "bot.evaluate",
                json!({"candidate_id":c.id,"candidate_digest":c.digest}),
            ),
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(evaluated["result"]["status"], "success", "{evaluated}");
    (f, c)
}
async fn complete_repair_evaluation(f: &HostFixture, c: &Candidate, valid: bool) {
    let (work, assignment) = {
        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        let work = p.evaluation_work_id.unwrap();
        let assignment:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&work],|r|r.get(0)).unwrap();
        (work, assignment)
    };
    let mut content: Value = serde_json::from_slice(&bytes(c)).unwrap();
    if !valid {
        content["cases"][0]["output"] = json!({"wrong":"serialized object"});
    }
    for (task, call, operation, args) in [
        (
            10,
            "write",
            "write",
            json!({"path":"bot-evaluation.json","content":serde_json::to_string(&content).unwrap()}),
        ),
        (
            11,
            "publish",
            "publish_artifact",
            json!({"path":"bot-evaluation.json","privacy":"public"}),
        ),
    ] {
        let mut e = env(
            &format!("repair-tool-{}-{call}", c.id),
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
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    }
    let mut e = env(
        &format!("repair-complete-{}", c.id),
        json!({"method":"work.execution.complete","assignment_id":assignment,"work_id":work,"task_id":7,"summary":"Candidate fixture output published"}),
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
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    f.host.advance_bot_provisioning().unwrap();
}
fn candidate_report(f: &HostFixture, c: &Candidate) -> String {
    let state = f.host.lock().unwrap();
    let p = progress(&state.journal.0, &c.id).unwrap();
    state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.submit' AND json_extract(payload,'$.body.goal_id')=?1 ORDER BY id LIMIT 1",[p.evaluation_goal_id],|r|r.get(0)).unwrap()
}
async fn report_descriptor(f: &HostFixture, report: &str) -> Value {
    let mut e = env(
        &format!("inspect-{report}"),
        json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation}),
    );
    e.actor_ref = f.ghost.clone();
    let result = f
        .host
        .lifetime_pi_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: f.ghost.clone(),
                conversation_id: f.conversation.clone(),
                envelope: e,
            },
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(result["result"]["status"], "success", "{result}");
    result["result"]["data"]["bot_repair"].clone()
}
fn repair_call(f: &HostFixture, c: &Candidate, report: &str, id: &str) -> lifetime::PiToolRequest {
    let mut e = env(
        id,
        json!({"method":"bot.repair","report_id":report,"arguments":{"candidate_id":c.id,"candidate_digest":c.digest,"instructions":format!("Repaired exact procedure for fixed scalar output; revision from {}",c.id)}}),
    );
    e.actor_ref = f.ghost.clone();
    lifetime::PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: e,
    }
}
#[tokio::test]
async fn failed_evaluation_is_visible_once_and_report_repairs_keep_identity_evaluator_and_immutable_history(
) {
    let (f, old) = repair_fixture().await;
    complete_repair_evaluation(&f, &old, false).await;
    let report = candidate_report(&f, &old);
    let descriptor = report_descriptor(&f, &report).await;
    assert_eq!(descriptor["candidate_revision"], 1);
    assert_eq!(descriptor["repairs_remaining"], 2);
    for variant in ["actor", "epoch", "report", "grant"] {
        let mut request=repair_call(&f,&old,&report,&format!("forged-repair-{variant}"));
        match variant {
            "actor"=>request.envelope.actor_ref="owner".into(),
            "epoch"=>request.envelope.authority_epoch=2,
            "report"=>request.envelope.body["report_id"]=json!("foreign-report"),
            _=>request.envelope.body["arguments"]["required_capabilities"]=json!(["browser"]),
        }
        request.envelope.payload_digest=canonical_digest(&request.envelope.body).unwrap();
        assert_eq!(f.host.lifetime_pi_action(&request,lifetime::PiInferenceScope::Public).await.unwrap()["result"]["status"],"error");
    }
    {
        let state = f.host.lock().unwrap();
        assert_eq!(progress(&state.journal.0, &old.id).unwrap().state, "failed");
        assert_eq!(state.journal.0.query_row("SELECT count(*) FROM lifetime_turns WHERE id=?1 AND kind='host_fact' AND source_turn_id='create-turn'",[format!("host-bot-status/1:{}:failed",old.id)],|r|r.get::<_,u64>(0)).unwrap(),1);
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT count(*) FROM lifetime_registry WHERE ghost_id=?1",
                    [&old.definition.ghost_id],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
    }
    f.host.advance_bot_provisioning().unwrap();
    let command = repair_call(&f, &old, &report, "repair-one");
    let response = f
        .host
        .lifetime_pi_action(&command, lifetime::PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    let new = {
        let state = f.host.lock().unwrap();
        candidate(
            &state.journal.0,
            response["result"]["data"]["candidate_id"].as_str().unwrap(),
        )
        .unwrap()
    };
    assert_ne!(new.id, old.id);
    assert_ne!(new.digest, old.digest);
    assert_eq!(new.definition.ghost_id, old.definition.ghost_id);
    assert_eq!(new.profile_name, old.profile_name);
    assert_eq!(new.conversation_id, old.conversation_id);
    assert_eq!(new.evaluation_profile, old.evaluation_profile);
    assert_eq!(
        new.definition.content.required_capabilities,
        old.definition.content.required_capabilities
    );
    assert_eq!(
        new.definition.content.input_contract,
        old.definition.content.input_contract
    );
    assert_eq!(
        new.definition.content.output_contract,
        old.definition.content.output_contract
    );
    {
        let state = f.host.lock().unwrap();
        assert_eq!(candidate(&state.journal.0, &old.id).unwrap(), old);
        assert_eq!(
            progress(&state.journal.0, &new.id).unwrap().operation_id,
            progress(&state.journal.0, &old.id).unwrap().operation_id
        );
    }
    assert_eq!(
        f.host
            .lifetime_pi_action(&command, lifetime::PiInferenceScope::Public)
            .await
            .unwrap(),
        response
    );
    assert!(
        report_descriptor(&f, &report).await.is_null(),
        "superseded failed report loses repair capability"
    );
    let stale = f
        .host
        .lifetime_pi_action(
            &repair_call(&f, &old, &report, "repair-stale-new-id"),
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(stale["result"]["status"], "error");
    // Original and replacement evaluation assignments still validate after the
    // pointer changes; old immutable evidence is not reinterpreted as new Work.
    complete_repair_evaluation(&f, &new, true).await;
    let pending = {
        let state = f.host.lock().unwrap();
        assert_eq!(
            progress(&state.journal.0, &new.id).unwrap().state,
            "provisioning"
        );
        lifetime::pending_outbox(&state.journal.0)
            .unwrap()
            .into_iter()
            .find(|item| item.payload["body"]["method"] == "conversation.ensure")
            .unwrap()
    };
    let entry =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/ghost-durable/src/main.js");
    let mut pi = super::super::lifetime_runtime::PiProcess::start(
        &entry,
        &f.root.path().join("repair-pi"),
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
    f.host.advance_bot_provisioning().unwrap();
    {
        let state = f.host.lock().unwrap();
        assert_eq!(progress(&state.journal.0, &new.id).unwrap().state, "ready");
        assert_eq!(progress(&state.journal.0, &old.id).unwrap().state, "failed");
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT count(*) FROM lifetime_registry WHERE ghost_id=?1 AND mode='active'",
                    [&old.definition.ghost_id],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT count(*) FROM lifetime_turns WHERE id=?1",
                    [format!("host-bot-status/1:{}:ready", new.id)],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            1
        );
    }
    let reopened = Journal::open(&f.root.path().join("workspace.db")).unwrap();
    let stored: String = reopened
        .0
        .query_row(
            "SELECT request FROM lifetime_commands WHERE command_id='repair-one'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let stored: Envelope = serde_json::from_str(&stored).unwrap();
    let replay = lifetime::apply(&reopened.0, &stored, &f.ghost).unwrap();
    assert_eq!(serde_json::to_value(replay).unwrap(), response["result"]);
}
#[tokio::test]
async fn repair_budget_is_two_and_cancelled_foreign_or_changed_reports_grant_nothing() {
    let (f, mut c) = repair_fixture().await;
    for revision in 1..=3 {
        complete_repair_evaluation(&f, &c, false).await;
        let report = candidate_report(&f, &c);
        let descriptor = report_descriptor(&f, &report).await;
        if revision == 3 {
            assert!(descriptor.is_null());
            let denied = f
                .host
                .lifetime_pi_action(
                    &repair_call(&f, &c, &report, "repair-over-budget"),
                    lifetime::PiInferenceScope::Public,
                )
                .await
                .unwrap();
            assert_eq!(denied["result"]["status"], "error");
            break;
        }
        assert_eq!(descriptor["candidate_revision"], revision);
        let mut wrong = repair_call(&f, &c, &report, &format!("wrong-{revision}"));
        wrong.envelope.body["arguments"]["candidate_digest"] = json!("0".repeat(64));
        wrong.envelope.payload_digest = canonical_digest(&wrong.envelope.body).unwrap();
        assert_eq!(
            f.host
                .lifetime_pi_action(&wrong, lifetime::PiInferenceScope::Public)
                .await
                .unwrap()["result"]["status"],
            "error"
        );
        let response = f
            .host
            .lifetime_pi_action(
                &repair_call(&f, &c, &report, &format!("repair-budget-{revision}")),
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        let state = f.host.lock().unwrap();
        c = candidate(
            &state.journal.0,
            response["result"]["data"]["candidate_id"].as_str().unwrap(),
        )
        .unwrap();
    }
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            state
                .journal
                .0
                .query_row("SELECT count(*) FROM lifetime_work", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            3
        );
    }
    let (f, c) = repair_fixture().await;
    complete_repair_evaluation(&f, &c, false).await;
    let report = candidate_report(&f, &c);
    f.host.lifetime_action(&env("repair-cancel",json!({"method":"conversation.cancel_turn","ghost_id":f.ghost,"conversation_id":f.conversation,"turn_id":"create-turn"}))).unwrap();
    assert!(report_descriptor(&f, &report).await.is_null());
    assert_eq!(
        f.host
            .lifetime_pi_action(
                &repair_call(&f, &c, &report, "repair-after-cancel"),
                lifetime::PiInferenceScope::Public
            )
            .await
            .unwrap()["result"]["status"],
        "error"
    );
}
