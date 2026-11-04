//! Exact Owner-sealed delegation bytes, selected by a Host-issued reference.
use super::{apply, db, graph, pi_execution};
use crate::lifetime_contract::{canonical_digest, Goal, Work};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Contract {
    target_ghost_id: String,
    prompt: String,
    acceptance_spec: Value,
    artifact_refs: Vec<String>,
}
fn root(conn: &Connection, parent: &Work) -> Result<Goal> {
    let id: Option<String> = conn
        .query_row(
            "SELECT root_goal_id FROM lifetime_work_links WHERE child_work_id=?1 AND current=1",
            [&parent.id],
            |r| r.get(0),
        )
        .optional()?;
    db::goal(conn, id.as_deref().unwrap_or(&parent.goal_id))?
        .ok_or_else(|| anyhow!("Delegation root Goal missing"))
}
fn contracts(conn: &Connection, root: &Goal) -> Result<Vec<Contract>> {
    let Some(value) = root.acceptance_spec.get("delegation_contracts") else {
        return Ok(vec![]);
    };
    ensure!(
        pi_execution::owner_goal_expectations(conn, root)?,
        "Delegation contract has no original committed Owner authority"
    );
    let items = value
        .as_array()
        .ok_or_else(|| anyhow!("Delegation contracts must be an array"))?;
    ensure!(
        items.len() <= 8 && serde_json::to_vec(items)?.len() <= 65536,
        "Delegation contracts exceed bounds"
    );
    let contracts: Vec<Contract> = serde_json::from_value(value.clone())?;
    for contract in &contracts {
        apply::validate_identity("contract target", &contract.target_ghost_id)?;
        apply::validate_text("contract prompt", &contract.prompt)?;
        ensure!(
            contract.prompt.len() <= 8192 && contract.acceptance_spec.is_object(),
            "Delegation contract task invalid"
        );
        ensure!(
            contract.artifact_refs.len() <= 32
                && contract
                    .artifact_refs
                    .iter()
                    .all(|value| !value.is_empty() && value.len() <= 4096 && !value.contains('\0')),
            "Delegation contract artifact references invalid"
        );
        let unique: std::collections::BTreeSet<_> = contract.artifact_refs.iter().collect();
        ensure!(
            unique.len() == contract.artifact_refs.len(),
            "Delegation contract artifact references repeat"
        );
        if let Some(target) = root
            .acceptance_spec
            .pointer("/operations_policy/approved_operations_ghost")
        {
            ensure!(
                target.as_str() == Some(&contract.target_ghost_id),
                "Delegation contract target exceeds Owner operations policy"
            );
        }
    }
    Ok(contracts)
}
fn reference(root: &Goal, parent: &Work, contract: &Contract) -> Result<String> {
    Ok(format!(
        "dc-{}",
        canonical_digest(
            &json!({"version":1,"root_goal_id":root.id,"root_goal_revision":root.revision,"requirement_digest":root.requirement_digest,"parent_work_id":parent.id,"parent_goal_revision":parent.goal_revision,"parent_owner":parent.owner,"parent_owner_revision":parent.owner_revision,"contract":contract})
        )?
    ))
}
pub(super) fn views(conn: &Connection, parent: &Work) -> Result<Vec<Value>> {
    let root = root(conn, parent)?;
    // Model-authored acceptance text supplies no capability or contract ref.
    if !pi_execution::owner_goal_expectations(conn, &root)? {
        return Ok(vec![]);
    }
    contracts(conn,&root)?.iter().map(|contract|Ok(json!({"contract_ref":reference(&root,parent,contract)?,"target_ghost_id":contract.target_ghost_id,"prompt":contract.prompt,"acceptance_spec_digest":canonical_digest(&contract.acceptance_spec)?,"artifact_refs":contract.artifact_refs}))).collect()
}
/// Internal normalization after validating the original signed source. It is
/// never accepted as a replacement source command or a new Owner assertion.
pub(super) fn resolved_body(conn: &Connection, body: &Value) -> Result<Value> {
    if body.get("template_ref").is_some(){return super::task_contracts::resolve_delegation(conn,body);}

    if let Some(stamp) = body.get("work_memory_context_revision") {
        ensure!(
            stamp.as_str().is_some_and(|stamp| stamp.len() == 64
                && stamp
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
            "Invalid Work memory context stamp"
        );
    }
    if body.get("contract_ref").is_none() {
        apply::allowed_fields(
            body,
            &[
                "method",
                "parent_work_id",
                "target_ghost_id",
                "summary",
                "artifact_refs",
                "acceptance_spec",
                "work_memory_context_revision",
            ],
            &[
                "method",
                "parent_work_id",
                "target_ghost_id",
                "summary",
                "artifact_refs",
                "acceptance_spec",
            ],
        )?;
        return Ok(body.clone());
    }
    apply::allowed_fields(
        body,
        &[
            "method",
            "parent_work_id",
            "contract_ref",
            "work_memory_context_revision",
        ],
        &["method", "parent_work_id", "contract_ref"],
    )?;
    let wanted = apply::string_field(body, "contract_ref")?;
    ensure!(
        wanted.len() == 67
            && wanted.starts_with("dc-")
            && wanted[3..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid delegation contract reference"
    );
    let parent = db::work(conn, apply::string_field(body, "parent_work_id")?)?
        .ok_or_else(|| anyhow!("Delegation parent Work missing"))?;
    let root = root(conn, &parent)?;
    let contract = contracts(conn, &root)?
        .into_iter()
        .find(|contract| {
            reference(&root, &parent, contract).is_ok_and(|reference| reference == wanted)
        })
        .ok_or_else(|| {
            anyhow!("Delegation contract is not authorized for this exact parent revision")
        })?;
    let parent_goal = db::goal(conn, &parent.goal_id)?
        .ok_or_else(|| anyhow!("Delegation parent Goal missing"))?;
    if let Some(target) = parent_goal
        .acceptance_spec
        .pointer("/operations_policy/approved_operations_ghost")
    {
        ensure!(
            target.as_str() == Some(&contract.target_ghost_id),
            "Delegation contract exceeds current parent operations policy"
        );
    }
    let mut normalized = json!({"method":body["method"],"parent_work_id":parent.id,"target_ghost_id":contract.target_ghost_id,"summary":contract.prompt,"artifact_refs":contract.artifact_refs,"acceptance_spec":contract.acceptance_spec});
    if let Some(stamp) = body.get("work_memory_context_revision") {
        normalized["work_memory_context_revision"] = stamp.clone();
    }
    Ok(normalized)
}
/// Exact contract expectations can authorize deterministic verification; an
/// arbitrary producer's prompt/spec remains pending independent review.
pub(super) fn authorizes_child(
    conn: &Connection,
    root: &Goal,
    goal: &Goal,
    work: &Work,
) -> Result<bool> {
    if super::task_contracts::authorizes_child(conn,root,goal,work)? {return Ok(true);}
    if !pi_execution::owner_goal_expectations(conn, root)? {
        return Ok(false);
    }
    let has_reference:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_commands WHERE json_extract(request,'$.body.method')='work.delegate' AND json_type(request,'$.body.contract_ref')='text' AND json_extract(response,'$.status')='success' AND json_extract(response,'$.data.work.id')=?1 AND json_extract(response,'$.data.goal.id')=?2)",rusqlite::params![work.id,goal.id],|r|r.get(0))?;
    if !has_reference {
        return Ok(false);
    }
    Ok(contracts(conn, root)?.into_iter().any(|contract| {
        contract.target_ghost_id == work.owner
            && contract.acceptance_spec == goal.acceptance_spec
            && graph::delegated_prompt(&contract.prompt, &contract.artifact_refs)
                .is_ok_and(|prompt| prompt == goal.prompt)
    }))
}

#[cfg(test)]
mod tests {
    use super::super::pi_execution::tests::{self as pi, Fixture};
    use super::*;
    use crate::{
        host::lifetime::{PiInferenceScope, PiToolRequest},
        host::Host,
        lifetime_contract::{Envelope, ResponseStatus},
        store::ProfileStore,
    };
    fn setup() -> Result<(Fixture, String, String, String)> {
        let f = pi::setup_with_spec(json!({}));
        let profile = Host::profile(ProfileStore::create_profile(
            &f.host.root,
            "contract-child",
            "Contract child",
        )?)?;
        let child = profile.id.clone();
        let conversation = uuid::Uuid::new_v4().to_string();
        {
            let mut state = f.host.lock()?;
            state.profiles.insert(child.clone(), profile);
            let registered = super::super::apply(
                &state.journal.0,
                &pi::envelope(
                    "owner",
                    json!({"method":"registry.ensure","ghost_id":child,"conversation_id":conversation,"kind":"specialist","roles":[]}),
                ),
                "owner",
            )?;
            ensure!(
                registered.status == ResponseStatus::Success,
                "Registration failed"
            );
            f.host
                .native_computers
                .as_ref()
                .unwrap()
                .provision_pi_ghost(&state.journal.0, &f.ghost, &child, 1, "pi-default/1")?;
        }
        let contract = json!({"target_ghost_id":child,"prompt":"Write exact Owner-approved bytes; never retype a contract","acceptance_spec":pi::verifier_spec("contract-child-output"),"artifact_refs":[]});
        let reference = {
            let state = f.host.lock()?;
            let work = db::work(&state.journal.0, &f.work)?.unwrap();
            let mut update = pi::envelope(
                "owner",
                json!({"method":"goal.update","goal_id":work.goal_id,"prompt":"Select immutable child contract","acceptance_spec":{"delegation_contracts":[contract]}}),
            );
            update.expected_revision = Some(1);
            let response = super::super::apply(&state.journal.0, &update, "owner")?;
            ensure!(
                response.status == ResponseStatus::Success,
                "Owner contract update failed"
            );
            let work = db::work(&state.journal.0, &f.work)?.unwrap();
            views(&state.journal.0, &work)?[0]["contract_ref"]
                .as_str()
                .unwrap()
                .to_string()
        };
        Ok((f, child, conversation, reference))
    }
    fn delegate(f: &Fixture, reference: &str) -> Envelope {
        let mut e = pi::envelope(
            &f.ghost,
            json!({"method":"work.delegate","parent_work_id":f.work,"contract_ref":reference}),
        );
        e.expected_revision = Some(2);
        e
    }
    #[tokio::test]
    async fn delegation_contract_ref_resolves_exact_owner_bytes_and_accepts_child_without_model_copy(
    ) -> Result<()> {
        let (f, child, conversation, reference) = setup()?;
        let source = delegate(&f, &reference);
        let delegated = {
            let state = f.host.lock()?;
            super::super::apply(&state.journal.0, &source, &f.ghost)?
        };
        ensure!(
            delegated.status == ResponseStatus::Success,
            "Delegation failed: {delegated:?}"
        );
        let child_work = delegated.data["work"]["id"].as_str().unwrap();
        let assignment:String=f.host.lock()?.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1 AND json_extract(payload,'$.body.method')='conversation.assignment'",[child_work],|r|r.get(0))?;
        let inspected=f.host.lifetime_pi_action(&PiToolRequest {context_ref: None, ghost_id:child.clone(),conversation_id:conversation.clone(),envelope:pi::envelope(&child,json!({"method":"conversation.assignment.inspect","assignment_id":assignment,"ghost_id":child,"conversation_id":conversation}))},PiInferenceScope::Public).await?;
        ensure!(
            inspected["result"]["status"] == "success"
                && inspected["result"]["data"]["assignment"]["prompt"]
                    == "Write exact Owner-approved bytes; never retype a contract",
            "Canonical child source lost resolved contract: {inspected}"
        );
        for (task, operation, args) in [
            (
                10,
                "write",
                json!({"path":"answer.txt","content":"contract-child-output"}),
            ),
            (
                11,
                "publish_artifact",
                json!({"path":"answer.txt","privacy":"public"}),
            ),
        ] {
            let body = json!({"method":"work.execute","assignment_id":assignment,"work_id":child_work,"generation_task_id":9,"task_id":task,"call_id":operation,"operation":operation,"arguments":args,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":args}))?});
            let result = f
                .host
                .lifetime_pi_execution_action(
                    &PiToolRequest {
                        context_ref: None, ghost_id: child.clone(),
                        conversation_id: conversation.clone(),
                        envelope: pi::envelope(&child, body),
                    },
                    PiInferenceScope::Public,
                )
                .await?;
            ensure!(
                result.status == ResponseStatus::Success,
                "Child effect failed: {result:?}"
            );
        }
        let complete=f.host.lifetime_pi_execution_action(&PiToolRequest {context_ref: None, ghost_id:child.clone(),conversation_id:conversation.clone(),envelope:pi::envelope(&child,json!({"method":"work.execution.complete","assignment_id":assignment,"work_id":child_work,"task_id":9,"summary":"Actual contract artifact"}))},PiInferenceScope::Public).await?;
        ensure!(
            complete.data["verification"]["status"] == "success",
            "Exact Owner contract verifier was not independently accepted: {complete:?}"
        );
        let state = f.host.lock()?;
        let replay = super::super::apply(&state.journal.0, &source, &f.ghost)?;
        ensure!(
            serde_json::to_value(replay)? == serde_json::to_value(delegated)?,
            "Same command contract replay changed"
        );
        ensure!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_work_links WHERE parent_work_id=?1",
                [&f.work],
                |r| r.get::<_, i64>(0)
            )? == 1,
            "Same command minted another child"
        );
        Ok(())
    }
    #[tokio::test]
    async fn delegation_contract_ref_rejects_mixed_null_forged_and_stale_scope() -> Result<()> {
        let (f, _, _, reference) = setup()?;
        for mut body in [
            json!({"method":"work.delegate","parent_work_id":f.work,"contract_ref":null}),
            json!({"method":"work.delegate","parent_work_id":f.work,"contract_ref":reference,"summary":"model replacement"}),
            json!({"method":"work.delegate","parent_work_id":f.work,"contract_ref":format!("dc-{}","0".repeat(64))}),
            json!({"method":"work.delegate","parent_work_id":f.work,"contract_ref":reference,"work_memory_context_revision":null}),
        ] {
            let mut request = pi::envelope(&f.ghost, body.take());
            request.expected_revision = Some(2);
            let state = f.host.lock()?;
            let result = super::super::apply(&state.journal.0, &request, &f.ghost)?;
            ensure!(
                result.status != ResponseStatus::Success,
                "Malformed contract was admitted"
            );
        }
        let state = f.host.lock()?;
        let work = db::work(&state.journal.0, &f.work)?.unwrap();
        let goal = db::goal(&state.journal.0, &work.goal_id)?.unwrap();
        let mut update = pi::envelope(
            "owner",
            json!({"method":"goal.update","goal_id":goal.id,"prompt":"Revised authority","acceptance_spec":goal.acceptance_spec}),
        );
        update.expected_revision = Some(2);
        super::super::apply(&state.journal.0, &update, "owner")?;
        let mut stale = delegate(&f, &reference);
        stale.expected_revision = Some(3);
        let result = super::super::apply(&state.journal.0, &stale, &f.ghost)?;
        ensure!(
            result.status != ResponseStatus::Success,
            "Old contract survived Goal revision"
        );
        Ok(())
    }
    #[tokio::test]
    async fn model_authored_contract_text_never_issues_host_reference() -> Result<()> {
        let (f, _, _, _) = setup()?;
        let state = f.host.lock()?;
        let work = db::work(&state.journal.0, &f.work)?.unwrap();
        let goal = db::goal(&state.journal.0, &work.goal_id)?.unwrap();
        let mut update = pi::envelope(
            &f.ghost,
            json!({"method":"goal.update","goal_id":goal.id,"prompt":"Model changed requirement","acceptance_spec":goal.acceptance_spec}),
        );
        update.expected_revision = Some(2);
        let result = super::super::apply(&state.journal.0, &update, &f.ghost)?;
        ensure!(
            result.status == ResponseStatus::Success,
            "Historical model update fixture failed: {result:?}"
        );
        let work = db::work(&state.journal.0, &f.work)?.unwrap();
        ensure!(
            views(&state.journal.0, &work)?.is_empty(),
            "Model-authored spec issued Owner contract authority"
        );
        Ok(())
    }
    #[tokio::test]
    async fn freeform_matching_contract_text_does_not_gain_reference_authority() -> Result<()> {
        let (f, child, _, _) = setup()?;
        let state = f.host.lock()?;
        let parent = db::work(&state.journal.0, &f.work)?.unwrap();
        let root = db::goal(&state.journal.0, &parent.goal_id)?.unwrap();
        let contract = &root.acceptance_spec["delegation_contracts"][0];
        let mut source = pi::envelope(
            &f.ghost,
            json!({"method":"work.delegate","parent_work_id":f.work,"target_ghost_id":child,"summary":contract["prompt"],"acceptance_spec":contract["acceptance_spec"],"artifact_refs":[]}),
        );
        source.expected_revision = Some(2);
        let response = super::super::apply(&state.journal.0, &source, &f.ghost)?;
        ensure!(
            response.status == ResponseStatus::Success,
            "Legacy freeform admission must remain readable/usable"
        );
        let child_work = db::work(
            &state.journal.0,
            response.data["work"]["id"].as_str().unwrap(),
        )?
        .unwrap();
        let child_goal = db::goal(&state.journal.0, &child_work.goal_id)?.unwrap();
        ensure!(
            !authorizes_child(&state.journal.0, &root, &child_goal, &child_work)?,
            "Model-retyped freeform text became reference authority"
        );
        Ok(())
    }
    #[tokio::test]
    async fn delegation_contract_cannot_override_owner_operations_target() -> Result<()> {
        let (f, _, _, reference) = setup()?;
        let state = f.host.lock()?;
        let parent = db::work(&state.journal.0, &f.work)?.unwrap();
        let goal = db::goal(&state.journal.0, &parent.goal_id)?.unwrap();
        let mut spec = goal.acceptance_spec.clone();
        spec["operations_policy"] =
            json!({"approved_operations_ghost":uuid::Uuid::new_v4().to_string()});
        let mut revised = pi::envelope(
            "owner",
            json!({"method":"goal.update","goal_id":goal.id,"prompt":goal.prompt,"acceptance_spec":spec}),
        );
        revised.expected_revision = Some(2);
        let updated = super::super::apply(&state.journal.0, &revised, "owner")?;
        ensure!(
            updated.status == ResponseStatus::Success,
            "Owner policy fixture failed"
        );
        let parent = db::work(&state.journal.0, &f.work)?.unwrap();
        ensure!(
            views(&state.journal.0, &parent).is_err(),
            "Host issued ref contradicting Owner operations target"
        );
        let mut request = delegate(&f, &reference);
        request.expected_revision = Some(3);
        let refused = super::super::apply(&state.journal.0, &request, &f.ghost)?;
        ensure!(
            refused.status != ResponseStatus::Success,
            "Contract bypassed target policy"
        );
        Ok(())
    }
}
