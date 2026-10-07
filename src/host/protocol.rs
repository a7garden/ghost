//! Project committed runtime receipts into the versioned collaboration log.
use super::{Delegation, Phase, State};
use crate::{domain::protocol::Event, durable::durable::TaskKind};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

pub fn cancel_delegation(s: &State, record: &mut Delegation) -> Result<()> {
    let target = s
        .profiles
        .get(&record.target)
        .ok_or_else(|| anyhow!("specialist missing"))?;
    if record.task_id.is_empty() {
        if let Some(input) = target
            .runtime
            .session
            .committed()?
            .submissions
            .iter()
            .find(|i| i.request_id == record.id && i.conversation_id == record.conversation_id)
        {
            record.task_id = input.task_id.clone();
        }
    }
    if !record.task_id.is_empty() {
        target.runtime.session.cancel(&record.task_id)?;
    }
    let snapshot = target.runtime.session.committed()?;
    let phase = snapshot.tasks.get(&record.task_id).map(|task| task.phase);
    let uncertain_effects = snapshot
        .effects
        .iter()
        .filter(|(_, e)| {
            e.phase == Phase::Uncertain
                && snapshot
                    .tasks
                    .get(&e.task_id)
                    .is_some_and(|task| task.conversation_id == record.conversation_id)
        })
        .map(|(key, _)| key.clone())
        .collect();
    let event = Event::CancelReceipt {
        task_id: (!record.task_id.is_empty()).then(|| record.task_id.clone()),
        phase,
        uncertain_effects,
    };
    let key = format!(
        "cancel_receipt:{}",
        crate::adapters::documents::digest(&serde_json::to_vec(&event)?)
    );
    s.journal.message(record, &key, event)?;
    record.state = if phase == Some(Phase::Complete) {
        "complete"
    } else {
        "cancelled"
    }
    .into();
    s.journal.put("delegation", &record.id, record)?;
    Ok(())
}
pub fn project(s: &State, owner: &str) -> Result<()> {
    let source = s
        .profiles
        .get(owner)
        .ok_or_else(|| anyhow!("source missing"))?
        .runtime
        .session
        .committed()?;
    for mut record in s
        .journal
        .objects::<Delegation>("delegation")?
        .into_iter()
        .filter(|r| r.owner == owner)
    {
        if record.state == "cancelling" {
            cancel_delegation(s, &mut record)?;
            continue;
        }
        let Some(target) = s.profiles.get(&record.target) else {
            continue;
        };
        let snapshot = target.runtime.session.committed()?;
        if let Some(TaskKind::Tool { call, .. }) =
            source.tasks.get(&record.owner_task).map(|task| &task.kind)
        {
            if let Some(prompt) = call.arguments["prompt"].as_str() {
                s.journal.message(
                    &record,
                    "requested",
                    Event::Requested {
                        prompt: prompt.into(),
                        background: record.background,
                    },
                )?;
            }
        }
        if record.task_id.is_empty() {
            if let Some(input) = snapshot
                .submissions
                .iter()
                .find(|i| i.request_id == record.id && i.conversation_id == record.conversation_id)
            {
                record.task_id = input.task_id.clone();
                record.state = "running".into();
                s.journal.put("delegation", &record.id, &record)?;
            }
        }
        let Some(task) = snapshot.tasks.get(&record.task_id) else {
            continue;
        };
        s.journal.message(
            &record,
            "accepted",
            Event::Accepted {
                conversation_id: record.conversation_id.clone(),
                task_id: record.task_id.clone(),
            },
        )?;
        let projection = json!({"task_id":task.id,"phase":task.phase});
        if s.journal
            .get::<Value>("collaboration_projection", &record.id)?
            .as_ref()
            == Some(&projection)
        {
            continue;
        }
        let artifacts = vec![format!(
            "ghost-task:{}:{}:{}",
            record.target, record.conversation_id, task.id
        )];
        let summary = task
            .output
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(4096)
            .collect();
        if task.phase.terminal() {
            let event = Event::Result {
                conversation_id: record.conversation_id.clone(),
                task_id: task.id.clone(),
                phase: task.phase,
                summary,
                artifacts,
            };
            let key = format!(
                "result:{}",
                crate::adapters::documents::digest(&serde_json::to_vec(&event)?)
            );
            s.journal.message(&record, &key, event)?;
            if record.state != "cancelled" {
                record.state = format!("{:?}", task.phase).to_lowercase();
                s.journal.put("delegation", &record.id, &record)?;
            }
        } else {
            s.journal.message(
                &record,
                &format!("phase:{}", snapshot.revision),
                Event::Progress {
                    task_id: task.id.clone(),
                    revision: snapshot.revision,
                    phase: task.phase,
                    summary,
                    artifacts,
                },
            )?;
        }
        s.journal
            .put("collaboration_projection", &record.id, &projection)?;
    }
    Ok(())
}
