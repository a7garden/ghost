// Component proof of the normal Owner lifecycle; no native engine or model calls.
async fn memory_update_active() -> MemoryBotFixture {
    let f = memory_bot_fixture(true).await;
    memory_owner_policy(&f, true);
    f.host.validate_bot_memory(&f.c).await.unwrap();
    let response = f
        .host
        .lifetime_action(&request(
            "memory-update-original-active",
            "bot.activate",
            &f.c,
        ))
        .unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    f
}
fn memory_update_configure(f: &MemoryBotFixture, id: &str) -> Value {
    let mut command = env(
        id,
        json!({"method":"work.memory.profile.configure","ghost_id":f.c.definition.ghost_id,"binding_ids":["shared"],"required":true,"experience_space_id":null}),
    );
    command.expected_revision = Some(1);
    let response = f.host.lifetime_action(&command).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    response["result"]["data"]["profile_ref"].clone()
}
fn memory_update_command(f: &MemoryBotFixture, id: &str, pin: Value) -> Envelope {
    env(
        id,
        json!({"method":"bot.update.prepare","ghost_id":f.c.definition.ghost_id,"definition_ref":bots_store::DefinitionPointer::from(&f.c.definition),"memory_profile_ref":pin}),
    )
}
fn memory_update_prepare(f: &MemoryBotFixture, command: &Envelope) -> Candidate {
    let response = f.host.lifetime_action(command).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    candidate(
        &f.host.lock().unwrap().journal.0,
        response["result"]["data"]["candidate_id"].as_str().unwrap(),
    )
    .unwrap()
}
fn memory_update_selected(f: &MemoryBotFixture) -> BotDefinition {
    bots_store::active_definition(&f.host.lock().unwrap().journal.0, &f.c.definition.ghost_id)
        .unwrap()
        .unwrap()
}
async fn memory_update_evaluation(f: &MemoryBotFixture, c: &Candidate) {
    memory_update_evaluation_host(&f.host, c).await;
}
async fn memory_update_evaluation_host(host: &Host, c: &Candidate) {
    let (ghost, conversation, work, assignment) = {
        let state = host.lock().unwrap();
        let (ghost, conversation): (String, String) = state
            .journal
            .0
            .query_row(
                "SELECT ghost_id,conversation_id FROM lifetime_registry WHERE kind='primary'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let work = progress(&state.journal.0, &c.id)
            .unwrap()
            .evaluation_work_id
            .unwrap();
        let assignment:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.work_id')=?1",[&work],|r|r.get(0)).unwrap();
        (ghost, conversation, work, assignment)
    };
    for (task, call, operation, arguments) in [
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
            json!({"path":"bot-evaluation.json","privacy":c.privacy}),
        ),
    ] {
        let mut command = env(
            &format!("memory-update-{}-{call}", c.id),
            json!({"method":"work.execute","assignment_id":assignment,"work_id":work,"generation_task_id":7,"task_id":task,"call_id":call,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":arguments})).unwrap(),"arguments":arguments}),
        );
        command.actor_ref = ghost.clone();
        command.authority_epoch = host.authority_epoch;
        let response = host
            .lifetime_pi_execution_action(
                &lifetime::PiToolRequest {
                    context_ref: None,
                    ghost_id: ghost.clone(),
                    conversation_id: conversation.clone(),
                    envelope: command,
                },
                lifetime::PiInferenceScope::Local,
            )
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    }
    let mut command = env(
        &format!("memory-update-complete-{}", c.id),
        json!({"method":"work.execution.complete","assignment_id":assignment,"work_id":work,"task_id":7,"summary":"Independent held-out fixture artifact"}),
    );
    command.actor_ref = ghost.clone();
    command.authority_epoch = host.authority_epoch;
    let response = host
        .lifetime_pi_execution_action(
            &lifetime::PiToolRequest {
                context_ref: None,
                ghost_id: ghost,
                conversation_id: conversation,
                envelope: command,
            },
            lifetime::PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    host.verify_bot_evaluation(c).unwrap();
}
async fn memory_update_provision(f: &MemoryBotFixture, c: &Candidate) {
    memory_update_provision_host(&f.host, c).await;
}
async fn memory_update_provision_host(host: &Host, c: &Candidate) {
    let mut command = request(
        &format!("memory-update-provision-{}", c.id),
        "bot.provision",
        c,
    );
    command.authority_epoch = host.authority_epoch;
    let response = host.lifetime_action(&command).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    let pending = {
        let state = host.lock().unwrap();
        lifetime::pending_outbox(&state.journal.0)
            .unwrap()
            .into_iter()
            .find(|o| {
                o.payload["body"]["method"] == "conversation.ensure"
                    && o.payload["body"]["ghost_id"] == c.definition.ghost_id
            })
    };
    if let Some(pending) = pending {
        let entry =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/ghost-durable/src/main.js");
        let mut pi = host::lifetime_runtime::PiProcess::start(
            &entry,
            &host.root.join("memory-pi"),
            &host.root,
            "fixture",
            "fixture-callback",
            host.authority_epoch,
            None,
        )
        .await
        .unwrap();
        let receipt = pi
            .request(&serde_json::from_value(pending.payload).unwrap())
            .await
            .unwrap();
        pi.close().await.unwrap();
        lifetime::ack_outbox(
            &host.lock().unwrap().journal.0,
            pending.id,
            &serde_json::to_value(receipt).unwrap(),
        )
        .unwrap();
    }
}
fn memory_update_admit(f: &MemoryBotFixture, id: &str) -> Work {
    let response=f.host.lifetime_action(&env(id,json!({"method":"goal.submit","ghost_id":f.c.definition.ghost_id,"conversation_id":f.c.conversation_id,"prompt":"Use selected immutable memory revision","privacy":"public","acceptance_spec":{}}))).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    serde_json::from_value(response["result"]["data"]["work"].clone()).unwrap()
}
#[tokio::test]
async fn memory_update_rotated_authority_requires_evaluated_adoption_and_preserves_history() {
    let f = memory_update_active().await;
    let old_work = memory_update_admit(&f, "memory-update-old-work");
    let (old_grant, old_profile) = {
        let state = f.host.lock().unwrap();
        (
            raw_grant_no_lock(&state.journal.0, &old_work),
            host::work_memory::resolve_definition_profile(
                &state.journal.0,
                &f.c.definition.ghost_id,
                f.c.definition.content.memory_profile_ref.as_ref().unwrap(),
            )
            .unwrap(),
        )
    };
    let path = f.engine.join("grants.json");
    let mut grants: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let grant = grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token")
        .unwrap();
    grants["rotated-fixture-token"] = grant;
    std::fs::write(&path, serde_json::to_vec(&grants).unwrap()).unwrap();
    std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", "rotated-fixture-token");
    let pin = memory_update_configure(&f, "memory-update-profile-v2");
    assert!(!host::bots_memory::definition_current(
        &f.host.lock().unwrap().journal.0,
        &f.c.definition
    )
    .unwrap());
    let command = memory_update_command(&f, "memory-update-adopt-v2", pin.clone());
    let new = memory_update_prepare(&f, &command);
    assert_eq!(new.definition.ghost_id, f.c.definition.ghost_id);
    assert_eq!(new.definition.revision, 2);
    assert_eq!(
        new.definition.content.instruction_ref,
        f.c.definition.content.instruction_ref
    );
    assert_eq!(new.assets, f.c.assets);
    assert_eq!(
        new.definition.content.required_capabilities,
        f.c.definition.content.required_capabilities
    );
    assert_eq!(new.conversation_id, f.c.conversation_id);
    assert_eq!(new.privacy, "private");
    assert_eq!(memory_update_selected(&f), f.c.definition);
    assert!(f
        .host
        .lifetime_action(&request("memory-update-too-early", "bot.activate", &new))
        .is_err());
    memory_update_evaluation(&f, &new).await;
    memory_update_provision(&f, &new).await;
    f.host.validate_bot_memory(&new).await.unwrap();
    let response = f
        .host
        .lifetime_action(&request("memory-update-active-v2", "bot.activate", &new))
        .unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    assert_eq!(memory_update_selected(&f), new.definition);
    let new_work = memory_update_admit(&f, "memory-update-new-work");
    let reopened = Journal::open(&f.root.path().join("workspace.db")).unwrap();
    assert_eq!(raw_grant_no_lock(&reopened.0, &old_work), old_grant);
    assert_eq!(
        bots_store::definition_for_work(&reopened.0, &old_work)
            .unwrap()
            .unwrap(),
        f.c.definition
    );
    assert_eq!(
        bots_store::definition_for_work(&reopened.0, &new_work)
            .unwrap()
            .unwrap(),
        new.definition
    );
    assert_eq!(
        serde_json::to_value(
            host::work_memory::resolve_definition_profile(
                &reopened.0,
                &f.c.definition.ghost_id,
                f.c.definition.content.memory_profile_ref.as_ref().unwrap()
            )
            .unwrap()
        )
        .unwrap(),
        serde_json::to_value(old_profile).unwrap()
    );
    assert_eq!(
        serde_json::to_value(new.definition.content.memory_profile_ref.as_ref().unwrap()).unwrap(),
        pin
    );
    assert_ne!(raw_grant_no_lock(&reopened.0, &new_work), old_grant);
    assert_eq!(candidate(&reopened.0, &f.c.id).unwrap(), f.c);
    assert_eq!(
        reopened
            .0
            .query_row(
                "SELECT count(*) FROM lifetime_registry WHERE kind='primary'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn memory_update_rejects_wrong_owner_reference_configuration_and_nonowner() {
    let f = memory_update_active().await;
    let pin = memory_update_configure(&f, "memory-update-negative-v2");
    for variant in [
        "owner",
        "revision",
        "digest",
        "unconfigured",
        "mixed",
        "actor",
        "epoch",
        "null",
    ] {
        let mut value = pin.clone();
        match variant {
            "owner" => value["namespace"] = json!(f.c.id),
            "revision" => value["revision"] = json!(99),
            "digest" => value["digest"] = json!("f".repeat(64)),
            "null" => value = Value::Null,
            "unconfigured" => std::env::set_var(
                "GHOST_BRAIN_TOKEN_SHARED_FIXTURE",
                "changed-unconfigured-fixture-token",
            ),
            _ => {}
        }
        let mut command =
            memory_update_command(&f, &format!("memory-update-invalid-{variant}"), value);
        match variant {
            "mixed" => {
                command.body["instructions"] = json!("unrequested instruction replacement");
                command.payload_digest = canonical_digest(&command.body).unwrap();
            }
            "actor" => command.actor_ref = f.c.definition.ghost_id.clone(),
            "epoch" => command.authority_epoch = 2,
            _ => {}
        }
        let response = f.host.lifetime_action(&command);
        assert!(
            response.is_err() || response.as_ref().unwrap()["result"]["status"] != "success",
            "{variant}: {response:?}"
        );
        if variant == "unconfigured" {
            std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", "shared-fixture-token");
        }
        assert_eq!(memory_update_selected(&f), f.c.definition);
    }
    assert_eq!(
        f.host
            .lock()
            .unwrap()
            .journal
            .0
            .query_row(
                "SELECT count(*) FROM workspace_objects WHERE kind='bot_candidate_v1'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn memory_update_authenticated_source_rejects_resealed_reference_privacy_and_capability_changes(
) {
    let f = memory_update_active().await;
    let pin = memory_update_configure(&f, "memory-update-proof-v2");
    let command = memory_update_command(&f, "memory-update-proof", pin);
    let new = memory_update_prepare(&f, &command);
    let state = f.host.lock().unwrap();
    let original_control: Value = state
        .journal
        .get("bot_control_intent_v1", &command.command_id)
        .unwrap()
        .unwrap();
    for variant in ["reference", "privacy", "capability"] {
        let mut changed = new.clone();
        match variant {
            "reference" => {
                changed.definition.content.memory_profile_ref =
                    f.c.definition.content.memory_profile_ref.clone()
            }
            "privacy" => changed.privacy = "public".into(),
            _ => changed
                .definition
                .content
                .required_capabilities
                .push("browser".into()),
        }
        changed.definition = BotDefinition::new(
            changed.definition.ghost_id.clone(),
            changed.definition.revision,
            changed.definition.content,
        )
        .unwrap();
        changed.digest = changed.expected_digest().unwrap();
        changed.validate().unwrap();
        let mut control = original_control.clone();
        control["candidate_digest"] = json!(changed.digest);
        save(&state.journal.0, CANDIDATES, &changed.id, &changed).unwrap();
        save(
            &state.journal.0,
            "bot_control_intent_v1",
            &command.command_id,
            &control,
        )
        .unwrap();
        assert!(
            host::bot_lifecycle::evaluation_envelope(&state.journal.0, &command).is_err(),
            "{variant}"
        );
    }
    save(&state.journal.0, CANDIDATES, &new.id, &new).unwrap();
    save(
        &state.journal.0,
        "bot_control_intent_v1",
        &command.command_id,
        &original_control,
    )
    .unwrap();
    assert!(host::bot_lifecycle::evaluation_envelope(&state.journal.0, &command).is_ok());
}
#[tokio::test]
async fn memory_update_revoked_auth_and_changed_epoch_cannot_activate_replacement() {
    let f = memory_update_active().await;
    let pin = memory_update_configure(&f, "memory-update-revoke-v2");
    let command = memory_update_command(&f, "memory-update-revoke", pin);
    let new = memory_update_prepare(&f, &command);
    memory_update_evaluation(&f, &new).await;
    memory_update_provision(&f, &new).await;
    let path = f.engine.join("grants.json");
    let original = std::fs::read(&path).unwrap();
    let mut grants: Value = serde_json::from_slice(&original).unwrap();
    grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token");
    std::fs::write(&path, serde_json::to_vec(&grants).unwrap()).unwrap();
    f.host.validate_bot_memory(&new).await.unwrap();
    assert!(f
        .host
        .lifetime_action(&request(
            "memory-update-revoked-active",
            "bot.activate",
            &new
        ))
        .is_err());
    assert_eq!(memory_update_selected(&f), f.c.definition);
    assert_eq!(
        host::bots_memory::readiness(&f.host.lock().unwrap().journal.0, &new, 1).unwrap()["reason"],
        "memory_authentication_unavailable"
    );
    std::fs::write(&path, original).unwrap();
    f.host.validate_bot_memory(&new).await.unwrap();
    {
        let state = f.host.lock().unwrap();
        state.journal.0.execute("UPDATE lifetime_authority SET authority_epoch=authority_epoch+1,dispatch_enabled=0 WHERE singleton=1",[]).unwrap();
    }
    let response = f
        .host
        .lifetime_action(&request("memory-update-stale-active", "bot.activate", &new))
        .unwrap();
    assert_eq!(response["result"]["error_code"], "authority_fenced");
    assert_eq!(memory_update_selected(&f), f.c.definition);
    assert_eq!(
        host::bots_memory::readiness(&f.host.lock().unwrap().journal.0, &new, 2).unwrap()
            ["verified"],
        false
    );
}
#[tokio::test]
async fn memory_update_ready_proof_stops_when_active_definition_is_replaced() {
    let f = memory_update_active().await;
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            host::bots_memory::readiness(&state.journal.0, &f.c, 1).unwrap()["verified"],
            true
        );
    }
    let replacement = BotDefinition::new(
        f.c.definition.ghost_id.clone(),
        2,
        f.c.definition.content.clone(),
    )
    .unwrap();
    let mut command = env(
        "memory-update-metadata-only-pointer",
        json!({"method":"bot.definition.update","definition":replacement}),
    );
    command.expected_revision = Some(1);
    let response = f.host.lifetime_action(&command).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    let state = f.host.lock().unwrap();
    assert_eq!(progress(&state.journal.0, &f.c.id).unwrap().state, "ready");
    assert_eq!(
        host::bots_memory::readiness(&state.journal.0, &f.c, 1).unwrap()["verified"],
        false
    );
    assert!(
        !host::bot_lifecycle::admission_allowed(&state.journal.0, &f.c.definition.ghost_id)
            .unwrap()
    );
}
