#![cfg(all(
    feature = "host",
    feature = "lifetime",
    target_os = "macos",
    target_arch = "aarch64"
))]

use anyhow::{anyhow, Result};
use ghost::{
    adapters::computer::{BrowserOperation, ComputerBackend, ComputerOperation},
    computers::{AppleContainerBackend, HomeManifest},
};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command as HostCommand, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const PINNED_IMAGE: &str =
    "docker.io/library/ubuntu@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7";
const APPLE_CONTAINER_CLI: &str = "/opt/homebrew/bin/container";
const FAKE_CLI: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/lifetime_computer/runtime/fake-container"
);

fn make_manifest(root: &Path, execution_id: &str) -> Result<(HomeManifest, PathBuf)> {
    fs::create_dir_all(root)?;
    let root = root.canonicalize()?;
    let home = root.join("home");
    let tasks = root.join("tasks");
    let browser = root.join("browser");
    let snapshot = tasks.join(execution_id);
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&tasks)?;
    fs::create_dir_all(&browser)?;
    fs::create_dir_all(&snapshot)?;
    Ok((
        HomeManifest {
            home_volume: home,
            task_snapshot_root: tasks,
            browser_profile: browser,
            credential_broker: None,
        },
        snapshot,
    ))
}

// This private CLI fixture covers adapter error/cleanup behavior only; it is not an OS-isolation test.

fn fake_backend(root: &Path, execution_id: &str) -> Result<(AppleContainerBackend, PathBuf)> {
    let (manifest, snapshot) = make_manifest(root, execution_id)?;
    let cli = root.join("container");
    fs::copy(FAKE_CLI, &cli)?;
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755))?;
    let backend = AppleContainerBackend::for_task(&cli, &manifest, execution_id, PINNED_IMAGE, 501, 20)?;
    Ok((backend, snapshot))
}

fn allow() -> anyhow::Result<()> {
    Ok(())
}

