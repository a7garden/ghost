//! Canonical document ingress for the single owned Primary. Source identity
//! and disclosure are Host facts: every method is bound to an accepted local
//! Pi route, a current immutable Owner turn inside the registered pair, and an
//! explicit Space grant. Model text never supplies an actor, epoch, route, or
//! source scope. Hosted/public inference receives no document tools or source.
//! The existing document adapter and journal Review plane are reused; this
//! module never opens a second store or saves a page by itself.
use super::{lifetime, now_ms, Host};
use crate::{
    adapters::documents,
    domain::{LifetimeReviewOrigin, Review},
    lifetime_contract::{Response, ResponseStatus, RetryClass},
};
use anyhow::{anyhow, bail, ensure, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

const REVIEW_TTL_MS: u64 = 86_400_000;
const FRAME_FIELDS: &[&str] = &["method", "ghost_id", "conversation_id", "turn_id"];
const PDC2_PROFILES: &[&str] = &["pdc-markdown/1", "pdc-html/1"];

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
        .ok_or_else(|| anyhow!("missing documents {name}"))?;
    ensure!(!value.trim().is_empty() && value.len() <= 8192, "documents {name} exceeds its text bound");
    Ok(value)
}

fn bounded<'a>(body: &'a Value, name: &str, limit: usize) -> Result<&'a str> {
    let value = body.get(name).and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing documents {name}"))?;
    ensure!(!value.is_empty() && value.len() <= limit, "documents {name} exceeds its size bound");
    Ok(value)
}

fn optional_bounded<'a>(body: &'a Value, name: &str, limit: usize) -> Result<Option<&'a str>> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            ensure!(!value.is_empty() && value.len() <= limit, "documents {name} exceeds its size bound");
            Ok(Some(value))
        }
        Some(_) => bail!("documents {name} must be a string"),
    }
}

/// Deterministic proposal identity derived from the authenticated command.
/// Retries of the same command reconstruct the same proposal; a different
/// command (or a changed body) can never collide with it.
fn proposal_id(ghost_id: &str, conversation_id: &str, turn_id: &str, command_id: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("lifetime-review\x1f{ghost_id}\x1f{conversation_id}\x1f{turn_id}\x1f{command_id}").as_bytes(),
    ).to_string()
}

/// One Space with an explicit current grant for this Ghost; read-only spaces
/// still serve reads and never accept proposals.
fn granted_space(s: &super::State, ghost_id: &str, space_id: &str) -> Result<documents::Space> {
    let space: documents::Space = s.journal.get("space", space_id)?
        .ok_or_else(|| anyhow!("Space missing"))?;
    ensure!(space.profiles.iter().any(|profile| profile == ghost_id), "current Space access denied");
    Ok(space)
}

/// Spaces explicitly granted to this Ghost. Raw filesystem paths and other
/// members are never returned.
fn granted_spaces(s: &super::State, ghost_id: &str) -> Result<Vec<documents::Space>> {
    Ok(s.journal.objects::<documents::Space>("space")?
        .into_iter()
        .filter(|space| space.profiles.iter().any(|profile| profile == ghost_id))
        .collect())
}

/// Current explicit grant plus writability, re-provable immediately before
/// any durable proposal admission.
fn writable_grant(s: &super::State, ghost_id: &str, space_id: &str) -> Result<documents::Space> {
    let space = granted_space(s, ghost_id, space_id)?;
    ensure!(space.writable, "Space is read-only");
    Ok(space)
}

/// Source-safe proposal projection: never echoes stored result bytes or any
/// Space membership/path data.
fn review_data(review: &Review, with_draft: bool) -> Value {
    let mut data = json!({
        "review_id": review.id,
        "state": review.state,
        "space_id": review.space_id,
        "page_id": review.page_id,
        "profile": review.profile,
        "created": review.created,
        "expires_ms": review.expires_ms,
    });
    if with_draft {
        data["title"] = json!(review.title);
        data["body"] = json!(review.body);
    }
    if let Some(expected) = &review.expected_hash {
        data["expected_hash"] = json!(expected);
    }
    if let Some(origin) = &review.lifetime_origin {
        data["origin"] = json!({
            "turn_id": origin.turn_id,
            "authority_epoch": origin.authority_epoch,
            "request_digest": origin.request_digest,
        });
    }
    if let Some(hash) = review.result.as_ref()
        .and_then(|value| value["planned_hash"].as_str().or_else(|| value["hash"].as_str()))
    {
        data["hash"] = json!(hash);
    }
    data
}

