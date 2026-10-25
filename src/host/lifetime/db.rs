use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use crate::lifetime_contract::{Acceptance, Goal, RuntimeBinding, Work};

pub(super) fn revision(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("revision exceeds SQLite integer range"))
}

pub(super) fn goal(conn: &Connection, id: &str) -> Result<Option<Goal>> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM lifetime_goals WHERE id=?1", [id], |row| row.get(0))
        .optional()?;
    payload.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}

pub(super) fn insert_goal(conn: &Connection, goal: &Goal) -> Result<()> {
    conn.execute(
        "INSERT INTO lifetime_goals(id,revision,requirement_digest,accountable_ghost,reply_conversation,privacy,state,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            goal.id,
            revision(goal.revision)?,
            goal.requirement_digest,
            goal.accountable_ghost,
            goal.reply_conversation,
            goal.privacy,
            goal.state,
            serde_json::to_string(goal)?,
        ],
    )?;
    Ok(())
}

pub(super) fn update_goal(conn: &Connection, goal: &Goal, expected_revision: u64) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE lifetime_goals SET revision=?1,requirement_digest=?2,accountable_ghost=?3,reply_conversation=?4,privacy=?5,state=?6,payload=?7 WHERE id=?8 AND revision=?9",
        params![
            revision(goal.revision)?,
            goal.requirement_digest,
            goal.accountable_ghost,
            goal.reply_conversation,
            goal.privacy,
            goal.state,
            serde_json::to_string(goal)?,
            goal.id,
            revision(expected_revision)?,
        ],
    )?;
    Ok(changed == 1)
}

pub(super) fn work(conn: &Connection, id: &str) -> Result<Option<Work>> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM lifetime_work WHERE id=?1", [id], |row| row.get(0))
        .optional()?;
    payload.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}

pub(super) fn works_for_goal(conn: &Connection, goal_id: &str) -> Result<Vec<Work>> {
    let mut statement = conn.prepare("SELECT payload FROM lifetime_work WHERE goal_id=?1 ORDER BY rowid")?;
    let rows = statement.query_map([goal_id], |row| row.get::<_, String>(0))?;
    let mut works = Vec::new();
    for row in rows {
        works.push(serde_json::from_str(&row?)?);
    }
    Ok(works)
}

pub(super) fn insert_work(conn: &Connection, work: &Work) -> Result<()> {
    conn.execute(
        "INSERT INTO lifetime_work(id,goal_id,goal_revision,owner,owner_revision,state,execution_id,cancellation,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            work.id,
            work.goal_id,
            revision(work.goal_revision)?,
            work.owner,
            revision(work.owner_revision)?,
            work.state,
            work.execution_id,
            work.cancellation,
            serde_json::to_string(work)?,
        ],
    )?;
    super::super::bots_store::pin_work(conn, work)?;
    super::super::shared_skills::pin_work(conn,work)?;
        super::super::work_memory::pin_work(conn, work)?;
    super::super::memory_publication::pin_work(conn,work)?;
    Ok(())
}

pub(super) fn update_work(conn: &Connection, work: &Work) -> Result<()> {
    let previous = self::work(conn, &work.id)?
        .ok_or_else(|| anyhow::anyhow!("lifetime work disappeared before update"))?;
    let changed = conn.execute(
        "UPDATE lifetime_work SET goal_revision=?1,owner=?2,owner_revision=?3,state=?4,execution_id=?5,cancellation=?6,payload=?7 WHERE id=?8",
        params![
            revision(work.goal_revision)?,
            work.owner,
            revision(work.owner_revision)?,
            work.state,
            work.execution_id,
            work.cancellation,
            serde_json::to_string(work)?,
            work.id,
        ],
    )?;
    if changed != 1 {
        bail!("lifetime work disappeared during update");
    }
    if previous.goal_revision != work.goal_revision
        || previous.owner_revision != work.owner_revision
        || previous.owner != work.owner
    {
        super::super::bots_store::pin_work(conn, work)?;
    super::super::shared_skills::pin_work(conn,work)?;
        super::super::work_memory::pin_work(conn, work)?;
        super::super::memory_publication::pin_work(conn,work)?;
    }
    Ok(())
}

pub(super) fn binding(conn: &Connection, conversation_id: &str) -> Result<Option<RuntimeBinding>> {
    conn.query_row(
        "SELECT conversation_id,ghost_id,runtime_kind,runtime_release,storage_ref FROM lifetime_bindings WHERE conversation_id=?1",
        [conversation_id],
        |row| {
            Ok(RuntimeBinding {
                conversation_id: row.get(0)?,
                ghost_id: row.get(1)?,
                runtime_kind: row.get(2)?,
                runtime_release: row.get(3)?,
                storage_ref: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub(super) fn insert_binding(conn: &Connection, binding: &RuntimeBinding) -> Result<()> {
    conn.execute(
        "INSERT INTO lifetime_bindings(conversation_id,ghost_id,runtime_kind,runtime_release,storage_ref) VALUES(?1,?2,?3,?4,?5)",
        params![
            binding.conversation_id,
            binding.ghost_id,
            binding.runtime_kind,
            binding.runtime_release,
            binding.storage_ref,
        ],
    )?;
    Ok(())
}

pub(super) fn acceptance(conn: &Connection, work_id: &str) -> Result<Option<Acceptance>> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM lifetime_acceptances WHERE work_id=?1", [work_id], |row| row.get(0))
        .optional()?;
    payload.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}

pub(super) fn save_acceptance(conn: &Connection, acceptance: &Acceptance) -> Result<()> {
    conn.execute(
        "INSERT INTO lifetime_acceptances(work_id,goal_revision,artifact_digest,verifier_revision,payload) VALUES(?1,?2,?3,?4,?5)",
        params![
            acceptance.work_id,
            revision(acceptance.goal_revision)?,
            acceptance.artifact_digest,
            acceptance.verifier_revision,
            serde_json::to_string(acceptance)?,
        ],
    )?;
    Ok(())
}
