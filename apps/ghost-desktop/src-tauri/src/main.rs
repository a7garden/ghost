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
use tauri::Manager;

struct DesktopHost {
    supervisor: Arc<ProcessSupervisor>,
    exiting: AtomicBool,
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

const TITLEBAR: &str = r#"
document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = 'body{box-sizing:border-box;padding-top:43px!important;height:100dvh!important}.app-shell{min-height:calc(100dvh - 43px)!important}.dot-detail{height:calc(100dvh - 105px)!important}.sidebar{height:calc(100dvh - 43px)!important;top:43px!important}.main-shell.chat-shell{height:calc(100dvh - 43px)!important}.chat-shell .dot-detail{height:100%!important}.ghost-native-titlebar{position:fixed;inset:0 0 auto;height:43px;background:color-mix(in srgb,var(--color-surface-elevated-2,#ededed) 92%,var(--color-text,#222) 8%);z-index:10000;border-bottom:1px solid var(--color-border,#ddd)}';
  document.head.appendChild(style);
  const bar = document.createElement('div'); bar.className='ghost-native-titlebar';
  bar.setAttribute('data-tauri-drag-region',''); bar.setAttribute('aria-hidden','true');
  document.body.prepend(bar);
});
"#;

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
            .initialization_script(TITLEBAR)
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
            let supervisor = supervisor(&app.path().resource_dir()?.join("resources"))?;
            app.manage(DesktopHost {
                supervisor: supervisor.clone(),
                exiting: AtomicBool::new(false),
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
