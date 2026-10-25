use super::*;
use crate::host::{
    bots::{DefinitionContent, RevisionRef},
    bots_provisioning::{Asset, Fixture},
    lifetime::{
        self,
        pi_execution::tests as fixture,
        pi_tools::{PiInferenceScope, PiToolRequest},
    },
};
use crate::lifetime_contract::{ResponseStatus, VERSION};

fn fixtures() -> Vec<Fixture> {
    [
        json!({"rows":[{"label":"雪❄","enabled":true,"value":null}],"count":7}),
        json!([false, null, [1, "é"]]),
        json!(null),
        json!(false),
        json!("literal input"),
        json!(42),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, input)| Fixture {
        id: format!("arbitrary-case-{i}"),
        input,
        expected_output: json!({"private_oracle":"EXPECTED_OUTPUT_MUST_NOT_APPEAR"}),
    })
    .collect()
}

fn profile() -> EvaluationProfile {
    let fixtures = fixtures();
    EvaluationProfile {
        revision: 3,
        digest: canonical_digest(&json!({"revision":3,"fixtures":fixtures})).unwrap(),
        fixtures,
    }
}

#[test]
fn evaluation_inputs_preserve_all_original_json_types_without_expected_outputs() {
    let profile = profile();
    let pin = pin(&profile).unwrap();
    let bytes = input_bytes(&profile).unwrap();
    assert_eq!(pin, super::pin(&profile).unwrap());
    assert_eq!(pin.digest, format!("{:x}", Sha256::digest(&bytes)));
    assert!(!String::from_utf8(bytes.clone())
        .unwrap()
        .contains("EXPECTED_OUTPUT_MUST_NOT_APPEAR"));
    let file: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(file.as_object().unwrap().len(), 2);
    assert_eq!(file["kind"], FILE_KIND);
    for (actual, original) in file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&profile.fixtures)
    {
        assert_eq!(actual.as_object().unwrap().len(), 3);
        assert_eq!(actual["fixture_id"], original.id);
        assert_eq!(actual["input"], original.input);
        assert_eq!(
            actual["input_digest"],
            canonical_digest(&original.input).unwrap()
        );
    }
    let reference = input_reference(&pin).unwrap();
    assert!(reference.contains(&pin.path) && reference.contains(&pin.digest));
    assert!(!reference.contains("literal input") && !reference.contains("private_oracle"));
}

#[test]
fn evaluation_inputs_reject_changed_pins_case_identity_and_profile_bytes() {
    let original = profile();
    let expected = pin(&original).unwrap();
    for key in [
        "kind",
        "digest",
        "path",
        "evaluation_profile_digest",
        "case_count",
    ] {
        let mut value = serde_json::to_value(&expected).unwrap();
        value[key] = if key == "case_count" {
            json!(3)
        } else {
            json!("changed")
        };
        let changed: Pin = serde_json::from_value(value).unwrap();
        assert!(validate_pin(&original, &changed).is_err(), "{key}");
    }
    let mut changed = original.clone();
    changed.fixtures[0].input = json!({"changed":true});
    assert!(
        pin(&changed).is_err(),
        "unchanged claimed profile digest is insufficient"
    );
    changed.digest =
        canonical_digest(&json!({"revision":changed.revision,"fixtures":changed.fixtures}))
            .unwrap();
    assert!(validate_pin(&changed, &expected).is_err());
    changed.fixtures[0].id = changed.fixtures[1].id.clone();
    changed.digest =
        canonical_digest(&json!({"revision":changed.revision,"fixtures":changed.fixtures}))
            .unwrap();
    assert!(pin(&changed).is_err());
}

fn owner(id: &str, body: Value) -> Envelope {
    Envelope {
        protocol_version: VERSION.into(),
        command_id: id.into(),
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: "owner".into(),
        authority_epoch: 1,
        expected_revision: None,
        correlation_id: id.into(),
        body,
    }
}

