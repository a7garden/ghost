#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use garden_native_host::{ProcessState, ProcessSupervisor, SupervisorConfig};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};

struct DesktopHost {
    supervisor: Arc<ProcessSupervisor>,
    exiting: AtomicBool,
    /// Whether the overlay currently holds window focus. Drives the
    /// focus-loss-to-hide behavior: a `Focused(false)` only hides the overlay
    /// when it had previously gained focus, so the show→focus sequence can't
    /// trip a spurious self-dismiss.
    overlay_focused: AtomicBool,
}

/// Overlay geometry: a small composer over the current work, bottom-center of
/// the monitor the main window sits on.
const OVERLAY_SIZE: (f64, f64) = (560.0, 420.0);
const OVERLAY_BOTTOM_GAP: f64 = 24.0;
/// Parked off-screen while hidden so the webview stays warm and the shortcut
/// surfaces it in a single frame.
const OVERLAY_PARK: (f64, f64) = (-32000.0, -32000.0);

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
    let x = origin.x as f64 / scale + ((size.width as f64 / scale) - width) / 2.0;
    let y = origin.y as f64 / scale + (size.height as f64 / scale) - height - OVERLAY_BOTTOM_GAP;
    let _ = overlay.set_position(tauri::LogicalPosition::new(x, y));
}

/// Surface the parked overlay over the current work; a visible overlay toggles
/// away instead. Mirrors the oximemo capture overlay's warm-window toggle.
fn toggle_overlay(app: &tauri::AppHandle) {
    let Some(overlay) = overlay_window(app) else {
        return;
    };
    if overlay.is_visible().unwrap_or(false) {
        let _ = overlay.hide();
        return;
    }
    position_overlay(&overlay);
    let _ = overlay.show();
    let _ = overlay.set_focus();
}

fn port() -> Result<u16, String> {
    let config_path = std::env::var_os("GHOST_CONSOLE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                .join(".config/ghost/console.json")
        });
    let config: Value = match std::fs::read(config_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "콘솔 설정을 읽지 못했습니다.".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(_) => return Err("콘솔 설정을 읽지 못했습니다.".into()),
    };
    if let Ok(value) = std::env::var("GHOST_DESKTOP_PORT").or_else(|_| std::env::var("PORT")) {
        return value
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .ok_or_else(|| "잘못된 콘솔 포트입니다.".into());
    }
    let value = config.get("port").and_then(Value::as_u64).unwrap_or(62062);
    u16::try_from(value)
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| "잘못된 콘솔 포트입니다.".into())
}

fn supervisor(resources: &Path) -> Result<Arc<ProcessSupervisor>, String> {
    let mut config = SupervisorConfig::new(resources.join("runtime/node"));
    config.arguments = vec![resources
        .join("launcher/desktop-console.mjs")
        .to_string_lossy()
        .into_owned()];
    config.working_directory = Some(resources.to_path_buf());
    config.shutdown_timeout = Duration::from_secs(7);
    config.restart_delay = Duration::from_millis(500);
    config.restart_limit = 3;
    ProcessSupervisor::new(config).map(Arc::new)
}

