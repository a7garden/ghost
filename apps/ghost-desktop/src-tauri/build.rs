fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["drag_window"])),
    )
    .expect("failed to run the Tauri build script");
}
