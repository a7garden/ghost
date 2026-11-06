//! Long-lived Ghost host. Owns profile runtimes, durable command receipts, goals,
//! schedules and policy independently of any UI, transport or optional adapter.
mod actions;
#[cfg(feature = "lifetime")]
pub mod bots;
#[cfg(feature = "lifetime")]
pub(crate) mod bots_store;
#[cfg(feature = "lifetime")]
pub(crate) mod bots_provisioning;
#[cfg(feature = "lifetime")]
pub(crate) mod bots_memory;
#[cfg(feature = "lifetime")]
pub(crate) mod bot_lifecycle;
#[cfg(feature = "lifetime")]
pub(crate) mod shared_skills;
pub mod orchestration;
pub mod avatars;
mod cli_tools;
#[cfg(test)]
#[allow(dead_code)]
mod code_worker;
pub mod integrations;
#[cfg(feature = "lifetime")]
mod integration_approvals;
pub mod models;
#[cfg(feature = "lifetime")]
pub(crate) mod inference;
// Historical source retained; no OMP worker module is linked.
mod omp_provider;
pub mod operations;
pub mod planner;
#[cfg(feature = "caldav")]
pub mod planner_sync;
#[cfg(feature = "caldav")]
pub mod planner_google_transport;
mod protocol;
pub mod routing_dispatch;
pub mod routing_host;
pub mod routing_model;
mod scheduler;
pub mod voice;
pub mod wake;
pub mod incidents;
pub mod skills;
#[cfg(feature = "lifetime")]
pub mod lifetime;
#[cfg(feature = "lifetime")]
mod lifetime_api;
#[cfg(feature = "lifetime")]
mod lifetime_memory;
#[cfg(feature = "lifetime")]
pub(crate) mod work_memory;
#[cfg(feature = "lifetime")]
pub(crate) mod memory_publication;
#[cfg(feature = "lifetime")]
mod lifetime_documents;
// The owner decision resume in adapters/computer.rs reuses this module's
// loopback worker request client.
#[cfg(feature = "lifetime")]
pub(crate) mod lifetime_driver;
#[cfg(feature = "lifetime")]
mod lifetime_runtime;
#[cfg(feature = "lifetime")]
pub mod lifetime_computers;
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
struct WorkspaceLock(File);
impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        // A forked child can retain the open file description after we close
        // our descriptor. Release our lease explicitly, in the original field
        // drop order after workspace state, rather than at that child's exit.
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

