use super::*;
use crate::{adapters::memory::tests::scoped_fixture, host::lifetime::pi_execution::tests as pi};

#[tokio::test]
async fn owner_temporal_errors_survive_authenticated_host_projection_without_recording_memory() {
    let mut f = pi::setup_with_spec(pi::verifier_spec("expected"));
    let (brain, _environment, directory, _) = scoped_fixture(f._root.path(), &f.ghost).await;
    f.host.brain = brain;
    f.host.pi_local_route = Some(crate::host::lifetime_runtime::LocalPiRoute {
        base_url: "http://127.0.0.1:9/v1".into(),
        model_id: "fixture".into(),
        max_output_tokens: 1024,
        callback_token: "fixture".into(),
    });
    {
        let state = f.host.lock().unwrap();
        state
            .journal
            .put(
                "policy",
                &f.ghost,
                &crate::domain::Policy {
                    memory: true,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let entered = pi::envelope(
        "owner",
        json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"Ask about the historical agreement","privacy":"private","attachments":[]}),
    );
    let turn = entered.command_id.clone();
    assert_eq!(
        f.host.lifetime_action(&entered).unwrap()["result"]["status"],
        "success"
    );
    for (method, extra, code) in [
        (
            "memory.search",
            json!({"as_of":0,"planes":["memory","documents"]}),
            "unsupported_temporal_scope",
        ),
        (
            "memory.recall",
            json!({"known_at":0,"planes":["documents"]}),
            "unsupported_temporal_scope",
        ),
        (
            "memory.recall",
            json!({"as_of":null}),
            "invalid_temporal_scope",
        ),
    ] {
        let mut body = json!({"method":method,"ghost_id":f.ghost,"conversation_id":f.conversation,"turn_id":turn,"query":"historical agreement"});
        for (field, value) in extra.as_object().unwrap() {
            body[field] = value.clone();
        }
        let request = lifetime::PiToolRequest {
            context_ref: None, ghost_id: f.ghost.clone(),
            conversation_id: f.conversation.clone(),
            envelope: pi::envelope(&f.ghost, body),
        };
        let response = f
            .host
            .lifetime_memory_action(&request, lifetime::PiInferenceScope::Local)
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Error);
        assert_eq!(response.error_code.as_deref(), Some(code));
        assert_eq!(response.retry_class, RetryClass::Never);
        assert_eq!(response.data["error_code"], code);
    }
    // The exact Work route must retain the same typed error, rather than
    // disguising unsupported document time as generic memory unavailability.
    f.host
        .native_computers
        .as_mut()
        .unwrap()
        .pi_fixture_allow_private(&f.ghost)
        .unwrap();
    let configured = pi::envelope(
        "owner",
        json!({"method":"work.memory.profile.configure","ghost_id":f.ghost,"required":false,"binding_ids":["shared"]}),
    );
    assert_eq!(
        f.host.lifetime_action(&configured).unwrap()["result"]["status"],
        "success"
    );
    let admitted=f.host.lifetime_action(&pi::envelope("owner",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Use only exact historical shared evidence","privacy":"public","acceptance_spec":pi::verifier_spec("expected")}))).unwrap();
    assert_eq!(admitted["result"]["status"], "success");
    let work = admitted["result"]["data"]["work"]["id"].as_str().unwrap();
    let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[work],|row|row.get(0)).unwrap();
    let request = lifetime::PiToolRequest {
        context_ref: None, ghost_id: f.ghost.clone(),
        conversation_id: f.conversation.clone(),
        envelope: pi::envelope(
            &f.ghost,
            json!({"method":"work.memory.recall","ghost_id":f.ghost,"conversation_id":f.conversation,"assignment_id":assignment,"work_id":work,"query":"historical agreement","as_of":0,"planes":["memory","documents"]}),
        ),
    };
    let response = f
        .host
        .lifetime_work_memory_action(&request, lifetime::PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Error);
    assert_eq!(
        response.error_code.as_deref(),
        Some("unsupported_temporal_scope")
    );
    assert_eq!(response.data["plane"], "documents");
    assert!(
        !directory.join("scope-calls.jsonl").exists(),
        "unsupported temporal intent must not become a current query"
    );
    let state = f.host.lock().unwrap();
    let used: i64 = state
        .journal
        .0
        .query_row(
            "SELECT count(*) FROM workspace_objects WHERE kind='memory_context_lineage_v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(used, 0);
}
