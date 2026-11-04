use super::*;
use crate::control::api::OwnerAction;
#[cfg(feature = "lifetime")]
use sha2::Digest;

fn host() -> (tempfile::TempDir, Arc<Host>) {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    for name in ["wake-owner-fixture", "wake-specialist-fixture"] {
        app.action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::CreateProfile { name: name.into(), persona: "Synthetic wake fixture".into() },
        }).unwrap();
    }
    (root, app)
}

fn conversation(app: &Arc<Host>, profile_id: &str) -> String {
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::CreateConversation {
                profile_id: profile_id.to_owned(),
                model: "mock".into(),
                tools: false,
            },
        })
        .unwrap();
    reply["result"]["conversation_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn wake_action(app: &Arc<Host>, action: OwnerAction) -> Value {
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace { action },
        })
        .unwrap();
    assert_eq!(reply["ok"], true, "{reply}");
    reply["result"].clone()
}

#[test]
fn occurrence_math_is_dst_correct_and_quiet_clamped() {
    // Asia/Seoul has no DST: 08:00 local stays 08:00 (+09:00).
    // 2026-10-11T00:30:00Z is 09:30 KST; the next 08:00 is 2026-10-12 local.
    let after_ms = "2026-10-11T00:30:00Z"
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_millisecond() as u64;
    let (ms, key) =
        wake::occurrence_after("Asia/Seoul", "08:00", None, after_ms).unwrap();
    assert_eq!(
        jiff::Timestamp::from_millisecond(ms as i64)
            .unwrap()
            .to_string(),
        "2026-10-11T23:00:00Z"
    );
    assert_eq!(key, "2026-10-12T08:00:00");

    // Quiet hours: 07:30 inside [00:00, 08:00) fires at 08:00.
    let (ms, key) =
        wake::occurrence_after("Asia/Seoul", "07:30", Some(480), after_ms).unwrap();
    assert_eq!(key, "2026-10-12T08:00:00");
    let _ = ms;

    // Spring-forward gap (America/New_York 2026-03-08): a 02:30 wake inside the
    // gap resolves with the offset before the transition (jiff compatible).
    let before_gap = "2026-03-08T05:00:00Z"
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_millisecond() as u64;
    let (ms, _) = wake::occurrence_after("America/New_York", "02:30", None, before_gap).unwrap();
    assert_eq!(
        jiff::Timestamp::from_millisecond(ms as i64)
            .unwrap()
            .to_string(),
        "2026-03-08T07:30:00Z"
    );

    // Fall-back fold (2026-11-01): the earlier offset wins, one fire per key.
    let before_fold = "2026-10-31T20:00:00Z"
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_millisecond() as u64;
    let (ms, key) =
        wake::occurrence_after("America/New_York", "01:30", None, before_fold).unwrap();
    assert_eq!(
        jiff::Timestamp::from_millisecond(ms as i64)
            .unwrap()
            .to_string(),
        "2026-11-01T05:30:00Z"
    );
    assert_eq!(key, "2026-11-01T01:30:00");

    // Latest occurrence at or before now, for missed-occurrence policy.
    let now = "2026-10-12T14:00:00Z"
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_millisecond() as u64;
    let (ms, key) =
        wake::occurrence_at_or_before("Asia/Seoul", "08:00", None, now).unwrap();
    assert_eq!(key, "2026-10-12T08:00:00");
    assert_eq!(
        jiff::Timestamp::from_millisecond(ms as i64)
            .unwrap()
            .to_string(),
        "2026-10-11T23:00:00Z"
    );
}

