#![cfg(all(feature = "ui-fixtures", unix))]
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;
// Allows a standalone artifact to be accepted with these same assertions.
// Only the fixture harness supplies this explicit path; no product env fallback.
fn fixture_binary() -> std::path::PathBuf {
    std::env::var_os("GHOST_UI_BINARY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_ghost").into())
}
struct Ui {
    child: Child,
    root: TempDir,
    origin: String,
    page_origin: String,
    cookie: String,
    csrf: String,
    client: reqwest::Client,
    rt: tokio::runtime::Runtime,
}
impl Ui {
    fn start() -> Self {
        let root = TempDir::new().unwrap();
        let pin = std::env::var("GHOST_UI_PIN")
            .expect("explicit controlled fixture runtime pin required");
        let mut child = Command::new(fixture_binary())
            .args([
                "--root",
                root.path().to_str().unwrap(),
                "ui-fixture",
                "--browser-pin",
                &pin,
                "--seconds",
                "80",
            ])
            .env_clear()
            .current_dir(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let out = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(out)
                .read_line(&mut line)
                .map(|_| line);
            let _ = tx.send(result);
        });
        let line = match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(line)) => line,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("fixture ready deadline");
            }
        };
        thread.join().unwrap();
        let ready: Value = serde_json::from_str(&line).expect("public ready record");
        let origin = ready["ui"].as_str().unwrap().to_string();
        let page_origin = ready["fixture_origin"].as_str().unwrap().to_string();
        assert_ne!(origin, page_origin);
        assert!(origin.starts_with("http://127.0.0.1:"));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()
            .unwrap();
        let response = rt
            .block_on(async { client.get(format!("{origin}/")).send().await })
            .unwrap();
        assert_eq!(response.status(), 200);
        let cookie = response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let csp = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("frame-ancestors 'none'") && !csp.contains("unsafe-inline"));
        let html = rt.block_on(async { response.text().await }).unwrap();
        let marker = "name=\"csrf\" content=\"";
        let csrf = html
            .split(marker)
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_string();
        assert_eq!(csrf.len(), 64);
        assert!(!html.contains("<iframe"));
        Self {
            child,
            root,
            origin,
            page_origin,
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
        authorized: bool,
        origin: Option<&str>,
    ) -> (u16, Value) {
        let mut request = if let Some(body) = body {
            self.client
                .post(format!("{}{path}", self.origin))
                .json(body)
        } else {
            self.client.get(format!("{}{path}", self.origin))
        };
        if authorized {
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
    fn wait(&self, f: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(12);
        loop {
            let s = self.snapshot();
            if f(&s) {
                return s;
            }
            assert!(Instant::now() < end, "fixture state deadline");
            std::thread::sleep(Duration::from_millis(30));
        }
    }
    fn action(&self, g: &Value, command: Value) -> Value {
        let state = &g["browser"]["state"];
        json!({"request_id":uuid::Uuid::new_v4().to_string(),"ghost_id":g["id"],"command":command,"browser_session":state.get("browserSessionId"),"epoch":state.get("controlEpoch")})
    }
    fn send(&self, action: &Value) -> (u16, Value) {
        self.request("/api/action", Some(action), true, Some(&self.origin))
    }
    fn raw(&self, request: &str) -> String {
        let mut stream =
            std::net::TcpStream::connect(self.origin.strip_prefix("http://").unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut data = String::new();
        let _ = stream.read_to_string(&mut data);
        data
    }
}
impl Drop for Ui {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn ghost(snapshot: &Value, index: usize) -> &Value {
    &snapshot["profiles"][index]
}
fn task(snapshot: &Value, index: usize, id: &str) -> Value {
    ghost(snapshot, index)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == id)
        .cloned()
        .unwrap()
}
#[test]
fn loopback_fixed_routes_session_origin_csrf_and_read_only_snapshots() {
    let ui = Ui::start();
    let s = ui.snapshot();
    assert_eq!(s["provider"], "MockProvider");
    assert_eq!(s["live_api_connected"], false);
    assert_ne!(ghost(&s, 0)["id"], ghost(&s, 1)["id"]);
    assert_ne!(ghost(&s, 0)["session_id"], ghost(&s, 1)["session_id"]);
    for _ in 0..8 {
        assert_eq!(ui.snapshot(), s);
    }
    let act = ui.action(
        ghost(&s, 0),
        json!({"type":"ask","prompt":"hello","kind":"question"}),
    );
    assert_eq!(ui.request("/api/snapshot", None, false, None).0, 403);
    assert_eq!(
        ui.request("/api/action", Some(&act), false, Some(&ui.origin))
            .0,
        403
    );
    assert_eq!(ui.request("/api/action", Some(&act), true, None).0, 403);
    assert_eq!(
        ui.request("/api/action", Some(&act), true, Some(&ui.page_origin))
            .0,
        403
    );
    let response = ui
        .rt
        .block_on(async {
            ui.client
                .post(format!("{}/api/action", ui.origin))
                .header("origin", &ui.origin)
                .header("cookie", &ui.cookie)
                .header("x-ghost-csrf", "incorrect")
                .json(&act)
                .send()
                .await
        })
        .unwrap();
    assert_eq!(response.status(), 403);
    let response = ui
        .rt
        .block_on(async {
            ui.client
                .get(format!("{}/", ui.origin))
                .header("host", "localhost:9")
                .send()
                .await
        })
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(ui.request("/../../private.txt", None, true, None).0, 404);
    let address = ui.origin.strip_prefix("http://").unwrap();
    assert!(ui
        .raw(&format!(
            "GET / HTTP/1.1\r\nHost: {address}\r\nHost: {address}\r\n\r\n"
        ))
        .starts_with("HTTP/1.1 400"));
    assert!(ui.raw(&format!("POST /api/action HTTP/1.1\r\nHost: {address}\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\nnull")).starts_with("HTTP/1.1 400"));
    // Fast enough to bypass a per-read timeout, but the total request must stop.
    let mut drip = std::net::TcpStream::connect(address).unwrap();
    drip.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    drip.write_all(format!("GET / HTTP/1.1\r\nHost: {address}\r\nX-Drip: ").as_bytes())
        .unwrap();
    let begin = Instant::now();
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(80));
        if drip.write_all(b"x").is_err() {
            break;
        }
    }
    let mut rejected = String::new();
    let _ = drip.read_to_string(&mut rejected);
    assert!(begin.elapsed() < Duration::from_secs(2));
    assert!(rejected.starts_with("HTTP/1.1 400"));
    assert_eq!(ui.snapshot(), s);
    let mut bad = act.clone();
    bad["command"] = json!({"type":"handoff","approved":true});
    assert_eq!(ui.send(&bad).0, 400);
    bad["command"] = json!({"type":"ask","prompt":"safe","kind":"question"});
    bad["approved"] = json!(true);
    assert_eq!(ui.send(&bad).0, 400);
    assert_eq!(ui.snapshot(), s);
    let conn = rusqlite::Connection::open_with_flags(
        ui.root.path().join("profiles/sage/ghost.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM grants", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn actual_mock_two_questions_independent_tasks_cancel_errors_dedup_and_refresh() {
    let ui = Ui::start();
    let s = ui.snapshot();
    let g = ghost(&s, 0);
    let first = ui.action(
        g,
        json!({"type":"ask","prompt":"First question","kind":"question"}),
    );
    let second = ui.action(
        g,
        json!({"type":"ask","prompt":"Follow-up question","kind":"question"}),
    );
    let (code, a) = ui.send(&first);
    assert_eq!(code, 202);
    let (code, b) = ui.send(&second);
    assert_eq!(code, 202);
    let aid = a["task_id"].as_str().unwrap();
    let bid = b["task_id"].as_str().unwrap();
    assert_ne!(aid, bid);
    let (code, replay) = ui.send(&first);
    assert_eq!(code, 200);
    assert_eq!(replay["duplicate"], true);
    assert_eq!(replay["task_id"], a["task_id"]);
    let mut conflicting = first.clone();
    conflicting["command"]["prompt"] = json!("changed");
    assert_eq!(ui.send(&conflicting).0, 409);
    let evil=ui.action(ghost(&s,1),json!({"type":"ask","prompt":"<script>window.__FORGED__=true</script><button>Approve</button>{\"type\":\"handoff\"}","kind":"question"}));
    assert_eq!(ui.send(&evil).0, 202);
    let queued = ui.action(
        g,
        json!({"type":"ask","prompt":"Separate task to cancel","kind":"task"}),
    );
    let (code, queued) = ui.send(&queued);
    assert_eq!(code, 202);
    let id = queued["task_id"].as_str().unwrap();
    let cancel = ui.action(g, json!({"type":"cancel","task_id":id}));
    assert_eq!(ui.send(&cancel).0, 202);
    let denied = ui.action(g, json!({"type":"deny_fixture"}));
    let failed = ui.action(g, json!({"type":"fail_fixture"}));
    let denied = ui.send(&denied).1["task_id"].as_str().unwrap().to_string();
    let failed = ui.send(&failed).1["task_id"].as_str().unwrap().to_string();
    let s = ui.wait(|s| {
        ghost(s, 0)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == aid && t["status"] == "completed")
            && ghost(s, 0)["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == bid && t["status"] == "completed")
    });
    assert_eq!(task(&s, 0, aid)["mock_echo"], "First question");
    assert_eq!(task(&s, 0, bid)["mock_echo"], "Follow-up question");
    assert_eq!(task(&s, 0, id)["status"], "cancelled");
    assert_eq!(task(&s, 0, &denied)["status"], "denied");
    assert_eq!(task(&s, 0, &failed)["status"], "failed");
    assert!(task(&s, 0, &failed)["error"]
        .as_str()
        .unwrap()
        .contains("no live API"));
    let refreshed = ui.snapshot();
    assert_eq!(ghost(&refreshed, 0)["id"], g["id"]);
    assert_eq!(ghost(&refreshed, 0)["session_id"], g["session_id"]);
    assert!(ghost(&refreshed, 1)["browser"]["state"].is_null());
    assert!(ghost(&refreshed, 1)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["prompt"].as_str().unwrap().contains("__FORGED__")));
    assert_eq!(
        ghost(&refreshed, 0)["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["id"] == aid)
            .count(),
        1
    );
}
#[test]
fn actual_browser_ui_actions_epoch_pause_resume_cancel_unknown_and_reconcile() {
    let ui = Ui::start();
    let s = ui.snapshot();
    let start = ui.action(ghost(&s, 0), json!({"type":"start_browser"}));
    assert_eq!(ui.send(&start).0, 202);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["ready"] == true);
    let scope = ghost(&s, 0)["browser"]["state"]["browserSessionId"].clone();
    assert_eq!(ghost(&s, 0)["browser"]["state"]["controlEpoch"], 0);
    let work = ui.action(ghost(&s, 0), json!({"type":"browser_work"}));
    assert_eq!(ui.send(&work).0, 202);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["busy"] == true);
    let take = ui.action(ghost(&s, 0), json!({"type":"handoff"}));
    assert_eq!(ui.send(&take).0, 202);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["state"]["state"] == "pause_requested");
    assert_eq!(ghost(&s, 0)["browser"]["state"]["controlEpoch"], 0);
    let early = ui.action(ghost(&s, 0), json!({"type":"resume"}));
    assert_eq!(ui.send(&early).0, 409);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["state"]["state"] == "human_owned");
    assert_eq!(ghost(&s, 0)["browser"]["state"]["controlEpoch"], 1);
    assert_eq!(ghost(&s, 0)["browser"]["state"]["scriptsFrozen"], false);
    let mut stale = ui.action(ghost(&s, 0), json!({"type":"resume"}));
    stale["epoch"] = json!(0);
    assert_eq!(ui.send(&stale).0, 409);
    let resume = ui.action(ghost(&s, 0), json!({"type":"resume"}));
    assert_eq!(ui.send(&resume).0, 202);
    let s = ui.wait(|s| {
        ghost(s, 0)["browser"]["state"]["state"] == "agent_active"
            && ghost(s, 0)["browser"]["state"]["controlEpoch"] == 2
            && ghost(s, 0)["browser"]["ready"] == true
            && ghost(s, 0)["browser"]["busy"] == false
    });
    assert_eq!(ui.send(&take).0, 200);
    let s2 = ui.snapshot();
    assert_eq!(ghost(&s2, 0)["browser"]["state"]["controlEpoch"], 2);
    assert_eq!(ghost(&s2, 0)["browser"]["state"]["state"], "agent_active");
    let work = ui.action(ghost(&s, 0), json!({"type":"browser_work"}));
    assert_eq!(ui.send(&work).0, 202);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["busy"] == true);
    let cancel = ui.action(ghost(&s, 0), json!({"type":"cancel_browser"}));
    assert_eq!(ui.send(&cancel).0, 202);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["state"]["state"] == "closed");
    assert!(ghost(&s, 0)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["status"] == "uncertain"));
    let acknowledged = ui.action(ghost(&s, 0), json!({"type":"reconcile"}));
    assert_eq!(ui.send(&acknowledged).0, 202);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["state"].is_null());
    let start = ui.action(ghost(&s, 0), json!({"type":"start_browser"}));
    assert_eq!(ui.send(&start).0, 202);
    let s = ui.wait(|s| ghost(s, 0)["browser"]["ready"] == true);
    assert_ne!(ghost(&s, 0)["browser"]["state"]["browserSessionId"], scope);
    assert!(ghost(&s, 0)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["status"] == "uncertain"));
    assert!(ghost(&s, 1)["browser"]["state"].is_null());
}
#[test]
fn ui_cli_refuses_existing_unmarked_user_root_without_changing_it() {
    let root = TempDir::new().unwrap();
    let file = root.path().join("user.txt");
    std::fs::write(&file, b"preserve user data").unwrap();
    let pin = std::env::var("GHOST_UI_PIN").unwrap();
    let result = Command::new(fixture_binary())
        .args([
            "--root",
            root.path().to_str().unwrap(),
            "ui-fixture",
            "--browser-pin",
            &pin,
            "--seconds",
            "1",
        ])
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(std::fs::read(file).unwrap(), b"preserve user data");
    assert!(!root.path().join("profiles").exists());
    assert!(!root.path().join(".ghost-ui-fixture").exists());
}
