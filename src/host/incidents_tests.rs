//! Behavior regressions for the Owner-configured incident intake binding:
//! stable identity with duplicate/revision dedup, same-identity/different-
//! content collision fail-close, authority-epoch fencing of recovered claims,
//! exact sealed-payload crash replay (and its binding/route/operations drift
//! fences plus integrity refusal), stale/unreadable/invalid snapshots as
//! observation incidents (never health), and the information disclosure
//! boundaries. These tests seed the real lifetime registry and drive the real
//! `goal.submit` admission; no broker environment is touched.
use super::*;
use crate::control::api::OwnerAction;
use rusqlite::params;
use sha2::Digest;
use std::path::Path;

struct TestHost {
    _root: tempfile::TempDir,
    alerts_dir: tempfile::TempDir,
    app: Arc<Host>,
    ghost: String,
    conversation: String,
    ops_ghost: String,
    ops_conversation: String,
}

fn alerts_path(t: &TestHost) -> std::path::PathBuf {
    t.alerts_dir.path().join("infra-alerts.json")
}

fn write_alerts(path: &Path, updated_secs_ago: u64, alerts: Value) {
    let updated = (super::now_ms() / 1000).saturating_sub(updated_secs_ago) as f64;
    std::fs::write(
        path,
        serde_json::to_vec(&json!({"updated": updated, "alerts": alerts})).unwrap(),
    )
    .unwrap();
}

fn alert(id: &str, severity: &str, summary: &str) -> Value {
    json!({"id": id, "severity": severity, "summary": summary, "since": "3시간째"})
}

fn binding_input(source: &Path) -> incidents::IncidentInput {
    incidents::IncidentInput {
        source_path: source.to_str().unwrap().to_owned(),
        severities: vec!["crit".into(), "warn".into()],
        sources: vec![
            "gatus:".into(),
            "beszel:".into(),
            "backup:".into(),
            "git:".into(),
        ],
        disclosure: "summary_only".into(),
        max_age_seconds: Some(180),
        paused: false,
    }
}

fn setup() -> TestHost {
    let root = tempfile::tempdir().unwrap();
    let alerts_dir = tempfile::tempdir().unwrap();
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
        pi_local_route: None,
        native_computers: None,
        authority_epoch: 1,
    });
    TestHost {
        _root: root,
        alerts_dir,
        app,
        ops_ghost: "specialist-operations-fixture".into(),
        ops_conversation: uuid::Uuid::now_v7().to_string(),
        ghost,
        conversation: uuid::Uuid::now_v7().to_string(),
    }
}

impl TestHost {
    fn seed_registry(&self) {
        let s = self.app.lock().unwrap();
        s.journal
            .0
            .execute(
                "INSERT OR IGNORE INTO lifetime_registry(ghost_id,kind,conversation_id,roles,mode) VALUES(?1,'primary',?2,'[\"coordination\"]','active')",
                params![self.ghost, self.conversation],
            )
            .unwrap();
        s.journal
            .0
            .execute(
                "INSERT OR IGNORE INTO lifetime_registry(ghost_id,kind,conversation_id,roles,mode) VALUES(?1,'specialist',?2,'[\"operations\"]','active')",
                params![self.ops_ghost, self.ops_conversation],
            )
            .unwrap();
    }

    fn action(&self, action: OwnerAction) -> Value {
        self.app
            .action(Action {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::Workspace { action },
            })
            .unwrap()
    }

    fn save_binding(&self, input: incidents::IncidentInput, version: Option<u64>) -> Value {
        let reply = self.action(OwnerAction::SaveIncidentBinding {
            profile_id: self.ghost.clone(),
            binding: input,
            version,
        });
        assert_eq!(reply["ok"], true, "{reply}");
        reply["result"].clone()
    }

    fn fire(&self, now: u64) {
        incidents::fire_due_gated(&*self.app.lock().unwrap(), &self.ghost, now, true).unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        self.app
            .lock()
            .unwrap()
            .journal
            .0
            .query_row(sql, [], |r| r.get::<_, i64>(0))
            .unwrap()
    }

