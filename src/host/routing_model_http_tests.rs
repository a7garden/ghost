//! Anonymous loopback HTTP exercises the configured SDK provider, owner command,
//! runtime callback and durable admission without real credentials or inference.
use super::{work_routing::*, *};
use crate::{
    control::api::{Action, RoutingEntry},
    store::ProfileStore,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const INITIAL: &[&str] = &[
    "신제품 출시 블로그 초안을 작성해 줘.",
    "고객 반응 분석도 정리해 줘.",
    "다음 주 회의 자료를 준비해 줘.",
];
const FOLLOWUP: &[&str] = &[
    "블로그는 두 문단으로 줄여 줘.",
    "분석에는 비교표를 넣어 줘.",
    "회의 자료에 예상 질문을 추가해 줘.",
    "그리고 블로그 마지막에는 신청 링크도 넣어 줘.",
];

fn original(clauses: &[&str]) -> (String, Vec<Segment>) {
    let text = clauses.join("\n");
    let mut offset = 0;
    let segments = clauses
        .iter()
        .enumerate()
        .map(|(i, clause)| {
            let part = Segment {
                id: format!("s{}", i + 1),
                start_byte: offset,
                end_byte: offset + clause.len(),
            };
            offset = part.end_byte + 1;
            part
        })
        .collect();
    (text, segments)
}
fn command(app: &Arc<Host>, request_id: &str, command: Value) -> Value {
    app.action(
        serde_json::from_value::<Action>(json!({"request_id":request_id,"command":command}))
            .unwrap(),
    )
    .unwrap()
}
fn ok(value: Value) -> Value {
    assert_eq!(value["ok"], true, "{value}");
    value["result"].clone()
}
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn natural(entry: &RoutingEntry, text: &str, kind: &str) -> Value {
    json!({"type":"routing","action":{"type":"routing_natural","entry":entry,"text":text,"kind":kind}})
}
fn last_output(body: &Value, id: &str) -> Value {
    let message = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool" && m["tool_call_id"] == id)
        .unwrap_or_else(|| panic!("Missing actual HTTP tool result {id}: {body}"));
    let output: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
    assert_eq!(output["status"], "success", "{output}");
    assert_eq!(output["content"]["ok"], true, "{output}");
    output["content"]["result"].clone()
}
fn tool_sse(id: &str, name: &str, arguments: Value) -> String {
    let delta = json!({"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},"finish_reason":null}]});
    let finish = json!({"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    format!("data: {delta}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
}
fn text_sse() -> String {
    let delta = json!({"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"요청을 Work로 저장했습니다. 실행 결과는 별도로 확인합니다."},"finish_reason":null}]});
    let finish = json!({"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    format!("data: {delta}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
}

async fn server(listener: TcpListener, profile: String) -> Vec<Value> {
    let mut requests = Vec::new();
    for step in 0..8 {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        loop {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            headers.push(byte[0]);
            assert!(headers.len() < 16384);
            if headers.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let headers = String::from_utf8(headers).unwrap();
        assert!(
            headers.starts_with("POST /v1/chat/completions "),
            "{headers}"
        );
        let lower = headers.to_ascii_lowercase();
        assert!(lower.contains("authorization: bearer ghost-anonymous"));
        let length = lower
            .lines()
            .find_map(|line| {
                line.strip_prefix("content-length:")
                    .and_then(|value| value.trim().parse::<usize>().ok())
            })
            .unwrap();
        assert!(length < 1_048_576);
        let mut bytes = vec![0; length];
        socket.read_exact(&mut bytes).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["model"], "synthetic-router");
        assert_eq!(body["stream"], true);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 6);
        assert!(tools.iter().any(|t| t["function"]["name"] == "route_work"));
        assert!(tools
            .iter()
            .all(|t| super::routing_model::is_tool(t["function"]["name"].as_str().unwrap())));
        assert!(body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "system"
                && m["content"]
                    .as_str()
                    .unwrap()
                    .contains("ghost-routing-proposal/2")));
        let expected = if step < 4 { INITIAL } else { FOLLOWUP };
        let latest_user = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .unwrap();
        assert_eq!(latest_user["content"], original(expected).0);
        let response = match step {
            0 | 4 => tool_sse(&format!("input-{step}"), "routing_input", json!({})),
            1 | 5 => {
                let input = last_output(&body, &format!("input-{}", step - 1));
                assert_eq!(input["text"], original(expected).0);
                assert_eq!(input["utf8_byte_length"], original(expected).0.len());
                assert!(input["assignees"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["profile_id"] == profile));
                tool_sse(
                    &format!("candidates-{step}"),
                    "routing_candidates",
                    json!({"query":"","limit":50}),
                )
            }
            2 => {
                assert!(last_output(&body, "candidates-1")
                    .as_array()
                    .unwrap()
                    .is_empty());
                let (_, segments) = original(INITIAL);
                let items = ["출시 블로그", "고객 반응 분석", "회의 자료"]
                    .iter()
                    .enumerate()
                    .map(|(i, title)| ProposedSegment {
                        segment_id: format!("s{}", i + 1),
                        additional_segment_ids: vec![],
                        operation: Operation::New {
                            title: (*title).into(),
                            scope: INITIAL[i].into(),
                            responsible_profile_id: profile.clone(),
                            dependencies: vec![],
                        },
                    })
                    .collect::<Vec<_>>();
                tool_sse(
                    "route-2",
                    "route_work",
                    json!({"segments":segments,"resolves":[],"proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items}}),
                )
            }
            6 => {
                let candidates: Vec<Candidate> =
                    serde_json::from_value(last_output(&body, "candidates-5")).unwrap();
                assert_eq!(candidates.len(), 3);
                let target = |title: &str| {
                    candidates
                        .iter()
                        .find(|c| c.title == title)
                        .unwrap()
                        .target
                        .clone()
                };
                let (_, segments) = original(FOLLOWUP);
                let items = vec![
                    ProposedSegment {
                        segment_id: "s1".into(),
                        additional_segment_ids: vec!["s4".into()],
                        operation: Operation::Amend {
                            target: target("출시 블로그"),
                            scope: "신제품 출시 블로그 초안: 두 문단; 마지막에 신청 링크".into(),
                        },
                    },
                    ProposedSegment {
                        segment_id: "s2".into(),
                        additional_segment_ids: vec![],
                        operation: Operation::Amend {
                            target: target("고객 반응 분석"),
                            scope: "고객 반응 분석: 비교표 포함".into(),
                        },
                    },
                    ProposedSegment {
                        segment_id: "s3".into(),
                        additional_segment_ids: vec![],
                        operation: Operation::Amend {
                            target: target("회의 자료"),
                            scope: "다음 주 회의 자료: 예상 질문 포함".into(),
                        },
                    },
                ];
                tool_sse(
                    "route-6",
                    "route_work",
                    json!({"segments":segments,"resolves":[],"proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items}}),
                )
            }
            3 | 7 => {
                let receipt = last_output(&body, &format!("route-{}", step - 1));
                assert_eq!(receipt["input"]["text"], original(expected).0);
                assert_eq!(
                    receipt["items"].as_array().unwrap().len(),
                    if step == 3 { 3 } else { 4 }
                );
                text_sse()
            }
            _ => unreachable!(),
        };
        requests.push(body);
        socket
            .write_all(
                crate::test_http::reply("200 OK", "Content-Type: text/event-stream\r\n", &response)
                    .as_bytes(),
            )
            .await
            .unwrap();
        socket.shutdown().await.unwrap();
    }
    requests
}

#[tokio::test]
async fn routing_model_http_configured_provider_owner_natural_multiwork_followup_and_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let app = Host::open(dir.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let profile = Host::profile(
        ProfileStore::create_profile(dir.path(), "http-router", "synthetic anonymous fixture")
            .unwrap(),
    )
    .unwrap();
    let profile_id = profile.id.clone();
    profile
        .host
        .install_services(Arc::new(services::Bridge {
            owner: profile_id.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    // Host::profile constructs Runtime with real GhostProviders::for_root.
    let runtime = profile.runtime.clone();
    app.lock()
        .unwrap()
        .profiles
        .insert(profile_id.clone(), profile);
    let provider = models::Provider {
        id: "synthetic-local".into(),
        name: "Anonymous fixture".into(),
        kind: models::Kind::OpenaiCompatible,
        endpoint,
        auth: models::Auth::None,
        roles: vec![models::Role::Llm],
        models: vec![models::Model {
            id: "synthetic-router".into(),
            name: "Scripted router".into(),
            roles: vec![models::Role::Llm],
        }],
        enabled: true,
        checked_ms: None,
        error: None,
    };
    ok(command(
        &app,
        &key(),
        json!({"type":"workspace","action":{"type":"save_model_provider","provider":provider,"version":0}}),
    ));
    let conversation=ok(command(&app,&key(),json!({"type":"create_conversation","profile_id":profile_id,"model":"synthetic-local/synthetic-router","tools":false})))["conversation_id"].as_str().unwrap().to_string();
    let entry = RoutingEntry {
        profile_id: profile_id.clone(),
        conversation_id: conversation.clone(),
    };
    let first_id = key();
    let first = natural(&entry, &original(INITIAL).0, "prompt");
    let accepted = command(&app, &first_id, first.clone());
    ok(accepted.clone());
    assert_eq!(command(&app, &first_id, first.clone()), accepted);
    assert_eq!(runtime.session.committed().unwrap().submissions.len(), 1);
    let task = tokio::spawn(server(listener, profile_id));
    tokio::time::timeout(Duration::from_secs(20), runtime.drive(32))
        .await
        .unwrap()
        .unwrap();
    let before: Vec<Work> = app
        .lock()
        .unwrap()
        .journal
        .objects("routing_work_v2")
        .unwrap();
    assert_eq!(before.len(), 3);
    assert!(before
        .iter()
        .all(|w| w.work_revision == 1 && w.origin.message_id == first_id));
    assert_eq!(command(&app, &first_id, first), accepted);
    let changed = command(
        &app,
        &first_id,
        natural(&entry, "같은 UUID의 다른 본문", "prompt"),
    );
    assert_eq!(changed["ok"], false, "{changed}");
    assert_eq!(changed["error_code"], "input_collision");
    let follow_id = key();
    let follow = natural(&entry, &original(FOLLOWUP).0, "follow_up");
    let follow_accepted = command(&app, &follow_id, follow.clone());
    ok(follow_accepted.clone());
    assert_eq!(command(&app, &follow_id, follow.clone()), follow_accepted);
    tokio::time::timeout(Duration::from_secs(20), runtime.drive(32))
        .await
        .unwrap()
        .unwrap();
    let requests = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(requests.len(), 8);
    let after: Vec<Work> = app
        .lock()
        .unwrap()
        .journal
        .objects("routing_work_v2")
        .unwrap();
    assert_eq!(
        before.iter().map(|w| &w.id).collect::<Vec<_>>(),
        after.iter().map(|w| &w.id).collect::<Vec<_>>()
    );
    assert!(after
        .iter()
        .all(|w| w.work_revision == 2 && w.decision_revision == 2));
    assert_eq!(runtime.session.committed().unwrap().submissions.len(), 2);
    assert_eq!(command(&app, &follow_id, follow), follow_accepted);
    let admissions: Vec<Admission> = app
        .lock()
        .unwrap()
        .journal
        .objects("routing_admission_v2")
        .unwrap();
    assert_eq!(admissions.len(), 2);
    let follow = admissions
        .iter()
        .find(|a| a.input.origin.message_id == follow_id)
        .unwrap();
    assert_eq!(follow.input.text, original(FOLLOWUP).0);
    assert_eq!(follow.items[0].work_id, follow.items[3].work_id);
    assert_eq!(follow.items[0].decision_revision, Some(2));
    println!(
        "configured HTTP routing evidence: {}",
        json!({"provider":"synthetic-local/synthetic-router","anonymous_loopback":true,"real_ghost_providers":true,"owner_natural_commands":2,"http_generations":requests.len(),"work_ids_stable":true,"admissions":admissions.len(),"exact_retry_same_submission":true,"changed_uuid_payload_rejected":true})
    );
    app.shutdown().await.unwrap();
}
