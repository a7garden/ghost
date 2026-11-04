//! Execution-scoped owned-browser relay for native worker host tools.
//!
//! The worker supervisor (same mini host, same UID, outside the network-none
//! guest) owns the browser child and its CDP connection. The guest only ever
//! sees the scoped `browser` host tool result; DevTools endpoints, profile
//! paths, and tokens never enter the guest. Every operation rides the durable
//! ComputerRegistry browser lease under the original native execution identity,
//! so the lease binds the profile writer to the active work execution and its
//! authority epoch, and any fence (revoke, detach, epoch advance, restore)
//! rejects subsequent operations before they execute.
use crate::adapters::computer::BrowserOperation;
use crate::computers::{
    ComputerRegistry, OwnedBrowser, OwnedBrowserComputer, OwnedBrowserConfig,
};
use crate::worker::runner::WorkerBrowserRuntime;
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
use parking_lot::Mutex;
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Bounded wall clock for one worker browser operation.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(45);

pub(crate) struct WorkerBrowserRelay {
    browser: OwnedBrowser,
    ghost_id: String,
    computer_id: String,
    execution_id: String,
    expected_epoch: u64,
    authority_epoch: Arc<RwLock<u64>>,
    registry: Arc<Mutex<ComputerRegistry>>,
    model_route_is_local: bool,
    runtime: tokio::runtime::Runtime,
}

impl WorkerBrowserRelay {
    pub(crate) fn new(
        browser: &WorkerBrowserRuntime,
        registry: Arc<Mutex<ComputerRegistry>>,
        ghost_id: &str,
        computer_id: &str,
        execution_id: &str,
        authority_epoch: u64,
        current_epoch: Arc<RwLock<u64>>,
        model_route_is_local: bool,
    ) -> Result<Self> {
        let computer = OwnedBrowserComputer {
            ghost_id: ghost_id.to_owned(),
            computer_id: computer_id.to_owned(),
            executable: browser.executable.clone(),
            executable_sha256: browser.executable_sha256.clone(),
            headless: browser.headless,
            profile_scope: browser.profile_scope.clone(),
        };
        let config = OwnedBrowserConfig::from_computers(vec![computer])?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        Ok(Self {
            browser: OwnedBrowser::new(config, Arc::clone(&registry), authority_epoch)
                .with_confinement(browser.profile_scope == "public")
                .with_instance_recording(true),
            ghost_id: ghost_id.to_owned(),
            computer_id: computer_id.to_owned(),
            execution_id: execution_id.to_owned(),
            expected_epoch: authority_epoch,
            authority_epoch: current_epoch,
            registry,
            model_route_is_local,
            runtime,
        })
    }

    /// One read/navigation operation under the execution-scoped lease, with
    /// per-call authority-epoch revalidation before and after the effect.
    /// The relay only ever opens its declared (public) profile scope.
    pub(crate) fn execute(&self, operation: BrowserOperation) -> Result<serde_json::Value> {
        let declared = self.browser.profile_scope_for(&self.ghost_id)?;
        ensure!(
            declared == "public" || (declared == "private" && self.model_route_is_local),
            "worker browser relay serves the public scope, or the private scope only on the keyless local model route"
        );
        let ghost_id = self.ghost_id.clone();
        let execution_id = self.execution_id.clone();
        let expected_epoch = self.expected_epoch;
        let authority_epoch = Arc::clone(&self.authority_epoch);
        let approve = move || {
            let current = *authority_epoch
                .read()
                .map_err(|_| anyhow::anyhow!("worker authority lock is poisoned"))?;
            ensure!(
                current == expected_epoch,
                "worker authority epoch moved during the browser operation"
            );
            Ok(())
        };
        self.runtime.block_on(async {
            tokio::time::timeout(
                OPERATION_TIMEOUT,
                self.browser
                    .scoped_execute(&ghost_id, &execution_id, operation, &approve),
            ).await
        })?
    }

