use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use ghost::collaboration::{self, Coordinator, ParentSpec, WorkerSpec};
#[cfg(feature = "oxicode-engine")]
use ghost::provider::OxicodeProvider;
use ghost::provider::{MockProvider, Provider};
use ghost::run_cycle;
use ghost::store::{self, ProfileStore};
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

fn emit(v: &impl serde::Serialize) -> Result<()> {
    let mut out = std::io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, v)?;
    out.write_all(b"\n")?;
    Ok(())
}

#[derive(Parser)]
#[command(
    name = "ghost",
    version,
    about = "Persistent personal agents and task control"
)]
struct Cli {
    /// State directory (GHOST_ROOT or the user's application state directory).
    #[arg(long, global = true)]
    root: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Independent local worker supervisor; does not install or restart a service.
    #[cfg(all(feature = "lifetime", unix))]
    WorkerServe,
    /// Capture, verify or restore caller-selected lifetime roots; never stop services.
    #[cfg(all(feature = "lifetime", unix))]
    Recovery {
        #[command(subcommand)]
        c: RecoveryCmd,
    },
    /// Create or verify an immutable selected release; never install it.
    #[cfg(all(feature = "lifetime", unix))]
    Release {
        #[command(subcommand)]
        c: ReleaseCmd,
    },
    /// Check model resolution and provider construction without a paid call.
    #[cfg(feature = "host")]
    Doctor {
        #[arg(long, default_value = "mock")]
        model: String,
    },
    /// Provision, inspect or revoke the Host-owned Google planner lease.
    /// Account consent happens in the owner's browser; tokens are never printed.
    #[cfg(feature = "caldav")]
    PlannerGoogle {
        #[command(subcommand)]
        c: PlannerGoogleCmd,
    },
    /// Restore a verified backup to this new root. Existing roots are refused.
    #[cfg(feature = "host")]
    Restore { backup: PathBuf },
    /// Write a supervisor configuration for review, without installing it.
    #[cfg(feature = "host")]
    ServiceSpec {
        #[arg(long)]
        output: PathBuf,
        /// Absolute OxiBrowser CLI path for public web search/read tools.
        #[arg(long)]
        oxibrowser_executable: Option<PathBuf>,
        /// Absolute OMP CLI path for the bounded analysis worker.
        #[arg(long)]
        omp_executable: Option<PathBuf>,
        /// Fixed minimax-code provider/model, required with --omp-executable.
        #[arg(long)]
        omp_model: Option<String>,
        #[arg(long, default_value = "launchd")]
        platform: String,
        #[arg(long, default_value_t = 62062)]
        port: u16,
        #[arg(long, default_value = "mock")]
        model: String,
        #[arg(long)]
        headless: bool,
    },
    /// Run the persistent Ghost host (headless unless workspace UI support is built).
    #[cfg(feature = "host")]
    Serve {
        #[arg(long, default_value_t = 0)]
        port: u16,
        #[arg(long)]
        model: Option<String>,
        /// Run the authenticated local control API without serving browser assets.
        #[arg(long)]
        headless: bool,
    },
    /// Control a running host without opening its profile databases.
    #[cfg(feature = "host")]
    Control {
        #[command(subcommand)]
        c: ControlCmd,
    },
    /// Owner-approved daily wake schedules and briefings (G06).
    #[cfg(feature = "host")]
    Wake {
        #[command(subcommand)]
        c: WakeCmd,
    },
    /// Owner-configured incident responsibility binding (G10 intake).
    #[cfg(feature = "host")]
    Incident {
        #[command(subcommand)]
        c: IncidentCmd,
    },
    /// Scoped per-Ghost skill store: pin, update, recover, improve (G11 path).
    #[cfg(feature = "host")]
    Skill {
        #[command(subcommand)]
        c: SkillCmd,
    },
    /// Durable conversations, checkpoints, compaction and child tasks.
    #[cfg(feature = "durable-runtime")]
    Conversation {
        #[command(subcommand)]
        c: ConversationCmd,
    },
    /// Temporary loopback UI; MockProvider/local fixtures only, no auto-open.
    #[cfg(all(feature = "ui-fixtures", unix))]
    UiFixture {
        #[arg(long)]
        browser_pin: PathBuf,
        #[arg(long, default_value_t = 180)]
        seconds: u64,
    },
    /// Profile (ghost identity) management
    Profile {
        #[command(subcommand)]
        c: ProfileCmd,
    },
    /// Session management within a profile
    Session {
        #[command(subcommand)]
        c: SessionCmd,
    },
    /// Task/inbox submission and status
    Task {
        #[command(subcommand)]
        c: TaskCmd,
    },
    /// Run the persistent headless host. A profile selects the legacy one-pass runner.
    Run {
        /// Legacy profile to drain once; omit to run the persistent host.
        profile: Option<String>,
        #[arg(long, requires = "profile")]
        provider: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Serve the bundled browser UI (requires a workspace-ui build).
        #[arg(long)]
        ui: bool,
    },
    /// List outbox records
    Outbox { profile: String },
    /// Capability grants (default: everything denied)
    Policy {
        #[command(subcommand)]
        c: PolicyCmd,
    },
    /// Durable computer registry operator surface (same ledger as the Host).
    #[cfg(all(feature = "lifetime", unix))]
    Computers {
        #[command(subcommand)]
        c: ComputersCmd,
    },
    /// Explicit restored-authority acceptance; dispatch stays off until this.
    #[cfg(all(feature = "lifetime", unix))]
    Lifetime {
        #[command(subcommand)]
        c: LifetimeCmd,
    },
    /// Multi-ghost delegation workflows (management app over Ghosts)
    Ghosts {
        #[command(subcommand)]
        c: GhostsCmd,
    },
}

#[cfg(all(feature = "lifetime", unix))]
#[derive(Subcommand)]
enum ComputersCmd {
    /// Inspect one computer's durable binding, leases, and browser service.
    Inspect {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
    },
    /// List every computer registered to this Ghost.
    List {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
    },
    /// Attach the owned browser gate to the current computer binding.
    AttachBrowser {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
    },
    /// Detach the owned browser gate; live browser writers are fenced.
    DetachBrowser {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
        #[arg(long)]
        expected_revision: u64,
    },
    /// Accept the currently probed runtime for this binding epoch.
    AcceptRuntime {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
        #[arg(long)]
        runtime_kind: String,
    },
    /// Explicit epoch-safe rebind after revoke or restore; advances one epoch.
    Rebind {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
    },
    /// Authorize (without executing) an idle stop of the accepted runtime.
    IdleStop {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
    },
    /// Authorize (without executing) a recreate of the accepted runtime.
    Recreate {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
    },
    /// Reconcile one unknown lifecycle attempt with a verified outcome.
    ResolveLifecycle {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        attempt: String,
        #[arg(long)]
        resolution: String,
        #[arg(long)]
        by: String,
    },
    /// Move every legacy original in a computer's home root into its private
    /// privacy lane (public keeps only public-classified state). Requires the
    /// worker stopped with no active or revoked home lease and --confirm.
    MigrateHome {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
        #[arg(long, default_value_t = false)]
        confirm: bool,
    },
    /// Reset a sticky-private public profile to fresh and clean.
    ResetPublicProfile {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        computer: String,
    },
    /// Run one operator browser action against the owned persistent profile.
    BrowserOp {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        ghost: String,
        #[arg(long)]
        operation: String,
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        value: Option<String>,
        #[arg(long)]
        snapshot_id: Option<u64>,
        #[arg(long)]
        reference: Option<String>,
    },
}

