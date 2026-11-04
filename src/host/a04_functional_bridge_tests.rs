// Controlled protocol peer: no model, endpoint, SDK outcome or artifact acceptance.
#[tokio::test]
async fn product_functional_bridge_soft_checkpoint_keeps_original_probe_and_wait_until_settled() {
    use tokio::io::AsyncBufReadExt;
    let f = host_fixture();
    let script = r#"import json,sys
read=lambda:json.loads(sys.stdin.readline())
emit=lambda value:print(json.dumps(value),flush=True)
idle=read();assert idle['type']=='idle'
base={'id':idle['id'],'mode':'a04-functional-policy/1','barrier_id':1}
emit({**base,'type':'observation_checkpoint','observation':'unconfirmed','reason_code':'observer_window_elapsed','wait_pending':True,'observation_seq':1,'progress':{'kind':'ghost-functional-progress/1','diagnostic_only':True,'sessions':[]}})
emit({**base,'type':'idle_result','observation':'settled','wait_pending':False,'observation_seq':2})
command=read();assert command['type']=='command', 'soft expiry must not send another idle probe or close the worker'
emit({'type':'command_result','id':command['id'],'receipt':{'status':'success'}})
"#;
    let mut process = tokio::process::Command::new("/usr/bin/python3")
        .arg("-u")
        .arg("-c")
        .arg(script)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = process.stdin.take().unwrap();
    let output = tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
    let observer = a04_functional_observation::Observer::open(&f.host.root).unwrap();
    let mut bridge = ProductBridge {
        process,
        input,
        output,
        commands: 0,
        callbacks: 0,
        metrics: Value::Null,
        delegations: vec![],
        reads: vec![],
        denials: vec![],
        callback_failures: vec![],
        idle_results: vec![],
        idle_probe_generation: 0,
        functional_observer: Some(observer),
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        bridge.drain(&f.host, &f.ghost, &f.conversation),
    )
    .await
    .expect("controlled original wait settles without any wall-clock window sleep")
    .unwrap();
    assert_eq!(bridge.idle_probe_generation, 1);
    assert_eq!(bridge.commands, 0);
    assert_eq!(bridge.callbacks, 0);
    let observed: Value = serde_json::from_slice(
        &std::fs::read(f.host.root.join("a04-functional-observation.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(observed["windows_elapsed"], 1);
    assert_eq!(
        observed["latest_checkpoint"]["id"],
        observed["latest_idle_result"]["id"]
    );
    assert_eq!(
        observed["latest_checkpoint"]["barrier_id"],
        observed["latest_idle_result"]["barrier_id"]
    );
    assert_eq!(
        observed["functional_verdict"], "pending",
        "Idle settlement alone cannot grant functional acceptance"
    );
    bridge.command(&f.host,json!({"command_id":"controlled-after-original-wait","body":{"method":"conversation.inspect"}})).await.unwrap();
    assert_eq!(bridge.commands, 1);
    assert!(bridge.process.wait().await.unwrap().success());
}

fn functional_cap_peer(f: &HostFixture, script: &str, args: &[String]) -> ProductBridge {
    use tokio::io::AsyncBufReadExt;
    let mut command = tokio::process::Command::new("/usr/bin/python3");
    command
        .arg("-u")
        .arg("-c")
        .arg(script)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);
    let mut process = command.spawn().unwrap();
    let input = process.stdin.take().unwrap();
    let output = tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
    ProductBridge {
        process,
        input,
        output,
        commands: 0,
        callbacks: 0,
        metrics: Value::Null,
        delegations: vec![],
        reads: vec![],
        denials: vec![],
        callback_failures: vec![],
        idle_results: vec![],
        idle_probe_generation: 0,
        functional_observer: Some(
            a04_functional_observation::Observer::open(&f.host.root).unwrap(),
        ),
    }
}

async fn functional_cap_observation(
    root: &std::path::Path,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if let Ok(bytes) = std::fs::read(root.join("a04-functional-observation.json")) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if predicate(&value) {
                        return value;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("controlled attention checkpoint must be written")
}

fn functional_cap_delivery(f: &HostFixture) -> lifetime::OutboxItem {
    let reference = register_task_template(f, "functional-cap-template");
    assert_eq!(
        task_input(
            f,
            "functional-cap-owner",
            reference,
            "direct",
            json!({"value":"controlled"})
        )["result"]["status"],
        "success"
    );
    let state = f.host.lock().unwrap();
    lifetime::pending_outbox(&state.journal.0)
        .unwrap()
        .into_iter()
        .find(|item| item.target == "pi" && item.payload["body"]["method"] == "conversation.input")
        .unwrap()
}

#[tokio::test]
async fn product_functional_bridge_callback_cap_inside_command_ack_retains_original_command_and_callback(
) {
    let f = host_fixture();
    let delivery = functional_cap_delivery(&f);
    let root = f.host.root.clone();
    let mut e = env(
        "functional-cap-original-callback",
        json!({"method":"conversation.inspect","ghost_id":f.ghost,"conversation_id":f.conversation}),
    );
    e.actor_ref = f.ghost.clone();
    let callback = json!({"ghost_id":f.ghost,"conversation_id":f.conversation,"envelope":e});
    let script = r#"import json,sys,pathlib
root=pathlib.Path(sys.argv[1]);request=json.loads(sys.argv[2]);read=lambda:json.loads(sys.stdin.readline())
original=read();assert original['type']=='command'
(root/'cap-original-command.json').write_text(json.dumps({'id':original['id'],'command_id':original['command']['command_id']}))
print(json.dumps({'type':'callback','id':'cap-callback-401','request':request}),flush=True)
unexpected=sys.stdin.readline()
if unexpected:
 (root/'cap-forbidden-frame.json').write_text(unexpected)
 raise AssertionError('callback cap must not send a receipt, replacement command, idle probe, or stop')
"#;
    let mut bridge = functional_cap_peer(
        &f,
        script,
        &[root.to_string_lossy().into_owned(), callback.to_string()],
    );
    bridge.callbacks = A04_BRIDGE_CALLBACK_BUDGET;
    let commands_before = f
        .host
        .lock()
        .unwrap()
        .journal
        .0
        .query_row::<u64, _, _>("SELECT COUNT(*) FROM lifetime_commands", [], |r| r.get(0))
        .unwrap();
    {
        // Only the observer clock is shortened. The production entry point
        // still supplies its original 130s window; this same future is retained.
        let pending = bridge.command_with_observation_window(
            &f.host,
            delivery.payload.clone(),
            std::time::Duration::from_millis(5),
        );
        tokio::pin!(pending);
        let proof = functional_cap_observation(&root, |value| {
            value["attention_reason"] == "command_observation_window_elapsed"
                && value["pending_callback"]["id"] == "cap-callback-401"
        });
        tokio::pin!(proof);
        let observed = tokio::select! {result=&mut pending=>panic!("observer/cap must not resolve or close original command: {result:?}"),value=&mut proof=>value};
        assert_eq!(observed["pending_command"]["id"], 1);
        assert_eq!(
            observed["pending_command"]["command_id"],
            delivery.payload["command_id"]
        );
        assert_eq!(
            observed["pending_callback"]["command_id"],
            "functional-cap-original-callback"
        );
        assert_eq!(
            observed["pending_callback"]["new_host_dispatch_started"],
            false
        );
        assert_eq!(observed["pending_callback"]["callback_result_sent"], false);
        assert!(!root.join("cap-forbidden-frame.json").exists());
        // End only this controlled protocol test future. No real SDK or
        // production worker is launched or cancelled by this regression.
    }
    assert_eq!(bridge.commands, 1);
    assert_eq!(bridge.callbacks, A04_BRIDGE_CALLBACK_BUDGET + 1);
    assert_eq!(bridge.idle_probe_generation, 0);
    assert!(
        bridge.process.try_wait().unwrap().is_none(),
        "The original controlled child remains live after the observation window"
    );
    let state = f.host.lock().unwrap();
    assert_eq!(
        state
            .journal
            .0
            .query_row::<u64, _, _>("SELECT COUNT(*) FROM lifetime_commands", [], |r| r.get(0))
            .unwrap(),
        commands_before
    );
    assert_eq!(
        state
            .journal
            .0
            .query_row::<u64, _, _>(
                "SELECT acknowledged FROM lifetime_outbox WHERE id=?1",
                [delivery.id],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
    drop(state);
    bridge.process.kill().await.unwrap();
    let _ = bridge.process.wait().await;
}

#[tokio::test]
async fn product_functional_bridge_callback_cap_blocks_pending_outbox_without_ack_or_new_delivery()
{
    let f = host_fixture();
    let delivery = functional_cap_delivery(&f);
    let root = f.host.root.clone();
    let script = r#"import json,sys,pathlib
root=pathlib.Path(sys.argv[1]);first=json.loads(sys.stdin.readline());assert first['type']=='idle', 'exhausted callbacks must block all new command delivery'
(root/'cap-original-idle.json').write_text(json.dumps(first))
print(json.dumps({'type':'observation_checkpoint','id':first['id'],'mode':'a04-functional-policy/1','barrier_id':0,'observation_seq':1,'observation':'unconfirmed','reason_code':'observer_window_elapsed','wait_pending':True}),flush=True)
unexpected=sys.stdin.readline()
if unexpected:
 (root/'cap-forbidden-delivery.json').write_text(unexpected)
 raise AssertionError('original pending outbox must not be delivered or closed')
"#;
    let mut bridge = functional_cap_peer(&f, script, &[root.to_string_lossy().into_owned()]);
    bridge.callbacks = A04_BRIDGE_CALLBACK_BUDGET + 1;
    {
        let pending = bridge.drain(&f.host, &f.ghost, &f.conversation);
        tokio::pin!(pending);
        let proof = functional_cap_observation(&root, |value| {
            value["attention_reason"] == "callback_budget_exhausted"
                && value["pending_delivery"]["command_id"] == delivery.payload["command_id"]
                && value["latest_checkpoint"]["wait_pending"] == true
        });
        tokio::pin!(proof);
        tokio::select! {result=&mut pending=>panic!("exhausted outbox must remain pending: {result:?}"),_=&mut proof=>{}};
        assert!(!root.join("cap-forbidden-delivery.json").exists());
    }
    assert_eq!(bridge.commands, 0);
    assert_eq!(bridge.callbacks, A04_BRIDGE_CALLBACK_BUDGET + 1);
    assert_eq!(bridge.idle_probe_generation, 1);
    assert!(
        bridge.process.try_wait().unwrap().is_none(),
        "The original controlled child remains live with its undelivered outbox"
    );
    assert_eq!(
        f.host
            .lock()
            .unwrap()
            .journal
            .0
            .query_row::<u64, _, _>(
                "SELECT acknowledged FROM lifetime_outbox WHERE id=?1",
                [delivery.id],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
    bridge.process.kill().await.unwrap();
    let _ = bridge.process.wait().await;
}

#[tokio::test]
async fn product_functional_bridge_command_observation_timeout_keeps_original_ack_wait() {
    let f = host_fixture();
    let delivery = functional_cap_delivery(&f);
    let root = f.host.root.clone();
    let script = r#"import json,sys,pathlib
root=pathlib.Path(sys.argv[1]);original=json.loads(sys.stdin.readline());assert original['type']=='command'
(root/'window-original-command.json').write_text(json.dumps({'id':original['id'],'command_id':original['command']['command_id']}))
unexpected=sys.stdin.readline()
if unexpected:
 (root/'window-forbidden-frame.json').write_text(unexpected)
 raise AssertionError('ordinary observation expiry must not send another command or close')
"#;
    let mut bridge = functional_cap_peer(&f, script, &[root.to_string_lossy().into_owned()]);
    {
        let pending = bridge.command_with_observation_window(
            &f.host,
            delivery.payload.clone(),
            std::time::Duration::from_millis(5),
        );
        tokio::pin!(pending);
        let proof = functional_cap_observation(&root, |value| {
            value["attention_reason"] == "command_observation_window_elapsed"
                && value["pending_command"]["command_id"] == delivery.payload["command_id"]
        });
        tokio::pin!(proof);
        tokio::select! {result=&mut pending=>panic!("ordinary observation expiry must retain the original ACK wait: {result:?}"),_=&mut proof=>{}};
        assert!(!root.join("window-forbidden-frame.json").exists());
    }
    assert_eq!(bridge.commands, 1);
    assert_eq!(bridge.callbacks, 0);
    assert_eq!(bridge.idle_probe_generation, 0);
    assert!(bridge.process.try_wait().unwrap().is_none());
    assert_eq!(
        f.host
            .lock()
            .unwrap()
            .journal
            .0
            .query_row::<u64, _, _>(
                "SELECT acknowledged FROM lifetime_outbox WHERE id=?1",
                [delivery.id],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
    bridge.process.kill().await.unwrap();
    let _ = bridge.process.wait().await;
}
