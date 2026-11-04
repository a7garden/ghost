//! Behavior regressions for the canonical lifetime document ingress:
//! authority fencing, immutable Owner turns, live source admission, CAS,
//! replay stability, foreign-pair refusal, and Owner save re-proof.
use super::*;
use crate::adapters::documents::{self, Space};
use crate::domain::Review;
use crate::lifetime_contract::{canonical_digest, Envelope, Response, ResponseStatus, VERSION};
use rusqlite::params;
use std::path::Path;

/// Proven-valid frozen `pdc-document/1` Djot fixture (legacy, readable, carries an id).
const LEGACY_DJOT: &str = "---\nformat: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: Minimal\n---\n# Minimal\n";
const LEGACY_DJOT_ID: &str = "018f47c6-4a77-7c52-9db8-0e5f9bcb17db";

struct TestHost {
    root: tempfile::TempDir,
    _notes: tempfile::TempDir,
    app: Arc<Host>,
    ghost: String,
    conversation: String,
    turn: String,
    space: String,
}

fn seed_pair(s: &State, ghost: &str, conversation: &str, turn: &str, kind: &str) {
    s.journal.0.execute(
        "INSERT INTO lifetime_registry(ghost_id,kind,conversation_id,roles,mode) VALUES(?1,?2,?3,'[]','active')",
        params![ghost, kind, conversation],
    ).unwrap();
    s.journal.0.execute(
        "INSERT INTO lifetime_bindings(conversation_id,ghost_id,runtime_kind,runtime_release,storage_ref) VALUES(?1,?2,'pi-durable','test','test')",
        params![conversation, ghost],
    ).unwrap();
    s.journal.0.execute(
        "INSERT INTO lifetime_turns(id,ghost_id,conversation_id,sequence,sender_kind,sender_ref,text,privacy,kind,source_turn_id,attachments,created_at_ms)
         VALUES(?1,?2,?3,1,'owner','owner','make a page','private','user',NULL,'[]',1)",
        params![turn, ghost, conversation],
    ).unwrap();
    s.journal.0.execute(
        "INSERT INTO lifetime_turn_runs(turn_id,ghost_id,conversation_id,state,cancel_requested,created_at_ms,updated_at_ms)
         VALUES(?1,?2,?3,'queued',0,1,1)",
        params![turn, ghost, conversation],
    ).unwrap();
}

fn seed_space(app: &Host, ghost: &str, path: &Path, writable: bool) -> String {
    let space = Space {
        id: uuid::Uuid::now_v7().to_string(),
        name: "Notes".into(),
        path: path.into(),
        writable,
        profiles: vec![ghost.to_string()],
    };
    if writable {
        documents::initialize(&space).unwrap();
    } else {
        std::fs::create_dir_all(path).unwrap();
    }
    app.lock().unwrap().journal.put("space", &space.id, &space).unwrap();
    space.id
}

fn setup(writable: bool) -> TestHost {
    let root = tempfile::tempdir().unwrap();
    let notes = tempfile::tempdir().unwrap();
    let store = ProfileStore::create_profile(root.path(), "primary", "Primary Ghost").unwrap();
    let p = Host::profile(store).unwrap();
    let ghost = p.id.clone();
    let journal = Journal::open(&root.path().join("workspace.db")).unwrap();
    let app = Arc::new(Host {
        root: root.path().into(),
        state: Mutex::new(State {
            profiles: BTreeMap::from([(ghost.clone(), p)]),
            journal,
        }),
        handle: tokio::runtime::Handle::current(),
        default_model: "mock".into(),
        _lock: super::WorkspaceLock(File::create(root.path().join("test.lock")).unwrap()),
        brain: memory::Brain::default(),
        computer: computer::default_backend(),
        integrations: integrations::Connections::default(),
        workers: Mutex::new(Vec::new()),
        profile_workers: Mutex::new(BTreeMap::new()),
        recovery: tokio::sync::Mutex::new(()),
        stopping: AtomicBool::new(false),
        #[cfg(test)]
        legacy_fixture_reasoning: AtomicBool::new(false),
        dispatch_enabled: true,
        pi_callback_token: String::new(),
        pi_local_route: Some(lifetime_runtime::LocalPiRoute {
            base_url: "http://127.0.0.1:9/v1".into(),
            model_id: "test-model".into(),
            max_output_tokens: 1024,
            callback_token: "test-token".into(),
        }),
        native_computers: None,
        authority_epoch: 1,
    });
    let conversation = uuid::Uuid::now_v7().to_string();
    let turn = uuid::Uuid::now_v7().to_string();
    seed_pair(&app.lock().unwrap(), &ghost, &conversation, &turn, "primary");
    let space = seed_space(&app, &ghost, notes.path(), writable);
    TestHost { root, _notes: notes, app, ghost, conversation, turn, space }
}

