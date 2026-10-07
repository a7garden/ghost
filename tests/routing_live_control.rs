#![cfg(feature = "host")]
//! Full process gate: real owner control -> configured SDK HTTP router -> durable
//! Work -> automatic dispatcher -> organizer effect -> verified completion.
use ghost::{
    control::{api::Action, ControlClient},
    host::work_routing::*,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const INITIAL: &str = "개인 할 일에 제목 '출시 준비 A'를 저장해 줘.";
const FOLLOW: &str = "그 작업의 할 일 제목을 '출시 준비 B'로 바꿔 줘.";
const TITLE_A: &str = "출시 준비 A";
const TITLE_B: &str = "출시 준비 B";

struct GhostChild(Child);
impl GhostChild {
    fn open(root: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ghost"))
            .arg("--root")
            .arg(root)
            .args(["serve", "--headless", "--port", "0", "--model", "mock"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        if line.trim().is_empty() {
            let mut failure = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut failure)
                .unwrap();
            panic!(
                "synthetic host startup failed {}: {failure}",
                child.wait().unwrap()
            );
        }
        let ready: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ready["mode"], "headless");
        Self(child)
    }
    fn kill(&mut self) {
        self.0.kill().unwrap();
        self.0.wait().unwrap();
    }
}
impl Drop for GhostChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn action(client: &ControlClient, id: &str, command: Value) -> Value {
    client
        .action(
            serde_json::from_value::<Action>(json!({"request_id":id,"command":command})).unwrap(),
        )
        .unwrap()
}
fn ok(v: Value) -> Value {
    assert_eq!(v["ok"], true, "{v}");
    v["result"].clone()
}
fn route(client: &ControlClient, action_value: Value) -> Value {
    ok(action(
        client,
        &key(),
        json!({"type":"routing","action":action_value}),
    ))
}
fn natural(entry: &Value, text: &str, kind: &str) -> Value {
    json!({"type":"routing","action":{"type":"routing_natural","entry":entry,"text":text,"kind":kind}})
}
fn results(client: &ControlClient, entry: &Value) -> Value {
    route(client, json!({"type":"routing_results","entry":entry}))
}
fn view(client: &ControlClient, entry: &Value) -> Value {
    route(
        client,
        json!({"type":"routing_view","entry":entry,"limit":50,"before_admission_id":null}),
    )
}
async fn completed(client: &ControlClient, entry: &Value, revision: u64) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let projection = results(client, entry);
        if projection["results"].as_array().unwrap().iter().any(|r| {
            r["decision_revision"] == revision
                && r["status"] == "finished_verified"
                && r["current"] == true
                && r["verified"] == true
        }) {
            return projection;
        }
        assert!(
            Instant::now() < until,
            "synthetic pipeline failed to finish revision {revision}: {projection}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
fn counts(snapshot: &Value) -> (usize, usize) {
    let conversations = snapshot["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|p| p["conversations"].as_array().unwrap());
    conversations.fold((0, 0), |(tasks, effects), c| {
        (
            tasks + c["tasks"].as_array().unwrap().len(),
            effects + c["effects"].as_array().unwrap().len(),
        )
    })
}

#[derive(Default)]
struct WireEvidence {
    text_only: bool,
    requests: usize,
    router: usize,
    worker: usize,
    saves: usize,
    worker_inputs: BTreeMap<String, usize>,
}
fn sse(call: Option<(&str, &str, Value)>) -> String {
    let (delta, reason) = match call {
        Some((id, name, args)) => (
            json!({"role":"assistant","tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}}]}),
            "tool_calls",
        ),
        None => (
            json!({"role":"assistant","content":"실제 도구 결과를 확인했습니다."}),
            "stop",
        ),
    };
    let first = json!({"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let finish = json!({"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":reason}]});
    format!("data: {first}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
}
fn current_messages(body: &Value) -> &[Value] {
    let messages = body["messages"].as_array().unwrap();
    let user = messages.iter().rposition(|m| m["role"] == "user").unwrap();
    &messages[user..]
}
fn latest_tool(messages: &[Value]) -> Option<(String, Value)> {
    let tool = messages.iter().rev().find(|m| m["role"] == "tool")?;
    let id = tool["tool_call_id"].as_str().unwrap();
    let name = messages
        .iter()
        .filter_map(|m| m["tool_calls"].as_array())
        .flatten()
        .find(|c| c["id"] == id)
        .unwrap()["function"]["name"]
        .as_str()
        .unwrap()
        .to_string();
    let output: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        output["status"], "success",
        "synthetic callback failed: {output}"
    );
    Some((name, output["content"].clone()))
}
fn router_response(body: &Value) -> String {
    let messages = current_messages(body);
    let text = messages[0]["content"].as_str().unwrap();
    assert!(
        text == INITIAL || text == FOLLOW,
        "fixture router received unexpected source"
    );
    match latest_tool(messages) {
        None => sse(Some(("router-input", "routing_input", json!({})))),
        Some((name, output)) if name == "routing_input" => {
            assert_eq!(output["ok"], true);
            assert_eq!(output["result"]["text"], text);
            sse(Some((
                "router-candidates",
                "routing_candidates",
                json!({"query":"","limit":50}),
            )))
        }
        Some((name, output)) if name == "routing_candidates" => {
            assert_eq!(output["ok"], true);
            let input_tool = messages
                .iter()
                .find(|m| m["role"] == "tool" && m["tool_call_id"] == "router-input")
                .unwrap();
            let input: Value =
                serde_json::from_str(input_tool["content"].as_str().unwrap()).unwrap();
            let profile = input["content"]["result"]["assignees"][0]["profile_id"]
                .as_str()
                .unwrap();
            let op = if text == INITIAL {
                assert!(output["result"].as_array().unwrap().is_empty());
                Operation::New {
                    title: "TodoA".into(),
                    scope: INITIAL.into(),
                    responsible_profile_id: profile.into(),
                    dependencies: vec![],
                }
            } else {
                let candidates: Vec<Candidate> =
                    serde_json::from_value(output["result"].clone()).unwrap();
                assert_eq!(candidates.len(), 1);
                Operation::Amend {
                    target: candidates[0].target.clone(),
                    scope: "개인 할 일의 기존 항목 제목을 '출시 준비 B'로 수정".into(),
                }
            };
            sse(Some((
                "router-route",
                "route_work",
                json!({"segments":[Segment{id:"s1".into(),start_byte:0,end_byte:text.len()}],"resolves":[],"proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items:vec![ProposedSegment{segment_id:"s1".into(),additional_segment_ids:vec![],operation:op}]}}),
            )))
        }
        Some((name, output)) if name == "route_work" => {
            assert_eq!(output["ok"], true);
            sse(None)
        }
        Some((name, _)) => panic!("unexpected fixture router tool {name}"),
    }
}
fn worker_response(body: &Value, evidence: &mut WireEvidence) -> String {
    if evidence.text_only {
        // Deliberately asserts success in prose while emitting no actual effect.
        return sse(None);
    }
    let messages = current_messages(body);
    let prompt = messages[0]["content"].as_str().unwrap().to_string();
    let next = evidence.worker_inputs.len() + 1;
    let revision = *evidence.worker_inputs.entry(prompt).or_insert(next);
    assert!(revision <= 2);
    let title = if revision == 1 { TITLE_A } else { TITLE_B };
    match latest_tool(messages) {
        None => sse(Some(("worker-list", "list_todos", json!({})))),
        Some((name, output)) if name == "list_todos" => {
            let todos = output["todos"].as_array().unwrap();
            let args = if revision == 1 {
                assert!(todos.is_empty());
                json!({"todo":{"title":title,"notes":"synthetic real organizer effect","due":null,"completed":false}})
            } else {
                assert_eq!(todos.len(), 1);
                assert_eq!(todos[0]["title"], TITLE_A);
                json!({"id":todos[0]["id"],"version":todos[0]["version"],"todo":{"title":title,"notes":todos[0]["notes"],"due":todos[0]["due"],"completed":todos[0]["completed"]}})
            };
            evidence.saves += 1;
            sse(Some(("worker-save", "save_todo", args)))
        }
        Some((name, output)) if name == "save_todo" => {
            assert_eq!(output["title"], title);
            assert_eq!(output["version"], revision);
            sse(None)
        }
        Some((name, _)) => panic!("unexpected fixture worker tool {name}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn routing_live_control_worker_prose_without_effect_remains_unverified() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let wire = Arc::new(Mutex::new(WireEvidence {
        text_only: true,
        ..Default::default()
    }));
    let server_wire = wire.clone();
    let fake = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            respond(socket, server_wire.clone()).await;
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("synthetic-unverified-workspace");
    let mut process = GhostChild::open(&root);
    let client = ControlClient::discover(&root).unwrap();
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"save_model_provider","version":0,"provider":{"id":"synthetic-live","name":"Anonymous fixture","kind":"openai_compatible","endpoint":endpoint,"auth":{"type":"none"},"roles":["llm"],"models":[{"id":"synthetic-live","name":"Scripted live fixture","roles":["llm"]}],"enabled":true,"checked_ms":null,"error":null}}}),
    ));
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"select_role_model","role":"llm","model":"synthetic-live/synthetic-live","version":1}}),
    ));
    let profile = ok(action(&client,&key(),json!({"type":"create_profile","name":"fixture","persona":"synthetic prose verification gate"})))["profile_id"].clone();
    let conversation = ok(action(&client,&key(),json!({"type":"create_conversation","profile_id":profile,"model":"synthetic-live/synthetic-live","tools":false})))["conversation_id"].clone();
    let entry = json!({"profile_id":profile,"conversation_id":conversation});
    let id = key();
    let command = natural(&entry, INITIAL, "prompt");
    let submitted = action(&client, &id, command.clone());
    ok(submitted.clone());
    let until = Instant::now() + Duration::from_secs(30);
    let projection = loop {
        let projection = results(&client, &entry);
        if projection["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["current"] == true && r["status"] == "finished_unverified")
        {
            break projection;
        }
        assert!(
            Instant::now() < until,
            "text-only worker was not reported: {projection}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let result = &projection["results"][0];
    assert_eq!(result["status"], "finished_unverified");
    assert_eq!(result["verified"], false);
    assert!(result["receipts"].as_array().unwrap().is_empty());
    assert!(result["model_output"]
        .as_str()
        .unwrap()
        .contains("실제 도구"));
    assert_eq!(projection["completion_outbox"].as_array().unwrap().len(), 1);
    assert_eq!(projection["completion_outbox"][0]["verified"], false);
    assert!(client.snapshot().unwrap()["todos"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(action(&client, &id, command), submitted);
    let evidence = wire.lock().unwrap();
    assert_eq!(evidence.requests, 5);
    assert_eq!(evidence.worker, 1);
    assert_eq!(evidence.saves, 0);
    println!(
        "live process unverified evidence: {}",
        json!({"real_child_process":true,"model_claimed_tool_success":true,"actual_effect_receipts":0,"current_status":result["status"],"verified":false,"organizer_todos":0})
    );
    drop(evidence);
    process.kill();
    fake.abort();
}
async fn respond(mut socket: TcpStream, evidence: Arc<Mutex<WireEvidence>>) {
    let mut bytes = Vec::new();
    loop {
        let mut one = [0];
        socket.read_exact(&mut one).await.unwrap();
        bytes.push(one[0]);
        assert!(bytes.len() < 16384);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let headers = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
    assert!(headers.starts_with("post /v1/chat/completions "));
    assert!(headers.contains("authorization: bearer ghost-anonymous"));
    let length = headers
        .lines()
        .find_map(|line| {
            line.strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap();
    assert!(length < 1_048_576);
    let mut bytes = vec![0; length];
    socket.read_exact(&mut bytes).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["model"], "synthetic-live");
    let tools = body["tools"].as_array().unwrap();
    let router = tools.iter().any(|t| t["function"]["name"] == "route_work");
    let response = {
        let mut state = evidence.lock().unwrap();
        state.requests += 1;
        if router {
            state.router += 1;
            assert_eq!(tools.len(), 6);
            router_response(&body)
        } else {
            state.worker += 1;
            assert!(!tools.iter().any(|t| t["function"]["name"]
                .as_str()
                .unwrap()
                .starts_with("routing_")));
            worker_response(&body, &mut state)
        }
    };
    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len());
    socket.write_all(response.as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn routing_live_control_natural_verified_organizer_restart_amend_and_exact_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let wire = Arc::new(Mutex::new(WireEvidence::default()));
    let server_wire = wire.clone();
    let fake = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            respond(socket, server_wire.clone()).await;
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("synthetic-workspace");
    let mut process = GhostChild::open(&root);
    let client = ControlClient::discover(&root).unwrap();
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"save_model_provider","version":0,"provider":{"id":"synthetic-live","name":"Anonymous fixture","kind":"openai_compatible","endpoint":endpoint,"auth":{"type":"none"},"roles":["llm"],"models":[{"id":"synthetic-live","name":"Scripted live fixture","roles":["llm"]}],"enabled":true,"checked_ms":null,"error":null}}}),
    ));
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"select_role_model","role":"llm","model":"synthetic-live/synthetic-live","version":1}}),
    ));
    let profile=ok(action(&client,&key(),json!({"type":"create_profile","name":"fixture","persona":"synthetic routing process gate"})))["profile_id"].clone();
    let conversation=ok(action(&client,&key(),json!({"type":"create_conversation","profile_id":profile,"model":"synthetic-live/synthetic-live","tools":false})))["conversation_id"].clone();
    let entry = json!({"profile_id":profile,"conversation_id":conversation});
    let first_id = key();
    let first_command = natural(&entry, INITIAL, "prompt");
    let first = action(&client, &first_id, first_command.clone());
    ok(first.clone());
    assert_eq!(action(&client, &first_id, first_command.clone()), first);
    let one = completed(&client, &entry, 1).await;
    let initial = one["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["current"] == true)
        .unwrap()
        .clone();
    assert_eq!(one["bindings"].as_array().unwrap().len(), 1);
    assert_eq!(one["completion_outbox"].as_array().unwrap().len(), 1);
    assert_eq!(initial["status"], "finished_verified");
    assert!(initial["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["tool"] == "save_todo" && r["verified"] == true));
    let first_view = view(&client, &entry);
    assert_eq!(first_view["works"].as_array().unwrap().len(), 1);
    assert_eq!(first_view["works"][0]["id"], initial["work_id"]);
    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot["todos"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["todos"][0]["title"], TITLE_A);
    let todo_id = snapshot["todos"][0]["id"].clone();
    let before_counts = counts(&snapshot);
    assert_eq!(action(&client, &first_id, first_command.clone()), first);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(counts(&client.snapshot().unwrap()), before_counts);
    assert_eq!(wire.lock().unwrap().saves, 1);
    process.kill();
    drop(client);
    process = GhostChild::open(&root);
    let client = ControlClient::discover(&root).unwrap();
    let restored = completed(&client, &entry, 1).await;
    let restored_result = restored["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["current"] == true)
        .unwrap();
    for field in ["work_id", "conversation_id", "task_id", "intent_id"] {
        assert_eq!(
            restored_result[field], initial[field],
            "restart changed {field}"
        );
    }
    assert_eq!(restored_result["receipts"], initial["receipts"]);
    assert_eq!(action(&client, &first_id, first_command), first);
    assert_eq!(counts(&client.snapshot().unwrap()), before_counts);
    let follow_id = key();
    let follow_command = natural(&entry, FOLLOW, "follow_up");
    let follow = action(&client, &follow_id, follow_command.clone());
    ok(follow.clone());
    assert_eq!(action(&client, &follow_id, follow_command.clone()), follow);
    let two = completed(&client, &entry, 2).await;
    let current = two["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["current"] == true)
        .unwrap();
    assert_eq!(current["status"], "finished_verified");
    assert_eq!(current["work_id"], initial["work_id"]);
    assert_eq!(current["conversation_id"], initial["conversation_id"]);
    assert_ne!(current["task_id"], initial["task_id"]);
    assert_eq!(two["bindings"].as_array().unwrap().len(), 2);
    assert_eq!(two["completion_outbox"].as_array().unwrap().len(), 2);
    assert_eq!(
        two["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["current"] == true && r["verified"] == true)
            .count(),
        1
    );
    assert!(two["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["intent_id"] == initial["intent_id"]
            && r["status"] == "superseded"
            && r["verified"] == false));
    let final_view = view(&client, &entry);
    assert_eq!(final_view["works"].as_array().unwrap().len(), 1);
    assert_eq!(final_view["works"][0]["work_revision"], 2);
    assert_eq!(final_view["works"][0]["decision_revision"], 2);
    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot["todos"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["todos"][0]["id"], todo_id);
    assert_eq!(snapshot["todos"][0]["title"], TITLE_B);
    assert_eq!(snapshot["todos"][0]["version"], 2);
    let final_counts = counts(&snapshot);
    assert_eq!(action(&client, &follow_id, follow_command), follow);
    let collision = action(
        &client,
        &follow_id,
        natural(&entry, "UUID 충돌의 다른 요청", "follow_up"),
    );
    assert_eq!(collision["ok"], false);
    assert_eq!(collision["error_code"], "input_collision");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(counts(&client.snapshot().unwrap()), final_counts);
    assert_eq!(
        results(&client, &entry)["completion_outbox"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let evidence = wire.lock().unwrap();
    assert_eq!(evidence.saves, 2);
    assert_eq!(evidence.requests, 14);
    assert_eq!(evidence.router, 8);
    assert_eq!(evidence.worker, 6);
    println!(
        "live process routing evidence: {}",
        json!({"real_child_process":true,"real_owner_control":true,"anonymous_sdk_http":true,"natural_submissions":2,"auto_dispatch":true,"organizer_save_receipts":evidence.saves,"current_status":current["status"],"verified":current["verified"],"restart_work_and_execution_conversation_stable":true,"new_revision_task":true,"todo_id_preserved":true,"exact_retry_tasks_effects_outbox_stable":true,"router_http":evidence.router,"worker_http":evidence.worker,"completion_outbox":2})
    );
    drop(evidence);
    process.kill();
    fake.abort();
}

/// Native fixture pauses after the actual local write commits and before the
/// SDK ToolOutput receipt commits. The installed production build has no gate.
#[cfg(feature = "native-fixtures")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn routing_live_control_kill_after_real_effect_blocks_reissue_and_amend_dispatch() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let wire = Arc::new(Mutex::new(WireEvidence::default()));
    let server_wire = wire.clone();
    let fake = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            respond(socket, server_wire.clone()).await;
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("synthetic-effect-crash-workspace");
    std::fs::create_dir_all(&root).unwrap();
    let gate = root.join(".routing-fixture-control-gate.json");
    let reached = root.join(".routing-fixture-control-reached.json");
    std::fs::write(&gate, serde_json::to_vec(&json!({"schema":"ghost-routing-host-fixture/1","message_id":"*","stage":"after_routing_effect"})).unwrap()).unwrap();
    let mut process = GhostChild::open(&root);
    let client = ControlClient::discover(&root).unwrap();
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"save_model_provider","version":0,"provider":{"id":"synthetic-live","name":"Anonymous fixture","kind":"openai_compatible","endpoint":endpoint,"auth":{"type":"none"},"roles":["llm"],"models":[{"id":"synthetic-live","name":"Scripted live fixture","roles":["llm"]}],"enabled":true,"checked_ms":null,"error":null}}}),
    ));
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"select_role_model","role":"llm","model":"synthetic-live/synthetic-live","version":1}}),
    ));
    let profile = ok(action(
        &client,
        &key(),
        json!({"type":"create_profile","name":"fixture","persona":"synthetic effect crash gate"}),
    ))["profile_id"]
        .clone();
    let conversation=ok(action(&client,&key(),json!({"type":"create_conversation","profile_id":profile,"model":"synthetic-live/synthetic-live","tools":false})))["conversation_id"].clone();
    let entry = json!({"profile_id":profile,"conversation_id":conversation});
    let id = key();
    let command = natural(&entry, INITIAL, "prompt");
    let submitted = action(&client, &id, command.clone());
    ok(submitted.clone());
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        if reached.is_file() && wire.lock().unwrap().router == 4 {
            break;
        }
        assert!(
            Instant::now() < until,
            "actual organizer effect crash boundary was not reached"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let marker: Value = serde_json::from_slice(&std::fs::read(&reached).unwrap()).unwrap();
    assert_eq!(marker["stage"], "after_routing_effect");
    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot["todos"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["todos"][0]["title"], TITLE_A);
    assert_eq!(snapshot["todos"][0]["version"], 1);
    let todo = snapshot["todos"][0].clone();
    let projection = results(&client, &entry);
    let binding = projection["bindings"][0].clone();
    let execution_id = binding["conversation_id"].clone();
    let original_task = binding["task_id"].clone();
    let work: Work = serde_json::from_value(view(&client, &entry)["works"][0].clone()).unwrap();
    assert_eq!(work.work_revision, 1);
    assert_eq!(wire.lock().unwrap().saves, 1);
    process.kill();
    drop(client);
    std::fs::remove_file(&gate).unwrap();
    std::fs::remove_file(&reached).unwrap();
    process = GhostChild::open(&root);
    let client = ControlClient::discover(&root).unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    let recovered = loop {
        let projection = results(&client, &entry);
        if projection["results"].as_array().unwrap().iter().any(|r| {
            r["current"] == true
                && r["status"] == "uncertain"
                && r["receipts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["tool"] == "save_todo" && e["phase"] == "uncertain")
        }) {
            break projection;
        }
        assert!(
            Instant::now() < until,
            "restarted process did not preserve uncertain write: {projection}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let current = recovered["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["current"] == true)
        .unwrap();
    assert_eq!(current["verified"], false);
    assert_eq!(current["conversation_id"], execution_id);
    assert_eq!(current["task_id"], original_task);
    let receipt = current["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["tool"] == "save_todo")
        .unwrap();
    assert_eq!(receipt["phase"], "uncertain");
    assert_eq!(receipt["output"], Value::Null);
    assert!(!recovered["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["current"] == true && r["verified"] == true));
    assert_eq!(client.snapshot().unwrap()["todos"][0], todo);
    let recovered_counts = counts(&client.snapshot().unwrap());
    let recovered_http = wire.lock().unwrap().requests;
    assert_eq!(action(&client, &id, command), submitted);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(counts(&client.snapshot().unwrap()), recovered_counts);
    assert_eq!(wire.lock().unwrap().requests, recovered_http);
    let amended = route(
        &client,
        json!({"type":"routing_admit","entry":entry,"text":FOLLOW,
        "segments":[Segment{id:"s1".into(),start_byte:0,end_byte:FOLLOW.len()}],"resolves":[],
        "proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items:vec![ProposedSegment{segment_id:"s1".into(),additional_segment_ids:vec![],
            operation:Operation::Amend{target:work.target(),scope:"기존 개인 할 일 제목을 출시 준비 B로 수정".into()}}]}}),
    );
    assert_eq!(amended["items"][0]["work_id"], work.id);
    assert_eq!(amended["items"][0]["work_revision"], 2);
    let until = Instant::now() + Duration::from_secs(30);
    let blocked = loop {
        let projection = results(&client, &entry);
        if projection["results"].as_array().unwrap().iter().any(|r| {
            r["decision_revision"] == 2 && r["current"] == true && r["status"] == "uncertain"
        }) {
            break projection;
        }
        assert!(
            Instant::now() < until,
            "amendment did not stop behind uncertain prior effect: {projection}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let next = blocked["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["current"] == true)
        .unwrap();
    assert_eq!(next["verified"], false);
    assert_eq!(next["task_id"], Value::Null);
    assert_eq!(next["conversation_id"], execution_id);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot["todos"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["todos"][0], todo);
    assert_eq!(counts(&snapshot), recovered_counts);
    let evidence = wire.lock().unwrap();
    assert_eq!(evidence.saves, 1);
    assert_eq!(evidence.worker, 2);
    assert_eq!(evidence.requests, recovered_http);
    println!(
        "live process crash evidence: {}",
        json!({"real_child_killed_after_effect_before_receipt":true,"actual_todo_saved_once":true,"recovered_status":"uncertain","verified":false,"receipt_output_missing":true,"exact_retry_no_new_effect":true,"amendment_execution_blocked":true,"amendment_task_id":next["task_id"],"effect_writes":evidence.saves,"worker_http":evidence.worker})
    );
    drop(evidence);
    process.kill();
    fake.abort();
}