    /// Proposes one precise non-observational action for owner approval.
    /// The exact arguments digest is bound at proposal time.
    pub(crate) fn propose_action(
        &self,
        arguments_digest: &str,
        detail: &serde_json::Value,
    ) -> Result<String> {
        let declared = self.browser.profile_scope_for(&self.ghost_id)?;
        ensure!(
            declared == "public" || (declared == "private" && self.model_route_is_local),
            "worker browser relay serves the public scope, or the private scope only on the keyless local model route"
        );
        let mut registry = self.registry.lock();
        registry.acquire_browser_lease(
            &self.computer_id, &self.ghost_id, &self.execution_id, self.expected_epoch,
        )?;
        registry.propose_browser_action(
                &self.computer_id,
                &self.ghost_id,
                &self.execution_id,
                arguments_digest,
                self.expected_epoch,
                detail,
            )
    }

    /// Executes one owner-approved action and records the effect against its
    /// exact arguments digest. A changed digest or non-approved state refuses.
    pub(crate) fn execute_approved(
        &self,
        action_id: &str,
        arguments_digest: &str,
        operation: BrowserOperation,
    ) -> Result<serde_json::Value> {
        let state = self
            .registry
            .lock()
            .browser_action(action_id)?
            .ok_or_else(|| anyhow::anyhow!("browser action disappeared"))?;
        ensure!(state.state == "approved", "browser action is not approved");
        ensure!(
            state.arguments_digest == arguments_digest,
            "browser action arguments changed after approval"
        );
        let outcome = self.execute(operation)?;
        self.registry
            .lock()
            .record_browser_action_effect(action_id, arguments_digest)?;
        Ok(outcome)
    }

    pub(crate) fn profile_scope(&self) -> String {
        self.browser
            .profile_scope_for(&self.ghost_id)
            .unwrap_or_default()
            .to_owned()
    }

    pub(crate) fn current_url(&self) -> Option<String> {
        self.browser
            .page_url(&self.ghost_id, &self.execution_id)
            .map(|value| value.to_owned())
    }

    pub(crate) fn describe_target(&self, reference: &str, snapshot_id: u64) -> Option<serde_json::Value> {
        self.browser
            .target_label(&self.ghost_id, &self.execution_id, reference, snapshot_id)
    }

