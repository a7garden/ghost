#![cfg(all(feature = "host", feature = "native-fixtures"))]
use ghost::{
    control::{api::Action, ControlClient},
    host::work_routing::*,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
struct Server {
    child: Child,
    endpoint: String,
}
impl Server {
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
            let status = child.wait().unwrap();
            panic!("fixture host startup failed {status}: {failure}");
        }
        let ready: Value = serde_json::from_str(&line).expect("real host readiness JSON");
        assert_eq!(ready["mode"], "headless");
        let endpoint = ready["endpoint"].as_str().unwrap().into();
        Self { child, endpoint }
    }
    fn kill(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
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
fn route(client: &ControlClient, id: &str, action_value: Value) -> Value {
    action(client, id, json!({"type":"routing","action":action_value}))
}
fn result(v: Value) -> Value {
    assert_eq!(v["ok"], true, "{v}");
    v["result"].clone()
}
fn entry(client: &ControlClient) -> Value {
    let p = result(action(
        client,
        &key(),
        json!({"type":"create_profile","name":"fixture","persona":"isolated host"}),
    ))["profile_id"]
        .clone();
    let c = result(action(
        client,
        &key(),
        json!({"type":"create_conversation","profile_id":p,"model":"mock","tools":false}),
    ))["conversation_id"]
        .clone();
    json!({"profile_id":p,"conversation_id":c})
}
fn parts(texts: &[&str]) -> (String, Vec<Segment>) {
    let mut t = String::new();
    let mut s = vec![];
    for (i, p) in texts.iter().enumerate() {
        if i > 0 {
            t.push('\n')
        };
        let start_byte = t.len();
        t.push_str(p);
        s.push(Segment {
            id: format!("s{}", i + 1),
            start_byte,
            end_byte: t.len(),
        });
    }
    (t, s)
}
fn proposal(ops: Vec<Operation>) -> RoutingProposal {
    RoutingProposal {
        schema: PROPOSAL_SCHEMA.into(),
        items: ops
            .into_iter()
            .enumerate()
            .map(|(i, operation)| ProposedSegment {
                segment_id: format!("s{}", i + 1),
                additional_segment_ids: vec![],
                operation,
            })
            .collect(),
    }
}
fn new(title: &str, entry: &Value) -> Operation {
    Operation::New {
        title: title.into(),
        scope: title.into(),
        responsible_profile_id: entry["profile_id"].as_str().unwrap().into(),
        dependencies: vec![],
    }
}
fn command_value(e: &Value, texts: &[&str], p: RoutingProposal) -> Value {
    let (text, segments) = parts(texts);
    json!({"type":"routing","action":{"type":"routing_admit","entry":e,"text":text,"segments":segments,"proposal":p}})
}
fn get_work(c: &ControlClient, e: &Value, id: &str) -> Work {
    serde_json::from_value(result(route(
        c,
        &key(),
        json!({"type":"routing_work","entry":e,"work_id":id}),
    )))
    .unwrap()
}

#[test]
fn routing_loopback_owner_control_groups_identity_retry_restart_and_unauthenticated_denial() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("workspace");
    let mut server = Server::open(&root);
    let c = ControlClient::discover(&root).unwrap();
    let e = entry(&c);
    let first_id = key();
    let first_cmd = command_value(
        &e,
        &["블로그", "분석", "회의"],
        proposal(vec![
            new("blog", &e),
            new("analysis", &e),
            new("meeting", &e),
        ]),
    );
    let first: Admission =
        serde_json::from_value(result(action(&c, &first_id, first_cmd))).unwrap();
    let w = first
        .items
        .iter()
        .map(|i| get_work(&c, &e, i.work_id.as_ref().unwrap()))
        .collect::<Vec<_>>();
    let next_id = key();
    let next = command_value(
        &e,
        &["짧게", "표", "새 비교"],
        proposal(vec![
            Operation::Amend {
                target: w[0].target(),
                scope: "short blog".into(),
            },
            Operation::Amend {
                target: w[1].target(),
                scope: "table analysis".into(),
            },
            new("comparison", &e),
        ]),
    );
    let saved = result(action(&c, &next_id, next.clone()));
    assert_eq!(saved, result(action(&c, &next_id, next)));
    let candidates = result(route(
        &c,
        &key(),
        json!({"type":"routing_candidates","entry":e,"query":"","limit":50}),
    ));
    assert_eq!(candidates.as_array().unwrap().len(), 4);
    let current = get_work(&c, &e, &w[0].id);
    let analysis = get_work(&c, &e, &w[1].id);
    let stale = action(
        &c,
        &key(),
        command_value(
            &e,
            &["stale"],
            proposal(vec![Operation::Amend {
                target: w[0].target(),
                scope: "stale".into(),
            }]),
        ),
    );
    assert_eq!(stale["error_code"], "revision_conflict");
    let grouped = RoutingProposal {
        schema: PROPOSAL_SCHEMA.into(),
        items: vec![
            ProposedSegment {
                segment_id: "s1".into(),
                additional_segment_ids: vec!["s3".into()],
                operation: Operation::Amend {
                    target: current.target(),
                    scope: "short blog with sources".into(),
                },
            },
            ProposedSegment {
                segment_id: "s2".into(),
                additional_segment_ids: vec![],
                operation: Operation::Amend {
                    target: analysis.target(),
                    scope: "analysis with table".into(),
                },
            },
        ],
    };
    let group_id = key();
    let grouped_cmd = command_value(&e, &["블로그 짧게", "분석 표", "블로그 출처"], grouped);
    let grouped = result(action(&c, &group_id, grouped_cmd.clone()));
    assert_eq!(
        grouped["items"][0]["intent_id"],
        grouped["items"][2]["intent_id"]
    );
    let history = result(route(
        &c,
        &key(),
        json!({"type":"routing_decisions","entry":e,"work_id":w[0].id}),
    ));
    assert_eq!(history[2]["source_fragments"].as_array().unwrap().len(), 2);
    assert_eq!(get_work(&c, &e, &w[2].id), w[2]);
    // No bearer or CSRF: this request must not reach an owner routing method.
    let address = server.endpoint.trim_start_matches("http://");
    let mut socket = TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let body=json!({"request_id":key(),"command":command_value(&e,&["unauthorized"],proposal(vec![new("unauthorized",&e)]))}).to_string();
    write!(socket,"POST /api/v1/action HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 403"),
        "status was not denied"
    );
    let cap = result(route(&c, &key(), json!({"type":"routing_capability"})));
    assert_eq!(cap["admission"], true);
    for k in [
        "runtime_dispatch",
        "effect_fence",
        "verified_completion_report",
    ] {
        assert_eq!(cap[k], true)
    }
    server.kill();
    drop(server);
    let _restarted = Server::open(&root);
    let c = ControlClient::discover(&root).unwrap();
    assert_eq!(grouped, result(action(&c, &group_id, grouped_cmd)));
    let restored = result(route(
        &c,
        &key(),
        json!({"type":"routing_receipt","entry":e,"message_id":group_id}),
    ));
    assert_eq!(restored["admission"], grouped);
    assert_eq!(
        result(route(
            &c,
            &key(),
            json!({"type":"routing_candidates","entry":e,"query":"","limit":50})
        ))
        .as_array()
        .unwrap()
        .len(),
        4
    );
    println!(
        "loopback control evidence: {}",
        json!({"work_count":4,"stable_first_ids":w.iter().map(|w|&w.id).collect::<Vec<_>>(),"group_receipt":grouped["id"],"restart_exact_receipt":true,"unauthenticated_http":403,"typed_revision_conflict":stale["error_code"],"runtime_dispatch":true})
    );
}

