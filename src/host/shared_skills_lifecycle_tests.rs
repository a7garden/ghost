// Included in provisioning::tests to exercise the real evaluated lifecycle.
fn shared_publish(
    f: &HostFixture,
    namespace: &str,
    id: &str,
    version: u64,
    expected: Option<u64>,
) -> (Envelope, RevisionRef) {
    let content=format!("---\nprivacy: public\n---\nShared procedure version {version}: preserve exact input provenance.");
    let source = {
        let state = f.host.lock().unwrap();
        let value = crate::host::skills::save(
            &state,
            f.root.path(),
            &format!("shared-source-{version}"),
            &f.ghost,
            "shared-source",
            &content,
            if version == 1 {
                None
            } else {
                Some(version - 1)
            },
        )
        .unwrap();
        let skill = &value["skill"];
        rr(
            &f.ghost,
            "shared-source",
            version,
            skill["digest"].as_str().unwrap().into(),
        )
    };
    let mut e = env(
        &format!("publish-{namespace}-{id}-{version}"),
        json!({"method":"skill.catalog.publish","namespace":namespace,"id":id,"source":source}),
    );
    e.expected_revision = expected;
    let response = f.host.lifetime_action(&e).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    (
        e,
        serde_json::from_value(response["result"]["data"]["reference"].clone()).unwrap(),
    )
}
fn shared_grant(
    f: &HostFixture,
    r: &RevisionRef,
    ghost: &str,
    allow: bool,
    expected: Option<u64>,
    id: &str,
) -> Value {
    let mut e = env(
        id,
        json!({"method":"skill.catalog.grant","reference":r,"ghost_id":ghost,"allow":allow}),
    );
    e.expected_revision = expected;
    let response = f.host.lifetime_action(&e).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    response
}
fn shared_adopt(
    f: &HostFixture,
    old: &Candidate,
    r: &RevisionRef,
    alias: &str,
    id: &str,
) -> (Envelope, Value, Option<Candidate>) {
    let e = env(
        id,
        json!({"method":"bot.update.prepare","ghost_id":old.definition.ghost_id,"definition_ref":bots_store::DefinitionPointer::from(&old.definition),"skill_adoption":{"reference":r,"alias":alias}}),
    );
    let response = f.host.lifetime_action(&e).unwrap();
    let c = response["result"]["data"]["candidate_id"]
        .as_str()
        .map(|id| candidate(&f.host.lock().unwrap().journal.0, id).unwrap());
    (e, response, c)
}
fn shared_fixture_extension(f: &HostFixture) {
    let old: EvaluationProfile = {
        let state = f.host.lock().unwrap();
        load(&state.journal.0, EVALUATOR, "workspace")
            .unwrap()
            .unwrap()
    };
    let mut fixtures = old.fixtures;
    let id = format!("shared-new-input-{}", old.revision);
    fixtures.push(Fixture {
        id: id.clone(),
        input: json!({"value":id,"source":"distinct-shared-regression"}),
        expected_output: json!(format!("DISTINCT_NEW_OUTPUT_{}_WITHHELD", old.revision)),
    });
    let mut e = env(
        &format!("shared-evaluation-corpus-{}", old.revision),
        json!({"method":"bot.evaluation_profile.configure","fixtures":fixtures}),
    );
    e.expected_revision = Some(old.revision);
    let response = f.host.lifetime_action(&e).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
}
#[tokio::test]
async fn shared_skill_real_running_v1_publish_v2_evaluated_adoption_new_work_and_staged_rollback() {
    let (f, initial) = lifecycle_fixture().await;
    let (_, v1) = shared_publish(&f, "common", "procedure", 1, None);
    shared_grant(
        &f,
        &v1,
        &initial.definition.ghost_id,
        true,
        None,
        "grant-v1-target",
    );
    shared_grant(&f, &v1, &f.ghost, true, None, "grant-v1-evaluator");
    shared_fixture_extension(&f);
    let (_, response, v1c) = shared_adopt(&f, &initial, &v1, "procedure", "adopt-v1");
    assert_eq!(response["result"]["status"], "success", "{response}");
    let v1c = v1c.unwrap();
    assert_eq!(v1c.evaluation_profile.fixtures.len(), 3);
    complete_repair_evaluation(&f, &v1c, true).await;
    lifecycle_finish_ready(&f, &v1c).await;
    let first = lifecycle_goal(&f, &v1c, "running-v1");
    let w1: Work = serde_json::from_value(first["result"]["data"]["work"].clone()).unwrap();
    let effect = lifecycle_execute(
        &f,
        &v1c,
        &w1,
        "running-v1-write",
        20,
        "write",
        json!({"path":"v1.txt","content":"actual running v1 effect"}),
    )
    .await
    .unwrap();
    assert_eq!(effect.status, ResponseStatus::Success);
    let w1 = {
        let state = f.host.lock().unwrap();
        let w: Work = serde_json::from_str(
            &state
                .journal
                .0
                .query_row(
                    "SELECT payload FROM lifetime_work WHERE id=?1",
                    [&w1.id],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(w.state, "running");
        assert!(w.execution_id.is_some());
        w
    };
    let (_, v2) = shared_publish(&f, "common", "procedure", 2, Some(1));
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            bots_store::active_definition(&state.journal.0, &v1c.definition.ghost_id)
                .unwrap()
                .unwrap(),
            v1c.definition
        );
        let assets = assets_for_work(&state.journal.0, &w1).unwrap();
        assert!(assets
            .iter()
            .any(|a| a["name"] == "procedure" && a["sha256"] == v1.digest));
        assert!(!assets.iter().any(|a| a["sha256"] == v2.digest));
    }
    shared_grant(
        &f,
        &v2,
        &v1c.definition.ghost_id,
        true,
        None,
        "grant-v2-target",
    );
    shared_grant(&f, &v2, &f.ghost, true, None, "grant-v2-evaluator");
    let (_, insufficient, _) =
        shared_adopt(&f, &v1c, &v2, "procedure", "reject-v2-without-new-case");
    assert_eq!(insufficient["ok"], false);
    shared_fixture_extension(&f);
    let (admit, response, v2c) = shared_adopt(&f, &v1c, &v2, "procedure", "adopt-v2");
    assert_eq!(response["result"]["status"], "success", "{response}");
    let v2c = v2c.unwrap();
    assert_ne!(v2c.definition.digest, v1c.definition.digest);
    assert_eq!(
        v2c.definition.content.memory_profile_ref,
        v1c.definition.content.memory_profile_ref
    );
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            bots_store::active_definition(&state.journal.0, &v1c.definition.ghost_id)
                .unwrap()
                .unwrap(),
            v1c.definition
        );
        assert!(progress(&state.journal.0, &v2c.id)
            .unwrap()
            .evaluation_work_id
            .is_some());
    }
    complete_repair_evaluation(&f, &v2c, true).await;
    lifecycle_finish_ready(&f, &v2c).await;
    assert_eq!(f.host.lifetime_action(&admit).unwrap(), response);
    let continued = lifecycle_execute(
        &f,
        &v1c,
        &w1,
        "running-v1-after-v2",
        21,
        "write",
        json!({"path":"v1-after-v2.txt","content":"original v1 execution still running"}),
    )
    .await
    .unwrap();
    assert_eq!(continued.status, ResponseStatus::Success);
    assert_eq!(
        continued.data["receipt"]["execution_id"],
        effect.data["receipt"]["execution_id"]
    );
    shared_complete_work(&f, &v1c, &w1, lifetime::PiInferenceScope::Public).await;
    let second = lifecycle_goal(&f, &v2c, "new-v2-work");
    let w2: Work = serde_json::from_value(second["result"]["data"]["work"].clone()).unwrap();
    let v2effect = lifecycle_execute(
        &f,
        &v2c,
        &w2,
        "new-v2-effect",
        22,
        "write",
        json!({"path":"v2.txt","content":"new v2 Work"}),
    )
    .await
    .unwrap();
    assert_eq!(v2effect.status, ResponseStatus::Success);
    assert_ne!(
        v2effect.data["receipt"]["execution_id"],
        effect.data["receipt"]["execution_id"]
    );
    {
        let state = f.host.lock().unwrap();
        let old = assets_for_work(&state.journal.0, &w1).unwrap();
        let new = assets_for_work(&state.journal.0, &w2).unwrap();
        assert!(old.iter().any(|a| a["sha256"] == v1.digest));
        assert!(new
            .iter()
            .any(|a| a["name"] == "procedure" && a["sha256"] == v2.digest));
        assert_eq!(
            bots_store::definition_for_work(&state.journal.0, &w1)
                .unwrap()
                .unwrap(),
            v1c.definition
        );
    }
    // Cold connection sees the exact same immutable Work pins and grants.
    let cold = rusqlite::Connection::open(f.root.path().join("workspace.db")).unwrap();
    assert_eq!(
        assets_for_work(&cold, &w1).unwrap(),
        assets_for_work(&f.host.lock().unwrap().journal.0, &w1).unwrap()
    );
    let (_, response, rollback) = shared_adopt(&f, &v2c, &v1, "procedure", "rollback-v1");
    assert_eq!(response["result"]["status"], "success", "{response}");
    let rollback = rollback.unwrap();
    assert_eq!(
        rollback.evaluation_profile.fixtures,
        v2c.evaluation_profile.fixtures
    ); // no invented new corpus for exact rollback
    assert_eq!(
        bots_store::active_definition(&cold, &v2c.definition.ghost_id)
            .unwrap()
            .unwrap(),
        v2c.definition
    );
    complete_repair_evaluation(&f, &rollback, true).await;
    lifecycle_finish_ready(&f, &rollback).await;
    assert_eq!(
        bots_store::active_definition(&cold, &rollback.definition.ghost_id)
            .unwrap()
            .unwrap(),
        rollback.definition
    );
    assert_eq!(
        bots_store::definition_for_work(&cold, &w2)
            .unwrap()
            .unwrap(),
        v2c.definition
    );
    assert_eq!(
        cold.query_row(
            "SELECT count(*) FROM lifetime_outbox WHERE target='worker'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
}
#[tokio::test]
async fn shared_skill_reader_revoke_blocks_cached_effect_and_inference_without_erasing_receipt() {
    let (f, initial) = lifecycle_fixture().await;
    let (_, reference) = shared_publish(&f, "common", "recipe", 1, None);
    let (_, denied, c) = shared_adopt(&f, &initial, &reference, "recipe", "missing-both-readers");
    assert_eq!(denied["ok"], false);
    assert!(c.is_none());
    shared_grant(
        &f,
        &reference,
        &initial.definition.ghost_id,
        true,
        None,
        "target-only",
    );
    let (_, denied, _) = shared_adopt(
        &f,
        &initial,
        &reference,
        "recipe",
        "missing-evaluator-reader",
    );
    assert_eq!(denied["ok"], false);
    shared_grant(&f, &reference, &f.ghost, true, None, "eval-reader");
    shared_fixture_extension(&f);
    let (_, _, c) = shared_adopt(&f, &initial, &reference, "recipe", "reader-adoption");
    let c = c.unwrap();
    complete_repair_evaluation(&f, &c, true).await;
    lifecycle_finish_ready(&f, &c).await;
    let admitted = lifecycle_goal(&f, &c, "revoke-work");
    let w: Work = serde_json::from_value(admitted["result"]["data"]["work"].clone()).unwrap();
    let args = json!({"path":"receipt.txt","content":"original effect"});
    let original = lifecycle_execute(&f, &c, &w, "cached-shared-write", 25, "write", args.clone())
        .await
        .unwrap();
    assert_eq!(original.status, ResponseStatus::Success);
    let (assignment, prior) = {
        let state = f.host.lock().unwrap();
        let assignment:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&w.id],|r|r.get(0)).unwrap();
        let prior: String = state
            .journal
            .0
            .query_row(
                "SELECT response_json FROM lifetime_pi_effects WHERE call_id='cached-shared-write'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (assignment, prior)
    };
    shared_grant(
        &f,
        &reference,
        &c.definition.ghost_id,
        false,
        Some(1),
        "revoke-reader",
    );
    let unbound = shared_unbound_inference(
        &f,
        &c.definition.ghost_id,
        &c.conversation_id,
        "revoked-history",
    )
    .await;
    assert_eq!(
        unbound["result"]["error_code"],
        "shared_skill_scope_blocked"
    );
    let other =
        shared_unbound_inference(&f, &f.ghost, &f.conversation, "other-ghost-history").await;
    assert_eq!(other["result"]["status"], "success", "{other}");
    {
        let state = f.host.lock().unwrap();
        for (ghost, conversation) in [
            (&c.definition.ghost_id, &c.conversation_id),
            (&f.ghost, &f.conversation),
        ] {
            let key = canonical_digest(&json!([ghost, conversation])).unwrap();
            let history:String=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind='shared_skill_history_v1' AND id=?1",[key],|r|r.get(0)).unwrap();
            assert!(serde_json::from_str::<Vec<RevisionRef>>(&history)
                .unwrap()
                .contains(&reference));
        }
        let wrong = canonical_digest(&json!([c.definition.ghost_id, f.conversation])).unwrap();
        assert_eq!(state.journal.0.query_row("SELECT count(*) FROM workspace_objects WHERE kind='shared_skill_history_v1' AND id=?1",[wrong],|r|r.get::<_,u64>(0)).unwrap(),0);
        let mut e = env(
            "clean-other-conversation",
            json!({"method":"inference.inspect"}),
        );
        e.actor_ref = c.definition.ghost_id.clone();
        let request = lifetime::PiToolRequest {
            context_ref: None, ghost_id: c.definition.ghost_id.clone(),
            conversation_id: uuid::Uuid::new_v4().to_string(),
            envelope: e,
        };
        assert!(crate::host::shared_skills::request_guard(
            &state.journal.0,
            &request,
            lifetime::PiInferenceScope::Public
        )
        .is_ok()); // history isolation grants no actual binding
        assert!(lifetime::pi_tool_guard(
            &state.journal.0,
            &request,
            lifetime::PiInferenceScope::Public
        )
        .unwrap()
        .is_some());
    }
    let replay = lifecycle_execute(&f, &c, &w, "cached-shared-write", 25, "write", args.clone())
        .await
        .unwrap();
    assert_eq!(
        replay.error_code.as_deref(),
        Some("shared_skill_scope_blocked")
    );
    for body in [
        json!({"method":"inference.inspect","assignment_id":assignment,"work_id":w.id}),
        json!({"method":"inference.inspect","assignment_id":assignment}),
        json!({"method":"inference.inspect","assignment_id":assignment,"work_id":"foreign"}),
        json!({"method":"inference.inspect","assignment_id":"stale","work_id":w.id}),
    ] {
        let mut e = env(
            &format!("inference-{}", canonical_digest(&body).unwrap()),
            body,
        );
        e.actor_ref = c.definition.ghost_id.clone();
        let req = lifetime::PiToolRequest {
            context_ref: None, ghost_id: c.definition.ghost_id.clone(),
            conversation_id: c.conversation_id.clone(),
            envelope: e,
        };
        let response = f
            .host
            .lifetime_pi_action(&req, lifetime::PiInferenceScope::Public)
            .await
            .unwrap();
        assert_eq!(response["result"]["status"], "error", "{response}");
    }
    let cold = rusqlite::Connection::open(f.root.path().join("workspace.db")).unwrap();
    assert!(crate::host::shared_skills::work_current(&cold, &w).is_err());
    assert_eq!(
        cold.query_row(
            "SELECT response_json FROM lifetime_pi_effects WHERE call_id='cached-shared-write'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        prior
    );
    assert_eq!(
        cold.query_row(
            "SELECT count(*) FROM lifetime_pi_effects WHERE call_id='cached-shared-write'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        1
    );
    shared_grant(
        &f,
        &reference,
        &c.definition.ghost_id,
        true,
        Some(2),
        "new-reader-revision",
    );
    assert!(crate::host::shared_skills::work_current(&cold, &w).is_err());
    let reauthorized = shared_unbound_inference(
        &f,
        &c.definition.ghost_id,
        &c.conversation_id,
        "explicit-reauthorized-history",
    )
    .await;
    assert_eq!(
        reauthorized["result"]["status"], "success",
        "{reauthorized}"
    );
}
#[tokio::test]
async fn shared_skill_namespace_grants_collision_and_immutable_source_preflight() {
    let (f, c) = lifecycle_fixture().await;
    let (published, reference) = shared_publish(&f, "common", "procedure", 1, None);
    // Namespace location confers no read authority, even for its publisher.
    assert_eq!(
        shared_adopt(&f, &c, &reference, "procedure", "namespace-is-not-grant").1["ok"],
        false
    );
    shared_grant(
        &f,
        &reference,
        &c.definition.ghost_id,
        true,
        None,
        "collision-target",
    );
    shared_grant(&f, &reference, &f.ghost, true, None, "collision-eval");
    {
        let state = f.host.lock().unwrap();
        crate::host::skills::save(
            &state,
            f.root.path(),
            "local-alias",
            &c.definition.ghost_id,
            "procedure",
            "---\nprivacy: public\n---\nLocal procedure",
            None,
        )
        .unwrap();
    }
    assert_eq!(
        shared_adopt(&f, &c, &reference, "procedure", "alias-collision").1["ok"],
        false
    );
    assert_eq!(
        shared_adopt(&f, &c, &reference, "../escape", "alias-traversal").1["ok"],
        false
    );
    for ns in ["project:bogus", "../common", &c.definition.ghost_id] {
        let mut e = published.clone();
        e.command_id = format!("bad-ns-{ns}");
        e.body["namespace"] = json!(ns);
        e.payload_digest = canonical_digest(&e.body).unwrap();
        assert_eq!(f.host.lifetime_action(&e).unwrap()["ok"], false);
    }
    // Source updates do not alter an already published immutable snapshot/cache.
    let original = f.host.lifetime_action(&published).unwrap();
    let (_, v2) = shared_publish(
        &f,
        "project:01930000-0000-7000-8000-000000000001",
        "procedure",
        2,
        None,
    );
    assert_ne!(reference.digest, v2.digest);
    assert_eq!(f.host.lifetime_action(&published).unwrap(), original);
    let source = published.body["source"].clone();
    let profile = f.host.lock().unwrap().profiles[&f.ghost].name.clone();
    let path = f.root.path().join(format!(
        "profiles/{profile}/skills/shared-source/revisions/{}/SKILL.md",
        source["digest"].as_str().unwrap()
    ));
    let outside = f.root.path().join("outside-skill");
    std::fs::write(&outside, std::fs::read(&path).unwrap()).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    // Use current v2 source so metadata matches, then replace its archive too.
    let digest = v2.digest.clone();
    let current = path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(digest)
        .join("SKILL.md");
    let bytes = std::fs::read(&current).unwrap();
    std::fs::remove_file(&current).unwrap();
    std::fs::write(&outside, bytes).unwrap();
    std::os::unix::fs::symlink(&outside, &current).unwrap();
    let mut e = published.clone();
    e.command_id = "unsafe-publication".into();
    e.expected_revision = Some(1);
    e.body["source"]["revision"] = json!(2);
    e.body["source"]["digest"] = json!(v2.digest);
    e.payload_digest = canonical_digest(&e.body).unwrap();
    assert_eq!(f.host.lifetime_action(&e).unwrap()["ok"], false);
    let state = f.host.lock().unwrap();
    assert_eq!(
        state
            .journal
            .0
            .query_row(
                "SELECT count(*) FROM workspace_objects WHERE kind='shared_skill_revision_v1'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        2
    );
}
async fn shared_complete_work(
    f: &HostFixture,
    c: &Candidate,
    w: &Work,
    scope: lifetime::PiInferenceScope,
) {
    let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&w.id],|r|r.get(0)).unwrap();
    let mut e = env(
        &format!("shared-complete-{}", w.id),
        json!({"method":"work.execution.complete","assignment_id":assignment,"work_id":w.id,"task_id":7,"summary":"Original exact Work effect observed"}),
    );
    e.actor_ref = c.definition.ghost_id.clone();
    let response = f
        .host
        .lifetime_pi_execution_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                conversation_id: c.conversation_id.clone(),
                envelope: e,
            },
            scope,
        )
        .await
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
}
async fn shared_private_evaluation(f: &HostFixture, c: &Candidate) {
    let (work, assignment) = {
        let state = f.host.lock().unwrap();
        let w = progress(&state.journal.0, &c.id)
            .unwrap()
            .evaluation_work_id
            .unwrap();
        let a:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&w],|r|r.get(0)).unwrap();
        (w, a)
    };
    for (task, call, operation, args) in [
        (
            10,
            "write",
            "write",
            json!({"path":"bot-evaluation.json","content":String::from_utf8(bytes(c)).unwrap()}),
        ),
        (
            11,
            "publish",
            "publish_artifact",
            json!({"path":"bot-evaluation.json","privacy":"private"}),
        ),
    ] {
        let mut e = env(
            &format!("private-shared-{}-{call}", c.id),
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
    let evaluator = Candidate {
        definition: BotDefinition::new(f.ghost.clone(), 1, c.definition.content.clone()).unwrap(),
        conversation_id: f.conversation.clone(),
        ..c.clone()
    };
    let w: Work = serde_json::from_str(
        &f.host
            .lock()
            .unwrap()
            .journal
            .0
            .query_row(
                "SELECT payload FROM lifetime_work WHERE id=?1",
                [&work],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    shared_complete_work(f, &evaluator, &w, lifetime::PiInferenceScope::Local).await;
    f.host.advance_bot_provisioning().unwrap();
}
#[tokio::test]
async fn shared_skill_private_adoption_never_discloses_into_public_or_selected_work_inference() {
    let (mut f, old) = lifecycle_fixture().await;
    let source = {
        let state = f.host.lock().unwrap();
        let value = crate::host::skills::save(
            &state,
            f.root.path(),
            "private-source",
            &f.ghost,
            "private-shared",
            "---\nprivacy: private\n---\nSYNTHETIC_PRIVATE_SHARED_PROCEDURE",
            None,
        )
        .unwrap();
        rr(
            &f.ghost,
            "private-shared",
            1,
            value["skill"]["digest"].as_str().unwrap().into(),
        )
    };
    let published=f.host.lifetime_action(&env("publish-private",json!({"method":"skill.catalog.publish","namespace":"common","id":"private-procedure","source":source}))).unwrap();
    let r: RevisionRef =
        serde_json::from_value(published["result"]["data"]["reference"].clone()).unwrap();
    shared_grant(
        &f,
        &r,
        &old.definition.ghost_id,
        true,
        None,
        "private-target",
    );
    shared_grant(&f, &r, &f.ghost, true, None, "private-evaluator");
    f.host.pi_local_route = Some(crate::host::lifetime_runtime::LocalPiRoute {
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
    f.host
        .native_computers
        .as_mut()
        .unwrap()
        .pi_fixture_allow_private(&old.definition.ghost_id)
        .unwrap();
    shared_fixture_extension(&f);
    let (_, response, c) = shared_adopt(&f, &old, &r, "private-procedure", "private-adoption");
    assert_eq!(response["result"]["status"], "success", "{response}");
    let c = c.unwrap();
    assert_eq!(c.privacy, "private");
    shared_private_evaluation(&f, &c).await;
    lifecycle_finish_ready(&f, &c).await;
    for (id, privacy) in [("public-work", "public"), ("private-work", "private")] {
        let response=f.host.lifetime_action(&env(id,json!({"method":"goal.submit","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"prompt":"Use exact procedure","privacy":privacy,"acceptance_spec":{}}))).unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        let w: Work = serde_json::from_value(response["result"]["data"]["work"].clone()).unwrap();
        // Admission fences no-effect advisory/report inference before any tool.
        assert!(!crate::host::lifetime::conversation_is_public(
            &f.host.lock().unwrap().journal.0,
            &c.definition.ghost_id,
            &c.conversation_id
        )
        .unwrap());
        assert_eq!(f.host.lock().unwrap().journal.0.query_row("SELECT count(*) FROM lifetime_pi_effects e JOIN lifetime_pi_executions x ON x.execution_id=e.execution_id WHERE x.work_id=?1",[&w.id],|r|r.get::<_,u64>(0)).unwrap(),0);
        let mut no_effect = env(
            &format!("no-effect-public-{id}"),
            json!({"method":"inference.inspect"}),
        );
        no_effect.actor_ref = c.definition.ghost_id.clone();
        let no_effect = f
            .host
            .lifetime_pi_action(
                &lifetime::PiToolRequest {
                    context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                    conversation_id: c.conversation_id.clone(),
                    envelope: no_effect,
                },
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(no_effect["result"]["status"], "error");
        let mut selected = env(
            &format!("no-effect-selected-{id}"),
            json!({"method":"inference.inspect"}),
        );
        selected.actor_ref = c.definition.ghost_id.clone();
        let selected = f
            .host
            .lifetime_pi_action(
                &lifetime::PiToolRequest {
                    context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                    conversation_id: c.conversation_id.clone(),
                    envelope: selected,
                },
                lifetime::PiInferenceScope::Selected,
            )
            .await
            .unwrap();
        assert_eq!(
            selected["result"]["error_code"],
            "shared_skill_scope_blocked"
        );
        let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&w.id],|r|r.get(0)).unwrap();
        for scope in [
            lifetime::PiInferenceScope::Public,
            lifetime::PiInferenceScope::Selected,
            lifetime::PiInferenceScope::Local,
        ] {
            let mut e = env(
                &format!("inspect-{id}-{}", scope as u8),
                json!({"method":"inference.inspect","assignment_id":assignment,"work_id":w.id}),
            );
            e.actor_ref = c.definition.ghost_id.clone();
            let req = lifetime::PiToolRequest {
                context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                conversation_id: c.conversation_id.clone(),
                envelope: e,
            };
            let result = f.host.lifetime_pi_action(&req, scope).await.unwrap();
            assert_eq!(
                result["result"]["status"] == "success",
                scope == lifetime::PiInferenceScope::Local,
                "{result}"
            );
            assert!(!result
                .to_string()
                .contains("SYNTHETIC_PRIVATE_SHARED_PROCEDURE"));
        }
        let mut e = env(
            &format!("assignment-{id}"),
            json!({"method":"conversation.assignment.inspect","assignment_id":assignment,"ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id}),
        );
        e.actor_ref = c.definition.ghost_id.clone();
        let req = lifetime::PiToolRequest {
            context_ref: None, ghost_id: c.definition.ghost_id.clone(),
            conversation_id: c.conversation_id.clone(),
            envelope: e,
        };
        let public = f
            .host
            .lifetime_pi_action(&req, lifetime::PiInferenceScope::Public)
            .await
            .unwrap();
        assert_ne!(public["result"]["status"], "success");
        assert!(!public
            .to_string()
            .contains("SYNTHETIC_PRIVATE_SHARED_PROCEDURE"));
        let local = f
            .host
            .lifetime_pi_action(&req, lifetime::PiInferenceScope::Local)
            .await
            .unwrap();
        assert_eq!(local["result"]["status"], "success", "{local}");
        assert!(local["result"]["data"]["skills"]
            .to_string()
            .contains("SYNTHETIC_PRIVATE_SHARED_PROCEDURE"));
        let written = shared_local_effect(
            &f,
            &c,
            &w,
            &assignment,
            30,
            "write",
            json!({"path":"private-output.txt","content":"SYNTHETIC_PRIVATE_SHARED_PROCEDURE"}),
        )
        .await;
        assert_eq!(written.status, ResponseStatus::Success);
        let rejected = shared_local_effect(
            &f,
            &c,
            &w,
            &assignment,
            31,
            "publish_artifact",
            json!({"path":"private-output.txt","privacy":"public"}),
        )
        .await;
        assert_eq!(rejected.data["receipt"]["state"], "denied");
        assert!(rejected.artifacts.is_empty());
        let published = shared_local_effect(
            &f,
            &c,
            &w,
            &assignment,
            32,
            "publish_artifact",
            json!({"path":"private-output.txt","privacy":"private"}),
        )
        .await;
        assert_eq!(published.status, ResponseStatus::Success);
        assert_eq!(published.artifacts[0].privacy, "private");
        shared_complete_work(&f, &c, &w, lifetime::PiInferenceScope::Local).await;
        let report:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.submit' AND json_extract(payload,'$.body.goal_id')=?1 ORDER BY id DESC LIMIT 1",[&w.goal_id],|r|r.get(0)).unwrap();
        let mut e = env(
            &format!("private-report-{id}"),
            json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id}),
        );
        e.actor_ref = c.definition.ghost_id.clone();
        let req = lifetime::PiToolRequest {
            context_ref: None, ghost_id: c.definition.ghost_id.clone(),
            conversation_id: c.conversation_id.clone(),
            envelope: e,
        };
        let public_report = f
            .host
            .lifetime_pi_action(&req, lifetime::PiInferenceScope::Public)
            .await
            .unwrap();
        assert_eq!(public_report["result"]["status"], "error");
        assert!(!public_report
            .to_string()
            .contains("SYNTHETIC_PRIVATE_SHARED_PROCEDURE"));
        let local_report = f
            .host
            .lifetime_pi_action(&req, lifetime::PiInferenceScope::Local)
            .await
            .unwrap();
        assert_eq!(
            local_report["result"]["status"], "success",
            "{local_report}"
        );
        assert_eq!(
            local_report["result"]["data"]["report"]["privacy"],
            "private"
        );
    }
}
async fn shared_local_effect(
    f: &HostFixture,
    c: &Candidate,
    w: &Work,
    assignment: &str,
    task: u64,
    operation: &str,
    args: Value,
) -> Response {
    let call = format!("shared-private-{}-{task}", w.id);
    let mut e = env(
        &call,
        json!({"method":"work.execute","assignment_id":assignment,"work_id":w.id,"generation_task_id":7,"task_id":task,"call_id":call,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":args})).unwrap(),"arguments":args}),
    );
    e.actor_ref = c.definition.ghost_id.clone();
    f.host
        .lifetime_pi_execution_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                conversation_id: c.conversation_id.clone(),
                envelope: e,
            },
            lifetime::PiInferenceScope::Local,
        )
        .await
        .unwrap()
}

async fn shared_unbound_inference(
    f: &HostFixture,
    ghost: &str,
    conversation: &str,
    id: &str,
) -> Value {
    let mut e = env(id, json!({"method":"inference.inspect"}));
    e.actor_ref = ghost.into();
    f.host
        .lifetime_pi_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: ghost.into(),
                conversation_id: conversation.into(),
                envelope: e,
            },
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap()
}
async fn shared_goal_create(
    f: &HostFixture,
    ghost: &str,
    conversation: &str,
    id: &str,
) -> (Value, Option<Work>) {
    let turn = format!("{id}-owner");
    let input=f.host.lifetime_action(&env(&turn,json!({"method":"conversation.input","ghost_id":ghost,"conversation_id":conversation,"text":"Start a new authorized responsibility using retained context.","privacy":"public","attachments":[]}))).unwrap();
    assert_eq!(input["result"]["status"], "success", "{input}");
    let mut e = env(
        id,
        json!({"method":"goal.create","turn_id":turn,"ghost_id":ghost,"conversation_id":conversation,"prompt":"A new authorized responsibility, without changing source grants.","acceptance_spec":{}}),
    );
    e.actor_ref = ghost.into();
    let response = f
        .host
        .lifetime_pi_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: ghost.into(),
                conversation_id: conversation.into(),
                envelope: e,
            },
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    let work = response["result"]["data"]["work"]
        .as_object()
        .map(|_| serde_json::from_value(response["result"]["data"]["work"].clone()).unwrap());
    (response, work)
}
async fn shared_bound_inference(f: &HostFixture, c: &Candidate, w: &Work, id: &str) -> Value {
    let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[&w.id],|r|r.get(0)).unwrap();
    let mut e = env(
        id,
        json!({"method":"inference.inspect","assignment_id":assignment,"work_id":w.id}),
    );
    e.actor_ref = c.definition.ghost_id.clone();
    f.host
        .lifetime_pi_action(
            &lifetime::PiToolRequest {
                context_ref: None, ghost_id: c.definition.ghost_id.clone(),
                conversation_id: c.conversation_id.clone(),
                envelope: e,
            },
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap()
}
#[tokio::test]
async fn shared_skill_learned_v2_fences_v1_context_new_work_snapshots_and_delegation_carries_audience(
) {
    let (f, initial) = lifecycle_fixture().await;
    let (_, v1) = shared_publish(&f, "common", "history-procedure", 1, None);
    shared_grant(
        &f,
        &v1,
        &initial.definition.ghost_id,
        true,
        None,
        "history-v1-target",
    );
    shared_grant(&f, &v1, &f.ghost, true, None, "history-v1-eval");
    shared_fixture_extension(&f);
    let (_, response, v1c) =
        shared_adopt(&f, &initial, &v1, "history-procedure", "history-v1-adopt");
    assert_eq!(response["result"]["status"], "success", "{response}");
    let v1c = v1c.unwrap();
    complete_repair_evaluation(&f, &v1c, true).await;
    lifecycle_finish_ready(&f, &v1c).await;
    let admitted = lifecycle_goal(&f, &v1c, "history-v1-running");
    let w1: Work = serde_json::from_value(admitted["result"]["data"]["work"].clone()).unwrap();
    let args = json!({"path":"history-v1.txt","content":"original v1 effect"});
    let first = lifecycle_execute(
        &f,
        &v1c,
        &w1,
        "history-v1-effect",
        40,
        "write",
        args.clone(),
    )
    .await
    .unwrap();
    assert_eq!(first.status, ResponseStatus::Success);
    let (_, v2) = shared_publish(&f, "common", "history-procedure", 2, Some(1));
    shared_grant(
        &f,
        &v2,
        &initial.definition.ghost_id,
        true,
        None,
        "history-v2-target",
    );
    shared_grant(&f, &v2, &f.ghost, true, None, "history-v2-eval");
    shared_fixture_extension(&f);
    let (_, response, v2c) = shared_adopt(&f, &v1c, &v2, "history-procedure", "history-v2-adopt");
    assert_eq!(response["result"]["status"], "success", "{response}");
    let v2c = v2c.unwrap();
    complete_repair_evaluation(&f, &v2c, true).await;
    lifecycle_finish_ready(&f, &v2c).await;
    // Updating a definition alone does not contaminate the running v1 context.
    let same = lifecycle_execute(
        &f,
        &v1c,
        &w1,
        "history-v1-still-safe",
        41,
        "write",
        json!({"path":"v1-still-safe.txt","content":"v1 continued after v2 activation"}),
    )
    .await
    .unwrap();
    assert_eq!(same.status, ResponseStatus::Success);
    assert_eq!(
        same.data["receipt"]["execution_id"],
        first.data["receipt"]["execution_id"]
    );
    // Real current Owner turn -> Pi goal.create admits a new Work and records
    // v2 history. This new admission never changes the original v1 Work pin.
    let (created, w2) = shared_goal_create(
        &f,
        &v2c.definition.ghost_id,
        &v2c.conversation_id,
        "history-v2-new-goal",
    )
    .await;
    assert_eq!(created["result"]["status"], "success", "{created}");
    let w2 = w2.unwrap();
    let new = shared_bound_inference(&f, &v2c, &w2, "history-new-authorized").await;
    assert_eq!(new["result"]["status"], "success", "{new}");
    let old = shared_bound_inference(&f, &v1c, &w1, "history-original-mixed").await;
    assert_eq!(old["result"]["error_code"], "shared_skill_scope_blocked");
    let prior: String = f
        .host
        .lock()
        .unwrap()
        .journal
        .0
        .query_row(
            "SELECT response_json FROM lifetime_pi_effects WHERE call_id='history-v1-effect'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let replay = lifecycle_execute(&f, &v1c, &w1, "history-v1-effect", 40, "write", args)
        .await
        .unwrap();
    assert_eq!(
        replay.error_code.as_deref(),
        Some("shared_skill_scope_blocked")
    );
    {
        let state = f.host.lock().unwrap();
        assert_eq!(state.journal.0.query_row("SELECT response_json FROM lifetime_pi_effects WHERE call_id='history-v1-effect'",[],|r|r.get::<_,String>(0)).unwrap(),prior);
        assert_eq!(
            bots_store::definition_for_work(&state.journal.0, &w1)
                .unwrap()
                .unwrap(),
            v1c.definition
        );
    }
    // Retained source cannot escape through independent stores/recipients.
    for method in [
        "mailbox.send",
        "memory.retain",
        "memory.session_record",
        "work.memory.record",
        "documents.review_page",
        "bot.prepare",
        "bot.repair",
    ] {
        let mut e = env(
            &format!("history-derivative-{method}"),
            json!({"method":method}),
        );
        e.actor_ref = v2c.definition.ghost_id.clone();
        let request = lifetime::PiToolRequest {
            context_ref: None, ghost_id: v2c.definition.ghost_id.clone(),
            conversation_id: v2c.conversation_id.clone(),
            envelope: e,
        };
        assert!(crate::host::shared_skills::request_guard(
            &f.host.lock().unwrap().journal.0,
            &request,
            lifetime::PiInferenceScope::Public
        )
        .is_err());
        let response = f
            .host
            .lifetime_pi_action(&request, lifetime::PiInferenceScope::Public)
            .await;
        assert!(response.is_err() || response.unwrap()["result"]["status"] != "success");
    }
    let delegate = |id: &str| {
        let mut e = env(
            id,
            json!({"method":"work.delegate","parent_work_id":w2.id,"target_ghost_id":f.ghost,"summary":"Authorized shared history summary","artifact_refs":[],"acceptance_spec":{}}),
        );
        e.actor_ref = v2c.definition.ghost_id.clone();
        e.expected_revision = Some(w2.goal_revision);
        lifetime::PiToolRequest {
            context_ref: None, ghost_id: v2c.definition.ghost_id.clone(),
            conversation_id: v2c.conversation_id.clone(),
            envelope: e,
        }
    };
    shared_grant(&f, &v2, &f.ghost, false, Some(1), "history-target-revoke");
    let before: u64 = f
        .host
        .lock()
        .unwrap()
        .journal
        .0
        .query_row("SELECT count(*) FROM lifetime_goals", [], |r| r.get(0))
        .unwrap();
    let denied = f
        .host
        .lifetime_pi_action(
            &delegate("history-delegate-missing-reader"),
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_ne!(denied["result"]["status"], "success", "{denied}");
    assert_eq!(
        f.host
            .lock()
            .unwrap()
            .journal
            .0
            .query_row("SELECT count(*) FROM lifetime_goals", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        before
    );
    shared_grant(&f, &v2, &f.ghost, true, Some(2), "history-target-regrant");
    let delivered = f
        .host
        .lifetime_pi_action(
            &delegate("history-delegate-authorized"),
            lifetime::PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(delivered["result"]["status"], "success", "{delivered}");
    let child: Work = serde_json::from_value(delivered["result"]["data"]["work"].clone()).unwrap();
    let (assignment, source_pins) = {
        let state = f.host.lock().unwrap();
        let a:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&child.id],|r|r.get(0)).unwrap();
        let pins:String=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind='shared_skill_work_pin_v1' AND id=?1",[format!("{}:{}:{}",child.id,child.goal_revision,child.owner_revision)],|r|r.get(0)).unwrap();
        (a, pins)
    };
    let pins: Vec<crate::host::shared_skills::Reader> = serde_json::from_str(&source_pins).unwrap();
    assert!(pins
        .iter()
        .any(|r| r.reference == v1 && r.ghost_id == f.ghost));
    assert!(pins
        .iter()
        .any(|r| r.reference == v2 && r.ghost_id == f.ghost && r.revision == 3));
    let mut e = env(
        "history-child-inspect",
        json!({"method":"conversation.assignment.inspect","assignment_id":assignment,"ghost_id":f.ghost,"conversation_id":f.conversation}),
    );
    e.actor_ref = f.ghost.clone();
    let child_request = lifetime::PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: e,
    };
    let inspected = f
        .host
        .lifetime_pi_action(&child_request, lifetime::PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(inspected["result"]["status"], "success", "{inspected}");
    // Primary has no active BotDefinition: history-only Work still snapshots.
    assert!(
        bots_store::active_definition(&f.host.lock().unwrap().journal.0, &f.ghost)
            .unwrap()
            .is_none()
    );
    let (history_only, work) =
        shared_goal_create(&f, &f.ghost, &f.conversation, "history-only-new-goal").await;
    assert_eq!(
        history_only["result"]["status"], "success",
        "{history_only}"
    );
    let work = work.unwrap();
    let state = f.host.lock().unwrap();
    let pins: String = state
        .journal
        .0
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='shared_skill_work_pin_v1' AND id=?1",
            [format!(
                "{}:{}:{}",
                work.id, work.goal_revision, work.owner_revision
            )],
            |r| r.get(0),
        )
        .unwrap();
    let pins: Vec<crate::host::shared_skills::Reader> = serde_json::from_str(&pins).unwrap();
    assert!(pins.iter().any(|r| r.reference == v1));
    assert!(pins.iter().any(|r| r.reference == v2));
    assert_eq!(
        state
            .journal
            .0
            .query_row(
                "SELECT count(*) FROM lifetime_mailbox WHERE sender_id=?1",
                [&v2c.definition.ghost_id],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn shared_skill_isolated_v1_context_survives_unrelated_v2_history_but_not_v1_revocation() {
    let (f,initial)=lifecycle_fixture().await;
    let (_,v1)=shared_publish(&f,"common","isolated-procedure",1,None);
    shared_grant(&f,&v1,&initial.definition.ghost_id,true,None,"isolated-v1-target");
    shared_grant(&f,&v1,&f.ghost,true,None,"isolated-v1-evaluator");
    shared_fixture_extension(&f);
    let (_,response,c)=shared_adopt(&f,&initial,&v1,"isolated-procedure","isolated-adopt-v1");
    assert_eq!(response["result"]["status"],"success","{response}");let c=c.unwrap();
    complete_repair_evaluation(&f,&c,true).await;lifecycle_finish_ready(&f,&c).await;
    let goal=lifecycle_goal(&f,&c,"isolated-running-v1");
    let w:Work=serde_json::from_value(goal["result"]["data"]["work"].clone()).unwrap();
    let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[&w.id],|r|r.get(0)).unwrap();
    let make=|id:&str,body:Value,reference:Option<String>| {let mut e=env(id,body);e.actor_ref=c.definition.ghost_id.clone();lifetime::PiToolRequest{context_ref:reference,ghost_id:c.definition.ghost_id.clone(),conversation_id:c.conversation_id.clone(),envelope:e}};
    let inspect=make("isolated-original-inspect",json!({"method":"conversation.assignment.inspect","assignment_id":assignment,"ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id}),None);
    let inspected=f.host.lifetime_pi_action(&inspect,lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(inspected["result"]["status"],"success","{inspected}");
    let context=inspected["result"]["data"]["execution_context"]["ref"].as_str().unwrap().to_owned();
    let claim=make("isolated-original-claim",json!({"method":"work.context.claim","assignment_id":assignment,"work_id":w.id,"context_ref":context,"generation_task_id":7,"provider_session_id":uuid::Uuid::new_v4().to_string(),"storage_ref":format!("ghost/work-contexts/{context}/durable.sqlite")}),Some(context.clone()));
    let claimed=f.host.lifetime_pi_action(&claim,lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(claimed["result"]["status"],"success","{claimed}");
    let effect=|id:&str,task:u64,path:&str| {let args=json!({"path":path,"content":"original v1 only"});make(id,json!({"method":"work.execute","assignment_id":assignment,"work_id":w.id,"generation_task_id":7,"task_id":task,"call_id":id,"operation":"write","arguments":args,"input_digest":canonical_digest(&json!({"operation":"write","arguments":args})).unwrap()}),Some(context.clone()))};
    let first_request=effect("isolated-v1-before",50,"isolated-before.txt");
    let first=f.host.lifetime_pi_execution_action(&first_request,lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(first.status,ResponseStatus::Success,"{first:?}");
    let (_,v2)=shared_publish(&f,"common","isolated-procedure",2,Some(1));
    shared_grant(&f,&v2,&c.definition.ghost_id,true,None,"isolated-v2-target");shared_grant(&f,&v2,&f.ghost,true,None,"isolated-v2-evaluator");
    shared_fixture_extension(&f);let (_,response,c2)=shared_adopt(&f,&c,&v2,"isolated-procedure","isolated-adopt-v2");assert_eq!(response["result"]["status"],"success","{response}");let c2=c2.unwrap();complete_repair_evaluation(&f,&c2,true).await;lifecycle_finish_ready(&f,&c2).await;
    let (created,_)=shared_goal_create(&f,&c2.definition.ghost_id,&c2.conversation_id,"isolated-owner-learned-v2").await;assert_eq!(created["result"]["status"],"success","{created}");
    shared_grant(&f,&v2,&c.definition.ghost_id,false,Some(1),"isolated-revoke-only-owner-v2");
    let owner=shared_unbound_inference(&f,&c.definition.ghost_id,&c.conversation_id,"isolated-owner-remains-fenced").await;assert_ne!(owner["result"]["status"],"success","{owner}");
    let disguised_owner=make("isolated-disguised-owner-inference",json!({"method":"inference.inspect"}),Some(context.clone()));
    let denied=f.host.lifetime_pi_action(&disguised_owner,lifetime::PiInferenceScope::Public).await.unwrap();assert_ne!(denied["result"]["status"],"success","{denied}");
    for method in ["conversation.turn.inspect","conversation.report.inspect","memory.context.inspect","documents.capabilities","bot.prepare"] {
        let disguised=make(&format!("isolated-disguised-{method}"),json!({"method":method,"ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"turn_id":"foreign-owner-turn"}),Some(context.clone()));
        let denied=f.host.lifetime_pi_action(&disguised,lifetime::PiInferenceScope::Public).await.unwrap();assert_ne!(denied["result"]["status"],"success","{method}: {denied}");
    }
    let inference=make("isolated-v1-inference",json!({"method":"inference.inspect","assignment_id":assignment,"work_id":w.id}),Some(context.clone()));
    let allowed=f.host.lifetime_pi_action(&inference,lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(allowed["result"]["status"],"success","{allowed}");
    let second=f.host.lifetime_pi_execution_action(&effect("isolated-v1-after",51,"isolated-after.txt"),lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(second.status,ResponseStatus::Success,"{second:?}");assert_eq!(second.data["receipt"]["execution_id"],first.data["receipt"]["execution_id"]);
    assert_eq!(f.host.lifetime_pi_execution_action(&first_request,lifetime::PiInferenceScope::Public).await.unwrap(),first);
    shared_grant(&f,&v1,&c.definition.ghost_id,false,Some(1),"isolated-revoke-actual-v1");
    let blocked=f.host.lifetime_pi_action(&inference,lifetime::PiInferenceScope::Public).await.unwrap();assert_ne!(blocked["result"]["status"],"success","{blocked}");
    assert_ne!(f.host.lifetime_pi_execution_action(&first_request,lifetime::PiInferenceScope::Public).await.unwrap().status,ResponseStatus::Success);
    let cancel=make("isolated-owner-cancel-after-source-revoke",json!({"method":"work.cancel","work_id":w.id}),None);
    let cancelled=f.host.lifetime_pi_action(&cancel,lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(cancelled["result"]["status"],"success","{cancelled}");
    let state=f.host.lock().unwrap();assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_executions WHERE work_id=?1",[&w.id],|r|r.get::<_,i64>(0)).unwrap(),1);assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1",[first.data["receipt"]["execution_id"].as_str().unwrap()],|r|r.get::<_,i64>(0)).unwrap(),2);
}
