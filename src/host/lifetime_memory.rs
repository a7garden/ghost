//! Canonical memory ingress. Source identity and disclosure are Host facts;
//! model text remains untrusted and never supplies an owner or engine space.
use super::{lifetime, Host};
use crate::{
    adapters::memory::{
        Brain, SourceDisclosure, SourceLedgerConfig, SourceOriginKind, SourceReceipt, SourceStatus,
        TrustedSourceOrigin,
    },
    domain::Policy,
    durable::durable::{ai, ToolStatus},
    lifetime_contract::{Response, ResponseStatus, RetryClass},
};
use anyhow::{anyhow, bail, ensure, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, PartialEq, Eq)]
struct MemoryScope {
    disclosure: SourceDisclosure,
    permitted: bool,
}

/// Owner review list bound: at most this many source revisions per reply.
const MAX_MEMORY_SOURCE_LIST: usize = 64;
/// Bounded newest-first scan of journaled Owner correction intents.
const MAX_MEMORY_SOURCE_INTENTS: usize = 4_096;

/// One listed memory source for the Owner review surface: Host-owned
/// identity and receipt metadata plus hash-checked original text when an
/// authentic durable record still exists. `content` stays `None` whenever
/// no authentic record survives; nothing is ever reconstructed.
#[derive(serde::Serialize)]
pub(crate) struct OwnerMemorySourceView {
    pub origin: TrustedSourceOrigin,
    pub receipt: SourceReceipt,
    pub content: Option<String>,
    pub correction_request_id: Option<String>,
}

/// One journaled Owner correction intent copied out of `workspace_commands`.
struct OwnerCorrectionIntent {
    request_id: String,
    resolution: IntentResolution,
    prior: TrustedSourceOrigin,
    expected_prior_episode_id: String,
    prior_content: String,
    replacement_content: String,
}

/// Durable outcome of the journaled Owner intent. `Inflight` means the
/// command receipt has no response yet (executing or interrupted);
/// `Unresolved` means the Host replied with an explicit `effect_unknown`
/// reconciliation outcome; anything else is a confirmed terminal reply that
/// must never keep a source marked pending.
#[derive(PartialEq, Eq)]
enum IntentResolution {
    Inflight,
    Unresolved,
    Terminal,
}

fn intent_resolution(response: Option<String>) -> IntentResolution {
    let Some(raw) = response else {
        return IntentResolution::Inflight;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return IntentResolution::Terminal;
    };
    // Host replies wrap the lifetime Response envelope: {"ok":true,"result":…}
    // or {"ok":false,"error":…}.
    let unresolved = value.get("ok").and_then(Value::as_bool) == Some(true)
        && value.pointer("/result/status").and_then(Value::as_str) == Some("error")
        && value.pointer("/result/error_code").and_then(Value::as_str) == Some("effect_unknown");
    if unresolved {
        IntentResolution::Unresolved
    } else {
        IntentResolution::Terminal
    }
}

/// Exact canonical scope membership for one registered Ghost pair. Note
/// sources are `canonical:{profile}:{conversation}:{turn}:effect:{command}`
/// and session sources are `canonical-session:{profile}:{conversation}:{turn}`;
/// the profile and conversation prefixes match exactly and the turn component
/// stays bounded, while the command id after `:effect:` is an opaque nonempty
/// suffix — no other Ghost or pair can leak through a shared prefix.
enum PairSource {
    Note,
    Session,
}

fn pair_source(profile_id: &str, conversation_id: &str, source_id: &str) -> Option<PairSource> {
    let note = format!("canonical:{profile_id}:{conversation_id}:");
    if let Some(rest) = source_id.strip_prefix(note.as_str()) {
        let (turn, command_id) = rest.split_once(":effect:")?;
        if turn.is_empty() || turn.contains(':') || command_id.is_empty() {
            return None;
        }
        return Some(PairSource::Note);
    }
    let session = format!("canonical-session:{profile_id}:{conversation_id}:");
    let turn = source_id.strip_prefix(session.as_str())?;
    if turn.is_empty() || turn.contains(':') {
        return None;
    }
    Some(PairSource::Session)
}

