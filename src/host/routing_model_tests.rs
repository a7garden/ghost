//! Exercise SDK generation, actual tool callbacks and host-bound admission.
use super::{routing_model, work_routing::*, *};
use crate::{
    durable::durable::{AgentConfig, SingleProvider, Task},
    store::ProfileStore,
};
use std::sync::atomic::{AtomicUsize, Ordering};

const FIRST: &[&str] = &[
    "출시 블로그 초안을 작성해 줘.",
    "고객 반응 분석을 정리해 줘.",
    "다음 주 회의 자료도 준비해 줘.",
];
const FOLLOW: &[&str] = &[
    "블로그는 두 문단으로 줄여 줘.",
    "분석에는 표를 넣어 줘.",
    "회의 자료는 참석자 질문도 포함해 줘.",
    "그리고 블로그 마지막에 신청 링크를 넣어 줘.",
];

fn segments(clauses: &[&str]) -> (String, Vec<Segment>) {
    let text = clauses.join("\n");
    let mut at = 0;
    let segments = clauses
        .iter()
        .enumerate()
        .map(|(index, clause)| {
            let segment = Segment {
                id: format!("s{}", index + 1),
                start_byte: at,
                end_byte: at + clause.len(),
            };
            at = segment.end_byte + 1;
            segment
        })
        .collect();
    (text, segments)
}

fn tool_result(context: &ai::Context, name: &str) -> Value {
    context
        .messages
        .iter()
        .rev()
        .find_map(|message| {
            let ai::Message::ToolResult(message) = message else {
                return None;
            };
            (message.tool_name == name)
                .then(|| message.details.as_ref().unwrap()["content"].clone())
        })
        .unwrap_or_else(|| panic!("SDK context missing {name}"))
}