fn envelope(t: &TestHost, command: &str, method: &str, args: serde_json::Value) -> lifetime::PiToolRequest {
    let mut body = args;
    let object = body.as_object_mut().unwrap();
    object.insert("method".into(), json!(method));
    object.insert("ghost_id".into(), json!(t.ghost));
    object.insert("conversation_id".into(), json!(t.conversation));
    object.insert("turn_id".into(), json!(t.turn));
    lifetime::PiToolRequest {
        context_ref: None, ghost_id: t.ghost.clone(),
        conversation_id: t.conversation.clone(),
        envelope: Envelope {
            protocol_version: VERSION.into(),
            command_id: command.into(),
            payload_digest: canonical_digest(&body).unwrap(),
            actor_ref: t.ghost.clone(),
            authority_epoch: 1,
            expected_revision: None,
            correlation_id: uuid::Uuid::now_v7().to_string(),
            body,
        },
    }
}

fn call(app: &Host, request: &lifetime::PiToolRequest) -> Response {
    app.lifetime_documents_action(request, lifetime::PiInferenceScope::Local).unwrap()
}

fn propose(t: &TestHost, command: &str, title: &str, body: &str) -> Response {
    let request = envelope(t, command, "documents.review_page",
        json!({"space_id": t.space, "title": title, "body": body}));
    call(&t.app, &request)
}

fn stored_review(t: &TestHost, id: &str) -> Review {
    t.app.lock().unwrap().journal.get::<Review>("review", id).unwrap().unwrap()
}

