#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod companion;
mod supervisor;

use crate::supervisor::{ProcessState, ProcessSupervisor, SupervisorConfig};
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};

/// The host origin the webviews may load. It is known only after the host
/// answers, so both windows read it from one shared cell.
type OriginCell = Arc<Mutex<Option<String>>>;

struct DesktopHost {
    /// The host process this app owns. An external host is never touched.
    supervisor: Option<Arc<ProcessSupervisor>>,
    /// Set when the app is quitting: the supervisor stops restarting.
    exiting: Arc<AtomicBool>,
    /// Set when the supervisor thread has released the host process.
    released: Arc<AtomicBool>,
    /// Whether the overlay currently holds window focus. Drives the
    /// focus-loss-to-hide behavior: a `Focused(false)` only hides the overlay
    /// when it had previously gained focus, so the show→focus sequence can't
    /// trip a spurious self-dismiss.
    overlay_focused: AtomicBool,
}

/// Where the Ghost host lives and who starts it.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum HostMode {
    /// The host runs outside this app; the app only talks to it.
    External,
    /// This app starts the host and keeps it running.
    #[default]
    Managed,
}

/// `~/.config/ghost/console.json`. Unknown keys are ignored: the file may
/// still carry settings this app no longer reads.
#[derive(Debug, Default, Deserialize)]
struct ConsoleConfig {
    #[serde(default)]
    host_mode: HostMode,
    root: Option<String>,
}

/// `<root>/host.json`: the port, owner token and pid of a running host.
#[derive(Debug, Deserialize)]
struct HostFile {
    port: u16,
    token: String,
    pid: u32,
}

/// A reachable host: the origin to load and the process behind it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Endpoint {
    origin: String,
    pid: u32,
}

/// Overlay geometry: a small composer over the current work, bottom-center of
/// the monitor the main window sits on.
const OVERLAY_SIZE: (f64, f64) = (560.0, 420.0);
const OVERLAY_BOTTOM_GAP: f64 = 24.0;
/// Parked off-screen while hidden so the webview stays warm and the shortcut
/// surfaces it in a single frame.
const OVERLAY_PARK: (f64, f64) = (-32000.0, -32000.0);

/// The host needs a moment to open the state root and answer.
const HOST_READY_TIMEOUT: Duration = Duration::from_secs(30);
/// An external host that is not up yet is retried, not failed.
const EXTERNAL_RETRY_TIMEOUT: Duration = Duration::from_secs(10);
/// Restart backoff for the managed host.
const RESTART_BACKOFF_MIN: Duration = Duration::from_millis(500);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// How long the quit path waits for the supervisor to release the host.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(5);

fn overlay_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("overlay")
}

fn position_overlay(overlay: &tauri::WebviewWindow) {
    let main = overlay.app_handle().get_webview_window("main");
    let monitor = main
        .as_ref()
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| overlay.current_monitor().ok().flatten())
        // Display-transition edge: without any current monitor the overlay
        // would otherwise surface at its off-screen park position, invisible
        // yet consuming the toggle.
        .or_else(|| overlay.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        // Practically unreachable with the primary fallback; leave placement
        // untouched rather than guessing.
        return;
    };
    let (width, height) = OVERLAY_SIZE;
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let size = monitor.size();
    // Physical pixels throughout: converting through the parked window's
    // monitor scale would misplace the overlay on mixed-DPI setups.
    let width_px = (width * scale).round() as i32;
    let height_px = (height * scale).round() as i32;
    let gap_px = (OVERLAY_BOTTOM_GAP * scale).round() as i32;
    let x = origin.x + (size.width as i32 - width_px) / 2;
    let y = origin.y + size.height as i32 - height_px - gap_px;
    let _ = overlay.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Surface the parked overlay over the current work; a visible overlay toggles
