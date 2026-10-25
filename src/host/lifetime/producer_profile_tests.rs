//! Deterministic Host authority tests; no guest, provider, or service is run.
use super::*;
use crate::host::lifetime::{
    self,
    pi_execution::tests::{self as fixture, Fixture},
    producer_profiles as profiles,
};
use crate::lifetime_contract::ResponseStatus;

fn accept(conn: &Connection) -> crate::host::bots::RevisionRef {
    let p = crate::computers::fixture_accepted_producer_profile();
    profiles::accept_config(
        conn,
        profiles::OwnerAcceptedProfile {
            manifest: p.manifest().clone(),
            runtime_facts: p.runtime_facts().clone(),
        },
    )
    .unwrap()
}

fn admit(f: &Fixture) -> (Work, Context) {
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    let response=lifetime::apply(conn,&fixture::envelope("owner",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Compute an input-derived JSON result","privacy":"public","acceptance_spec":{}})),"owner").unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    let work = db::work(conn, response.data["work"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.work_id')=?2",params![CONTEXT,work.id],|r|r.get(0)).unwrap();
    (work, serde_json::from_str(&raw).unwrap())
}

#[tokio::test]
async fn producer_profile_legacy_context_bytes_and_environment_survive_new_selection() {
    let f = fixture::setup_with_spec(json!({}));
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    let original: String = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![CONTEXT, f.assignment],
            |r| r.get(0),
        )
        .unwrap();
    let context: Context = serde_json::from_str(&original).unwrap();
    let expected = format!(
        "wc-{}",
        canonical_digest(&json!([
            "ghost-work-context/1",
            context.ghost_id,
            context.conversation_id,
            context.assignment_id,
            context.assignment_digest,
            context.work_id,
            context.goal_revision,
            context.owner_revision,
            context.authority_epoch,
            context.execution_id
        ]))
        .unwrap()
    );
    assert_eq!(context.reference, expected);
    assert!(!original.contains("producer_profile_pin"));
    assert_eq!(serde_json::to_string(&context).unwrap(), original);
    let reference = accept(conn);
    profiles::select(conn, &f.ghost, Some(&reference)).unwrap();
    let work = db::work(conn, &f.work).unwrap().unwrap();
    assert!(producer_profile(conn, &work).unwrap().is_none());
    assert_eq!(
        conn.query_row::<String, _, _>(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![CONTEXT, f.assignment],
            |r| r.get(0)
        )
        .unwrap(),
        original
    );
    execution_profile_binding(
        conn,
        &work,
        &context.assignment_id,
        &context.execution_id,
        false,
    )
    .unwrap();
}