    fn goals(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM lifetime_goals")
    }

    fn incident_commands(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM lifetime_commands WHERE command_id LIKE 'infra:%'")
    }

    /// (prompt, privacy, acceptance_spec) per admitted incident goal.
    fn goal_payloads(&self) -> Vec<(String, String, Value)> {
        let s = self.app.lock().unwrap();
        let mut statement = s
            .journal
            .0
            .prepare("SELECT payload FROM lifetime_goals ORDER BY rowid")
            .unwrap();
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        rows.into_iter()
            .map(|payload| {
                let value: Value = serde_json::from_str(&payload).unwrap();
                (
                    value["prompt"].as_str().unwrap().to_owned(),
                    value["privacy"].as_str().unwrap().to_owned(),
                    value["acceptance_spec"].clone(),
                )
            })
            .collect()
    }

    fn runs(&self) -> Vec<incidents::IncidentRun> {
        self.app
            .lock()
            .unwrap()
            .journal
            .objects::<incidents::IncidentRun>(incidents::RUN_KIND)
            .unwrap()
    }

    /// Reset a settled run to its claimed state: a crash between the claim
    /// commit and settlement, with the lifetime ledger left untouched.
    fn reclaim(&self, run_id: &str) {
        let s = self.app.lock().unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, run_id).unwrap().unwrap();
        run.status = "claimed".into();
        run.goal_id = None;
        s.journal.put(incidents::RUN_KIND, run_id, &run).unwrap();
    }
}

#[tokio::test]
async fn input_validation_bounds_source_scope_and_disclosure() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    std::fs::write(&source, "{}").unwrap();

    let invalid = incidents::IncidentInput {
        severities: vec!["warn".into(), "fatal".into()],
        ..binding_input(&source)
    };
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: invalid,
        version: None,
    });
    assert_eq!(reply["ok"], false);

    let invalid = incidents::IncidentInput {
        sources: vec!["gatus: drop".into()],
        ..binding_input(&source)
    };
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: invalid,
        version: None,
    });
    assert_eq!(reply["ok"], false);

    let invalid = incidents::IncidentInput {
        source_path: "infra-alerts.json".into(),
        ..binding_input(&source)
    };
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: invalid,
        version: None,
    });
    assert_eq!(reply["ok"], false);

    let invalid = incidents::IncidentInput {
        disclosure: "everything".into(),
        ..binding_input(&source)
    };
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: invalid,
        version: None,
    });
    assert_eq!(reply["ok"], false);
}

