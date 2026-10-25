//! A01 synthetic schema-14 preservation, not installed-data migration or inference.
use super::*;
use crate::host::bots::{BotDefinition, DefinitionContent, RevisionRef};
use crate::lifetime_contract::{canonical_digest, Envelope, ResponseStatus, VERSION};
use anyhow::{ensure, Result};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Value};
use sha2::Digest;
use std::process::Command as ProcessCommand;

const CHILD_ROOT: &str = "GHOST_A01_PRESERVATION_ROOT";
const TEST_NAME: &str = "host::preservation_tests::a01_schema14_four_persistent_ghosts_and_legacy_profile_survive_new_model_open";

fn request(body: Value) -> Envelope {
    let id = uuid::Uuid::new_v4().to_string();
    Envelope {
        protocol_version: VERSION.into(),
        command_id: id.clone(),
        correlation_id: id,
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: "owner".into(),
        authority_epoch: 1,
        expected_revision: None,
        body,
    }
}
fn apply(conn: &Connection, body: Value) -> Result<crate::lifetime_contract::Response> {
    let response = lifetime::apply(conn, &request(body), "owner")?;
    ensure!(response.status == ResponseStatus::Success, "{response:?}");
    Ok(response)
}
fn old_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE workspace_commands(id TEXT PRIMARY KEY,payload TEXT NOT NULL,response TEXT); CREATE TABLE schedules(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,conversation_id TEXT NOT NULL,prompt TEXT NOT NULL,interval_seconds INTEGER NOT NULL,next_run_ms INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0,last_task_id TEXT); CREATE TABLE workspace_objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE collaboration_messages(delegation TEXT NOT NULL,event_key TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(delegation,event_key),UNIQUE(delegation,sequence));")?;
    for migration in [
        include_str!("../../contracts/lifetime/migration-005.sql"),
        include_str!("../../contracts/lifetime/migration-006.sql"),
        include_str!("../../contracts/lifetime/migration-007.sql"),
        include_str!("../../contracts/lifetime/migration-008.sql"),
        include_str!("../../contracts/lifetime/migration-009.sql"),
        include_str!("../../contracts/lifetime/migration-010.sql"),
        include_str!("../../contracts/lifetime/migration-011.sql"),
        include_str!("../../contracts/lifetime/migration-012.sql"),
        include_str!("../../contracts/lifetime/migration-013.sql"),
        include_str!("../../contracts/lifetime/migration-014.sql"),
    ] {
        conn.execute_batch(migration)?;
    }
    conn.pragma_update(None, "user_version", 14)?;
    Ok(())
}
// Preserve complete stable SQLite values, including exact UTF-8 payload bytes;
// sorting changes only row enumeration order, not source strings or columns.
fn sql_rows(conn: &Connection, sql: &str) -> Result<Vec<Value>> {
    let mut query = conn.prepare(sql)?;
    let columns = query.column_count();
    let mut rows = query.query([])?;
    let mut result = vec![];
    while let Some(row) = rows.next()? {
        let mut values = vec![];
        for column in 0..columns {
            values.push(match row.get_ref(column)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => json!(std::str::from_utf8(value)?),
                ValueRef::Blob(value) => json!({"blob":value}),
            });
        }
        result.push(json!(values));
    }
    result.sort_by_cached_key(Value::to_string);
    Ok(result)
}
fn tables(conn: &Connection) -> Result<BTreeMap<String, Vec<Value>>> {
    let names = sql_rows(
        conn,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let mut result = BTreeMap::new();
    for name in names {
        let name = name[0].as_str().unwrap();
        result.insert(
            name.into(),
            sql_rows(
                conn,
                &format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")),
            )?,
        );
    }
    Ok(result)
}
fn profiles(profiles: &BTreeMap<String, Profile>) -> Result<Value> {
    let mut result = BTreeMap::new();
    for (id, profile) in profiles {
        let store = profile
            .host
            .store
            .lock()
            .map_err(|_| anyhow!("Profile unavailable"))?;
        let durable = Connection::open_with_flags(
            store.dir.join("durable.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        result.insert(id.clone(),json!({"id":id,"name":profile.name,"persona":profile.persona,"profile_sqlite":tables(&store.conn)?,"durable_sqlite":tables(&durable)?,"conversations":profile.runtime.session.committed()?.conversations}));
    }
    Ok(json!(result))
}
fn definition(ghost: &str, index: usize) -> Result<BotDefinition> {
    let reference = |id: &str| RevisionRef {
        namespace: "owner".into(),
        id: id.into(),
        revision: 1,
        digest: "a".repeat(64),
    };
    BotDefinition::new(
        ghost.into(),
        1,
        DefinitionContent {
            purpose: format!("Original persistent purpose {index}"),
            input_contract: json!({"type":"object"}),
            output_contract: json!({"type":"object"}),
            instruction_ref: reference("original-instructions"),
            skill_refs: vec![],
                skill_aliases: Default::default(),
            acceptance_policy_ref: reference("owner-review"),
            required_capabilities: vec!["read".into()],
            memory_profile_ref: None,
            execution_profile_ref: reference("original-execution"),
        },
    )
}
fn seed(root: &Path) -> Result<()> {
    std::fs::create_dir_all(root)?;
    let conn = Connection::open(root.join("workspace.db"))?;
    old_schema(&conn)?;
    let mut stored = BTreeMap::new();
    let mut primary = String::new();
    for (index, (name, role)) in [
        ("original-companion", "coordination"),
        ("original-library", "research"),
        ("original-builder", "engineering"),
        ("original-operator", "operations"),
        ("legacy-profile-v1", "legacy"),
    ]
    .into_iter()
    .enumerate()
    {
        let persona = format!(
            "Original persona {index}: synthetic owner text\nPreserve punctuation, 한글, and UUID."
        );
        let profile = Host::profile(ProfileStore::create_profile(root, name, &persona)?)?;
        let old_model = ai::Model::new(
            format!("legacy-model-{index}"),
            "Original stored model",
            ai::Api::OpenAiCompletions,
            "mock",
            "",
        );
        let conversation =
            profile
                .runtime
                .session
                .create_conversation(host::durable::AgentConfig::new(
                    old_model,
                    format!("Original conversation instructions {index}"),
                ))?;
        profile.runtime.session.observe(
            &conversation,
            &format!("original-observation-{index}"),
            "synthetic-preexisting-history",
            &format!("Original conversation history {index}, never replace or merge."),
        )?;
        let id = profile.id.clone();
        if index < 4 {
            if index == 0 {
                primary = id.clone();
            }
            let personal = uuid::Uuid::new_v4().to_string();
            apply(
                &conn,
                json!({"method":"registry.ensure","ghost_id":id,"kind":if index==0{"primary"}else{"specialist"},"conversation_id":personal,"roles":[role]}),
            )?;
            if index == 0 {
                apply(
                    &conn,
                    json!({"method":"bot.definition.update","definition":definition(&id,index)?}),
                )?;
            }
            apply(
                &conn,
                json!({"method":"goal.submit","ghost_id":id,"conversation_id":personal,"prompt":format!("Original queued responsibility {index}"),"privacy":"public","acceptance_spec":{}}),
            )?;
        }
        if index > 0 && index < 4 {
            // Pre-B1 records had no definition and no explicit-null Work pin.
            conn.execute("DELETE FROM workspace_objects WHERE kind='bot_definition_work_pin_v1' AND json_extract(payload,'$.ghost_id')=?1",[&id])?;
        }
        stored.insert(id, profile);
    }
    let computers =
        lifetime_computers::NativeComputers::pi_fixture(&root.join("registry"), &primary)?;
    let mut homes = vec![];
    for (id, profile) in &stored {
        if id != &primary {
            computers.provision_pi_ghost(&conn, &primary, id, 1, "pi-default/1")?;
        }
        let execution = format!("{:x}", sha2::Sha256::digest(format!("a01-original-{id}")));
        let home = computers.pi_acquire(id, &execution, 1, "public")?;
        let marker = home.manifest.home_volume.join("a01-original.txt");
        let bytes = format!("Original home bytes for {} ({id})\n", profile.name).into_bytes();
        std::fs::write(&marker, &bytes)?;
        homes.push(json!({"ghost_id":id,"manifest":home.manifest,"marker":marker,"bytes":bytes}));
        computers.pi_release(id, &execution, 1)?;
    }
    drop(computers);
    let registry = Connection::open_with_flags(
        root.join("registry/computer-registry.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let expected = json!({"classification":"synthetic schema14 fixture; no installed data or inference","schema":14,"primary_id":primary,"profiles":profiles(&stored)?,"workspace_tables":tables(&conn)?,"computer_registry":tables(&registry)?,"homes":homes});
    std::fs::write(
        root.join("a01-before.json"),
        serde_json::to_vec_pretty(&expected)?,
    )?;
    Ok(())
}
async fn check_open(root: &Path) -> Result<()> {
    let before: Value = serde_json::from_slice(&std::fs::read(root.join("a01-before.json"))?)?;
    let expected: BTreeMap<String, Vec<Value>> =
        serde_json::from_value(before["workspace_tables"].clone())?;
    let mut summaries = vec![];
    for pass in 1..=2 {
        let app = Host::open(
            root,
            tokio::runtime::Handle::current(),
            Some("new-a01-model-route"),
        )?;
        assert_eq!(app.default_model, "new-a01-model-route");
        assert!(!app.permits_legacy_fixture_reasoning());
        assert!(app.workers.lock().unwrap().is_empty());
        assert!(app.profile_workers.lock().unwrap().is_empty());
        assert!(app.native_computers.is_none());
        {
            let state = app.lock()?;
            assert_eq!(profiles(&state.profiles)?, before["profiles"]);
            assert_eq!(state.profiles.len(), 5);
            assert!(
                state
                    .profiles
                    .values()
                    .all(|profile| profile.name != "primary"
                        && !profile.name.starts_with("specialist-")),
                "Bootstrap invented a default-name replacement"
            );
            let current = tables(&state.journal.0)?;
            for (table, rows) in &expected {
                if table == "workspace_objects" {
                    for row in rows {
                        ensure!(
                            current[table].contains(row),
                            "Original workspace object changed: {row}"
                        );
                    }
                    let additions = current[table]
                        .iter()
                        .filter(|row| !rows.contains(row))
                        .collect::<Vec<_>>();
                    ensure!(
                        additions.len() == 1
                            && additions[0][0] == "meta"
                            && additions[0][1] == "workspace_id",
                        "Unexpected workspace migration additions: {additions:?}"
                    );
                } else {
                    assert_eq!(
                        &current[table], rows,
                        "Original complete SQLite rows changed in {table}"
                    );
                }
            }
            let added = current
                .keys()
                .filter(|name| !expected.contains_key(*name))
                .map(String::as_str)
                .collect::<Vec<_>>();
            assert_eq!(added, vec!["lifetime_pi_effects", "lifetime_pi_executions"]);
            assert!(
                current["lifetime_pi_effects"].is_empty()
                    && current["lifetime_pi_executions"].is_empty()
            );
            assert_eq!(
                state
                    .journal
                    .0
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, u64>(0))?,
                16
            );
            assert_eq!(
                state.journal.0.query_row(
                    "SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_definition_active_v1'",
                    [],
                    |row| row.get::<_, u64>(0)
                )?,
                1
            );
            assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM workspace_objects WHERE kind='bot_definition_work_pin_v1'",[],|row|row.get::<_,u64>(0))?,1);
            let mut works = state
                .journal
                .0
                .prepare("SELECT payload FROM lifetime_work")?;
            let raw = works
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for raw in raw {
                let work: crate::lifetime_contract::Work = serde_json::from_str(&raw)?;
                let selected = super::bots_store::definition_for_work(&state.journal.0, &work)?;
                if work.owner == before["primary_id"].as_str().unwrap() {
                    assert!(
                        selected.is_some(),
                        "Original explicit primary definition pin lost"
                    );
                } else {
                    assert!(
                        selected.is_none(),
                        "Legacy Work acquired a definition implicitly"
                    );
                }
            }
            let primary: String = state.journal.0.query_row(
                "SELECT ghost_id FROM lifetime_registry WHERE kind='primary'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(primary, before["primary_id"]);
            assert_eq!(
                state.journal.0.query_row(
                    "SELECT COUNT(*) FROM lifetime_registry WHERE kind='primary'",
                    [],
                    |r| r.get::<_, u64>(0)
                )?,
                1
            );
            assert_eq!(
                state
                    .journal
                    .0
                    .query_row("SELECT COUNT(*) FROM lifetime_work", [], |r| r
                        .get::<_, u64>(0))?,
                4
            );
            assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_commands WHERE command_id LIKE 'primary-bootstrap:%' OR command_id LIKE 'specialist-bootstrap:%'",[],|r|r.get::<_,u64>(0))?,0);
        }
        for home in before["homes"].as_array().unwrap() {
            let marker = Path::new(home["marker"].as_str().unwrap());
            assert_eq!(json!(std::fs::read(marker)?), home["bytes"]);
            for key in ["home_volume", "task_snapshot_root", "browser_profile"] {
                assert!(
                    Path::new(home["manifest"][key].as_str().unwrap()).is_dir(),
                    "Original home path lost"
                );
            }
        }
        let registry = Connection::open_with_flags(
            root.join("registry/computer-registry.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        assert_eq!(json!(tables(&registry)?), before["computer_registry"]);
        summaries.push(json!({"pass":pass,"original_profiles":5,"persistent_registered_ghosts":4,"legacy_profiles":1,"original_works":4,"defined_pinned_works":1,"pre_b1_works_without_definitions_or_pins":3,"original_homes":5,"new_primary":0,"new_default_profiles":0,"schema":16,"model_inference":false}));
        app.shutdown().await?;
        drop(app);
    }
    std::fs::write(
        root.join("a01-result.json"),
        serde_json::to_vec_pretty(
            &json!({"classification":"synthetic schema14 preservation only; not installed migration or model acceptance","opens":summaries}),
        )?,
    )?;
    Ok(())
}
#[test]
fn a01_schema14_four_persistent_ghosts_and_legacy_profile_survive_new_model_open() -> Result<()> {
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(check_open(Path::new(&root)));
    }
    let directory = tempfile::tempdir()?;
    seed(directory.path())?;
    // Isolate startup environment from other tests and all installed routes.
    let output = ProcessCommand::new(std::env::current_exe()?)
        .args(["--exact", TEST_NAME, "--nocapture"])
        .env_clear()
        .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
        .env("HOME", directory.path())
        .env(CHILD_ROOT, directory.path())
        .env("GHOST_LIFETIME_MODE", "broker")
        .output()?;
    ensure!(
        output.status.success(),
        "A01 isolated startup failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("a01-result.json"))?)?;
    assert_eq!(result["opens"].as_array().unwrap().len(), 2);
    eprintln!("A01 preservation metadata {result}");
    Ok(())
}
