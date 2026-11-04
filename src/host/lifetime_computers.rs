//! Operator-selected native runtimes. Model input never selects a computer or socket.
use super::{scheduler::Journal, Host, Profile};
use crate::{
    computers::{
        browser_service_binding, BrowserServiceBinding, ComputerRegistry,
        NativeWorkerBackendFacts, OwnedBrowser, OwnedBrowserComputer, OwnedBrowserConfig,
        OwnedBrowserLifecycle, RuntimeFacts,
    },
    lifetime_contract::{canonical_digest, ComputerBinding, Envelope, Response, ResponseStatus, RetryClass, VERSION},
    worker::{guest_broker::GuestModelBackend, GuestRunnerConfig},
};
use anyhow::{anyhow, ensure, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, OpenOptions}, io::Read, path::{Path, PathBuf}, sync::Arc};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};

const CONFIG_ENV: &str = "GHOST_LIFETIME_NATIVE_WORKERS_CONFIG";
const BACKEND: &str = "apple-native-omp";
const CAPABILITIES: [&str; 2] = ["persistent_filesystem", "shell"];
const BROWSER_CAPABILITIES: [&str; 2] = ["browser", "human_control"];
const TOOLS: [&str; 12] = ["read", "write", "edit", "bash", "grep", "glob", "ast_grep", "ast_edit", "eval", "todo", "publish_artifact", "browser"];
#[cfg(test)]
const PI_FIXTURE_CLI:&str="/bin/false";
#[cfg(test)]
const PI_FIXTURE_HOST:&str="pi-fixture-host";
const MAX_CONFIG_BYTES: u64 = 65_536;
const MAX_PROGRESS_BYTES: u64 = 1_048_576;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    registry_root: PathBuf,
    container_cli: PathBuf,
    accepted_capabilities: Vec<String>,
    routes: Vec<RouteConfiguration>,
    #[serde(default)]
    cleanup_origins: Vec<WorkerOrigin>,
    /// Explicit owned browser gate. Absent keeps today's browser-free
    /// native workers; present, every entry must attach to an existing
    /// route pair in this same configuration.
    #[serde(default)]
    browser: Option<BrowserConfiguration>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserConfiguration {
    /// Must be exactly the offered browser capability set; acceptance is
    /// never inferred and never includes shell or filesystem access.
    accepted_capabilities: Vec<String>,
    computers: Vec<OwnedBrowserComputer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteConfiguration {
    ghost_id: String,
    computer_id: String,
    worker_root: PathBuf,
    worker_socket: PathBuf,
    runner_config: PathBuf,
    model: String,
    thinking: String,
    privacy_classes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct WorkerOrigin {
    ghost_id: String,
    computer_id: String,
    worker_root: PathBuf,
    worker_socket: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HomePolicy<S, P> {
    ghost_id: S,
    computer_id: S,
    privacy_classes: P,
}

#[derive(Clone)]
struct Route {
    computer_id: String,
    model: String,
    thinking: String,
    privacy_classes: Vec<String>,
    deadline_ms: u64,
    /// Private browser grant: public-classified Goals never reach this
    /// route's model context — admission denies before DOM/text can flow.
    browser_private: bool,
    browser_enabled: bool,
    producer_profile_ref: Option<super::bots::RevisionRef>,
}

pub(crate) struct NativeComputers {
    registry: Arc<Mutex<ComputerRegistry>>,
    routes: BTreeMap<String, Route>,
    origins: BTreeMap<String, WorkerOrigin>,
    browser: Option<Arc<OwnedBrowser>>,
    authority_epoch: u64,
    /// Direct Pi tools use the container transport, never the legacy socket.
    pi_cli: Option<PathBuf>,
    pi_dynamic: Mutex<BTreeMap<String,Route>>,
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PiConfiguration {
    #[serde(default)]
    accepted_producer_profiles: Vec<super::lifetime::producer_profiles::OwnerAcceptedProfile>,
    registry_root: PathBuf,
    container_cli: PathBuf,
    accepted_capabilities: Vec<String>,
    routes: Vec<PiRoute>,
    #[serde(default)]
    browser: Option<BrowserConfiguration>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PiRoute {
    #[serde(default)]
    producer_profile_ref: Option<super::bots::RevisionRef>,
    ghost_id: String,
    computer_id: String,
    privacy_classes: Vec<String>,
    deadline_ms: u64,
}

pub(crate) struct PiEnvironment {
    pub(crate) ghost_id: String,
    pub(crate) manifest: crate::computers::HomeManifest,
    pub(crate) directory: PathBuf,
    pub(crate) container_cli: PathBuf,
    pub(crate) producer_profile: Option<crate::computers::AcceptedProducerProfile>,
}

#[derive(Serialize)]
pub(crate) struct NativeWorkerGrant<'a> {
    ghost_id: &'a str,
    computer_id: &'a str,
    authority_epoch: u64,
    task_snapshot_root: PathBuf,
    model: &'a str,
    thinking: &'a str,
    allowed_tools: &'static [&'static str],
    deadline_ms: u64,
    max_progress_bytes: u64,
    privacy_classes: &'a [String],
}

impl NativeWorkerGrant<'_> {
    pub(crate) fn permits_privacy(&self, privacy: &str) -> bool {
        self.privacy_classes.iter().any(|class| class == privacy)
    }

    /// Caller has already checked this Goal's privacy against the route.
    pub(crate) fn permits_spec(&self, spec: &Value) -> bool {
        let Some(execution_id) = spec.get("execution_id").and_then(Value::as_str) else { return false; };
        let Some(cwd) = spec.get("cwd").and_then(Value::as_str) else { return false; };
        if spec.get("computer_id").and_then(Value::as_str) != Some(self.computer_id)
            || spec.get("authority_epoch").and_then(Value::as_u64) != Some(self.authority_epoch)
            || spec.get("model").and_then(Value::as_str) != Some(self.model)
            || spec.get("thinking").and_then(Value::as_str) != Some(self.thinking)
            || !spec.get("allowed_tools").and_then(Value::as_array).is_some_and(|tools|
                tools.iter().map(Value::as_str).eq(self.allowed_tools.iter().map(|tool| Some(*tool))))
            || spec.get("deadline_ms").and_then(Value::as_u64) != Some(self.deadline_ms)
            || spec.get("max_progress_bytes").and_then(Value::as_u64) != Some(self.max_progress_bytes) {
            return false;
        }
        let directory = self.task_snapshot_root.join(format!("{:x}", Sha256::digest(execution_id.as_bytes())));
        directory.to_str() == Some(cwd)
    }
}

impl NativeComputers {
    #[cfg(test)]
    pub(crate) fn pi_fixture_allow_private(&mut self,ghost:&str)->Result<()> {
        if let Some(route)=self.routes.get_mut(ghost) {
            route.privacy_classes=vec!["private".into(),"local_only".into()];return Ok(());
        }
        let mut routes=self.pi_dynamic.lock();
        let route=routes.get_mut(ghost).ok_or_else(||anyhow!("Pi fixture route missing"))?;
        route.privacy_classes=vec!["private".into(),"local_only".into()];Ok(())
    }

    #[cfg(test)]
    pub(crate) fn pi_fixture_browser_instance(&self,ghost:&str)->Result<Option<Value>> {
        let computer=self.pi_computer(ghost).ok_or_else(||anyhow!("Pi fixture computer missing"))?;
        self.registry.lock().browser_instance(&computer)?.map(serde_json::to_value).transpose().map_err(Into::into)
    }

    #[cfg(test)]
    pub(crate) fn pi_fixture_replace_browser_instance(&self,instance:&Value)->Result<()> {
        self.registry.lock().register_browser_instance(&serde_json::from_value(instance.clone())?)
    }

    #[cfg(test)]
    pub(crate) fn pi_fixture_reopened_browser(&self)->Result<OwnedBrowser> {
        let config=OwnedBrowserConfig::from_computers(self.browser.as_ref().ok_or_else(||anyhow!("Pi fixture browser missing"))?.config_computers())?;
        Ok(OwnedBrowser::new(config,Arc::clone(&self.registry),self.authority_epoch).with_confinement(true).with_instance_recording(true).with_work_isolation(true))
    }
    #[cfg(test)]
    pub(crate) fn attach_pi_fixture_browser(&mut self,ghost:&str,executable:&Path,private:bool)->Result<()> {
        let route=self.routes.get_mut(ghost).ok_or_else(||anyhow!("Pi fixture route missing"))?;
        if private {route.privacy_classes=vec!["private".into(),"local_only".into()];}
        route.browser_enabled=true;route.browser_private=private;
        let executable=executable.canonicalize()?;
        let computer=OwnedBrowserComputer {ghost_id:ghost.into(),computer_id:route.computer_id.clone(),executable_sha256:crate::computers::local_browser::file_sha256(&executable)?,executable,headless:true,profile_scope:if private {"private"}else{"public"}.into()};
        let config=OwnedBrowserConfig::from_computers(vec![computer.clone()])?;
        let runtime=config.runtime_facts()?;
        let browser=Arc::new(OwnedBrowser::new(config,Arc::clone(&self.registry),self.authority_epoch).with_confinement(true).with_instance_recording(true).with_work_isolation(true));
        self.registry.lock().register_backend_with_runtime(Arc::clone(&browser) as Arc<dyn crate::adapters::computer::ComputerBackend>,true,BROWSER_CAPABILITIES.iter().map(|v|v.to_string()).collect(),Some(runtime))?;
        attach_owned_browser(&mut self.registry.lock(),&computer,&self.workspace_id,self.authority_epoch)?;
        self.browser=Some(browser);Ok(())
    }
    #[cfg(test)]
    pub(crate) fn set_pi_fixture_cli(&mut self,cli:&Path)->Result<()> {
        let cli=cli.canonicalize()?;
        ensure!(crate::computers::AppleContainerBackend::probe(&cli)?.available(),"Actual fixture container service unavailable");
        self.pi_cli=Some(cli);Ok(())
    }
    #[cfg(test)]
    pub(crate) fn select_pi_fixture_profile(&mut self,conn:&Connection,ghost:&str,reference:&super::bots::RevisionRef)->Result<()> {
        ensure!(self.workspace_id==PI_FIXTURE_HOST,"Profile fixture requires disposable registry");
        super::lifetime::producer_profiles::resolve(conn,reference)?;
        let route=self.routes.get_mut(ghost).ok_or_else(||anyhow!("Fixture Pi route missing"))?;
        super::lifetime::producer_profiles::select(conn,ghost,Some(reference))?;
        route.producer_profile_ref=(!super::lifetime::producer_profiles::is_legacy(reference)?).then(||reference.clone());
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn pi_fixture_snapshot(&self,ghost:&str,execution:&str,epoch:u64)->Result<PathBuf> {
        let computer=self.pi_computer(ghost).ok_or_else(||anyhow!("Pi fixture computer missing"))?;
        let home=self.registry.lock().inspect_worker_home(&computer,ghost,epoch)?.ok_or_else(||anyhow!("Pi fixture home unavailable"))?;
        Ok(home.task_snapshot_root.join(execution))
    }
    #[cfg(test)]
    pub(crate) fn pi_fixture(root:&Path,ghost:&str)->Result<Self> {Self::pi_fixture_at(root,ghost,1)}
    /// Explicit operator acceptance for epoch-boundary tests, using the real
    /// registry CAS/rebind path. The old NativeComputers stays fenced afterwards.
    #[cfg(test)]
    pub(crate) fn pi_fixture_accept_next_epoch(&self)->Result<()> {
        let mut routes=self.routes.clone();routes.extend(self.pi_dynamic.lock().clone());
        let mut registry=self.registry.lock();
        for (ghost,route) in routes {
            let prior=registry_request(&mut registry,&ghost,self.authority_epoch,json!({"method":"inspect","computer_id":route.computer_id}))?;
            ensure!(prior.status==ResponseStatus::Success,"fixture acceptance binding missing");
            let mut binding:ComputerBinding=serde_json::from_value(prior.data["binding"].clone())?;
            let expected=binding.grant_revision;ensure!(binding.epoch==self.authority_epoch,"fixture old epoch differs");
            binding.epoch+=1;binding.grant_revision+=1;
            let body=json!({"method":"bind","binding":binding});let command_id=uuid::Uuid::new_v4().to_string();
            let response=registry.handle(&Envelope{protocol_version:VERSION.into(),payload_digest:canonical_digest(&body)?,actor_ref:ghost.clone(),authority_epoch:self.authority_epoch,expected_revision:Some(expected),correlation_id:command_id.clone(),command_id,body},&ghost)?;
            ensure!(response.status==ResponseStatus::Success,"fixture explicit rebind failed: {}",response.summary);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn pi_fixture_at(root:&Path,ghost:&str,epoch:u64)->Result<Self> {
        let mut registry=ComputerRegistry::open(root)?;
        registry.register_native_worker_backend(NativeWorkerBackendFacts {configured:true,available:true},CAPABILITIES.iter().map(|v|v.to_string()).collect())?;
        let prior=registry_request(&mut registry,ghost,epoch,json!({"method":"inspect","computer_id":"pi-fixture"}))?;
        if prior.error_code.as_deref()==Some("not_found") {
            let response=registry_request(&mut registry,ghost,epoch,json!({"method":"bind","binding":{
                "computer_id":"pi-fixture","ghost_id":ghost,"backend":BACKEND,"host_id":"pi-fixture-host","epoch":epoch,
                "capabilities":CAPABILITIES,"accepted_capabilities":CAPABILITIES,"grant_revision":1}}))?;
            ensure!(response.status==ResponseStatus::Success,"Pi fixture binding failed: {}",response.summary);
        } else {
            ensure!(prior.status==ResponseStatus::Success && prior.data["binding"]["ghost_id"]==ghost && prior.data["binding"]["host_id"]=="pi-fixture-host" && prior.data["binding"]["epoch"]==epoch && prior.data["revoked"]==false,"Cold Pi fixture binding changed or was fenced");
        }
        Ok(Self {registry:Arc::new(Mutex::new(registry)),routes:BTreeMap::from([(ghost.into(),Route {computer_id:"pi-fixture".into(),model:String::new(),thinking:String::new(),privacy_classes:vec!["public".into()],deadline_ms:300_000,browser_private:false,browser_enabled:false,producer_profile_ref:None})]),
            origins:BTreeMap::new(),browser:None,authority_epoch:epoch,pi_cli:Some(PathBuf::from(PI_FIXTURE_CLI)),pi_dynamic:Mutex::new(BTreeMap::new()),workspace_id:PI_FIXTURE_HOST.into()})
    }
    /// Called only for dispatch-enabled startup, before any Host worker starts.
    pub(crate) fn from_environment(journal: &Journal, profiles: &BTreeMap<String, Profile>, epoch: u64) -> Result<Option<Self>> {
        if let Some(file) = std::env::var_os("GHOST_PI_COMPUTERS_CONFIG") {
            ensure!(std::env::var_os(CONFIG_ENV).is_none(), "select Pi computer configuration explicitly; legacy dispatch configuration cannot also be enabled");
            return Self::from_pi_configuration(journal, profiles, epoch, Path::new(&file)).map(Some);
        }
        let Some(file) = std::env::var_os(CONFIG_ENV) else { return Ok(None); };
        let mut config: Configuration = read_private_json(Path::new(&file))?;
        ensure!(!config.routes.is_empty() && config.routes.len() <= 64, "native routes must contain 1..=64 explicit Ghosts");
        config.accepted_capabilities.sort_unstable();
        ensure!(config.accepted_capabilities.iter().map(String::as_str).eq(CAPABILITIES), "native home requires exactly trusted shell and persistent filesystem acceptance");
        private_directory(&config.registry_root)?;
        let cli = config.container_cli.canonicalize().context("resolving native container CLI")?;
        let workspace_id = journal.get::<String>("meta", "workspace_id")?
            .ok_or_else(|| anyhow!("native computer provisioning requires a workspace identity"))?;
        let mut facts = NativeWorkerBackendFacts { configured: true, available: true };
        let mut prepared = Vec::with_capacity(config.routes.len());
        let mut runner_browsers: Vec<(String, String, PathBuf, String, bool, String)> = Vec::new();
        // Validate every selected runtime before writing bindings or home policy.
        for mut route in config.routes {
            uuid::Uuid::parse_str(&route.ghost_id)?;
            ensure!(profiles.contains_key(&route.ghost_id), "native route has no existing Ghost profile");
            let registered: bool = journal.0.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
                params![route.ghost_id], |row| row.get(0),
            )?;
            ensure!(registered, "native route Ghost is not canonically registered");
            ensure!(!route.computer_id.is_empty() && route.computer_id.len() <= 128
                && route.computer_id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')), "invalid native computer component");
            private_directory(&route.worker_root)?;
            ensure!(route.worker_socket.parent() == Some(route.worker_root.as_path()), "native socket must be directly inside its registered worker root");
            let socket = fs::symlink_metadata(&route.worker_socket)?;
            ensure!(socket.file_type().is_socket() && socket.uid() == unsafe { libc::geteuid() }
                && route.worker_socket.canonicalize()? == route.worker_socket, "native worker endpoint must be an owned canonical Unix socket");
            route.privacy_classes.sort_unstable();
            ensure!(!route.privacy_classes.is_empty()
                && route.privacy_classes.iter().all(|class| matches!(class.as_str(), "public" | "private" | "local_only"))
                && route.privacy_classes.windows(2).all(|classes| classes[0] != classes[1]), "invalid native privacy classes");
            let runner: GuestRunnerConfig = read_private_json(&route.runner_config)?;
            ensure!(runner.ghost_id == route.ghost_id
                && runner.computer_registry_root == config.registry_root
                && runner.container_cli.canonicalize()? == cli, "native runtime differs from its exact Ghost/registry/CLI route");
            let accepted: BTreeSet<&str> = runner.accepted_computer_capabilities.iter().map(String::as_str).collect();
            ensure!(accepted.len() == runner.accepted_computer_capabilities.len()
                && accepted.iter().copied().eq(CAPABILITIES), "native runtime trusted capabilities differ from its Host grant");
            let (provider, thinking) = match &runner.backend {
                GuestModelBackend::SubscriptionNative(_) => {
                    ensure!(route.privacy_classes == ["public"], "subscription native route cannot expose a protected home");
                    ("openai-codex/", "max")
                },
                GuestModelBackend::LocalHttp { .. } => ("local/", "off"),
            };
            ensure!(route.model.strip_prefix(provider) == Some(runner.model_id.as_str()) && route.thinking == thinking,
                "native route differs from its exact provider/model/thinking pin");
            let current = runner.worker_backend_facts()?;
            facts.configured &= current.configured;
            facts.available &= current.available;
            if let Some(browser) = &runner.browser {
                // The private scope is wired only to the keyless local model
                // route; subscription-native/public/cloud startup fails.
                ensure!(
                    browser.profile_scope != "private"
                        || matches!(runner.backend, GuestModelBackend::LocalHttp { .. }),
                    "a private browser worker grant requires the keyless local model route"
                );
                runner_browsers.push((
                    route.ghost_id.clone(),
                    route.computer_id.clone(),
                    browser.executable.clone(),
                    browser.executable_sha256.clone(),
                    matches!(runner.backend, GuestModelBackend::LocalHttp { .. }),
                    browser.profile_scope.clone(),
                ));
            }
            prepared.push((route, runner.deadline_ms));
        }
        {
            let mut ghosts = BTreeSet::new();
            let mut computers = BTreeSet::new();
            let mut worker_roots = BTreeSet::new();
            for (route, _) in &prepared {
                ensure!(ghosts.insert(route.ghost_id.as_str()) && computers.insert(route.computer_id.as_str())
                    && worker_roots.insert(route.worker_root.as_path()), "native Ghost/computer/worker roots must be distinct");
            }
        }
        let mut origins = load_worker_origins(journal)?;
        ensure!(config.cleanup_origins.len() <= 64, "too many explicit cleanup origins");
        for origin in config.cleanup_origins {
            ensure!(profiles.contains_key(&origin.ghost_id), "cleanup origin has no existing Ghost profile");
            let policy = journal.get::<HomePolicy<String, Vec<String>>>("meta", &format!("native_home_privacy:{}", origin.computer_id))?
                .ok_or_else(|| anyhow!("cleanup origin has no original Host home provenance"))?;
            ensure!(policy.ghost_id == origin.ghost_id && policy.computer_id == origin.computer_id,
                "cleanup origin differs from original Host home owner");
            validate_worker_origin(&origin)?;
            record_worker_origin(journal, &mut origins, origin)?;
        }
        for (route, _) in &prepared {
            record_worker_origin(journal, &mut origins, WorkerOrigin {
                ghost_id: route.ghost_id.clone(), computer_id: route.computer_id.clone(),
                worker_root: route.worker_root.clone(), worker_socket: route.worker_socket.clone(),
            })?;
        }
        let registry = Arc::new(Mutex::new(ComputerRegistry::open(&config.registry_root)?));
        let native_runtime = RuntimeFacts::new("apple-container", crate::computers::local_browser::file_sha256(&cli)?)?;
        registry.lock().register_native_worker_backend_with_runtime(facts, config.accepted_capabilities, Some(native_runtime))?;
        let mut routes = BTreeMap::new();
        let route_pairs: Vec<(String, String)> = prepared
            .iter()
            .map(|(route, _)| (route.ghost_id.clone(), route.computer_id.clone()))
            .collect();
        for (route, deadline_ms) in prepared {
            let inspection = registry_request(&mut registry.lock(), &route.ghost_id, epoch,
                json!({"method":"inspect", "computer_id":route.computer_id}))?;
            let policy_key = format!("native_home_privacy:{}", route.computer_id);
            let previous = journal.get::<HomePolicy<String, Vec<String>>>("meta", &policy_key)?;
            if let Some(policy) = previous.as_ref() {
                ensure!(policy.ghost_id == route.ghost_id && policy.computer_id == route.computer_id
                    && policy.privacy_classes == route.privacy_classes, "native home privacy provenance changed; explicit owner reconciliation is required");
            }
            if inspection.status == ResponseStatus::Success {
                ensure!(previous.is_some(), "existing native home has no Host privacy provenance; do not infer that it is public");
                let binding: ComputerBinding = serde_json::from_value(inspection.data.get("binding").cloned()
                    .ok_or_else(|| anyhow!("native computer inspection omitted binding"))?)?;
                ensure!(binding.ghost_id == route.ghost_id && binding.computer_id == route.computer_id
                    && binding.backend == BACKEND && binding.host_id == workspace_id && binding.epoch == epoch
                    && inspection.data.get("revoked") == Some(&Value::Bool(false))
                    && inspection.data.get("capability_downgrade") == Some(&Value::Bool(false)),
                    "native binding is foreign, revoked, stale or downgraded; no automatic rebind");
            } else {
                ensure!(inspection.error_code.as_deref() == Some("not_found"), "native computer inspection failed: {}", inspection.summary);
                if previous.is_none() {
                    journal.put("meta", &policy_key, &HomePolicy {
                        ghost_id: &route.ghost_id, computer_id: &route.computer_id,
                        privacy_classes: &route.privacy_classes,
                    })?;
                }
                let response = registry_request(&mut registry.lock(), &route.ghost_id, epoch,
                    json!({"method":"bind", "binding": {
                        "computer_id":route.computer_id, "ghost_id":route.ghost_id, "backend":BACKEND,
                        "host_id":workspace_id, "epoch":epoch, "capabilities":CAPABILITIES,
                        "accepted_capabilities":CAPABILITIES, "grant_revision":1,
                    }}))?;
                ensure!(response.status == ResponseStatus::Success, "native binding was not admitted: {}", response.summary);
            }
            let browser_scope = runner_browsers.iter()
                .find(|(ghost_id, computer_id, ..)| {
                    *ghost_id == route.ghost_id && *computer_id == route.computer_id
                })
                .map(|(.., scope)| scope.as_str());
            routes.insert(route.ghost_id, Route { computer_id: route.computer_id,
                model: route.model, thinking: route.thinking,
                privacy_classes: route.privacy_classes, deadline_ms,
                browser_private: browser_scope == Some("private"),
                browser_enabled: browser_scope.is_some(), producer_profile_ref:None });
        }
        // Explicit owned-browser gate: probed, registered on the same durable
        // registry, and attached per computer after its worker binding is current.
        let browser = match config.browser {
            Some(section) => {
                let mut accepted = section.accepted_capabilities.clone();
                accepted.sort();
                ensure!(accepted.iter().map(String::as_str).eq(BROWSER_CAPABILITIES),
                    "owned browser acceptance must be exactly browser and human_control");
                for computer in &section.computers {
                    ensure!(route_pairs.iter().any(|(ghost_id, computer_id)| {
                        *ghost_id == computer.ghost_id && *computer_id == computer.computer_id
                    }),
                        "owned browser computer must attach to an existing native worker route");
                    // A runner that carries browser facts must match this
                    // section exactly: one acceptance source, no partial grant.
                    let runner_pin = runner_browsers.iter().find(|(ghost_id, computer_id, ..)|
                        *ghost_id == computer.ghost_id && *computer_id == computer.computer_id);
                    ensure!(runner_pin.is_some(),
                        "Host browser computer {} has no worker browser grant; the worker cannot operate it",
                        computer.computer_id);
                    let (_, _, executable, sha, route_is_local, _) = runner_pin.unwrap();
                    ensure!(*executable == computer.executable && *sha == computer.executable_sha256,
                        "worker browser executable pin differs from its Host browser grant");
                    ensure!(computer.profile_scope != "private" || *route_is_local,
                        "a private Host browser grant requires the keyless local worker model route");
                }
                for (ghost_id, computer_id, ..) in &runner_browsers {
                    ensure!(section.computers.iter().any(|computer|
                        computer.ghost_id == *ghost_id && computer.computer_id == *computer_id),
                        "worker browser grant for computer {computer_id} has no Host browser section");
                }
                let service_config = OwnedBrowserConfig::from_computers(section.computers.clone())?;
                let runtime = service_config.runtime_facts()?;
                let browser = Arc::new(OwnedBrowser::new(service_config, Arc::clone(&registry), epoch));
                registry.lock().register_backend_with_runtime(
                    Arc::clone(&browser) as Arc<dyn crate::adapters::computer::ComputerBackend>,
                    true,
                    BROWSER_CAPABILITIES.iter().map(|capability| capability.to_string()).collect(),
                    Some(runtime),
                )?;
                for computer in &section.computers {
                    attach_owned_browser(&mut registry.lock(), computer, &workspace_id, epoch)?;
                }
                Some(browser)
            }
            None => None,
        };
        Ok(Some(Self { registry, routes, origins, browser, authority_epoch: epoch, pi_cli: None,pi_dynamic:Mutex::new(BTreeMap::new()),workspace_id }))
    }

    /// Trusted Host startup entry point. The same strict private Owner file
    /// validation applies as for from_environment; no model supplies this path.
    pub(crate) fn from_pi_configuration(journal: &Journal, profiles: &BTreeMap<String, Profile>, epoch: u64, file: &Path) -> Result<Self> {
        let mut config: PiConfiguration = read_private_json(file)?;
        config.accepted_capabilities.sort_unstable();
        ensure!(config.accepted_capabilities.iter().map(String::as_str).eq(CAPABILITIES), "Pi requires explicit shell and persistent filesystem acceptance");
        ensure!(!config.routes.is_empty() && config.routes.len() <= 64, "Pi routes must contain 1..=64 Ghosts");
        private_directory(&config.registry_root)?;
        let cli = config.container_cli.canonicalize()?;
        let probe = crate::computers::AppleContainerBackend::probe(&cli)?;
        ensure!(probe.available(), "Pi container service is not available");
        let cli_sha256=crate::computers::local_browser::file_sha256(&cli)?;
        let workspace_id = journal.get::<String>("meta", "workspace_id")?.ok_or_else(|| anyhow!("Pi requires workspace identity"))?;
        let mut registry = ComputerRegistry::open(&config.registry_root)?;
        // The registry identity is retained so existing home ownership, layout,
        // fencing and leases remain authoritative. No OMP runner is constructed.
        registry.register_native_worker_backend_with_runtime(NativeWorkerBackendFacts { configured: true, available: true },
            config.accepted_capabilities, Some(RuntimeFacts::new("apple-container", crate::computers::local_browser::file_sha256(&cli)?)?))?;
        ensure!(config.accepted_producer_profiles.len()<=32,"Too many Owner accepted producer profiles");
        for accepted in config.accepted_producer_profiles { super::lifetime::producer_profiles::accept_config(&journal.0,accepted)?; }
        let mut routes = BTreeMap::new();
        let mut computers = BTreeSet::new();
        for mut route in config.routes {
            ensure!(profiles.contains_key(&route.ghost_id), "Pi route requires an existing Ghost");
            ensure!(!routes.contains_key(&route.ghost_id) && computers.insert(route.computer_id.clone()), "Pi Ghost/computer routes must be distinct");
            ensure!(route.deadline_ms > 0 && route.deadline_ms <= 1_800_000, "Pi deadline must be bounded");
            if let Some(reference)=route.producer_profile_ref.as_ref() {
                if let Some(profile)=super::lifetime::producer_profiles::resolve(&journal.0,reference)? {
                    ensure!(profile.runtime_facts().container_cli_sha256==cli_sha256
                        && profile.runtime_facts().sandbox_uid==unsafe {libc::geteuid()}
                        && profile.runtime_facts().sandbox_gid==unsafe {libc::getegid()},"Selected producer profile probe belongs to another CLI or sandbox identity");
                }
            }
            route.privacy_classes.sort_unstable();
            ensure!(!route.privacy_classes.is_empty() && route.privacy_classes.iter().all(|p| matches!(p.as_str(), "public" | "private" | "local_only"))
                && route.privacy_classes.windows(2).all(|p| p[0] != p[1]), "invalid Pi privacy classes");
            let policy_key = format!("native_home_privacy:{}", route.computer_id);
            let previous = journal.get::<HomePolicy<String, Vec<String>>>("meta", &policy_key)?;
            if let Some(policy) = previous.as_ref() {
                ensure!(policy.ghost_id == route.ghost_id && policy.computer_id == route.computer_id && policy.privacy_classes == route.privacy_classes,
                    "Pi home privacy provenance changed; explicit reconciliation required");
            }
            let inspection = registry_request(&mut registry, &route.ghost_id, epoch, json!({"method":"inspect","computer_id":route.computer_id}))?;
            if inspection.status == ResponseStatus::Success {
                ensure!(previous.is_some(), "existing Pi home lacks Host privacy provenance");
                let binding: ComputerBinding = serde_json::from_value(inspection.data["binding"].clone())?;
                ensure!(binding.ghost_id == route.ghost_id && binding.backend == BACKEND && binding.host_id == workspace_id
                    && binding.epoch == epoch && inspection.data["revoked"] == false && inspection.data["capability_downgrade"] == false,
                    "Pi home is foreign, fenced, revoked or downgraded");
            } else {
                ensure!(inspection.error_code.as_deref() == Some("not_found"), "Pi computer inspection failed");
                journal.put("meta", &policy_key, &HomePolicy { ghost_id: &route.ghost_id, computer_id: &route.computer_id, privacy_classes: &route.privacy_classes })?;
                let response = registry_request(&mut registry, &route.ghost_id, epoch, json!({"method":"bind","binding":{
                    "computer_id":route.computer_id,"ghost_id":route.ghost_id,"backend":BACKEND,"host_id":workspace_id,
                    "epoch":epoch,"capabilities":CAPABILITIES,"accepted_capabilities":CAPABILITIES,"grant_revision":1}}))?;
                ensure!(response.status == ResponseStatus::Success, "Pi home binding rejected: {}", response.summary);
            }
            super::lifetime::producer_profiles::select(&journal.0,&route.ghost_id,route.producer_profile_ref.as_ref())?;
            routes.insert(route.ghost_id, Route { computer_id: route.computer_id, model: String::new(), thinking: String::new(),
                privacy_classes: route.privacy_classes, deadline_ms: route.deadline_ms, browser_private: false, browser_enabled: false, producer_profile_ref:route.producer_profile_ref });
        }
        let registry=Arc::new(Mutex::new(registry));
        let browser=if let Some(section)=config.browser {
            let mut accepted=section.accepted_capabilities; accepted.sort();
            ensure!(accepted.iter().map(String::as_str).eq(BROWSER_CAPABILITIES),"Pi browser requires explicit browser and human_control acceptance");
            for computer in &section.computers {
                let route=routes.get_mut(&computer.ghost_id).ok_or_else(||anyhow!("Pi browser requires an existing Ghost route"))?;
                ensure!(route.computer_id==computer.computer_id,"Pi browser must match its accepted computer");
                ensure!(computer.profile_scope!="private" || route.privacy_classes.iter().all(|privacy|privacy!="public"),"Private Pi browser requires a protected-only execution route");
                route.browser_enabled=true;
                route.browser_private=computer.profile_scope=="private";
            }
            let service=OwnedBrowserConfig::from_computers(section.computers.clone())?;
            let runtime=service.runtime_facts()?;
            let browser=Arc::new(OwnedBrowser::new(service,Arc::clone(&registry),epoch).with_confinement(true).with_instance_recording(true).with_work_isolation(true));
            registry.lock().register_backend_with_runtime(Arc::clone(&browser) as Arc<dyn crate::adapters::computer::ComputerBackend>,true,
                BROWSER_CAPABILITIES.iter().map(|v|v.to_string()).collect(),Some(runtime))?;
            for computer in &section.computers { attach_owned_browser(&mut registry.lock(),computer,&workspace_id,epoch)?; }
            Some(browser)
        } else { None };
        let computers=Self { registry, routes, origins: load_worker_origins(journal)?, browser,
            authority_epoch: epoch, pi_cli: Some(cli),pi_dynamic:Mutex::new(BTreeMap::new()),workspace_id };
        computers.restore_provisioned_pi_routes(&journal.0,profiles)?;
        Ok(computers)
    }

    /// Reloads only the immutable provisioned route graph using bindings that
    /// are already accepted at this NativeComputers' current epoch. It never
    /// advances registry authority or repairs a fenced/revoked binding.
    pub(crate) fn restore_provisioned_pi_routes(&self,conn:&Connection,profiles:&BTreeMap<String,Profile>)->Result<()> {
        let mut query=conn.prepare("SELECT payload FROM workspace_objects WHERE kind='pi_provisioned_route' ORDER BY id")?;
        let mut saved=query.query_map([],|r|r.get::<_,String>(0))?.map(|raw|Ok(serde_json::from_str::<Value>(&raw?)?)).collect::<Result<Vec<_>>>()?;
        drop(query);
        ensure!(saved.len()<=64,"Too many provisioned Pi routes");
        while !saved.is_empty() {
            let before=saved.len();let mut remaining=vec![];
            for entry in saved {
                let ghost=entry["ghost_id"].as_str().ok_or_else(||anyhow!("Provisioned Pi Ghost missing"))?;
                let issuer=entry["issuer_ghost"].as_str().ok_or_else(||anyhow!("Provisioned Pi issuer missing"))?;
                ensure!(profiles.contains_key(ghost),"Provisioned Pi Ghost profile is missing");
                if self.pi_route(issuer).is_some() {
                    let profile=Self::saved_pi_profile(&entry)?;
                    self.provision_pi_ghost_with_profile(conn,issuer,ghost,self.authority_epoch,&profile)?;
                }
                else {remaining.push(entry);}
            }
            ensure!(remaining.len()<before,"Provisioned Pi issuer graph has no accepted root or has a cycle");saved=remaining;
        }
        Ok(())
    }

    fn pi_route(&self,ghost:&str)->Option<Route> {self.routes.get(ghost).cloned().or_else(||self.pi_dynamic.lock().get(ghost).cloned())}

    pub(crate) fn pi_profile_ref(&self,ghost:&str)->Result<super::bots::RevisionRef> {
        self.pi_route(ghost).ok_or_else(||anyhow!("Pi profile route missing"))?.producer_profile_ref.map(Ok).unwrap_or_else(super::lifetime::producer_profiles::legacy_ref)
    }

    fn saved_pi_profile(record:&Value)->Result<super::bots::RevisionRef> {
        match record["profile"].as_str() {
            Some("pi-default/1")=>{ensure!(record.get("producer_profile_ref").is_none(),"Legacy provisioned profile contains a foreign pin");super::lifetime::producer_profiles::legacy_ref()},
            Some("pi-producer/1")=>Ok(serde_json::from_value(record["producer_profile_ref"].clone())?),
            _=>Err(anyhow!("Unknown provisioned Pi profile")),
        }
    }

    pub(crate) fn pi_provisioned_profile_matches(&self,record:&Value,reference:&super::bots::RevisionRef)->Result<bool> {
        Ok(Self::saved_pi_profile(record)?==*reference)
    }

    /// Producer observations resolve the original assignment, never today's
    /// issuer/default route. Independent verification uses its legacy plan.
    pub(crate) fn pi_work_execution_environment(&self,conn:&Connection,work:&crate::lifetime_contract::Work)->Result<Option<Value>> {
        let Some(legacy)=self.pi_execution_environment(&work.owner) else {return Ok(None)};
        match super::lifetime::work_context::producer_profile(conn,work)? {
            Some(profile)=>Ok(Some(profile.environment())),None=>Ok(Some(legacy)),
        }
    }

    pub(crate) fn pi_computer(&self,ghost:&str)->Option<String> {self.pi_route(ghost).map(|route|route.computer_id)}

    pub(crate) fn pi_available(&self, ghost: &str, epoch: u64, privacy: &str) -> Result<bool> {
        let Some(route)=self.pi_route(ghost) else {return Ok(false);};
        Ok(self.pi_cli.is_some() && epoch == self.authority_epoch && route.privacy_classes.iter().any(|p|p==privacy)
            && self.registry.lock().inspect_worker_home(&route.computer_id,ghost,epoch)?.is_some())
    }

    /// Selected execution policy only; availability remains a separate guard.
    /// Test routes can use either simulated tools or an actual selected Apple
    /// CLI, so fixture registry identity alone never implies simulation.
    pub(crate) fn pi_execution_environment(&self,ghost:&str)->Option<Value> {
        self.pi_route(ghost)?;
        let _cli=self.pi_cli.as_ref()?;
        #[cfg(test)]
        if _cli.as_path()==Path::new(PI_FIXTURE_CLI) {
            return Some(json!({"version":"ghost-execution-environment/1","evidence":"fixture","backend":"fixture","route":"fixture","simulated":true}));
        }
        let mut policy=crate::computers::AppleContainerBackend::configured_producer_environment();
        let route="configured";
        #[cfg(test)]
        let route=if self.workspace_id==PI_FIXTURE_HOST {"fixture"}else{route};
        policy["route"]=json!(route);
        Some(policy)
    }

    pub(crate) fn pi_deadline(&self, ghost: &str) -> Result<u64> {
        self.pi_route(ghost).map(|route| route.deadline_ms).ok_or_else(|| anyhow!("Pi route missing"))
    }

    pub(crate) fn pi_browser_available(&self, ghost:&str)->bool {
        self.pi_cli.is_some() && self.browser.is_some() && self.routes.get(ghost).is_some_and(|route|route.browser_enabled)
    }

    pub(crate) fn pi_browser_private(&self,ghost:&str)->bool {self.routes.get(ghost).is_some_and(|route|route.browser_private)}

    pub(crate) async fn pi_browser_execute(&self,ghost:&str,execution:&str,operation:crate::adapters::computer::BrowserOperation,
        authorize:crate::adapters::computer::Authorize<'_>)->Result<Value> {
        ensure!(self.pi_browser_available(ghost),"Pi browser is not granted");
        self.browser.as_ref().unwrap().scoped_execute(ghost,execution,operation,authorize).await
    }

    pub(crate) async fn pi_browser_proposal(&self,ghost:&str,execution:&str,digest:&str,args:&Value)->Result<crate::computers::BrowserAction> {
        let browser=self.browser.as_ref().ok_or_else(||anyhow!("Pi browser missing"))?;
        let computer=browser.computer_id_for(ghost)?;
        if let Some(prior)=self.registry.lock().browser_action_for_input(&computer,execution,digest,self.authority_epoch)? {return Ok(prior);}
        let reference=args["ref"].as_str().ok_or_else(||anyhow!("Exact observed browser target required"))?;
        let snapshot=args["snapshot_id"].as_u64().ok_or_else(||anyhow!("Exact observed browser snapshot required"))?;
        let target=browser.target_label(ghost,execution,reference,snapshot).ok_or_else(||anyhow!("Browser observation stale"))?;
        let detail=serde_json::json!({"operation":args["operation"],"arguments":args,"url":target["url"],"snapshot_id":snapshot,"target":target,"authority_epoch":self.authority_epoch});
        ensure!(browser.verify_live_target(ghost,execution,&detail).await?,"Browser target no longer matches observation");
        let id=self.registry.lock().propose_browser_action(&computer,ghost,execution,digest,self.authority_epoch,&detail)?;
        self.registry.lock().browser_action(&id)?.ok_or_else(||anyhow!("Browser proposal missing"))
    }

    pub(crate) async fn pi_browser_approval_current(&self,ghost:&str,execution:&str,action:&crate::computers::BrowserAction)->Result<bool> {
        ensure!(action.execution_id==execution && action.requested_epoch==self.authority_epoch,"Browser action scope changed");
        self.browser.as_ref().ok_or_else(||anyhow!("Pi browser missing"))?.verify_live_target(ghost,execution,&action.detail).await
    }
    pub(crate) fn pi_browser_decide(&self,action:&str,approve:bool)->Result<crate::computers::BrowserAction> {
        self.registry.lock().decide_browser_action(action,"owner",approve)
    }
    pub(crate) fn pi_browser_claim(&self,action:&str,digest:&str)->Result<()> {
        self.registry.lock().record_browser_action_effect(action,digest)
    }

    pub(crate) async fn pi_browser_gesture(&self,ghost:&str,execution:&str,args:&Value,authorize:crate::adapters::computer::Authorize<'_>)->Result<Value> {
        self.browser.as_ref().ok_or_else(||anyhow!("Pi browser missing"))?.scoped_targeted_gesture(ghost,execution,args,authorize).await
    }

    pub(crate) async fn pi_browser_stop(&self,ghost:&str,execution:&str)->Result<()> {
        if let Some(browser)=&self.browser {
            browser.stop_scoped_session(ghost,execution).await?;
        }
        Ok(())
    }

    pub(crate) fn pi_acquire(&self, ghost: &str, execution: &str, epoch: u64, privacy: &str) -> Result<PiEnvironment> {
        ensure!(self.pi_available(ghost, epoch, privacy)?, "no current Pi computer grant");
        let computer_id = self.pi_computer(ghost).ok_or_else(||anyhow!("Pi route missing"))?;
        let manifest = self.registry.lock().acquire_worker_home(&computer_id, ghost, execution, epoch)?;
        let directory = manifest.task_snapshot_root.join(execution);
        if !directory.exists() {
            // execution is the Host-derived lowercase SHA-256 component.
            crate::worker::native_tools::create_execution_workspace(&manifest.task_snapshot_root, execution)
                .map_err(|error| anyhow!(error.code))?;
        }
        crate::worker::native_tools::NativeWorkspace::open(&directory).map_err(|error| anyhow!(error.code))?;
        Ok(PiEnvironment { ghost_id:ghost.into(), manifest, directory, container_cli: self.pi_cli.as_ref().unwrap().clone(), producer_profile:None })
    }

    pub(crate) fn pi_current(&self, ghost: &str, execution: &str, computer: &str, epoch: u64, privacy: &str) -> Result<bool> {
        Ok(self.pi_available(ghost, epoch, privacy)? && self.pi_computer(ghost).as_deref() == Some(computer)
            && self.registry.lock().worker_home_is_current(computer, ghost, execution, epoch)?)
    }

    pub(crate) fn pi_release(&self, ghost: &str, execution: &str, epoch: u64) -> Result<()> {
        let route = self.pi_route(ghost).ok_or_else(|| anyhow!("Pi route missing"))?;
        self.registry.lock().release_worker_home(&route.computer_id, ghost, execution, epoch)
    }

    pub(crate) fn pi_release_cancelled(&self, computer: &str, ghost: &str, execution: &str, epoch: u64) -> Result<()> {
        self.registry.lock().release_worker_home_if_acquired(computer, ghost, execution, epoch)
    }

    /// Provision only the caller's already accepted Pi execution profile.
    /// All paths, capabilities and computer identity are Host-derived. This
    /// crosses the registry database boundary; call outside a Host transaction.
    pub(crate) fn provision_pi_ghost(&self,conn:&Connection,issuer:&str,ghost:&str,epoch:u64,profile:&str)->Result<Value> {
        ensure!(conn.is_autocommit(),"Pi provisioning must not run inside the Host command transaction");
        ensure!(profile=="pi-default/1","Unsupported historical Pi execution profile");
        self.provision_pi_ghost_with_profile(conn,issuer,ghost,epoch,&super::lifetime::producer_profiles::legacy_ref()?)
    }

    pub(crate) fn provision_pi_ghost_with_profile(&self,conn:&Connection,issuer:&str,ghost:&str,epoch:u64,profile:&super::bots::RevisionRef)->Result<Value> {
        ensure!(conn.is_autocommit(),"Pi provisioning must not run inside the Host command transaction");
        ensure!(self.pi_cli.is_some() && epoch==self.authority_epoch,"Pi execution profile unavailable or fenced");
        super::lifetime::producer_profiles::resolve(conn,profile)?;
        uuid::Uuid::parse_str(ghost)?;
        let source=self.pi_route(issuer).ok_or_else(||anyhow!("Issuer has no accepted Pi execution profile"))?;
        ensure!(self.pi_available(issuer,epoch,source.privacy_classes.first().ok_or_else(||anyhow!("Issuer privacy profile empty"))?)?,"Issuer Pi profile no longer current");
        let computer=format!("pi-bot-{}",&format!("{:x}",Sha256::digest(ghost.as_bytes()))[..32]);
        let mut record=json!({"ghost_id":ghost,"issuer_ghost":issuer,"computer_id":computer,"privacy_classes":source.privacy_classes,"deadline_ms":source.deadline_ms,"profile":"pi-default/1"});
        if !super::lifetime::producer_profiles::is_legacy(profile)? { record["profile"]=json!("pi-producer/1");record["producer_profile_ref"]=serde_json::to_value(profile)?; }
        let prior:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='pi_provisioned_route' AND id=?1",[ghost],|r|r.get(0)).optional()?;
        if let Some(prior)=prior {ensure!(serde_json::from_str::<Value>(&prior)?==record,"Provisioned Pi route changed; explicit reconciliation required");}
        else {ensure!(self.pi_profile_ref(issuer)?==*profile,"New bot profile must match its issuer Owner-selected profile");}
        ensure!(!self.routes.contains_key(ghost),"Ghost already has a static operator Pi route");
        {let dynamic=self.pi_dynamic.lock();ensure!(dynamic.contains_key(ghost)||dynamic.len()<64,"Provisioned Pi route limit reached");}
        let policy_key=format!("native_home_privacy:{computer}");
        let policy=json!({"ghost_id":ghost,"computer_id":computer,"privacy_classes":source.privacy_classes});
        let existing_policy:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='meta' AND id=?1",[&policy_key],|r|r.get(0)).optional()?;
        if let Some(existing)=existing_policy {ensure!(serde_json::from_str::<Value>(&existing)?==policy,"Provisioned Pi privacy provenance conflict");}
        else {conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES('meta',?1,?2)",params![policy_key,serde_json::to_string(&policy)?])?;}
        let mut registry=self.registry.lock();
        let inspected=registry_request(&mut registry,ghost,epoch,json!({"method":"inspect","computer_id":computer}))?;
        if inspected.error_code.as_deref()==Some("not_found") {
            let response=registry_request(&mut registry,ghost,epoch,json!({"method":"bind","binding":{"computer_id":computer,"ghost_id":ghost,"backend":BACKEND,"host_id":self.workspace_id,"epoch":epoch,"capabilities":CAPABILITIES,"accepted_capabilities":CAPABILITIES,"grant_revision":1}}))?;
            ensure!(response.status==ResponseStatus::Success,"Provisioned Pi computer bind failed: {}",response.summary);
        } else {
            ensure!(inspected.status==ResponseStatus::Success && inspected.data["binding"]["ghost_id"]==ghost && inspected.data["binding"]["host_id"]==self.workspace_id
                && inspected.data["binding"]["backend"]==BACKEND && inspected.data["binding"]["epoch"]==epoch && inspected.data["revoked"]==false && inspected.data["capability_downgrade"]==false,
                "Provisioned Pi home is foreign, revoked, fenced or downgraded");
        }
        ensure!(registry.inspect_worker_home(&computer,ghost,epoch)?.is_some(),"Provisioned Pi home is not ready");drop(registry);
        #[cfg(test)]
        {
            let fault:Option<String>=conn.query_row("SELECT f.payload FROM workspace_objects f JOIN workspace_objects c ON c.kind='bot_candidate_v1' AND c.id=f.id WHERE f.kind='bot_provisioning_test_fault' AND json_extract(c.payload,'$.definition.ghost_id')=?1 AND json_extract(f.payload,'$.stage')='environment_registry_commit'",[ghost],|r|r.get(0)).optional()?;
            if let Some(raw)=fault {
                let fault:Value=serde_json::from_str(&raw)?;
                let parent=std::env::var_os("GHOST_A03_CRASH_PARENT").map(PathBuf::from)
                    .ok_or_else(||anyhow!("A03 registry-boundary exit requires its private child root"))?;
                ensure!(fault["behavior"]=="exit-process" && parent.is_absolute() && parent.is_dir()
                    && fault["parent_root"].as_str()==parent.to_str()
                    && self.workspace_id==PI_FIXTURE_HOST && self.pi_cli.as_deref()==Some(Path::new(PI_FIXTURE_CLI)),
                    "A03 registry-boundary exit requires the declared disposable fixture");
                // Registry/home committed, but the Host route and dynamic map
                // do not exist yet. Exit without unwinding or phase projection.
                std::process::exit(73);
            }
        }
        conn.execute("INSERT OR IGNORE INTO workspace_objects(kind,id,payload) VALUES('pi_provisioned_route',?1,?2)",params![ghost,serde_json::to_string(&record)?])?;
        super::lifetime::producer_profiles::select(conn,ghost,Some(profile))?;
        self.pi_dynamic.lock().insert(ghost.into(),Route {computer_id:computer.clone(),model:String::new(),thinking:String::new(),privacy_classes:source.privacy_classes,deadline_ms:source.deadline_ms,browser_private:false,browser_enabled:false,producer_profile_ref:(!super::lifetime::producer_profiles::is_legacy(profile)?).then(||profile.clone())});
        let mut response=json!({"engine":"pi","execution_profile":"pi-default/1","ghost_id":ghost,"computer_id":computer,"authority_epoch":epoch,"ready":true});
        if !super::lifetime::producer_profiles::is_legacy(profile)? {response["execution_profile"]=json!("pi-producer/1");response["producer_profile_ref"]=serde_json::to_value(profile)?;}
        Ok(response)
    }

    /// The Ghost's current native computer identity, when routed here.
    pub(crate) fn route_computer(&self, ghost_id: &str) -> Option<&str> {
        self.routes.get(ghost_id).map(|route| route.computer_id.as_str())
    }

    /// The owned browser backend for Host conversation tools, when configured.
    pub(crate) fn conversation_backend(&self) -> Option<Arc<dyn crate::adapters::computer::ComputerBackend>> {
        self.browser.as_ref().map(|browser| Arc::clone(browser) as _)
    }

    /// Registry-authorized lifecycle execution for the owned browser. The
    /// Host keeps a recreated runtime running; callers without session
    /// ownership verify and stop instead.
    pub(crate) fn lifecycle_executor(&self, keep_running: bool) -> Option<OwnedBrowserLifecycle<'_>> {
        self.browser.as_ref().map(|browser| OwnedBrowserLifecycle { browser, keep_running })
    }

    /// Owner control-plane lifecycle: authorize through the durable registry,
    /// execute through the owning Host, record the effect receipt.
    pub(crate) fn execute_lifecycle(&self, ghost_id: &str, operation: &str) -> Result<Response> {
        ensure!(matches!(operation, "idle_stop" | "recreate" | "stop"),
            "unsupported lifecycle operation");
        let route = self.routes.get(ghost_id)
            .ok_or_else(|| anyhow!("this Ghost has no native computer route"))?;
        let executor = self.lifecycle_executor(true)
            .ok_or_else(|| anyhow!("no owned browser is configured for this host"))?;
        let body = json!({"method": if operation == "stop" { "idle_stop" } else { operation },
                          "computer_id": route.computer_id});
        let command_id = uuid::Uuid::new_v4().to_string();
        let envelope = Envelope {
            protocol_version: VERSION.into(),
            payload_digest: canonical_digest(&body)?,
            actor_ref: ghost_id.to_owned(),
            authority_epoch: self.authority_epoch,
            expected_revision: None,
            correlation_id: command_id.clone(),
            command_id,
            body,
        };
        self.registry.lock().handle_lifecycle(&envelope, ghost_id, &executor)
    }

    /// Whether this Ghost's route grants a private browser profile.
    pub(crate) fn route_is_private_browser(&self, ghost_id: &str) -> Option<bool> {
        self.routes.get(ghost_id).map(|route| route.browser_private)
    }

    /// Pending browser actions for this Ghost's computer — the owner approval
    /// surface reads the exact normalized details, never a bare digest.
    pub(crate) fn pending_browser_actions(&self, ghost_id: &str) -> Result<Vec<crate::computers::BrowserAction>> {
        let route = self.routes.get(ghost_id)
            .ok_or_else(|| anyhow!("this Ghost has no native computer route"))?;
        self.registry.lock().pending_browser_actions(&route.computer_id)
    }

    /// The one browser action by identity, only when this Ghost's computer
    /// route owns it. Unknown or foreign actions read as absent so the owner
    /// decision surface can never decide another Ghost's proposal.
    pub(crate) fn owned_browser_action(
        &self,
        ghost_id: &str,
        action_id: &str,
    ) -> Result<Option<crate::computers::BrowserAction>> {
        let Some(route) = self.routes.get(ghost_id) else { return Ok(None); };
        let Some(action) = self.registry.lock().browser_action(action_id)? else { return Ok(None); };
        Ok((action.computer_id == route.computer_id).then_some(action))
    }

    pub(crate) fn grant<'a>(&'a self, ghost_id: &'a str, epoch: u64) -> Result<Option<NativeWorkerGrant<'a>>> {
        let Some(route) = self.routes.get(ghost_id) else { return Ok(None); };
        let home = self.registry.lock().inspect_worker_home(&route.computer_id, ghost_id, epoch)?;
        Ok(home.map(|home| NativeWorkerGrant { ghost_id, computer_id: &route.computer_id,
            authority_epoch: epoch, task_snapshot_root: home.task_snapshot_root,
            model: &route.model, thinking: &route.thinking,
            allowed_tools: if route.browser_enabled { &TOOLS } else { &TOOLS[..TOOLS.len() - 1] },
            deadline_ms: route.deadline_ms, max_progress_bytes: MAX_PROGRESS_BYTES,
            privacy_classes: &route.privacy_classes }))
    }

    pub(crate) fn socket_for_computer(&self, ghost_id: &str, computer_id: &str) -> Option<&Path> {
        self.origins.get(computer_id).filter(|origin| origin.ghost_id == ghost_id)
            .map(|origin| origin.worker_socket.as_path())
    }

    pub(crate) fn socket_is_current(&self, ghost_id: &str, socket: &Path) -> bool {
        self.routes.get(ghost_id).and_then(|route| self.socket_for_computer(ghost_id, &route.computer_id))
            == Some(socket)
    }

    /// Historical control follows the exact committed execution, never today's Ghost route.
    pub(crate) fn socket_for_execution(&self, conn: &Connection, work_id: &str, ghost_id: &str, execution_id: &str) -> Result<Option<&Path>> {
        let mut statement = conn.prepare(
            "SELECT DISTINCT json_extract(request,'$.body.spec.computer_id')
             FROM lifetime_commands
             WHERE json_extract(request,'$.body.method')='work.submit'
               AND json_extract(request,'$.body.work_id')=?1
               AND json_extract(request,'$.body.spec.work_id')=?1
               AND json_extract(request,'$.body.spec.execution_id')=?2
               AND json_extract(response,'$.status')='success'
               AND json_extract(response,'$.data.execution_id')=?2
               AND json_extract(response,'$.data.work.owner')=?3
             LIMIT 2")?;
        let mut rows = statement.query(params![work_id, execution_id, ghost_id])?;
        let Some(row) = rows.next()? else { return Ok(None); };
        let computer_id: String = row.get(0)?;
        ensure!(rows.next()?.is_none(), "execution has ambiguous original computer provenance");
        Ok(self.socket_for_computer(ghost_id, &computer_id))
    }

}

impl Host {
    /// Native policy applies to fresh owner effects, not historical receipt replay.
    pub(crate) fn native_work_admission(&self, conn: &Connection, envelope: &Envelope) -> Result<Option<Response>> {
        let method = envelope.body.get("method").and_then(Value::as_str);
        if !matches!(method, Some("work.submit" | "work.steer")) { return Ok(None); }
        let work_id = envelope.body.get("work_id").and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Native Work admission has no Work identity"))?;
        let scope: Option<(String, String)> = conn.query_row(
            "SELECT json_extract(w.payload,'$.owner'),g.privacy FROM lifetime_work w JOIN lifetime_goals g ON g.id=w.goal_id WHERE w.id=?1",
            [work_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((ghost_id, privacy)) = scope else {
            return Ok(Some(native_denied("not_found", "Native Work has no authoritative Goal/owner scope")));
        };
        // A private-browser route never serves a public-classified Goal: the
        // grant is joined with the effective Goal privacy BEFORE any route or
        // model context, so private DOM/text can never leak into public Pi.
        let route_is_private = self.native_computers.as_ref()
            .and_then(|computers| computers.route_is_private_browser(&ghost_id))
            .unwrap_or(false);
        if route_is_private && privacy == "public" {
            return Ok(Some(native_denied(
                "private_route_public_goal",
                "This Goal is public-classified but its route grants a private browser profile; ask the Primary for private admission or use a public route",
            )));
        }
        let current = self.native_computers.as_ref()
            .map(|computers| computers.grant(&ghost_id, envelope.authority_epoch)).transpose()?.flatten();
        let Some(grant) = current.filter(|grant| grant.permits_privacy(&privacy)) else {
            return Ok(Some(native_denied("worker_grant_unavailable", "No current accepted native computer route permits this Goal; no Worker admission occurred")));
        };
        if method == Some("work.submit") && !grant.permits_spec(envelope.body.get("spec").unwrap_or(&Value::Null)) {
            return Ok(Some(native_denied("unauthorized", "Worker spec exceeds its current Host-issued Ghost/computer/workspace grant")));
        }
        if method == Some("work.steer") {
            let computers = self.native_computers.as_ref().context("current native route disappeared")?;
            let execution_id: Option<String> = conn.query_row(
                "SELECT execution_id FROM lifetime_work WHERE id=?1", [work_id], |row| row.get(0))?;
            let original = execution_id.as_deref()
                .map(|execution_id| computers.socket_for_execution(conn, work_id, &ghost_id, execution_id))
                .transpose()?.flatten();
            if !original.is_some_and(|socket| computers.socket_is_current(&ghost_id, socket)) {
                return Ok(Some(native_denied("worker_grant_unavailable", "Original execution has no current compute grant; historical cleanup authority cannot steer it")));
            }
        }
        Ok(None)
    }
}

fn validate_worker_origin(origin: &WorkerOrigin) -> Result<()> {
    uuid::Uuid::parse_str(&origin.ghost_id)?;
    ensure!(!origin.computer_id.is_empty() && origin.computer_id.len() <= 128
        && origin.computer_id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')),
        "invalid worker origin computer identity");
    private_directory(&origin.worker_root)?;
    ensure!(origin.worker_socket.parent() == Some(origin.worker_root.as_path())
        && origin.worker_socket.file_name().is_some(), "worker origin socket is outside its original root");
    match fs::symlink_metadata(&origin.worker_socket) {
        Ok(metadata) => ensure!(metadata.file_type().is_socket()
            && metadata.uid() == unsafe { libc::geteuid() }
            && origin.worker_socket.canonicalize()? == origin.worker_socket,
            "worker origin socket is foreign or non-canonical"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn record_worker_origin(journal: &Journal, origins: &mut BTreeMap<String, WorkerOrigin>, origin: WorkerOrigin) -> Result<()> {
    if let Some(previous) = origins.get(&origin.computer_id) {
        ensure!(previous == &origin, "original worker route changed; explicit relocation reconciliation is required");
        return Ok(());
    }
    journal.put("meta", &format!("native_worker_origin:{}", origin.computer_id), &origin)?;
    origins.insert(origin.computer_id.clone(), origin);
    Ok(())
}

fn load_worker_origins(journal: &Journal) -> Result<BTreeMap<String, WorkerOrigin>> {
    let relocation = crate::operations::relocation::configured()?;
    if let Some(relocation) = &relocation {
        let workspace_id = journal.get::<String>("meta", "workspace_id")?.context("relocation requires workspace identity")?;
        let epoch = super::lifetime::authority::current(&journal.0)?.epoch;
        relocation.check_authority(&workspace_id, epoch)?;
    }
    let mut statement = journal.0.prepare(
        "SELECT id,payload FROM workspace_objects WHERE kind='meta' AND id LIKE 'native_worker_origin:%'")?;
    let mut origins = BTreeMap::new();
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let mut origin: WorkerOrigin = serde_json::from_str(&row.get::<_, String>(1)?)?;
        ensure!(key == format!("native_worker_origin:{}", origin.computer_id), "worker origin metadata key differs");
        uuid::Uuid::parse_str(&origin.ghost_id)?;
        if let Some(relocation) = &relocation {
            ensure!(origin.worker_socket.parent() == Some(origin.worker_root.as_path()), "historical socket is outside its original worker root");
            let filename = origin.worker_socket.file_name().context("historical socket filename is missing")?.to_owned();
            origin.worker_root = relocation.worker_root(&origin.ghost_id, &origin.computer_id, &origin.worker_root)?;
            origin.worker_socket = origin.worker_root.join(filename);
        }
        ensure!(origins.insert(origin.computer_id.clone(), origin).is_none(), "duplicate worker origin metadata");
    }
    Ok(origins)
}

fn native_denied(code: &str, summary: &str) -> Response {
    Response { status: ResponseStatus::Error, summary: summary.into(),
        object_refs: vec![], artifacts: vec![], next_actions: vec!["inspect_native_computer_scope".into()],
        error_code: Some(code.into()), retry_class: RetryClass::Never, data: Value::Null }
}

/// Operator-owned durable computer registry built from the same native
/// workers configuration the Host uses. Backend capability truth comes from
/// probed facts, never from a command payload; no binding is changed here.
pub struct OperatorComputers {
    pub registry: Arc<Mutex<ComputerRegistry>>,
    pub browser_computers: Vec<OwnedBrowserComputer>,
    pub runtime_facts: BTreeMap<String, RuntimeFacts>,
}

pub fn operator_computers(config_path: &Path) -> Result<OperatorComputers> {
    let config: Configuration = read_private_json(config_path)?;
    private_directory(&config.registry_root)?;
    let cli = config.container_cli.canonicalize().context("resolving native container CLI")?;
    let mut facts = NativeWorkerBackendFacts { configured: true, available: true };
    for route in &config.routes {
        let runner: GuestRunnerConfig = read_private_json(&route.runner_config)?;
        ensure!(runner.computer_registry_root == config.registry_root
            && runner.container_cli.canonicalize()? == cli,
            "operator runtime differs from its exact registry/CLI route");
        let current = runner.worker_backend_facts()?;
        facts.configured &= current.configured;
        facts.available &= current.available;
    }
    let registry = Arc::new(Mutex::new(ComputerRegistry::open(&config.registry_root)?));
    let native_runtime = RuntimeFacts::new("apple-container", crate::computers::local_browser::file_sha256(&cli)?)?;
    let mut runtime_facts = BTreeMap::from([(BACKEND.to_owned(), native_runtime.clone())]);
    registry.lock().register_native_worker_backend_with_runtime(facts, config.accepted_capabilities, Some(native_runtime))?;
    let browser_computers = match &config.browser {
        Some(section) => {
            let service = OwnedBrowserConfig::from_computers(section.computers.clone())?;
            let runtime = service.runtime_facts()?;
            runtime_facts.insert("ghost-owned-browser".to_owned(), runtime.clone());
            let available = section.computers.iter().all(|computer|
                crate::computers::probe_is_configured(&computer.executable, &computer.executable_sha256));
            registry.lock().register_backend_with_runtime(
                // Facts-only registration for operator commands; the live
                // session backend lives in the Host process.
                Arc::new(OperatorBrowserBackend),
                available,
                vec!["browser".into(), "human_control".into()],
                Some(runtime),
            )?;
            service.computers()
        }
        None => Vec::new(),
    };
    Ok(OperatorComputers { registry, browser_computers, runtime_facts })
}

/// Facts-only backend placeholder for operator CLI registration. It never
/// executes: browser execution is owned by the Host session backend.
struct OperatorBrowserBackend;

impl crate::adapters::computer::ComputerBackend for OperatorBrowserBackend {
    fn identity(&self) -> &'static str { crate::computers::local_browser::OWNED_BROWSER_BACKEND_ID }
    fn capabilities(&self) -> crate::adapters::computer::ComputerCapabilities {
        crate::adapters::computer::ComputerCapabilities {
            browser: true, shell: false, human_control: true, persistent_filesystem: false,
        }
    }
    fn configured(&self) -> bool { true }
    fn execute<'a>(&'a self, _: &'a str, _: crate::adapters::computer::ComputerOperation,
        _: crate::adapters::computer::Authorize<'a>) -> crate::adapters::computer::ComputerFuture<'a, Result<Value>> {
        Box::pin(async { Err(anyhow!("operator registration never executes browser operations")) })
    }
    fn control<'a>(&'a self, _: &'a str, _: &'a str) -> crate::adapters::computer::ComputerFuture<'a, Result<Value>> {
        Box::pin(async { Err(anyhow!("operator registration never executes control verbs")) })
    }
}

/// Idempotently attaches the owned browser service to a current binding.
/// An identical active service is left alone; any other prior state is
/// advanced by exactly one grant revision.
pub fn attach_owned_browser(
    registry: &mut ComputerRegistry,
    computer: &OwnedBrowserComputer,
    host_id: &str,
    epoch: u64,
) -> Result<()> {
    let inspection = registry_request(registry, &computer.ghost_id, epoch,
        json!({"method":"inspect", "computer_id":computer.computer_id}))?;
    ensure!(inspection.status == ResponseStatus::Success,
        "owned browser requires a current computer binding: {}", inspection.summary);
    let binding: ComputerBinding = serde_json::from_value(inspection.data.get("binding").cloned()
        .ok_or_else(|| anyhow!("owned browser inspection omitted binding"))?)?;
    let desired = browser_service_binding(&computer.computer_id, &computer.ghost_id, host_id,
        binding.epoch, &computer.profile_scope);
    let existing = inspection.data.get("browser_service").cloned().unwrap_or(Value::Null);
    if let Some(previous) = existing.get("service") {
        let previous: BrowserServiceBinding = serde_json::from_value(previous.clone())?;
        let mut same_shape = previous.clone();
        let prior_revision = same_shape.grant_revision;
        same_shape.grant_revision = desired.grant_revision;
        if same_shape == desired
            && existing.get("state") == Some(&Value::String("active".into()))
        {
            return Ok(());
        }
        let mut service = desired;
        service.grant_revision = prior_revision.checked_add(1)
            .ok_or_else(|| anyhow!("browser service grant revision exhausted"))?;
        let response = registry_request(registry, &computer.ghost_id, binding.epoch,
            json!({"method":"attach_browser", "computer_id":computer.computer_id, "service": service}))?;
        ensure!(response.status == ResponseStatus::Success,
            "owned browser service was not admitted: {}", response.summary);
        return Ok(());
    }
    let response = registry_request(registry, &computer.ghost_id, binding.epoch,
        json!({"method":"attach_browser", "computer_id":computer.computer_id, "service": desired}))?;
    ensure!(response.status == ResponseStatus::Success,
        "owned browser service was not admitted: {}", response.summary);
    Ok(())
}

fn registry_request(registry: &mut ComputerRegistry, ghost_id: &str, epoch: u64, body: Value) -> Result<Response> {
    let command_id = uuid::Uuid::new_v4().to_string();
    registry.handle(&Envelope { protocol_version: VERSION.into(), payload_digest: canonical_digest(&body)?,
        actor_ref: ghost_id.into(), authority_epoch: epoch, expected_revision: None,
        correlation_id: command_id.clone(), command_id, body }, ghost_id)
}

fn private_directory(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "native directories must be absolute");
    let metadata = fs::symlink_metadata(path)?;
    ensure!(metadata.is_dir() && !metadata.file_type().is_symlink() && metadata.permissions().mode() & 0o077 == 0
        && metadata.uid() == unsafe { libc::geteuid() } && path.canonicalize()? == path,
        "native directory must be a canonical private owned directory");
    Ok(())
}

fn read_private_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    ensure!(path.is_absolute() && path.canonicalize()? == path, "native configuration must be a canonical absolute file");
    let path_metadata = fs::symlink_metadata(path)?;
    ensure!(path_metadata.is_file() && !path_metadata.file_type().is_symlink(), "native configuration must be a real file");
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    let before = file.metadata()?;
    ensure!(before.dev() == path_metadata.dev() && before.ino() == path_metadata.ino()
        && before.nlink() == 1 && before.uid() == unsafe { libc::geteuid() }
        && before.permissions().mode() & 0o077 == 0 && before.len() <= MAX_CONFIG_BYTES,
        "native configuration must be private, owned, singly linked and bounded");
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref().take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(bytes.len() as u64 == before.len() && after.len() == before.len()
        && after.mtime() == before.mtime() && after.mtime_nsec() == before.mtime_nsec()
        && after.ctime() == before.ctime() && after.ctime_nsec() == before.ctime_nsec(),
        "native configuration changed during read");
    serde_json::from_slice(&bytes).context("invalid native runtime configuration")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GHOST: &str = "22222222-2222-7222-8222-222222222222";

    #[test]
    fn configured_pi_environment_distinguishes_simulation_from_selected_container_policy() {
        let root=tempfile::tempdir().unwrap();let mut computers=NativeComputers::pi_fixture(root.path(),GHOST).unwrap();
        let simulated=computers.pi_execution_environment(GHOST).unwrap();assert_eq!(simulated["backend"],"fixture");assert_eq!(simulated["simulated"],true);assert!(simulated.get("image_ref").is_none());assert!(simulated.get("os").is_none());
        // Metadata-only declaration: no CLI execution, probe or package check.
        // A real fixture CLI selection uses this same pi_cli field after its
        // existing independent acceptance path has run.
        computers.pi_cli=Some(PathBuf::from("/declared-only/container-cli"));
        let selected=computers.pi_execution_environment(GHOST).unwrap();assert_eq!(selected["backend"],"apple_container");assert_eq!(selected["route"],"fixture");assert_eq!(selected["evidence"],"configured_policy");assert_eq!(selected["image_ref"],crate::computers::PINNED_TASK_IMAGE);assert!(selected.get("simulated").is_none());assert!(!selected.to_string().contains("/declared-only"));
        computers.workspace_id="configured-owner-workspace".into();assert_eq!(computers.pi_execution_environment(GHOST).unwrap()["route"],"configured");
        assert!(computers.pi_execution_environment("unknown-ghost").is_none());computers.pi_cli=None;assert!(computers.pi_execution_environment(GHOST).is_none());
    }

    fn fixture() -> (tempfile::TempDir, Journal, NativeComputers) {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::open(&root.path().join("host.db")).unwrap();
        let old = WorkerOrigin {
            ghost_id: GHOST.into(), computer_id: "old-computer".into(),
            worker_root: root.path().join("old"), worker_socket: root.path().join("old/worker.sock"),
        };
        let new = WorkerOrigin {
            ghost_id: GHOST.into(), computer_id: "new-computer".into(),
            worker_root: root.path().join("new"), worker_socket: root.path().join("new/worker.sock"),
        };
        let mut origins = BTreeMap::new();
        record_worker_origin(&journal, &mut origins, old).unwrap();
        record_worker_origin(&journal, &mut origins, new).unwrap();
        let computers = NativeComputers {
            registry: Arc::new(Mutex::new(ComputerRegistry::open(&root.path().join("registry")).unwrap())),
            routes: BTreeMap::from([(GHOST.into(), Route {
                computer_id: "new-computer".into(), model: "openai-codex/gpt-6-luna".into(),
                thinking: "max".into(), privacy_classes: vec!["public".into()], deadline_ms: 180_000,
                browser_private: false,
                browser_enabled: false,
                producer_profile_ref: None,
            })]),
            origins,
            browser: None,
            authority_epoch: 1,
            pi_cli: None,
            pi_dynamic:Mutex::new(BTreeMap::new()),
            workspace_id:"test-host".into(),
        };
        (root, journal, computers)
    }

    fn committed_submit(journal: &Journal, computer: &str, status: &str) {
        journal.0.execute(
            "INSERT INTO lifetime_commands(command_id,payload_digest,actor_ref,authority_epoch,request,response) VALUES(?1,'fixture-digest',?2,1,?3,?4)",
            params![
                uuid::Uuid::new_v4().to_string(), GHOST,
                json!({"body":{"method":"work.submit","work_id":"work-old","spec":{
                    "work_id":"work-old","execution_id":"execution-old","computer_id":computer
                }}}).to_string(),
                json!({"status":status,"data":{"execution_id":"execution-old","work":{"owner":GHOST}}}).to_string(),
            ],
        ).unwrap();
    }

    #[test]
    fn original_execution_route_survives_current_home_change_and_metadata_reopen() {
        let (root, journal, mut computers) = fixture();
        committed_submit(&journal, "old-computer", "success");
        computers.origins = load_worker_origins(&journal).unwrap();
        let socket = computers.socket_for_execution(&journal.0, "work-old", GHOST, "execution-old").unwrap().unwrap();
        assert_eq!(socket, root.path().join("old/worker.sock"));
        assert!(!computers.socket_is_current(GHOST, socket));
        assert!(computers.socket_is_current(GHOST, &root.path().join("new/worker.sock")));
        assert!(computers.socket_for_execution(&journal.0, "another-work", GHOST, "execution-old").unwrap().is_none());
        assert!(computers.socket_for_execution(&journal.0, "work-old", "33333333-3333-7333-8333-333333333333", "execution-old").unwrap().is_none());
    }

    #[test]
    fn missing_rejected_or_ambiguous_submit_provenance_never_uses_current_route() {
        let (_root, journal, computers) = fixture();
        assert!(computers.socket_for_execution(&journal.0, "work-old", GHOST, "execution-old").unwrap().is_none());
        committed_submit(&journal, "old-computer", "error");
        assert!(computers.socket_for_execution(&journal.0, "work-old", GHOST, "execution-old").unwrap().is_none());
        committed_submit(&journal, "old-computer", "success");
        committed_submit(&journal, "new-computer", "success");
        assert!(computers.socket_for_execution(&journal.0, "work-old", GHOST, "execution-old").is_err());
    }

    #[test]
    fn original_worker_origin_cannot_be_rebound_to_a_replacement_socket() {
        let (root, journal, mut computers) = fixture();
        let changed = WorkerOrigin {
            ghost_id: GHOST.into(), computer_id: "old-computer".into(),
            worker_root: root.path().join("replacement"), worker_socket: root.path().join("replacement/worker.sock"),
        };
        assert!(record_worker_origin(&journal, &mut computers.origins, changed).is_err());
        committed_submit(&journal, "old-computer", "success");
        let reopened = load_worker_origins(&journal).unwrap();
        assert_eq!(reopened["old-computer"].worker_socket, root.path().join("old/worker.sock"));
    }
}