/// away instead. Mirrors the oximemo capture overlay's warm-window toggle.
fn toggle_overlay(app: &tauri::AppHandle) {
    let Some(overlay) = overlay_window(app) else {
        return;
    };
    // The renderer's Esc handler and the focus-loss auto-hide also hide the
    // window: an unreadable state must not re-surface a just-dismissed
    // overlay, so only act on a definite answer.
    match overlay.is_visible() {
        Ok(true) => {
            let _ = overlay.hide();
        }
        Ok(false) => {
            position_overlay(&overlay);
            let _ = overlay.show();
            let _ = overlay.set_focus();
        }
        Err(_) => {}
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// The console settings file. `GHOST_CONSOLE_CONFIG` points the app at a
/// different file so a test run never touches the owner's settings.
fn console_config_path() -> PathBuf {
    match std::env::var_os("GHOST_CONSOLE_CONFIG") {
        Some(path) => PathBuf::from(path),
        None => home_dir().join(".config/ghost/console.json"),
    }
}

fn default_root() -> PathBuf {
    home_dir().join("Library/Application Support/Ghost")
}

fn load_console_config() -> Result<ConsoleConfig, String> {
    let path = console_config_path();
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConsoleConfig::default());
        }
        Err(_) => return Err("콘솔 설정을 읽지 못했습니다.".into()),
    };
    serde_json::from_slice(&bytes).map_err(|_| "콘솔 설정의 형식이 올바르지 않습니다.".to_string())
}

/// The state root the host owns.
fn state_root(config: &ConsoleConfig) -> PathBuf {
    match &config.root {
        Some(root) => PathBuf::from(root),
        None => default_root(),
    }
}

fn read_host_file(root: &Path) -> Result<HostFile, String> {
    let bytes = std::fs::read(root.join("host.json"))
        .map_err(|_| "호스트 정보를 찾을 수 없습니다.".to_string())?;
    let file: HostFile =
        serde_json::from_slice(&bytes).map_err(|_| "호스트 정보를 읽지 못했습니다.".to_string())?;
    if file.token.is_empty() {
        return Err("호스트 토큰이 비어 있습니다.".into());
    }
    Ok(file)
}

/// The host answers `/api/health` with `{"ok":true}` while it is serving.
fn host_health(client: &reqwest::blocking::Client, port: u16) -> bool {
    let Ok(response) = client
        .get(format!("http://127.0.0.1:{port}/api/health"))
        .send()
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(value) = response.json::<Value>() else {
        return false;
    };
    value.get("ok").and_then(Value::as_bool) == Some(true)
}

fn health_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "상태 확인을 시작하지 못했습니다.".to_string())
}