/// Recover this revision's original text and its pending correction intent
/// from authentic durable records only: journaled Owner correction intents
/// in `workspace_commands`, hash-checked against the ledger row. Any other
/// revision keeps `content: None` — nothing is reconstructed or guessed.
///
/// Intents arrive newest-first. Any hash-matching authentic intent can
/// supply the revision's original text, whatever its durable outcome was.
/// The pending original UUID is far stricter: only an in-flight or explicitly
/// `effect_unknown` intent whose expected episode matches this ledger
/// revision marks the row pending, and redacted history is never pending. A
/// bound replacement revision exposes its original journaled UUID only while
/// the correction is unresolved; a completed correction stays fully
/// inspectable and is not pending.
fn recover_owner_source_text(
    origin: &TrustedSourceOrigin,
    prior_revision: Option<&str>,
    episode_id: Option<&str>,
    prior_episode_id: Option<&str>,
    status: SourceStatus,
    redaction_state: &str,
    intents: &[OwnerCorrectionIntent],
) -> (Option<String>, Option<String>) {
    let digest =
        |content: &str| crate::adapters::documents::digest(content.as_bytes());
    let mut content = None;
    let mut request_id = None;
    for intent in intents {
        let identity_match = intent.prior.owner == origin.owner
            && intent.prior.source_id == origin.source_id
            && intent.prior.revision == origin.revision
            && intent.prior.content_sha256 == origin.content_sha256
            && intent.prior.disclosure == origin.disclosure
            && intent.prior.kind == origin.kind;
        if !identity_match
            || digest(&intent.prior_content) != origin.content_sha256
        {
            continue;
        }
        if content.is_none() {
            content = Some(intent.prior_content.clone());
        }
        if request_id.is_none()
            && status != SourceStatus::Redacted
            && intent.resolution != IntentResolution::Terminal
            && episode_id.is_some_and(|episode| intent.expected_prior_episode_id == episode)
        {
            request_id = Some(intent.request_id.clone());
        }
        if content.is_some() && request_id.is_some() {
            break;
        }
    }
    if request_id.is_some() || !origin.revision.starts_with("owner-correction:") {
        return (content, request_id);
    }
    // This row is itself a journaled correction's replacement revision.
    let Some(correction_uuid) = origin.revision.strip_prefix("owner-correction:") else {
        return (content, request_id);
    };
    let bound = intents.iter().find(|intent| {
        intent.request_id == correction_uuid
            && intent.prior.owner == origin.owner
            && intent.prior.source_id == origin.source_id
            && prior_revision.is_some_and(|prior| intent.prior.revision == prior)
            && prior_episode_id
                .is_some_and(|episode| intent.expected_prior_episode_id == episode)
            && digest(&intent.replacement_content) == origin.content_sha256
    });
    if let Some(intent) = bound {
        let pending =
            redaction_state != "complete" && intent.resolution != IntentResolution::Terminal;
        let request_id = pending.then(|| intent.request_id.clone());
        return (content.or_else(|| Some(intent.replacement_content.clone())), request_id);
    }
    (content, request_id)
}

fn success(summary: impl Into<String>, data: Value) -> Response {
    Response {
        status: ResponseStatus::Success, summary: summary.into(), data,
        object_refs: vec![], artifacts: vec![], next_actions: vec![],
        error_code: None, retry_class: RetryClass::SameId,
    }
}

fn denied(code: &str, summary: impl Into<String>, retry_class: RetryClass) -> Response {
    Response {
        status: ResponseStatus::Error, summary: summary.into(), data: Value::Null,
        object_refs: vec![], artifacts: vec![], next_actions: vec![],
        error_code: Some(code.into()), retry_class,
    }
}

fn string<'a>(body: &'a Value, name: &str) -> Result<&'a str> {
    let value = body.get(name).and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing memory {name}"))?;
    ensure!(!value.trim().is_empty() && value.len() <= 8192, "memory {name} exceeds its text bound");
    Ok(value)
}

