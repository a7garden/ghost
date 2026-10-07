//! OpenBot supervisor-backed implementation of the computer interface.
use super::{
    Authorize, BrowserOperation, ComputerBackend, ComputerCapabilities, ComputerFuture,
    ComputerOperation,
};
use anyhow::{anyhow, bail, Result};
use futures::StreamExt;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::Duration;

struct Computer {
    client: reqwest::Client,
    supervisor: reqwest::Url,
    supervisor_token: String,
    master: String,
    namespace: String,
}

pub struct OpenBot;

impl Computer {
    fn from_env() -> Result<Self> {
        let get = |key: &str| {
            std::env::var(key).map_err(|_| anyhow!("computer service is not configured"))
        };
        let supervisor = reqwest::Url::parse(&get("GHOST_COMPUTER_SUPERVISOR_URL")?)?;
        if !matches!(supervisor.scheme(), "http" | "https")
            || !supervisor.username().is_empty()
            || supervisor.password().is_some()
            || supervisor.query().is_some()
            || supervisor.fragment().is_some()
        {
            bail!("invalid supervisor endpoint");
        }
        let namespace =
            std::env::var("GHOST_COMPUTER_NAMESPACE").unwrap_or_else(|_| "opendots".into());
        if namespace.len() > 64
            || !namespace
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            bail!("invalid computer namespace");
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(25))
                .build()?,
            supervisor,
            supervisor_token: get("GHOST_COMPUTER_SUPERVISOR_TOKEN")?,
            master: get("GHOST_COMPUTER_TOKEN")?,
            namespace,
        })
    }

    fn token(&self, id: &str) -> Result<String> {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.master.as_bytes())
            .map_err(|_| anyhow!("invalid computer key"))?;
        mac.update(format!("opendots-computer:{id}").as_bytes());
        Ok(mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }

    async fn json(
        &self,
        url: &str,
        token: &str,
        id: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = if let Some(body) = body {
            self.client.post(url).json(&body)
        } else {
            self.client.get(url)
        }
        .bearer_auth(token);
        if let Some(id) = id {
            request = request.header("x-openbot-bot-id", id);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow!("computer transport failed"))?;
        if !response.status().is_success() {
            bail!(
                "computer returned HTTP {}; refresh snapshot or inspect human control",
                response.status().as_u16()
            );
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            bytes.extend_from_slice(&chunk.map_err(|_| anyhow!("computer response interrupted"))?);
            if bytes.len() > 4_000_000 {
                bail!("computer response size limit");
            }
        }
        let mut text = String::from_utf8(bytes)?;
        for secret in [token, &self.master, &self.supervisor_token] {
            if !secret.is_empty() {
                text = text.replace(secret, "[redacted]");
            }
        }
        let mut value: Value =
            serde_json::from_str(&text).map_err(|_| anyhow!("invalid computer response"))?;
        if let Some(object) = value.as_object_mut() {
            object.remove("command");
        }
        Ok(value)
    }

    async fn supervisor(&self, path: &str, body: Option<Value>) -> Result<Value> {
        self.json(
            &format!("{}{path}", self.supervisor.as_str().trim_end_matches('/')),
            &self.supervisor_token,
            None,
            body,
        )
        .await
    }

    fn endpoint(&self, id: &str, state: &Value) -> Result<String> {
        let container = format!("{}-computer-{id}", self.namespace);
        if state["botId"] != id || state["container"] != container {
            bail!("computer identity mismatch");
        }
        let port = state["port"]
            .as_u64()
            .filter(|p| (1024..=65535).contains(p));
        let raw = state["url"].as_str().map(String::from).unwrap_or_else(|| {
            port.map(|p| format!("http://127.0.0.1:{p}"))
                .unwrap_or_else(|| format!("http://{container}:4100"))
        });
        let url = reqwest::Url::parse(&raw)?;
        let local = url.host_str() == Some("127.0.0.1")
            && port == url.port().map(u64::from)
            && port.is_some()
            && self.supervisor.host_str() == Some("127.0.0.1");
        let network =
            url.host_str() == Some(container.to_lowercase().as_str()) && url.port() == Some(4100);
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || (!local && !network)
        {
            bail!("computer endpoint is not bound to this Ghost");
        }
        Ok(url.origin().ascii_serialization())
    }

    async fn running(&self, id: &str) -> Result<String> {
        let listing = self.supervisor("/computers", None).await?;
        let state = listing["computers"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|state| state["botId"] == id && state["status"] == "running")
            })
            .ok_or_else(|| anyhow!("start this Ghost's computer first"))?;
        self.endpoint(id, state)
    }

    fn request(operation: ComputerOperation) -> Result<(&'static str, Value, bool)> {
        match operation {
            ComputerOperation::Shell {
                command,
                timeout_ms,
            } => Ok((
                "exec",
                json!({"command": command, "timeoutMs": timeout_ms}),
                true,
            )),
            ComputerOperation::Browser(operation) => match operation {
                BrowserOperation::Navigate { url } => Ok(("navigate", json!({"url": url}), true)),
                BrowserOperation::Read => Ok(("read", json!({}), false)),
                BrowserOperation::Snapshot => Ok(("snapshot", json!({}), true)),
                BrowserOperation::Screenshot => Ok(("screenshot", json!({}), false)),
                BrowserOperation::Click {
                    reference,
                    snapshot_id,
                } => Ok((
                    "click",
                    json!({"ref": reference, "snapshotId": snapshot_id}),
                    true,
                )),
                BrowserOperation::Type {
                    reference,
                    snapshot_id,
                    text,
                } => Ok((
                    "type",
                    json!({"ref": reference, "snapshotId": snapshot_id, "text": text}),
                    true,
                )),
                BrowserOperation::Key { key } => Ok(("key", json!({"key": key}), true)),
                BrowserOperation::Scroll { delta_y } => {
                    Ok(("scroll", json!({"deltaY": delta_y}), true))
                }
            },
        }
    }
}

