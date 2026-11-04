//! Bot readiness observes existing scoped memory; it never creates credentials,
//! permissions, Spaces, or a replacement memory engine.
use super::{
    bots::{BotDefinition, RevisionRef},
    bots_provisioning::{self as provisioning, Candidate},
    lifetime, work_memory, Host,
};
use crate::{
    domain::Policy,
    lifetime_contract::{canonical_digest, Envelope, Response, ResponseStatus, RetryClass},
};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
const RECEIPTS: &str = "bot_memory_readiness_v1";
const FRESH_MS: u64 = 30_000;
pub(crate) fn planned_identity(command: &str) -> Result<Value> {
    ensure!(
        !command.trim().is_empty() && command.len() <= 200 && !command.contains('\0'),
        "creation command identity invalid"
    );
    let id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("ghost-bot-candidate/1:{command}").as_bytes(),
    )
    .to_string();
    let ghost = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("ghost-bot-identity/1:{id}").as_bytes(),
    )
    .to_string();
    let conversation = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("ghost-bot-conversation/1:{id}").as_bytes(),
    )
    .to_string();
    Ok(json!({"candidate_id":id,"ghost_id":ghost,"conversation_id":conversation}))
}
pub(crate) fn plan(conn: &Connection, e: &Envelope) -> Result<Response> {
    let fields = e
        .body
        .as_object()
        .ok_or_else(|| anyhow!("creation planning body missing"))?;
    ensure!(
        e.actor_ref == "owner" && fields.len() == 2 && fields.contains_key("creation_command_id"),
        "creation planning requires exact Owner command identity"
    );
    let command = e.body["creation_command_id"]
        .as_str()
        .ok_or_else(|| anyhow!("creation command missing"))?;
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT actor_ref,request FROM lifetime_commands WHERE command_id=?1",
            [command],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((actor, request)) = existing {
        let request: Envelope = serde_json::from_str(&request)?;
        ensure!(
            actor == "owner" && request.body["method"] == "bot.prepare",
            "creation command belongs to another intent"
        );
    }
    Ok(Response {
        status: ResponseStatus::Success,
        summary: "Future Owner bot identity planned; no resources or permissions created".into(),
        object_refs: vec![],
        artifacts: vec![],
        next_actions: vec![],
        error_code: None,
        retry_class: RetryClass::SameId,
        data: planned_identity(command)?,
    })
}
fn load(conn: &Connection, kind: &str, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|r| serde_json::from_str(&r).map_err(Into::into))
        .transpose()
}
fn eligible(conn: &Connection, c: &Candidate) -> Result<bool> {
    let progress = provisioning::progress(conn, &c.id)?;
    if !matches!(progress.state.as_str(), "provisioning" | "ready")
        || super::bot_lifecycle::mode(conn, &c.definition.ghost_id)? == "retired"
    {
        return Ok(false);
    }
    if progress.state == "ready" {
        // The successful update has replaced its source pointer. Validate the
        // selected result itself rather than requiring that old source again.
        if super::bots_store::active_definition(conn, &c.definition.ghost_id)?
            .is_none_or(|definition| definition != c.definition)
        {
            return Ok(false);
        }
    } else if super::bot_lifecycle::target_is_stale(conn, c)? {
        return Ok(false);
    }
    if let Some(turn) = &c.intent_turn_id {
        let cancelled: Option<bool> = conn
            .query_row(
                "SELECT cancel_requested FROM lifetime_turn_runs WHERE turn_id=?1",
                [turn],
                |r| r.get(0),
            )
            .optional()?;
        if cancelled != Some(false) {
            return Ok(false);
        }
    }
    Ok(true)
}
fn stamp(conn: &Connection, c: &Candidate, pin: &RevisionRef) -> Result<String> {
    let authority = lifetime::authority::current(conn)?;
    let policy = load(conn, "policy", &c.definition.ghost_id)?
        .unwrap_or(serde_json::to_value(Policy::default())?);
    canonical_digest(
        &json!({"eligible":eligible(conn,c)?,"candidate_id":c.id,"candidate_digest":c.digest,"definition_digest":c.definition.digest,"profile_ref":pin,"epoch":authority.epoch,"dispatch_enabled":authority.dispatch_enabled,"policy_digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&policy)?)),"binding_configuration":if cfg!(feature="memory"){json!(crate::adapters::memory::Brain::context_revision(&c.definition.ghost_id)?)}else{json!({"available":false})}}),
    )
}
fn selection(
    conn: &Connection,
    c: &Candidate,
    pin: &RevisionRef,
) -> Result<(Option<work_memory::Profile>, Option<&'static str>)> {
    let profile = match work_memory::resolve_definition_profile(conn, &c.definition.ghost_id, pin) {
        Ok(profile) => profile,
        Err(error) => {
            return if let Some(reason) = error.downcast_ref::<work_memory::ProfileUnavailable>() {
                Ok((None, Some(reason.0)))
            } else {
                Err(error)
            }
        }
    };
    let reason = match work_memory::definition_profile_current(conn, &profile) {
        Ok(()) => {
            if profile.profile.is_none() {
                Some("memory_binding_missing")
            } else {
                None
            }
        }
        Err(error) => {
            if let Some(reason) = error.downcast_ref::<work_memory::ProfileUnavailable>() {
                Some(reason.0)
            } else {
                return Err(error);
            }
        }
    };
    Ok((Some(profile), reason))
}
pub(crate) fn readiness(conn: &Connection, c: &Candidate, epoch: u64) -> Result<Value> {
    let Some(pin) = &c.definition.content.memory_profile_ref else {
        return Ok(
            json!({"verified":false,"activation_allowed":true,"state":"degraded","reason":"optional_unbound","required":false}),
        );
    };
    if !eligible(conn, c)? {
        return Ok(
            json!({"verified":false,"activation_allowed":false,"state":"blocked","reason":"bot_creation_inactive","required":true,"profile_ref":pin}),
        );
    }
    let (profile, reason) = selection(conn, c, pin)?;
    let required = profile.as_ref().is_none_or(|p| p.required);
    if let Some(reason) = reason {
        return Ok(
            json!({"verified":false,"activation_allowed":!required,"state":if required {"blocked"}else{"degraded"},"reason":reason,"required":required,"profile_ref":pin}),
        );
    }
    let receipt = load(conn, RECEIPTS, &c.id)?;
    let current = stamp(conn, c, pin)?;
    let receipt = receipt.filter(|r| {
        r["candidate_digest"] == c.digest
            && r["epoch"] == epoch
            && r["stamp"] == current
            && r["checked_ms"]
                .as_u64()
                .is_some_and(|t| super::now_ms() >= t && super::now_ms() - t <= FRESH_MS)
    });
    let verified = receipt.as_ref().is_some_and(|r| r["state"] == "verified");
    let reason = receipt
        .as_ref()
        .and_then(|r| r["reason"].as_str())
        .unwrap_or("memory_validation_pending");
    Ok(
        json!({"verified":verified,"activation_allowed":verified || !required,"state":if verified {"verified"}else if required {"blocked"}else{"degraded"},"reason":if verified {Value::Null}else{json!(reason)},"required":required,"profile_ref":pin}),
    )
}
pub(crate) fn surface(conn: &Connection, definition: &BotDefinition) -> Result<Option<Value>> {
    if definition.content.memory_profile_ref.is_none() {
        return Ok(None);
    }
    let raw:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='bot_candidate_v1' AND json_extract(payload,'$.definition.digest')=?1 AND json_extract(payload,'$.definition.ghost_id')=?2 ORDER BY id LIMIT 1",params![definition.digest,definition.ghost_id],|r|r.get(0)).optional()?;
    let Some(raw) = raw else {
        return Ok(Some(
            json!({"state":"blocked","required":true,"reason":"memory_profile_unavailable"}),
        ));
    };
    let c: Candidate = serde_json::from_str(&raw)?;
    let memory = readiness(conn, &c, lifetime::authority::current(conn)?.epoch)?;
    Ok(Some(
        json!({"state":memory["state"],"required":memory["required"],"reason":memory["reason"]}),
    ))
}
// Pinned configuration authority and recent activation readiness are distinct.
// A current claimed SDK generation still reauthenticates its exact Work memory
// on every inference/tool callback; the activation cache is not its lease.
pub(crate) fn definition_authority_current(conn: &Connection, definition: &BotDefinition) -> Result<bool> {
    let Some(pin) = &definition.content.memory_profile_ref else {
        return Ok(true);
    };
    let profile = match work_memory::resolve_definition_profile(conn, &definition.ghost_id, pin) {
        Ok(p) => p,
        Err(error) => {
            return if error
                .downcast_ref::<work_memory::ProfileUnavailable>()
                .is_some()
            {
                Ok(false)
            } else {
                Err(error)
            }
        }
    };
    if !profile.required {
        return Ok(true);
    };
    if let Err(error) = work_memory::definition_profile_current(conn, &profile) {
        return if error
            .downcast_ref::<work_memory::ProfileUnavailable>()
            .is_some()
        {
            Ok(false)
        } else {
            Err(error)
        };
    };
    Ok(true)
}
pub(crate) fn definition_current(conn:&Connection,definition:&BotDefinition)->Result<bool> {
    if !definition_authority_current(conn,definition)? {return Ok(false);}
    let Some(pin)=&definition.content.memory_profile_ref else{return Ok(true)};
    if !work_memory::resolve_definition_profile(conn,&definition.ghost_id,pin)?.required {return Ok(true);}
    let raw:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='bot_candidate_v1' AND json_extract(payload,'$.definition.digest')=?1 AND json_extract(payload,'$.definition.ghost_id')=?2 ORDER BY id LIMIT 1",params![definition.digest,definition.ghost_id],|r|r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(false) };
    let c: Candidate = serde_json::from_str(&raw)?;
    Ok(readiness(conn, &c, lifetime::authority::current(conn)?.epoch)?["verified"] == true)
}
impl Host {
    /// Read-only external authentication is outside the writer lock. The fresh
    /// epoch/policy/configuration stamp is checked on every callback and commit.
    pub(crate) async fn validate_bot_memory(&self, c: &Candidate) -> Result<()> {
        let Some(pin) = &c.definition.content.memory_profile_ref else {
            return Ok(());
        };
        let (captured, profile, reason) = {
            let state = self.lock()?;
            let authority = lifetime::authority::current(&state.journal.0)?;
            ensure!(
                authority.epoch == self.authority_epoch && authority.dispatch_enabled,
                "bot memory writer fenced"
            );
            let actual = provisioning::candidate(&state.journal.0, &c.id)?;
            ensure!(
                actual.digest == c.digest && eligible(&state.journal.0, c)?,
                "bot memory candidate changed or inactive"
            );
            let (profile, reason) = selection(&state.journal.0, c, pin)?;
            (stamp(&state.journal.0, c, pin)?, profile, reason)
        };
        let check = || -> Result<()> {
            ensure!(
                !self.stopping.load(std::sync::atomic::Ordering::Acquire),
                "Host stopping"
            );
            let state = self.lock()?;
            ensure!(
                stamp(&state.journal.0, c, pin)? == captured,
                "bot memory authority changed during authentication"
            );
            Ok(())
        };
        let reason = if let Some(reason) = reason {
            Some(reason)
        } else {
            let profile = profile
                .as_ref()
                .and_then(|p| p.profile.as_ref())
                .ok_or_else(|| anyhow!("memory read bindings missing"))?;
            match self
                .brain
                .validate_work_context(&c.definition.ghost_id, profile, &check)
                .await
            {
                Ok(_) => None,
                Err(_) => Some("memory_authentication_unavailable"),
            }
        };
        check()?;
        let state = self.lock()?;
        ensure!(
            stamp(&state.journal.0, c, pin)? == captured,
            "bot memory proof changed before commit"
        );
        let actual = provisioning::candidate(&state.journal.0, &c.id)?;
        ensure!(
            actual.digest == c.digest,
            "bot memory candidate changed before commit"
        );
        let value = json!({"candidate_digest":c.digest,"epoch":self.authority_epoch,"stamp":captured,"checked_ms":super::now_ms(),"state":if reason.is_none(){"verified"}else{"blocked"},"reason":reason});
        state.journal.0.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![RECEIPTS,c.id,serde_json::to_string(&value)?])?;
        Ok(())
    }
    pub(crate) async fn advance_bot_memory_readiness(&self) -> Result<()> {
        let candidates = {
            let state = self.lock()?;
            let after = load(
                &state.journal.0,
                "bot_memory_readiness_cursor_v1",
                "workspace",
            )?
            .and_then(|v| v["after"].as_str().map(str::to_owned))
            .unwrap_or_default();
            let mut q=state.journal.0.prepare("SELECT c.id,c.payload FROM workspace_objects c JOIN workspace_objects p ON p.kind='bot_provisioning_v1' AND p.id=c.id WHERE c.kind='bot_candidate_v1' AND json_extract(c.payload,'$.definition.content.memory_profile_ref') IS NOT NULL AND json_extract(p.payload,'$.state') IN ('provisioning','ready') ORDER BY CASE WHEN c.id>?1 THEN 0 ELSE 1 END,c.id LIMIT 16")?;
            let rows = q
                .query_map([after], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let candidates = rows
                .iter()
                .map(|(_, r)| serde_json::from_str::<Candidate>(r))
                .collect::<serde_json::Result<Vec<_>>>()?;
            candidates
        };
        for c in candidates {
            let due = {
                let state = self.lock()?;
                // Advance before each attempted candidate, so a killed/hung first
                // authentication cannot starve the remainder of a full batch.
                state.journal.0.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES('bot_memory_readiness_cursor_v1','workspace',?1) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",[serde_json::to_string(&json!({"after":c.id}))?])?;
                if !eligible(&state.journal.0, &c)? {
                    false
                } else {
                    let pin = c
                        .definition
                        .content
                        .memory_profile_ref
                        .as_ref()
                        .ok_or_else(|| anyhow!("memory profile pin missing"))?;
                    let current = stamp(&state.journal.0, &c, pin)?;
                    !load(&state.journal.0, RECEIPTS, &c.id)?.is_some_and(|r| {
                        r["stamp"] == current
                            && r["checked_ms"].as_u64().is_some_and(|t| {
                                super::now_ms() >= t && super::now_ms() - t < FRESH_MS
                            })
                    })
                }
            };
            if due {
                self.validate_bot_memory(&c).await?;
            }
        }
        Ok(())
    }
}