#[tokio::test]
async fn binding_requires_primary_pair_operations_role_and_version_cas() {
    let t = setup();
    let source = alerts_path(&t);
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();

    // Without any registration the binding is refused: responsibility binds to
    // the actual Primary pair, never to an arbitrary Ghost.
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: binding_input(&source),
        version: None,
    });
    assert_eq!(reply["ok"], false);

    // Primary without the operations role policy is also refused.
    t.app.lock().unwrap().journal.0.execute(
        "INSERT INTO lifetime_registry(ghost_id,kind,conversation_id,roles,mode) VALUES(?1,'primary',?2,'[\"coordination\"]','active')",
        params![t.ghost, t.conversation],
    ).unwrap();
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: binding_input(&source),
        version: None,
    });
    assert_eq!(reply["ok"], false);

    t.seed_registry();
    let binding = t.save_binding(binding_input(&source), None);
    assert_eq!(binding["version"], 1);
    assert_eq!(binding["operations_ghost_id"], t.ops_ghost);

    // Updates are CAS: a stale version never overwrites the binding.
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: binding_input(&source),
        version: Some(99),
    });
    assert_eq!(reply["ok"], false);
    // Creation replay with version None is refused too.
    let reply = t.action(OwnerAction::SaveIncidentBinding {
        profile_id: t.ghost.clone(),
        binding: binding_input(&source),
        version: None,
    });
    assert_eq!(reply["ok"], false);

    // Owner pause/resume is CAS on the version.
    let reply = t.action(OwnerAction::PauseIncidentBinding {
        profile_id: t.ghost.clone(),
        paused: true,
        version: 1,
    });
    assert_eq!(reply["ok"], true, "{reply}");
    let binding = t
        .app
        .lock()
        .unwrap()
        .journal
        .get::<incidents::IncidentBinding>(incidents::BINDING_KIND, &t.ghost)
        .unwrap()
        .unwrap();
    assert!(binding.input.paused);

    // Removal requires the current version.
    let reply = t.action(OwnerAction::DeleteIncidentBinding {
        profile_id: t.ghost.clone(),
        version: 1,
    });
    assert_eq!(reply["ok"], false);
    let reply = t.action(OwnerAction::DeleteIncidentBinding {
        profile_id: t.ghost.clone(),
        version: 2,
    });
    assert_eq!(reply["ok"], true, "{reply}");
    assert!(
        t.app
            .lock()
            .unwrap()
            .journal
            .get::<incidents::IncidentBinding>(incidents::BINDING_KIND, &t.ghost)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn incident_fires_once_per_revision_and_recovering_a_claim_does_not_duplicate() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(
        &source,
        10,
        json!([
            alert("gatus:mlx-shared", "crit", "mlx-shared 엔드포인트 다운"),
            alert("unknown:collector", "crit", "범위 밖 소스"),
            alert("beszel:disk", "warn", "디스크 사용률 임계 초과"),
        ]),
    );
    let now = super::now_ms();
    t.fire(now);

    // Exactly one goal per in-scope alert; out-of-scope sources are dropped.
    assert_eq!(t.goals(), 2, "crit + beszel in scope, unknown source dropped");
    assert_eq!(t.incident_commands(), 2);
    assert_eq!(
        t.count("SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi'"),
        2
    );
    for (prompt, privacy, spec) in t.goal_payloads() {
        assert_eq!(privacy, "private");
        assert_eq!(spec["origin"], "infra_incident");
        assert_eq!(spec["operations_policy"]["role"], "operations");
        // Byte publication alone cannot satisfy the intake's diagnosis
        // contract: callers must attest its independent semantic boundaries.
        let required = spec["required_checks"].as_array().unwrap();
        for check in [
            "artifact-exact-bytes", "bounded-observation-truthfulness",
            "original-goal-section-structure", "source-provenance",
            "read-only-owner-gated", "publish-path-contract",
        ] {
            assert!(required.contains(&json!(check)), "missing diagnosis gate {check}");
        }
        assert!(!prompt.contains("unknown:collector"));
        assert!(!prompt.contains(source.to_str().unwrap()), "summary_only never discloses the source path");
    }
    assert!(t.runs().iter().all(|run| run.status == "delivered" && run.source_status == "ok"));

    // Re-running the loop over an unchanged snapshot never re-fires.
    t.fire(now + 1_000);
    t.fire(now + 2_000);
    assert_eq!(t.goals(), 2);
    assert_eq!(t.incident_commands(), 2);

    // A crash between claim and admission: same epoch, same identity — the
    // redelivery dedups against the lifetime command ledger.
    let run_id = t.runs()[0].id.clone();
    {
        let s = t.app.lock().unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, &run_id).unwrap().unwrap();
        run.status = "claimed".into();
        run.goal_id = None;
        s.journal.put(incidents::RUN_KIND, &run_id, &run).unwrap();
    }
    t.fire(now + 3_000);
    assert_eq!(t.goals(), 2, "command-ledger dedup makes recovery a no-op");
    assert_eq!(t.incident_commands(), 2);
    let runs = t.runs();
    assert!(runs.iter().all(|run| run.status == "delivered"));

    // A changed summary is a truthful new revision of the same alert id.
    write_alerts(
        &source,
        5,
        json!([
            alert("gatus:mlx-shared", "crit", "mlx-shared 엔드포인트 다운 (재발)"),
            alert("beszel:disk", "warn", "디스크 사용률 임계 초과"),
        ]),
    );
    t.fire(now + 4_000);
    assert_eq!(t.goals(), 3, "one revision bump, not a replay of both alerts");
    assert_eq!(t.incident_commands(), 3);
    let revisions: std::collections::HashSet<_> = t.runs().iter().map(|r| r.revision.clone()).collect();
    assert_eq!(revisions.len(), 3);
    // The old revision is never refired while its ledger row stands.
    t.fire(now + 5_000);
    assert_eq!(t.goals(), 3);
}

