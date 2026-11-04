// A04 uses only authenticated Owner inputs and the production Host/Pi paths.
// The Owner installs a generic template+input, never an expected-answer command
// or a fixed child UUID. No model run happens without explicit opt-in.
mod a04_producer_configuration { include!("a04_producer_configuration.rs"); }
mod a04_functional_observation { include!("a04_functional_observation.rs"); }
/// Transport budgets of the functional bridge. These bound runaway callback
/// and delivery loops; they are not model admission limits. The complete
/// six-role chain (seed, independent evaluation, two reuses, correction and
/// cold reopen) delivers several hundred commands and callbacks in one run,
/// so the budgets must carry the whole accepted scenario.
const A04_BRIDGE_COMMAND_BUDGET: u64 = 256;
// Registered external inference adds per-fence selection/authority reads and
// 64 KiB stream gates (~53 callbacks per model call; see PHASE_CALLBACKS
// derivation). Two cold phases at 80 calls need more than the local-route
// 1,200; 6,000 stays a hard bound with identical-repeat/watchdog protection.
const A04_BRIDGE_CALLBACK_BUDGET: u64 = 6_000;
include!("a04_functional_bridge_tests.rs");
struct ProductBridge {
    process: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    commands: u64,
    callbacks: u64,
    metrics: Value,
    delegations: Vec<Value>,
    reads: Vec<Value>,
    denials: Vec<Value>,
    callback_failures: Vec<Value>,
    idle_results: Vec<Value>,
    idle_probe_generation: u64,
    functional_observer: Option<a04_functional_observation::Observer>,
}
impl ProductBridge {
    async fn frame(&mut self, host: &Host) -> Result<Value> {
        self.frame_with_observation_window(host, std::time::Duration::from_secs(130))
            .await
    }
    async fn frame_with_observation_window(
        &mut self,
        host: &Host,
        window: std::time::Duration,
    ) -> Result<Value> {
        loop {
            let event = self.event_with_observation_window(host, window).await?;
            if event["type"] == "callback_serviced" {
                continue;
            }
            if self.functional_observer.is_some() && event["type"] == "functional_io_checkpoint" {
                continue;
            }
            if self.functional_observer.is_some()
                && matches!(
                    event["type"].as_str(),
                    Some(
                        "observation_checkpoint" | "observer_rejected" | "callback_budget_blocked"
                    )
                )
            {
                self.functional_event(&event);
                continue;
            }
            if event["type"] == "idle_result" {
                self.idle_results.push(event);
                continue;
            }
            return Ok(event);
        }
    }
    async fn event(&mut self, host: &Host) -> Result<Value> {
        self.event_with_observation_window(host, std::time::Duration::from_secs(130))
            .await
    }
    async fn event_with_observation_window(
        &mut self,
        host: &Host,
        window: std::time::Duration,
    ) -> Result<Value> {
        let line = match tokio::time::timeout(window, self.output.next_line()).await {
            Err(_) if self.functional_observer.is_some() => {
                self.functional_attention("command_observation_window_elapsed");
                return Ok(json!({"type":"functional_io_checkpoint"}));
            }
            result => result??.ok_or_else(|| anyhow!("A04 bridge exited"))?,
        };
        self.event_line(host, line).await
    }
    async fn poll_event(&mut self, host:&Host)->Result<Option<Value>> {
        // Only the cancellation-safe line read is timed. Never drop an active
        // Host callback/effect future merely because an observer tick elapsed.
        match tokio::time::timeout(std::time::Duration::from_millis(100),self.output.next_line()).await {
            Err(_)=>Ok(None),
            Ok(line)=>Ok(Some(self.event_line(host,line?.ok_or_else(||anyhow!("A04 bridge exited"))?).await?)),
        }
    }
    async fn event_line(&mut self,host:&Host,line:String)->Result<Value> {
        use tokio::io::AsyncWriteExt;
            ensure!(line.len() <= 1_048_576, "A04 frame bound");
            let frame: Value = serde_json::from_str(&line)?;
            if frame["metrics"].is_object() {
                self.metrics = frame["metrics"].clone();
            }
            if frame["type"] != "callback" {
                ensure!(
                    frame["type"] != "failure",
                    "A04 runtime failed: {}",
                    frame["error_code"]
                );
                return Ok(frame);
            }
            self.callbacks += 1;
            if self.callbacks>a04_functional_observation::PHASE_CALLBACKS && self.functional_observer.is_some() {
                if let Some(observer)=self.functional_observer.as_mut() {
                    let safe=|value:&Value|value.as_str().filter(|s|s.len()<=400).map(str::to_owned);
                    let _=observer.pending("pending_callback",json!({"id":if frame["id"].is_u64() {frame["id"].clone()}else{json!(safe(&frame["id"]))},"command_id":safe(&frame["request"]["envelope"]["command_id"]),"method":safe(&frame["request"]["envelope"]["body"]["method"]),"request_digest":safe(&frame["request"]["envelope"]["payload_digest"]),"reason_code":"callback_budget_exhausted","new_host_dispatch_started":false,"callback_result_sent":false}));
                }
                self.functional_attention("callback_budget_exhausted");
                // No further Host request is authorized. Keep the exact SDK
                // callback/wait pending for explicit operator attention.
                return Ok(json!({"type":"callback_budget_blocked"}));
            }
            ensure!(self.callbacks <= a04_functional_observation::PHASE_CALLBACKS, "A04 phase callback bound");
            let request: lifetime::PiToolRequest =
                serde_json::from_value(frame["request"].clone())?;
            let body = &request.envelope.body;
            let method = body["method"].as_str().unwrap_or("unknown");
            let scope = lifetime::test_callback_inference_scope(&frame);
            let (response,failure)=product_callback_reply(host
                .lifetime_pi_action(&request, scope)
                .await,method,&request.envelope.command_id);
            if let Some(failure)=failure {self.callback_failures.push(failure);}
            if response["ok"] != true || response["result"]["status"] == "error" {
                self.denials.push(json!({"method":method,"code":response["result"]["error_code"],"work_id":body["work_id"]}));
            }
            if method == "work.delegate" && response["result"]["status"] == "success" {
                self.delegations.push(json!({"parent_work_id":body["parent_work_id"],"template_ref":body["template_ref"],"target_ghost_id":body["target_ghost_id"],"child_work_id":response["result"]["data"]["work"]["id"]}));
            }
            if method == "work.execute"
                && body["operation"] == "read"
                && response["result"]["status"] == "success"
            {
                self.reads.push(json!({"ghost_id":request.ghost_id,"work_id":body["work_id"],"path":body["arguments"]["path"],"sha256":response["result"]["data"]["output"]["sha256"]}));
            }
            a04_producer_configuration::capture_for_host(host)?;
            self.input
                .write_all(
                    format!(
                        "{}\n",
                        json!({"type":"callback_result","id":frame["id"],"frame":response})
                    )
                    .as_bytes(),
                )
                .await?;
            self.input.flush().await?;
            Ok(json!({"type":"callback_serviced"}))
    }
    async fn start(host: &Host) -> Result<Self> {
        Self::start_mode(host,false).await
    }
    async fn start_mode(host: &Host,functional:bool) -> Result<Self> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let mut process = tokio::process::Command::new("/opt/homebrew/bin/node")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("apps/ghost-durable/scripts/a20-live-canary.mjs"),
            )
            .env_clear()
            .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
            .env("HOME", &host.root)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let input = process.stdin.take().unwrap();
        let output = tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
        let mut bridge = Self {
            process,
            input,
            output,
            commands: 0,
            callbacks: 0,
            metrics: Value::Null,
            delegations: vec![],
            reads: vec![],
            denials: vec![],
            callback_failures: vec![],
            idle_results: vec![],
            idle_probe_generation: 0,
            functional_observer: if functional {Some(a04_functional_observation::Observer::open(&host.root)?)}else{None},
        };
        let mut config = json!({"type":"config","root":host.root.join("pi-product-store"),"host_root":host.root,"authority_epoch":1,"allow_work_parks":true,"ack_on_admission":true});
        if functional {config["observation_mode"]=json!(a04_functional_observation::MODE);}
        bridge
            .input
            .write_all(format!("{config}\n").as_bytes())
            .await?;
        bridge.input.flush().await?;
        let configured=bridge.frame(host).await?;
        ensure!(
            configured["type"] == "configured",
            "A04 configuration refused"
        );
        if functional {ensure!(configured["observation_mode"]==a04_functional_observation::MODE,"A04 functional observation mode was not negotiated");}
        Ok(bridge)
    }
    async fn command(&mut self, host: &Host, command: Value) -> Result<Value> {
        self.command_with_observation_window(host, command, std::time::Duration::from_secs(130))
            .await
    }
    async fn command_with_observation_window(
        &mut self,
        host: &Host,
        command: Value,
        window: std::time::Duration,
    ) -> Result<Value> {
        use tokio::io::AsyncWriteExt;
        if self.functional_observer.is_some()
            && (self.callbacks > A04_BRIDGE_CALLBACK_BUDGET || self.commands >= A04_BRIDGE_COMMAND_BUDGET)
        {
            self.functional_attention(if self.callbacks > A04_BRIDGE_CALLBACK_BUDGET {
                "callback_budget_exhausted"
            } else {
                "delivery_budget_exhausted"
            });
            if let Some(observer) = self.functional_observer.as_mut() {
                let _=observer.pending("pending_delivery",json!({"command_id":command["command_id"].as_str().filter(|s|s.len()<=400),"sent":false}));
            }
            // A fixed exhausted budget never resets. Retain ownership and the
            // existing receiver stream for explicit attention, without sending
            // a new command or manufacturing an ACK/effect receipt.
            loop {
                let _ = self.frame_with_observation_window(host, window).await?;
            }
        }
        self.commands += 1;
        ensure!(self.commands <= 64, "A04 phase delivery bound");
        if let Some(observer) = self.functional_observer.as_mut() {
            let _=observer.pending("pending_command",json!({"id":self.commands,"command_id":command["command_id"].as_str().filter(|s|s.len()<=400),"method":command["body"]["method"].as_str().filter(|s|s.len()<=400),"acknowledged":false}));
        }
        self.input
            .write_all(
                format!(
                    "{}\n",
                    json!({"type":"command","id":self.commands,"command":command})
                )
                .as_bytes(),
            )
            .await?;
        self.input.flush().await?;
        let failures_before = self.callback_failures.len();
        let result = self.frame_with_observation_window(host, window).await?;
        if let Some(failure) = self.callback_failures.get(failures_before) {
            anyhow::bail!("A04 Host callback {} ({}) returned no verified receipt; outcome remains unconfirmed; inspect retained original command/effect state",failure["method"],failure["command_id"]);
        }
        ensure!(
            result["type"] == "command_result" && result["receipt"]["status"] == "success",
            "A04 command refused: {result}"
        );
        if let Some(observer) = self.functional_observer.as_mut() {
            let _ = observer.pending("pending_command", Value::Null);
        }
        Ok(result)
    }
    async fn drain(&mut self, host: &Host, ghost: &str, conversation: &str) -> Result<()> {
        if self.functional_observer.is_some() {return self.drain_functional(host,ghost,conversation).await;}
        use tokio::io::AsyncWriteExt;
        let mut idle_probe:Option<String>=None;
        let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(120);
        for _ in 0..1200 {
            ensure!(tokio::time::Instant::now()<deadline,"A04 bounded concurrent dispatch did not settle; inspect original Work/turn receipts");
            // Same bounded existing Host driver steps. A failed producer keeps
            // its evidence and cannot be promoted by the fixture.
            if let Err(error) = host.advance_task_verifications().await {
                eprintln!("A04 verification blocker: {error}");
            }
            if let Some(blocker)=product_verification_blocker(host,ghost,conversation)? {
                anyhow::bail!("A04 independent verification reached a terminal blocker: {blocker}; output remains unaccepted, original evidence retained, no automatic model retry");
            }
            host.advance_bot_provisioning()?;
            a04_producer_configuration::capture_for_host(host)?;
            let next = {
                let state = host.lock()?;
                let items = lifetime::pending_outbox(&state.journal.0)?;
                let eligible = |item: &&lifetime::OutboxItem| {
                    if item.target != "pi" {
                        return false;
                    }
                    if item.payload["body"]["method"] == "conversation.assignment" {
                        return item.payload["body"]["work_id"].as_str().is_some_and(|id| {
                            state
                                .journal
                                .0
                                .query_row(
                                    "SELECT state FROM lifetime_work WHERE id=?1",
                                    [id],
                                    |r| r.get::<_, String>(0),
                                )
                                .is_ok_and(|s| matches!(s.as_str(), "queued" | "running" | "blocked"))
                        });
                    }
                    true
                };
                items
                    .iter()
                    .filter(eligible)
                    .find(|item| {
                        matches!(
                            item.payload["body"]["method"].as_str(),
                            Some("conversation.open" | "conversation.ensure")
                        )
                    })
                    .cloned()
                    .or_else(|| items.iter().rev().find(eligible).cloned())
            };
            if let Some(next) = next {
                // An observer started before this delivery cannot establish
                // that its newly admitted report or assignment has settled.
                idle_probe = None;
                let reply = self.command(host, next.payload).await?;
                lifetime::ack_outbox(&host.lock()?.journal.0, next.id, &reply["receipt"])?;
                continue;
            }
            if idle_probe.is_none() {
                // Keep barriers unique across drain calls even when no new
                // command was sent; delayed duplicate results stay obsolete.
                self.idle_probe_generation += 1;
                let id = format!("product-idle-{}", self.idle_probe_generation);
                self.input.write_all(format!("{}\n",json!({"type":"idle","id":id,"ghost_id":ghost,"conversation_id":conversation})).as_bytes()).await?;
                self.input.flush().await?;
                idle_probe=Some(id);
            }
            if let Some(position)=self.idle_results.iter().position(|event|event["id"].as_str()==idle_probe.as_deref()) {
                let result=self.idle_results.remove(position);
                ensure!(result.get("error_code").is_none(),"A04 runtime idle is unconfirmed; original source/Work identities retained");
                return Ok(());
            }
            match self.poll_event(host).await? {
                Some(event) if event["type"]=="idle_result" => self.idle_results.push(event),
                Some(event) if event["type"]=="callback_serviced" => {},
                Some(event) => anyhow::bail!("A04 unexpected concurrent frame: {}",event["type"]),
                None=>{},
            }

        }
        anyhow::bail!("A04 bounded driver did not settle")
    }

    fn functional_attention(&mut self, reason: &str) {
        if let Some(observer) = self.functional_observer.as_mut() {
            let _ = observer.attention(reason);
        }
    }
    fn functional_event(&mut self, event: &Value) -> bool {
        let Some(observer) = self.functional_observer.as_mut() else {
            return false;
        };
        match observer.frame(event) {
            Ok(settled) => settled,
            Err(_) => {
                let _ = observer.attention("observation_metadata_unavailable");
                false
            }
        }
    }
    async fn drain_functional(
        &mut self,
        host: &Host,
        ghost: &str,
        conversation: &str,
    ) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let mut idle_probe: Option<String> = None;
        loop {
            if let Err(error) = host.advance_task_verifications().await {
                eprintln!("A04 verification blocker: {error}");
            }
            if let Some(blocker) = product_verification_blocker(host, ghost, conversation)? {
                anyhow::bail!("A04 independent verification reached a terminal blocker: {blocker}; output remains unaccepted, original evidence retained, no automatic model retry");
            }
            host.advance_bot_provisioning()?;
            a04_producer_configuration::capture_for_host(host)?;
            if let Some(observer) = self.functional_observer.as_mut() {
                if observer.refresh(host).is_err() {
                    let _ = observer.attention("observation_metadata_unavailable");
                }
            }
            let next = {
                let state = host.lock()?;
                let items = lifetime::pending_outbox(&state.journal.0)?;
                let eligible = |item: &&lifetime::OutboxItem| {
                    if item.target != "pi" {
                        return false;
                    }
                    if item.payload["body"]["method"] == "conversation.assignment" {
                        return item.payload["body"]["work_id"].as_str().is_some_and(|id| {
                            state
                                .journal
                                .0
                                .query_row(
                                    "SELECT state FROM lifetime_work WHERE id=?1",
                                    [id],
                                    |r| r.get::<_, String>(0),
                                )
                                .is_ok_and(|s| {
                                    matches!(s.as_str(), "queued" | "running" | "blocked")
                                })
                        });
                    }
                    true
                };
                items
                    .iter()
                    .filter(eligible)
                    .find(|item| {
                        matches!(
                            item.payload["body"]["method"].as_str(),
                            Some("conversation.open" | "conversation.ensure")
                        )
                    })
                    .cloned()
                    .or_else(|| items.iter().rev().find(eligible).cloned())
            };
            let resource_blocked = self.callbacks > A04_BRIDGE_CALLBACK_BUDGET
                || (next.is_some() && self.commands >= A04_BRIDGE_COMMAND_BUDGET);
            if let Some(next) = next {
                if self.callbacks > A04_BRIDGE_CALLBACK_BUDGET {
                    self.functional_attention("callback_budget_exhausted");
                    if let Some(observer)=self.functional_observer.as_mut() {let _=observer.pending("pending_delivery",json!({"outbox_id":next.id,"command_id":next.payload["command_id"].as_str().filter(|s|s.len()<=400),"sent":false}));}
                } else if self.commands >= A04_BRIDGE_COMMAND_BUDGET {
                    self.functional_attention("delivery_budget_exhausted");
                } else {
                    idle_probe = None;
                    if let Some(observer) = self.functional_observer.as_mut() {
                        let _ = observer.invalidate_probe();
                    }
                    let reply = self.command(host, next.payload).await?;
                    lifetime::ack_outbox(&host.lock()?.journal.0, next.id, &reply["receipt"])?;
                    continue;
                }
            }
            if idle_probe.is_none() {
                self.idle_probe_generation += 1;
                let id = format!("product-idle-{}", self.idle_probe_generation);
                if let Some(observer) = self.functional_observer.as_mut() {
                    let _ = observer.begin_probe(&id, ghost, conversation);
                }
                self.input.write_all(format!("{}\n",json!({"type":"idle","id":id,"ghost_id":ghost,"conversation_id":conversation})).as_bytes()).await?;
                self.input.flush().await?;
                idle_probe = Some(id);
            }
            if let Some(position) = self
                .idle_results
                .iter()
                .position(|event| event["id"].as_str() == idle_probe.as_deref())
            {
                let event = self.idle_results.remove(position);
                if self.functional_event(&event) && !resource_blocked {
                    return Ok(());
                }
            }
            let now = crate::host::now_ms();
            if self
                .functional_observer
                .as_mut()
                .is_some_and(|observer| observer.status_due(now))
            {
                self.input.write_all(format!("{}\n",json!({"type":"observation_status","id":idle_probe.as_deref().unwrap(),"ghost_id":ghost,"conversation_id":conversation})).as_bytes()).await?;
                self.input.flush().await?;
            }
            match self.poll_event(host).await? {
                Some(event) if event["type"] == "idle_result" => self.idle_results.push(event),
                Some(event)
                    if matches!(
                        event["type"].as_str(),
                        Some("observation_checkpoint" | "observer_rejected")
                    ) =>
                {
                    self.functional_event(&event);
                }
                Some(event)
                    if matches!(
                        event["type"].as_str(),
                        Some("callback_serviced" | "callback_budget_blocked")
                    ) => {}
                Some(event) => anyhow::bail!("A04 unexpected concurrent frame: {}", event["type"]),
                None => {}
            }
        }
    }
    fn snapshot(&self) -> Value {
        json!({"metrics":self.metrics,"delegations":self.delegations,"reads":self.reads,"denials":self.denials,"commands":self.commands,"callbacks":self.callbacks,"callback_failures":self.callback_failures})
    }
    async fn stop(&mut self, host: &Host) -> Result<Value> {
        use tokio::io::AsyncWriteExt;
        self.input.write_all(b"{\"type\":\"stop\"}\n").await?;
        self.input.flush().await?;
        let end = self.frame(host).await?;
        ensure!(end["type"] == "stopped", "A04 stop refused");
        ensure!(
            tokio::time::timeout(std::time::Duration::from_secs(10), self.process.wait())
                .await??
                .success(),
            "A04 runner exit failed"
        );
        Ok(
            json!({"metrics":self.metrics,"delegations":self.delegations,"reads":self.reads,"denials":self.denials,"commands":self.commands,"callbacks":self.callbacks,"callback_failures":self.callback_failures}),
        )
    }
}
fn product_verification_blocker(host:&Host,ghost:&str,conversation:&str)->Result<Option<Value>> {
    let state=host.lock()?;let conn=&state.journal.0;
    // Only the latest actual Owner input in this pair and its current graph.
    // An unrelated historical failure must not poison a new responsibility.
    let goal:Option<String>=conn.query_row("SELECT link.goal_id FROM lifetime_turns t LEFT JOIN lifetime_turn_goals link ON link.turn_id=t.id WHERE t.ghost_id=?1 AND t.conversation_id=?2 AND t.sender_kind='owner' AND t.sender_ref='owner' AND t.kind='user' ORDER BY t.sequence DESC LIMIT 1",params![ghost,conversation],|r|r.get::<_,Option<String>>(0)).optional()?.flatten();
    let Some(goal)=goal else{return Ok(None)};
    let mut q=conn.prepare("SELECT w.payload FROM lifetime_work w WHERE w.goal_id=?1 OR EXISTS(SELECT 1 FROM lifetime_work_links l WHERE l.child_work_id=w.id AND l.root_goal_id=?1 AND l.current=1) ORDER BY w.id LIMIT 257")?;
    let rows=q.query_map([goal],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(rows.len()<=256,"A04 current Work graph exceeds bounded observer");
    for raw in rows {let work:Work=serde_json::from_str(&raw)?;
        if let Some(view)=lifetime::task_verification::view(conn,&work)? {
            if view["receipt_ref"].is_string() && matches!(view["status"].as_str(),Some("failed"|"unknown")) {
                return Ok(Some(json!({"work_id":work.id,"execution_id":work.execution_id,"status":view["status"],"historical_status":view["historical_status"],"current_scope":view["current_scope"],"receipt_ref":view["receipt_ref"]})));
            }
        }
    }
    Ok(None)
}
// Match the production HTTP boundary's negative callback frame. An unexpected
// Host error may follow an effect, so it is unconfirmed, never no_effect. The
// stdio caller must settle this callback even when the Host returned Err.
fn product_callback_reply(response: Result<Value>, method: &str, command_id: &str) -> (Value,Option<Value>) {
    match response {
        Ok(frame) if frame["ok"]==true => (frame,None),
        Ok(_) => (json!({"ok":false,"error":"Host callback did not return a verified receipt; outcome unconfirmed"}),Some(json!({"method":method,"command_id":command_id,"error_code":"host_callback_rejected","host_effect_class":"unconfirmed"}))),
        Err(error) => {
            let code=if error.downcast_ref::<rusqlite::Error>().is_some_and(|error|matches!(error,rusqlite::Error::QueryReturnedNoRows)) {"database_row_missing"} else {"host_callback_failed"};
            (json!({"ok":false,"error":"Host callback failed before a verified receipt; outcome unconfirmed"}),Some(json!({"method":method,"command_id":command_id,"error_code":code,"host_effect_class":"unconfirmed"})))
        }
    }
}
fn product_source_fingerprint() -> Result<Value> {
    fn collect(directory: &std::path::Path, paths: &mut Vec<std::path::PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                collect(&entry.path(), paths)?;
            } else if kind.is_file() {
                paths.push(entry.path());
            }
        }
        Ok(())
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut paths = vec![std::env::current_exe()?];
    for directory in [
        "src",
        "apps/ghost-durable/src",
        "apps/ghost-durable/scripts",
        "tests/fixtures/a04",
    ] {
        collect(&root.join(directory), &mut paths)?;
    }
    for file in [
        "Cargo.toml",
        "Cargo.lock",
        "apps/ghost-durable/package.json",
        "apps/ghost-durable/package-lock.json",
        "tests/fixtures/a20/product-comparison-v1.json",
    ] {
        paths.push(root.join(file));
    }
    paths.sort();
    let mut files = serde_json::Map::new();
    for path in paths {
        let bytes = std::fs::read(&path)?;
        let name = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        files.insert(
            name,
            json!({"sha256":format!("{:x}",Sha256::digest(&bytes)),"bytes":bytes.len()}),
        );
    }
    Ok(json!({"files":files,"owner_package":a04_fixture::package_manifest()?}))
}
struct ProductEvidence {
    root: std::path::PathBuf,
    before: Value,
    accepted: bool,
    producer_configuration: Option<a04_producer_configuration::ConfigurationPin>,
    functional:bool,
}
impl Drop for ProductEvidence {
    fn drop(&mut self) {
        if self.functional && !self.accepted {let _=a04_functional_observation::finish(&self.root,false);}
        let after = product_source_fingerprint().ok();
        let stable = after.as_ref() == Some(&self.before);
        let configuration_stable=self.producer_configuration.as_ref().is_none_or(|pin|pin.verify(&self.root).is_ok());
        let observed = json!({"status":if self.accepted&&stable&&configuration_stable{"accepted"}else{"failed"},"source_stable":stable,"producer_configuration_stable":configuration_stable,"producer_configuration":self.producer_configuration.as_ref().map(|pin|pin.metadata()),"panicking":std::thread::panicking(),"after":after});
        let _ = std::fs::write(
            self.root.join("a04-final-observation.json"),
            serde_json::to_vec_pretty(&observed).unwrap_or_default(),
        );
    }
}
fn product_input(
    f: &HostFixture,
    turn: &str,
    reference: &Value,
    mode: &str,
    input: &Value,
) -> Result<()> {
    let response=f.host.lifetime_action(&env(turn,json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":input["criteria"]["request"],"privacy":"public","attachments":[],"task_contract":{"template":reference,"mode":mode,"input":input}})))?;
    ensure!(
        response["result"]["status"] == "success",
        "A04 Owner input rejected: {response}"
    );
    Ok(())
}
fn product_root_work(host: &Host, turn: &str) -> Result<Work> {
    let state = host.lock()?;
    let raw:String=state.journal.0.query_row("SELECT json_extract(response,'$.data.work') FROM lifetime_commands WHERE json_extract(request,'$.body.method')='goal.create' AND json_extract(request,'$.body.turn_id')=?1 AND json_extract(response,'$.status')='success'",[turn],|r|r.get(0)).optional()?.ok_or_else(||anyhow!("A04 actual Owner turn {turn} produced no admitted Goal/Work; inspect its retained model metrics and advisory reply before retrying"))?;
    let admitted: Work = serde_json::from_str(&raw)?;
    let raw: String = state.journal.0.query_row(
        "SELECT payload FROM lifetime_work WHERE id=?1",
        [&admitted.id],
        |r| r.get(0),
    ).optional()?.ok_or_else(||anyhow!("A04 admitted Work {} has no durable Work row for Owner turn {turn}",admitted.id))?;
    Ok(serde_json::from_str(&raw)?)
}
fn product_result(host: &Host, work: &Work, input: &Value) -> Result<Value> {
    ensure!(
        work.state == "accepted",
        "Actual A04 Work was not independently accepted: {} {}",
        work.id,
        work.state
    );
    let state = host.lock()?;
    let payload: String = state.journal.0.query_row(
        "SELECT payload FROM lifetime_acceptances WHERE work_id=?1",
        [&work.id],
        |r| r.get(0),
    )?;
    let acceptance: Acceptance = serde_json::from_str(&payload)?;
    let replies:u64=state.journal.0.query_row("SELECT count(*) FROM lifetime_report_replies r JOIN lifetime_outbox o ON o.id=r.outbox_id WHERE json_extract(o.payload,'$.body.goal_id')=?1 AND json_extract(o.payload,'$.body.ghost_id')=?2",params![work.goal_id,work.owner],|r|r.get(0))?;
    ensure!(
        replies > 0,
        "A04 accepted Work has no actual Pi report reply"
    );
    ensure!(
        acceptance
            .checks
            .iter()
            .any(|check| check.id == "owner_verifier" && check.passed),
        "A04 lacks independent Owner verifier evidence"
    );
    let execution = work
        .execution_id
        .as_deref()
        .ok_or_else(|| anyhow!("A04 producer execution missing"))?;
    let mut query=state.journal.0.prepare("SELECT response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='publish_artifact' AND state='complete'")?;
    let responses = query
        .query_map([execution], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let artifact = responses
        .into_iter()
        .filter_map(|raw| serde_json::from_str::<Response>(&raw).ok())
        .flat_map(|response| response.artifacts)
        .find(|artifact| artifact.digest == acceptance.artifact_digest)
        .ok_or_else(|| anyhow!("A04 accepted artifact missing"))?;
    let bytes = crate::worker::journal::read_verified_artifact(
        &host.root.join("pi-execution"),
        execution,
        &artifact.digest,
        std::path::Path::new(&artifact.locator),
    )?;
    let expected = a04_fixture::answer(input)?;
    let quality = a04_fixture::corpus::quality(Some(&bytes), &expected);
    ensure!(
        quality["passed"] == true,
        "A04 independent test oracle rejected actual artifact: {quality}"
    );
    Ok(
        json!({"work_id":work.id,"goal_id":work.goal_id,"goal_revision":work.goal_revision,"execution_id":execution,"owner":work.owner,"artifact_sha256":artifact.digest,"input_digest":canonical_digest(input)?,"source_corpus_sha256":input["corpus_sha256"],"source_refs":input["sources"].as_array().unwrap().iter().map(|item|json!({"ref":item["source"]["ref"],"sha256":item["sha256"]})).collect::<Vec<_>>(),"selected_product_id":expected["selected_product_id"],"acceptance":acceptance,"quality":quality}),
    )
}
fn product_child_proof(
    host: &Host,
    bridge: &ProductBridge,
    parent: &Work,
    c: &Candidate,
    input: &Value,
) -> Result<Value> {
    let child = {
        let state = host.lock()?;
        let mut query=state.journal.0.prepare("SELECT w.payload FROM lifetime_work_links l JOIN lifetime_work w ON w.id=l.child_work_id WHERE l.parent_work_id=?1 AND l.current=1")?;
        let rows = query
            .query_map([&parent.id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            rows.len() == 1,
            "A04 requires exactly one actual child Work"
        );
        let child: Work = serde_json::from_str(&rows[0])?;
        ensure!(
            child.owner == c.definition.ghost_id
                && bots_store::definition_for_work(&state.journal.0, &child)?
                    == Some(c.definition.clone()),
            "A04 child definition identity changed"
        );
        child
    };
    let input_digest = canonical_digest(input)?;
    ensure!(
        bridge.reads.iter().any(|read| read["work_id"] == child.id
            && read["ghost_id"] == child.owner
            && read["sha256"] == input_digest
            && read["path"] == format!("owner-input-{input_digest}.json")),
        "Created bot did not read the new exact Owner input"
    );
    let mut result=product_result(host,&child,input)?;
    result["parent_consumption"]=product_child_read_proof(&bridge.reads,parent,&child,result["artifact_sha256"].as_str().unwrap())?;
    Ok(result)
}
fn product_child_read_proof(reads: &[Value], parent: &Work, child: &Work, digest: &str) -> Result<Value> {
    let path=format!("input-{:x}-{digest}",Sha256::digest(child.id.as_bytes()));
    ensure!(reads.iter().any(|read|read["work_id"]==parent.id && read["ghost_id"]==parent.owner && read["path"]==path && read["sha256"]==digest),
        "Primary did not successfully read the exact independently accepted child's artifact path and SHA256");
    Ok(json!({"parent_work_id":parent.id,"child_work_id":child.id,"path":path,"sha256":digest}))
}
fn product_source_proof(host: &Host, seed: &Work, c: &Candidate) -> Result<Value> {
    let state=host.lock()?;
    let turn=c.intent_turn_id.as_deref().ok_or_else(||anyhow!("A04 creation lacks actual Owner intent"))?;
    let pin=source_acceptance(&state.journal.0,&seed.id,turn)?;
    ensure!(pin.work==*seed && c.source_acceptances==vec![pin.clone()],"Candidate did not pin exact accepted original Work and receipt");
    let (accepted_row,owner_row,original):(i64,i64,String)=state.journal.0.query_row("SELECT accepted.rowid,owner.rowid,owner.request FROM lifetime_commands accepted JOIN lifetime_commands owner ON owner.command_id=?2 WHERE accepted.command_id=?1",params![pin.command_id,turn],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let owner:Envelope=serde_json::from_str(&original)?;owner.validate()?;
    ensure!(accepted_row<owner_row && owner.actor_ref=="owner" && owner.body["method"]=="conversation.input" && owner.body["text"]=="방금 우리가 수행한 작업을 봇으로 만들어줘",
        "A04 original accepted task did not causally precede the actual natural Owner creation request");
    Ok(json!({"source_work":seed,"acceptance":pin.acceptance,"acceptance_command_id":pin.command_id,"acceptance_command_digest":pin.command_digest,"acceptance_journal_row":accepted_row,"owner_creation_turn_id":turn,"owner_creation_command_digest":owner.payload_digest,"owner_creation_journal_row":owner_row}))
}
fn product_reopen(root: &std::path::Path, ghost: &str, configuration:Option<&a04_producer_configuration::ConfigurationPin>) -> Result<Host> {
    let profiles = crate::store::list_profiles(root)?
        .into_iter()
        .map(|name| {
            Host::profile(ProfileStore::open_profile(root, &name)?)
                .map(|profile| (profile.id.clone(), profile))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    let journal = Journal::open(&root.join("workspace.db"))?;
    let computers=if let Some(configuration)=configuration {
        configuration.reload(root,&journal,&profiles,ghost)?
    } else {
        let mut computers=host::lifetime_computers::NativeComputers::pi_fixture(&root.join("registry"), ghost)?;
        computers.set_pi_fixture_cli(std::path::Path::new("/opt/homebrew/bin/container"))?;
        computers.restore_provisioned_pi_routes(&journal.0, &profiles)?;
        computers
    };
    Ok(Host {
        root: root.into(),
        state: Mutex::new(State { profiles, journal }),
        handle: tokio::runtime::Handle::current(),
        default_model: "mock".into(),
        _lock: host::WorkspaceLock(File::create(root.join("test.lock"))?),
        brain: crate::adapters::memory::Brain::default(),
        computer: crate::adapters::computer::default_backend(),
        integrations: host::integrations::Connections::default(),
        workers: Mutex::new(vec![]),
        profile_workers: Mutex::new(BTreeMap::new()),
        recovery: tokio::sync::Mutex::new(()),
        stopping: AtomicBool::new(false),
        legacy_fixture_reasoning: AtomicBool::new(false),
        dispatch_enabled: true,
        pi_callback_token: "fixture-callback".into(),
        pi_local_route: None,
        authority_epoch: 1,
        native_computers: Some(computers),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit A04 local-model product scenario; at most80 calls across two cold phases"]
async fn real_product_task_becomes_one_bot_and_primary_reuses_it_across_restart() -> Result<()> {
    product_task_scenario(false).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit separate A04 functional policy observer; original model/call/effect bounds unchanged"]
async fn real_product_task_functional_observation_preserves_policy_deadlines_across_restart()->Result<()> {
    product_task_scenario(true).await
}

async fn product_task_scenario(functional:bool)->Result<()> {
    ensure!(
        std::env::var(if functional {"GHOST_PI_RUN_A04_FUNCTIONAL_CANARY"}else{"GHOST_PI_RUN_A04_PRODUCT_CANARY"}).as_deref() == Ok("1"),
        "A04 explicit opt-in missing"
    );
    let before = product_source_fingerprint()?;
    let mut f = host_fixture();
    let root = std::mem::replace(&mut f.root, tempfile::tempdir()?).keep();
    let mut evidence = ProductEvidence {
        root: root.clone(),
        before: before.clone(),
        accepted: false,
        producer_configuration: None,
        functional,
    };
    eprintln!("A04 public synthetic evidence: {}", root.display());
    let producer_configuration=a04_producer_configuration::install_from_environment(&mut f)?;
    if functional {ensure!(producer_configuration.is_some(),"Functional A04 requires its explicit genuine accepted producer configuration");}
    evidence.producer_configuration=producer_configuration.clone();
    crate::host::inference::install_external_test_inference(&f.host)?;
    std::fs::write(
        root.join("a04-attempt.json"),
        serde_json::to_vec_pretty(
            &json!({"status":"running","max_calls_per_phase":40,"max_calls_total":80,"max_output_tokens":4096,"inference_endpoint":"https://api.z.ai/api/v1","owner_template_prerequisite":true,"expected_outputs_disclosed":false,"producer_configuration":producer_configuration.as_ref().map(|pin|pin.metadata()),"distinct_new_source_artifacts":["tests/fixtures/a04/reuse-one.json","tests/fixtures/a04/reuse-two.json"]}),
        )?,
    )?;
    std::fs::write(
        root.join("a04-before.json"),
        serde_json::to_vec_pretty(&before)?,
    )?;
    if functional {
        let path=root.join("a04-attempt.json");let mut attempt:Value=serde_json::from_slice(&std::fs::read(&path)?)?;
        attempt["mode"]=json!(a04_functional_observation::MODE);attempt["kind"]=json!("ghost-a04-functional-attempt/1");
        std::fs::write(path,serde_json::to_vec_pretty(&attempt)?)?;
    }
    if producer_configuration.is_none() {f.host
        .native_computers
        .as_mut()
        .unwrap()
        .set_pi_fixture_cli(std::path::Path::new("/opt/homebrew/bin/container"))?;}
    let package = a04_fixture::verifier_package()?;
    let registered=f.host.lifetime_action(&env("install-comparison-template",json!({"method":"task.contract.register","ghost_id":f.ghost,"conversation_id":f.conversation,"id":"product-comparison","content":a04_fixture::content(&package)})))?;
    ensure!(
        registered["result"]["status"] == "success",
        "Owner template installation failed"
    );
    let reference = registered["result"]["data"]["template_ref"].clone();
    let cases = a04_fixture::corpus::cases();
    let configured=f.host.lifetime_action(&env("fixed-product-evaluation",json!({"method":"bot.evaluation_profile.configure","fixtures":[{"id":"no-fit-held-out","input":a04_fixture::input(&cases[1]),"expected_output":a04_fixture::corpus::answer(&cases[1])},{"id":"corrected-held-out","input":a04_fixture::input(&cases[2]),"expected_output":a04_fixture::corpus::answer(&cases[2])}]})))?;
    ensure!(
        configured["result"]["status"] == "success",
        "Fixed Owner bot evaluator unavailable"
    );
    let seed_input=a04_fixture::input(&cases[0]);
    let mut bridge = if functional {ProductBridge::start_mode(&f.host,true).await?}else{ProductBridge::start(&f.host).await?};
    let phase_one=async {
        product_input(&f,"original-product-task",&reference,"direct",&seed_input)?;bridge.drain(&f.host,&f.ghost,&f.conversation).await?;
        let seed=product_root_work(&f.host,"original-product-task")?;let seed_result=product_result(&f.host,&seed,&seed_input)?;
        owner_create_turn(&f,"방금 우리가 수행한 작업을 봇으로 만들어줘");bridge.drain(&f.host,&f.ghost,&f.conversation).await?;
        let c={let state=f.host.lock()?;let ids=state.journal.0.prepare("SELECT id FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.state')='ready'")?.query_map([PROGRESS],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;ensure!(ids.len()==1,"Actual model did not produce exactly one ready candidate");candidate(&state.journal.0,&ids[0])?};
        ensure!(c.source_work_ids==vec![seed.id.clone()],"Bot must derive from the actual independently accepted original task");
        let source_proof=product_source_proof(&f.host,&seed,&c)?;
        ensure!(c.definition.content.input_contract==json!({"kind":"source-backed-product-comparison/1"})&&c.definition.content.output_contract==json!({"kind":"source-backed-product-comparison/1"}),"Candidate changed exact reusable task eligibility");
        let mut first=cases[0].clone();first["id"]=json!("new-night-commute");first["request"]=json!("새 입력이야. 이 헤드폰들을 야간 통근용으로 비교해줘. 새로 지정한 예산, 배터리, 무게 조건을 그대로 지켜줘.");first["max_price_usd"]=json!(190);first["min_battery_hours"]=json!(22);first["max_weight_g"]=json!(260);first["weights"]=json!({"price":3,"battery":2,"weight":1});
        let first=a04_fixture::reuse_input(1,&first)?;
        product_input(&f,"new-primary-product-one",&reference,"delegate",&first)?;bridge.drain(&f.host,&f.ghost,&f.conversation).await?;
        let first_work=product_root_work(&f.host,"new-primary-product-one")?;let first_result=product_result(&f.host,&first_work,&first)?;
        let child=product_child_proof(&f.host,&bridge,&first_work,&c,&first)?;let first_result=json!({"primary":first_result,"child":child});
        ensure!(bridge.delegations.len()==1&&bridge.delegations[0]["target_ghost_id"]==c.definition.ghost_id,"Primary did not automatically select the created bot");
        if let Some(pin)=producer_configuration.as_ref() {
            let evaluation={let state=f.host.lock()?;progress(&state.journal.0,&c.id)?.evaluation_work_id.ok_or_else(||anyhow!("A04 candidate evaluation Work missing"))?};
            a04_producer_configuration::required_consumption(&f.host,pin,&[("seed",&seed.id),("evaluation",&evaluation),("reuse_one_parent",first_result["primary"]["work_id"].as_str().unwrap()),("reuse_one_child",first_result["child"]["work_id"].as_str().unwrap())],&c)?;
        }
        Ok::<_,anyhow::Error>((c,seed_result,source_proof,first,first_result))
    }.await;
    let stopped_one = bridge.stop(&f.host).await;
    let phase_one_metrics = bridge.snapshot();
    std::fs::write(
        root.join("a04-phase-one.json"),
        serde_json::to_vec_pretty(&phase_one_metrics)?,
    )?;
    let (c, seed_result, source_proof, first, first_result) = phase_one?;
    stopped_one?;
    let ghost = f.ghost.clone();
    let conversation = f.conversation.clone();
    drop(f.host);
    let reopened = product_reopen(&root, &ghost,producer_configuration.as_ref())?;
    let selected = {
        let state = reopened.lock()?;
        bots_store::active_definition(&state.journal.0, &c.definition.ghost_id)?
            .ok_or_else(|| anyhow!("Ready bot definition lost on cold reopen"))?
    };
    ensure!(
        selected == c.definition,
        "Cold reopen changed selected immutable definition"
    );
    if let Some(pin)=producer_configuration.as_ref() {
        a04_producer_configuration::required_consumption(&reopened,pin,&[("seed",seed_result["work_id"].as_str().unwrap()),("reuse_one_parent",first_result["primary"]["work_id"].as_str().unwrap()),("reuse_one_child",first_result["child"]["work_id"].as_str().unwrap())],&c)?;
    }
    let mut correction = first["criteria"].clone();
    correction["id"] = json!("criteria-corrected-endurance");
    correction["request"]=json!("조건을 정정할게. 이번에는 새로 제공한 다른 제품 자료로 예산185달러, ANC를 켠 배터리26시간 이상, 무게260g 이하로 비교해줘. 배터리를 더 중요하게 봐줘. 봇 자체의 정의를 바꾸는 요청은 아니야.");
    correction["max_price_usd"] = json!(185);
    correction["min_battery_hours"] = json!(26);
    correction["weights"] = json!({"price":1,"battery":5,"weight":1});
    let correction=a04_fixture::reuse_input(2,&correction)?;
    let current = HostFixture {
        root: f.root,
        host: reopened,
        ghost,
        conversation,
    };
    let mut bridge = if functional {ProductBridge::start_mode(&current.host,true).await?}else{ProductBridge::start(&current.host).await?};
    let phase_two=async {
        product_input(&current,"new-primary-product-two",&reference,"delegate",&correction)?;bridge.drain(&current.host,&current.ghost,&current.conversation).await?;
        let second_work=product_root_work(&current.host,"new-primary-product-two")?;let second_result=product_result(&current.host,&second_work,&correction)?;
        let child=product_child_proof(&current.host,&bridge,&second_work,&c,&correction)?;let second_result=json!({"primary":second_result,"child":child});
        ensure!(bridge.delegations.len()==1&&bridge.delegations[0]["target_ghost_id"]==c.definition.ghost_id,"Cold primary did not automatically reuse the same created bot");
        ensure!(first_result["primary"]["artifact_sha256"]!=second_result["primary"]["artifact_sha256"]&&first_result["primary"]["input_digest"]!=second_result["primary"]["input_digest"],"New requests did not produce distinct input/artifact identities");
        ensure!(first_result["primary"]["work_id"]!=second_result["primary"]["work_id"],"New primary request reused an old Work identity");
        ensure!(first_result["child"]["work_id"]!=second_result["child"]["work_id"] && first_result["child"]["execution_id"]!=second_result["child"]["execution_id"] && first_result["child"]["artifact_sha256"]!=second_result["child"]["artifact_sha256"],"Reuse did not produce different actual child Work/execution/artifact identities");
        for earlier in [&seed_input,&first] {ensure!(earlier["corpus_sha256"]!=correction["corpus_sha256"] && earlier["sources"].as_array().unwrap().iter().all(|old|correction["sources"].as_array().unwrap().iter().all(|new|old["source"]["ref"]!=new["source"]["ref"] && old["sha256"]!=new["sha256"])),"New reuse source records were copied from an earlier task");}
        ensure!(seed_input["corpus_sha256"]!=first["corpus_sha256"],"First reuse must consume a new source artifact");
        let state=current.host.lock()?;ensure!(bots_store::active_definition(&state.journal.0,&c.definition.ghost_id)?==Some(c.definition.clone()),"Task criteria correction mutated bot definition");
        let ids:u64=state.journal.0.query_row("SELECT count(DISTINCT json_extract(payload,'$.definition.ghost_id')) FROM workspace_objects WHERE kind=?1",[CANDIDATES],|r|r.get(0))?;ensure!(ids==1,"Repeated requests created another bot");
        let goals:u64=state.journal.0.query_row("SELECT count(DISTINCT json_extract(response,'$.data.goal.id')) FROM lifetime_commands WHERE json_extract(request,'$.body.method')='goal.create' AND json_extract(request,'$.body.turn_id') IN ('original-product-task','new-primary-product-one','new-primary-product-two') AND json_extract(response,'$.status')='success'",[],|r|r.get(0))?;ensure!(goals==3,"Owner inputs created duplicate or missing responsibilities");
        Ok::<_,anyhow::Error>(second_result)
    }.await;
    let stopped_two = bridge.stop(&current.host).await;
    let phase_two_metrics = bridge.snapshot();
    std::fs::write(
        root.join("a04-phase-two.json"),
        serde_json::to_vec_pretty(&phase_two_metrics)?,
    )?;
    let second_result = phase_two?;
    stopped_two?;
    let producer_consumption=if let Some(pin)=producer_configuration.as_ref() {
        let evaluation={let state=current.host.lock()?;progress(&state.journal.0,&c.id)?.evaluation_work_id.ok_or_else(||anyhow!("A04 candidate evaluation Work missing"))?};
        Some(a04_producer_configuration::required_consumption(&current.host,pin,&[("seed",seed_result["work_id"].as_str().unwrap()),("evaluation",&evaluation),("reuse_one_parent",first_result["primary"]["work_id"].as_str().unwrap()),("reuse_one_child",first_result["child"]["work_id"].as_str().unwrap()),("reuse_two_parent",second_result["primary"]["work_id"].as_str().unwrap()),("reuse_two_child",second_result["child"]["work_id"].as_str().unwrap())],&c)?)
    } else {None};
    let after = product_source_fingerprint()?;
    if let Some(pin)=producer_configuration.as_ref() {pin.verify(&root)?;}
    std::fs::write(
        root.join("a04-after.json"),
        serde_json::to_vec_pretty(&after)?,
    )?;
    ensure!(
        before == after,
        "A04 implementation changed during model trial"
    );
    let total_calls = phase_one_metrics["metrics"]["model_calls"]
        .as_u64()
        .ok_or_else(|| anyhow!("First model count missing"))?
        + phase_two_metrics["metrics"]["model_calls"]
            .as_u64()
            .ok_or_else(|| anyhow!("Second model count missing"))?;
    ensure!(total_calls <= 80, "A04 cumulative model budget exceeded");
    let mut result = json!({"status":"accepted","model_calls_total":total_calls,"classification":"original frozen fictional products plus two disjoint new fictional source artifacts; not live purchase research","owner_template_prerequisite":true,"plain_unconfigured_chat_auto_verified":false,"expected_outputs_disclosed":false,"source_stable":true,"producer_configuration":producer_configuration.as_ref().map(|pin|pin.metadata()),"producer_consumption":producer_consumption,"created_ghost_id":c.definition.ghost_id,"candidate_digest":c.digest,"definition_ref":{"ghost_id":c.definition.ghost_id,"revision":c.definition.revision,"digest":c.definition.digest},"seed":seed_result,"creation_source_proof":source_proof,"new_results":[first_result,second_result],"phase_one":phase_one_metrics,"phase_two":phase_two_metrics,"cold_host_and_pi_reopen":true,"fixture_authority_epoch":1,"installed_state_changed":false});
    if functional {
        if let Some(observer)=bridge.functional_observer.as_mut() {observer.refresh_force(&current.host)?;}
        result["kind"]=json!("ghost-a04-functional-result/1");result["mode"]=json!(a04_functional_observation::MODE);result["functional_verdict"]=json!("accepted");result["functional_observation"]=a04_functional_observation::finish(&root,true)?;
    }
    let result_file=if functional {"a04-functional-result.json"}else{"a04-result.json"};
    std::fs::write(
        root.join(result_file),
        serde_json::to_vec_pretty(&result)?,
    )?;
    evidence.accepted = true;
    eprintln!("A04 result: {}", root.join(result_file).display());
    Ok(())
}

#[test]
fn product_parent_read_proof_rejects_prefix_only_foreign_work_and_wrong_bytes() {
    let parent=Work{id:"parent-accepted".into(),goal_id:"goal".into(),goal_revision:1,owner:"primary".into(),owner_revision:1,state:"accepted".into(),execution_id:Some("parent-execution".into()),cancellation:"none".into(),blocker:None};
    let child=Work{id:"child-accepted".into(),owner:"created-bot".into(),execution_id:Some("child-execution".into()),..parent.clone()};
    let digest="a".repeat(64);let path=format!("input-{:x}-{digest}",Sha256::digest(child.id.as_bytes()));
    let read=json!({"work_id":parent.id,"ghost_id":parent.owner,"path":path,"sha256":digest});
    assert!(product_child_read_proof(&[read.clone()],&parent,&child,&digest).is_ok());
    for (field,value) in [("path",json!("input-unrelated")),("sha256",json!("b".repeat(64))),("work_id",json!("foreign-parent")),("ghost_id",json!("foreign-ghost"))] {
        let mut changed=read.clone();changed[field]=value;
        assert!(product_child_read_proof(&[changed],&parent,&child,&digest).is_err(),"{field} is part of exact child consumption proof");
    }
}

#[tokio::test]
async fn product_bridge_host_error_always_settles_callback_as_unconfirmed_without_hanging() {
    use tokio::io::AsyncBufReadExt;
    let f=host_fixture();
    let mut envelope=env("controlled-host-error",json!({"method":"work.pi.admit","work_id":123}));envelope.actor_ref=f.ghost.clone();
    let request=json!({"ghost_id":f.ghost,"conversation_id":f.conversation,"envelope":envelope});
    let script="import json,sys
request=json.loads(sys.argv[1])
print(json.dumps({'type':'callback','id':'controlled-host-error','request':request}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply['type']=='callback_result' and reply['id']=='controlled-host-error'
assert reply['frame']['ok'] is False
assert 'unconfirmed' in reply['frame']['error']
print(json.dumps({'type':'command_result','receipt':{'status':'success'}}),flush=True)
";
    let mut process=tokio::process::Command::new("/usr/bin/python3").arg("-u").arg("-c").arg(script).arg(request.to_string()).env_clear().env("PATH","/usr/bin:/bin").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn().unwrap();
    let input=process.stdin.take().unwrap();let output=tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
    let mut bridge=ProductBridge{process,input,output,commands:0,callbacks:0,metrics:Value::Null,delegations:vec![],reads:vec![],denials:vec![],callback_failures:vec![],idle_results:vec![],idle_probe_generation:0,functional_observer:None};
    let result=tokio::time::timeout(std::time::Duration::from_secs(3),bridge.frame(&f.host)).await.expect("Host Err must still release the pending stdio callback").unwrap();
    assert_eq!(result["type"],"command_result");assert_eq!(bridge.callback_failures.len(),1);
    assert_eq!(bridge.callback_failures[0]["command_id"],"controlled-host-error");
    assert_eq!(bridge.callback_failures[0]["host_effect_class"],"unconfirmed");
    assert!(!serde_json::to_string(&bridge.callback_failures).unwrap().contains("123"),"Callback-error diagnostic retains identity/code, not raw model arguments");
    assert!(bridge.process.wait().await.unwrap().success());
}

#[tokio::test]
async fn product_bridge_dispatches_new_assignment_while_original_owner_idle_observer_is_pending() {
    use tokio::io::AsyncBufReadExt;
    let f=host_fixture();let reference=register_task_template(&f,"concurrent-dispatch-fixture");
    assert_eq!(task_input(&f,"pump-owner",reference,"direct",json!({"value":"controlled"}))["result"]["status"],"success");
    let task={let state=f.host.lock().unwrap();lifetime::task_contracts::turn_descriptor(&state.journal.0,"pump-owner",&f.ghost,&f.conversation).unwrap().unwrap()};
    let mut goal=env("pump-goal-create",json!({"method":"goal.create","turn_id":"pump-owner","ghost_id":f.ghost,"conversation_id":f.conversation,"task_contract_ref":task["task_contract_ref"]}));goal.actor_ref=f.ghost.clone();
    let callback=json!({"ghost_id":f.ghost,"conversation_id":f.conversation,"envelope":goal});
    // No model, endpoint, native process or acceptance shortcut: this peer only
    // models production's admission ACK and an independently pending observer.
    let script=r#"import json,sys,hashlib
request=json.loads(sys.argv[1]);emit=lambda value:print(json.dumps(value),flush=True)
read=lambda:json.loads(sys.stdin.readline())
def ack(frame,extra={}):
 b=frame['command']['body'];return {'type':'command_result','id':frame['id'],'receipt':{'status':'success','summary':'Controlled durable admission ACK','artifacts':[],'next_actions':[],'data':{'command_id':frame['command']['command_id'],'ghost_id':b['ghost_id'],'conversation_id':b['conversation_id'],'runtime_kind':'pi-durable','runtime_release':'1.1.0','storage_ref':'controlled/owner/durable.sqlite','pi_conversation_id':1,**extra}}}
owner=read();assert owner['type']=='command' and owner['command']['body']['method']=='conversation.input'
emit(ack(owner))
idle=read();assert idle['type']=='idle'
emit({'type':'callback','id':'create-during-idle','request':request})
created=read();assert created['type']=='callback_result' and created['frame']['result']['status']=='success'
assignment=read();assert assignment['type']=='command' and assignment['command']['body']['method']=='conversation.assignment'
body={'method':'conversation.assignment.inspect','assignment_id':assignment['command']['command_id'],'ghost_id':request['ghost_id'],'conversation_id':request['conversation_id']}
canonical=json.dumps(body,sort_keys=True,separators=(',',':'));envelope={**request['envelope'],'command_id':'pump-assignment-inspect','correlation_id':'pump-assignment-inspect','payload_digest':hashlib.sha256(canonical.encode()).hexdigest(),'body':body}
emit({'type':'callback','id':'inspect-new-assignment','request':{'ghost_id':request['ghost_id'],'conversation_id':request['conversation_id'],'envelope':envelope}})
inspected=read();assert inspected['frame']['result']['status']=='success'
context=inspected['frame']['result']['data']['execution_context']
emit({'type':'idle_result','id':idle['id']})
emit(ack(assignment,{'context_ref':context['ref'],'storage_ref':'controlled/work/'+context['ref']+'/durable.sqlite'}))
fresh=read();assert fresh['type']=='idle' and fresh['id']!=idle['id']
emit({'type':'idle_result','id':fresh['id'],'metrics':{'idle_generation':1}})
again=read();assert again['type']=='idle' and again['id'] not in [idle['id'],fresh['id']]
emit({'type':'idle_result','id':fresh['id'],'metrics':{'idle_generation':1}})
emit({'type':'idle_result','id':again['id'],'metrics':{'idle_generation':2}})
failure=read();assert failure['type']=='idle' and failure['id'] not in [idle['id'],fresh['id'],again['id']]
emit({'type':'idle_result','id':failure['id'],'error_code':'a04_idle_unconfirmed','metrics':{'idle_generation':3}})
assert read()['type']=='stop';emit({'type':'stopped'})
"#;
    let mut process=tokio::process::Command::new("/usr/bin/python3").arg("-u").arg("-c").arg(script).arg(callback.to_string()).env_clear().env("PATH","/usr/bin:/bin").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn().unwrap();
    let input=process.stdin.take().unwrap();let output=tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
    let mut bridge=ProductBridge{process,input,output,commands:0,callbacks:0,metrics:Value::Null,delegations:vec![],reads:vec![],denials:vec![],callback_failures:vec![],idle_results:vec![],idle_probe_generation:0,functional_observer:None};
    tokio::time::timeout(std::time::Duration::from_secs(5),bridge.drain(&f.host,&f.ghost,&f.conversation)).await.expect("the pending Owner idle observer must not prevent new outbox delivery").unwrap();
    assert_eq!(bridge.metrics["idle_generation"],1,"a stale idle result buffered before the new command ACK cannot settle the drain");
    tokio::time::timeout(std::time::Duration::from_secs(5),bridge.drain(&f.host,&f.ghost,&f.conversation)).await.expect("a later drain needs a distinct idle barrier even without another delivery").unwrap();
    assert_eq!(bridge.metrics["idle_generation"],2,"a duplicate old idle result cannot settle a later drain");
    let error=tokio::time::timeout(std::time::Duration::from_secs(5),bridge.drain(&f.host,&f.ghost,&f.conversation)).await.expect("a current failed idle barrier must settle as an error").unwrap_err();
    assert!(error.to_string().contains("runtime idle is unconfirmed"));
    assert_eq!(bridge.metrics["idle_generation"],3);
    assert_eq!(bridge.commands,2);assert_eq!(bridge.callbacks,2);assert!(bridge.callback_failures.is_empty());
    let state=f.host.lock().unwrap();assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE acknowledged=0",[],|r|r.get::<_,u64>(0)).unwrap(),0);
    assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_work WHERE state='queued'",[],|r|r.get::<_,u64>(0)).unwrap(),1,"dispatch proof is not model execution or artifact acceptance");drop(state);
    bridge.stop(&f.host).await.unwrap();
}

#[tokio::test]
async fn product_bridge_fails_fast_on_exact_current_terminal_verdict_and_ignores_unrelated_history() {
    use tokio::io::AsyncBufReadExt;
    let f=host_fixture();let reference=register_task_template(&f,"terminal-verdict-observer");
    assert_eq!(task_input(&f,"current-verifier-owner",reference,"direct",json!({"value":"alpha"}))["result"]["status"],"success");
    let (_,mut work)=task_goal(&f,"current-verifier-owner","current-verifier-goal").await;
    work.state="completed".into();work.execution_id=Some("controlled-completed-source".into());
    {let state=f.host.lock().unwrap();state.journal.0.execute("UPDATE lifetime_work SET state=?1,execution_id=?2,payload=?3 WHERE id=?4",params![work.state,work.execution_id,serde_json::to_string(&work).unwrap(),work.id]).unwrap();}
    lifetime::task_verification::fixture_terminal_receipt(&f.host,&work.id,"complete").unwrap();
    let blocker=product_verification_blocker(&f.host,&f.ghost,&f.conversation).unwrap().unwrap();assert_eq!(blocker["work_id"],work.id);assert_eq!(blocker["status"],"failed");
    let mut process=tokio::process::Command::new("/usr/bin/true").env_clear().stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let input=process.stdin.take().unwrap();let output=tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
    let mut bridge=ProductBridge{process,input,output,commands:0,callbacks:0,metrics:Value::Null,delegations:vec![],reads:vec![],denials:vec![],callback_failures:vec![],idle_results:vec![],idle_probe_generation:0,functional_observer:None};
    let error=tokio::time::timeout(std::time::Duration::from_secs(2),bridge.drain(&f.host,&f.ghost,&f.conversation)).await.expect("terminal verifier rejection must not wait for the 120s model observer").unwrap_err();assert!(error.to_string().contains("terminal blocker"));assert_eq!(bridge.commands,0);assert_eq!(bridge.callbacks,0);
    let newer=env("unrelated-new-owner",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"A genuinely different later request.","privacy":"public","attachments":[]}));assert_eq!(f.host.lifetime_action(&newer).unwrap()["result"]["status"],"success");
    assert!(product_verification_blocker(&f.host,&f.ghost,&f.conversation).unwrap().is_none(),"old failed Work does not block another unconfigured responsibility");
}
