use super::*;
use crate::{
    adapters::memory::tests::{scoped_fixture, SourceEnvGuard},
    host::lifetime::pi_execution::tests::{self as pi, Fixture},
};
use std::{fs, path::PathBuf};
include!("work_memory_driver_tests.rs");

async fn fixture() -> (Fixture, SourceEnvGuard, PathBuf, Space) {
    let mut f = pi::setup_with_spec(pi::verifier_spec("expected"));
    let (brain, guard, engine, _) = scoped_fixture(f._root.path(), &f.ghost).await;
    f.host.brain = brain;
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
    let space = Space {
        id: "experience-documents".into(),
        name: "Private experience".into(),
        path: f._root.path().join("documents"),
        writable: true,
        profiles: vec![f.ghost.clone()],
    };
    {
        let state = f.host.lock().unwrap();
        state
            .journal
            .put(
                "policy",
                &f.ghost,
                &Policy {
                    memory: true,
                    ..Default::default()
                },
            )
            .unwrap();
        state.journal.put("space", &space.id, &space).unwrap();
    }
    fs::write(engine.join("document-root"), space.path.to_str().unwrap()).unwrap();
    (f, guard, engine, space)
}
fn owner(f: &Fixture, body: Value, revision: Option<u64>) -> Value {
    let mut envelope = pi::envelope("owner", body);
    envelope.authority_epoch = f.host.authority_epoch;
    envelope.expected_revision = revision;
    f.host.lifetime_action(&envelope).unwrap()
}
fn bind(f: &mut Fixture, required: bool, ids: Value, space: Option<&str>) {
    let response = owner(
        f,
        json!({"method":"work.memory.profile.configure","ghost_id":f.ghost,"required":required,"binding_ids":ids,"experience_space_id":space}),
        None,
    );
    assert_eq!(response["result"]["status"], "success", "{response}");
    let admitted = owner(
        f,
        json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Pinned memory Work","privacy":"public","acceptance_spec":pi::verifier_spec("expected")}),
        None,
    );
    assert_eq!(admitted["result"]["status"], "success", "{admitted}");
    f.work = admitted["result"]["data"]["work"]["id"]
        .as_str()
        .unwrap()
        .into();
    f.assignment=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&f.work],|row|row.get(0)).unwrap();
}
fn memory_request(f: &Fixture, method: &str, args: Value) -> PiToolRequest {
    let mut body = json!({"method":method,"ghost_id":f.ghost,"conversation_id":f.conversation,"assignment_id":f.assignment,"work_id":f.work});
    for (key, value) in args.as_object().unwrap() {
        body[key] = value.clone();
    }
    PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: pi::envelope(&f.ghost, body),
    }
}
fn stamped(mut request: PiToolRequest, stamp: &str) -> PiToolRequest {
    request.envelope.body["work_memory_context_revision"] = json!(stamp);
    request.envelope.payload_digest = canonical_digest(&request.envelope.body).unwrap();
    request
}
async fn inspect(f: &Fixture) -> String {
    let response = f
        .host
        .lifetime_work_memory_action(
            &memory_request(f, "work.memory.context.inspect", json!({})),
            PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(response.data["memory_permitted"], true, "{response:?}");
    response.data["context_revision"].as_str().unwrap().into()
}
async fn publish(f: &Fixture, stamp: &str) -> Artifact {
    let response = f
        .host
        .lifetime_pi_execution_action(
            &stamped(
                pi::request(
                    f,
                    10,
                    "write",
                    "write",
                    json!({"path":"answer.txt","content":"expected"}),
                ),
                stamp,
            ),
            PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    let response = f
        .host
        .lifetime_pi_execution_action(
            &stamped(
                pi::request(
                    f,
                    11,
                    "publish",
                    "publish_artifact",
                    json!({"path":"answer.txt","privacy":"private"}),
                ),
                stamp,
            ),
            PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    response.artifacts[0].clone()
}
async fn complete(f: &Fixture, stamp: &str) -> Response {
    let request = PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: pi::envelope(
            &f.ghost,
            json!({"method":"work.execution.complete","assignment_id":f.assignment,"work_id":f.work,"task_id":7,"summary":"common marker MUST NOT enter Owner report"}),
        ),
    };
    f.host
        .lifetime_pi_execution_action(&stamped(request, stamp), PiInferenceScope::Local)
        .await
        .unwrap()
}
fn entries(f: &Fixture) -> Vec<Experience> {
    let state = f.host.lock().unwrap();
    let mut query = state
        .journal
        .0
        .prepare("SELECT payload FROM workspace_objects WHERE kind=?1 ORDER BY id")
        .unwrap();
    query
        .query_map([EXPERIENCES], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|raw| serde_json::from_str(&raw.unwrap()).unwrap())
        .collect()
}
fn due(f: &Fixture) {
    let state = f.host.lock().unwrap();
    for mut entry in entries_locked(&state.journal.0) {
        entry.next_attempt_ms = 0;
        put(&state.journal.0, EXPERIENCES, &entry.id, &entry).unwrap();
    }
}
fn entries_locked(conn: &Connection) -> Vec<Experience> {
    let mut query = conn
        .prepare("SELECT payload FROM workspace_objects WHERE kind=?1")
        .unwrap();
    let rows = query
        .query_map([EXPERIENCES], |row| row.get::<_, String>(0))
        .unwrap();
    rows.map(|raw| serde_json::from_str(&raw.unwrap()).unwrap())
        .collect()
}

#[tokio::test]
async fn shared_work_read_preserves_evidence_but_never_own_memory_or_forged_scope() {
    let (mut f, _guard, engine, _) = fixture().await;
    bind(&mut f, false, json!(["shared"]), None);
    let response = f
        .host
        .lifetime_pi_action(
            &memory_request(
                &f,
                "work.memory.recall",
                json!({"query":"marker","token_budget":256}),
            ),
            PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    assert!(response.to_string().contains("common marker"));
    assert!(!response.to_string().contains("private marker"));
    let calls = fs::read_to_string(engine.join("scope-calls.jsonl")).unwrap();
    assert!(calls
        .lines()
        .all(|line| serde_json::from_str::<Value>(line).unwrap()["space"] == "common"));
    let mut forged = memory_request(
        &f,
        "work.memory.recall",
        json!({"query":"marker","spaces":["fixture-space"]}),
    );
    assert!(f
        .host
        .lifetime_work_memory_action(&forged, PiInferenceScope::Local)
        .await
        .is_err());
    forged
        .envelope
        .body
        .as_object_mut()
        .unwrap()
        .remove("spaces");
    forged.envelope.body["assignment_id"] = json!("foreign-assignment");
    forged.envelope.payload_digest = canonical_digest(&forged.envelope.body).unwrap();
    assert!(f
        .host
        .lifetime_work_memory_action(&forged, PiInferenceScope::Local)
        .await
        .is_err());
}

#[tokio::test]
async fn required_absence_blocks_first_effect_while_unbound_work_keeps_original_behavior() {
    let (mut f, _guard, _engine, _) = fixture().await;
    bind(&mut f, true, json!([]), None);
    let inspect = f
        .host
        .lifetime_work_memory_action(
            &memory_request(&f, "work.memory.context.inspect", json!({})),
            PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(inspect.data["memory_permitted"], false);
    let denied = f
        .host
        .lifetime_pi_execution_action(
            &pi::request(
                &f,
                10,
                "write",
                "write",
                json!({"path":"answer.txt","content":"must not write"}),
            ),
            PiInferenceScope::Local,
        )
        .await
        .unwrap();
    assert_eq!(denied.error_code.as_deref(), Some("disclosure_blocked"));
    assert_eq!(
        f.host
            .lock()
            .unwrap()
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_pi_effects", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    let absent = pi::setup_with_spec(json!({}));
    let success = absent
        .host
        .lifetime_pi_execution_action(
            &pi::request(
                &absent,
                10,
                "write",
                "write",
                json!({"path":"answer.txt","content":"ordinary"}),
            ),
            PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(success.status, ResponseStatus::Success, "{success:?}");
}

#[tokio::test]
async fn work_profile_is_cas_pinned_at_admission_and_changes_only_future_work() {
    let (f, _guard, _engine, _) = fixture().await;
    let configured = owner(
        &f,
        json!({"method":"work.memory.profile.configure","ghost_id":f.ghost,"binding_ids":["shared"],"required":true,"experience_space_id":null}),
        None,
    );
    assert_eq!(configured["result"]["status"], "success", "{configured}");
    {
        let state = f.host.lock().unwrap();
        assert!(
            grant(&state.journal.0, &work(&state.journal.0, &f.work).unwrap())
                .unwrap()
                .is_none()
        );
    }
    let admitted = owner(
        &f,
        json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"New pinned Work","privacy":"public","acceptance_spec":{}}),
        None,
    );
    assert_eq!(admitted["result"]["status"], "success", "{admitted}");
    let pinned: Work = serde_json::from_value(admitted["result"]["data"]["work"].clone()).unwrap();
    let original = {
        let state = f.host.lock().unwrap();
        let grant = grant(&state.journal.0, &pinned).unwrap().unwrap();
        assert!(grant.required);
        assert!(requires_private_delivery(&state.journal.0, &pinned.id).unwrap());
        let raw:String=state.journal.0.query_row("SELECT payload FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1",[&pinned.id],|row|row.get(0)).unwrap();
        let receiver: Envelope = serde_json::from_str(&raw).unwrap();
        assert_eq!(receiver.body["privacy"], "private");
        assert!(!lifetime::assignment_is_public_for_delivery(&state.journal.0, &receiver).unwrap());
        serde_json::to_value(grant).unwrap()
    };
    let update = owner(
        &f,
        json!({"method":"work.memory.profile.configure","ghost_id":f.ghost,"binding_ids":[],"required":false,"experience_space_id":null}),
        Some(1),
    );
    assert_eq!(update["result"]["status"], "success");
    let state = f.host.lock().unwrap();
    assert_eq!(
        serde_json::to_value(grant(&state.journal.0, &pinned).unwrap().unwrap()).unwrap(),
        original
    );
}

#[tokio::test]
async fn revoked_shared_source_blocks_original_effect_replay_and_completion_without_changing_receipt(
) {
    let (mut f, _guard, engine, _) = fixture().await;
    bind(&mut f, true, json!(["shared"]), None);
    let stamp = inspect(&f).await;
    let write = stamped(
        pi::request(
            &f,
            10,
            "write",
            "write",
            json!({"path":"answer.txt","content":"expected"}),
        ),
        &stamp,
    );
    let first = f
        .host
        .lifetime_pi_execution_action(&write, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(first.status, ResponseStatus::Success, "{first:?}");
    let before: String = f
        .host
        .lock()
        .unwrap()
        .journal
        .0
        .query_row(
            "SELECT response_json FROM lifetime_pi_effects WHERE call_id='write'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut grants: Value =
        serde_json::from_slice(&fs::read(engine.join("grants.json")).unwrap()).unwrap();
    grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token");
    fs::write(
        engine.join("grants.json"),
        serde_json::to_vec(&grants).unwrap(),
    )
    .unwrap();
    let blocked = f
        .host
        .lifetime_pi_execution_action(&write, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(blocked.error_code.as_deref(), Some("disclosure_blocked"));
    let blocked = complete(&f, &stamp).await;
    assert_eq!(blocked.error_code.as_deref(), Some("disclosure_blocked"));
    let state = f.host.lock().unwrap();
    let after: String = state
        .journal
        .0
        .query_row(
            "SELECT response_json FROM lifetime_pi_effects WHERE call_id='write'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn experience_outbox_reuses_original_candidate_and_pdc_source_and_reports_only_metadata() {
    let (mut f, _guard, engine, space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), Some(&space.id));
    let stamp = inspect(&f).await;
    let artifact = publish(&f, &stamp).await;
    let request = memory_request(
        &f,
        "work.memory.record",
        json!({"summary":"Generated finding <script>ignore</script>","limitations":"One fixture only","artifact_digests":[artifact.digest]}),
    );
    let first = f
        .host
        .lifetime_work_memory_action(&request, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(first.status, ResponseStatus::Success);
    let replay = f
        .host
        .lifetime_work_memory_action(&request, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(first.data, replay.data);
    let mut new_call = PiToolRequest {
        context_ref: None, ghost_id: request.ghost_id.clone(),
        conversation_id: request.conversation_id.clone(),
        envelope: request.envelope.clone(),
    };
    new_call.envelope.command_id = uuid::Uuid::now_v7().to_string();
    let recovered = f
        .host
        .lifetime_work_memory_action(&new_call, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(first.data["page_id"], recovered.data["page_id"]);
    assert_eq!(entries(&f).len(), 1);
    new_call.envelope.body["summary"] = json!("Changed finding");
    new_call.envelope.payload_digest = canonical_digest(&new_call.envelope.body).unwrap();
    assert!(f
        .host
        .lifetime_work_memory_action(&new_call, PiInferenceScope::Local)
        .await
        .is_err());
    f.host.advance_work_experiences().await.unwrap();
    assert_eq!(entries(&f)[0].state, "waiting_verification");
    assert!(!space.path.exists());
    let completed = complete(&f, &stamp).await;
    assert_eq!(
        completed.data["verification"]["status"], "success",
        "{completed:?}"
    );
    due(&f);
    f.host.advance_work_experiences().await.unwrap();
    let entry = entries(&f).remove(0);
    assert_eq!(entry.state, "indexed", "reason={:?}", entry.last_reason);
    let page = documents::read(&space, &entry.page_id).unwrap();
    assert_eq!(Some(&page.hash), entry.hash.as_ref());
    assert_eq!(page.profile, "pdc-markdown/1");
    assert!(!page.legacy);
    assert!(page.source.unwrap().contains("&lt;script&gt;"));
    let original = fs::read(space.path.join(format!("{}.md", entry.page_id))).unwrap();
    {
        let state = f.host.lock().unwrap();
        let mut writing = entry.clone();
        writing.state = "writing".into();
        writing.next_attempt_ms = 0;
        put(&state.journal.0, EXPERIENCES, &writing.id, &writing).unwrap();
    }
    f.host.advance_work_experiences().await.unwrap();
    assert_eq!(
        fs::read(space.path.join(format!("{}.md", entry.page_id))).unwrap(),
        original
    );
    assert_eq!(documents::list(&space, "").unwrap().len(), 1);
    let calls = fs::read_to_string(engine.join("scope-calls.jsonl")).unwrap_or_default();
    assert!(!calls.lines().any(|line| matches!(
        serde_json::from_str::<Value>(line).unwrap()["name"].as_str(),
        Some("ingest" | "session_record" | "declare")
    )));
    let state = f.host.lock().unwrap();
    let mut query=state.journal.0.prepare("SELECT payload FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.submit'").unwrap();
    for raw in query.query_map([], |row| row.get::<_, String>(0)).unwrap() {
        assert!(!raw.unwrap().contains("common marker MUST NOT"));
    }
}

#[tokio::test]
async fn final_document_write_lock_fences_epoch_race_and_explicit_recovery_preserves_source_identity(
) {
    let (mut f, _guard, _engine, space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), Some(&space.id));
    let stamp = inspect(&f).await;
    let artifact = publish(&f, &stamp).await;
    f.host.lifetime_work_memory_action(&memory_request(&f,"work.memory.record",json!({"summary":"Recoverable summary","limitations":"","artifact_digests":[artifact.digest]})),PiInferenceScope::Local).await.unwrap();
    complete(&f, &stamp).await;
    due(&f);
    f.host.advance_work_experiences().await.unwrap();
    let mut entry = entries(&f).remove(0);
    fs::remove_file(space.path.join(format!("{}.md", entry.page_id))).unwrap();
    entry.state = "writing".into();
    let pinned = {
        let state = f.host.lock().unwrap();
        let work = work(&state.journal.0, &f.work).unwrap();
        let pinned = grant(&state.journal.0, &work).unwrap().unwrap();
        f.host
            .experience_authorized(&state, &entry, &pinned, &space)
            .unwrap();
        pinned
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
        put(&state.journal.0, EXPERIENCES, &entry.id, &entry).unwrap();
    }
    assert!(f
        .host
        .write_experience_source(&entry, &pinned, &space)
        .is_err());
    assert!(!space.path.join(format!("{}.md", entry.page_id)).exists());
    f.host.authority_epoch = 2;
    let recovered = owner(
        &f,
        json!({"method":"work.experience.resume","work_id":f.work,"experience_id":entry.id}),
        Some(1),
    );
    assert_eq!(recovered["result"]["status"], "success", "{recovered}");
    f.host.advance_work_experiences().await.unwrap();
    let resumed = entries(&f).remove(0);
    assert_eq!(entry.page_id, resumed.page_id);
    assert_eq!(entry.hash, resumed.hash);
    assert_eq!(entry.body, resumed.body);
    assert_eq!(entry.context_revision, resumed.context_revision);
    assert_ne!(
        resumed.writer_context_revision.as_deref(),
        Some(entry.context_revision.as_str())
    );
    assert_eq!(resumed.state, "indexed");
    assert!(
        !save_experience(&f.host.lock().unwrap().journal.0, &entry).unwrap(),
        "old asynchronous writer must not overwrite explicit recovery"
    );
    assert_eq!(entries(&f)[0].generation, resumed.generation);
}

#[tokio::test]
async fn experience_rejects_unpublished_artifacts_and_revoke_withholds_source_file() {
    let (mut f, _guard, engine, space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), Some(&space.id));
    let stamp = inspect(&f).await;
    let invented = memory_request(
        &f,
        "work.memory.record",
        json!({"summary":"Unsupported source","limitations":"","artifact_digests":["0".repeat(64)]}),
    );
    assert!(f
        .host
        .lifetime_work_memory_action(&invented, PiInferenceScope::Local)
        .await
        .is_err());
    assert!(entries(&f).is_empty());
    let artifact = publish(&f, &stamp).await;
    f.host.lifetime_work_memory_action(&memory_request(&f,"work.memory.record",json!({"summary":"Source-backed candidate","limitations":"","artifact_digests":[artifact.digest]})),PiInferenceScope::Local).await.unwrap();
    let completion = complete(&f, &stamp).await;
    assert_eq!(completion.data["verification"]["status"], "success");
    let mut grants: Value =
        serde_json::from_slice(&fs::read(engine.join("grants.json")).unwrap()).unwrap();
    grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token");
    fs::write(
        engine.join("grants.json"),
        serde_json::to_vec(&grants).unwrap(),
    )
    .unwrap();
    due(&f);
    f.host.advance_work_experiences().await.unwrap();
    let entry = entries(&f).remove(0);
    assert!(!space.path.join(format!("{}.md", entry.page_id)).exists());
    assert_ne!(entry.state, "indexed");
    let reopened =
        crate::host::scheduler::Journal::open(&f.host.root.join("workspace.db")).unwrap();
    let mut query=reopened.0.prepare("SELECT delivery_ref,payload FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.submit'").unwrap();
    for row in query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
    {
        let (report, raw) = row.unwrap();
        assert!(!raw.contains("common marker MUST NOT"));
        let response=lifetime::apply(&reopened.0,&pi::envelope(&f.ghost,json!({"method":"conversation.report.inspect","ghost_id":f.ghost,"conversation_id":f.conversation,"report_id":report})),&f.ghost).unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        assert!(!response.data.to_string().contains("common marker MUST NOT"));
    }
}

#[tokio::test]
#[ignore = "opt-in isolated real Oxibrain CLI documents index, no production store or model"]
async fn real_oxibrain_documents_reconcile_without_episode_or_assertion_promotion() {
    let executable =
        std::env::var_os("GHOST_REAL_BRAIN_CLI").expect("set explicit source-built Oxibrain CLI");
    let (mut f, _guard, _fake, space) = fixture().await;
    let directory = f._root.path().join("real-brain");
    let run = |args: &[&str]| {
        let output = std::process::Command::new(&executable)
            .arg("--dir")
            .arg(&directory)
            .args(args)
            .output()
            .expect("isolated CLI launch");
        assert!(
            output.status.success(),
            "isolated CLI operation failed; output withheld"
        );
        String::from_utf8(output.stdout).unwrap()
    };
    run(&["admin", "init", "--space", "fixture-space"]);
    run(&["admin", "init", "--space", "common"]);
    let issue = |space: &str, caps: &str| {
        let output = run(&[
            "admin",
            "token",
            "issue",
            "--space",
            space,
            "--caps",
            caps,
            "--label",
            "isolated-work-test",
        ]);
        output
            .lines()
            .find_map(|line| line.strip_prefix("secret (shown once): "))
            .expect("isolated token reply did not include a secret")
            .to_owned()
    };
    let own = issue("fixture-space", "read,ingest");
    let shared = issue("common", "read");
    std::env::set_var("GHOST_BRAIN_EXECUTABLE", &executable);
    std::env::set_var("GHOST_BRAIN_DIR", &directory);
    std::env::set_var("GHOST_BRAIN_TOKEN_OWN_FIXTURE", own);
    std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", shared);
    fs::create_dir_all(&space.path).unwrap();
    fs::write(
        directory.join("documents.toml"),
        format!(
            "[[root]]\nalias = \"work-experience\"\npath = {}\nspace = \"fixture-space\"\n",
            serde_json::to_string(space.path.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    bind(&mut f, true, json!(["shared"]), Some(&space.id));
    let stamp = inspect(&f).await;
    let artifact = publish(&f, &stamp).await;
    f.host.lifetime_work_memory_action(&memory_request(&f,"work.memory.record",json!({"summary":"Isolated source-backed experience","limitations":"Synthetic artifact; no user memory","artifact_digests":[artifact.digest]})),PiInferenceScope::Local).await.unwrap();
    let completed = complete(&f, &stamp).await;
    assert_eq!(completed.data["verification"]["status"], "success");
    f.host.advance_work_experiences().await.unwrap();
    let entry = entries(&f).remove(0);
    assert_eq!(entry.state, "indexed", "reason={:?}", entry.last_reason);
    let database = Connection::open(directory.join("brain.db")).unwrap();
    for table in ["episodes", "assertions"] {
        let count: u64 = database
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 0,
            "generated prose must remain in the documents plane"
        );
    }
    assert_eq!(
        documents::read(&space, &entry.page_id).unwrap().hash,
        entry.hash.unwrap()
    );
}

#[tokio::test]
async fn revised_public_goal_keeps_pinned_private_assignment_delivery() {
    let (mut f, _guard, _engine, _space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), None);
    let original = {
        let state = f.host.lock().unwrap();
        work(&state.journal.0, &f.work).unwrap()
    };
    let updated = owner(
        &f,
        json!({"method":"goal.update","goal_id":original.goal_id,"prompt":"A revised public Goal","acceptance_spec":pi::verifier_spec("expected")}),
        Some(1),
    );
    assert_eq!(updated["result"]["status"], "success", "{updated}");
    let state = f.host.lock().unwrap();
    let raw:String=state.journal.0.query_row("SELECT payload FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.goal_id')=?1 AND json_extract(payload,'$.body.goal_revision')=2 ORDER BY id DESC LIMIT 1",[&original.goal_id],|row|row.get(0)).unwrap();
    let receiver: Envelope = serde_json::from_str(&raw).unwrap();
    assert_eq!(receiver.body["privacy"], "private");
    assert!(!lifetime::assignment_is_public_for_delivery(&state.journal.0, &receiver).unwrap());
    let request = pi::envelope(
        &f.ghost,
        json!({"method":"conversation.assignment.inspect","ghost_id":f.ghost,"conversation_id":f.conversation,"assignment_id":receiver.command_id}),
    );
    let inspected = lifetime::apply(&state.journal.0, &request, &f.ghost).unwrap();
    assert_eq!(inspected.status, ResponseStatus::Success, "{inspected:?}");
    assert_eq!(inspected.data["assignment"]["privacy"], "private");
}

#[tokio::test]
async fn memory_derived_delegation_rejects_ungranted_child_and_rechecks_revoke_before_coordination()
{
    let (mut f, _guard, engine, _space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), None);
    let stamp = inspect(&f).await;
    let target = uuid::Uuid::now_v7().to_string();
    {
        let state = f.host.lock().unwrap();
        let registered=lifetime::apply(&state.journal.0,&pi::envelope("owner",json!({"method":"registry.ensure","ghost_id":target,"conversation_id":uuid::Uuid::now_v7().to_string(),"kind":"specialist","roles":[]})),"owner").unwrap();
        assert_eq!(registered.status, ResponseStatus::Success);
    }
    let mut request = PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: pi::envelope(
            &f.ghost,
            json!({"method":"work.delegate","parent_work_id":f.work,"target_ghost_id":target,"summary":"common marker must stay scoped","artifact_refs":[],"acceptance_spec":{},"work_memory_context_revision":stamp}),
        ),
    };
    request.envelope.expected_revision = Some(1);
    let mut unstamped = request.clone();
    unstamped
        .envelope
        .body
        .as_object_mut()
        .unwrap()
        .remove("work_memory_context_revision");
    unstamped.envelope.payload_digest = canonical_digest(&unstamped.envelope.body).unwrap();
    let missing = f
        .host
        .lifetime_pi_action(&unstamped, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(
        missing["result"]["error_code"], "disclosure_blocked",
        "{missing}"
    );
    let denied = f
        .host
        .lifetime_pi_action(&request, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_ne!(denied["result"]["status"], "success", "{denied}");
    {
        let state = f.host.lock().unwrap();
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM lifetime_work_links WHERE parent_work_id=?1",
                    [&f.work],
                    |row| row.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
    }
    // Independently configured same-source target (the same Ghost here) may
    // receive the scoped responsibility, but its optional profile becomes a
    // required child gate before any generated summary reaches inference.
    let update = owner(
        &f,
        json!({"method":"work.memory.profile.configure","ghost_id":f.ghost,"binding_ids":["shared"],"required":false,"experience_space_id":null}),
        Some(1),
    );
    assert_eq!(update["result"]["status"], "success");
    request.envelope.command_id = uuid::Uuid::now_v7().to_string();
    request.envelope.body["target_ghost_id"] = json!(f.ghost);
    request.envelope.payload_digest = canonical_digest(&request.envelope.body).unwrap();
    let delegated = f
        .host
        .lifetime_pi_action(&request, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(delegated["result"]["status"], "success", "{delegated}");
    let child: Work = serde_json::from_value(delegated["result"]["data"]["work"].clone()).unwrap();
    {
        let state = f.host.lock().unwrap();
        let grant = grant(&state.journal.0, &child).unwrap().unwrap();
        assert!(grant.required);
        assert!(grant.experience_space.is_none());
        assert!(requires_private_delivery(&state.journal.0, &child.id).unwrap());
    }
    let child_assignment = {
        let state = f.host.lock().unwrap();
        state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[&child.id],|row|row.get::<_,String>(0)).unwrap()
    };
    let child_inspect = PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: pi::envelope(
            &f.ghost,
            json!({"method":"conversation.assignment.inspect","ghost_id":f.ghost,"conversation_id":f.conversation,"assignment_id":child_assignment}),
        ),
    };
    let inspected = f
        .host
        .lifetime_pi_action(&child_inspect, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(inspected["result"]["status"], "success", "{inspected}");
    assert_eq!(
        inspected["result"]["data"]["assignment"]["privacy"],
        "private"
    );
    let child_context = PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: pi::envelope(
            &f.ghost,
            json!({"method":"work.memory.context.inspect","ghost_id":f.ghost,"conversation_id":f.conversation,"assignment_id":child_assignment,"work_id":child.id}),
        ),
    };
    let authenticated = f
        .host
        .lifetime_pi_action(&child_context, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(
        authenticated["result"]["data"]["memory_permitted"], true,
        "{authenticated}"
    );
    let mut grants: Value =
        serde_json::from_slice(&fs::read(engine.join("grants.json")).unwrap()).unwrap();
    grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token");
    fs::write(
        engine.join("grants.json"),
        serde_json::to_vec(&grants).unwrap(),
    )
    .unwrap();
    request.envelope.command_id = uuid::Uuid::now_v7().to_string();
    let blocked = f
        .host
        .lifetime_pi_action(&request, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(
        blocked["result"]["error_code"], "disclosure_blocked",
        "{blocked}"
    );
}

#[tokio::test]
async fn hung_index_continuation_yields_driver_and_reconciles_same_written_source() {
    let (mut f, _guard, engine, space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), Some(&space.id));
    let stamp = inspect(&f).await;
    let artifact = publish(&f, &stamp).await;
    f.host.lifetime_work_memory_action(&memory_request(&f,"work.memory.record",json!({"summary":"One durable source across timeout","limitations":"","artifact_digests":[artifact.digest]})),PiInferenceScope::Local).await.unwrap();
    let completed = complete(&f, &stamp).await;
    assert_eq!(completed.data["verification"]["status"], "success");
    fs::write(engine.join("hang-source-proof"), "hang").unwrap();
    let started = std::time::Instant::now();
    let returned = f
        .host
        .advance_work_experiences_bounded(std::time::Duration::from_millis(500))
        .await
        .unwrap();
    assert!(!returned);
    assert!(started.elapsed() < std::time::Duration::from_millis(1500));
    assert!(
        engine.join("proof-started").exists(),
        "test must time out after the source write and native index request"
    );
    let pending = entries(&f).remove(0);
    assert_eq!(pending.state, "written_index_pending");
    let bytes = fs::read(space.path.join(format!("{}.md", pending.page_id))).unwrap();
    assert_eq!(Some(documents::digest(&bytes)), pending.hash);
    let admitted = owner(
        &f,
        json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Other dispatch after bounded drain","privacy":"public","acceptance_spec":{}}),
        None,
    );
    assert_eq!(admitted["result"]["status"], "success", "{admitted}");
    let state = f.host.lock().unwrap();
    let outbox = lifetime::pending_outbox(&state.journal.0).unwrap();
    assert!(outbox.iter().any(|item| item.target == "pi"));
    drop(state);
    fs::remove_file(engine.join("hang-source-proof")).unwrap();
    due(&f);
    assert!(f
        .host
        .advance_work_experiences_bounded(std::time::Duration::from_secs(2))
        .await
        .unwrap());
    let recovered = entries(&f).remove(0);
    assert_eq!(recovered.state, "indexed");
    assert_eq!(recovered.page_id, pending.page_id);
    assert_eq!(recovered.hash, pending.hash);
    assert_eq!(recovered.body, pending.body);
    assert_eq!(
        fs::read(space.path.join(format!("{}.md", pending.page_id))).unwrap(),
        bytes
    );
    assert_eq!(documents::list(&space, "").unwrap().len(), 1);
}

#[tokio::test]
async fn independent_verifier_requires_recorded_memory_lineage_and_fresh_source_grant() {
    let (mut f,_guard,engine,_)=fixture().await;
    bind(&mut f,true,json!(["shared"]),None);
    let actual={let state=f.host.lock().unwrap();work(&state.journal.0,&f.work).unwrap()};
    assert!(f.host.work_memory_verification_guard(&actual).await.is_err(),"required Work cannot synthesize missing producer lineage");
    inspect(&f).await;
    f.host.work_memory_verification_guard(&actual).await.unwrap();
    let mut grants:Value=serde_json::from_slice(&fs::read(engine.join("grants.json")).unwrap()).unwrap();
    grants.as_object_mut().unwrap().remove("shared-fixture-token");
    fs::write(engine.join("grants.json"),serde_json::to_vec(&grants).unwrap()).unwrap();
    assert!(f.host.work_memory_verification_guard(&actual).await.is_err(),"verifier must freshly authenticate source, not reuse the producer stamp");
    let revoked=owner(&f,json!({"method":"work.memory.revoke","work_id":f.work}),Some(actual.goal_revision));
    assert_eq!(revoked["result"]["status"],"success","{revoked}");
    let state=f.host.lock().unwrap();
    assert!(f.host.work_memory_verification_current(&state,&actual).is_err(),"final writer rejects revoked lineage too");
}