#[tokio::test]
async fn wake_fires_once_per_occurrence_and_recovers_a_claim() {
    let (root, app) = host();
    let id = app.lock().unwrap().profiles.keys().next().unwrap().clone();
    let conversation_id = conversation(&app, &id);
    let wake = wake_action(
        &app,
        OwnerAction::AddWake {
            profile_id: id.clone(),
            conversation_id: conversation_id.clone(),
            prompt: "아침 브리핑을 정리해 줘.".into(),
            timezone: "Asia/Seoul".into(),
            local_time: "08:00".into(),
            quiet_minutes: None,
            missed_policy: "coalesce".into(),
        },
    );
    let wake_id = wake["id"].as_str().unwrap().to_owned();

    // Force the schedule due now.
    let now = super::now_ms();
    {
        let s = app.lock().unwrap();
        let mut stored: wake::WakeSchedule = s.journal.get(wake::WAKE_KIND, &wake_id).unwrap().unwrap();
        stored.next_run_ms = now - 1_000;
        s.journal.put(wake::WAKE_KIND, &wake_id, &stored).unwrap();
    }
    wake::fire_due(&*app.lock().unwrap(), &id, now).unwrap();

    // One durable submission with the exact occurrence identity.
    let submissions = || {
        app.lock()
            .unwrap()
            .profiles
            .get(&id)
            .unwrap()
            .runtime
            .session
            .committed()
            .unwrap()
            .submissions
            .iter()
            .filter(|s| s.request_id.starts_with("wake:"))
            .cloned()
            .collect::<Vec<_>>()
    };
    let first = submissions();
    assert_eq!(first.len(), 1, "expected exactly one wake submission");
    assert!(first[0].request_id.starts_with(&format!("wake:{wake_id}:")));

    // Re-running the loop must not duplicate the fire.
    wake::fire_due(&*app.lock().unwrap(), &id, now + 1_000).unwrap();
    assert_eq!(submissions().len(), 1);

    // A crash left the claim behind: same epoch redelivers the same request id.
    let (occurrence_ms, occurrence_key) = {
        let s = app.lock().unwrap();
        let stored: wake::WakeSchedule =
            s.journal.get(wake::WAKE_KIND, &wake_id).unwrap().unwrap();
        let previous = wake::occurrence_after(
            &stored.input.timezone,
            &stored.input.local_time,
            stored.input.quiet_minutes,
            stored.next_run_ms - 86_400_000,
        )
        .unwrap();
        previous
    };
    {
        let s = app.lock().unwrap();
        let mut stored: wake::WakeSchedule =
            s.journal.get(wake::WAKE_KIND, &wake_id).unwrap().unwrap();
        stored.fire_state = "claiming".into();
        stored.next_run_ms = occurrence_ms;
        stored.next_occurrence_key = occurrence_key.clone();
        s.journal.put(wake::WAKE_KIND, &wake_id, &stored).unwrap();
        s.journal
            .put(
                wake::WAKE_RUN_KIND,
                &format!("{wake_id}:{occurrence_key}"),
                &wake::WakeRun {
                    id: format!("{wake_id}:{occurrence_key}"),
                    wake_id: wake_id.clone(),
                    occurrence_key: occurrence_key.clone(),
                    status: "claimed".into(),
                    authority_epoch: wake::current_epoch(&s),
                    goal_id: None,
                    task_id: None,
                    at_ms: now,
                    diagnostic: None,
                },
            )
            .unwrap();
    }
    wake::fire_due(&*app.lock().unwrap(), &id, now + 2_000).unwrap();
    let after = submissions();
    assert_eq!(after.len(), 2, "redelivery targets the different occurrence identity");
    assert_eq!(after[0].request_id, first[0].request_id);
    let s = app.lock().unwrap();
    let stored: wake::WakeSchedule = s.journal.get(wake::WAKE_KIND, &wake_id).unwrap().unwrap();
    assert_eq!(stored.fire_state, "idle");
}

