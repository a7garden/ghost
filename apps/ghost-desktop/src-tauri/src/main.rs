#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod companion;

use serde::{Deserialize, Serialize};
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
use tauri_plugin_updater::{Update, UpdaterExt};

/// The host origin the webviews may load. It is known only after the host
/// answers, so both windows read it from one shared cell.
type OriginCell = Arc<Mutex<Option<String>>>;

struct DesktopHost {
    /// Stop following the external host when the app quits.
    exiting: Arc<AtomicBool>,
    /// Whether the overlay currently holds window focus. Drives the
    /// focus-loss-to-hide behavior: a `Focused(false)` only hides the overlay
    /// when it had previously gained focus, so the show→focus sequence can't
    /// trip a spurious self-dismiss.
    overlay_focused: AtomicBool,
}

/// `~/.config/ghost/console.json`. Unknown keys are ignored: the file may
/// still carry settings this app no longer reads.
#[derive(Debug, Default, Deserialize)]
struct ConsoleConfig {
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

/// Overlay geometry: a 400x440 logical sheet (its CSS inset padding and
/// bottom tail included) attached to the desktop pet, or — with no visible
/// pet — bottom-center of the monitor the main window sits on.
const OVERLAY_SIZE: (f64, f64) = (400.0, 440.0);
/// Gap under the detached bottom-center sheet.
const OVERLAY_BOTTOM_GAP: f64 = 24.0;
/// Gap between the sheet's edge and the pet's rect, logical px.
const OVERLAY_PET_GAP: f64 = 4.0;
/// Shortest pet-attached sheet worth showing, logical px: between this and
/// the full height the sheet shortens to the headroom, under this it flips
/// to the pet's other side instead of squishing.
const OVERLAY_MIN_HEIGHT: f64 = 240.0;

/// Parked off-screen while hidden so the webview stays warm and the shortcut
/// surfaces it in a single frame.
const OVERLAY_PARK: (f64, f64) = (-32000.0, -32000.0);

/// An external host that is not up yet is retried, not failed.
const EXTERNAL_RETRY_TIMEOUT: Duration = Duration::from_secs(10);

fn overlay_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("overlay")
}

/// A rectangle in physical pixels: top-left corner and extent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PxRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// Which side of the pet the sheet's tail points from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverlaySide {
    /// Sheet above the pet, tail on its bottom edge.
    Above,
    /// Sheet below the pet, tail on its top edge.
    Below,
    /// No pet to attach to: centered sheet without a tail.
    Detached,
}

impl OverlaySide {
    /// The value the overlay page reads from its `data-side` attribute.
    fn css_value(self) -> &'static str {
        match self {
            Self::Above => "above",
            Self::Below => "below",
            Self::Detached => "none",
        }
    }
}

/// One deterministic placement: physical position and size, plus the tail
/// anchor in logical CSS pixels (pet center minus overlay left edge).
#[derive(Clone, Copy, Debug, PartialEq)]
struct OverlayPlacement {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    side: OverlaySide,
    anchor_x: f64,
}

/// Logical to physical pixels on one monitor's scale.
fn logical_px(value: f64, scale: f64) -> i32 {
    (value * scale).round() as i32
}

/// Attach the overlay to one pet inside one work area, both in physical
/// pixels. Preference: full height above the pet; shortened above once at
/// least `min_height` logical px fit; below only when above is physically
/// impossible; `None` when even a minimum sheet would leave the work area,
/// because a half-visible sheet is worse than surfacing nothing. The sheet
/// always ends up fully inside the work area.
fn place_overlay_near_pet(
    pet: PxRect,
    pet_center_x: i64,
    work_area: PxRect,
    scale: f64,
    gap_logical: f64,
    desired: (f64, f64),
    min_height_logical: f64,
) -> Option<OverlayPlacement> {
    if !scale.is_finite() || scale <= 0.0 || work_area.width <= 0 || work_area.height <= 0 {
        return None;
    }
    let width = logical_px(desired.0, scale).min(work_area.width);
    let full_height = logical_px(desired.1, scale).min(work_area.height);
    let min_height = logical_px(min_height_logical, scale).max(1);
    let gap = logical_px(gap_logical, scale);
    let area_bottom = i64::from(work_area.y) + i64::from(work_area.height);
    let pet_bottom = i64::from(pet.y) + i64::from(pet.height);
    let headroom = i64::from(pet.y) - i64::from(gap) - i64::from(work_area.y);
    let (side, height, y) = if headroom >= i64::from(full_height) {
        let y = i64::from(pet.y) - i64::from(gap) - i64::from(full_height);
        (OverlaySide::Above, i64::from(full_height), y)
    } else if headroom >= i64::from(min_height) {
        // Shorten the sheet to the headroom: top pinned to the work area,
        // bottom still `gap` above the pet.
        (OverlaySide::Above, headroom, i64::from(work_area.y))
    } else {
        let below_room = area_bottom - i64::from(gap) - pet_bottom;
        if below_room < i64::from(min_height) {
            return None;
        }
        let height = below_room.min(i64::from(full_height));
        (OverlaySide::Below, height, pet_bottom + i64::from(gap))
    };
    // Center on the pet, then keep the sheet inside the same work area.
    let x = companion::clamp_axis(
        pet_center_x - i64::from(width) / 2,
        work_area.x,
        work_area.width.max(0) as u32,
        width.max(0) as u32,
    );
    Some(OverlayPlacement {
        x,
        y: companion::clamp_axis(y, work_area.y, work_area.height as u32, height as u32),
        width,
        height: height as i32,
        side,
        anchor_x: (pet_center_x - i64::from(x)) as f64 / scale,
    })
}