#[cfg(all(feature = "lifetime", unix))]
#[derive(Subcommand)]
enum LifetimeCmd {
    /// Fence a stopped Host before a manual cross-host handoff. Workers must be fenced separately.
    Fence {
        #[arg(long)]
        host_root: PathBuf,
        #[arg(long)]
        expected_epoch: u64,
        #[arg(long)]
        operation_id: String,
        #[arg(long, default_value_t = false)]
        confirm: bool,
    },
    /// Re-enable dispatch after restore + explicit rebinds; requires --confirm.
    Accept {
        #[arg(long)]
        host_root: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long, default_value_t = false)]
        confirm: bool,
    },
}

#[cfg(all(feature = "lifetime", unix))]
#[derive(Subcommand)]
enum RecoveryCmd {
    /// Capture an explicit complete inventory whose owners are already stopped.
    Create {
        #[arg(long)]
        request: PathBuf,
        #[arg(long)]
        destination: PathBuf,
    },
    /// Verify exact file inventory, digests and SQLite integrity.
    Verify {
        #[arg(long)]
        bundle: PathBuf,
    },
    /// Restore to a new root, advance authority, and keep dispatch disabled.
    Restore {
        #[arg(long)]
        bundle: PathBuf,
        #[arg(long)]
        destination: PathBuf,
    },
}

#[cfg(all(feature = "lifetime", unix))]
#[derive(Subcommand)]
enum ReleaseCmd {
    /// Capture the nine selected components using caller-pinned provenance.
    Create {
        #[arg(long)]
        request: PathBuf,
        #[arg(long)]
        destination: PathBuf,
    },
    /// Verify all copied bytes against a separately trusted manifest SHA256.
    Verify {
        #[arg(long)]
        package: PathBuf,
        #[arg(long)]
        manifest_sha256: String,
    },
}

#[cfg(all(feature = "lifetime", unix))]
fn read_bundle_request(path: &std::path::Path) -> Result<ghost::operations::recovery_bundle::BundleRequest> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    const MAX_REQUEST_BYTES: u64 = 1_048_576;
    let file = std::fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file() && metadata.len() <= MAX_REQUEST_BYTES,
        "bundle request must be a bounded regular JSON file");
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() as u64 <= MAX_REQUEST_BYTES, "bundle request grew beyond its byte limit");
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(all(feature = "lifetime", unix))]
fn release_command(c: ReleaseCmd) -> Result<()> {
    use ghost::operations::release_package;
    match c {
        ReleaseCmd::Create { request, destination } => {
            let request = read_bundle_request(&request)?;
            emit(&release_package::create_release_package(&request, &destination)?)
        }
        ReleaseCmd::Verify { package, manifest_sha256 } => {
            emit(&release_package::verify_release_package(&package, &manifest_sha256)?)
        }
    }
}

#[cfg(all(feature = "lifetime", unix))]
fn recovery_command(c: RecoveryCmd) -> Result<()> {
    use ghost::operations::recovery_bundle;
    match c {
        RecoveryCmd::Create { request, destination } => {
            let request = read_bundle_request(&request)?;
            emit(&recovery_bundle::create_bundle(&request, &destination)?)
        }
        RecoveryCmd::Verify { bundle } => emit(&recovery_bundle::verify_bundle(&bundle)?),
        RecoveryCmd::Restore { bundle, destination } => emit(&recovery_bundle::restore_bundle(&bundle, &destination)?),
    }
}

#[cfg(all(feature = "lifetime", unix))]
fn operator_envelope(ghost_id: &str, epoch: u64, body: serde_json::Value) -> Result<ghost::lifetime_contract::Envelope> {
    use ghost::lifetime_contract::{canonical_digest, Envelope, VERSION};
    let command_id = uuid::Uuid::new_v4().to_string();
    Ok(Envelope {
        protocol_version: VERSION.into(),
        payload_digest: canonical_digest(&body)?,
        actor_ref: ghost_id.to_owned(),
        authority_epoch: epoch,
        expected_revision: None,
        correlation_id: command_id.clone(),
        command_id,
        body,
    })
}

#[cfg(all(feature = "lifetime", unix))]
fn listed_bindings(
    registry: &mut ghost::computers::ComputerRegistry,
    ghost: &str,
) -> Result<Vec<ghost::lifetime_contract::ComputerBinding>> {
    let response = registry.handle(
        &operator_envelope(ghost, 1, serde_json::json!({"method":"list"}))?, ghost)?;
    anyhow::ensure!(
        !matches!(response.status, ghost::lifetime_contract::ResponseStatus::Error),
        "computer list failed: {}", response.summary
    );
    let views = response.data.get("computers").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    Ok(views.iter().filter_map(|view| view.get("binding").cloned())
        .filter_map(|binding| serde_json::from_value(binding).ok()).collect())
}

#[cfg(all(feature = "lifetime", unix))]
fn binding_epoch(
    registry: &mut ghost::computers::ComputerRegistry,
    ghost: &str,
    computer: &str,
) -> Result<(ghost::lifetime_contract::ComputerBinding, serde_json::Value)> {
    let response = registry.handle(
        &operator_envelope(ghost, 1, serde_json::json!({"method":"list"}))?, ghost)?;
    anyhow::ensure!(
        !matches!(response.status, ghost::lifetime_contract::ResponseStatus::Error),
        "computer list failed: {}", response.summary
    );
    for view in response.data.get("computers").and_then(serde_json::Value::as_array).into_iter().flatten() {
        if view.get("binding").and_then(|binding| binding.get("computer_id")).and_then(serde_json::Value::as_str) == Some(computer) {
            let binding: ghost::lifetime_contract::ComputerBinding = serde_json::from_value(
                view.get("binding").cloned().ok_or_else(|| anyhow::anyhow!("computer view omits binding"))?)?;
            return Ok((binding, view.clone()));
        }
    }
    anyhow::bail!("computer '{computer}' is not registered for this Ghost")
}

#[cfg(all(feature = "lifetime", unix))]
fn operator_rebind_envelope(binding: &ghost::lifetime_contract::ComputerBinding) -> Result<ghost::lifetime_contract::Envelope> {
    let epoch = binding.epoch.checked_add(1).context("binding epoch exhausted")?;
    let grant_revision = binding.grant_revision.checked_add(1).context("grant revision exhausted")?;
    let capabilities = match binding.backend.as_str() {
        "apple-native-omp" => vec!["persistent_filesystem", "shell"],
        other => anyhow::bail!("rebind of backend '{other}' has no operator capability pin"),
    };
    // The mutation is authorized by the current binding; its payload proposes
    // the next binding. Using the proposed epoch fences this very request.
    let mut request = operator_envelope(&binding.ghost_id, binding.epoch, serde_json::json!({
        "method":"bind", "binding": {
            "computer_id":binding.computer_id,"ghost_id":binding.ghost_id,"backend":binding.backend,
            "host_id":binding.host_id,"epoch":epoch,"capabilities":capabilities,
            "accepted_capabilities":capabilities,"grant_revision":grant_revision,
        }
    }))?;
    request.expected_revision = Some(binding.grant_revision);
    Ok(request)
}

