mod scoped_tools;
#[cfg(unix)]
mod browser_relay;
#[cfg(unix)]
mod native_tools;
// Read by the Host's scoped owner artifact surface (lifetime/artifact.rs),
// which reuses the journal's verified artifact read/hash primitive.
pub(crate) mod journal;
mod omp_rpc;
mod process;
pub(crate) mod process_identity;
mod runner;
#[cfg(unix)]
pub mod guest_broker;
#[cfg(unix)]
pub mod guest_runtime;
#[cfg(unix)]
pub mod subscription_bridge;

use crate::lifetime_contract::{canonical_digest, Envelope, Response, ResponseStatus, RetryClass, WorkerSpec, VERSION};
use anyhow::{anyhow, bail, ensure, Context, Result};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use journal::{Admission, CommandLookup, ExecutionRecord, Journal};
use process::{ActorCommand, ActorControl, ActorHandle, ActorResume};
use runner::Runner;
#[cfg(unix)]
pub use runner::GuestRunnerConfig;
use scoped_tools::{ScopedWorkspace, WriteReconciliation};
#[cfg(unix)]
use native_tools::is_exact_worker_tool_scope;
use serde_json::{json, Value};
use std::{collections::HashMap, fs::{self, OpenOptions}, path::{Path, PathBuf}, sync::{mpsc, Arc, RwLock}, time::Duration};

const MAX_EXECUTION_ID_BYTES: usize = 400;
const MAX_PROMPT_BYTES: usize = 512 * 1024;
const RPC_ACK_TIMEOUT: Duration = Duration::from_secs(30);

/// Durable OMP execution journal and process supervisor. The worker server owns
/// this object; individual Host/SSH client connections do not own child stdin.
pub struct Supervisor {
    root: PathBuf,
    runner: Runner,
    journal: Journal,
    _lock: fs::File,
    actors: HashMap<String, ActorHandle>,
    authority_epoch: Arc<RwLock<u64>>,
}

impl Supervisor {
    /// Open the coordinator-registered scoped OMP runtime. Model requests never
    /// select the executable, entry point, package, or configuration overlay.
    pub fn open(root: &Path) -> Result<Self> {
        let runner = Runner::registered()?;
        Self::open_configured(root, runner)
    }

    /// Open with coordinator-trusted Bun, scoped entry, pinned package, and overlay.
    pub fn open_with_scoped_omp(root: &Path, bun: &Path, entry: &Path, package_root: &Path, overlay: &Path) -> Result<Self> {
        let runner = Runner::scoped_omp(bun, entry, package_root, overlay)?;
        Self::open_configured(root, runner)
    }

    /// Open one explicitly configured credentialless Linux OMP route.
    #[cfg(unix)]
    pub fn open_with_guest_omp(root: &Path, config: GuestRunnerConfig) -> Result<Self> {
        Self::open_configured(root, Runner::guest(config)?)
    }

    /// Explicit trusted fixture entry. This is not a production runner path.
    pub fn open_with_canary_runner(root: &Path, executable: &Path, runner_args: &[String]) -> Result<Self> {
        let runner = Runner::canary(executable, runner_args)?;
        Self::open_configured(root, runner)
    }

    fn open_configured(root: &Path, runner: Runner) -> Result<Self> {
        ensure!(root.is_absolute(), "worker root must be absolute");
        if let Ok(metadata) = fs::symlink_metadata(root) {
            ensure!(!metadata.file_type().is_symlink(), "worker root must not be a symlink");
            ensure!(metadata.is_dir(), "worker root is not a directory");
        } else {
            fs::create_dir_all(root)?;
        }
        let root = root.canonicalize()?;
        scoped_tools::ensure_workspace_root(&root)?;
        #[cfg(unix)]
        fs::set_permissions(&root, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
        let lock_path = root.join("supervisor.lock");
        if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
            ensure!(!metadata.file_type().is_symlink(), "worker supervisor lock must not be a symlink");
        }
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(lock_path)?;
        lock.try_lock_exclusive().map_err(|_| anyhow!("worker supervisor is already open for this root"))?;
        let journal = Journal::open(&root)?;
        let authority_epoch = Arc::new(RwLock::new(journal.current_epoch()?));
        let mut supervisor = Self { root: root.clone(), runner, journal, _lock: lock, actors: HashMap::new(), authority_epoch };
        supervisor.recover_open_executions()?;
        Ok(supervisor)
    }

    /// Handle one revision-1 worker envelope synchronously. Process IO runs on
    /// an execution-owned thread, not on the caller's connection lifetime.
    pub fn handle(&mut self, request: &Envelope) -> Result<Response> {
        if let Err(error) = request.validate() {
            return Ok(error_response("invalid_request", &error.to_string(), RetryClass::Never));
        }
        if request.protocol_version != VERSION {
            return Ok(error_response("unsupported_version", "worker protocol version is unsupported", RetryClass::Never));
        }
        let body = match request.body.as_object() {
            Some(body) => body,
            None => return Ok(error_response("invalid_request", "worker body must be an object", RetryClass::Never)),
        };
        let method = match body.get("method").and_then(Value::as_str) {
            Some(method) => method,
            None => return Ok(error_response("invalid_request", "worker method is required", RetryClass::Never)),
        };
        if matches!(method, "submit" | "steer" | "cancel" | "acknowledge" | "fence") {
            // A receipt witnesses an old command; it does not grant an old
            // writer permission to replay that command after a newer fence.
            let current_epoch = self.journal.current_epoch()?;
            if request.authority_epoch < current_epoch
                || (!matches!(method, "submit" | "fence") && request.authority_epoch != current_epoch)
            {
                return Ok(error_response("fenced", "worker mutation authority epoch is stale", RetryClass::Never));
            }
            if method == "submit" && request.authority_epoch > current_epoch {
                return Ok(error_response("fence_required", "advance the worker fence before submitting a newer authority epoch", RetryClass::ReconcileFirst));
            }
        }
        let request_value = serde_json::to_value(request)?;
        let request_digest = canonical_digest(&request_value)?;
        match self.journal.lookup_command(&request.command_id, &request_digest) {
            Ok(CommandLookup::Complete(response)) | Ok(CommandLookup::Pending(response)) => return Ok(response),
            Ok(CommandLookup::Missing) => {}
            Err(error) => return Ok(error_response("conflict", &error.to_string(), RetryClass::Never)),
        }
        match method {
            "submit" => self.submit(request, body, &request_digest),
            "inspect" => self.inspect(request, body, &request_digest),
            "events" => self.events(request, body, &request_digest),
            "steer" => self.control(request, body, &request_digest, ActorControl::Steer),
            #[cfg(unix)]
            "browser.resume" => self.browser_resume(request, &Value::Object(body.clone())),
            "cancel" => self.control(request, body, &request_digest, ActorControl::Cancel),
            "collect" => self.collect(request, body, &request_digest),
            "acknowledge" => self.acknowledge(request, body, &request_digest),
            "fence" => self.fence(request, body, &request_digest),
            _ => Ok(error_response("unsupported_method", "worker method is not supported", RetryClass::Never)),
        }
    }

