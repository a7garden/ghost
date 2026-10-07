//! Persistent Rust Ghost identities and a headless host for durable agent work.
//! The default `host` feature owns execution; `workspace-ui` adds a web client.
//! Optional document, memory, computer and channel adapters grant no authority
//! by their presence. The owner policy and effect journal govern every action.
//! Legacy bounded run and fixture APIs remain available for compatibility.

#[cfg(feature = "host")]
pub mod adapters;
pub mod browser;
pub mod collaboration;
#[cfg(feature = "host")]
pub mod control;
#[cfg(feature = "host")]
pub mod domain;
#[cfg(feature = "durable-runtime")]
pub mod durable;
#[cfg(feature = "host")]
pub mod host;
pub mod judge;
#[cfg(any(feature = "host", feature = "ui-fixtures"))]
mod local_http;
pub mod native_http;
pub mod protocol;
pub mod provider;
pub mod provider_control;
pub mod provider_journal;
pub mod store;
pub mod tools;
#[cfg(feature = "workspace-ui")]
pub mod workspace;

use anyhow::Result;
use provider::{Provider, ProviderRequest};
use provider_control::{CallFailure, RunControl};
use serde::Serialize;
use std::path::Path;
use store::{ProfileStore, Task};
#[cfg(test)]
mod test_http;

/// Result of executing one task in a run cycle.
#[derive(Serialize, Debug, Default)]
pub struct RunSummary {
    pub completed: usize,
    pub denied: usize,
    pub failed: usize,
    pub uncertain: usize,
    pub cancelled: usize,
}

enum ActionReport {
    /// Effect done (read returns file payload).
    Done { output: Option<String> },
    /// No filesystem effect occurred.
    Denied { reason: String },
    /// External effect may or may not have occurred; never automatically retried.
    Uncertain { reason: String },
    /// Effect attempt failed; no automatic retry.
    Failed { reason: String },
}

fn exec_action(
    store: &ProfileStore,
    task: &Task,
    op: &str,
    raw: &str,
    content: Option<&str>,
) -> ActionReport {
    use ActionReport::*;
    let abs = match tools::lexical_abs(Path::new(raw)) {
        Ok(p) => p,
        Err(e) => {
            return Denied {
                reason: e.to_string(),
            }
        }
    };
    // Root/self-state protection uses resolved canonical target.
    let root_c = store
        .root
        .canonicalize()
        .unwrap_or_else(|_| store.root.clone());
    if abs.starts_with(&root_c) {
        return Denied {
            reason: "target is inside the Ghost root; identity/policy artifacts are protected"
                .into(),
        };
    }
    let grant = match store.grant_for(op, &abs) {
        Some(g) => g,
        None => {
            return Denied {
                reason: format!("no active '{}' grant covers {}", op, abs.display()),
            }
        }
    };
    let resolved = match tools::resolve(Path::new(&grant.path), Path::new(raw), op == "write") {
        Ok(p) => p,
        Err(e) => {
            return Denied {
                reason: e.to_string(),
            }
        }
    };
    // Re-check canonical self-root protection immediately after resolution:
    // a grant above the root must never reach Ghost state via resolution.
    if resolved.starts_with(&root_c) {
        return Denied {
            reason:
                "resolved target is inside the Ghost root; identity/policy artifacts are protected"
                    .into(),
        };
    }
    // Durable ledger row is written BEFORE the external effect.
    let effect = match store.start_effect(task.id, op, &resolved.to_string_lossy(), grant.id) {
        Ok(id) => id,
        Err(e) => {
            return Denied {
                reason: e.to_string(),
            }
        }
    };
    let _ = store.audit(
        Some(task.id),
        "effect_started",
        &serde_json::json!({
            "action": op,
            "target": resolved.to_string_lossy(),
            "grant_id": grant.id,
        })
        .to_string(),
    );
    let io = if op == "read" {
        tools::read_bounded(&resolved).map(Some)
    } else {
        tools::write_new(&resolved, content.unwrap_or("")).map(|_| None)
    };
    match io {
        Ok(payload) => match store.finish_effect(effect, "completed") {
            Ok(()) => Done { output: payload },
            Err(e) => Uncertain {
                reason: format!(
                    "effect performed but ledger update failed ({}); manual reconciliation required; no automatic retry",
                    e
                ),
            },
        },
        Err(e) => {
            if op == "write" {
                // A write may have partially landed externally before the IO
                // error; conservatively uncertain, never failed, never retried.
                let _ = store.finish_effect(effect, "uncertain");
                Uncertain {
                    reason: format!(
                        "write failed after a possible partial external effect ({}); manual reconciliation required; no automatic retry",
                        e
                    ),
                }
            } else {
                // Reads have no external effect; a failure is definitive.
                let _ = store.finish_effect(effect, "failed");
                Failed {
                    reason: format!("read failed; no automatic retry: {}", e),
                }
            }
        }
    }
}

/// Execute exactly one selected task by id, once. Bounded: a single attempt,
/// no automatic retry of terminal/failed/uncertain/running tasks. A task that
/// is not queued (terminal, or left running by a crash and recovered to
/// 'uncertain' by store open) is a no-op. Returns the per-task summary.
pub fn run_task(store: &ProfileStore, provider: &dyn Provider, task_id: i64) -> Result<RunSummary> {
    run_task_with_control(store, provider, task_id, &RunControl::default())
}

