//! A failed evaluation may repair instructions twice under its original
//! authenticated create intent. A report is evidence of this narrow capability,
//! never an Owner identity or a new resource grant.
use super::*;
const LINEAGE: &str = "bot_candidate_lineage_v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Lineage {
    root: String,
    parent: Option<String>,
    revision: u64,
}
fn lineage(conn: &Connection, c: &Candidate) -> Result<Lineage> {
    lineage_at(conn, c, 0)
}
fn lineage_at(conn: &Connection, c: &Candidate, depth: usize) -> Result<Lineage> {
    ensure!(depth < 3, "bot repair lineage cycle or excessive depth");
    let Some(value) = load::<Lineage>(conn, LINEAGE, &c.id)? else {
        return Ok(Lineage {
            root: c.id.clone(),
            parent: None,
            revision: 1,
        });
    };
    ensure!(
        (2..=3).contains(&value.revision),
        "invalid bot repair revision"
    );
    let root = candidate(conn, &value.root)?;
    let parent = candidate(
        conn,
        value
            .parent
            .as_deref()
            .ok_or_else(|| anyhow!("repair parent missing"))?,
    )?;
    let previous = lineage_at(conn, &parent, depth + 1)?;
    ensure!(
        previous.root == value.root
            && previous.revision + 1 == value.revision
            && c.id == repair_id(&value.root, value.revision)
            && root.definition.ghost_id == c.definition.ghost_id
            && root.profile_name == c.profile_name
            && root.conversation_id == c.conversation_id
            && root.intent_turn_id == c.intent_turn_id
            && root.issuer_ghost == c.issuer_ghost
            && root.source_contract_ref == c.source_contract_ref
            && root.source_contract == c.source_contract
            && root.evaluation_inputs == c.evaluation_inputs,
        "bot repair identity chain changed"
    );
    Ok(value)
}
fn repair_id(root: &str, revision: u64) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("ghost-bot-repair/1:{root}:{revision}").as_bytes(),
    )
    .to_string()
}
pub(super) fn in_current_lineage(
    conn: &Connection,
    c: &Candidate,
    intent: &CreationIntent,
) -> Result<bool> {
    let Some(id) = &intent.candidate_id else {
        return Ok(false);
    };
    let mut current = candidate(conn, id)?;
    if intent.candidate_digest.as_deref() != Some(current.digest.as_str()) {
        return Ok(false);
    }
    for _ in 0..3 {
        if current.id == c.id {
            return Ok(current.digest == c.digest);
        }
        let l = lineage(conn, &current)?;
        let Some(parent) = l.parent else {
            return Ok(false);
        };
        current = candidate(conn, &parent)?;
    }
    Ok(false)
}
fn proof(
    conn: &Connection,
    ghost: &str,
    conversation: &str,
    report: &str,
    c: &Candidate,
    epoch: u64,
    require_current: bool,
) -> Result<()> {
    ensure!(
        c.issuer_ghost.as_deref() == Some(ghost),
        "repair issuer is outside the original creation scope"
    );
    let goal = super::super::lifetime::bot_repair_report_goal(conn, report, ghost, conversation)?;
    let p = progress(conn, &c.id)?;
    ensure!(
        p.state == "failed"
            && p.receipts["blocker"] == "independent_evaluation_failed"
            && p.evaluation_goal_id.as_deref() == Some(goal.id.as_str()),
        "report is not this candidate's failed evaluation"
    );
    let turn = c
        .intent_turn_id
        .as_deref()
        .ok_or_else(|| anyhow!("repair has no Owner create intent"))?;
    let body = json!({"method":"bot.evaluate","candidate_id":c.id,"candidate_digest":c.digest,"intent_turn_id":turn});
    let e = Envelope {
        protocol_version: crate::lifetime_contract::VERSION.into(),
        command_id: format!("bot-repair-proof:{report}"),
        actor_ref: ghost.into(),
        authority_epoch: epoch,
        expected_revision: None,
        correlation_id: report.into(),
        payload_digest: canonical_digest(&body)?,
        body,
    };
    authorize_source(conn, &e, ghost, !require_current)?;
    if require_current {
        current_policy(conn, c)?;
    }
    Ok(())
}
pub(crate) fn repair_descriptor(
    conn: &Connection,
    request: &super::super::lifetime::PiToolRequest,
    scope: super::super::lifetime::PiInferenceScope,
) -> Result<Option<Value>> {
    let report = field(&request.envelope.body, "report_id")?;
    let goal = super::super::lifetime::bot_repair_report_goal(
        conn,
        report,
        &request.ghost_id,
        &request.conversation_id,
    )?;
    let ids = {
        let mut q=conn.prepare("SELECT id FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.state')='failed' AND json_extract(payload,'$.evaluation_goal_id')=?2")?;
        let rows = q
            .query_map(params![PROGRESS, goal.id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    ensure!(
        ids.len() <= 1,
        "failed bot evaluation identity is ambiguous"
    );
    let Some(id) = ids.first() else {
        return Ok(None);
    };
    let c = candidate(conn, id)?;
    let l = lineage(conn, &c)?;
    if l.revision >= 3
        || (scope != super::super::lifetime::PiInferenceScope::Local && c.privacy != "public")
    {
        return Ok(None);
    }
    if proof(
        conn,
        &request.ghost_id,
        &request.conversation_id,
        report,
        &c,
        request.envelope.authority_epoch,
        true,
    )
    .is_err()
    {
        return Ok(None);
    }
    let intent = creation_intent(conn, c.intent_turn_id.as_deref().unwrap())?;
    if intent.candidate_id.as_deref() != Some(c.id.as_str())
        || intent.candidate_digest.as_deref() != Some(c.digest.as_str())
    {
        return Ok(None);
    }
    Ok(Some(
        json!({"report_id":report,"candidate_id":c.id,"candidate_digest":c.digest,"candidate_revision":l.revision,"repairs_remaining":3-l.revision}),
    ))
}
fn replacement(
    conn: &Connection,
    old: &Candidate,
    instructions: &str,
) -> Result<(Candidate, Lineage)> {
    ensure!(
        !instructions.is_empty() && instructions.len() <= 32768,
        "repair instruction text exceeds its bound"
    );
    let bound_instructions=old.source_contract.as_ref().map(|pin|pin.with_notes(instructions)).transpose()?;
    let instructions=bound_instructions.as_deref().unwrap_or(instructions);
    let previous = lineage(conn, old)?;
    ensure!(previous.revision < 3, "bot repair budget exhausted");
    let l = Lineage {
        root: previous.root,
        parent: Some(old.id.clone()),
        revision: previous.revision + 1,
    };
    let mut c = old.clone();
    c.id = repair_id(&l.root, l.revision);
    c.request_ref = format!("bot-repair/1:{}:{}", l.root, l.revision);
    let mut asset = c.assets[0].clone();
    asset.content = instructions.into();
    asset.reference.revision = asset
        .reference
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow!("instruction revision exhausted"))?;
    asset.reference.digest = format!("{:x}", Sha256::digest(instructions.as_bytes()));
    asset.validate()?;
    c.assets[0] = asset.clone();
    let mut content = c.definition.content.clone();
    content.instruction_ref = asset.reference;
    // This candidate has not activated a definition. Its first installed
    // definition remains revision one; the candidate lineage has its own count.
    c.definition = BotDefinition::new(old.definition.ghost_id.clone(), 1, content)?;
    c.digest = c.expected_digest()?;
    c.validate()?;
    Ok((c, l))
}
/// Reconstruct only the Host-normalized evaluation request. This also verifies
/// repair provenance when the immutable Work reaches Pi after a reopen.
pub(super) fn evaluation_envelope(
    conn: &Connection,
    e: &Envelope,
    require_current: bool,
) -> Result<Envelope> {
    exact(
        &e.body,
        &[
            "method",
            "candidate_id",
            "candidate_digest",
            "repair_of_id",
            "repair_of_digest",
            "repair_instructions",
            "source_report_id",
            "intent_turn_id",
            "source_callback_digest",
        ],
    )?;
    ensure!(e.body["method"] == "bot.repair", "unexpected repair source");
    let old = candidate(conn, field(&e.body, "repair_of_id")?)?;
    ensure!(
        e.body["repair_of_digest"] == old.digest,
        "repair source digest changed"
    );
    let (new, _) = replacement(conn, &old, field(&e.body, "repair_instructions")?)?;
    ensure!(
        e.body["candidate_id"] == new.id
            && e.body["candidate_digest"] == new.digest
            && e.body["intent_turn_id"] == old.intent_turn_id.as_deref().unwrap_or(""),
        "repair changed its fixed replacement identity"
    );
    let intent = creation_intent(conn, field(&e.body, "intent_turn_id")?)?;
    proof(
        conn,
        &e.actor_ref,
        &intent.conversation_id,
        field(&e.body, "source_report_id")?,
        &old,
        e.authority_epoch,
        require_current,
    )?;
    ensure!(
        candidate(conn, &new.id)? == new,
        "repaired candidate immutable bytes changed"
    );
    let body = json!({"method":"bot.evaluate","candidate_id":new.id,"candidate_digest":new.digest,"intent_turn_id":e.body["intent_turn_id"],"source_callback_digest":e.body["source_callback_digest"]});
    Ok(Envelope {
        payload_digest: canonical_digest(&body)?,
        body,
        ..e.clone()
    })
}
pub(crate) fn repaired_evaluation_envelope(conn: &Connection, e: &Envelope) -> Result<Envelope> {
    evaluation_envelope(conn, e, true)
}

impl super::super::Host {
    pub(super) fn scoped_bot_repair(
        &self,
        request: &super::super::lifetime::PiToolRequest,
        scope: super::super::lifetime::PiInferenceScope,
    ) -> Result<Response> {
        let state = self.lock()?;
        let conn = &state.journal.0;
        if let Some(r) = self.check_pi_host_scope(&state, request, scope)? {
            return Ok(r);
        }
        if let Some(r) = super::super::lifetime::pi_tool_guard(conn, request, scope)? {
            return Ok(r);
        }
        exact(
            &request.envelope.body,
            &["method", "report_id", "arguments"],
        )?;
        let args = &request.envelope.body["arguments"];
        exact(args, &["candidate_id", "candidate_digest", "instructions"])?;
        let cached:Option<(String,String,u64,String)>=conn.query_row("SELECT request,actor_ref,authority_epoch,response FROM lifetime_commands WHERE command_id=?1",[&request.envelope.command_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if let Some((original, actor, epoch, response)) = cached {
            let original: Envelope = serde_json::from_str(&original)?;
            original.validate()?;
            ensure!(
                actor == request.ghost_id
                    && epoch == request.envelope.authority_epoch
                    && original.body["source_callback_digest"] == request.envelope.payload_digest,
                "repair command conflicts with its original bytes"
            );
            authorize(conn, &original, &request.ghost_id)?;
            return Ok(serde_json::from_str(&response)?);
        }
        let descriptor = repair_descriptor(conn, request, scope)?
            .ok_or_else(|| anyhow!("current report has no remaining bot repair capability"))?;
        ensure!(
            args["candidate_id"] == descriptor["candidate_id"]
                && args["candidate_digest"] == descriptor["candidate_digest"],
            "repair is outside this exact report capability"
        );
        let old = candidate(conn, field(args, "candidate_id")?)?;
        let (new, l) = replacement(conn, &old, field(args, "instructions")?)?;
        let body = json!({"method":"bot.repair","candidate_id":new.id,"candidate_digest":new.digest,"repair_of_id":old.id,"repair_of_digest":old.digest,"repair_instructions":args["instructions"],"source_report_id":request.envelope.body["report_id"],"intent_turn_id":old.intent_turn_id,"source_callback_digest":request.envelope.payload_digest});
        let e = Envelope {
            payload_digest: canonical_digest(&body)?,
            body,
            ..request.envelope.clone()
        };
        super::super::lifetime::apply_with_admission(conn, &e, &request.ghost_id, |tx| {
            proof(
                tx,
                &request.ghost_id,
                &request.conversation_id,
                field(&request.envelope.body, "report_id")?,
                &old,
                e.authority_epoch,
                true,
            )?;
            let mut intent = creation_intent(tx, new.intent_turn_id.as_deref().unwrap())?;
            ensure!(
                intent.candidate_id.as_deref() == Some(old.id.as_str())
                    && intent.candidate_digest.as_deref() == Some(old.digest.as_str()),
                "repair candidate was superseded"
            );
            ensure!(
                load::<Candidate>(tx, CANDIDATES, &new.id)?.is_none(),
                "repair revision already exists under another receipt"
            );
            let original = progress(tx, &old.id)?;
            let p = Progress {
                candidate_id: new.id.clone(),
                candidate_digest: new.digest.clone(),
                operation_id: original.operation_id,
                ghost_id: new.definition.ghost_id.clone(),
                conversation_id: new.conversation_id.clone(),
                state: "draft".into(),
                activation_requested: true,
                evaluation_work_id: None,
                evaluation_goal_id: None,
                receipts: json!({"repair_of":old.id,"candidate_revision":l.revision}),
            };
            save(tx, CANDIDATES, &new.id, &new)?;
            save(tx, LINEAGE, &new.id, &l)?;
            save(tx, PROGRESS, &new.id, &p)?;
            intent.candidate_id = Some(new.id.clone());
            intent.candidate_digest = Some(new.digest.clone());
            save(tx, INTENTS, new.intent_turn_id.as_deref().unwrap(), &intent)?;
            Ok(None)
        })
    }
}
