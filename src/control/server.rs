use super::{api::Action, metadata};
use crate::{host::Host, local_http as http};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
#[cfg(feature = "workspace-ui")]
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    net::{Shutdown, TcpListener, TcpStream},
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(feature = "workspace-ui")]
use crate::workspace::{CSS, INDEX, JS, TOKENS, WORKFLOWS};

const REQUEST_BODY_LIMIT: usize = 8 * 1_048_576;
const MAX_CONNECTIONS: usize = 32;

/// Serve the host on loopback. The host process owns all profile stores while
/// this transport is alive; clients use the protected discovery file.
pub fn serve(root: &Path, port: u16, model: Option<&str>, with_ui: bool) -> Result<()> {
    #[cfg(not(feature = "workspace-ui"))]
    if with_ui {
        return Err(anyhow!(
            "this build does not include the workspace UI; pass --headless"
        ));
    }

    let rt = tokio::runtime::Runtime::new()?;
    let root = metadata::canonical_root(root, true)?;
    let host = Host::open(&root, rt.handle().clone(), model)?;
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(error) => {
            let _ = rt.block_on(host.shutdown());
            return Err(error.into());
        }
    };
    let actual_port = match listener
        .set_nonblocking(true)
        .and_then(|_| listener.local_addr())
    {
        Ok(address) => address.port(),
        Err(error) => {
            let _ = rt.block_on(host.shutdown());
            return Err(error.into());
        }
    };
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let started_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if let Err(error) = metadata::write(&root, actual_port, token.clone(), started_ms) {
        let _ = rt.block_on(host.shutdown());
        return Err(error);
    }
    let session = Arc::new(http::Session::new_with_control_token(
        actual_port,
        "ghost_workspace_sid",
        token.clone(),
    ));
    let readiness_result = (|| -> Result<()> {
        if with_ui {
            let readiness = json!({
                "ui": session.origin,
                "mode": "durable_workspace",
                "default_model": host.default_model(),
                "auto_open": false
            });
            writeln!(std::io::stdout().lock(), "{readiness}")?;
        } else {
            let readiness = json!({
                "protocol": metadata::PROTOCOL,
                "protocol_version": metadata::VERSION,
                "endpoint": session.origin,
                "mode": "headless",
                "default_model": host.default_model()
            });
            writeln!(std::io::stdout().lock(), "{readiness}")?;
        }
        std::io::stdout().flush()?;
        Ok(())
    })();
    if let Err(error) = readiness_result {
        metadata::remove_if_owned(&root, &token);
        let _ = rt.block_on(host.shutdown());
        return Err(error);
    }

    let result = rt.block_on(accept_until_shutdown(
        listener,
        host.clone(),
        session,
        with_ui,
    ));
    metadata::remove_if_owned(&root, &token);
    result?;
    Ok(())
}

async fn accept_until_shutdown(
    listener: TcpListener,
    host: Arc<Host>,
    session: Arc<http::Session>,
    with_ui: bool,
) -> Result<()> {
    let signal = shutdown_signal();
    tokio::pin!(signal);
    let mut requests: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut handler_panicked = false;
    let mut accept_error = None;
    loop {
        let mut active = Vec::with_capacity(requests.len());
        for request in requests.drain(..) {
            if request.is_finished() {
                handler_panicked |= request.join().is_err();
            } else {
                active.push(request);
            }
        }
        requests = active;
        if handler_panicked {
            break;
        }
        tokio::select! {
            received = &mut signal => {
                if let Err(error) = received {
                    accept_error = Some(error.into());
                }
                break;
            }
            accepted = accept(&listener) => {
                let (mut peer, address) = match accepted {
                    Ok(peer) => peer,
                    Err(error) => {
                        accept_error = Some(error);
                        break;
                    }
                };
                if !address.ip().is_loopback() {
                    let _ = peer.shutdown(Shutdown::Both);
                    continue;
                }
                if requests.len() >= MAX_CONNECTIONS {
                    let _ = peer.shutdown(Shutdown::Both);
                    continue;
                }
                let host = host.clone();
                let session = session.clone();
                let handler = std::thread::Builder::new()
                    .name("ghost-control-request".into())
                    .spawn(move || {
                    let result = http::read_with_limit(&mut peer, REQUEST_BODY_LIMIT)
                        .and_then(|request| route(&mut peer, &request, &session, &host, with_ui));
                    if result.is_err() {
                        let _ = http::respond(
                            &mut peer,
                            400,
                            "application/json",
                            br#"{"ok":false,"error":"invalid_request"}"#,
                            None,
                        );
                    }
                    let _ = peer.shutdown(Shutdown::Both);
                });
                match handler {
                    Ok(handler) => requests.push(handler),
                    Err(error) => {
                        accept_error = Some(error.into());
                        break;
                    }
                }
            }
        }
    }

    drop(listener);
    // Flip the host's stopping flag before draining accepted handlers. This
    // rejects mutations that have not started while allowing already-committed
    // actions to finish and write their receipts before their threads join.
    let shutdown = host.shutdown().await;
    // No new sockets are accepted after Ctrl-C. Join every accepted handler so
    // an in-flight action can finish its durable receipt before the host and
    // runtime are shut down. The number of handlers is capped above.
    for request in requests {
        handler_panicked |= request.join().is_err();
    }
    if handler_panicked {
        return Err(anyhow!("control request handler panicked"));
    }
    if let Some(error) = accept_error {
        return Err(error);
    }
    shutdown?;
    Ok(())
}

