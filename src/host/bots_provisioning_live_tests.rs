// Explicit opt-in only: public synthetic inputs, disposable Host, pinned local
// inference and the already running container service. Never production state.
struct LiveBotBridge {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    commands: u64,
    callbacks: u64,
}
impl LiveBotBridge {
    async fn frame(&mut self, host: &Host) -> Value {
        use tokio::io::AsyncWriteExt;
        loop {
            let line =
                tokio::time::timeout(std::time::Duration::from_secs(130), self.output.next_line())
                    .await
                    .unwrap()
                    .unwrap()
                    .expect("bot bridge exited");
            assert!(line.len() <= 1_048_576);
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["type"] != "callback" {
                assert_ne!(frame["type"], "failure", "{frame}");
                return frame;
            }
            self.callbacks += 1;
            assert!(
                self.callbacks <= 400,
                "bounded bot canary callback budget exhausted"
            );
            let request: lifetime::PiToolRequest =
                serde_json::from_value(frame["request"].clone()).unwrap();
            let result = host
                .lifetime_pi_action(&request, lifetime::PiInferenceScope::Public)
                .await
                .unwrap();
            if request.envelope.body["method"] == "work.execute" {
                eprintln!(
                    "Bot tool receipt: {}",
                    json!({"operation":request.envelope.body["operation"],"status":result["result"]["status"],"receipt":result["result"]["data"]["receipt"],"error_code":result["result"]["error_code"]})
                );
            }
            if result["result"]["status"] == "error" {
                eprintln!(
                    "Bot callback denial: {}",
                    json!({"method":request.envelope.body["method"],"code":result["result"]["error_code"],"summary":result["result"]["summary"]})
                );
            }
            let response = json!({"type":"callback_result","id":frame["id"],"frame":result});
            self.input
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
            self.input.flush().await.unwrap();
        }
    }
    async fn start(host: &Host) -> Self {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let mut child = tokio::process::Command::new("/opt/homebrew/bin/node")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
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
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let output = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let config = json!({"type":"config","root":host.root.join("pi-live-store"),"host_root":host.root,"authority_epoch":1});
        input
            .write_all(format!("{config}\n").as_bytes())
            .await
            .unwrap();
        input.flush().await.unwrap();
        let mut bridge = Self {
            child,
            input,
            output,
            commands: 0,
            callbacks: 0,
        };
        assert_eq!(bridge.frame(host).await["type"], "configured");
        bridge
    }
    async fn drain(&mut self, host: &Host) {
        use tokio::io::AsyncWriteExt;
        for _ in 0..32 {
            host.advance_bot_provisioning().unwrap();
            let next = {
                let state = host.lock().unwrap();
                lifetime::pending_outbox(&state.journal.0)
                    .unwrap()
                    .into_iter()
                    .find(|item| item.target == "pi")
            };
            let Some(next) = next else { return };
            self.commands += 1;
            eprintln!("Bot canary delivery: {}", next.payload["body"]["method"]);
            let command = json!({"type":"command","id":self.commands,"command":next.payload});
            self.input
                .write_all(format!("{command}\n").as_bytes())
                .await
                .unwrap();
            self.input.flush().await.unwrap();
            let response = self.frame(host).await;
            assert_eq!(response["type"], "command_result", "{response}");
            assert_eq!(response["receipt"]["status"], "success", "{response}");
            let state = host.lock().unwrap();
            lifetime::ack_outbox(&state.journal.0, next.id, &response["receipt"]).unwrap();
        }
        panic!("bot canary outbox budget exhausted");
    }
    async fn stop(mut self, host: &Host) -> Value {
        use tokio::io::AsyncWriteExt;
        self.input
            .write_all(b"{\"type\":\"stop\"}\n")
            .await
            .unwrap();
        self.input.flush().await.unwrap();
        let terminal = self.frame(host).await;
        drop(self.input);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(10), self.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        terminal
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opt-in real external-inference conversational bot creation and two independent new inputs"]
async fn real_local_model_conversation_creates_and_reuses_one_bot_twice() {
    assert_eq!(
        std::env::var("GHOST_PI_RUN_LIVE_BOT_CANARY").as_deref(),
        Ok("1")
    );
    let mut f = host_fixture();
    crate::host::inference::install_external_test_inference(&f.host).unwrap();
    // Preserve only this synthetic disposable fixture if assertions fail, so an
    // unresolved physical effect can be diagnosed without replaying it.
    struct Evidence(std::path::PathBuf);
    impl Drop for Evidence {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!("Synthetic bot canary evidence: {}", self.0.display());
            } else {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
    let evidence = Evidence(std::mem::replace(&mut f.root, tempfile::tempdir().unwrap()).keep());
    f.host
        .native_computers
        .as_mut()
        .unwrap()
        .set_pi_fixture_cli(std::path::Path::new("/opt/homebrew/bin/container"))
        .unwrap();
    {
        let state = f.host.lock().unwrap();
        let response = lifetime::apply(
            &state.journal.0,
            &env(
                "live-fixed-profile",
                json!({"method":"bot.evaluation_profile.configure","fixtures":[
            {"id":"held-alpha","input":{"value":"alpha"},"expected_output":"ALPHA"},
            {"id":"held-beta","input":{"value":"beta"},"expected_output":"BETA"}]}),
            ),
            "owner",
        )
        .unwrap();
        assert_eq!(response.status, ResponseStatus::Success);
    }
    let mut bridge = LiveBotBridge::start(&f.host).await;
    let context=f.host.lifetime_action(&env("recipe-context",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"Remember this public synthetic reusable task recipe for my next request: for input JSON object with a string value field, convert value to ASCII uppercase and return that scalar string as the output value. Example: input {\"value\":\"foo\"} produces scalar output FOO; it must never produce or serialize an object such as {\"value\":\"FOO\"}. The reusable instructions must preserve this exact scalar procedure. Name: Uppercase. Required capabilities: read, write, bash, publish_artifact. No memory, network, private data or credentials. Input contract is object with value string; output contract is scalar string, not JSON object and not serialized JSON text. For a real assigned Work write only the uppercase letters as raw UTF-8 without quotation marks or JSON syntax in output.txt and publish output.txt with public privacy. For candidate evaluation follow the Host evaluation envelope and compute canonical input SHA256 using bash if necessary. Only acknowledge the recipe now; do not create a bot or any Goal until my next Owner request.","privacy":"public","attachments":[]}))).unwrap();
    assert_eq!(context["result"]["status"], "success");
    bridge.drain(&f.host).await;
    owner_create_turn(&f, "이 요구사항으로 봇을 만들어줘");
    bridge.drain(&f.host).await;
    let c = {
        let state = f.host.lock().unwrap();
        let keys: Vec<String> = state
            .journal
            .0
            .prepare("SELECT id FROM workspace_objects WHERE kind=?1")
            .unwrap()
            .query_map([CANDIDATES], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            keys.len(),
            1,
            "actual model must prepare exactly one candidate"
        );
        let c = candidate(&state.journal.0, &keys[0]).unwrap();
        let p = progress(&state.journal.0, &c.id).unwrap();
        assert_eq!(p.state, "ready", "{p:?}");
        assert!(p.activation_requested);
        c
    };
    let original_digest = c.digest.clone();
    let mut ids = vec![];
    for (index, input, expected) in [(0, "gamma", "GAMMA"), (1, "delta", "DELTA")] {
        let mut spec = crate::host::lifetime::pi_execution::tests::verifier_spec(expected);
        spec["verifier"]["artifact_path"] = json!("output.txt");
        let prompt=format!("Apply your pinned reusable bot instructions to this new public input: {{\"value\":\"{input}\"}}. Write output.txt with exactly the resulting raw UTF-8 output, no quotation marks or newline. Publish output.txt with public privacy. Finish only after successful publication. Do not create another bot or Goal.");
        let admitted=f.host.lifetime_action(&env(&format!("live-new-{index}"),json!({"method":"goal.submit","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"prompt":prompt,"privacy":"public","acceptance_spec":spec}))).unwrap();
        assert_eq!(admitted["result"]["status"], "success", "{admitted}");
        let id = admitted["result"]["data"]["work"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        ids.push(id.clone());
        bridge.drain(&f.host).await;
        let state = f.host.lock().unwrap();
        let work: Work = serde_json::from_str(
            &state
                .journal
                .0
                .query_row(
                    "SELECT payload FROM lifetime_work WHERE id=?1",
                    [&id],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(work.owner, c.definition.ghost_id);
        assert_eq!(
            work.state, "accepted",
            "independent output acceptance: {work:?}"
        );
        assert_eq!(
            candidate(&state.journal.0, &c.id).unwrap().digest,
            original_digest
        );
        assert_eq!(
            assets_for_work(&state.journal.0, &work).unwrap()[0]["content"],
            c.assets[0].content
        );
    }
    assert_ne!(ids[0], ids[1]);
    let found = f
        .host
        .lifetime_action(&env(
            "live-discover",
            json!({"method":"bot.discover","required_capabilities":["write"]}),
        ))
        .unwrap();
    assert_eq!(found["result"]["data"]["bots"].as_array().unwrap().len(), 1);
    let no_fit = f
        .host
        .lifetime_action(&env(
            "live-no-fit",
            json!({"method":"bot.discover","required_capabilities":["browser"]}),
        ))
        .unwrap();
    assert_eq!(no_fit["result"]["data"]["no_fit"], true);
    let terminal = bridge.stop(&f.host).await;
    eprintln!(
        "Live conversational bot metadata: {}",
        json!({"status":"success","model_calls":terminal["model_calls"],"new_work_count":ids.len(),"same_ghost":true,"candidate_digest_unchanged":true,"independent_acceptances":3,"external_provider_calls":0})
    );
    drop(f);
    drop(evidence);
}