#[cfg(all(feature = "lifetime", unix))]
fn operator_accept_runtime_envelope(binding: &ghost::lifetime_contract::ComputerBinding, facts: &ghost::computers::RuntimeFacts,
    declared_kind: &str) -> Result<ghost::lifetime_contract::Envelope> {
    anyhow::ensure!(declared_kind == facts.kind, "declared runtime kind differs from the operator-probed runtime");
    let mut request = operator_envelope(&binding.ghost_id, binding.epoch, serde_json::json!({
        "method":"accept_runtime","computer_id":binding.computer_id,"runtime":facts,
    }))?;
    request.expected_revision = Some(binding.grant_revision);
    Ok(request)
}

#[cfg(all(feature = "lifetime", unix))]
fn computers_command(c: ComputersCmd) -> Result<()> {
    use ghost::computers::ComputerRegistry;
    use ghost::host::lifetime_computers::operator_computers;
    use ghost::lifetime_contract::Response;
    fn request(registry: &mut ComputerRegistry, ghost: &str, epoch: u64, body: serde_json::Value) -> Result<Response> {
        registry.handle(&operator_envelope(ghost, epoch, body)?, ghost)
    }
    fn ensure_success(response: &Response) -> Result<()> {
        use ghost::lifetime_contract::ResponseStatus;
        anyhow::ensure!(!matches!(response.status, ResponseStatus::Error),
            "registry command failed ({}): {}", response.error_code.as_deref().unwrap_or("error"), response.summary);
        Ok(())
    }
    let run = || -> Result<()> {
        match c {
            ComputersCmd::Inspect { config, ghost, computer } => {
                let operator = operator_computers(&config)?;
                let (binding, view) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer)?;
                let _ = binding;
                emit(&view)?;
            }
            ComputersCmd::List { config, ghost } => {
                let operator = operator_computers(&config)?;
                let response = request(&mut operator.registry.lock(), &ghost, 1, serde_json::json!({"method":"list"}))?;
                ensure_success(&response)?;
                emit(&response.data)?;
            }
            ComputersCmd::AttachBrowser { config, ghost, computer } => {
                let operator = operator_computers(&config)?;
                let entry = operator.browser_computers.iter()
                    .find(|entry| entry.ghost_id == ghost && entry.computer_id == computer)
                    .ok_or_else(|| anyhow::anyhow!("configuration has no owned browser computer '{computer}' for this Ghost"))?
                    .clone();
                {
                    let mut registry = operator.registry.lock();
                    let (binding, _) = binding_epoch(&mut registry, &ghost, &computer)?;
                    ghost::host::lifetime_computers::attach_owned_browser(
                        &mut registry, &entry, &binding.host_id, binding.epoch)?;
                }
                let (_, view) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer)?;
                emit(&view)?;
            }
            ComputersCmd::DetachBrowser { config, ghost, computer, expected_revision } => {
                let operator = operator_computers(&config)?;
                let (binding, _) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer)?;
                let response = request(&mut operator.registry.lock(), &ghost, binding.epoch,
                    serde_json::json!({"method":"detach_browser","computer_id":computer,"expected_revision":expected_revision}))?;
                ensure_success(&response)?;
                emit(&response.data)?;
            }
            ComputersCmd::AcceptRuntime { config, ghost, computer, runtime_kind } => {
                let operator = operator_computers(&config)?;
                let (binding, _) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer)?;
                // The declared kind must match the probed registration; the
                // registry cross-checks kind and digest before storing.
                let facts = operator.runtime_facts.get(&binding.backend)
                    .ok_or_else(|| anyhow::anyhow!("computer backend '{}' has no operator runtime probe",binding.backend))?;
                let response = operator.registry.lock().handle(&operator_accept_runtime_envelope(&binding,facts,&runtime_kind)?, &ghost)?;
                ensure_success(&response)?;
                emit(&response.data)?;
            }
            ComputersCmd::Rebind { config, ghost, computer } => {
                let operator = operator_computers(&config)?;
                {
                    let mut registry = operator.registry.lock();
                    let (binding, _) = binding_epoch(&mut registry, &ghost, &computer)?;
                    let response = registry.handle(&operator_rebind_envelope(&binding)?, &ghost)?;
                    ensure_success(&response)?;
                    emit(&response.data)?;
                }
            }
            ref arm @ (ComputersCmd::IdleStop { config: _, ghost: _, computer: _ } | ComputersCmd::Recreate { config: _, ghost: _, computer: _ }) => {
                let (config, ghost, computer) = match arm {
                    ComputersCmd::IdleStop { config, ghost, computer }
                    | ComputersCmd::Recreate { config, ghost, computer } => (config.clone(), ghost.clone(), computer.clone()),
                    _ => unreachable!(),
                };
                let operator = operator_computers(&config)?;
                let (binding, _) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer)?;
                let method = if matches!(arm, ComputersCmd::IdleStop { .. }) { "idle_stop" } else { "recreate" };
                let response = request(&mut operator.registry.lock(), &ghost, binding.epoch,
                    serde_json::json!({"method":method,"computer_id":computer}))?;
                emit(&serde_json::json!({
                    "response": response,
                    "note": "authorization only; execute through the running Host control plane (computer verb idle_stop/recreate) so the owning process performs the effect",
                }))?;
            }
            ComputersCmd::ResolveLifecycle { config, attempt, resolution, by } => {
                let operator = operator_computers(&config)?;
                let resolution_value: serde_json::Value = serde_json::from_str(&resolution)?;
                operator.registry.lock().resolve_lifecycle_attempt(&attempt, resolution_value, &by)?;
                emit(&serde_json::json!({"attempt": attempt, "resolved": true, "by": by}))?;
            }
            ComputersCmd::MigrateHome { config, ghost, computer, confirm } => {
                anyhow::ensure!(
                    confirm,
                    "home migration reclassifies every original in the home root as private; rerun with --confirm"
                );
                let operator = operator_computers(&config)?;
                let (binding, _) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer)?;
                anyhow::ensure!(binding.epoch > 0, "binding epoch is invalid");
                let body = serde_json::json!({"method": "migrate_home", "computer_id": computer});
                let envelope = operator_envelope(&ghost, binding.epoch, body)?;
                let response = operator.registry.lock().migrate_home(&envelope, &ghost)?;
                ensure_success(&response)?;
                anyhow::ensure!(
                    !matches!(response.status, ghost::lifetime_contract::ResponseStatus::Warning),
                    "home migration did not complete: {}",
                    response.summary
                );
                emit(&response.data)?;
            }
            ComputersCmd::ResetPublicProfile { config, ghost, computer } => {
                let operator = operator_computers(&config)?;
                let (binding, _) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer)?;
                anyhow::ensure!(binding.epoch > 0, "binding epoch is invalid");
                operator.registry.lock().reset_public_profile(&computer)?;
                emit(&serde_json::json!({
                    "computer": computer,
                    "public_profile": "fresh and clean; old contents rotated aside as private-tainted",
                }))?;
            }
            ComputersCmd::BrowserOp { config, ghost, operation, url, value, snapshot_id, reference } => {
                let operator = operator_computers(&config)?;
                anyhow::ensure!(!operator.browser_computers.is_empty(), "configuration has no owned browser section");
                let computer = operator.browser_computers.iter()
                    .find(|entry| entry.ghost_id == ghost)
                    .ok_or_else(|| anyhow::anyhow!("this Ghost has no owned browser computer"))?
                    .clone();
                let (binding, _) = binding_epoch(&mut operator.registry.lock(), &ghost, &computer.computer_id)?;
                let epoch = binding.epoch;
                let service = ghost::computers::OwnedBrowserConfig::from_computers(vec![computer.clone()])?;
                let browser = ghost::computers::OwnedBrowser::new(service, operator.registry.clone(), epoch);
                use ghost::adapters::computer::BrowserOperation;
                let browser_operation = match operation.as_str() {
                    "navigate" => BrowserOperation::Navigate { url: url.ok_or_else(|| anyhow::anyhow!("--url is required for navigate"))? },
                    "read" => BrowserOperation::Read,
                    "snapshot" => BrowserOperation::Snapshot,
                    "screenshot" => BrowserOperation::Screenshot,
                    "click" => BrowserOperation::Click {
                        reference: reference.ok_or_else(|| anyhow::anyhow!("--reference is required for click"))?,
                        snapshot_id: snapshot_id.ok_or_else(|| anyhow::anyhow!("--snapshot-id is required for click"))?,
                    },
                    "type" => BrowserOperation::Type {
                        reference: reference.ok_or_else(|| anyhow::anyhow!("--reference is required for type"))?,
                        snapshot_id: snapshot_id.ok_or_else(|| anyhow::anyhow!("--snapshot-id is required for type"))?,
                        text: value.clone().ok_or_else(|| anyhow::anyhow!("--value is required for type"))?,
                    },
                    "key" => BrowserOperation::Key { key: value.clone().ok_or_else(|| anyhow::anyhow!("--value is required for key"))? },
                    "scroll" => BrowserOperation::Scroll { delta_y: value.as_deref().and_then(|v| v.parse().ok()).ok_or_else(|| anyhow::anyhow!("--value must be a number for scroll"))? },
                    other => anyhow::bail!("unsupported operator browser operation '{other}'"),
                };
                let result = tokio::runtime::Builder::new_multi_thread().enable_all().build()?
                    .block_on(async {
                        let outcome = browser.operator_operation(&ghost, browser_operation).await;
                        let _ = browser.idle_stop(&computer.computer_id, &ghost).await;
                        outcome
                    });
                emit(&result?)?;
            }
        }
        Ok(())
    };
    run()
}