impl Host {
    /// Scope proof shared by every documents method: current authority, local
    /// Pi route, registered Pi binding, and an immutable Owner turn inside the
    /// authenticated pair. Returns the proven turn identity.
    fn document_scope<'a>(
        &self,
        request: &'a lifetime::PiToolRequest,
        route: lifetime::PiInferenceScope,
    ) -> Result<&'a str> {
        let state = self.lock()?;
        if let Some(response) = self.check_pi_host_scope(&state, request, route)? {
            bail!("{}: {}", response.error_code.as_deref().unwrap_or("unauthorized"), response.summary);
        }
        if let Some(response) = lifetime::pi_tool_guard(&state.journal.0, request, route)? {
            bail!("{}: {}", response.error_code.as_deref().unwrap_or("unauthorized"), response.summary);
        }
        if route != lifetime::PiInferenceScope::Local {
            bail!("documents require an accepted local Pi route; hosted inference receives no document tools or source");
        }
        let body = &request.envelope.body;
        ensure!(string(body, "ghost_id")? == request.ghost_id
            && string(body, "conversation_id")? == request.conversation_id,
            "document request exceeds the authenticated Pi pair");
        let turn_id = string(body, "turn_id")?;
        let owner_turn: Option<()> = state.journal.0.query_row(
            "SELECT 1 FROM lifetime_turns t
             JOIN lifetime_registry r ON r.ghost_id=t.ghost_id AND r.conversation_id=t.conversation_id
             WHERE t.id=?1 AND t.ghost_id=?2 AND t.conversation_id=?3
               AND t.kind='user' AND t.sender_kind='owner' AND t.sender_ref='owner'",
            params![turn_id, request.ghost_id, request.conversation_id],
            |_| Ok(()),
        ).optional()?;
        ensure!(owner_turn.is_some(), "document origin is not an immutable Owner turn in the registered pair");
        Ok(turn_id)
    }

    /// Re-prove the captured scope after unhosted I/O, before any durable
    /// admission. Authority, grants, and the immutable turn must be unchanged.
    fn document_scope_unchanged(
        &self,
        request: &lifetime::PiToolRequest,
        route: lifetime::PiInferenceScope,
        captured: &str,
    ) -> Result<()> {
        let current = self.document_scope(request, route)?;
        ensure!(current == captured, "document scope changed during I/O; no admission occurred");
        Ok(())
    }

    /// New document proposals additionally require the controller turn to
    /// still be a live, uncancelled run: finished turns can approve their
    /// earlier proposals but cannot mint new ones.
    fn proposal_admission(&self, request: &lifetime::PiToolRequest, turn_id: &str) -> Result<()> {
        let state = self.lock()?;
        let live: bool = state.journal.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs
             WHERE turn_id=?1 AND ghost_id=?2 AND conversation_id=?3
               AND cancel_requested=0 AND state IN ('queued','running'))",
            params![turn_id, request.ghost_id, request.conversation_id],
            |row| row.get(0),
        )?;
        ensure!(live, "the Owner controller turn no longer permits new document proposals");
        Ok(())
    }

    pub(crate) fn lifetime_documents_action(
        &self,
        request: &lifetime::PiToolRequest,
        route: lifetime::PiInferenceScope,
    ) -> Result<Response> {
        request.envelope.validate()?;
        let body = &request.envelope.body;
        let method = string(body, "method")?;
        let extra: &[&str] = match method {
            "documents.capabilities" | "documents.list_spaces" => &[],
            "documents.list_pages" => &["space_id", "query"],
            "documents.read_page" => &["space_id", "page_id", "locator"],
            "documents.review_page" => &["space_id", "title", "body", "profile", "page_id", "expected_hash"],
            "documents.review.inspect" => &["review_id"],
            _ => return Ok(denied("unsupported_method", "Document method is not in the controller action space", RetryClass::Never)),
        };
        let Some(fields) = body.as_object() else { bail!("documents body must be an object"); };
        if fields.keys().any(|field| !FRAME_FIELDS.contains(&field.as_str()) && !extra.contains(&field.as_str())) {
            return Ok(denied("invalid_request", "Model-supplied document scope or source fields are forbidden", RetryClass::Never));
        }
        if route != lifetime::PiInferenceScope::Local {
            return Ok(denied("disclosure_blocked",
                "Documents require an accepted local Pi route; hosted inference receives no document tools or source",
                RetryClass::Never));
        }
        let captured_turn = match self.document_scope(request, route) {
            Ok(turn_id) => turn_id,
            Err(error) => return Ok(denied("unauthorized", error.to_string(), RetryClass::Never)),
        };
        if !cfg!(feature = "documents") {
            return match method {
                "documents.capabilities" => Ok(success(
                    "No document tools are available in this captured scope",
                    json!({"available_tools": []}),
                )),
                _ => Ok(denied("documents_unavailable",
                    "Documents require the documents feature, an explicit Space grant and an accepted local Pi route",
                    RetryClass::Never)),
            };
        }
        if method == "documents.capabilities" {
            let spaces = granted_spaces(&*self.lock()?, &request.ghost_id)?;
            let mut tools: Vec<&str> = Vec::new();
            if !spaces.is_empty() {
                tools.extend(["list_spaces", "list_pages", "read_page"]);
                if spaces.iter().any(|space| space.writable) {
                    tools.extend(["review_page", "inspect_review"]);
                }
            }
            return Ok(success("Live scoped document capabilities inspected", json!({"available_tools": tools})));
        }
        match method {
            "documents.list_spaces" => self.documents_list_spaces(request, &captured_turn),
            "documents.list_pages" => self.documents_list_pages(request, &captured_turn),
            "documents.read_page" => self.documents_read_page(request, &captured_turn),
            "documents.review_page" => self.documents_review_page(request, &captured_turn),
            "documents.review.inspect" => self.documents_review_inspect(request, &captured_turn),
            _ => unreachable!("document method was checked before scope inspection"),
        }
    }

    fn documents_list_spaces(&self, request: &lifetime::PiToolRequest, _turn_id: &str) -> Result<Response> {
        let spaces: Vec<Value> = granted_spaces(&*self.lock()?, &request.ghost_id)?
            .into_iter()
            .map(|space| json!({"id": space.id, "name": space.name, "writable": space.writable}))
            .collect();
        Ok(success("Authorized document Spaces", json!({"spaces": spaces})))
    }

    fn documents_list_pages(&self, request: &lifetime::PiToolRequest, turn_id: &str) -> Result<Response> {
        let body = &request.envelope.body;
        let space_id = bounded(body, "space_id", 200)?;
        let query = optional_bounded(body, "query", 1000)?.unwrap_or("");
        let space = granted_space(&*self.lock()?, &request.ghost_id, space_id)?;
        let pages = documents::list(&space, query)?;
        self.document_scope_unchanged(request, lifetime::PiInferenceScope::Local, turn_id)?;
        granted_space(&*self.lock()?, &request.ghost_id, space_id)?;
        Ok(success("Documents and visible diagnostics", json!({"space_id": space_id, "pages": pages})))
    }

    fn documents_read_page(&self, request: &lifetime::PiToolRequest, turn_id: &str) -> Result<Response> {
        let body = &request.envelope.body;
        let space_id = bounded(body, "space_id", 200)?;
        let page_id = optional_bounded(body, "page_id", 200)?;
        let locator = optional_bounded(body, "locator", 1024)?;
        let page = match (page_id, locator) {
            (Some(page_id), None) => {
                let space = granted_space(&*self.lock()?, &request.ghost_id, space_id)?;
                documents::read(&space, page_id)?
            }
            (None, Some(locator)) => {
                let space = granted_space(&*self.lock()?, &request.ghost_id, space_id)?;
                documents::read_source(&space, locator)?
            }
            _ => return Ok(denied("invalid_request",
                "read_page requires exactly one of page_id or locator", RetryClass::Never)),
        };
        self.document_scope_unchanged(request, lifetime::PiInferenceScope::Local, turn_id)?;
        granted_space(&*self.lock()?, &request.ghost_id, space_id)?;
        // Rendered HTML is a presentation artifact, not source; untrusted
        // source, body, identity and hash are what a proposal is bound to.
        let mut page = page;
        page.preview = None;
        Ok(success(
            "Untrusted document source; preserve identity and source hash",
            serde_json::to_value(page)?,
        ))
    }

    fn documents_review_page(&self, request: &lifetime::PiToolRequest, turn_id: &str) -> Result<Response> {
        let envelope = &request.envelope;
        let body = &envelope.body;
        let space_id = bounded(body, "space_id", 200)?.to_owned();
        let title = bounded(body, "title", 640)?;
        let content = bounded(body, "body", 524_288)?;
        let profile = optional_bounded(body, "profile", 32)?.unwrap_or("pdc-markdown/1");
        if !PDC2_PROFILES.contains(&profile) {
            return Ok(denied("invalid_request",
                "new documents must use a PDC 2 Markdown or HTML profile", RetryClass::Never));
        }
        let page_id = optional_bounded(body, "page_id", 200)?;
        let expected_hash = optional_bounded(body, "expected_hash", 128)?;
        match (page_id, expected_hash) {
            (Some(_), Some(_)) | (None, None) => {}
            (Some(_), None) => return Ok(denied("invalid_request",
                "editing an existing page requires its current source hash", RetryClass::Never)),
            (None, Some(_)) => return Ok(denied("invalid_request",
                "expected_hash is only valid together with page_id", RetryClass::Never)),
        }
        let id = proposal_id(&request.ghost_id, &request.conversation_id, turn_id, &envelope.command_id);
        let existing: Option<Review> = self.lock()?.journal.get("review", &id)?;
        if let Some(previous) = existing {
            let Some(origin) = previous.lifetime_origin.as_ref() else {
                return Ok(denied("conflict", "proposal has no lifetime provenance", RetryClass::Never));
            };
            // Fence, source cancellation/expiry and current grant precede replay.
            // Reuse the immutable proposal identity before generating any new page.
            if let Err(error) = verify_owner_save(self, &*self.lock()?, &previous, origin) {
                return Ok(denied("unauthorized", error.to_string(), RetryClass::Never));
            }
            let same = origin.request_digest == envelope.payload_digest
                && origin.turn_id == turn_id
                && previous.profile_id == request.ghost_id
                && previous.conversation_id == request.conversation_id
                && previous.space_id == space_id
                && page_id.map_or(previous.expected_hash.is_none(), |page_id| previous.page_id == page_id)
                && previous.expected_hash.as_deref() == expected_hash
                && previous.title == title
                && previous.body == content
                && previous.profile == profile;
            if !same {
                return Ok(denied("conflict",
                    "proposal identity was already used with different content; no existing proposal was mutated",
                    RetryClass::Never));
            }
            return Ok(success(
                "Document proposal re-inspected at its current review state",
                review_data(&previous, false),
            ));
        }
        if let Err(error) = self.proposal_admission(request, turn_id) {
            return Ok(denied("unauthorized", error.to_string(), RetryClass::Never));
        }
        // Canonical proposed bytes are validated before any durable admission.
        let created = documents::timestamp()?;
        let resolved_page_id;
        let planned_hash;
        {
            let space = writable_grant(&*self.lock()?, &request.ghost_id, &space_id)?;
            match page_id {
                Some(existing) => {
                    let current = documents::read(&space, existing)
                        .map_err(|error| anyhow!("page inspection failed: {error}"))?;
                    if current.legacy {
                        return Ok(denied("legacy_document_read_only",
                            "legacy_document_read_only: create a separate PDC 2 target after backup",
                            RetryClass::Never));
                    }
                    if current.hash != expected_hash.unwrap_or_default() {
                        return Ok(denied("conflict",
                            "external_change_conflict: re-read the document before proposing edits",
                            RetryClass::NewRevision));
                    }
                    planned_hash = documents::digest(&documents::proposed_source(&current, title, content, &created)?);
                    resolved_page_id = existing.to_owned();
                }
                None => {
                    let new_id = uuid::Uuid::now_v7().to_string();
                    let (_locator, bytes) = documents::new_source(&new_id, title, content, profile, &created)?;
                    planned_hash = documents::digest(&bytes);
                    resolved_page_id = new_id;
                }
            }
        }
        self.document_scope_unchanged(request, lifetime::PiInferenceScope::Local, turn_id)?;
        self.proposal_admission(request, turn_id)?;
        writable_grant(&*self.lock()?, &request.ghost_id, &space_id)?;
        let review = Review {
            id: id.clone(),
            profile_id: request.ghost_id.clone(),
            conversation_id: request.conversation_id.clone(),
            task_id: String::new(),
            space_id,
            page_id: resolved_page_id,
            title: title.to_owned(),
            body: content.to_owned(),
            profile: profile.to_owned(),
            expected_hash: expected_hash.map(str::to_owned),
            created,
            expires_ms: now_ms().saturating_add(REVIEW_TTL_MS),
            state: "pending".into(),
            result: None,
            lifetime_origin: Some(LifetimeReviewOrigin {
                turn_id: turn_id.to_owned(),
                authority_epoch: envelope.authority_epoch,
                request_digest: envelope.payload_digest.clone(),
            }),
        };
        self.lock()?.journal.put("review", &id, &review)?;
        let mut data = review_data(&review, false);
        data["planned_hash"] = json!(planned_hash);
        Ok(success(
            "Document proposal is pending Owner review; this call never saves. Tell the Owner to inspect and decide on this review.",
            data,
        ))
    }

    fn documents_review_inspect(&self, request: &lifetime::PiToolRequest, turn_id: &str) -> Result<Response> {
        let body = &request.envelope.body;
        let review_id = bounded(body, "review_id", 200)?;
        let review: Option<Review> = self.lock()?.journal.get("review", review_id)?;
        let Some(review) = review else {
            return Ok(denied("not_found", "review proposal missing", RetryClass::Never));
        };
        let lifetime_origin_ok = review.lifetime_origin.is_some();
        if !lifetime_origin_ok
            || review.profile_id != request.ghost_id
            || review.conversation_id != request.conversation_id
        {
            return Ok(denied("not_found",
                "review proposal is outside the authenticated Pi pair", RetryClass::Never));
        }
        self.document_scope_unchanged(request, lifetime::PiInferenceScope::Local, turn_id)?;
        if let Err(error) = granted_space(&*self.lock()?, &request.ghost_id, &review.space_id) {
            return Ok(denied("unauthorized", error.to_string(), RetryClass::Never));
        }
        Ok(success(
            "Recorded document proposal; approval and saving stay with the Owner",
            review_data(&review, true),
        ))
    }
}

