use anyhow::{anyhow, Result};
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
#[command(name = "ghost", version, about = "Persistent personal agents and task control")]
struct Cli {
    /// State directory (GHOST_ROOT or the user's application state directory).
    #[arg(long, global = true)]
    root: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Check model resolution and provider construction without a paid call.
    #[cfg(feature = "host")]
    Doctor {
        #[arg(long, default_value = "mock")]
        model: String,
    },
    /// Restore a verified backup to this new root. Existing roots are refused.
    #[cfg(feature = "host")]
    Restore { backup: PathBuf },
    /// Write a supervisor configuration for review, without installing it.
    #[cfg(feature = "host")]
    ServiceSpec {
        #[arg(long)]
        output: PathBuf,
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
    /// Multi-ghost delegation workflows (management app over Ghosts)
    Ghosts {
        #[command(subcommand)]
        c: GhostsCmd,
    },
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
            platform,
            port,
            model,
            headless,
        } => {
            let root = root.canonicalize()?;
            let spec = ghost::host::operations::service_spec(
                &root,
                &std::env::current_exe()?,
                port,
                &model,
                &platform,
                headless,
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
                        anyhow::bail!("this binary has no bundled UI; use ghost run for the headless host");
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