#[tokio::test]
async fn producer_profile_admission_pins_original_scope_before_claim_and_ignores_latest_route() {
    let f = fixture::setup_with_spec(json!({}));
    {
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let reference = accept(conn);
        profiles::select(conn, &f.ghost, Some(&reference)).unwrap();
    }
    let (work, context) = admit(&f);
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    assert!(context.producer_profile_pin.is_some());
    let outbox: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_outbox WHERE delivery_ref=?1)",
            [&context.assignment_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(outbox);
    let executions: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lifetime_pi_executions WHERE work_id=?1",
            [&work.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(executions, 0);
    let pinned = producer_profile(conn, &work).unwrap().unwrap();
    profiles::select(conn, &f.ghost, None).unwrap();
    assert_eq!(producer_profile(conn, &work).unwrap().unwrap(), pinned);
    let request = PiToolRequest {
        context_ref: None,
        ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: fixture::envelope(
            &f.ghost,
            json!({"method":"work.execute","work_id":work.id,"assignment_id":context.assignment_id}),
        ),
    };
    assert!(
        validate(conn, &request).is_err(),
        "An unclaimed new-profile Work cannot bypass the original context"
    );
    let mut wrong = context.profile_scope();
    wrong.work_id = f.work.clone();
    assert!(profiles::pinned(
        conn,
        context.producer_profile_pin.as_deref().unwrap(),
        &wrong
    )
    .is_err());
}

#[tokio::test]
async fn producer_profile_missing_or_tampered_required_records_cannot_become_legacy() {
    for mutation in [
        "context_field",
        "pin_deleted",
        "pin_scope",
        "catalog_deleted",
        "catalog_receipt",
        "context_deleted",
    ] {
        let f = fixture::setup_with_spec(json!({}));
        {
            let state = f.host.lock().unwrap();
            let conn = &state.journal.0;
            let reference = accept(conn);
            profiles::select(conn, &f.ghost, Some(&reference)).unwrap();
        }
        let (work, context) = admit(&f);
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        match mutation {
            "context_field" => {
                conn.execute("UPDATE workspace_objects SET payload=json_remove(payload,'$.producer_profile_pin') WHERE kind=?1 AND id=?2",params![CONTEXT,context.assignment_id]).unwrap();
            }
            "pin_deleted" => {
                conn.execute("DELETE FROM workspace_objects WHERE kind='pi_producer_profile_pin_v1' AND id=?1",[context.producer_profile_pin.as_ref().unwrap()]).unwrap();
            }
            "pin_scope" => {
                conn.execute("UPDATE workspace_objects SET payload=json_set(payload,'$.scope.work_id','foreign') WHERE kind='pi_producer_profile_pin_v1'",[]).unwrap();
            }
            "catalog_deleted" => {
                conn.execute(
                    "DELETE FROM workspace_objects WHERE kind='pi_producer_profile_acceptance_v1'",
                    [],
                )
                .unwrap();
            }
            "catalog_receipt" => {
                conn.execute("UPDATE workspace_objects SET payload=json_set(payload,'$.profile.runtime_facts.observation.json_roundtrip',0) WHERE kind='pi_producer_profile_acceptance_v1'",[]).unwrap();
            }
            "context_deleted" => {
                conn.execute(
                    "DELETE FROM workspace_objects WHERE kind=?1 AND id=?2",
                    params![CONTEXT, context.assignment_id],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(producer_profile(conn, &work).is_err(), "{mutation}");
        assert!(
            execution_profile_binding(
                conn,
                &work,
                &context.assignment_id,
                &context.execution_id,
                false
            )
            .is_err(),
            "{mutation}"
        );
    }
}

#[tokio::test]
async fn producer_profile_execution_binding_is_immutable_and_required_on_resume_and_completion() {
    let f = fixture::setup_with_spec(json!({}));
    {
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let reference = accept(conn);
        profiles::select(conn, &f.ghost, Some(&reference)).unwrap();
    }
    let (work, context) = admit(&f);
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    assert!(execution_profile_binding(
        conn,
        &work,
        &context.assignment_id,
        &context.execution_id,
        false
    )
    .is_err());
    execution_profile_binding(
        conn,
        &work,
        &context.assignment_id,
        &context.execution_id,
        true,
    )
    .unwrap();
    let raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='pi_execution_profile_binding_v1' AND id=?1",[&context.execution_id],|r|r.get(0)).unwrap();
    execution_profile_binding(
        conn,
        &work,
        &context.assignment_id,
        &context.execution_id,
        false,
    )
    .unwrap();
    execution_profile_binding(
        conn,
        &work,
        &context.assignment_id,
        &context.execution_id,
        true,
    )
    .unwrap();
    assert!(execution_profile_binding(
        conn,
        &work,
        "foreign-assignment",
        &context.execution_id,
        false
    )
    .is_err());
    assert_eq!(conn.query_row::<String,_,_>("SELECT payload FROM workspace_objects WHERE kind='pi_execution_profile_binding_v1' AND id=?1",[&context.execution_id],|r|r.get(0)).unwrap(),raw);
    conn.execute(
        "DELETE FROM workspace_objects WHERE kind='pi_execution_profile_binding_v1'",
        [],
    )
    .unwrap();
    assert!(execution_profile_binding(
        conn,
        &work,
        &context.assignment_id,
        &context.execution_id,
        false
    )
    .is_err());
}

#[tokio::test]
async fn producer_profile_catalog_revision_is_immutable_and_unaccepted_selection_is_rejected() {
    let f = fixture::setup_with_spec(json!({}));
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    let reference = accept(conn);
    let p = crate::computers::fixture_accepted_producer_profile();
    let mut profile = profiles::OwnerAcceptedProfile {
        manifest: p.manifest().clone(),
        runtime_facts: p.runtime_facts().clone(),
    };
    profile.runtime_facts.observation.python_version = "3.13.2".into();
    profile.runtime_facts.observation_sha256 = profile.runtime_facts.observation.digest().unwrap();
    assert!(
        profiles::accept_config(conn, profile).is_err(),
        "Same manifest revision cannot replace its accepted facts"
    );
    let mut foreign = reference.clone();
    foreign.digest = "0".repeat(64);
    assert!(profiles::select(conn, &f.ghost, Some(&foreign)).is_err());
    assert_eq!(
        profiles::selected(conn, &f.ghost).unwrap(),
        profiles::legacy_ref().unwrap()
    );
}

#[tokio::test]
async fn producer_profile_provisioned_children_restore_their_saved_profile_not_latest_issuer() {
    let f = fixture::setup_with_spec(json!({}));
    let mut state = f.host.state.lock().unwrap();
    let conn = &state.journal.0;
    let registry = f._root.path().join("profile-restore-registry");
    let mut computers =
        crate::host::lifetime_computers::NativeComputers::pi_fixture(&registry, &f.ghost).unwrap();
    let accepted = accept(conn);
    let legacy = profiles::legacy_ref().unwrap();
    let old_child = uuid::Uuid::new_v4().to_string();
    let new_child = uuid::Uuid::new_v4().to_string();
    computers
        .provision_pi_ghost(conn, &f.ghost, &old_child, 1, "pi-default/1")
        .unwrap();
    let old_record: String = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='pi_provisioned_route' AND id=?1",
            [&old_child],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!old_record.contains("producer_profile_ref"));
    computers
        .select_pi_fixture_profile(conn, &f.ghost, &accepted)
        .unwrap();
    computers
        .provision_pi_ghost_with_profile(conn, &f.ghost, &new_child, 1, &accepted)
        .unwrap();
    let new_record: String = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='pi_provisioned_route' AND id=?1",
            [&new_child],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(computers.pi_profile_ref(&new_child).unwrap(), accepted);
    drop(computers);
    for (id, name) in [(&old_child, "legacy-child"), (&new_child, "json-child")] {
        let store = crate::store::ProfileStore::create_profile_with_id(
            f._root.path(),
            name,
            "profile replay fixture",
            id,
        )
        .unwrap();
        let p = crate::host::Host::profile(store).unwrap();
        state.profiles.insert(id.clone(), p);
    }
    let mut cold =
        crate::host::lifetime_computers::NativeComputers::pi_fixture(&registry, &f.ghost).unwrap();
    cold.select_pi_fixture_profile(&state.journal.0, &f.ghost, &legacy)
        .unwrap();
    cold.restore_provisioned_pi_routes(&state.journal.0, &state.profiles)
        .unwrap();
    assert_eq!(cold.pi_profile_ref(&old_child).unwrap(), legacy);
    assert_eq!(cold.pi_profile_ref(&new_child).unwrap(), accepted);
    assert_eq!(
        profiles::selected(&state.journal.0, &new_child).unwrap(),
        accepted
    );
    for (id, expected) in [(&old_child, old_record), (&new_child, new_record)] {
        let actual: String = state
            .journal
            .0
            .query_row(
                "SELECT payload FROM workspace_objects WHERE kind='pi_provisioned_route' AND id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(actual, expected);
    }
}

#[tokio::test]
async fn producer_profile_admission_rollback_and_cancellation_preserve_original_pin() {
    let f = fixture::setup_with_spec(json!({}));
    {
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let reference = accept(conn);
        profiles::select(conn, &f.ghost, Some(&reference)).unwrap();
    }
    let (work, context) = admit(&f);
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    let pin = context.producer_profile_pin.as_deref().unwrap();
    let before:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='pi_producer_profile_pin_v1' AND id=?1",[pin],|r|r.get(0)).unwrap();
    let cancelled = lifetime::apply(
        conn,
        &fixture::envelope("owner", json!({"method":"work.cancel","work_id":work.id})),
        "owner",
    )
    .unwrap();
    assert_eq!(cancelled.status, ResponseStatus::Success);
    let current_work = db::work(conn, &work.id).unwrap().unwrap();
    assert_eq!(current_work.cancellation, "confirmed");
    assert_eq!(conn.query_row::<String,_,_>("SELECT payload FROM workspace_objects WHERE kind='pi_producer_profile_pin_v1' AND id=?1",[pin],|r|r.get(0)).unwrap(),before);
    let request = PiToolRequest {
        context_ref: Some(context.reference.clone()),
        ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: fixture::envelope(
            &f.ghost,
            json!({"method":"work.context.claim","work_id":work.id,"assignment_id":context.assignment_id}),
        ),
    };
    assert!(validate(conn, &request).is_err());
    let count = |table: &str| {
        conn.query_row::<u64, _, _>(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };
    let counts = (
        count("lifetime_work"),
        count("lifetime_outbox"),
        count("lifetime_commands"),
    );
    conn.execute("UPDATE workspace_objects SET payload=json_set(payload,'$.digest',?1) WHERE kind='pi_producer_profile_selection_v1' AND id=?2",params!["0".repeat(64),f.ghost]).unwrap();
    assert!(lifetime::apply(conn,&fixture::envelope("owner",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Must not admit without the selected accepted profile","privacy":"public","acceptance_spec":{}})),"owner").is_err());
    assert_eq!(
        (
            count("lifetime_work"),
            count("lifetime_outbox"),
            count("lifetime_commands")
        ),
        counts
    );
}