    fn submit(&mut self, request: &Envelope, body: &serde_json::Map<String, Value>, request_digest: &str) -> Result<Response> {
        // The revision-1 admission body carries the sealed spec plus the
        // dispatcher's closed private skill payload (absent when the spec has
        // no pinned skills). Nothing else is accepted.
        let payload_keys = match body.get("skill_payloads") {
            Some(_) => ["method", "spec", "skill_payloads"].as_slice(),
            None => ["method", "spec"].as_slice(),
        };
        ensure_keys(body, payload_keys)?;
        let spec: WorkerSpec = serde_json::from_value(body.get("spec").cloned().unwrap_or(Value::Null))
            .context("invalid WorkerSpec")?;
        validate_spec(&spec, request.authority_epoch)?;
        // The admitted binding (computer + Ghost + epoch) validates the private
        // payload against the sealed refs BEFORE persist or launch: exact
        // closed set, per-payload SHA-256, bounded UTF-8 bytes, aggregate frame
        // budget. Validated bytes stage immutably per digest under this root;
        // the same-ID recovery path re-verifies existing bytes and never
        // replaces a pin.
        let payloads = self.validate_skill_payloads(body.get("skill_payloads"), &spec)?;
        let tool_scope_valid = match &self.runner {
            #[cfg(unix)]
            Runner::GuestOmp(template) => is_exact_worker_tool_scope(&spec.allowed_tools)
                && spec.allowed_tools.len() == native_tools::ALL_WORKER_TOOL_NAMES.len()
                    + usize::from(template.browser.is_some()),
            _ => spec.allowed_tools.len() == 2
                && spec.allowed_tools.iter().any(|tool| tool == "canary_read")
                && spec.allowed_tools.iter().any(|tool| tool == "canary_write"),
        };
        if !tool_scope_valid {
            return Ok(error_response("invalid_tool_scope", "worker tool scope does not match its registered execution route", RetryClass::Never));
        }
        if matches!(&self.runner, Runner::ScopedOmp { .. }) && (spec.model != "openai-codex/gpt-6-luna" || spec.thinking != "max") {
            return Ok(error_response("unsupported_model","scoped OMP accepts only openai-codex/gpt-6-luna at max thinking",RetryClass::Never));
        }
        #[cfg(unix)]
        if let Runner::GuestOmp(template) = &self.runner {
            let model_matches = match &template.config.backend {
                guest_broker::GuestModelBackend::LocalHttp { .. } =>
                    spec.model.strip_prefix("local/") == Some(template.config.model_id.as_str()) && spec.thinking == "off",
                guest_broker::GuestModelBackend::SubscriptionNative(_) =>
                    spec.model == "openai-codex/gpt-6-luna" && spec.thinking == "max",
            };
            if !model_matches {
                return Ok(error_response("unsupported_model", "guest OMP model and thinking must match its explicitly selected backend", RetryClass::Never));
            }
        }
        let cwd_valid = match &self.runner {
            #[cfg(unix)]
            Runner::GuestOmp(_) => true,
            _ => ScopedWorkspace::new(&self.root,&spec.cwd).is_ok(),
        };
        if !cwd_valid {
            return Ok(error_response("worker_cwd_out_of_scope","worker cwd must be a canonical directory under the supervisor workspace root",RetryClass::Never));
        }
        let spec_digest = journal::canonical_spec_digest(&spec)?;
        let session_locator = journal::execution_session_locator(&self.root, &spec.execution_id);
        let response = success_response(
            "Worker execution admitted durably",
            vec![spec.execution_id.clone()],
            json!({"execution_id":spec.execution_id,"spec_digest":spec_digest,"state":"admitted","session_locator":session_locator}),
        );
        let admission = match self.journal.admit(&request.command_id, request_digest, &spec, &spec_digest, &session_locator, &response) {
            Ok(admission) => admission,
            Err(error) => return Ok(error_response("conflict", &error.to_string(), RetryClass::Never)),
        };
        // Persist the validated payload bytes immutably, keyed by digest, only
        // after the journal admitted this execution binding. An existing staged
        // digest must already match its bytes — a pin is never replaced.
        if !payloads.is_empty() {
            if let Err(error) = persist_skill_payloads(&self.root, &payloads) {
                return Ok(error_response("invalid_request", &error.to_string(), RetryClass::ReconcileFirst));
            }
        }
        match admission {
            Admission::Cached(response) => Ok(response),
            Admission::New { response, session_locator } => {
                self.start_actor(spec, session_locator)?;
                Ok(response)
            }
            Admission::Existing { response, start_admitted, session_locator } => {
                if start_admitted && !self.actors.contains_key(&spec.execution_id) {
                    self.start_actor(spec, session_locator)?;
                }
                Ok(response)
            }
        }
    }

