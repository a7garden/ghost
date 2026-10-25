use anyhow::{ensure, Context, Result};
use std::{env, fs, path::{Path, PathBuf}};
#[cfg(unix)]
use crate::computers::{AppleContainerBackend, ComputerRegistry, HomeManifest, NativeWorkerBackendFacts};
#[cfg(unix)]
use crate::lifetime_contract::WorkerSpec;
#[cfg(unix)]
use parking_lot::Mutex;
#[cfg(unix)]
use serde::Deserialize;
#[cfg(unix)]
use std::{collections::BTreeSet, os::unix::fs::PermissionsExt, sync::Arc};

const BUN_ENV: &str = "GHOST_OMP_BUN";
const ENTRY_ENV: &str = "GHOST_OMP_SCOPED_ENTRY";
const PACKAGE_ROOT_ENV: &str = "GHOST_OMP_PACKAGE_ROOT";
const CONFIG_ENV: &str = "GHOST_OMP_CONFIG";


#[cfg(unix)]
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuestRunnerConfig {
    pub container_cli: PathBuf,
    pub linux_runtime_root: PathBuf,
    pub source_directory: PathBuf,
    pub overlay_file: PathBuf,
    pub computer_registry_root: PathBuf,
    pub ghost_id: String,
    pub accepted_computer_capabilities: Vec<String>,
    pub backend: super::guest_broker::GuestModelBackend,
    pub model_id: String,
    pub model_pin: String,
    pub max_tokens: u32,
    pub context_window: u32,
    pub deadline_ms: u64,
    pub max_requests: u32,
    /// Explicit owned-browser grant for this worker. Absent keeps the
    /// historical browser-free worker; present, the browser host tool is
    /// advertised and every operation rides the durable registry lease.
    #[serde(default)]
    pub browser: Option<WorkerBrowserRuntime>,
}

/// Operator-pinned, probed owned-browser runtime for one worker.
#[cfg(unix)]
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerBrowserRuntime {
    pub executable: PathBuf,
    pub executable_sha256: String,
    /// Public research, or private browsing only on the validated keyless local route.
    pub profile_scope: String,
    #[serde(default)]
    pub headless: bool,
}

#[cfg(unix)]
impl GuestRunnerConfig {
    pub fn worker_backend_facts(&self) -> Result<NativeWorkerBackendFacts> {
        ensure!(
            !self.model_id.is_empty()
                && self.model_id.len() <= 128
                && self.model_id == self.model_pin
                && !self.model_id.chars().any(|value| value.is_whitespace() || value.is_control()),
            "guest runner model must match its explicit route pin"
        );
        super::guest_broker::validate_registered_route(
            &self.backend,
            &self.model_id,
            self.max_tokens,
            self.context_window,
            self.deadline_ms,
            self.max_requests,
        )
        .map_err(anyhow::Error::new)?;
        validate_ghost_id(&self.ghost_id)?;
        let accepted = self.accepted_computer_capabilities.iter().map(String::as_str).collect::<BTreeSet<_>>();
        ensure!(
            self.accepted_computer_capabilities.len() == 2
                && accepted.len() == 2
                && accepted.contains("shell")
                && accepted.contains("persistent_filesystem"),
            "native worker requires explicit shell and persistent-filesystem grants"
        );
        let container_cli = trusted_executable(&self.container_cli)?;
        ensure!(container_cli == self.container_cli, "Apple Container CLI path must be canonical");
        let runtime_root = trusted_directory(&self.linux_runtime_root, "Linux OMP runtime")?;
        ensure!(runtime_root == self.linux_runtime_root, "Linux OMP runtime path must be canonical");
        let source_directory = trusted_directory(&self.source_directory, "scoped guest source snapshot")?;
        ensure!(source_directory == self.source_directory, "guest source path must be canonical");
        let overlay_file = trusted_file(&self.overlay_file, "credentialless guest overlay")?;
        ensure!(overlay_file == self.overlay_file, "guest overlay path must be canonical");
        ensure!(
            fs::metadata(&overlay_file)?.permissions().mode() & 0o077 == 0,
            "guest overlay must be private"
        );
        let registry_root = trusted_private_directory(&self.computer_registry_root, "computer registry root")?;
        ensure!(registry_root == self.computer_registry_root, "computer registry root must be canonical");
        super::guest_runtime::validate_guest_runner_assets(&runtime_root, &source_directory)
            .map_err(anyhow::Error::new)?;
        let probe = AppleContainerBackend::probe(&container_cli).context("probing Apple Container backend facts")?;
        Ok(NativeWorkerBackendFacts {
            configured: true,
            available: probe.available(),
        })
    }
}