impl Host {
    fn memory_scope(&self, request: &lifetime::PiToolRequest, route: lifetime::PiInferenceScope) -> Result<MemoryScope> {
        let state = self.lock()?;
        if let Some(response) = self.check_pi_host_scope(&state, request, route)? {
            bail!("{}: {}", response.error_code.as_deref().unwrap_or("unauthorized"), response.summary);
        }
        if let Some(response) = lifetime::pi_tool_guard(&state.journal.0, request, route)? {
            bail!("{}: {}", response.error_code.as_deref().unwrap_or("unauthorized"), response.summary);
        }
        let body = &request.envelope.body;
        ensure!(string(body, "ghost_id")? == request.ghost_id
            && string(body, "conversation_id")? == request.conversation_id,
            "memory request exceeds the authenticated Pi pair");
        let privacy: Option<String> = state.journal.0.query_row(
            "SELECT CASE WHEN t.privacy='local_only' OR d.privacy='local_only' THEN 'local_only'
                         WHEN t.privacy='private' OR d.privacy='private' THEN 'private'
                         ELSE 'public' END
             FROM lifetime_turns t
             JOIN lifetime_registry r ON r.ghost_id=t.ghost_id AND r.conversation_id=t.conversation_id
             LEFT JOIN lifetime_conversation_disclosure d ON d.ghost_id=t.ghost_id AND d.conversation_id=t.conversation_id
             WHERE t.id=?1 AND t.ghost_id=?2 AND t.conversation_id=?3
               AND t.kind='user' AND t.sender_kind='owner' AND t.sender_ref='owner'",
            params![string(body, "turn_id")?, request.ghost_id, request.conversation_id],
            |row| row.get(0),
        ).optional()?;
        let disclosure = match privacy.as_deref() {
            Some("public") => SourceDisclosure::Public,
            Some("private") => SourceDisclosure::Private,
            Some("local_only") => SourceDisclosure::LocalOnly,
            _ => bail!("memory origin is not an immutable Owner turn in this registered conversation"),
        };
        if matches!(string(body, "method")?, "memory.retain" | "memory.session_record") {
            let source_admission: bool = state.journal.0.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs
                 WHERE turn_id=?1 AND ghost_id=?2 AND conversation_id=?3
                   AND cancel_requested=0 AND state IN ('queued','running'))",
                params![string(body, "turn_id")?, request.ghost_id, request.conversation_id],
                |row| row.get(0),
            )?;
            ensure!(source_admission, "the Owner controller turn no longer permits new source effects");
        }
        let policy: Policy = state.journal.get("policy", &request.ghost_id)?.unwrap_or_default();
        Ok(MemoryScope { disclosure, permitted: policy.memory })
    }

    pub(crate) async fn lifetime_memory_action(&self, request: &lifetime::PiToolRequest, route: lifetime::PiInferenceScope) -> Result<Response> {
        request.envelope.validate()?;
        let body = &request.envelope.body;
        let method = string(body, "method")?;
        let extra: &[&str] = match method {
            "memory.capabilities" => &[],
            "memory.search" => &["query"],
            "memory.recall" => &["query", "token_budget"],
            "memory.session_list" => &["limit"],
            "memory.retain" => &["text"],
            "memory.session_record" => &["summary"],
            _ => return Ok(denied("unsupported_method", "Memory method is not in the controller action space", RetryClass::Never)),
        };
        let Some(fields) = body.as_object() else { bail!("memory body must be an object"); };
        if fields.keys().any(|field| !["method", "ghost_id", "conversation_id", "turn_id"].contains(&field.as_str())
            && !extra.contains(&field.as_str())) {
            return Ok(denied("invalid_request", "Model-supplied source or memory scope fields are forbidden", RetryClass::Never));
        }
        let captured = match self.memory_scope(request, route) {
            Ok(scope) => scope,
            Err(error) => return Ok(denied("unauthorized", error.to_string(), RetryClass::Never)),
        };
        let configured = route == lifetime::PiInferenceScope::Local && captured.permitted && Brain::source_configured();
        if method == "memory.capabilities" && !configured {
            return Ok(success("No memory tools are available in this captured scope", json!({"available_tools":[]})));
        }
        if !configured {
            return Ok(denied("disclosure_blocked", "Memory requires current permission, an explicit source ledger and an accepted local Pi route", RetryClass::Never));
        }
        let ledger = SourceLedgerConfig::from_env()?;
        let check = || -> Result<()> {
            let current = self.memory_scope(request, route)?;
            ensure!(current == captured && current.permitted,
                "memory permission or immutable disclosure scope changed during I/O");
            Ok(())
        };
        if method == "memory.capabilities" {
            let capabilities = self.brain.source_capabilities(&request.ghost_id, &ledger, &check).await?;
            check()?;
            let available: &[&str] = match (capabilities.notes, capabilities.sessions) {
                (true, true) => &["memory_search", "memory_recall", "memory_session_list", "memory_retain", "memory_session_record"],
                (true, false) => &["memory_search", "memory_recall", "memory_session_list", "memory_retain"],
                (false, true) => &["memory_session_record"],
                (false, false) => &[],
            };
            return Ok(success("Live scoped memory capabilities inspected", json!({"available_tools":available})));
        }
        let turn_id = string(body, "turn_id")?;
        let session_id = format!("ghost-session/v1/{}/{}/{turn_id}/1", request.ghost_id, request.conversation_id);
        if matches!(method, "memory.retain" | "memory.session_record") {
            let content = string(body, if method == "memory.retain" { "text" } else { "summary" })?;
            let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
            let origin = if method == "memory.session_record" {
                TrustedSourceOrigin::new_session(
                    &request.ghost_id,
                    format!("canonical-session:{}:{}:{turn_id}", request.ghost_id, request.conversation_id),
                    "1", captured.disclosure, hash, session_id,
                )?
            } else {
                TrustedSourceOrigin::new(
                    &request.ghost_id,
                    format!("canonical:{}:{}:{turn_id}:effect:{}", request.ghost_id, request.conversation_id, request.envelope.command_id),
                    "1", captured.disclosure, hash,
                )?
            };
            let receipt = self.brain.ingest_source(&origin, content, &ledger, &check).await?;
            if check().is_err() {
                return Ok(denied("effect_unknown", "Memory authority changed during I/O; inspect the original source receipt before any new write", RetryClass::ReconcileFirst));
            }
            let data = serde_json::to_value(&receipt)?;
            return Ok(match receipt.status {
                SourceStatus::Recorded | SourceStatus::AlreadyRecorded => success("Untrusted source stored; this is not a folded belief or accepted fact", data),
                SourceStatus::EffectUnknown => Response {
                    status: ResponseStatus::Error, summary: "Memory outcome is unresolved; no alternate source or blind replay is permitted".into(),
                    data, object_refs: vec![], artifacts: vec![], next_actions: vec!["inspect_original_source_receipt".into()],
                    error_code: Some("effect_unknown".into()), retry_class: RetryClass::ReconcileFirst,
                },
                _ => denied("conflict", "Source receipt is not an active recorded revision", RetryClass::Never),
            });
        }
        let (name, arguments) = match method {
            "memory.search" => ("memory_search", json!({"query":string(body,"query")?})),
            "memory.recall" => {
                let budget = body.get("token_budget").map(|value| value.as_u64()
                    .filter(|value| (128..=2048).contains(value))
                    .ok_or_else(|| anyhow!("token_budget must be an integer in 128..2048"))).transpose()?.unwrap_or(1024);
                ("memory_recall", json!({"query":string(body,"query")?,"token_budget":budget}))
            }
            "memory.session_list" => {
                let limit = body.get("limit").map(|value| value.as_u64()
                    .filter(|value| (1..=20).contains(value))
                    .ok_or_else(|| anyhow!("limit must be an integer in 1..20"))).transpose()?.unwrap_or(10);
                ("memory_session_list", json!({"limit":limit}))
            }
            _ => unreachable!("memory method was checked before I/O"),
        };
        let call = ai::ToolCall::new(&request.envelope.command_id, name, arguments);
        let output = self.brain.read_memory(&request.ghost_id, &session_id, &call, &check).await?;
        check()?;
        Ok(match output.status {
            ToolStatus::Success => success(output.summary, output.content),
            ToolStatus::Denied => denied("unauthorized", output.summary, RetryClass::Never),
            ToolStatus::Uncertain => denied("effect_unknown", output.summary, RetryClass::ReconcileFirst),
            _ => denied("unavailable", output.summary, RetryClass::SameId),
        })
    }

    fn owner_memory_source_guard(&self, profile_id: &str, conversation_id: &str, source_owner: &str) -> Result<()> {
        ensure!(profile_id == source_owner, "memory source belongs to another Ghost");
        ensure!(!self.stopping.load(std::sync::atomic::Ordering::Acquire), "Ghost host is stopping");
        let state = self.lock()?;
        let authority = lifetime::authority::current(&state.journal.0)?;
        ensure!(authority.epoch == self.authority_epoch && authority.dispatch_enabled,
            "memory writer authority is no longer current");
        ensure!(state.profiles.contains_key(profile_id), "memory Ghost is not registered in this Host");
        let registered: bool = state.journal.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1 AND conversation_id=?2)",
            params![profile_id, conversation_id], |row| row.get(0),
        )?;
        ensure!(registered, "memory conversation is not the registered Ghost pair");
        let policy: Policy = state.journal.get("policy", profile_id)?.unwrap_or_default();
        ensure!(policy.memory, "memory permission was revoked");
        ensure!(Brain::source_configured(), "memory requires an explicit Host-owned source ledger");
        Ok(())
    }

    pub(super) async fn owner_memory_source_inspect(
        &self, profile_id: &str, conversation_id: &str,
        origin: &TrustedSourceOrigin, content: &str,
    ) -> Result<Value> {
        let check = || self.owner_memory_source_guard(profile_id, conversation_id, &origin.owner);
        check()?;
        let ledger = SourceLedgerConfig::from_env()?;
        let receipt = self.brain.inspect_source(origin, content, &ledger, &check).await?;
        check()?;
        Ok(serde_json::to_value(success(
            "Original memory source receipt inspected; status is not an accepted fact",
            serde_json::to_value(receipt)?,
        ))?)
    }

    pub(super) async fn owner_memory_source_correct(
        &self, request_id: &str, profile_id: &str, conversation_id: &str,
        prior: &TrustedSourceOrigin, expected_prior_episode_id: &str,
        prior_content: &str, replacement_content: &str,
    ) -> Result<Value> {
        let check = || self.owner_memory_source_guard(profile_id, conversation_id, &prior.owner);
        check()?;
        let revision = format!("owner-correction:{request_id}");
        let hash = format!("{:x}", Sha256::digest(replacement_content.as_bytes()));
        let replacement = match &prior.kind {
            SourceOriginKind::Note => TrustedSourceOrigin::new(
                profile_id, &prior.source_id, revision, SourceDisclosure::LocalOnly, hash,
            )?,
            SourceOriginKind::Session { .. } => TrustedSourceOrigin::new_session(
                profile_id, &prior.source_id, revision, SourceDisclosure::LocalOnly, hash,
                format!("ghost-owner-correction/v1/{profile_id}/{request_id}"),
            )?,
        };
        let ledger = SourceLedgerConfig::from_env()?;
        let receipt = self.brain.correct_source(
            prior, expected_prior_episode_id, prior_content, &replacement,
            replacement_content, &ledger, &check,
        ).await?;
        let response = if check().is_err() || receipt.status != SourceStatus::CorrectionComplete {
            Response {
                status: ResponseStatus::Error,
                summary: "Memory correction is unresolved; inspect the original source, then explicitly resume its original Owner intent".into(),
                data: serde_json::to_value(receipt)?,
                object_refs: vec![], artifacts: vec![],
                next_actions: vec!["memory_source_inspect".into(), "memory_source_resume".into()],
                error_code: Some("effect_unknown".into()), retry_class: RetryClass::ReconcileFirst,
            }
        } else {
            success(
                "Memory source revision corrected; replacement remains untrusted source material",
                serde_json::to_value(receipt)?,
            )
        };
        Ok(serde_json::to_value(response)?)
    }

    pub(super) async fn owner_memory_source_resume(
        &self, profile_id: &str, conversation_id: &str, correction_request_id: &str,
    ) -> Result<Value> {
        uuid::Uuid::parse_str(correction_request_id)?;
        let payload: String = self.lock()?.journal.0.query_row(
            "SELECT payload FROM workspace_commands WHERE id=?1",
            params![correction_request_id], |row| row.get(0),
        )?;
        let original: crate::control::api::Command = serde_json::from_str(&payload)?;
        let crate::control::api::Command::Workspace {
            action: crate::control::api::OwnerAction::MemorySourceCorrect {
                profile_id: original_profile, conversation_id: original_conversation,
                prior, expected_prior_episode_id, prior_content, replacement_content,
            },
        } = original else {
            bail!("original Owner intent is not a memory source correction");
        };
        ensure!(profile_id == original_profile && conversation_id == original_conversation,
            "memory correction intent belongs to another Ghost conversation");
        // Reuse the journaled original UUID, bytes, source identity and CAS:
        // this fresh Owner authorization must not create a second revision.
        self.owner_memory_source_correct(
            correction_request_id, profile_id, conversation_id, &prior,
            &expected_prior_episode_id, &prior_content, &replacement_content,
        ).await
    }

    /// Newest-first journaled Owner correction intents for this exact Ghost
    /// pair. Read-only copy out of `workspace_commands`; foreign or unparseable
    /// rows are skipped and never interpreted. Exact-substring filters avoid
    /// LIKE wildcard semantics on Owner-controlled ids.
    fn owner_memory_correction_intents(
        &self, profile_id: &str, conversation_id: &str,
    ) -> Result<Vec<OwnerCorrectionIntent>> {
        let state = self.lock()?;
        let mut statement = state.journal.0.prepare(
            "SELECT id,payload,response FROM workspace_commands
             WHERE instr(payload,'\"memory_source_correct\"') > 0
             ORDER BY rowid DESC
             LIMIT ?1",
        )?;
        let mut intents = Vec::new();
        let mut rows = statement.query(params![MAX_MEMORY_SOURCE_INTENTS])?;
        while let Some(row) = rows.next()? {
            let request_id: String = row.get(0)?;
            let response: Option<String> = row.get(2)?;
            let Ok(original) = serde_json::from_str::<crate::control::api::Command>(
                &row.get::<_, String>(1)?,
            ) else {
                continue;
            };
            let crate::control::api::Command::Workspace {
                action: crate::control::api::OwnerAction::MemorySourceCorrect {
                    profile_id: original_profile, conversation_id: original_conversation,
                    prior, expected_prior_episode_id, prior_content, replacement_content,
                },
            } = original else { continue; };
            if original_profile != profile_id || original_conversation != conversation_id {
                continue;
            }
            intents.push(OwnerCorrectionIntent {
                request_id,
                resolution: intent_resolution(response),
                prior,
                expected_prior_episode_id,
                prior_content,
                replacement_content,
            });
        }
        Ok(intents)
    }

    /// Read-only Owner review of one registered Ghost pair's canonical memory
    /// sources: latest ledger receipts (metadata only), plus original text
    /// recovered solely from authentic durable records and hash-checked
    /// against the row's content digest. No state transition, no ingestion,
    /// and no pending attempt is resolved here.
    pub(super) fn owner_memory_source_list(
        &self, profile_id: &str, conversation_id: &str,
    ) -> Result<Value> {
        let check = || self.owner_memory_source_guard(profile_id, conversation_id, profile_id);
        check()?;
        let ledger = SourceLedgerConfig::from_env()?;
        let (listed, more) = self.brain.list_source_receipts(profile_id, &ledger, &check)?;
        check()?;
        let intents = self.owner_memory_correction_intents(profile_id, conversation_id)?;
        let mut views: Vec<OwnerMemorySourceView> = Vec::new();
        let mut matched = 0usize;
        for source in listed {
            if pair_source(profile_id, conversation_id, &source.origin.source_id).is_none() {
                continue;
            }
            matched += 1;
            if views.len() == MAX_MEMORY_SOURCE_LIST {
                continue;
            }
            let (content, correction_request_id) = recover_owner_source_text(
                &source.origin,
                source.prior_revision.as_deref(),
                source.receipt.episode_id.as_deref(),
                source.receipt.prior_episode_id.as_deref(),
                source.receipt.status,
                &source.redaction_state,
                &intents,
            );
            views.push(OwnerMemorySourceView {
                origin: source.origin,
                receipt: source.receipt,
                content,
                correction_request_id,
            });
        }
        let truncated = matched > views.len() || more;
        check()?;
        Ok(serde_json::to_value(success(
            "Memory source receipts listed; receipts are metadata and any recovered text is untrusted original source material",
            json!({"sources": views, "truncated": truncated}),
        ))?)
    }
}