#[tokio::test]
async fn recovered_claim_fences_on_authority_epoch_change() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1);

    // Simulate a restore that advanced the authority epoch while a claim was
    // in flight: the claim must fence to an explicit blocked status instead of
    // replaying the accepted incident at the old epoch.
    let run_id = t.runs()[0].id.clone();
    {
        let s = t.app.lock().unwrap();
        s.journal
            .0
            .execute("UPDATE lifetime_authority SET authority_epoch=authority_epoch+1 WHERE singleton=1", [])
            .unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, &run_id).unwrap().unwrap();
        run.status = "claimed".into();
        run.authority_epoch = 1;
        run.goal_id = None;
        s.journal.put(incidents::RUN_KIND, &run_id, &run).unwrap();
    }
    t.fire(now + 1_000);
    let run = &t.runs()[0];
    assert_eq!(run.status, "blocked");
    assert_eq!(t.goals(), 1, "no replay at the old epoch");
    assert_eq!(t.incident_commands(), 1);
    assert_eq!(run.goal_id, None, "the fenced claim keeps no fabricated goal ref");
}

#[tokio::test]
async fn crash_before_admission_replays_the_sealed_payload_exactly_once() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1);
    let original = t.goal_payloads()[0].clone();

    // Crash after the claim row committed but before the admission landed:
    // every trace of the first attempt is gone except the claim row and its
    // sealed payload.
    let run_id = t.runs()[0].id.clone();
    {
        let s = t.app.lock().unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, &run_id).unwrap().unwrap();
        assert_eq!(run.sealed_body["privacy"], "private");
        run.status = "claimed".into();
        run.goal_id = None;
        s.journal.put(incidents::RUN_KIND, &run_id, &run).unwrap();
        s.journal
            .0
            .execute(
                "DELETE FROM lifetime_outbox WHERE command_id LIKE 'infra:%'",
                [],
            )
            .unwrap();
        s.journal
            .0
            .execute(
                "DELETE FROM lifetime_commands WHERE command_id LIKE 'infra:%'",
                [],
            )
            .unwrap();
        s.journal.0.execute("DELETE FROM lifetime_graph_budgets", []).unwrap();
        s.journal.0.execute("DELETE FROM lifetime_work", []).unwrap();
        s.journal.0.execute("DELETE FROM lifetime_goals", []).unwrap();
    }
    t.fire(now + 1_000);

    // The sealed payload — not a body recomputed from the current binding or
    // registry — becomes the one goal.
    assert_eq!(t.goals(), 1, "the sealed payload is admitted exactly once");
    assert_eq!(t.incident_commands(), 1);
    assert_eq!(
        t.count("SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi'"),
        1
    );
    let replayed = t.goal_payloads();
    assert_eq!(replayed.len(), 1);
    assert_eq!(
        replayed[0], original,
        "recovery replays the exact sealed content, byte for byte"
    );
    let runs = t.runs();
    assert_eq!(runs[0].status, "delivered");
    assert!(runs[0].goal_id.is_some());
    assert_eq!(runs[0].severity, "crit", "the original severity is preserved");

    // A second recovery pass over the same identity stays a no-op.
    t.fire(now + 2_000);
    assert_eq!(t.goals(), 1);
    assert_eq!(t.incident_commands(), 1);
}

