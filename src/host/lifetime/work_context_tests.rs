use super::*;
use crate::host::lifetime::{
    self,
    pi_execution::tests::{self as fixture, Fixture},
    pi_tools::{self, PiInferenceScope},
};
use crate::lifetime_contract::ResponseStatus;

fn request(f: &Fixture, body: Value, reference: Option<&str>) -> PiToolRequest {
    PiToolRequest {
        context_ref: reference.map(str::to_owned),
        ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: fixture::envelope(&f.ghost, body),
    }
}
fn descriptor(f: &Fixture) -> Value {
    view(&f.host.lock().unwrap().journal.0, &f.assignment)
        .unwrap()
        .unwrap()
}
fn claim_request(f: &Fixture) -> PiToolRequest {
    let d = descriptor(f);
    request(
        f,
        json!({"method":"work.context.claim","assignment_id":f.assignment,"work_id":f.work,"context_ref":d["ref"],"generation_task_id":7,"provider_session_id":uuid::Uuid::new_v4().to_string(),"storage_ref":format!("ghost/work-contexts/{}/durable.sqlite",d["ref"].as_str().unwrap())}),
        d["ref"].as_str(),
    )
}
fn apply(f: &Fixture, r: &PiToolRequest) -> Result<Response> {
    pi_tools::apply(
        &f.host.lock().unwrap().journal.0,
        r,
        PiInferenceScope::Public,
        f.host.native_computers.as_ref(),
    )
}
fn succeeds(response: Result<Response>) -> Response {
    let r = response.unwrap();
    assert_eq!(r.status, ResponseStatus::Success, "{r:?}");
    r
}
fn refused(response: Result<Response>) {
    assert!(response.is_err() || response.unwrap().status != ResponseStatus::Success);
}

#[tokio::test]
async fn work_context_claim_fences_forged_generation_revision_and_legacy_relabel() {
    let f = fixture::setup_with_spec(json!({}));
    let claim = claim_request(&f);
    let reference = claim.context_ref.as_deref().unwrap();
    let inference = request(
        &f,
        json!({"method":"inference.inspect","assignment_id":f.assignment,"work_id":f.work}),
        Some(reference),
    );
    refused(apply(&f, &inference));
    let ack = succeeds(apply(&f, &claim));
    assert_eq!(succeeds(apply(&f, &claim)), ack);
    succeeds(apply(&f, &inference));
    let settings = request(
        &f,
        json!({"method":"inference.settings","assignment_id":f.assignment,"work_id":f.work}),
        Some(reference),
    );
    succeeds(pi_tools::apply(
        &f.host.lock().unwrap().journal.0,
        &settings,
        PiInferenceScope::Selected,
        f.host.native_computers.as_ref(),
    ));
    let unbound = request(&f, json!({"method":"inference.settings"}), Some(reference));
    refused(pi_tools::apply(
        &f.host.lock().unwrap().journal.0,
        &unbound,
        PiInferenceScope::Selected,
        f.host.native_computers.as_ref(),
    ));
    let mut forged = inference.clone();
    forged.context_ref = Some(format!("wc-{}", "0".repeat(64)));
    refused(apply(&f, &forged));
    let mut changed = claim.clone();
    changed.envelope.body["generation_task_id"] = json!(8);
    changed.envelope.payload_digest = canonical_digest(&changed.envelope.body).unwrap();
    refused(apply(&f, &changed));
    let mut write = fixture::request(
        &f,
        10,
        "one",
        "write",
        json!({"path":"context.txt","content":"original"}),
    );
    write.context_ref = Some(reference.into());
    let first = f
        .host
        .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(first.status, ResponseStatus::Success, "{first:?}");
    assert_eq!(
        f.host
            .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
            .await
            .unwrap(),
        first
    );
    let mut wrong = write.clone();
    wrong.envelope.body["generation_task_id"] = json!(8);
    wrong.envelope.payload_digest = canonical_digest(&wrong.envelope.body).unwrap();
    assert_ne!(
        f.host
            .lifetime_pi_execution_action(&wrong, PiInferenceScope::Public)
            .await
            .unwrap()
            .status,
        ResponseStatus::Success
    );
    let mut missing = write.clone();
    missing.context_ref = None;
    assert_ne!(
        f.host
            .lifetime_pi_execution_action(&missing, PiInferenceScope::Public)
            .await
            .unwrap()
            .status,
        ResponseStatus::Success
    );
    let conn = Connection::open(f.host.root.join("workspace.db")).unwrap();
    assert!(validate(&conn, &inference).unwrap().is_some());
    assert_eq!(
        succeeds(pi_tools::apply(
            &conn,
            &claim,
            PiInferenceScope::Public,
            None
        )),
        ack
    );
    let mut stale = inference.clone();
    stale.envelope.authority_epoch = 2;
    refused(pi_tools::apply(
        &conn,
        &stale,
        PiInferenceScope::Public,
        None,
    ));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM lifetime_pi_executions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM lifetime_pi_effects", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let mut unknown = first.clone();
    unknown.status = ResponseStatus::Error;
    unknown.error_code = Some("effect_unknown".into());
    unknown.data["receipt"]["state"] = json!("unknown");
    conn.execute(
        "UPDATE lifetime_pi_effects SET state='unknown',response_json=?1",
        [serde_json::to_string(&unknown).unwrap()],
    )
    .unwrap();
    assert_eq!(
        f.host
            .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
            .await
            .unwrap(),
        unknown
    );
    let mut new_call = fixture::request(
        &f,
        11,
        "after-unknown",
        "write",
        json!({"path":"after-unknown.txt","content":"must not dispatch"}),
    );
    new_call.context_ref = Some(reference.into());
    let blocked = f
        .host
        .lifetime_pi_execution_action(&new_call, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(blocked.error_code.as_deref(), Some("effect_unknown"));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM lifetime_pi_effects", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!f
        .host
        .root
        .join("registry/computers/pi-fixture/tasks/after-unknown.txt")
        .exists());
    conn.execute(
        "UPDATE lifetime_pi_effects SET state='complete',response_json=?1",
        [serde_json::to_string(&first).unwrap()],
    )
    .unwrap();
    drop(conn);
    succeeds(apply(
        &f,
        &request(&f, json!({"method":"work.children","work_id":f.work}), None),
    ));
    succeeds(apply(
        &f,
        &request(&f, json!({"method":"work.cancel","work_id":f.work}), None),
    ));
    let legacy = fixture::setup_with_spec(json!({}));
    let old = fixture::request(
        &legacy,
        10,
        "legacy",
        "write",
        json!({"path":"old.txt","content":"old"}),
    );
    assert_eq!(
        legacy
            .host
            .lifetime_pi_execution_action(&old, PiInferenceScope::Public)
            .await
            .unwrap()
            .status,
        ResponseStatus::Success
    );
    refused(apply(&legacy, &claim_request(&legacy)));
    {
        let state = legacy.host.lock().unwrap();
        state
            .journal
            .0
            .execute("DELETE FROM workspace_objects WHERE kind=?1", [CONTEXT])
            .unwrap();
    }
    assert!(
        view(&legacy.host.lock().unwrap().journal.0, &legacy.assignment)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        legacy
            .host
            .lifetime_pi_execution_action(&old, PiInferenceScope::Public)
            .await
            .unwrap()
            .status,
        ResponseStatus::Success
    );
}