#[cfg(test)]
mod source_list_tests {
    use super::*;

    fn note_origin(
        owner: &str, source_id: &str, revision: &str, content: &str,
    ) -> TrustedSourceOrigin {
        TrustedSourceOrigin::new(
            owner, source_id, revision, SourceDisclosure::LocalOnly,
            crate::adapters::documents::digest(content.as_bytes()),
        ).unwrap()
    }

    fn intent(
        request_id: &str, prior: &TrustedSourceOrigin,
        prior_content: &str, replacement_content: &str,
    ) -> OwnerCorrectionIntent {
        OwnerCorrectionIntent {
            request_id: request_id.to_owned(),
            resolution: IntentResolution::Inflight,
            prior: prior.clone(),
            expected_prior_episode_id: "e".repeat(64),
            prior_content: prior_content.to_owned(),
            replacement_content: replacement_content.to_owned(),
        }
    }

    fn resolved(
        mut intent: OwnerCorrectionIntent, resolution: IntentResolution,
    ) -> OwnerCorrectionIntent {
        intent.resolution = resolution;
        intent
    }

    #[test]
    fn pair_scope_never_leaks_through_shared_prefixes() {
        let scope = |source_id: &str| pair_source("ghost-1", "conv-1", source_id).is_some();
        assert!(scope("canonical:ghost-1:conv-1:t1:effect:c1"));
        // Real Pi effect ids are opaque and contain further colons.
        assert!(scope("canonical:ghost-1:conv-1:t1:effect:pi-tool-v2:c4cc6683"));
        assert!(scope("canonical-session:ghost-1:conv-1:t1"));
        assert!(!scope("canonical:ghost-1:conv-10:t1:effect:pi-tool-v2:c4cc"));
        assert!(!scope("canonical:ghost-10:conv-1:t1:effect:pi-tool-v2:c4cc"));
        assert!(!scope("canonical-session:ghost-1:conv-1:"));
        assert!(!scope("canonical:ghost-1:conv-1:t1"));
        assert!(!scope("canonical:ghost-1:conv-1:t1:effect:"));
        assert!(!scope("canonical:ghost-1:conv-1::effect:pi-tool-v2:c4cc"));
        assert!(!scope("foreign:ghost-1:conv-1:t1:effect:c1"));
        assert!(matches!(
            pair_source("ghost-1", "conv-1", "canonical:ghost-1:conv-1:turn-9:effect:pi-tool-v2:abc"),
            Some(PairSource::Note)
        ));
        assert!(matches!(
            pair_source("ghost-1", "conv-1", "canonical-session:ghost-1:conv-1:turn-9"),
            Some(PairSource::Session)
        ));
    }