#[tokio::test]
async fn recovered_claim_blocks_when_the_binding_changed_after_the_claim() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1);
    let original = t.goal_payloads()[0].clone();

    let run_id = t.runs()[0].id.clone();
    t.reclaim(&run_id);

    // The Owner changes the binding while the claim is in flight (pause and
    // resume bump the version twice). The old grant is never replayed under
    // the changed authorization and nothing new is admitted.
    let reply = t.action(OwnerAction::PauseIncidentBinding {
        profile_id: t.ghost.clone(),
        paused: true,
        version: 1,
    });
    assert_eq!(reply["ok"], true, "{reply}");
    let reply = t.action(OwnerAction::PauseIncidentBinding {
        profile_id: t.ghost.clone(),
        paused: false,
        version: 2,
    });
    assert_eq!(reply["ok"], true, "{reply}");

    t.fire(now + 1_000);
    let run = &t.runs()[0];
    assert_eq!(run.status, "blocked");
    assert_eq!(t.goals(), 1, "no duplicate delivery under the old grant");
    assert_eq!(t.incident_commands(), 1, "no new command is submitted");
    assert_eq!(
        t.goal_payloads()[0], original,
        "the original goal content is untouched"
    );
}

#[tokio::test]
async fn recovered_claim_blocks_on_a_route_change_instead_of_cross_route_delivery() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1);
    let original = t.goal_payloads()[0].clone();

    let run_id = t.runs()[0].id.clone();
    t.reclaim(&run_id);

    // The lifetime Primary re-registers on a different conversation while the
    // claim is in flight. Recovery must fence instead of replaying the
    // incident onto the moved route.
    let moved = uuid::Uuid::now_v7().to_string();
    t.app
        .lock()
        .unwrap()
        .journal
        .0
        .execute(
            "UPDATE lifetime_registry SET conversation_id=?1 WHERE ghost_id=?2 AND kind='primary'",
            params![moved, t.ghost],
        )
        .unwrap();

    t.fire(now + 1_000);
    let run = &t.runs()[0];
    assert_eq!(run.status, "blocked");
    assert_eq!(t.goals(), 1, "no cross-route delivery");
    assert_eq!(t.incident_commands(), 1, "no new command is submitted");
    assert_eq!(t.goal_payloads()[0], original, "only the original goal stands");
}

#[tokio::test]
async fn recovered_claim_blocks_when_the_operations_specialist_changed() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1);

    let run_id = t.runs()[0].id.clone();
    t.reclaim(&run_id);

    // The live operations specialist leaves the active registry while the
    // claim is in flight: the sealed grant's operations policy no longer
    // holds, so recovery must not reuse it.
    t.app
        .lock()
        .unwrap()
        .journal
        .0
        .execute(
            "UPDATE lifetime_registry SET mode='draining' WHERE ghost_id=?1 AND kind='specialist'",
            params![t.ops_ghost],
        )
        .unwrap();

    t.fire(now + 1_000);
    let run = &t.runs()[0];
    assert_eq!(run.status, "blocked");
    assert_eq!(t.goals(), 1);
    assert_eq!(t.incident_commands(), 1, "no new command is submitted");
}