#[tokio::test]
async fn missed_occurrences_coalesce_into_one_fire() {
    let (root, app) = host();
    let id = app.lock().unwrap().profiles.keys().next().unwrap().clone();
    let conversation_id = conversation(&app, &id);
    let wake = wake_action(
        &app,
        OwnerAction::AddWake {
            profile_id: id.clone(),
            conversation_id,
            prompt: "브리핑".into(),
            timezone: "Asia/Seoul".into(),
            local_time: "08:00".into(),
            quiet_minutes: None,
            missed_policy: "coalesce".into(),
        },
    );
    let wake_id = wake["id"].as_str().unwrap().to_owned();
    let now = super::now_ms();
    {
        let s = app.lock().unwrap();
        let mut stored: wake::WakeSchedule = s.journal.get(wake::WAKE_KIND, &wake_id).unwrap().unwrap();
        // The schedule went quiet for three days: next_run_ms is 3 days old.
        stored.next_run_ms = now - 3 * 86_400_000;
        s.journal.put(wake::WAKE_KIND, &wake_id, &stored).unwrap();
    }
    wake::fire_due(&*app.lock().unwrap(), &id, now).unwrap();
    let s = app.lock().unwrap();
    let runs = s.journal.objects::<wake::WakeRun>(wake::WAKE_RUN_KIND).unwrap();
    let skipped = runs.iter().filter(|r| r.status == "skipped").count();
    let fired = runs.iter().filter(|r| r.status == "submitted").count();
    assert_eq!(skipped, 1, "one bounded summary for the missed span");
    assert_eq!(fired, 1, "one fire for the latest missed occurrence, not an explosion");
    let stored: wake::WakeSchedule = s.journal.get(wake::WAKE_KIND, &wake_id).unwrap().unwrap();
    assert!(stored.next_run_ms > now);
}

#[tokio::test]
async fn wake_preview_is_pure_and_dispatch_off_survives_reads() {
    let (root, app) = host();
    let id = app.lock().unwrap().profiles.keys().next().unwrap().clone();
    let conversation_id = conversation(&app, &id);
    let wake = wake_action(
        &app,
        OwnerAction::AddWake {
            profile_id: id.clone(),
            conversation_id,
            prompt: "브리핑".into(),
            timezone: "Asia/Seoul".into(),
            local_time: "08:00".into(),
            quiet_minutes: None,
            missed_policy: "coalesce".into(),
        },
    );
    let wake_id = wake["id"].as_str().unwrap().to_owned();
    let objects = || {
        app.lock()
            .unwrap()
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM workspace_objects", [], |r| r.get::<_, i64>(0))
            .unwrap()
    };
    let tasks = || {
        app.lock()
            .unwrap()
            .profiles
            .get(&id)
            .unwrap()
            .runtime
            .session
            .committed()
            .unwrap()
            .tasks
            .len()
    };
    let before_objects = objects();
    let before_tasks = tasks();
    let preview = wake_action(
        &app,
        OwnerAction::WakePreview {
            profile_id: id.clone(),
            wake_id,
            now_ms: None,
        },
    );
    assert!(preview["briefing"].as_str().unwrap().contains("브리핑"));
    assert!(preview["request_id"].as_str().unwrap().starts_with("wake:"));
    assert_eq!(objects(), before_objects, "preview persists nothing");
    assert_eq!(tasks(), before_tasks, "preview starts no model turn");
}