    #[test]
    fn in_flight_attempt_exposes_original_uuid_and_prior_text() {
        let content = "원본 메모";
        let origin = note_origin("owner", "canonical:owner:conv:t1:effect:c1", "revision-1", content);
        let intents = [intent("248a615b-0000-4000-8000-000000000000", &origin, content, "수정 메모")];
        let (recovered, request) = recover_owner_source_text(
            &origin, None, Some(&"e".repeat(64)), None,
            SourceStatus::Recorded, "none", &intents,
        );
        assert_eq!(recovered.as_deref(), Some(content));
        assert_eq!(request.as_deref(), Some("248a615b-0000-4000-8000-000000000000"));
    }

    #[test]
    fn terminal_denials_recover_text_but_never_block_new_intents() {
        let content = "원본 메모";
        let origin = note_origin("owner", "canonical:owner:conv:t1:effect:c1", "revision-1", content);
        let denied = [resolved(
            intent("248a615b-0000-4000-8000-000000000000", &origin, content, "수정 메모"),
            IntentResolution::Terminal,
        )];
        let (recovered, request) = recover_owner_source_text(
            &origin, None, Some(&"e".repeat(64)), None,
            SourceStatus::Recorded, "none", &denied,
        );
        assert_eq!(recovered.as_deref(), Some(content));
        assert_eq!(request, None);
        // A stale expected episode never marks the row pending either.
        let stale = [resolved(
            intent("248a615b-0000-4000-8000-000000000000", &origin, content, "수정 메모"),
            IntentResolution::Inflight,
        )];
        let (recovered, request) = recover_owner_source_text(
            &origin, None, Some(&"f".repeat(64)), None,
            SourceStatus::Recorded, "none", &stale,
        );
        assert_eq!(recovered.as_deref(), Some(content));
        assert_eq!(request, None);
    }