/// Native transport controls belong to the host. Cancellation after dispatch
/// is uncertain; a dropped request does not prove absence of remote work.
/// Legacy SDK transports do not claim deadline/stream control support.
pub fn run_task_with_control(
    store: &ProfileStore,
    provider: &dyn Provider,
    task_id: i64,
    control: &RunControl,
) -> Result<RunSummary> {
    let mut s = RunSummary::default();
    let Some(task) = store.task_by_id(task_id)? else {
        return Ok(s);
    };
    if task.status != "queued" {
        return Ok(s);
    }
    if control.cancellation.is_cancelled() {
        store.cancel(&task.uuid)?;
        s.cancelled = 1;
        return Ok(s);
    }
    store.set_status(task.id, "running", None)?;
    store.audit(
        Some(task.id),
        "task_running",
        &format!("provider={}", provider.name()),
    )?;
    let req = ProviderRequest {
        profile_uuid: store.uuid.clone(),
        persona: store.persona.clone(),
        session_uuid: task.session_id.clone(),
        task_uuid: task.uuid.clone(),
        message_id: task.message_id.clone(),
        prompt: task.prompt.clone(),
    };
    let native = provider.native_descriptor();
    let attempt = uuid::Uuid::new_v4().to_string();
    if let Some(descriptor) = &native {
        provider_journal::begin(store, &task, descriptor, &attempt)?;
    }
    let mut sequence = 0;
    let mut observe = |event: &provider_control::StreamEvent| {
        if native.is_some() {
            provider_journal::event(store, &task, &mut sequence, event)?;
        }
        Ok(())
    };
    let response = match provider.run_controlled(&req, &attempt, control, &mut observe) {
        Ok(response) => response,
        Err(error) => {
            let status = if native.is_some() {
                error
                    .downcast_ref::<CallFailure>()
                    .map(CallFailure::task_status)
                    .unwrap_or("uncertain")
            } else {
                "failed"
            };
            // Unrecognized native errors must not expose arbitrary transport
            // details or authorize replay. Legacy error behavior is preserved.
            let message = if native.is_some() {
                error
                    .downcast_ref::<CallFailure>()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        "provider internal failure; outcome uncertain; no automatic replay".into()
                    })
            } else {
                error.to_string()
            };
            finish_activity(
                store,
                &task,
                status,
                &message,
                None,
                Some(&message),
                native.is_some(),
                &mut s,
            )?;
            return Ok(s);
        }
    };
    if native.is_some() && control.cancellation.is_cancelled() {
        let message =
            "provider completed but cancellation preceded host action; no automatic replay";
        finish_activity(
            store,
            &task,
            "uncertain",
            message,
            response.usage.as_ref(),
            Some(message),
            true,
            &mut s,
        )?;
        return Ok(s);
    }
    let action = if let Some(p) = &task.read_path {
        Some(("read", p.clone(), None))
    } else if let Some(p) = &task.write_path {
        Some(("write", p.clone(), task.write_content.clone()))
    } else {
        None
    };
    let (status, output) = match action {
        None => ("completed", response.content),
        Some((op, raw, content)) => match exec_action(store, &task, op, &raw, content.as_deref()) {
            ActionReport::Done { output } => (
                "completed",
                match output {
                    Some(file) => format!("{}\n[file]\n{}", response.content, file),
                    None => response.content,
                },
            ),
            ActionReport::Denied { reason } => ("denied", reason),
            ActionReport::Uncertain { reason } => ("uncertain", reason),
            ActionReport::Failed { reason } => ("failed", reason),
        },
    };
    finish_activity(
        store,
        &task,
        status,
        &output,
        response.usage.as_ref(),
        if status == "completed" {
            None
        } else {
            Some("host tool did not complete")
        },
        native.is_some(),
        &mut s,
    )?;
    Ok(s)
}

#[allow(clippy::too_many_arguments)] // One atomic activity receipt has these fixed fields.
fn finish_activity(
    store: &ProfileStore,
    task: &Task,
    status: &str,
    output: &str,
    usage: Option<&provider_control::TokenUsage>,
    failure: Option<&str>,
    native: bool,
    summary: &mut RunSummary,
) -> Result<()> {
    let counter = match status {
        "completed" => &mut summary.completed,
        "denied" => &mut summary.denied,
        "failed" => &mut summary.failed,
        "uncertain" => &mut summary.uncertain,
        "cancelled" => &mut summary.cancelled,
        _ => anyhow::bail!("invalid activity status"),
    };
    if native {
        provider_journal::finish(store, task, status, output, usage, failure)?;
        *counter += 1;
    } else {
        store.finish_task(task, status, Some(output), counter)?;
    }
    Ok(())
}

/// Drain queued tasks once. Bounded: one attempt per task, no retries of
/// terminal/failed/uncertain effects. A provider failure on one task does not
/// prevent processing of the remaining queued tasks.
pub fn run_cycle(store: &ProfileStore, provider: &dyn Provider) -> Result<RunSummary> {
    let mut total = RunSummary::default();
    for id in store.queued_task_ids()? {
        let s = run_task(store, provider, id)?;
        total.completed += s.completed;
        total.denied += s.denied;
        total.failed += s.failed;
        total.uncertain += s.uncertain;
        total.cancelled += s.cancelled;
    }
    Ok(total)
}

#[cfg(all(feature = "ui-fixtures", unix))]
pub mod ui;
