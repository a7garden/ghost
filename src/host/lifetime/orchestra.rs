//! Owner turn and isolated Work pins for Orchestra. Task labels are hints;
//! provider approval and exact inference selection are always Host-owned.
use super::{apply, db, pi_tools::PiToolRequest};
use crate::{host::inference::{self, Selection}, lifetime_contract::{Goal, Work}};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::OnceLock};

const INTAKE: &str = "orchestra_intake_v1";
const GOAL: &str = "orchestra_goal_v1";
const WORK: &str = "orchestra_work_v1";
const DIRECT: &str = "direct";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    #[serde(default)]
    pub routes: BTreeMap<String, Selection>,
    pub reviewer: Option<Selection>,
}

impl Profile {
    pub(crate) fn validate(&self, base: &Selection) -> Result<()> {
        ensure!(self.routes.len() <= 16, "Too many Orchestra producer routes");
        for (task, route) in &self.routes {
            ensure!(valid_task(task) && inference::valid_selection(route) && route.provider == base.provider,
                "Orchestra producer routes must use the conversation's approved provider and supported model/effort");
            ensure!(base.provider != "local" || route == base, "Local Orchestra routes require the configured model");
        }
        if let Some(route) = &self.reviewer {
            ensure!(inference::valid_selection(route) && matches!(route.provider.as_str(), "zai-coding" | "minimax")
                && base.provider != "local" && route.provider != base.provider,
                "An Orchestra reviewer requires Z.AI or MiniMax and must differ from the producer provider");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApprovedProfile {
    pub version: u64,
    pub profile: Profile,
}

#[derive(Debug, Serialize, Deserialize)]
struct Intake {
    routes: BTreeMap<String, Selection>,
    reviewer: Option<Selection>,
    review_grant_version: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Assignment {
    pub(super) task: String,
    pub(super) selection: Selection,
    pub(super) reviewer: Option<Selection>,
    review_grant_version: Option<u64>,
}

fn valid_task(task: &str) -> bool {
    !task.is_empty() && task.len() <= 40 &&
        task.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn builtin_routes() -> &'static BTreeMap<String, Selection> {
    static ROUTES: OnceLock<BTreeMap<String, Selection>> = OnceLock::new();
    ROUTES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/lifetime/orchestra-routes.json"))
            .expect("generated Orchestra producer routes")
    })
}

fn load<T: for<'de> Deserialize<'de>>(conn: &Connection, kind: &str, id: &str) -> Result<Option<T>> {
    let payload: Option<String> = conn.query_row(
        "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2", params![kind, id], |r| r.get(0),
    ).optional()?;
    payload.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}

fn pin(conn: &Connection, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![kind,id,serde_json::to_string(value)?])?;
    Ok(())
}

pub(super) fn admit_turn(conn: &Connection, turn: &str, ghost: &str, conversation: &str, privacy: &str) -> Result<()> {
    let primary: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE kind='primary' AND ghost_id=?1)",
        [ghost], |r| r.get(0),
    )?;
    if !primary { return Ok(()); }

    let (settings, base) = inference::selected(conn, ghost, conversation)?;
    let mut routes: BTreeMap<_, _> = builtin_routes().iter()
        .filter(|(_, route)| route.provider == base.provider && inference::valid_selection(route))
        .map(|(task, route)| (task.clone(), route.clone())).collect();
    let mut reviewer = None;
    let mut review_grant_version = None;
    if let Some(approved) = settings.orchestra.get(&inference::key(ghost, conversation)) {
        // Changing the selected provider invalidates overrides on the previous provider.
        if approved.profile.validate(&base).is_ok() {
            routes.extend(approved.profile.routes.clone());
            if privacy == "public" && approved.profile.reviewer.is_some() {
                reviewer.clone_from(&approved.profile.reviewer);
                review_grant_version = Some(approved.version);
            }
        }
    }
    routes.entry(DIRECT.into()).or_insert_with(|| base.clone());
    pin(conn, INTAKE, turn, &Intake { routes, reviewer, review_grant_version })
}