#[test]
fn task_binding_rejects_unpinned_image_and_root_identity() {
    let manifest = HomeManifest {
        home_volume: PathBuf::new(),
        task_snapshot_root: PathBuf::new(),
        browser_profile: PathBuf::new(),
        credential_broker: None,
    };
    assert!(AppleContainerBackend::for_task(
        Path::new("unused"),
        &manifest,
        "execution",
        "docker.io/library/ubuntu:latest",
        501,
        20,
    )
    .is_err());
    assert!(AppleContainerBackend::for_task(
        Path::new("unused"),
        &manifest,
        "execution",
        PINNED_IMAGE,
        0,
        20,
    )
    .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_browser_and_lifecycle_verbs_fail_closed() -> Result<()> {
    let root = tempfile::tempdir()?;
    let (backend, _) = fake_backend(root.path(), "unsupported")?;
    assert!(backend
        .execute(
            "owner",
            ComputerOperation::Browser(BrowserOperation::Read),
            &allow,
        )
        .await
        .is_err());
    assert!(backend.control("owner", "restart").await.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_authorization_kills_only_the_bound_task() -> Result<()> {
    let root = tempfile::tempdir()?;
    let (backend, _) = fake_backend(root.path(), "revoked")?;
    let inspected = backend.control("owner", "inspect").await?;
    let expected_name = inspected["container_name"]
        .as_str()
        .ok_or_else(|| anyhow!("task inspection omitted container name"))?
        .to_owned();
    let calls = AtomicUsize::new(0);
    let authorize = || {
        if calls.fetch_add(1, Ordering::SeqCst) < 2 {
            Ok(())
        } else {
            Err(anyhow!("revoked by test owner"))
        }
    };
    backend
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "__fixture_hold__".to_owned(),
                timeout_ms: 5_000,
            },
            &authorize,
        )
        .await
        .expect_err("revoked guest execution must not report success");
    let targeted = fs::read_to_string(root.path().join("container.killed"))?;
    assert_eq!(targeted.trim(), expected_name);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeout_and_output_overflow_are_bounded_errors() -> Result<()> {
    let timeout_root = tempfile::tempdir()?;
    let (timeout_backend, _) = fake_backend(timeout_root.path(), "timeout")?;
    timeout_backend
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "__fixture_hold__".to_owned(),
                timeout_ms: 100,
            },
            &allow,
        )
        .await
        .expect_err("timed out guest execution must not report success");
    assert!(timeout_root.path().join("container.killed").is_file());

    let overflow_root = tempfile::tempdir()?;
    let (overflow_backend, _) = fake_backend(overflow_root.path(), "overflow")?;
    overflow_backend
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "__fixture_overflow__".to_owned(),
                timeout_ms: 5_000,
            },
            &allow,
        )
        .await
        .expect_err("over-limit guest output must not report success");
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn buildkit_state() -> Result<String> {
    let output = HostCommand::new(APPLE_CONTAINER_CLI)
        .args(["inspect", "buildkit"])
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success()
        || output.stdout.len() + output.stderr.len() > 64 * 1024
    {
        return Err(anyhow!("could not inspect the pre-existing buildkit container"));
    }
    let value: Value = serde_json::from_slice(&output.stdout)?;
    value
        .as_array()
        .and_then(|records| records.first())
        .and_then(|record| record.pointer("/status/state"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("buildkit inspection omitted its state"))
}

fn physical_backend(root: &Path, execution_id: &str) -> Result<(AppleContainerBackend, PathBuf)> {
    let (manifest, snapshot) = make_manifest(root, execution_id)?;
    let backend = AppleContainerBackend::for_task(
        Path::new(APPLE_CONTAINER_CLI),
        &manifest,
        execution_id,
        PINNED_IMAGE,
        501,
        20,
    )?;
    Ok((backend, snapshot))
}

async fn assert_control_stops_guest(root: &Path, execution_id: &str, verb: &'static str) -> Result<()> {
    let (backend, _) = physical_backend(root, execution_id)?;
    let backend = Arc::new(backend);
    let worker_backend = backend.clone();
    let execution = tokio::spawn(async move {
        let authorize = || -> anyhow::Result<()> { Ok(()) };
        worker_backend
            .execute(
                "owner",
                ComputerOperation::Shell {
                    command: "sleep 30".to_owned(),
                    timeout_ms: 20_000,
                },
                &authorize,
            )
            .await
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(state) = backend.control("owner", "inspect").await {
            if state["state"] == "running" {
                break;
            }
        }
        if Instant::now() >= deadline {
            return Err(anyhow!("task did not become inspectable before the gate deadline"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let controlled = backend.control("owner", verb).await?;
    assert_eq!(controlled["state"], "stopped");
    let execution = execution.await?;
    execution.expect_err("controlled guest execution must not report success");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "root-only D2 physical acceptance; requires the approved image, task directory, and started API server"]
async fn apple_container_network_none_smoke() -> Result<()> {
    if std::env::var("GHOST_D2_RUN_PHYSICAL_SMOKE").as_deref() != Ok("1") {
        return Err(anyhow!("set GHOST_D2_RUN_PHYSICAL_SMOKE=1 to authorize physical D2 acceptance"));
    }
    assert_eq!(buildkit_state()?, "stopped");
    let root = tempfile::tempdir()?;
    let root_path = root.path().canonicalize()?;
    let (backend, snapshot) = physical_backend(&root_path, "d2-network-none")?;
    let host_secret = root_path.join("host-secret.txt");
    fs::write(&host_secret, "must not be visible in the guest")?;
    let home = PathBuf::from(std::env::var("HOME")?);
    let hidden_paths = [
        home.clone(),
        home.join(".ssh"),
        home.join(".config"),
        home.join(".aws"),
        host_secret,
    ]
    .into_iter()
    .map(|path| Ok(shell_quote(path.to_str().ok_or_else(|| anyhow!("host path is not UTF-8"))?)))
    .collect::<Result<Vec<_>>>()?
    .join(" ");
    let command = format!(
        "set -eu\nprintf 'persistent-d2' > /workspace/.d2-persist\ntest \"$(cat /workspace/.d2-persist)\" = persistent-d2\nfor path in {hidden_paths}; do test ! -e \"$path\"; done\nif (printf x > /tmp/.ghost-d2-root-write) 2>/dev/null; then exit 70; fi\nroot_ro=0\nwhile read -r source target fstype options rest; do\n  if [ \"$target\" = / ]; then case \",${{options}},\" in *,ro,*) root_ro=1 ;; esac; fi\ndone < /proc/mounts\n[ \"$root_ro\" -eq 1 ]\ncommand -v getent >/dev/null\ncommand -v timeout >/dev/null\ncommand -v bash >/dev/null\nif timeout 2 getent hosts example.com >/dev/null 2>&1; then exit 71; fi\nif timeout 2 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' >/dev/null 2>&1; then exit 72; fi\nprintf '===IPV4===\\n'\ncat /proc/net/route\nprintf '===IPV6===\\n'\ncat /proc/net/ipv6_route\nprintf '===END===\\n'"
    );
    let result = backend
        .execute(
            "owner",
            ComputerOperation::Shell {
                command,
                timeout_ms: 30_000,
            },
            &allow,
        )
        .await?;
    assert_eq!(result["success"], true);
    assert_eq!(fs::read_to_string(snapshot.join(".d2-persist"))?, "persistent-d2");
    let output = result["stdout"]
        .as_str()
        .ok_or_else(|| anyhow!("guest route probe output was not text"))?;
    let ipv4 = output
        .split("===IPV4===\n")
        .nth(1)
        .and_then(|tail| tail.split("===IPV6===\n").next())
        .ok_or_else(|| anyhow!("guest IPv4 route table was missing"))?;
    for route in ipv4.lines().skip(1).filter(|route| !route.trim().is_empty()) {
        let fields = route.split_whitespace().collect::<Vec<_>>();
        assert!(fields.len() >= 2);
        assert_eq!(fields[0], "lo", "network-none exposed a non-loopback IPv4 route");
        assert_ne!(fields[1], "00000000", "network-none exposed an IPv4 default route");
    }
    let ipv6 = output
        .split("===IPV6===\n")
        .nth(1)
        .and_then(|tail| tail.split("===END===").next())
        .ok_or_else(|| anyhow!("guest IPv6 route table was missing"))?;
    for route in ipv6.lines().filter(|route| !route.trim().is_empty()) {
        let fields = route.split_whitespace().collect::<Vec<_>>();
        assert_eq!(fields.len(), 10, "unexpected Linux IPv6 route row");
        let flags = u32::from_str_radix(fields[8], 16)?;
        let loopback = fields[0] == "00000000000000000000000000000001"
            && fields[1] == "80";
        assert!(loopback || flags & 0x200 != 0, "network-none exposed a usable external IPv6 route");
        assert_eq!(fields[9], "lo");
    }
    assert_eq!(backend.control("owner", "inspect").await?["state"], "stopped");

    let persisted = backend
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "set -eu; test \"$(cat /workspace/.d2-persist)\" = persistent-d2; printf preserved".to_owned(),
                timeout_ms: 30_000,
            },
            &allow,
        )
        .await?;
    assert_eq!(persisted["stdout"], "preserved");
    let (recreated, _) = physical_backend(&root_path, "d2-network-none")?;
    let resumed = recreated
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "set -eu; test \"$(cat /workspace/.d2-persist)\" = persistent-d2; printf recreated".to_owned(),
                timeout_ms: 30_000,
            },
            &allow,
        )
        .await?;
    assert_eq!(resumed["stdout"], "recreated");
    let (other_ghost, other_snapshot) =
        physical_backend(&root_path.join("other-ghost"), "d2-network-none")?;
    let isolated = other_ghost
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "set -eu; test ! -e /workspace/.d2-persist; printf another-ghost > /workspace/.d2-persist; cat /workspace/.d2-persist".to_owned(),
                timeout_ms: 30_000,
            },
            &allow,
        )
        .await?;
    assert_eq!(isolated["stdout"], "another-ghost");
    assert_eq!(fs::read_to_string(snapshot.join(".d2-persist"))?, "persistent-d2");
    assert_eq!(fs::read_to_string(other_snapshot.join(".d2-persist"))?, "another-ghost");

    for (execution_id, verb) in [("d2-stop", "stop"), ("d2-kill", "kill")] {
        assert_control_stops_guest(&root_path, execution_id, verb).await?;
    }

    let (timeout_backend, _) = physical_backend(&root_path, "d2-timeout")?;
    timeout_backend
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "sleep 30".to_owned(),
                timeout_ms: 5_000,
            },
            &allow,
        )
        .await
        .expect_err("physical timeout must settle as an error");
    assert_eq!(timeout_backend.control("owner", "inspect").await?["state"], "stopped");

    let (revoke_backend, _) = physical_backend(&root_path, "d2-revoked")?;
    let calls = AtomicUsize::new(0);
    let authorize = || {
        if calls.fetch_add(1, Ordering::SeqCst) < 2 {
            Ok(())
        } else {
            Err(anyhow!("revoked by physical acceptance"))
        }
    };
    revoke_backend
        .execute(
            "owner",
            ComputerOperation::Shell {
                command: "sleep 30".to_owned(),
                timeout_ms: 20_000,
            },
            &authorize,
        )
        .await
        .expect_err("physical authorization revocation must settle as an error");
    assert_eq!(revoke_backend.control("owner", "inspect").await?["state"], "stopped");
    assert_eq!(buildkit_state()?, "stopped");
    Ok(())
}