fn journal_space(t: &TestHost) -> Space {
    t.app.lock().unwrap().journal.get::<Space>("space", &t.space).unwrap().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capabilities_reflect_current_grants_and_local_route() {
    let t = setup(true);
    let response = call(&t.app, &envelope(&t, "cap-1", "documents.capabilities", json!({})));
    assert_eq!(response.status, ResponseStatus::Success);
    assert_eq!(response.data["available_tools"],
        json!(["list_spaces", "list_pages", "read_page", "review_page", "inspect_review"]));

    // Public/hosted inference never receives document tools.
    let public = envelope(&t, "cap-2", "documents.capabilities", json!({}));
    let response = t.app.lifetime_documents_action(&public, lifetime::PiInferenceScope::Public).unwrap();
    assert_eq!(response.error_code.as_deref(), Some("disclosure_blocked"));

    // A read-only-only grant exposes no writable or inspect tools.
    let t2 = setup(false);
    let response = call(&t2.app, &envelope(&t2, "cap-3", "documents.capabilities", json!({})));
    assert_eq!(response.data["available_tools"],
        json!(["list_spaces", "list_pages", "read_page"]));

    // Unauthenticated scope never reaches grant inspection.
    let mut stranger = envelope(&t, "cap-4", "documents.capabilities", json!({}));
    stranger.ghost_id = "stranger".into();
    stranger.envelope.actor_ref = "stranger".into();
    stranger.envelope.body["ghost_id"] = json!("stranger");
    stranger.envelope.payload_digest = canonical_digest(&stranger.envelope.body).unwrap();
    let response = call(&t.app, &stranger);
    assert_eq!(response.error_code.as_deref(), Some("unauthorized"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proposal_is_pending_durable_replay_stable_and_collision_denied() {
    let t = setup(true);
    let request = envelope(&t, "cmd-1", "documents.review_page",
        json!({"space_id": t.space, "title": "Owner page", "body": "Approved content"}));
    let response = call(&t.app, &request);
    assert_eq!(response.status, ResponseStatus::Success, "{}", response.summary);
    assert_eq!(response.data["state"], json!("pending"));
    let review_id = response.data["review_id"].as_str().unwrap().to_owned();
    assert!(response.data["planned_hash"].as_str().is_some());

    // Durable admission with real provenance and no legacy Task.
    let stored = stored_review(&t, &review_id);
    assert_eq!(stored.state, "pending");
    assert!(stored.task_id.is_empty());
    assert_eq!(stored.profile_id, t.ghost);
    assert_eq!(stored.conversation_id, t.conversation);
    let origin = stored.lifetime_origin.as_ref().unwrap();
    assert_eq!(origin.turn_id, t.turn);
    assert_eq!(origin.authority_epoch, 1);
    assert_eq!(origin.request_digest, request.envelope.payload_digest);

    // No document exists before Owner approval.
    assert!(documents::list(&journal_space(&t), "").unwrap().is_empty());

    // Exact replay reconstructs the same pending proposal.
    let replay = call(&t.app, &request);
    assert_eq!(replay.data["review_id"], json!(review_id.clone()));
    assert_eq!(replay.data["state"], json!("pending"));
    assert_eq!(t.app.lock().unwrap().journal.objects::<Review>("review").unwrap().len(), 1);

    // Same command identity with a changed body can never mutate the proposal.
    let collision = envelope(&t, "cmd-1", "documents.review_page",
        json!({"space_id": t.space, "title": "Different", "body": "Approved content"}));
    let denied = call(&t.app, &collision);
    assert_eq!(denied.error_code.as_deref(), Some("conflict"));
    assert_eq!(stored_review(&t, &review_id).title, "Owner page");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proposals_require_live_uncancelled_source_turn() {
    let t = setup(true);
    t.app.lock().unwrap().journal.0.execute(
        "UPDATE lifetime_turn_runs SET state='answered' WHERE turn_id=?1", params![t.turn]).unwrap();
    let settled = propose(&t, "cmd-2", "Too late", "content");
    assert_eq!(settled.error_code.as_deref(), Some("unauthorized"));
    assert!(settled.summary.contains("no longer permits new document proposals"));

    t.app.lock().unwrap().journal.0.execute(
        "UPDATE lifetime_turn_runs SET state='queued', cancel_requested=1, cancel_command_id='cancel-1' WHERE turn_id=?1",
        params![t.turn]).unwrap();
    let cancelled = propose(&t, "cmd-3", "Cancelled", "content");
    assert_eq!(cancelled.error_code.as_deref(), Some("unauthorized"));
    assert_eq!(t.app.lock().unwrap().journal.objects::<Review>("review").unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edits_require_current_hash_and_refuse_legacy_targets() {
    let t = setup(true);
    let space = journal_space(&t);
    let page = documents::create(&space, &uuid::Uuid::now_v7().to_string(),
        "Doc", "original body", "pdc-markdown/1", &documents::timestamp().unwrap()).unwrap();
    let page_id = page.id.clone().unwrap();

    // Stale CAS hash is refused before any admission.
    let stale = call(&t.app, &envelope(&t, "edit-1", "documents.review_page", json!(
        {"space_id": t.space, "page_id": page_id.clone(), "expected_hash": "deadbeef",
         "title": "Doc", "body": "next body"})));
    assert_eq!(stale.error_code.as_deref(), Some("conflict"));
    assert!(stale.summary.contains("external_change_conflict"));

    // Frozen legacy documents are never edited in place.
    std::fs::write(space.path.join("legacy.djot"), LEGACY_DJOT).unwrap();
    let legacy = documents::read(&space, LEGACY_DJOT_ID).unwrap();
    assert!(legacy.legacy);
    let refused = call(&t.app, &envelope(&t, "edit-2", "documents.review_page", json!(
        {"space_id": t.space, "page_id": LEGACY_DJOT_ID, "expected_hash": legacy.hash,
         "title": "Legacy", "body": "rewritten"})));
    assert_eq!(refused.error_code.as_deref(), Some("legacy_document_read_only"));

    // Current hash admits the edit proposal and records the expected hash.
    let accepted = call(&t.app, &envelope(&t, "edit-3", "documents.review_page", json!(
        {"space_id": t.space, "page_id": page_id.clone(), "expected_hash": page.hash.clone(),
         "title": "Doc", "body": "next body"})));
    assert_eq!(accepted.status, ResponseStatus::Success, "{}", accepted.summary);
    let stored = stored_review(&t, accepted.data["review_id"].as_str().unwrap());
    assert_eq!(stored.expected_hash.as_deref(), Some(page.hash.as_str()));
    assert_eq!(stored.page_id, page_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_are_source_safe_and_take_exactly_one_locator_or_id() {
    let t = setup(true);
    let space = journal_space(&t);
    let page = documents::create(&space, &uuid::Uuid::now_v7().to_string(),
        "Doc", "untrusted body", "pdc-markdown/1", &documents::timestamp().unwrap()).unwrap();

    let listed = call(&t.app, &envelope(&t, "read-1", "documents.list_pages",
        json!({"space_id": t.space})));
    let by_id = call(&t.app, &envelope(&t, "read-2", "documents.read_page",
        json!({"space_id": t.space, "page_id": page.id.clone()})));
    let by_locator = call(&t.app, &envelope(&t, "read-3", "documents.read_page",
        json!({"space_id": t.space, "locator": page.locator.clone()})));
    let ambiguous = call(&t.app, &envelope(&t, "read-4", "documents.read_page",
        json!({"space_id": t.space, "page_id": page.id.clone(), "locator": page.locator.clone()})));
    let missing = call(&t.app, &envelope(&t, "read-5", "documents.read_page",
        json!({"space_id": t.space})));
    let escape = t.app.lifetime_documents_action(
        &envelope(&t, "read-6", "documents.read_page",
            json!({"space_id": t.space, "locator": "../escape"})),
        lifetime::PiInferenceScope::Local);

    assert_eq!(listed.status, ResponseStatus::Success);
    let pages = listed.data["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 1);
    assert!(pages[0].get("source").is_none() && pages[0].get("body").is_none());
    assert_eq!(by_id.data["hash"], json!(page.hash.clone()));
    assert!(by_id.data["source"].as_str().is_some());
    assert!(by_id.data.get("preview").is_none() || by_id.data["preview"].is_null());
    assert_eq!(by_locator.data["hash"], json!(page.hash));
    assert_eq!(ambiguous.error_code.as_deref(), Some("invalid_request"));
    assert_eq!(missing.error_code.as_deref(), Some("invalid_request"));
    assert!(escape.is_err(), "path traversal must never resolve");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inspect_is_pair_scoped_and_non_mutating() {
    let t = setup(true);
    let proposal = propose(&t, "ins-1", "Pending draft", "draft body");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();

    let own = call(&t.app, &envelope(&t, "ins-2", "documents.review.inspect",
        json!({"review_id": review_id.clone()})));
    let unknown = call(&t.app, &envelope(&t, "ins-3", "documents.review.inspect",
        json!({"review_id": uuid::Uuid::now_v7().to_string()})));
    assert_eq!(own.status, ResponseStatus::Success);
    assert_eq!(own.data["state"], json!("pending"));
    assert_eq!(own.data["title"], json!("Pending draft"));
    assert_eq!(own.data["origin"]["turn_id"], json!(t.turn));
    assert_eq!(unknown.error_code.as_deref(), Some("not_found"));

    // A second registered pair can never see the first pair's proposal.
    let store = ProfileStore::create_profile(t.root.path(), "specialist", "Specialist").unwrap();
    let other = Host::profile(store).unwrap();
    let other_id = other.id.clone();
    let other_conversation = uuid::Uuid::now_v7().to_string();
    let other_turn = uuid::Uuid::now_v7().to_string();
    {
        let mut s = t.app.lock().unwrap();
        s.profiles.insert(other_id.clone(), other);
        seed_pair(&s, &other_id, &other_conversation, &other_turn, "specialist");
    }
    let mut foreign_request = envelope(&t, "ins-4", "documents.review.inspect",
        json!({"review_id": review_id}));
    foreign_request.ghost_id = other_id.clone();
    foreign_request.conversation_id = other_conversation.clone();
    foreign_request.envelope.actor_ref = other_id.clone();
    foreign_request.envelope.body["ghost_id"] = json!(other_id);
    foreign_request.envelope.body["conversation_id"] = other_conversation.clone().into();
    foreign_request.envelope.body["turn_id"] = other_turn.clone().into();
    foreign_request.envelope.payload_digest = canonical_digest(&foreign_request.envelope.body).unwrap();
    let foreign = call(&t.app, &foreign_request);
    assert_eq!(foreign.error_code.as_deref(), Some("not_found"));
    assert_eq!(stored_review(&t, &review_id).state, "pending");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_approval_saves_canonical_file_and_replay_reflects_saved() {
    let t = setup(true);
    let proposal = propose(&t, "own-1", "Owner page", "Approved content");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();
    let page_id = proposal.data["page_id"].as_str().unwrap().to_owned();

    let saved = actions::apply(&t.app, &mut t.app.lock().unwrap(), "owner-1",
        OwnerAction::DecideReview { review_id: review_id.clone(), approve: true }).unwrap();
    assert_eq!(saved["id"], json!(page_id.clone()));
    let page = documents::read(&journal_space(&t), &page_id).unwrap();
    assert_eq!(page.hash, proposal.data["planned_hash"].as_str().unwrap());
    assert!(!page.legacy);
    assert_eq!(stored_review(&t, &review_id).state, "saved");

    // Replay of the original proposal command reports the explicit saved state.
    let request = envelope(&t, "own-1", "documents.review_page",
        json!({"space_id": t.space, "title": "Owner page", "body": "Approved content"}));
    let replay = call(&t.app, &request);
    assert_eq!(replay.data["state"], json!("saved"));

    // Decline resolves without any file write.
    let second = propose(&t, "own-2", "Declined page", "draft");
    let second_id = second.data["review_id"].as_str().unwrap().to_owned();
    let second_page = second.data["page_id"].as_str().unwrap().to_owned();
    actions::apply(&t.app, &mut t.app.lock().unwrap(), "owner-2",
        OwnerAction::DecideReview { review_id: second_id.clone(), approve: false }).unwrap();
    assert_eq!(stored_review(&t, &second_id).state, "declined");
    assert!(documents::read(&journal_space(&t), &second_page).is_err());
    let snapshot = t.app.snapshot().unwrap();
    let reviews = snapshot["reviews"].as_array().unwrap();
    assert_eq!(reviews.iter().find(|review| review["id"] == review_id)
        .and_then(|review| review["state"].as_str()), Some("saved"));
    assert_eq!(reviews.iter().find(|review| review["id"] == second_id)
        .and_then(|review| review["state"].as_str()), Some("declined"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_save_refuses_revoked_grant() {
    let t = setup(true);
    let proposal = propose(&t, "rev-1", "Revoked", "content");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();
    let mut space = journal_space(&t);
    space.profiles.clear();
    t.app.lock().unwrap().journal.put("space", &t.space, &space).unwrap();
    let error = actions::apply(&t.app, &mut t.app.lock().unwrap(), "owner-1",
        OwnerAction::DecideReview { review_id, approve: true }).unwrap_err();
    assert!(error.to_string().contains("Space access was revoked"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_save_refuses_cancelled_source_turn() {
    let t = setup(true);
    let proposal = propose(&t, "can-1", "Cancelled", "content");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();
    t.app.lock().unwrap().journal.0.execute(
        "UPDATE lifetime_turn_runs SET cancel_requested=1, cancel_command_id='cancel-1' WHERE turn_id=?1",
        params![t.turn]).unwrap();
    let error = actions::apply(&t.app, &mut t.app.lock().unwrap(), "owner-1",
        OwnerAction::DecideReview { review_id, approve: true }).unwrap_err();
    assert!(error.to_string().contains("cancelled"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_save_refuses_stale_authority_epoch() {
    let t = setup(true);
    let proposal = propose(&t, "ep-1", "Epoch", "content");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();
    t.app.lock().unwrap().journal.0.execute(
        "UPDATE lifetime_authority SET authority_epoch=2 WHERE singleton=1", []).unwrap();
    let error = actions::apply(&t.app, &mut t.app.lock().unwrap(), "owner-1",
        OwnerAction::DecideReview { review_id, approve: true }).unwrap_err();
    assert!(error.to_string().contains("epoch"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_save_refuses_expired_proposal() {
    let t = setup(true);
    let proposal = propose(&t, "exp-1", "Expired", "content");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();
    {
        let s = t.app.lock().unwrap();
        let mut review: Review = s.journal.get("review", &review_id).unwrap().unwrap();
        review.expires_ms = now_ms().saturating_sub(1);
        s.journal.put("review", &review_id, &review).unwrap();
    }
    let error = actions::apply(&t.app, &mut t.app.lock().unwrap(), "owner-1",
        OwnerAction::DecideReview { review_id, approve: true }).unwrap_err();
    assert!(error.to_string().contains("expired"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_expires_lifetime_proposals_and_keeps_legacy_cancellation() {
    let t = setup(true);
    let proposal = propose(&t, "rec-1", "Patient draft", "content");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();

    // The proposal outlives its model turn: no task-phase cancellation.
    t.app.dispatch_due(&t.ghost, now_ms()).unwrap();
    assert_eq!(stored_review(&t, &review_id).state, "pending");

    // Expired lifetime proposals transition to expired at recovery.
    {
        let s = t.app.lock().unwrap();
        let mut review: Review = s.journal.get("review", &review_id).unwrap().unwrap();
        review.expires_ms = now_ms().saturating_sub(1);
        s.journal.put("review", &review_id, &review).unwrap();
    }
    t.app.dispatch_due(&t.ghost, now_ms()).unwrap();
    assert_eq!(stored_review(&t, &review_id).state, "expired");

    // Legacy task-bound reviews keep their cancellation semantics.
    let legacy = Review {
        id: "legacy-review".into(),
        profile_id: t.ghost.clone(),
        conversation_id: "legacy-conversation".into(),
        task_id: "missing-task".into(),
        space_id: t.space.clone(),
        page_id: uuid::Uuid::now_v7().to_string(),
        title: "Legacy".into(),
        body: "legacy".into(),
        profile: "pdc-markdown/1".into(),
        expected_hash: None,
        created: documents::timestamp().unwrap(),
        expires_ms: now_ms() + 86_400_000,
        state: "pending".into(),
        result: None,
        lifetime_origin: None,
    };
    t.app.lock().unwrap().journal.put("review", &legacy.id, &legacy).unwrap();
    t.app.dispatch_due(&t.ghost, now_ms()).unwrap();
    assert_eq!(stored_review(&t, "legacy-review").state, "cancelled");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_proposal_survives_cold_reopen_and_stays_owner_decidable() {
    let t = setup(true);
    let proposal = propose(&t, "cold-1", "Cold page", "Approved content");
    let review_id = proposal.data["review_id"].as_str().unwrap().to_owned();
    let page_id = proposal.data["page_id"].as_str().unwrap().to_owned();
    let root = t.root.path().to_path_buf();
    drop(t.app);

    let reopened = Host::open_legacy_fixture(&root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let review: Review = reopened.lock().unwrap().journal.get("review", &review_id).unwrap().unwrap();
    assert_eq!(review.state, "pending");
    assert_eq!(review.lifetime_origin.as_ref().unwrap().authority_epoch, 1);
    let saved = actions::apply(&reopened, &mut reopened.lock().unwrap(), "owner-1",
        OwnerAction::DecideReview { review_id, approve: true }).unwrap();
    assert_eq!(saved["id"], json!(page_id.clone()));
    let space: Space = reopened.lock().unwrap().journal.get("space", &review.space_id).unwrap().unwrap();
    assert_eq!(documents::read(&space, &page_id).unwrap().hash, proposal.data["planned_hash"].as_str().unwrap());
    reopened.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_space_grant_withholds_an_earlier_same_pair_draft() {
    let t = setup(true);
    let proposal = propose(&t, "revoke-inspect-proposal", "Private draft", "No access after revocation");
    let review_id = proposal.data["review_id"].as_str().unwrap();
    actions::apply(&t.app, &mut t.app.lock().unwrap(), "revoke-inspect-grant",
        OwnerAction::SpaceAccess {
            space_id: t.space.clone(),
            writable: true,
            profiles: vec![],
        }).unwrap();
    let response = call(&t.app, &envelope(&t, "revoked-inspect", "documents.review.inspect",
        json!({"review_id": review_id})));
    assert_eq!(response.error_code.as_deref(), Some("unauthorized"));
    assert_eq!(response.data, Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integration_approval_fixture_executes_exactly_once_and_fails_closed() {
    let t = setup(true);
    let effects = t.root.path().join("fixture-mail-effects.jsonl");
    let server = r#"
import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 method=r['method']
 if method=='initialize':
  out={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif method=='tools/list':
  schema={'type':'object','properties':{'to':{'type':'string'},'subject':{'type':'string'},'body':{'type':'string'}},'required':['to','subject','body'],'additionalProperties':False}
  out={'tools':[{'name':name,'inputSchema':schema} for name in ['send_email','disconnect']]}
 elif method=='tools/call':
  with open(sys.argv[1],'a') as f: print(json.dumps(r['params']),file=f)
  if r['params']['name']=='disconnect': sys.exit(0)
  out={'content':[{'type':'text','text':'fixture accepted'}],'isError':False}
 else: out={}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':out}),flush=True)
"#;
    let mut connection = json!({"name":"Fixture email","transport":{"kind":"stdio","command":"python3",
        "args":["-u","-c",server,effects],"env_refs":{},"cwd":null},"profiles":[t.ghost],"enabled":true});
    let mut create_id = uuid::Uuid::new_v4().to_string();
    let owner_action = |request_id: &str, value: Value| -> crate::control::api::Action {
        serde_json::from_value(json!({"request_id":request_id,"command":{"type":"workspace","action":value}})).unwrap()
    };
    let action = |value: Value| owner_action(&uuid::Uuid::new_v4().to_string(), value);
    let created = t.app.action_async(owner_action(&create_id,json!({"type":"save_integration","integration":connection}))).await.unwrap();
    assert_eq!(created["ok"], true, "{created}");
    let id = created["result"]["id"].as_str().unwrap();
    let catalog = t.app.action_async(action(json!({"type":"check_integration","id":id}))).await.unwrap();
    assert_eq!(catalog["result"]["tools"].as_array().unwrap().len(), 2, "{catalog}");
    connection["approved_tools"] = json!(["send_email","disconnect"]);
    let saved = t.app.action_async(action(json!({"type":"save_integration","id":id,"version":1,"integration":connection}))).await.unwrap();
    assert_eq!(saved["ok"], true, "{saved}");
    {
        let state = t.app.lock().unwrap();
        assert!(state.journal.get::<Value>("integration", id).unwrap().is_none(), "an older Host must not see the managed connection");
        assert!(state.journal.get::<Value>("integration_managed_v1", id).unwrap().is_some());
    }
    let inspect_turn = envelope(&t,"integration-turn","conversation.turn.inspect",json!({}));
    let inspected_turn = t.app.lifetime_pi_action(&inspect_turn,lifetime::PiInferenceScope::Local).await.unwrap();
    assert_eq!(inspected_turn["result"]["data"]["integration_approvals"], true, "{inspected_turn}");
    let list = envelope(&t,"integration-list","integrations.list",json!({}));
    let listed = t.app.lifetime_pi_action(&list,lifetime::PiInferenceScope::Local).await.unwrap();
    assert_eq!(listed["result"]["data"]["features"].as_array().unwrap().len(),2,"{listed}");
    let args = json!({"to":"owner@example.invalid","subject":"Fixture","body":"Synthetic message"});
    assert!(integrations::run(&t.app,id,Some(&t.ghost),Some(("send_email",args.clone())),||Ok(())).await.is_err());
    let proposal = |cmd: &str, tool: &str, arguments: &Value| envelope(&t,cmd,"integrations.propose",
        json!({"integration_id":id,"tool":tool,"arguments":arguments}));
    let request = proposal("mail-proposal","send_email",&args);
    let first = t.app.lifetime_pi_action(&request,lifetime::PiInferenceScope::Local).await.unwrap();
    assert_eq!(first["result"]["data"]["state"],"pending","{first}");
    assert!(!effects.exists());
    let review = first["result"]["data"]["id"].as_str().unwrap();
    let replay = t.app.lifetime_pi_action(&request,lifetime::PiInferenceScope::Local).await.unwrap();
    assert_eq!(replay["result"]["data"], first["result"]["data"]);
    let bad = t.app.lifetime_pi_action(&proposal("bad","send_email",&json!({"to":3})),lifetime::PiInferenceScope::Local).await.unwrap();
    assert_eq!(bad["result"]["error_code"],"integration_proposal_denied","{bad}");
    let summaries = t.app.snapshot().unwrap()["integration_approvals"].clone();
    assert_eq!(summaries.as_array().unwrap().len(),1);
    assert!(summaries[0].get("arguments").is_none());
    let inspected = t.app.action_async(action(json!({"type":"inspect_integration_approval","id":review}))).await.unwrap();
    assert_eq!(inspected["result"]["arguments"],args);
    assert_eq!(inspected["result"]["approval_allowed"], true);
    let decision = json!({"type":"decide_integration_approval","id":review,"approve":true});
    create_id = uuid::Uuid::new_v4().to_string();
    let (sent, competing) = tokio::join!(
        t.app.action_async(owner_action(&create_id,decision.clone())),
        t.app.action_async(action(decision.clone())),
    );
    let sent = sent.unwrap();
    assert_eq!(sent["result"]["state"],"sent","{sent}");
    assert_eq!(competing.unwrap()["ok"], false);
    assert!(integrations::allowed(&*t.app.lock().unwrap(),id,Some(&t.ghost)).unwrap().error.is_none());
    assert_eq!(t.app.action_async(owner_action(&create_id,decision.clone())).await.unwrap(),sent);
    assert_eq!(t.app.action_async(action(decision)).await.unwrap()["ok"],false);
    let completed = t.app.action_async(action(json!({"type":"inspect_integration_approval","id":review}))).await.unwrap();
    assert_eq!(completed["result"]["result"]["text"], "fixture accepted");
    assert!(t.app.snapshot().unwrap()["integration_approvals"][0].get("result").is_none());
    let lines = std::fs::read_to_string(&effects).unwrap();
    assert_eq!(lines.lines().count(),1);
    assert_eq!(serde_json::from_str::<Value>(lines.trim()).unwrap(),json!({"name":"send_email","arguments":args}));
    let revoked = t.app.lifetime_pi_action(&proposal("revoked","send_email",&args),lifetime::PiInferenceScope::Local).await.unwrap();
    let revoked_id = revoked["result"]["data"]["id"].as_str().unwrap();
    connection["approved_tools"] = json!(["disconnect"]);
    let update = t.app.action_async(action(json!({"type":"save_integration","id":id,"version":2,"integration":connection}))).await.unwrap();
    assert_eq!(update["ok"], true, "{update}");
    let stale = t.app.action_async(action(json!({"type":"inspect_integration_approval","id":revoked_id}))).await.unwrap();
    assert_eq!(stale["result"]["approval_allowed"], false);
    assert_eq!(t.app.action_async(action(json!({"type":"decide_integration_approval","id":revoked_id,"approve":true}))).await.unwrap()["ok"],false);
    assert_eq!(std::fs::read_to_string(&effects).unwrap().lines().count(),1);
    assert_eq!(t.app.action_async(action(json!({"type":"decide_integration_approval","id":revoked_id,"approve":false}))).await.unwrap()["result"]["state"],"declined");
    let lost = t.app.lifetime_pi_action(&proposal("lost","disconnect",&args),lifetime::PiInferenceScope::Local).await.unwrap();
    let lost_id = lost["result"]["data"]["id"].as_str().unwrap();
    let lost_decision = json!({"type":"decide_integration_approval","id":lost_id,"approve":true});
    let receipt = t.app.action_async(action(lost_decision.clone())).await.unwrap();
    assert_eq!(receipt["result"]["state"],"uncertain","{receipt}");
    assert_eq!(t.app.action_async(action(lost_decision)).await.unwrap()["ok"],false);
    assert_eq!(std::fs::read_to_string(&effects).unwrap().lines().count(),2);
}