#[cfg(all(feature = "lifetime", unix))]
fn lifetime_command(c: LifetimeCmd) -> Result<()> {
    match c {
        LifetimeCmd::Fence { host_root, expected_epoch, operation_id, confirm } => {
            anyhow::ensure!(confirm, "stopped Host fencing requires --confirm");
            emit(&ghost::operations::relocation::fence_stopped_host(&host_root, expected_epoch, &operation_id)?)
        }
        LifetimeCmd::Accept { host_root, config, confirm } => {
            let operator = ghost::host::lifetime_computers::operator_computers(&config)?;
            let database = host_root.join("workspace.db");
            let connection = rusqlite::Connection::open_with_flags(
                &database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
            let (epoch, dispatch): (i64, i64) = connection.query_row(
                "SELECT authority_epoch, dispatch_enabled FROM lifetime_authority WHERE singleton=1",
                [], |row| Ok((row.get(0)?, row.get(1)?)))?;
            anyhow::ensure!(dispatch == 0, "Host dispatch is already enabled");
            anyhow::ensure!(epoch > 0, "Host authority epoch is invalid");
            let offenders = operator.registry.lock().dispatch_ready_computers(epoch as u64)?;
            anyhow::ensure!(offenders.is_empty(),
                "dispatch acceptance refused; rebind and accept runtimes first: {:?}", offenders);
            anyhow::ensure!(confirm,
                "dispatch acceptance is destructive to the old writer epoch; rerun with --confirm to enable epoch {epoch}");
            let changed = connection.execute(
                "UPDATE lifetime_authority SET dispatch_enabled=1 WHERE singleton=1 AND authority_epoch=?1 AND dispatch_enabled=0",
                [epoch])?;
            anyhow::ensure!(changed == 1, "authority row changed during dispatch acceptance");
            emit(&serde_json::json!({
                "authority_epoch": epoch,
                "dispatch_enabled": true,
                "confirmed": true,
            }))
        }
    }
}

#[cfg(feature = "host")]
#[derive(Subcommand)]
enum ControlCmd {
    /// Read the current host snapshot.
    Snapshot,
    /// Read committed events for a profile after the given sequence.
    Events {
        profile_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Submit a typed Action JSON object from a file or stdin.
    Send {
        /// Read JSON from this file; omit or use '-' for stdin.
        #[arg(long)]
        file: Option<PathBuf>,
    },
}

#[cfg(feature = "caldav")]
#[derive(Subcommand)]
enum PlannerGoogleCmd {
    /// Run the installed-app consent flow with PKCE and a loopback redirect,
    /// then store the durable lease for the Host.
    Login {
        /// Stable account label that connected planner collections must match.
        #[arg(long)]
        account: String,
        /// Loopback port for the redirect; 0 picks a free port.
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Include event/task write scopes instead of read-only provisioning.
        #[arg(long, default_value_t = false)]
        write: bool,
        /// Replace an existing store for the same account reference.
        #[arg(long, default_value_t = false)]
        replace: bool,
    },
    /// Report the configured lease without printing any token.
    Status,
    /// Revoke the lease at Google, then remove the store on confirmed success.
    Revoke,
}

#[cfg(feature = "caldav")]
fn planner_google_command(c: PlannerGoogleCmd) -> Result<()> {
    use ghost::adapters::personal_connectors::google_oauth::{self, GoogleScope};
    match c {
        PlannerGoogleCmd::Login {
            account,
            port,
            write,
            replace,
        } => {
            let mut scopes = vec![
                GoogleScope::CalendarEventsReadOnly,
                GoogleScope::TasksReadOnly,
            ];
            if write {
                scopes.push(GoogleScope::CalendarEvents);
                scopes.push(GoogleScope::Tasks);
            }
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let status = runtime.block_on(google_oauth::provision(
                &account,
                &scopes,
                port,
                replace,
            ))?;
            emit(&serde_json::json!({
                "account_ref": status.account_ref,
                "scopes": status.scopes.iter().map(|scope| scope.as_str()).collect::<Vec<_>>(),
                "expires_at": format!("{:?}", status.expires_at),
                "refreshable": status.refreshable,
            }))
        }
        PlannerGoogleCmd::Status => emit(&google_oauth::status()?),
        PlannerGoogleCmd::Revoke => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(google_oauth::revoke())
        }
    }
}

#[cfg(feature = "host")]
#[derive(Subcommand)]
enum WakeCmd {
    /// Approve a daily wake for a Ghost conversation (briefing source).
    Add {
        profile: String,
        #[arg(long)]
        conversation: String,
        /// Local wall-clock fire time, HH:MM in --timezone.
        #[arg(long)]
        time: String,
        #[arg(long, default_value = "Asia/Seoul")]
        timezone: String,
        #[arg(long)]
        prompt: String,
        /// Quiet-hours length in minutes after local midnight.
        #[arg(long)]
        quiet_minutes: Option<u32>,
        /// Missed-occurrence policy: coalesce (default) or skip.
        #[arg(long, default_value = "coalesce")]
        missed_policy: String,
    },
    List { profile: String },
    /// Read-only preview of the next briefing (no model call, no effect).
    Preview {
        profile: String,
        wake_id: String,
        #[arg(long)]
        now_ms: Option<u64>,
    },
    /// Reschedule or pause; resume recomputes the next occurrence from now.
    Update {
        profile: String,
        wake_id: String,
        #[arg(long)]
        time: Option<String>,
        #[arg(long)]
        timezone: Option<String>,
        #[arg(long)]
        quiet_minutes: Option<u32>,
        /// Clear stored quiet hours.
        #[arg(long, default_value_t = false)]
        clear_quiet: bool,
        #[arg(long)]
        missed_policy: Option<String>,
        #[arg(long)]
        paused: Option<bool>,
    },
    /// Cancel the schedule; fired occurrence history is preserved.
    Remove { profile: String, wake_id: String },
}

#[cfg(feature = "host")]
#[derive(Subcommand)]
enum IncidentCmd {
    /// Bind the actual registered lifetime Primary to one exact alerts source.
    /// Never implicit: existing Ghosts keep no binding until this is run.
    Bind {
        profile: String,
        /// Absolute alerts JSON path (e.g. ~/.local/state/infra/infra-alerts.json).
        #[arg(long)]
        source: String,
        /// Severities in scope; repeatable. Default: crit + warn.
        #[arg(long, value_delimiter = ',')]
        severities: Option<Vec<String>>,
        /// Alert-id prefixes in scope; repeatable (e.g. gatus:,beszel:,backup:,git:).
        #[arg(long, value_delimiter = ',')]
        sources: Option<Vec<String>>,
        /// Disclosure level: summary_only (default) or operator.
        #[arg(long, default_value = "summary_only")]
        disclosure: String,
        /// Snapshot freshness bound in seconds (default 180).
        #[arg(long)]
        max_age_seconds: Option<u64>,
        /// CAS version when rebinding an existing binding.
        #[arg(long)]
        version: Option<u64>,
    },
    /// Read-only: binding, delivery runs, collisions.
    List { profile: String },
    /// Read-only: bounded source read and what would fire now (no effect).
    Preview {
        profile: String,
        #[arg(long)]
        now_ms: Option<u64>,
    },
    /// Pause deliveries without removing the binding.
    Pause { profile: String, version: u64 },
    /// Resume deliveries.
    Resume { profile: String, version: u64 },
    /// Remove the binding; run history is preserved.
    Remove { profile: String, version: u64 },
}

#[cfg(feature = "host")]
#[derive(Subcommand)]
enum SkillCmd {
    /// Import a skill (first install).
    Add {
        profile: String,
        name: String,
        #[arg(long)]
        file: PathBuf,
    },
    /// Replace with a new revision; requires the current version.
    Replace {
        profile: String,
        name: String,
        #[arg(long)]
        version: u64,
        #[arg(long)]
        file: PathBuf,
    },
    List { profile: String },
    /// The explicit pinned manifest handed to scoped OMP sessions.
    Manifest { profile: String },
    /// Verify store bytes against the pinned digest; restore the pinned revision.
    Recover { profile: String, name: String },
    Disable { profile: String, name: String },
    Enable { profile: String, name: String },
    Remove {
        profile: String,
        name: String,
        #[arg(long)]
        version: u64,
    },
    /// Record an improvement candidate (never active until promoted).
    Candidate {
        profile: String,
        skill: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long, default_value = "")]
        note: String,
    },
    /// Owner promotion of a draft candidate to the active revision.
    Promote { profile: String, candidate_id: String },
    Reject { profile: String, candidate_id: String },
}

