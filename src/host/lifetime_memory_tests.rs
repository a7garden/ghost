use super::*;
use crate::adapters::memory::tests::scoped_fixture;
use std::fs;

#[cfg(feature = "lifetime")]
#[path = "memory_native_contention_tests.rs"]
mod native_contention;

#[cfg(feature = "lifetime")]
#[tokio::test]
async fn scoped_host_reply_reauthenticates_before_cached_receipt_and_requires_lineage_stamp() {
    use crate::{
        control::api::{Action, Command},
        host::{
            lifetime::{PiInferenceScope, PiToolRequest},
            Host,
        },
        lifetime_contract::{canonical_digest, Envelope, VERSION},
    };
    let root = tempfile::tempdir().unwrap();
    let host_root = root.path().join("host");
    let original = Host::open(&host_root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let created = original
        .action(Action {
            request_id: uuid::Uuid::now_v7().to_string(),
            command: Command::CreateProfile {
                name: "memory-reply-fixture".into(),
                persona: "original persona".into(),
            },
        })
        .unwrap();
    let ghost = created["result"]["profile_id"].as_str().unwrap().to_owned();
    original.shutdown().await.unwrap();
    let mut owned = std::sync::Arc::try_unwrap(original)
        .ok()
        .expect("all Host workers joined");
    let (brain, _environment, directory, _policy) = scoped_fixture(root.path(), &ghost).await;
    owned.brain = brain;
    owned.pi_local_route = Some(crate::host::lifetime_runtime::LocalPiRoute {
        base_url: "http://127.0.0.1:9/v1".into(),
        model_id: "fixture-local".into(),
        max_output_tokens: 1024,
        callback_token: "fixture-only".into(),
    });
    owned
        .stopping
        .store(false, std::sync::atomic::Ordering::Release);
    let host = std::sync::Arc::new(owned);
    let conversation = uuid::Uuid::now_v7().to_string();
    let envelope = |id: &str, actor: &str, body: Value| Envelope {
        protocol_version: VERSION.into(),
        command_id: id.into(),
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: actor.into(),
        authority_epoch: 1,
        expected_revision: None,
        correlation_id: id.into(),
        body,
    };
    let owner = |id: &str, body: Value| {
        host.action(Action {
            request_id: uuid::Uuid::now_v7().to_string(),
            command: Command::Lifetime {
                envelope: envelope(id, "owner", body),
            },
        })
        .unwrap()
    };
    let registered = owner(
        "register-memory-reply",
        json!({"method":"registry.ensure","ghost_id":ghost,"conversation_id":conversation,"kind":"specialist","roles":["fixture"]}),
    );
    assert_eq!(registered["result"]["status"], "success");
    let entered = owner(
        "owner-memory-turn",
        json!({"method":"conversation.input","ghost_id":ghost,"conversation_id":conversation,"text":"Read the source markers","privacy":"private","attachments":[]}),
    );
    assert_eq!(entered["result"]["status"], "success");
    host.lock()
        .unwrap()
        .journal
        .put(
            "policy",
            &ghost,
            &crate::domain::Policy {
                memory: true,
                ..Default::default()
            },
        )
        .unwrap();
    let request = |id: &str, body: Value| PiToolRequest {
        context_ref: None, ghost_id: ghost.clone(),
        conversation_id: conversation.clone(),
        envelope: envelope(id, &ghost, body),
    };
    let running=host.lifetime_pi_action(&request("fixture-running",json!({"method":"conversation.turn_status",
        "ghost_id":ghost,"conversation_id":conversation,"turn_id":"owner-memory-turn","status":"running",
        "submission_id":"fixture-sdk-submission","entry_id":null,"reason_code":null})),PiInferenceScope::Local).await.unwrap();
    assert_eq!(running["result"]["status"], "success", "{running}");
    let recalled=host.lifetime_pi_action(&request("recall-memory",json!({"method":"memory.recall","ghost_id":ghost,"conversation_id":conversation,"turn_id":"owner-memory-turn","query":"marker"})),PiInferenceScope::Local).await.unwrap();
    assert_eq!(recalled["result"]["status"], "success", "{recalled}");
    let stamp = recalled["result"]["data"]["context_revision"]
        .as_str()
        .unwrap();
    let unstamped = request(
        "unstamped-reply",
        json!({"method":"conversation.reply","ghost_id":ghost,"conversation_id":conversation,"turn_id":"owner-memory-turn","text":"source result"}),
    );
    let denied = host
        .lifetime_pi_action(&unstamped, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(denied["result"]["error_code"], "disclosure_blocked");
    let reply = request(
        "stamped-reply",
        json!({"method":"conversation.reply","ghost_id":ghost,"conversation_id":conversation,"turn_id":"owner-memory-turn","text":"source result","memory_context_revision":stamp}),
    );
    let accepted = host
        .lifetime_pi_action(&reply, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(accepted["result"]["status"], "success", "{accepted}");
    let receipt_before: String = host
        .lock()
        .unwrap()
        .journal
        .0
        .query_row(
            "SELECT response FROM lifetime_commands WHERE command_id='stamped-reply'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut grants: Value =
        serde_json::from_slice(&fs::read(directory.join("grants.json")).unwrap()).unwrap();
    grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token");
    fs::write(
        directory.join("grants.json"),
        serde_json::to_vec(&grants).unwrap(),
    )
    .unwrap();
    let replay = host
        .lifetime_pi_action(&reply, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(
        replay["result"]["error_code"], "disclosure_blocked",
        "{replay}"
    );
    let receipt_after: String = host
        .lock()
        .unwrap()
        .journal
        .0
        .query_row(
            "SELECT response FROM lifetime_commands WHERE command_id='stamped-reply'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        receipt_before, receipt_after,
        "prior receipt remains historical, never rewritten as rollback"
    );
    host.lock()
        .unwrap()
        .journal
        .put("policy", &ghost, &crate::domain::Policy::default())
        .unwrap();
    let inspected=host.lifetime_pi_action(&request("context-after-revoke",json!({"method":"memory.context.inspect","ghost_id":ghost,"conversation_id":conversation,"turn_id":"owner-memory-turn"})),PiInferenceScope::Local).await.unwrap();
    assert_eq!(inspected["result"]["data"]["memory_permitted"], false);
    let next = owner(
        "plain-owner-turn",
        json!({"method":"conversation.input","ghost_id":ghost,"conversation_id":conversation,"text":"An ordinary fresh reply","privacy":"private","attachments":[]}),
    );
    assert_eq!(next["result"]["status"], "success", "{next}");
    let running=host.lifetime_pi_action(&request("plain-running",json!({"method":"conversation.turn_status","ghost_id":ghost,"conversation_id":conversation,"turn_id":"plain-owner-turn","status":"running","submission_id":"fixture-plain-submission","entry_id":null,"reason_code":null})),PiInferenceScope::Local).await.unwrap();
    assert_eq!(running["result"]["status"], "success", "{running}");
    let plain=host.lifetime_pi_action(&request("plain-reply",json!({"method":"conversation.reply","ghost_id":ghost,"conversation_id":conversation,"turn_id":"plain-owner-turn","text":"Ordinary reply without a memory dependency"})),PiInferenceScope::Local).await.unwrap();
    assert_eq!(plain["result"]["status"], "success", "{plain}");
    host.shutdown().await.unwrap();
}