struct ScriptedRouter {
    turn: AtomicUsize,
    profile: String,
}
impl ai::Provider for ScriptedRouter {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        context: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            assert!(context
                .system_prompt
                .as_deref()
                .unwrap()
                .contains("ghost-routing-proposal/2"));
            assert!(context.tools.iter().any(|t| t.name == "route_work"));
            assert!(!context.tools.iter().any(|t| t.name == "shell"));
            let turn = self.turn.fetch_add(1, Ordering::SeqCst);
            let call = match turn {
                0 | 4 => Some(ai::ToolCall::new(
                    format!("input-{turn}"),
                    "routing_input",
                    json!({}),
                )),
                1 | 5 => {
                    let input = tool_result(context, "routing_input");
                    assert_eq!(input["ok"], true, "{input}");
                    let expected = if turn == 1 { FIRST } else { FOLLOW };
                    assert_eq!(input["result"]["text"], segments(expected).0);
                    Some(ai::ToolCall::new(
                        format!("candidate-{turn}"),
                        "routing_candidates",
                        json!({"query":"","limit":50}),
                    ))
                }
                2 => {
                    let candidates = tool_result(context, "routing_candidates");
                    assert_eq!(candidates["ok"], true);
                    assert!(candidates["result"].as_array().unwrap().is_empty());
                    let (_, segments) = segments(FIRST);
                    let items = ["출시 블로그", "고객 반응 분석", "회의 자료"]
                        .iter()
                        .enumerate()
                        .map(|(i, title)| ProposedSegment {
                            segment_id: format!("s{}", i + 1),
                            additional_segment_ids: vec![],
                            operation: Operation::New {
                                title: title.to_string(),
                                scope: FIRST[i].into(),
                                responsible_profile_id: self.profile.clone(),
                                dependencies: vec![],
                            },
                        })
                        .collect::<Vec<_>>();
                    Some(ai::ToolCall::new(
                        "route-new",
                        "route_work",
                        json!({"segments":segments,"resolves":[],"proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items}}),
                    ))
                }
                6 => {
                    let candidates = tool_result(context, "routing_candidates");
                    assert_eq!(candidates["ok"], true, "{candidates}");
                    let candidates: Vec<Candidate> =
                        serde_json::from_value(candidates["result"].clone()).unwrap();
                    assert_eq!(candidates.len(), 3);
                    let target = |title: &str| {
                        candidates
                            .iter()
                            .find(|c| c.title == title)
                            .unwrap()
                            .target
                            .clone()
                    };
                    let (_, segments) = segments(FOLLOW);
                    let items = vec![
                        ProposedSegment {
                            segment_id: "s1".into(),
                            additional_segment_ids: vec!["s4".into()],
                            operation: Operation::Amend {
                                target: target("출시 블로그"),
                                scope: "출시 블로그 초안: 두 문단; 마지막에 신청 링크".into(),
                            },
                        },
                        ProposedSegment {
                            segment_id: "s2".into(),
                            additional_segment_ids: vec![],
                            operation: Operation::Amend {
                                target: target("고객 반응 분석"),
                                scope: "고객 반응 분석: 표 포함".into(),
                            },
                        },
                        ProposedSegment {
                            segment_id: "s3".into(),
                            additional_segment_ids: vec![],
                            operation: Operation::Amend {
                                target: target("회의 자료"),
                                scope: "다음 주 회의 자료: 참석자 질문 포함".into(),
                            },
                        },
                    ];
                    Some(ai::ToolCall::new(
                        "route-follow",
                        "route_work",
                        json!({"segments":segments,"resolves":[],"proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items}}),
                    ))
                }
                3 | 7 => {
                    let receipt = tool_result(context, "route_work");
                    assert_eq!(receipt["ok"], true, "{receipt}");
                    assert_eq!(
                        receipt["result"]["items"].as_array().unwrap().len(),
                        if turn == 3 { 3 } else { 4 }
                    );
                    None
                }
                _ => panic!("unexpected router generation {turn}"),
            };
            let mut message = ai::AssistantMessage::new(model.api, &model.provider, &model.id);
            message.content.push(match call {
                Some(call) => ai::ContentBlock::ToolCall(call),
                None => ai::ContentBlock::Text(ai::TextContent::new(
                    "요청을 Work로 저장했습니다. 실행 결과는 별도로 확인합니다.",
                )),
            });
            Ok(Box::pin(futures::stream::iter([ai::ProviderEvent::Done {
                reason: ai::StopReason::Stop,
                message,
            }]))
                as std::pin::Pin<
                    Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>,
                >)
        })
    }
}

fn fixture() -> (tempfile::TempDir, Arc<Host>, String, Runtime, String) {
    let dir = tempfile::tempdir().unwrap();
    let app = Host::open(dir.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let mut profile = Host::profile(
        ProfileStore::create_profile(dir.path(), "router", "synthetic anonymous fixture").unwrap(),
    )
    .unwrap();
    let id = profile.id.clone();
    profile
        .host
        .install_services(Arc::new(services::Bridge {
            owner: id.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    profile.runtime = Runtime::new(
        profile.runtime.session.clone(),
        Arc::new(SingleProvider(Arc::new(ScriptedRouter {
            turn: AtomicUsize::new(0),
            profile: id.clone(),
        }))),
        profile.host.clone(),
    );
    let mut config = AgentConfig::new(host::mock_model(), "Synthetic language routing");
    routing_model::configure(&mut config);
    let conversation = profile.runtime.session.create_conversation(config).unwrap();
    let runtime = profile.runtime.clone();
    app.lock().unwrap().profiles.insert(id.clone(), profile);
    (dir, app, id, runtime, conversation)
}
fn works(app: &Host) -> Vec<Work> {
    app.lock()
        .unwrap()
        .journal
        .objects("routing_work_v2")
        .unwrap()
}

#[tokio::test]
async fn routing_model_sdk_natural_multiwork_then_grouped_followup_keeps_ids() {
    let (_dir, app, profile, runtime, conversation) = fixture();
    runtime
        .session
        .submit(
            &conversation,
            "first-original-message",
            InputKind::Prompt,
            &segments(FIRST).0,
        )
        .unwrap();
    runtime.drive(32).await.unwrap();
    let first = works(&app);
    assert_eq!(first.len(), 3);
    assert!(first
        .iter()
        .all(|w| w.work_revision == 1 && w.origin.message_id == "first-original-message"));
    runtime
        .session
        .submit(
            &conversation,
            "follow-original-message",
            InputKind::Prompt,
            &segments(FOLLOW).0,
        )
        .unwrap();
    runtime.drive(32).await.unwrap();
    let after = works(&app);
    assert_eq!(
        first.iter().map(|w| &w.id).collect::<Vec<_>>(),
        after.iter().map(|w| &w.id).collect::<Vec<_>>()
    );
    assert!(after
        .iter()
        .all(|w| w.work_revision == 2 && w.decision_revision == 2));
    let blog = after.iter().find(|w| w.title == "출시 블로그").unwrap();
    assert!(blog.scope.contains("두 문단") && blog.scope.contains("신청 링크"));
    let admissions: Vec<Admission> = app
        .lock()
        .unwrap()
        .journal
        .objects("routing_admission_v2")
        .unwrap();
    let follow = admissions
        .iter()
        .find(|a| a.input.origin.message_id == "follow-original-message")
        .unwrap();
    assert_eq!(follow.input.text, segments(FOLLOW).0);
    assert_eq!(follow.input.origin.entry_profile_id, profile);
    assert_eq!(follow.items[0].work_id, follow.items[3].work_id);
    let decisions: Vec<Decision> = app
        .lock()
        .unwrap()
        .journal
        .objects("routing_decision_v2")
        .unwrap();
    let decision = decisions
        .iter()
        .find(|d| d.work_id == blog.id && d.revision == 2)
        .unwrap();
    assert_eq!(decision.source_fragments.len(), 2);
    assert_eq!(decision.source_fragments[0].text, FOLLOW[0]);
    assert_eq!(decision.source_fragments[1].text, FOLLOW[3]);
    let snapshot = runtime.session.committed().unwrap();
    assert!(snapshot.effects.values().any(
        |e| e.name == "route_work" && e.output.as_ref().unwrap().status == ToolStatus::Success
    ));
    println!(
        "routing SDK evidence: {}",
        json!({"natural_messages":2,"created_work":3,"same_ids_after_amend":true,"noncontiguous_group_fragments":2,"actual_sdk_tool_callbacks":true})
    );
    app.shutdown().await.unwrap();
}

fn callback_task(runtime: &Runtime, conversation: &str, request: &str, text: &str) -> Task {
    let submission = runtime
        .session
        .submit(conversation, request, InputKind::Prompt, text)
        .unwrap();
    runtime.session.committed().unwrap().tasks[&submission.task_id].clone()
}
fn route_arguments(text: &str, op: Operation) -> Value {
    json!({"segments":[Segment{id:"s1".into(),start_byte:0,end_byte:text.len()}],"resolves":[],
        "proposal":RoutingProposal{schema:PROPOSAL_SCHEMA.into(),items:vec![ProposedSegment{segment_id:"s1".into(),additional_segment_ids:vec![],operation:op}]}})
}
#[tokio::test]
async fn routing_model_rejects_forged_source_invalid_utf8_coverage_and_revision_atomically() {
    let (_dir, app, profile, runtime, conversation) = fixture();
    let text = "한국어 작업";
    let task = callback_task(&runtime, &conversation, "authority-original", text);
    let new = Operation::New {
        title: "original".into(),
        scope: text.into(),
        responsible_profile_id: profile.clone(),
        dependencies: vec![],
    };
    let mut forged = route_arguments(text, new.clone());
    forged["owner_id"] = json!("forged-owner");
    assert!(
        routing_model::action(&ai::ToolCall::new("forged-source", "route_work", forged)).is_err()
    );
    let mut invalid = route_arguments(text, new.clone());
    invalid["segments"][0]["end_byte"] = json!(1);
    let bad = routing_model::execute(
        &app,
        &profile,
        &task,
        &ai::ToolCall::new("bad-utf8", "route_work", invalid),
    )
    .unwrap();
    assert_eq!(bad.status, ToolStatus::Failed);
    assert!(works(&app).is_empty());
    let mut gap = route_arguments(text, new.clone());
    gap["segments"][0]["start_byte"] = json!(3);
    assert_eq!(
        routing_model::execute(
            &app,
            &profile,
            &task,
            &ai::ToolCall::new("gap", "route_work", gap)
        )
        .unwrap()
        .status,
        ToolStatus::Failed
    );
    assert!(works(&app).is_empty());
    let accepted = routing_model::execute(
        &app,
        &profile,
        &task,
        &ai::ToolCall::new("good", "route_work", route_arguments(text, new)),
    )
    .unwrap();
    assert_eq!(accepted.status, ToolStatus::Success);
    let original = works(&app)[0].clone();
    let follow_text = "더 짧게 바꿔 줘";
    let follow_task = callback_task(&runtime, &conversation, "authority-follow", follow_text);
    let mut target = original.target();
    target.expected_work_revision += 1;
    let bad = routing_model::execute(
        &app,
        &profile,
        &follow_task,
        &ai::ToolCall::new(
            "forged-revision",
            "route_work",
            route_arguments(
                follow_text,
                Operation::Amend {
                    target,
                    scope: follow_text.into(),
                },
            ),
        ),
    )
    .unwrap();
    assert_eq!(bad.status, ToolStatus::Failed);
    assert_eq!(bad.content["error_code"], "revision_conflict");
    assert_eq!(works(&app), vec![original]);
    let mut fake = follow_task.clone();
    fake.id = "not-a-committed-task".into();
    let denied = routing_model::execute(
        &app,
        &profile,
        &fake,
        &ai::ToolCall::new("fake-task", "routing_input", json!({})),
    )
    .unwrap();
    assert_eq!(denied.status, ToolStatus::Failed);
    assert_eq!(denied.content["error_code"], "origin_unavailable");
    app.shutdown().await.unwrap();
}

#[test]
fn routing_model_configs_and_arguments_do_not_grant_model_authority() {
    let mut config = AgentConfig::new(host::mock_model(), "entry");
    config
        .tools
        .push(ai::Tool::new("shell", "effect", json!({"type":"object"})));
    routing_model::configure(&mut config);
    assert_eq!(config.tools.len(), 6);
    assert!(config.tools.iter().all(|t| routing_model::is_tool(&t.name)));
    for name in ["routing_candidates", "routing_input", "route_work"] {
        assert!(routing_model::action(&ai::ToolCall::new(
            "injection",
            name,
            json!({"identity":"other","type":"input"})
        ))
        .is_err());
    }
    assert!(routing_model::action(&ai::ToolCall::new("unknown", "shell", json!({}))).is_err());
}
