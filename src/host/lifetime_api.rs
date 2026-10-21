use super::{lifetime, Host};
use crate::lifetime_contract::{Envelope, Response, ResponseStatus, RetryClass};
use anyhow::{bail, Result};
use serde_json::{json, Value};

impl Host {
    /// Only the authenticated owner control surface calls this façade. Worker and
    /// Pi callbacks receive their own scoped transport rather than impersonating owner.
    pub(crate) fn lifetime_action(&self, envelope: &Envelope) -> Result<Value> {
        if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
            bail!("Ghost host is stopping");
        }
        let result = (|| -> Result<Response> {
            envelope.validate()?;
            let state = self.lock()?;
            if envelope.actor_ref != "owner" {
                return Ok(Response {
                    status: ResponseStatus::Error, summary: "authenticated owner does not match envelope actor".into(),
                    object_refs: vec![], artifacts: vec![], next_actions: vec![],
                    error_code: Some("unauthorized".into()), retry_class: RetryClass::Never, data: Value::Null,
                });
            }
            let method = envelope.body.get("method").and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing lifetime method"))?;
            let authority = lifetime::authority::current(&state.journal.0)?;
            if authority.epoch != self.authority_epoch && !matches!(method, "snapshot" | "command.inspect" | "work.artifact") {
                return Ok(Response {
                    status: ResponseStatus::Error, summary: "Host writer generation is fenced; reopen the current authority before writing".into(),
                    object_refs: vec![], artifacts: vec![], next_actions: vec![],
                    error_code: Some("authority_fenced".into()), retry_class: RetryClass::Never, data: Value::Null,
                });
            }
            if matches!(method, "goal.submit" | "registry.ensure" | "conversation.input" | "conversation.inspect" | "conversation.cancel_turn" | "conversation.turn.inspect") {
                let ghost_id = envelope.body.get("ghost_id").and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("missing ghost identity"))?;
                let profile = state.profiles.get(ghost_id)
                    .ok_or_else(|| anyhow::anyhow!("profile missing"))?;
                let conversation = envelope.body.get("conversation_id").and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("missing conversation identity"))?;
                uuid::Uuid::parse_str(conversation)?;
                if profile.runtime.session.committed()?.conversations.contains_key(conversation) {
                    bail!("legacy conversation is bound to its existing runtime; create a new Pi conversation");
                }
            }
            if method == "snapshot" {
                if let Some(response) = lifetime::authority::guard(&state.journal.0, envelope)? {
                    return Ok(response);
                }
                return Ok(Response {
                    status: ResponseStatus::Success,
                    summary: "Lifetime ledger snapshot".into(),
                    object_refs: vec![], artifacts: vec![], next_actions: vec![],
                    error_code: None, retry_class: RetryClass::SameId,
                    data: serde_json::to_value(lifetime::snapshot(&state.journal.0)?)?,
                });
            }
            // Owner artifact reads are uncached: like the snapshot, they run
            // through the authority guard (epoch + dispatch state) but never
            // enter the command receipt table, so bounded artifact bytes are
            // never retained in receipts. The authenticated owner actor and
            // the exact work/goal/execution/digest/locator binding are
            // enforced inside the read.
            if method == "work.artifact" {
                if let Some(response) = lifetime::authority::guard(&state.journal.0, envelope)? {
                    return Ok(response);
                }
                return lifetime::artifact_read(&state.journal.0, self.native_computers.as_ref(), &envelope.body);
            }
            // Identity is supplied here after control-server bearer/HMAC checks.
            lifetime::apply_with_admission(&state.journal.0, envelope, "owner",
                |conn| self.native_work_admission(conn, envelope))
        })();
        Ok(match result {
            Ok(response) => json!({"ok": true, "result": response}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        })
    }
    /// The private Pi-controller credential is checked by the HTTP route.
    /// Scope is bound to an existing Host conversation, never to model arguments.
    pub(crate) async fn lifetime_pi_action(&self, request: &lifetime::PiToolRequest, scope: lifetime::PiInferenceScope) -> Result<Value> {
        if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
            bail!("Ghost host is stopping");
        }
        let memory = request.envelope.body.get("method").and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("memory."));
        let document = request.envelope.body.get("method").and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("documents."));
        let result = if memory {
            self.lifetime_memory_action(request, scope).await
        } else if document {
            self.lifetime_documents_action(request, scope)
        } else {
            (|| -> Result<Response> {
                let state = self.lock()?;
                if let Some(response) = self.check_pi_host_scope(&state, request, scope)? {
                    return Ok(response);
                }
                lifetime::pi_tool_apply(&state.journal.0, request, scope, self.native_computers.as_ref())
            })()
        };
        Ok(match result {
            Ok(response) => json!({"ok": true, "result": response}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        })
    }

    pub(crate) fn check_pi_host_scope(&self, state: &super::State, request: &lifetime::PiToolRequest, scope: lifetime::PiInferenceScope) -> Result<Option<Response>> {
        let authority = lifetime::authority::current(&state.journal.0)?;
        if self.stopping.load(std::sync::atomic::Ordering::Acquire)
            || authority.epoch != self.authority_epoch
            || (scope == lifetime::PiInferenceScope::Local && self.pi_local_route.is_none()) {
            return Ok(Some(Response {
                status: ResponseStatus::Error, summary: "Captured Pi writer or local route is no longer authoritative".into(),
                object_refs: vec![], artifacts: vec![], next_actions: vec![],
                error_code: Some("authority_fenced".into()), retry_class: RetryClass::Never, data: Value::Null,
            }));
        }
        if !state.profiles.contains_key(&request.ghost_id) {
            return Ok(Some(Response {
                status: ResponseStatus::Error,
                summary: "Pi controller Ghost scope is not registered in this Host".into(),
                object_refs: vec![], artifacts: vec![], next_actions: vec![],
                error_code: Some("unauthorized".into()), retry_class: RetryClass::Never,
                data: Value::Null,
            }));
        }
        Ok(None)
    }
}
