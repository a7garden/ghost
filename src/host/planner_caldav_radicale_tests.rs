//! Opt-in actual Radicale 3.8.1 process; scratch storage and localhost only.
use super::fixture::FaultProxy;
use super::*;
use crate::control::api::{Action, Command, OwnerAction};
use crate::host::planner_sync::{
    self as planner,
    fixtures::{configure_fixture, ics, mutation, owner},
    Host, Kind, Verb,
};
use std::{
    path::PathBuf,
    process::{Child, Command as Process, Stdio},
    sync::{atomic::Ordering, Arc},
};

struct Radicale {
    root: tempfile::TempDir,
    python: PathBuf,
    config: PathBuf,
    base: String,
    child: Option<Child>,
    client: Client,
}
impl Radicale {
    async fn new() -> Self {
        let python = PathBuf::from(
            std::env::var("GHOST_RADICALE_TEST_PYTHON")
                .expect("set isolated fixture Python; never install from a test"),
        );
        assert!(python.is_absolute());
        let version = Process::new(&python)
            .args(["-m", "radicale", "--version"])
            .env_clear()
            .env("PYTHONNOUSERSITE", "1")
            .output()
            .unwrap();
        assert!(version.status.success());
        assert_eq!(
            String::from_utf8(version.stdout).unwrap().trim(),
            "3.8.1",
            "fixture is pinned, not a claim about all versions"
        );
        let root = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = root.path().join("radicale.conf");
        std::fs::write(&config,format!("[server]\nhosts=127.0.0.1:{port}\nmax_content_length=2097152\nmax_resource_size=1048576\ntimeout=3\n[auth]\ntype=none\n[rights]\ntype=authenticated\npermit_delete_collection=false\npermit_overwrite_collection=false\n[storage]\nfilesystem_folder={}\n[web]\ntype=none\n[logging]\nlevel=error\n",root.path().join("collections").display())).unwrap();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .pool_max_idle_per_host(0)
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let mut fixture = Self {
            root,
            python,
            config,
            base: format!("http://127.0.0.1:{port}"),
            child: None,
            client,
        };
        fixture.start().await;
        let result = fixture
            .client
            .request(
                Method::from_bytes(b"MKCOL").unwrap(),
                format!("{}/fixture/", fixture.base),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(result.status().as_u16(), 201);
        fixture
    }
    async fn start(&mut self) {
        assert!(self.child.is_none());
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.path().join("server.log"))
            .unwrap();
        self.child = Some(
            Process::new(&self.python)
                .args(["-m", "radicale", "--config"])
                .arg(&self.config)
                .env_clear()
                .env("PYTHONNOUSERSITE", "1")
                .env("PYTHONDONTWRITEBYTECODE", "1")
                .env("TZ", "UTC")
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap(),
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(code) = self.child.as_mut().unwrap().try_wait().unwrap() {
                    panic!(
                        "fixture startup failed: {code}: {}",
                        std::fs::read_to_string(self.root.path().join("server.log")).unwrap()
                    );
                }
                if self
                    .client
                    .request(Method::OPTIONS, &self.base)
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }
    async fn calendar(&self, name: &str, kind: &str) {
        assert!(matches!(name, "events" | "todos"));
        let xml=format!("<?xml version=\"1.0\"?><C:mkcalendar xmlns:C=\"urn:ietf:params:xml:ns:caldav\" xmlns:D=\"DAV:\"><D:set><D:prop><C:supported-calendar-component-set><C:comp name=\"{kind}\"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>");
        let result = self
            .client
            .request(
                Method::from_bytes(b"MKCALENDAR").unwrap(),
                format!("{}/fixture/{name}/", self.base),
            )
            .header(header::CONTENT_TYPE, "application/xml")
            .body(xml)
            .send()
            .await
            .unwrap();
        assert_eq!(
            result.status().as_u16(),
            201,
            "{}",
            result.text().await.unwrap()
        );
    }
    async fn get(&self, cid: &str, href: &str) -> (String, String) {
        let response = self
            .client
            .get(format!("{}/fixture/{cid}/{href}", self.base))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();
        (etag, response.text().await.unwrap())
    }
    async fn put(&self, cid: &str, href: &str, raw: String, etag: Option<&str>) -> u16 {
        let mut request = self
            .client
            .put(format!("{}/fixture/{cid}/{href}", self.base))
            .header(header::CONTENT_TYPE, "text/calendar")
            .body(raw);
        request = if let Some(etag) = etag {
            request.header(header::IF_MATCH, etag)
        } else {
            request.header(header::IF_NONE_MATCH, "*")
        };
        let response = request.send().await.unwrap();
        let code = response.status().as_u16();
        assert!(
            matches!(code, 201 | 204),
            "external fixture mutation failed: {code}: {}",
            response.text().await.unwrap()
        );
        code
    }
}
impl Drop for Radicale {
    fn drop(&mut self) {
        self.stop();
    }
}
fn host(root: &std::path::Path) -> Arc<Host> {
    Host::open(root, tokio::runtime::Handle::current(), Some("mock")).unwrap()
}
fn row(app: &Arc<Host>, cid: &str, uid: &str) -> planner::Resource {
    planner::resource(&app.lock().unwrap().journal.0, cid, uid)
        .unwrap()
        .unwrap()
}
fn adapter(proxy: &FaultProxy, cid: &str) -> HttpAdapter {
    HttpAdapter::loopback_fixture(
        &format!("fixture:{cid}"),
        &format!("{}/fixture/{cid}/", proxy.url),
        Duration::from_secs(3),
    )
    .unwrap()
}
fn enqueue(app: &Arc<Host>, m: planner::Mutation) -> serde_json::Value {
    let r = owner(app, OwnerAction::PlannerMutation { mutation: m });
    assert_eq!(r["ok"], true, "{r}");
    r["result"].clone()
}
fn write_count(proxy: &FaultProxy) -> usize {
    proxy
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|r| matches!(r.method.as_str(), "PUT" | "DELETE"))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit isolated Radicale 3.8.1 Python and localhost socket permission"]
async fn caldav_radicale_actual_http_event_todo_complete_conflict_delete_and_windows() {
    let mut server = Radicale::new().await;
    server.calendar("events", "VEVENT").await;
    server.calendar("todos", "VTODO").await;
    let proxy = FaultProxy::start(&server.base).await;
    let root = tempfile::tempdir().unwrap();
    let app = host(root.path());
    for (cid, kind) in [("events", Kind::Event), ("todos", Kind::Todo)] {
        configure_fixture(&app, cid, kind, vec![]);
        assert_eq!(
            app.planner_pull(cid, &adapter(&proxy, cid)).await.unwrap()["observed"],
            0
        );
    }
    let mut events = Vec::new();
    for (title, start, end) in [
        ("near", "20261003T090000Z", "20261003T100000Z"),
        ("far", "20270103T090000Z", "20270103T100000Z"),
    ] {
        let queued = enqueue(
            &app,
            mutation(
                "events",
                None,
                None,
                Verb::Create,
                serde_json::json!({"title":title,"start_ms":planner::parse_utc(start).unwrap(),"end_ms":planner::parse_utc(end).unwrap()}),
            ),
        );
        assert_eq!(queued["phase"], "queued");
        assert_eq!(queued["remote_applied"], false);
        let id = queued["operation_id"].as_str().unwrap();
        let uid = queued["uid"].as_str().unwrap().to_string();
        assert_eq!(
            app.planner_dispatch(id, &adapter(&proxy, "events"))
                .await
                .unwrap()["phase"],
            "synced"
        );
        events.push(uid);
    }
    let queued = enqueue(
        &app,
        mutation(
            "todos",
            None,
            None,
            Verb::Create,
            serde_json::json!({"title":"due only","due":"2026-10-03"}),
        ),
    );
    let todo = queued["uid"].as_str().unwrap();
    let id = queued["operation_id"].as_str().unwrap();
    assert_eq!(
        app.planner_dispatch(id, &adapter(&proxy, "todos"))
            .await
            .unwrap()["phase"],
        "synced"
    );
    let todo_row = row(&app, "todos", todo);
    let original_etag = todo_row.etag.clone().unwrap();
    assert!(todo_row
        .raw
        .as_ref()
        .unwrap()
        .contains("DUE;VALUE=DATE:20261003"));
    assert!(!todo_row.raw.as_ref().unwrap().contains("DTSTART"));
    assert!(!todo_row.raw.as_ref().unwrap().contains("VEVENT"));
    let requests_before = proxy.log.lock().unwrap().len();
    for (start, end) in [
        ("20261003T000000Z", "20261004T000000Z"),
        ("20270103T000000Z", "20270104T000000Z"),
    ] {
        let value = owner(
            &app,
            OwnerAction::ListConnectedPlanner {
                collection_id: "events".into(),
                from_ms: Some(planner::parse_utc(start).unwrap()),
                to_ms: Some(planner::parse_utc(end).unwrap()),
            },
        );
        assert_eq!(value["result"]["items"].as_array().unwrap().len(), 1);
    }
    assert_eq!(
        proxy.log.lock().unwrap().len(),
        requests_before,
        "date queries never issue DAV inventory requests"
    );
    assert_eq!(
        app.planner_pull("events", &adapter(&proxy, "events"))
            .await
            .unwrap()["observed"],
        2
    );
    assert!(!row(&app, "events", &events[1]).tombstone);
    let near = row(&app, "events", &events[0]);
    let patch = enqueue(
        &app,
        mutation(
            "events",
            Some(&events[0]),
            Some(near.version),
            Verb::Patch,
            serde_json::json!({"title":"near edited"}),
        ),
    );
    assert_eq!(
        app.planner_dispatch(
            patch["operation_id"].as_str().unwrap(),
            &adapter(&proxy, "events")
        )
        .await
        .unwrap()["phase"],
        "synced"
    );
    assert_ne!(row(&app, "events", &events[0]).etag, near.etag);
    let complete = enqueue(
        &app,
        mutation(
            "todos",
            Some(todo),
            Some(todo_row.version),
            Verb::Complete,
            serde_json::json!({}),
        ),
    );
    assert_eq!(
        app.planner_dispatch(
            complete["operation_id"].as_str().unwrap(),
            &adapter(&proxy, "todos")
        )
        .await
        .unwrap()["phase"],
        "synced"
    );
    let done = row(&app, "todos", todo);
    assert!(done.view.completed);
    assert_eq!(done.view.due.as_deref(), Some("2026-10-03"));
    assert_ne!(done.etag.as_deref(), Some(original_etag.as_str()));
    assert!(!done.read_only);
    // External synthetic records retain unsupported schema exactly and become
    // read-only; neither completion nor deletion may write them remotely.
    server
        .put(
            "todos",
            "unknown.ics",
            ics("unknown", Kind::Todo, "X-OPAQUE:original source data\r\n"),
            None,
        )
        .await;
    server
        .put(
            "events",
            "repeat.ics",
            ics(
                "repeat",
                Kind::Event,
                "DTSTART:20261003T090000Z\r\nDTEND:20261003T100000Z\r\nRRULE:FREQ=WEEKLY\r\n",
            ),
            None,
        )
        .await;
    for (cid, uid) in [("todos", "unknown"), ("events", "repeat")] {
        app.planner_pull(cid, &adapter(&proxy, cid)).await.unwrap();
        let r = row(&app, cid, uid);
        let remote_raw = server.get(cid, &r.href).await.1;
        assert_eq!(r.raw.as_deref(), Some(remote_raw.as_str()));
        assert!(r.read_only);
        let before = write_count(&proxy);
        for verb in [Verb::Patch, Verb::Complete, Verb::Delete] {
            let changes = if verb == Verb::Patch {
                serde_json::json!({"title":"denied"})
            } else {
                serde_json::json!({})
            };
            assert_eq!(
                owner(
                    &app,
                    OwnerAction::PlannerMutation {
                        mutation: mutation(cid, Some(uid), Some(r.version), verb, changes)
                    }
                )["ok"],
                false
            );
        }
        assert_eq!(write_count(&proxy), before);
        assert_eq!(server.get(cid, &r.href).await.1, remote_raw);
    }
    let near = row(&app, "events", &events[0]);
    let pending = enqueue(
        &app,
        mutation(
            "events",
            Some(&events[0]),
            Some(near.version),
            Verb::Patch,
            serde_json::json!({"title":"local choice"}),
        ),
    );
    let external = near
        .raw
        .as_ref()
        .unwrap()
        .replace("SUMMARY:near edited", "SUMMARY:remote choice");
    server
        .put("events", &near.href, external, near.etag.as_deref())
        .await;
    let conflict = app
        .planner_dispatch(
            pending["operation_id"].as_str().unwrap(),
            &adapter(&proxy, "events"),
        )
        .await
        .unwrap();
    assert_eq!(conflict["phase"], "conflict");
    assert_eq!(conflict["write_outcome"], "precondition_failed");
    assert_eq!(conflict["remote_applied"], false);
    assert!(
        proxy
            .responses
            .lock()
            .unwrap()
            .iter()
            .any(|(m, status)| m == "PUT" && *status == 412),
        "412 came from actual Radicale HTTP"
    );
    let before = write_count(&proxy);
    assert_eq!(
        app.planner_dispatch(
            pending["operation_id"].as_str().unwrap(),
            &adapter(&proxy, "events")
        )
        .await
        .unwrap(),
        conflict
    );
    assert_eq!(write_count(&proxy), before);
    let far = row(&app, "events", &events[1]);
    let deleted = enqueue(
        &app,
        mutation(
            "events",
            Some(&events[1]),
            Some(far.version),
            Verb::Delete,
            serde_json::json!({}),
        ),
    );
    assert_eq!(
        app.planner_dispatch(
            deleted["operation_id"].as_str().unwrap(),
            &adapter(&proxy, "events")
        )
        .await
        .unwrap()["phase"],
        "synced"
    );
    assert!(row(&app, "events", &events[1]).tombstone);
    assert!(!row(&app, "events", &events[0]).tombstone);
    assert!(adapter(&proxy, "events")
        .observe_uid(&events[1])
        .await
        .unwrap()
        .is_none());
    assert!(app.snapshot().unwrap()["todos"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(app.snapshot().unwrap()["calendar_events"]
        .as_array()
        .unwrap()
        .is_empty());
    eprintln!(
        "RADICALE_HTTP_LIFECYCLE {}",
        serde_json::json!({"version":"3.8.1","loopback":true,"date_query_requests":0,"due_only":true,"unknown_repeat_writes":0,"conflict":conflict,"actual_statuses":*proxy.responses.lock().unwrap()})
    );
    app.shutdown().await.unwrap();
    server.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit isolated Radicale 3.8.1 Python and localhost socket permission"]
async fn caldav_radicale_lost_http_reply_host_and_server_restart_never_duplicate_put() {
    let mut server = Radicale::new().await;
    server.calendar("todos", "VTODO").await;
    let proxy = FaultProxy::start(&server.base).await;
    let root = tempfile::tempdir().unwrap();
    let app = host(root.path());
    configure_fixture(&app, "todos", Kind::Todo, vec![]);
    let request_id = uuid::Uuid::new_v4().to_string();
    let m = mutation(
        "todos",
        None,
        None,
        Verb::Create,
        serde_json::json!({"title":"restart synthetic","due":"2026-10-03"}),
    );
    let action = || Action {
        request_id: request_id.clone(),
        command: Command::Workspace {
            action: OwnerAction::PlannerMutation {
                mutation: m.clone(),
            },
        },
    };
    let admission = app.action(action()).unwrap();
    let id = admission["result"]["operation_id"].as_str().unwrap();
    let uid = admission["result"]["uid"].as_str().unwrap();
    proxy.lose_put.store(true, Ordering::SeqCst);
    proxy.fail_scan.store(true, Ordering::SeqCst);
    let first = app
        .planner_dispatch(id, &adapter(&proxy, "todos"))
        .await
        .unwrap();
    assert_eq!(first["phase"], "uncertain");
    assert_eq!(first["remote_applied"], false);
    assert_eq!(first["write_outcome"], "unknown");
    assert_eq!(write_count(&proxy), 1);
    assert!(proxy
        .responses
        .lock()
        .unwrap()
        .iter()
        .any(|(m, status)| m == "PUT" && *status == 201));
    app.shutdown().await.unwrap();
    drop(app);
    server.stop();
    server.start().await;
    let app = host(root.path());
    let status = app
        .planner_dispatch(id, &adapter(&proxy, "todos"))
        .await
        .unwrap();
    assert_eq!(status["phase"], "synced");
    assert_eq!(status["remote_applied"], true);
    assert_eq!(status["write_outcome"], "unknown");
    assert_eq!(status["uid"], uid);
    assert_eq!(status["operation_id"], id);
    assert_eq!(
        app.action(action()).unwrap(),
        admission,
        "original admission remains queued/false after remote confirmation"
    );
    app.planner_dispatch(id, &adapter(&proxy, "todos"))
        .await
        .unwrap();
    assert_eq!(write_count(&proxy), 1);
    let inv = adapter(&proxy, "todos").inventory().await.unwrap();
    assert_eq!(inv.items.len(), 1);
    assert_eq!(inv.items[0].uid, uid);
    assert_eq!(
        planner::operations(&app.lock().unwrap().journal.0, "todos")
            .unwrap()
            .len(),
        1
    );
    eprintln!(
        "RADICALE_RESTART_RECOVERY {}",
        serde_json::json!({"version":"3.8.1","host_restarted":true,"server_restarted":true,"put_count":1,"same_uid":uid,"immutable_admission":admission["result"],"live_status":status,"actual_statuses":*proxy.responses.lock().unwrap()})
    );
    app.shutdown().await.unwrap();
    server.stop();
}