    /// Validate the dispatcher's closed private skill payload against the
    /// sealed spec: exact ref set (no extra, missing, or renamed entries),
    /// per-payload SHA-256 equal to the sealed digest, bounded UTF-8 content,
    /// and the aggregate admission-frame budget. Returns the verified contents
    /// for immutable staging.
    fn validate_skill_payloads(
        &self,
        raw: Option<&Value>,
        spec: &WorkerSpec,
    ) -> Result<Vec<(String, String)>> {
        use crate::lifetime_contract::WorkerSkillRef;
        let empty: Vec<WorkerSkillRef> = Vec::new();
        let refs = spec.skills.as_ref().unwrap_or(&empty);
        let Some(raw) = raw else {
            if refs.is_empty() {
                return Ok(Vec::new());
            }
            bail!("sealed skill refs require their private admission payload");
        };
        let items = raw
            .as_array()
            .ok_or_else(|| anyhow!("skill_payloads must be an array"))?;
        if refs.is_empty() {
            bail!("skill payload arrived for a spec without sealed skill refs");
        }
        if items.len() != refs.len() {
            bail!("skill payload set does not match the sealed skill refs exactly");
        }
        let mut staged = Vec::with_capacity(items.len());
        let mut total = 0usize;
        for (payload, reference) in items.iter().zip(refs.iter()) {
            let name = payload.get("name").and_then(Value::as_str)
                .ok_or_else(|| anyhow!("skill payload name is missing"))?;
            if name != reference.name {
                bail!("skill payload set does not match the sealed skill refs exactly");
            }
            let sha256 = payload.get("sha256").and_then(Value::as_str)
                .ok_or_else(|| anyhow!("skill payload digest is missing"))?;
            if sha256 != reference.sha256 {
                bail!("skill payload digest does not match the sealed spec");
            }
            let privacy = payload.get("privacy").and_then(Value::as_str)
                .ok_or_else(|| anyhow!("skill payload privacy is missing"))?;
            if privacy != reference.privacy {
                bail!("skill payload privacy does not match the sealed spec");
            }
            let content = payload.get("content").and_then(Value::as_str)
                .ok_or_else(|| anyhow!("skill payload content must be bounded UTF-8 text"))?;
            if content.len() > 262_144 {
                bail!("skill payload content exceeds the bounded size");
            }
            total += content.len();
            if total > crate::host::skills::MAX_SKILL_PAYLOAD_TOTAL {
                bail!("aggregate skill payload exceeds the worker admission frame budget");
            }
            let digest = format!("{:x}", Sha256::digest(content.as_bytes()));
            if digest != reference.sha256 {
                bail!("skill payload bytes do not match the sealed spec digest");
            }
            staged.push((reference.sha256.clone(), content.to_owned()));
        }
        Ok(staged)
    }

