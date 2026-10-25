//! Real loopback parser/router + JS discovery/transport. The terminal verdict
//! is a controlled metadata fixture, not an independently executed verifier.
use super::pi_test_http::Server;
use super::*;
use crate::host::lifetime::{self, pi_execution::tests as pi};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_http_pi_terminal_report_checks_hmac_bearer_scope_and_exact_reply_replay() {
    let mut f = pi::setup_with_spec(json!({}));
    f.host.pi_callback_token = "b".repeat(64);
    // Controlled producer/failed-verdict metadata only. This test exercises
    // the HTTP boundary, and must not claim a real producer/verifier ran.
    {
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let raw: String = conn
            .query_row(
                "SELECT payload FROM lifetime_work WHERE id=?1",
                [&f.work],
                |r| r.get(0),
            )
            .unwrap();
        let mut work: crate::lifetime_contract::Work = serde_json::from_str(&raw).unwrap();
        work.state = "completed".into();
        work.execution_id = Some("http-controlled-producer-execution".into());
        conn.execute(
            "UPDATE lifetime_work SET state=?1,execution_id=?2,payload=?3 WHERE id=?4",
            rusqlite::params![
                work.state,
                work.execution_id,
                serde_json::to_string(&work).unwrap(),
                work.id
            ],
        )
        .unwrap();
    }
    lifetime::task_verification::fixture_terminal_receipt(&f.host, &f.work, "complete").unwrap();
    f.host.advance_task_verifications().await.unwrap();
    let (report, receipt_before, effects_before, executions_before, worker_before) = {
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='owner_task_verification_notice_v1'",[],|r|r.get(0)).unwrap();
        let notice: Value = serde_json::from_str(&raw).unwrap();
        let receipt: String = conn
            .query_row(
                "SELECT payload FROM workspace_objects WHERE kind='owner_task_verification_v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, u64>(0)).unwrap();
        (
            notice["report_id"].as_str().unwrap().to_owned(),
            receipt,
            count("SELECT COUNT(*) FROM lifetime_pi_effects"),
            count("SELECT COUNT(*) FROM lifetime_pi_executions"),
            count("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'"),
        )
    };
    assert_eq!(
        (effects_before, executions_before, worker_before),
        (0, 0, 0),
        "metadata fixture baseline must be explicit"
    );
    let owner_token = "a".repeat(64);
    let callback_token = f.host.pi_callback_token.clone();
    let raw_request = json!({"ghost_id":f.ghost,"conversation_id":f.conversation,"envelope":pi::envelope(&f.ghost,json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation}))});
    let invalid_command = raw_request["envelope"]["command_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let config = json!({"root":f.host.root,"ghost":f.ghost,"conversation":f.conversation,"report":report,"epoch":f.host.authority_epoch,"callbackToken":callback_token,"ownerToken":owner_token,"rawRequest":raw_request,"transportModule":concat!(env!("CARGO_MANIFEST_DIR"),"/apps/ghost-durable/src/host-transport.js")});
    let _root = f._root;
    let host = Arc::new(f.host);
    let server = Server::start(Arc::clone(&host), owner_token);
    let script = host.root.join("pi-report-http.mjs");
    let config_path = host.root.join("pi-report-http-config.json");
    fs_write(&config_path, serde_json::to_vec(&config).unwrap());
    let source = r#"import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
const c=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const {createHostToolTransport}=await import(c.transportModule);
const {discover}=await import(path.join(path.dirname(c.transportModule),'host-discovery.js'));
const {payloadDigest}=await import(path.join(path.dirname(c.transportModule),'contract.js'));
const transport=(token=c.callbackToken,epoch=c.epoch)=>createHostToolTransport({hostRoot:c.root,callbackToken:token,authorityEpoch:epoch});
const scope={ghost_id:c.ghost,conversation_id:c.conversation,report_id:c.report,inference_scope:'public',conversation_disclosure:'public'};
const inspect={...scope,method:'conversation.report.inspect',invocation_id:'http-terminal-inspect',arguments:{}};
if(process.argv[3]==='hmac-mismatch') {
 const metadata=path.join(c.root,'.ghost-control.json');const original=await fs.readFile(metadata,'utf8');const changed=JSON.parse(original);changed.token='c'.repeat(64);await fs.writeFile(metadata,JSON.stringify(changed));
 try {await assert.rejects(transport()({...inspect,invocation_id:'wrong-bootstrap-hmac'}),e=>e.code==='host_discovery_failed');}finally{await fs.writeFile(metadata,original);}
 console.log(JSON.stringify({status:'hmac_rejected'}));process.exit(0);
}
const call=transport();const result=await call(inspect);
assert.equal(result.status,'success');assert.equal(result.data.independent_verification.status,'failed');assert.equal(result.data.independent_verification.accepted,false);assert.equal(result.data.independent_verification.observation.exit_code,255);
const reply={...scope,method:'conversation.report.reply',invocation_id:'http-terminal-reply',arguments:{text:'Independent verification failed; this output was not accepted.'}};
const first=await call(reply);assert.equal(first.status,'success');assert.deepEqual(await call(reply),first);
for(const token of ['wrong-fixture-callback',c.ownerToken]) await assert.rejects(transport(token)({...inspect,invocation_id:'bad-token-'+token.slice(0,2)}),e=>e.code==='host_callback_rejected'&&e.http_status===403);
async function blocked(request,expectedCode,client=call){const result=await client(request);assert.equal(result.status,'error');assert.equal(result.error_code,expectedCode);assert.equal(result.data?.independent_verification,undefined);}
for(const mutation of [{conversation_id:'foreign-conversation'},{ghost_id:'foreign-ghost'}]) {
 await blocked({...inspect,...mutation,invocation_id:'foreign-inspect-'+JSON.stringify(mutation)},'unauthorized');
 await blocked({...reply,...mutation,invocation_id:'foreign-reply-'+JSON.stringify(mutation)},'unauthorized');
}
await blocked({...inspect,invocation_id:'stale-epoch'},'authority_fenced',transport(c.callbackToken,c.epoch+1));
const {origin}=await discover(c.root);
const headers={'Authorization':'Bearer '+c.callbackToken,'X-Ghost-CSRF':c.callbackToken,Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
for(const mutation of [{'X-Ghost-CSRF':'wrong-csrf'},{Origin:'https://foreign.example'},{'Sec-Fetch-Site':'cross-site'}]) {
 const r=await fetch(origin+'/api/v1/pi/action',{method:'POST',headers:{...headers,...mutation},body:JSON.stringify(c.rawRequest)});assert.equal(r.status,403);assert.deepEqual(await r.json(),{ok:false,error:'request_denied'});
}
const badDigest=structuredClone(c.rawRequest);badDigest.envelope.payload_digest='0'.repeat(64);
const bad=await fetch(origin+'/api/v1/pi/action',{method:'POST',headers,body:JSON.stringify(badDigest)});const invalid=await bad.json();assert.equal(bad.status,200);assert.deepEqual(invalid,{ok:false,error:'payload digest mismatch'});
console.log(JSON.stringify({status:'passed',bootstrap_hmac:true,actual_http:true,failed_metadata:true,exact_reply_replay:true,invalid_token_scope_epoch_rejected:true,model_calls:0}));
"#;
    fs_write(&script, source.as_bytes());
    let child = tokio::process::Command::new("node")
        .arg(&script)
        .arg(&config_path)
        .arg("exercise")
        .kill_on_drop(true)
        .env_clear()
        .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
        .env("HOME", &host.root)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(20), child)
        .await
        .expect("bounded real HTTP fixture timed out")
        .unwrap();
    assert!(
        output.status.success(),
        "Node HTTP fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed["status"], "passed");
    let before_hmac_posts = server.posts();
    let before_hmac_bootstraps = server.bootstraps();
    let mismatch = tokio::process::Command::new("node")
        .arg(&script)
        .arg(&config_path)
        .arg("hmac-mismatch")
        .kill_on_drop(true)
        .env_clear()
        .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
        .env("HOME", &host.root)
        .output();
    let mismatch = tokio::time::timeout(Duration::from_secs(20), mismatch)
        .await
        .expect("bounded HMAC negative timed out")
        .unwrap();
    assert!(
        mismatch.status.success(),
        "HMAC fixture failed: {}",
        String::from_utf8_lossy(&mismatch.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&mismatch.stdout).unwrap()["status"],
        "hmac_rejected"
    );
    assert_eq!(
        server.posts(),
        before_hmac_posts,
        "failed discovery HMAC must not send any callback POST"
    );
    assert_eq!(
        server.bootstraps(),
        before_hmac_bootstraps + 1,
        "HMAC rejection must follow an actual bootstrap response"
    );
    assert!(server.posts() >= 12);
    assert!(server.bootstraps() > server.posts() - 4);
    let errors = server.errors();
    assert!(
        errors.is_empty(),
        "production parser/router failed: {errors:?}"
    );
    drop(server);
    {
        let state = host.lock().unwrap();
        let conn = &state.journal.0;
        let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, u64>(0)).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM lifetime_report_replies"), 1);
        assert_eq!(
            count("SELECT COUNT(*) FROM lifetime_turns WHERE kind='assistant_advisory'"),
            1
        );
        assert_eq!(count("SELECT COUNT(*) FROM lifetime_acceptances"), 0);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM lifetime_commands WHERE command_id=?1",
                [&invalid_command],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            0,
            "invalid digest must not create a cached command receipt"
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM lifetime_pi_effects"),
            effects_before
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM lifetime_pi_executions"),
            executions_before
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'"),
            worker_before
        );
        let retained: String = conn
            .query_row(
                "SELECT payload FROM workspace_objects WHERE kind='owner_task_verification_v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(retained, receipt_before);
    }
    host.shutdown().await.unwrap();
}

fn fs_write(path: &Path, bytes: impl AsRef<[u8]>) {
    std::fs::write(path, bytes).unwrap();
}