#[cfg(feature = "host")]
fn control_action(root: &std::path::Path, action: ghost::control::api::OwnerAction) -> Result<()> {
    use ghost::control::{api::Action, ControlClient};
    let client = ControlClient::discover(root)?;
    let action = Action {
        request_id: uuid::Uuid::new_v4().to_string(),
        command: ghost::control::api::Command::Workspace { action },
    };
    let reply = client.action(action)?;
    emit(&reply)?;
    if reply["ok"] == false {
        anyhow::bail!("host rejected control action");
    }
    Ok(())
}

#[cfg(feature = "host")]
fn read_skill_file(path: &PathBuf) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    anyhow::ensure!(meta.len() <= 262_144, "skill file exceeds 262144 bytes");
    Ok(std::fs::read_to_string(path)?)
}

#[cfg(feature = "host")]
fn wake_command(root: &std::path::Path, c: WakeCmd) -> Result<()> {
    use ghost::control::api::OwnerAction;
    match c {
        WakeCmd::Add {
            profile,
            conversation,
            time,
            timezone,
            prompt,
            quiet_minutes,
            missed_policy,
        } => control_action(
            root,
            OwnerAction::AddWake {
                profile_id: profile,
                conversation_id: conversation,
                prompt,
                timezone,
                local_time: time,
                quiet_minutes,
                missed_policy,
            },
        ),
        WakeCmd::List { profile } => control_action(root, OwnerAction::WakeList { profile_id: profile }),
        WakeCmd::Preview {
            profile,
            wake_id,
            now_ms,
        } => control_action(
            root,
            OwnerAction::WakePreview {
                profile_id: profile,
                wake_id,
                now_ms,
            },
        ),
        WakeCmd::Update {
            profile,
            wake_id,
            time,
            timezone,
            quiet_minutes,
            clear_quiet,
            missed_policy,
            paused,
        } => control_action(
            root,
            OwnerAction::UpdateWake {
                profile_id: profile,
                wake_id,
                local_time: time,
                timezone,
                quiet_minutes: if clear_quiet { Some(None) } else { quiet_minutes.map(Some) },
                missed_policy,
                paused,
            },
        ),
        WakeCmd::Remove { profile, wake_id } => control_action(
            root,
            OwnerAction::DeleteWake {
                profile_id: profile,
                wake_id,
            },
        ),
    }
}

#[cfg(feature = "host")]
fn incident_command(root: &std::path::Path, c: IncidentCmd) -> Result<()> {
    use ghost::control::api::OwnerAction;
    match c {
        IncidentCmd::Bind {
            profile,
            source,
            severities,
            sources,
            disclosure,
            max_age_seconds,
            version,
        } => control_action(
            root,
            OwnerAction::SaveIncidentBinding {
                profile_id: profile,
                binding: ghost::host::incidents::IncidentInput {
                    source_path: source,
                    severities: severities.unwrap_or_else(|| vec!["crit".into(), "warn".into()]),
                    sources: sources.unwrap_or_else(|| {
                        vec![
                            "gatus:".into(),
                            "beszel:".into(),
                            "backup:".into(),
                            "git:".into(),
                        ]
                    }),
                    disclosure,
                    max_age_seconds,
                    paused: false,
                },
                version,
            },
        ),
        IncidentCmd::List { profile } => {
            control_action(root, OwnerAction::IncidentList { profile_id: profile })
        }
        IncidentCmd::Preview { profile, now_ms } => control_action(
            root,
            OwnerAction::IncidentPreview {
                profile_id: profile,
                now_ms,
            },
        ),
        IncidentCmd::Pause { profile, version } => control_action(
            root,
            OwnerAction::PauseIncidentBinding {
                profile_id: profile,
                paused: true,
                version,
            },
        ),
        IncidentCmd::Resume { profile, version } => control_action(
            root,
            OwnerAction::PauseIncidentBinding {
                profile_id: profile,
                paused: false,
                version,
            },
        ),
        IncidentCmd::Remove { profile, version } => control_action(
            root,
            OwnerAction::DeleteIncidentBinding {
                profile_id: profile,
                version,
            },
        ),
    }
}

