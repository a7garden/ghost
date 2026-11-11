import Foundation

/// The contract between the native shell and the Host-served web UI
/// (`apps/ghost-ui/src/host/shell.ts`). The page owns every Ghost surface; the shell
/// owns pairing, the Keychain credential, notification permission and push routing.
public enum Shell {
    /// `window.webkit.messageHandlers.<handlerName>` in the page.
    public static let handlerName = "ghostShell"

    private struct Bootstrap: Encodable {
        let origin: String
        let token: String
        let platform = "ios"
        let version: String
        let deviceId: String
    }

    /// Document-start script for the paired origin's main frame. It hands the device
    /// token and shell identity to the page and refuses to do so on any other origin.
    public static func bootstrapScript(connection: Connection, version: String) -> String {
        let payload = Bootstrap(origin: origin(connection.origin), token: connection.token, version: version, deviceId: connection.deviceId)
        let json = String(data: (try? JSONEncoder().encode(payload)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
        return """
        (function () {
          var s = \(json);
          if (window.location.origin !== s.origin) return;
          var lock = function (name, value) { Object.defineProperty(window, name, { value: value, writable: false, configurable: false, enumerable: false }); };
          lock('__GHOST_TOKEN__', s.token);
          lock('__GHOST_SHELL__', Object.freeze({ platform: s.platform, version: s.version, deviceId: s.deviceId }));
        })();
        """
    }

    /// Script that delivers one native event to the page as a `ghost-shell` CustomEvent.
    public static func dispatchScript(_ event: ShellEvent) -> String {
        "window.dispatchEvent(new CustomEvent('ghost-shell', { detail: \(event.json) }));"
    }

    /// The serialized origin the page reports as `location.origin`.
    public static func origin(_ url: URL) -> String {
        guard let scheme = url.scheme, let host = url.host else { return "" }
        return origin(scheme: scheme, host: host, port: url.port)
    }

    /// Same serialization from parts; WebKit's security-origin host may already carry IPv6 brackets.
    public static func origin(scheme: String, host: String, port: Int?) -> String {
        let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
        let bracketed = bare.contains(":") ? "[\(bare)]" : bare
        return "\(scheme.lowercased())://\(bracketed.lowercased())\(port.map { ":\($0)" } ?? "")"
    }

    /// Only the paired Host's exact HTTPS manifest endpoint may start an OTA install.
    public static func installURL(_ raw: String, origin paired: URL) -> URL? {
        guard raw.hasPrefix("itms-services://?"),
              let install = URLComponents(string: raw),
              install.scheme == "itms-services",
              install.host?.isEmpty != false,
              install.user == nil, install.password == nil, install.port == nil,
              install.percentEncodedPath.isEmpty, install.fragment == nil,
              let items = install.queryItems, items.count == 2,
              items.first(where: { $0.name == "action" })?.value == "download-manifest",
              let manifestText = items.first(where: { $0.name == "url" })?.value,
              let manifest = URLComponents(string: manifestText),
              manifest.scheme == "https",
              manifest.user == nil, manifest.password == nil, manifest.fragment == nil,
              manifest.percentEncodedPath == "/api/update/ios/manifest.plist",
              let manifestURL = manifest.url,
              origin(manifestURL) == origin(paired),
              let url = URL(string: raw, encodingInvalidCharacters: false) else { return nil }
        return url
    }

    /// Whether a navigation stays inside the paired Host. Sandboxed previews
    /// (`about:srcdoc`, `about:blank`) and in-page `blob:`/`data:` documents are inert;
    /// anything else leaves the app.
    public static func staysInside(_ url: URL, origin paired: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "about", "blob", "data": return true
        case "http", "https": return origin(url) == origin(paired)
        default: return false
        }
    }
}

/// Native → page events.
public enum ShellEvent: Equatable, Sendable {
    case notificationOpen(String)
    case resume

    var json: String {
        switch self {
        case .notificationOpen(let id):
            let quoted = String(data: (try? JSONEncoder().encode(id)) ?? Data("\"\"".utf8), encoding: .utf8) ?? "\"\""
            return "{\"type\":\"notification.open\",\"notificationId\":\(quoted)}"
        case .resume:
            return "{\"type\":\"resume\"}"
        }
    }

    /// The reply body for `ready`: the same shape the live event carries.
    public var payload: [String: String] {
        switch self {
        case .notificationOpen(let id): ["type": "notification.open", "notificationId": id]
        case .resume: ["type": "resume"]
        }
    }
}

/// Page → native requests (`postMessage` bodies). Anything else is rejected.
public enum ShellRequest: Equatable, Sendable {
    case ready
    case notificationsStatus
    case notificationsRequest
    case notificationsSettings
    case appInstall(URL)
    case theme(dark: Bool)
    case haptic(HapticStyle)
    case disconnected
    case revoked

    public enum HapticStyle: String, Sendable { case selection, success, warning }

    public init?(body: Any) {
        guard let body = body as? [String: Any], let type = body["type"] as? String else { return nil }
        switch type {
        case "ready": self = .ready
        case "notifications.status": self = .notificationsStatus
        case "notifications.request": self = .notificationsRequest
        case "notifications.settings": self = .notificationsSettings
        case "app.install":
            guard let raw = body["url"] as? String,
                  let url = URL(string: raw, encodingInvalidCharacters: false) else { return nil }
            self = .appInstall(url)
        case "theme":
            guard let scheme = body["scheme"] as? String, scheme == "light" || scheme == "dark" else { return nil }
            self = .theme(dark: scheme == "dark")
        case "haptic":
            guard let raw = body["style"] as? String, let style = HapticStyle(rawValue: raw) else { return nil }
            self = .haptic(style)
        case "disconnected": self = .disconnected
        case "revoked": self = .revoked
        default: return nil
        }
    }
}