/// Where the overlay belongs right now. A visible companion pins the sheet
/// to the pet's painted bounds, work area, and scale — the parked overlay's or the
/// main window's monitor would misplace it on mixed-DPI setups. Without a
/// readable pet the shortcut keeps its old bottom-center surface over the
/// monitor the main window sits on. `None` means no trustworthy monitor:
/// stay parked rather than surface off-screen.
fn overlay_placement(
    app: &tauri::AppHandle,
    overlay: &WebviewWindow,
) -> Option<(OverlayPlacement, f64)> {
    let pet = app
        .get_webview_window("companion")
        .filter(|pet| pet.is_visible().unwrap_or(false));
    if let Some(pet) = pet {
        if let (Ok(origin), Ok(size), Some(monitor)) = (
            pet.outer_position(),
            pet.inner_size(),
            pet.current_monitor().ok().flatten(),
        ) {
            let area = monitor.work_area();
            let (bounds, center_x) = app.state::<companion::CompanionState>().visible_geometry(
                PxRect {
                    x: origin.x,
                    y: origin.y,
                    width: size.width as i32,
                    height: size.height as i32,
                },
                monitor.scale_factor(),
            );
            return place_overlay_near_pet(
                bounds,
                center_x,
                PxRect {
                    x: area.position.x,
                    y: area.position.y,
                    width: area.size.width as i32,
                    height: area.size.height as i32,
                },
                monitor.scale_factor(),
                OVERLAY_PET_GAP,
                OVERLAY_SIZE,
                OVERLAY_MIN_HEIGHT,
            )
            .map(|placement| (placement, monitor.scale_factor()));
        }
    }
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| overlay.current_monitor().ok().flatten())
        // Display-transition edge: without any current monitor the overlay
        // would otherwise surface at its off-screen park position, invisible
        // yet consuming the toggle.
        .or_else(|| overlay.primary_monitor().ok().flatten())?;
    // Physical pixels throughout: converting through the parked window's
    // monitor scale would misplace the overlay on mixed-DPI setups.
    let scale = monitor.scale_factor();
    let width = logical_px(OVERLAY_SIZE.0, scale);
    let height = logical_px(OVERLAY_SIZE.1, scale);
    let gap = logical_px(OVERLAY_BOTTOM_GAP, scale);
    let origin = monitor.position();
    let size = monitor.size();
    Some((
        OverlayPlacement {
            x: origin.x + (size.width as i32 - width) / 2,
            y: origin.y + size.height as i32 - height - gap,
            width,
            height,
            side: OverlaySide::Detached,
            anchor_x: OVERLAY_SIZE.0 / 2.0,
        },
        scale,
    ))
}

