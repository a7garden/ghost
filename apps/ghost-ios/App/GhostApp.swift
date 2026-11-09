import SwiftUI
import UIKit
import UserNotifications
import GhostMobileCore

@main struct GhostApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = GhostModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                #if DEBUG
                .preferredColorScheme(MobileUIFixture.dark ? .dark : nil)
                #endif
        }
    }
}

// Remote-notification callbacks arrive through the app delegate. The notification
// delegate is set before launch finishes so a tap that cold-starts the app is not lost.
final class AppDelegate: NSObject, UIApplicationDelegate {
    @MainActor static let coordinator = NotificationCoordinator()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = Self.coordinator
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Self.coordinator.handleDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Self.coordinator.handleRegistrationFailure(error)
    }
}

// Ghost semantic tokens (DESIGN.md) for the native surfaces: pairing and the unreachable host.
enum GhostStyle {
    static let surface = adaptive(light: 0xffffff, dark: 0x18181b)
    static let under = adaptive(light: 0xf0f0ee, dark: 0x0e0e10)
    static let canvas = adaptive(light: 0xfafaf9, dark: 0x121214)
    static let ink = adaptive(light: 0x141518, dark: 0xececee)
    static let onInk = adaptive(light: 0xffffff, dark: 0x0c0c0e)
    static let signal = adaptive(light: 0x3d5cf5, dark: 0x7088ff)
    static let danger = adaptive(light: 0xe0372f, dark: 0xff6a62)
    static let dangerInk = adaptive(light: 0xc02a23, dark: 0xff8a83)
    static let dangerTint = adaptive(light: 0xe0372f, dark: 0xff6a62, lightAlpha: 0.10, darkAlpha: 0.14)
    static let text = ink
    static let secondary = adaptive(light: 0x646468, dark: 0x929296)
    static let border = ink.opacity(0.12)

    static let canvasColor = UIColor { traits in
        uiColor(traits.userInterfaceStyle == .dark ? 0x121214 : 0xfafaf9)
    }

    private static func uiColor(_ hex: UInt32, alpha: Double = 1) -> UIColor {
        UIColor(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, alpha: alpha)
    }

    private static func adaptive(light: UInt32, dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? uiColor(dark, alpha: darkAlpha) : uiColor(light, alpha: lightAlpha)
        })
    }
}

struct RootView: View {
    let model: GhostModel
    var body: some View {
        Group {
            if let connection = model.connection {
                WebShellView(model: model, connection: connection)
                    .id(connection.origin.absoluteString + connection.deviceId)
            } else {
                PairingFlowView(model: model)
            }
        }
        .tint(GhostStyle.ink)
        .onAppear { AppDelegate.coordinator.activate(model: model) }
        .onOpenURL { url in
            // Parsed strictly before any network or storage use; an already
            // connected device ignores pairing links.
            if model.connection == nil { model.pairing.handleDeepLink(url) }
        }
    }
}