#[tokio::test]
async fn tampered_or_bare_claim_payloads_fail_closed_without_replay() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1);
    let original = t.goal_payloads()[0].clone();

    // A half-migrated or tampered claim whose payload is not the private
    // admission it must be is refused outright: never replayed, never
    // granted a route, never recorded as a new admission.
    let run_id = t.runs()[0].id.clone();
    {
        let s = t.app.lock().unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, &run_id).unwrap().unwrap();
        run.status = "claimed".into();
        run.goal_id = None;
        run.sealed_body["privacy"] = json!("public");
        s.journal.put(incidents::RUN_KIND, &run_id, &run).unwrap();
    }
    t.fire(now + 1_000);
    let run = &t.runs()[0];
    assert_eq!(run.status, "failed");
    assert_eq!(t.goals(), 1);
    assert_eq!(t.incident_commands(), 1, "a tampered payload never reaches the ledger");
    assert_eq!(t.goal_payloads()[0], original);

    // A claim row with no sealed payload at all refuses the same way instead
    // of inventing content.
    let run_id = t.runs()[0].id.clone();
    {
        let s = t.app.lock().unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, &run_id).unwrap().unwrap();
        run.status = "claimed".into();
        run.goal_id = None;
        run.sealed_body = Value::Null;
        s.journal.put(incidents::RUN_KIND, &run_id, &run).unwrap();
    }
    t.fire(now + 2_000);
    let run = &t.runs()[0];
    assert_eq!(run.status, "failed");
    assert_eq!(t.goals(), 1);
    assert_eq!(t.incident_commands(), 1);
}

