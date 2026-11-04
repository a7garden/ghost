// Ghost Preview runs the same console and package assets as macOS.
// The existing mobile gateway remains the owner of production pairing.
#[cfg(target_os = "ios")]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let url = preview_url();
            let origin = url.origin();
            tauri::WebviewWindowBuilder::new(
                app,
                "package-preview",
                tauri::WebviewUrl::External(url),
            )
            .on_navigation(move |url| url.origin() == origin || url.as_str() == "about:blank")
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("start Ghost package preview");
}

#[cfg(target_os = "ios")]
fn preview_url() -> tauri::Url {
    // Only an explicitly supplied local development endpoint is accepted.
    if let Some(url) = std::env::var("GHOST_IOS_PREVIEW_URL")
        .ok()
        .and_then(|value| tauri::Url::parse(&value).ok())
        .filter(|url| {
            url.scheme() == "http"
                && url.username().is_empty()
                && url.password().is_none()
                && url
                    .host_str()
                    .and_then(|host| host.parse::<std::net::Ipv4Addr>().ok())
                    .is_some_and(|ip| ip.is_loopback() || ip.is_private())
        })
    {
        return url;
    }
    "http://127.0.0.1:65179/".parse().expect("loopback URL")
}
