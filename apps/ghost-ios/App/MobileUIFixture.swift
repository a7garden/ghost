#if DEBUG
import Foundation
import GhostMobileCore

/// Launch arguments for UI tests. `--pairing` opens the connect screen without a saved
/// credential; `--shell-origin/--shell-device/--shell-token` open the shell against a
/// test Host (an isolated dev host) without touching the Keychain.
enum MobileUIFixture {
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }
    static var enabled: Bool { arguments.contains("--ui-testing") }
    static var dark: Bool { enabled && arguments.contains("--dark") }
    static var pairing: Bool { enabled && arguments.contains("--pairing") }

    static var connection: Connection? {
        guard enabled, let origin = value("--shell-origin"), let device = value("--shell-device"), let token = value("--shell-token") else { return nil }
        return try? Connection(origin: origin, deviceId: device, token: token)
    }

    /// `--shell-route /inbox` opens the page at that hash route (screenshots of one screen).
    static var shellRoute: String? { enabled ? value("--shell-route") : nil }

    /// `--shell-loading` shows the first-load view alone, without a Host; `--mark-at 0.4` holds every living mark at
    /// that many seconds and `--mark-ready-at 2` has it recognise the page from that second (screenshots of one moment).
    static var shellLoading: Bool { enabled && arguments.contains("--shell-loading") }
    static var markAt: TimeInterval? { enabled ? value("--mark-at").flatMap { TimeInterval($0) } : nil }
    static var markReadyAt: TimeInterval? { enabled ? value("--mark-ready-at").flatMap { TimeInterval($0) } : nil }

    private static func value(_ name: String) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}
#endif