#[cfg(unix)]
pub(crate) struct GuestRunner {
    pub config: GuestRunnerConfig,
    pub registry: Arc<Mutex<ComputerRegistry>>,
    pub browser: Option<WorkerBrowserRuntime>,
    browser_relays: Mutex<std::collections::BTreeMap<String, Arc<super::browser_relay::WorkerBrowserRelay>>>,
}

#[cfg(unix)]
pub(crate) struct GuestHomeLease {
    pub manifest: HomeManifest,
    registry: Arc<Mutex<ComputerRegistry>>,
    computer_id: String,
    ghost_id: String,
    execution_id: String,
    authority_epoch: u64,
}

#[cfg(unix)]
impl GuestHomeLease {
    pub(crate) fn is_current(&self) -> bool {
        self.registry
            .lock()
            .worker_home_is_current(&self.computer_id, &self.ghost_id, &self.execution_id, self.authority_epoch)
            .unwrap_or(false)
    }

    /// Resolves the one registry-committed privacy lane directory this
    /// execution may mount as HOME. The registry re-checks the full
    /// admission discipline (binding, backend, exact lease pair, committed
    /// layout provenance); the containing home root and the sibling lane are
    /// never returned.
    pub(crate) fn lane_directory(
        &self,
        lane: crate::operations::home_lanes::HomePrivacyLane,
    ) -> Result<PathBuf> {
        self.registry.lock().worker_home_lane_directory(
            &self.computer_id,
            &self.ghost_id,
            &self.execution_id,
            self.authority_epoch,
            lane,
        )
    }

    pub(crate) fn release(&self) -> Result<()> {
        self.registry
            .lock()
            .release_worker_home(&self.computer_id, &self.ghost_id, &self.execution_id, self.authority_epoch)
    }
}

#[cfg(unix)]
impl GuestRunner {
    pub(crate) fn browser_relay(
        &self,
        spec: &WorkerSpec,
        authority_epoch: Arc<std::sync::RwLock<u64>>,
    ) -> Result<Option<Arc<super::browser_relay::WorkerBrowserRelay>>> {
        let Some(browser) = &self.browser else { return Ok(None); };
        let mut relays = self.browser_relays.lock();
        if let Some(relay) = relays.get(&spec.execution_id) {
            return Ok(Some(Arc::clone(relay)));
        }
        let relay = Arc::new(super::browser_relay::WorkerBrowserRelay::new(
            browser, Arc::clone(&self.registry), &self.config.ghost_id,
            &spec.computer_id, &spec.execution_id, spec.authority_epoch, authority_epoch,
            matches!(self.config.backend, super::guest_broker::GuestModelBackend::LocalHttp { .. }),
        )?);
        relays.insert(spec.execution_id.clone(), Arc::clone(&relay));
        Ok(Some(relay))
    }

    pub(crate) fn acquire_home(&self, spec: &WorkerSpec) -> Result<GuestHomeLease> {
        let manifest = self.registry.lock().acquire_worker_home(
            &spec.computer_id,
            &self.config.ghost_id,
            &spec.execution_id,
            spec.authority_epoch,
        )?;
        Ok(GuestHomeLease {
            manifest,
            registry: Arc::clone(&self.registry),
            computer_id: spec.computer_id.clone(),
            ghost_id: self.config.ghost_id.clone(),
            execution_id: spec.execution_id.clone(),
            authority_epoch: spec.authority_epoch,
        })
    }

    pub(crate) fn cleanup_home_is_authorized(&self, spec: &WorkerSpec) -> Result<bool> {
        self.registry.lock().worker_home_cleanup_is_authorized(
            &spec.computer_id,
            &self.config.ghost_id,
            &spec.execution_id,
            spec.authority_epoch,
        )
    }