#[tokio::test]
async fn skill_store_pins_digests_and_candidates_promote_only_by_owner() {
    let (root, app) = host();
    let id = app.lock().unwrap().profiles.keys().next().unwrap().clone();
    let content = "---\nname: research-brief\ndescription: Research briefing procedure\n---\n1. collect sources\n";
    let saved = wake_action(
        &app,
        OwnerAction::SaveSkill {
            profile_id: id.clone(),
            name: "research-brief".into(),
            content: content.into(),
            version: None,
        },
    );
    assert_eq!(saved["skill"]["revision"], 1);
    let digest = saved["skill"]["digest"].as_str().unwrap().to_owned();

    // The pinned manifest exposes exactly the active skill with its digest.
    let manifest = wake_action(&app, OwnerAction::SkillManifest { profile_id: id.clone() });
    let entries = manifest["skills"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["sha256"].as_str().unwrap(), digest);

    // Silent drift fails closed with the recovery instruction.
    let name = app.lock().unwrap().profiles.get(&id).unwrap().name.clone();
    let active = root
        .path()
        .join("profiles")
        .join(&name)
        .join("skills")
        .join("research-brief")
        .join("SKILL.md");
    std::fs::write(&active, "tampered").unwrap();
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace {
                action: OwnerAction::SkillManifest { profile_id: id.clone() },
            },
        })
        .unwrap();
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["error"].as_str().unwrap().contains("skill recover"));

    // Recovery restores the pinned revision, never the drift.
    let recovered = wake_action(
        &app,
        OwnerAction::SkillRecover {
            profile_id: id.clone(),
            name: "research-brief".into(),
        },
    );
    assert_eq!(recovered["status"], "restored_after_drift");
    let manifest = wake_action(&app, OwnerAction::SkillManifest { profile_id: id.clone() });
    assert_eq!(manifest["skills"].as_array().unwrap().len(), 1);

    // Replacement without the current version is rejected (CAS).
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace {
                action: OwnerAction::SaveSkill {
                    profile_id: id.clone(),
                    name: "research-brief".into(),
                    content: "new".into(),
                    version: None,
                },
            },
        })
        .unwrap();
    assert_eq!(reply["ok"], false);

    // Candidates never touch the active revision; promotion is owner-only and
    // creates a truthful candidate origin.
    let candidate = wake_action(
        &app,
        OwnerAction::SaveSkillCandidate {
            profile_id: id.clone(),
            skill: "research-brief".into(),
            content: "---\nname: research-brief\ndescription: Research briefing procedure v2\n---\n1. collect sources\n2. verify dates\n".into(),
            note: "add date verification".into(),
        },
    );
    let candidate_id = candidate["candidate"]["id"].as_str().unwrap().to_owned();
    let active_before = wake_action(&app, OwnerAction::SkillList { profile_id: id.clone() });
    assert_eq!(active_before.as_array().unwrap()[0]["revision"], 1);
    let promoted = wake_action(
        &app,
        OwnerAction::PromoteSkillCandidate {
            profile_id: id.clone(),
            candidate_id: candidate_id.clone(),
        },
    );
    assert_eq!(promoted["skill"]["revision"], 2);
    assert_eq!(promoted["skill"]["origin"]["kind"], "candidate");
    // Promoting twice is refused.
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace {
                action: OwnerAction::PromoteSkillCandidate {
                    profile_id: id.clone(),
                    candidate_id,
                },
            },
        })
        .unwrap();
    assert_eq!(reply["ok"], false);
}

#[tokio::test]
async fn legacy_skill_keys_migrate_without_cross_ghost_name_collisions() {
    let (root, app) = host();
    let ids: Vec<_> = app.lock().unwrap().profiles.keys().cloned().collect();
    let mut digests = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let saved = wake_action(&app, OwnerAction::SaveSkill {
            profile_id: id.clone(), name: "shared".into(),
            content: format!("---\nname: shared\ndescription: Scoped procedure\n---\nowner {index}\n"),
            version: None,
        });
        digests.push(saved["skill"]["digest"].as_str().unwrap().to_owned());
    }
    // A pre-cutover store used the human name as its key.
    {
        let state = app.lock().unwrap();
        state.journal.0.execute(
            "UPDATE workspace_objects SET id='shared' WHERE kind='skill' AND id=?1",
            [format!("{}:shared", ids[0])],
        ).unwrap();
    }
    app.shutdown().await.unwrap();
    drop(app);
    let app = Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    for (id, digest) in ids.iter().zip(digests) {
        let manifest = wake_action(&app, OwnerAction::SkillManifest { profile_id: id.clone() });
        let skills = manifest["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 1, "one active revision per Ghost after cold migration");
        assert_eq!(skills[0]["sha256"].as_str().unwrap(), digest);
    }
}

#[tokio::test]
async fn conflicting_legacy_skill_records_preserve_both_payloads() {
    let (root, app) = host();
    let id = app.lock().unwrap().profiles.keys().next().unwrap().clone();
    wake_action(&app, OwnerAction::SaveSkill {
        profile_id: id.clone(), name: "brief".into(),
        content: "---\nname: brief\ndescription: Scoped procedure\n---\noriginal\n".into(),
        version: None,
    });
    let original = {
        let state = app.lock().unwrap();
        state.journal.0.query_row(
            "SELECT payload FROM workspace_objects WHERE kind='skill' AND id=?1",
            [format!("{id}:brief")], |row| row.get::<_, String>(0),
        ).unwrap()
    };
    let mut conflicting: serde_json::Value = serde_json::from_str(&original).unwrap();
    conflicting["digest"] = json!("b".repeat(64));
    let conflicting = serde_json::to_string(&conflicting).unwrap();
    app.lock().unwrap().journal.0.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES('skill','brief',?1)",
        [&conflicting],
    ).unwrap();
    app.shutdown().await.unwrap();
    drop(app);
    let result = Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock"));
    assert!(result.is_err(), "conflicting revisions must never be silently chosen");
    let conn = rusqlite::Connection::open(root.path().join("workspace.db")).unwrap();
    for (key, expected) in [(format!("{id}:brief"), original), ("brief".into(), conflicting)] {
        let retained: String = conn.query_row(
            "SELECT payload FROM workspace_objects WHERE kind='skill' AND id=?1",
            [key], |row| row.get(0),
        ).unwrap();
        assert_eq!(retained, expected, "failed migration preserves each original payload");
    }
}

