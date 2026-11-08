fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "drag_window",
            "open_external_url",
            "pick_folder",
            "companion_set",
            "companion_enabled",
            "companion_reset_position",
            "companion_resize",
            "companion_anchor",
            "toggle_overlay",
            "focus_main",
            "companion_menu",
            "companion_drag",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
