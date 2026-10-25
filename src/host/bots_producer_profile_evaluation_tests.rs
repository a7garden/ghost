#[test]
fn producer_profile_evaluation_rejects_selection_drift_before_admission_and_keeps_admitted_pin() {
    use crate::host::lifetime::producer_profiles as profiles;
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::open(&dir.path().join("workspace.db")).unwrap();
    let conn = &journal.0;
    let ghost = "01930000-0000-7000-8000-000000000001";
    let conversation = "01930000-0000-7000-8000-000000000002";
    assert_eq!(lifetime::apply(conn,&env("profile-evaluator",json!({"method":"registry.ensure","ghost_id":ghost,"conversation_id":conversation,"kind":"primary","roles":[]})),"owner").unwrap().status,ResponseStatus::Success);
    let accepted = crate::computers::fixture_accepted_producer_profile();
    let original = profiles::OwnerAcceptedProfile {
        manifest: accepted.manifest().clone(),
        runtime_facts: accepted.runtime_facts().clone(),
    };
    let first = profiles::accept_config(conn, original.clone()).unwrap();
    let mut second_profile = original;
    second_profile.manifest.revision += 1;
    second_profile.runtime_facts.profile_digest = second_profile.manifest.digest().unwrap();
    let second = profiles::accept_config(conn, second_profile).unwrap();
    profiles::select(conn, ghost, Some(&first)).unwrap();
    config(conn);
    let (mut prepared, assets) = prepared(conn);
    prepared.body["content"]["execution_profile_ref"] = serde_json::to_value(&first).unwrap();
    prepared.payload_digest = canonical_digest(&prepared.body).unwrap();
    let response = lifetime::apply_with_admission(conn, &prepared, "owner", |tx| {
        prepare(tx, &prepared, "owner", assets).map(Some)
    })
    .unwrap();
    assert_eq!(response.status, ResponseStatus::Success);
    let candidate = candidate(conn, response.data["candidate_id"].as_str().unwrap()).unwrap();
    let count = |table: &str| {
        conn.query_row::<u64, _, _>(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };
    let (goals, works, outboxes) = ("lifetime_goals", "lifetime_work", "lifetime_outbox");
    let before = (count(goals), count(works), count(outboxes));
    profiles::select(conn, ghost, Some(&second)).unwrap();
    assert!(lifetime::apply(
        conn,
        &request("evaluation-wrong-selection", "bot.evaluate", &candidate),
        "owner"
    )
    .is_err());
    assert_eq!((count(goals), count(works), count(outboxes)), before);
    assert!(progress(conn, &candidate.id)
        .unwrap()
        .evaluation_work_id
        .is_none());
    profiles::select(conn, ghost, Some(&first)).unwrap();
    let admitted = lifetime::apply(
        conn,
        &request("evaluation-original-profile", "bot.evaluate", &candidate),
        "owner",
    )
    .unwrap();
    assert_eq!(admitted.status, ResponseStatus::Success);
    let work_id = admitted.data["evaluation_work_id"].as_str().unwrap();
    let raw: String = conn
        .query_row(
            "SELECT payload FROM lifetime_work WHERE id=?1",
            [work_id],
            |r| r.get(0),
        )
        .unwrap();
    let work: Work = serde_json::from_str(&raw).unwrap();
    let pinned = lifetime::work_context::producer_profile(conn, &work)
        .unwrap()
        .unwrap();
    assert_eq!(pinned.digest().unwrap(), first.digest);
    let context:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND json_extract(payload,'$.work_id')=?1",[work_id],|r|r.get(0)).unwrap();
    profiles::select(conn, ghost, Some(&second)).unwrap();
    let repeated = lifetime::apply(
        conn,
        &request("evaluation-retained-profile", "bot.evaluate", &candidate),
        "owner",
    )
    .unwrap();
    assert_eq!(repeated.status, ResponseStatus::Success);
    assert_eq!(repeated.data["evaluation_work_id"], work_id);
    assert_eq!(
        lifetime::work_context::producer_profile(conn, &work)
            .unwrap()
            .unwrap(),
        pinned
    );
    assert_eq!(conn.query_row::<String,_,_>("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND json_extract(payload,'$.work_id')=?1",[work_id],|r|r.get(0)).unwrap(),context);
    let mut wrong_candidate = candidate;
    wrong_candidate.definition.content.execution_profile_ref = second;
    assert!(evaluation_profile_matches(conn, &wrong_candidate, &work).is_err());
}
