// Actual production main/SDK + Host HTTP/driver, with deterministic local
// inference and a declared fixture computer. No network model or physical tool.
mod actual_sdk {
    use super::*;
    use crate::{control::server::pi_test_http, host::lifetime_driver};
    use crate::host::lifetime_runtime::PiLauncher;
    use std::{
        io::Write,
        net::{Shutdown, TcpListener, TcpStream},
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::{Duration, Instant},
    };

    const MODEL: &str = "fixture/a19-sdk";
    const SIMPLE: &str = "A19_SDK_SIMPLE";
    const ORCHESTRA: &str = "GHOST_ORCHESTRA_SKILL_CANARY";
    const PARENT: &str = "A19_SDK_PARENT";
    const CHILD: &str = "A19_SDK_CHILD";
    const ANSWER: &str = "a19-sdk-output";
    const NATIVE: &str = "A19_SDK_NATIVE";
    const STOCK: &str = "A19_STOCK_CODING_TOOLS";
    const THREAD_OWNER: &str = "A19_OWNER_WORK_THREAD";
    const THREAD_FOLLOW_UP: &str = "Keep the filename and return the verified result in Korean.";

    struct ModelServer {
        origin: String,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
        requests: Arc<Mutex<Vec<Value>>>,
        errors: Arc<Mutex<Vec<String>>>,
        publication_allowed: Arc<AtomicBool>,
        delivered: Arc<AtomicUsize>,
    }
    impl ModelServer {
        fn start(root: &Path) -> Self { Self::start_at(root, None) }
        fn start_at(root: &Path, origin: Option<&str>) -> Self {
            let address = origin.map(|s|s.strip_prefix("http://").unwrap().strip_suffix("/v1").unwrap().to_owned()).unwrap_or_else(||"127.0.0.1:0".into());
            let listener = TcpListener::bind(&address).expect("explicit controlled loopback origin must be free; never stop another listener");
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}/v1", listener.local_addr().unwrap());
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = Arc::clone(&stop);
            let requests = Arc::new(Mutex::new(vec![]));
            let observed = Arc::clone(&requests);
            let errors = Arc::new(Mutex::new(vec![]));
            let failures = Arc::clone(&errors);
            let publication_allowed=Arc::new(AtomicBool::new(true));
            let allowed=Arc::clone(&publication_allowed);
            let delivered=Arc::new(AtomicUsize::new(0));
            let completed=Arc::clone(&delivered);
            let diagnostics = root.to_owned();
            let thread = std::thread::spawn(move || {
                while !stopping.load(Ordering::Acquire) {
                    let (mut peer, _) = match listener.accept() {
                        Ok(p) => p,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(2));
                            continue;
                        }
                        Err(_) => {
                            failures.lock().unwrap().push("accept_failed".into());
                            break;
                        }
                    };
                    prepare_controlled_peer(&peer);
                    match model_request(&mut peer, &observed, &allowed) {
                      Err(error) => {
                        let mut errors = failures.lock().unwrap();
                        if errors.len() < 16 {
                            errors.push(scrub(&format!("controlled_provider_request: {error:#}")));
                        }
                        private_diagnostic(
                            &diagnostics,
                            "provider-errors",
                            &json!({"errors":*errors}),
                        );
                      }
                      Ok(true) => {completed.fetch_add(1,Ordering::Release);}
                      Ok(false) => {} // EOF on an unused connection is no HTTP request.
                    }
                    let _ = peer.shutdown(Shutdown::Both);
                }
            });
            Self {
                origin,
                stop,
                thread: Some(thread),
                requests,
                errors,
                publication_allowed,
                delivered,
            }
        }
        fn requests(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
        fn clean(&self) {
            assert!(
                self.errors.lock().unwrap().is_empty(),
                "controlled provider protocol failure"
            );
        }
        fn owner_tools_absent(&self) {
            // Exact model tool names from models.js MEMORY_TOOL_NAMES and
            // DOCUMENT_TOOL_NAMES (document_ prefix), not source-view/Work tools.
            const OWNER_TOOLS: &[&str] = &[
                "memory_search",
                "memory_recall",
                "memory_session_list",
                "memory_retain",
                "memory_session_record",
                "document_list_spaces",
                "document_list_pages",
                "document_read_page",
                "document_review_page",
                "document_inspect_review",
            ];
            let requests = self.requests.lock().unwrap();
            let assigned = requests
                .iter()
                .filter(|body| {
                    body["messages"].as_array().is_some_and(|messages| {
                        messages.iter().any(|m| {
                            (m["role"] == "system" || m["role"] == "developer")
                                && m.to_string()
                                    .contains("Current authenticated Goal assignment:")
                        })
                    })
                })
                .collect::<Vec<_>>();
            assert!(
                !assigned.is_empty(),
                "actual assigned provider request must be observed"
            );
            for request in assigned {
                for tool in request["tools"].as_array().into_iter().flatten() {
                    let name = tool["function"]["name"].as_str().unwrap();
                    assert!(
                        !OWNER_TOOLS.contains(&name),
                        "actual Work request exposed an Owner-only tool"
                    );
                }
            }
        }
    }
    impl Drop for ModelServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(t) = self.thread.take() {
                t.join().unwrap();
            }
        }
    }
    struct Driver {
        task: Option<tokio::task::JoinHandle<()>>,
    }
    impl Driver {
        fn start(host: &Arc<Host>, entry: PathBuf) -> Self {
            Self {
                task: Some(tokio::spawn(lifetime_driver::run_broker_fixture_driver(
                    Arc::clone(host),
                    entry,
                ))),
            }
        }
        fn start_bundled(host: &Arc<Host>, binary: PathBuf) -> Self {
            Self {
                task: Some(tokio::spawn(lifetime_driver::run_broker_fixture_launcher(
                    Arc::clone(host),
                    PiLauncher::Bundled(binary),
                ))),
            }
        }
        async fn pause(mut self,host:&Host) {
            // Stop only this disposable fixture's original driver naturally.
            // Its tail closes and waits for its owned Pi child before reuse.
            assert!(!host.stopping.swap(true,Ordering::AcqRel));
            tokio::time::timeout(Duration::from_secs(12),self.task.as_mut().unwrap()).await.expect("fixture driver pause/owned child close deadline").unwrap();
            self.task.take();
            // A timeout or failed join leaves stopping set and prevents reuse.
            host.stopping.store(false,Ordering::Release);
        }
        async fn close(mut self, host: &Host) {
            host.shutdown().await.unwrap();
            tokio::time::timeout(Duration::from_secs(12), self.task.as_mut().unwrap())
                .await
                .unwrap()
                .unwrap();
            self.task.take();
        }
    }
    // Failure unwinding cancels the real driver owner. Its owned PiProcess has
    // kill_on_drop; the fixture never signals a PID recovered from history.
    impl Drop for Driver {
        fn drop(&mut self) {
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }
    fn tool_message<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
        let messages = body["messages"].as_array()?;
        let ids = messages
            .iter()
            .flat_map(|m| m["tool_calls"].as_array().into_iter().flatten())
            .filter(|c| c["function"]["name"] == name)
            .filter_map(|c| c["id"].as_str())
            .collect::<Vec<_>>();
        messages
            .iter()
            .rev()
            .find(|m| {
                m["role"] == "tool"
                    && m["tool_call_id"]
                        .as_str()
                        .is_some_and(|id| ids.contains(&id))
            })
    }
    fn tool_result(body: &Value, name: &str) -> Option<Value> {
        tool_message(body, name).and_then(|m| {
                if let Some(s) = m["content"].as_str() {
                    serde_json::from_str(s).ok()
                } else {
                    m["content"].as_array()?.iter().find_map(|p| {
                        p["text"]
                            .as_str()
                            .and_then(|s| serde_json::from_str(s).ok())
                    })
                }
            })
    }
    fn recall_result(body: &Value, query: &str) -> Option<Value> {
        let messages=body["messages"].as_array()?;
        let id=messages.iter().flat_map(|m|m["tool_calls"].as_array().into_iter().flatten()).find_map(|c| {
            let args:Value=serde_json::from_str(c["function"]["arguments"].as_str()?).ok()?;
            (c["function"]["name"]=="work_memory_recall" && args["query"]==query).then(||c["id"].as_str()).flatten()
        })?;
        let result=messages.iter().rev().find(|m|m["role"]=="tool" && m["tool_call_id"]==id)?;
        let content=&result["content"];
        serde_json::from_str(content.as_str().or_else(||content.as_array()?.iter().find_map(|p|p["text"].as_str()))?).ok()
    }
    fn call(name: &str, args: Value) -> Value {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("a19-sdk-{name}-{}",&format!("{:x}",Sha256::digest(args.to_string().as_bytes()))[..12]),"type":"function","function":{"name":name,"arguments":args.to_string()}}]})
    }
    fn model_message(body: &Value) -> Result<Value> {
        let messages = body["messages"]
            .as_array()
            .ok_or_else(|| anyhow!("messages_missing"))?;
        let all = serde_json::to_string(messages)?;
        // The current assignment marker is in the actual SDK request. No
        // in-memory step counter determines recovery or supplies a Host grant.
        let assignment = messages
            .iter()
            .filter(|m| m["role"] == "system" || m["role"] == "developer")
            .any(|m| m.to_string().contains("assignment_id"));
        if !assignment {
            if all.contains("Authenticated Host verification:") {
                return Ok(json!({"role":"assistant","content":"Host 검수를 통과했습니다. 작업 결과를 게시했습니다."}));
            }
            if all.contains(THREAD_OWNER) && all.contains("Authoritative Host report for work") {
                return Ok(json!({"role":"assistant","content":"작업 결과를 게시했습니다. 검수가 필요합니다."}));
            }
            if all.contains(THREAD_OWNER) && all.contains("Current authenticated input kind: owner.") {
                if let Some(created) = tool_result(body, "goal_create") {
                    ensure!(created["status"] == "success", "thread goal admission failed: {created}");
                    return Ok(json!({"role":"assistant","content":"작업을 시작했습니다."}));
                }
                return Ok(call("goal_create", json!({
                    "prompt": SIMPLE,
                    "acceptance_spec": lifetime::pi_execution::tests::verifier_spec(ANSWER),
                })));
            }
            return Ok(
                json!({"role":"assistant","content":"Controlled advisory; the Host owns independent acceptance."}),
            );
        }
        let stock = all.contains(STOCK);
        let tool_seen = |name| if stock { tool_message(body, name).is_some() } else { tool_result(body, name).is_some() };
        if all.contains(NATIVE) {
            let recall = |query| recall_result(body, query);
            if recall("A19_NATIVE_SOURCE_MARKER").is_none() {
                return Ok(call("work_memory_recall",json!({"query":"A19_NATIVE_SOURCE_MARKER","token_budget":2048,"planes":["memory"]})));
            }
            if recall("A19_PDC_SOURCE_MARKER").is_none() {
                return Ok(call("work_memory_recall",json!({"query":"A19_PDC_SOURCE_MARKER","token_budget":2048,"planes":["documents"]})));
            }
            let memory=recall("A19_NATIVE_SOURCE_MARKER").unwrap();
            let document=recall("A19_PDC_SOURCE_MARKER").unwrap();
            ensure!(memory["status"]=="success" && document["status"]=="success","actual_native_recall_failed");
            let m=&memory["data"]["evidence"][0]["source"]["source"];
            let d=&document["data"]["evidence"][0]["source"]["source"];
            let pin=|key:&str|->Result<String>{let token=all.split(key).nth(1).ok_or_else(||anyhow!("native_pin_missing"))?.chars().take(64).collect::<String>();ensure!(token.len()==64&&token.bytes().all(|b|b.is_ascii_hexdigit()),"native_pin_invalid");Ok(token)};
            let expected=format!("source={}@{};document={}@{}#{};skill={}",m["reference"].as_str().ok_or_else(||anyhow!("native_episode_missing"))?.strip_prefix("episode://").ok_or_else(||anyhow!("native_episode_scheme"))?,m["revision"].as_str().unwrap(),d["document_uuid"].as_str().unwrap(),d["revision"].as_str().unwrap(),pin("document_hash=")?,pin("skill=")?);
            if tool_result(body,"write").is_none() {return Ok(call("write",json!({"path":"answer.txt","content":expected})));}
            if tool_result(body,"publish_artifact").is_none() {return Ok(call("publish_artifact",json!({"path":"answer.txt","privacy":"private"})));}
            return Ok(json!({"role":"assistant","content":"The native source tuple is published for independent Host verification."}));
        }
        if all.contains(PARENT) {
            if all.contains("A19_PARK_SOURCE") && recall_result(body,"A19_NATIVE_SOURCE_MARKER").is_none() {return Ok(call("work_memory_recall",json!({"query":"A19_NATIVE_SOURCE_MARKER","token_budget":2048,"planes":["memory"]})));}
            let inspected = tool_result(body, "work_inspect");
            if inspected.is_none() {
                // The trusted system header contains a JSON assignment object.
                let system = messages
                    .iter()
                    .find(|m| {
                        (m["role"] == "system" || m["role"] == "developer")
                            && m.to_string().contains("assignment_id")
                    })
                    .unwrap();
                let text = system["content"]
                    .as_str()
                    .ok_or_else(|| anyhow!("actual_system_text_missing"))?;
                let marker = "Current authenticated Goal assignment: ";
                let object = text
                    .split(marker)
                    .nth(1)
                    .ok_or_else(|| anyhow!("actual_assignment_work_missing"))?
                    .trim();
                let mut parsed = serde_json::Deserializer::from_str(object).into_iter::<Value>();
                let descriptor = parsed
                    .next()
                    .ok_or_else(|| anyhow!("actual_assignment_json_missing"))??;
                let tail = object[parsed.byte_offset()..].trim();
                ensure!(
                    tail.is_empty() || tail == "</ghost-controller>",
                    "unexpected_assignment_header_tail"
                );
                let work = descriptor["work_id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("actual_assignment_work_missing"))?;
                return Ok(call("work_inspect", json!({"work_id":work})));
            }
            let inspected = inspected.unwrap();
            ensure!(
                inspected["status"] == "success",
                "actual_work_inspection_failed: status={} code={}",
                inspected["status"],
                inspected["error_code"]
            );
            let work = inspected["data"]["work"]["id"]
                .as_str()
                .ok_or_else(|| anyhow!("actual_work_missing"))?;
            if tool_result(body, "work_delegate").is_none() {
                let reference = inspected["data"]["delegation_contracts"][0]["contract_ref"]
                    .as_str()
                    .ok_or_else(|| anyhow!("actual_delegation_contract_missing"))?;
                return Ok(call(
                    "work_delegate",
                    json!({"parent_work_id":work,"contract_ref":reference}),
                ));
            }
            if !tool_seen("write") {
                return Ok(call(
                    "write",
                    json!({"path":"answer.txt","content":"initial-original"}),
                ));
            }
            if tool_result(body, "work_wait").is_none() {
                let delegated = tool_result(body, "work_delegate").unwrap();
                ensure!(
                    delegated["status"] == "success",
                    "actual_delegation_failed: status={} code={}",
                    delegated["status"],
                    delegated["error_code"]
                );
                let child = delegated["data"]["work"]["id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("actual_child_missing"))?;
                return Ok(call(
                    "work_wait",
                    json!({"work_id":work,"wait_for":[child]}),
                ));
            }
            if !tool_seen("edit") {
                return Ok(call(
                    "edit",
                    json!({"path":"answer.txt","edits":[{"oldText":"initial-original","newText":ANSWER}]}),
                ));
            }
        } else if all.contains(SIMPLE) || all.contains(CHILD) {
            if !tool_seen("write") {
                return Ok(call(
                    "write",
                    json!({"path":"answer.txt","content":if all.contains(CHILD) {
                        if stock { "child-start" } else { "child-ready" }
                    } else { ANSWER }}),
                ));
            }
        } else {
            return Err(anyhow!("unrecognized_actual_assignment"));
        }
        if stock && !all.contains(PARENT) && all.contains(CHILD) {
            let Some(read) = tool_message(body, "read") else {
                return Ok(call("read", json!({"path":"answer.txt","offset":1,"limit":1})));
            };
            ensure!(read["content"].to_string().contains("child-start"), "stock read did not return the staged text");
            if !tool_seen("edit") {
                return Ok(call("edit", json!({"path":"answer.txt","edits":[{"oldText":"child-start","newText":"child-ready"}]})));
            }
            let Some(shell) = tool_message(body, "bash") else {
                return Ok(call("bash", json!({"command":"test \"$(cat answer.txt)\" = child-ready && printf stock-shell-ok","timeout":30})));
            };
            ensure!(shell["content"].to_string().contains("stock-shell-ok"), "stock bash did not return isolated stdout");
        }
        let orchestra = all.contains(ORCHESTRA);
        if orchestra {
            let Some(read) = tool_message(body, "read") else {
                return Ok(call("read", json!({"path":"answer.txt"})));
            };
            ensure!(read["content"].to_string().contains(ANSWER), "Orchestra check did not read the exact output");
        }
        if tool_result(body, "publish_artifact").is_none() {
            let privacy = if orchestra { "local_only" } else { "public" };
            return Ok(call("publish_artifact", json!({"path":"answer.txt","privacy":privacy})));
        }
        Ok(
            json!({"role":"assistant","content":"The artifact is published; independent Host acceptance is separate."}),
        )
    }
    fn prepare_controlled_peer(peer:&TcpStream) {
        // Darwin accept inherits the nonblocking listener's socket properties.
        // Explicitly restore blocking IO before bounded peek/HTTP parsing.
        peer.set_nonblocking(false).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        peer.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
    }
    #[test]
    fn controlled_provider_accepts_delayed_bytes_but_rejects_partial_http() {
        use std::os::fd::AsRawFd;
        for case in ["delayed","unused","partial"] {
            let listener=TcpListener::bind(("127.0.0.1",0)).unwrap();listener.set_nonblocking(true).unwrap();
            let mut client=TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let deadline=Instant::now()+Duration::from_secs(3);
            let (mut peer,_)=loop {
                match listener.accept() {
                    Ok(peer)=>break peer,
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>{
                        assert!(Instant::now()<deadline,"controlled socket connection admission deadline");
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error)=>panic!("controlled socket accept failed: {error}"),
                }
            };
            peer.set_nonblocking(true).unwrap();prepare_controlled_peer(&peer);
            assert_eq!(unsafe{libc::fcntl(peer.as_raw_fd(),libc::F_GETFL)}&libc::O_NONBLOCK,0);
            let (started,ready)=std::sync::mpsc::channel();
            let reader=std::thread::spawn(move|| {
                let observed=Mutex::new(vec![]);let allowed=AtomicBool::new(true);started.send(()).unwrap();
                let result=model_request(&mut peer,&observed,&allowed);
                (result,observed.into_inner().unwrap().len())
            });
            ready.recv().unwrap();
            if case=="delayed" {
                let body=json!({"model":MODEL,"messages":[{"role":"user","content":"Controlled socket fixture"}]}).to_string();
                write!(client,"POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",body.len(),body).unwrap();
            }else if case=="partial" {client.write_all(b"POST /v1/chat/completions HTTP/1.1\r\n").unwrap();}
            client.shutdown(Shutdown::Write).unwrap();
            let (result,requests)=reader.join().unwrap();
            match case {"delayed"=>{assert!(result.unwrap());assert_eq!(requests,1);},"unused"=>{assert!(!result.unwrap());assert_eq!(requests,0);},_=>{assert!(result.is_err());assert_eq!(requests,0);}}
        }
    }
    fn model_request(peer: &mut TcpStream, observed: &Mutex<Vec<Value>>, publication_allowed:&AtomicBool) -> Result<bool> {
        // Fetch may open a spare connection, then close it without sending a
        // request. Peek consumes nothing; any partial/malformed HTTP still goes
        // through the strict parser, and failed response writes still fail.
        let mut first=[0u8;1];
        if peer.peek(&mut first)?==0 {return Ok(false);}
        let request = crate::local_http::read_with_limit(peer, 1_048_576)?;
        ensure!(
            request.method == "POST" && request.target == "/v1/chat/completions",
            "unexpected_controlled_endpoint"
        );
        let body: Value = serde_json::from_slice(&request.body)?;
        ensure!(body["model"] == MODEL, "unexpected_controlled_model");
        {
            let mut rows = observed.lock().unwrap();
            ensure!(rows.len() < 64, "controlled_call_budget");
            rows.push(body.clone());
        }
        let message = model_message(&body)?;
        if message["tool_calls"][0]["function"]["name"]=="publish_artifact" || body["messages"].to_string().contains("A19_SDK_CLAIM_HOLD") {
            let deadline=Instant::now()+Duration::from_secs(5);
            while !publication_allowed.load(Ordering::Acquire) {ensure!(Instant::now()<deadline,"controlled_publication_gate_deadline");std::thread::sleep(Duration::from_millis(2));}
        }
        let reason = if message["tool_calls"].is_array() {
            "tool_calls"
        } else {
            "stop"
        };
        let response=json!({"id":"a19-sdk-controlled","object":"chat.completion","created":1,"model":MODEL,"choices":[{"index":0,"message":message,"finish_reason":reason}],"usage":{"prompt_tokens":128,"completion_tokens":32,"total_tokens":160}}).to_string();
        write!(peer,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response)?;
        peer.flush()?;
        Ok(true)
    }
    async fn isolated_environment(
        root: &Path,
        ghost: &str,
    ) -> crate::adapters::memory::tests::SourceEnvGuard {
        let (_, mut environment, _, _) =
            crate::adapters::memory::tests::scoped_fixture(root, ghost).await;
        const ROUTES: &[&str] = &[
            "GHOST_LIFETIME_PI_ENTRY",
            "GHOST_LIFETIME_MODE",
            "GHOST_PI_COMPUTERS_CONFIG",
            "GHOST_LIFETIME_NATIVE_WORKERS_CONFIG",
            "GHOST_LIFETIME_LOCAL_MODEL_URL",
            "GHOST_LIFETIME_LOCAL_MODEL_ID",
            "GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS",
            "GHOST_LIFETIME_LOCAL_ROUTE_IDENTITY",
            "GHOST_PI_ARTIFACT_RELOCATION_FILE",
        ];
        environment.capture_extra(ROUTES);
        for key in ROUTES.iter().chain(
            [
                "GHOST_BRAIN_EXECUTABLE",
                "GHOST_BRAIN_DIR",
                "GHOST_BRAIN_TOKEN",
                "GHOST_BRAIN_BINDINGS",
                "GHOST_BRAIN_SPACE_MAP",
            ]
            .iter(),
        ) {
            std::env::remove_var(key);
        }
        environment
    }
    fn production_entry(root: &Path) -> PathBuf {
        // Strip ambient provider credentials/routes in the child, then import
        // production main unchanged. PiProcess still supplies exact local pins.
        let entry = root.join("isolated-sdk-main.mjs");
        let main = Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/ghost-durable/src/main.js");
        let script=format!("import {{pathToFileURL}} from 'node:url';\nconst keep=new Set(['PATH','GHOST_LIFETIME_HOST_ROOT','GHOST_PI_CALLBACK_TOKEN','GHOST_PI_AUTHORITY_EPOCH','GHOST_PI_LOCAL_CALLBACK_TOKEN','GHOST_LIFETIME_LOCAL_MODEL_URL','GHOST_LIFETIME_LOCAL_MODEL_ID','GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS','GHOST_LIFETIME_LOCAL_ROUTE_IDENTITY']);for(const key of Object.keys(process.env))if(!keep.has(key))delete process.env[key];process.env.HOME=process.env.GHOST_LIFETIME_HOST_ROOT;await import(pathToFileURL({}).href);\n",serde_json::to_string(main.to_str().unwrap()).unwrap());
        fs::write(&entry, script).unwrap();
        entry
    }
    fn configure_local(host: &mut Host, model: &ModelServer, pairs: &[(&str, &str)]) {
        host.pi_callback_token = "a19-sdk-public-callback".into();
        host.pi_local_route = Some(host::lifetime_runtime::LocalPiRoute {
            base_url: model.origin.clone(),
            model_id: MODEL.into(),
            max_output_tokens: 1024,
            callback_token: "a19-sdk-local-callback".into(),
        });
        for (ghost, conversation) in pairs {
            let version=host.inference_settings().unwrap()["settings"]["version"].as_u64().unwrap();
            host.configure_inference(&json!({"operation":"select","version":version,"ghost_id":ghost,"conversation_id":conversation,"selection":{"provider":"local","model":MODEL,"effort":"off"}})).unwrap();
        }
    }
    fn scrub(text: &str) -> String {
        let mut text = text.to_owned();
        for (key, value) in std::env::vars().filter(|(key, value)| {
            !value.is_empty()
                && (key.contains("TOKEN") || key.contains("KEY") || key.contains("PASSWORD"))
        }) {
            let _ = key;
            text = text.replace(&value, "[credential redacted]");
        }
        for token in [
            "a19-sdk-public-callback",
            "a19-sdk-local-callback",
            &"a".repeat(64),
        ] {
            text = text.replace(token, "[fixture credential redacted]");
        }
        text.chars().take(2048).collect()
    }
    fn private_diagnostic(root: &Path, name: &str, value: &Value) {
        let bytes = serde_json::to_vec_pretty(value).unwrap();
        if bytes.len() > 65536 {
            return;
        }
        let path = root.join(format!("sdk-{name}.json"));
        if let Ok(mut file) = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            let _ = file.write_all(&bytes);
            let _ = file.sync_all();
        }
    }
    fn progress(
        host: &Host,
        model: &ModelServer,
        http: &pi_test_http::Server,
        phase: &str,
        status: &str,
    ) {
        let state = host.lock().unwrap();
        let conn = &state.journal.0;
        let collect = |sql: &str| -> Vec<Value> {
            let Ok(mut q) = conn.prepare(sql) else {
                return vec![];
            };
            let Ok(rows) = q.query_map([], |r| r.get::<_, String>(0)) else {
                return vec![];
            };
            rows.take(32)
                .filter_map(|r| r.ok().and_then(|s| serde_json::from_str(&s).ok()))
                .collect()
        };
        let works=collect("SELECT json_object('id',id,'state',state,'blocker',json_extract(payload,'$.blocker'),'execution_id',execution_id) FROM lifetime_work ORDER BY id LIMIT 32");
        let outbox=collect("SELECT json_object('id',id,'target',target,'delivery_ref',delivery_ref,'acknowledged',acknowledged) FROM lifetime_outbox ORDER BY id LIMIT 32");
        let counts=collect("SELECT json_object('contexts',(SELECT COUNT(*) FROM workspace_objects WHERE kind='ghost_work_context_v1'),'claims',(SELECT COUNT(*) FROM workspace_objects WHERE kind='ghost_work_context_claim_v1'),'effects',(SELECT COUNT(*) FROM lifetime_pi_effects),'acceptances',(SELECT COUNT(*) FROM lifetime_acceptances))");
        drop(state);
        let mut runs = vec![];
        if let Ok(dirs) = fs::read_dir(host.root.join("durable")) {
            for dir in dirs.take(16).flatten() {
                let path = dir.path().join("runtime.sqlite");
                if path.is_file() {
                    if let Ok(db) = Connection::open_with_flags(
                        &path,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    ) {
                        if let Ok(mut q)=db.prepare("SELECT turn_id,status,reason_code FROM ghost_canonical_turn_runs LIMIT 16"){if let Ok(rows)=q.query_map([],|r|Ok(json!({"turn_id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"reason_code":r.get::<_,Option<String>>(2)?}))){runs.extend(rows.filter_map(|r|r.ok()));}}
                    }
                }
            }
        }
        private_diagnostic(
            &host.root,
            phase,
            &json!({"phase":phase,"status":status,"works":works,"outbox":outbox,"counts":counts,"runtime_runs":runs,"provider_requests":model.requests(),"provider_errors":model.errors.lock().unwrap().iter().map(|e|scrub(e)).collect::<Vec<_>>(),"http_errors":http.errors().iter().map(|e|scrub(e)).collect::<Vec<_>>(),"http_callbacks":http.diagnostic_observations(),"runtime_diagnostics":"controlled main stderr codes retained in parent test log; no raw model/source content captured"}),
        );
    }
    async fn until(
        host: &Host,
        model: &ModelServer,
        http: &pi_test_http::Server,
        phase: &str,
        check: impl Fn(&Connection) -> bool,
    ) {
        until_before(host,model,http,phase,Instant::now()+Duration::from_secs(20),check).await;
    }
    async fn until_before(
        host:&Host,
        model:&ModelServer,
        http:&pi_test_http::Server,
        phase:&str,
        deadline:Instant,
        check:impl Fn(&Connection)->bool,
    ) {
        loop {
            if check(&host.lock().unwrap().journal.0) {
                progress(host, model, http, phase, "observed");
                return;
            }
            if Instant::now() >= deadline {
                progress(host, model, http, phase, "deadline_unconfirmed");
            }
            assert!(
                Instant::now() < deadline,
                "actual SDK/Host progress deadline"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    fn row(conn: &Connection, kind: &str, id: &str) -> Value {
        let raw: String = conn
            .query_row(
                "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
    fn context_claim(host: &Host, assignment: &str) -> (Value, Value) {
        let state = host.lock().unwrap();
        let context = row(&state.journal.0, "ghost_work_context_v1", assignment);
        let claim = row(
            &state.journal.0,
            "ghost_work_context_claim_v1",
            context["reference"].as_str().unwrap(),
        );
        (context, claim)
    }
    fn effects(host: &Host, work: &str) -> Vec<String> {
        let state = host.lock().unwrap();
        let mut q=state.journal.0.prepare("SELECT json_array(task_id,call_id,input_digest,operation,state,response_json) FROM lifetime_pi_effects WHERE execution_id=(SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1) ORDER BY task_id,call_id").unwrap();
        let rows = q
            .query_map([work], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        rows
    }
    fn accepted(conn: &Connection, work: &str) -> bool {
        conn.query_row(
            "SELECT state='accepted' FROM lifetime_work WHERE id=?1",
            [work],
            |r| r.get(0),
        )
        .unwrap_or(false)
    }
    fn public_privacy_preserved(host: &Host, ghost: &str, conversation: &str) {
        let key = format!("{:x}", Sha256::digest(ghost.as_bytes()));
        let path = host.root.join("durable").join(key).join("runtime.sqlite");
        let index =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let privacy: String = index
            .query_row(
                "SELECT privacy FROM ghost_conversations WHERE external_id=?1",
                [conversation],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            privacy, "public",
            "local provider selection must not relabel committed disclosure"
        );
    }

    // Opt-in composite native fixture. It owns only its declared loopback
    // provider, actual Host HTTP bridge and the already existing driver.
    #[cfg(feature = "documents")]
    pub(super) struct NativeSdk {
        model: ModelServer,
        http: pi_test_http::Server,
        entry: PathBuf,
        driver: Option<Driver>,
    }
    #[cfg(feature = "documents")]
    impl NativeSdk {
        pub(super) fn start(host: &mut Arc<Host>, c: &Candidate, origin: Option<&str>) -> Self {
            let model=ModelServer::start_at(&host.root,origin);
            configure_local(Arc::get_mut(host).expect("configure before HTTP/driver owners"),&model,&[(&c.definition.ghost_id,&c.conversation_id)]);
            let entry=production_entry(&host.root);
            let http=pi_test_http::Server::start(Arc::clone(host),"a".repeat(64));
            Self{model,http,entry,driver:None}
        }
        pub(super) fn origin(&self) -> &str {&self.model.origin}
        pub(super) fn prepare(&self,seed_home:bool){self.model.publication_allowed.store(!seed_home,Ordering::Release);}
        pub(super) fn start_driver(&mut self,host:&Arc<Host>) {
            assert!(self.driver.is_none());self.driver=Some(Driver::start(host,self.entry.clone()));
        }
        pub(super) async fn pause_driver(&mut self,host:&Host) {
            if let Some(driver)=self.driver.take(){driver.pause(host).await;}
        }
        pub(super) fn clean(&self) {self.model.clean();self.model.owner_tools_absent();assert!(self.http.errors().is_empty());}
        pub(super) async fn accepted_work(&self,host:&Arc<Host>,c:&Candidate,work:&Work,assignment:&str,expected:&str,proof:Value,seed_home:bool)->Value {
            // Real native source authentication/provenance checks accompany
            // each SDK request. One deadline covers this entire Work stage.
            let deadline=Instant::now()+Duration::from_secs(90);
            let home_relative=if seed_home {
                until_before(host,&self.model,&self.http,"native-sdk-original-lease",deadline,|db|db.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_effects e JOIN lifetime_pi_executions x ON x.execution_id=e.execution_id WHERE x.work_id=?1 AND x.state='running' AND e.operation='write' AND e.state='complete')",[&work.id],|r|r.get(0)).unwrap()).await;
                let execution:String=host.lock().unwrap().journal.0.query_row("SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1 AND state='running'",[&work.id],|r|r.get(0)).unwrap();
                let native=host.native_computers.as_ref().unwrap();let computer=native.pi_computer(&c.definition.ghost_id).unwrap();
                assert!(native.pi_current(&c.definition.ghost_id,&execution,&computer,host.authority_epoch,"private").unwrap());
                let environment=native.pi_acquire(&c.definition.ghost_id,&execution,host.authority_epoch,"private").unwrap();
                let layout=crate::operations::home_lanes::open_layout_by_marker_at_root(&environment.manifest.home_volume,&computer).unwrap();
                let path=layout.private.join("a19-original-preference");fs::write(&path,b"original Ghost home preference").unwrap();
                self.model.publication_allowed.store(true,Ordering::Release);
                Some(path.strip_prefix(&host.root).unwrap().to_owned())
            }else{None};
            until_before(host,&self.model,&self.http,"native-sdk-accepted",deadline,|db|accepted(db,&work.id)).await;
            loop {
                let db=Connection::open_with_flags(index_path(host,&c.definition.ghost_id),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                let settled:bool=db.query_row("SELECT status='answered' FROM ghost_canonical_turn_runs WHERE turn_id=?1",[assignment],|r|r.get(0)).unwrap();
                if settled{break;}assert!(Instant::now()<deadline,"SDK completion projection must settle before source driver pause");tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let (context,claim)=context_claim(host,assignment);
            assert_eq!(context["authority_epoch"],host.authority_epoch);
            assert_eq!(context["work_id"],work.id);
            let requests=self.model.requests.lock().unwrap();
            let request=requests.iter().rev().find(|body| {
                body["messages"].as_array().is_some_and(|messages|messages.iter().any(|m| (m["role"]=="system"||m["role"]=="developer")&&m.to_string().contains(assignment)))
                    && recall_result(body,"A19_PDC_SOURCE_MARKER").is_some()
            }).expect("actual provider saw both native memory tool results");
            let mut observations=serde_json::Map::new();
            for (label,query) in [("memory","A19_NATIVE_SOURCE_MARKER"),("document","A19_PDC_SOURCE_MARKER")] {
                let result=recall_result(request,query).unwrap();assert_eq!(result["status"],"success");
                let data=&result["data"];assert_eq!(data["partial"],false);
                let scopes=data["scopes"].as_array().unwrap();assert_eq!(scopes.len(),1);
                let scope=&scopes[0];assert_eq!(scope["binding_id"],"shared");assert_eq!(scope["space"],"common");assert_eq!(scope["partial"],false);
                assert_eq!(scope["result"]["meta"]["scope"]["requested"]["space"],proof["space"]);
                let evidence=data["evidence"].as_array().unwrap();assert_eq!(evidence.len(),1,"fixture has one independently seeded source per plane");
                let item=&evidence[0];assert_eq!(item["binding_id"],"shared");assert_eq!(item["space"],"common");
                let citation=&item["source"];let coordinate=&citation["source"];
                let text=scope["result"]["data"]["layers"][citation["layer_index"].as_u64().unwrap() as usize]["text"].as_str().unwrap();
                let start=citation["rendered_text_start"].as_u64().unwrap() as usize;let end=citation["rendered_text_end"].as_u64().unwrap() as usize;
                assert!(text[start..end].contains(query));
                if label=="memory" {
                    assert_eq!(coordinate["view"],"episode-utf8/1");
                    let observed=format!("source={}@{};",coordinate["reference"].as_str().unwrap().strip_prefix("episode://").unwrap(),coordinate["revision"].as_str().unwrap());
                    assert!(expected.starts_with(&observed),"provider memory coordinate differs from native ledger");
                } else {
                    assert_eq!(coordinate["document_uuid"],proof["document_uuid"]);assert_eq!(coordinate["revision"],proof["source_revision"]);assert_eq!(coordinate["view"],"decoded-utf8/1");assert!(coordinate["view_digest"].as_str().is_some());
                    assert_eq!(coordinate["reference"],format!("doc://a19-source/{}?rev={}",proof["locator"].as_str().unwrap(),proof["source_revision"].as_str().unwrap()));
                    let freshness=&scope["result"]["meta"]["freshness"];assert!(freshness["reconciled_roots"].as_array().unwrap().iter().any(|v|v=="a19-source"));assert_eq!(freshness["skipped_roots"],json!([]));assert_eq!(freshness["skipped_files"],0);assert_eq!(freshness["stale_after_retry"],json!([]));
                }
                observations.insert(label.into(),data.clone());
            }
            let artifact=tool_result(request,"publish_artifact").expect("actual SDK publication response");
            assert_eq!(artifact["status"],"success");let artifact=artifact["artifacts"][0].clone();
            drop(requests);
            let state=host.lock().unwrap();
            let actual:Work=serde_json::from_str(&state.journal.0.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[&work.id],|r|r.get::<_,String>(0)).unwrap()).unwrap();
            assert_eq!(actual.state,"accepted");assert!(assets_for_work(&state.journal.0,&actual).unwrap().iter().any(|a|a["sha256"]==c.definition.content.skill_refs[0].digest));
            let (task,call_id,input_digest,arguments):(u64,String,String,String)=state.journal.0.query_row("SELECT task_id,call_id,input_digest,arguments_json FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='write'",[actual.execution_id.as_ref().unwrap()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
            let memory_revision=observations["document"]["context_revision"].clone();
            drop(state);
            let replay=super::request(host,c,assignment,&work.id,"work.execute",json!({"generation_task_id":claim["generation_task_id"],"task_id":task,"call_id":call_id,"operation":"write","input_digest":input_digest,"arguments":serde_json::from_str::<Value>(&arguments).unwrap(),"work_memory_context_revision":memory_revision}),&format!("native-sdk-replay-{}",work.id));
            let state=host.lock().unwrap();
            json!({"work":actual,"grant":raw_grant_no_lock(&state.journal.0,&actual),"definition":bots_store::definition_for_work(&state.journal.0,&actual).unwrap(),"replay":json!({"ghost_id":replay.ghost_id,"conversation_id":replay.conversation_id,"envelope":replay.envelope,"context_ref":replay.context_ref}),"artifact":artifact,"expected":expected,"recall_observations":observations,"document_source_proof":proof,"home_relative":home_relative,"context":context,"claim":claim})
        }
        pub(super) async fn park(&self,host:&Arc<Host>,c:&Candidate,primary:&str)->Value {
            assert!(self.driver.is_none());
            let deadline=Instant::now()+Duration::from_secs(90);
            let mut spec=lifetime::pi_execution::tests::verifier_spec(ANSWER);
            spec["delegation_contracts"]=json!([{"target_ghost_id":primary,"prompt":CHILD,"acceptance_spec":lifetime::pi_execution::tests::verifier_spec("child-ready"),"artifact_refs":[]}]);
            let admitted=owner(host,"a19-sdk-parked-goal",json!({"method":"goal.submit","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"prompt":format!("{PARENT} A19_PARK_SOURCE"),"privacy":"private","acceptance_spec":spec}),None);
            let work=admitted["work"]["id"].as_str().unwrap();
            let (outbox,raw)= {let state=host.lock().unwrap();state.journal.0.query_row("SELECT id,payload FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[work],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).unwrap()};
            let assignment:Envelope=serde_json::from_str(&raw).unwrap();
            let mut pi=host::lifetime_runtime::PiProcess::start(&self.entry,&host.root.join("durable"),&host.root,"broker",&host.pi_callback_token,host.authority_epoch,host.pi_local_route.as_ref()).await.unwrap();
            let ack=pi.request(&assignment).await.unwrap();assert_eq!(ack.status,ResponseStatus::Success);
            lifetime::ack_outbox(&host.lock().unwrap().journal.0,outbox,&serde_json::to_value(ack).unwrap()).unwrap();
            until_before(host,&self.model,&self.http,"native-sdk-parked",deadline,|db|db.query_row("SELECT state='blocked' AND json_extract(payload,'$.blocker') LIKE 'wait_for:%' FROM lifetime_work WHERE id=?1",[work],|r|r.get(0)).unwrap_or(false)).await;
            pi.close().await.unwrap();
            let (context,claim)=context_claim(host,&assignment.command_id);let effects=effects(host,work);assert_eq!(effects.len(),1);
            let wait=row(&host.lock().unwrap().journal.0,"pi_work_wait_active",work);
            json!({"work_id":work,"assignment":assignment,"context":context,"claim":claim,"effects":effects,"wait":wait})
        }
        pub(super) async fn deny_restored(&self,host:&Arc<Host>,c:&Candidate,source:&Value)->Value {
            assert!(self.driver.is_none());let parked=&source["sdk_parked"];
            let assignment:Envelope=serde_json::from_value(parked["assignment"].clone()).unwrap();
            let before=snapshot(host,c);let callbacks_before=self.http.observation_count();let receipts=pi_effect_rows(host);let claims=claim_count(host);let inference=self.model.requests();
            let mut guard=super::request(host,c,&assignment.command_id,parked["work_id"].as_str().unwrap(),"inference.inspect",json!({}),"a19-sdk-restored-old-authority");
            guard.envelope.authority_epoch=2;
            let denied=host.lifetime_pi_action(&guard,lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(denied["result"]["error_code"],"execution_context_fenced");
            let mut pi=host::lifetime_runtime::PiProcess::start(&self.entry,&host.root.join("durable"),&host.root,"broker",&host.pi_callback_token,2,host.pi_local_route.as_ref()).await.unwrap();
            // Cached successful admission is historical evidence, never a new
            // generation grant. Reconcile explicitly attempts the parked run.
            let admission=pi.request(&assignment).await.unwrap();
            let mut resume=env("a19-sdk-epoch2-reconcile",json!({"method":"runtime.reconcile","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id}));resume.authority_epoch=2;
            let reconcile=pi.request(&resume).await.unwrap();
            let deadline=Instant::now()+Duration::from_secs(8);
            let actual_denial=loop {
                let callback=self.http.observations_since(callbacks_before).into_iter().find(|row| {
                    row["context_ref"]==parked["context"]["reference"] && row["authority_epoch"]==2
                        && row["status"]=="error" && row["error_code"]=="execution_context_fenced"
                });
                if let Some(callback)=callback{break callback;}
                if Instant::now()>=deadline {
                    private_diagnostic(&host.root,"restore-denial",&json!({"actual_callbacks":self.http.observations_since(callbacks_before).into_iter().collect::<Vec<_>>(),"reconcile_status":reconcile.status}));
                }
                assert!(Instant::now()<deadline,"actual SDK must freshly attempt old-context callback and receive epoch2 fencing");
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            pi.close().await.unwrap();
            assert_eq!(self.model.requests(),inference,"old SDK generation invoked inference");assert_eq!(pi_effect_rows(host),receipts);assert_eq!(claim_count(host),claims);assert_preserved(&before,&snapshot(host,c));
            assert_eq!(context_claim(host,&assignment.command_id),(parked["context"].clone(),parked["claim"].clone()));
            json!({"host_error_code":denied["result"]["error_code"],"historical_admission_status":admission.status,"reconcile_status":reconcile.status,"actual_sdk_denial":actual_denial,"inference_delta":0,"effect_delta":0,"claim_delta":0})
        }
    }
    #[cfg(feature = "documents")]
    pub(super) fn assert_preserved(before:&Value,after:&Value) {
        assert_eq!(before["canonical_conversation_id"],after["canonical_conversation_id"]);assert_eq!(before["privacy"],after["privacy"]);
        for original in before["contexts"].as_array().unwrap() {
            let restored=after["contexts"].as_array().unwrap().iter().find(|item|item["mapping"]["context_ref"]==original["mapping"]["context_ref"]).expect("original SDK context mapping disappeared");
            assert_eq!(original["mapping"],restored["mapping"]);
            for (table,rows) in original["checkpoints"].as_object().unwrap() {
                let current=restored["checkpoints"][table].as_array().unwrap();
                for row in rows.as_array().unwrap(){assert!(current.contains(row),"original immutable SDK {table} checkpoint was lost or rewritten");}
            }
            assert_eq!(original["task_ids"],restored["task_ids"],"old context acquired a new SDK task/generation");
        }
    }
    #[cfg(feature = "documents")]
    fn claim_count(host:&Host)->u64 {host.lock().unwrap().journal.0.query_row("SELECT COUNT(*) FROM workspace_objects WHERE kind='ghost_work_context_claim_v1'",[],|r|r.get(0)).unwrap()}
    #[cfg(feature = "documents")]
    fn index_path(host:&Host,ghost:&str)->PathBuf {host.root.join("durable").join(format!("{:x}",Sha256::digest(ghost.as_bytes()))).join("runtime.sqlite")}
    #[cfg(feature = "documents")]
    pub(super) fn snapshot(host:&Host,c:&Candidate)->Value {
        let db=Connection::open_with_flags(index_path(host,&c.definition.ghost_id),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut q=db.prepare("SELECT assignment_id,context_ref,canonical_conversation_id,binding_json,binding_digest,storage_ref,pi_id,provider_session_id,callback_scope FROM ghost_work_contexts ORDER BY assignment_id").unwrap();
        let mappings=q.query_map([],|r|Ok(json!({"assignment_id":r.get::<_,String>(0)?,"context_ref":r.get::<_,String>(1)?,"canonical_conversation_id":r.get::<_,String>(2)?,"binding_json":r.get::<_,String>(3)?,"binding_digest":r.get::<_,String>(4)?,"storage_ref":r.get::<_,String>(5)?,"pi_id":r.get::<_,u64>(6)?,"provider_session_id":r.get::<_,String>(7)?,"callback_scope":r.get::<_,String>(8)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        let mut checkpoints=vec![];
        for mapping in mappings {
            let path=host.root.join("durable").join(mapping["storage_ref"].as_str().unwrap());
            let db=Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();let mut tables=serde_json::Map::new();
            // These are immutable committed SDK checkpoints. Mutable task/run
            // status indexes may separately record the denied recovery attempt.
            for (table,sql) in [("identity","SELECT json_array(key,value) FROM ghost_runtime_identity ORDER BY key"),("entries","SELECT json_array(id,conversation_id,head,commit_seq,record) FROM entries ORDER BY id"),("documents","SELECT json_array(id,kind,family,key_value,scope_kind,owner_id,created_at,retired_at,record) FROM documents ORDER BY id"),("document_revisions","SELECT json_array(document_id,seq,kind,version,content) FROM document_revisions ORDER BY document_id,seq")] {
                let mut q=db.prepare(sql).unwrap();let rows=q.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();tables.insert(table.into(),json!(rows));
            }
            assert!(!tables["entries"].as_array().unwrap().is_empty());
            let task_ids=db.prepare("SELECT id FROM tasks ORDER BY id").unwrap().query_map([],|r|r.get::<_,u64>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            checkpoints.push(json!({"mapping":mapping,"checkpoints":tables,"task_ids":task_ids}));
        }
        let privacy:String=db.query_row("SELECT privacy FROM ghost_conversations WHERE external_id=?1",[&c.conversation_id],|r|r.get(0)).unwrap();
        json!({"canonical_conversation_id":c.conversation_id,"privacy":privacy,"contexts":checkpoints})
    }

    #[cfg(feature = "documents")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_sdk_claimed_generation_outlives_readiness_cache_and_preserves_authority_fences() {
        // Deterministic reproduction: real production SDK obtains its original
        // claim, while the controlled provider holds its first response. No
        // native engine, physical tool, sleep-based TTL expiry or new effect.
        let mut f=memory_update_active().await;
        f.root.disable_cleanup(true);
        eprintln!("A19 readiness expiry fixture root: {}",f.root.path().display());
        let model=ModelServer::start(f.root.path());
        configure_local(Arc::get_mut(&mut f.host).unwrap(),&model,&[(&f.c.definition.ghost_id,&f.c.conversation_id)]);
        model.publication_allowed.store(false,Ordering::Release);
        let admitted=owner(&f.host,"sdk-readiness-expiry-goal",json!({"method":"goal.submit","ghost_id":f.c.definition.ghost_id,"conversation_id":f.c.conversation_id,"prompt":format!("{SIMPLE} A19_SDK_CLAIM_HOLD"),"privacy":"private","acceptance_spec":lifetime::pi_execution::tests::verifier_spec(ANSWER)}),None);
        let work=admitted["work"]["id"].as_str().unwrap();
        let pending=owner(&f.host,"sdk-readiness-unclaimed-goal",json!({"method":"goal.submit","ghost_id":f.c.definition.ghost_id,"conversation_id":f.c.conversation_id,"prompt":"A separate unclaimed Work still needs fresh admission readiness","privacy":"private","acceptance_spec":{}}),None);
        let unclaimed:Work=serde_json::from_value(pending["work"].clone()).unwrap();
        let raw:String=f.host.lock().unwrap().journal.0.query_row("SELECT payload FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[work],|r|r.get(0)).unwrap();
        let assignment:Envelope=serde_json::from_str(&raw).unwrap();
        let entry=production_entry(f.root.path());
        let http=pi_test_http::Server::start(Arc::clone(&f.host),"a".repeat(64));
        let effects_before=pi_effect_rows(&f.host);
        let mut pi=host::lifetime_runtime::PiProcess::start(&entry,&f.host.root.join("durable"),&f.host.root,"broker",&f.host.pi_callback_token,1,f.host.pi_local_route.as_ref()).await.unwrap();
        let response=pi.request(&assignment).await.unwrap();assert_eq!(response.status,ResponseStatus::Success);
        let outbox:i64=f.host.lock().unwrap().journal.0.query_row("SELECT id FROM lifetime_outbox WHERE delivery_ref=?1",[&assignment.command_id],|r|r.get(0)).unwrap();
        lifetime::ack_outbox(&f.host.lock().unwrap().journal.0,outbox,&serde_json::to_value(&response).unwrap()).unwrap();
        let deadline=Instant::now()+Duration::from_secs(10);
        while model.requests()!=1 {assert!(Instant::now()<deadline,"SDK must reach its held first controlled request");tokio::time::sleep(Duration::from_millis(10)).await;}
        let original=context_claim(&f.host,&assignment.command_id);
        assert!(original.1["generation_task_id"].as_u64().unwrap()>0);
        let probe=super::request(&f.host,&f.c,&assignment.command_id,work,"inference.inspect",json!({}),"sdk-readiness-scope-probe");
        {
            let state=f.host.lock().unwrap();let conn=&state.journal.0;
            assert!(lifetime::work_context::validate(conn,&probe).unwrap().is_some(),"fresh readiness must admit the exact original claim");
            let raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='bot_memory_readiness_v1' AND id=?1",[&f.c.id],|r|r.get(0)).unwrap();
            let mut receipt:Value=serde_json::from_str(&raw).unwrap();receipt["checked_ms"]=json!(host::now_ms().saturating_sub(30_001));
            conn.execute("UPDATE workspace_objects SET payload=?1 WHERE kind='bot_memory_readiness_v1' AND id=?2",params![receipt.to_string(),f.c.id]).unwrap();
            assert!(!host::bots_memory::definition_current(conn,&f.c.definition).unwrap(),"expired readiness remains insufficient for new admission");
            assert!(host::bots_memory::definition_authority_current(conn,&f.c.definition).unwrap());
            assert!(lifetime::work_context::validate(conn,&probe).unwrap().is_some(),"the exact current claimed generation outlives its activation cache");
            assert!(!host::bot_lifecycle::work_may_start(conn,&unclaimed).unwrap(),"an expired unclaimed Work gains no authority from another claim");
            let actual:Work=serde_json::from_str(&conn.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[work],|r|r.get::<_,String>(0)).unwrap()).unwrap();
            assert_eq!(actual.state,"queued");assert!(actual.execution_id.is_none());
            assert_eq!(actual.owner_revision,1);assert_eq!(actual.cancellation,"none");
            assert!(lifetime::work_context::has_current_claim(conn,&actual).unwrap());
            let lifecycle:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='bot_lifecycle_v1' AND id=?1",[&actual.owner],|r|r.get(0)).optional().unwrap();
            for mode in ["paused","retired"] {
                conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES('bot_lifecycle_v1',?1,?2) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![actual.owner,json!({"ghost_id":actual.owner,"revision":1,"mode":mode}).to_string()]).unwrap();
                assert!(host::bot_lifecycle::work_may_start(conn,&actual).unwrap(),"a current bound SDK generation retains continuation semantics when {mode}");
                assert!(lifetime::work_context::validate(conn,&probe).unwrap().is_some());
                assert!(!host::bot_lifecycle::work_may_start(conn,&unclaimed).unwrap(),"{mode} never admits the unclaimed Work");
            }
            if let Some(raw)=lifecycle {conn.execute("UPDATE workspace_objects SET payload=?1 WHERE kind='bot_lifecycle_v1' AND id=?2",params![raw,actual.owner]).unwrap();}
            else {conn.execute("DELETE FROM workspace_objects WHERE kind='bot_lifecycle_v1' AND id=?1",[&actual.owner]).unwrap();}
            // A restore epoch never inherits this exemption from old claim rows.
            conn.execute("UPDATE lifetime_authority SET authority_epoch=2 WHERE singleton=1",[]).unwrap();
            assert!(!lifetime::work_context::has_current_claim(conn,&actual).unwrap());
            assert!(!host::bot_lifecycle::work_may_start(conn,&actual).unwrap());
            assert_eq!(lifetime::work_context::validate(conn,&probe).unwrap_err().to_string(),"Pi context epoch is no longer current");
            conn.execute("UPDATE lifetime_authority SET authority_epoch=1 WHERE singleton=1",[]).unwrap();
            // Configuration/policy checks still gate the already claimed Work.
            // The Host state lock keeps these deterministic fixture mutations
            // invisible to concurrent callbacks until the final revocation.
            let token=std::env::var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE").unwrap();
            std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE","changed-expiry-fixture-token");
            assert!(!host::bots_memory::definition_authority_current(conn,&f.c.definition).unwrap());
            assert!(!host::bot_lifecycle::work_may_start(conn,&actual).unwrap());
            std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE",token);
            assert!(host::bot_lifecycle::work_may_start(conn,&actual).unwrap());
            let raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='policy' AND id=?1",[&actual.owner],|r|r.get(0)).unwrap();
            let mut policy:Value=serde_json::from_str(&raw).unwrap();policy["memory"]=json!(false);
            conn.execute("UPDATE workspace_objects SET payload=?1 WHERE kind='policy' AND id=?2",params![policy.to_string(),actual.owner]).unwrap();
            assert!(!host::bot_lifecycle::work_may_start(conn,&actual).unwrap());
            assert!(lifetime::work_context::validate(conn,&probe).is_err(),"revocation still blocks the same original generation");
        }
        assert_eq!(context_claim(&f.host,&assignment.command_id),original);
        assert_eq!(pi_effect_rows(&f.host),effects_before);
        model.publication_allowed.store(true,Ordering::Release);
        // Drain the intentionally held provider response and its SDK failure
        // projection before closing the process that owns the HTTP request.
        let deadline=Instant::now()+Duration::from_secs(5);
        loop {
            let index=Connection::open_with_flags(index_path(&f.host,&f.c.definition.ghost_id),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let settled:bool=index.query_row("SELECT status IN ('failed','effect_unknown','cancelled') FROM ghost_canonical_turn_runs WHERE turn_id=?1",[&assignment.command_id],|r|r.get(0)).unwrap_or(false);
            if model.delivered.load(Ordering::Acquire)==1 && settled {break;}
            assert!(Instant::now()<deadline,"held provider response and SDK rejection must settle before owned Pi close");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        pi.close().await.unwrap();
        assert_eq!(pi_effect_rows(&f.host),effects_before);
        model.clean();assert!(http.errors().is_empty());
        f.host.shutdown().await.unwrap();drop(http);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_sdk_http_existing_driver_claims_and_completes_exact_work() {
        let mut f = host_fixture();
        let retained = f.root.keep();
        fs::set_permissions(&retained, fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!(
            "A19 actual SDK original fixture root: {}",
            retained.display()
        );
        let _environment = isolated_environment(&retained, &f.ghost).await;
        let model = ModelServer::start(&retained);
        configure_local(&mut f.host, &model, &[(&f.ghost, &f.conversation)]);
        let response=f.host.lifetime_action(&env("a19-sdk-simple-goal",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":SIMPLE,"privacy":"public","acceptance_spec":lifetime::pi_execution::tests::verifier_spec(ANSWER)}))).unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        let work = response["result"]["data"]["work"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[&work],|r|r.get(0)).unwrap();
        let entry = production_entry(&retained);
        let host = Arc::new(f.host);
        let http = pi_test_http::Server::start(Arc::clone(&host), "a".repeat(64));
        let driver = Driver::start(&host, entry);
        until(&host, &model, &http, "simple-completion", |conn| {
            accepted(conn, &work)
        })
        .await;
        let (context, claim) = context_claim(&host, &assignment);
        assert_eq!(context["assignment_id"], assignment);
        assert_eq!(context["ghost_id"], f.ghost);
        assert_eq!(context["conversation_id"], f.conversation);
        assert_eq!(context["authority_epoch"], 1);
        assert_eq!(context["work_id"], work);
        assert!(claim["generation_task_id"].as_u64().unwrap() > 0);
        uuid::Uuid::parse_str(claim["provider_session_id"].as_str().unwrap()).unwrap();
        assert!(claim["storage_ref"]
            .as_str()
            .unwrap()
            .contains("/work-contexts/"));
        assert_eq!(effects(&host, &work).len(), 2);
        assert!(model.requests() >= 3);
        model.clean();
        model.owner_tools_absent();
        assert!(http.errors().is_empty());
        driver.close(&host).await;
        public_privacy_preserved(&host, &f.ghost, &f.conversation);
        assert_eq!(context_claim(&host, &assignment), (context, claim));
        drop(http);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_sdk_same_epoch_wait_resumes_original_generation_through_existing_driver() {
        delegation_and_report(None, false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "bundled Bun executable and physical Apple container required"]
    async fn bundled_bun_stock_tools_delegate_and_report() {
        let binary = PathBuf::from(std::env::var_os("GHOST_TEST_BUNDLED_PI").expect("explicit bundled Pi path"));
        delegation_and_report(Some(binary.canonicalize().unwrap()), false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires an exported Orchestra skill and an explicit bundled Pi binary"]
    async fn bundled_bun_applies_exported_orchestra_skill_in_scoped_work() {
        let binary = PathBuf::from(std::env::var_os("GHOST_TEST_BUNDLED_PI").expect("explicit bundled Pi path"));
        let exported = PathBuf::from(std::env::var_os("GHOST_TEST_ORCHESTRA_SKILL").expect("explicit exported skill path"));
        let skill = fs::read_to_string(exported).unwrap();
        assert!(skill.contains("privacy: local_only") && skill.contains("## Source: `references/shared-defaults.md`"));
        let digest = format!("{:x}", Sha256::digest(skill.as_bytes()));
        let mut f = host_fixture();
        f.host.native_computers.as_mut().unwrap().pi_fixture_allow_private(&f.ghost).unwrap();
        let _environment = isolated_environment(f.root.path(), &f.ghost).await;
        let model = ModelServer::start(f.root.path());
        configure_local(&mut f.host, &model, &[(&f.ghost, &f.conversation)]);
        {
            let state = f.host.lock().unwrap();
            let installed = host::skills::save(
                &state, &f.host.root, "orchestra-canary-install", &f.ghost, "agent-orchestra", &skill, None,
            ).unwrap();
            assert_eq!(installed["skill"]["digest"], digest);
            assert_eq!(installed["skill"]["privacy"], "local_only");
        }
        let admitted = owner(&f.host, "orchestra-canary-work", json!({
            "method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,
            "prompt":format!("{SIMPLE} {ORCHESTRA}"),
            "privacy":"local_only","acceptance_spec":lifetime::pi_execution::tests::verifier_spec(ANSWER),
        }), None);
        let work = admitted["work"]["id"].as_str().unwrap();
        {
            let state = f.host.lock().unwrap();
            let replacement = format!("{skill}\nThis new revision applies to future Work.\n");
            let saved = host::skills::save(
                &state, &f.host.root, "orchestra-canary-replace", &f.ghost, "agent-orchestra", &replacement, Some(1),
            ).unwrap();
            assert_eq!(saved["skill"]["revision"], 2);
        }
        let host = Arc::new(f.host);
        let http = pi_test_http::Server::start(Arc::clone(&host), "a".repeat(64));
        let driver = Driver::start_bundled(&host, binary.canonicalize().unwrap());
        until(&host, &model, &http, "orchestra-skill-accepted", |conn| accepted(conn, work)).await;
        {
            let requests = model.requests.lock().unwrap();
            let prompts = requests.iter().flat_map(|request| request["messages"].as_array().unwrap())
                .filter(|message| matches!(message["role"].as_str(), Some("system" | "developer")))
                .filter_map(|message| message["content"].as_str());
            let delivered = prompts.flat_map(str::lines)
                .filter_map(|line| serde_json::from_str::<Vec<Value>>(line).ok())
                .flatten()
                .find(|value| value["name"] == "agent-orchestra").expect("exact installed skill did not reach Pi");
            assert_eq!(delivered["content"], skill);
            assert_eq!(delivered["sha256"], digest);
            assert_eq!(delivered["privacy"], "local_only");
        }
        assert_eq!(effects(&host, work).len(), 3, "write, reread and publish");
        model.clean();
        model.owner_tools_absent();
        assert!(http.errors().is_empty());
        driver.close(&host).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_sdk_owner_chat_opens_work_thread_and_follow_up_reports_back() {
        let mut f = host_fixture();
        let _environment = isolated_environment(f.root.path(), &f.ghost).await;
        let model = ModelServer::start(f.root.path());
        configure_local(&mut f.host, &model, &[(&f.ghost, &f.conversation)]);
        let host = Arc::new(f.host);
        let entry = production_entry(f.root.path());
        let http = pi_test_http::Server::start(Arc::clone(&host), "a".repeat(64));

        let thread_input = format!("{THREAD_OWNER} 결과 파일을 만들고 검수 결과를 알려줘.");
        owner(&host, "work-thread-owner", json!({
            "method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,
            "text":thread_input,"privacy":"public","attachments":[],
        }), None);
        let (outbox_id, raw): (i64, String) = host.lock().unwrap().journal.0.query_row(
            "SELECT id,payload FROM lifetime_outbox WHERE command_id='work-thread-owner' AND target='pi'",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        let submitted: Envelope = serde_json::from_str(&raw).unwrap();
        let mut pi = host::lifetime_runtime::PiProcess::start(
            &entry, &host.root.join("durable"), &host.root, "broker",
            &host.pi_callback_token, 1, host.pi_local_route.as_ref(),
        ).await.unwrap();
        let ack = pi.request(&submitted).await.unwrap();
        assert_eq!(ack.status, ResponseStatus::Success, "{ack:?}");
        lifetime::ack_outbox(
            &host.lock().unwrap().journal.0, outbox_id, &serde_json::to_value(&ack).unwrap(),
        ).unwrap();
        until(&host, &model, &http, "thread-origin-answered", |conn| conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_turns WHERE source_turn_id='work-thread-owner' AND text='작업을 시작했습니다.')",
            [], |r| r.get(0),
        ).unwrap()).await;
        pi.close().await.unwrap();
        let goal: String = host.lock().unwrap().journal.0.query_row(
            "SELECT goal_id FROM lifetime_turn_goals WHERE turn_id='work-thread-owner'",
            [], |r| r.get(0),
        ).unwrap();
        let chat = json!({"method":"conversation.inspect","ghost_id":f.ghost,"conversation_id":f.conversation});
        // Browsing does not require a new command receipt and does not
        // change the source turn when another Goal revision is committed.
        let opened = owner(&host, "work-thread-chat-first", chat.clone(), None);
        assert_eq!(opened["turns"][0]["work_thread_ids"], json!([goal]));
        let inspect = json!({"method":"goal.thread.inspect","goal_id":goal});
        let initial = owner(&host, "work-thread-live-view", inspect.clone(), None);
        assert_eq!(initial["origin"]["text"], thread_input);
        assert_eq!(initial["graph"]["work"][0]["state"], "queued");
        assert_eq!(initial["follow_ups"], json!([]));

        let mut update = env("work-thread-follow-up", json!({
            "method":"goal.update","goal_id":goal,
            "prompt":format!("{SIMPLE}\n\nOwner follow-up:\n{THREAD_FOLLOW_UP}"),
            "acceptance_spec":initial["goal"]["acceptance_spec"],"follow_up":THREAD_FOLLOW_UP,
        }));
        update.expected_revision = Some(1);
        let mut bad = update.clone();
        bad.command_id = "work-thread-invalid-follow-up".into();
        bad.body["prompt"] = json!("silently replace the prior instructions");
        bad.payload_digest = crate::lifetime_contract::canonical_digest(&bad.body).unwrap();
        assert_eq!(host.lifetime_action(&bad).unwrap()["result"]["error_code"], "invalid_request");
        let revised = host.lifetime_action(&update).unwrap();
        assert_eq!(revised["result"]["status"], "success", "{revised}");
        assert_eq!(revised["result"]["data"]["retained_owner_expectations"], false);
        assert_eq!(host.lifetime_action(&update).unwrap(), revised);
        let mut stale = update.clone();
        stale.command_id = "work-thread-stale-follow-up".into();
        assert_eq!(host.lifetime_action(&stale).unwrap()["result"]["error_code"], "conflict");

        let driver = Driver::start(&host, entry);
        until(&host, &model, &http, "thread-revision-report", |conn| conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_report_replies r
             JOIN lifetime_outbox o ON o.id=r.outbox_id JOIN lifetime_turns t ON t.id=r.reply_turn_id
             WHERE t.ghost_id=?1 AND t.conversation_id=?2
               AND json_extract(o.payload,'$.body.goal_id')=?3
               AND json_extract(o.payload,'$.body.goal_revision')=2
               AND t.text='작업 결과를 게시했습니다. 검수가 필요합니다.')",
            rusqlite::params![f.ghost, f.conversation, goal],
            |r| r.get(0),
        ).unwrap()).await;
        let thread = owner(&host, "work-thread-live-view", inspect, None);
        assert_eq!(thread["goal"]["revision"], 2);
        assert_eq!(thread["follow_ups"], json!([{
            "id":"work-thread-follow-up","text":THREAD_FOLLOW_UP,"revision":2
        }]));
        assert_eq!(thread["reports"].as_array().unwrap().len(), 1);
        assert_eq!(thread["reports"][0]["revision"], 2);
        assert_eq!(thread["graph"]["work"][0]["state"], "completed");
        assert_eq!(host.lock().unwrap().journal.0.query_row(
            "SELECT count(*) FROM lifetime_acceptances", [], |r| r.get::<_, u64>(0)
        ).unwrap(), 0, "an Owner follow-up must not approve model-authored verification");
        let returned = owner(&host, "work-thread-chat-final", chat, None);
        let final_turn = returned["turns"].as_array().unwrap().iter()
            .find(|turn| turn["id"] == thread["reports"][0]["id"]).unwrap();
        assert_eq!(final_turn["work_thread_ids"], json!([goal]));
        assert_eq!(final_turn["text"], thread["reports"][0]["text"]);
        assert_eq!(host.lock().unwrap().journal.0.query_row(
            "SELECT count(*) FROM lifetime_commands WHERE command_id='work-thread-live-view'", [],
            |row| row.get::<_, u64>(0),
        ).unwrap(), 0);
        owner(&host, "work-thread-private-chat", json!({
            "method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,
            "text":"Raise the conversation's disclosure floor.","privacy":"private","attachments":[],
        }), None);
        let restricted = owner(&host, "work-thread-live-view", json!({"method":"goal.thread.inspect","goal_id":goal}), None);
        assert_eq!(restricted["follow_up_blocker"], "disclosure_changed");
        let mut private_follow_up = env("work-thread-private-follow-up", json!({
            "method":"goal.update","goal_id":goal,
            "prompt":format!("{}\n\nOwner follow-up:\nPrivate note", thread["goal"]["prompt"].as_str().unwrap()),
            "acceptance_spec":thread["goal"]["acceptance_spec"],"follow_up":"Private note",
        }));
        private_follow_up.expected_revision = Some(2);
        assert_eq!(host.lifetime_action(&private_follow_up).unwrap()["result"]["error_code"], "follow_up_unavailable");
        assert!(model.requests.lock().unwrap().iter().any(|request| {
            request["messages"].to_string().contains(THREAD_FOLLOW_UP)
        }), "the revised assignment must carry the follow-up into Pi");
        model.clean();
        assert!(http.errors().is_empty());
        driver.close(&host).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_sdk_follow_up_replaces_parked_work_and_its_current_delegation() {
        delegation_and_report(None, true).await;
    }

    async fn delegation_and_report(bundled: Option<PathBuf>, revise_parked_work: bool) {
        let mut f = host_fixture();
        if bundled.is_some() {
            f.host.native_computers.as_mut().unwrap().set_pi_fixture_cli(Path::new("/opt/homebrew/bin/container")).unwrap();
        }
        let retained = f.root.keep();
        fs::set_permissions(&retained, fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!(
            "A19 actual SDK original fixture root: {}",
            retained.display()
        );
        let _environment = isolated_environment(&retained, &f.ghost).await;
        let child_profile = Host::profile(
            ProfileStore::create_profile(&retained, "a19-sdk-child", "controlled child").unwrap(),
        )
        .unwrap();
        let child = child_profile.id.clone();
        let child_conversation = uuid::Uuid::new_v4().to_string();
        f.host
            .lock()
            .unwrap()
            .profiles
            .insert(child.clone(), child_profile);
        let registered=f.host.lifetime_action(&env("a19-sdk-register-child",json!({"method":"registry.ensure","ghost_id":child,"conversation_id":child_conversation,"kind":"specialist","roles":[]}))).unwrap();
        assert_eq!(registered["result"]["status"], "success");
        {
            let s = f.host.lock().unwrap();
            f.host
                .native_computers
                .as_ref()
                .unwrap()
                .provision_pi_ghost(&s.journal.0, &f.ghost, &child, 1, "pi-default/1")
                .unwrap();
        }
        let model = ModelServer::start(&retained);
        configure_local(
            &mut f.host,
            &model,
            &[(&f.ghost, &f.conversation), (&child, &child_conversation)],
        );
        let mut spec = lifetime::pi_execution::tests::verifier_spec(ANSWER);
        let parent_prompt = if bundled.is_some() { format!("{PARENT} {STOCK}") } else { PARENT.into() };
        let child_prompt = if bundled.is_some() { format!("{CHILD} {STOCK}") } else { CHILD.into() };
        spec["delegation_contracts"] = json!([{"target_ghost_id":child,"prompt":child_prompt,"acceptance_spec":lifetime::pi_execution::tests::verifier_spec("child-ready"),"artifact_refs":[]}]);
        let response=f.host.lifetime_action(&env("a19-sdk-parent-goal",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":parent_prompt,"privacy":"public","acceptance_spec":spec}))).unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        let goal = &response["result"]["data"]["goal"];
        let work = response["result"]["data"]["work"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let revision = owner(&f.host, "a19-sdk-parent-follow-up", json!({
            "method":"goal.update","goal_id":goal["id"],
            "prompt":format!("{parent_prompt}\n\nOwner follow-up:\n{THREAD_FOLLOW_UP}"),
            "acceptance_spec":spec,"follow_up":THREAD_FOLLOW_UP,
        }), Some(1));
        assert_eq!(revision["retained_owner_expectations"], true);
        let (outbox, assignment) = {
            let s = f.host.lock().unwrap();
            s.journal.0.query_row("SELECT id,payload FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.goal_revision')=2",[&work],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).unwrap()
        };
        let assignment: Envelope = serde_json::from_str(&assignment).unwrap();
        let entry = production_entry(&retained);
        let host = Arc::new(f.host);
        let http = pi_test_http::Server::start(Arc::clone(&host), "a".repeat(64));
        // Only the parent is delivered before close. Its real delegated child
        // remains in the ordinary outbox; no synthetic wait state is supplied.
        let launcher = bundled.as_ref().map(|path| PiLauncher::Bundled(path.clone())).unwrap_or_else(|| PiLauncher::NodeEntry(entry.clone()));
        let mut pi = host::lifetime_runtime::PiProcess::launch(
            &launcher,
            &host.root.join("durable"),
            &host.root,
            "broker",
            &host.pi_callback_token,
            1,
            host.pi_local_route.as_ref(),
        )
        .await
        .unwrap();
        let ack = pi.request(&assignment).await.unwrap();
        assert_eq!(ack.status, ResponseStatus::Success, "{ack:?}");
        lifetime::ack_outbox(
            &host.lock().unwrap().journal.0,
            outbox,
            &serde_json::to_value(&ack).unwrap(),
        )
        .unwrap();
        until(&host,&model,&http,"original-wait",|conn|conn.query_row("SELECT state='blocked' AND json_extract(payload,'$.blocker') LIKE 'wait_for:%' FROM lifetime_work WHERE id=?1",[&work],|r|r.get(0)).unwrap_or(false)).await;
        let thread = owner(&host, "a19-sdk-thread-progress",
            json!({"method":"goal.thread.inspect","goal_id":response["result"]["data"]["goal"]["id"]}), None);
        assert_eq!(thread["graph"]["work_id"], work);
        let links = thread["graph"]["links"].as_array().unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0]["parent_work_id"], work);
        assert_eq!(links[0]["current"], true);
        assert!(thread["graph"]["work"].as_array().unwrap().iter().any(|item| {
            item["id"] == links[0]["child_work_id"] && item["owner"] == child
        }));
        let original = context_claim(&host, &assignment.command_id);
        assert_eq!(original.0["assignment_id"], assignment.command_id);
        assert_eq!(original.0["work_id"], work);
        assert_eq!(original.0["ghost_id"], f.ghost);
        assert_eq!(original.0["conversation_id"], f.conversation);
        assert_eq!(original.0["authority_epoch"], 1);
        let before = effects(&host, &work);
        assert_eq!(before.len(), 1);
        let wait = {
            let s = host.lock().unwrap();
            row(&s.journal.0, "pi_work_wait_active", &work)
        };
        pi.close().await.unwrap();
        let count = model.requests();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(model.requests(), count);
        if revise_parked_work {
            let instruction = "Publish the verified artifact and include the reasoning in the report.";
            let body = json!({
                "method":"goal.update","goal_id":goal["id"],
                "prompt":format!("{}\n\nOwner follow-up:\n{instruction}", revision["goal"]["prompt"].as_str().unwrap()),
                "acceptance_spec":spec,"follow_up":instruction,
            });
            // Simulate the durable reservation made just before a tool runs.
            // An edit during this interval must leave revision 2 authorized.
            {
                let state = host.lock().unwrap();
                state.journal.0.execute(
                    "INSERT INTO lifetime_pi_effects(execution_id,task_id,call_id,input_digest,operation,arguments_json,state)
                     SELECT execution_id,task_id,'thread-test-pending',input_digest,operation,arguments_json,'pending'
                     FROM lifetime_pi_effects WHERE execution_id=(SELECT execution_id FROM lifetime_work WHERE id=?1) LIMIT 1",
                    [&work],
                ).unwrap();
            }
            let mut blocked = env("a19-sdk-follow-up-during-effect", body.clone());
            blocked.expected_revision = Some(2);
            let result = host.lifetime_action(&blocked).unwrap();
            assert_eq!(result["result"]["error_code"], "follow_up_unavailable");
            assert_eq!(result["result"]["summary"], "effect_unsettled");
            {
                let state = host.lock().unwrap();
                state.journal.0.execute(
                    "DELETE FROM lifetime_pi_effects WHERE call_id='thread-test-pending'", [],
                ).unwrap();
            }
            let revised = owner(&host, "a19-sdk-parked-follow-up", body, Some(2));
            let replacement = revised["work"].as_array().unwrap().iter()
                .find(|item| item["goal_revision"] == 3).unwrap()["id"].as_str().unwrap();
            assert_ne!(replacement, work);
            let driver = Driver::start(&host, entry);
            until(&host, &model, &http, "thread-parked-replacement", |conn| accepted(conn, replacement)).await;
            let updated = owner(&host, "a19-sdk-thread-progress-after-follow-up",
                json!({"method":"goal.thread.inspect","goal_id":goal["id"]}), None);
            assert_eq!(updated["graph"]["work_id"], replacement);
            assert!(updated["graph"]["work"].as_array().unwrap().iter().any(|item| {
                item["id"] == work && item["cancellation"] == "confirmed"
            }));
            assert!(updated["graph"]["links"].as_array().unwrap().iter().any(|link| {
                link["parent_work_id"] == work && link["current"] == false
            }));
            assert!(updated["graph"]["links"].as_array().unwrap().iter().any(|link| {
                link["parent_work_id"] == replacement && link["current"] == true
            }));
            model.clean();
            assert!(http.errors().is_empty());
            driver.close(&host).await;
            return;
        }
        let driver = match &bundled {
            Some(path) => Driver::start_bundled(&host, path.clone()),
            None => Driver::start(&host, entry),
        };
        until(&host, &model, &http, "same-epoch-resume", |conn| {
            accepted(conn, &work)
        })
        .await;
        assert_eq!(context_claim(&host, &assignment.command_id), original);
        assert_eq!(&effects(&host, &work)[..1], before.as_slice());
        assert_eq!(effects(&host, &work).len(), if bundled.is_some() { 4 } else { 3 });
        if bundled.is_some() {
            until(&host, &model, &http, "primary-final-report", |conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM lifetime_report_replies r
                     JOIN lifetime_outbox o ON o.id=r.outbox_id JOIN lifetime_turns t ON t.id=r.reply_turn_id
                     WHERE t.ghost_id=?1 AND t.conversation_id=?2
                     AND json_extract(o.payload,'$.body.prompt') LIKE ?3
                     AND t.text LIKE 'Host 검수를 통과했습니다.%')",
                    rusqlite::params![f.ghost, f.conversation, format!("Authenticated Host verification: work_id={work} %")],
                    |r| r.get(0),
                ).unwrap_or(false)
            }).await;
            let s = host.lock().unwrap();
            let operations: Vec<(String, String)> = s.journal.0.prepare(
                "SELECT operation,arguments_json FROM lifetime_pi_effects
                 WHERE execution_id=(SELECT execution_id FROM lifetime_pi_executions WHERE ghost_id=?1)
                 ORDER BY task_id,call_id",
            ).unwrap().query_map([&child], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
            for tool in ["read", "write", "edit", "bash", "publish_artifact"] {
                assert!(operations.iter().any(|(operation, _)| operation == tool), "child did not run {tool}");
            }
            assert!(operations.iter().any(|(operation, args)| operation == "read" && args.contains("text_snapshot")));
            assert!(operations.iter().any(|(operation, args)| operation == "edit" && args.contains("source_sha256")));
        }
        {
            let s = host.lock().unwrap();
            assert_eq!(row(&s.journal.0, "pi_work_wait_active", &work), wait);
            assert_eq!(
                s.journal
                    .0
                    .query_row(
                        "SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_work_wait'",
                        [],
                        |r| r.get::<_, u64>(0)
                    )
                    .unwrap(),
                1
            );
            assert_eq!(
                s.journal
                    .0
                    .query_row("SELECT COUNT(*) FROM lifetime_acceptances", [], |r| r
                        .get::<_, u64>(0))
                    .unwrap(),
                2
            );
        }
        model.clean();
        model.owner_tools_absent();
        assert!(http.errors().is_empty());
        driver.close(&host).await;
        public_privacy_preserved(&host, &f.ghost, &f.conversation);
        public_privacy_preserved(&host, &child, &child_conversation);
        drop(http);
    }

    include!("bots_selected_task_recovery_tests.rs");

    #[test]
    fn controlled_provider_reads_only_the_actual_wrapped_assignment_descriptor() {
        let body = json!({"messages":[{"role":"system","content":"<ghost-controller>\nCurrent authenticated Goal assignment: {\"assignment_id\":\"original-assignment\",\"work_id\":\"actual-work\"}\n</ghost-controller>"},{"role":"user","content":PARENT}]});
        let reply = model_message(&body).unwrap();
        assert_eq!(reply["tool_calls"][0]["function"]["name"], "work_inspect");
        assert_eq!(
            serde_json::from_str::<Value>(
                reply["tool_calls"][0]["function"]["arguments"]
                    .as_str()
                    .unwrap()
            )
            .unwrap()["work_id"],
            "actual-work"
        );
        let mut changed = body;
        changed["messages"][0]["content"]=json!("Current authenticated Goal assignment: {\"assignment_id\":\"original-assignment\",\"work_id\":\"actual-work\"} unexpected payload");
        assert!(model_message(&changed).is_err());
    }
}