pub struct Host {
    pub(crate) root: PathBuf,
    pub(crate) state: Mutex<State>,
    pub(crate) handle: tokio::runtime::Handle,
    pub(crate) default_model: String,
    _lock: WorkspaceLock,
    pub(crate) brain: memory::Brain,
    computer: Arc<dyn computer::ComputerBackend>,
    integrations: integrations::Connections,
    workers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    profile_workers: Mutex<BTreeMap<String, Vec<tokio::task::AbortHandle>>>,
    recovery: tokio::sync::Mutex<()>,
    stopping: AtomicBool,
    #[cfg(test)]
    legacy_fixture_reasoning: AtomicBool,
    pub(crate) dispatch_enabled: bool,
    #[cfg(feature = "lifetime")]
    pub(crate) pi_callback_token: String,
    #[cfg(feature = "lifetime")]
    pub(crate) pi_local_route: Option<lifetime_runtime::LocalPiRoute>,
    #[cfg(feature = "lifetime")]
    pub(crate) authority_epoch: u64,
    #[cfg(feature = "lifetime")]
    pub(crate) native_computers: Option<lifetime_computers::NativeComputers>,
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
            .map_err(|error| anyhow!(error).context("workspace is already served by another process"))?;
        let lock = WorkspaceLock(lock);
        let mut profiles = BTreeMap::new();
        for name in store::list_profiles(&root)? {
            let p = Self::profile(ProfileStore::open_profile(&root, &name)?)?;
            profiles.insert(p.id.clone(), p);
        }
        let journal = Journal::open(&root.join("workspace.db"))?;
        let dispatch_enabled = journal.dispatch_enabled()?;
        #[cfg(feature = "lifetime")]
        if dispatch_enabled { integration_approvals::recover_interrupted(&journal)?; }
        if journal.get::<String>("meta", "workspace_id")?.is_none() {
            journal.put("meta", "workspace_id", &uuid::Uuid::now_v7().to_string())?;
        }
        #[cfg(feature = "lifetime")]
        let authority_epoch = lifetime::authority::current(&journal.0)?.epoch;
        #[cfg(feature = "lifetime")]
        if dispatch_enabled && std::env::var("GHOST_LIFETIME_MODE").as_deref() == Ok("broker") {
            use crate::lifetime_contract::{canonical_digest, Envelope, ResponseStatus, VERSION};
            use rusqlite::OptionalExtension;
            const STARTER_POLICY: &str = "lifetime_bootstrap_specialists";
            let bootstrap_specialists = match std::env::var("GHOST_LIFETIME_BOOTSTRAP_SPECIALISTS").as_deref() {
                Ok(value @ ("0" | "1")) => {
                    let enabled = value == "1";
                    journal.put("meta", STARTER_POLICY, &enabled)?;
                    enabled
                }
                Err(std::env::VarError::NotPresent) => {
                    journal.get("meta", STARTER_POLICY)?.unwrap_or(true)
                }
                _ => bail!("GHOST_LIFETIME_BOOTSTRAP_SPECIALISTS must be 0 or 1"),
            };
            let primary: Option<(String, String)> = journal.0.query_row(
                "SELECT ghost_id,conversation_id FROM lifetime_registry WHERE kind='primary'",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            if let Some((ghost_id, conversation_id)) = primary {
                let profile = profiles.get(&ghost_id).ok_or_else(|| anyhow!("registered Primary profile is missing"))?;
                uuid::Uuid::parse_str(&conversation_id)?;
                anyhow::ensure!(!profile.runtime.session.committed()?.conversations.contains_key(&conversation_id),
                    "registered Primary personal conversation conflicts with legacy runtime ownership");
            } else {
                // A named Primary is an explicit identity; arbitrary first-profile
                // ordering never selects or overwrites an existing user's Ghost.
                let ghost_id = match profiles.values().find(|profile| profile.name == "primary") {
                    Some(profile) => profile.id.clone(),
                    None => {
                        let profile = Self::profile(ProfileStore::create_profile(&root, "primary",
                            "주 Ghost. 사용자의 개인 대화와 장기 책임을 맡고, 필요한 전문 Ghost와 작업을 조율한다.")?)?;
                        let id = profile.id.clone();
                        profiles.insert(id.clone(), profile);
                        id
                    }
                };
                let conversation_id = uuid::Uuid::now_v7().to_string();
                let body = json!({"method":"registry.ensure","ghost_id":ghost_id,
                    "kind":"primary","conversation_id":conversation_id,"roles":["coordination"]});
                let command_id = format!("primary-bootstrap:{ghost_id}:{conversation_id}");
                let envelope = Envelope {
                    protocol_version: VERSION.into(), payload_digest: canonical_digest(&body)?,
                    actor_ref: "owner".into(), authority_epoch, expected_revision: None,
                    correlation_id: command_id.clone(), command_id, body,
                };
                let response = lifetime::apply(&journal.0, &envelope, "owner")?;
                anyhow::ensure!(response.status == ResponseStatus::Success,
                    "Primary registration was not accepted: {}", response.summary);
            }
            for (name, role, soul) in [
                ("specialist-research", "research", "지속형 리서치 Ghost. 주 Ghost와 요약·근거를 교환하고 맡은 책임을 검증 가능한 작업으로 수행한다."),
                ("specialist-engineering", "engineering", "지속형 엔지니어링 Ghost. 자기 작업 범위와 sandbox에서 자신의 Pi 실행으로 실제 작업을 맡고 검수 가능한 산출물을 주 Ghost에게 전달한다."),
                ("specialist-operations", "operations", "지속형 운영 Ghost. 운영 상태와 복구 경계를 보존하며 맡은 책임과 검증 결과를 주 Ghost와 공유한다."),
            ] {
                let existing: Option<(String, String)> = journal.0.query_row(
                    "SELECT r.ghost_id,r.conversation_id FROM lifetime_registry r
                     WHERE r.kind='specialist' AND EXISTS(SELECT 1 FROM json_each(r.roles) WHERE value=?1)
                     ORDER BY r.ghost_id LIMIT 1",
                    [role], |row| Ok((row.get(0)?, row.get(1)?)),
                ).optional()?;
                if let Some((ghost_id, conversation_id)) = existing {
                    let profile = profiles.get(&ghost_id).ok_or_else(|| anyhow!("registered specialist profile is missing"))?;
                    uuid::Uuid::parse_str(&conversation_id)?;
                    anyhow::ensure!(!profile.runtime.session.committed()?.conversations.contains_key(&conversation_id),
                        "registered specialist conversation conflicts with legacy runtime ownership");
                    // A draining specialist is still the user's configured role;
                    // startup must not reactivate it or create a replacement.
                    continue;
                }
                if !bootstrap_specialists {
                    continue;
                }
                let ghost_id = match profiles.values().find(|profile| profile.name == name) {
                    Some(profile) => profile.id.clone(),
                    None => {
                        let profile = Self::profile(ProfileStore::create_profile(&root, name, soul)?)?;
                        let id = profile.id.clone();
                        profiles.insert(id.clone(), profile);
                        id
                    }
                };
                let claimed: bool = journal.0.query_row(
                    "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
                    [&ghost_id], |row| row.get(0),
                )?;
                anyhow::ensure!(!claimed, "named specialist profile is already registered with a different role; preserve its identity");
                let conversation_id = uuid::Uuid::now_v7().to_string();
                let body = json!({"method":"registry.ensure","ghost_id":ghost_id,
                    "kind":"specialist","conversation_id":conversation_id,"roles":[role]});
                let command_id = format!("specialist-bootstrap:{role}:{ghost_id}:{conversation_id}");
                let envelope = Envelope {
                    protocol_version: VERSION.into(), payload_digest: canonical_digest(&body)?,
                    actor_ref: "owner".into(), authority_epoch, expected_revision: None,
                    correlation_id: command_id.clone(), command_id, body,
                };
                let response = lifetime::apply(&journal.0, &envelope, "owner")?;
                anyhow::ensure!(response.status == ResponseStatus::Success,
                    "Specialist registration was not accepted: {}", response.summary);
            }
        }
        #[cfg(feature = "lifetime")]
        let native_computers = if dispatch_enabled {
            lifetime_computers::NativeComputers::from_environment(&journal, &profiles, authority_epoch)?
        } else { None };
        // An operator-configured owned browser backend replaces the default
        // conversation computer for this host; its browser state is bound to
        // the same durable computer registry as the native worker homes.
        #[cfg(feature = "lifetime")]
        let computer = match native_computers.as_ref().and_then(|computers| computers.conversation_backend()) {
            Some(owned) => owned,
            None => computer,
        };
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
        #[cfg(test)]
        legacy_fixture_reasoning: AtomicBool::new(false),
            dispatch_enabled,
            #[cfg(feature = "lifetime")]
            pi_callback_token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
            #[cfg(feature = "lifetime")]
            pi_local_route: if dispatch_enabled { lifetime_runtime::LocalPiRoute::from_environment()? } else { None },
            #[cfg(feature = "lifetime")]
            authority_epoch,
            #[cfg(feature = "lifetime")]
            native_computers,
        });
        // Recovery roots remain inspectable without starting any effect owner.
        if !dispatch_enabled { return Ok(this); }
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
        #[cfg(feature = "lifetime")]
        lifetime_driver::start(&this)?;
        Ok(this)
    }
    pub(crate) fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| anyhow!("workspace state unavailable"))
    }
    #[cfg(test)]
    fn open_legacy_fixture(root:&Path,handle:tokio::runtime::Handle,model:Option<&str>)->Result<Arc<Self>> {
        let app=Self::open(root,handle,model)?;
        app.legacy_fixture_reasoning.store(true,Ordering::Release);
        let profiles=app.lock()?.profiles.values().map(|p|(p.id.clone(),p.runtime.clone())).collect::<Vec<_>>();
        for (id,runtime) in profiles {app.start_legacy_fixture_worker(id,runtime,4);}
        Ok(app)
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
    fn permits_legacy_fixture_reasoning(&self)->bool {
        #[cfg(test)] {return self.legacy_fixture_reasoning.load(Ordering::Acquire);}
        #[cfg(not(test))] {false}
    }
    // Legacy receipts stay open, but Pi is the sole reasoning owner. Missing
    // Pi configuration never permits a fallback agent or a second scheduler.
    fn start_worker(self: &Arc<Self>, _id:String, _runtime:Runtime, _concurrency:usize) {
        #[cfg(test)]
        if self.permits_legacy_fixture_reasoning() {self.start_legacy_fixture_worker(_id,_runtime,_concurrency);}
    }

    #[cfg(test)]
    fn start_legacy_fixture_worker(self: &Arc<Self>, id:String, runtime:Runtime, concurrency:usize) {
        if !self.dispatch_enabled {return;}
        self.legacy_fixture_reasoning.store(true,Ordering::Release);
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
        // Owner-approved wake schedules share this same loop and journal; no
        // second timer exists. Recover interrupted claims first, then fire.
        wake::fire_due(&s, id, now)?;
        // Owner-approved incident intake shares this loop too; no second
        // timer, daemon, or MCP dependency exists.
        incidents::fire_due(&s, id, now)?;
        orchestration::tick(self, &s, id)?;
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
            // Lifetime proposals carry no Task: their source turn may settle
            // while the proposal stays Owner-decidable until it expires.
            let stale_task = review.lifetime_origin.is_none()
                && snapshot
                    .tasks
                    .get(&review.task_id)
                    .is_none_or(|t| t.phase.terminal());
            if stale_task || review.expires_ms <= now {
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
                config.tools.extend(services::scoped_tool_definitions(
                    self,
                    services::ToolRole::Ordinary,
                    &policy,
                ));
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
    fn read_only_action(action: &Action) -> bool {
        #[cfg(feature = "lifetime")]
        if let Command::Lifetime { envelope } = &action.command {
            return lifetime::authority::read_only(envelope.body["method"].as_str());
        }
        #[cfg(feature = "lifetime")]
        if matches!(&action.command, Command::Workspace { action: OwnerAction::InspectIntegrationApproval { .. } }) {
            return true;
        }
        let _ = action;
        false
    }

    /// Issue a local command. For external adapter commands inside Tokio, use
    /// `action_async` so the caller does not block the executor.
    pub fn action(self: &Arc<Self>, action: Action) -> Result<Value> {
        if !self.dispatch_enabled && !Self::read_only_action(&action) {
            return Ok(json!({"ok":false,"error":"dispatch_off"}));
        }
        #[cfg(feature = "lifetime")]
        if let Command::Lifetime { envelope } = &action.command {
            return self.lifetime_action(envelope);
        }
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
                OwnerAction::PlannerSyncStatus { collection_id } => Some(
                    planner_sync::sync_status(&*self.lock()?, collection_id),
                ),
                _ => None,
            };
            if let Some(value) = value {
                return Ok(match value {
                    Ok(result) => json!({"ok":true,"result":result}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                });
            }
        }
        // Wake reads are pure derivations from persisted rows; like planner
        // status reads they carry no command receipt and no effect.
        if let Command::Workspace { action: ref query } = action.command {
            let value = match query {
                OwnerAction::WakeList { profile_id } => {
                    Some(wake::list(&*self.lock()?, profile_id).map(|wakes| json!(wakes)))
                }
                OwnerAction::WakePreview {
                    profile_id,
                    wake_id,
                    now_ms,
                } => Some(wake::preview(&*self.lock()?, profile_id, wake_id, *now_ms)),
                OwnerAction::IncidentList { profile_id } => {
                    Some(incidents::status(&*self.lock()?, profile_id))
                }
                OwnerAction::IncidentPreview { profile_id, now_ms } => {
                    Some(incidents::preview(&*self.lock()?, profile_id, *now_ms))
                }
                OwnerAction::SkillList { profile_id } => {
                    Some(skills::list(&*self.lock()?, profile_id).map(|items| json!(items)))
                }
                OwnerAction::SkillManifest { profile_id } => Some(
                    skills::manifest(&*self.lock()?, &self.root, profile_id),
                ),
                // Owner memory source review is a pure read: no command
                // receipt, no CAS and no side effect, like the other reads.
                #[cfg(feature = "lifetime")]
                OwnerAction::MemorySourceList {
                    profile_id,
                    conversation_id,
                } => Some(self.owner_memory_source_list(profile_id, conversation_id)),
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
        if !self.dispatch_enabled && !Self::read_only_action(&action) {
            return Ok(json!({"ok":false,"error":"dispatch_off"}));
        }
        // Read-only discovery has no effects to replay and does not retain large catalogs in command receipts.
        let read = match &action.command {
            #[cfg(feature = "lifetime")]
            Command::Workspace { action: OwnerAction::InspectIntegrationApproval { id } } => {
                Some(self.integration_approval_inspect(id))
            }
            Command::Workspace {
                action: OwnerAction::ModelCatalog,
            } => Some(models::catalog(&self.root).await),
            Command::Workspace {
                action: OwnerAction::DiscoverLocalModels,
            } => Some(models::discover().await),
            Command::Workspace {
                action: OwnerAction::WakeList { profile_id },
            } => Some(wake::list(&*self.lock()?, profile_id).map(|wakes| json!(wakes))),
            Command::Workspace {
                action:
                    OwnerAction::WakePreview {
                        profile_id,
                        wake_id,
                        now_ms,
                    },
            } => Some(wake::preview(&*self.lock()?, profile_id, wake_id, *now_ms)),
            Command::Workspace {
                action: OwnerAction::IncidentList { profile_id },
            } => Some(incidents::status(&*self.lock()?, profile_id)),
            Command::Workspace {
                action: OwnerAction::IncidentPreview { profile_id, now_ms },
            } => Some(incidents::preview(&*self.lock()?, profile_id, *now_ms)),
            Command::Workspace {
                action: OwnerAction::SkillList { profile_id },
            } => Some(skills::list(&*self.lock()?, profile_id).map(|items| json!(items))),
            Command::Workspace {
                action: OwnerAction::SkillManifest { profile_id },
            } => Some(skills::manifest(&*self.lock()?, &self.root, profile_id)),
            // Owner memory source review is a pure read: no command receipt,
            // no CAS and no side effect, like the other registered reads.
            #[cfg(feature = "lifetime")]
            Command::Workspace {
                action:
                    OwnerAction::MemorySourceList {
                        profile_id,
                        conversation_id,
                    },
            } => Some(self.owner_memory_source_list(profile_id, conversation_id)),
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
            #[cfg(feature = "lifetime")]
            Command::Workspace {
                action: OwnerAction::MemorySourceInspect {
                    profile_id, conversation_id, origin, content,
                },
            } => self.owner_memory_source_inspect(
                &profile_id, &conversation_id, &origin, &content,
            ).await,
            #[cfg(feature = "lifetime")]
            Command::Workspace {
                action: OwnerAction::MemorySourceCorrect {
                    profile_id, conversation_id, prior, expected_prior_episode_id,
                    prior_content, replacement_content,
                },
            } => self.owner_memory_source_correct(
                &request_id, &profile_id, &conversation_id, &prior,
                &expected_prior_episode_id, &prior_content, &replacement_content,
            ).await,
            #[cfg(feature = "lifetime")]
            Command::Workspace {
                action: OwnerAction::MemorySourceResume {
                    profile_id, conversation_id, correction_request_id,
                },
            } => self.owner_memory_source_resume(
                &profile_id, &conversation_id, &correction_request_id,
            ).await,
            Command::Workspace {
                action: OwnerAction::RecoverProfile { profile_id },
            } => self.recover_profile(&profile_id).await,
            #[cfg(feature = "lifetime")]
            Command::Workspace { action: OwnerAction::DecideIntegrationApproval { id, approve } } => {
                self.decide_integration_approval(&request_id, &id, approve).await
            }
            Command::Workspace {
                action: OwnerAction::CheckIntegration { id },
            } => integrations::run(self, &id, None, None, || Ok(())).await,
            Command::Workspace {
                action: OwnerAction::CheckModelProvider { id },
            } => models::check(self, &id).await,
            Command::Workspace {
                action: OwnerAction::Computer { profile_id, verb, action_id },
            } => computer::control(self, &profile_id, &verb, action_id.as_deref()).await,
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
            #[cfg(feature = "caldav")]
            Command::Workspace {
                action:
                    OwnerAction::PlannerSyncOnce {
                        collection_id,
                        write,
                    },
            } => self.planner_sync_once(&collection_id, write).await,
            _ => unreachable!("external command classification"),
        };
        self.finish_action(&request_id, result)
    }

    fn external_command(command: &Command) -> bool {
        #[cfg(feature = "lifetime")]
        if matches!(command, Command::Workspace {
            action: OwnerAction::MemorySourceInspect { .. } | OwnerAction::MemorySourceCorrect { .. }
                | OwnerAction::MemorySourceResume { .. } | OwnerAction::DecideIntegrationApproval { .. }
        }) {
            return true;
        }
        let channel = matches!(
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
        );
        #[cfg(feature = "caldav")]
        if !channel {
            return matches!(
                command,
                Command::Workspace {
                    action: OwnerAction::PlannerSyncOnce { .. }
                }
            );
        }
        channel
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
                    let policy: Policy = s.journal.get("policy", &p.id)?.unwrap_or_default();
                    config.tools.extend(services::scoped_tool_definitions(
                        self,
                        services::ToolRole::Ordinary,
                        &policy,
                    ));
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
                if !self.permits_legacy_fixture_reasoning() {bail!("pi_execution_prerequisite: use the canonical Ghost Pi conversation route; the legacy profile runtime is retired");}
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
                if config.tools.iter().any(|tool| tool.name == "list_todos")
                    && !snapshot
                        .tasks
                        .values()
                        .any(|t| t.conversation_id == conversation_id && !t.phase.terminal())
                {
                    let policy: Policy = s.journal.get("policy", &p.id)?.unwrap_or_default();
                    let extra = services::scoped_tool_definitions(
                        self,
                        services::ToolRole::Ordinary,
                        &policy,
                    )
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
                    profiles.push(json!({"id":p.id,"name":p.name,"display_name":s.journal.get::<String>("display_name",&p.id)?,"persona":p.persona,"avatar_id":avatar.avatar_id,"avatar_version":avatar.version,"conversations":[],"grants":[],"policy":s.journal.get::<Policy>("policy", &p.id)?.unwrap_or_default(),"spend":s.journal.get::<Spend>("spend", &p.id)?.unwrap_or_default(),"usage":{"tokens":0,"cost_usd":0.0,"unavailable":true},"error":"이 Ghost의 저장소를 읽을 수 없습니다. 다른 Ghost의 작업은 계속됩니다."}));
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
            profiles.push(json!({"id":p.id,"name":p.name,"display_name":s.journal.get::<String>("display_name",&p.id)?,"persona":persona,"avatar_id":avatar.avatar_id,"avatar_version":avatar.version,"conversations":conversations,"grants":grants,"policy":policy,"spend":spend,"usage":{"tokens":usage_tokens,"cost_usd":usage_cost},"error":p.error}));
        }
        #[allow(unused_mut)]
        let mut snapshot = self.with_snapshot_authority(&s.journal.0,
            json!({"mode":"durable_workspace","host_protocol_version":1,"capabilities":{"orchestration":true,"routing":routing_host::capability(),"code_worker":{"configured":false,"retired":true,"projects":[]},"omp_subscription":{"configured":omp_provider::configured(),"models":omp_provider::model_specs().iter().map(|(provider,model)|format!("{provider}/{model}")).collect::<Vec<_>>()},"avatars":true,"documents":cfg!(feature="documents"),"memory":memory::Brain::configured(),"channels":cfg!(feature="channels"),"computer":{"backend":self.computer.identity(),"configured":self.computer.configured(),"operations":self.computer.capabilities()}},"avatars":s.journal.objects::<avatars::Avatar>("avatar")?,"todos":s.journal.objects::<planner::Todo>("todo")?,"calendar_events":s.journal.objects::<planner::Event>("calendar_event")?,"connected_planner":connected_planner_snapshot(&s)?,"integrations":integrations::list(&s)?,"routing_shares":s.journal.objects::<routing_host::RoutingShare>("routing_share_v1")?,"routing_results":routing_dispatch::owner_results(&s)?,"workspace_id":s.journal.get::<String>("meta","workspace_id")?,"default_model":models::selected_llm(&s,&self.default_model)?,"model_settings":models::settings(&s)?,"profiles":profiles,"schedules":s.journal.list()?,"spaces":s.journal.objects::<documents::Space>("space")?,"reviews":s.journal.objects::<Review>("review")?.into_iter().filter(|r|!r.profile_id.is_empty()&&matches!(r.state.as_str(),"pending"|"approved"|"saved"|"declined")).collect::<Vec<_>>(),"goals":s.journal.objects::<Goal>("goal")?,"delegations":s.journal.objects::<Delegation>("delegation")?,"orchestration_plans":s.journal.objects::<orchestration::Plan>("orchestration_plan")?,"orchestration_runs":s.journal.objects::<orchestration::Run>("orchestration_run")?,"slack_bindings":s.journal.objects::<channels::SlackBinding>("slack_binding")?,"slack_outbox":s.journal.objects::<channels::Outbox>("slack_outbox")?,"voice_calls":s.journal.objects::<channels::Call>("voice_call")?,"connector_status":s.journal.objects::<Value>("connector_status")?,"connectors":{"computer":self.computer.configured(),"brain":memory::Brain::configured(),"voice":cfg!(feature="channels")&&std::env::var_os("OPENAI_API_KEY").is_some(),"slack":cfg!(feature="channels")&&std::env::var_os("GHOST_SLACK_APP_TOKEN").is_some()}}),
            )?;
        // The owner's main Ghost; a removed Ghost no longer counts.
        snapshot["default_ghost"] = json!(s.journal.get::<String>("meta", "default_ghost")?.filter(|id| s.profiles.contains_key(id)));
        #[cfg(feature = "lifetime")]
        { snapshot["integration_approvals"] = json!(integration_approvals::summaries(&s)?); }
        Ok(snapshot)
    }

    fn with_snapshot_authority(&self, _conn: &rusqlite::Connection, snapshot: Value) -> Result<Value> {
        #[cfg(feature = "lifetime")]
        let snapshot = {
            let mut snapshot = snapshot;
            let authority = lifetime::authority::current(_conn)?;
            snapshot["capabilities"]["integration_approvals"] = json!(true);
            snapshot["lifetime_authority"] = json!({
                "authority_epoch": authority.epoch,
                "dispatch_enabled": authority.dispatch_enabled && self.dispatch_enabled && authority.epoch == self.authority_epoch,
                "runtime_available": self.dispatch_enabled && lifetime_driver::runtime_configured(),
            });
            snapshot
        };
        Ok(snapshot)
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

    /// Long-poll variant of [`Self::events`]: returns as soon as the profile's
    /// durable session commits anything newer than `after`, or the current
    /// (possibly empty) list once `timeout` elapses. Waiting subscribes to the
    /// session's change signal and never drives execution. Sync-thread only:
    /// it parks the calling thread, so async callers must use a plain thread.
    pub fn events_wait(&self, profile_id: &str, after: u64, timeout: Duration) -> Result<Value> {
        if tokio::runtime::Handle::try_current().is_ok() {
            bail!("events_wait blocks its thread; call it from a plain (non-async) thread");
        }
        self.handle.block_on(async move {
            // Subscribe before the first read so a commit racing this call
            // still wakes the wait instead of being seen only on a re-poll.
            let mut watch = {
                let state = self.lock()?;
                let profile = state
                    .profiles
                    .get(profile_id)
                    .ok_or_else(|| anyhow!("profile missing"))?;
                profile.runtime.session.watch()
            };
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                // Host shutdown must not wait out the full poll deadline.
                if self.stopping.load(Ordering::Acquire) {
                    return self.events(profile_id, after);
                }
                let commits = self.events(profile_id, after)?;
                if commits.as_array().is_some_and(|list| !list.is_empty()) {
                    return Ok(commits);
                }
                if tokio::time::Instant::now() >= deadline {
                    return Ok(commits);
                }
                match tokio::time::timeout_at(deadline, watch.changed()).await {
                    Ok(Ok(())) => {}
                    // The watched session was replaced (profile recovery) and
                    // its sender is gone: pause briefly, then resubscribe.
                    Ok(Err(_)) => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        watch = {
                            let state = self.lock()?;
                            let profile = state
                                .profiles
                                .get(profile_id)
                                .ok_or_else(|| anyhow!("profile missing"))?;
                            profile.runtime.session.watch()
                        };
                    }
                    Err(_) => return self.events(profile_id, after),
                }
            }
        })
    }

    pub(crate) fn computer_backend(&self) -> &Arc<dyn computer::ComputerBackend> {
        &self.computer
    }

    pub(crate) fn track(&self, task: tokio::task::JoinHandle<()>) {
        let mut workers = self.workers.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopping.load(Ordering::Acquire) {
            task.abort();
        }
        // The handle is retained even for a task aborted while stopping: an
        // aborted future is dropped on a later scheduler tick, so discarding
        // the handle would let that teardown outlive shutdown() and drop(),
        // keeping the workspace lock alive against the next writer.
        workers.push(task);
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
        #[cfg(test)]
        if self.permits_legacy_fixture_reasoning() {
            self.start_legacy_fixture_worker(id.into(),runtime,concurrency);
            return Ok(json!({"profile_id":id,"state":"recovered"}));
        }
        self.start_worker(id.into(), runtime, concurrency);
        Ok(json!({"profile_id":id,"state":"recovered"}))
    }

    /// Stop dispatch and await task teardown. Durable work is retained for restart.
    /// Drop all Host handles afterwards to release the root and profile locks.
    ///
    /// Drains the worker list until one full round observes no workers, so a
    /// task spawned or tracked inside the shutdown window is aborted and joined
    /// here instead of finishing its teardown after this call. Every Host
    /// worker future is therefore complete before the caller drops the host
    /// and another writer opens the workspace.
    pub async fn shutdown(&self) -> Result<()> {
        self.integrations.clear();
        self.stopping.store(true, Ordering::Release);
        let mut failure = None;
        loop {
            let tasks = std::mem::take(
                &mut *self
                    .workers
                    .lock()
                    .map_err(|_| anyhow!("worker state unavailable"))?,
            );
            if tasks.is_empty() {
                break;
            }
            for task in &tasks {
                task.abort();
            }
            for task in tasks {
                if let Err(error) = task.await {
                    if !error.is_cancelled() {
                        failure = Some(anyhow!("Ghost worker shutdown failed: {error}"));
                    }
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
#[cfg(test)]
mod wake_tests;
#[cfg(all(test, feature = "documents"))]
mod workflow_tests;
#[cfg(all(test, feature = "lifetime", feature = "documents"))]
mod lifetime_documents_tests;
#[cfg(all(test, feature = "lifetime"))]
mod incidents_tests;
#[cfg(test)]
mod ghost_settings_tests;

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

#[cfg(all(test,feature="lifetime"))]
mod retirement_tests;
#[cfg(all(test, feature = "lifetime"))]
mod preservation_tests;
