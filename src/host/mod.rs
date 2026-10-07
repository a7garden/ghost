//! Long-lived Ghost host. Owns profile runtimes, durable command receipts, goals,
//! schedules and policy independently of any UI, transport or optional adapter.
mod actions;
pub mod avatars;
pub mod integrations;
pub mod models;
pub mod operations;
pub mod planner;
#[cfg(feature = "caldav")]
pub mod planner_sync;
mod protocol;
pub mod routing_dispatch;
pub mod routing_host;
pub mod routing_model;
mod scheduler;
pub mod voice;
pub mod work_routing;
pub(crate) use protocol::cancel_delegation;
pub(crate) mod services;
use crate::{
    adapters::{channels, computer, documents, memory},
    control::api::{Action, Command, OwnerAction},
    domain::{Delegation, Goal, Policy, Review, Spend},
    durable::{
        self as host,
        durable::{ai, EntryKind, InputKind, Phase, Runtime, TaskKind, ToolOutput, ToolStatus},
    },
    store::{self, ProfileStore},
};
use anyhow::{anyhow, bail, Result};
use fs2::FileExt;
use scheduler::{Journal, Schedule};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
pub(crate) fn text(value: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > limit {
        bail!("text is empty or exceeds its size limit");
    }
    Ok(())
}
pub(crate) struct Profile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) persona: String,
    pub(crate) runtime: Runtime,
    pub(crate) host: Arc<host::GhostHost>,
    pub(crate) error: Option<String>,
}
pub(crate) struct State {
    pub(crate) profiles: BTreeMap<String, Profile>,
    pub(crate) journal: Journal,
}
pub struct Host {
    pub(crate) root: PathBuf,
    pub(crate) state: Mutex<State>,
    pub(crate) handle: tokio::runtime::Handle,
    pub(crate) default_model: String,
    _lock: File,
    pub(crate) brain: memory::Brain,
    computer: Arc<dyn computer::ComputerBackend>,
    integrations: integrations::Connections,
    workers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    profile_workers: Mutex<BTreeMap<String, Vec<tokio::task::AbortHandle>>>,
    recovery: tokio::sync::Mutex<()>,
    stopping: AtomicBool,
}
impl Host {
    pub fn open(
        root: &Path,
        handle: tokio::runtime::Handle,
        model: Option<&str>,
    ) -> Result<Arc<Self>> {
        Self::open_with_backend(root, handle, model, computer::default_backend())
    }

