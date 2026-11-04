import UIKit
@preconcurrency import UserNotifications
import GhostMobileCore

// APNs alert delivery for the durable notification outbox. Registration is
// idempotent: the token is re-uploaded whenever it changes, and delivery
// state (transport_accepted / client_seen) stays in the Host ledger.
@MainActor final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    private weak var model: GhostModel?

    func activate(model: GhostModel) {
        self.model = model
        UNUserNotificationCenter.current().delegate = self
    }

    func requestAuthorizationAndRegister(model: GhostModel) {
        activate(model: model)
        model.pushStatus = nil
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            Task { @MainActor in
                switch settings.authorizationStatus {
                case .notDetermined:
                    model.pushStatus = "알림 권한을 요청합니다."
                    let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                    model.pushStatus = granted ? nil : "알림이 꺼져 있어 완료 알림을 받지 못합니다."
                case .denied:
                    model.pushStatus = "알림이 꺼져 있어 완료 알림을 받지 못합니다."
                default:
                    model.pushStatus = nil
                }
                guard settings.authorizationStatus != .denied else { return }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func handleDeviceToken(_ token: Data) {
        guard let model else { return }
        let tokenText = token.map { String(format: "%02x", $0) }.joined()
        guard let api = model.api else {
            model.pendingPushToken = tokenText
            return
        }
        model.pushStatus = "알림 토큰을 등록하는 중…"
        Task {
            do {
                try await api.registerPushToken(tokenText, environment: PushEnvironment.current)
                model.pushStatus = nil
                model.pendingPushToken = nil
            } catch {
                model.pendingPushToken = tokenText
                model.pushStatus = "알림 토큰 등록이 실패했습니다. 연결 후 다시 시도됩니다."
            }
        }
    }

    func handleRegistrationFailure(_ error: Error) {
        guard let model else { return }
        #if targetEnvironment(simulator)
        model.pushStatus = "시뮬레이터는 원격 알림을 등록하지 못합니다. 실기기에서 확인해 주세요."
        #else
        model.pushStatus = "원격 알림 등록이 실패했습니다: \(error.localizedDescription)"
        #endif
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
        let coordinator = self
        Task { @MainActor in
            await coordinator.model?.openNotification(notificationID: identifier)
        }
    }
}

enum PushEnvironment {
    // Debug builds use Apple's sandbox gateway; release builds use production.
    static var current: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}
