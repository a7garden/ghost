use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf, sync::Mutex};
use tauri::{Manager, PhysicalPosition, WebviewWindow, WindowEvent};

const SIZE: (f64, f64) = (140.0, 170.0);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Position {
    x: i32,
    y: i32,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
struct Config {
    enabled: bool,
    position: Option<Position>,
}

pub struct CompanionState {
    path: PathBuf,
    config: Mutex<Config>,
}

impl CompanionState {
    fn save(&self, config: &Config) -> Result<(), String> {
        let parent = self.path.parent().ok_or("아바타 설정 경로가 없습니다.")?;
        std::fs::create_dir_all(parent).map_err(|_| "아바타 설정 폴더를 만들지 못했습니다.")?;
        let bytes = serde_json::to_vec(config).map_err(|_| "아바타 설정을 저장하지 못했습니다.")?;
        let temporary = self.path.with_extension("json.tmp");
        let mut file =
            std::fs::File::create(&temporary).map_err(|_| "아바타 설정을 저장하지 못했습니다.")?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "아바타 설정을 저장하지 못했습니다.")?;
        std::fs::rename(temporary, &self.path)
            .map_err(|_| "아바타 설정을 저장하지 못했습니다.".into())
    }
}

fn config_path() -> PathBuf {
    super::console_config_path().with_file_name("companion.json")
}

fn load_config(path: &std::path::Path) -> Config {
    let result = match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "아바타 설정의 형식이 올바르지 않습니다.")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Config::default(),
        Err(_) => Err("아바타 설정을 읽지 못했습니다."),
    };
    result.unwrap_or_else(|error| {
        eprintln!("[ghost] {error} 기본 아바타 설정을 사용합니다.");
        Config::default()
    })
}

fn clamp(position: Position, origin: Position, area: (u32, u32), size: (u32, u32)) -> Position {
    // i64 avoids overflowing when a disconnected display left an extreme saved coordinate.
    let axis = |value: i32, start: i32, available: u32, extent: u32| {
        let end = i64::from(start) + i64::from(available.saturating_sub(extent));
        i64::from(value)
            .clamp(i64::from(start), end)
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
    };
    Position {
        x: axis(position.x, origin.x, area.0, size.0),
        y: axis(position.y, origin.y, area.1, size.1),
    }
}

fn position(window: &WebviewWindow, reset: bool) -> Result<(), String> {
    let app = window.app_handle();
    let state = app.state::<CompanionState>();
    let saved = if reset {
        None
    } else {
        state
            .config
            .lock()
            .map_err(|_| "아바타 설정을 읽지 못했습니다.")?
            .position
    };
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let monitor = saved
        .and_then(|saved| {
            monitors
                .iter()
                .find(|monitor| {
                    let area = monitor.work_area();
                    i64::from(saved.x) >= i64::from(area.position.x)
                        && i64::from(saved.x)
                            < i64::from(area.position.x) + i64::from(area.size.width)
                        && i64::from(saved.y) >= i64::from(area.position.y)
                        && i64::from(saved.y)
                            < i64::from(area.position.y) + i64::from(area.size.height)
                })
                .cloned()
        })
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|main| main.current_monitor().ok().flatten())
        })
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("아바타를 표시할 화면을 찾지 못했습니다.")?;
    let area = monitor.work_area();
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let gap = (20.0 * monitor.scale_factor()).round() as i32;
    let default = Position {
        x: area
            .position
            .x
            .saturating_add_unsigned(area.size.width)
            .saturating_sub_unsigned(size.width)
            .saturating_sub(gap),
        y: area
            .position
            .y
            .saturating_add_unsigned(area.size.height)
            .saturating_sub_unsigned(size.height)
            .saturating_sub(gap),
    };
    let next = clamp(
        saved.unwrap_or(default),
        Position {
            x: area.position.x,
            y: area.position.y,
        },
        (area.size.width, area.size.height),
        (size.width, size.height),
    );
    window
        .set_position(PhysicalPosition::new(next.x, next.y))
        .map_err(|error| error.to_string())?;
    let mut config = state
        .config
        .lock()
        .map_err(|_| "아바타 설정을 읽지 못했습니다.")?;
    config.position = Some(next);
    state.save(&config)
}