fn receipt(
    f: &Fixture,
    item: &lifetime::OutboxItem,
    storage: &str,
    reference: Option<&str>,
) -> Value {
    let mut data = json!({"command_id":item.payload["command_id"],"ghost_id":f.ghost,"conversation_id":f.conversation,"runtime_kind":"pi-durable","runtime_release":"1.1.0","storage_ref":storage});
    if let Some(reference) = reference {
        data["context_ref"] = json!(reference);
    }
    json!({"status":"success","data":data})
}

#[tokio::test]
async fn work_context_ack_keeps_owner_store_and_distinct_work_receipts() {
    let mut f = fixture::setup_with_spec(json!({}));
    let state = f.host.lock().unwrap();
    let input=lifetime::apply(&state.journal.0,&fixture::envelope("owner",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"Canonical Owner monitoring","privacy":"public","attachments":[]})),"owner").unwrap();
    assert_eq!(input.status, ResponseStatus::Success);
    let pending = lifetime::pending_outbox(&state.journal.0).unwrap();
    let owner = pending
        .iter()
        .find(|i| i.payload["body"]["method"] == "conversation.input")
        .unwrap();
    lifetime::ack_outbox(
        &state.journal.0,
        owner.id,
        &receipt(&f, owner, "owner/durable.sqlite", None),
    )
    .unwrap();
    drop(state);
    let first_claim = claim_request(&f);
    succeeds(apply(&f, &first_claim));
    let first_reference = first_claim.context_ref.clone().unwrap();
    let first_storage = first_claim.envelope.body["storage_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    for index in 0..2 {
        if index == 1 {
            let state = f.host.lock().unwrap();
            let response=lifetime::apply(&state.journal.0,&fixture::envelope("owner",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Second independent task","privacy":"public","acceptance_spec":{}})),"owner").unwrap();
            assert_eq!(response.status, ResponseStatus::Success);
            f.work = response.data["work"]["id"].as_str().unwrap().into();
            f.assignment=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1",[&f.work],|r|r.get(0)).unwrap();
        }
        let claim = if index == 0 {
            first_claim.clone()
        } else {
            claim_request(&f)
        };
        if index == 1 {
            assert_ne!(claim.context_ref, first_claim.context_ref);
            let mut collision = claim.clone();
            collision.envelope.body["storage_ref"] = json!(first_storage);
            collision.envelope.payload_digest = canonical_digest(&collision.envelope.body).unwrap();
            refused(apply(&f, &collision));
            succeeds(apply(&f, &claim));
            let mut cross = claim.clone();
            cross.context_ref = Some(first_reference.clone());
            refused(apply(&f, &cross));
        }
        let state = f.host.lock().unwrap();
        let pending = lifetime::pending_outbox(&state.journal.0).unwrap();
        let item = pending
            .iter()
            .find(|i| i.payload["command_id"] == f.assignment)
            .unwrap();
        let storage = claim.envelope.body["storage_ref"].as_str().unwrap();
        assert!(
            lifetime::ack_outbox(&state.journal.0, item.id, &receipt(&f, item, storage, None))
                .is_err()
        );
        assert!(lifetime::ack_outbox(
            &state.journal.0,
            item.id,
            &receipt(
                &f,
                item,
                "wrong/durable.sqlite",
                claim.context_ref.as_deref()
            )
        )
        .is_err());
        let ack = receipt(&f, item, storage, claim.context_ref.as_deref());
        lifetime::ack_outbox(&state.journal.0, item.id, &ack).unwrap();
        lifetime::ack_outbox(&state.journal.0, item.id, &ack).unwrap();
        let owner_store: String = state
            .journal
            .0
            .query_row(
                "SELECT storage_ref FROM lifetime_bindings WHERE conversation_id=?1",
                [&f.conversation],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner_store, "owner/durable.sqlite");
    }
}

#[tokio::test]
async fn work_context_completion_lost_reply_replays_exact_receipts_without_new_effect() {
    let f = fixture::setup_with_spec(json!({}));
    let claim = claim_request(&f);
    succeeds(apply(&f, &claim));
    let mut write = fixture::request(
        &f,
        10,
        "first",
        "write",
        json!({"path":"done.txt","content":"done"}),
    );
    write.context_ref = claim.context_ref.clone();
    let observed = f
        .host
        .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(observed.status, ResponseStatus::Success, "{observed:?}");
    let complete = request(
        &f,
        json!({"method":"work.execution.complete","assignment_id":f.assignment,"work_id":f.work,"task_id":7,"summary":"Done"}),
        claim.context_ref.as_deref(),
    );
    let first = f
        .host
        .lifetime_pi_execution_action(&complete, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(first.status, ResponseStatus::Success, "{first:?}");
    assert_eq!(
        f.host
            .lifetime_pi_execution_action(&complete, PiInferenceScope::Public)
            .await
            .unwrap(),
        first
    );
    assert_eq!(
        f.host
            .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
            .await
            .unwrap(),
        observed
    );
    succeeds(apply(&f, &claim));
    let mut different = write.clone();
    different.envelope.body["call_id"] = json!("new-effect");
    different.envelope.command_id = uuid::Uuid::new_v4().to_string();
    different.envelope.payload_digest = canonical_digest(&different.envelope.body).unwrap();
    assert_ne!(
        f.host
            .lifetime_pi_execution_action(&different, PiInferenceScope::Public)
            .await
            .unwrap()
            .status,
        ResponseStatus::Success
    );
    let mut inference = request(
        &f,
        json!({"method":"inference.inspect","assignment_id":f.assignment,"work_id":f.work}),
        claim.context_ref.as_deref(),
    );
    refused(apply(&f, &inference));
    inference.envelope.authority_epoch = 2;
    refused(apply(&f, &inference));
    let state = f.host.lock().unwrap();
    assert_eq!(
        state
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_pi_effects", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        state
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_pi_executions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn work_context_reference_cannot_follow_changed_authoritative_work_revision() {
    let f = fixture::setup_with_spec(json!({}));
    let claim = claim_request(&f);
    succeeds(apply(&f, &claim));
    let inference = request(
        &f,
        json!({"method":"inference.inspect","assignment_id":f.assignment,"work_id":f.work}),
        claim.context_ref.as_deref(),
    );
    succeeds(apply(&f, &inference));
    {
        let state = f.host.lock().unwrap();
        let mut work = db::work(&state.journal.0, &f.work).unwrap().unwrap();
        work.owner_revision += 1;
        db::update_work(&state.journal.0, &work).unwrap();
    }
    refused(apply(&f, &inference));
    refused(apply(&f, &claim));
    let state = f.host.lock().unwrap();
    assert_eq!(
        state
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_pi_executions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