    #[test]
    fn completed_correction_is_not_pending_but_stays_readable() {
        let prior_content = "원본 메모";
        let replacement_content = "수정된 메모";
        let prior = note_origin("owner", "canonical:owner:conv:t1:effect:c1", "revision-1", prior_content);
        let replacement = note_origin(
            "owner", "canonical:owner:conv:t1:effect:c1",
            "owner-correction:248a615b-0000-4000-8000-000000000000", replacement_content,
        );
        let intents = [intent(
            "248a615b-0000-4000-8000-000000000000", &prior, prior_content, replacement_content,
        )];
        let (recovered, request) = recover_owner_source_text(
            &replacement, Some(&prior.revision), Some(&"d".repeat(64)), Some(&"e".repeat(64)),
            SourceStatus::Recorded, "complete", &intents,
        );
        assert_eq!(recovered.as_deref(), Some(replacement_content));
        assert_eq!(request, None);
        let (recovered, request) = recover_owner_source_text(
            &replacement, Some(&prior.revision), Some(&"d".repeat(64)), Some(&"e".repeat(64)),
            SourceStatus::EffectUnknown, "sent", &intents,
        );
        assert_eq!(recovered.as_deref(), Some(replacement_content));
        assert_eq!(request.as_deref(), Some("248a615b-0000-4000-8000-000000000000"));
        // A confirmed terminal denial on the bound intent is not resumable.
        let denied = [resolved(
            intent(
                "248a615b-0000-4000-8000-000000000000", &prior, prior_content, replacement_content,
            ),
            IntentResolution::Terminal,
        )];
        let (recovered, request) = recover_owner_source_text(
            &replacement, Some(&prior.revision), Some(&"d".repeat(64)), Some(&"e".repeat(64)),
            SourceStatus::EffectUnknown, "sent", &denied,
        );
        assert_eq!(recovered.as_deref(), Some(replacement_content));
        assert_eq!(request, None);
    }