impl ComputerBackend for OpenBot {
    fn identity(&self) -> &'static str {
        "openbot-supervisor"
    }

    fn capabilities(&self) -> ComputerCapabilities {
        ComputerCapabilities {
            browser: true,
            shell: true,
            human_control: true,
            persistent_filesystem: true,
        }
    }

    fn configured(&self) -> bool {
        [
            "GHOST_COMPUTER_SUPERVISOR_URL",
            "GHOST_COMPUTER_SUPERVISOR_TOKEN",
            "GHOST_COMPUTER_TOKEN",
        ]
        .iter()
        .all(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()))
    }

    fn execute<'a>(
        &'a self,
        owner: &'a str,
        operation: ComputerOperation,
        authorize: Authorize<'a>,
    ) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async move {
            authorize()?;
            let computer = Computer::from_env()?;
            let (path, body, send_body) = Computer::request(operation)?;
            let endpoint = computer.running(owner).await?;
            let token = computer.token(owner)?;
            authorize()?;
            let url = format!("{endpoint}/{path}");
            let future = computer.json(&url, &token, Some(owner), send_body.then_some(body));
            tokio::pin!(future);
            loop {
                tokio::select! {
                    result = &mut future => {
                        let value = result?;
                        authorize()?;
                        return Ok(value);
                    }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => authorize()?,
                }
            }
        })
    }

    fn control<'a>(&'a self, owner: &'a str, verb: &'a str) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async move {
            let computer = Computer::from_env()?;
            match verb {
                "start" => {
                    let state = computer
                        .supervisor(&format!("/computers/{owner}/ensure"), Some(json!({})))
                        .await?;
                    computer.endpoint(owner, &state)?;
                    Ok(state)
                }
                "stop" => {
                    computer
                        .supervisor(&format!("/computers/{owner}/stop"), Some(json!({})))
                        .await
                }
                "status" => {
                    let endpoint = computer.running(owner).await?;
                    computer
                        .json(
                            &format!("{endpoint}/control"),
                            &computer.token(owner)?,
                            Some(owner),
                            None,
                        )
                        .await
                }
                "take" | "release" => {
                    let endpoint = computer.running(owner).await?;
                    let token = computer.token(owner)?;
                    let mut state = computer
                        .json(&format!("{endpoint}/control"), &token, Some(owner), None)
                        .await?;
                    if verb == "take" && state["request"].is_null() {
                        state = computer
                            .json(
                                &format!("{endpoint}/control/request"),
                                &token,
                                Some(owner),
                                Some(json!({"reason": "Owner requested control."})),
                            )
                            .await?;
                    }
                    let request = state["request"]["id"]
                        .as_str()
                        .ok_or_else(|| anyhow!("no active human control request"))?;
                    computer
                        .json(
                            &format!("{endpoint}/control/{verb}"),
                            &token,
                            Some(owner),
                            Some(json!({"requestId": request})),
                        )
                        .await
                }
                _ => bail!("unknown owner computer action"),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http;
    fn computer(url: &str) -> Computer {
        Computer {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            supervisor: reqwest::Url::parse(url).unwrap(),
            supervisor_token: "fixture-supervisor".into(),
            master: "fixture-master".into(),
            namespace: "ghost".into(),
        }
    }
    const OWNER: &str = "018f47c6-1199-72b3-87de-344e5a493e27";
    #[test]
    fn hmac_identity_and_endpoint_binding_prevent_cross_ghost_dispatch() {
        let c = computer("http://127.0.0.1:64000");
        assert_eq!(
            c.token(OWNER).unwrap(),
            "a748141a0592cc675635f9775b037ee041a9bc4480189ccd6deff717c0f6c759"
        );
        let state = json!({"botId":OWNER,"container":format!("ghost-computer-{OWNER}"),"port":64001,"url":"http://127.0.0.1:64001"});
        assert_eq!(c.endpoint(OWNER, &state).unwrap(), "http://127.0.0.1:64001");
        for changed in [
            json!({"botId":"another"}),
            json!({"url":"http://evil.invalid:64001"}),
            json!({"url":"http://127.0.0.1:64002"}),
            json!({"url":"http://127.0.0.1:64001/path"}),
        ] {
            let mut candidate = state.clone();
            for (k, v) in changed.as_object().unwrap() {
                candidate[k] = v.clone();
            }
            assert!(c.endpoint(OWNER, &candidate).is_err());
        }
    }
    #[tokio::test]
    async fn computer_transport_binds_owner_and_redacts_credentials_and_command_echo() {
        let(url,request,server)=test_http::once(Some(test_http::reply("200 OK","Content-Type: application/json\r\n","{\"output\":\"fixture-master fixture-supervisor fixture-token\",\"command\":\"private command\"}"))).await;
        let c = computer(&url);
        let result = c
            .json(
                &format!("{url}/exec"),
                "fixture-token",
                Some(OWNER),
                Some(json!({"command":"echo fixture","timeoutMs":20000})),
            )
            .await
            .unwrap();
        let body = String::from_utf8(request.await.unwrap()).unwrap();
        assert!(body
            .to_lowercase()
            .contains(&format!("x-openbot-bot-id: {OWNER}")));
        assert!(body.contains("Bearer fixture-token"));
        assert_eq!(result["output"], "[redacted] [redacted] [redacted]");
        assert!(result.get("command").is_none());
        server.await.unwrap();
    }
    #[tokio::test]
    async fn computer_transport_does_not_follow_redirects_or_accept_lost_ack() {
        let (url, _, server) = test_http::once(Some(test_http::reply(
            "302 Found",
            "Location: http://evil.invalid/\r\n",
            "",
        )))
        .await;
        assert!(computer(&url)
            .json(&url, "fixture-token", Some(OWNER), None)
            .await
            .is_err());
        server.await.unwrap();
        let (url, _, server) = test_http::once(None).await;
        assert!(computer(&url)
            .json(&url, "fixture-token", Some(OWNER), None)
            .await
            .is_err());
        server.await.unwrap();
    }
}