#[cfg(feature = "host")]
fn skill_command(root: &std::path::Path, c: SkillCmd) -> Result<()> {
    use ghost::control::api::OwnerAction;
    match c {
        SkillCmd::Add { profile, name, file } => {
            let content = read_skill_file(&file)?;
            control_action(
                root,
                OwnerAction::SaveSkill {
                    profile_id: profile,
                    name,
                    content,
                    version: None,
                },
            )
        }
        SkillCmd::Replace {
            profile,
            name,
            version,
            file,
        } => {
            let content = read_skill_file(&file)?;
            control_action(
                root,
                OwnerAction::SaveSkill {
                    profile_id: profile,
                    name,
                    content,
                    version: Some(version),
                },
            )
        }
        SkillCmd::List { profile } => control_action(root, OwnerAction::SkillList { profile_id: profile }),
        SkillCmd::Manifest { profile } => {
            control_action(root, OwnerAction::SkillManifest { profile_id: profile })
        }
        SkillCmd::Recover { profile, name } => control_action(
            root,
            OwnerAction::SkillRecover {
                profile_id: profile,
                name,
            },
        ),
        SkillCmd::Disable { profile, name } => control_action(
            root,
            OwnerAction::SetSkillStatus {
                profile_id: profile,
                name,
                status: "disabled".into(),
            },
        ),
        SkillCmd::Enable { profile, name } => control_action(
            root,
            OwnerAction::SetSkillStatus {
                profile_id: profile,
                name,
                status: "active".into(),
            },
        ),
        SkillCmd::Remove {
            profile,
            name,
            version,
        } => control_action(
            root,
            OwnerAction::DeleteSkill {
                profile_id: profile,
                name,
                version,
            },
        ),
        SkillCmd::Candidate {
            profile,
            skill,
            file,
            note,
        } => {
            let content = read_skill_file(&file)?;
            control_action(
                root,
                OwnerAction::SaveSkillCandidate {
                    profile_id: profile,
                    skill,
                    content,
                    note,
                },
            )
        }
        SkillCmd::Promote {
            profile,
            candidate_id,
        } => control_action(
            root,
            OwnerAction::PromoteSkillCandidate {
                profile_id: profile,
                candidate_id,
            },
        ),
        SkillCmd::Reject {
            profile,
            candidate_id,
        } => control_action(
            root,
            OwnerAction::RejectSkillCandidate {
                profile_id: profile,
                candidate_id,
            },
        ),
    }
}

#[cfg(feature = "host")]
fn control_command(root: &std::path::Path, c: ControlCmd) -> Result<()> {
    use ghost::control::{api::Action, ControlClient};
    let client = ControlClient::discover(root)?;
    match c {
        ControlCmd::Snapshot => emit(&client.snapshot()?),
        ControlCmd::Events { profile_id, after } => emit(&client.events(&profile_id, after)?),
        ControlCmd::Send { file } => {
            let action: Action = match file {
                Some(path) if path != std::path::Path::new("-") => {
                    serde_json::from_reader(std::fs::File::open(path)?)?
                }
                _ => serde_json::from_reader(std::io::stdin().lock())?,
            };
            let reply = client.action(action)?;
            emit(&reply)?;
            if reply["ok"] == false {
                anyhow::bail!("host rejected control action");
            }
            Ok(())
        }
    }
}

#[cfg(feature = "durable-runtime")]
#[derive(Subcommand)]
enum ConversationCmd {
    Create {
        profile: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        tools: bool,
    },
    List {
        profile: String,
    },
    Status {
        profile: String,
        conversation: String,
    },
    Submit {
        profile: String,
        conversation: String,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        prompt: String,
        #[arg(long, default_value="prompt", value_parser=["prompt","steer","follow-up"])]
        kind: String,
    },
    Run {
        profile: String,
        #[arg(long, default_value_t=256, value_parser=clap::value_parser!(u32).range(1..=10000))]
        steps: u32,
    },
    Cancel {
        profile: String,
        task: String,
    },
    Compact {
        profile: String,
        conversation: String,
        #[arg(long)]
        request_id: String,
    },
    Spawn {
        profile: String,
        parent: String,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        prompt: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        background: bool,
    },
    Reconcile {
        profile: String,
        effect_key: String,
        /// Definitive ToolOutput JSON; records a result without re-executing.
        #[arg(long)]
        result_json: String,
    },
    Events {
        profile: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
}

#[cfg(feature = "durable-runtime")]
fn conversation_command(root: &std::path::Path, c: ConversationCmd) -> Result<()> {
    use ghost::durable::{self as host, durable::InputKind};
    match c {
        ConversationCmd::Create {
            profile,
            model,
            tools,
        } => {
            let store = ProfileStore::open_profile(root, &profile)?;
            let config = host::config(&store, model.as_deref(), tools)?;
            let runtime = host::open(store)?;
            emit(
                &serde_json::json!({"conversation_id":runtime.session.create_conversation(config)?}),
            )
        }
        ConversationCmd::List { profile } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            emit(&runtime.session.snapshot()?.conversations)
        }
        ConversationCmd::Status {
            profile,
            conversation,
        } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            emit(&host::status(&runtime, &conversation)?)
        }
        ConversationCmd::Submit {
            profile,
            conversation,
            request_id,
            prompt,
            kind,
        } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            let kind = match kind.as_str() {
                "steer" => InputKind::Steer,
                "follow-up" => InputKind::FollowUp,
                _ => InputKind::Prompt,
            };
            emit(
                &runtime
                    .session
                    .submit(&conversation, &request_id, kind, &prompt)?,
            )
        }
        ConversationCmd::Run { profile, steps } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            let rt = tokio::runtime::Runtime::new()?;
            emit(&rt.block_on(runtime.drive(steps as usize))?)
        }
        ConversationCmd::Cancel { profile, task } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            runtime.session.cancel(&task)?;
            emit(&runtime.session.snapshot()?.tasks.get(&task))
        }
        ConversationCmd::Compact {
            profile,
            conversation,
            request_id,
        } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            emit(&runtime.session.compact(&conversation, &request_id)?)
        }
        ConversationCmd::Spawn {
            profile,
            parent,
            request_id,
            prompt,
            model,
            background,
        } => {
            let store = ProfileStore::open_profile(root, &profile)?;
            let config = host::config(&store, model.as_deref(), false)?;
            let runtime = host::open(store)?;
            emit(
                &runtime
                    .session
                    .spawn(&parent, &request_id, config, &prompt, background)?,
            )
        }
        ConversationCmd::Reconcile {
            profile,
            effect_key,
            result_json,
        } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            let output = serde_json::from_str(&result_json)?;
            runtime.session.reconcile(&effect_key, output)?;
            emit(&serde_json::json!({"reconciled":effect_key}))
        }
        ConversationCmd::Events { profile, after } => {
            let runtime = host::open(ProfileStore::open_profile(root, &profile)?)?;
            emit(&runtime.session.commits_since(after)?)
        }
    }
}

