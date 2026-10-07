#![cfg(feature = "workspace-ui")]
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Ui {
    _child: Running,
    origin: String,
    cookie: String,
    csrf: String,
    client: reqwest::Client,
    rt: tokio::runtime::Runtime,
}
impl Ui {
    fn start(root: &Path) -> Self {
        let mut child = Running(
            Command::new(env!("CARGO_BIN_EXE_ghost"))
                .args(["--root", root.to_str().unwrap(), "serve"])
                .env_clear()
                .env("OXICODE_MODELS_DEV_DISABLE_FETCH", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line);
            let _ = tx.send(result);
        });
        let line = match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(line)) => line,
            _ => {
                let _ = child.0.kill();
                let _ = child.0.wait();
                panic!("workspace ready deadline");
            }
        };
        let ready: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ready["mode"], "durable_workspace");
        let origin = ready["ui"].as_str().unwrap().to_string();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(4))
            .build()
            .unwrap();
        let response = rt
            .block_on(async { client.get(format!("{origin}/")).send().await })
            .unwrap();
        assert_eq!(response.status(), 200);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'"));
        let html = rt.block_on(async { response.text().await }).unwrap();
        let csrf = html
            .split("name=\"csrf\" content=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_string();
        Self {
            _child: child,
            origin,
            cookie,
            csrf,
            client,
            rt,
        }
    }
    fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        auth: bool,
        origin: Option<&str>,
    ) -> (u16, Value) {
        let mut request = if let Some(body) = body {
            self.client
                .post(format!("{}{path}", self.origin))
                .json(body)
        } else {
            self.client.get(format!("{}{path}", self.origin))
        };
        if auth {
            request = request
                .header("cookie", &self.cookie)
                .header("x-ghost-csrf", &self.csrf);
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = self.rt.block_on(async { request.send().await }).unwrap();
        let status = response.status().as_u16();
        let bytes = self.rt.block_on(async { response.bytes().await }).unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    fn snapshot(&self) -> Value {
        let (status, data) = self.request("/api/snapshot", None, true, None);
        assert_eq!(status, 200);
        data
    }
    fn send(&self, body: &Value) -> (u16, Value) {
        self.request("/api/action", Some(body), true, Some(&self.origin))
    }
    fn action(&self, command: Value) -> Value {
        let (status, data) = self.send(&body(command));
        assert_eq!(status, 200, "{data}");
        data["result"].clone()
    }
    fn profile(&self, name: &str) -> String {
        self.action(json!({"type":"create_profile","name":name,"persona":"test researcher"}))
            ["profile_id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn conversation(&self, id: &str) -> String {
        self.action(
            json!({"type":"create_conversation","profile_id":id,"model":"mock","tools":false}),
        )["conversation_id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn wait(&self, ready: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(8);
        loop {
            let s = self.snapshot();
            if ready(&s) {
                return s;
            }
            assert!(Instant::now() < end, "workspace task deadline");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn raw(&self, data: &str) -> String {
        let mut stream =
            std::net::TcpStream::connect(self.origin.strip_prefix("http://").unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(data.as_bytes()).unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    }
}

fn body(command: Value) -> Value {
    json!({"request_id":uuid::Uuid::new_v4().to_string(),"command":command})
}
fn profile<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap()
}
fn conversation<'a>(snapshot: &'a Value, id: &str, c: &str) -> &'a Value {
    profile(snapshot, id)["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == c)
        .unwrap()
}
#[test]
fn workspace_requires_session_origin_csrf_and_exact_request_payload() {
    let root = TempDir::new().unwrap();
    let ui = Ui::start(root.path());
    assert_eq!(ui.request("/api/snapshot", None, false, None).0, 403);
    let action = body(json!({"type":"create_profile","name":"sage","persona":"research"}));
    assert_eq!(
        ui.request(
            "/api/action",
            Some(&action),
            true,
            Some("https://untrusted.invalid")
        )
        .0,
        403
    );
    assert_eq!(ui.request("/api/action", Some(&action), true, None).0, 403);
    let (status, first) = ui.send(&action);
    assert_eq!(status, 200);
    assert_eq!(ui.send(&action).1, first);
    let mut changed = action.clone();
    changed["command"]["name"] = json!("other");
    assert_eq!(ui.send(&changed).0, 409);
    assert_eq!(ui.snapshot()["profiles"].as_array().unwrap().len(), 1);
    assert_eq!(
        ui.request("/profiles/sage/ghost.db", None, true, None).0,
        404
    );
    assert!(ui
        .raw("GET / HTTP/1.1\r\nHost: bad.invalid\r\n\r\n")
        .contains("403 Forbidden"));
    assert!(ui
        .raw("GET / HTTP/1.1\r\nHost: one\r\nHost: two\r\n\r\n")
        .contains("400 Bad Request"));
}
#[test]
fn background_execution_preserves_history_and_command_receipts_after_process_restart() {
    let root = TempDir::new().unwrap();
    let ui = Ui::start(root.path());
    let p = ui.profile("sage");
    let c = ui.conversation(&p);
    let submit = body(
        json!({"type":"submit","profile_id":p,"conversation_id":c,"prompt":"첫 질문","kind":"prompt"}),
    );
    let (_, receipt) = ui.send(&submit);
    let s = ui.wait(|s| {
        conversation(s, &p, &c)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["phase"] == "complete")
    });
    assert_eq!(
        conversation(&s, &p, &c)["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    drop(ui);
    let ui = Ui::start(root.path());
    assert_eq!(ui.send(&submit).1, receipt);
    ui.action(json!({"type":"submit","profile_id":p,"conversation_id":c,"prompt":"이어서 답해줘","kind":"follow_up"}));
    let s = ui.wait(|s| {
        conversation(s, &p, &c)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["phase"] == "complete")
            .count()
            == 2
    });
    let messages = conversation(&s, &p, &c)["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    let response: Value =
        serde_json::from_str(messages.last().unwrap()["text"].as_str().unwrap()).unwrap();
    assert_eq!(response["history_messages"], 3);
    // The worker completes another turn even if no client reads the API.
    ui.action(json!({"type":"submit","profile_id":p,"conversation_id":c,"prompt":"백그라운드 작업","kind":"prompt"}));
    std::thread::sleep(Duration::from_millis(700));
    let s = ui.snapshot();
    assert_eq!(
        conversation(&s, &p, &c)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["phase"] == "complete")
            .count(),
        3
    );
}
#[test]
fn profiles_remain_isolated_and_permissions_are_host_controlled() {
    let root = TempDir::new().unwrap();
    let folder = TempDir::new().unwrap();
    let ui = Ui::start(root.path());
    let a = ui.profile("sage");
    let b = ui.profile("rune");
    let c = ui.conversation(&a);
    let denied = body(
        json!({"type":"submit","profile_id":b,"conversation_id":c,"prompt":"wrong owner","kind":"prompt"}),
    );
    assert_eq!(ui.send(&denied).0, 409);
    let grant =
        body(json!({"type":"grant","profile_id":a,"path":folder.path(),"operation":"read"}));
    let (status, reply) = ui.send(&grant);
    assert_eq!(status, 200);
    assert_eq!(ui.send(&grant).1, reply);
    let s = ui.snapshot();
    assert_eq!(profile(&s, &a)["grants"].as_array().unwrap().len(), 1);
    assert!(profile(&s, &b)["grants"].as_array().unwrap().is_empty());
    ui.action(json!({"type":"revoke","profile_id":a,"grant_id":reply["result"]["id"]}));
    let s = ui.snapshot();
    assert!(!profile(&s, &a)["grants"][0]["revoked_at"].is_null());
    assert_eq!(
        ui.send(&body(
            json!({"type":"grant","profile_id":a,"path":root.path(),"operation":"write"})
        ))
        .0,
        409
    );
    assert_eq!(
        ui.send(&body(
            json!({"type":"create_profile","name":"../outside","persona":"bad"})
        ))
        .0,
        409
    );
}
#[test]
fn timer_configuration_pause_and_resume_survive_restart() {
    let root = TempDir::new().unwrap();
    let ui = Ui::start(root.path());
    let p = ui.profile("sage");
    let c = ui.conversation(&p);
    let saved=ui.action(json!({"type":"add_schedule","profile_id":p,"conversation_id":c,"prompt":"review notes","interval_seconds":60}));
    ui.action(json!({"type":"pause_schedule","schedule_id":saved["id"],"paused":true}));
    drop(ui);
    let ui = Ui::start(root.path());
    let s = ui.snapshot();
    assert_eq!(s["schedules"][0]["paused"], true);
    assert_eq!(s["schedules"][0]["id"], saved["id"]);
    ui.action(json!({"type":"pause_schedule","schedule_id":saved["id"],"paused":false}));
    let s = ui.snapshot();
    assert_eq!(s["schedules"][0]["paused"], false);
    assert_eq!(s["schedules"][0]["interval_seconds"], 60);
}
