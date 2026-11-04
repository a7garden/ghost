//! Versioned bot metadata in the existing workspace journal. Call mutations
//! only inside the lifetime command transaction: definitions, pointer and
//! receipt then commit together, without external I/O or policy changes.
use super::bots::BotDefinition;
use crate::lifetime_contract::{Envelope, Response, ResponseStatus, RetryClass, Work};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFINITIONS: &str = "bot_definition_v1";
const POINTERS: &str = "bot_definition_active_v1";
const WORK_PINS: &str = "bot_definition_work_pin_v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DefinitionPointer {
    pub ghost_id: String,
    pub revision: u64,
    pub digest: String,
}
impl From<&BotDefinition> for DefinitionPointer {
    fn from(definition: &BotDefinition) -> Self {
        Self {
            ghost_id: definition.ghost_id.clone(),
            revision: definition.revision,
            digest: definition.digest.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct WorkPin {
    work_id: String,
    ghost_id: String,
    goal_revision: u64,
    owner_revision: u64,
    definition: Option<DefinitionPointer>,
}

fn load<T: for<'de> Deserialize<'de>>(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> Result<Option<T>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![kind, id],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

pub(crate) fn definition(
    conn: &Connection,
    ghost_id: &str,
    revision: u64,
) -> Result<Option<BotDefinition>> {
    let definition: Option<BotDefinition> =
        load(conn, DEFINITIONS, &format!("{ghost_id}:{revision}"))?;
    if let Some(definition) = &definition {
        definition.validate()?;
        ensure!(
            definition.ghost_id == ghost_id && definition.revision == revision,
            "stored definition identity conflicts with its journal key"
        );
    }
    Ok(definition)
}

pub(crate) fn active_definition(
    conn: &Connection,
    ghost_id: &str,
) -> Result<Option<BotDefinition>> {
    let Some(pointer) = load::<DefinitionPointer>(conn, POINTERS, ghost_id)? else {
        return Ok(None);
    };
    resolve_pointer(conn, ghost_id, &pointer).map(Some)
}

fn resolve_pointer(
    conn: &Connection,
    ghost_id: &str,
    pointer: &DefinitionPointer,
) -> Result<BotDefinition> {
    ensure!(
        pointer.ghost_id == ghost_id,
        "definition pointer changes Ghost identity"
    );
    let definition = definition(conn, ghost_id, pointer.revision)?
        .ok_or_else(|| anyhow!("pinned bot definition is missing"))?;
    ensure!(
        definition.digest == pointer.digest,
        "pinned bot definition digest mismatch"
    );
    Ok(definition)
}

fn pin_key(work: &Work) -> String {
    format!("{}:{}:{}", work.id, work.goal_revision, work.owner_revision)
}

/// Admission-only hook. An explicit empty pin records legacy behavior, so
/// publishing a definition later cannot change an already admitted Work.
pub(crate) fn pin_work(conn: &Connection, work: &Work) -> Result<()> {
    let key = pin_key(work);
    let pin = WorkPin {
        work_id: work.id.clone(),
        ghost_id: work.owner.clone(),
        goal_revision: work.goal_revision,
        owner_revision: work.owner_revision,
        definition: active_definition(conn, &work.owner)?
            .as_ref()
            .map(DefinitionPointer::from),
    };
    if let Some(existing) = load::<WorkPin>(conn, WORK_PINS, &key)? {
        ensure!(existing == pin, "Work definition pin is immutable");
        return Ok(());
    }
    conn.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![WORK_PINS, key, serde_json::to_string(&pin)?],
    )?;
    Ok(())
}

/// Read-only. A pre-feature Work without a pin keeps legacy semantics; reads
/// never adopt the current definition or create a record.
pub(crate) fn definition_for_work(conn: &Connection, work: &Work) -> Result<Option<BotDefinition>> {
    let Some(pin) = load::<WorkPin>(conn, WORK_PINS, &pin_key(work))? else {
        return Ok(None);
    };
    ensure!(
        pin.work_id == work.id
            && pin.ghost_id == work.owner
            && pin.goal_revision == work.goal_revision
            && pin.owner_revision == work.owner_revision,
        "Work definition pin scope mismatch"
    );
    pin.definition
        .map(|pointer| resolve_pointer(conn, &work.owner, &pointer))
        .transpose()
}

fn response(status: ResponseStatus, code: Option<&str>, summary: &str, data: Value) -> Response {
    Response {
        status,
        summary: summary.into(),
        object_refs: vec![],
        artifacts: vec![],
        next_actions: vec![],
        error_code: code.map(str::to_owned),
        retry_class: if code.is_none() {
            RetryClass::SameId
        } else if code == Some("conflict") {
            RetryClass::NewRevision
        } else {
            RetryClass::Never
        },
        data,
    }
}
fn error(code: &str, summary: &str) -> Response {
    response(ResponseStatus::Error, Some(code), summary, Value::Null)
}

/// Owner control commands share lifetime authority checks and exact command
/// receipts. No model callback or remembered claim is an owner credential.
pub(crate) fn apply_owner(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    if principal != "owner" {
        return Ok(error(
            "unauthorized",
            "bot definition changes require authenticated owner",
        ));
    }
    let Some(body) = envelope.body.as_object() else {
        return Ok(error(
            "invalid_request",
            "bot definition request must be an object",
        ));
    };
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let allowed = match method {
        "bot.definition.update" => &["method", "definition"][..],
        "bot.definition.inspect" => &["method", "ghost_id", "revision"][..],
        _ => {
            return Ok(error(
                "unsupported_method",
                "unsupported bot definition method",
            ))
        }
    };
    if body.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Ok(error("invalid_request", "unexpected bot definition field"));
    }
    if method == "bot.definition.inspect" {
        let Some(ghost_id) = body.get("ghost_id").and_then(Value::as_str) else {
            return Ok(error("invalid_request", "missing Ghost identity"));
        };
        let selected = if let Some(revision) = body.get("revision") {
            let Some(revision) = revision.as_u64().filter(|value| *value > 0) else {
                return Ok(error("invalid_request", "invalid definition revision"));
            };
            definition(conn, ghost_id, revision)?
        } else {
            active_definition(conn, ghost_id)?
        };
        return Ok(response(
            ResponseStatus::Success,
            None,
            "Bot definition inspected",
            json!({
                "definition":selected,"readiness":"not_evaluated","grants_changed":false
            }),
        ));
    }
    let definition: BotDefinition =
        match body.get("definition").cloned().map(serde_json::from_value) {
            Some(Ok(value)) => value,
            _ => return Ok(error("invalid_request", "invalid bot definition")),
        };
    select_definition(conn, definition, envelope.expected_revision)
}

/// Internal B4 activation hook. The caller must already hold the authenticated
/// owner operation's lifetime transaction and validate provisioning readiness.
/// This helper selects metadata only and never supplies Owner authentication.
pub(crate) fn select_definition(
    conn: &Connection,
    definition: BotDefinition,
    expected_revision: Option<u64>,
) -> Result<Response> {
    if definition.validate().is_err() || i64::try_from(definition.revision).is_err() {
        return Ok(error(
            "invalid_request",
            "invalid bot definition identity, revision, content or digest",
        ));
    }
    // Host also checks the actual profile; requiring its registered identity
    // here keeps the lower-level lifetime entry point from inventing a bot.
    let registered: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
        [&definition.ghost_id],
        |row| row.get(0),
    )?;
    if !registered {
        return Ok(error("not_found", "bot Ghost is not registered"));
    }
    let previous = active_definition(conn, &definition.ghost_id)?;
    if previous.as_ref().map(|value| value.revision) != expected_revision {
        return Ok(error("conflict", "active bot definition revision changed"));
    }
    if let Some(previous) = &previous {
        if definition.validate_successor(previous).is_err() {
            return Ok(error(
                "conflict",
                "definition update must keep its identity and advance one revision",
            ));
        }
    } else if definition.revision != 1 {
        return Ok(error(
            "conflict",
            "first bot definition revision must be one",
        ));
    }
    let key = format!("{}:{}", definition.ghost_id, definition.revision);
    if load::<BotDefinition>(conn, DEFINITIONS, &key)?.is_some() {
        return Ok(error(
            "conflict",
            "immutable bot definition revision already exists",
        ));
    }
    conn.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![DEFINITIONS, key, serde_json::to_string(&definition)?],
    )?;
    let pointer = serde_json::to_string(&DefinitionPointer::from(&definition))?;
    if let Some(previous) = previous {
        let expected = serde_json::to_string(&DefinitionPointer::from(&previous))?;
        let changed = conn.execute(
            "UPDATE workspace_objects SET payload=?1 WHERE kind=?2 AND id=?3 AND payload=?4",
            params![pointer, POINTERS, definition.ghost_id, expected],
        )?;
        ensure!(changed == 1, "bot definition pointer CAS failed");
    } else {
        conn.execute(
            "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
            params![POINTERS, definition.ghost_id, pointer],
        )?;
    }
    Ok(response(
        ResponseStatus::Success,
        None,
        "Bot definition revision selected; resource grants are unchanged",
        json!({"definition":definition,"readiness":"not_evaluated","grants_changed":false}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{
        bots::{DefinitionContent, RevisionRef},
        lifetime,
    };
    use crate::lifetime_contract::{canonical_digest, VERSION};

    const GHOST: &str = "01930000-0000-7000-8000-000000000001";
    const CONVERSATION: &str = "01930000-0000-7000-8000-000000000002";

    fn initialize(conn: &Connection) {
        conn.execute_batch("CREATE TABLE workspace_objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));").unwrap();
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
            conn.execute_batch(migration).unwrap();
        }
        let request = request(
            "register",
            None,
            json!({"method":"registry.ensure","ghost_id":GHOST,
            "kind":"primary","conversation_id":CONVERSATION,"roles":["coordination"]}),
        );
        assert_success(&lifetime::apply(conn, &request, "owner").unwrap());
        conn.execute(
            "INSERT INTO workspace_objects VALUES('profile',?1,?2)",
            params![
                GHOST,
                r#"{"id":"01930000-0000-7000-8000-000000000001","persona":"original bytes"}"#
            ],
        )
        .unwrap();
    }
    fn request(id: &str, expected_revision: Option<u64>, body: Value) -> Envelope {
        Envelope {
            protocol_version: VERSION.into(),
            command_id: id.into(),
            payload_digest: canonical_digest(&body).unwrap(),
            actor_ref: "owner".into(),
            authority_epoch: 1,
            expected_revision,
            correlation_id: id.into(),
            body,
        }
    }
    fn definition_fixture(revision: u64) -> BotDefinition {
        let reference = |id: &str| RevisionRef {
            namespace: "owner".into(),
            id: id.into(),
            revision: 1,
            digest: "a".repeat(64),
        };
        BotDefinition::new(
            GHOST.into(),
            revision,
            DefinitionContent {
                purpose: format!("comparison revision {revision}"),
                input_contract: json!({"type":"object"}),
                output_contract: json!({"type":"object"}),
                instruction_ref: reference("instructions"),
                skill_refs: vec![],
                skill_aliases: Default::default(),
                acceptance_policy_ref: reference("review"),
                required_capabilities: vec!["read".into()],
                memory_profile_ref: None,
                execution_profile_ref: reference("isolated"),
            },
        )
        .unwrap()
    }
    fn update(conn: &Connection, id: &str, revision: u64, expected: Option<u64>) -> Response {
        lifetime::apply(
            conn,
            &request(
                id,
                expected,
                json!({"method":"bot.definition.update","definition":definition_fixture(revision)}),
            ),
            "owner",
        )
        .unwrap()
    }
    fn assert_success(response: &Response) {
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    }
    fn submit(conn: &Connection, id: &str) -> (String, Work) {
        let response = lifetime::apply(conn, &request(id, None, json!({"method":"goal.submit","ghost_id":GHOST,
            "conversation_id":CONVERSATION,"prompt":"Compare the supplied products","privacy":"public",
            "acceptance_spec":{"required_checks":["artifact_content"]}})), "owner").unwrap();
        assert_success(&response);
        (
            response.data["goal"]["id"].as_str().unwrap().into(),
            serde_json::from_value(response.data["work"].clone()).unwrap(),
        )
    }
    #[test]
    fn owner_api_cas_exact_retry_and_cold_reopen_preserve_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspace.db");
        let conn = Connection::open(&path).unwrap();
        initialize(&conn);
        let first = update(&conn, "definition-one", 1, None);
        assert_success(&first);
        assert_eq!(update(&conn, "definition-one", 1, None), first);
        assert_success(&update(&conn, "definition-two", 2, Some(1)));
        assert_eq!(
            update(&conn, "stale-writer", 2, Some(1))
                .error_code
                .as_deref(),
            Some("conflict")
        );
        assert_eq!(
            update(&conn, "skip-revision", 4, Some(2))
                .error_code
                .as_deref(),
            Some("conflict")
        );
        let inspect = request(
            "inspect-old",
            None,
            json!({"method":"bot.definition.inspect","ghost_id":GHOST,"revision":1}),
        );
        assert_eq!(
            lifetime::apply(&conn, &inspect, "owner").unwrap().data["definition"],
            serde_json::to_value(definition_fixture(1)).unwrap()
        );
        let original: String = conn
            .query_row(
                "SELECT payload FROM workspace_objects WHERE kind='profile' AND id=?1",
                [GHOST],
                |row| row.get(0),
            )
            .unwrap();
        assert!(original.contains("original bytes"));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM lifetime_registry WHERE kind='primary'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(conn);
        let cold = Connection::open(&path).unwrap();
        assert_eq!(
            active_definition(&cold, GHOST).unwrap().unwrap(),
            definition_fixture(2)
        );
        assert_eq!(
            definition(&cold, GHOST, 1).unwrap().unwrap(),
            definition_fixture(1)
        );
        assert_eq!(update(&cold, "definition-one", 1, None), first);
    }
    #[test]
    fn old_work_pin_and_explicit_legacy_pin_survive_definition_update() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn);
        let (_, legacy) = submit(&conn, "legacy-work");
        assert!(definition_for_work(&conn, &legacy).unwrap().is_none());
        assert_success(&update(&conn, "definition-one", 1, None));
        let (goal_id, admitted) = submit(&conn, "new-work");
        assert_eq!(
            definition_for_work(&conn, &admitted)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert_success(&update(&conn, "definition-two", 2, Some(1)));
        assert!(definition_for_work(&conn, &legacy).unwrap().is_none());
        assert_eq!(
            definition_for_work(&conn, &admitted)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        let revision = lifetime::apply(&conn, &request("goal-revision",Some(1), json!({"method":"goal.update",
            "goal_id":goal_id,"prompt":"Compare a new input","acceptance_spec":{"required_checks":["artifact_content"]}})),"owner").unwrap();
        assert_success(&revision);
        let current: Work = serde_json::from_value(revision.data["work"][0].clone()).unwrap();
        assert_eq!(current.goal_revision, 2);
        assert_eq!(
            definition_for_work(&conn, &current)
                .unwrap()
                .unwrap()
                .revision,
            2
        );
        assert_eq!(
            definition_for_work(&conn, &admitted)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        // Model callbacks and reads cannot adopt a newly selected definition.
        conn.execute(
            "DELETE FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![WORK_PINS, pin_key(&legacy)],
        )
        .unwrap();
        assert!(definition_for_work(&conn, &legacy).unwrap().is_none());
        assert!(load::<WorkPin>(&conn, WORK_PINS, &pin_key(&legacy))
            .unwrap()
            .is_none());
    }
    #[test]
    fn unauthorized_fenced_and_invalid_updates_leave_no_revision() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn);
        let mut denied = request(
            "forged-owner",
            None,
            json!({"method":"bot.definition.update","definition":definition_fixture(1)}),
        );
        denied.actor_ref = GHOST.into();
        assert_eq!(
            lifetime::apply(&conn, &denied, GHOST)
                .unwrap()
                .error_code
                .as_deref(),
            Some("unauthorized")
        );
        let mut fenced = request("fenced", None, denied.body.clone());
        fenced.authority_epoch = 2;
        assert_eq!(
            lifetime::apply(&conn, &fenced, "owner")
                .unwrap()
                .error_code
                .as_deref(),
            Some("authority_fenced")
        );
        let mut invalid = definition_fixture(1);
        invalid.content.purpose = "tampered".into();
        let invalid = request(
            "tampered",
            None,
            json!({"method":"bot.definition.update","definition":invalid}),
        );
        assert_eq!(
            lifetime::apply(&conn, &invalid, "owner")
                .unwrap()
                .error_code
                .as_deref(),
            Some("invalid_request")
        );
        assert!(active_definition(&conn, GHOST).unwrap().is_none());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM workspace_objects WHERE kind=?1",
                [DEFINITIONS],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_success(&update(&conn, "definition-one", 1, None));
        conn.execute("UPDATE lifetime_authority SET dispatch_enabled=0", [])
            .unwrap();
        let inspect = request(
            "read-only-inspect",
            None,
            json!({"method":"bot.definition.inspect","ghost_id":GHOST}),
        );
        assert_success(&lifetime::apply(&conn, &inspect, "owner").unwrap());
        assert_eq!(
            update(&conn, "read-only-update", 2, Some(1))
                .error_code
                .as_deref(),
            Some("dispatch_off")
        );
    }

