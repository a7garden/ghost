use super::routing_host::ModelRoutingAction;
use super::work_routing::*;
use super::*;
use crate::control::api::{RoutingEntry, RoutingPermissions};

fn command(app: &Arc<Host>, id: &str, value: Value) -> Value {
    app.action(serde_json::from_value(json!({"request_id":id,"command":value})).unwrap())
        .unwrap()
}
fn route(app: &Arc<Host>, id: &str, action: Value) -> Value {
    command(app, id, json!({"type":"routing","action":action}))
}
fn result(v: Value) -> Value {
    assert_eq!(v["ok"], true, "{v}");
    v["result"].clone()
}
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn entry(app: &Arc<Host>, name: &str) -> RoutingEntry {
    let profile = result(command(
        app,
        &key(),
        json!({"type":"create_profile","name":name,"persona":"fixture"}),
    ))["profile_id"]
        .as_str()
        .unwrap()
        .to_string();
    let convo = result(command(
        app,
        &key(),
        json!({"type":"create_conversation","profile_id":profile,"model":"mock","tools":false}),
    ))["conversation_id"]
        .as_str()
        .unwrap()
        .to_string();
    RoutingEntry {
        profile_id: profile,
        conversation_id: convo,
    }
}
fn parts(texts: &[&str]) -> (String, Vec<Segment>) {
    let mut text = String::new();
    let mut segments = vec![];
    for (i, t) in texts.iter().enumerate() {
        if i > 0 {
            text.push('\n')
        };
        let start_byte = text.len();
        text.push_str(t);
        segments.push(Segment {
            id: format!("s{}", i + 1),
            start_byte,
            end_byte: text.len(),
        });
    }
    (text, segments)
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
fn new(title: &str, profile: &str) -> Operation {
    Operation::New {
        title: title.into(),
        scope: title.into(),
        responsible_profile_id: profile.into(),
        dependencies: vec![],
    }
}
fn admit(
    app: &Arc<Host>,
    entry: &RoutingEntry,
    id: &str,
    texts: &[&str],
    p: &RoutingProposal,
) -> Value {
    let (text, segments) = parts(texts);
    route(
        app,
        id,
        json!({"type":"routing_admit","entry":entry,"text":text,"segments":segments,"proposal":p}),
    )
}
fn work(app: &Arc<Host>, entry: &RoutingEntry, id: &str) -> Work {
    serde_json::from_value(result(route(
        app,
        &key(),
        json!({"type":"routing_work","entry":entry,"work_id":id}),
    )))
    .unwrap()
}
fn rows(app: &Arc<Host>) -> Vec<(String, String, String)> {
    let s = app.lock().unwrap();
    let mut q = s
        .journal
        .0
        .prepare("SELECT kind,id,payload FROM workspace_objects ORDER BY kind,id")
        .unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}
fn stop_workers(app: &Arc<Host>) {
    for aborts in app.profile_workers.lock().unwrap().values() {
        for a in aborts {
            a.abort();
        }
    }
}
fn task(app: &Arc<Host>, e: &RoutingEntry, text: &str) -> host::durable::Task {
    let session = app.lock().unwrap().profiles[&e.profile_id]
        .runtime
        .session
        .clone();
    let sub = session
        .submit(&e.conversation_id, &key(), InputKind::Prompt, text)
        .unwrap();
    session.committed().unwrap().tasks[&sub.task_id].clone()
}
fn share(
    app: &Arc<Host>,
    source: &RoutingEntry,
    recipient: &RoutingEntry,
    previous: Option<(&str, u64)>,
    p: RoutingPermissions,
    enabled: bool,
    delegation_id: Option<&str>,
) -> Value {
    let (id, version) = previous.map_or((None, None), |(id, v)| (Some(id), Some(v)));
    result(route(
        app,
        &key(),
        json!({"type":"routing_share_access","id":id,"expected_version":version,"source":source,"recipient":recipient,"permissions":p,"enabled":enabled,"delegation_id":delegation_id}),
    ))
}
fn all() -> RoutingPermissions {
    RoutingPermissions {
        read_work: true,
        change_work: true,
        read_content: true,
        resolve_clarification: true,
    }
}

#[tokio::test]
async fn routing_real_host_control_admission_group_retry_revision_and_reopen() {
    let d = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let e = entry(&app, "marketing");
    let specialist = entry(&app, "developer");
    let cap = result(route(&app, &key(), json!({"type":"routing_capability"})));
    assert_eq!(cap["admission"], true);
    assert_eq!(cap["runtime_dispatch"], true);
    assert_eq!(cap["effect_fence"], true);
    assert_eq!(cap["verified_completion_report"], true);
    let first_id = key();
    let p = proposal(vec![
        new("blog", &specialist.profile_id),
        new("analysis", &specialist.profile_id),
        new("meeting", &specialist.profile_id),
    ]);
    let first: Admission = serde_json::from_value(result(admit(
        &app,
        &e,
        &first_id,
        &["블로그 작성", "분석 작성", "회의 준비"],
        &p,
    )))
    .unwrap();
    assert_eq!(
        first.input.origin.owner_id,
        app.snapshot().unwrap()["workspace_id"].as_str().unwrap()
    );
    let w = first
        .items
        .iter()
        .map(|i| work(&app, &e, i.work_id.as_ref().unwrap()))
        .collect::<Vec<_>>();
    let follow_id = key();
    let follow = proposal(vec![
        Operation::Amend {
            target: w[0].target(),
            scope: "짧은 블로그".into(),
        },
        Operation::Amend {
            target: w[1].target(),
            scope: "분석에 표".into(),
        },
        new("comparison", &specialist.profile_id),
    ]);
    let saved = result(admit(
        &app,
        &e,
        &follow_id,
        &["짧게 수정", "표 추가", "비교 새 작업"],
        &follow,
    ));
    assert_eq!(
        saved,
        result(admit(
            &app,
            &e,
            &follow_id,
            &["짧게 수정", "표 추가", "비교 새 작업"],
            &follow
        ))
    );
    let candidates = result(route(
        &app,
        &key(),
        json!({"type":"routing_candidates","entry":e,"query":"","limit":50}),
    ));
    assert_eq!(candidates.as_array().unwrap().len(), 4);
    assert_eq!(work(&app, &e, &w[2].id), w[2]);
    let conflict = admit(
        &app,
        &e,
        &key(),
        &["낡은 수정"],
        &proposal(vec![Operation::Amend {
            target: w[0].target(),
            scope: "stale".into(),
        }]),
    );
    assert_eq!(conflict["error_code"], "revision_conflict");
    let latest = work(&app, &e, &w[0].id);
    let other = work(&app, &e, &w[1].id);
    let group_id = key();
    let grouped = RoutingProposal {
        schema: PROPOSAL_SCHEMA.into(),
        items: vec![
            ProposedSegment {
                segment_id: "s1".into(),
                additional_segment_ids: vec!["s3".into()],
                operation: Operation::Amend {
                    target: latest.target(),
                    scope: "짧은 블로그 + 출처".into(),
                },
            },
            ProposedSegment {
                segment_id: "s2".into(),
                additional_segment_ids: vec![],
                operation: Operation::Amend {
                    target: other.target(),
                    scope: "분석에 검증된 표".into(),
                },
            },
        ],
    };
    let grouped = result(admit(
        &app,
        &e,
        &group_id,
        &["블로그 짧게", "분석 표", "블로그 출처"],
        &grouped,
    ));
    assert_eq!(
        grouped["items"][0]["intent_id"],
        grouped["items"][2]["intent_id"]
    );
    assert_ne!(
        grouped["items"][0]["intent_id"],
        grouped["items"][1]["intent_id"]
    );
    let history = result(route(
        &app,
        &key(),
        json!({"type":"routing_decisions","entry":e,"work_id":w[0].id}),
    ));
    assert_eq!(history.as_array().unwrap().len(), 3);
    assert_eq!(history[2]["source_fragments"][1]["text"], "블로그 출처");
    let fake = json!({"request_id":key(),"command":{"type":"routing","action":{"type":"routing_admit","entry":e,"owner_id":"forged","text":"x","segments":[],"proposal":proposal(vec![])}}});
    assert!(serde_json::from_value::<Action>(fake).is_err());
    let bad = route(
        &app,
        &key(),
        json!({"type":"routing_candidates","entry":{"profile_id":e.profile_id,"conversation_id":"nonexistent"},"query":"","limit":10}),
    );
    assert_eq!(bad["error_code"], "origin_unavailable");
    app.shutdown().await.unwrap();
    drop(app);
    let reopened = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let receipt = result(route(
        &reopened,
        &key(),
        json!({"type":"routing_receipt","entry":e,"message_id":group_id}),
    ));
    assert_eq!(receipt["admission"], grouped);
    println!(
        "host admission evidence: {}",
        json!({"first_work_ids":w.iter().map(|w|&w.id).collect::<Vec<_>>(),"work_count":4,"group":grouped,"reopen_receipt_equal":true,"typed_conflict":conflict["error_code"]})
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn routing_real_task_explicit_sharing_zero_candidates_revocation_and_linked_answer() {
    let d = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let source = entry(&app, "source");
    let receiver = entry(&app, "receiver");
    stop_workers(&app);
    let held_id = key();
    let held: Admission = serde_json::from_value(result(admit(
        &app,
        &source,
        &held_id,
        &["private held"],
        &proposal(vec![Operation::Clarify {
            question: "which work?".into(),
            candidates: vec![],
        }]),
    )))
    .unwrap();
    let t = task(&app, &receiver, "답변\n독립 과업");
    let (_, segments) = parts(&["답변", "독립 과업"]);
    let resolves = vec![ResolutionRef {
        source_admission_id: held.id.clone(),
        source_segment_id: "s1".into(),
        expected_input_hash: held.input_hash.clone(),
        answer_segment_id: "s1".into(),
    }];
    let action = ModelRoutingAction::Admit {
        segments: segments.clone(),
        resolves: resolves.clone(),
        proposal: proposal(vec![
            Operation::Question { target: None },
            new("answer work", &receiver.profile_id),
        ]),
    };
    let before = rows(&app);
    let denied = app.routing_for_model(&receiver.profile_id, &t, action.clone());
    assert_eq!(denied["ok"], false);
    assert_eq!(rows(&app), before);
    let partial = RoutingPermissions {
        resolve_clarification: false,
        ..all()
    };
    let grant = share(&app, &source, &receiver, None, partial, true, None);
    let grant_id = grant["id"].as_str().unwrap();
    assert_eq!(
        app.routing_for_model(
            &receiver.profile_id,
            &t,
            ModelRoutingAction::Receipt {
                source: source.clone(),
                message_id: held_id.clone()
            }
        )["ok"],
        true
    );
    let before = rows(&app);
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, action.clone())["ok"],
        false
    );
    assert_eq!(rows(&app), before);
    share(
        &app,
        &source,
        &receiver,
        Some((grant_id, 1)),
        all(),
        true,
        None,
    );
    let answer: Admission = serde_json::from_value(result(app.routing_for_model(
        &receiver.profile_id,
        &t,
        action.clone(),
    )))
    .unwrap();
    let snapshot = app.lock().unwrap().profiles[&receiver.profile_id]
        .runtime
        .session
        .committed()
        .unwrap();
    let submitted = snapshot
        .submissions
        .iter()
        .find(|s| s.task_id == t.id)
        .unwrap();
    assert_eq!(answer.input.origin.entry_profile_id, receiver.profile_id);
    assert_eq!(answer.input.origin.message_id, submitted.request_id);
    assert_eq!(answer.input.text, submitted.text);
    assert_eq!(
        serde_json::from_value::<Admission>(result(app.routing_for_model(
            &receiver.profile_id,
            &t,
            action
        )))
        .unwrap(),
        answer
    );
    let source_task = task(&app, &source, "source query");
    let query = ModelRoutingAction::Receipt {
        source: source.clone(),
        message_id: held_id.clone(),
    };
    assert_eq!(
        app.routing_for_model(&source.profile_id, &source_task, query.clone())["ok"],
        false
    );
    let reverse = share(&app, &receiver, &source, None, all(), true, None);
    assert_eq!(
        app.routing_for_model(&source.profile_id, &source_task, query.clone())["ok"],
        true
    );
    share(
        &app,
        &receiver,
        &source,
        Some((reverse["id"].as_str().unwrap(), 1)),
        RoutingPermissions {
            read_content: false,
            ..all()
        },
        true,
        None,
    );
    assert_eq!(
        app.routing_for_model(&source.profile_id, &source_task, query)["ok"],
        false
    );
    // Source share is revoked, but this caller still has its own valid Task and work.
    share(
        &app,
        &source,
        &receiver,
        Some((grant_id, 2)),
        all(),
        false,
        None,
    );
    assert_eq!(
        app.routing_for_model(
            &receiver.profile_id,
            &t,
            ModelRoutingAction::Work {
                work_id: answer.items[1].work_id.clone().unwrap()
            }
        )["ok"],
        true
    );
    let held2: Admission = serde_json::from_value(result(admit(
        &app,
        &source,
        &key(),
        &["second private held"],
        &proposal(vec![Operation::Clarify {
            question: "which?".into(),
            candidates: vec![],
        }]),
    )))
    .unwrap();
    let newer = task(&app, &receiver, "답변\n독립 과업");
    let invalid = ModelRoutingAction::Admit {
        segments,
        resolves: vec![ResolutionRef {
            source_admission_id: held2.id,
            source_segment_id: "s1".into(),
            expected_input_hash: held2.input_hash,
            answer_segment_id: "s1".into(),
        }],
        proposal: proposal(vec![
            Operation::Question { target: None },
            new("must rollback", &receiver.profile_id),
        ]),
    };
    let before = rows(&app);
    let revoked = app.routing_for_model(&receiver.profile_id, &newer, invalid);
    assert_eq!(revoked["ok"], false);
    assert_eq!(rows(&app), before);
    let mut forged = t.clone();
    forged.conversation_id = source.conversation_id.clone();
    assert_eq!(
        app.routing_for_model(
            &receiver.profile_id,
            &forged,
            ModelRoutingAction::Candidates {
                query: "".into(),
                limit: 50
            }
        )["error_code"],
        "origin_unavailable"
    );
    assert_eq!(
        app.routing_for_model(
            &source.profile_id,
            &t,
            ModelRoutingAction::Candidates {
                query: "".into(),
                limit: 50
            }
        )["error_code"],
        "origin_unavailable"
    );
    let invalid_args = json!({"type":"admit","segments":[],"proposal":proposal(vec![]),"owner_id":"spoof","profile_id":source.profile_id});
    assert!(serde_json::from_value::<ModelRoutingAction>(invalid_args).is_err());
    println!(
        "host authority evidence: {}",
        json!({"source":held.id,"answer":answer.id,"zero_candidates_denied":true,"explicit_cross_grant_succeeded":true,"source_revoked_answer_permission_retained":true,"linked_answer_content_revoked":true,"full_rollback":true,"actual_task_origin_derived":true})
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn routing_command_pending_intent_and_committed_admission_recover_without_duplicates() {
    let d = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let e = entry(&app, "owner");
    let id = key();
    let (text, segments) = parts(&["job"]);
    let action:Action=serde_json::from_value(json!({"request_id":id,"command":{"type":"routing","action":{"type":"routing_admit","entry":e,"text":text,"segments":segments,"proposal":proposal(vec![new("job",&e.profile_id)])}}})).unwrap();
    let payload = serde_json::to_string(&serde_json::to_value(&action.command).unwrap()).unwrap();
    app.lock().unwrap().journal.begin(&id, &payload).unwrap();
    app.lock().unwrap().journal.0.execute_batch("CREATE TEMP TRIGGER fixture_fail_finish BEFORE UPDATE OF response ON workspace_commands BEGIN SELECT RAISE(ABORT,'fixture interruption after admission'); END;").unwrap();
    let failed = app.action(action).unwrap();
    assert_eq!(failed["ok"], false);
    let stored: Admission = app
        .lock()
        .unwrap()
        .journal
        .objects::<Admission>("routing_admission_v2")
        .unwrap()
        .pop()
        .unwrap();
    assert!(app
        .lock()
        .unwrap()
        .journal
        .0
        .query_row(
            "SELECT response IS NULL FROM workspace_commands WHERE id=?1",
            [&id],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    app.shutdown().await.unwrap();
    drop(app);
    let reopened = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let recovered: Action = serde_json::from_value(
        json!({"request_id":id,"command":serde_json::from_str::<Value>(&payload).unwrap()}),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_value::<Admission>(result(reopened.action(recovered).unwrap())).unwrap(),
        stored
    );
    assert_eq!(
        reopened
            .lock()
            .unwrap()
            .journal
            .objects::<Work>("routing_work_v2")
            .unwrap()
            .len(),
        1
    );
    assert!(reopened
        .lock()
        .unwrap()
        .journal
        .0
        .query_row(
            "SELECT response IS NOT NULL FROM workspace_commands WHERE id=?1",
            [&id],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    println!(
        "host command recovery evidence: {}",
        json!({"admission":stored.id,"pending_command_recovered":true,"commit_before_response_recovered":true,"work_count":1})
    );
    reopened.shutdown().await.unwrap();
}

struct OnceTool {
    call: ai::ToolCall,
}
impl ai::Provider for OnceTool {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        _: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            let mut message = ai::AssistantMessage::new(model.api, &model.provider, &model.id);
            message
                .content
                .push(ai::ContentBlock::ToolCall(self.call.clone()));
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
async fn source_tool(app: &Arc<Host>, e: &RoutingEntry, call: ai::ToolCall) -> host::durable::Task {
    let (session, host) = {
        let s = app.lock().unwrap();
        (
            s.profiles[&e.profile_id].runtime.session.clone(),
            s.profiles[&e.profile_id].host.clone(),
        )
    };
    let mut config = host::durable::AgentConfig::new(host::mock_model(), "fixture");
    config.tools.push(ai::Tool {
        name: call.name.clone(),
        description: "fixture tool".into(),
        parameters: json!({"type":"object"}),
    });
    session.set_config(&e.conversation_id, config).unwrap();
    session
        .submit(
            &e.conversation_id,
            &key(),
            InputKind::Prompt,
            "source instruction",
        )
        .unwrap();
    let runtime = Runtime::new(
        session.clone(),
        Arc::new(host::durable::SingleProvider(Arc::new(OnceTool { call }))),
        host,
    );
    runtime.drive(2).await.unwrap();
    session
        .committed()
        .unwrap()
        .tasks
        .values()
        .find(|t| t.conversation_id == e.conversation_id && matches!(t.kind, TaskKind::Tool { .. }))
        .unwrap()
        .clone()
}

#[tokio::test]
async fn routing_real_delegation_lineage_cancellation_policy_and_duplicate_records_deny() {
    let d = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let source = entry(&app, "parent");
    let receiver = entry(&app, "child");
    stop_workers(&app);
    tokio::task::yield_now().await;
    let source_task=source_tool(&app,&source,ai::ToolCall::new("delegate","delegate_ghost",json!({"profile_id":receiver.profile_id,"prompt":"child instruction","background":false}))).await;
    let delegation_id = key();
    let child_session = app.lock().unwrap().profiles[&receiver.profile_id]
        .runtime
        .session
        .clone();
    let submitted = child_session
        .submit(
            &receiver.conversation_id,
            &delegation_id,
            InputKind::Prompt,
            "child instruction",
        )
        .unwrap();
    let t = child_session.committed().unwrap().tasks[&submitted.task_id].clone();
    let record = Delegation {
        id: delegation_id.clone(),
        owner: source.profile_id.clone(),
        owner_task: source_task.id.clone(),
        target: receiver.profile_id.clone(),
        conversation_id: receiver.conversation_id.clone(),
        task_id: t.id.clone(),
        background: false,
        state: "running".into(),
        config: None,
    };
    app.lock()
        .unwrap()
        .journal
        .put("delegation", &delegation_id, &record)
        .unwrap();
    let held_id = key();
    let held = result(admit(
        &app,
        &source,
        &held_id,
        &["private"],
        &proposal(vec![Operation::Clarify {
            question: "which?".into(),
            candidates: vec![],
        }]),
    ));
    let query = ModelRoutingAction::Receipt {
        source: source.clone(),
        message_id: held_id.clone(),
    };
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, query.clone())["ok"],
        false,
        "lineage is not transcript sharing"
    );
    share(
        &app,
        &source,
        &receiver,
        None,
        all(),
        true,
        Some(&delegation_id),
    );
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, query.clone())["ok"],
        true
    );
    let third = entry(&app, "private-third");
    stop_workers(&app);
    let third_id = key();
    result(admit(
        &app,
        &third,
        &third_id,
        &["third private"],
        &proposal(vec![Operation::Clarify {
            question: "which?".into(),
            candidates: vec![],
        }]),
    ));
    share(&app, &third, &receiver, None, all(), true, None);
    let third_query = ModelRoutingAction::Receipt {
        source: third.clone(),
        message_id: third_id,
    };
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, third_query.clone())["ok"],
        false,
        "receiver grant cannot exceed actual sender scope"
    );
    let sender_grant = share(&app, &third, &source, None, all(), true, None);
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, third_query.clone())["ok"],
        true
    );
    share(
        &app,
        &third,
        &source,
        Some((sender_grant["id"].as_str().unwrap(), 1)),
        all(),
        false,
        None,
    );
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, third_query)["ok"],
        false
    );
    let mut p = Policy {
        delegation: false,
        ..Policy::default()
    };
    app.lock()
        .unwrap()
        .journal
        .put("policy", &source.profile_id, &p)
        .unwrap();
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, query.clone())["error_code"],
        "origin_unavailable"
    );
    p.delegation = true;
    app.lock()
        .unwrap()
        .journal
        .put("policy", &source.profile_id, &p)
        .unwrap();
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, query.clone())["ok"],
        true
    );
    let mut duplicate = record.clone();
    duplicate.id = key();
    app.lock()
        .unwrap()
        .journal
        .put("delegation", &duplicate.id, &duplicate)
        .unwrap();
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, query.clone())["error_code"],
        "origin_unavailable"
    );
    app.lock()
        .unwrap()
        .journal
        .delete("delegation", &duplicate.id)
        .unwrap();
    app.lock().unwrap().profiles[&source.profile_id]
        .runtime
        .session
        .cancel(&source_task.id)
        .unwrap();
    assert_eq!(
        app.routing_for_model(&receiver.profile_id, &t, query)["error_code"],
        "origin_unavailable"
    );
    let before = rows(&app);
    let failed = app.routing_for_model(
        &receiver.profile_id,
        &t,
        ModelRoutingAction::Admit {
            segments: parts(&["child instruction"]).1,
            resolves: vec![ResolutionRef {
                source_admission_id: held["id"].as_str().unwrap().into(),
                source_segment_id: "s1".into(),
                expected_input_hash: held["input_hash"].as_str().unwrap().into(),
                answer_segment_id: "s1".into(),
            }],
            proposal: proposal(vec![Operation::Question { target: None }]),
        },
    );
    assert_eq!(failed["ok"], false);
    assert_eq!(rows(&app), before);
    println!(
        "host lineage evidence: {}",
        json!({"actual_source_tool":source_task.id,"delegation":delegation_id,"lineage_alone_no_private_share":true,"explicit_bound_share_success":true,"source_policy_revoke":true,"duplicate_lineage_denied":true,"cancelled_source_denied":true,"receiver_cannot_exceed_sender_scope":true})
    );
    app.shutdown().await.unwrap();
}

