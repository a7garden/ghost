use super::*;
use host::durable::Host as _;

fn action(app: &Arc<Host>, id: &str, command: Value) -> Value {
    app.action(serde_json::from_value(json!({"request_id":id,"command":command})).unwrap())
        .unwrap()
}
fn owner(app: &Arc<Host>, value: Value) -> Value {
    action(
        app,
        &uuid::Uuid::new_v4().to_string(),
        json!({"type":"workspace","action":value}),
    )
}
fn result(reply: Value) -> Value {
    assert_eq!(reply["ok"], true, "{reply}");
    reply["result"].clone()
}
fn profile(app: &Arc<Host>, name: &str) -> String {
    result(action(
        app,
        &uuid::Uuid::new_v4().to_string(),
        json!({"type":"create_profile","name":name,"persona":"personal assistant"}),
    ))["profile_id"]
        .as_str()
        .unwrap()
        .into()
}

#[tokio::test]
async fn planner_persists_deduplicates_and_rejects_stale_updates() {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let create = json!({"type":"workspace","action":{"type":"save_todo","todo":{"title":"한 주 계획","notes":"개인 할 일","due":"2028-02-29"}}});
    let first = result(action(&app, &key, create.clone()));
    assert_eq!(first, result(action(&app, &key, create)));
    assert_eq!(
        app.snapshot().unwrap()["todos"].as_array().unwrap().len(),
        1
    );
    let updated = result(owner(
        &app,
        json!({"type":"save_todo","id":key,"version":1,"todo":{"title":"한 주 계획","completed":true,"due":null}}),
    ));
    assert_eq!(updated["version"], 2);
    assert_eq!(
        owner(&app, json!({"type":"delete_todo","id":key,"version":1}))["ok"],
        false
    );
    assert_eq!(
        owner(
            &app,
            json!({"type":"save_todo","todo":{"title":"bad date","due":"2026-02-29"}})
        )["ok"],
        false
    );
    let event = result(owner(
        &app,
        json!({"type":"save_calendar_event","event":{"title":"일정","start_ms":1000,"end_ms":3000}}),
    ));
    assert_eq!(
        owner(
            &app,
            json!({"type":"save_calendar_event","event":{"title":"bad interval","start_ms":3000,"end_ms":1000}})
        )["ok"],
        false
    );
    let overlap = planner::execute(
        &app.lock().unwrap(),
        "list_calendar_events",
        &json!({"from_ms":2000,"to_ms":4000}),
        "read",
    )
    .unwrap();
    assert_eq!(overlap["events"][0]["id"], event["id"]);
    let adjacent = planner::execute(
        &app.lock().unwrap(),
        "list_calendar_events",
        &json!({"from_ms":3000,"to_ms":4000}),
        "read",
    )
    .unwrap();
    assert!(adjacent["events"].as_array().unwrap().is_empty());
    app.shutdown().await.unwrap();
    drop(app);
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    assert_eq!(app.snapshot().unwrap()["todos"][0]["completed"], true);
    result(owner(
        &app,
        json!({"type":"delete_todo","id":key,"version":2}),
    ));
    result(owner(
        &app,
        json!({"type":"delete_calendar_event","id":event["id"],"version":1}),
    ));
    assert!(app.snapshot().unwrap()["todos"]
        .as_array()
        .unwrap()
        .is_empty());
    app.shutdown().await.unwrap();
}

