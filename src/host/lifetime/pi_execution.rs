//! Same-Ghost Pi execution. No worker process or second model loop is started.
//! SQLite records intent before I/O; an unresolved intent blocks the entire
//! execution, including a retry that invents a new tool-call identity.
use super::{
    apply, assignments, db, graph,
    pi_tools::{self, PiInferenceScope, PiToolRequest},
};
use crate::{
    adapters::computer::{ComputerBackend, ComputerOperation},
    host::{lifetime_computers::PiEnvironment, Host},
    lifetime_contract::{
        canonical_digest, Artifact, Envelope, Response, ResponseStatus, RetryClass, Work,
    },
    worker::{native_tools::NativeWorkspace, scoped_tools::ScopedWorkspace},
};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
#[cfg(test)]
#[path = "pi_execution/real_tests.rs"]
mod real_tests;
#[cfg(test)]
#[path="pi_execution/browser_tests.rs"]
mod browser_tests;
#[cfg(test)]
#[path="pi_execution/recovery_tests.rs"]
mod recovery_tests;
#[cfg(test)]
#[path="pi_execution/time_policy_tests.rs"]
mod time_policy_tests;
#[cfg(test)]
#[path="pi_execution/a20_tests.rs"]
mod a20_tests;

#[path="pi_execution/command_recipes.rs"]
mod command_recipes;
#[path="pi_execution/json_summary.rs"]
mod json_summary;
pub(super) fn command_recipe_views(conn:&Connection,work:&Work)->Result<Vec<Value>> {command_recipes::views(conn,work)}

/// Read-only evidence of the original effect authorization budget. This is not
/// a completion deadline, a task terminalizer, or authority to resume work.
#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct ExecutionTimePolicy {
    pub(crate) work_id: String,
    pub(crate) execution_id: String,
    pub(crate) assignment_id: String,
    pub(crate) generation_task_id: u64,
    pub(crate) authority_epoch: u64,
    pub(crate) execution_state: String,
    pub(crate) observed_at_ms: u64,
    pub(crate) created_ms: u64,
    pub(crate) deadline_ms: u64,
    pub(crate) paused_ms: u64,
    pub(crate) dependency_pause_ms: u64,
    pub(crate) owner_pause_ms: i64,
    pub(crate) effect_deadline_at_ms: u64,
    pub(crate) effect_authority_alive: bool,
}

pub(crate) fn execution_time_policy(
    conn: &Connection,
    work: &Work,
    now: u64,
) -> Result<Option<ExecutionTimePolicy>> {
    let Some(execution) = work.execution_id.as_deref() else {
        return Ok(None);
    };
    let dependency_pause = super::pi_wait::ongoing_pause_ms(conn, work, now)?;
    // Keep the exact SQL arithmetic and inclusive boundary used by the effect
    // guard. In particular, an active dependency/Owner wait does not restart a
    // fresh execution budget, and read-only observation never accrues pause.
    let policy=conn.query_row("SELECT assignment_id,generation_task_id,authority_epoch,state,created_ms,deadline_ms,paused_ms,COALESCE((SELECT MAX(?2-wait_started_ms) FROM lifetime_pi_effects WHERE execution_id=?1 AND state='waiting_owner'),0),created_ms+deadline_ms+paused_ms+?3+COALESCE((SELECT MAX(?2-wait_started_ms) FROM lifetime_pi_effects WHERE execution_id=?1 AND state='waiting_owner'),0),?2<=created_ms+deadline_ms+paused_ms+?3+COALESCE((SELECT MAX(?2-wait_started_ms) FROM lifetime_pi_effects WHERE execution_id=?1 AND state='waiting_owner'),0) FROM lifetime_pi_executions WHERE execution_id=?1 AND work_id=?4 AND ghost_id=?5 AND goal_revision=?6",params![execution,now,dependency_pause,work.id,work.owner,work.goal_revision],|r|Ok(ExecutionTimePolicy {work_id:work.id.clone(),execution_id:execution.into(),assignment_id:r.get(0)?,generation_task_id:r.get(1)?,authority_epoch:r.get(2)?,execution_state:r.get(3)?,observed_at_ms:now,created_ms:r.get(4)?,deadline_ms:r.get(5)?,paused_ms:r.get(6)?,dependency_pause_ms:dependency_pause,owner_pause_ms:r.get(7)?,effect_deadline_at_ms:r.get(8)?,effect_authority_alive:r.get(9)?}))?;
    Ok(Some(policy))
}