pub fn create(app: &tauri::AppHandle, origin: &super::OriginCell) -> Result<WebviewWindow, String> {
    let path = config_path();
    let config = load_config(&path);
    app.manage(CompanionState {
        path,
        config: Mutex::new(config),
    });
    let allowed = origin.clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "companion",
        tauri::WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("Ghost 아바타")
    .inner_size(SIZE.0, SIZE.1)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focusable(false)
    .focused(false)
    .visible(false)
    .on_navigation(move |url| super::navigation_allowed(&allowed, url))
    .build()
    .map_err(|error| format!("아바타 창을 만들지 못했습니다: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        // SAFETY: setup runs on the main thread; Tauri owns this live NSWindow.
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        native.setHidesOnDeactivate(false);
    }
    let tracked = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(point) = event {
            let state = tracked.app_handle().state::<CompanionState>();
            if let Ok(mut config) = state.config.lock() {
                config.position = Some(Position {
                    x: point.x,
                    y: point.y,
                });
            };
        }
    });
    let menu_window = window.clone();
    window.on_menu_event(move |_, event| {
        let result = match event.id().as_ref() {
            "companion-chat" => {
                super::toggle_overlay(menu_window.app_handle());
                Ok(())
            }
            "companion-main" => focus_main(menu_window.app_handle().clone()),
            "companion-hide" => companion_set(menu_window.clone(), false).and_then(|()| {
                menu_window
                    .eval("window.dispatchEvent(new Event('ghost-companion-hide'))")
                    .map_err(|error| error.to_string())
            }),
            _ => Ok(()),
        };
        if let Err(error) = result {
            eprintln!("[ghost] {error}");
        }
    });
    Ok(window)
}

pub fn navigate(window: &WebviewWindow, endpoint: &super::Endpoint) {
    if let Ok(url) = tauri::Url::parse(&format!("{}/companion.html", endpoint.origin)) {
        let _ = window.navigate(url);
        // The page calls companion_set after its first paint, so an enabled avatar
        // never flashes an empty webview while the Host reconnects.
    }
}

#[tauri::command]
pub fn companion_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<CompanionState>();
    let config = state
        .config
        .lock()
        .map_err(|_| "아바타 설정을 읽지 못했습니다.")?;
    Ok(config.enabled)
}