struct RoutingProbe {
    app: std::sync::Weak<Host>,
    profile: String,
}
impl host::durable::Host for RoutingProbe {
    fn prepare(
        &self,
        t: &host::durable::Task,
        _: &ai::ToolCall,
    ) -> host::durable::Result<host::durable::ToolPlan> {
        Ok(host::durable::ToolPlan {
            effect_key: format!("routing-probe:{}", t.id),
            replay_safe: true,
        })
    }
    fn execute<'a>(
        &'a self,
        t: &'a host::durable::Task,
        _: &'a ai::ToolCall,
        _: &'a host::durable::ToolPlan,
    ) -> host::durable::HostFuture<'a, host::durable::ToolOutput> {
        Box::pin(async move {
            let app = self.app.upgrade().unwrap();
            let actual = app.lock().unwrap().profiles[&self.profile]
                .runtime
                .session
                .committed()
                .unwrap()
                .tasks[&t.id]
                .clone();
            assert_eq!(t.phase, Phase::ToolReady);
            assert_eq!(actual.phase, Phase::ToolRunning);
            let value = app.routing_for_model(
                &self.profile,
                t,
                ModelRoutingAction::Admit {
                    segments: parts(&["probe original input"]).1,
                    resolves: vec![],
                    proposal: proposal(vec![Operation::Question { target: None }]),
                },
            );
            assert_eq!(value["ok"], true, "{value}");
            Ok(host::durable::ToolOutput::success(
                "fixture routing receipt",
                value,
            ))
        })
    }
}
#[tokio::test]
async fn routing_actual_runtime_pre_intent_task_binds_to_current_tool_and_original_submission() {
    let d = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let e = entry(&app, "probe");
    stop_workers(&app);
    tokio::task::yield_now().await;
    let session = app.lock().unwrap().profiles[&e.profile_id]
        .runtime
        .session
        .clone();
    let mut config = host::durable::AgentConfig::new(host::mock_model(), "fixture");
    config.tools.push(ai::Tool {
        name: "routing_probe".into(),
        description: "fixture only".into(),
        parameters: json!({"type":"object"}),
    });
    session.set_config(&e.conversation_id, config).unwrap();
    let original = key();
    session
        .submit(
            &e.conversation_id,
            &original,
            InputKind::Prompt,
            "probe original input",
        )
        .unwrap();
    let runtime = Runtime::new(
        session.clone(),
        Arc::new(host::durable::SingleProvider(Arc::new(OnceTool {
            call: ai::ToolCall::new("probe", "routing_probe", json!({})),
        }))),
        Arc::new(RoutingProbe {
            app: Arc::downgrade(&app),
            profile: e.profile_id.clone(),
        }),
    );
    runtime.drive(3).await.unwrap();
    let saved = app
        .lock()
        .unwrap()
        .journal
        .objects::<Admission>("routing_admission_v2")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(saved.input.origin.message_id, original);
    assert_eq!(saved.input.origin.entry_profile_id, e.profile_id);
    assert_eq!(saved.input.text, "probe original input");
    println!(
        "runtime caller evidence: {}",
        json!({"actual_tool_running_pre_intent_task_ready":true,"server_derived_original_message":saved.input.origin.message_id,"server_derived_original_text":true})
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn routing_rejected_owner_command_is_immutable_after_assignment_permission_repair() {
    let d = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let e = entry(&app, "owner");
    let assignee = entry(&app, "assignee");
    let id = key();
    let p = proposal(vec![new("permission repair job", &assignee.profile_id)]);
    app.lock()
        .unwrap()
        .profiles
        .get_mut(&assignee.profile_id)
        .unwrap()
        .error = Some("fixture unavailable".into());
    let rejected = admit(&app, &e, &id, &["job"], &p);
    assert_eq!(rejected["ok"], false);
    app.lock()
        .unwrap()
        .profiles
        .get_mut(&assignee.profile_id)
        .unwrap()
        .error = None;
    assert_eq!(admit(&app, &e, &id, &["job"], &p), rejected);
    assert_eq!(
        app.lock()
            .unwrap()
            .journal
            .objects::<Work>("routing_work_v2")
            .unwrap()
            .len(),
        0
    );
    assert_eq!(admit(&app, &e, &key(), &["job"], &p)["ok"], true);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn routing_owner_view_restores_entry_history_without_writing_or_cross_entry_leaks() {
    let d = tempfile::tempdir().unwrap();
    let app = Host::open_legacy_fixture(d.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let e = entry(&app, "view_source");
    let other = entry(&app, "private_other_entry");
    let first: Admission = serde_json::from_value(result(admit(
        &app,
        &e,
        &key(),
        &["블로그 초안"],
        &proposal(vec![new("blog", &e.profile_id)]),
    )))
    .unwrap();
    let original = work(&app, &e, first.items[0].work_id.as_ref().unwrap());
    let held: Admission = serde_json::from_value(result(admit(
        &app,
        &e,
        &key(),
        &["그건 다음 주로"],
        &proposal(vec![Operation::Clarify {
            question: "블로그 일정인가요?".into(),
            candidates: vec![original.target()],
        }]),
    )))
    .unwrap();
    result(admit(
        &app,
        &other,
        &key(),
        &["private"],
        &proposal(vec![new("private", &other.profile_id)]),
    ));
    let before = rows(&app);
    let page = result(route(
        &app,
        &key(),
        json!({"type":"routing_view","entry":e,"limit":1,"before_admission_id":null}),
    ));
    assert_eq!(page["schema"], "ghost-routing-view/1");
    assert_eq!(page["admissions"].as_array().unwrap().len(), 1);
    assert_eq!(page["works"].as_array().unwrap().len(), 1);
    let next = page["next_before_admission_id"].as_str().unwrap();
    let second = result(route(
        &app,
        &key(),
        json!({"type":"routing_view","entry":e,"limit":1,"before_admission_id":next}),
    ));
    let ids = [
        page["admissions"][0]["admission"]["id"].as_str().unwrap(),
        second["admissions"][0]["admission"]["id"].as_str().unwrap(),
    ];
    assert!(ids.contains(&first.id.as_str()) && ids.contains(&held.id.as_str()));
    assert!(second["next_before_admission_id"].is_null());
    assert_eq!(rows(&app), before);
    let wrong_cursor = route(
        &app,
        &key(),
        json!({"type":"routing_view","entry":other,"limit":50,"before_admission_id":held.id}),
    );
    assert_eq!(wrong_cursor["error_code"], "origin_unavailable");
    let invalid = route(
        &app,
        &key(),
        json!({"type":"routing_view","entry":e,"limit":51,"before_admission_id":null}),
    );
    assert_eq!(invalid["ok"], false);
    stop_workers(&app);
}

/// Persist the owner's selection via the public natural-input command, then
/// exercise model admission with the actual committed submission task.
struct SelectedAnswerFixture {
    _directory: tempfile::TempDir,
    app: Arc<Host>,
    entry: RoutingEntry,
    selected: Work,
    other: Work,
    held: Admission,
}
impl SelectedAnswerFixture {
    fn open() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let app = Host::open_legacy_fixture(
            directory.path(),
            tokio::runtime::Handle::current(),
            Some("mock"),
        )
        .unwrap();
        let entry = entry(&app, "selected-answer");
        stop_workers(&app);
        let initial: Admission = serde_json::from_value(result(admit(
            &app,
            &entry,
            &key(),
            &["선택 자료 준비", "다른 자료 준비"],
            &proposal(vec![
                new("selected document", &entry.profile_id),
                new("other document", &entry.profile_id),
            ]),
        )))
        .unwrap();
        let selected = work(&app, &entry, initial.items[0].work_id.as_ref().unwrap());
        let other = work(&app, &entry, initial.items[1].work_id.as_ref().unwrap());
        let held: Admission = serde_json::from_value(result(admit(
            &app,
            &entry,
            &key(),
            &["그 자료는 간략하게 줄여 줘"],
            &proposal(vec![Operation::Clarify {
                question: "어느 자료를 줄일까요?".into(),
                candidates: vec![selected.target(), other.target()],
            }]),
        )))
        .unwrap();
        Self {
            _directory: directory,
            app,
            entry,
            selected,
            other,
            held,
        }
    }
    fn natural_task(
        &self,
        clauses: &[&str],
        answer_segment_id: &str,
    ) -> (host::durable::Task, Vec<Segment>, Vec<ResolutionRef>) {
        let (text, segments) = parts(clauses);
        let resolves = vec![ResolutionRef {
            source_admission_id: self.held.id.clone(),
            source_segment_id: "s1".into(),
            expected_input_hash: self.held.input_hash.clone(),
            answer_segment_id: answer_segment_id.into(),
        }];
        let message_id = key();
        let submitted = result(route(
            &self.app,
            &message_id,
            json!({"type":"routing_natural","entry":self.entry,"text":text,"kind":"follow_up",
                "resolves":resolves,"clarification_target":self.selected.target()}),
        ));
        let snapshot = self.app.lock().unwrap().profiles[&self.entry.profile_id]
            .runtime
            .session
            .committed()
            .unwrap();
        let submission = snapshot
            .submissions
            .iter()
            .find(|s| s.request_id == message_id)
            .unwrap();
        assert_eq!(submission.text, text);
        assert_eq!(submission.conversation_id, self.entry.conversation_id);
        assert_eq!(submitted["submission"]["task_id"], submission.task_id);
        let task = snapshot.tasks[&submission.task_id].clone();
        let input = result(self.app.routing_for_model(
            &self.entry.profile_id,
            &task,
            ModelRoutingAction::Input {},
        ));
        assert_eq!(input["text"], text);
        assert_eq!(input["message_id"], message_id);
        assert_eq!(
            input["expected_resolves"],
            serde_json::to_value(&resolves).unwrap()
        );
        assert_eq!(
            input["clarification_target"],
            serde_json::to_value(self.selected.target()).unwrap()
        );
        assert_eq!(
            input["held_clarifications"][0]["source"]["admission"]["id"],
            self.held.id
        );
        (task, segments, resolves)
    }
    fn receipt(&self) -> Value {
        result(route(
            &self.app,
            &key(),
            json!({"type":"routing_receipt","entry":self.entry,"message_id":self.held.input.origin.message_id}),
        ))
    }
    fn admit_model(&self, task: &host::durable::Task, action: ModelRoutingAction) -> Value {
        self.app
            .routing_for_model(&self.entry.profile_id, task, action)
    }
}

#[tokio::test]
async fn routing_selected_natural_answer_allows_independent_new_group() {
    let fixture = SelectedAnswerFixture::open();
    let (task, segments, resolves) =
        fixture.natural_task(&["선택 자료를 뜻했어", "새 경쟁 비교도 준비해 줘"], "s1");
    let action = ModelRoutingAction::Admit {
        segments,
        resolves: resolves.clone(),
        proposal: proposal(vec![
            Operation::Amend {
                target: fixture.selected.target(),
                scope: "선택 자료: 간략하게".into(),
            },
            new("independent comparison", &fixture.entry.profile_id),
        ]),
    };
    let answer: Admission =
        serde_json::from_value(result(fixture.admit_model(&task, action.clone()))).unwrap();
    assert_eq!(answer.input.resolves, resolves);
    assert_eq!(
        answer.items[0].work_id.as_deref(),
        Some(fixture.selected.id.as_str())
    );
    assert_eq!(answer.items[0].decision_revision, Some(2));
    assert!(matches!(answer.items[1].operation, Operation::New { .. }));
    assert_ne!(answer.items[1].work_id, answer.items[0].work_id);
    assert_eq!(
        work(&fixture.app, &fixture.entry, &fixture.other.id),
        fixture.other
    );
    assert_eq!(
        fixture
            .app
            .lock()
            .unwrap()
            .journal
            .objects::<Work>("routing_work_v2")
            .unwrap()
            .len(),
        3
    );
    let receipt = fixture.receipt();
    assert_eq!(receipt["resolutions"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["resolutions"][0]["answer_admission_id"], answer.id);
    assert_eq!(receipt["resolutions"][0]["answer_segment_id"], "s1");
    let before_retry = rows(&fixture.app);
    assert_eq!(
        serde_json::from_value::<Admission>(result(fixture.admit_model(&task, action))).unwrap(),
        answer
    );
    assert_eq!(rows(&fixture.app), before_retry);
    fixture.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn routing_selected_natural_answer_allows_other_work_amendment() {
    let fixture = SelectedAnswerFixture::open();
    let (task, segments, resolves) = fixture.natural_task(
        &["선택 자료를 뜻했어", "다른 자료에는 표를 추가해 줘"],
        "s1",
    );
    let answer: Admission = serde_json::from_value(result(fixture.admit_model(
        &task,
        ModelRoutingAction::Admit {
            segments,
            resolves,
            proposal: proposal(vec![
                Operation::Amend {
                    target: fixture.selected.target(),
                    scope: "선택 자료: 간략하게".into(),
                },
                Operation::Amend {
                    target: fixture.other.target(),
                    scope: "다른 자료: 표 추가".into(),
                },
            ]),
        },
    )))
    .unwrap();
    assert_eq!(
        answer.items[0].work_id.as_deref(),
        Some(fixture.selected.id.as_str())
    );
    assert_eq!(
        answer.items[1].work_id.as_deref(),
        Some(fixture.other.id.as_str())
    );
    assert_ne!(answer.items[0].intent_id, answer.items[1].intent_id);
    for old in [&fixture.selected, &fixture.other] {
        let updated = work(&fixture.app, &fixture.entry, &old.id);
        assert_eq!(updated.work_revision, 2);
        assert_eq!(updated.decision_revision, 2);
    }
    let receipt = fixture.receipt();
    assert_eq!(receipt["resolutions"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["resolutions"][0]["answer_segment_id"], "s1");
    assert_eq!(
        fixture
            .app
            .lock()
            .unwrap()
            .journal
            .objects::<Work>("routing_work_v2")
            .unwrap()
            .len(),
        2
    );
    fixture.app.shutdown().await.unwrap();
}

fn selected_additional_group(fixture: &SelectedAnswerFixture) -> RoutingProposal {
    RoutingProposal {
        schema: PROPOSAL_SCHEMA.into(),
        items: vec![
            ProposedSegment {
                segment_id: "s1".into(),
                additional_segment_ids: vec!["s3".into()],
                operation: Operation::Amend {
                    target: fixture.selected.target(),
                    scope: "선택 자료: 간략하게, 출처 포함".into(),
                },
            },
            ProposedSegment {
                segment_id: "s2".into(),
                additional_segment_ids: vec![],
                operation: Operation::Amend {
                    target: fixture.other.target(),
                    scope: "다른 자료: 표 추가".into(),
                },
            },
        ],
    }
}

#[tokio::test]
async fn routing_selected_natural_additional_answer_group_preserves_source_and_resolution() {
    let fixture = SelectedAnswerFixture::open();
    let clauses = [
        "선택 자료에는 출처도 넣어 줘",
        "다른 자료에는 표를 넣어 줘",
        "그 질문은 선택 자료를 뜻했어",
    ];
    let (task, segments, resolves) = fixture.natural_task(&clauses, "s3");
    let action = ModelRoutingAction::Admit {
        segments,
        resolves: resolves.clone(),
        proposal: selected_additional_group(&fixture),
    };
    let answer: Admission =
        serde_json::from_value(result(fixture.admit_model(&task, action.clone()))).unwrap();
    assert_eq!(answer.input.text, parts(&clauses).0);
    assert_eq!(answer.input.resolves, resolves);
    assert_eq!(
        answer.input.origin.entry_profile_id,
        fixture.entry.profile_id
    );
    assert_eq!(answer.input.origin.conversation_id, task.conversation_id);
    let snapshot = fixture.app.lock().unwrap().profiles[&fixture.entry.profile_id]
        .runtime
        .session
        .committed()
        .unwrap();
    let actual = snapshot
        .submissions
        .iter()
        .find(|s| s.task_id == task.id)
        .unwrap();
    assert_eq!(answer.input.origin.message_id, actual.request_id);
    assert_eq!(answer.input.text, actual.text);
    assert_eq!(answer.items.len(), 3);
    assert_eq!(answer.items[0].work_id, answer.items[2].work_id);
    assert_eq!(answer.items[0].intent_id, answer.items[2].intent_id);
    assert_eq!(answer.items[2].group_anchor_segment_id, "s1");
    assert_ne!(answer.items[0].intent_id, answer.items[1].intent_id);
    let decisions: Vec<Decision> = serde_json::from_value(result(route(
        &fixture.app,
        &key(),
        json!({"type":"routing_decisions","entry":fixture.entry,"work_id":fixture.selected.id}),
    )))
    .unwrap();
    let decision = decisions.iter().find(|d| d.revision == 2).unwrap();
    assert_eq!(decision.source_admission_id, answer.id);
    assert_eq!(decision.source_segment_id, "s1");
    assert_eq!(
        decision.requested_text,
        format!("{}\n{}", clauses[0], clauses[2])
    );
    assert_eq!(decision.source_fragments.len(), 2);
    for (fragment, index) in decision.source_fragments.iter().zip([0, 2]) {
        assert_eq!(fragment.text, clauses[index]);
        assert_eq!(
            &actual.text[fragment.start_byte..fragment.end_byte],
            clauses[index]
        );
    }
    let receipt = fixture.receipt();
    assert_eq!(receipt["resolutions"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["resolutions"][0]["answer_admission_id"], answer.id);
    assert_eq!(receipt["resolutions"][0]["answer_segment_id"], "s3");
    let before_retry = rows(&fixture.app);
    assert_eq!(
        serde_json::from_value::<Admission>(result(fixture.admit_model(&task, action))).unwrap(),
        answer
    );
    assert_eq!(rows(&fixture.app), before_retry);
    fixture.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn routing_selected_natural_group_scope_keeps_target_coverage_and_task_fences() {
    let fixture = SelectedAnswerFixture::open();
    let clauses = [
        "선택 자료에는 출처도 넣어 줘",
        "다른 자료에는 표를 넣어 줘",
        "그 질문은 선택 자료를 뜻했어",
    ];
    let (task, segments, resolves) = fixture.natural_task(&clauses, "s3");
    let valid = ModelRoutingAction::Admit {
        segments: segments.clone(),
        resolves: resolves.clone(),
        proposal: selected_additional_group(&fixture),
    };
    let assert_denied = |action: ModelRoutingAction, typed: Option<&str>| {
        let before = rows(&fixture.app);
        let denied = fixture.admit_model(&task, action);
        assert_eq!(denied["ok"], false, "{denied}");
        if let Some(code) = typed {
            assert_eq!(denied["error_code"], code);
        }
        assert_eq!(
            rows(&fixture.app),
            before,
            "rejected answer must roll back every group"
        );
        assert!(fixture.receipt()["resolutions"]
            .as_array()
            .unwrap()
            .is_empty());
    };
    // The owner's selected target constrains a group even when the answer is
    // an additional source, rather than its anchor.
    let mut wrong_target = selected_additional_group(&fixture);
    wrong_target.items[0].operation = Operation::Amend {
        target: fixture.other.target(),
        scope: "must reject wrong selected target".into(),
    };
    assert_denied(
        ModelRoutingAction::Admit {
            segments: segments.clone(),
            resolves: resolves.clone(),
            proposal: wrong_target,
        },
        Some("input_collision"),
    );
    // An independent New remains valid; New in the linked answer group does not.
    assert_denied(
        ModelRoutingAction::Admit {
            segments: segments.clone(),
            resolves: resolves.clone(),
            proposal: proposal(vec![
                Operation::Question { target: None },
                new(
                    "independent allowed in isolation",
                    &fixture.entry.profile_id,
                ),
                new("answer replacement must reject", &fixture.entry.profile_id),
            ]),
        },
        Some("input_collision"),
    );
    let mut changed_resolves = resolves.clone();
    changed_resolves[0].answer_segment_id = "s1".into();
    assert_denied(
        ModelRoutingAction::Admit {
            segments: segments.clone(),
            resolves: changed_resolves,
            proposal: selected_additional_group(&fixture),
        },
        Some("input_collision"),
    );
    // Vacuous selected-group filtering cannot permit an uncovered answer.
    assert_denied(
        ModelRoutingAction::Admit {
            segments: segments.clone(),
            resolves: resolves.clone(),
            proposal: proposal(vec![
                Operation::Amend {
                    target: fixture.selected.target(),
                    scope: "selected but missing answer".into(),
                },
                new(
                    "must roll back independent creation",
                    &fixture.entry.profile_id,
                ),
            ]),
        },
        None,
    );
    let mut duplicate = selected_additional_group(&fixture);
    duplicate.items.push(ProposedSegment {
        segment_id: "s3".into(),
        additional_segment_ids: vec![],
        operation: Operation::Amend {
            target: fixture.selected.target(),
            scope: "duplicate answer membership".into(),
        },
    });
    assert_denied(
        ModelRoutingAction::Admit {
            segments: segments.clone(),
            resolves: resolves.clone(),
            proposal: duplicate,
        },
        None,
    );
    let mut incomplete_source = segments.clone();
    incomplete_source[0].start_byte = clauses[0].chars().next().unwrap().len_utf8();
    assert_denied(
        ModelRoutingAction::Admit {
            segments: incomplete_source,
            resolves: resolves.clone(),
            proposal: selected_additional_group(&fixture),
        },
        None,
    );
    let mut forged_task = task.clone();
    forged_task.conversation_id = key();
    let before = rows(&fixture.app);
    let denied = fixture.admit_model(&forged_task, valid.clone());
    assert_eq!(denied["error_code"], "origin_unavailable");
    assert_eq!(rows(&fixture.app), before);
    assert!(fixture.receipt()["resolutions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        work(&fixture.app, &fixture.entry, &fixture.selected.id),
        fixture.selected
    );
    assert_eq!(
        work(&fixture.app, &fixture.entry, &fixture.other.id),
        fixture.other
    );
    // All rejected attempts leave the original linked question available.
    let answer: Admission =
        serde_json::from_value(result(fixture.admit_model(&task, valid))).unwrap();
    assert_eq!(answer.input.text, parts(&clauses).0);
    assert_eq!(answer.input.resolves, resolves);
    assert_eq!(
        fixture.receipt()["resolutions"].as_array().unwrap().len(),
        1
    );
    fixture.app.shutdown().await.unwrap();
}