fn admitted() -> (fixture::Fixture, Candidate) {
    let mut f = fixture::setup_with_spec(json!({}));
    let (candidate, work, assignment) = {
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let configured = lifetime::apply(
            conn,
            &owner(
                "evaluation-input-config",
                json!({"method":"bot.evaluation_profile.configure","fixtures":fixtures()}),
            ),
            "owner",
        )
        .unwrap();
        assert_eq!(configured.status, ResponseStatus::Success);
        let source = "Process each complete original JSON input using its actual type.";
        let instruction = RevisionRef {
            namespace: f.ghost.clone(),
            id: "evaluation-input-instructions".into(),
            revision: 1,
            digest: format!("{:x}", Sha256::digest(source.as_bytes())),
        };
        let content = DefinitionContent {
            purpose: "Generic independently evaluated transformation".into(),
            input_contract: json!({}),
            output_contract: json!({}),
            instruction_ref: instruction.clone(),
            skill_refs: vec![],
            skill_aliases: Default::default(),
            acceptance_policy_ref: serde_json::from_value(
                configured.data["acceptance_policy_ref"].clone(),
            )
            .unwrap(),
            required_capabilities: vec!["read".into(), "write".into(), "publish_artifact".into()],
            memory_profile_ref: None,
            execution_profile_ref: serde_json::from_value(
                configured.data["execution_profile_ref"].clone(),
            )
            .unwrap(),
        };
        let prepare = owner(
            "evaluation-input-prepare",
            json!({"method":"bot.prepare","display_name":"Generic JSON transformation","content":content,"source_work_ids":[]}),
        );
        let prepared = lifetime::apply_with_admission(conn, &prepare, "owner", |tx| {
            bots_provisioning::prepare(
                tx,
                &prepare,
                "owner",
                vec![Asset {
                    reference: instruction,
                    content: source.into(),
                    privacy: "public".into(),
                }],
            )
            .map(Some)
        })
        .unwrap();
        assert_eq!(prepared.status, ResponseStatus::Success);
        let candidate =
            bots_provisioning::candidate(conn, prepared.data["candidate_id"].as_str().unwrap())
                .unwrap();
        let result=lifetime::apply(conn,&owner("evaluation-input-admit",json!({"method":"bot.evaluate","candidate_id":candidate.id,"candidate_digest":candidate.digest})),"owner").unwrap();
        assert_eq!(result.status, ResponseStatus::Success, "{result:?}");
        let work = result.data["evaluation_work_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let assignment=conn.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&work],|r|r.get::<_,String>(0)).unwrap();
        (candidate, work, assignment)
    };
    f.work = work;
    f.assignment = assignment;
    (f, candidate)
}

#[tokio::test]
async fn evaluation_inputs_original_work_inspects_and_stages_exact_bytes_without_verifier_authority(
) {
    let (f, candidate) = admitted();
    let pin = candidate.evaluation_inputs.as_ref().unwrap();
    let before = {
        let state = f.host.lock().unwrap();
        let work = db::work(&state.journal.0, &f.work).unwrap().unwrap();
        let descriptor = work_input_descriptor(&state.journal.0, &work)
            .unwrap()
            .unwrap();
        assert_eq!(descriptor["work_id"], work.id);
        assert_eq!(descriptor["candidate_digest"], candidate.digest);
        assert_eq!(descriptor["sha256"], pin.digest);
        assert!(
            super::super::task_contracts::work_source(&state.journal.0, &work)
                .unwrap()
                .is_none(),
            "input data must never become an Owner verifier grant"
        );
        let snapshot = input_snapshot(&state.journal.0, &work).unwrap().unwrap();
        assert_eq!(snapshot.0, pin.path);
        let raw: Value = serde_json::from_slice(&snapshot.1).unwrap();
        assert_eq!(raw["cases"].as_array().unwrap().len(), fixtures().len());
        state
            .journal
            .0
            .query_row::<String, _, _>(
                "SELECT response FROM lifetime_commands WHERE command_id='evaluation-input-admit'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    let inspect = PiToolRequest {
        context_ref: None,
        ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: fixture::envelope(&f.ghost, json!({"method":"work.inspect","work_id":f.work})),
    };
    let response = f
        .host
        .lifetime_pi_action(&inspect, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    assert_eq!(response["result"]["data"]["task_input"]["path"], pin.path);
    let read = f
        .host
        .lifetime_pi_execution_action(
            &fixture::request(
                &f,
                10,
                "read-evaluation-input",
                "read",
                json!({"path":pin.path}),
            ),
            PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(read.status, ResponseStatus::Success, "{read:?}");
    assert_eq!(read.data["output"]["sha256"], pin.digest);
    assert_eq!(
        serde_json::from_str::<Value>(read.data["output"]["content"].as_str().unwrap()).unwrap(),
        serde_json::from_slice::<Value>(&input_bytes(&candidate.evaluation_profile).unwrap())
            .unwrap()
    );
    let state = f.host.lock().unwrap();
    assert_eq!(
        state
            .journal
            .0
            .query_row::<String, _, _>(
                "SELECT response FROM lifetime_commands WHERE command_id='evaluation-input-admit'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        before,
        "original full admission receipt must remain byte-identical"
    );
    let reopened =
        crate::host::scheduler::Journal::open(&f._root.path().join("workspace.db")).unwrap();
    let work = db::work(&reopened.0, &f.work).unwrap().unwrap();
    assert_eq!(
        input_snapshot(&reopened.0, &work).unwrap().unwrap().1,
        input_bytes(&candidate.evaluation_profile).unwrap()
    );
}

#[tokio::test]
async fn evaluation_inputs_reject_cross_work_changed_goal_scope_epoch_and_missing_receipts() {
    let (f, candidate) = admitted();
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    let work = db::work(conn, &f.work).unwrap().unwrap();
    assert!(input_snapshot(conn, &work).unwrap().is_some());
    let replay=lifetime::apply(conn,&owner("equivalent-evaluation-request",json!({"method":"bot.evaluate","candidate_id":candidate.id,"candidate_digest":candidate.digest})),"owner").unwrap();
    assert_eq!(replay.status, ResponseStatus::Success);
    assert_eq!(replay.data["evaluation_work_id"], work.id);
    assert!(input_snapshot(conn, &work).unwrap().is_some());
    for changed in [
        Work {
            id: "other-work".into(),
            ..work.clone()
        },
        Work {
            owner_revision: work.owner_revision + 1,
            ..work.clone()
        },
        Work {
            goal_revision: work.goal_revision + 1,
            ..work.clone()
        },
        Work {
            owner: "other-ghost".into(),
            ..work.clone()
        },
    ] {
        assert!(input_snapshot(conn, &changed).is_err());
    }
    conn.execute_batch("SAVEPOINT changed_input_scope").unwrap();
    conn.execute("UPDATE lifetime_goals SET payload=json_set(payload,'$.prompt','forged replacement') WHERE id=?1",[&work.goal_id]).unwrap();
    assert!(input_snapshot(conn, &work).is_err());
    conn.execute_batch("ROLLBACK TO changed_input_scope; RELEASE changed_input_scope")
        .unwrap();
    conn.execute_batch("SAVEPOINT changed_input_scope").unwrap();
    conn.execute(
        "UPDATE lifetime_authority SET authority_epoch=authority_epoch+1 WHERE singleton=1",
        [],
    )
    .unwrap();
    assert!(input_snapshot(conn, &work).is_err());
    assert!(
        work_input_descriptor(conn, &work).unwrap().is_some(),
        "historical metadata is not authority to stage at a new epoch"
    );
    conn.execute_batch("ROLLBACK TO changed_input_scope; RELEASE changed_input_scope")
        .unwrap();
    conn.execute_batch("SAVEPOINT changed_input_scope").unwrap();
    conn.execute("UPDATE lifetime_commands SET response=json_remove(response,'$.data.goal') WHERE command_id='evaluation-input-admit'",[]).unwrap();
    assert!(input_snapshot(conn, &work).is_err());
    conn.execute_batch("ROLLBACK TO changed_input_scope; RELEASE changed_input_scope")
        .unwrap();
    assert!(input_snapshot(conn, &work).unwrap().is_some());

    conn.execute_batch("SAVEPOINT changed_input_scope").unwrap();
    conn.execute("UPDATE workspace_objects SET payload=json_remove(payload,'$.evaluation_inputs') WHERE kind='bot_candidate_v1' AND id=(SELECT json_extract(payload,'$.candidate_id') FROM workspace_objects WHERE kind='bot_provisioning_v1' AND json_extract(payload,'$.evaluation_work_id')=?1)",[&work.id]).unwrap();
    assert!(
        input_snapshot(conn, &work).is_err(),
        "a required new pin cannot silently fall back to inline input"
    );
    conn.execute_batch("ROLLBACK TO changed_input_scope; RELEASE changed_input_scope")
        .unwrap();

    // Later Owner configuration is not the immutable profile of this Work.
    let original = input_snapshot(conn, &work).unwrap().unwrap();
    let mut next = fixtures();
    next[0].input = json!({"new_owner_configuration":true});
    let mut configure = owner(
        "later-evaluation-input-config",
        json!({"method":"bot.evaluation_profile.configure","fixtures":next}),
    );
    configure.expected_revision = Some(1);
    assert_eq!(
        lifetime::apply(conn, &configure, "owner").unwrap().status,
        ResponseStatus::Success
    );
    assert_eq!(input_snapshot(conn, &work).unwrap().unwrap(), original);

    conn.execute_batch("SAVEPOINT changed_input_scope").unwrap();
    let (request,response):(String,String)=conn.query_row("SELECT request,response FROM lifetime_commands WHERE command_id='evaluation-input-admit'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    let mut duplicated: Envelope = serde_json::from_str(&request).unwrap();
    duplicated.command_id = "duplicate-original-evaluation".into();
    conn.execute("INSERT INTO lifetime_commands(command_id,payload_digest,actor_ref,authority_epoch,request,response) VALUES(?1,?2,?3,?4,?5,?6)",params![duplicated.command_id,duplicated.payload_digest,duplicated.actor_ref,duplicated.authority_epoch,serde_json::to_string(&duplicated).unwrap(),response]).unwrap();
    assert_eq!(
        input_snapshot(conn, &work).unwrap().unwrap(),
        original,
        "an equivalent corroborating receipt does not replace the original assignment source"
    );
    conn.execute("UPDATE lifetime_commands SET response=json_set(response,'$.data.work.owner_revision',999) WHERE command_id='evaluation-input-admit'",[]).unwrap();
    assert!(
        input_snapshot(conn, &work).is_err(),
        "a conflicting original source must not fall back to a corroborating receipt"
    );
    conn.execute_batch("ROLLBACK TO changed_input_scope; RELEASE changed_input_scope")
        .unwrap();
}

#[tokio::test]
async fn evaluation_inputs_staged_file_tampering_is_not_repaired_or_reexecuted() {
    let (f, candidate) = admitted();
    let pin = candidate.evaluation_inputs.as_ref().unwrap();
    let read = f
        .host
        .lifetime_pi_execution_action(
            &fixture::request(
                &f,
                10,
                "original-evaluation-input",
                "read",
                json!({"path":pin.path}),
            ),
            PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(read.status, ResponseStatus::Success, "{read:?}");
    let execution = read.data["receipt"]["execution_id"].as_str().unwrap();
    let directory = f
        .host
        .native_computers
        .as_ref()
        .unwrap()
        .pi_fixture_snapshot(&f.ghost, execution, 1)
        .unwrap();
    let path = directory.join(&pin.path);
    std::fs::write(&path, b"task-side replacement").unwrap();
    let request = fixture::request(
        &f,
        11,
        "changed-evaluation-input",
        "read",
        json!({"path":pin.path}),
    );
    let rejected = f
        .host
        .lifetime_pi_execution_action(&request, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(
        rejected.error_code.as_deref(),
        Some("effect_unknown"),
        "{rejected:?}"
    );
    assert_eq!(
        f.host
            .lifetime_pi_execution_action(&request, PiInferenceScope::Public)
            .await
            .unwrap(),
        rejected
    );
    assert_eq!(std::fs::read(path).unwrap(), b"task-side replacement");
}
