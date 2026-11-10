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

/// CSS-pixel paint bounds, never persisted with the companion's preferences.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibleAnchor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    center_x: f64,
    window_width: f64,
    window_height: f64,
}

impl VisibleAnchor {
    fn validate(&self, size: (f64, f64)) -> Result<(), String> {
        if [
            self.x,
            self.y,
            self.width,
            self.height,
            self.center_x,
            self.window_width,
            self.window_height,
            size.0,
            size.1,
        ]
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
            || self.width <= 0.0
            || self.height <= 0.0
            || size.0 <= 0.0
            || size.1 <= 0.0
            // A logical client dimension can round by one physical pixel.
            || (self.window_width - size.0).abs() > 1.0
            || (self.window_height - size.1).abs() > 1.0
            || self.x + self.width > self.window_width
            || self.y + self.height > self.window_height
            || self.x + self.width > size.0 + 1.0
            || self.y + self.height > size.1 + 1.0
            || self.center_x < self.x
            || self.center_x > self.x + self.width
        {
            return Err("올바르지 않거나 크기가 지난 아바타 표시 영역입니다.".into());
        }
        Ok(())
    }

    fn physical_geometry(
        &self,
        window: super::PxRect,
        scale: f64,
    ) -> Result<(super::PxRect, i64), String> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err("아바타 화면 배율을 읽지 못했습니다.".into());
        }
        self.validate((
            f64::from(window.width) / scale,
            f64::from(window.height) / scale,
        ))?;
        let left = super::logical_px(self.x, scale);
        let top = super::logical_px(self.y, scale);
        Ok((
            super::PxRect {
                x: window.x.saturating_add(left),
                y: window.y.saturating_add(top),
                width: super::logical_px(self.x + self.width, scale) - left,
                height: super::logical_px(self.y + self.height, scale) - top,
            },
            i64::from(window.x) + i64::from(super::logical_px(self.center_x, scale)),
        ))
    }
}

pub struct CompanionState {
    path: PathBuf,
    config: Mutex<Config>,
    visible_anchor: Mutex<Option<VisibleAnchor>>,
}