/// Service managers send SIGTERM, while an interactive terminal sends SIGINT.
/// Both use the drain/checkpoint path before removing discovery.
async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}

async fn accept(listener: &TcpListener) -> Result<(TcpStream, std::net::SocketAddr)> {
    loop {
        match listener.accept() {
            Ok(peer) => return Ok(peer),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn route(
    peer: &mut TcpStream,
    request: &http::Request,
    session: &http::Session,
    host: &Arc<Host>,
    with_ui: bool,
) -> Result<()> {
    if !session.host_ok(request)
        || request
            .headers
            .get("origin")
            .is_some_and(|value| value != &session.origin)
        || request
            .headers
            .get("sec-fetch-site")
            .is_some_and(|value| value != "same-origin" && value != "none")
    {
        return denied(peer);
    }

    if request.method == "GET" && request.target.starts_with("/api/v1/bootstrap/") {
        let nonce = request.target.trim_start_matches("/api/v1/bootstrap/");
        if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return respond_json(
                peer,
                400,
                &json!({"ok": false, "error": "invalid_bootstrap_challenge"}),
            );
        }
        return respond_json(
            peer,
            200,
            &json!({
                "protocol": metadata::PROTOCOL,
                "version": metadata::VERSION,
                "proof": session.bootstrap_proof(nonce),
                "mode": if with_ui { "workspace" } else { "headless" },
                "endpoints": {
                    "bootstrap": "/api/v1/bootstrap/{nonce}",
                    "snapshot": "/api/v1/snapshot",
                    "events": "/api/v1/events/{profile_id}/{after}",
                    "action": "/api/v1/action"
                },
                "capabilities": ["snapshot", "events", "action"]
            }),
        );
    }
    #[cfg(feature = "lifetime")]
    if request.method == "POST" && matches!(request.target.as_str(), "/api/v1/pi/action" | "/api/v1/pi/local-action" | "/api/v1/pi/selected-action") {
        let local = request.target == "/api/v1/pi/local-action";
        let credential = if local {
            host.pi_local_route.as_ref().map(|route| route.callback_token.as_str())
        } else { Some(host.pi_callback_token.as_str()) };
        let Some(credential) = credential else { return denied(peer); };
        if !session.control_authorized_with_token(request, true, credential) {
            return denied(peer);
        }
        if request.body.len() > 1_048_576 {
            return respond_json(peer, 413, &json!({"ok":false,"error":"Pi callback frame limit"}));
        }
        let input = serde_json::from_slice::<crate::host::lifetime::PiToolRequest>(&request.body);
        return match input {
            Ok(input) => respond_result(peer, host.handle.block_on(host.lifetime_pi_action(&input,
                if local { crate::host::lifetime::PiInferenceScope::Local }
                else if request.target == "/api/v1/pi/selected-action" { crate::host::lifetime::PiInferenceScope::Selected }
                else { crate::host::lifetime::PiInferenceScope::Public }))),
            Err(_) => respond_json(peer, 400, &json!({"ok":false,"error":"invalid Pi callback envelope"})),
        };
    }

    #[cfg(feature = "lifetime")]
    if request.target == "/api/v1/inference/settings" {
        if request.method == "GET" && session.control_authorized(request, false) {
            return respond_result(peer, host.inference_settings());
        }
        if request.method == "POST" && session.control_authorized(request, true) {
            if request.body.len() > 16_384 { return respond_json(peer,413,&json!({"ok":false,"error":"inference frame limit"})); }
            // This credential ingress deliberately bypasses the action journal.
            // Only redacted metadata is committed by configure_inference.
            return match serde_json::from_slice::<Value>(&request.body) {
                Ok(value) => respond_result(peer,host.configure_inference(&value)),
                Err(_) => respond_json(peer,400,&json!({"ok":false,"error":"invalid inference configuration"})),
            };
        }
        return denied(peer);
    }

    match (request.method.as_str(), request.target.as_str()) {
        ("GET", "/api/v1/snapshot") if session.control_authorized(request, false) => {
            return respond_result(peer, host.snapshot());
        }
        ("POST", "/api/v1/action") if session.control_authorized(request, true) => {
            return action(peer, request, host);
        }
        (
            "POST",
            "/api/v1/voice/config" | "/api/v1/voice/transcribe" | "/api/v1/voice/synthesize",
        ) if session.control_authorized(request, true) => {
            return voice(peer, request, host);
        }
        _ => {}
    }

    if request.method == "GET"
        && request.target.starts_with("/api/v1/events/")
        && session.control_authorized(request, false)
    {
        let parts = request
            .target
            .trim_start_matches("/api/v1/events/")
            .split('/')
            .collect::<Vec<_>>();
        if parts.len() != 2
            || uuid::Uuid::parse_str(parts[0]).is_err()
            || parts[1].parse::<u64>().is_err()
        {
            return respond_json(
                peer,
                400,
                &json!({"ok": false, "error": "invalid_event_cursor"}),
            );
        }
        let after = parts[1].parse::<u64>()?;
        return respond_result(peer, host.events(parts[0], after));
    }

    #[cfg(feature = "workspace-ui")]
    if request.method == "GET"
        && request.target.starts_with("/api/snapshot/")
        && with_ui
        && session.authorized(request, false)
    {
        let parts = request
            .target
            .trim_start_matches("/api/snapshot/")
            .split('/')
            .collect::<Vec<_>>();
        if parts.len() != 2 || parts.iter().any(|id| uuid::Uuid::parse_str(id).is_err()) {
            return respond_json(
                peer,
                400,
                &json!({"ok": false, "error": "invalid_snapshot_selection"}),
            );
        }
        let mut data = match host.snapshot_for(Some((parts[0], parts[1]))) {
            Ok(value) => value,
            Err(error) => {
                return respond_json(peer, 409, &json!({"ok": false, "error": error.to_string()}))
            }
        };
        let revision = digest(data.to_string().as_bytes());
        if request.headers.get("x-ghost-revision") == Some(&revision) {
            return http::respond(peer, 204, "application/json", b"", None);
        }
        data["revision_token"] = json!(revision);
        return respond_json(peer, 200, &data);
    }

    if with_ui {
        #[cfg(feature = "workspace-ui")]
        match (request.method.as_str(), request.target.as_str()) {
            ("GET", "/") => {
                return http::respond(
                    peer,
                    200,
                    "text/html; charset=utf-8",
                    session.root(INDEX).as_bytes(),
                    Some(&session.cookie(86_400)),
                )
            }
            ("GET", "/style.css") => {
                return http::respond(peer, 200, "text/css; charset=utf-8", CSS.as_bytes(), None)
            }
            ("GET", "/tokens.css") => {
                return http::respond(
                    peer,
                    200,
                    "text/css; charset=utf-8",
                    TOKENS.as_bytes(),
                    None,
                )
            }
            ("GET", "/app.js") => {
                return http::respond(
                    peer,
                    200,
                    "text/javascript; charset=utf-8",
                    JS.as_bytes(),
                    None,
                )
            }
            ("GET", "/workflows.js") => {
                return http::respond(
                    peer,
                    200,
                    "text/javascript; charset=utf-8",
                    WORKFLOWS.as_bytes(),
                    None,
                )
            }
            ("GET", "/api/snapshot") if session.authorized(request, false) => {
                return respond_result(peer, host.snapshot_ui())
            }
            ("POST", "/api/action") if session.authorized(request, true) => {
                return action(peer, request, host)
            }
            (_, "/api/snapshot" | "/api/action") => return denied(peer),
            _ => {}
        }
    }

    if request.target.starts_with("/api/") {
        return denied(peer);
    }
    http::respond(
        peer,
        404,
        "application/json",
        br#"{"ok":false,"error":"not_found"}"#,
        None,
    )
}

/// Audio is ephemeral and deliberately bypasses durable command receipts.
fn voice(peer: &mut TcpStream, request: &http::Request, host: &Arc<Host>) -> Result<()> {
    if request.body.len() > crate::host::voice::MAX_REQUEST_BYTES {
        return respond_json(
            peer,
            413,
            &json!({"ok": false, "error": "음성 요청 크기를 줄여 주세요."}),
        );
    }
    let result = (|| -> Result<Value> {
        match request.target.as_str() {
            "/api/v1/voice/config" => {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Selection {
                    profile_id: String,
                    conversation_id: String,
                }
                let input: Selection = serde_json::from_slice(&request.body)
                    .map_err(|_| anyhow!("음성 요청 형식을 확인해 주세요."))?;
                crate::host::voice::config(host, &input.profile_id, &input.conversation_id)
            }
            "/api/v1/voice/transcribe" => {
                let input = serde_json::from_slice(&request.body)
                    .map_err(|_| anyhow!("음성 요청 형식을 확인해 주세요."))?;
                host.handle
                    .block_on(crate::host::voice::transcribe_command(host, input))
            }
            "/api/v1/voice/synthesize" => {
                let input = serde_json::from_slice(&request.body)
                    .map_err(|_| anyhow!("음성 요청 형식을 확인해 주세요."))?;
                host.handle
                    .block_on(crate::host::voice::synthesize_command(host, input))
            }
            _ => Err(anyhow!("지원하지 않는 음성 요청입니다.")),
        }
    })();
    match result {
        Ok(value) => respond_json(peer, 200, &json!({"ok": true, "result": value})),
        Err(error) => respond_json(peer, 409, &json!({"ok": false, "error": error.to_string()})),
    }
}

fn action(peer: &mut TcpStream, request: &http::Request, host: &Arc<Host>) -> Result<()> {
    let reply = serde_json::from_slice::<Action>(&request.body)
        .map_err(anyhow::Error::from)
        .and_then(|action| host.action(action));
    match reply {
        Ok(value) => {
            let status = if value["ok"] == false { 409 } else { 200 };
            respond_json(peer, status, &value)
        }
        Err(error) => respond_json(peer, 409, &json!({"ok": false, "error": error.to_string()})),
    }
}

fn respond_result(peer: &mut TcpStream, result: Result<Value>) -> Result<()> {
    match result {
        Ok(value) => respond_json(peer, 200, &value),
        Err(error) => respond_json(peer, 409, &json!({"ok": false, "error": error.to_string()})),
    }
}

fn respond_json(peer: &mut TcpStream, status: u16, value: &Value) -> Result<()> {
    http::respond(
        peer,
        status,
        "application/json",
        value.to_string().as_bytes(),
        None,
    )
}

fn denied(peer: &mut TcpStream) -> Result<()> {
    http::respond(
        peer,
        403,
        "application/json",
        br#"{"ok":false,"error":"request_denied"}"#,
        None,
    )
}

#[cfg(feature = "workspace-ui")]
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod voice_tests {
    use super::*;
    use std::{collections::HashMap, io::Read};

    fn request(session: &http::Session, target: &str, body: Vec<u8>) -> http::Request {
        http::Request {
            method: "POST".into(),
            target: target.into(),
            body,
            headers: HashMap::from([
                (
                    "host".into(),
                    session.origin.trim_start_matches("http://").into(),
                ),
                ("origin".into(), session.origin.clone()),
                ("content-type".into(), "application/json".into()),
                ("authorization".into(), format!("Bearer {}", "a".repeat(64))),
                ("x-ghost-csrf".into(), "a".repeat(64)),
            ]),
        }
    }
    fn response(request: &http::Request, session: &http::Session, host: &Arc<Host>) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        route(&mut peer, request, session, host, false).unwrap();
        peer.shutdown(Shutdown::Both).unwrap();
        let mut output = String::new();
        client.read_to_string(&mut output).unwrap();
        output
    }
    #[test]
    fn ephemeral_voice_routes_require_auth_and_redact_malformed_audio_inputs() {
        let root = tempfile::tempdir().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let host = Host::open(root.path(), runtime.handle().clone(), Some("mock")).unwrap();
        let session = http::Session::new_with_control_token(62077, "voice-test", "a".repeat(64));
        for operation in ["config", "transcribe", "synthesize"] {
            let mut input = request(
                &session,
                &format!("/api/v1/voice/{operation}"),
                br#"{"settings_version":"PRIVATE_AUDIO_MARKER"}"#.to_vec(),
            );
            input.headers.remove("authorization");
            assert!(response(&input, &session, &host).starts_with("HTTP/1.1 403"));
            input
                .headers
                .insert("authorization".into(), format!("Bearer {}", "a".repeat(64)));
            let output = response(&input, &session, &host);
            assert!(output.starts_with("HTTP/1.1 409"));
            assert!(!output.contains("PRIVATE_AUDIO_MARKER"));
            input
                .headers
                .insert("origin".into(), "https://foreign.example".into());
            assert!(response(&input, &session, &host).starts_with("HTTP/1.1 403"));
        }
        runtime.block_on(host.shutdown()).unwrap();
    }
    #[test]
    fn oversized_audio_is_rejected_before_deserialization() {
        let root = tempfile::tempdir().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let host = Host::open(root.path(), runtime.handle().clone(), Some("mock")).unwrap();
        let session = http::Session::new_with_control_token(62077, "voice-test", "a".repeat(64));
        let input = request(
            &session,
            "/api/v1/voice/transcribe",
            vec![b'a'; crate::host::voice::MAX_REQUEST_BYTES + 1],
        );
        assert!(response(&input, &session, &host).starts_with("HTTP/1.1 413"));
        runtime.block_on(host.shutdown()).unwrap();
    }
}