#[derive(Subcommand)]
enum ProfileCmd {
    Create {
        name: String,
        #[arg(long)]
        persona: Option<String>,
    },
    List,
}

#[derive(Subcommand)]
enum SessionCmd {
    Create { profile: String },
    Status { profile: String, session: String },
}

#[derive(Subcommand)]
enum TaskCmd {
    Submit {
        profile: String,
        session: String,
        #[arg(long = "message-id")]
        message_id: String,
        #[arg(long)]
        prompt: String,
        #[arg(long)]
        read: Option<PathBuf>,
        #[arg(long = "write")]
        write_path: Option<PathBuf>,
        #[arg(long, requires = "write_path")]
        content: Option<String>,
    },
    Status {
        profile: String,
        #[arg(long)]
        task: Option<String>,
    },
    Cancel {
        profile: String,
        task: String,
    },
    /// Read normalized native call receipt (no credential configuration)
    ProviderReceipt {
        profile: String,
        task: String,
    },
}

#[derive(Subcommand)]
enum PolicyCmd {
    Allow {
        profile: String,
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        operation: String,
    },
    Revoke {
        profile: String,
        #[arg(long)]
        grant_id: i64,
    },
    List {
        profile: String,
    },
}

#[derive(Subcommand)]
enum GhostsCmd {
    /// Create (or idempotently replay) a two-worker delegation workflow
    Submit {
        #[arg(long = "request-id")]
        request_id: String,
        #[arg(long)]
        owner: String,
        #[arg(long)]
        title: String,
        #[arg(long = "worker")]
        worker: Vec<String>,
    },
    /// Run one bounded pass of a workflow (MockProvider only in this unit)
    Run { workflow: String },
    /// Read-only durable status snapshot of a workflow
    Status { workflow: String },
    /// Request parent cancellation and propagate it boundedly
    Cancel { workflow: String },
    /// List known workflows from the journal (read-only, lock-free)
    List,
}

fn provider_for(name: &str, model: Option<&str>) -> Result<Box<dyn Provider>> {
    let _ = model;
    match name {
        "mock" => Ok(Box::new(MockProvider)),
        #[cfg(feature = "oxicode-engine")]
        "oxicode" => {
            let model = model.ok_or_else(|| anyhow!("--provider oxicode requires --model"))?;
            Ok(Box::new(OxicodeProvider {
                model_id: model.to_string(),
            }))
        }
        #[cfg(not(feature = "oxicode-engine"))]
        "oxicode" => anyhow::bail!("ghost was built without the 'oxicode-engine' feature"),
        other => anyhow::bail!("unknown provider '{}'", other),
    }
}

