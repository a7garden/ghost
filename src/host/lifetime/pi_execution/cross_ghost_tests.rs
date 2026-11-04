//! Explicit live Pi → Host → isolated Apple containers across two Ghosts.
//! Only disposable synthetic state. The JSONL bridge replaces the HTTP socket.
use super::{
    db,
    tests::{envelope, setup_with_spec, verifier_spec},
    PiInferenceScope, PiToolRequest,
};
use crate::{
    host::{self, Host, State},
    lifetime_contract::ResponseStatus,
    store::ProfileStore,
};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::{collections::BTreeMap, fs::File, path::Path, sync::atomic::AtomicBool, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};

struct Evidence {
    path: std::path::PathBuf,
    success: bool,
}
impl Drop for Evidence {
    fn drop(&mut self) {
        if !self.success {
            eprintln!("B7 synthetic evidence retained: {}", self.path.display());
        } else {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
struct Bridge {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: Lines<BufReader<tokio::process::ChildStdout>>,
    commands: u64,
    callbacks: u64,
    model_calls: u64,
    methods: Vec<String>,
    effects: Vec<(PiToolRequest, Value)>,
}
impl Bridge {
    async fn frame(&mut self, host: &Host) -> Result<Value> {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(310), self.output.next_line())
                .await??
                .ok_or_else(|| anyhow::anyhow!("Cross-Ghost bridge exited"))?;
            ensure!(line.len() <= 1_048_576, "Bridge frame exceeds bound");
            let frame: Value = serde_json::from_str(&line)?;
            if frame["type"] != "callback" {
                ensure!(frame["type"] != "failure", "Bridge failure: {frame}");
                self.model_calls = frame["model_calls"].as_u64().unwrap_or(self.model_calls);
                return Ok(frame);
            }
            self.callbacks += 1;
            ensure!(
                self.callbacks <= 1000,
                "Cross-Ghost callback budget exceeded"
            );
            let request: PiToolRequest = serde_json::from_value(frame["request"].clone())?;
            let method = request.envelope.body["method"].as_str().unwrap_or("");
            self.methods.push(method.into());
            let result = host
                .lifetime_pi_action(&request, host::lifetime::test_callback_inference_scope(&frame))
                .await?;
            if method == "work.execute" && result["result"]["status"] == "success" {
                self.effects
                    .push((request.clone(), result["result"].clone()));
            }
            if matches!(
                method,
                "work.execute" | "work.delegate" | "work.wait" | "work.execution.complete"
            ) {
                eprintln!(
                    "B7 callback {}",
                    json!({"ghost":request.ghost_id,"method":method,"operation":request.envelope.body["operation"],"status":result["result"]["status"],"code":result["result"]["error_code"]})
                );
            }
            self.input
                .write_all(
                    format!(
                        "{}\n",
                        json!({"type":"callback_result","id":frame["id"],"frame":result})
                    )
                    .as_bytes(),
                )
                .await?;
            self.input.flush().await?;
        }
    }
    async fn start(host: &Host) -> Result<Self> {
        let mut child = tokio::process::Command::new("/opt/homebrew/bin/node")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("apps/ghost-durable/scripts/bot-live-canary.mjs"),
            )
            .env_clear()
            .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
            .env("HOME", &host.root)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        input.write_all(format!("{}\n",json!({"type":"config","root":host.root.join("pi-cross-store"),"host_root":host.root,"authority_epoch":1,"allow_work_parks":true})).as_bytes()).await?;
        input.flush().await?;
        let mut bridge = Self {
            child,
            input,
            output,
            commands: 0,
            callbacks: 0,
            model_calls: 0,
            methods: vec![],
            effects: vec![],
        };
        ensure!(
            bridge.frame(host).await?["type"] == "configured",
            "Bridge did not configure"
        );
        Ok(bridge)
    }
    async fn deliver(&mut self, host: &Host, method: &str, work: Option<&str>) -> Result<bool> {
        let next = {
            let state = host.lock()?;
            host::lifetime::pending_outbox(&state.journal.0)?
                .into_iter()
                .rev()
                .find(|item| {
                    item.target == "pi"
                        && item.payload["body"]["method"] == method
                        && work.is_none_or(|id| item.payload["body"]["work_id"] == id)
                })
        };
        let Some(next) = next else {
            return Ok(false);
        };
        self.commands += 1;
        ensure!(self.commands <= 20, "Cross-Ghost delivery budget exceeded");
        self.input
            .write_all(
                format!(
                    "{}\n",
                    json!({"type":"command","id":self.commands,"command":next.payload})
                )
                .as_bytes(),
            )
            .await?;
        self.input.flush().await?;
        let result = self.frame(host).await?;
        ensure!(
            result["type"] == "command_result" && result["receipt"]["status"] == "success",
            "Cross-Ghost delivery rejected: {result}"
        );
        host::lifetime::ack_outbox(&host.lock()?.journal.0, next.id, &result["receipt"])?;
        Ok(true)
    }
    async fn replay_assignment(&mut self, host: &Host, assignment: &str) -> Result<()> {
        let command: Value = {
            let state = host.lock()?;
            let raw: String = state.journal.0.query_row(
                "SELECT payload FROM lifetime_outbox WHERE target='pi' AND delivery_ref=?1",
                [assignment],
                |r| r.get(0),
            )?;
            serde_json::from_str(&raw)?
        };
        self.commands += 1;
        self.input
            .write_all(
                format!(
                    "{}\n",
                    json!({"type":"command","id":self.commands,"command":command})
                )
                .as_bytes(),
            )
            .await?;
        self.input.flush().await?;
        let result = self.frame(host).await?;
        ensure!(
            result["type"] == "command_result" && result["receipt"]["status"] == "success",
            "Original assignment replay failed: {result}"
        );
        Ok(())
    }
    async fn opens(&mut self, host: &Host) -> Result<()> {
        for _ in 0..4 {
            if !self.deliver(host, "conversation.open", None).await? {
                return Ok(());
            }
        }
        anyhow::bail!("Unexpected repeated conversation opens")
    }
    async fn stop(
        mut self,
        host: &Host,
    ) -> Result<(u64, Vec<String>, Vec<(PiToolRequest, Value)>)> {
        self.input.write_all(b"{\"type\":\"stop\"}\n").await?;
        self.input.flush().await?;
        ensure!(
            self.frame(host).await?["type"] == "stopped",
            "Bridge stop failed"
        );
        drop(self.input);
        ensure!(
            tokio::time::timeout(Duration::from_secs(10), self.child.wait())
                .await??
                .success(),
            "Bridge exit failed"
        );
        Ok((self.model_calls, self.methods, self.effects))
    }
}
fn reopened(root: &Path, root_ghost: &str, child_ghost: &str) -> Result<Host> {
    let profiles = crate::store::list_profiles(root)?
        .into_iter()
        .map(|name| {
            Host::profile(ProfileStore::open_profile(root, &name)?)
                .map(|profile| (profile.id.clone(), profile))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    let journal = host::scheduler::Journal::open(&root.join("workspace.db"))?;
    let mut computers =
        host::lifetime_computers::NativeComputers::pi_fixture(&root.join("registry"), root_ghost)?;
    computers.set_pi_fixture_cli(Path::new("/opt/homebrew/bin/container"))?;
    computers.provision_pi_ghost(&journal.0, root_ghost, child_ghost, 1, "pi-default/1")?;
    Ok(Host {
        root: root.into(),
        state: Mutex::new(State { profiles, journal }),
        handle: tokio::runtime::Handle::current(),
        default_model: "mock".into(),
        _lock: host::WorkspaceLock(File::create(root.join("test.lock"))?),
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
    })
}

#[derive(Debug, PartialEq, Eq)]
struct AssignmentSnapshot {
    outbox_id: i64,
    assignment_id: String,
    goal_revision: u64,
}
fn root_assignments(conn: &rusqlite::Connection, work_id: &str) -> Result<Vec<AssignmentSnapshot>> {
    let mut query=conn.prepare("SELECT id,delivery_ref,json_extract(payload,'$.body.goal_revision') FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1 ORDER BY id")?;
    let rows = query.query_map([work_id], |row| {
        Ok(AssignmentSnapshot {
            outbox_id: row.get(0)?,
            assignment_id: row.get(1)?,
            goal_revision: row.get(2)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}
fn verify_original_assignments(
    before: &[AssignmentSnapshot],
    after: &[AssignmentSnapshot],
    revision: u64,
    original: &str,
) -> Result<()> {
    ensure!(before==after,"Wait changed the root assignment set across any Goal revision: before={before:?}, after={after:?}");
    let current = after
        .iter()
        .filter(|row| row.goal_revision == revision)
        .map(|row| row.assignment_id.as_str())
        .collect::<Vec<_>>();
    ensure!(
        current == vec![original],
        "Current root revision does not retain exactly its original assignment: {current:?}"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opt-in actual local Pi root→child→cold restart→parent physical acceptance"]
async fn real_pi_cross_ghost_child_acceptance_cold_restart_parent_acceptance() -> Result<()> {
    ensure!(
        std::env::var("GHOST_PI_RUN_CROSS_GHOST_CANARY").as_deref() == Ok("1"),
        "Explicit B7 physical external-inference opt-in required"
    );
    let f = setup_with_spec(json!({}));
    crate::host::inference::install_external_test_inference(&f.host)?;
    f.host.configure_inference(&json!({
        "operation":"set_default","version":2,
        "selection":{"provider":"zai-coding","model":"glm-5.3","effort":"high"}
    }))?;
    let super::tests::Fixture {
        _root,
        mut host,
        ghost,
        conversation: _,
        assignment: _,
        work: root_work,
    } = f;
    let root = _root.keep();
    let mut evidence = Evidence {
        path: root.clone(),
        success: false,
    };
    host.native_computers
        .as_mut()
        .unwrap()
        .set_pi_fixture_cli(Path::new("/opt/homebrew/bin/container"))?;
    let child_profile = Host::profile(ProfileStore::create_profile(
        &root,
        "b7-researcher",
        "Synthetic B7 researcher",
    )?)?;
    let child = child_profile.id.clone();
    let child_conversation = uuid::Uuid::new_v4().to_string();
    {
        let mut state = host.lock()?;
        state.profiles.insert(child.clone(), child_profile);
        let registered = host::lifetime::apply(
            &state.journal.0,
            &envelope(
                "owner",
                json!({"method":"registry.ensure","ghost_id":child,"conversation_id":child_conversation,"kind":"specialist","roles":["b7_researcher"]}),
            ),
            "owner",
        )?;
        ensure!(
            registered.status == ResponseStatus::Success,
            "Child registration: {registered:?}"
        );
        host.native_computers.as_ref().unwrap().provision_pi_ghost(
            &state.journal.0,
            &ghost,
            &child,
            1,
            "pi-default/1",
        )?;
    }
    let child_command = "test \"$(cat answer.txt)\" = b7-child && printf b7-child-verified";
    let child_instructions = "Synthetic B7 child task. Write answer.txt with exactly b7-child (no newline), then publish answer.txt with privacy public and finish. The Host will run its required verifier after publication. Do not run bash or delegate.".to_owned();
    let mut child_spec = verifier_spec("b7-child");
    child_spec["required_checks"] = json!([
        "artifact_sha256",
        "artifact_content",
        "command_success",
        "command_stdout"
    ]);
    child_spec["verifier"]["command"] = json!(child_command);
    child_spec["verifier"]["expected_stdout"] = json!("b7-child-verified");
    child_spec["verifier"]["completion_timeout_seconds"] = json!(20);
    child_spec["instructions"] = json!(child_instructions);
    let child_prompt = child_instructions;
    let root_command = "test $(cat answer.txt) = b7-root-reviewed && printf b7-root-verified";
    let mut root_spec = verifier_spec("b7-root-reviewed");
    root_spec["required_checks"] = json!([
        "artifact_sha256",
        "artifact_content",
        "command_success",
        "command_stdout"
    ]);
    root_spec["verifier"]["command"] = json!(root_command);
    root_spec["verifier"]["expected_stdout"] = json!("b7-root-verified");
    root_spec["verifier"]["completion_timeout_seconds"] = json!(20);
    root_spec["delegation_contracts"] = json!([{"target_ghost_id":child,"prompt":child_prompt,"acceptance_spec":child_spec,"artifact_refs":[]}]);
    let prompt="Synthetic B7 coordinator task. Inspect your current work_children, registry_inspect and work_inspect. If the links array has NO child links, select the Host-issued contract_ref from work_inspect data.delegation_contracts for specialist role b7_researcher and delegate exactly ONE child using only parent_work_id and contract_ref. Do not retype or modify its prompt or acceptance specification. Before delegation, write draft.txt exactly before-wait, read it using only the path argument (omit view), then edit its text before-wait to prepared. Then call work_wait for that one child. That tool durably parks THIS SAME generation; after it returns continue with the accepted child below. Do not finish while waiting or submit a replacement Work. If you ALREADY have an accepted child, never delegate again. Read the exact Host-staged input_artifacts relative path using only the path argument (omit view) and confirm its content is b7-child. Then write answer.txt exactly b7-root-reviewed (no newline), publish answer.txt with privacy public, and finish. The Host will run its required verifier after publication. 최종 사용자 보고는 반드시 한국어로 작성하세요. Do not create or update any Goal. Child acceptance alone does not complete your own output.".to_owned();
    let root_goal = {
        let state = host.lock()?;
        db::work(&state.journal.0, &root_work)?.unwrap().goal_id
    };
    let mut revised = envelope(
        "owner",
        json!({"method":"goal.update","goal_id":root_goal,"prompt":prompt,"acceptance_spec":root_spec}),
    );
    revised.expected_revision = Some(1);
    let admitted = host.lifetime_action(&revised)?;
    ensure!(
        admitted["result"]["status"] == "success",
        "Root revision: {admitted}"
    );
    // Capture every root revision before inference/park. The fixture already
    // contains the original admission and this explicit Owner Goal update.
    let assignments_before = root_assignments(&host.lock()?.journal.0, &root_work)?;
    let mut bridge = Bridge::start(&host).await?;
    bridge.opens(&host).await?;
    ensure!(
        bridge
            .deliver(&host, "conversation.assignment", Some(&root_work))
            .await?,
        "Root assignment absent"
    );
    let child_work = {
        let state = host.lock()?;
        let mut query = state.journal.0.prepare(
            "SELECT child_work_id FROM lifetime_work_links WHERE parent_work_id=?1 AND current=1",
        )?;
        let works = query
            .query_map([&root_work], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(works.len() == 1, "Model did not delegate exactly one child");
        works[0].clone()
    };
    let (original_execution, original_assignment, original_generation, original_effects) = {
        let state = host.lock()?;
        let conn = &state.journal.0;
        let root = db::work(conn, &root_work)?.unwrap();
        ensure!(
            root.state == "blocked",
            "Root did not durably park before cold restart: {root:?}"
        );
        let execution = root.execution_id.unwrap();
        let (assignment,generation):(String,u64)=conn.query_row("SELECT assignment_id,generation_task_id FROM lifetime_pi_executions WHERE execution_id=?1",[&execution],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let effects = bridge.effects.clone();
        ensure!(
            effects.len() == 3,
            "Root must write/read/edit before waiting: {}",
            effects.len()
        );
        for (request, _) in &effects {
            ensure!(request.ghost_id == ghost, "Child ran before restart");
        }
        (execution, assignment, generation, effects)
    };
    let (first_calls, mut methods, _) = bridge.stop(&host).await?;
    drop(host);
    // The root has real prior effects and an active dependency. Both Host and
    // Pi are cold before any child execution or independent acceptance.
    let host = reopened(&root, &ghost, &child)?;
    let mut bridge = Bridge::start(&host).await?;
    bridge
        .replay_assignment(&host, &original_assignment)
        .await?;
    ensure!(
        host.lock()?.journal.0.query_row(
            "SELECT state FROM lifetime_pi_executions WHERE execution_id=?1",
            [&original_execution],
            |r| r.get::<_, String>(0)
        )? == "running",
        "Original root execution disappeared"
    );
    ensure!(
        bridge
            .deliver(&host, "conversation.assignment", Some(&child_work))
            .await?,
        "Child assignment absent after restart"
    );
    bridge
        .replay_assignment(&host, &original_assignment)
        .await?;
    let (child_execution, child_receipts, child_artifact) = {
        let state = host.lock()?;
        let work = db::work(&state.journal.0, &child_work)?.unwrap();
        ensure!(
            work.state == "accepted",
            "Actual child was not independently accepted: {work:?}"
        );
        let execution = work.execution_id.unwrap();
        let count: i64 = state.journal.0.query_row(
            "SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1",
            [&execution],
            |r| r.get(0),
        )?;
        let artifact = super::artifact_inputs(
            &state.journal.0,
            &db::work(&state.journal.0, &root_work)?.unwrap(),
        )?;
        ensure!(artifact.len() == 1, "Accepted child artifact not offered");
        (execution, count, artifact[0].clone())
    };
    ensure!(bridge.deliver(&host, "conversation.submit", None).await?, "Accepted root report absent");
    let (second_calls, second_methods, _) = bridge.stop(&host).await?;
    methods.extend(second_methods);
    ensure!(
        first_calls + second_calls <= 40,
        "Total model budget exceeded"
    );
    for (original, receipt) in original_effects {
        let raw:String=host.lock()?.journal.0.query_row("SELECT response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND task_id=?2 AND call_id=?3",rusqlite::params![original_execution,original.envelope.body["task_id"].as_u64(),original.envelope.body["call_id"].as_str()],|r|r.get(0))?;
        ensure!(
            serde_json::from_str::<Value>(&raw)? == receipt,
            "Original pre-wait effect receipt changed"
        );
    }
    let state = host.lock()?;
    let root_state = db::work(&state.journal.0, &root_work)?.unwrap();
    ensure!(
        root_state.state == "accepted",
        "Root not independently accepted after real restart: {root_state:?}"
    );
    let korean_reports: i64 = state.journal.0.query_row(
        "SELECT COUNT(*) FROM lifetime_report_replies r JOIN lifetime_turns t ON t.id=r.reply_turn_id
         JOIN lifetime_outbox o ON o.id=r.outbox_id WHERE t.ghost_id=?1
         AND json_extract(o.payload,'$.body.goal_id')=?2 AND json_extract(o.payload,'$.body.goal_revision')=?3
         AND t.text GLOB '*[가-힣]*'",
        rusqlite::params![ghost,root_goal,root_state.goal_revision], |r| r.get(0),
    )?;
    ensure!(korean_reports == 1, "Expected one Korean report from the original master");
    for operation in ["write", "publish_artifact", "bash"] {
        let count: i64 = state.journal.0.query_row(
            "SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1 AND operation=?2",
            rusqlite::params![child_execution,operation], |r| r.get(0),
        )?;
        ensure!(count == 1, "Expected one child {operation} effect");
    }
    let root_execution = root_state.execution_id.as_deref().unwrap();
    ensure!(
        root_execution == original_execution,
        "Wait created a replacement execution"
    );
    let generation: u64 = state.journal.0.query_row(
        "SELECT generation_task_id FROM lifetime_pi_executions WHERE execution_id=?1",
        [root_execution],
        |r| r.get(0),
    )?;
    ensure!(
        generation == original_generation,
        "Wait replaced the original GenerationTask"
    );
    verify_original_assignments(
        &assignments_before,
        &root_assignments(&state.journal.0, &root_work)?,
        root_state.goal_revision,
        &original_assignment,
    )?;
    ensure!(
        root_execution != child_execution,
        "Ghosts shared an execution"
    );
    let staged = super::artifact_inputs(&state.journal.0, &root_state)?;
    ensure!(
        staged == vec![child_artifact.clone()],
        "Child immutable provenance changed across reopen"
    );
    ensure!(
        state.journal.0.query_row(
            "SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1",
            [&child_execution],
            |r| r.get::<_, i64>(0)
        )? == child_receipts,
        "Restart replayed child effects"
    );
    ensure!(
        state.journal.0.query_row(
            "SELECT COUNT(*) FROM lifetime_acceptances WHERE work_id IN (?1,?2)",
            rusqlite::params![root_work, child_work],
            |r| r.get::<_, i64>(0)
        )? == 2,
        "Root/child acceptance count differs"
    );
    ensure!(
        state.journal.0.query_row(
            "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
            [],
            |r| r.get::<_, i64>(0)
        )? == 0,
        "Cross-Ghost execution used a worker"
    );
    ensure!(
        methods.iter().any(|m| m == "work.delegate") && methods.iter().any(|m| m == "work.wait"),
        "Root did not coordinate through actual Pi tools"
    );
    let root_dir = host
        .native_computers
        .as_ref()
        .unwrap()
        .pi_fixture_snapshot(&ghost, root_execution, 1)?;
    let child_dir = host
        .native_computers
        .as_ref()
        .unwrap()
        .pi_fixture_snapshot(&child, &child_execution, 1)?;
    ensure!(root_dir != child_dir, "Ghost task roots shared");
    ensure!(
        std::fs::read(root_dir.join(child_artifact["path"].as_str().unwrap()))? == b"b7-child",
        "Parent did not receive exact staged bytes"
    );
    ensure!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_effects WHERE operation='bash' AND state='complete' AND call_id LIKE 'host-verifier:pc-%' AND json_extract(arguments_json,'$.command_ref') LIKE 'pc-%' AND json_extract(arguments_json,'$.command') IS NULL",[],|r|r.get::<_,u64>(0))?==2,"Actual child and parent must select original Host command refs");
    ensure!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_commands WHERE json_extract(request,'$.body.method')='work.delegate' AND json_extract(request,'$.body.contract_ref') LIKE 'dc-%' AND json_extract(request,'$.body.summary') IS NULL",[],|r|r.get::<_,i64>(0))?==1,"Actual model did not use immutable contract-reference path");
    ensure!(state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='read' AND state='complete' AND json_extract(arguments_json,'$.path')=?2 AND json_extract(response_json,'$.data.output.sha256')=?3)",rusqlite::params![root_execution,child_artifact["path"].as_str(),child_artifact["artifact"]["digest"].as_str()],|r|r.get::<_,bool>(0))?,"Actual parent Pi did not read the exact immutable staged child artifact");
    let root_effects: i64 = state.journal.0.query_row(
        "SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1",
        [root_execution],
        |r| r.get(0),
    )?;
    eprintln!(
        "B7 accepted metadata {}",
        json!({"root_work":root_work,"child_work":child_work,"original_assignment":original_assignment,"child_execution":child_execution,"root_execution":root_execution,"child_effects":child_receipts,"root_effects":root_effects,"model_calls":first_calls+second_calls,"acceptances":2,"worker_outbox":0,"cold_restart":true})
    );
    drop(state);
    drop(host);
    evidence.success = true;
    drop(evidence);
    Ok(())
}

#[tokio::test]
async fn pi_cross_ghost_fixture_reopens_profiles_registry_and_original_route_without_rebinding(
) -> Result<()> {
    let f = setup_with_spec(json!({}));
    let super::tests::Fixture {
        _root, host, ghost, ..
    } = f;
    let child_profile = Host::profile(ProfileStore::create_profile(
        _root.path(),
        "cold-child",
        "Synthetic cold child",
    )?)?;
    let child = child_profile.id.clone();
    {
        let mut state = host.lock()?;
        state.profiles.insert(child.clone(), child_profile);
        host.native_computers.as_ref().unwrap().provision_pi_ghost(
            &state.journal.0,
            &ghost,
            &child,
            1,
            "pi-default/1",
        )?;
    }
    let computer = host
        .native_computers
        .as_ref()
        .unwrap()
        .pi_computer(&child)
        .unwrap();
    drop(host);
    let reopened = reopened(_root.path(), &ghost, &child)?;
    ensure!(
        reopened
            .native_computers
            .as_ref()
            .unwrap()
            .pi_computer(&child)
            == Some(computer),
        "Cold reopen changed child route"
    );
    ensure!(
        reopened.lock()?.profiles.len() == 2,
        "Cold reopen lost a profile"
    );
    Ok(())
}

#[test]
fn pi_cross_ghost_assignment_snapshot_retains_history_and_rejects_extra_revisions() -> Result<()> {
    let conn = rusqlite::Connection::open_in_memory()?;
    conn.execute_batch("CREATE TABLE lifetime_outbox(id INTEGER PRIMARY KEY,target TEXT,delivery_ref TEXT,payload TEXT)")?;
    for (revision, id) in [
        (1, "initial-owner-assignment"),
        (2, "current-owner-assignment"),
    ] {
        conn.execute("INSERT INTO lifetime_outbox(target,delivery_ref,payload) VALUES('pi',?1,?2)",rusqlite::params![id,serde_json::to_string(&json!({"body":{"method":"conversation.assignment","work_id":"root-work","goal_revision":revision}}))?])?;
    }
    let before = root_assignments(&conn, "root-work")?;
    assert_eq!(before.len(), 2);
    verify_original_assignments(
        &before,
        &root_assignments(&conn, "root-work")?,
        2,
        "current-owner-assignment",
    )?;
    assert!(verify_original_assignments(&before, &before, 2, "different-assignment").is_err());
    conn.execute("INSERT INTO lifetime_outbox(target,delivery_ref,payload) VALUES('pi','unexpected-other-revision',?1)",[serde_json::to_string(&json!({"body":{"method":"conversation.assignment","work_id":"root-work","goal_revision":3}}))?])?;
    let after = root_assignments(&conn, "root-work")?;
    assert_eq!(
        after.iter().filter(|row| row.goal_revision == 2).count(),
        1,
        "A current-revision-only count would miss this extra assignment"
    );
    assert!(verify_original_assignments(&before, &after, 2, "current-owner-assignment").is_err());
    Ok(())
}
