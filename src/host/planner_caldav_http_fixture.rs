//! Test-only anonymous localhost HTTP fixture/proxy. Never a shipped server.
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}
pub async fn request(socket: &mut TcpStream) -> Request {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 16384);
        bytes.push(socket.read_u8().await.unwrap());
    }
    let text = std::str::from_utf8(&bytes).unwrap();
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap().split_whitespace();
    let method = first.next().unwrap().to_string();
    let path = first.next().unwrap().to_string();
    let headers = lines
        .filter_map(|l| {
            l.split_once(':')
                .map(|(k, v)| (k.to_lowercase(), v.trim().to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    assert!(
        !headers.contains_key("authorization"),
        "fixture must never receive account credentials"
    );
    let length = headers
        .get("content-length")
        .map(|s| s.parse::<usize>().unwrap())
        .unwrap_or(0);
    assert!(length <= 1_048_576);
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await.unwrap();
    Request {
        method,
        path,
        headers,
        body,
    }
}
pub fn reply(code: u16, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {code} Fixture\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
pub struct Scripted {
    pub url: String,
    pub log: Arc<Mutex<Vec<Request>>>,
    task: JoinHandle<()>,
}
impl Scripted {
    /// Deliver status/headers before delaying the body. Independent response
    /// tasks allow the client to requery after the first body times out.
    pub async fn start_body_delayed(responses: Vec<(String, Duration)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let recorded = log.clone();
        let task = tokio::spawn(async move {
            let mut replies = tokio::task::JoinSet::new();
            for (response, delay) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let observed = request(&mut socket).await;
                recorded.lock().unwrap().push(observed);
                replies.spawn(async move {
                    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
                    let _ = socket.write_all(headers.as_bytes()).await;
                    let _ = socket.write_all(b"\r\n\r\n").await;
                    let _ = socket.flush().await;
                    tokio::time::sleep(delay).await;
                    let _ = socket.write_all(body.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
            while replies.join_next().await.is_some() {}
        });
        Self { url, log, task }
    }
    pub async fn start(responses: Vec<(String, Duration)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let recorded = log.clone();
        let task = tokio::spawn(async move {
            for (response, delay) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let observed = request(&mut socket).await;
                recorded.lock().unwrap().push(observed);
                tokio::time::sleep(delay).await;
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        Self { url, log, task }
    }
}
impl Drop for Scripted {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct FaultProxy {
    pub url: String,
    pub log: Arc<Mutex<Vec<Request>>>,
    pub lose_put: Arc<AtomicBool>,
    pub fail_scan: Arc<AtomicBool>,
    pub responses: Arc<Mutex<Vec<(String, u16)>>>,
    task: JoinHandle<()>,
}
impl FaultProxy {
    pub async fn start(upstream: &str) -> Self {
        assert!(upstream.starts_with("http://127.0.0.1:"));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (log, lose_put, fail_scan) = (
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        );
        let (records, lose, fail) = (log.clone(), lose_put.clone(), fail_scan.clone());
        let responses = Arc::new(Mutex::new(Vec::new()));
        let statuses = responses.clone();
        let upstream = upstream.to_string();
        let task = tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .pool_max_idle_per_host(0)
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let req = request(&mut socket).await;
                assert!(
                    req.path.starts_with("/fixture/")
                        && !req.path.contains("..")
                        && !req.path.contains('%')
                );
                records.lock().unwrap().push(req.clone());
                if req.method == "PROPFIND" && fail.swap(false, Ordering::SeqCst) {
                    statuses.lock().unwrap().push((req.method.clone(), 503));
                    let _ = socket.write_all(reply(503, "", "").as_bytes()).await;
                    continue;
                }
                let mut builder = client.request(
                    reqwest::Method::from_bytes(req.method.as_bytes()).unwrap(),
                    format!("{upstream}{}", req.path),
                );
                for name in [
                    "depth",
                    "content-type",
                    "if-match",
                    "if-none-match",
                    "accept",
                    "accept-encoding",
                ] {
                    if let Some(value) = req.headers.get(name) {
                        builder = builder.header(name, value);
                    }
                }
                let response = builder.body(req.body).send().await.unwrap();
                let status = response.status().as_u16();
                statuses.lock().unwrap().push((req.method.clone(), status));
                let mut headers = String::new();
                for name in ["etag", "content-type"] {
                    if let Some(value) = response.headers().get(name) {
                        headers.push_str(&format!("{name}: {}\r\n", value.to_str().unwrap()));
                    }
                }
                let body = response.text().await.unwrap();
                assert!(body.len() <= 4_194_304);
                if req.method == "PUT" && lose.swap(false, Ordering::SeqCst) {
                    drop(socket);
                    continue;
                }
                let _ = socket
                    .write_all(reply(status, &headers, &body).as_bytes())
                    .await;
                let _ = socket.shutdown().await;
            }
        });
        Self {
            url,
            log,
            lose_put,
            fail_scan,
            responses,
            task,
        }
    }
}
impl Drop for FaultProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