#[tokio::test]
async fn same_identity_different_content_fails_closed() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1);

    // A ledger row whose recorded digest no longer matches the re-presented
    // identity (tampering or half-migration) must fail closed: collision
    // record, untouched run row, no new admission.
    let run_id = t.runs()[0].id.clone();
    {
        let s = t.app.lock().unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, &run_id).unwrap().unwrap();
        run.status = "delivered".into();
        run.content_digest = format!("{:x}", sha2::Sha256::digest(b"tampered"));
        s.journal.put(incidents::RUN_KIND, &run_id, &run).unwrap();
    }
    t.fire(now + 1_000);
    assert_eq!(t.goals(), 1, "collision never re-admits");
    assert_eq!(t.incident_commands(), 1);
    let collisions = t
        .app
        .lock()
        .unwrap()
        .journal
        .objects::<incidents::IncidentCollision>(incidents::COLLISION_KIND)
        .unwrap();
    assert_eq!(collisions.len(), 1);
    assert_eq!(collisions[0].alert_id, "gatus:mlx-shared");

    // The status surface reports the collision and the run truthfully.
    let status = t.action(OwnerAction::IncidentList {
        profile_id: t.ghost.clone(),
    });
    assert_eq!(status["ok"], true, "{status}");
    assert_eq!(status["result"]["collisions"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn stale_unreadable_and_invalid_snapshots_are_observation_incidents_not_health() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    let now = super::now_ms();

    // Missing file: an explicit unreadable observation, never quiet health.
    t.fire(now);
    assert_eq!(t.goals(), 1);
    let (_, _, spec) = &t.goal_payloads()[0];
    assert_eq!(spec["alert_id"], "observation:unreadable");

    // Same condition again: one durable observation per condition revision.
    t.fire(now + 1_000);
    assert_eq!(t.goals(), 1);

    // Stale snapshot: a distinct observation condition.
    write_alerts(&source, 1_000, json!([]));
    t.fire(now + 2_000);
    assert_eq!(t.goals(), 2);
    assert_eq!(t.goal_payloads()[1].2["alert_id"], "observation:stale");
    t.fire(now + 3_000);
    assert_eq!(t.goals(), 2, "age drift alone must not create revisions");

    // Invalid snapshot: a third condition.
    std::fs::write(&source, b"{not json").unwrap();
    t.fire(now + 4_000);
    assert_eq!(t.goals(), 3);
    assert_eq!(t.goal_payloads()[2].2["alert_id"], "observation:invalid");

    // Recovery to a fresh snapshot with a real alert produces the alert fire
    // and no synthetic "recovered" observation.
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    t.fire(now + 5_000);
    assert_eq!(t.goals(), 4);
    assert_eq!(t.goal_payloads()[3].2["alert_id"], "gatus:mlx-shared");
    assert_eq!(t.goal_payloads()[3].2["source_status"], "ok");
}

#[tokio::test]
async fn disclosure_operator_mode_and_scope_filters_bound_by_config() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);

    // Severity scope: a warn-only binding never fires crit alerts.
    let warn_only = incidents::IncidentInput {
        severities: vec!["warn".into()],
        ..binding_input(&source)
    };
    t.save_binding(warn_only, Some(1));
    write_alerts(
        &source,
        10,
        json!([
            alert("gatus:mlx-shared", "crit", "다운"),
            alert("beszel:cpu", "warn", "CPU 임계 초과"),
        ]),
    );
    let now = super::now_ms();
    t.fire(now);
    assert_eq!(t.goals(), 1, "crit is out of severity scope");
    assert!(t.goal_payloads()[0].0.contains("beszel:cpu"));
    assert!(!t.goal_payloads()[0].0.contains("gatus:mlx-shared"));

    // Operator disclosure: the source path is disclosed, the prompt is still
    // private and bounded by the same diagnosis boundary.
    let operator = incidents::IncidentInput {
        disclosure: "operator".into(),
        ..binding_input(&source)
    };
    t.save_binding(operator, Some(2));
    write_alerts(
        &source,
        10,
        json!([alert("beszel:cpu", "warn", "CPU 임계 초과 (심화)")]),
    );
    t.fire(now + 1_000);
    assert_eq!(t.goals(), 2);
    let (prompt, privacy, _) = t.goal_payloads()[1].clone();
    assert!(prompt.contains(source.to_str().unwrap()), "operator mode discloses the source path");
    assert!(prompt.contains(&format!("[관측 스냅샷](<{}>)", source.display())),
        "operator source includes the exact required Markdown link");
    assert!(prompt.contains("실제 Gatus 시스템이 발행했는지"),
        "producer labels do not prove live producer provenance");
    assert!(prompt.contains("Owner의 바인딩 승인과 경보의 작성·발행 주체는 다릅니다"));
    assert_eq!(privacy, "private");

    // Paused: the dispatch hook skips the binding entirely.
    let reply = t.action(OwnerAction::PauseIncidentBinding {
        profile_id: t.ghost.clone(),
        paused: true,
        version: 3,
    });
    assert_eq!(reply["ok"], true, "{reply}");
    write_alerts(&source, 10, json!([alert("beszel:cpu", "warn", "CPU 임계 초과 (3)")]));
    t.fire(now + 2_000);
    assert_eq!(t.goals(), 2, "paused binding never fires");

    // Preview is read-only and reports scope/dedup state without writes.
    let objects = || {
        t.count("SELECT COUNT(*) FROM workspace_objects")
    };
    let before = objects();
    let preview = t.action(OwnerAction::IncidentPreview {
        profile_id: t.ghost.clone(),
        now_ms: None,
    });
    assert_eq!(preview["ok"], true, "{preview}");
    assert_eq!(preview["result"]["alerts_total"], 1);
    assert_eq!(preview["result"]["alerts_in_scope"], 1);
    assert_eq!(preview["result"]["fires"][0]["state"], "due", "paused binding has not delivered this revision");
    assert_eq!(objects(), before, "preview persists nothing");
}

#[tokio::test]
async fn in_flight_claim_refuses_removal_until_settled() {
    let t = setup();
    t.seed_registry();
    let source = alerts_path(&t);
    t.save_binding(binding_input(&source), None);
    write_alerts(&source, 10, json!([alert("gatus:mlx-shared", "crit", "다운")]));
    let now = super::now_ms();
    t.fire(now);
    let run_id = t.runs()[0].id.clone();
    {
        let s = t.app.lock().unwrap();
        let mut run: incidents::IncidentRun =
            s.journal.get(incidents::RUN_KIND, &run_id).unwrap().unwrap();
        run.status = "claimed".into();
        s.journal.put(incidents::RUN_KIND, &run_id, &run).unwrap();
    }
    let reply = t.action(OwnerAction::DeleteIncidentBinding {
        profile_id: t.ghost.clone(),
        version: 1,
    });
    assert_eq!(reply["ok"], false);
}
