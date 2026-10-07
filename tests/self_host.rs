#![cfg(all(unix, feature = "host"))]

use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[test]
fn service_sigterm_drains_and_removes_owned_discovery() {
    let root = tempfile::tempdir().unwrap();
    let mut child = Server(
        Command::new(env!("CARGO_BIN_EXE_ghost"))
            .arg("--root")
            .arg(root.path())
            .args(["serve", "--headless", "--port", "0"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if ghost::control::ControlClient::discover(root.path())
            .and_then(|client| client.snapshot())
            .is_ok()
        {
            break;
        }
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "host exited before readiness"
        );
        assert!(Instant::now() < deadline, "host readiness timed out");
        std::thread::sleep(Duration::from_millis(30));
    }
    assert!(Command::new("kill")
        .args(["-TERM", &child.0.id().to_string()])
        .status()
        .unwrap()
        .success());
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(
                status.success(),
                "SIGTERM must take the graceful shutdown path: {status}"
            );
            break;
        }
        assert!(Instant::now() < deadline, "host did not stop");
        std::thread::sleep(Duration::from_millis(30));
    }
    assert!(!root.path().join(".ghost-control.json").exists());
}