/// Owner-side re-proof before an existing lifetime proposal may be saved. The
/// legacy task-phase branch never runs for these proposals: they carry no
/// Task, and approval always flows through the existing Review/PDC save path.
pub(crate) fn verify_owner_save(
    app: &Host,
    s: &super::State,
    review: &Review,
    origin: &LifetimeReviewOrigin,
) -> Result<()> {
    ensure!(now_ms() < review.expires_ms, "proposal expired; no document saved");
    let authority = lifetime::authority::current(&s.journal.0)?;
    ensure!(
        authority.epoch == origin.authority_epoch && authority.epoch == app.authority_epoch,
        "proposal authority epoch is no longer current; ask for a fresh proposal"
    );
    ensure!(s.profiles.contains_key(&review.profile_id), "Ghost missing");
    let registered: Option<()> = s.journal.0.query_row(
        "SELECT 1 FROM lifetime_registry r
         JOIN lifetime_turns t ON t.ghost_id=r.ghost_id AND t.conversation_id=r.conversation_id
         WHERE r.ghost_id=?1 AND r.conversation_id=?2 AND t.id=?3
           AND t.kind='user' AND t.sender_kind='owner' AND t.sender_ref='owner'",
        params![review.profile_id, review.conversation_id, origin.turn_id],
        |_| Ok(()),
    ).optional()?;
    ensure!(registered.is_some(), "proposal source pair or Owner turn is no longer registered");
    let uncancelled: bool = s.journal.0.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs
         WHERE turn_id=?1 AND ghost_id=?2 AND conversation_id=?3 AND cancel_requested=0)",
        params![origin.turn_id, review.profile_id, review.conversation_id],
        |row| row.get(0),
    )?;
    ensure!(uncancelled, "proposal source turn was cancelled; refusing to save");
    let space: documents::Space = s.journal.get("space", &review.space_id)?
        .ok_or_else(|| anyhow!("Space missing"))?;
    ensure!(space.writable, "Space is read-only");
    ensure!(
        space.profiles.iter().any(|profile| profile == &review.profile_id),
        "Space access was revoked"
    );
    Ok(())
}