    #[test]
    fn redacted_prior_history_is_inspect_only_without_pending_uuid() {
        let prior_content = "원본 메모";
        let prior = note_origin("owner", "canonical:owner:conv:t1:effect:c1", "revision-1", prior_content);
        let intents = [intent(
            "248a615b-0000-4000-8000-000000000000", &prior, prior_content, "수정된 메모",
        )];
        let (recovered, request) = recover_owner_source_text(
            &prior, None, Some(&"e".repeat(64)), None,
            SourceStatus::Redacted, "none", &intents,
        );
        assert_eq!(recovered.as_deref(), Some(prior_content));
        assert_eq!(request, None);
    }

    #[test]
    fn unauthenticated_or_foreign_intents_keep_content_hidden() {
        let origin = note_origin("owner", "canonical:owner:conv:t1:effect:c1", "revision-1", "원본 메모");
        let mismatched = [intent("req-1", &origin, "다른 텍스트", "수정")];
        let (recovered, request) = recover_owner_source_text(
            &origin, None, Some(&"e".repeat(64)), None,
            SourceStatus::Recorded, "none", &mismatched,
        );
        assert_eq!(recovered, None);
        assert_eq!(request, None);
        let (recovered, request) = recover_owner_source_text(
            &origin, None, Some(&"e".repeat(64)), None,
            SourceStatus::Recorded, "none", &[],
        );
        assert_eq!(recovered, None);
        assert_eq!(request, None);
        let claimed = note_origin(
            "owner", "canonical:owner:conv:t1:effect:c1",
            "owner-correction:00000000-0000-4000-8000-000000000001", "텍스트",
        );
        let (recovered, request) = recover_owner_source_text(
            &claimed, Some("revision-1"), Some(&"d".repeat(64)), Some(&"e".repeat(64)),
            SourceStatus::Recorded, "none", &[],
        );
        assert_eq!(recovered, None);
        assert_eq!(request, None);
    }

