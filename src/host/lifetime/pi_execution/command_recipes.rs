//! One Host-issued recipe for an already authorized exact verifier command.
use super::*;

pub(super) fn views(conn: &Connection, work: &Work) -> Result<Vec<Value>> {
    let goal = db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Recipe Goal missing"))?;
    if goal.revision != work.goal_revision || !graph::current_result_scope(conn, work)? {
        return Ok(vec![]);
    }
    let verifier = &goal.acceptance_spec["verifier"];
    if verifier["kind"] != "pi-artifact/1" || !owner_expectations(conn, work, verifier)? {
        return Ok(vec![]);
    }
    let Some(command) = verifier["command"].as_str() else {
        return Ok(vec![]);
    };
    ensure!(
        !command.is_empty() && command.len() <= 32768 && !command.contains('\0'),
        "Recipe command invalid"
    );
    let reference = format!(
        "pc-{}",
        canonical_digest(
            &json!({"version":1,"work_id":work.id,"goal_id":goal.id,"goal_revision":work.goal_revision,"requirement_digest":goal.requirement_digest,"owner":work.owner,"owner_revision":work.owner_revision,"command":command})
        )?
    );
    Ok(vec![
        json!({"command_ref":reference,"name":"verifier-command","command":command}),
    ])
}

pub(super) fn resolve(conn: &Connection, work: &Work, args: &Value) -> Result<Value> {
    apply::allowed_fields(args, &["command", "command_ref", "timeout"], &[])?;
    ensure!(
        args.get("command").is_some() != args.get("command_ref").is_some(),
        "bash requires exactly one command or command_ref"
    );
    if let Some(timeout) = args.get("timeout") {
        ensure!(
            timeout
                .as_u64()
                .is_some_and(|value| (1..=180).contains(&value)),
            "bash timeout must be an integer from 1 to 180"
        );
    }
    if args.get("command_ref").is_none() {
        let command = apply::string_field(args, "command")?;
        ensure!(
            !command.is_empty() && command.len() <= 32768 && !command.contains('\0'),
            "bash command invalid"
        );
        return Ok(args.clone());
    }
    let reference = apply::string_field(args, "command_ref")?;
    ensure!(
        reference.len() == 67
            && reference.starts_with("pc-")
            && reference[3..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Command reference invalid"
    );
    let recipe = views(conn, work)?
        .into_iter()
        .find(|recipe| recipe["command_ref"] == reference)
        .ok_or_else(|| anyhow!("Command recipe has no current Owner authority or scope"))?;
    let mut result = json!({"command":recipe["command"]});
    if let Some(timeout) = args.get("timeout") {
        result["timeout"] = timeout.clone();
    }
    Ok(result)
}
fn key(execution: &str, task: u64, call: &str) -> Result<String> {
    canonical_digest(&json!(["pi-command-resolution/1", execution, task, call]))
}
fn binding(body: &Value, execution: &str, resolved: &Value) -> Value {
    json!({"version":1,"execution_id":execution,"work_id":body["work_id"],"task_id":body["task_id"],"call_id":body["call_id"],"input_digest":body["input_digest"],"arguments":body["arguments"],"resolved_arguments":resolved})
}
/// Called inside the same transaction as the original pending effect intent.
pub(super) fn bind(
    conn: &Connection,
    body: &Value,
    execution: &str,
    resolved: &Value,
) -> Result<()> {
    if body["arguments"].get("command_ref").is_none() {
        return Ok(());
    }
    let id = key(
        execution,
        apply::number_field(body, "task_id")?,
        apply::string_field(body, "call_id")?,
    )?;
    let payload = binding(body, execution, resolved);
    let prior: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='pi_command_resolution' AND id=?1",
            [&id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(prior) = prior {
        ensure!(
            serde_json::from_str::<Value>(&prior)? == payload,
            "Command resolution changed"
        );
    } else {
        conn.execute(
            "INSERT INTO workspace_objects(kind,id,payload) VALUES('pi_command_resolution',?1,?2)",
            params![id, serde_json::to_string(&payload)?],
        )?;
    }
    Ok(())
}
/// Replays validate current Owner scope and the original immutable resolution.
pub(super) fn check_binding(
    conn: &Connection,
    body: &Value,
    execution: &str,
    resolved: &Value,
) -> Result<()> {
    if body["arguments"].get("command_ref").is_none() {
        return Ok(());
    }
    let prior: String = conn.query_row(
        "SELECT payload FROM workspace_objects WHERE kind='pi_command_resolution' AND id=?1",
        [key(
            execution,
            apply::number_field(body, "task_id")?,
            apply::string_field(body, "call_id")?,
        )?],
        |r| r.get(0),
    )?;
    ensure!(
        serde_json::from_str::<Value>(&prior)? == binding(body, execution, resolved),
        "Command resolution binding mismatch"
    );
    Ok(())
}
/// Integrity is checked against the original effect bytes and its bound identity.
pub(super) fn receipt_command(
    conn: &Connection,
    execution: &str,
    task: u64,
    call: &str,
    digest: &str,
    args: &Value,
) -> Result<Option<String>> {
    if args.get("command_ref").is_none() {
        return Ok(args["command"].as_str().map(str::to_owned));
    }
    let stored: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='pi_command_resolution' AND id=?1",
            [key(execution, task, call)?],
            |r| r.get(0),
        )
        .optional()?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&stored)?;
    ensure!(
        value["version"] == 1
            && value["execution_id"] == execution
            && value["task_id"] == task
            && value["call_id"] == call
            && value["input_digest"] == digest
            && value["arguments"] == *args
            && canonical_digest(&json!({"operation":"bash","arguments":args}))? == digest,
        "Verifier command resolution provenance mismatch"
    );
    Ok(value["resolved_arguments"]["command"]
        .as_str()
        .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{envelope, request, setup_with_spec, verifier_spec};
    use super::*;
    fn spec() -> Value {
        let mut spec = verifier_spec("recipe-output");
        spec["verifier"]["command"] =
            json!("test $(cat answer.txt) = recipe-output && printf verified");
        spec["verifier"]["expected_stdout"] = json!("verified");
        spec
    }
    #[tokio::test]
    async fn command_recipe_exact_owner_scope_and_strict_ref_union() -> Result<()> {
        let f = setup_with_spec(spec());
        let state = f.host.lock()?;
        let conn = &state.journal.0;
        let work = db::work(conn, &f.work)?.unwrap();
        let recipes = views(conn, &work)?;
        assert_eq!(recipes.len(), 1);
        let reference = &recipes[0]["command_ref"];
        let raw = resolve(conn, &work, &json!({"command_ref":reference,"timeout":180}))?;
        assert_eq!(
            raw,
            json!({"command":spec()["verifier"]["command"],"timeout":180})
        );
        for args in [
            json!({}),
            json!({"command_ref":null}),
            json!({"command_ref":reference,"command":"printf forged"}),
            json!({"command_ref":format!("pc-{}","0".repeat(64))}),
            json!({"command_ref":reference,"timeout":null}),
            json!({"command_ref":reference,"timeout":181}),
            json!({"command_ref":reference,"timeout":1.5}),
            json!({"command":null}),
        ] {
            assert!(resolve(conn, &work, &args).is_err(), "{args}");
        }
        assert_eq!(
            resolve(conn, &work, &json!({"command":"printf legacy"}))?,
            json!({"command":"printf legacy"})
        );
        let goal = db::goal(conn, &work.goal_id)?.unwrap();
        let mut update = envelope(
            "owner",
            json!({"method":"goal.update","goal_id":goal.id,"prompt":"Owner changed requirement","acceptance_spec":spec()}),
        );
        update.expected_revision = Some(goal.revision);
        assert_eq!(
            super::super::super::apply(conn, &update, "owner")?.status,
            ResponseStatus::Success
        );
        let current = db::works_for_goal(conn, &goal.id)?
            .into_iter()
            .find(|work| work.goal_revision == goal.revision + 1)
            .unwrap();
        assert!(resolve(conn, &current, &json!({"command_ref":reference})).is_err());
        Ok(())
    }
    #[tokio::test]
    async fn command_recipe_model_authored_expectation_never_issues_ref() -> Result<()> {
        let f = setup_with_spec(json!({}));
        let state = f.host.lock()?;
        let conn = &state.journal.0;
        let turn = uuid::Uuid::new_v4().to_string();
        conn.execute("INSERT INTO lifetime_turns(id,ghost_id,conversation_id,sequence,sender_kind,sender_ref,text,privacy,kind,source_turn_id,attachments,created_at_ms) VALUES(?1,?2,?3,1,'owner','owner','produce an answer','public','user',NULL,'[]',1)",params![turn,f.ghost,f.conversation])?;
        conn.execute("INSERT INTO lifetime_turn_runs(turn_id,ghost_id,conversation_id,state,cancel_requested,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,'queued',0,1,1)",params![turn,f.ghost,f.conversation])?;
        let response = super::super::super::apply(
            conn,
            &envelope(
                &f.ghost,
                json!({"method":"goal.create","turn_id":turn,"ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"produce an answer","acceptance_spec":spec()}),
            ),
            &f.ghost,
        )?;
        let work: Work = serde_json::from_value(response.data["work"].clone())?;
        assert!(views(conn, &work)?.is_empty());
        Ok(())
    }
    #[tokio::test]
    async fn command_recipe_resolution_atomic_original_digest_and_cold_replay_provenance(
    ) -> Result<()> {
        let f = setup_with_spec(spec());
        let state = f.host.lock()?;
        let conn = &state.journal.0;
        let work = db::work(conn, &f.work)?.unwrap();
        let reference = views(conn, &work)?[0]["command_ref"].clone();
        let request = request(
            &f,
            20,
            "recipe",
            "bash",
            json!({"command_ref":reference,"timeout":10}),
        );
        let body = &request.envelope.body;
        let resolved = resolve(conn, &work, &body["arguments"])?;
        {
            let tx = conn.unchecked_transaction()?;
            bind(&tx, body, "execution-fixture", &resolved)?;
        }
        assert!(
            check_binding(conn, body, "execution-fixture", &resolved).is_err(),
            "Rolled-back admission must not leave a command resolution"
        );
        {
            let tx = conn.unchecked_transaction()?;
            bind(&tx, body, "execution-fixture", &resolved)?;
            tx.commit()?;
        }
        check_binding(conn, body, "execution-fixture", &resolved)?;
        let reopened = crate::host::scheduler::Journal::open(&f._root.path().join("workspace.db"))?;
        check_binding(&reopened.0, body, "execution-fixture", &resolved)?;
        let digest = body["input_digest"].as_str().unwrap();
        assert_eq!(
            receipt_command(
                &reopened.0,
                "execution-fixture",
                20,
                "recipe",
                digest,
                &body["arguments"]
            )?
            .as_deref(),
            resolved["command"].as_str()
        );
        assert_eq!(
            body["arguments"],
            json!({"command_ref":reference,"timeout":10})
        );
        assert!(receipt_command(
            &reopened.0,
            "execution-fixture",
            20,
            "recipe",
            &"0".repeat(64),
            &body["arguments"]
        )
        .is_err());
        assert!(receipt_command(
            &reopened.0,
            "execution-fixture",
            20,
            "different-call",
            digest,
            &body["arguments"]
        )?
        .is_none());
        let mut forged = resolved.clone();
        forged["command"] = json!("printf forged");
        assert!(check_binding(conn, body, "execution-fixture", &forged).is_err());
        Ok(())
    }
    #[tokio::test]
    async fn command_recipe_unknown_effect_blocks_new_call_before_recipe_resolution() -> Result<()>
    {
        let f = setup_with_spec(spec());
        let first = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    10,
                    "write",
                    "write",
                    json!({"path":"answer.txt","content":"recipe-output"}),
                ),
                PiInferenceScope::Public,
            )
            .await?;
        let execution = first.data["receipt"]["execution_id"].as_str().unwrap();
        {
            let state = f.host.lock()?;
            state.journal.0.execute("UPDATE lifetime_pi_effects SET state='pending',response_json=NULL WHERE execution_id=?1",[execution])?;
        }
        let response = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    30,
                    "forged-after-unknown",
                    "bash",
                    json!({"command_ref":format!("pc-{}","0".repeat(64))}),
                ),
                PiInferenceScope::Public,
            )
            .await?;
        assert_eq!(response.error_code.as_deref(), Some("effect_unknown"));
        let state = f.host.lock()?;
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_command_resolution'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            0
        );
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1",
                [execution],
                |r| r.get::<_, u64>(0)
            )?,
            1
        );
        Ok(())
    }
    #[tokio::test]
    async fn command_recipe_denied_receipt_replays_without_pending_shell_intent() -> Result<()> {
        let f = setup_with_spec(spec());
        for (index, args) in [
            json!({"command_ref":null}),
            json!({"command_ref":format!("pc-{}","0".repeat(64))}),
            json!({"command_ref":format!("pc-{}","0".repeat(64)),"command":"printf forged"}),
        ]
        .into_iter()
        .enumerate()
        {
            let tool = request(
                &f,
                30 + index as u64,
                &format!("denied-{index}"),
                "bash",
                args,
            );
            let first = f
                .host
                .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
                .await?;
            assert_eq!(first.data["receipt"]["state"], "denied");
            assert_eq!(
                first,
                f.host
                    .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
                    .await?
            );
        }
        let state = f.host.lock()?;
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_pi_effects WHERE state<>'complete'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            0
        );
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_command_resolution'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            0
        );
        Ok(())
    }
    #[tokio::test]
    async fn command_recipe_pending_reservation_survives_cold_journal_without_dispatch(
    ) -> Result<()> {
        let f = setup_with_spec(spec());
        let first = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    10,
                    "write",
                    "write",
                    json!({"path":"answer.txt","content":"recipe-output"}),
                ),
                PiInferenceScope::Public,
            )
            .await?;
        let execution = first.data["receipt"]["execution_id"].as_str().unwrap();
        let tool = {
            let state = f.host.lock()?;
            let conn = &state.journal.0;
            let work = db::work(conn, &f.work)?.unwrap();
            request(
                &f,
                20,
                "reserved-recipe",
                "bash",
                json!({"command_ref":views(conn,&work)?[0]["command_ref"]}),
            )
        };
        {
            let state = f.host.lock()?;
            let conn = &state.journal.0;
            let work = db::work(conn, &f.work)?.unwrap();
            let body = &tool.envelope.body;
            let tx = conn.unchecked_transaction()?;
            bind(
                &tx,
                body,
                execution,
                &resolve(&tx, &work, &body["arguments"])?,
            )?;
            tx.execute("INSERT INTO lifetime_pi_effects(execution_id,task_id,call_id,input_digest,operation,arguments_json,state) VALUES(?1,20,'reserved-recipe',?2,'bash',?3,'pending')",params![execution,body["input_digest"].as_str().unwrap(),serde_json::to_string(&body["arguments"])?])?;
            tx.commit()?;
        }
        let reopened = crate::host::scheduler::Journal::open(&f._root.path().join("workspace.db"))?;
        let work = db::work(&reopened.0, &f.work)?.unwrap();
        check_binding(
            &reopened.0,
            &tool.envelope.body,
            execution,
            &resolve(&reopened.0, &work, &tool.envelope.body["arguments"])?,
        )?;
        let response = f
            .host
            .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
            .await?;
        assert_eq!(response.error_code.as_deref(), Some("effect_unknown"));
        let new = request(
            &f,
            21,
            "new-recipe",
            "bash",
            tool.envelope.body["arguments"].clone(),
        );
        assert_eq!(
            f.host
                .lifetime_pi_execution_action(&new, PiInferenceScope::Public)
                .await?
                .error_code
                .as_deref(),
            Some("effect_unknown")
        );
        assert_eq!(
            reopened.0.query_row(
                "SELECT COUNT(*) FROM lifetime_pi_effects WHERE operation='bash'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            1
        );
        Ok(())
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "physical exact recipe dispatch and lost-ACK replay; existing Apple service/image only"]
    async fn real_pi_command_recipe_exact_dispatch_receipt_replay_and_independent_acceptance(
    ) -> Result<()> {
        ensure!(
            std::env::var("GHOST_PI_RUN_PHYSICAL_CANARY").as_deref() == Ok("1"),
            "Explicit physical opt-in required"
        );
        let mut sealed = spec();
        sealed["required_checks"] = json!([
            "artifact_sha256",
            "artifact_content",
            "command_success",
            "command_stdout"
        ]);
        sealed["verifier"]["command"] =
            json!("test ! -e once && printf once > once && printf verified");
        let mut f = setup_with_spec(sealed);
        f.host
            .native_computers
            .as_mut()
            .unwrap()
            .set_pi_fixture_cli(std::path::Path::new("/opt/homebrew/bin/container"))?;
        let reference = {
            let state = f.host.lock()?;
            let work = db::work(&state.journal.0, &f.work)?.unwrap();
            views(&state.journal.0, &work)?[0]["command_ref"].clone()
        };
        let tool = request(
            &f,
            20,
            "once-recipe",
            "bash",
            json!({"command_ref":reference,"timeout":10}),
        );
        let first = f
            .host
            .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
            .await?;
        assert_eq!(first.status, ResponseStatus::Success, "{first:?}");
        assert_eq!(first.data["output"]["stdout"], "verified");
        assert_eq!(
            first,
            f.host
                .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
                .await?,
            "Lost ACK must return original receipt without dispatching the once-only command"
        );
        let complete = super::super::tests::publish_complete(&f, "recipe-output").await;
        assert_eq!(
            complete.data["verification"]["status"], "success",
            "{complete:?}"
        );
        let state = f.host.lock()?;
        assert_eq!(
            db::work(&state.journal.0, &f.work)?.unwrap().state,
            "accepted"
        );
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_pi_effects WHERE operation='bash'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            1
        );
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            0
        );
        Ok(())
    }
}