    pub(crate) fn release_home(&self, spec: &WorkerSpec) -> Result<()> {
        if self.browser.is_some() {
            let instance = self.registry.lock().browser_instance(&spec.computer_id)?;
            if let Some(instance) = &instance {
                ensure!(instance.lease_execution_id == spec.execution_id
                    && instance.authority_epoch == spec.authority_epoch,
                    "registered browser belongs to another execution or epoch");
            }
            let relay = self.browser_relays.lock().get(&spec.execution_id).cloned();
            if let Some(relay) = relay {
                relay.stop_browser_only();
            }
            if let Some(instance) = instance {
                ensure!(super::process_identity::reconcile_recorded_absence(
                    instance.pid, instance.process_group, &instance.start_identity)?,
                    "original browser process group is not proven absent");
                let mut registry = self.registry.lock();
                if let Some(current) = registry.browser_instance(&spec.computer_id)? {
                    ensure!(current.pid == instance.pid && current.start_identity == instance.start_identity
                        && current.lease_execution_id == spec.execution_id,
                        "browser instance changed during cleanup");
                    registry.clear_browser_instance(&spec.computer_id, instance.pid)?;
                }
            }
            let mut registry = self.registry.lock();
            if registry.browser_lease_is_current(
                &spec.computer_id, &self.config.ghost_id, &spec.execution_id, spec.authority_epoch,
            )? {
                registry.release_browser_lease(
                    &spec.computer_id, &self.config.ghost_id, &spec.execution_id, spec.authority_epoch,
                )?;
            }
            drop(registry);
            self.browser_relays.lock().remove(&spec.execution_id);
        }
        self.registry.lock().release_worker_home(
            &spec.computer_id,
            &self.config.ghost_id,
            &spec.execution_id,
            spec.authority_epoch,
        )
    }
}

#[derive(Clone)]
pub(crate) enum Runner {
    Retired,
    ScopedOmp { executable: PathBuf, args: Vec<String> },
    Canary { executable: PathBuf, args: Vec<String> },
    #[cfg(unix)]
    GuestOmp(Arc<GuestRunner>),
}

impl Runner {
    pub(crate) fn registered() -> Result<Self> {
        #[cfg(unix)]
        if env::var_os("GHOST_OMP_GUEST_CONFIG").is_some() {
            let file = trusted_file(&registered_path("GHOST_OMP_GUEST_CONFIG")?, "guest runner configuration")?;
            ensure!(fs::metadata(&file)?.len() <= 16 * 1024, "guest runner configuration exceeds its bound");
            let config = serde_json::from_slice(&fs::read(file)?).context("invalid trusted guest runner configuration")?;
            return Self::guest(config);
        }
        let bun = registered_path(BUN_ENV)?;
        let entry = registered_path(ENTRY_ENV)?;
        let package_root = registered_path(PACKAGE_ROOT_ENV)?;
        let config = registered_path(CONFIG_ENV)?;
        Self::scoped_omp(&bun, &entry, &package_root, &config)
    }

    pub(crate) fn scoped_omp(bun: &Path, entry: &Path, package_root: &Path, config: &Path) -> Result<Self> {
        let executable = trusted_executable(bun)?;
        let entry = trusted_file(entry, "scoped OMP entry")?;
        let package_root = trusted_directory(package_root, "OMP package root")?;
        let config = trusted_file(config, "coordinator OMP configuration overlay")?;
        ensure!(package_root.join("package.json").is_file(), "OMP package root has no package.json");
        let args = vec![
            entry.to_string_lossy().into_owned(),
            "--package-root".into(),
            package_root.to_string_lossy().into_owned(),
            "--config".into(),
            config.to_string_lossy().into_owned(),
        ];
        Ok(Self::ScopedOmp { executable, args })
    }

    pub(crate) fn canary(executable: &Path, args: &[String]) -> Result<Self> {
        let executable = trusted_executable(executable)?;
        ensure!(args.len() <= 128, "trusted canary runner has too many arguments");
        ensure!(args.iter().all(|arg| !arg.as_bytes().contains(&0) && arg.len() <= 16 * 1024), "trusted canary runner argument is invalid or oversized");
        Ok(Self::Canary { executable, args: args.to_vec() })
    }

