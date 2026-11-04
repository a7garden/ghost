#[tokio::test]
async fn a03_external_effect_receipt_loss_never_replays_and_owner_reconciles_original_identity() {
    for stage in ["profile", "environment"] {
        let (f, c) = repair_fixture().await;
        {
            let state = f.host.lock().unwrap();
            save(
                &state.journal.0,
                "bot_provisioning_test_fault",
                &c.id,
                &json!({"stage":stage}),
            )
            .unwrap();
        }
        complete_repair_evaluation(&f, &c, true).await;
        let original = {
            let state = f.host.lock().unwrap();
            let p = progress(&state.journal.0, &c.id).unwrap();
            assert_eq!(p.state, "reconcile_required", "{stage}: {p:?}");
            assert_eq!(p.receipts["phases"][stage]["certainty"], "unknown");
            assert!(state.profiles.contains_key(&c.definition.ghost_id));
            assert_eq!(
                state
                    .journal
                    .0
                    .query_row(
                        "SELECT COUNT(*) FROM lifetime_registry WHERE ghost_id=?1",
                        [&c.definition.ghost_id],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.ensure' AND json_extract(payload,'$.body.ghost_id')=?1",[&c.definition.ghost_id],|r|r.get::<_,i64>(0)).unwrap(),0);
            // A process crash leaves `started` instead of a caught-error marker.
            let mut crashed = p.clone();
            crashed.receipts["phases"][stage]["certainty"] = json!("started");
            save(&state.journal.0, PROGRESS, &c.id, &crashed).unwrap();
            p
        };
        f.host.advance_bot_provisioning().unwrap();
        // Reopen the persisted journal; no inferred absence and no new operation.
        let reopened = Journal::open(&f.root.path().join("workspace.db")).unwrap();
        let persisted = progress(&reopened.0, &c.id).unwrap();
        assert_eq!(persisted.state, "reconcile_required");
        assert_eq!(persisted.operation_id, original.operation_id);
        assert_eq!(persisted.receipts["phases"][stage]["certainty"], "started");
        drop(reopened);
        let response = f
            .host
            .lifetime_action(&request(
                &format!("owner-reconcile-{stage}"),
                "bot.provision",
                &c,
            ))
            .unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        assert_eq!(p.operation_id, original.operation_id);
        assert_eq!(p.ghost_id, original.ghost_id);
        assert_eq!(p.state, "provisioning");
        assert_eq!(p.receipts["blocker"], "runtime_prepare_pending");
        assert_eq!(p.receipts["phases"][stage]["certainty"], "known_complete");
        assert_eq!(
            p.receipts["phases"][stage]["command_id"],
            original.receipts["phases"][stage]["command_id"]
        );
        assert_eq!(
            p.receipts["phases"][stage]["reconciled_by"],
            format!("owner-reconcile-{stage}")
        );
    }
}
#[tokio::test]
async fn a03_missing_evaluation_bytes_remain_unavailable_not_failed_and_recover_same_operation() {
    let (f, c) = repair_fixture().await;
    complete_repair_evaluation(&f, &c, true).await;
    let (path, p) = {
        let state = f.host.lock().unwrap();
        let (execution, artifact) = evaluation_artifact(&state.journal.0, &c).unwrap();
        (
            f.root
                .path()
                .join("pi-execution")
                .join(execution)
                .join(artifact.locator),
            progress(&state.journal.0, &c.id).unwrap(),
        )
    };
    // Exercise the real verified-artifact reader, rather than inject a semantic verdict.
    let backup = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    f.host.advance_bot_provisioning().unwrap();
    {
        let state = f.host.lock().unwrap();
        let current = progress(&state.journal.0, &c.id).unwrap();
        assert_eq!(current.state, "provisioning");
        assert_eq!(
            current.receipts["blocker"],
            "evaluation_evidence_unavailable"
        );
        assert_eq!(current.operation_id, p.operation_id);
    }
    std::fs::write(&path, backup).unwrap();
    f.host.advance_bot_provisioning().unwrap();
    let state = f.host.lock().unwrap();
    let restored = progress(&state.journal.0, &c.id).unwrap();
    assert_eq!(restored.state, "provisioning");
    assert_eq!(restored.operation_id, p.operation_id);
}
#[test]
fn a03_cursor_advances_past_sixteen_blocked_candidates_and_late_failure_cannot_replace_ready() {
    let dir = tempfile::tempdir().unwrap();
    let j = Journal::open(&dir.path().join("workspace.db")).unwrap();
    let c = prepare_fixture(&j.0);
    for n in 0..17 {
        save(
            &j.0,
            PROGRESS,
            &format!("fair-{n:02}"),
            &json!({"state":"evaluating","activation_requested":true}),
        )
        .unwrap();
    }
    let first = status::next_ids(&j.0).unwrap();
    assert_eq!(first.len(), 16);
    assert!(!first.contains(&"fair-16".into()));
    let next = status::next_ids(&j.0).unwrap();
    assert!(next.contains(&"fair-16".into()));
    let mut p = progress(&j.0, &c.id).unwrap();
    p.state = "ready".into();
    save(&j.0, PROGRESS, &c.id, &p).unwrap();
    status::blocked(&j.0, &c, 1, "failed", "provisioning_rejected", "activation").unwrap();
    status::blocked(
        &j.0,
        &c,
        1,
        "reconcile_required",
        "provisioning_effect_unconfirmed",
        "environment",
    )
    .unwrap();
    assert_eq!(progress(&j.0, &c.id).unwrap(), p);
    assert!(status::before_external(
        &j.0,
        &c,
        &request("late", "bot.provision", &c),
        "environment",
        false,
        None
    )
    .is_err());
}
#[tokio::test]
async fn a03_runtime_protocol_error_is_terminal_visible_and_retains_existing_resources() {
    let (f, c) = repair_fixture().await;
    {
        let state = f.host.lock().unwrap();
        state.journal.0.execute("INSERT INTO lifetime_bindings(conversation_id,ghost_id,runtime_kind,runtime_release,storage_ref) VALUES(?1,?2,'pi-durable','unresolved','unresolved:foreign')",params![c.conversation_id,f.ghost]).unwrap();
    }
    complete_repair_evaluation(&f, &c, true).await;
    let phase = format!("bot-phase/1:{}:1:bot.runtime.prepare", c.id);
    {
        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        assert_eq!(p.state, "failed");
        assert_eq!(p.receipts["blocker"], "provisioning_rejected");
        assert_eq!(
            p.receipts["phases"]["profile"]["certainty"],
            "known_complete"
        );
        assert_eq!(
            p.receipts["phases"]["environment"]["certainty"],
            "known_complete"
        );
        assert!(state.profiles.contains_key(&c.definition.ghost_id));
        let response: String = state
            .journal
            .0
            .query_row(
                "SELECT response FROM lifetime_commands WHERE command_id=?1",
                [&phase],
                |r| r.get(0),
            )
            .unwrap();
        let response: Response = serde_json::from_str(&response).unwrap();
        assert_eq!(response.status, ResponseStatus::Error);
        let mut interrupted = p;
        interrupted.state = "provisioning".into();
        interrupted.receipts["blocker"] = Value::Null;
        save(&state.journal.0, PROGRESS, &c.id, &interrupted).unwrap();
    }
    // Recover an Error committed before its status projection, never report pending ACK.
    f.host.advance_bot_provisioning().unwrap();
    let state = f.host.lock().unwrap();
    assert_eq!(progress(&state.journal.0, &c.id).unwrap().state, "failed");
    assert_eq!(
        state
            .journal
            .0
            .query_row(
                "SELECT COUNT(*) FROM lifetime_outbox WHERE command_id=?1",
                [phase],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        state
            .journal
            .0
            .query_row(
                "SELECT COUNT(*) FROM lifetime_registry WHERE ghost_id=?1",
                [&c.definition.ghost_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn a03_unrelated_binding_cannot_replace_original_runtime_ack() {
    let (f, c) = repair_fixture().await;
    complete_repair_evaluation(&f, &c, true).await;
    {
        let state = f.host.lock().unwrap();
        state.journal.0.execute("UPDATE lifetime_bindings SET runtime_release='1.1.0',storage_ref='durable/unrelated-ensure' WHERE ghost_id=?1 AND conversation_id=?2",params![c.definition.ghost_id,c.conversation_id]).unwrap();
    }
    f.host.advance_bot_provisioning().unwrap();
    {
        let state = f.host.lock().unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        assert_eq!(p.state, "provisioning");
        assert_eq!(p.receipts["blocker"], "runtime_prepare_pending");
        assert!(!status::runtime_ready(&state.journal.0, &c, 1).unwrap());
    }
    lifecycle_finish_ready(&f, &c).await;
    assert_eq!(
        progress(&f.host.lock().unwrap().journal.0, &c.id)
            .unwrap()
            .state,
        "ready"
    );
}