    /// Supply an isolated computer implementation without changing the host runtime.
    pub fn open_with_backend(
        root: &Path,
        handle: tokio::runtime::Handle,
        model: Option<&str>,
        computer: Arc<dyn computer::ComputerBackend>,
    ) -> Result<Arc<Self>> {
        if root.is_symlink() {
            bail!("workspace root must not be a symlink");
        }
        std::fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        let lock_path = root.join("workspace.lock");
        if lock_path.is_symlink() {
            bail!("workspace lock must not be a symlink");
        }
        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock_exclusive()
            .map_err(|_| anyhow!("workspace is already served by another process"))?;
        let mut profiles = BTreeMap::new();
        for name in store::list_profiles(&root)? {
            let p = Self::profile(ProfileStore::open_profile(&root, &name)?)?;
            profiles.insert(p.id.clone(), p);
        }
        let journal = Journal::open(&root.join("workspace.db"))?;
        if journal.get::<String>("meta", "workspace_id")?.is_none() {
            journal.put("meta", "workspace_id", &uuid::Uuid::now_v7().to_string())?;
        }
        let this = Arc::new(Self {
            root,
            state: Mutex::new(State { profiles, journal }),
            handle,
            default_model: model.unwrap_or("mock").into(),
            _lock: lock,
            brain: memory::Brain::default(),
            computer,
            integrations: integrations::Connections::default(),
            workers: Mutex::new(Vec::new()),
            profile_workers: Mutex::new(BTreeMap::new()),
            recovery: tokio::sync::Mutex::new(()),
            stopping: AtomicBool::new(false),
        });
        let runtimes = this
            .lock()?
            .profiles
            .values()
            .map(|p| (p.id.clone(), p.runtime.clone()))
            .collect::<Vec<_>>();
        for (id, runtime) in runtimes {
            this.lock()?.profiles[&id]
                .host
                .install_services(Arc::new(services::Bridge {
                    owner: id.clone(),
                    host: Arc::downgrade(&this),
                }))?;
            this.lock()?.profiles[&id]
                .host
                .install_file_fence(Arc::new(services::Bridge {
                    owner: id.clone(),
                    host: Arc::downgrade(&this),
                }))?;
            let concurrency = this
                .lock()?
                .journal
                .get::<Policy>("policy", &id)?
                .unwrap_or_default()
                .concurrency;
            this.start_worker(id, runtime, concurrency);
        }
        #[cfg(not(test))]
        {
            let weak = Arc::downgrade(&this);
            this.spawn(async move {
                loop {
                    let Some(app) = weak.upgrade() else {
                        break;
                    };
                    if app.stopping.load(Ordering::Acquire) {
                        break;
                    }
                    if let Err(error) = routing_dispatch::pump(&app) {
                        if let Ok(s) = app.lock() {
                            let _ = s.journal.put(
                                "routing_dispatch_error_v1",
                                "current",
                                &json!({"error":error.to_string(),"updated_ms":now_ms()}),
                            );
                        }
                    }
                    drop(app);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            });
        }
        // Unit fixtures dispatch adapters explicitly to anonymous loopback
        // endpoints; they must not start account-connected background adapters.
        #[cfg(not(test))]
        for worker in channels::start(&this) {
            this.track(worker);
        }
        Ok(this)
    }
    pub(crate) fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| anyhow!("workspace state unavailable"))
    }
    fn profile(store: ProfileStore) -> Result<Profile> {
        let id = store.uuid.clone();
        let name = store.name.clone();
        let persona = store.persona.clone();
        let (runtime, host) = host::open_with_host(store)?;
        Ok(Profile {
            id,
            name,
            persona,
            runtime,
            host,
            error: None,
        })
    }
    fn start_worker(self: &Arc<Self>, id: String, runtime: Runtime, concurrency: usize) {
        let weak = Arc::downgrade(self);
        let runner_weak = weak.clone();
        let runner_id = id.clone();
        let profile_id = id.clone();
        let runner = self.spawn(async move {
            if runtime.serve(concurrency).await.is_err() {
                if let Some(app) = runner_weak.upgrade() {
                    if let Ok(mut s) = app.lock() {
                        if let Some(p) = s.profiles.get_mut(&runner_id) {
                            p.error = Some(
                                "저장소 실행이 중단되었습니다. 복구하거나 서버를 다시 시작하세요."
                                    .into(),
                            );
                        }
                    }
                }
            }
        });
        let scheduler = self.spawn(async move {
            loop {
                let Some(app)=weak.upgrade() else { break; };
                let scheduled=app.dispatch_due(&id,now_ms());
                drop(app);
                let result=scheduled;
                if result.is_err() {
                    if let Some(app)=weak.upgrade() {
                        if let Ok(mut s)=app.lock() { if let Some(p)=s.profiles.get_mut(&id) { p.error=Some("작업 실행을 중단했습니다. 저장소와 모델 설정을 확인한 뒤 서버를 다시 시작하세요.".into()); } }
                    }
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        });
        self.profile_workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(profile_id, vec![runner, scheduler]);
    }
    fn dispatch_due(&self, id: &str, now: u64) -> Result<()> {
        let s = self.lock()?;
        let p = s
            .profiles
            .get(id)
            .ok_or_else(|| anyhow!("profile missing"))?;
        for schedule in s
            .journal
            .list()?
            .into_iter()
            .filter(|x| x.profile_id == id && !x.paused && x.next_run_ms <= now)
        {
            let snapshot = p.runtime.session.committed()?;
            if !snapshot
                .conversations
                .contains_key(&schedule.conversation_id)
            {
                s.journal.put(
                    "schedule_error",
                    &schedule.id,
                    &json!({"id":schedule.id,"error":"scheduled conversation missing"}),
                )?;
                continue;
            }
            if snapshot.tasks.values().any(|t| {
                t.conversation_id == schedule.conversation_id
                    && (!t.phase.terminal() || t.phase == Phase::Uncertain)
            }) {
                continue;
            }
            let request = format!("schedule:{}:{}", schedule.id, schedule.next_run_ms);
            if let Err(error) =
                models::prepare_conversation(&s, id, &schedule.conversation_id, InputKind::FollowUp)
            {
                s.journal.put(
                    "schedule_error",
                    &schedule.id,
                    &json!({"id":schedule.id,"error":error.to_string()}),
                )?;
                continue;
            }
            let submission = p.runtime.session.submit(
                &schedule.conversation_id,
                &request,
                InputKind::FollowUp,
                &schedule.prompt,
            )?;
            s.journal.delivered(&schedule, &submission.task_id, now)?;
        }
        self.dispatch_goals(&s, id)?;
        protocol::project(&s, id)?;
        for mut record in s
            .journal
            .objects::<Delegation>("delegation")?
            .into_iter()
            .filter(|d| d.owner == id && !d.background)
        {
            if record.task_id.is_empty() {
                if let Some(target) = s.profiles.get(&record.target) {
                    if let Some(input) =
                        target
                            .runtime
                            .session
                            .snapshot()?
                            .submissions
                            .iter()
                            .find(|input| {
                                input.request_id == record.id
                                    && input.conversation_id == record.conversation_id
                            })
                    {
                        record.task_id = input.task_id.clone();
                        record.state = "running".into();
                        s.journal.put("delegation", &record.id, &record)?;
                    }
                }
            }
            let snapshot = p.runtime.session.committed()?;
            if snapshot.tasks.get(&record.owner_task).is_none_or(|t| {
                matches!(t.phase, Phase::Cancelled | Phase::Failed | Phase::Uncertain)
                    || t.phase == Phase::Complete
                        && s.profiles
                            .get(&record.target)
                            .and_then(|target| target.runtime.session.committed().ok())
                            .is_some_and(|snapshot| {
                                snapshot
                                    .tasks
                                    .get(&record.task_id)
                                    .is_none_or(|target| !target.phase.terminal())
                            })
            }) {
                s.journal.message(
                    &record,
                    "source_cancel",
                    crate::domain::protocol::Event::CancelRequested {
                        reason: "Owned source cancelled or ended without a settled result".into(),
                    },
                )?;
                cancel_delegation(&s, &mut record)?;
                if snapshot
                    .effects
                    .get(&record.id)
                    .is_some_and(|e| e.phase == Phase::Uncertain)
                {
                    p.runtime.session.reconcile(
                        &record.id,
                        ToolOutput::error(
                            ToolStatus::Denied,
                            "Owned delegation stopped; inspect the specialist's retained receipts",
                        ),
                    )?;
                }
            }
        }
        for mut review in s
            .journal
            .objects::<Review>("review")?
            .into_iter()
            .filter(|r| r.profile_id == id && r.state == "pending")
        {
            let snapshot = p.runtime.session.committed()?;
            if snapshot
                .tasks
                .get(&review.task_id)
                .is_none_or(|t| t.phase.terminal())
                || review.expires_ms <= now
            {
                review.state = if review.expires_ms <= now {
                    "expired"
                } else {
                    "cancelled"
                }
                .into();
                s.journal.put("review", &review.id, &review)?;
                if snapshot
                    .effects
                    .get(&review.id)
                    .is_some_and(|e| e.phase == Phase::Uncertain)
                {
                    p.runtime.session.reconcile(
                        &review.id,
                        ToolOutput::error(
                            ToolStatus::Denied,
                            "Owner review cancelled before approval; no document was saved",
                        ),
                    )?;
                }
            }
        }
        Ok(())
    }
    fn dispatch_goals(&self, s: &State, id: &str) -> Result<()> {
        let goals: Vec<Goal> = s.journal.objects("goal")?;
        let p = s.profiles.get(id).ok_or_else(|| anyhow!("Ghost missing"))?;
        for mut goal in goals.iter().filter(|g| g.profile_id == id).cloned() {
            if goal.state == "running" {
                if let Some(task) = goal
                    .task_id
                    .as_ref()
                    .and_then(|tid| p.runtime.session.snapshot().ok()?.tasks.get(tid).cloned())
                    .filter(|t| t.phase.terminal())
                {
                    goal.state = if task.phase == Phase::Complete {
                        "review"
                    } else {
                        "failed"
                    }
                    .into();
                    goal.note = task.output.unwrap_or_else(|| format!("{:?}", task.phase));
                    goal.evidence.push(format!("task:{}", task.id));
                    s.journal.put("goal", &goal.id, &goal)?;
                }
                continue;
            }
            if !matches!(goal.state.as_str(), "ready" | "starting")
                || goal
                    .dependencies
                    .iter()
                    .any(|dep| !goals.iter().any(|g| g.id == *dep && g.state == "complete"))
            {
                continue;
            }
            if goal.state == "ready" {
                if let Some(name) = &goal.event {
                    let mut events = s
                        .journal
                        .objects::<Value>("event")?
                        .into_iter()
                        .filter(|e| {
                            e["profile_id"] == id
                                && e["name"] == *name
                                && e["created_ms"].as_u64().is_some_and(|time| {
                                    time >= goal.created_ms && time > goal.last_event_ms
                                })
                        })
                        .collect::<Vec<_>>();
                    events.sort_by_key(|e| e["created_ms"].as_u64());
                    let Some(event) = events.first() else {
                        continue;
                    };
                    goal.last_event_ms = event["created_ms"].as_u64().unwrap_or(0);
                }
            }
            let key = format!("goal:{}:{}", goal.id, goal.run);
            let config = if let Some(config) = s
                .journal
                .get::<host::durable::AgentConfig>("goal_config", &key)?
            {
                config
            } else {
                let policy: Policy = s.journal.get("policy", id)?.unwrap_or_default();
                let store = p
                    .host
                    .store
                    .lock()
                    .map_err(|_| anyhow!("profile unavailable"))?;
                let mut config = host::config(
                    &store,
                    Some(
                        policy
                            .model
                            .as_deref()
                            .unwrap_or(&models::selected_llm(s, &self.default_model)?),
                    ),
                    true,
                )?;
                config.tools.extend(services::tool_definitions(self));
                s.journal.put("goal_config", &key, &config)?;
                config
            };
            goal.state = "starting".into();
            s.journal.put("goal", &goal.id, &goal)?;
            let conversation =
                uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, key.as_bytes()).to_string();
            p.runtime
                .session
                .create_conversation_with_id(&conversation, config)?;
            let prompt=format!("Responsibility {}: {}\nOwner verification criteria: {}\nInstruction: {}\nReport progress and evidence with report_goal. The owner verifies completion.",goal.id,goal.title,goal.criteria,goal.instruction);
            let submitted =
                p.runtime
                    .session
                    .submit(&conversation, &key, InputKind::Prompt, &prompt)?;
            goal.task_id = Some(submitted.task_id);
            goal.state = "running".into();
            s.journal.put("goal", &goal.id, &goal)?;
        }
        Ok(())
    }
    /// Issue a local command. For external adapter commands inside Tokio, use
    /// `action_async` so the caller does not block the executor.
    pub fn action(self: &Arc<Self>, action: Action) -> Result<Value> {
        if matches!(&action.command, Command::Routing { .. }) {
            return routing_host::owner_action(self, &action);
        }
        // Image reads are immutable and must not duplicate multi-MiB payloads in receipts.
        if let Command::Workspace {
            action: OwnerAction::ReadAvatar { id },
        } = &action.command
        {
            let value = avatars::read(&*self.lock()?, id);
            return Ok(match value {
                Ok(result) => json!({"ok": true, "result": result}),
                Err(error) => json!({"ok": false, "error": error.to_string()}),
            });
        }
        #[cfg(feature = "caldav")]
        if let Command::Workspace { action: ref query } = action.command {
            let value = match query {
                OwnerAction::PlannerOperationStatus {
                    collection_id,
                    operation_id,
                } => Some(planner_sync::status(
                    &*self.lock()?,
                    operation_id,
                    collection_id,
                )),
                OwnerAction::ListConnectedPlanner {
                    collection_id,
                    from_ms,
                    to_ms,
                } => Some(planner_sync::list(
                    &*self.lock()?,
                    collection_id,
                    *from_ms,
                    *to_ms,
                )),
                _ => None,
            };
            if let Some(value) = value {
                return Ok(match value {
                    Ok(result) => json!({"ok":true,"result":result}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                });
            }
        }
        #[cfg(feature = "caldav")]
        if let Command::Workspace {
            action: OwnerAction::PlannerMutation { mutation },
        } = &action.command
        {
            if self.stopping.load(Ordering::Acquire) {
                bail!("Ghost host is stopping");
            }
            uuid::Uuid::parse_str(&action.request_id)?;
            let payload = serde_json::to_string(&serde_json::to_value(&action.command)?)?;
            if payload.len() > 1_048_576 {
                bail!("command size limit");
            }
            let result = planner_sync::enqueue_owner(
                &*self.lock()?,
                &action.request_id,
                &payload,
                mutation.clone(),
            );
            return Ok(match result {
                Ok(value) => value,
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            });
        }
        if Self::external_command(&action.command) {
            if tokio::runtime::Handle::try_current().is_ok() {
                bail!("external adapter commands inside Tokio require Host::action_async");
            }
            return self.handle.block_on(self.action_async(action));
        }
        if let Some(reply) = self.begin_action(&action)? {
            return Ok(reply);
        }
        let request_id = action.request_id;
        let result = match action.command {
            Command::Workspace {
                action: OwnerAction::Backup { destination },
            } => operations::backup(self, Path::new(&destination)),
            Command::Workspace { action } => {
                actions::apply(self, &*self.lock()?, &request_id, action)
            }
            command => self.apply(&mut *self.lock()?, &request_id, command),
        };
        self.finish_action(&request_id, result)
    }

    /// Async variant for computer and channel effects. An interrupted effect
    /// leaves its command intent available for inspection rather than replay.
    pub async fn action_async(self: &Arc<Self>, action: Action) -> Result<Value> {
        // Read-only discovery has no effects to replay and does not retain large catalogs in command receipts.
        let read = match &action.command {
            Command::Workspace {
                action: OwnerAction::ModelCatalog,
            } => Some(models::catalog(&self.root).await),
            Command::Workspace {
                action: OwnerAction::DiscoverLocalModels,
            } => Some(models::discover().await),
            _ => None,
        };
        if let Some(result) = read {
            return Ok(match result {
                Ok(value) => json!({"ok":true,"result":value}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            });
        }
        if !Self::external_command(&action.command) {
            return self.action(action);
        }
        if let Some(reply) = self.begin_action(&action)? {
            return Ok(reply);
        }
        let request_id = action.request_id;
        let result = match action.command {
            Command::Workspace {
                action: OwnerAction::RecoverProfile { profile_id },
            } => self.recover_profile(&profile_id).await,
            Command::Workspace {
                action: OwnerAction::CheckIntegration { id },
            } => integrations::run(self, &id, None, None, || Ok(())).await,
            Command::Workspace {
                action: OwnerAction::CheckModelProvider { id },
            } => models::check(self, &id).await,
            Command::Workspace {
                action: OwnerAction::Computer { profile_id, verb },
            } => computer::control(self, &profile_id, &verb).await,
            Command::Workspace {
                action:
                    OwnerAction::VoiceStart {
                        profile_id,
                        conversation_id,
                        sdp,
                    },
            } => {
                channels::voice_start(self, &request_id, &profile_id, &conversation_id, &sdp).await
            }
            Command::Workspace {
                action: OwnerAction::VoiceEnd { call_id },
            } => channels::voice_end(self, &call_id).await,
            Command::Workspace {
                action: OwnerAction::SendSlack { outbox_id },
            } => channels::send_slack(self, &outbox_id).await,
            _ => unreachable!("external command classification"),
        };
        self.finish_action(&request_id, result)
    }

    fn external_command(command: &Command) -> bool {
        matches!(
            command,
            Command::Workspace {
                action: OwnerAction::Computer { .. }
                    | OwnerAction::RecoverProfile { .. }
                    | OwnerAction::CheckIntegration { .. }
                    | OwnerAction::ModelCatalog
                    | OwnerAction::DiscoverLocalModels
                    | OwnerAction::CheckModelProvider { .. }
                    | OwnerAction::VoiceStart { .. }
                    | OwnerAction::VoiceEnd { .. }
                    | OwnerAction::SendSlack { .. }
            }
        )
    }

    fn begin_action(&self, action: &Action) -> Result<Option<Value>> {
        if self.stopping.load(Ordering::Acquire) {
            bail!("Ghost host is stopping");
        }
        uuid::Uuid::parse_str(&action.request_id)
            .map_err(|_| anyhow!("request id must be a UUID"))?;
        // Preserve the existing canonical JSON spelling for durable receipt keys.
        let payload = serde_json::to_string(&serde_json::to_value(&action.command)?)?;
        if payload.len() > 1_048_576
            && !matches!(
                &action.command,
                Command::Workspace {
                    action: OwnerAction::CreateAvatar { .. }
                }
            )
        {
            bail!("command size limit");
        }
        self.lock()?.journal.begin(&action.request_id, &payload)
    }

    fn finish_action(&self, request_id: &str, result: Result<Value>) -> Result<Value> {
        let reply = match result {
            Ok(value) => json!({"ok": true, "result": value}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        };
        self.lock()?.journal.finish(request_id, &reply)?;
        Ok(reply)
    }
    fn apply(self: &Arc<Self>, s: &mut State, request: &str, command: Command) -> Result<Value> {
        if let Command::CreateProfile { name, persona } = &command {
            store::validate_name(name)?;
            if persona.len() > 4096 {
                bail!("persona size limit");
            }
            let p = Self::profile(ProfileStore::create_profile(&self.root, name, persona)?)?;
            let id = p.id.clone();
            p.host.install_services(Arc::new(services::Bridge {
                owner: id.clone(),
                host: Arc::downgrade(self),
            }))?;
            p.host.install_file_fence(Arc::new(services::Bridge {
                owner: id.clone(),
                host: Arc::downgrade(self),
            }))?;
            let runtime = p.runtime.clone();
            s.profiles.insert(id.clone(), p);
            self.start_worker(id.clone(), runtime, 4);
            return Ok(json!({"profile_id":id}));
        }
        if let Command::PauseSchedule {
            schedule_id,
            paused,
        } = &command
        {
            s.journal.pause(schedule_id, *paused, now_ms())?;
            return Ok(json!({"schedule_id":schedule_id,"paused":paused}));
        }
        let profile_id = match &command {
            Command::CreateConversation { profile_id, .. }
            | Command::Submit { profile_id, .. }
            | Command::Cancel { profile_id, .. }
            | Command::Compact { profile_id, .. }
            | Command::AddSchedule { profile_id, .. }
            | Command::Grant { profile_id, .. }
            | Command::Revoke { profile_id, .. }
            | Command::Reconcile { profile_id, .. } => profile_id,
            _ => bail!("unsupported command"),
        };
        let p = s
            .profiles
            .get(profile_id)
            .ok_or_else(|| anyhow!("profile missing"))?;
        match command {
            Command::CreateConversation { model, tools, .. } => {
                text(&model, 200)?;
                let store = p
                    .host
                    .store
                    .lock()
                    .map_err(|_| anyhow!("profile unavailable"))?;
                let mut config = host::config(&store, Some(&model), tools)?;
                if tools {
                    config.tools.extend(services::tool_definitions(self));
                }
                Ok(
                    json!({"conversation_id":p.runtime.session.create_conversation_with_id(request,config)?}),
                )
            }
            Command::Submit {
                conversation_id,
                prompt,
                kind,
                ..
            } => {
                text(&prompt, 8192)?;
                models::prepare_conversation(s, &p.id, &conversation_id, kind)?;
                // Existing tool-enabled chats pick up newly shipped host tools
                // at the next idle turn; active runs keep their saved config.
                let snapshot = p.runtime.session.snapshot()?;
                let mut config = snapshot
                    .conversations
                    .get(&conversation_id)
                    .ok_or_else(|| anyhow!("conversation missing"))?
                    .config
                    .clone();
                if config.tools.iter().any(|tool| tool.name == "list_ghosts")
                    && !snapshot
                        .tasks
                        .values()
                        .any(|t| t.conversation_id == conversation_id && !t.phase.terminal())
                {
                    let extra = services::tool_definitions(self)
                        .into_iter()
                        .filter(|tool| !config.tools.iter().any(|old| old.name == tool.name))
                        .collect::<Vec<_>>();
                    if !extra.is_empty() {
                        config.tools.extend(extra);
                        p.runtime.session.set_config(&conversation_id, config)?;
                    }
                }
                Ok(serde_json::to_value(p.runtime.session.submit(
                    &conversation_id,
                    request,
                    kind,
                    &prompt,
                )?)?)
            }
            Command::Cancel { task_id, .. } => {
                p.runtime.session.cancel(&task_id)?;
                Ok(json!({"task_id":task_id}))
            }
            Command::Compact {
                conversation_id, ..
            } => Ok(serde_json::to_value(
                p.runtime.session.compact(&conversation_id, request)?,
            )?),
            Command::AddSchedule {
                profile_id,
                conversation_id,
                prompt,
                interval_seconds,
            } => {
                text(&prompt, 8192)?;
                if !p
                    .runtime
                    .session
                    .snapshot()?
                    .conversations
                    .contains_key(&conversation_id)
                {
                    bail!("conversation missing");
                }
                let schedule = Schedule {
                    id: request.into(),
                    profile_id,
                    conversation_id,
                    prompt,
                    interval_seconds,
                    next_run_ms: now_ms().saturating_add(interval_seconds.saturating_mul(1000)),
                    paused: false,
                    last_task_id: None,
                };
                s.journal.add(&schedule)?;
                Ok(serde_json::to_value(schedule)?)
            }
            Command::Grant {
                path, operation, ..
            } => {
                text(&path, 4096)?;
                let store = p
                    .host
                    .store
                    .lock()
                    .map_err(|_| anyhow!("profile unavailable"))?;
                Ok(serde_json::to_value(
                    store.allow(Path::new(&path), &operation)?,
                )?)
            }
            Command::Revoke { grant_id, .. } => {
                let store = p
                    .host
                    .store
                    .lock()
                    .map_err(|_| anyhow!("profile unavailable"))?;
                Ok(serde_json::to_value(store.revoke(grant_id)?)?)
            }
            Command::Reconcile {
                effect_key,
                status,
                summary,
                ..
            } => {
                text(&summary, 2048)?;
                if status == ToolStatus::Uncertain {
                    bail!("definitive result required");
                }
                p.runtime.session.reconcile(
                    &effect_key,
                    ToolOutput {
                        status,
                        summary,
                        next_actions: vec![],
                        artifacts: vec![],
                        content: Value::Null,
                    },
                )?;
                Ok(json!({"effect_key":effect_key}))
            }
            _ => bail!("unsupported command"),
        }
    }
    pub fn snapshot(&self) -> Result<Value> {
        self.snapshot_for(None)
    }
    /// Initial browser projection carries one conversation's content and the
    /// remaining conversation identities. Native owner snapshots keep their API.
    pub fn snapshot_ui(&self) -> Result<Value> {
        let selected = self.lock()?.profiles.values().find_map(|profile| {
            profile
                .runtime
                .session
                .committed()
                .ok()?
                .conversations
                .keys()
                .next()
                .map(|conversation| (profile.id.clone(), conversation.clone()))
        });
        self.snapshot_for(
            selected
                .as_ref()
                .map(|(profile, conversation)| (profile.as_str(), conversation.as_str())),
        )
    }
    pub fn snapshot_for(&self, selected: Option<(&str, &str)>) -> Result<Value> {
        let s = self.lock()?;
        let mut profiles = vec![];
        for p in s.profiles.values() {
            let avatar = s
                .journal
                .get::<avatars::Assignment>("profile_avatar", &p.id)?
                .unwrap_or_default();
            let snap = match p.runtime.session.committed() {
                Ok(snapshot) => snapshot,
                Err(_) => {
                    profiles.push(json!({"id":p.id,"name":p.name,"persona":p.persona,"avatar_id":avatar.avatar_id,"avatar_version":avatar.version,"conversations":[],"grants":[],"policy":s.journal.get::<Policy>("policy", &p.id)?.unwrap_or_default(),"spend":s.journal.get::<Spend>("spend", &p.id)?.unwrap_or_default(),"usage":{"tokens":0,"cost_usd":0.0,"unavailable":true},"error":"이 Ghost의 저장소를 읽을 수 없습니다. 다른 Ghost의 작업은 계속됩니다."}));
                    continue;
                }
            };
            let mut conversations = vec![];
            for c in snap.conversations.values() {
                let title = snap
                    .submissions
                    .iter()
                    .find(|x| x.conversation_id == c.id && x.kind != InputKind::Compact)
                    .map(|x| x.text.chars().take(48).collect::<String>())
                    .unwrap_or_else(|| "새 대화".into());
                if selected
                    .is_some_and(|(profile, conversation)| profile != p.id || conversation != c.id)
                {
                    conversations.push(json!({"id":c.id,"title":title}));
                    continue;
                }
                let mut messages = vec![];
                for entry in c.entries.iter().skip(c.entries.len().saturating_sub(200)) {
                    match &entry.kind {
                        EntryKind::Message(m)=>{
                            let role=match m {ai::Message::User(_)=>"user",ai::Message::Assistant(_)=>"assistant",ai::Message::ToolResult(_)=>"tool"};
                            let tool=match m{ai::Message::ToolResult(t)=>serde_json::from_str::<Value>(&m.text_content().unwrap_or_default()).ok().map(|v|json!({"name":t.tool_name,"output":v})),_=>None};
                            // A durable router submission has one stable request
                            // per root task. Never infer identity from message text.
                            let sources=snap.submissions.iter().filter(|sub| sub.conversation_id==c.id && Some(&sub.task_id)==entry.task_id.as_ref()).collect::<Vec<_>>();
                            let request_id=if role=="user" && sources.len()==1 { Some(sources[0].request_id.as_str()) } else { None };
                            messages.push(json!({"role":role,"text":m.text_content().unwrap_or_default(),"tool":tool,"revision":entry.revision,"task_id":entry.task_id,"request_id":request_id}));
                        },
                        EntryKind::Aborted{partial,reason}=>messages.push(json!({"role":"interrupted","text":partial,"reason":reason,"task_id":entry.task_id})),
                        EntryKind::Compaction{..}=>messages.push(json!({"role":"checkpoint","text":"이전 대화를 요약했습니다. 원문은 보존됩니다."})),
                        EntryKind::Observation{source,text,..}=>messages.push(json!({"role":"voice","text":text,"source":source,"revision":entry.revision})),
                        _=>{},
                    }
                }
                for sub in snap.submissions.iter().filter(|x| {
                    x.conversation_id == c.id && !x.consumed && x.kind != InputKind::Compact
                }) {
                    messages.push(json!({"role":"queued","text":sub.text,"task_id":sub.task_id,"request_id":sub.request_id,"phase":snap.tasks.get(&sub.task_id).map(|t|t.phase)}));
                }
                let mut tasks = snap
                    .tasks
                    .values()
                    .filter(|t| t.conversation_id == c.id)
                    .collect::<Vec<_>>();
                tasks.sort_by_key(|t| t.ordinal);
                let tasks=tasks.into_iter().map(|t|{
                    let (name,partial)=match &t.kind {TaskKind::Generation{partial,..}=>("응답 생성".into(),partial.clone()),TaskKind::Tool{call,..}=>(call.name.clone(),String::new())};
                    json!({"id":t.id,"parent_id":t.parent_id,"phase":t.phase,"name":name,"partial":partial,"output":t.output,"usage":t.usage})
                }).collect::<Vec<_>>();
                let effects = snap
                    .effects
                    .values()
                    .filter(|e| {
                        snap.tasks
                            .get(&e.task_id)
                            .is_some_and(|t| t.conversation_id == c.id)
                    })
                    .collect::<Vec<_>>();
                let selection = models::conversation_selection(&s, &p.id, &c.id, &c.config.model)?;
                conversations.push(json!({"id":c.id,"title":title,"selected_model":selection["selected_model"],"model_pending":selection["model_pending"],"model_available":selection["model_available"],"model_error":selection["model_error"],"model":format!("{}/{}",c.config.model.provider,c.config.model.id),"offline":c.config.model.provider=="mock","tools_enabled":!c.config.tools.is_empty(),"messages":messages,"tasks":tasks,"effects":effects,"revision":snap.revision,"earlier_entries":c.entries.len().saturating_sub(200)}));
            }
            let grants = p
                .host
                .store
                .lock()
                .map_err(|_| anyhow!("profile unavailable"))?
                .grants()?;
            let persona = p
                .host
                .store
                .lock()
                .map_err(|_| anyhow!("profile unavailable"))?
                .persona
                .clone();
            let policy: Policy = s.journal.get("policy", &p.id)?.unwrap_or_default();
            let spend: Spend = s.journal.get("spend", &p.id)?.unwrap_or_default();
            let usage_tokens: u64 = snap
                .tasks
                .values()
                .filter(|t| t.parent_id.is_none())
                .map(|t| t.usage.total_tokens as u64)
                .sum();
            let usage_cost: f64 = snap
                .tasks
                .values()
                .filter(|t| t.parent_id.is_none())
                .map(|t| {
                    t.usage.cost.input
                        + t.usage.cost.output
                        + t.usage.cost.cache_read
                        + t.usage.cost.cache_write
                })
                .sum();
            profiles.push(json!({"id":p.id,"name":p.name,"persona":persona,"avatar_id":avatar.avatar_id,"avatar_version":avatar.version,"conversations":conversations,"grants":grants,"policy":policy,"spend":spend,"usage":{"tokens":usage_tokens,"cost_usd":usage_cost},"error":p.error}));
        }
        Ok(
            json!({"mode":"durable_workspace","host_protocol_version":1,"capabilities":{"routing":routing_host::capability(),"avatars":true,"documents":cfg!(feature="documents"),"memory":memory::Brain::configured(),"channels":cfg!(feature="channels"),"computer":{"backend":self.computer.identity(),"configured":self.computer.configured(),"operations":self.computer.capabilities()}},"avatars":s.journal.objects::<avatars::Avatar>("avatar")?,"todos":s.journal.objects::<planner::Todo>("todo")?,"calendar_events":s.journal.objects::<planner::Event>("calendar_event")?,"connected_planner":connected_planner_snapshot(&s)?,"integrations":s.journal.objects::<integrations::Integration>("integration")?,"routing_shares":s.journal.objects::<routing_host::RoutingShare>("routing_share_v1")?,"routing_results":routing_dispatch::owner_results(&s)?,"workspace_id":s.journal.get::<String>("meta","workspace_id")?,"default_model":models::selected_llm(&s,&self.default_model)?,"model_settings":models::settings(&s)?,"profiles":profiles,"schedules":s.journal.list()?,"spaces":s.journal.objects::<documents::Space>("space")?,"reviews":s.journal.objects::<Review>("review")?.into_iter().filter(|r|!r.profile_id.is_empty()&&matches!(r.state.as_str(),"pending"|"approved")).collect::<Vec<_>>(),"goals":s.journal.objects::<Goal>("goal")?,"delegations":s.journal.objects::<Delegation>("delegation")?,"slack_bindings":s.journal.objects::<channels::SlackBinding>("slack_binding")?,"slack_outbox":s.journal.objects::<channels::Outbox>("slack_outbox")?,"voice_calls":s.journal.objects::<channels::Call>("voice_call")?,"connector_status":s.journal.objects::<Value>("connector_status")?,"connectors":{"computer":self.computer.configured(),"brain":memory::Brain::configured(),"voice":cfg!(feature="channels")&&std::env::var_os("OPENAI_API_KEY").is_some(),"slack":cfg!(feature="channels")&&std::env::var_os("GHOST_SLACK_APP_TOKEN").is_some()}}),
        )
    }
}

impl Host {
    pub fn default_model(&self) -> String {
        self.lock()
            .and_then(|s| models::selected_llm(&s, &self.default_model))
            .unwrap_or_else(|_| self.default_model.clone())
    }

    /// Committed runtime events; reads do not drive execution.
    pub fn events(&self, profile_id: &str, after: u64) -> Result<Value> {
        let state = self.lock()?;
        let profile = state
            .profiles
            .get(profile_id)
            .ok_or_else(|| anyhow!("profile missing"))?;
        Ok(serde_json::to_value(
            profile.runtime.session.commits_since(after)?,
        )?)
    }

    pub(crate) fn computer_backend(&self) -> &Arc<dyn computer::ComputerBackend> {
        &self.computer
    }

    pub(crate) fn track(&self, task: tokio::task::JoinHandle<()>) {
        let mut workers = self.workers.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopping.load(Ordering::Acquire) {
            task.abort();
        } else {
            workers.push(task);
        }
    }

    pub(crate) fn spawn(
        &self,
        task: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> tokio::task::AbortHandle {
        let task = self.handle.spawn(task);
        let abort = task.abort_handle();
        self.track(task);
        abort
    }

    /// Recover only the affected profile after its storage has been repaired.
    /// Stop and join both workers before reloading committed runtime receipts.
    async fn recover_profile(self: &Arc<Self>, id: &str) -> Result<Value> {
        let _recovery = self.recovery.lock().await;
        let (runtime, concurrency) = {
            let state = self.lock()?;
            let profile = state
                .profiles
                .get(id)
                .ok_or_else(|| anyhow!("Ghost missing"))?;
            if profile.error.is_none() {
                bail!("Ghost is healthy; recovery is unnecessary");
            }
            (
                profile.runtime.clone(),
                state
                    .journal
                    .get::<Policy>("policy", id)?
                    .unwrap_or_default()
                    .concurrency,
            )
        };
        let aborts = self
            .profile_workers
            .lock()
            .map_err(|_| anyhow!("worker state unavailable"))?
            .remove(id)
            .unwrap_or_default();
        let tasks = {
            let mut workers = self
                .workers
                .lock()
                .map_err(|_| anyhow!("worker state unavailable"))?;
            let mut tasks = Vec::new();
            let mut index = 0;
            while index < workers.len() {
                if aborts.iter().any(|a| a.id() == workers[index].id()) {
                    tasks.push(workers.swap_remove(index));
                } else {
                    index += 1;
                }
            }
            tasks
        };
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        if self.stopping.load(Ordering::Acquire) {
            bail!("Ghost host is stopping");
        }
        runtime.session.reload_committed()?;
        self.lock()?
            .profiles
            .get_mut(id)
            .ok_or_else(|| anyhow!("Ghost missing"))?
            .error = None;
        self.start_worker(id.into(), runtime, concurrency);
        Ok(json!({"profile_id":id,"state":"recovered"}))
    }

    /// Stop dispatch and await task teardown. Durable work is retained for restart.
    /// Drop all Host handles afterwards to release the root and profile locks.
    pub async fn shutdown(&self) -> Result<()> {
        self.integrations.clear();
        self.stopping.store(true, Ordering::Release);
        let tasks = std::mem::take(
            &mut *self
                .workers
                .lock()
                .map_err(|_| anyhow!("worker state unavailable"))?,
        );
        for task in &tasks {
            task.abort();
        }
        let mut failure = None;
        for task in tasks {
            if let Err(error) = task.await {
                if !error.is_cancelled() {
                    failure = Some(anyhow!("Ghost worker shutdown failed: {error}"));
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        for worker in self
            .workers
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            worker.abort();
        }
    }
}

#[cfg(test)]
mod extension_tests;
#[cfg(test)]
mod tests;
#[cfg(all(test, feature = "documents"))]
mod workflow_tests;

fn connected_planner_snapshot(s: &State) -> Result<Value> {
    #[cfg(feature = "caldav")]
    {
        planner_sync::snapshot(s)
    }
    #[cfg(not(feature = "caldav"))]
    {
        let _ = s;
        Ok(json!({"transport_available":false,"collections":[],"operations":[]}))
    }
}

#[cfg(test)]
mod routing_dispatch_tests;
#[cfg(test)]
mod routing_host_tests;
#[cfg(test)]
mod routing_model_http_tests;
#[cfg(test)]
mod routing_model_tests;