    #[tokio::test]
    async fn public_host_control_requires_actual_profile_and_preserves_persona() {
        use crate::control::api::{Action, Command};
        let root = tempfile::tempdir().unwrap();
        let host =
            crate::host::Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock"))
                .unwrap();
        let profile = host
            .action(Action {
                request_id: uuid::Uuid::now_v7().to_string(),
                command: Command::CreateProfile {
                    name: "definition-owner".into(),
                    persona: "preserve this exact persona".into(),
                },
            })
            .unwrap();
        let ghost_id = profile["result"]["profile_id"].as_str().unwrap();
        let conversation_id = uuid::Uuid::now_v7().to_string();
        let control = |envelope: Envelope| {
            host.action(Action {
                request_id: uuid::Uuid::now_v7().to_string(),
                command: Command::Lifetime { envelope },
            })
            .unwrap()
        };
        let registered = control(request(
            "register-existing-profile",
            None,
            json!({"method":"registry.ensure",
            "ghost_id":ghost_id,"kind":"specialist","conversation_id":conversation_id,"roles":["comparison"]}),
        ));
        assert_eq!(registered["result"]["status"], "success");
        let selected =
            BotDefinition::new(ghost_id.into(), 1, definition_fixture(1).content).unwrap();
        let published = control(request(
            "publish-existing-profile",
            None,
            json!({"method":"bot.definition.update","definition":selected}),
        ));
        assert_eq!(published["result"]["status"], "success", "{published}");
        assert_eq!(published["result"]["data"]["grants_changed"], false);
        assert_eq!(published["result"]["data"]["readiness"], "not_evaluated");
        let missing = control(request(
            "missing-real-profile",
            None,
            json!({"method":"bot.definition.update","definition":definition_fixture(1)}),
        ));
        assert_eq!(missing["ok"], false);
        assert_eq!(
            host.lock().unwrap().profiles[ghost_id].persona,
            "preserve this exact persona"
        );
        host.shutdown().await.unwrap();
    }