impl CompanionState {
    pub(super) fn visible_geometry(
        &self,
        window: super::PxRect,
        scale: f64,
    ) -> (super::PxRect, i64) {
        let fallback = (window, i64::from(window.x) + i64::from(window.width) / 2);
        let Ok(mut saved) = self.visible_anchor.lock() else {
            eprintln!("[ghost] 아바타 표시 영역을 읽지 못했습니다.");
            return fallback;
        };
        match saved
            .as_ref()
            .map(|anchor| anchor.physical_geometry(window, scale))
        {
            Some(Ok(geometry)) => geometry,
            Some(Err(error)) => {
                eprintln!("[ghost] {error}");
                *saved = None;
                fallback
            }
            None => fallback,
        }
    }

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

/// One axis of a work-area clamp. i64 avoids overflowing when a disconnected
/// display left an extreme saved coordinate. `pub(super)` so the overlay's
/// pet-anchored geometry in the crate root reuses the same rule.
pub(super) fn clamp_axis(value: i64, start: i32, available: u32, extent: u32) -> i32 {
    let end = i64::from(start) + i64::from(available.saturating_sub(extent));
    value
        .clamp(i64::from(start), end)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn clamp(position: Position, origin: Position, area: (u32, u32), size: (u32, u32)) -> Position {
    Position {
        x: clamp_axis(i64::from(position.x), origin.x, area.0, size.0),
        y: clamp_axis(i64::from(position.y), origin.y, area.1, size.1),
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
        visible_anchor: Mutex::new(None),
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
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(point) => {
            let state = tracked.app_handle().state::<CompanionState>();
            if let Ok(mut config) = state.config.lock() {
                config.position = Some(Position {
                    x: point.x,
                    y: point.y,
                });
            };
        }
        WindowEvent::Resized(_) => {
            let state = tracked.app_handle().state::<CompanionState>();
            if let Ok(mut anchor) = state.visible_anchor.lock() {
                *anchor = None;
            };
        }
        _ => {}
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

#[tauri::command]
pub fn companion_anchor(window: WebviewWindow, bounds: VisibleAnchor) -> Result<(), String> {
    if window.label() != "companion" {
        return Err("허용되지 않은 창입니다.".into());
    }
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("아바타 화면을 찾지 못했습니다.")?;
    let scale = monitor.scale_factor();
    bounds.validate((
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    ))?;
    *window
        .state::<CompanionState>()
        .visible_anchor
        .lock()
        .map_err(|_| "아바타 표시 영역을 저장하지 못했습니다.")? = Some(bounds);
    Ok(())
}

/// Track a held pointer on a worker; all NSWindow access stays on the main thread.
/// WebKit IPC cannot provide the original AppKit press for performWindowDragWithEvent.
#[cfg(target_os = "macos")]
pub(super) fn track_window_drag(window: &WebviewWindow) -> Result<bool, String> {
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
    Ok(moved)
}

/// Borderless, non-key windows cannot reliably use AppKit's event-driven
/// performWindowDragWithEvent through WebKit IPC. Track the global pointer
/// without activating the app; frame updates stay on AppKit's main thread.
#[tauri::command]
pub async fn companion_drag(window: WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use std::sync::mpsc;
            let moved = track_window_drag(&window)?;
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
        super::drag_window(window).await?;
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
    use super::{clamp, load_config, CompanionState, Config, Position, VisibleAnchor};
    use std::sync::Mutex;

    fn anchor() -> VisibleAnchor {
        VisibleAnchor {
            x: 30.0,
            y: 55.0,
            width: 80.0,
            height: 100.0,
            center_x: 70.0,
            window_width: 140.0,
            window_height: 170.0,
        }
    }

    #[test]
    fn transparent_window_offset_places_tail_at_painted_head_at_both_corners() {
        let area = super::super::PxRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1056,
        };
        for (window_x, expected_x, expected_anchor) in [(1780, 1520, 330.0), (0, 0, 70.0)] {
            let (paint, center) = anchor()
                .physical_geometry(
                    super::super::PxRect {
                        x: window_x,
                        y: 700,
                        width: 140,
                        height: 170,
                    },
                    1.0,
                )
                .unwrap();
            assert_eq!(paint.y, 755);
            let placed = super::super::place_overlay_near_pet(
                paint,
                center,
                area,
                1.0,
                super::super::OVERLAY_PET_GAP,
                super::super::OVERLAY_SIZE,
                super::super::OVERLAY_MIN_HEIGHT,
            )
            .unwrap();
            assert_eq!(placed.y + placed.height, 751);
            assert_eq!(placed.x, expected_x);
            assert_eq!(placed.anchor_x, expected_anchor);
        }
    }

    #[test]
    fn paint_uses_companion_scale_and_body_center_not_decoration_center() {
        let decorated = VisibleAnchor {
            x: 20.0,
            width: 110.0,
            ..anchor()
        };
        let (paint, center) = decorated
            .physical_geometry(
                super::super::PxRect {
                    x: -3840,
                    y: 400,
                    width: 280,
                    height: 340,
                },
                2.0,
            )
            .unwrap();
        assert_eq!(
            paint,
            super::super::PxRect {
                x: -3800,
                y: 510,
                width: 220,
                height: 200
            }
        );
        assert_eq!(center, -3700);
        assert_ne!(center, i64::from(paint.x) + i64::from(paint.width) / 2);
    }

    #[test]
    fn invalid_paint_bounds_and_stale_viewports_are_rejected() {
        assert!(anchor().validate((140.0, 170.0)).is_ok());
        for invalid in [
            VisibleAnchor {
                x: -1.0,
                ..anchor()
            },
            VisibleAnchor {
                y: f64::NAN,
                ..anchor()
            },
            VisibleAnchor {
                width: f64::INFINITY,
                ..anchor()
            },
            VisibleAnchor {
                height: 0.0,
                ..anchor()
            },
            VisibleAnchor {
                height: 116.0,
                ..anchor()
            },
            VisibleAnchor {
                center_x: 111.0,
                ..anchor()
            },
            VisibleAnchor {
                window_width: 168.0,
                ..anchor()
            },
        ] {
            assert!(invalid.validate((140.0, 170.0)).is_err());
        }
        assert!(anchor().validate((112.0, 142.0)).is_err());
        assert!(anchor().validate((f64::NAN, 170.0)).is_err());
        assert!(serde_json::from_str::<VisibleAnchor>(
            r#"{"x":0,"y":0,"width":1,"height":1,"centerX":0,"windowWidth":140,"windowHeight":170,"state":{}}"#
        ).is_err());
    }

    #[test]
    fn resize_discards_old_paint_and_falls_back_to_current_window_bounds() {
        let state = CompanionState {
            path: std::path::PathBuf::new(),
            config: Mutex::new(Config::default()),
            visible_anchor: Mutex::new(Some(anchor())),
        };
        let resized = super::super::PxRect {
            x: 20,
            y: 30,
            width: 112,
            height: 142,
        };
        assert_eq!(state.visible_geometry(resized, 1.0), (resized, 76));
        assert!(state.visible_anchor.lock().unwrap().is_none());
    }

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
            visible_anchor: Mutex::new(None),
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