#[cfg(feature = "lifetime")]
#[tokio::test]
async fn work_admission_derives_sealed_skill_refs_from_the_store() {
    let (root, app) = host();
    let (id, other) = {
        let s = app.lock().unwrap();
        let ids: Vec<String> = s.profiles.keys().cloned().collect();
        (ids[0].clone(), ids.get(1).cloned())
    };
    let _ = &root;
    let content = "---\nname: brief\ndescription: Briefing procedure\n---\nsteps\n";
    let saved = wake_action(
        &app,
        OwnerAction::SaveSkill {
            profile_id: id.clone(),
            name: "brief".into(),
            content: content.into(),
            version: None,
        },
    );
    let digest = saved["skill"]["digest"].as_str().unwrap().to_owned();
    // A disabled skill and another Ghost's skill never enter the sealed refs.
    if let Some(other) = other {
        wake_action(
            &app,
            OwnerAction::SaveSkill {
                profile_id: other.clone(),
                name: "foreign".into(),
                content: content.into(),
                version: None,
            },
        );
    }
    wake_action(
        &app,
        OwnerAction::SaveSkill {
            profile_id: id.clone(),
            name: "retired".into(),
            content: content.into(),
            version: None,
        },
    );
    wake_action(
        &app,
        OwnerAction::SetSkillStatus {
            profile_id: id.clone(),
            name: "retired".into(),
            status: "disabled".into(),
        },
    );
    let refs = crate::host::skills::refs_for_work(&app.lock().unwrap().journal.0, &id).unwrap();
    let refs = refs.expect("active skill must produce sealed refs");
    assert_eq!(refs.len(), 1, "{refs:?}");
    assert_eq!(refs[0].name, "brief");
    assert_eq!(refs[0].sha256, digest);
    assert_eq!(refs[0].privacy, "private");
}

#[cfg(feature = "lifetime")]
#[tokio::test]
async fn queued_skill_pin_survives_an_owner_upgrade_and_missing_archive_fails_closed() {
    let (_root, app) = host();
    let (id, name) = {
        let state = app.lock().unwrap();
        let profile = state.profiles.values().next().unwrap();
        (profile.id.clone(), profile.name.clone())
    };
    let original = "---\nname: pinned\ndescription: Original procedure\nprivacy: public\n---\nUse the original procedure.\n";
    wake_action(&app, OwnerAction::SaveSkill {
        profile_id: id.clone(), name: "pinned".into(),
        content: original.into(), version: None,
    });
    let refs = crate::host::skills::refs_for_work(&app.lock().unwrap().journal.0, &id).unwrap().unwrap();
    let upgraded = wake_action(&app, OwnerAction::SaveSkill {
        profile_id: id, name: "pinned".into(),
        content: "---\nname: pinned\ndescription: Changed procedure\nprivacy: private\n---\nUse the changed procedure.\n".into(),
        version: Some(1),
    });
    let delivered = crate::host::skills::payloads_for_refs(&app.root, &name, &refs).unwrap();
    let actual_digest = format!("{:x}", sha2::Sha256::digest(delivered[0]["content"].as_str().unwrap().as_bytes()));
    assert_eq!(actual_digest, refs[0].sha256);
    assert_ne!(actual_digest, upgraded["skill"]["digest"].as_str().unwrap());
    assert_eq!(delivered[0]["content"], original);
    std::fs::remove_file(app.root.join("profiles").join(&name).join("skills/pinned/revisions")
        .join(&refs[0].sha256).join("SKILL.md")).unwrap();
    assert!(crate::host::skills::payloads_for_refs(&app.root, &name, &refs).is_err());
}
