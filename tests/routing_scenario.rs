#![cfg(feature = "host")]
//! A compound natural-language scenario through the real owner-control process,
//! anonymous SDK HTTP, durable Work routing and actual synthetic organizer effects.
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
    requests: usize,
    router: usize,
    worker: usize,
    saves: usize,
    saved_titles: BTreeMap<String, usize>,
    admissions: BTreeMap<String, Value>,
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

const INITIAL_CLAUSES: &[&str] = &[
    "개인 할 일에 '블로그 초안 A'를 저장하고,",
    "'고객 분석 A'도 저장하고,",
    "'회의 자료 A'도 저장해 줘.",
];
const FOLLOW_CLAUSES: &[&str] = &[
    "블로그 할 일 제목은 '블로그 초안 B'로 바꾸고,",
    "고객 분석은 '고객 분석 B'로 바꾸고,",
    "새 할 일 '경쟁 비교 A'도 저장해 줘.",
];
const AMBIGUOUS_CLAUSES: &[&str] = &[
    "그 자료는 '회의 자료 B'로 바꾸고,",
    "경쟁 비교는 '경쟁 비교 B'로 바꿔 줘.",
];
const ANSWER: &str = "회의 자료를 뜻했어.";
const WORK_TITLES: &[&str] = &["블로그", "고객 분석", "회의 자료", "경쟁 비교"];
const TODO_A: &[&str] = &["블로그 초안 A", "고객 분석 A", "회의 자료 A", "경쟁 비교 A"];
const TODO_B: &[&str] = &["블로그 초안 B", "고객 분석 B", "회의 자료 B", "경쟁 비교 B"];