fn state_root(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(root) = explicit {
        return Ok(root);
    }
    if let Some(root) = std::env::var_os("GHOST_ROOT").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow!("set --root or GHOST_ROOT; LOCALAPPDATA is unavailable"))?;
        Ok(PathBuf::from(base).join("Ghost"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(not(target_os = "macos"))]
        if let Some(base) = std::env::var_os("XDG_STATE_HOME").filter(|value| !value.is_empty()) {
            return Ok(PathBuf::from(base).join("ghost"));
        }
        let home = std::env::var_os("HOME")
            .ok_or_else(|| anyhow!("set --root or GHOST_ROOT; HOME is unavailable"))?;
        #[cfg(target_os = "macos")]
        let suffix = "Library/Application Support/Ghost";
        #[cfg(not(target_os = "macos"))]
        let suffix = ".local/state/ghost";
        Ok(PathBuf::from(home).join(suffix))
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let resolved_root = state_root(cli.root)?;
    let root = &resolved_root;
    match cli.cmd {
        #[cfg(feature = "host")]
        Cmd::Doctor { model } => emit(&ghost::durable::GhostProviders::new().preflight(&model)?),
        #[cfg(feature = "host")]
        Cmd::Restore { backup } => emit(&ghost::host::operations::restore(&backup, root)?),
        #[cfg(feature = "host")]
        Cmd::ServiceSpec {
            output,
            oxibrowser_executable,
            omp_executable,
            omp_model,
            platform,
            port,
            model,
            headless,
        } => {
            let root = root.canonicalize()?;
            let spec = ghost::host::operations::service_spec_with_tools(
                &root,
                &std::env::current_exe()?,
                port,
                &model,
                &platform,
                headless,
                oxibrowser_executable.as_deref(),
                omp_executable.as_deref(),
                omp_model.as_deref(),
            )?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)?;
            file.write_all(spec.as_bytes())?;
            file.sync_all()?;
            emit(&serde_json::json!({"path":output,"installed":false}))
        }
        #[cfg(feature = "host")]
        Cmd::Serve {
            port,
            model,
            headless,
        } => ghost::control::serve(
            root,
            port,
            model.as_deref(),
            !headless && cfg!(feature = "workspace-ui"),
        ),
        #[cfg(feature = "host")]
        Cmd::Control { c } => control_command(root, c),
        #[cfg(feature = "host")]
        Cmd::Wake { c } => wake_command(root, c),
        #[cfg(feature = "host")]
        Cmd::Incident { c } => incident_command(root, c),
        #[cfg(feature = "host")]
        Cmd::Skill { c } => skill_command(root, c),
        #[cfg(feature = "caldav")]
        Cmd::PlannerGoogle { c } => planner_google_command(c),
        #[cfg(all(feature = "lifetime", unix))]
        Cmd::WorkerServe => ghost::worker_server::serve(root),
        #[cfg(all(feature = "lifetime", unix))]
        Cmd::Recovery { c } => recovery_command(c),
        #[cfg(all(feature = "lifetime", unix))]
        Cmd::Release { c } => release_command(c),
        #[cfg(all(feature = "lifetime", unix))]
        Cmd::Computers { c } => computers_command(c),
        #[cfg(all(feature = "lifetime", unix))]
        Cmd::Lifetime { c } => lifetime_command(c),
        #[cfg(feature = "durable-runtime")]
        Cmd::Conversation { c } => conversation_command(root, c),
        #[cfg(all(feature = "ui-fixtures", unix))]
        Cmd::UiFixture {
            browser_pin,
            seconds,
        } => ghost::ui::serve_fixture(root, &browser_pin, seconds),
        Cmd::Profile { c } => match c {
            ProfileCmd::Create { name, persona } => {
                let s =
                    ProfileStore::create_profile(root, &name, persona.as_deref().unwrap_or(""))?;
                emit(&serde_json::json!({"name": s.name, "uuid": s.uuid, "persona": s.persona}))
            }
            ProfileCmd::List => emit(&store::list_profiles(root)?),
        },
        Cmd::Session { c } => match c {
            SessionCmd::Create { profile } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                emit(&s.create_session()?)
            }
            SessionCmd::Status { profile, session } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                match s.session(&session)? {
                    Some(sess) => emit(&sess),
                    None => anyhow::bail!("session not found"),
                }
            }
        },
        Cmd::Task { c } => match c {
            TaskCmd::Submit {
                profile,
                session,
                message_id,
                prompt,
                read,
                write_path,
                content,
            } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                let (task, created) = s.submit(
                    &session,
                    &message_id,
                    &prompt,
                    read.as_ref().map(|p| p.to_string_lossy()).as_deref(),
                    write_path.as_ref().map(|p| p.to_string_lossy()).as_deref(),
                    content.as_deref(),
                )?;
                emit(&serde_json::json!({"task": task, "created": created}))
            }
            TaskCmd::Status { profile, task } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                match task {
                    Some(id) => match s.task(&id)? {
                        Some(t) => emit(&t),
                        None => anyhow::bail!("task not found"),
                    },
                    None => emit(&s.tasks()?),
                }
            }
            TaskCmd::ProviderReceipt { profile, task } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                let t = s.task(&task)?.ok_or_else(|| anyhow!("task not found"))?;
                emit(&ghost::provider_journal::receipt(&s, &t.uuid)?)
            }
            TaskCmd::Cancel { profile, task } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                emit(&s.cancel(&task)?)
            }
        },
        Cmd::Run {
            profile,
            provider,
            model,
            port,
            ui,
        } => {
            if let Some(profile) = profile {
                if port != 0 || ui {
                    anyhow::bail!("--port and --ui are host options; omit the legacy profile");
                }
                let s = ProfileStore::open_profile(root, &profile)?;
                let p = provider_for(provider.as_deref().unwrap_or("mock"), model.as_deref())?;
                emit(&run_cycle(&s, p.as_ref())?)
            } else {
                #[cfg(feature = "host")]
                {
                    if ui && !cfg!(feature = "workspace-ui") {
                        anyhow::bail!(
                            "this binary has no bundled UI; use ghost run for the headless host"
                        );
                    }
                    ghost::control::serve(root, port, model.as_deref(), ui)
                }
                #[cfg(not(feature = "host"))]
                {
                    anyhow::bail!("ghost run requires a host-enabled binary; the legacy runner requires a profile")
                }
            }
        }
        Cmd::Outbox { profile } => {
            let s = ProfileStore::open_profile(root, &profile)?;
            emit(&s.outbox()?)
        }
        Cmd::Policy { c } => match c {
            PolicyCmd::Allow {
                profile,
                path,
                operation,
            } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                emit(&s.allow(&path, &operation)?)
            }
            PolicyCmd::Revoke { profile, grant_id } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                emit(&s.revoke(grant_id)?)
            }
            PolicyCmd::List { profile } => {
                let s = ProfileStore::open_profile(root, &profile)?;
                emit(&s.grants()?)
            }
        },
        Cmd::Ghosts { c } => match c {
            GhostsCmd::Submit {
                request_id,
                owner,
                title,
                worker,
            } => {
                if worker.len() != 2 {
                    anyhow::bail!("exactly two --worker profile:role assignments required");
                }
                let mut workers = Vec::new();
                for w in &worker {
                    let (p, r) = w
                        .split_once(':')
                        .ok_or_else(|| anyhow!("worker must be given as profile:role"))?;
                    workers.push(WorkerSpec {
                        profile: p.to_string(),
                        role: r.to_string(),
                    });
                }
                let spec = ParentSpec {
                    request_id,
                    owner_profile: owner,
                    title,
                    workers,
                };
                let coord = Coordinator::open(root)?;
                let uuid = coord.create(&spec)?;
                emit(&serde_json::json!({"workflow": uuid, "status": "pending"}))
            }
            GhostsCmd::Run { workflow } => {
                let coord = Coordinator::open(root)?;
                emit(&coord.run(&workflow, &MockProvider)?)
            }
            GhostsCmd::Status { workflow } => emit(&collaboration::snapshot(root, &workflow)?),
            GhostsCmd::Cancel { workflow } => {
                let coord = Coordinator::open(root)?;
                emit(&coord.cancel(&workflow)?)
            }
            GhostsCmd::List => {
                // Read-only, lock-free listing: no coordinator open, no writer
                // lock, no journal creation.
                emit(&collaboration::list(root)?)
            }
        },
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ghost: {:#}", e);
            ExitCode::FAILURE
        }
    }
}

#[cfg(all(test, feature = "lifetime", unix))]
mod operator_tests {
    use super::*;
    use ghost::{computers::{ComputerRegistry, NativeWorkerBackendFacts, RuntimeFacts}, lifetime_contract::{ComputerBinding, ResponseStatus}};
    #[test]
    fn operator_rebind_advances_an_actual_registry_and_rejects_stale_replay() {
        let root = tempfile::tempdir().unwrap();
        let mut registry = ComputerRegistry::open(root.path()).unwrap();
        let runtime = RuntimeFacts::new("apple-container","a".repeat(64)).unwrap();
        let capabilities = vec!["persistent_filesystem".into(), "shell".into()];
        registry.register_native_worker_backend_with_runtime(
            NativeWorkerBackendFacts { configured:true, available:true }, capabilities.clone(), Some(runtime.clone())).unwrap();
        let binding = ComputerBinding { computer_id:"operator-rebind".into(), ghost_id:uuid::Uuid::new_v4().to_string(),
            backend:"apple-native-omp".into(),host_id:uuid::Uuid::new_v4().to_string(),epoch:1,
            capabilities:capabilities.clone(),accepted_capabilities:capabilities,grant_revision:1 };
        let initial = operator_envelope(&binding.ghost_id,1,serde_json::json!({"method":"bind","binding":binding})).unwrap();
        assert_eq!(registry.handle(&initial,&binding.ghost_id).unwrap().status,ResponseStatus::Success);
        let request = operator_rebind_envelope(&binding).unwrap();
        let result = registry.handle(&request,&binding.ghost_id).unwrap();
        assert_eq!(result.status,ResponseStatus::Success,"{result:?}");
        assert_eq!(result.data["binding"]["epoch"],2);
        assert_eq!(result.data["binding"]["grant_revision"],2);
        let current: ComputerBinding = serde_json::from_value(result.data["binding"].clone()).unwrap();
        assert!(!registry.dispatch_ready_computers(2).unwrap().is_empty());
        let acceptance = operator_accept_runtime_envelope(&current,&runtime,"apple-container").unwrap();
        assert_eq!(registry.handle(&acceptance,&binding.ghost_id).unwrap().status,ResponseStatus::Success);
        assert!(registry.dispatch_ready_computers(2).unwrap().is_empty());
        assert!(operator_accept_runtime_envelope(&current,&runtime,"other-runtime").is_err());
        let forged = RuntimeFacts::new("apple-container","b".repeat(64)).unwrap();
        let mismatch = operator_accept_runtime_envelope(&current,&forged,"apple-container").unwrap();
        assert_eq!(registry.handle(&mismatch,&binding.ghost_id).unwrap().error_code.as_deref(),Some("runtime_mismatch"));
        let stale = registry.handle(&operator_rebind_envelope(&binding).unwrap(),&binding.ghost_id).unwrap();
        assert_eq!(stale.error_code.as_deref(),Some("stale_epoch"));
    }
}