fn health(client: &reqwest::blocking::Client, origin: &str, pid: u32) -> bool {
    let response = client.get(format!("{origin}/ghost-api/bootstrap")).send();
    let Ok(response) = response else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(bytes) = response.bytes() else {
        return false;
    };
    if bytes.len() > 8192 {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value["protocol"] == "ghost-ui"
        && value["protocol_version"] == 1
        && value["mode"] == "live"
        && value["owner_pid"] == pid
}

fn ready(supervisor: &ProcessSupervisor, port: u16) -> Result<(String, u32), String> {
    // Bind failure leaves separately managed consoles and their hosts untouched.
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|_| {
        "이 포트에서 콘솔이 이미 실행 중입니다. 기존 콘솔을 종료한 뒤 Ghost를 다시 여세요."
            .to_string()
    })?;
    drop(listener);
    supervisor.start()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "상태 확인을 시작하지 못했습니다.")?;
    let origin = format!("http://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let state = supervisor.status()?;
        if let Some(pid) = state.pid {
            if health(&client, &origin, pid) {
                return Ok((origin, pid));
            }
        }
        if state.state == ProcessState::Failed || Instant::now() >= deadline {
            let _ = supervisor.stop();
            return Err("작업 공간을 열지 못했습니다. 콘솔 설정과 호스트 실행 상태를 확인한 뒤 Ghost를 다시 여세요.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// 창 상단 46px 타이틀바는 콘솔 UI가 렌더링한다(ghost-ui GTitleBar, Tauri 셸에서만).
// 트래픽 라이트 overlay·드래그는 네이티브 창 플래그가 담당한다.

fn fail(window: &tauri::WebviewWindow, error: &str) {
    let message = serde_json::to_string(error).unwrap_or_else(|_| "\"실행 실패\"".into());
    let _ = window.eval(format!("document.getElementById('title').textContent='작업 공간을 열 수 없습니다';document.getElementById('status').textContent={message};"));
}

fn main() {
    // Integration probe uses the same packaged supervisor and handshake, without
    // opening a window or claiming that UI interactions have been tested.
    if std::env::args().any(|arg| arg == "--desktop-probe") {
        let result = (|| -> Result<Value, String> {
            let executable = std::env::current_exe().map_err(|_| "앱 경로를 찾지 못했습니다.")?;
            let resources = executable
                .parent()
                .and_then(Path::parent)
                .ok_or("앱 경로 오류")?
                .join("Resources/resources");
            let supervisor = supervisor(&resources)?;
            let started = ready(&supervisor, port()?);
            let stopped = supervisor.stop();
            let (origin, pid) = started?;
            let stopped = stopped?;
            Ok(
                serde_json::json!({"protocol":"ghost-desktop-probe/1","origin":origin,"owned_console_pid":pid,"stopped":stopped,"ui_interactions_verified":false}),
            )
        })();
        match result {
            Ok(value) => println!("{value}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    tauri::Builder::default()
        .plugin(ShortcutBuilder::new().build())
        .setup(|app| {
            let port = port()?;
            let origin = format!("http://127.0.0.1:{port}");
            let allowed_origin = origin.clone();
            let capture_origin = origin.clone();
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
                    && webview
                        .url()
                        .is_ok_and(|url| url.origin().ascii_serialization() == capture_origin)
                {
                    // Let WebKit and macOS ask the user for microphone access.
                    PermissionResponse::Default
                } else {
                    PermissionResponse::Deny
                }
            })
            .on_navigation(move |url| {
                // Native startup assets and this exact console origin only.
                url.as_str() == "about:srcdoc"
                    || url.as_str() == "about:blank"
                    || url.scheme() == "tauri"
                    || url.as_str().starts_with("http://tauri.localhost/")
                    || url.origin().ascii_serialization() == allowed_origin
            })
            .build()?;
            // The chat overlay: a warm, parked second webview the ⌘⇧G global
            // shortcut surfaces over the current work. Same navigation
            // allowlist as the main window; it loads the console's compact
            // overlay page once the bridge is ready.
            let overlay_origin = origin.clone();
            let overlay = tauri::WebviewWindowBuilder::new(
                app,
                "overlay",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Ghost")
            .inner_size(OVERLAY_SIZE.0, OVERLAY_SIZE.1)
            .position(OVERLAY_PARK.0, OVERLAY_PARK.1)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .on_navigation(move |url| {
                // Native startup assets and this exact console origin only.
                url.as_str() == "about:srcdoc"
                    || url.as_str() == "about:blank"
                    || url.scheme() == "tauri"
                    || url.as_str().starts_with("http://tauri.localhost/")
                    || url.origin().ascii_serialization() == overlay_origin
            })
            .build()?;
            let _ = overlay.hide();
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
            // Click-outside and app-switch dismissal: hide only after the
            // overlay actually held focus, so show→focus can't self-dismiss.
            let tracked = overlay.clone();
            overlay.on_window_event(move |event| {
                if let WindowEvent::Focused(focused) = event {
                    let state = tracked.app_handle().state::<DesktopHost>();
                    if *focused {
                        state.overlay_focused.store(true, Ordering::Release);
                    } else if state.overlay_focused.swap(false, Ordering::AcqRel) {
                        let _ = tracked.hide();
                    }
                }
            });
            let supervisor = supervisor(&app.path().resource_dir()?.join("resources"))?;
            app.manage(DesktopHost {
                supervisor: supervisor.clone(),
                exiting: AtomicBool::new(false),
                overlay_focused: AtomicBool::new(false),
            });
            // Process startup, health, and recovery stay off the native event loop.
            std::thread::spawn(move || {
                let Ok((origin, mut previous_pid)) =
                    ready(&supervisor, port).map_err(|error| fail(&window, &error))
                else {
                    return;
                };
                let _ = window.navigate(origin.parse().unwrap());
                let _ = window.show();
                let _ = window.set_focus();
                let overlay_url: tauri::Url = format!("{origin}/overlay.html").parse().unwrap();
                let _ = overlay.navigate(overlay_url.clone());
                let Ok(client) = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_millis(300))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                else {
                    return;
                };
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let Ok(state) = supervisor.status() else {
                        break;
                    };
                    if state.state == ProcessState::Stopped || state.state == ProcessState::Failed {
                        break;
                    }
                    if let Some(pid) = state.pid {
                        if pid != previous_pid && health(&client, &origin, pid) {
                            // A restarted bridge has a new CSRF value; reload its bootstrap.
                            let _ = window.navigate(origin.parse().unwrap());
                            let _ = overlay.navigate(overlay_url.clone());
                            previous_pid = pid;
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Ghost desktop runtime failed")
        .run(|app, event| {
            // macOS application termination can reach Exit directly. The native
            // host must reap its owned process group before the runtime leaves.
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = app.state::<DesktopHost>().supervisor.stop();
                return;
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<DesktopHost>();
                if !state.exiting.swap(true, Ordering::AcqRel) {
                    api.prevent_exit();
                    let supervisor = state.supervisor.clone();
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let _ = supervisor.stop();
                        app.exit(0);
                    });
                }
            }
        });
}