    #[test]
    fn terminal_receipt_states_never_read_as_pending() {
        // The durable outcome parser only trusts in-flight and explicit
        // effect_unknown replies; anything else is terminal.
        assert!(matches!(
            intent_resolution(None),
            IntentResolution::Inflight
        ));
        let unresolved = serde_json::json!({"ok": true, "result": {
            "status": "error", "error_code": "effect_unknown", "retry_class": "reconcile_first",
        }});
        assert!(matches!(
            intent_resolution(Some(unresolved.to_string())),
            IntentResolution::Unresolved
        ));
        let success = serde_json::json!({"ok": true, "result": {
            "status": "success", "error_code": null,
        }});
        assert!(matches!(
            intent_resolution(Some(success.to_string())),
            IntentResolution::Terminal
        ));
        let blocked = serde_json::json!({"ok": true, "result": {
            "status": "error", "error_code": "unauthorized",
        }});
        assert!(matches!(
            intent_resolution(Some(blocked.to_string())),
            IntentResolution::Terminal
        ));
        let host_error = serde_json::json!({"ok": false, "error": "memory source belongs to another Ghost"});
        assert!(matches!(
            intent_resolution(Some(host_error.to_string())),
            IntentResolution::Terminal
        ));
        assert!(matches!(
            intent_resolution(Some("not json".to_owned())),
            IntentResolution::Terminal
        ));
    }
}