pub(super) fn intake_view(conn: &Connection, turn: &str) -> Result<Value> {
    Ok(load::<Intake>(conn, INTAKE, turn)?.map_or(Value::Null, |pin| json!({
        "tasks": pin.routes.keys().collect::<Vec<_>>(),
        "default_task": DIRECT,
        "independent_review": pin.reviewer.is_some(),
    })))
}

pub(super) fn admit_goal(conn: &Connection, turn: &str, goal: &str, spec: &Value) -> Result<()> {
    let Some(intake) = load::<Intake>(conn, INTAKE, turn)? else { return Ok(()); };
    let task = match spec.get("orchestra_task") {
        Some(value) => value.as_str().filter(|task| intake.routes.contains_key(*task))
            .ok_or_else(|| apply::invalid("orchestra_task must match a task offered for the original Owner turn"))?,
        None => DIRECT,
    };
    pin(conn, GOAL, goal, &Assignment {
        task: task.into(), selection: intake.routes[task].clone(), reviewer: intake.reviewer,
        review_grant_version: intake.review_grant_version,
    })
}

fn work_key(work: &Work) -> String {
    format!("{}/{}/{}", work.id, work.goal_revision, work.owner_revision)
}

pub(super) fn admit_assignment(conn: &Connection, work: &Work, conversation: &str) -> Result<()> {
    let Some(goal) = db::goal(conn, &work.goal_id)? else { return Ok(()); };
    let direct = load::<Assignment>(conn, GOAL, &goal.id)?;
    let assignment = if let Some(direct) = direct {
        direct
    } else {
        let root_goal: Option<String> = conn.query_row(
            "SELECT root_goal_id FROM lifetime_work_links WHERE child_work_id=?1 AND current=1",
            [&work.id], |r| r.get(0),
        ).optional()?;
        let Some(root_goal) = root_goal else { return Ok(()); };
        let Some(root) = load::<Assignment>(conn, GOAL, &root_goal)? else { return Ok(()); };
        let (settings, base) = inference::selected(conn, &work.owner, conversation)?;
        let task = goal.acceptance_spec["orchestra_task"].as_str().filter(|task| valid_task(task)).unwrap_or(&root.task);
        let selection = settings.orchestra.get(&inference::key(&work.owner, conversation))
            .and_then(|p| p.profile.routes.get(task))
            .or_else(|| builtin_routes().get(task))
            .filter(|route| route.provider == base.provider && inference::valid_selection(route)
                && (base.provider != "local" || **route == base))
            .cloned().unwrap_or(base);
        Assignment { task: task.into(), selection, reviewer: None, review_grant_version: None }
    };
    pin(conn, WORK, &work_key(work), &assignment)
}

pub(super) fn assignment(conn: &Connection, work: &Work) -> Result<Option<Assignment>> {
    load(conn, WORK, &work_key(work))
}

pub(super) fn selection_view(conn: &Connection, request: &PiToolRequest) -> Result<Value> {
    let mut view = inference::selection_view(conn, &request.ghost_id, &request.conversation_id)?;
    let work = if request.context_ref.is_some() {
        super::work_context::validate(conn, request)?
    } else {
        super::work_context::inference_preflight(conn, request)?
    };
    if let Some(work) = work {
        if let Some(pin) = assignment(conn, &work)? {
            ensure!(view["selection"]["provider"] == pin.selection.provider,
                "The assigned Orchestra producer provider changed; reconcile this Work");
            view["selection"] = serde_json::to_value(pin.selection)?;
        }
    }
    Ok(view)
}

pub(super) fn reviewer_current(conn: &Connection, goal: &Goal, route: &Selection) -> Result<bool> {
    let (settings, selected) = inference::selected(conn, &goal.accountable_ghost, &goal.reply_conversation)?;
    let producer = load::<Assignment>(conn, GOAL, &goal.id)?;
    let Some(pin) = producer else { return Ok(false); };
    let approved = settings.orchestra.get(&inference::key(&goal.accountable_ghost, &goal.reply_conversation));
    Ok(pin.selection.provider == selected.provider && selected.provider != route.provider &&
        approved.is_some_and(|approval| Some(approval.version) == pin.review_grant_version &&
            approval.profile.reviewer.as_ref() == Some(route)) &&
        settings.credentials.get(&route.provider).copied().unwrap_or(route.provider == "codex"))
}