fn failure(code: &str, summary: impl Into<String>) -> Response {
    Response {
        status: ResponseStatus::Error,
        summary: summary.into(),
        object_refs: vec![],
        artifacts: vec![],
        next_actions: vec!["reconcile_original_pi_effect".into()],
        error_code: Some(code.into()),
        retry_class: RetryClass::ReconcileFirst,
        data: Value::Null,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        host::{self, scheduler::Journal, State},
        store::ProfileStore,
    };
    use std::{
        collections::BTreeMap,
        fs::File,
        sync::{atomic::AtomicBool, Mutex},
    };
    pub(crate) struct Fixture {
        pub(crate) _root: tempfile::TempDir,
        pub(crate) host: Host,
        pub(crate) ghost: String,
        pub(crate) conversation: String,
        pub(crate) assignment: String,
        pub(crate) work: String,
    }
    pub(crate) fn envelope(actor: &str, body: Value) -> Envelope {
        Envelope {
            protocol_version: crate::lifetime_contract::VERSION.into(),
            command_id: uuid::Uuid::new_v4().to_string(),
            payload_digest: canonical_digest(&body).unwrap(),
            actor_ref: actor.into(),
            authority_epoch: 1,
            expected_revision: None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            body,
        }
    }
    fn setup() -> Fixture {
        setup_with_spec(json!({}))
    }
    pub(crate) fn setup_with_spec(spec: Value) -> Fixture {
        setup_with_prompt_and_spec("Write and independently publish a fixture",spec)
    }

    pub(crate) fn setup_with_prompt_and_spec(prompt:&str,spec:Value)->Fixture {
        setup_with_privacy(prompt,spec,"public")
    }

    pub(crate) fn setup_with_privacy(prompt:&str,spec:Value,privacy:&str)->Fixture {
        let root = tempfile::tempdir().unwrap();
        let profile = Host::profile(
            ProfileStore::create_profile(root.path(), "primary", "Pi fixture").unwrap(),
        )
        .unwrap();
        let ghost = profile.id.clone();
        let conversation = uuid::Uuid::new_v4().to_string();
        let journal = Journal::open(&root.path().join("workspace.db")).unwrap();
        let pair=super::super::apply(&journal.0,&envelope("owner",json!({"method":"registry.ensure","ghost_id":ghost,"conversation_id":conversation,"kind":"primary","roles":[]})),"owner").unwrap();
        assert_eq!(pair.status, ResponseStatus::Success, "{pair:?}");
        let admission=super::super::apply(&journal.0,&envelope("owner",json!({"method":"goal.submit","ghost_id":ghost,"conversation_id":conversation,"prompt":prompt,"privacy":privacy,"acceptance_spec":spec})),"owner").unwrap();
        assert_eq!(admission.status, ResponseStatus::Success, "{admission:?}");
        let work = admission.data["work"]["id"].as_str().unwrap().to_string();
        let assignment:String=journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment'",[],|r|r.get(0)).unwrap();
        let computers = host::lifetime_computers::NativeComputers::pi_fixture(
            &root.path().join("registry"),
            &ghost,
        )
        .unwrap();
        let app = Host {
            root: root.path().to_path_buf(),
            state: Mutex::new(State {
                profiles: BTreeMap::from([(ghost.clone(), profile)]),
                journal,
            }),
            handle: tokio::runtime::Handle::current(),
            default_model: "mock".into(),
            _lock: host::WorkspaceLock(File::create(root.path().join("test.lock")).unwrap()),
            brain: crate::adapters::memory::Brain::default(),
            computer: crate::adapters::computer::default_backend(),
            integrations: host::integrations::Connections::default(),
            workers: Mutex::new(vec![]),
            profile_workers: Mutex::new(BTreeMap::new()),
            recovery: tokio::sync::Mutex::new(()),
            stopping: AtomicBool::new(false),
        #[cfg(test)]
        legacy_fixture_reasoning: AtomicBool::new(false),
            dispatch_enabled: true,
            pi_callback_token: String::new(),
            pi_local_route: None,
            authority_epoch: 1,
            native_computers: Some(computers),
        };
        Fixture {
            _root: root,
            host: app,
            ghost,
            conversation,
            assignment,
            work,
        }
    }
    #[tokio::test]
    async fn work_inspection_exposes_only_the_configured_fixture_execution_environment() {
        let f=setup();
        let request=PiToolRequest{context_ref:None,ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:envelope(&f.ghost,json!({"method":"work.inspect","work_id":f.work}))};
        let response=f.host.lifetime_pi_action(&request,PiInferenceScope::Public).await.unwrap();assert_eq!(response["result"]["status"],"success");
        let execution=&response["result"]["data"]["execution"];let environment=&execution["environment"];
        assert_eq!(execution["engine"],"pi");assert_eq!(execution["cwd"],"/workspace");assert_eq!(execution["file_paths"],"work-relative");
        assert_eq!(environment["version"],"ghost-execution-environment/1");assert_eq!(environment["evidence"],"fixture");assert_eq!(environment["backend"],"fixture");assert_eq!(environment["simulated"],true);
        assert!(environment.get("image_ref").is_none());assert!(environment.get("shell").is_none());assert!(!environment.to_string().contains(f.host.root.to_str().unwrap()));
    }

    pub(crate) fn request(
        f: &Fixture,
        task: u64,
        call: &str,
        operation: &str,
        arguments: Value,
    ) -> PiToolRequest {
        PiToolRequest {
            context_ref: None, ghost_id: f.ghost.clone(),
            conversation_id: f.conversation.clone(),
            envelope: envelope(
                &f.ghost,
                json!({"method":"work.execute","assignment_id":f.assignment,"work_id":f.work,
            "generation_task_id":7,"task_id":task,"call_id":call,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":arguments})).unwrap(),"arguments":arguments}),
            ),
        }
    }
    #[tokio::test]
    async fn pi_direct_files_publish_and_result_without_worker_admission() {
        let f = setup();
        let write = request(
            &f,
            10,
            "write",
            "write",
            json!({"path":"answer.txt","content":"before"}),
        );
        let first = f
            .host
            .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
            .await
            .unwrap();
        assert_eq!(first.status, ResponseStatus::Success, "{first:?}");
        assert_eq!(first.data["receipt"]["state"], "complete");
        let replay = f
            .host
            .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
            .await
            .unwrap();
        assert_eq!(first, replay);
        for tool in [
            request(&f, 11, "read", "read", json!({"path":"answer.txt"})),
            request(
                &f,
                12,
                "edit",
                "edit",
                json!({"path":"answer.txt","edits":[{"oldText":"before","newText":"after"}]}),
            ),
        ] {
            let response = f
                .host
                .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
                .await
                .unwrap();
            assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        }
        let publication = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    13,
                    "publish",
                    "publish_artifact",
                    json!({"path":"answer.txt","privacy":"public"}),
                ),
                PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(
            publication.status,
            ResponseStatus::Success,
            "{publication:?}"
        );
        assert_eq!(publication.artifacts.len(), 1);
        let complete = PiToolRequest {
            context_ref: None, ghost_id: f.ghost.clone(),
            conversation_id: f.conversation.clone(),
            envelope: envelope(
                &f.ghost,
                json!({"method":"work.execution.complete","assignment_id":f.assignment,"work_id":f.work,"task_id":7,"summary":"Published fixture"}),
            ),
        };
        let completed = f
            .host
            .lifetime_pi_execution_action(&complete, PiInferenceScope::Public)
            .await
            .unwrap();
        assert_eq!(completed.status, ResponseStatus::Success, "{completed:?}");
        let state = f.host.lock().unwrap();
        let work = db::work(&state.journal.0, &f.work).unwrap().unwrap();
        assert_eq!(work.state, "completed");
        assert_ne!(
            db::goal(&state.journal.0, &work.goal_id)
                .unwrap()
                .unwrap()
                .state,
            "accepted"
        );
        let workers: i64 = state
            .journal
            .0
            .query_row(
                "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(workers, 0);
        let artifact = &publication.artifacts[0];
        assert_eq!(
            crate::worker::journal::read_verified_artifact(
                &f.host.root.join("pi-execution"),
                work.execution_id.as_deref().unwrap(),
                &artifact.digest,
                Path::new(&artifact.locator)
            )
            .unwrap(),
            b"after"
        );
        drop(state);
        let read = envelope("owner", json!({
            "method":"work.artifact",
            "work_id":work.id,
            "execution_id":work.execution_id,
            "digest":artifact.digest,
            "locator":artifact.locator
        }));
        let response = f.host.lifetime_action(&read).unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        let data = &response["result"]["data"];
        assert_eq!(data["goal_id"], work.goal_id);
        assert_eq!(data["goal_revision"], work.goal_revision);
        assert_eq!(data["digest"], artifact.digest);
        use base64::{engine::general_purpose::STANDARD, Engine};
        assert_eq!(STANDARD.decode(data["data"].as_str().unwrap()).unwrap(), b"after");
    }
    #[tokio::test]
    async fn pending_effect_blocks_replay_and_new_call_after_durable_reopen() {
        let f = setup();
        let write = request(
            &f,
            10,
            "write",
            "write",
            json!({"path":"answer.txt","content":"one-effect"}),
        );
        assert_eq!(
            f.host
                .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
                .await
                .unwrap()
                .status,
            ResponseStatus::Success
        );
        {
            let state = f.host.lock().unwrap();
            state
                .journal
                .0
                .execute(
                    "UPDATE lifetime_pi_effects SET state='pending',response_json=NULL",
                    [],
                )
                .unwrap();
        }
        // A fresh SQLite connection observes the persisted crash window.
        let reopened = Connection::open(f.host.root.join("workspace.db")).unwrap();
        assert_eq!(
            reopened
                .query_row("SELECT state FROM lifetime_pi_effects", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "pending"
        );
        drop(reopened);
        for tool in [
            write,
            request(
                &f,
                11,
                "new-call",
                "write",
                json!({"path":"forbidden.txt","content":"duplicate"}),
            ),
        ] {
            let response = f
                .host
                .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
                .await
                .unwrap();
            assert_eq!(
                response.error_code.as_deref(),
                Some("effect_unknown"),
                "{response:?}"
            );
        }
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
    }
    #[tokio::test]
    async fn different_input_same_identity_and_fenced_epoch_never_write() {
        let f = setup();
        let write = request(
            &f,
            10,
            "call",
            "write",
            json!({"path":"answer.txt","content":"first"}),
        );
        let first = f
            .host
            .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
            .await
            .unwrap();
        assert_eq!(first.status, ResponseStatus::Success);
        let conflict = request(
            &f,
            10,
            "call",
            "write",
            json!({"path":"answer.txt","content":"second"}),
        );
        assert!(f
            .host
            .lifetime_pi_execution_action(&conflict, PiInferenceScope::Public)
            .await
            .is_err());
        {
            let state = f.host.lock().unwrap();
            state
                .journal
                .0
                .execute("UPDATE lifetime_authority SET authority_epoch=2", [])
                .unwrap();
        }
        let fenced = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    11,
                    "other",
                    "write",
                    json!({"path":"other.txt","content":"no"}),
                ),
                PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(fenced.error_code.as_deref(), Some("authority_fenced"));
    }
    pub(crate) fn verifier_spec(expected: &str) -> Value {
        json!({"required_checks":["artifact_sha256","artifact_content"],"verifier":{"kind":"pi-artifact/1","artifact_path":"answer.txt","expected_sha256":format!("{:x}",Sha256::digest(expected.as_bytes()))}})
    }
    pub(crate) async fn publish_complete(f: &Fixture, text: &str) -> Response {
        let write = request(
            f,
            10,
            "write",
            "write",
            json!({"path":"answer.txt","content":text}),
        );
        assert_eq!(
            f.host
                .lifetime_pi_execution_action(&write, PiInferenceScope::Public)
                .await
                .unwrap()
                .status,
            ResponseStatus::Success
        );
        let publication = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    f,
                    11,
                    "publish",
                    "publish_artifact",
                    json!({"path":"answer.txt","privacy":"public"}),
                ),
                PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(publication.status, ResponseStatus::Success);
        f.host.lifetime_pi_execution_action(&PiToolRequest {context_ref: None, ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:envelope(&f.ghost,json!({"method":"work.execution.complete","assignment_id":f.assignment,"work_id":f.work,"task_id":7,"summary":"Published fixture"}))},PiInferenceScope::Public).await.unwrap()
    }
    #[tokio::test]
    async fn legacy_verifier_without_completion_opt_in_stays_pending_when_shell_is_omitted() {
        let mut spec = verifier_spec("expected");
        spec["required_checks"] = json!(["artifact_sha256", "artifact_content", "command_success"]);
        spec["verifier"]["command"] = json!("printf verified");
        let fixture = setup_with_spec(spec);
        let completed = publish_complete(&fixture, "expected").await;
        assert_eq!(completed.status, ResponseStatus::Success);
        assert_ne!(completed.data["verification"]["status"], "success");
        let state = fixture.host.lock().unwrap();
        assert_eq!(db::work(&state.journal.0, &fixture.work).unwrap().unwrap().state, "completed");
        assert_eq!(state.journal.0.query_row(
            "SELECT COUNT(*) FROM lifetime_pi_effects WHERE operation='bash'", [],
            |row| row.get::<_, u64>(0),
        ).unwrap(), 0);
    }

    #[tokio::test]
    async fn owner_content_expectation_is_independently_accepted_and_recovered_after_reopen() {
        let f = setup_with_spec(verifier_spec("expected"));
        let response = publish_complete(&f, "expected").await;
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        assert_eq!(
            response.data["verification"]["status"], "success",
            "{response:?}"
        );
        let reopened = Journal::open(&f.host.root.join("workspace.db")).unwrap();
        let work = db::work(&reopened.0, &f.work).unwrap().unwrap();
        assert_eq!(work.state, "accepted");
        let recovered = f
            .host
            .verify_pi_work(
                &reopened.0,
                &envelope("owner", json!({"method":"work.verify","work_id":f.work})),
                &f.work,
            )
            .unwrap();
        assert_eq!(recovered.status, ResponseStatus::Success, "{recovered:?}");
        assert_eq!(
            reopened
                .0
                .query_row("SELECT COUNT(*) FROM lifetime_acceptances", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[tokio::test]
    async fn wrong_or_missing_owner_expectation_stays_completed_pending_review() {
        for spec in [
            verifier_spec("owner-expected"),
            json!({"verifier":{"kind":"pi-artifact/1","artifact_path":"answer.txt"}}),
            json!({}),
        ] {
            let f = setup_with_spec(spec);
            let response = publish_complete(&f, "producer-claim").await;
            assert_eq!(response.status, ResponseStatus::Success);
            assert_eq!(
                response.data["verification"]["state"], "pending_review",
                "{response:?}"
            );
            let state = f.host.lock().unwrap();
            assert_eq!(
                db::work(&state.journal.0, &f.work).unwrap().unwrap().state,
                "completed"
            );
            assert_eq!(
                state
                    .journal
                    .0
                    .query_row("SELECT COUNT(*) FROM lifetime_acceptances", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
    #[tokio::test]
    async fn model_created_verifier_has_no_owner_authority() {
        let f = setup();
        let state = f.host.lock().unwrap();
        let turn = uuid::Uuid::new_v4().to_string();
        state.journal.0.execute("INSERT INTO lifetime_turns(id,ghost_id,conversation_id,sequence,sender_kind,sender_ref,text,privacy,kind,source_turn_id,attachments,created_at_ms) VALUES(?1,?2,?3,1,'owner','owner','produce an answer','public','user',NULL,'[]',1)",params![turn,f.ghost,f.conversation]).unwrap();
        state.journal.0.execute("INSERT INTO lifetime_turn_runs(turn_id,ghost_id,conversation_id,state,cancel_requested,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,'queued',0,1,1)",params![turn,f.ghost,f.conversation]).unwrap();
        let spec = verifier_spec("producer-invented");
        let result=super::super::apply(&state.journal.0,&envelope(&f.ghost,json!({"method":"goal.create","turn_id":turn,"ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"produce an answer","acceptance_spec":spec})),&f.ghost).unwrap();
        assert_eq!(result.status, ResponseStatus::Success, "{result:?}");
        let work: Work = serde_json::from_value(result.data["work"].clone()).unwrap();
        assert!(!owner_expectations(&state.journal.0, &work, &spec["verifier"]).unwrap());
    }
    #[test]
    fn edits_match_original_do_not_overlap_and_never_overwrite_changed_read_source() {
        assert!(edited_content(
            "ab",
            &json!([{"oldText":"a","newText":"x"},{"oldText":"x","newText":"y"}])
        )
        .is_err());
        assert!(edited_content(
            "abcd",
            &json!([{"oldText":"abc","newText":"x"},{"oldText":"bc","newText":"y"}])
        )
        .is_err());
        assert_eq!(
            edited_content(
                "a b",
                &json!([{"oldText":"a","newText":"x"},{"oldText":"b","newText":"y"}])
            )
            .unwrap(),
            "x y"
        );
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        std::fs::write(root.join("answer.txt"), "before").unwrap();
        let workspace = ScopedWorkspace::for_task(&root).unwrap();
        let (original, digest) = workspace.read_utf8("answer.txt").unwrap();
        let edited =
            edited_content(&original, &json!([{"oldText":"before","newText":"after"}])).unwrap();
        std::fs::write(root.join("answer.txt"), "concurrent newer contents").unwrap();
        assert!(plan_checked_edit(&workspace, "answer.txt", &edited, &digest).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("answer.txt")).unwrap(),
            "concurrent newer contents"
        );
    }
    #[tokio::test]
    async fn two_ghosts_delegate_accept_and_stage_exact_child_artifact_without_worker() {
        let mut f = setup();
        let profile = Host::profile(
            ProfileStore::create_profile(&f.host.root, "specialist", "Child Ghost").unwrap(),
        )
        .unwrap();
        let child = profile.id.clone();
        let conversation = uuid::Uuid::new_v4().to_string();
        let prompt = "Produce child evidence";
        let child_spec = verifier_spec("child-evidence");
        let (child_work, child_assignment) = {
            let mut state = f.host.lock().unwrap();
            state.profiles.insert(child.clone(), profile);
            let registered=super::super::apply(&state.journal.0,&envelope("owner",json!({"method":"registry.ensure","ghost_id":child,"conversation_id":conversation,"kind":"specialist","roles":["researcher"]})),"owner").unwrap();
            assert_eq!(registered.status, ResponseStatus::Success, "{registered:?}");
            let provision = f
                .host
                .native_computers
                .as_ref()
                .unwrap()
                .provision_pi_ghost(&state.journal.0, &f.ghost, &child, 1, "pi-default/1")
                .unwrap();
            assert_eq!(provision["ready"], true);
            let original = db::work(&state.journal.0, &f.work).unwrap().unwrap();
            let goal = db::goal(&state.journal.0, &original.goal_id)
                .unwrap()
                .unwrap();
            let mut update = envelope(
                "owner",
                json!({"method":"goal.update","goal_id":goal.id,"prompt":goal.prompt,"acceptance_spec":{"delegation_verifiers":[{"target_ghost_id":child,"prompt_digest":format!("{:x}",Sha256::digest(prompt.as_bytes())),"verifier":child_spec["verifier"]}]}}),
            );
            update.expected_revision = Some(1);
            let updated = super::super::apply(&state.journal.0, &update, "owner").unwrap();
            assert_eq!(updated.status, ResponseStatus::Success, "{updated:?}");
            let mut delegate = envelope(
                &f.ghost,
                json!({"method":"work.delegate","parent_work_id":f.work,"target_ghost_id":child,"summary":prompt,"artifact_refs":[],"acceptance_spec":child_spec}),
            );
            delegate.expected_revision = Some(2);
            let delegated = super::super::apply(&state.journal.0, &delegate, &f.ghost).unwrap();
            assert_eq!(delegated.status, ResponseStatus::Success, "{delegated:?}");
            let work = delegated.data["work"]["id"].as_str().unwrap().to_owned();
            let assignment:String=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1 ORDER BY id DESC LIMIT 1",[&work],|r|r.get(0)).unwrap();
            (work, assignment)
        };
        f.assignment={let state=f.host.lock().unwrap();state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1 ORDER BY id DESC LIMIT 1",[&f.work],|r|r.get(0)).unwrap()};
        let before=f.host.lifetime_pi_execution_action(&request(&f,10,"pre-wait-write","write",json!({"path":"draft.txt","content":"original"})),PiInferenceScope::Public).await.unwrap();
        assert_eq!(before.status,ResponseStatus::Success,"{before:?}");
        let original_execution=before.data["receipt"]["execution_id"].clone();
        {let state=f.host.lock().unwrap();let mut wait=envelope(&f.ghost,json!({"method":"work.wait","work_id":f.work,"wait_for":[child_work],"assignment_id":f.assignment,"generation_task_id":7}));wait.expected_revision=Some(2);
        let response=super::super::apply(&state.journal.0,&wait,&f.ghost).unwrap();assert_eq!(response.status,ResponseStatus::Success,"{response:?}");}
        let child_request = |task, call, operation, arguments: Value| PiToolRequest {
            context_ref: None, ghost_id: child.clone(),
            conversation_id: conversation.clone(),
            envelope: envelope(
                &child,
                json!({"method":"work.execute","assignment_id":child_assignment,"work_id":child_work,
            "generation_task_id":19,"task_id":task,"call_id":call,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":arguments})).unwrap(),"arguments":arguments}),
            ),
        };
        for request in [
            child_request(
                20,
                "write",
                "write",
                json!({"path":"answer.txt","content":"child-evidence"}),
            ),
            child_request(
                21,
                "publish",
                "publish_artifact",
                json!({"path":"answer.txt","privacy":"public"}),
            ),
        ] {
            let response = f
                .host
                .lifetime_pi_execution_action(&request, PiInferenceScope::Public)
                .await
                .unwrap();
            assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        }
        let completed=f.host.lifetime_pi_execution_action(&PiToolRequest {context_ref: None, ghost_id:child.clone(),conversation_id:conversation.clone(),envelope:envelope(&child,json!({"method":"work.execution.complete","assignment_id":child_assignment,"work_id":child_work,"task_id":19,"summary":"Child evidence published"}))},PiInferenceScope::Public).await.unwrap();
        assert_eq!(
            completed.data["verification"]["status"], "success",
            "{completed:?}"
        );
        let (input, locator) = {
            let state = f.host.lock().unwrap();
            let work = db::work(&state.journal.0, &f.work).unwrap().unwrap();
            assert_eq!(work.state, "queued");
            f.assignment=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1 ORDER BY id DESC LIMIT 1",[&f.work],|r|r.get(0)).unwrap();
            let inputs = artifact_inputs(&state.journal.0, &work).unwrap();
            assert_eq!(inputs.len(), 1);
            assert_eq!(inputs[0]["work_id"], child_work);
            assert_eq!(
                inputs[0]["artifact"]["producing_attempt"],
                inputs[0]["execution_id"]
            );
            (
                inputs[0]["path"].as_str().unwrap().to_string(),
                inputs[0]["artifact"]["locator"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            )
        };
        let read = f
            .host
            .lifetime_pi_execution_action(
                &request(&f, 30, "read-child", "read", json!({"path":input})),
                PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(read.data["output"]["content"], "child-evidence", "{read:?}");
        assert_eq!(read.data["receipt"]["execution_id"],original_execution,"Wait replaced the parent execution");
        {let state=f.host.lock().unwrap();let pins:String=state.journal.0.query_row("SELECT input_artifacts_json FROM lifetime_pi_executions WHERE work_id=?1",[&f.work],|r|r.get(0)).unwrap();let pins:Value=serde_json::from_str(&pins).unwrap();assert_eq!(pins.as_array().unwrap().len(),1);assert_eq!(pins[0]["work_id"],child_work);assert_eq!(pins[0]["execution_id"],completed.data["execution_id"]);}

        std::fs::write(locator, b"tampered-source").unwrap();
        let refused = f
            .host
            .lifetime_pi_execution_action(
                &request(&f, 31, "read-tampered", "read", json!({"path":input})),
                PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(refused.error_code.as_deref(), Some("effect_unknown"));
        let replay=f.host.lifetime_pi_execution_action(&request(&f,31,"read-tampered","read",json!({"path":input})),PiInferenceScope::Public).await.unwrap();
        assert_eq!(replay,refused,"Post-wait unknown effect must retain its exact original receipt");
        let count:u64=f.host.lock().unwrap().journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_effects",[],|r|r.get(0)).unwrap();
        let next=f.host.lifetime_pi_execution_action(&request(&f,32,"after-unknown","write",json!({"path":"must-not-exist.txt","content":"no"})),PiInferenceScope::Public).await.unwrap();
        assert_eq!(next.error_code.as_deref(),Some("effect_unknown"));
        let directory=f.host.native_computers.as_ref().unwrap().pi_fixture_snapshot(&f.ghost,original_execution.as_str().unwrap(),1).unwrap();
        assert!(!directory.join("must-not-exist.txt").exists());
        let state = f.host.lock().unwrap();
        assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_effects",[],|r|r.get::<_,u64>(0)).unwrap(),count);
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn public_host_action_retires_fresh_omp_and_preserves_original_receipt() {
        use crate::control::api::{Action, Command};
        let f = setup();
        let host = std::sync::Arc::new(f.host);
        let source = envelope(
            "owner",
            json!({"method":"work.submit","work_id":f.work,"spec":{"execution_id":"legacy-original"}}),
        );
        let action = |source: Envelope| {
            host.action(Action {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::Lifetime { envelope: source },
            })
            .unwrap()
        };
        let denied = action(source.clone());
        assert_eq!(denied["result"]["error_code"], "legacy_execution_retired");
        let original = apply::success(
            "Historical execution was already admitted",
            vec!["legacy-original".into()],
            json!({"execution_id":"legacy-original"}),
        );
        {
            let state = host.lock().unwrap();
            assert!(db::work(&state.journal.0, &f.work)
                .unwrap()
                .unwrap()
                .execution_id
                .is_none());
            state.journal.0.execute("INSERT INTO lifetime_commands(command_id,payload_digest,actor_ref,authority_epoch,request,response) VALUES(?1,?2,'owner',1,?3,?4)",params![source.command_id,source.payload_digest,serde_json::to_string(&source).unwrap(),serde_json::to_string(&original).unwrap()]).unwrap();
        }
        let recovered = action(source);
        assert_eq!(
            recovered["result"],
            serde_json::to_value(&original).unwrap()
        );
        let state = host.lock().unwrap();
        assert!(db::work(&state.journal.0, &f.work)
            .unwrap()
            .unwrap()
            .execution_id
            .is_none());
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn pi_cancel_never_uses_worker_transport_and_blocks_further_effects() {
        let f=setup();
        let first=f.host.lifetime_pi_execution_action(&request(&f,10,"first","write",json!({"path":"answer.txt","content":"before-cancel"})),PiInferenceScope::Public).await.unwrap();
        assert_eq!(first.status,ResponseStatus::Success);
        let cancelled=f.host.lifetime_action(&envelope("owner",json!({"method":"work.cancel","work_id":f.work}))).unwrap();
        assert_eq!(cancelled["result"]["status"],"success");assert_eq!(cancelled["result"]["data"]["work"]["cancellation"],"requested");
        assert!(f.host.lifetime_pi_execution_action(&request(&f,11,"after-cancel","write",json!({"path":"never.txt","content":"forbidden"})),PiInferenceScope::Public).await.is_err());
        let state=f.host.lock().unwrap();assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_effects",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[tokio::test]
    async fn same_ghost_completes_multiple_works_then_reopens_without_result_stream_collision() {
        let mut f=setup_with_spec(verifier_spec("expected"));
        let first=publish_complete(&f,"expected").await;assert_eq!(first.data["verification"]["status"],"success");
        let first_work=f.work.clone();let first_assignment=f.assignment.clone();
        for attempt in 2..=3 {
            if attempt==3 {
                let reopened=Journal::open(&f.host.root.join("workspace.db")).unwrap();
                assert_eq!(reopened.0.query_row("SELECT COUNT(*) FROM lifetime_acceptances",[],|row|row.get::<_,i64>(0)).unwrap(),2);
            }
            {let state=f.host.lock().unwrap();let response=super::super::apply(&state.journal.0,&envelope("owner",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":format!("Independent task {attempt}"),"privacy":"public","acceptance_spec":verifier_spec("expected")})),"owner").unwrap();assert_eq!(response.status,ResponseStatus::Success,"{response:?}");
                f.work=response.data["work"]["id"].as_str().unwrap().into();
                f.assignment=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&f.work],|row|row.get(0)).unwrap();}
            let completed=publish_complete(&f,"expected").await;assert_eq!(completed.data["verification"]["status"],"success","{completed:?}");
        }
        f.work=first_work;f.assignment=first_assignment;
        let replay=f.host.lifetime_pi_execution_action(&PiToolRequest {context_ref: None, ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:envelope(&f.ghost,json!({"method":"work.execution.complete","assignment_id":f.assignment,"work_id":f.work,"task_id":7,"summary":"Published fixture"}))},PiInferenceScope::Public).await.unwrap();
        assert_eq!(replay,first);
        let state=f.host.lock().unwrap();
        assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_acceptances",[],|row|row.get::<_,i64>(0)).unwrap(),3);
        assert_eq!(state.journal.0.query_row("SELECT COUNT(DISTINCT producer) FROM lifetime_inbox",[],|row|row.get::<_,i64>(0)).unwrap(),3);
        assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_work WHERE json_extract(payload,'$.owner')=?1",[&f.ghost],|row|row.get::<_,i64>(0)).unwrap(),3);
    }
}

pub(crate) fn has_binding(
    conn: &Connection,
    work: &Work,
    assignment: &str,
    epoch: u64,
) -> Result<bool> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='lifetime_pi_executions')", [], |r| r.get(0))?;
    if !exists {
        return Ok(false);
    }
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2 AND assignment_id=?3 AND authority_epoch=?4)",
        params![work.id, work.execution_id, assignment, epoch], |r| r.get(0))?)
}

pub(super) fn execution_is_pi(conn: &Connection, execution: &str) -> Result<bool> {
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='lifetime_pi_executions')",[],|r|r.get(0))?;
    if !exists {
        return Ok(false);
    }
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE execution_id=?1)",
        [execution],
        |r| r.get(0),
    )?)
}

pub(crate) fn offer(
    conn: &Connection,
    computers: Option<&crate::host::lifetime_computers::NativeComputers>,
    ghost: &str,
    work_id: &str,
    epoch: u64,
) -> Result<Option<Value>> {
    let Some(work) = db::work(conn, work_id)? else {
        return Ok(None);
    };
    if !crate::host::bot_lifecycle::work_may_start(conn,&work)? {return Ok(None);}
    let Some(goal) = db::goal(conn, &work.goal_id)? else {
        return Ok(None);
    };
    if work.owner != ghost
        || work.cancellation != "none"
        || !graph::current_result_scope(conn, &work)?
    {
        return Ok(None);
    }
    if let Some(execution) = &work.execution_id {
        let ours: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2 AND authority_epoch=?3 AND state='running')",
            params![work.id, execution, epoch], |r| r.get(0))?;
        if !ours {
            return Ok(None);
        }
    }
    // Skills must not disclose protected content to a public model. Actual
    // pinned bytes are delivered by the assignment inspection separately.
    let privacy = privacy(conn, &work)?;
    if computers.is_some_and(|c| c.pi_available(ghost, epoch, &privacy).unwrap_or(false))
        && goal.state == "open"
    {
        let mut tools = vec!["read", "write", "edit", "bash", "publish_artifact"];
        if computers.is_some_and(|c| c.pi_browser_available(ghost)) {
            tools.push("browser");
        }
        let environment=computers.ok_or_else(||anyhow!("Pi computer missing"))?.pi_work_execution_environment(conn,&work)?.ok_or_else(||anyhow::anyhow!("accepted Pi route has no configured execution policy"))?;
        Ok(Some(json!({"engine":"pi","version":1,"tools":tools,"cwd":"/workspace","file_paths":"work-relative","environment":environment})))
    } else {
        Ok(None)
    }
}

pub(crate) fn skill_refs(
    conn: &Connection,
    work: &Work,
) -> Result<Vec<crate::lifetime_contract::WorkerSkillRef>> {
    let key = format!("{}:{}:{}", work.id, work.goal_revision, work.owner_revision);
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='pi_skill_pin' AND id=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = raw {
        return Ok(serde_json::from_str(&raw)?);
    }
    let refs = crate::host::skills::refs_for_work(conn, &work.owner)?.unwrap_or_default();
    conn.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES('pi_skill_pin',?1,?2)",
        params![key, serde_json::to_string(&refs)?],
    )?;
    Ok(refs)
}

pub(super) fn privacy(conn: &Connection, work: &Work) -> Result<String> {
    let goal = db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Pi Work Goal missing"))?;
    let mut privacy = if super::work_context::is_claimed(conn,work)? {goal.privacy.clone()}else{super::conversation::conversation_privacy(
        conn,
        &goal.accountable_ghost,
        &goal.reply_conversation,
    )?};
    super::conversation::raise_privacy(&mut privacy, &goal.privacy)?;
    for asset in crate::host::bots_provisioning::assets_for_work(conn,work)? {
        super::conversation::raise_privacy(&mut privacy,asset["privacy"].as_str().unwrap_or("local_only"))?;
    }
    for skill in skill_refs(conn, work)? {
        super::conversation::raise_privacy(&mut privacy, &skill.privacy)?;
    }
    for input in graph::native_artifact_inputs(conn, work)?.unwrap_or_default() {
        for artifact in input.artifacts {
            super::conversation::raise_privacy(&mut privacy, &artifact.privacy)?;
        }
    }
    super::conversation::raise_privacy(&mut privacy,&crate::host::shared_skills::privacy(conn,work)?)?;
    crate::host::work_memory::assignment_privacy(conn,work,&privacy)
}

pub(crate) fn artifact_inputs(conn: &Connection, work: &Work) -> Result<Vec<Value>> {
    let mut result = vec![];
    for input in graph::native_artifact_inputs(conn, work)?.unwrap_or_default() {
        for artifact in input.artifacts {
            result.push(json!({"work_id":input.work_id,"goal_id":input.goal_id,"goal_revision":input.goal_revision,"execution_id":input.execution_id,
                "path":format!("input-{}-{}",format!("{:x}",Sha256::digest(input.work_id.as_bytes())),artifact.digest),"artifact":artifact}));
        }
    }
    Ok(result)
}

fn edited_content(original: &str, edits: &Value) -> Result<String> {
    let edits = edits
        .as_array()
        .ok_or_else(|| anyhow!("edit list required"))?;
    ensure!(!edits.is_empty() && edits.len() <= 64, "edit list bounded");
    let mut ranges = vec![];
    for edit in edits {
        apply::exact_fields(edit, &["oldText", "newText"])?;
        let old = apply::string_field(edit, "oldText")?;
        ensure!(!old.is_empty(), "edit source cannot be empty");
        let mut matches = original.match_indices(old);
        let (start, _) = matches
            .next()
            .ok_or_else(|| anyhow!("edit source missing from original file"))?;
        ensure!(
            matches.next().is_none(),
            "edit must match original file exactly once"
        );
        ranges.push((
            start,
            start + old.len(),
            apply::string_field(edit, "newText")?,
        ));
    }
    ranges.sort_by_key(|range| range.0);
    ensure!(
        ranges.windows(2).all(|range| range[0].1 <= range[1].0),
        "edits overlap in original file"
    );
    let mut content = original.to_owned();
    for (start, end, replacement) in ranges.into_iter().rev() {
        content.replace_range(start..end, replacement);
    }
    Ok(content)
}

fn plan_checked_edit(
    workspace: &ScopedWorkspace,
    path: &str,
    content: &str,
    source_digest: &str,
) -> Result<Value> {
    let intent = workspace
        .plan_write(path, content)
        .map_err(|e| anyhow!(e.code))?;
    ensure!(
        intent["before"]["sha256"].as_str() == Some(source_digest),
        "Edit source changed before planning; no overwrite occurred"
    );
    Ok(intent)
}

pub(super) fn admit(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut apply::ApplyContext,
) -> Result<Response> {
    apply::allowed_fields(&envelope.body,&["method","work_id","work_memory_context_revision"],&["method","work_id"])?;
    let work_id = apply::string_field(&envelope.body, "work_id")?;
    let work = db::work(conn, work_id)?.ok_or_else(|| anyhow!("Pi Work not found"))?;
    let goal = db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Pi Goal not found"))?;
    ensure!(
        work.owner == principal && goal.accountable_ghost == principal,
        "Pi admission requires the accountable Ghost"
    );
    ensure!(
        work.execution_id.is_none() && work.cancellation == "none" && work.state == "queued",
        "Work already has an execution; reconcile original attempt"
    );
    if let Some(response) = graph::check_admission(conn, &work)? {
        return Ok(response);
    }
    let original: Option<String> = conn.query_row("SELECT command_id FROM lifetime_commands WHERE json_extract(request,'$.body.method')='goal.create' AND json_extract(response,'$.data.work.id')=?1 AND json_extract(response,'$.status')='success' LIMIT 1", [work_id], |r| r.get(0)).optional()?;
    let existing: Option<String> = conn.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1 LIMIT 1", [work_id], |r| r.get(0)).optional()?;
    if let Some(assignment) = existing {
        return Ok(apply::success(
            "Original same-Ghost Pi assignment recovered",
            vec![work.id.clone()],
            json!({"work":work,"assignment_id":assignment,"execution":{"engine":"pi","version":1}}),
        ));
    }
    // Compatibility for goal.create records admitted before direct dispatch.
    // Delivery keeps the original source command, never the new retry command.
    let source_id = original
        .ok_or_else(|| anyhow!("Pi admission requires a committed canonical Goal source"))?;
    let raw: String = conn.query_row(
        "SELECT request FROM lifetime_commands WHERE command_id=?1",
        [&source_id],
        |r| r.get(0),
    )?;
    let source: Envelope = serde_json::from_str(&raw)?;
    let delivery = apply::outgoing(
        &source,
        principal,
        Some(goal.revision),
        json!({"method":"conversation.assignment","ghost_id":principal,
        "conversation_id":goal.reply_conversation,"goal_id":goal.id,"goal_revision":goal.revision,"work_id":work.id,"prompt":goal.prompt,"privacy":crate::host::work_memory::assignment_privacy(conn,&work,&goal.privacy)?}),
    )?;
    let assignment = delivery["command_id"].clone();
    context.enqueue_from(source_id, "pi", delivery);
    Ok(apply::success(
        "Same-Ghost Pi assignment admitted",
        vec![work.id.clone()],
        json!({"work":work,"assignment_id":assignment,"execution":{"engine":"pi","version":1}}),
    ))
}

pub(crate) fn validate_assignment(conn: &Connection, request: &PiToolRequest) -> Result<Work> {
    let body = &request.envelope.body;
    let mut inspected = request.envelope.clone();
    inspected.body = json!({"method":"conversation.assignment.inspect","assignment_id":apply::string_field(body,"assignment_id")?,
        "ghost_id":request.ghost_id,"conversation_id":request.conversation_id});
    inspected.payload_digest = canonical_digest(&inspected.body)?;
    let response = assignments::inspect(conn, &inspected, &request.ghost_id)?;
    ensure!(
        response.data["assignment"]["work_id"].as_str() == body["work_id"].as_str(),
        "Pi assignment Work mismatch"
    );
    db::work(conn, apply::string_field(body, "work_id")?)?.ok_or_else(|| anyhow!("Pi Work missing"))
}

fn preflight_pi_arguments(operation:&str,args:&Value,privacy:&str)->Result<()> {
    if matches!(operation,"read"|"write"|"edit"|"publish_artifact") {
        let path=apply::string_field(args,"path")?;
        crate::worker::scoped_tools::validate_relative_path(path).map_err(|error|anyhow!("{}; file tools require Work-relative paths such as answer.txt, and shell cwd is /workspace",error.code))?;
    }
    match operation {
        "read"=>json_summary::arguments(args),
        "write"=>{apply::exact_fields(args,&["path","content"])?;ensure!(apply::string_field(args,"content")?.len()<=crate::worker::scoped_tools::MAX_TOOL_CONTENT_BYTES,"Write content exceeds file tool bound");Ok(())},
        "edit"=>apply::exact_fields(args,&["path","edits"]),
        "publish_artifact"=>{apply::exact_fields(args,&["path","privacy"])?;ensure!(args["privacy"].as_str()==Some(privacy),"artifact privacy must match pinned execution privacy");Ok(())},
        _=>Ok(())
    }
}
fn no_effect(body:&Value,execution:&str,reason:&str)->Response {
    let mut response=failure("tool_input_refused",reason);
    response.data=json!({"receipt":receipt(body,execution,"denied"),"host_effect_class":"no_effect"});response
}

fn receipt(body: &Value, execution: &str, state: &str) -> Value {
    json!({"assignment_id":body["assignment_id"],"work_id":body["work_id"],"generation_task_id":body["generation_task_id"],
        "task_id":body["task_id"],"call_id":body["call_id"],"input_digest":body["input_digest"],"execution_id":execution,"state":state})
}

fn unknown(body: &Value, execution: &str) -> Response {
    let mut response = failure(
        "effect_unknown",
        "Original Pi effect remains unresolved; no replay or new effect was admitted",
    );
    response.data = json!({"receipt":receipt(body,execution,"unknown")});
    response
}

impl Host {
    pub(crate) async fn lifetime_pi_execution_action(
        &self,
        request: &PiToolRequest,
        scope: PiInferenceScope,
    ) -> Result<Response> {
        if request.envelope.body["call_id"].as_str().is_some_and(|id| id.starts_with("host-verifier:")) {
            return Ok(failure("invalid_request", "The Host verifier call namespace is reserved"));
        }
        self.pi_execution_action(request, scope).await
    }

    async fn pi_execution_action(
        &self,
        request: &PiToolRequest,
        scope: PiInferenceScope,
    ) -> Result<Response> {
        request.envelope.validate()?;
        if let Some(response)=self.work_memory_effect_guard(request,scope).await? {return Ok(response);}
        if let Some((response,execution))=self.reconcile_revoked_pi_wait(request,scope)? {
            if let Some(computers)=&self.native_computers {let _=computers.pi_browser_stop(&request.ghost_id,&execution).await;}
            return Ok(response);
        }
        let method = apply::string_field(&request.envelope.body, "method")?;
        if method == "work.execution.complete" {
            apply::allowed_fields(&request.envelope.body,&["method","assignment_id","work_id","task_id","summary","work_memory_context_revision"],&["method","assignment_id","work_id","task_id","summary"])?;
            let (execution, verifier_request) = {
                let state = self.lock()?;
                if let Some(response) = self
                    .check_pi_host_scope(&state, request, scope)?
                    .or(pi_tools::guard(&state.journal.0, request, scope)?)
                {
                    return Ok(response);
                }
                let work = db::work(
                    &state.journal.0,
                    apply::string_field(&request.envelope.body, "work_id")?,
                )?
                .ok_or_else(|| anyhow!("Pi Work missing"))?;
                ensure!(
                    work.owner == request.ghost_id,
                    "Pi completion owner mismatch"
                );
                if let Some(execution) = &work.execution_id {
                    let (assignment,generation):(String,u64)=state.journal.0.query_row("SELECT assignment_id,generation_task_id FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2",params![work.id,execution],|r|Ok((r.get(0)?,r.get(1)?)))?;
                    ensure!(
                        request.envelope.body["assignment_id"] == assignment
                            && request.envelope.body["task_id"] == generation,
                        "Pi completion task mismatch"
                    );
                }
                let mut verifier_request = None;
                if let Some(execution) = work.execution_id.as_deref() {
                    let running: bool = state.journal.0.query_row(
                        "SELECT state='running' FROM lifetime_pi_executions WHERE execution_id=?1",
                        [execution], |row| row.get(0),
                    )?;
                    if running {
                        if let Some(arguments) = command_recipes::missing_required_command(&state.journal.0, &work, execution)? {
                            let completion = &request.envelope.body;
                            let call = format!("host-verifier:{}", arguments["command_ref"].as_str().unwrap());
                            let effect = json!({"operation":"bash","arguments":arguments});
                            let mut body = json!({
                                "method":"work.execute","assignment_id":completion["assignment_id"],
                                "work_id":work.id,"generation_task_id":completion["task_id"],
                                "task_id":completion["task_id"],"call_id":call,
                                "input_digest":canonical_digest(&effect)?,"operation":"bash","arguments":arguments
                            });
                            if let Some(revision) = completion.get("work_memory_context_revision") {
                                body["work_memory_context_revision"] = revision.clone();
                            }
                            let mut invocation = request.clone();
                            invocation.envelope.command_id = format!("pi-verifier:{execution}");
                            invocation.envelope.payload_digest = canonical_digest(&body)?;
                            invocation.envelope.body = body;
                            verifier_request = Some(invocation);
                        }
                    }
                }
                (work.execution_id, verifier_request)
            };
            if let Some(verifier) = verifier_request {
                Box::pin(self.pi_execution_action(&verifier, scope)).await?;
            }
            if let Some(execution) = execution {
                self.native_computers
                    .as_ref()
                    .ok_or_else(|| anyhow!("Pi computer missing"))?
                    .pi_browser_stop(&request.ghost_id, &execution)
                    .await?;
            }
            return self.complete_pi_execution(request, scope);
        }
        let body = &request.envelope.body;
        apply::allowed_fields(body,&["method","assignment_id","work_id","generation_task_id","task_id","call_id","input_digest","operation","arguments","work_memory_context_revision"],&["method","assignment_id","work_id","generation_task_id","task_id","call_id","input_digest","operation","arguments"])?;
        let task_id = apply::number_field(body, "task_id")?;
        let generation = apply::number_field(body, "generation_task_id")?;
        ensure!(
            task_id > 0
                && generation > 0
                && task_id <= 9_007_199_254_740_991
                && generation <= 9_007_199_254_740_991,
            "Pi task identity invalid"
        );
        let call = apply::string_field(body, "call_id")?;
        ensure!(
            !call.is_empty() && call.len() <= 512,
            "Pi call identity invalid"
        );
        let operation = apply::string_field(body, "operation")?;
        ensure!(
            matches!(
                operation,
                "read" | "write" | "edit" | "bash" | "publish_artifact" | "browser"
            ),
            "Pi operation unsupported"
        );
        let arguments = body["arguments"]
            .as_object()
            .ok_or_else(|| anyhow!("Pi arguments must be an object"))?;
        ensure!(
            serde_json::to_vec(arguments)?.len() <= 262_144,
            "Pi arguments exceed bound"
        );
        let digest = canonical_digest(&json!({"operation":operation,"arguments":arguments}))?;
        ensure!(
            body["input_digest"].as_str() == Some(&digest),
            "Pi input digest mismatch"
        );
        let browser_mutation=operation=="browser" && matches!(body["arguments"]["operation"].as_str(),Some("click"|"type"|"key"|"scroll"));
        let epoch = request.envelope.authority_epoch;
        let (execution, privacy, pinned_computer, effective_arguments) = {
            let state = self.lock()?;
            if let Some(response) = self.check_pi_host_scope(&state, request, scope)? {
                return Ok(response);
            }
            if let Some(response) = pi_tools::guard(&state.journal.0, request, scope)? {
                return Ok(response);
            }
            if let Some(response)=self.work_memory_effect_current(&state,request,scope)? {return Ok(response);}
            let conn = &state.journal.0;
            if request.context_ref.is_some() {
                let work=db::work(conn,apply::string_field(body,"work_id")?)?.ok_or_else(||anyhow!("Pi replay Work missing"))?;
                if !matches!(work.state.as_str(),"queued"|"running"|"blocked") {
                    let computers=self.native_computers.as_ref().ok_or_else(||anyhow!("Pi replay computer unavailable"))?;
                    ensure!(computers.pi_available(&request.ghost_id,epoch,&privacy(conn,&work)?)?,"Pi replay computer grant revoked");
                    return super::work_context::cached_effect(conn,request)?.ok_or_else(||anyhow!("Terminal Pi Work has no exact effect receipt"));
                }
            }
            let tx = conn.unchecked_transaction()?;
            let mut work = validate_assignment(&tx, request)?;
            super::work_context::producer_profile(&tx,&work)?;
            super::pi_wait::resume(&tx,&mut work,apply::string_field(body,"assignment_id")?,generation)?;
            let privacy = privacy(&tx, &work)?;
            if privacy != "public" && scope != PiInferenceScope::Local {
                return Ok(failure(
                    "disclosure_blocked",
                    "Protected Pi execution requires a local inference route",
                ));
            }
            let Some(computers) = self.native_computers.as_ref() else {
                return Ok(failure(
                    "computer_unavailable",
                    "Pi execution requires an accepted computer",
                ));
            };
            ensure!(
                computers.pi_available(&request.ghost_id, epoch, &privacy)?,
                "Pi computer grant unavailable"
            );
            let computer = computers
                .pi_computer(&request.ghost_id)
                .ok_or_else(|| anyhow!("Pi route unavailable"))?;
            ensure!(
                operation != "browser" || computers.pi_browser_available(&request.ghost_id),
                "Pi browser is not granted"
            );
            let assignment = apply::string_field(body, "assignment_id")?;
            let execution = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&json!([
                    "ghost-pi/1",
                    request.ghost_id,
                    work.id,
                    work.goal_revision,
                    assignment
                ]))?)
            );
            let binding: Option<(String,u64,u64,String,String,String,u64,u64)> = tx.query_row("SELECT execution_id,generation_task_id,authority_epoch,computer_id,privacy,state,created_ms,deadline_ms FROM lifetime_pi_executions WHERE work_id=?1", [&work.id],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional()?;
            let mut running = true;
            if let Some((prior, task, old_epoch, pinned, old_privacy, status, created, deadline)) =
                binding
            {
                super::work_context::execution_profile_binding(&tx,&work,assignment,&execution,false)?;
                ensure!(
                    prior == execution
                        && task == generation
                        && old_epoch == epoch
                        && pinned == computer
                        && old_privacy == privacy,
                    "Pi execution binding conflict"
                );
                let (paused,waiting):(u64,u64)=tx.query_row("SELECT paused_ms,COALESCE((SELECT MAX(?2-wait_started_ms) FROM lifetime_pi_effects WHERE execution_id=?1 AND state='waiting_owner'),0) FROM lifetime_pi_executions WHERE execution_id=?1",params![execution,crate::host::now_ms()],|r|Ok((r.get(0)?,r.get(1)?)))?;
                running = status == "running"
                    && crate::host::now_ms() <= created.saturating_add(deadline).saturating_add(paused).saturating_add(waiting);
            } else {
                if work.execution_id.is_some() {
                    return Ok(failure(
                        "legacy_execution_unreconciled",
                        "Work already owns an execution; no Pi duplicate was admitted",
                    ));
                }
                if let Some(response) = graph::check_admission(&tx, &work)? {
                    return Ok(response);
                }
                // Previous revision cancellation must be confirmed first.
                ensure!(
                    !db::works_for_goal(&tx, &work.goal_id)?
                        .iter()
                        .any(|w| w.id != work.id
                            && w.execution_id.is_some()
                            && w.cancellation == "requested"),
                    "Prior Work cancellation is unresolved"
                );
                super::conversation::persist_disclosure(&tx,&request.ghost_id,&request.conversation_id,&privacy)?;
                let skills = skill_refs(&tx, &work)?;
                let inputs = graph::native_artifact_inputs(&tx, &work)?.unwrap_or_default();
                super::work_context::execution_profile_binding(&tx,&work,assignment,&execution,true)?;
                tx.execute("INSERT INTO lifetime_pi_executions(work_id,execution_id,assignment_id,ghost_id,conversation_id,generation_task_id,authority_epoch,goal_revision,computer_id,privacy,skills_json,input_artifacts_json,created_ms,deadline_ms,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'running')",
                    params![work.id,execution,assignment,request.ghost_id,request.conversation_id,generation,epoch,work.goal_revision,computer,privacy,serde_json::to_string(&skills)?,serde_json::to_string(&inputs)?,crate::host::now_ms(),computers.pi_deadline(&request.ghost_id)?])?;
                work.execution_id = Some(execution.clone());
                work.state = "running".into();
                work.blocker = None;
                db::update_work(&tx, &work)?;
            }
            let prior: Option<(String,String,Option<String>)> = tx.query_row("SELECT input_digest,state,response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND task_id=?2 AND call_id=?3",params![execution,task_id,call],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((prior_digest,status,response))=&prior {
                ensure!(prior_digest==&digest,"Pi effect identity was reused with different input");
                if status=="unknown" {return Ok(serde_json::from_str(response.as_deref().ok_or_else(||anyhow!("Pi receipt missing"))?)?);}
                if status=="complete" {
                    if let Some(response)=response.as_deref() {let response:Response=serde_json::from_str(response)?;if response.data["receipt"]["state"]=="denied" {return Ok(response);}}
                }
                if status!="complete" && status!="waiting_owner" {return Ok(unknown(body,&execution));}
            } else {
                let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_effects WHERE execution_id=?1 AND state<>'complete')",[&execution],|r|r.get(0))?;
                if !running || unresolved {return Ok(unknown(body,&execution));}
            }
            let effective_arguments = if operation=="bash" {
                match command_recipes::resolve(&tx,&work,&body["arguments"]) {
                    Ok(arguments)=>arguments,
                    Err(error)=>{
                        let response=no_effect(body,&execution,&error.to_string());
                        if prior.is_none() {
                            tx.execute("INSERT INTO lifetime_pi_effects(execution_id,task_id,call_id,input_digest,operation,arguments_json,state,response_json) VALUES(?1,?2,?3,?4,?5,?6,'complete',?7)",params![execution,task_id,call,digest,operation,serde_json::to_string(arguments)?,serde_json::to_string(&response)?])?;
                            tx.commit()?;
                        }
                        return Ok(response);
                    },
                }
            } else {body["arguments"].clone()};
            if let Some((prior_digest, status, response)) = prior {
                ensure!(
                    prior_digest == digest,
                    "Pi effect identity was reused with different input"
                );
                if operation=="bash" && status=="complete" {command_recipes::check_binding(&tx,body,&execution,&effective_arguments)?;}
                if status == "complete" || status == "unknown" {
                    return Ok(serde_json::from_str(
                        &response.ok_or_else(|| anyhow!("Pi receipt missing"))?,
                    )?);
                }
                if status!="waiting_owner" {return Ok(unknown(body,&execution));}
                ensure!(browser_mutation,"Only a known browser approval may resume");
                tx.commit()?;
                (execution,privacy,computer,effective_arguments)
            } else {
            if let Err(error)=preflight_pi_arguments(operation,&body["arguments"],&privacy) {
                let response=no_effect(body,&execution,&error.to_string());
                tx.execute("INSERT INTO lifetime_pi_effects(execution_id,task_id,call_id,input_digest,operation,arguments_json,state,response_json) VALUES(?1,?2,?3,?4,?5,?6,'complete',?7)",params![execution,task_id,call,digest,operation,serde_json::to_string(arguments)?,serde_json::to_string(&response)?])?;
                tx.commit()?;return Ok(response);
            }
            if operation=="bash" {command_recipes::bind(&tx,body,&execution,&effective_arguments)?;}
            tx.execute("INSERT INTO lifetime_pi_effects(execution_id,task_id,call_id,input_digest,operation,arguments_json,state,wait_started_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![execution,task_id,call,digest,operation,serde_json::to_string(arguments)?,if browser_mutation {"waiting_owner"} else {"pending"},if browser_mutation {Some(crate::host::now_ms())} else {None}])?;
            tx.commit()?;
            (execution, privacy, computer, effective_arguments)
            }
        };
        let authorize = || -> Result<()> {
            let state = self.lock()?;
            ensure!(self.work_memory_effect_current(&state,request,scope)?.is_none(),"Work memory disclosure authorization changed");
            ensure!(
                self.check_pi_host_scope(&state, request, scope)?.is_none()
                    && pi_tools::guard(&state.journal.0, request, scope)?.is_none(),
                "Pi authority revoked"
            );
            let work = db::work(&state.journal.0, apply::string_field(body, "work_id")?)?
                .ok_or_else(|| anyhow!("Pi Work missing"))?;
            super::work_context::execution_profile_binding(&state.journal.0,&work,apply::string_field(body,"assignment_id")?,&execution,false)?;
            let now=crate::host::now_ms();
            let time_policy=execution_time_policy(&state.journal.0,&work,now)?.ok_or_else(||anyhow!("Pi execution time policy missing"))?;
            ensure!(time_policy.effect_authority_alive,"Pi execution deadline expired");
            super::pi_wait::assert_resumed(&state.journal.0,&work,apply::string_field(body,"assignment_id")?,apply::number_field(body,"generation_task_id")?)?;
            ensure!(
                work.execution_id.as_deref() == Some(&execution)
                    && work.cancellation == "none"
                    && work.state == "running"
                    && graph::current_result_scope(&state.journal.0, &work)?,
                "Pi Work no longer current"
            );
            if json_summary::requested(operation,&effective_arguments) {
                json_summary::contract(&state.journal.0,&work,apply::string_field(&effective_arguments,"path")?)
                    .map_err(|_|anyhow!("pi_no_effect:json_summary_contract_unconfirmed"))?;
            }
            if operation=="bash" && body["arguments"].get("command_ref").is_some() {
                ensure!(command_recipes::resolve(&state.journal.0,&work,&body["arguments"])?==effective_arguments,"Command recipe authority changed");
                command_recipes::check_binding(&state.journal.0,body,&execution,&effective_arguments)?;
            }
            ensure!(
                self.native_computers
                    .as_ref()
                    .ok_or_else(|| anyhow!("Pi computer missing"))?
                    .pi_current(
                        &request.ghost_id,
                        &execution,
                        &pinned_computer,
                        epoch,
                        &privacy
                    )?,
                "Pi computer grant revoked"
            );
            Ok(())
        };
        let outcome = async {
            let computers = self
                .native_computers
                .as_ref()
                .ok_or_else(|| anyhow!("Pi computer missing"))?;
            let mut environment =
                computers.pi_acquire(&request.ghost_id, &execution, epoch, &privacy)?;
            environment.producer_profile={let state=self.lock()?;let work=db::work(&state.journal.0,apply::string_field(body,"work_id")?)?.ok_or_else(||anyhow!("Pi Work missing"))?;super::work_context::producer_profile(&state.journal.0,&work)?};
            authorize()?;
            self.stage_pi_inputs(request, &environment, &execution, &authorize)?;
            if browser_mutation {
                match self.prepare_pi_browser_effect(request,scope,&execution,&authorize).await? {
                    Some(response)=>return Ok((json!({"pi_wait_response":response}),vec![])),
                    None=>{}
                }
            }

            let summary_contract=if json_summary::requested(operation,&effective_arguments) {
                let state=self.lock()?;
                let work=db::work(&state.journal.0,apply::string_field(body,"work_id")?)?.ok_or_else(||anyhow!("Pi Work missing"))?;
                Some(json_summary::contract(&state.journal.0,&work,apply::string_field(&effective_arguments,"path")?)
                    .map_err(|_|anyhow!("pi_no_effect:json_summary_contract_unconfirmed"))?)
            }else{None};
            self.execute_pi_operation(
                &environment,
                &execution,
                operation,
                &effective_arguments,
                &privacy,
                summary_contract.as_ref(),
                &authorize,
            )
            .await
        }
        .await;
        let mut stopped_browser = false;
        if operation == "browser" && outcome.as_ref().err().is_some_and(|error|!error.to_string().contains("pi_browser_owner_action_required")) {
            stopped_browser = self
                .native_computers
                .as_ref()
                .unwrap()
                .pi_browser_stop(&request.ghost_id, &execution)
                .await
                .is_ok();
        }
        let delivery_permitted = authorize().is_ok();
        let state = self.lock()?;
        let conn = &state.journal.0;
        let mut response = match outcome {
            Ok((data, _artifacts)) if data.get("pi_wait_response").is_some()=>serde_json::from_value(data["pi_wait_response"].clone())?,
            Ok((data, artifacts)) => {
                let invalid_summary=json_summary::requested(operation,&effective_arguments) && json_summary::invalid(&data);
                let parse_failed=data["parse"]["status"]=="invalid";
                let mut response = apply::success(
                    "Pi tool effect observed",
                    vec![execution.clone()],
                    json!({"receipt":receipt(body,&execution,"complete"),"output":data}),
                );
                response.artifacts = artifacts;
                if invalid_summary {
                    response.status=ResponseStatus::Error;
                    response.error_code=Some(if parse_failed {"json_parse_invalid"}else{"json_contract_invalid"}.into());
                    response.summary="Complete file read was observed; JSON structural self-inspection failed. No semantic verification or artifact acceptance is claimed".into();
                    response.retry_class=RetryClass::Never;
                    response.next_actions=vec!["correct_file_then_issue_fresh_json_inspection".into()];
                }
                response
            }
            Err(error) => {
                if let Some(reason)=error.to_string().strip_prefix("pi_no_effect:") {
                    no_effect(body,&execution,reason)
                } else if error.to_string().contains("pi_browser_owner_action_required") {
                    let mut response=failure("browser_action_approval_required","No browser mutation executed; the exact-action Pi approval bridge is not enabled");
                    response.data=json!({"receipt":receipt(body,&execution,"denied"),"host_effect_class":"no_effect"});
                    response
                } else {
                let mut response = unknown(body, &execution);
                let process =
                    if stopped_browser || error.to_string().contains("guest stop was confirmed") {
                        "stopped"
                    } else if error.to_string().contains("revoked before guest execution") {
                        "not_started"
                    } else {
                        "unknown"
                    };
                response
                    .data
                    .as_object_mut()
                    .unwrap()
                    .insert("process_state".into(), json!(process));
                response
                }
            }
        };
        let known_summary_read=json_summary::requested(operation,&effective_arguments)
            && response.data["receipt"]["state"]=="complete" && response.data["output"]["kind"]==json_summary::KIND;
        let receipt_state = if response.data["receipt"]["state"]=="waiting_owner" {"waiting_owner"} else if response.status == ResponseStatus::Success || response.data["receipt"]["state"]=="denied" || known_summary_read {
            "complete"
        } else {
            "unknown"
        };
        if response.data["receipt"]["state"]=="denied" {browser_approval::pause_finished(conn,&execution,body)?;}
        let recorded=conn.execute("UPDATE lifetime_pi_effects SET state=?1,response_json=?2 WHERE execution_id=?3 AND task_id=?4 AND call_id=?5 AND state=?6",
            params![receipt_state,serde_json::to_string(&response)?,execution,task_id,call,if receipt_state=="waiting_owner" || (browser_mutation && response.data["receipt"]["state"]=="denied") {"waiting_owner"} else {"pending"}])?;
        if recorded==0 {
            // A concurrent delivery may have consumed this wait. Never claim
            // no effect after another delivery reserved the raw action.
            let stored:Option<String>=conn.query_row("SELECT response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND task_id=?2 AND call_id=?3 AND state IN ('complete','unknown')",params![execution,task_id,call],|r|r.get(0)).optional()?.flatten();
            response=stored.map(|raw|serde_json::from_str(&raw)).transpose()?.unwrap_or_else(||unknown(body,&execution));
        }
        if receipt_state == "unknown" {
            conn.execute(
                "UPDATE lifetime_pi_executions SET state='unknown' WHERE execution_id=?1",
                [&execution],
            )?;
            if let Some(mut work) = db::work(conn, apply::string_field(body, "work_id")?)? {
                if work.cancellation == "none" {
                    work.state = "unknown".into();
                    db::update_work(conn, &work)?;
                }
            }
        }
        // Persist the witnessed effect even if authorization was revoked, but
        // never disclose its result after the current scope gate has closed.
        if !delivery_permitted {
            response=failure("authority_fenced","Pi effect was recorded, but current Work/computer authority no longer permits result delivery");
        }
        if let Some(denial) = self
            .check_pi_host_scope(&state, request, scope)?
            .or(pi_tools::guard(conn, request, scope)?)
        {
            response = denial;
        }
        Ok(response)
    }

    fn stage_pi_inputs(
        &self,
        request: &PiToolRequest,
        env: &PiEnvironment,
        execution: &str,
        authorize: &(dyn Fn() -> Result<()> + Send + Sync),
    ) -> Result<()> {
        let snapshots = {
            let state = self.lock()?;
            let raw: String = state.journal.0.query_row(
                "SELECT input_artifacts_json FROM lifetime_pi_executions WHERE execution_id=?1",
                [execution],
                |r| r.get(0),
            )?;
            let inputs: Vec<crate::lifetime_contract::WorkerArtifactInput> =
                serde_json::from_str(&raw)?;
            let mut snapshots = vec![];
            let work=db::work(&state.journal.0,apply::string_field(&request.envelope.body,"work_id")?)?.ok_or_else(||anyhow!("Pi task input Work missing"))?;
            let task_input=super::task_contracts::input_snapshot(&state.journal.0,&work)?;
            let evaluation_input=super::evaluation_inputs::input_snapshot(&state.journal.0,&work)?;
            ensure!(task_input.is_none() || evaluation_input.is_none(),"Pi task has conflicting immutable input sources");
            if let Some(input)=task_input.or(evaluation_input) {snapshots.push(input);}

            for input in inputs {
                let work = db::work(&state.journal.0, &input.work_id)?
                    .ok_or_else(|| anyhow!("Pi child missing"))?;
                ensure!(
                    work.execution_id.as_deref() == Some(input.execution_id.as_str())
                        && work.goal_revision == input.goal_revision
                        && graph::current_result_scope(&state.journal.0, &work)?,
                    "Pi child artifact input is stale"
                );
                let pi:bool=state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE execution_id=?1 AND work_id=?2)",params![input.execution_id,input.work_id],|r|r.get(0))?;
                let root = if pi {
                    self.root.join("pi-execution")
                } else {
                    self.native_computers
                        .as_ref()
                        .ok_or_else(|| anyhow!("Pi computer missing"))?
                        .socket_for_execution(
                            &state.journal.0,
                            &work.id,
                            &work.owner,
                            &input.execution_id,
                        )?
                        .and_then(Path::parent)
                        .ok_or_else(|| anyhow!("Original child artifact route unavailable"))?
                        .to_path_buf()
                };
                for artifact in input.artifacts {
                    ensure!(
                        artifact.producing_attempt == input.execution_id,
                        "Pi input producer mismatch"
                    );
                    let bytes = if pi {
                        crate::worker::journal::read_verified_pi_artifact(&self.root, &state.journal.0, &input.execution_id, &artifact.digest, Path::new(&artifact.locator))?
                    } else {
                        crate::worker::journal::read_verified_artifact(&root, &input.execution_id, &artifact.digest, Path::new(&artifact.locator))?
                    };
                    // Flat, deterministic relative name avoids mutable aliases
                    // and model-selected directories. Raw files remain data.
                    let name = format!(
                        "input-{}-{}",
                        format!("{:x}", Sha256::digest(input.work_id.as_bytes())),
                        artifact.digest
                    );
                    snapshots.push((name, bytes));
                }
            }
            snapshots
        };
        let workspace = ScopedWorkspace::for_task(&env.directory)?;
        let reader = NativeWorkspace::open(&env.directory).map_err(|e| anyhow!(e.code))?;
        for (name, bytes) in snapshots {
            // Preserve any existing input and reject task-side tampering rather
            // than rewriting evidence during a later tool call.
            match reader.read_artifact(&name) {
                Ok(existing) => {
                    ensure!(existing == bytes, "Pi child input changed after staging");
                    continue;
                }
                Err(error) if error.code == "tool_file_not_found" => {}
                Err(error) => return Err(anyhow!(error.code)),
            }
            authorize()?;
            workspace
                .create_input(&name, &bytes)
                .map_err(|e| anyhow!(e.code))?;
        }
        let _ = request;
        Ok(())
    }

    async fn execute_pi_operation(
        &self,
        env: &PiEnvironment,
        execution: &str,
        operation: &str,
        args: &Value,
        privacy: &str,
        summary_contract: Option<&json_summary::Contract>,
        authorize: &(dyn Fn() -> Result<()> + Send + Sync),
    ) -> Result<(Value, Vec<Artifact>)> {
        let workspace = ScopedWorkspace::for_task(&env.directory)?;
        let path = || apply::string_field(args, "path");
        match operation {
            "read" => {
                json_summary::arguments(args)?;
                let (content, digest) =
                    workspace.read_utf8(path()?).map_err(|e| anyhow!("pi_no_effect:{}",e.code))?;
                if json_summary::requested(operation,args) {
                    let contract=summary_contract.ok_or_else(||anyhow!("pi_no_effect:json_summary_contract_unconfirmed"))?;
                    return Ok((json_summary::summarize(&content,&digest,contract),vec![]));
                }
                let offset = args["offset"].as_u64().unwrap_or(1).saturating_sub(1) as usize;
                let limit = args["limit"].as_u64().unwrap_or(2000).min(2000) as usize;
                Ok((
                    json!({"content":content.lines().skip(offset).take(limit).collect::<Vec<_>>().join("\n"),"sha256":digest}),
                    vec![],
                ))
            }
            "write" | "edit" => {
                let mut source_digest = None;
                let content = if operation == "write" {
                    apply::exact_fields(args, &["path", "content"])?;
                    apply::string_field(args, "content")?.to_owned()
                } else {
                    apply::exact_fields(args, &["path", "edits"])?;
                    let (content, digest) =
                        workspace.read_utf8(path()?).map_err(|e| anyhow!("pi_no_effect:{}",e.code))?;
                    source_digest = Some(digest);
                    edited_content(&content, &args["edits"]).map_err(|e|anyhow!("pi_no_effect:{e}"))?
                };
                let intent = if let Some(digest) = source_digest {
                    plan_checked_edit(&workspace, path()?, &content, &digest).map_err(|e|anyhow!("pi_no_effect:{e}"))?
                } else {
                    workspace
                        .plan_write(path()?, &content)
                        .map_err(|e| anyhow!("pi_no_effect:{}",e.code))?
                };
                authorize()?;
                let digest = workspace
                    .write_from_intent(path()?, &content, &intent)
                    .map_err(|e| anyhow!(e.code))?;
                Ok((json!({"path":path()?,"sha256":digest}), vec![]))
            }
            "bash" => {
                apply::allowed_fields(args, &["command", "timeout"], &["command"])?;
                let timeout = args["timeout"]
                    .as_u64()
                    .unwrap_or(30)
                    .checked_mul(1000)
                    .ok_or_else(|| anyhow!("timeout invalid"))?;
                let backend = if let Some(profile)=env.producer_profile.as_ref() {
                    crate::computers::AppleContainerBackend::for_accepted_producer(&env.container_cli,&env.manifest,execution,profile,unsafe { libc::geteuid() },unsafe { libc::getegid() })?
                } else { crate::computers::AppleContainerBackend::for_task(
                    &env.container_cli,
                    &env.manifest,
                    execution,
                    crate::computers::PINNED_TASK_IMAGE,
                    unsafe { libc::geteuid() },
                    unsafe { libc::getegid() },
                )? };
                let result = backend
                    .execute(
                        "pi",
                        ComputerOperation::Shell {
                            command: apply::string_field(args, "command")?.into(),
                            timeout_ms: timeout,
                        },
                        authorize,
                    )
                    .await?;
                Ok((result, vec![]))
            }
            "publish_artifact" => {
                apply::exact_fields(args, &["path", "privacy"])?;
                ensure!(
                    args["privacy"].as_str() == Some(privacy),
                    "artifact privacy must match pinned execution privacy"
                );
                let bytes = NativeWorkspace::open(&env.directory)
                    .map_err(|e| anyhow!(e.code))?
                    .read_artifact(path()?)
                    .map_err(|e| anyhow!(e.code))?;
                authorize()?;
                let root = self.root.join("pi-execution");
                std::fs::create_dir_all(&root)?;
                let journal = crate::worker::journal::Journal::open(&root)?;
                let mut artifact = journal.write_artifact(execution, &bytes)?;
                artifact.privacy = privacy.into();
                Ok((json!({"artifact":artifact}), vec![artifact]))
            }
            "browser" => {
                use crate::adapters::computer::BrowserOperation;
                let name = apply::string_field(args, "operation")?;
                ensure!(matches!(name,"navigate"|"read"|"snapshot"|"screenshot"|"click"|"type"|"key"|"scroll"),"Pi browser operation invalid");
                let operation = match name {
                    "navigate" => {
                        apply::exact_fields(args, &["operation", "url"])?;
                        let url = apply::string_field(args, "url")?;
                        let private=self.native_computers.as_ref().is_some_and(|computers|computers.pi_browser_private(&env.ghost_id));
                        ensure!(if private {crate::computers::local_browser::url_is_bounded_http(url)} else {crate::computers::local_browser::url_host_is_publicly_routable(url)},"Pi scoped browser URL refused");
                        BrowserOperation::Navigate { url: url.into() }
                    }
                    "read" => {
                        apply::exact_fields(args, &["operation"])?;
                        BrowserOperation::Read
                    }
                    "snapshot" => {
                        apply::exact_fields(args, &["operation"])?;
                        BrowserOperation::Snapshot
                    }
                    "screenshot" => {
                        apply::exact_fields(args, &["operation"])?;
                        BrowserOperation::Screenshot
                    }
                    "click" => {
                        apply::exact_fields(args, &["operation", "ref", "snapshot_id"])?;
                        BrowserOperation::Click {
                            reference: apply::string_field(args, "ref")?.into(),
                            snapshot_id: apply::number_field(args, "snapshot_id")?,
                        }
                    }
                    "type" => {
                        apply::exact_fields(args, &["operation", "ref", "snapshot_id", "value"])?;
                        BrowserOperation::Type {
                            reference: apply::string_field(args, "ref")?.into(),
                            snapshot_id: apply::number_field(args, "snapshot_id")?,
                            text: apply::string_field(args, "value")?.into(),
                        }
                    }
                    "key" => {
                        apply::exact_fields(args, &["operation", "value", "ref", "snapshot_id"])?;
                        BrowserOperation::Key {
                            key: apply::string_field(args, "value")?.into(),
                        }
                    }
                    "scroll" => {
                        apply::exact_fields(args, &["operation", "value", "ref", "snapshot_id"])?;
                        BrowserOperation::Scroll {
                            delta_y: args["value"]
                                .as_f64()
                                .filter(|v| v.is_finite())
                                .ok_or_else(|| anyhow!("Pi scroll value invalid"))?,
                        }
                    }
                    _ => return Err(anyhow!("Pi browser operation invalid")),
                };
                if matches!(name,"key"|"scroll") {
                    let output=self.native_computers.as_ref().ok_or_else(||anyhow!("Pi browser unavailable"))?.pi_browser_gesture(&env.ghost_id,execution,args,authorize).await?;
                    return Ok((output,vec![]));
                }
                let result = self
                    .native_computers
                    .as_ref()
                    .ok_or_else(|| anyhow!("Pi browser unavailable"))?
                    .pi_browser_execute(&env.ghost_id, execution, operation, authorize)
                    .await?;
                Ok((result, vec![]))
            }
            _ => unreachable!(),
        }
    }

    fn complete_pi_execution(
        &self,
        request: &PiToolRequest,
        scope: PiInferenceScope,
    ) -> Result<Response> {
        let body = &request.envelope.body;
        apply::allowed_fields(body,&["method","assignment_id","work_id","task_id","summary","work_memory_context_revision"],&["method","assignment_id","work_id","task_id","summary"])?;
        let state = self.lock()?;
        if let Some(response) = self
            .check_pi_host_scope(&state, request, scope)?
            .or(pi_tools::guard(&state.journal.0, request, scope)?)
        {
            return Ok(response);
        }
        if let Some(response)=self.work_memory_effect_current(&state,request,scope)? {return Ok(response);}
        let conn = &state.journal.0;
        let work_id = apply::string_field(body, "work_id")?;
        let mut work = db::work(conn, work_id)?.ok_or_else(|| anyhow!("Pi Work missing"))?;
        ensure!(
            work.owner == request.ghost_id,
            "Pi completion owner mismatch"
        );
        let binding: (String,String,u64,u64,String)=conn.query_row("SELECT execution_id,assignment_id,generation_task_id,authority_epoch,state FROM lifetime_pi_executions WHERE work_id=?1 AND ghost_id=?2 AND conversation_id=?3",
            params![work_id,request.ghost_id,request.conversation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
        super::work_context::execution_profile_binding(conn,&work,&binding.1,&binding.0,false)?;
        ensure!(
            body["assignment_id"].as_str() == Some(&binding.1)
                && body["task_id"].as_u64() == Some(binding.2)
                && request.envelope.authority_epoch == binding.3,
            "Pi completion task binding mismatch"
        );
        let privacy=privacy(conn,&work)?;
        let computers=self.native_computers.as_ref().ok_or_else(||anyhow!("Pi completion computer unavailable"))?;
        let computer:String=conn.query_row("SELECT computer_id FROM lifetime_pi_executions WHERE execution_id=?1",[&binding.0],|r|r.get(0))?;
        ensure!(computers.pi_available(&request.ghost_id,binding.3,&privacy)? && (binding.4=="completed" || computers.pi_current(&request.ghost_id,&binding.0,&computer,binding.3,&privacy)?),"Pi completion computer grant revoked");
        if let Some(receipt)=super::work_context::completion(conn,request,None)? {return Ok(receipt);}
        super::pi_wait::resume(conn,&mut work,apply::string_field(body,"assignment_id")?,apply::number_field(body,"task_id")?)?;
        let unresolved:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_effects WHERE execution_id=?1 AND state<>'complete')",[&binding.0],|r|r.get(0))?;
        if unresolved || binding.4 == "unknown" {
            return Ok(failure(
                "effect_unknown",
                "Pi completion blocked by unresolved original effect",
            ));
        }
        ensure!(
            work.cancellation == "none" && graph::current_result_scope(conn, &work)?,
            "Pi completion scope no longer current"
        );
        let mut artifacts = vec![];
        let mut query=conn.prepare("SELECT response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='publish_artifact' AND state='complete'")?;
        for raw in query.query_map([&binding.0], |r| r.get::<_, String>(0))? {
            let response: Response = serde_json::from_str(&raw?)?;
            for artifact in response.artifacts {
                if !artifacts
                    .iter()
                    .any(|a: &Artifact| a.digest == artifact.digest)
                {
                    artifacts.push(artifact);
                }
            }
        }
        // Re-read and hash each published byte sequence independently before
        // projecting a completed producer result. Acceptance remains separate.
        for artifact in &artifacts {
            crate::worker::journal::read_verified_pi_artifact(
                &self.root,
                &state.journal.0,
                &binding.0,
                &artifact.digest,
                Path::new(&artifact.locator),
            )?;
        }
        // Inbox sequence belongs to an authenticated event stream. Scope that
        // stream to this immutable execution; each Ghost may complete many
        // Works in the same authority epoch without colliding at sequence 1.
        let producer=format!("pi-result:{}:{}",request.ghost_id,binding.0);
        let result_body = json!({"method":"work.result","execution_id":binding.0,"producer":producer,"sequence":1,
            "goal_revision":work.goal_revision,"state":"completed","artifacts":artifacts,"summary":apply::string_field(body,"summary")?});
        let result = Envelope {
            body: result_body.clone(),
            actor_ref:producer.clone(),
            payload_digest: canonical_digest(&result_body)?,
            command_id: format!("pi-result:{}", binding.0),
            ..request.envelope.clone()
        };
        let result = super::apply(conn, &result, &producer)?;
        if result.status != ResponseStatus::Success {
            return Ok(result);
        }
        conn.execute(
            "UPDATE lifetime_pi_executions SET state='completed' WHERE execution_id=?1",
            [&binding.0],
        )?;
        self.native_computers
            .as_ref()
            .ok_or_else(|| anyhow!("Pi computer missing"))?
            .pi_release(&request.ghost_id, &binding.0, binding.3)?;
        let verification = match self.verify_pi_work(conn, &request.envelope, work_id) {
            Ok(response) => serde_json::to_value(response)?,
            Err(error) => json!({"state":"pending_review","reason":error.to_string()}),
        };
        let response=apply::success(
            "Pi producer result completed; independent verification recorded separately",
            vec![work.id],
            json!({"assignment_id":binding.1,"work_id":work_id,"task_id":binding.2,"execution_id":binding.0,"result":result.data,"verification":verification}),
        );
        super::work_context::completion(conn,request,Some(&response))?;
        Ok(response)
    }

    /// A narrow deterministic verifier. Producer-supplied expectations alone
    /// confer no authority: expectations must have a committed Owner source.
    pub(crate) fn verify_pi_work(
        &self,
        conn: &Connection,
        source: &Envelope,
        work_id: &str,
    ) -> Result<Response> {
        let work =
            db::work(conn, work_id)?.ok_or_else(|| anyhow!("Pi verification Work missing"))?;
        let goal = db::goal(conn, &work.goal_id)?
            .ok_or_else(|| anyhow!("Pi verification Goal missing"))?;
        let execution = work
            .execution_id
            .as_deref()
            .ok_or_else(|| anyhow!("Pi verification execution missing"))?;
        let verifier = &goal.acceptance_spec["verifier"];
        ensure!(verifier["kind"]!="owner-task-verifier/1", "Independent Owner verifier runs through the asynchronous driver with fresh source authority; result remains pending review");
        ensure!(
            verifier["kind"] == "pi-artifact/1",
            "No supported deterministic verifier; independent review required"
        );
        ensure!(owner_expectations(conn,&work,verifier)?,"Verifier expectations have no exact committed Owner authority; independent review required");
        apply::allowed_fields(
            verifier,
            &[
                "kind",
                "artifact_path",
                "expected_sha256",
                "command",
                "expected_stdout",
                "completion_timeout_seconds",
            ],
            &["kind", "artifact_path", "expected_sha256"],
        )?;
        if let Some(timeout) = verifier.get("completion_timeout_seconds") {
            ensure!(verifier["command"].is_string() && timeout.as_u64().is_some_and(|value| (1..=180).contains(&value)),
                "Owner completion verifier requires a command and a timeout from 1 to 180 seconds");
        }
        let path = apply::string_field(verifier, "artifact_path")?;
        let expected = apply::string_field(verifier, "expected_sha256")?;
        ensure!(
            expected.len() == 64
                && expected
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "Owner expected digest must be SHA-256"
        );
        let unresolved:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_effects WHERE execution_id=?1 AND state<>'complete')",[execution],|r|r.get(0))?;
        ensure!(!unresolved, "Original Pi effects are unresolved");
        let mut query=conn.prepare("SELECT arguments_json,response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='publish_artifact' AND state='complete'")?;
        let mut publication = None;
        for row in query.query_map([execution], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (args, response) = row?;
            let args: Value = serde_json::from_str(&args)?;
            let response: Response = serde_json::from_str(&response)?;
            if args["path"] == path && response.status == ResponseStatus::Success {
                for artifact in response.artifacts {
                    if artifact.digest == expected {
                        ensure!(
                            publication.is_none(),
                            "Owner artifact expectation matched multiple publications"
                        );
                        publication = Some(artifact);
                    }
                }
            }
        }
        let artifact = publication.ok_or_else(|| {
            anyhow!(
                "Published artifact does not match the Owner's expected path and content digest"
            )
        })?;
        let bytes = crate::worker::journal::read_verified_pi_artifact(
            &self.root,
            conn,
            execution,
            &artifact.digest,
            Path::new(&artifact.locator),
        )?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == expected,
            "Independent artifact content check failed"
        );
        let mut checks=vec![crate::lifetime_contract::Check {id:"artifact_sha256".into(),passed:true,evidence:format!("Verified immutable {} bytes with SHA-256 {} for execution {}",bytes.len(),artifact.digest,execution)},
            crate::lifetime_contract::Check {id:"artifact_content".into(),passed:true,evidence:format!("Published path {path} matches the committed Owner expected content digest {expected}")}];
        if let Some(command) = verifier.get("command") {
            let command = command
                .as_str()
                .ok_or_else(|| anyhow!("Owner verifier command must be a string"))?;
            let mut matched = None;
            let mut query=conn.prepare("SELECT task_id,call_id,arguments_json,response_json,input_digest FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='bash' AND state='complete' ORDER BY task_id,call_id")?;
            for row in query.query_map([execution], |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })? {
                let (task, call, args, response, input_digest) = row?;
                let args: Value = serde_json::from_str(&args)?;
                let response: Response = serde_json::from_str(&response)?;
                if command_recipes::receipt_command(conn,execution,task,&call,&input_digest,&args)?.as_deref() == Some(command)
                    && response.status == ResponseStatus::Success
                    && response.data["output"]["exit_code"] == 0
                    && response.data["output"]["success"] == true
                {
                    if verifier.get("expected_stdout").is_some()
                        && response.data["output"]["stdout"] != verifier["expected_stdout"]
                    {
                        continue;
                    }
                    matched = Some((task, call));
                    break;
                }
            }
            let (task,call)=matched.ok_or_else(||anyhow!("No independently observed successful receipt matches the Owner's exact command/output expectation"))?;
            checks.push(crate::lifetime_contract::Check {
                id: "command_success".into(),
                passed: true,
                evidence: format!(
                    "Original Pi task {task} call {call} observed exact Owner command exit 0"
                ),
            });
            if verifier.get("expected_stdout").is_some() {
                checks.push(crate::lifetime_contract::Check {id:"command_stdout".into(),passed:true,evidence:format!("Original Pi task {task} call {call} stdout matches the committed Owner expectation")});
            }
        } else {
            ensure!(
                verifier.get("expected_stdout").is_none(),
                "stdout expectation requires exact Owner command"
            );
        }
        for required in goal.acceptance_spec["required_checks"]
            .as_array()
            .into_iter()
            .flatten()
        {
            ensure!(
                checks
                    .iter()
                    .any(|check| Some(check.id.as_str()) == required.as_str()),
                "Required check has no deterministic evaluator; independent review required"
            );
        }
        let (revision,policy):(String,u64)=conn.query_row("SELECT verifier_revision,policy_revision FROM lifetime_verification_policy WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let acceptance = crate::lifetime_contract::Acceptance {
            work_id: work.id,
            goal_revision: goal.revision,
            requirement_digest: goal.requirement_digest,
            artifact_digest: artifact.digest,
            verifier_revision: revision,
            policy_revision: policy,
            checks,
        };
        let body = json!({"method":"work.accept","acceptance":acceptance});
        let command = Envelope {
            command_id: format!("pi-independent-accept:{execution}"),
            actor_ref: "host-pi-verifier".into(),
            payload_digest: canonical_digest(&body)?,
            body,
            ..source.clone()
        };
        super::apply(conn, &command, "host-pi-verifier")
    }
}

pub(super) fn owner_goal_expectations(
    conn: &Connection,
    goal: &crate::lifetime_contract::Goal,
) -> Result<bool> {
    if super::task_contracts::authorizes_goal(conn,goal)? {return Ok(true);}
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_commands WHERE actor_ref='owner' AND json_extract(response,'$.status')='success' AND json_extract(response,'$.data.goal.id')=?1 AND json_extract(response,'$.data.goal.revision')=?2 AND json_extract(response,'$.data.goal.requirement_digest')=?3 AND json_extract(request,'$.body.method') IN ('goal.submit','goal.update','work.delegate'))",
        params![goal.id,goal.revision,goal.requirement_digest],|r|r.get(0))?)
}

fn owner_expectations(conn: &Connection, work: &Work, verifier: &Value) -> Result<bool> {
    let goal = db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Pi Goal missing"))?;
    if owner_goal_expectations(conn, &goal)? {
        return Ok(true);
    }
    let root: Option<String> = conn
        .query_row(
            "SELECT root_goal_id FROM lifetime_work_links WHERE child_work_id=?1 AND current=1",
            [&work.id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(root) = root else {
        return Ok(false);
    };
    let root = db::goal(conn, &root)?.ok_or_else(|| anyhow!("Pi root Goal missing"))?;
    if !owner_goal_expectations(conn, &root)? {
        return Ok(false);
    }
    if super::delegation_contracts::authorizes_child(conn,&root,&goal,work)? {return Ok(true);}
    let prompt_digest = format!("{:x}", Sha256::digest(goal.prompt.as_bytes()));
    Ok(root.acceptance_spec["delegation_verifiers"]
        .as_array()
        .is_some_and(|grants| {
            grants.iter().any(|grant| {
                grant["target_ghost_id"] == work.owner
                    && grant["prompt_digest"] == prompt_digest
                    && grant["verifier"] == *verifier
            })
        }))
}

#[path="pi_execution/browser_approval.rs"]
mod browser_approval;

#[cfg(test)]
#[path="pi_execution/cross_ghost_tests.rs"]
mod cross_ghost_tests;
