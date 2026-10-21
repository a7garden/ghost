use crate::worker::journal::ProcessIdentity;
use anyhow::{ensure, Result};
use std::{path::Path, time::{Duration, Instant}};
#[cfg(target_os = "linux")]
use std::fs;

#[cfg(target_os = "linux")]
pub(crate) fn inspect(pid: u32) -> Result<Option<ProcessIdentity>> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let close = stat.rfind(')').ok_or_else(|| anyhow::anyhow!("invalid /proc process stat"))?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    ensure!(fields.len() > 19, "short /proc process stat");
    let process_group = fields[2].parse::<i32>()?;
    let start_ticks = fields[19];
    Ok(Some(ProcessIdentity { pid, process_group, start_identity: start_ticks.to_owned() }))
}

#[cfg(target_os = "macos")]
pub(crate) fn inspect(pid: u32) -> Result<Option<ProcessIdentity>> {
    use std::{ffi::c_void, mem::{size_of, MaybeUninit}};
    #[repr(C)]
    struct ProcBsdInfo {
        flags: u32, status: u32, xstatus: u32, pid: u32, ppid: u32,
        uid: u32, gid: u32, ruid: u32, rgid: u32, svuid: u32, svgid: u32, reserved: u32,
        comm: [u8; 16], name: [u8; 32], nfiles: u32, pgid: u32, pjobc: u32,
        e_tdev: u32, e_tpgid: u32, nice: i32, start_sec: u64, start_usec: u64,
    }
    #[link(name = "proc")]
    extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, buffersize: i32) -> i32;
    }
    const PROC_PIDTBSDINFO: i32 = 3;
    let mut info = MaybeUninit::<ProcBsdInfo>::uninit();
    let size = i32::try_from(size_of::<ProcBsdInfo>())?;
    let result = unsafe { proc_pidinfo(pid as i32, PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    if result == 0 { return Ok(None); }
    ensure!(result == size, "proc_pidinfo returned a truncated process identity");
    let info = unsafe { info.assume_init() };
    Ok(Some(ProcessIdentity {
        pid,
        process_group: info.pgid as i32,
        start_identity: format!("{}.{}", info.start_sec, info.start_usec),
    }))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn inspect(_pid: u32) -> Result<Option<ProcessIdentity>> {
    anyhow::bail!("worker process start identity is unsupported on this Unix platform")
}

pub(crate) fn matches(pid: u32, process_group: i32, start_identity: &str) -> Result<bool> {
    let Some(current) = inspect(pid)? else { return Ok(false); };
    Ok(current.pid == pid && current.process_group == process_group && current.start_identity == start_identity)
}

#[cfg(unix)]
pub(crate) fn terminate_group(pid: u32, process_group: i32, start_identity: &str) -> Result<bool> {
    ensure!(process_group > 1 && process_group == pid as i32, "refusing to signal an unexpected process group");
    if !matches(pid, process_group, start_identity)? { return Ok(false); }
    signal_group(process_group, libc::SIGTERM)?;
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if !group_exists(process_group) { return Ok(true); }
        std::thread::sleep(Duration::from_millis(10));
    }
    if matches(pid, process_group, start_identity)? {
        signal_group(process_group, libc::SIGKILL)?;
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if !group_exists(process_group) { return Ok(true); }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(!group_exists(process_group))
}

#[cfg(unix)]
fn signal_group(process_group: i32, signal: i32) -> Result<()> {
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 { return Ok(()); }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) { return Ok(()); }
    Err(error.into())
}

#[cfg(unix)]
fn group_exists(process_group: i32) -> bool {
    let result = unsafe { libc::kill(-process_group, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub(crate) fn terminate_group(_pid: u32, _process_group: i32, _start_identity: &str) -> Result<bool> {
    anyhow::bail!("worker process-group termination is unsupported on this platform")
}

pub(crate) fn verify_recorded(root: &Path, pid: u32, group: i32, start_identity: &str) -> Result<bool> {
    let _ = root;
    matches(pid, group, start_identity)
}

#[cfg(unix)]
pub(crate) fn reconcile_recorded_absence(pid: u32, group: i32, start: &str) -> Result<bool> {
    ensure!(pid > 1 && group > 1 && group == pid as i32 && !start.is_empty(), "invalid recorded cleanup process identity");
    if let Some(current) = inspect(pid)? {
        if current.process_group != group || current.start_identity != start {
            return Ok(false);
        }
        if !terminate_group(pid, group, start)? {
            return Ok(false);
        }
    } else {
        // Darwin's inspection API also returns zero for inaccessible processes.
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            return Ok(false);
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => {}
            Some(libc::EPERM) => return Ok(false),
            _ => return Err(error.into()),
        }
    }
    if unsafe { libc::kill(-group, 0) } == 0 {
        return Ok(false);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(true),
        Some(libc::EPERM) => Ok(false),
        _ => Err(error.into()),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{inspect, reconcile_recorded_absence};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn unknown_cleanup_does_not_signal_a_reused_birth_identity() {
        let child = Command::new("/bin/sleep").arg("30").process_group(0)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut child = OwnedChild(child);
        let identity = inspect(child.0.id()).unwrap().unwrap();
        let foreign_birth = format!("{}-different-birth", identity.start_identity);
        assert!(!reconcile_recorded_absence(identity.pid, identity.process_group, &foreign_birth).unwrap());
        assert!(child.0.try_wait().unwrap().is_none(), "foreign birth denial must leave the live process untouched");
    }

    #[test]
    fn unknown_cleanup_confirms_an_already_reaped_owned_process_group() {
        let child = Command::new("/bin/sleep").arg("30").process_group(0)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut child = OwnedChild(child);
        let identity = inspect(child.0.id()).unwrap().unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(reconcile_recorded_absence(identity.pid, identity.process_group, &identity.start_identity).unwrap());
    }
}