/// Apply geometry using its target display's scale, never the parked window's.
fn apply_placement(
    overlay: &WebviewWindow,
    placement: &OverlayPlacement,
    scale: f64,
) -> Result<(), tauri::Error> {
    #[cfg(target_os = "macos")]
    {
        // Tao queues both native mutations asynchronously. Logical arguments
        // bypass its conversion through the overlay's stale previous scale.
        overlay.set_size(tauri::LogicalSize::new(
            f64::from(placement.width) / scale,
            f64::from(placement.height) / scale,
        ))?;
        overlay.set_position(tauri::LogicalPosition::new(
            f64::from(placement.x) / scale,
            f64::from(placement.y) / scale,
        ))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        overlay.set_size(tauri::PhysicalSize::new(
            placement.width as u32,
            placement.height as u32,
        ))?;
        overlay.set_position(tauri::PhysicalPosition::new(placement.x, placement.y))?;
    }
    overlay.eval(format!(
        "document.documentElement.style.setProperty('--anchor-x', '{:.1}px');document.documentElement.setAttribute('data-side', '{}');",
        placement.anchor_x,
        placement.side.css_value(),
    ))
}

/// Surface the overlay above the visible pet when there is one, else over
/// the current work; a visible overlay toggles away instead. Mirrors the
/// oximemo capture overlay's warm-window toggle.
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
        Ok(false) => match overlay_placement(app, &overlay) {
            Some((placement, scale)) => {
                if let Err(error) = apply_placement(&overlay, &placement, scale)
                    .and_then(|()| overlay.show())
                    .and_then(|()| overlay.set_focus())
                {
                    eprintln!("[ghost] 오버레이를 열지 못했습니다: {error}");
                }
            }
            // Nothing sane to compute: showing the parked overlay would put
            // it off-screen, invisible yet consuming the toggle.
            None => eprintln!("[ghost] 오버레이를 표시할 위치를 계산하지 못했습니다."),
        },
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

struct ShellUpdater {
    root: PathBuf,
    // One operation at a time; retain the verified offer until installation.
    pending: tauri::async_runtime::Mutex<Option<Update>>,
}

#[derive(Serialize)]
struct ShellUpdate {
    version: String,
    notes: String,
}

fn shell_update_url(port: u16, asset: &str) -> Result<tauri::Url, String> {
    // Neither the renderer nor host.json can choose a non-loopback endpoint.
    tauri::Url::parse(&format!("http://127.0.0.1:{port}/api/update/shell/{asset}"))
        .map_err(|_| "앱 업데이트 주소를 읽지 못했습니다.".into())
}

#[tauri::command]
fn shell_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn shell_update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, ShellUpdater>,
) -> Result<Option<ShellUpdate>, String> {
    let mut pending = state
        .pending
        .try_lock()
        .map_err(|_| "앱 업데이트가 진행 중입니다.".to_string())?;
    *pending = None;
    let host = read_host_file(&state.root)?;
    let updater = app
        .updater_builder()
        .no_proxy()
        .configure_client(|client| client.redirect(reqwest::redirect::Policy::none()))
        .endpoints(vec![shell_update_url(host.port, "latest.json")?])
        .map_err(|_| "앱 업데이트 주소를 설정하지 못했습니다.".to_string())?
        .header("Authorization", format!("Bearer {}", host.token))
        .map_err(|_| "호스트 인증 정보를 읽지 못했습니다.".to_string())?
        .build()
        .map_err(|_| "앱 업데이트를 시작하지 못했습니다.".to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|_| "앱 업데이트를 확인하지 못했습니다.".to_string())?;
    if let Some(update) = update {
        // The HTTP exception and owner bearer token are only for this Host.
        if update.download_url != shell_update_url(host.port, "Ghost.app.tar.gz")? {
            return Err("앱 업데이트 다운로드 주소가 올바르지 않습니다.".into());
        }
        let offer = ShellUpdate {
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
        };
        *pending = Some(update);
        Ok(Some(offer))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn shell_update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, ShellUpdater>,
) -> Result<(), String> {
    let mut pending = state
        .pending
        .try_lock()
        .map_err(|_| "앱 업데이트가 진행 중입니다.".to_string())?;
    let update = pending
        .as_mut()
        .ok_or_else(|| "앱 업데이트를 먼저 확인하세요.".to_string())?;
    // The Host may have restarted between checking and clicking 설치.
    let host = read_host_file(&state.root)?;
    update.download_url = shell_update_url(host.port, "Ghost.app.tar.gz")?;
    let authorization = update
        .headers
        .get_mut("Authorization")
        .ok_or_else(|| "호스트 인증 정보를 읽지 못했습니다.".to_string())?;
    *authorization = format!("Bearer {}", host.token)
        .parse()
        .map_err(|_| "호스트 인증 정보를 읽지 못했습니다.".to_string())?;
    authorization.set_sensitive(true);
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "앱 업데이트를 설치하지 못했습니다.".to_string())?;
    relaunch(&app);
}