    #[test]
    fn pointer_failure_rolls_back_new_revision_and_retry_uses_same_command() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn);
        assert_success(&update(&conn, "definition-one", 1, None));
        conn.execute_batch("CREATE TEMP TRIGGER fail_bot_pointer BEFORE UPDATE ON workspace_objects
            WHEN NEW.kind='bot_definition_active_v1' BEGIN SELECT RAISE(ABORT,'fixture pointer failure'); END;").unwrap();
        let request = request(
            "definition-two",
            Some(1),
            json!({"method":"bot.definition.update","definition":definition_fixture(2)}),
        );
        assert!(lifetime::apply(&conn, &request, "owner").is_err());
        assert!(definition(&conn, GHOST, 2).unwrap().is_none());
        assert_eq!(
            active_definition(&conn, GHOST).unwrap().unwrap().revision,
            1
        );
        conn.execute_batch("DROP TRIGGER fail_bot_pointer;")
            .unwrap();
        assert_success(&lifetime::apply(&conn, &request, "owner").unwrap());
        assert_eq!(
            active_definition(&conn, GHOST).unwrap().unwrap().revision,
            2
        );
    }

    #[test]
    fn corrupted_pinned_revision_is_never_replaced_by_current_definition() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn);
        assert_success(&update(&conn, "definition-one", 1, None));
        let (_, work) = submit(&conn, "admit-one");
        assert_success(&update(&conn, "definition-two", 2, Some(1)));
        conn.execute("UPDATE workspace_objects SET payload=json_set(payload,'$.content.purpose','changed outside owner API') WHERE kind=?1 AND id=?2",
            params![DEFINITIONS,format!("{GHOST}:1")]).unwrap();
        assert!(definition_for_work(&conn, &work).is_err());
        assert_eq!(
            active_definition(&conn, GHOST).unwrap().unwrap().revision,
            2
        );
    }
}