/// Wait until the host publishes a healthy endpoint.
///
/// `expected_pid` pins the answer to one process: a managed host rewrites
/// `host.json` on every start, so a stale file must not be mistaken for the
/// host that was just launched. `supervisor` lets the wait end as soon as the
/// managed child dies instead of burning the whole timeout.
fn wait_for_endpoint(
    client: &reqwest::blocking::Client,
    root: &Path,
    expected_pid: Option<u32>,
    supervisor: Option<&ProcessSupervisor>,
    exiting: &AtomicBool,
    timeout: Duration,
) -> Result<Endpoint, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(file) = read_host_file(root) {
            let same_process = expected_pid.is_none_or(|pid| pid == file.pid);
            if same_process && host_health(client, file.port) {
                return Ok(Endpoint {
                    origin: format!("http://127.0.0.1:{}", file.port),
                    pid: file.pid,
                });
            }
        }
        if exiting.load(Ordering::Acquire) {
            return Err("앱이 종료되었습니다.".into());
        }
        if let Some(supervisor) = supervisor {
            let running = supervisor
                .status()
                .map(|status| status.state == ProcessState::Running)
                .unwrap_or(false);
            if !running {
                return Err("호스트가 종료되었습니다.".into());
            }
        }
        if Instant::now() >= deadline {
            return Err("호스트가 준비되지 않았습니다.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The bundled host, supervised by this app.
fn supervisor(resources: &Path, root: &Path) -> Result<Arc<ProcessSupervisor>, String> {
    let mut config = SupervisorConfig::new(resources.join("host/ghost"));
    config.arguments = vec!["serve".to_string()];
    config.environment = vec![
        ("GHOST_ROOT".into(), root.to_string_lossy().into_owned()),
        (
            "GHOST_UI_DIR".into(),
            resources.join("ui").to_string_lossy().into_owned(),
        ),
    ];
    config.working_directory = Some(resources.to_path_buf());
    config.shutdown_timeout = Duration::from_secs(7);
    config.restart_delay = Duration::from_millis(500);
    // Restarts are driven from here so the delay can grow between failures.
    config.restart_limit = 0;
    ProcessSupervisor::new(config).map(Arc::new)
}

fn set_origin(origin: &OriginCell, value: &str) {
    if let Ok(mut cell) = origin.lock() {
        *cell = Some(value.to_string());
    }
}

/// The webviews load the host origin and nothing else.
fn navigation_allowed(origin: &OriginCell, url: &tauri::Url) -> bool {
    if url.as_str() == "about:srcdoc" || url.as_str() == "about:blank" {
        return true;
    }
    if url.scheme() == "tauri" || url.as_str().starts_with("http://tauri.localhost/") {
        return true;
    }
    let Ok(cell) = origin.lock() else {
        return false;
    };
    match cell.as_deref() {
        Some(allowed) => url.origin().ascii_serialization() == allowed,
        None => false,
    }
}

#[cfg(target_os = "macos")]
fn browser_url_allowed(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// The renderer never navigates outside the Host; HTTP(S) leaves through this command.
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = tauri::Url::parse(&url).map_err(|_| "유효한 웹 주소가 아닙니다.")?;
    if !browser_url_allowed(&url) {
        return Err("HTTP와 HTTPS 주소만 열 수 있습니다.".into());
    }
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let opened = NSURL::URLWithString(&NSString::from_str(url.as_str()))
        .is_some_and(|url| NSWorkspace::sharedWorkspace().openURL(&url));
    if opened {
        Ok(())
    } else {
        // Authorization URLs can contain secrets; never include the URL in errors.
        Err("기본 브라우저에서 페이지를 열지 못했습니다.".into())
    }
}

/// Load the host UI in the main window.
fn navigate(window: &WebviewWindow, endpoint: &Endpoint) {
    let Ok(origin) = tauri::Url::parse(&format!("{}/", endpoint.origin)) else {
        return;
    };
    let _ = window.navigate(origin);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Load the host's overlay page.
fn navigate_overlay(overlay: &WebviewWindow, endpoint: &Endpoint) {
    if let Ok(url) = tauri::Url::parse(&format!("{}/overlay.html", endpoint.origin)) {
        let _ = overlay.navigate(url);
    }
}

/// The chat overlay: a warm, parked second webview the ⌘⇧G global shortcut
/// surfaces over the current work. It stays hidden until the host is up and
/// the shell navigates it to `{origin}/overlay.html`.
fn create_overlay(app: &tauri::AppHandle, origin: &OriginCell) -> Result<WebviewWindow, String> {
    let overlay_origin = origin.clone();
    let overlay = tauri::WebviewWindowBuilder::new(
        app,
        "overlay",
        tauri::WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("Ghost")
    .inner_size(OVERLAY_SIZE.0, OVERLAY_SIZE.1)
    .position(OVERLAY_PARK.0, OVERLAY_PARK.1)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .on_navigation(move |url| navigation_allowed(&overlay_origin, url))
    .build()
    .map_err(|error| format!("오버레이를 만들지 못했습니다: {error}"))?;
    let _ = overlay.hide();
    // Click-outside and app-switch dismissal: hide only after the overlay
    // actually held focus, so show→focus can't self-dismiss.
    let tracked = overlay.clone();
    overlay.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            // The handler is attached before `manage`; a missing state just
            // means no dismiss decision is possible yet.
            let Some(state) = tracked.app_handle().try_state::<DesktopHost>() else {
                return;
            };
            if *focused {
                state.overlay_focused.store(true, Ordering::Release);
            } else if state.overlay_focused.swap(false, Ordering::AcqRel) {
                let _ = tracked.hide();
            }
        }
    });
    Ok(overlay)
}

/// The app's view of the host it is talking to.
struct HostUi {
    window: WebviewWindow,
    overlay: WebviewWindow,
    companion: WebviewWindow,
    /// The origin the webviews may load.
    origin: OriginCell,
    /// The endpoint the windows currently show.
    current: Option<Endpoint>,
}

impl HostUi {
    /// Point the app at a host endpoint and load its UI.
    fn connect(&mut self, endpoint: &Endpoint) {
        let previous = self.current.as_ref();
        let moved = previous.is_none_or(|current| current.origin != endpoint.origin);
        let restarted = previous.is_some_and(|current| current.pid != endpoint.pid);
        set_origin(&self.origin, &endpoint.origin);
        // A new origin or a restarted host needs a fresh page: the old one
        // talks to a server that is gone. The host refreshes the owner token
        // in every page it serves, so a reload is all the UI needs.
        if moved || restarted {
            navigate(&self.window, endpoint);
            navigate_overlay(&self.overlay, endpoint);
            companion::navigate(&self.companion, endpoint);
        }
        self.current = Some(endpoint.clone());
    }
}

/// Report a host problem. Before the UI is up the message goes into the
/// placeholder window; afterwards it only reaches the app's own log.
fn report(window: &WebviewWindow, error: &str, ui_loaded: bool) {
    if ui_loaded {
        eprintln!("[ghost] {error}");
        return;
    }
    let message = serde_json::to_string(error).unwrap_or_else(|_| "\"실행 실패\"".into());
    let _ = window.eval(format!("document.getElementById('title').textContent='작업 공간을 열 수 없습니다';document.getElementById('status').textContent={message};"));
}

/// Keep a managed host running: start it, load its UI, and restart it with a
/// growing delay when it dies.
fn supervise_managed(
    mut ui: HostUi,
    supervisor: Arc<ProcessSupervisor>,
    root: PathBuf,
    exiting: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
) {
    let Ok(client) = health_client() else {
        report(&ui.window, "상태 확인을 시작하지 못했습니다.", false);
        released.store(true, Ordering::Release);
        return;
    };
    let mut backoff = RESTART_BACKOFF_MIN;
    let mut next_start = Instant::now();
    while !exiting.load(Ordering::Acquire) {
        let running = supervisor.status().ok().and_then(|status| {
            if status.state == ProcessState::Running {
                status.pid
            } else {
                None
            }
        });
        match running {
            Some(pid) => {
                match wait_for_endpoint(
                    &client,
                    &root,
                    Some(pid),
                    Some(&supervisor),
                    &exiting,
                    HOST_READY_TIMEOUT,
                ) {
                    Ok(endpoint) => {
                        ui.connect(&endpoint);
                        backoff = RESTART_BACKOFF_MIN;
                    }
                    Err(message) => report(&ui.window, &message, ui.current.is_some()),
                }
                // Wait for the child to go away before starting a new one.
                while !exiting.load(Ordering::Acquire) {
                    let state = supervisor.status().map(|status| status.state);
                    match state {
                        Ok(ProcessState::Running) | Ok(ProcessState::Restarting) => {}
                        _ => break,
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                next_start = Instant::now() + backoff;
                backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
            }
            None => {
                if Instant::now() >= next_start {
                    if let Err(error) = supervisor.start() {
                        report(&ui.window, &error, ui.current.is_some());
                        next_start = Instant::now() + backoff;
                        backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
                    } else {
                        next_start = Instant::now();
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    // The host must not outlive the app.
    let _ = supervisor.stop();
    released.store(true, Ordering::Release);
}

/// Follow an external host: load its UI and reload it when the host restarts.
fn supervise_external(
    mut ui: HostUi,
    root: PathBuf,
    exiting: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
) {
    let Ok(client) = health_client() else {
        report(&ui.window, "상태 확인을 시작하지 못했습니다.", false);
        released.store(true, Ordering::Release);
        return;
    };
    while !exiting.load(Ordering::Acquire) {
        match wait_for_endpoint(&client, &root, None, None, &exiting, EXTERNAL_RETRY_TIMEOUT) {
            Ok(endpoint) => {
                if ui.current.as_ref() != Some(&endpoint) {
                    ui.connect(&endpoint);
                }
            }
            Err(message) => report(&ui.window, &message, ui.current.is_some()),
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    released.store(true, Ordering::Release);
}

// 창 상단 46px 타이틀바는 콘솔 UI가 렌더링한다(ghost-ui GTitleBar, Tauri 셸에서만).
// 트래픽 라이트 overlay·드래그는 네이티브 창 플래그가 담당한다.

/// The packaged resources of the running app.
fn bundled_resources() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|_| "앱 경로를 찾지 못했습니다.".to_string())?;
    executable
        .parent()
        .and_then(Path::parent)
        .map(|contents| contents.join("Resources/resources"))
        .ok_or_else(|| "앱 경로를 찾지 못했습니다.".to_string())
}

/// Integration probe: resolve the host the app would use and report it
/// without opening a window. It does not claim that UI interactions work.
fn probe() -> Result<Value, String> {
    let config = load_console_config()?;
    let root = state_root(&config);
    let client = health_client()?;
    let exiting = AtomicBool::new(false);
    match config.host_mode {
        HostMode::External => {
            let endpoint =
                wait_for_endpoint(&client, &root, None, None, &exiting, EXTERNAL_RETRY_TIMEOUT)?;
            Ok(serde_json::json!({
                "protocol": "ghost-desktop-probe/2",
                "mode": "external",
                "origin": endpoint.origin,
                "host_pid": endpoint.pid,
                "healthy": true,
                "ui_interactions_verified": false,
            }))
        }
        HostMode::Managed => {
            let resources = bundled_resources()?;
            let supervisor = supervisor(&resources, &root)?;
            let result = (|| {
                supervisor.start()?;
                let pid = supervisor.status()?.pid;
                wait_for_endpoint(
                    &client,
                    &root,
                    pid,
                    Some(&supervisor),
                    &exiting,
                    HOST_READY_TIMEOUT,
                )
            })();
            let stopped = supervisor.stop().is_ok();
            let endpoint = result?;
            Ok(serde_json::json!({
                "protocol": "ghost-desktop-probe/2",
                "mode": "managed",
                "origin": endpoint.origin,
                "host_pid": endpoint.pid,
                "stopped": stopped,
                "healthy": true,
                "ui_interactions_verified": false,
            }))
        }
    }
}

/// Present a sheet without nesting an event loop inside Tauri's main-thread callback.
/// Only the main window has permission to ask for a project folder.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn pick_folder(window: WebviewWindow) -> Result<Option<String>, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let main_window = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(error) = begin_project_folder_sheet(&main_window, sender.clone()) {
                let _ = sender.try_send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "폴더 선택 창의 응답을 받지 못했습니다.".to_string())?
}

#[cfg(target_os = "macos")]
fn begin_project_folder_sheet(
    window: &WebviewWindow,
    sender: tauri::async_runtime::Sender<Result<Option<String>, String>>,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel, NSWindow};
    // Foundation still re-exports this marker; use the already-present crate.
    #[allow(deprecated)]
    let main_thread = objc2_foundation::MainThreadMarker::new()
        .ok_or("폴더 선택 창은 메인 스레드에서 열어야 합니다.")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri supplies this window's live NSWindow; this function runs on
    // the main thread and the borrowed window stays alive while presenting it.
    let parent = unsafe { &*pointer.cast::<NSWindow>() };
    let panel = NSOpenPanel::openPanel(main_thread);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    let selected_panel = panel.clone();
    let completion = RcBlock::new(move |response| {
        let result = if response == NSModalResponseOK {
            selected_panel
                .URL()
                .and_then(|url| url.path())
                .map(|path| Some(path.to_string()))
                .ok_or_else(|| "선택한 폴더 경로를 읽지 못했습니다.".into())
        } else if response == NSModalResponseCancel {
            Ok(None)
        } else {
            Err("폴더 선택 창을 열지 못했습니다.".into())
        };
        selected_panel.orderOut(None);
        let _ = sender.try_send(result);
    });
    panel.beginSheetModalForWindow_completionHandler(parent, &completion);
    Ok(())
}

/// Move the window with the pointer from a title bar press.
///
/// Tauri's `start_dragging` hands AppKit whatever event is current when the IPC
/// message lands. The press already went to the web content process, so once the
/// pointer moves that is a drag event and AppKit logs "Window move completed
/// without beginning" instead of moving. A synchronous command runs on the main
/// thread; it starts the move from a press at the pointer while the button is held.
#[tauri::command]
fn drag_window(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
        if NSEvent::pressedMouseButtons() & 1 == 0 {
            return Ok(());
        }
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        // SAFETY: Tauri returns the live NSWindow of this webview window, and a
        // synchronous command runs on the main thread that owns it.
        let ns_window = unsafe { &*pointer.cast::<NSWindow>() };
        let press = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDown,
            ns_window.mouseLocationOutsideOfEventStream(),
            NSEventModifierFlags::empty(),
            0.0,
            ns_window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
        .ok_or("could not create the press event")?;
        ns_window.performWindowDragWithEvent(&press);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    window.start_dragging().map_err(|error| error.to_string())
}

fn main() {
    // Integration probe uses the same host handshake as the window, without
    // opening a window or claiming that UI interactions have been tested.
    if std::env::args().any(|arg| arg == "--desktop-probe") {
        match probe() {
            Ok(value) => println!("{value}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(target_os = "macos")]
    let invoke_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        drag_window,
        open_external_url,
        pick_folder,
        companion::companion_set,
        companion::companion_enabled,
        companion::companion_reset_position,
        companion::companion_resize,
        companion::toggle_overlay,
        companion::focus_main,
        companion::companion_menu,
        companion::companion_drag
    ];
    #[cfg(not(target_os = "macos"))]
    let invoke_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        drag_window,
        companion::companion_set,
        companion::companion_enabled,
        companion::companion_reset_position,
        companion::companion_resize,
        companion::toggle_overlay,
        companion::focus_main,
        companion::companion_menu,
        companion::companion_drag
    ];
    tauri::Builder::default()
        .plugin(ShortcutBuilder::new().build())
        .invoke_handler(invoke_handler)
        .setup(|app| {
            let resources = app.path().resource_dir()?.join("resources");
            let origin: OriginCell = Arc::new(Mutex::new(None));

            let window_origin = origin.clone();
            let permission_origin = origin.clone();
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Ghost")
            .inner_size(1280.0, 860.0)
            .min_inner_size(720.0, 480.0)
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 20.0))
            .on_permission_request(move |webview, kind| {
                use tauri::webview::{PermissionKind, PermissionResponse};
                if kind == PermissionKind::Microphone
                    && webview.url().is_ok_and(|url| {
                        let Ok(cell) = permission_origin.lock() else {
                            return false;
                        };
                        cell.as_deref()
                            .is_some_and(|allowed| url.origin().ascii_serialization() == allowed)
                    })
                {
                    // Let WebKit and macOS ask the user for microphone access.
                    PermissionResponse::Default
                } else {
                    PermissionResponse::Deny
                }
            })
            .on_navigation(move |url| navigation_allowed(&window_origin, url))
            .build()?;
            // Closing the workspace keeps the desktop avatar and shortcut alive.
            // Actual application termination still follows ExitRequested below.
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let quitting = close_window
                        .app_handle()
                        .try_state::<DesktopHost>()
                        .is_some_and(|state| state.exiting.load(Ordering::Acquire));
                    if !quitting {
                        api.prevent_close();
                        if let Err(error) = close_window.hide() {
                            eprintln!("[ghost] Ghost 창을 숨기지 못했습니다: {error}");
                        }
                    }
                }
            });

            // The chat overlay: a warm, parked second webview the ⌘⇧G global
            // shortcut surfaces over the current work. It stays hidden until
            // the host is up and the shell navigates it to the host's
            // overlay page.
            let overlay = create_overlay(app.handle(), &origin)?;
            let companion = companion::create(app.handle(), &origin)?;

            // A taken or rejected ⌘⇧G must not take the whole console down:
            // register here and keep the app usable without the shortcut.
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(error) =
                app.global_shortcut()
                    .on_shortcut("cmd+shift+G", |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            toggle_overlay(app);
                        }
                    })
            {
                eprintln!("⌘⇧G 오버레이 단축키를 등록하지 못했습니다: {error}");
            }

            let exiting = Arc::new(AtomicBool::new(false));
            let released = Arc::new(AtomicBool::new(false));
            let config = load_console_config();
            let mode = config
                .as_ref()
                .map(|config| config.host_mode)
                .unwrap_or_default();
            let root = config
                .as_ref()
                .map(state_root)
                .unwrap_or_else(|_| default_root());
            let managed = match mode {
                HostMode::Managed => match supervisor(&resources, &root) {
                    Ok(supervisor) => Some(supervisor),
                    Err(error) => {
                        report(&window, &error, false);
                        None
                    }
                },
                HostMode::External => None,
            };
            app.manage(DesktopHost {
                supervisor: managed.clone(),
                exiting: exiting.clone(),
                released: released.clone(),
                overlay_focused: AtomicBool::new(false),
            });
            if let Err(error) = &config {
                report(&window, error, false);
            }

            // Host startup, health, and recovery stay off the native event loop.
            let ui = HostUi {
                window,
                overlay,
                companion,
                origin,
                current: None,
            };
            std::thread::spawn(move || match mode {
                HostMode::Managed => {
                    let Some(supervisor) = managed else {
                        released.store(true, Ordering::Release);
                        return;
                    };
                    supervise_managed(ui, supervisor, root, exiting, released);
                }
                HostMode::External => {
                    supervise_external(ui, root, exiting, released);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Ghost desktop runtime failed")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                if !app.state::<DesktopHost>().exiting.load(Ordering::Acquire) {
                    if let Err(error) = companion::focus_main(app.clone()) {
                        eprintln!("[ghost] {error}");
                    }
                }
                return;
            }
            // macOS application termination can reach Exit directly. The owned
            // host process must be reaped before the runtime leaves.
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<DesktopHost>();
                state.exiting.store(true, Ordering::Release);
                if let Some(supervisor) = &state.supervisor {
                    let _ = supervisor.stop();
                }
                return;
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<DesktopHost>();
                if !state.exiting.swap(true, Ordering::AcqRel) {
                    api.prevent_exit();
                    let supervisor = state.supervisor.clone();
                    let released = state.released.clone();
                    let app = app.clone();
                    std::thread::spawn(move || {
                        // The supervisor thread owns the host: wait for it to
                        // release the process before the app leaves.
                        let deadline = Instant::now() + RELEASE_TIMEOUT;
                        while !released.load(Ordering::Acquire) && Instant::now() < deadline {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        if let Some(supervisor) = supervisor {
                            let _ = supervisor.stop();
                        }
                        app.exit(0);
                    });
                }
            }
        });
}

#[cfg(all(test, target_os = "macos"))]
mod external_link_tests {
    use super::{browser_url_allowed, navigation_allowed, OriginCell};
    use std::sync::{Arc, Mutex};

    #[test]
    fn browser_links_only_accept_web_schemes() {
        for value in [
            "https://auth.openai.com/codex/device",
            "https://platform.claude.com/settings/keys",
            "http://127.0.0.1:62062/",
        ] {
            assert!(browser_url_allowed(&value.parse().unwrap()));
        }
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "mailto:owner@example.com",
            "tauri://localhost/",
            "about:blank",
        ] {
            assert!(!browser_url_allowed(&value.parse().unwrap()));
        }
    }

    #[test]
    fn external_browser_links_do_not_relax_webview_navigation() {
        let origin: OriginCell = Arc::new(Mutex::new(Some("http://127.0.0.1:62062".into())));
        assert!(navigation_allowed(
            &origin,
            &"http://127.0.0.1:62062/".parse().unwrap()
        ));
        assert!(!navigation_allowed(
            &origin,
            &"https://auth.openai.com/codex/device".parse().unwrap()
        ));
    }
}
