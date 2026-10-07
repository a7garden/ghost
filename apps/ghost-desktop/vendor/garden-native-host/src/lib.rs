//! Host-owned process lifecycle. Renderer code never supplies executable paths.
mod protocol;
pub use protocol::{daemon_health, DaemonHealth, QueueHealth};
use serde::Serialize;
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub struct SupervisorConfig {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: Option<PathBuf>,
    pub shutdown_timeout: Duration,
    pub restart_delay: Duration,
    pub restart_limit: u32,
}

impl SupervisorConfig {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            arguments: vec![],
            working_directory: None,
            shutdown_timeout: Duration::from_secs(3),
            restart_delay: Duration::from_millis(250),
            restart_limit: 3,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Stopped,
    Running,
    Restarting,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub state: ProcessState,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

struct Inner {
    child: Option<Child>,
    desired: bool,
    next_start: Option<Instant>,
    status: ProcessStatus,
}

pub struct ProcessSupervisor {
    config: Arc<SupervisorConfig>,
    inner: Arc<Mutex<Inner>>,
    stopping: Arc<AtomicBool>,
    monitor: Option<JoinHandle<()>>,
}

fn spawn(config: &SupervisorConfig) -> std::io::Result<Child> {
    let mut command = Command::new(&config.program);
    command
        .args(&config.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(directory) = &config.working_directory {
        command.current_dir(directory);
    }
    // A private process group lets shutdown include helpers started by the child.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn()
}

fn launch(config: &SupervisorConfig, inner: &mut Inner) -> Result<(), String> {
    match spawn(config) {
        Ok(child) => {
            inner.status.pid = Some(child.id());
            inner.child = Some(child);
            inner.status.state = ProcessState::Running;
            inner.status.error = None;
            inner.next_start = None;
            Ok(())
        }
        Err(error) => {
            inner.status.state = ProcessState::Failed;
            inner.status.error = Some(error.to_string());
            inner.status.pid = None;
            inner.desired = false;
            Err(error.to_string())
        }
    }
}

#[cfg(unix)]
fn signal_group(child: &Child, signal: i32) {
    // The group was created exclusively for this owned child and its helpers.
    unsafe {
        libc::kill(-(child.id() as i32), signal);
    }
}

fn terminate(child: &mut Child, timeout: Duration) -> std::io::Result<()> {
    if child.try_wait()?.is_some() {
        #[cfg(unix)]
        signal_group(child, libc::SIGKILL);
        return Ok(());
    }
    #[cfg(unix)]
    signal_group(child, libc::SIGTERM);
    #[cfg(not(unix))]
    child.kill()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            #[cfg(unix)]
            signal_group(child, libc::SIGKILL);
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    #[cfg(unix)]
    signal_group(child, libc::SIGKILL);
    #[cfg(not(unix))]
    child.kill()?;
    child.wait()?;
    Ok(())
}

impl ProcessSupervisor {
    pub fn new(config: SupervisorConfig) -> Result<Self, String> {
        if config.program.as_os_str().is_empty() {
            return Err("A program is required".into());
        }
        if config.shutdown_timeout.is_zero() || config.shutdown_timeout > Duration::from_secs(60) {
            return Err("Shutdown timeout must be between 1ms and 60s".into());
        }
        if config.restart_delay < Duration::from_millis(10)
            || config.restart_delay > Duration::from_secs(60)
            || config.restart_limit > 100
        {
            return Err("Restart policy is outside its supported bounds".into());
        }
        let config = Arc::new(config);
        let inner = Arc::new(Mutex::new(Inner {
            child: None,
            desired: false,
            next_start: None,
            status: ProcessStatus {
                state: ProcessState::Stopped,
                pid: None,
                restarts: 0,
                exit_code: None,
                error: None,
            },
        }));
        let stopping = Arc::new(AtomicBool::new(false));
        let thread_config = config.clone();
        let thread_inner = inner.clone();
        let thread_stopping = stopping.clone();
        let monitor = thread::Builder::new()
            .name("garden-process".into())
            .spawn(move || {
                while !thread_stopping.load(Ordering::Acquire) {
                    if let Ok(mut inner) = thread_inner.lock() {
                        let exited = inner.child.as_mut().map(|child| child.try_wait());
                        match exited {
                            Some(Ok(Some(status))) => {
                                #[cfg(unix)]
                                if let Some(child) = inner.child.as_ref() {
                                    signal_group(child, libc::SIGKILL);
                                }
                                inner.child = None;
                                inner.status.pid = None;
                                inner.status.exit_code = status.code();
                                if inner.desired
                                    && inner.status.restarts < thread_config.restart_limit
                                {
                                    inner.status.state = ProcessState::Restarting;
                                    inner.next_start =
                                        Some(Instant::now() + thread_config.restart_delay);
                                } else {
                                    inner.desired = false;
                                    inner.status.state = ProcessState::Failed;
                                    inner.status.error =
                                        Some("Child exited; restart budget exhausted".into());
                                }
                            }
                            Some(Err(error)) => {
                                inner.status.error = Some(error.to_string());
                            }
                            _ => {}
                        }
                        if inner.desired
                            && inner.child.is_none()
                            && inner.next_start.is_some_and(|at| Instant::now() >= at)
                        {
                            inner.status.restarts += 1;
                            let _ = launch(&thread_config, &mut inner);
                        }
                    }
                    thread::sleep(Duration::from_millis(20));
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            config,
            inner,
            stopping,
            monitor: Some(monitor),
        })
    }

    /// Idempotent while running. An explicit new start replenishes the restart budget.
    pub fn start(&self) -> Result<ProcessStatus, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Supervisor state unavailable")?;
        if inner.desired {
            return Ok(inner.status.clone());
        }
        if inner.child.is_some() {
            return Err("The previous child has not stopped".into());
        }
        inner.desired = true;
        inner.status.restarts = 0;
        inner.status.exit_code = None;
        launch(&self.config, &mut inner)?;
        Ok(inner.status.clone())
    }

    pub fn status(&self) -> Result<ProcessStatus, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "Supervisor state unavailable")?
            .status
            .clone())
    }

    pub fn stop(&self) -> Result<ProcessStatus, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Supervisor state unavailable")?;
        inner.desired = false;
        inner.next_start = None;
        if let Some(mut child) = inner.child.take() {
            if let Err(error) = terminate(&mut child, self.config.shutdown_timeout) {
                inner.child = Some(child);
                inner.status.error = Some(error.to_string());
                inner.status.state = ProcessState::Failed;
                return Err(error.to_string());
            }
        }
        inner.status.pid = None;
        inner.status.state = ProcessState::Stopped;
        inner.status.error = None;
        Ok(inner.status.clone())
    }
}

