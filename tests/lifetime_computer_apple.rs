#![cfg(all(feature = "host", feature = "lifetime", unix))]

use ghost::{
    computers::{parse_cli_result, AppleCliOutcome, AppleContainerCliPlan, HomeManifest, APPLE_CONTAINER_OUTPUT_LIMIT},
};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use ghost::computers::APPLE_CONTAINER_CLI_VERSION;
use std::path::{Path, PathBuf};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::process::{Command, Stdio};
use tempfile::TempDir;

fn manifest(root: &Path) -> HomeManifest {
    let root = root.canonicalize().unwrap();
    let home = root.join("home");
    let tasks = root.join("tasks");
    let browser = root.join("browser-profile");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&tasks).unwrap();
    std::fs::create_dir_all(&browser).unwrap();
    std::fs::create_dir_all(tasks.join("execution-plan")).unwrap();
    HomeManifest {
        home_volume: home,
        task_snapshot_root: tasks,
        browser_profile: browser,
        credential_broker: None,
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn cli_path_from_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join("container"))
        .find(|candidate| candidate.is_file())
}

#[test]
fn plan_refuses_unrooted_snapshot_and_mount_option_injection() {
    let root = TempDir::new().unwrap();
    let rooted = manifest(root.path());
    let image = format!("registry.example/ghost-linux@sha256:{}", "a".repeat(64));
    let plan = |manifest: &HomeManifest, execution: &str| AppleContainerCliPlan::shell(
        Path::new("/opt/homebrew/bin/container"), manifest, execution, &image,
        1000, 1000, "fixture-egress-deny", "printf fixture", None,
    );
    assert!(plan(&rooted, "../home").is_err());
    let outside = TempDir::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), rooted.task_snapshot_root.join("linked-task")).unwrap();
    assert!(plan(&rooted, "linked-task").is_err());
    let comma_root = root.path().join("injected,readonly=false");
    std::fs::create_dir(&comma_root).unwrap();
    let injected = manifest(&comma_root);
    assert!(plan(&injected, "execution-plan").is_err());
}

#[test]
fn cli_error_parser_classifies_observed_offline_status_and_bounds_output() {
    let observed = b"apiserver is not running and not registered with launchd\n";
    assert_eq!(
        parse_cli_result(1, b"", observed).unwrap(),
        AppleCliOutcome::ServiceUnavailable
    );
    assert_eq!(
        parse_cli_result(0, b"container CLI version 1.4.1", b"").unwrap(),
        AppleCliOutcome::Success
    );
    assert_eq!(
        parse_cli_result(2, b"", b"unrecognized status output").unwrap(),
        AppleCliOutcome::Failed
    );
    let oversized = vec![b'x'; APPLE_CONTAINER_OUTPUT_LIMIT + 1];
    assert!(parse_cli_result(1, &oversized, b"").is_err());
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn installed_container_141_help_and_status_are_read_only_and_parseable() {
    let cli = cli_path_from_path().expect("installed Apple container CLI is required for D1");
    let version = Command::new(&cli)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        parse_cli_result(
            version.status.code().unwrap_or(-1),
            &version.stdout,
            &version.stderr,
        )
        .unwrap(),
        AppleCliOutcome::Success
    );
    let version_text = String::from_utf8_lossy(&version.stdout);
    assert!(version_text.contains(APPLE_CONTAINER_CLI_VERSION));

    let help = Command::new(&cli)
        .args(["run", "--help"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        parse_cli_result(
            help.status.code().unwrap_or(-1),
            &help.stdout,
            &help.stderr,
        )
        .unwrap(),
        AppleCliOutcome::Success
    );
    let help_text = String::from_utf8_lossy(&help.stdout);
    for option in ["--os", "--arch", "--uid", "--gid", "--cap-drop", "--mount", "--read-only"] {
        assert!(help_text.contains(option), "installed CLI help lacks {option}");
    }

    let status = Command::new(&cli)
        .args(["system", "status"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(matches!(
        parse_cli_result(
            status.status.code().unwrap_or(-1),
            &status.stdout,
            &status.stderr,
        )
        .unwrap(),
        AppleCliOutcome::Success | AppleCliOutcome::ServiceUnavailable
    ));
}