    fn inspect(&mut self, request: &Envelope, body: &serde_json::Map<String, Value>, digest: &str) -> Result<Response> {
        ensure_keys(body, &["method", "execution_id"])?;
        let execution_id = body_string(body, "execution_id")?;
        let Some(record) = self.journal.get_execution(execution_id)? else {
            let response = error_response("not_found", "execution_id is not in the worker journal", RetryClass::Never);
            self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
            return Ok(response);
        };
        let waiting_owner = if record.state == "waiting_owner" {
            self.journal
                .pending_browser_question(execution_id)?
                .and_then(|(_, receipt)| receipt.result)
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let response = success_response("Worker execution inspected", vec![execution_id.to_owned()], inspect_data(&record, self.journal.current_epoch()?, &waiting_owner));
        self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
        Ok(response)
    }

    fn events(&mut self, request: &Envelope, body: &serde_json::Map<String, Value>, digest: &str) -> Result<Response> {
        ensure_keys(body, &["method", "execution_id", "after_sequence"])?;
        let execution_id = body_string(body, "execution_id")?;
        let after = body.get("after_sequence").and_then(Value::as_u64).ok_or_else(|| anyhow!("after_sequence must be a non-negative integer"))?;
        let data = match self.journal.events(execution_id, after) {
            Ok(data) => data,
            Err(error) => {
                let response = error_response("sequence_reconcile_required", &error.to_string(), RetryClass::ReconcileFirst);
                self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
                return Ok(response);
            }
        };
        let is_gap = data["gap"] == true;
        let response = if is_gap {
            warning_response("Worker event sequence has a gap; use the authoritative snapshot before resuming", vec![execution_id.to_owned()], data, "sequence_gap", RetryClass::ReconcileFirst)
        } else {
            success_response("Worker events inspected", vec![execution_id.to_owned()], data)
        };
        self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
        Ok(response)
    }

    fn control(&mut self, request: &Envelope, body: &serde_json::Map<String, Value>, digest: &str, action: ActorControl) -> Result<Response> {
        let method = if matches!(action, ActorControl::Steer) { "steer" } else { "cancel" };
        let required = if method == "steer" { &["method", "execution_id", "prompt"][..] } else { &["method", "execution_id"][..] };
        ensure_keys(body, required)?;
        let execution_id = body_string(body, "execution_id")?;
        let current_epoch = request.authority_epoch; // handle fenced before any cached receipt.
        let prompt = if method == "steer" {
            let Some(prompt) = body.get("prompt").and_then(Value::as_str) else {
                return Ok(error_response("invalid_prompt", "steer prompt must be a string", RetryClass::Never));
            };
            if prompt.trim().is_empty() || prompt.len() > MAX_PROMPT_BYTES {
                return Ok(error_response("invalid_prompt", "steer prompt is empty or exceeds the RPC frame budget", RetryClass::Never));
            }
            Some(prompt.to_owned())
        } else {
            None
        };
        let pending = warning_response("Worker control intent is durable; command outcome is being reconciled", vec![execution_id.to_owned()], json!({"execution_id":execution_id,"state":"command_pending"}), "command_pending", RetryClass::ReconcileFirst);
        self.journal.reserve_command(&request.command_id, digest, Some(execution_id), &pending)?;
        let Some(record) = self.journal.get_execution(execution_id)? else {
            let response = error_response("not_found", "execution_id is not in the worker journal", RetryClass::Never);
            self.journal.finish_command(&request.command_id, &response)?;
            return Ok(response);
        };
        if record.spec.authority_epoch != current_epoch || record.session_settled || record.process_exited {
            let response = warning_response("Execution is not controllable in its current state", vec![execution_id.to_owned()], inspect_data(&record,current_epoch,&Value::Null), "execution_not_controllable", RetryClass::ReconcileFirst);
            self.journal.finish_command(&request.command_id, &response)?;
            return Ok(response);
        }
        let Some(actor) = self.actors.get(execution_id) else {
            let response = warning_response("Worker process is not attached; inspect and reconcile before retrying", vec![execution_id.to_owned()], inspect_data(&record,current_epoch,&Value::Null), "worker_not_attached", RetryClass::ReconcileFirst);
            self.journal.finish_command(&request.command_id, &response)?;
            return Ok(response);
        };
        if !matches!(action, ActorControl::Steer) {
            actor.authorization.store(false, std::sync::atomic::Ordering::Release);
        }
        let (reply, receive) = mpsc::sync_channel(1);
        if actor.sender.send(ActorCommand { action, prompt, resume: None, reply }).is_err() {
            let response = warning_response("Worker process actor disconnected; inspect the same execution before retrying", vec![execution_id.to_owned()], inspect_data(&record,current_epoch,&Value::Null), "worker_not_attached", RetryClass::ReconcileFirst);
            self.journal.finish_command(&request.command_id, &response)?;
            return Ok(response);
        }
        let result = match receive.recv_timeout(RPC_ACK_TIMEOUT) {
            Ok(Ok(data)) => success_response(if method == "steer" { "OMP acknowledged steering input" } else { "OMP acknowledged cancellation request; process stop and effect reconciliation remain separate" }, vec![execution_id.to_owned()], data),
            Ok(Err(error)) => warning_response("Worker control outcome is uncertain; inspect the same execution before retrying", vec![execution_id.to_owned()], json!({"execution_id":execution_id,"error":error.to_string()}), "effect_unknown", RetryClass::ReconcileFirst),
            Err(_) => warning_response("Worker control acknowledgement timed out; inspect the same execution before retrying", vec![execution_id.to_owned()], json!({"execution_id":execution_id,"command_acknowledged":false}), "effect_unknown", RetryClass::ReconcileFirst),
        };
        self.journal.finish_command(&request.command_id, &result)?;
        Ok(result)
    }
    fn collect(&mut self, request: &Envelope, body: &serde_json::Map<String, Value>, digest: &str) -> Result<Response> {
        ensure_keys(body, &["method", "execution_id"])?;
        let execution_id = body_string(body, "execution_id")?;
        #[cfg(unix)]
        if let Runner::GuestOmp(guest) = &self.runner {
            if let Some(record) = self.journal.get_execution(execution_id)? {
                if matches!(record.state.as_str(), "unknown" | "failed") && !record.session_settled {
                    let outcome = (|| -> Result<(Value, Vec<crate::lifetime_contract::Artifact>)> {
                        ensure!(!self.actors.contains_key(execution_id), "unsettled execution still has a live actor owner");
                        ensure!(guest.cleanup_home_is_authorized(&record.spec)?, "original native Home cleanup scope is not authorized");
                        self.journal.ensure_unknown_tools_reconciled(execution_id)?;
                        let receipt = self.journal.unsettled_forensic_receipt(execution_id)?;
                        let (data, artifacts) = match receipt {
                            Some((data, artifacts)) => {
                                ensure!(data["spec_digest"].as_str() == Some(record.spec_digest.as_str()),
                                    "unknown forensic receipt differs from the original spec");
                                (data, artifacts)
                            }
                            None => {
                                let expected = journal::execution_session_locator(&self.root, execution_id);
                                ensure!(record.session_locator == expected, "original native session scope changed");
                                let (pid, group, start) = match (record.pid, record.process_group, record.process_start_identity.as_deref()) {
                                    (Some(pid), Some(group), Some(start)) => (pid, group, start),
                                    _ => anyhow::bail!("original process birth identity is missing"),
                                };
                                ensure!(process_identity::reconcile_recorded_absence(pid, group, start)?,
                                    "original process group is not proven absent");
                                let runtime_key = Path::new(&expected).file_name().context("original native runtime key is missing")?;
                                let reservation = self.root.join("guest-runtimes").join(runtime_key)
                                    .join("control").join("launch-reservation.jsonl");
                                let name = guest_runtime::reconcile_owned_launch(
                                    &guest.config.container_cli, &reservation, execution_id, record.spec.authority_epoch,
                                ).map_err(anyhow::Error::new)?;
                                let proof = json!({
                                    "ghost_id":guest.config.ghost_id,"computer_id":record.spec.computer_id,
                                    "authority_epoch":record.spec.authority_epoch,"pid":pid,"process_group":group,
                                    "process_start_identity":start,"container_name":name,
                                    "host_process_group_absent":true,"original_native_vm_stopped":true,
                                });
                                self.journal.collect_unsettled_forensics(&record, proof)?
                            }
                        };
                        guest.release_home(&record.spec).context("forensic proof is durable but original Home release still requires reconciliation")?;
                        Ok((data, artifacts))
                    })();
                    let response = match outcome {
                        Ok((data, artifacts)) => {
                            let mut response = warning_response(
                                "Original native execution physically collected; original failed or unknown producer outcome is preserved and is not accepted evidence",
                                vec![execution_id.to_owned()], data, "unsettled_physically_collected", RetryClass::ReconcileFirst,
                            );
                            response.artifacts = artifacts;
                            response
                        }
                        Err(error) => error_response("native_unsettled_cleanup_unverified", &error.to_string(), RetryClass::ReconcileFirst),
                    };
                    self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
                    return Ok(response);
                }
            }
        }
        let (data, artifacts, complete) = match self.journal.collect(execution_id) {
            Ok(value) => value,
            Err(error) => {
                let response = error_response("collection_unverified", &error.to_string(), RetryClass::ReconcileFirst);
                self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
                return Ok(response);
            }
        };
        #[cfg(unix)]
        if complete {
            if let Runner::GuestOmp(guest) = &self.runner {
                let record = self.journal.get_execution(execution_id)?.context("collected worker execution disappeared")?;
                if guest.release_home(&record.spec).is_err() {
                    return Ok(error_response("home_lease_release_failed", "collected execution home lease could not be released; reconcile the same execution", RetryClass::ReconcileFirst));
                }
            }
        }
        let response = if complete {
            let mut response = success_response("Durable worker receipt and spool artifacts collected; Host acceptance is separate", vec![execution_id.to_owned()], data);
            response.artifacts = artifacts;
            response
        } else {
            warning_response("Worker execution is not fully settled and exited; collect only after inspect/reconcile", vec![execution_id.to_owned()], data, "not_collected", RetryClass::ReconcileFirst)
        };
        self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
        Ok(response)
    }

    fn acknowledge(&mut self, request: &Envelope, body: &serde_json::Map<String, Value>, digest: &str) -> Result<Response> {
        ensure_keys(body, &["method", "execution_id", "through_sequence"])?;
        let execution_id = body_string(body, "execution_id")?;
        let through = body.get("through_sequence").and_then(Value::as_u64).ok_or_else(|| anyhow!("through_sequence must be a non-negative integer"))?;
        let response = match self.journal.acknowledge(execution_id, through) {
            Ok(sequence) => success_response("Durable event sequence acknowledged", vec![execution_id.to_owned()], json!({"execution_id":execution_id,"through_sequence":sequence,"terminal_receipt_preserved":true})),
            Err(error) => error_response("invalid_acknowledgement", &error.to_string(), RetryClass::Never),
        };
        self.journal.cache_command(&request.command_id, digest, Some(execution_id), &response)?;
        Ok(response)
    }

    fn fence(&mut self, request: &Envelope, body: &serde_json::Map<String, Value>, digest: &str) -> Result<Response> {
        ensure_keys(body, &["method", "new_epoch"])?;
        let new_epoch = body.get("new_epoch").and_then(Value::as_u64).ok_or_else(|| anyhow!("new_epoch must be a positive integer"))?;
        if new_epoch == 0 || request.authority_epoch != new_epoch {
            return Ok(error_response("invalid_fence", "fence new_epoch must match the positive envelope authority_epoch", RetryClass::Never));
        }
        let pending = warning_response("Worker authority fence is being committed", Vec::new(), json!({"new_epoch":new_epoch}), "fence_pending", RetryClass::ReconcileFirst);
        self.journal.reserve_command(&request.command_id,digest,None,&pending)?;
        let mut authority_epoch = self.authority_epoch.write().map_err(|_| anyhow!("worker authority lock is poisoned"))?;
        let fenced = match self.journal.fence(new_epoch) {
            Ok(ids) => {
                *authority_epoch = new_epoch;
                ids
            }
            Err(error) => {
                let response = error_response("invalid_fence", &error.to_string(), RetryClass::Never);
                self.journal.finish_command(&request.command_id,&response)?;
                return Ok(response);
            }
        };
        drop(authority_epoch);
        for execution_id in &fenced {
            if let Some(actor) = self.actors.get(execution_id) {
                actor.authorization.store(false, std::sync::atomic::Ordering::Release);
                let (reply, _receive) = mpsc::sync_channel(1);
                let _ = actor.sender.send(ActorCommand { action:ActorControl::Fence, prompt:None, resume:None, reply });
            } else if let Some(record) = self.journal.get_execution(execution_id)? {
                if let (Some(pid),Some(group),Some(start)) = (record.pid,record.process_group,record.process_start_identity.as_deref()) {
                    let _ = process_identity::terminate_group(pid,group,start);
                }
            }
        }
        let response = success_response("Worker authority epoch fenced; prior executions are retained and not replayed", fenced, json!({"authority_epoch":new_epoch,"new_spawns_blocked_for_older_epochs":true,"cancel_ack_is_not_process_exit":true}));
        self.journal.finish_command(&request.command_id,&response)?;
        Ok(response)
    }

    fn start_actor(&mut self, spec: WorkerSpec, session_locator: String) -> Result<()> {
        if self.actors.contains_key(&spec.execution_id) { return Ok(()); }
        let record = self.journal.get_execution(&spec.execution_id)?.ok_or_else(|| anyhow!("execution disappeared before process start"))?;
        if record.state != "admitted" { return Ok(()); }
        let handle = match process::start_actor(&self.root, self.runner.clone(), spec.clone(), session_locator, self.authority_epoch.clone()) {
            Ok(handle) => handle,
            Err(error) => {
                self.journal.set_failure(&spec.execution_id,"runner_thread_start_failed",&error.to_string(),false)?;
                return Err(error);
            }
        };
        self.actors.insert(spec.execution_id, handle);
        Ok(())
    }

    /// Deterministic resume of a known owner-question pause. The owner
    /// decision arrives through the control plane; the durable pending tool
    /// executes HERE — same execution identity, fresh same-epoch leases, a
    /// relaunched registered browser instance, effect-time authorization —
    /// never by asking the model to guess. Unknown effects stay fenced.
    #[cfg(unix)]
    fn browser_resume(
        &mut self,
        request: &Envelope,
        body: &Value,
    ) -> Result<Response> {
        use crate::worker::process::browser_operation_from_arguments;
        const KEYS: &[&str] = &["method", "execution_id", "action_id", "decision", "approver"];
        let body = body.as_object().cloned().unwrap_or_default();
        if body.len() != KEYS.len() || KEYS.iter().any(|key| !body.contains_key(*key)) {

            return Ok(error_response("invalid_request", "browser.resume requires method, execution_id, action_id, decision, approver", RetryClass::Never));
        }
        let execution_id = body["execution_id"].as_str().unwrap_or_default().to_owned();
        let action_id = body["action_id"].as_str().unwrap_or_default().to_owned();
        let decision = body["decision"].as_str().unwrap_or_default().to_owned();
        let arguments_digest;
        if execution_id.is_empty() || action_id.is_empty() {
            return Ok(error_response("invalid_request", "browser.resume requires identifiers", RetryClass::Never));
        }
        if !matches!(decision.as_str(), "approve" | "deny") {
            return Ok(error_response("invalid_request", "browser.resume decision must be approve or deny", RetryClass::Never));
        }
        let current_epoch = *self
            .authority_epoch
            .read()
            .map_err(|_| anyhow::anyhow!("worker authority lock is poisoned"))?;
        if request.authority_epoch != current_epoch {
            return Ok(error_response("authority_fenced", "resume authority is not current", RetryClass::NewRevision));
        }
        // Known pause only: waiting_owner + staged pending question.
        if self.journal.execution_state(&execution_id)?.as_deref() != Some("waiting_owner") {
            return Ok(error_response("not_paused", "execution has no known owner-question pause", RetryClass::Never));
        }
        let Some((tool_call_id, receipt)) = self.journal.pending_browser_question_for_action(&execution_id, &action_id)? else {
            return Ok(error_response("not_paused", "execution has no pending browser question for this action", RetryClass::Never));
        };
        let template = match &self.runner {
            Runner::GuestOmp(template) => template.clone(),
            _ => return Ok(error_response("unsupported_runner", "browser resume requires the native guest route", RetryClass::Never)),
        };
        let approver = body["approver"].as_str().unwrap_or_default().to_owned();
        let record = self.journal.get_execution(&execution_id)?
            .ok_or_else(|| anyhow::anyhow!("execution record disappeared"))?;
        let Some(remaining_ms) = self.journal.paused_remaining_budget_ms(&execution_id)? else {
            return Ok(error_response("budget_unknown", "the original active budget was not sealed at this pause; no effect dispatched", RetryClass::Never));
        };
        if remaining_ms == 0 || remaining_ms > record.spec.deadline_ms {
            return Ok(error_response("budget_exhausted", "the sealed original active budget is exhausted or invalid; no effect dispatched", RetryClass::Never));
        }
        let resume_started = std::time::Instant::now();
        // The decision is durably recorded against the still-held leases
        // before any effect: same execution identity, same authority epoch.
        // Either the Host control plane already CAS-approved (authenticated
        // approver travels with the transport) or this supervisor CASes with
        // the explicit approver identity — never a literal placeholder.
        {
            let mut registry = template.registry.lock();
            let action = registry
                .browser_action(&action_id)?
                .ok_or_else(|| anyhow::anyhow!("unknown browser action"))?;
            if action.execution_id != execution_id
                || action.requested_epoch != request.authority_epoch {
                return Ok(error_response("not_paused", "action belongs to another execution", RetryClass::Never));
            }
            match action.state.as_str() {
                "pending" => {
                    ensure!(!approver.is_empty() && approver.len() <= 180,
                        "browser resume of a pending action requires the authenticated approver identity");
                    registry
                        .decide_browser_action(&action_id, &approver, decision == "approve")
                        .map_err(|error| anyhow::anyhow!("decision refused: {error}"))?;
                }
                "approved" if decision == "approve" => {
                    ensure!(!action.approved_by.as_deref().unwrap_or_default().is_empty(),
                        "pre-approved action carries no authenticated approver");
                }
                "approved" => {
                    return Ok(error_response("stale_action", "action was already approved; deny is not applicable", RetryClass::Never));
                }
                other => {
                    return Ok(error_response("stale_action", &format!("browser action is {other}"), RetryClass::Never));
                }
            }
            arguments_digest = action.arguments_digest;
        }
        // A crash during decision/effect work must not reuse the old sealed
        // allowance as if the interval had been an owner wait.
        self.journal.charge_owner_budget(&execution_id, remaining_ms)?;
        let result = if decision == "deny" {
            json!({"status": "denied_by_owner", "action_id": action_id})
        } else {
        // Approve: fresh same-identity browser session under the held lease,
        // effect-time reauthorization inside execute_approved.
        let Some(relay) = template.browser_relay(&record.spec, Arc::clone(&self.authority_epoch))? else {
            return Ok(error_response("unsupported_runner", "worker has no browser grant", RetryClass::Never));
        };
        let Some(operation) = browser_operation_from_arguments(&receipt.arguments) else {
            return Ok(error_response("invalid_request", "staged arguments do not parse", RetryClass::Never));
        };
        match relay.execute_paused_action(&action_id, &arguments_digest, operation) {
            Ok(result) => result,
            Err(error) => {
                // Approval is committed. A failed/unknown effect must never
                // remain a resumable owner wait or acquire a fresh budget.
                self.journal.finish_tool_call(
                    &execution_id, &tool_call_id, receipt.authority_epoch,
                    &json!({"error_code":"browser_resume_effect_unknown","action_id":action_id}),
                    true, None, true,
                )?;
                self.journal.mark_recovery_unknown(&execution_id,
                    "approved browser effect failed; reconcile the original execution without replay")?;
                return Ok(error_response("browser_resume_effect_unknown",
                    &format!("approved effect failed: {error}"), RetryClass::ReconcileFirst));
            }
        }
        };
        // Consent freshness: a relaunched session re-observed a mutated page —
        // the OLD approval never executes; a fresh exact question replaces it
        // and the execution stays in its known pause awaiting NEW consent. The
        // parked SDK frame stays unanswered: the SAME tool call still resolves
        // exactly once, with the eventual decision on the fresh action.
        if result["status"].as_str() == Some("fresh_consent_required") {
            let new_action = result["action_id"].as_str().unwrap_or_default().to_owned();
            self.journal.stage_tool_receipt_result(
                &execution_id,
                &tool_call_id,
                receipt.authority_epoch,
                &result,
            )?;
            // The consent refresh was real observation work on the active
            // budget; the following owner wait is not. Seal the charged
            // remainder as the newest pause.
            let charged = remaining_ms.saturating_sub(resume_started.elapsed().as_millis() as u64);
            self.journal.mark_waiting_owner(&execution_id, &new_action, &result, charged)?;
            self.journal.seal_owner_budget(&execution_id, charged)?;
            return Ok(success_response(
                "target mutated after pause; fresh exact consent required",
                vec![execution_id],
                json!({"resumed": false, "fresh_consent_required": true, "action_id": new_action, "remaining_budget_ms": charged}),
            ));
        }
        self.journal.finish_tool_call(
            &execution_id,
            &tool_call_id,
            receipt.authority_epoch,
            &result,
            decision == "deny",
            None,
            false,
        )?;
        self.journal.mark_resumed(&execution_id, &json!({
            "action_id": action_id, "decision": decision, "result": result,
        }))?;
        // Same sealed session and original active budget, excluding owner
        // waiting time. Charge the authorized decision/effect work before any
        // continuation; the owner wait itself never spent budget.
        let remaining_ms = remaining_ms.saturating_sub(resume_started.elapsed().as_millis() as u64);
        if self.actors.contains_key(&execution_id) {
            // The paused actor still holds the EXACT unanswered SDK frame for
            // this tool call: deliver the committed decision to it in memory.
            // Even a zero remainder is delivered — the answer is the durable
            // receipt, not a new effect — and the rebased clock then ends the
            // run through the normal deadline path.
            let Some(actor) = self.actors.get(&execution_id) else {
                return Ok(error_response("not_paused", "worker actor vanished during resume", RetryClass::ReconcileFirst));
            };
            let (reply, receive) = mpsc::sync_channel(1);
            let sent = actor.sender.send(ActorCommand {
                action: ActorControl::Resume,
                prompt: None,
                resume: Some(ActorResume {
                    tool_call_id: tool_call_id.clone(),
                    remaining_ms,
                }),
                reply,
            }).is_ok();
            if sent {
                return match receive.recv_timeout(RPC_ACK_TIMEOUT) {
                    Ok(Ok(delivery)) => {
                        let effective_remaining_ms = delivery["remaining_budget_ms"].as_u64()
                            .ok_or_else(|| anyhow::anyhow!("live actor omitted its measured remaining budget"))?;
                        Ok(success_response(
                            if decision == "deny" { "owner denied; the sealed session continued without executing the action" } else { "owner approved; the exact action executed and the sealed session continued" },
                            vec![execution_id],
                            json!({"resumed": true, "executed": decision == "approve", "result": result, "remaining_budget_ms": effective_remaining_ms, "delivery": delivery}),
                        ))
                    }
                    Ok(Err(error)) => {
                        let data = json!({"execution_id":execution_id,"error":error.to_string(),"decision_committed":true});
                        Ok(warning_response(
                            "The decision is committed but its SDK delivery failed; reconcile this exact tool call before any continuation",
                            vec![execution_id], data,
                            "resume_delivery_failed", RetryClass::ReconcileFirst,
                        ))
                    }
                    Err(_) => {
                        let data = json!({"execution_id":execution_id,"decision_committed":true,"delivery":"unknown"});
                        Ok(warning_response(
                            "The decision is committed but its SDK delivery outcome is unknown; reconcile this exact tool call — do not resend the decision",
                            vec![execution_id], data,
                            "resume_delivery_unknown", RetryClass::ReconcileFirst,
                        ))
                    }
                };
            }
            // The actor died between the attachment check and the send: fall
            // through to the same-identity relaunch below.
            self.actors.remove(&execution_id);
        }
        if remaining_ms == 0 {
            self.journal.append_event(&execution_id, "deadline_reached_after_owner_decision",
                &json!({"decision": decision, "result": result}), 0, true, Some("failed"))?;
            return Ok(error_response("budget_exhausted", "owner decision completed; no active budget remains for SDK continuation", RetryClass::Never));
        }
        let handle = crate::worker::process::start_actor_with_budget(
            &self.root,
            self.runner.clone(),
            record.spec,
            record.session_locator,
            Arc::clone(&self.authority_epoch),
            Some(ActorResume { tool_call_id, remaining_ms }),
        )?;
        self.actors.insert(execution_id.clone(), handle);
        Ok(success_response(
            if decision == "deny" { "owner denied; the sealed session resumed without executing the action" } else { "owner approved; the exact action executed and the sealed session resumed" },
            vec![execution_id],
            json!({"resumed": true, "executed": decision == "approve", "result": result, "remaining_budget_ms": remaining_ms, "delivery": "relaunched_session_continuation"}),
        ))
    }

    fn reconcile_recovered_tool_calls(&mut self, spec: &WorkerSpec) -> Result<()> {
        for (tool_call_id, receipt) in self.journal.pending_tool_calls(&spec.execution_id)? {
            let mut result = json!({"error_code":"tool_effect_unknown"});
            let mut is_error = true;
            let mut unknown = true;
            let mut artifact = None;
            if receipt.tool_name == "canary_write" {
                if let (Some(path),Some(content)) = (receipt.arguments["path"].as_str(),receipt.arguments["content"].as_str()) {
                    if let Ok(workspace) = ScopedWorkspace::new(&self.root,&spec.cwd) {
                        match workspace.reconcile_write(path,content,&receipt.intent) {
                            Ok(WriteReconciliation::Applied) => {
                                if let Some(digest) = receipt.intent["desired_sha256"].as_str() {
                                    match self.journal.write_artifact(&spec.execution_id,content.as_bytes()) {
                                        Ok(saved) => {
                                            result = json!({"path":path,"sha256":digest});
                                            is_error = false;
                                            unknown = false;
                                            artifact = Some(saved);
                                        }
                                        Err(_) => result = json!({"error_code":"tool_artifact_store_failed"}),
                                    }
                                }
                            }
                            Ok(WriteReconciliation::NotApplied) => {
                                result = json!({"error_code":"tool_not_applied_after_recovery"});
                                unknown = false;
                            }
                            Ok(WriteReconciliation::Unknown) | Err(_) => {}
                        }
                    }
                }
            }
            self.journal.finish_tool_call(
                &spec.execution_id,
                &tool_call_id,
                receipt.authority_epoch,
                &result,
                is_error,
                artifact.as_ref(),
                unknown,
            )?;
        }
        Ok(())
    }

    fn mark_pending_tool_calls_unknown(&mut self, execution_id: &str) -> Result<()> {
        for (tool_call_id,receipt) in self.journal.pending_tool_calls(execution_id)? {
            self.journal.finish_tool_call(
                execution_id,
                &tool_call_id,
                receipt.authority_epoch,
                &json!({"error_code":"tool_effect_unknown"}),
                true,
                None,
                true,
            )?;
        }
        Ok(())
    }

    fn recover_open_executions(&mut self) -> Result<()> {
        let records = self.journal.active_records()?;
        for record in records {
            match record.state.as_str() {
                "admitted" if record.pid.is_none() && !record.prompt_intent => {
                    let locator = record.session_locator.clone();
                    self.start_actor(record.spec, locator)?;
                }
                state if matches!(state, "starting" | "running" | "yielded" | "cancel_requested" | "cancel_acknowledged" | "spool_full" | "fenced" | "settled" | "resumed")
                    || (state == "waiting_owner"
                        && self.journal.paused_remaining_budget_ms(&record.spec.execution_id)?.is_none()) => {
                    let identity = match (record.pid,record.process_group,record.process_start_identity.as_deref()) {
                        (Some(pid),Some(group),Some(start)) => process_identity::verify_recorded(&self.root,pid,group,start)?,
                        _ => false,
                    };
                    let stopped = if identity {
                        process_identity::terminate_group(record.pid.unwrap(),record.process_group.unwrap(),record.process_start_identity.as_deref().unwrap())?
                    } else { true };
                    if record.prompt_intent || record.prompt_acknowledged || !stopped {
                        self.journal.mark_recovery_unknown(&record.spec.execution_id,"worker restart left an execution outcome to reconcile; automatic respawn is disabled")?;
                        if identity && stopped {
                            self.reconcile_recovered_tool_calls(&record.spec)?;
                        } else {
                            self.mark_pending_tool_calls_unknown(&record.spec.execution_id)?;
                        }
                    } else if record.pid.is_none() || !identity {
                        self.journal.mark_recovery_unknown(&record.spec.execution_id,"process identity was not durably recorded; no automatic respawn")?;
                    } else {
                        self.journal.mark_admitted_for_recovery(&record.spec.execution_id)?;
                        let latest = self.journal.get_execution(&record.spec.execution_id)?.ok_or_else(|| anyhow!("execution disappeared during recovery"))?;
                        self.start_actor(latest.spec,latest.session_locator)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn validate_spec(spec: &WorkerSpec, envelope_epoch: u64) -> Result<()> {
    ensure!(!spec.execution_id.is_empty() && spec.execution_id.len() <= MAX_EXECUTION_ID_BYTES, "invalid execution_id");
    ensure!(!spec.work_id.is_empty() && spec.work_id.len() <= MAX_EXECUTION_ID_BYTES, "invalid work_id");
    ensure!(spec.work_revision > 0 && spec.authority_epoch > 0, "worker revisions must be positive");
    ensure!(spec.authority_epoch == envelope_epoch, "WorkerSpec authority_epoch must match the envelope");
    ensure!(spec.deadline_ms > 0 && spec.max_progress_bytes > 0, "worker limits must be positive");
    ensure!(!spec.prompt.trim().is_empty() && spec.prompt.len() <= MAX_PROMPT_BYTES, "worker prompt is empty or exceeds the bounded prompt frame");
    ensure!(spec.cwd.starts_with('/'), "worker cwd must be absolute");
    let (provider, model) = spec.model.split_once('/').ok_or_else(|| anyhow!("worker model must be provider-qualified"))?;
    ensure!(!provider.is_empty() && !model.is_empty() && !spec.model.starts_with('-'), "worker model selector is invalid");
    ensure!(matches!(spec.thinking.as_str(),"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"), "unsupported OMP thinking level");
    ensure!(spec.allowed_tools.iter().all(|tool| !tool.trim().is_empty() && tool.len() <= 128), "worker allowed_tools contains an invalid name");
    Ok(())
}

fn ensure_keys(body: &serde_json::Map<String, Value>, keys: &[&str]) -> Result<()> {
    ensure!(body.len() == keys.len() && keys.iter().all(|key| body.contains_key(*key)), "worker body fields do not match the revision-1 method contract");
    Ok(())
}

fn body_string<'a>(body: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str> {
    let value = body.get(key).and_then(Value::as_str).ok_or_else(|| anyhow!("{key} must be a string"))?;
    ensure!(!value.is_empty() && value.len() <= MAX_EXECUTION_ID_BYTES, "{key} is empty or oversized");
    Ok(value)
}

fn inspect_data(record: &ExecutionRecord, authority_epoch: u64, waiting_owner: &Value) -> Value {
    json!({"execution_id":record.spec.execution_id,"work_id":record.spec.work_id,"work_revision":record.spec.work_revision,
        "spec_digest":record.spec_digest,"authority_epoch":record.spec.authority_epoch,"current_authority_epoch":authority_epoch,
        "state":record.state,"pid":record.pid,"process_start_identity":record.process_start_identity,
        "process_group":record.process_group,"session_locator":record.session_locator,
        "last_sequence":record.last_sequence,"acknowledged_sequence":record.acknowledged_sequence,
        "progress_bytes":record.progress_bytes,"prompt_intent":record.prompt_intent,
        "prompt_acknowledged":record.prompt_acknowledged,"prompt_result":record.prompt_result,
        "session_settled":record.session_settled,"process_exited":record.process_exited,
        "process_exit_code":record.process_exit_code,"collected":record.collected,
        "collection_kind":if record.collected && matches!(record.state.as_str(), "unknown" | "failed") { Some("native_unknown_forensics") } else { None },
        "waiting_owner": waiting_owner})
}

/// Persist validated skill payload bytes immutably, content-addressed by their
/// sealed digest, under THIS binding root's skills store. An existing staged
/// digest must already match its bytes; a pin is never replaced or rewritten.
fn persist_skill_payloads(root: &Path, payloads: &[(String, String)]) -> Result<()> {
    let store = root.join("skills-store");
    for (digest, content) in payloads {
        let target = store.join(digest).join("SKILL.md");
        if target.exists() {
            let existing = fs::read_to_string(&target)
                .map_err(|_| anyhow!("staged skill pin is not bounded UTF-8 text"))?;
            let existing_digest = format!("{:x}", Sha256::digest(existing.as_bytes()));
            ensure!(existing_digest == *digest, "staged skill pin does not match its digest");
            continue;
        }
        let parent = target.parent().expect("digest store parent");
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        fs::set_permissions(parent, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
        let temp = store.join(format!(".{digest}.tmp"));
        fs::write(&temp, content.as_bytes())?;
        #[cfg(unix)]
        fs::set_permissions(&temp, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        fs::rename(&temp, &target)?;
    }
    Ok(())
}

fn success_response(summary: &str, object_refs: Vec<String>, data: Value) -> Response {
    Response { status:ResponseStatus::Success,summary:summary.to_owned(),object_refs,artifacts:Vec::new(),next_actions:Vec::new(),error_code:None,retry_class:RetryClass::SameId,data }
}

fn warning_response(summary: &str, object_refs: Vec<String>, data: Value, code: &str, retry: RetryClass) -> Response {
    Response { status:ResponseStatus::Warning,summary:summary.to_owned(),object_refs,artifacts:Vec::new(),next_actions:vec!["Inspect the same execution before retrying".into()],error_code:Some(code.into()),retry_class:retry,data }
}

fn error_response(code: &str, summary: &str, retry: RetryClass) -> Response {
    Response { status:ResponseStatus::Error,summary:summary.to_owned(),object_refs:Vec::new(),artifacts:Vec::new(),next_actions:Vec::new(),error_code:Some(code.into()),retry_class:retry,data:Value::Null }
}
