//! Read-only time evidence and unchanged effect authority; no model/container.
use super::tests::{self as fixture};
use super::*;

#[tokio::test]
async fn execution_time_policy_has_no_preexecution_clock_and_expiry_does_not_terminalize() {
    let f = fixture::setup_with_spec(json!({}));
    {
        let state = f.host.lock().unwrap();
        let before: usize = state
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_pi_executions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(execution_time_policy(
            &state.journal.0,
            &db::work(&state.journal.0, &f.work).unwrap().unwrap(),
            crate::host::now_ms()
        )
        .unwrap()
        .is_none());
        assert_eq!(
            state
                .journal
                .0
                .query_row::<usize, _, _>("SELECT COUNT(*) FROM lifetime_pi_executions", [], |r| r
                    .get(0))
                .unwrap(),
            before
        );
    }
    let written = f
        .host
        .lifetime_pi_execution_action(
            &fixture::request(
                &f,
                10,
                "time-policy-original",
                "write",
                json!({"path":"policy.txt","content":"original"}),
            ),
            PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(written.status, ResponseStatus::Success);
    let state = f.host.lock().unwrap();
    let conn = &state.journal.0;
    let original = db::work(conn, &f.work).unwrap().unwrap();
    let first = execution_time_policy(conn, &original, crate::host::now_ms())
        .unwrap()
        .unwrap();
    let boundary = first.created_ms + first.deadline_ms;
    assert!(
        execution_time_policy(conn, &original, boundary)
            .unwrap()
            .unwrap()
            .effect_authority_alive
    );
    let expired = execution_time_policy(conn, &original, boundary + 1)
        .unwrap()
        .unwrap();
    assert!(!expired.effect_authority_alive);
    assert_eq!(expired.execution_id, first.execution_id);
    assert_eq!(expired.assignment_id, f.assignment);
    assert_eq!(
        db::work(conn, &f.work).unwrap().unwrap(),
        original,
        "Observer expiry is not a Work terminal event"
    );
    assert_eq!(
        conn.query_row::<String, _, _>(
            "SELECT state FROM lifetime_pi_executions WHERE work_id=?1",
            [&f.work],
            |r| r.get(0)
        )
        .unwrap(),
        "running"
    );
}

#[tokio::test]
async fn execution_time_policy_observes_exact_dependency_pause_and_resume_accrues_once(
) -> Result<()> {
    let f = fixture::setup_with_spec(json!({}));
    let written = f
        .host
        .lifetime_pi_execution_action(
            &fixture::request(
                &f,
                10,
                "before-policy-wait",
                "write",
                json!({"path":"policy.txt","content":"original"}),
            ),
            PiInferenceScope::Public,
        )
        .await?;
    ensure!(written.status == ResponseStatus::Success, "{written:?}");
    let target = uuid::Uuid::new_v4().to_string();
    let conversation = uuid::Uuid::new_v4().to_string();
    {
        let state = f.host.lock()?;
        let e = fixture::envelope(
            "owner",
            json!({"method":"registry.ensure","ghost_id":target,"conversation_id":conversation,"kind":"specialist","roles":[]}),
        );
        ensure!(
            super::super::apply(&state.journal.0, &e, "owner")?.status == ResponseStatus::Success,
            "registry"
        );
    }
    let mut delegate = fixture::envelope(
        &f.ghost,
        json!({"method":"work.delegate","parent_work_id":f.work,"target_ghost_id":target,"summary":"Original independent dependency","acceptance_spec":{},"artifact_refs":[]}),
    );
    delegate.expected_revision = Some(1);
    let response = f
        .host
        .lifetime_pi_action(
            &PiToolRequest {
                context_ref: None,
                ghost_id: f.ghost.clone(),
                conversation_id: f.conversation.clone(),
                envelope: delegate,
            },
            PiInferenceScope::Public,
        )
        .await?;
    ensure!(response["result"]["status"] == "success", "{response}");
    let child = response["result"]["data"]["work"]["id"].as_str().unwrap();
    let mut wait = fixture::envelope(
        &f.ghost,
        json!({"method":"work.wait","work_id":f.work,"wait_for":[child],"assignment_id":f.assignment,"generation_task_id":7}),
    );
    wait.expected_revision = Some(1);
    let response = f
        .host
        .lifetime_pi_action(
            &PiToolRequest {
                context_ref: None,
                ghost_id: f.ghost.clone(),
                conversation_id: f.conversation.clone(),
                envelope: wait.clone(),
            },
            PiInferenceScope::Public,
        )
        .await?;
    ensure!(response["result"]["status"] == "success", "{response}");
    let state = f.host.lock()?;
    let conn = &state.journal.0;
    let now = crate::host::now_ms();
    // Advance only the controlled clock origin; original wait request and all
    // command/assignment identities remain the genuine API-created records.
    conn.execute("UPDATE workspace_objects SET payload=json_set(payload,'$.started_ms',?1) WHERE kind='pi_work_wait' AND id=?2",params![now-2_000,wait.command_id])?;
    let before = work_unlocked(conn, &f.work)?;
    let first = execution_time_policy(conn, &before, now)?.unwrap();
    let again = execution_time_policy(conn, &before, now + 100)?.unwrap();
    assert_eq!(first.dependency_pause_ms, 2_000);
    assert_eq!(again.dependency_pause_ms, 2_100);
    assert_eq!(first.paused_ms, 0);
    assert_eq!(again.paused_ms, 0);
    let cancelled = super::super::apply(
        conn,
        &fixture::envelope("owner", json!({"method":"work.cancel","work_id":child})),
        "owner",
    )?;
    ensure!(cancelled.status == ResponseStatus::Success, "{cancelled:?}");
    // The normal dependency reconciler fixes the original resolved_at. Resume
    // the same generation twice and prove that pause is accrued only once.
    super::super::graph::check_admission(conn, &work_unlocked(conn, &f.work)?)?;
    let mut resumed = work_unlocked(conn, &f.work)?;
    super::super::pi_wait::resume(conn, &mut resumed, &f.assignment, 7)?;
    let once = execution_time_policy(conn, &resumed, crate::host::now_ms())?.unwrap();
    super::super::pi_wait::resume(conn, &mut resumed, &f.assignment, 7)?;
    let twice = execution_time_policy(conn, &resumed, crate::host::now_ms())?.unwrap();
    assert!(once.paused_ms >= 2_000);
    assert_eq!(once.paused_ms, twice.paused_ms);
    assert_eq!(twice.dependency_pause_ms, 0);
    assert_eq!(once.execution_id, first.execution_id);
    Ok(())
}

fn work_unlocked(conn: &Connection, id: &str) -> Result<Work> {
    db::work(conn, id)?.ok_or_else(|| anyhow!("fixture Work missing"))
}