    #[cfg(unix)]
    pub(crate) fn guest(config: GuestRunnerConfig) -> Result<Self> {
        let facts = config.worker_backend_facts()?;
        let mut registry = ComputerRegistry::open(&config.computer_registry_root)?;
        let browser = match &config.browser {
            Some(browser) => {
                crate::computers::probe_is_configured(&browser.executable, &browser.executable_sha256)
                    .then_some(())
                    .ok_or_else(|| anyhow::anyhow!("worker browser executable pin does not match its probed sha256"))?;
                // A private-profile worker grant is wired ONLY to the existing
                // keyless local model route (LocalHttp / validated LocalPi):
                // subscription-native, public, or cloud routes can never see
                // private profile DOM, screenshots, or cookies.
                ensure!(
                    browser.profile_scope != "private"
                        || matches!(config.backend, super::guest_broker::GuestModelBackend::LocalHttp { .. }),
                    "a private browser worker grant requires the keyless local model route"
                );
                let runtime = crate::computers::RuntimeFacts::new(
                    crate::computers::local_browser::OWNED_BROWSER_RUNTIME_KIND,
                    browser.executable_sha256.clone(),
                )?;
                registry.register_backend_with_runtime(
                    // Facts-only registration; the live session backend is
                    // constructed per execution in the actor.
                    std::sync::Arc::new(WorkerBrowserFacts),
                    true,
                    vec!["browser".to_owned(), "human_control".to_owned()],
                    Some(runtime),
                )?;
                Some(browser.clone())
            }
            None => None,
        };
        registry.register_native_worker_backend(facts, config.accepted_computer_capabilities.clone())?;
        Ok(Self::GuestOmp(Arc::new(GuestRunner {
            config,
            registry: Arc::new(Mutex::new(registry)),
            browser,
            browser_relays: Mutex::new(std::collections::BTreeMap::new()),
        })))
    }
}

/// Facts-only backend registration for worker-side browser lease currency.
/// Execution never flows through this object.
#[cfg(unix)]
struct WorkerBrowserFacts;

#[cfg(unix)]
impl crate::adapters::computer::ComputerBackend for WorkerBrowserFacts {
    fn identity(&self) -> &'static str {
        crate::computers::local_browser::OWNED_BROWSER_BACKEND_ID
    }

    fn capabilities(&self) -> crate::adapters::computer::ComputerCapabilities {
        crate::adapters::computer::ComputerCapabilities {
            browser: true,
            shell: false,
            human_control: true,
            persistent_filesystem: false,
        }
    }

    fn configured(&self) -> bool {
        true
    }

    fn execute<'a>(
        &'a self,
        _: &'a str,
        _: crate::adapters::computer::ComputerOperation,
        _: crate::adapters::computer::Authorize<'a>,
    ) -> crate::adapters::computer::ComputerFuture<'a, Result<serde_json::Value>> {
        Box::pin(async {
            Err(anyhow::anyhow!("worker facts registration never executes browser operations"))
        })
    }

    fn control<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> crate::adapters::computer::ComputerFuture<'a, Result<serde_json::Value>> {
        Box::pin(async {
            Err(anyhow::anyhow!("worker facts registration never executes control verbs"))
        })
    }
}

fn registered_path(name: &str) -> Result<PathBuf> {
    let path = env::var_os(name).map(PathBuf::from).with_context(|| format!("{name} is not configured by the worker coordinator"))?;
    ensure!(path.is_absolute(), "coordinator runner paths must be absolute");
    Ok(path)
}

fn trusted_executable(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "trusted runner executable path must be absolute");
    let executable = path.canonicalize().context("resolving trusted runner executable")?;
    let metadata = fs::metadata(&executable)?;
    ensure!(metadata.is_file(), "trusted runner path is not a regular file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(metadata.permissions().mode() & 0o111 != 0, "trusted runner is not executable");
    }
    Ok(executable)
}

fn trusted_file(path: &Path, label: &str) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "{label} path must be absolute");
    let path = path.canonicalize().with_context(|| format!("resolving {label}"))?;
    ensure!(fs::metadata(&path)?.is_file(), "{label} is not a regular file");
    Ok(path)
}

fn trusted_directory(path: &Path, label: &str) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "{label} path must be absolute");
    let path = path.canonicalize().with_context(|| format!("resolving {label}"))?;
    ensure!(fs::metadata(&path)?.is_dir(), "{label} is not a directory");
    Ok(path)
}
#[cfg(unix)]
fn trusted_private_directory(path: &Path, label: &str) -> Result<PathBuf> {
    let directory = trusted_directory(path, label)?;
    ensure!(fs::metadata(&directory)?.permissions().mode() & 0o077 == 0, "{label} must be private");
    Ok(directory)
}

#[cfg(unix)]
fn validate_ghost_id(ghost_id: &str) -> Result<()> {
    ensure!(
        !ghost_id.is_empty()
            && ghost_id.len() <= 128
            && ghost_id != "."
            && ghost_id != ".."
            && ghost_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "trusted Ghost identity is invalid"
    );
    Ok(())
}