    /// Durable normalized question facts for the known pause.
    pub(crate) fn pause_snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "profile_scope": self.profile_scope(),
            "url": self.current_url(),
            "lease_execution_id": self.execution_id,
            "authority_epoch": self.expected_epoch,
        })
    }

    /// Stops the browser process WITHOUT releasing the execution's browser
    /// lease: the known pause holds the writer identity for same-identity
    /// resume. The registered instance record is cleared with the process.
    pub(crate) fn stop_browser_only(&self) {
        let _ = self.runtime.block_on(self.browser.stop_for_pause(&self.computer_id));
    }

    /// Deterministic same-identity resume: relaunch the exact registered
    /// instance under the still-held lease. Consent freshness first: a stale
    /// or mutated target NEVER executes the old approval — a fresh exact
    /// question is proposed from a live observation and the caller must wait
    /// for NEW owner consent.
    pub(crate) fn execute_paused_action(
        &self,
        action_id: &str,
        arguments_digest: &str,
        operation: crate::adapters::computer::BrowserOperation,
    ) -> Result<serde_json::Value> {
        // Navigation approves an exact URL, not an old DOM target.
        if matches!(&operation, BrowserOperation::Navigate { .. }) {
            return self.execute_approved(action_id, arguments_digest, operation);
        }
        let state = self
            .registry
            .lock()
            .browser_action(action_id)?
            .ok_or_else(|| anyhow::anyhow!("browser action disappeared"))?;
        ensure!(state.state == "approved", "browser action is not approved");
        ensure!(state.arguments_digest == arguments_digest,
            "browser action arguments changed after approval");
        let verified = self.browser.verify_target(&self.ghost_id, &self.execution_id, &state.detail)?;
        if !verified {
            // Observation-only refresh (no effect), then a fresh exact
            // question bound to the live observation.
            let fresh = self.browser.refresh_observation(&self.ghost_id, &self.execution_id)?;
            if let BrowserOperation::Click { reference, .. } = &operation {
                let fresh_target = self.browser.target_label(
                    &self.ghost_id,
                    &self.execution_id,
                    reference,
                    fresh["snapshot_id"].as_u64().unwrap_or_default(),
                );
                if let serde_json::Value::Object(detail) = &state.detail {
                    let mut refreshed = detail.clone();
                    refreshed.insert("url".into(), fresh["url"].clone());
                    refreshed.insert("snapshot_id".into(), fresh["snapshot_id"].clone());
                    refreshed.insert("target".into(), fresh_target.unwrap_or(Value::Null));
                    let _ = self
                        .registry
                        .lock()
                        .expire_browser_action(action_id, "target mutated or observation stale after pause");
                    let new_arguments = json!({
                        "operation": Self::arguments_of(&state.detail),
                        "ref": state.detail["target"]["ref"],
                        "snapshot_id": fresh["snapshot_id"],
                    });
                    let new_digest = crate::lifetime_contract::canonical_digest(&new_arguments)?;
                    let new_action = self.registry.lock().propose_browser_action(
                        &self.computer_id,
                        &self.ghost_id,
                        &self.execution_id,
                        &new_digest,
                        self.expected_epoch,
                        &Value::Object(refreshed),
                    )?;
                    return Ok(serde_json::json!({
                        "status": "fresh_consent_required",
                        "action_id": new_action,
                        "fresh_snapshot_id": fresh["snapshot_id"],
                    }));
                }
            }
            if let BrowserOperation::Type { reference, .. } = &operation {
                let fresh_target = self.browser.target_label(
                    &self.ghost_id,
                    &self.execution_id,
                    reference,
                    fresh["snapshot_id"].as_u64().unwrap_or_default(),
                );
                if let serde_json::Value::Object(detail) = &state.detail {
                    let mut refreshed = detail.clone();
                    refreshed.insert("url".into(), fresh["url"].clone());
                    refreshed.insert("snapshot_id".into(), fresh["snapshot_id"].clone());
                    refreshed.insert("target".into(), fresh_target.unwrap_or(Value::Null));
                    let _ = self
                        .registry
                        .lock()
                        .expire_browser_action(action_id, "target mutated or observation stale after pause");
                    let new_arguments = json!({
                        "operation": Self::arguments_of(&state.detail),
                        "ref": state.detail["target"]["ref"],
                        "snapshot_id": fresh["snapshot_id"],
                        "value": state.detail["value"],
                    });
                    let new_digest = crate::lifetime_contract::canonical_digest(&new_arguments)?;
                    let new_action = self.registry.lock().propose_browser_action(
                        &self.computer_id,
                        &self.ghost_id,
                        &self.execution_id,
                        &new_digest,
                        self.expected_epoch,
                        &Value::Object(refreshed),
                    )?;
                    return Ok(serde_json::json!({
                        "status": "fresh_consent_required",
                        "action_id": new_action,
                        "fresh_snapshot_id": fresh["snapshot_id"],
                    }));
                }
            }
            let _ = self
                .registry
                .lock()
                .expire_browser_action(action_id, "observation stale after pause");
            bail!("approved target could not be re-verified; a fresh consent question is required");
        }
        let outcome = self.execute(operation)?;
        self.registry
            .lock()
            .record_browser_action_effect(action_id, arguments_digest)?;
        Ok(outcome)
    }

    fn arguments_of(detail: &Value) -> &Value {
        &detail["arguments"]
    }

    /// Expires this execution's pending question durably (pause/settlement).
    pub(crate) fn expire_action(&self, action_id: &str, reason: &str) {
        let _ = self
            .registry
            .lock()
            .expire_browser_action(action_id, reason);
    }

    /// Stops the browser and releases the execution lease after a settled,
    /// collected execution. Unknown cleanup keeps the lease for explicit
    /// reconciliation, mirroring the worker-home lease semantics.
    pub(crate) fn release_after_settle(&self) -> Result<()> {
        let ghost_id = self.ghost_id.clone();
        let computer_id = self.computer_id.clone();
        self.runtime.block_on(async {
            self.browser.idle_stop(&computer_id, &ghost_id).await
        })?;
        Ok(())
    }
}