/// One sentence, including its punctuation, with whitespace-only gaps.
fn sentence(clauses: &[&str]) -> (String, Vec<Segment>) {
    let text = clauses.join(" ");
    let mut start_byte = 0;
    let segments = clauses
        .iter()
        .enumerate()
        .map(|(i, clause)| {
            let segment = Segment {
                id: format!("s{}", i + 1),
                start_byte,
                end_byte: start_byte + clause.len(),
            };
            start_byte = segment.end_byte + 1;
            segment
        })
        .collect();
    (text, segments)
}
fn tool_content(messages: &[Value], id: &str) -> Value {
    let message = messages
        .iter()
        .find(|m| m["role"] == "tool" && m["tool_call_id"] == id)
        .unwrap();
    serde_json::from_str::<Value>(message["content"].as_str().unwrap()).unwrap()["content"].clone()
}
fn todo_scope(title: &str) -> String {
    format!("개인 할 일 제목을 '{title}'로 저장 또는 수정해 줘.")
}
fn router_response(body: &Value, evidence: &mut WireEvidence) -> String {
    let messages = current_messages(body);
    let text = messages[0]["content"].as_str().unwrap();
    assert!(
        [
            sentence(INITIAL_CLAUSES).0,
            sentence(FOLLOW_CLAUSES).0,
            sentence(AMBIGUOUS_CLAUSES).0,
            ANSWER.into()
        ]
        .iter()
        .any(|s| s == text),
        "unexpected scenario input: {text}"
    );
    match latest_tool(messages) {
        None => sse(Some(("router-input", "routing_input", json!({})))),
        Some((name, output)) if name == "routing_input" => {
            assert_eq!(output["ok"], true);
            assert_eq!(output["result"]["text"], text);
            assert_eq!(output["result"]["utf8_byte_length"], text.len());
            sse(Some((
                "router-candidates",
                "routing_candidates",
                json!({"query":"","limit":50}),
            )))
        }
        Some((name, output)) if name == "routing_candidates" => {
            assert_eq!(output["ok"], true);
            let input = tool_content(messages, "router-input")["result"].clone();
            let profile = input["assignees"][0]["profile_id"].as_str().unwrap();
            let candidates: Vec<Candidate> =
                serde_json::from_value(output["result"].clone()).unwrap();
            let target = |title: &str| {
                candidates
                    .iter()
                    .find(|c| c.title == title)
                    .unwrap()
                    .target
                    .clone()
            };
            let create = |index: usize| Operation::New {
                title: WORK_TITLES[index].into(),
                scope: todo_scope(TODO_A[index]),
                responsible_profile_id: profile.into(),
                dependencies: vec![],
            };
            let amend = |index: usize| Operation::Amend {
                target: target(WORK_TITLES[index]),
                scope: todo_scope(TODO_B[index]),
            };
            let (segments, operations, resolves) = if text == sentence(INITIAL_CLAUSES).0 {
                assert!(candidates.is_empty());
                (
                    sentence(INITIAL_CLAUSES).1,
                    vec![create(0), create(1), create(2)],
                    vec![],
                )
            } else if text == sentence(FOLLOW_CLAUSES).0 {
                assert_eq!(candidates.len(), 3);
                (
                    sentence(FOLLOW_CLAUSES).1,
                    vec![amend(0), amend(1), create(3)],
                    vec![],
                )
            } else if text == sentence(AMBIGUOUS_CLAUSES).0 {
                assert_eq!(candidates.len(), 4);
                (
                    sentence(AMBIGUOUS_CLAUSES).1,
                    vec![
                        Operation::Clarify {
                            question: "블로그와 회의 자료 중 어느 할 일을 바꿀까요?".into(),
                            candidates: vec![target("블로그"), target("회의 자료")],
                        },
                        amend(3),
                    ],
                    vec![],
                )
            } else {
                assert_eq!(candidates.len(), 4);
                let selected: Target =
                    serde_json::from_value(input["clarification_target"].clone()).unwrap();
                assert_eq!(selected, target("회의 자료"));
                let resolves: Vec<ResolutionRef> =
                    serde_json::from_value(input["expected_resolves"].clone()).unwrap();
                assert_eq!(resolves.len(), 1);
                assert_eq!(resolves[0].answer_segment_id, "s1");
                let held = &input["held_clarifications"][0];
                assert_eq!(
                    held["reference"],
                    serde_json::to_value(&resolves[0]).unwrap()
                );
                assert_eq!(
                    held["source"]["admission"]["input"]["text"],
                    sentence(AMBIGUOUS_CLAUSES).0
                );
                assert_eq!(
                    held["source"]["admission"]["items"][0]["operation"]["type"],
                    "clarify"
                );
                (
                    vec![Segment {
                        id: "s1".into(),
                        start_byte: 0,
                        end_byte: text.len(),
                    }],
                    vec![Operation::Amend {
                        target: selected,
                        scope: todo_scope(TODO_B[2]),
                    }],
                    resolves,
                )
            };
            let items = operations
                .into_iter()
                .enumerate()
                .map(|(i, operation)| ProposedSegment {
                    segment_id: format!("s{}", i + 1),
                    additional_segment_ids: vec![],
                    operation,
                })
                .collect();
            sse(Some((
                "router-route",
                "route_work",
                json!({"segments":segments,"resolves":resolves,
                "proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items}}),
            )))
        }
        Some((name, output)) if name == "route_work" => {
            assert_eq!(output["ok"], true, "{output}");
            assert!(evidence
                .admissions
                .insert(text.into(), output["result"].clone())
                .is_none());
            sse(None)
        }
        Some((name, _)) => panic!("unexpected scenario router tool {name}"),
    }
}
fn worker_response(body: &Value, evidence: &mut WireEvidence) -> String {
    let messages = current_messages(body);
    let prompt = messages[0]["content"].as_str().unwrap();
    let (index, title, version) = (0..4)
        .find_map(|i| {
            if prompt.contains(&todo_scope(TODO_A[i])) {
                Some((i, TODO_A[i], 1))
            } else if prompt.contains(&todo_scope(TODO_B[i])) {
                Some((i, TODO_B[i], 2))
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            panic!("worker did not receive an authoritative scenario scope: {prompt}")
        });
    match latest_tool(messages) {
        None => sse(Some(("worker-list", "list_todos", json!({})))),
        Some((name, output)) if name == "list_todos" => {
            let todos = output["todos"].as_array().unwrap();
            assert!(!todos.iter().any(|todo| todo["title"] == title));
            let args = if version == 1 {
                json!({"todo":{"title":title,"notes":format!("synthetic scenario {}",WORK_TITLES[index]),"due":null,"completed":false}})
            } else {
                let old = todos
                    .iter()
                    .find(|todo| todo["title"] == TODO_A[index])
                    .unwrap();
                assert_eq!(old["version"], 1);
                json!({"id":old["id"],"version":old["version"],"todo":{"title":title,"notes":old["notes"],"due":old["due"],"completed":old["completed"]}})
            };
            evidence.saves += 1;
            *evidence.saved_titles.entry(title.into()).or_default() += 1;
            sse(Some(("worker-save", "save_todo", args)))
        }
        Some((name, output)) if name == "save_todo" => {
            assert_eq!(output["title"], title);
            assert_eq!(output["version"], version);
            sse(None)
        }
        Some((name, _)) => panic!("unexpected scenario worker tool {name}"),
    }
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
    assert_eq!(body["model"], "synthetic-scenario");
    let tools = body["tools"].as_array().unwrap();
    let router = tools.iter().any(|t| t["function"]["name"] == "route_work");
    let response = {
        let mut state = evidence.lock().unwrap();
        state.requests += 1;
        if router {
            state.router += 1;
            assert_eq!(tools.len(), 6);
            router_response(&body, &mut state)
        } else {
            state.worker += 1;
            assert!(!tools.iter().any(|t| t["function"]["name"]
                .as_str()
                .unwrap()
                .starts_with("routing_")));
            worker_response(&body, &mut state)
        }
    };
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len());
    socket.write_all(response.as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
}

async fn receipt(client: &ControlClient, entry: &Value, message: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let value = route(
            client,
            json!({"type":"routing_receipt","entry":entry,"message_id":message}),
        );
        if !value.is_null() {
            return value;
        }
        assert!(Instant::now() < until, "scenario admission did not commit");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn entry_completed(client: &ControlClient, response: &Value) {
    let task_id = response["result"]["submission"]["task_id"]
        .as_str()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let snapshot = client.snapshot().unwrap();
        let done = snapshot["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["conversations"].as_array().unwrap())
            .flat_map(|c| c["tasks"].as_array().unwrap())
            .any(|task| task["id"] == task_id && task["phase"] == "complete");
        if done {
            return;
        }
        assert!(
            Instant::now() < until,
            "entry router task did not complete: {task_id}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn completed(
    client: &ControlClient,
    entry: &Value,
    current_count: usize,
    binding_count: usize,
) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let projection = results(client, entry);
        let current: Vec<_> = projection["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["current"] == true)
            .collect();
        if current.len() == current_count
            && projection["bindings"].as_array().unwrap().len() == binding_count
            && current
                .iter()
                .all(|r| r["status"] == "finished_verified" && r["verified"] == true)
        {
            return projection;
        }
        assert!(
            Instant::now() < until,
            "scenario execution did not finish: {projection}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
fn work(client: &ControlClient, entry: &Value, id: &Value) -> Work {
    serde_json::from_value(route(
        client,
        json!({"type":"routing_work","entry":entry,"work_id":id}),
    ))
    .unwrap()
}
fn current_for<'a>(projection: &'a Value, id: &Value) -> &'a Value {
    projection["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["work_id"] == *id && r["current"] == true)
        .unwrap()
}
fn assert_effect(result: &Value, todo: &Value, admission: &Value, clause: &str) {
    assert_eq!(result["source_admission_id"], admission["id"]);
    assert_eq!(result["source_fragments"].as_array().unwrap().len(), 1);
    assert_eq!(result["source_fragments"][0]["text"], clause);
    let effect = result["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["tool"] == "save_todo")
        .unwrap();
    assert_eq!(effect["verified"], true);
    assert_eq!(effect["profile_id"], result["profile_id"]);
    assert_eq!(effect["output"]["content"], *todo);
    assert_eq!(effect["verification"]["kind"], "durable_object");
    assert_eq!(effect["verification"]["namespace"], "todo");
    assert_eq!(effect["verification"]["id"], todo["id"]);
    assert_eq!(effect["verification"]["version"], todo["version"]);
}
fn todo(snapshot: &Value, title: &str) -> Value {
    snapshot["todos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["title"] == title)
        .unwrap()
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn routing_scenario_compound_followup_partial_clarification_effects_restart_exact_retry() {
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
    let root = dir.path().join("synthetic-compound-scenario");
    let mut process = GhostChild::open(&root);
    let client = ControlClient::discover(&root).unwrap();
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"save_model_provider","version":0,
        "provider":{"id":"synthetic-scenario","name":"Anonymous scenario fixture","kind":"openai_compatible","endpoint":endpoint,
        "auth":{"type":"none"},"roles":["llm"],"models":[{"id":"synthetic-scenario","name":"Scripted scenario","roles":["llm"]}],
        "enabled":true,"checked_ms":null,"error":null}}}),
    ));
    ok(action(
        &client,
        &key(),
        json!({"type":"workspace","action":{"type":"select_role_model","role":"llm","model":"synthetic-scenario/synthetic-scenario","version":1}}),
    ));
    let profile = ok(action(
        &client,
        &key(),
        json!({"type":"create_profile","name":"scenario","persona":"synthetic routing scenario"}),
    ))["profile_id"]
        .clone();
    let conversation = ok(action(&client, &key(), json!({"type":"create_conversation","profile_id":profile,"model":"synthetic-scenario/synthetic-scenario","tools":false})))["conversation_id"].clone();
    let entry = json!({"profile_id":profile,"conversation_id":conversation});
    let mut retries = vec![];

    let first_id = key();
    let first_command = natural(&entry, &sentence(INITIAL_CLAUSES).0, "prompt");
    let first_response = action(&client, &first_id, first_command.clone());
    ok(first_response.clone());
    entry_completed(&client, &first_response).await;
    retries.push((first_id.clone(), first_command, first_response));
    let first_admission = receipt(&client, &entry, &first_id).await["admission"].clone();
    assert_eq!(first_admission["items"].as_array().unwrap().len(), 3);
    let first_results = completed(&client, &entry, 3, 3).await;
    let initial_snapshot = client.snapshot().unwrap();
    let entry_snapshot = initial_snapshot["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == entry["profile_id"])
        .unwrap()["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == entry["conversation_id"])
        .unwrap();
    assert!(entry_snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "user" && m["request_id"] == first_id));
    assert_eq!(initial_snapshot["todos"].as_array().unwrap().len(), 3);
    let mut ids: Vec<Value> = first_admission["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["work_id"].clone())
        .collect();
    let original_todos: Vec<_> = TODO_A[..3]
        .iter()
        .map(|title| todo(&initial_snapshot, title))
        .collect();
    for i in 0..3 {
        assert_eq!(first_admission["items"][i]["operation"]["type"], "new");
        assert_effect(
            current_for(&first_results, &ids[i]),
            &original_todos[i],
            &first_admission,
            INITIAL_CLAUSES[i],
        );
    }
    let original_meeting = work(&client, &entry, &ids[2]);
    let original_meeting_result = current_for(&first_results, &ids[2]).clone();

    let follow_id = key();
    let follow_command = natural(&entry, &sentence(FOLLOW_CLAUSES).0, "follow_up");
    let follow_response = action(&client, &follow_id, follow_command.clone());
    ok(follow_response.clone());
    entry_completed(&client, &follow_response).await;
    retries.push((follow_id.clone(), follow_command, follow_response));
    let follow_admission = receipt(&client, &entry, &follow_id).await["admission"].clone();
    assert_eq!(follow_admission["items"].as_array().unwrap().len(), 3);
    for i in 0..2 {
        assert_eq!(follow_admission["items"][i]["operation"]["type"], "amend");
        assert_eq!(follow_admission["items"][i]["work_id"], ids[i]);
        assert_eq!(follow_admission["items"][i]["decision_revision"], 2);
    }
    assert_eq!(follow_admission["items"][2]["operation"]["type"], "new");
    ids.push(follow_admission["items"][2]["work_id"].clone());
    let follow_results = completed(&client, &entry, 4, 6).await;
    assert_eq!(work(&client, &entry, &ids[2]), original_meeting);
    let follow_snapshot = client.snapshot().unwrap();
    let comparison_todo = todo(&follow_snapshot, TODO_A[3]);
    for i in 0..2 {
        let updated = todo(&follow_snapshot, TODO_B[i]);
        assert_eq!(updated["id"], original_todos[i]["id"]);
        assert_eq!(updated["version"], 2);
        let current = current_for(&follow_results, &ids[i]);
        assert_eq!(
            current["conversation_id"],
            current_for(&first_results, &ids[i])["conversation_id"]
        );
        assert_ne!(
            current["task_id"],
            current_for(&first_results, &ids[i])["task_id"]
        );
        assert_effect(current, &updated, &follow_admission, FOLLOW_CLAUSES[i]);
    }
    assert_effect(
        current_for(&follow_results, &ids[3]),
        &comparison_todo,
        &follow_admission,
        FOLLOW_CLAUSES[2],
    );

    let ambiguous_id = key();
    let ambiguous_command = natural(&entry, &sentence(AMBIGUOUS_CLAUSES).0, "follow_up");
    let ambiguous_response = action(&client, &ambiguous_id, ambiguous_command.clone());
    ok(ambiguous_response.clone());
    entry_completed(&client, &ambiguous_response).await;
    retries.push((ambiguous_id.clone(), ambiguous_command, ambiguous_response));
    let held_view = receipt(&client, &entry, &ambiguous_id).await;
    let held_admission = &held_view["admission"];
    assert_eq!(held_admission["items"].as_array().unwrap().len(), 2);
    let held = &held_admission["items"][0];
    assert_eq!(held["operation"]["type"], "clarify");
    assert_eq!(held["operation"]["candidates"].as_array().unwrap().len(), 2);
    for field in ["work_id", "work_revision", "decision_revision", "intent_id"] {
        assert!(held[field].is_null());
    }
    assert!(held_view["resolutions"].as_array().unwrap().is_empty());
    assert_eq!(held_admission["items"][1]["work_id"], ids[3]);
    let partial_results = completed(&client, &entry, 4, 7).await;
    assert_eq!(work(&client, &entry, &ids[2]), original_meeting);
    assert_eq!(
        current_for(&partial_results, &ids[2])["task_id"],
        original_meeting_result["task_id"]
    );
    let partial_snapshot = client.snapshot().unwrap();
    assert_eq!(partial_snapshot["todos"].as_array().unwrap().len(), 4);
    assert_eq!(todo(&partial_snapshot, TODO_A[2]), original_todos[2]);
    let updated_comparison = todo(&partial_snapshot, TODO_B[3]);
    assert_eq!(updated_comparison["id"], comparison_todo["id"]);
    assert_effect(
        current_for(&partial_results, &ids[3]),
        &updated_comparison,
        held_admission,
        AMBIGUOUS_CLAUSES[1],
    );
    assert_eq!(wire.lock().unwrap().saves, 7);

    let answer_id = key();
    let resolution = ResolutionRef {
        source_admission_id: held_admission["id"].as_str().unwrap().into(),
        source_segment_id: "s1".into(),
        expected_input_hash: held_admission["input_hash"].as_str().unwrap().into(),
        answer_segment_id: "s1".into(),
    };
    let answer_command = json!({"type":"routing","action":{"type":"routing_natural","entry":entry,"text":ANSWER,"kind":"follow_up",
        "resolves":[resolution],"clarification_target":original_meeting.target()}});
    let answer_response = action(&client, &answer_id, answer_command.clone());
    ok(answer_response.clone());
    entry_completed(&client, &answer_response).await;
    retries.push((answer_id.clone(), answer_command, answer_response));
    let answer_admission = receipt(&client, &entry, &answer_id).await["admission"].clone();
    assert_eq!(answer_admission["items"].as_array().unwrap().len(), 1);
    assert_eq!(answer_admission["items"][0]["operation"]["type"], "amend");
    assert_eq!(answer_admission["items"][0]["work_id"], ids[2]);
    assert_eq!(answer_admission["items"][0]["decision_revision"], 2);
    let final_results = completed(&client, &entry, 4, 8).await;
    let resolved = receipt(&client, &entry, &ambiguous_id).await;
    assert_eq!(resolved["resolutions"].as_array().unwrap().len(), 1);
    assert_eq!(
        resolved["resolutions"][0]["answer_admission_id"],
        answer_admission["id"]
    );
    assert_eq!(resolved["resolutions"][0]["source_segment_id"], "s1");
    let final_view = view(&client, &entry);
    assert_eq!(final_view["works"].as_array().unwrap().len(), 4);
    assert_eq!(final_view["decisions"].as_array().unwrap().len(), 8);
    let final_snapshot = client.snapshot().unwrap();
    assert_eq!(final_snapshot["todos"].as_array().unwrap().len(), 4);
    let meeting_todo = todo(&final_snapshot, TODO_B[2]);
    assert_eq!(meeting_todo["id"], original_todos[2]["id"]);
    let meeting_result = current_for(&final_results, &ids[2]);
    assert_eq!(
        meeting_result["conversation_id"],
        original_meeting_result["conversation_id"]
    );
    assert_ne!(
        meeting_result["task_id"],
        original_meeting_result["task_id"]
    );
    assert_effect(meeting_result, &meeting_todo, &answer_admission, ANSWER);
    for i in 0..4 {
        assert_eq!(work(&client, &entry, &ids[i]).work_revision, 2);
        assert_eq!(todo(&final_snapshot, TODO_B[i])["version"], 2);
    }
    assert_eq!(
        final_results["completion_outbox"].as_array().unwrap().len(),
        8
    );
    let final_counts = counts(&final_snapshot);
    // Router completion is a separate SDK response after the admission commits.
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        if wire.lock().unwrap().router == 16 {
            break;
        }
        assert!(
            Instant::now() < until,
            "router did not acknowledge all four admissions"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let final_requests = wire.lock().unwrap().requests;
    process.kill();
    drop(client);
    process = GhostChild::open(&root);
    let client = ControlClient::discover(&root).unwrap();
    let restored = completed(&client, &entry, 4, 8).await;
    for id in &ids {
        let previous = current_for(&final_results, id);
        let recovered = current_for(&restored, id);
        for field in [
            "work_id",
            "work_revision",
            "decision_revision",
            "conversation_id",
            "task_id",
            "intent_id",
            "source_admission_id",
            "source_fragments",
            "receipts",
        ] {
            assert_eq!(recovered[field], previous[field], "restart changed {field}");
        }
    }
    for (id, command, response) in retries {
        assert_eq!(action(&client, &id, command), response);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let restored_snapshot = client.snapshot().unwrap();
    assert_eq!(restored_snapshot["todos"], final_snapshot["todos"]);
    assert_eq!(counts(&restored_snapshot), final_counts);
    assert_eq!(
        results(&client, &entry)["completion_outbox"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    assert_eq!(view(&client, &entry), final_view);
    let evidence = wire.lock().unwrap();
    assert_eq!(evidence.saves, 8);
    assert_eq!(evidence.admissions.len(), 4);
    assert_eq!(evidence.saved_titles.len(), 8);
    assert!(evidence.saved_titles.values().all(|count| *count == 1));
    assert_eq!(evidence.router, 16);
    assert_eq!(evidence.worker, 24);
    assert_eq!(evidence.requests, 40);
    assert_eq!(evidence.requests, final_requests);
    println!(
        "compound scenario evidence: {}",
        json!({"real_host_process":true,"anonymous_sdk_http":true,
        "initial_works":3,"followup_amendments":2,"followup_new":1,"partial_clarification_held":1,
        "independent_clause_executed":true,"answer_preserved_work_and_execution_conversation":true,
        "durable_todos":4,"verified_save_receipts":8,"restart_exact_retry_no_new_calls_tasks_effects":true})
    );
    drop(evidence);
    process.kill();
    fake.abort();
}