#[tauri::command]
pub fn companion_set(window: WebviewWindow, visible: bool) -> Result<(), String> {
    if !matches!(window.label(), "main" | "companion") {
        return Err("허용되지 않은 창입니다.".into());
    }
    let app = window.app_handle();
    let companion = app
        .get_webview_window("companion")
        .ok_or("아바타 창을 찾지 못했습니다.")?;
    let state = app.state::<CompanionState>();
    {
        let mut config = state
            .config
            .lock()
            .map_err(|_| "아바타 설정을 읽지 못했습니다.")?;
        let next = Config {
            enabled: visible,
            ..config.clone()
        };
        state.save(&next)?;
        *config = next;
    }
    if visible {
        position(&companion, false)?;
        companion.show().map_err(|error| error.to_string())
    } else {
        companion.hide().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn companion_reset_position(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("companion")
        .ok_or("아바타 창을 찾지 못했습니다.")?;
    position(&window, true)
}

#[tauri::command]
pub fn companion_resize(window: WebviewWindow, size: String) -> Result<(), String> {
    let dimensions = match size.as_str() {
        "s" => (112.0, 142.0),
        "m" => SIZE,
        "l" => (168.0, 198.0),
        _ => return Err("올바르지 않은 아바타 크기입니다.".into()),
    };
    window
        .set_size(tauri::LogicalSize::new(dimensions.0, dimensions.1))
        .map_err(|error| error.to_string())?;
    position(&window, false)
}

/// Borderless, non-key windows cannot reliably use AppKit's event-driven
/// performWindowDragWithEvent through WebKit IPC. Track the global pointer
/// without activating the app; frame updates stay on AppKit's main thread.
#[tauri::command]
pub async fn companion_drag(window: WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use objc2_app_kit::{NSEvent, NSWindow};
            use std::{sync::mpsc, time::Duration};
            let (sender, receiver) = mpsc::channel();
            let initial = window.clone();
            window
                .run_on_main_thread(move || {
                    let result = initial
                        .ns_window()
                        .map(|pointer| {
                            // SAFETY: this callback runs on the main thread; Tauri owns the window.
                            let native = unsafe { &*pointer.cast::<NSWindow>() };
                            let origin = native.frame().origin;
                            let mouse = NSEvent::mouseLocation();
                            (origin.x, origin.y, mouse.x, mouse.y)
                        })
                        .map_err(|error| error.to_string());
                    let _ = sender.send(result);
                })
                .map_err(|error| error.to_string())?;
            let (x, y, mouse_x, mouse_y) = receiver.recv().map_err(|error| error.to_string())??;
            let mut moved = false;
            while NSEvent::pressedMouseButtons() & 1 != 0 {
                let mouse = NSEvent::mouseLocation();
                let dx = mouse.x - mouse_x;
                let dy = mouse.y - mouse_y;
                if moved || dx.hypot(dy) >= 4.0 {
                    moved = true;
                    let target = window.clone();
                    window
                        .run_on_main_thread(move || {
                            if let Ok(pointer) = target.ns_window() {
                                // SAFETY: live Tauri window, accessed only on the main thread.
                                let native = unsafe { &*pointer.cast::<NSWindow>() };
                                let mut origin = native.frame().origin;
                                origin.x = x + dx;
                                origin.y = y + dy;
                                native.setFrameOrigin(origin);
                            }
                        })
                        .map_err(|error| error.to_string())?;
                }
                std::thread::sleep(Duration::from_millis(16));
            }
            if moved {
                // Queue after all frame updates, then save once on this worker.
                let (sender, receiver) = mpsc::channel();
                let final_window = window.clone();
                window
                    .run_on_main_thread(move || {
                        let _ = sender.send(final_window.outer_position());
                    })
                    .map_err(|error| error.to_string())?;
                let point = receiver
                    .recv()
                    .map_err(|error| error.to_string())?
                    .map_err(|error| error.to_string())?;
                let state = window.app_handle().state::<CompanionState>();
                let mut config = state
                    .config
                    .lock()
                    .map_err(|_| "아바타 설정을 읽지 못했습니다.")?;
                config.position = Some(Position {
                    x: point.x,
                    y: point.y,
                });
                state.save(&config)?;
            }
            Ok(moved)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        super::drag_window(window)?;
        Ok(false)
    }
}

#[tauri::command]
pub fn toggle_overlay(app: tauri::AppHandle) {
    super::toggle_overlay(&app);
}

#[tauri::command]
pub fn focus_main(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Ghost 창을 찾지 못했습니다.")?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn companion_menu(window: WebviewWindow) -> Result<(), String> {
    let menu = tauri::menu::MenuBuilder::new(window.app_handle())
        .text("companion-chat", "대화 열기")
        .text("companion-main", "Ghost 창 열기")
        .separator()
        .text("companion-hide", "숨기기")
        .build()
        .map_err(|error| error.to_string())?;
    window.popup_menu(&menu).map_err(|error| error.to_string())
}
#[cfg(test)]
mod tests {
    use super::{clamp, load_config, CompanionState, Config, Position};
    use std::sync::Mutex;

    #[test]
    fn config_defaults_are_hidden_and_unpositioned() {
        assert_eq!(
            serde_json::from_str::<Config>("{}").unwrap(),
            Config::default()
        );
        assert!(!Config::default().enabled);
    }

    #[test]
    fn corrupt_empty_and_unreadable_config_fall_back_and_can_be_replaced() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ghost-companion-config-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("companion.json");
        assert_eq!(load_config(&path), Config::default());
        assert_eq!(load_config(&directory), Config::default());
        for bytes in [
            b"".as_slice(),
            b"{broken".as_slice(),
            br#"{"enabled":"yes"}"#.as_slice(),
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(load_config(&path), Config::default());
        }
        let config = Config {
            enabled: true,
            position: Some(Position { x: 12, y: 34 }),
        };
        let state = CompanionState {
            path: path.clone(),
            config: Mutex::new(config.clone()),
        };
        state.save(&config).unwrap();
        assert_eq!(load_config(&path), config);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn config_round_trips_and_rejects_invalid_fields() {
        let config = Config {
            enabled: true,
            position: Some(Position { x: -1400, y: 400 }),
        };
        assert_eq!(
            serde_json::from_slice::<Config>(&serde_json::to_vec(&config).unwrap()).unwrap(),
            config
        );
        assert!(serde_json::from_str::<Config>(r#"{"enabled":"yes"}"#).is_err());
        assert!(serde_json::from_str::<Config>(r#"{"position":{"x":0}}"#).is_err());
    }

    #[test]
    fn position_stays_within_work_area_on_negative_monitor() {
        assert_eq!(
            clamp(
                Position { x: -3000, y: 2000 },
                Position { x: -1920, y: 24 },
                (1920, 1056),
                (280, 340)
            ),
            Position { x: -1920, y: 740 }
        );
        assert_eq!(
            clamp(
                Position { x: -500, y: 400 },
                Position { x: -1920, y: 24 },
                (1920, 1056),
                (280, 340)
            ),
            Position { x: -500, y: 400 }
        );
    }

    #[test]
    fn oversized_window_and_extreme_coordinates_are_safe() {
        assert_eq!(
            clamp(
                Position {
                    x: i32::MAX,
                    y: i32::MIN
                },
                Position { x: 10, y: 20 },
                (100, 100),
                (280, 340)
            ),
            Position { x: 10, y: 20 }
        );
    }
}