/// Start the updated bundle again. A process spawned by `app.restart()` came up
/// without its main window on screen; LaunchServices (`open`) launches and activates
/// the bundle like a Dock click. The helper waits for this process to exit first so
/// the new instance can take the global shortcut.
#[cfg(target_os = "macos")]
fn relaunch(app: &tauri::AppHandle) -> ! {
    let bundle = std::env::current_exe().ok().and_then(|exe| {
        exe.ancestors()
            .find(|path| path.extension().is_some_and(|ext| ext == "app"))
            .map(Path::to_path_buf)
    });
    if let Some(bundle) = bundle {
        let pid = std::process::id().to_string();
        let spawned = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$2\"",
                "ghost-relaunch",
            ])
            .arg(&pid)
            .arg(&bundle)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if spawned.is_ok() {
            // The same exit path `app.restart()` takes, minus its direct respawn.
            app.cleanup_before_exit();
            std::process::exit(0);
        }
    }
    app.restart()
}

#[cfg(not(target_os = "macos"))]
fn relaunch(app: &tauri::AppHandle) -> ! {
    app.restart()
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
fn wait_for_endpoint(
    client: &reqwest::blocking::Client,
    root: &Path,
    exiting: &AtomicBool,
    timeout: Duration,
) -> Result<Endpoint, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(file) = read_host_file(root) {
            if host_health(client, file.port) {
                return Ok(Endpoint {
                    origin: format!("http://127.0.0.1:{}", file.port),
                    pid: file.pid,
                });
            }
        }
        if exiting.load(Ordering::Acquire) {
            return Err("앱이 종료되었습니다.".into());
        }
        if Instant::now() >= deadline {
            return Err(
                "호스트에 연결할 수 없습니다. `ghost service install`을 실행하세요.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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
    // The rounded sheet and tail are drawn in CSS over a transparent,
    // unshadowed, fixed-size window; placement reasserts the exact physical
    // size on every show.
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .on_navigation(move |url| navigation_allowed(&overlay_origin, url))
    .build()
    .map_err(|error| format!("오버레이를 만들지 못했습니다: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let pointer = overlay.ns_window().map_err(|error| error.to_string())?;
        // SAFETY: setup runs on the main thread; Tauri owns this live NSWindow.
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary,
        );
        native.setHidesOnDeactivate(false);
    }
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

/// Follow an external host: load its UI and reload it when the host restarts.
fn follow_host(mut ui: HostUi, root: PathBuf, exiting: Arc<AtomicBool>) {
    let Ok(client) = health_client() else {
        report(&ui.window, "상태 확인을 시작하지 못했습니다.", false);
        return;
    };
    while !exiting.load(Ordering::Acquire) {
        match wait_for_endpoint(&client, &root, &exiting, EXTERNAL_RETRY_TIMEOUT) {
            Ok(endpoint) => {
                if ui.current.as_ref() != Some(&endpoint) {
                    ui.connect(&endpoint);
                }
            }
            Err(message) => report(&ui.window, &message, ui.current.is_some()),
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

// 창 상단 46px 타이틀바는 콘솔 UI가 렌더링한다(ghost-ui GTitleBar, Tauri 셸에서만).
// 트래픽 라이트 overlay·드래그는 네이티브 창 플래그가 담당한다.

/// Integration probe: resolve the host the app would use and report it
/// without opening a window. It does not claim that UI interactions work.
fn probe() -> Result<Value, String> {
    let config = load_console_config()?;
    let root = state_root(&config);
    let client = health_client()?;
    let exiting = AtomicBool::new(false);
    let endpoint = wait_for_endpoint(&client, &root, &exiting, EXTERNAL_RETRY_TIMEOUT)?;
    Ok(serde_json::json!({
        "protocol": "ghost-desktop-probe/2",
        "mode": "external",
        "origin": endpoint.origin,
        "host_pid": endpoint.pid,
        "healthy": true,
        "ui_interactions_verified": false,
    }))
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
        shell_version,
        shell_update_check,
        shell_update_install,
        companion::companion_set,
        companion::companion_enabled,
        companion::companion_reset_position,
        companion::companion_resize,
        companion::companion_anchor,
        companion::toggle_overlay,
        companion::focus_main,
        companion::companion_menu,
        companion::companion_drag
    ];
    #[cfg(not(target_os = "macos"))]
    let invoke_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        drag_window,
        shell_version,
        shell_update_check,
        shell_update_install,
        companion::companion_set,
        companion::companion_enabled,
        companion::companion_reset_position,
        companion::companion_resize,
        companion::companion_anchor,
        companion::toggle_overlay,
        companion::focus_main,
        companion::companion_menu,
        companion::companion_drag
    ];
    tauri::Builder::default()
        .plugin(ShortcutBuilder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(invoke_handler)
        .setup(|app| {
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
            let config = load_console_config();
            let root = config
                .as_ref()
                .map(state_root)
                .unwrap_or_else(|_| default_root());
            app.manage(DesktopHost {
                exiting: exiting.clone(),
                overlay_focused: AtomicBool::new(false),
            });
            app.manage(ShellUpdater {
                root: root.clone(),
                pending: tauri::async_runtime::Mutex::new(None),
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
            std::thread::spawn(move || follow_host(ui, root, exiting));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Ghost desktop runtime failed")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                if !app.state::<DesktopHost>().exiting.load(Ordering::Acquire) {
                    if let Err(error) = companion::focus_main(app.clone(), None) {
                        eprintln!("[ghost] {error}");
                    }
                }
                return;
            }
            // The host service is independent of the shell's lifetime.
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<DesktopHost>();
                state.exiting.store(true, Ordering::Release);
                return;
            }
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                app.state::<DesktopHost>()
                    .exiting
                    .store(true, Ordering::Release);
            }
        });
}

#[cfg(test)]
mod overlay_placement_tests {
    use super::{
        place_overlay_near_pet, OverlayPlacement, OverlaySide, PxRect, OVERLAY_MIN_HEIGHT,
        OVERLAY_PET_GAP, OVERLAY_SIZE,
    };

    /// The production gap, size, and minimum; only the scale varies per test.
    fn place(pet: PxRect, area: PxRect, scale: f64) -> Option<OverlayPlacement> {
        place_overlay_near_pet(
            pet,
            i64::from(pet.x) + i64::from(pet.width) / 2,
            area,
            scale,
            OVERLAY_PET_GAP,
            OVERLAY_SIZE,
            OVERLAY_MIN_HEIGHT,
        )
    }

    #[test]
    fn attaches_above_at_full_height_centered_on_the_pet() {
        let pet = PxRect {
            x: 890,
            y: 700,
            width: 140,
            height: 170,
        };
        let area = PxRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1056,
        };
        assert_eq!(
            place(pet, area, 1.0),
            Some(OverlayPlacement {
                x: 760,
                y: 256,
                width: 400,
                height: 440,
                side: OverlaySide::Above,
                anchor_x: 200.0,
            })
        );
    }

    #[test]
    fn shortens_above_when_the_headroom_is_partial() {
        let pet = PxRect {
            x: 100,
            y: 300,
            width: 140,
            height: 170,
        };
        let area = PxRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1056,
        };
        // 296 logical px of headroom: between the 240 minimum and the 440
        // full height, so the sheet pins to the work-area top and keeps its
        // bottom 4 px above the pet.
        assert_eq!(
            place(pet, area, 1.0),
            Some(OverlayPlacement {
                x: 0,
                y: 0,
                width: 400,
                height: 296,
                side: OverlaySide::Above,
                anchor_x: 170.0,
            })
        );
    }

    #[test]
    fn flips_below_when_the_headroom_is_insufficient() {
        let area = PxRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1056,
        };
        // 196 logical px of headroom is under the minimum: hang below instead.
        let near_top = PxRect {
            x: 100,
            y: 200,
            width: 140,
            height: 170,
        };
        assert_eq!(
            place(near_top, area, 1.0),
            Some(OverlayPlacement {
                x: 0,
                y: 374,
                width: 400,
                height: 440,
                side: OverlaySide::Below,
                anchor_x: 170.0,
            })
        );
        // Below never exceeds the full height either: the pet leaves 252 px
        // under it, so the sheet shortens to that.
        let tall = PxRect {
            x: 100,
            y: 240,
            width: 140,
            height: 560,
        };
        assert_eq!(
            place(tall, area, 1.0),
            Some(OverlayPlacement {
                x: 0,
                y: 804,
                width: 400,
                height: 252,
                side: OverlaySide::Below,
                anchor_x: 170.0,
            })
        );
    }

    #[test]
    fn fails_safely_when_neither_side_leaves_room() {
        let area = PxRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1056,
        };
        let covering = PxRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1056,
        };
        assert_eq!(place(covering, area, 1.0), None);
    }

    #[test]
    fn clamps_to_the_work_area_edges() {
        let area = PxRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1056,
        };
        let near_right = PxRect {
            x: 1780,
            y: 700,
            width: 140,
            height: 170,
        };
        assert_eq!(
            place(near_right, area, 1.0),
            Some(OverlayPlacement {
                x: 1520,
                y: 256,
                width: 400,
                height: 440,
                side: OverlaySide::Above,
                anchor_x: 330.0,
            })
        );
        let near_left = PxRect {
            x: 2,
            y: 700,
            width: 140,
            height: 170,
        };
        assert_eq!(
            place(near_left, area, 1.0),
            Some(OverlayPlacement {
                x: 0,
                y: 256,
                width: 400,
                height: 440,
                side: OverlaySide::Above,
                anchor_x: 72.0,
            })
        );
    }

    #[test]
    fn negative_monitor_coordinates_stay_inside_their_work_area() {
        let area = PxRect {
            x: -1920,
            y: 24,
            width: 1920,
            height: 1056,
        };
        let pet = PxRect {
            x: -1850,
            y: 700,
            width: 140,
            height: 170,
        };
        assert_eq!(
            place(pet, area, 1.0),
            Some(OverlayPlacement {
                x: -1920,
                y: 256,
                width: 400,
                height: 440,
                side: OverlaySide::Above,
                anchor_x: 140.0,
            })
        );
    }

    #[test]
    fn mixed_dpi_converts_the_logical_sheet_through_the_target_monitor_scale() {
        let area = PxRect {
            x: 0,
            y: 0,
            width: 3840,
            height: 2112,
        };
        let pet = PxRect {
            x: 1780,
            y: 1400,
            width: 280,
            height: 340,
        };
        // 2x: 400x440 logical becomes 800x880 physical, the 4 px gap becomes 8.
        assert_eq!(
            place(pet, area, 2.0),
            Some(OverlayPlacement {
                x: 1520,
                y: 512,
                width: 800,
                height: 880,
                side: OverlaySide::Above,
                anchor_x: 200.0,
            })
        );
        let retina_area = PxRect {
            x: 0,
            y: 0,
            width: 2880,
            height: 1584,
        };
        let retina_pet = PxRect {
            x: 0,
            y: 600,
            width: 210,
            height: 255,
        };
        // 1.5x: 594 physical px of headroom shorten the sheet; the anchor
        // stays logical (105 physical px / 1.5 = 70).
        assert_eq!(
            place(retina_pet, retina_area, 1.5),
            Some(OverlayPlacement {
                x: 0,
                y: 0,
                width: 600,
                height: 594,
                side: OverlaySide::Above,
                anchor_x: 70.0,
            })
        );
    }

    #[test]
    fn narrow_work_area_and_partly_offscreen_pet_keep_the_sheet_reachable() {
        let area = PxRect {
            x: 0,
            y: 30,
            width: 320,
            height: 600,
        };
        let pet = PxRect {
            x: 260,
            y: 680,
            width: 140,
            height: 170,
        };
        let result = place(pet, area, 1.0).unwrap();
        assert_eq!(
            (result.x, result.y, result.width, result.height),
            (0, 190, 320, 440)
        );
    }
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

#[cfg(test)]
mod shell_update_tests {
    use super::{shell_update_url, state_root, ConsoleConfig};
    use std::path::PathBuf;

    #[test]
    fn console_reads_only_the_root_and_ignores_unknown_keys() {
        let config: ConsoleConfig = serde_json::from_value(serde_json::json!({
            "root": "/tmp/ghost-shell-test",
            "unknown": {"value": true},
        }))
        .unwrap();
        assert_eq!(state_root(&config), PathBuf::from("/tmp/ghost-shell-test"));
    }

    #[test]
    fn updater_urls_are_fixed_to_the_loopback_host() {
        for port in [1, 62062, u16::MAX] {
            for asset in ["latest.json", "Ghost.app.tar.gz"] {
                let url = shell_update_url(port, asset).unwrap();
                assert_eq!(url.scheme(), "http");
                assert_eq!(url.host_str(), Some("127.0.0.1"));
                assert_eq!(url.port_or_known_default(), Some(port));
                assert_eq!(url.path(), format!("/api/update/shell/{asset}"));
                assert_eq!(url.username(), "");
                assert!(url.password().is_none());
            }
        }
    }
}