#[test]
fn routing_actual_host_process_kill_at_command_intent_and_receipt_commit_recovers() {
    for stage in ["after_command_begin", "after_admission_commit"] {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("workspace");
        let mut server = Server::open(&root);
        let c = ControlClient::discover(&root).unwrap();
        let e = entry(&c);
        let request = key();
        let cmd = command_value(&e, &["one job"], proposal(vec![new("one job", &e)]));
        std::fs::write(root.join(".routing-fixture-control-gate.json"),serde_json::to_vec(&json!({"schema":"ghost-routing-host-fixture/1","message_id":request,"stage":stage})).unwrap()).unwrap();
        let action_json = json!({"request_id":request,"command":cmd});
        let worker = thread::spawn(move || c.action(serde_json::from_value(action_json).unwrap()));
        let deadline = Instant::now() + Duration::from_secs(8);
        let reached = root.join(".routing-fixture-control-reached.json");
        while !reached.is_file() {
            assert!(Instant::now() < deadline, "host crash stage not reached");
            assert!(server.child.try_wait().unwrap().is_none());
            thread::sleep(Duration::from_millis(20));
        }
        let observed: Value = serde_json::from_slice(&std::fs::read(&reached).unwrap()).unwrap();
        assert_eq!(observed["stage"], stage);
        server.kill();
        assert!(worker.join().unwrap().is_err());
        drop(server);
        std::fs::remove_file(root.join(".routing-fixture-control-gate.json")).unwrap();
        // Only this temporary fixture DB is inspected, while its host is stopped.
        let db = rusqlite::Connection::open(root.join("workspace.db")).unwrap();
        let count: u64 = db
            .query_row(
                "SELECT COUNT(*) FROM workspace_objects WHERE kind='routing_admission_v2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, if stage == "after_command_begin" { 0 } else { 1 });
        let response_missing: bool = db
            .query_row(
                "SELECT response IS NULL FROM workspace_commands WHERE id=?1",
                [&request],
                |r| r.get(0),
            )
            .unwrap();
        assert!(response_missing);
        let previous: Option<Admission> = if count == 1 {
            Some(
                serde_json::from_str(
                    &db.query_row(
                        "SELECT payload FROM workspace_objects WHERE kind='routing_admission_v2'",
                        [],
                        |r| r.get::<_, String>(0),
                    )
                    .unwrap(),
                )
                .unwrap(),
            )
        } else {
            None
        };
        drop(db);
        let _restarted = Server::open(&root);
        let c = ControlClient::discover(&root).unwrap();
        let saved: Admission =
            serde_json::from_value(result(action(&c, &request, cmd.clone()))).unwrap();
        if let Some(old) = previous {
            assert_eq!(saved, old)
        }
        assert_eq!(
            saved,
            serde_json::from_value::<Admission>(result(action(&c, &request, cmd))).unwrap()
        );
        assert_eq!(
            result(route(
                &c,
                &key(),
                json!({"type":"routing_candidates","entry":e,"query":"","limit":50})
            ))
            .as_array()
            .unwrap()
            .len(),
            1
        );
        println!(
            "host process-kill evidence: {}",
            json!({"stage":stage,"admissions_before_recovery":count,"command_response_missing":true,"recovered_admission":saved.id,"recovered_work":saved.items[0].work_id,"work_count":1,"retry_receipt_equal":true})
        );
    }
}
