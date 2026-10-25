//! Opt-in physical Host/tool acceptance. No model/provider or live Host state.
use super::{
    db,
    pi_tools::{PiInferenceScope, PiToolRequest},
    tests::{envelope, request, setup_with_spec, verifier_spec},
};
use crate::lifetime_contract::ResponseStatus;
use serde_json::json;
use std::path::Path;

/// This opt-in chain uses live local inference, the real Pi SDK and Host
/// handlers, and the physical Apple container. JSONL replaces only the
/// authenticated HTTP socket with a trusted fixture transport.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "live external inference plus physical Pi Host tools; no production state"]
async fn real_pi_sdk_local_model_host_container_roundtrip() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use std::process::Stdio;
    assert_eq!(std::env::var("GHOST_PI_RUN_LIVE_MODEL_CANARY").as_deref(), Ok("1"));
    let command = "test \"$(cat answer.txt)\" = pi-live-output && printf pi-live-verified";
    let prompt = format!("Complete this synthetic public acceptance task using tools in order. First write answer.txt with exactly initial-input (no newline). Read answer.txt. Edit initial-input to pi-live-output (no newline). Execute bash command exactly: {command}. Publish answer.txt with privacy public. After successful publication, finish with a short report. Do not delegate or create another Goal. Use all five tools: write, read, edit, bash, publish_artifact. Do not change the expected strings or invent success without tool receipts.");
    let mut spec = verifier_spec("pi-live-output");
    spec["required_checks"] = json!(["artifact_sha256", "artifact_content", "command_success", "command_stdout"]);
    spec["verifier"]["command"] = json!(command);
    spec["verifier"]["expected_stdout"] = json!("pi-live-verified");
    let mut f = super::tests::setup_with_prompt_and_spec(&prompt, spec);
    crate::host::inference::install_external_test_inference(&f.host).unwrap();
    f.host.native_computers.as_mut().unwrap()
        .set_pi_fixture_cli(Path::new("/opt/homebrew/bin/container")).unwrap();
    let assignment: serde_json::Value = {
        let state = f.host.lock().unwrap();
        let raw: String = state.journal.0.query_row(
            "SELECT payload FROM lifetime_outbox WHERE target='pi' AND delivery_ref=?1",
            [&f.assignment], |row| row.get(0),
        ).unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    let runner = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("apps/ghost-durable/scripts/pi-live-canary.mjs");
    let mut child = tokio::process::Command::new("/opt/homebrew/bin/node")
        .arg(&runner).env_clear()
        .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
        .env("HOME", &f.host.root)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .kill_on_drop(true).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let config = json!({"type":"config","root":f.host.root.join("pi-live-store"),"host_root":f.host.root,
        "authority_epoch":1,"assignment":assignment,
        "expected_tools":["read","write","edit","bash","publish_artifact"],"deadline_ms":120000});
    input.write_all(format!("{config}\n").as_bytes()).await.unwrap();
    input.flush().await.unwrap();
    let terminal = tokio::time::timeout(std::time::Duration::from_secs(150), async {
        let mut callbacks = 0;
        loop {
            let line = output.next_line().await.unwrap().expect("Pi runner exited without terminal result");
            assert!(line.len() <= 1_048_576, "Pi fixture frame exceeded bound");
            let frame: serde_json::Value = serde_json::from_str(&line).unwrap();
            match frame["type"].as_str() {
                Some("callback") => {
                    callbacks += 1;
                    assert!(callbacks <= 200, "Pi canary callback limit exceeded");
                    let request: PiToolRequest = serde_json::from_value(frame["request"].clone()).unwrap();
                    assert_eq!(request.ghost_id, f.ghost);
                    assert_eq!(request.conversation_id, f.conversation);
                    let result = f.host.lifetime_pi_action(&request, crate::host::lifetime::test_callback_inference_scope(&frame)).await.unwrap();
                    let reply = json!({"type":"callback_result","id":frame["id"],"frame":result});
                    input.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                    input.flush().await.unwrap();
                },
                Some("result") => break frame,
                _ => panic!("Unexpected Pi canary frame type"),
            }
        }
    }).await.expect("Live Pi model canary timed out");
    drop(input);
    let exit = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await.unwrap().unwrap();
    assert!(exit.success(), "Pi runner failed: {terminal}");
    assert_eq!(terminal["status"], "success", "{terminal}");
    assert!(terminal["model_calls"].as_u64().unwrap() >= 2, "{terminal}");
    let names = terminal["tool_names"].as_array().unwrap();
    for required in ["write", "read", "edit", "bash", "publish_artifact"] {
        assert!(names.contains(&json!(required)), "{terminal}");
    }
    let state = f.host.lock().unwrap();
    assert_eq!(db::work(&state.journal.0, &f.work).unwrap().unwrap().state, "accepted", "{terminal}");
    assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
    assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_acceptances", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
    eprintln!("Live Pi canary metadata: {terminal}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "physical Pi Host tool acceptance; existing container 1.4.1 service/image required"]
async fn real_pi_host_container_effect_and_independent_acceptance() {
    assert_eq!(
        std::env::var("GHOST_PI_RUN_PHYSICAL_CANARY").as_deref(),
        Ok("1")
    );
    let command = r#"set -eu
test "$(cat /workspace/answer.txt)" = edited-input
test ! -e /workspace/once
test ! -e /Users/garden
test ! -e /private
if (printf forbidden > /tmp/ghost-pi-root-write) 2>/dev/null; then exit 70; fi
if timeout 2 getent hosts example.com >/dev/null 2>&1; then exit 71; fi
if timeout 2 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' >/dev/null 2>&1; then exit 72; fi
printf once > /workspace/once
printf pi-physical-output > /workspace/answer.txt
printf pi-physical-verified"#;
    let mut spec = verifier_spec("pi-physical-output");
    spec["required_checks"] = json!([
        "artifact_sha256",
        "artifact_content",
        "command_success",
        "command_stdout"
    ]);
    spec["verifier"]["command"] = json!(command);
    spec["verifier"]["expected_stdout"] = json!("pi-physical-verified");
    let mut f = setup_with_spec(spec);
    f.host
        .native_computers
        .as_mut()
        .unwrap()
        .set_pi_fixture_cli(Path::new("/opt/homebrew/bin/container"))
        .unwrap();
    let requests = [
        request(
            &f,
            100,
            "physical-write",
            "write",
            json!({"path":"answer.txt","content":"initial-input"}),
        ),
        request(
            &f,
            101,
            "physical-read",
            "read",
            json!({"path":"answer.txt"}),
        ),
        request(
            &f,
            102,
            "physical-edit",
            "edit",
            json!({"path":"answer.txt","edits":[{"oldText":"initial-input","newText":"edited-input"}]}),
        ),
    ];
    for tool in requests {
        let result = f
            .host
            .lifetime_pi_execution_action(&tool, PiInferenceScope::Public)
            .await
            .unwrap();
        assert_eq!(result.status, ResponseStatus::Success, "{result:?}");
    }
    let bash = request(
        &f,
        103,
        "physical-bash",
        "bash",
        json!({"command":command,"timeout":30}),
    );
    let first = f
        .host
        .lifetime_pi_execution_action(&bash, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(first.status, ResponseStatus::Success, "{first:?}");
    assert_eq!(first.data["output"]["success"], true, "{first:?}");
    assert_eq!(
        first.data["output"]["stdout"], "pi-physical-verified",
        "{first:?}"
    );
    // Re-execution would fail on /workspace/once. Exact replay must instead
    // return the immutable receipt without creating a second guest process.
    assert_eq!(
        first,
        f.host
            .lifetime_pi_execution_action(&bash, PiInferenceScope::Public)
            .await
            .unwrap()
    );
    let output = f
        .host
        .lifetime_pi_execution_action(
            &request(
                &f,
                104,
                "physical-output-read",
                "read",
                json!({"path":"answer.txt"}),
            ),
            PiInferenceScope::Public,
        )
        .await
        .unwrap();
    assert_eq!(output.data["output"]["content"], "pi-physical-output");
    let publication = f
        .host
        .lifetime_pi_execution_action(
            &request(
                &f,
                105,
                "physical-publish",
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
    let completion = PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: envelope(
            &f.ghost,
            json!({"method":"work.execution.complete","assignment_id":f.assignment,"work_id":f.work,"task_id":7,"summary":"Physical isolated command verified"}),
        ),
    };
    let completed = f
        .host
        .lifetime_pi_execution_action(&completion, PiInferenceScope::Public)
        .await
        .unwrap();
    assert_eq!(completed.status, ResponseStatus::Success, "{completed:?}");
    assert_eq!(
        completed.data["verification"]["status"], "success",
        "{completed:?}"
    );
    let state = f.host.lock().unwrap();
    assert_eq!(
        db::work(&state.journal.0, &f.work).unwrap().unwrap().state,
        "accepted"
    );
    assert_eq!(
        state
            .journal
            .0
            .query_row(
                "SELECT COUNT(*) FROM lifetime_pi_effects WHERE operation='bash'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        state
            .journal
            .0
            .query_row(
                "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        state
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_acceptances", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        1
    );
}
