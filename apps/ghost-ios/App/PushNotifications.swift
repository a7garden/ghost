import UIKit
@preconcurrency import UserNotifications

// APNs alert delivery for the durable notification outbox. Registration is
// idempotent: the token is re-uploaded whenever it changes, and delivery
// state stays in the Host ledger. A tap becomes a page event; the web UI routes it.
@MainActor final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    private weak var model: GhostModel?
    /// Taps that arrived before the model attached (a tap that cold-started the app).
    private var earlyTaps: [String] = []

    func activate(model: GhostModel) {
        self.model = model
        UNUserNotificationCenter.current().delegate = self
        for id in earlyTaps { model.enqueue(.notificationOpen(id)) }
        earlyTaps = []
    }

    /// Permission as the page sees it: `allowed`, `denied` or `undetermined`.
    func status() async -> String {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: return "undetermined"
        case .denied: return "denied"
        default: return "allowed"
        }
    }

    /// Asks iOS once when undetermined, then registers for remote alerts when allowed.
    func requestAndRegister() async -> String {
        let center = UNUserNotificationCenter.current()
        if await status() == "undetermined" {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        let current = await status()
        if current == "allowed" { UIApplication.shared.registerForRemoteNotifications() }
        return current
    }

    func handleDeviceToken(_ token: Data) {
        guard let model else { return }
        let tokenText = token.map { String(format: "%02x", $0) }.joined()
        Task { await model.registerPushToken(tokenText, environment: PushEnvironment.current) }
    }

    func handleRegistrationFailure(_ error: Error) {
        // Without the push entitlement (personal signing team) iOS refuses a token;
        // the page reads permission separately and nothing else depends on it.
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let identifier = response.notification.request.content.userInfo["notification_id"] as? String ?? ""
        completionHandler()
        guard !identifier.isEmpty else { return }
        let coordinator = self
        Task { @MainActor in
            if let model = coordinator.model { model.enqueue(.notificationOpen(identifier)) }
            else { coordinator.earlyTaps.append(identifier) }
        }
    }
}

enum PushEnvironment {
    // Debug builds use Apple's sandbox environment; release builds use production.
    static var current: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}
