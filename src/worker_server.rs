//! Local same-UID transport, not an OS sandbox. Worker outlives Host connections.
#[cfg(unix)]
pub fn serve(root: &std::path::Path) -> anyhow::Result<()> {
    use anyhow::{anyhow, bail, ensure, Context};
    use fs2::FileExt;
    use std::{fs::{OpenOptions, Permissions}, io::{BufRead, BufReader, Write},
        os::unix::{fs::{FileTypeExt, PermissionsExt}, net::UnixListener}, time::Duration};
    use crate::{lifetime_contract::{Envelope, Response, ResponseStatus, RetryClass}, worker::Supervisor};
    ensure!(!root.is_symlink(), "worker root must not be a symlink");
    std::fs::create_dir_all(root)?;
    let root = root.canonicalize()?;
    std::fs::set_permissions(&root, Permissions::from_mode(0o700))?;
    let lock_path = root.join("worker-server.lock");
    ensure!(!lock_path.is_symlink(), "worker lock must not be a symlink");
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(lock_path)?;
    lock.try_lock_exclusive().map_err(|_| anyhow!("worker server is already running"))?;
    let mut supervisor = Supervisor::open(&root)?;
    let socket = root.join("worker.sock");
    if let Ok(meta) = socket.symlink_metadata() {
        ensure!(meta.file_type().is_socket(), "refusing to replace non-socket worker path");
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, Permissions::from_mode(0o600))?;
    eprintln!("worker ready {}", socket.display());
    for peer in listener.incoming() {
        let mut peer = peer.context("accepting worker client")?;
        peer.set_read_timeout(Some(Duration::from_secs(5))).context("setting worker client read deadline")?;
        peer.set_write_timeout(Some(Duration::from_secs(5))).context("setting worker client write deadline")?;
        let response = (|| -> anyhow::Result<Response> {
            let mut reader = BufReader::new(&mut peer);
            let mut bytes = Vec::new();
            loop {
                let buffer = reader.fill_buf()?;
                if buffer.is_empty() { bail!("incomplete worker request"); }
                let end = buffer.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(buffer.len());
                ensure!(bytes.len() + end <= 1_048_576, "worker frame limit");
                let newline = buffer[end - 1] == b'\n';
                bytes.extend_from_slice(&buffer[..end]);
                reader.consume(end);
                if newline { break; }
            }
            let request: Envelope = serde_json::from_slice(&bytes)?;
            supervisor.handle(&request)
        })().unwrap_or_else(|error| Response {
            status: ResponseStatus::Error, summary: error.to_string(), object_refs: vec![],
            artifacts: vec![], next_actions: vec!["Inspect the same execution before retrying".into()],
            error_code: Some("worker_request_failed".into()), retry_class: RetryClass::ReconcileFirst,
            data: serde_json::Value::Null,
        });
        let mut bytes = serde_json::to_vec(&response)?;
        bytes.push(b'\n');
        // A client disconnect is not a worker lifecycle signal.
        if let Err(error) = peer.write_all(&bytes) { eprintln!("worker response delivery lost: {error}"); }
    }
    Ok(())
}