fn fixture() -> Value {
    // A real JSONL child process with pagination, notifications and persistent state.
    json!({"kind":"stdio","command":"python3","args":["-u","-c",r#"
import json,sys
calls=0
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 method=r['method']
 if method=='initialize': out={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif method=='tools/list':
  later='cursor' in r.get('params',{})
  out={'tools':[{'name':'drop' if later else 'remember','description':'fixture tool','inputSchema':{'type':'object'}}]}
  if not later: out['nextCursor']='next'
 elif method=='tools/call':
  if r['params']['name']=='drop': sys.exit(0)
  calls+=1
  out={'content':[{'type':'text','text':str(calls)}],'isError':False}
 else: out={}
 print(json.dumps({'jsonrpc':'2.0','method':'notifications/message','params':{'level':'info','data':'fixture'}}),flush=True)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':out}),flush=True)
"#],"env_refs":{},"cwd":null})
}

#[tokio::test]
async fn mcp_stdio_scope_pagination_persistence_and_uncertain_effects() {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let owner_id = profile(&app, "owner");
    let other = profile(&app, "other");
    let saved = result(owner(
        &app,
        json!({"type":"save_integration","integration":{"name":"Fixture","transport":fixture(),"profiles":[owner_id],"enabled":true}}),
    ));
    let id = saved["id"].as_str().unwrap();
    assert!(integrations::run(&app, id, Some(&other), None, || Ok(()))
        .await
        .is_err());
    let checked = integrations::run(&app, id, Some(&owner_id), None, || Ok(()))
        .await
        .unwrap();
    assert_eq!(checked["tools"].as_array().unwrap().len(), 2);
    for n in 1..=2 {
        let value = integrations::run(
            &app,
            id,
            Some(&owner_id),
            Some(("remember", json!({}))),
            || Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(value["content"][0]["text"], n.to_string());
    }
    let session = app.lock().unwrap().profiles[&owner_id]
        .runtime
        .session
        .clone();
    let mut config = host::durable::AgentConfig::new(host::mock_model(), "fixture");
    config.tools = services::role_tool_definitions(&app, services::ToolRole::Ordinary);
    let conversation = session.create_conversation(config).unwrap();
    let task_id = session
        .submit(&conversation, "message", InputKind::Prompt, "fixture")
        .unwrap()
        .task_id;
    let task = session.snapshot().unwrap().tasks[&task_id].clone();
    let bridge = services::Bridge {
        owner: owner_id.clone(),
        host: Arc::downgrade(&app),
    };
    let call = ai::ToolCall::new(
        "call",
        "integration_call",
        json!({"integration_id":id,"tool":"drop","arguments":{}}),
    );
    let plan = bridge.prepare(&task, &call).unwrap();
    assert!(!plan.replay_safe);
    let output = bridge.execute(&task, &call, &plan).await.unwrap();
    assert_eq!(output.status, ToolStatus::Uncertain);
    result(owner(
        &app,
        json!({"type":"save_integration","id":id,"version":1,"integration":{"name":"Fixture","transport":fixture(),"profiles":[owner_id],"enabled":false}}),
    ));
    assert!(bridge.prepare(&task, &call).is_err());
    assert!(
        integrations::run(&app, id, Some(&owner_id), None, || Ok(()))
            .await
            .is_err()
    );
    assert!(
        integrations::visible(&app.lock().unwrap(), &owner_id).unwrap()["integrations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_rechecks_grants_after_connection_and_does_not_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let profile_id = profile(&app, "agent");
    let saved = result(owner(
        &app,
        json!({"type":"save_integration","integration":{"name":"Fixture","transport":fixture(),"profiles":[profile_id],"enabled":true}}),
    ));
    let id = saved["id"].as_str().unwrap();
    let result = integrations::run(
        &app,
        id,
        Some(&profile_id),
        Some(("remember", json!({}))),
        || {
            let s = app.lock()?;
            let mut i: integrations::Integration = s.journal.get("integration", id)?.unwrap();
            i.data.profiles.clear();
            s.journal.put("integration", id, &i)?;
            Ok(())
        },
    )
    .await;
    assert!(result.is_err());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn integration_settings_validate_endpoints_and_keep_env_references_only() {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    for url in [
        "http://example.com/mcp",
        "https://user:password@example.com/mcp",
        "https://example.com/mcp?token=secret",
    ] {
        assert_eq!(
            owner(
                &app,
                json!({"type":"save_integration","integration":{"name":"bad","transport":{"kind":"http","url":url},"enabled":true}})
            )["ok"],
            false
        );
    }
    let saved = result(owner(
        &app,
        json!({"type":"save_integration","integration":{"name":"local","transport":{"kind":"http","url":"http://127.0.0.1:12345/mcp","bearer_env":"GHOST_TEST_MISSING_MCP_TOKEN"},"enabled":true}}),
    ));
    let id = saved["id"].as_str().unwrap();
    let failure = integrations::run(&app, id, None, None, || Ok(()))
        .await
        .unwrap_err();
    assert!(failure.to_string().contains("GHOST_TEST_MISSING_MCP_TOKEN"));
    assert_eq!(
        app.snapshot().unwrap()["integrations"][0]["transport"]["bearer_env"],
        "GHOST_TEST_MISSING_MCP_TOKEN"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_http_handles_session_headers_json_sse_and_tool_errors() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for _ in 0..5 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = vec![];
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap().to_lowercase();
            assert!(header.contains("mcp-protocol-version: 2025-06-18"));
            let size: usize = header
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let mut bytes = vec![0; size];
            socket.read_exact(&mut bytes).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            let method = request["method"].as_str().unwrap();
            if method != "initialize" {
                assert!(header.contains("mcp-session-id: fixture-session"));
            }
            let result = match method {
                "initialize" => {
                    json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
                }
                "notifications/initialized" => Value::Null,
                "tools/list" => {
                    json!({"tools":[{"name":"example","description":"일정 도구","inputSchema":{"type":"object"}}]})
                }
                "tools/call" => {
                    json!({"isError":true,"content":[{"type":"text","text":"Sign in to the fixture service"}]})
                }
                _ => panic!("unexpected method"),
            };
            let data = json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string();
            let (status, headers, body) = match method {
                "notifications/initialized" => ("202 Accepted", "", String::new()),
                "initialize" => (
                    "200 OK",
                    "Content-Type: application/json\r\nMcp-Session-Id: fixture-session\r\n",
                    data,
                ),
                "tools/list" => (
                    "200 OK",
                    "Content-Type: text/event-stream\r\n",
                    format!(": heartbeat\r\n\r\nevent: message\r\ndata: {data}\r\n\r\n"),
                ),
                _ => ("200 OK", "Content-Type: application/json\r\n", data),
            };
            let response = crate::test_http::reply(status, headers, &body);
            // Deliberately split an SSE/UTF-8 response across network writes.
            for part in response.as_bytes().chunks(7) {
                socket.write_all(part).await.unwrap();
            }
        }
    });
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let saved = result(owner(
        &app,
        json!({"type":"save_integration","integration":{"name":"HTTP fixture","transport":{"kind":"http","url":url},"enabled":true}}),
    ));
    let id = saved["id"].as_str().unwrap();
    let checked = integrations::run(&app, id, None, None, || Ok(()))
        .await
        .unwrap();
    assert_eq!(checked["tools"][0]["description"], "일정 도구");
    let output = integrations::run(&app, id, None, Some(("example", json!({}))), || Ok(()))
        .await
        .unwrap();
    assert_eq!(output["isError"], true);
    server.await.unwrap();
    app.shutdown().await.unwrap();
}