impl Drop for ProcessSupervisor {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.stop();
        if let Some(monitor) = self.monitor.take() {
            let _ = monitor.join();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn shell(script: &str) -> SupervisorConfig {
        let mut config = SupervisorConfig::new("/bin/sh");
        config.arguments = vec!["-c".into(), script.into()];
        config.shutdown_timeout = Duration::from_millis(100);
        config.restart_delay = Duration::from_millis(20);
        config
    }
    fn until(supervisor: &ProcessSupervisor, state: ProcessState) -> ProcessStatus {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let status = supervisor.status().unwrap();
            if status.state == state {
                return status;
            }
            assert!(Instant::now() < deadline, "Timed out: {status:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn start_is_idempotent_and_stop_reaps_only_the_owned_process() {
        let mut external = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        let supervisor = ProcessSupervisor::new(shell("exec sleep 10")).unwrap();
        let first = supervisor.start().unwrap();
        assert!(first.pid.is_some());
        assert_eq!(first.pid, supervisor.start().unwrap().pid);
        assert_eq!(supervisor.stop().unwrap().state, ProcessState::Stopped);
        assert_eq!(supervisor.stop().unwrap().pid, None);
        assert!(external.try_wait().unwrap().is_none());
        external.kill().unwrap();
        external.wait().unwrap();
    }

    #[test]
    fn crashes_have_a_bounded_restart_budget() {
        let mut config = shell("exit 7");
        config.restart_limit = 2;
        let supervisor = ProcessSupervisor::new(config).unwrap();
        supervisor.start().unwrap();
        let failed = until(&supervisor, ProcessState::Failed);
        assert_eq!(failed.restarts, 2);
        assert_eq!(failed.exit_code, Some(7));
        assert!(failed.pid.is_none());
    }

    #[test]
    fn stop_cancels_a_pending_restart() {
        let mut config = shell("exit 1");
        config.restart_delay = Duration::from_millis(300);
        let supervisor = ProcessSupervisor::new(config).unwrap();
        supervisor.start().unwrap();
        until(&supervisor, ProcessState::Restarting);
        supervisor.stop().unwrap();
        thread::sleep(Duration::from_millis(400));
        assert_eq!(supervisor.status().unwrap().state, ProcessState::Stopped);
        assert_eq!(supervisor.status().unwrap().restarts, 0);
    }

    #[test]
    fn failed_spawn_is_visible_and_shutdown_escalates_when_term_is_ignored() {
        let missing =
            ProcessSupervisor::new(SupervisorConfig::new("/no/such/garden-executable")).unwrap();
        assert!(missing.start().is_err());
        assert_eq!(missing.status().unwrap().state, ProcessState::Failed);
        let supervisor =
            ProcessSupervisor::new(shell("trap '' TERM; while :; do sleep 1; done")).unwrap();
        supervisor.start().unwrap();
        thread::sleep(Duration::from_millis(50));
        let start = Instant::now();
        supervisor.stop().unwrap();
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
