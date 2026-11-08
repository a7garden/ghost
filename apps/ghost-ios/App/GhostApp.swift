import SwiftUI
import UIKit
import GhostMobileCore

@main struct GhostApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = GhostModel()
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if MobileUIFixture.enabled, let width = MobileUIFixture.reviewWidth {
                RootView(model: model)
                    .environment(\.horizontalSizeClass, width < 600 ? .compact : .regular)
                    .frame(width: width).frame(maxWidth: .infinity)
                    .preferredColorScheme(MobileUIFixture.dark ? .dark : nil)
            } else { RootView(model: model).preferredColorScheme(MobileUIFixture.dark ? .dark : nil) }
            #else
            RootView(model: model)
            #endif
        }
    }
}

// Remote-notification callbacks arrive through the app delegate; delivery
// state and routing stay in the model and the host ledger.
final class AppDelegate: NSObject, UIApplicationDelegate {
    static let coordinator = NotificationCoordinator()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool { true }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Self.coordinator.handleDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Self.coordinator.handleRegistrationFailure(error)
    }
}

// Ghost mobile semantic tokens (DESIGN.md); native type and touch sizes
// follow Dynamic Type and iOS accessibility rather than desktop pixel sizes.
enum GhostStyle {
    static let surface = adaptive(light: 0xffffff, dark: 0x18181b)
    static let under = adaptive(light: 0xf0f0ee, dark: 0x0e0e10)
    static let canvas = adaptive(light: 0xfafaf9, dark: 0x121214)
    static let page = adaptive(light: 0xf3f3f1, dark: 0x0c0c0e)
    static let ink = adaptive(light: 0x141518, dark: 0xececee)
    static let onInk = adaptive(light: 0xffffff, dark: 0x0c0c0e)
    static let signal = adaptive(light: 0x3d5cf5, dark: 0x7088ff)
    static let signalInk = adaptive(light: 0x2c47d1, dark: 0x98a9ff)
    static let amber = adaptive(light: 0xf0a020, dark: 0xf5b13d)
    static let amberInk = adaptive(light: 0xa35a00, dark: 0xf7bd5c)
    static let success = adaptive(light: 0x1f9d55, dark: 0x3fcf7f)
    static let successInk = adaptive(light: 0x157a41, dark: 0x5ad893)
    static let danger = adaptive(light: 0xe0372f, dark: 0xff6a62)
    static let dangerInk = adaptive(light: 0xc02a23, dark: 0xff8a83)
    static let signalTint = adaptive(light: 0x3d5cf5, dark: 0x7088ff, lightAlpha: 0.09, darkAlpha: 0.15)
    static let amberTint = amber.opacity(0.14)
    static let successTint = adaptive(light: 0x1f9d55, dark: 0x3fcf7f, lightAlpha: 0.11, darkAlpha: 0.13)
    static let dangerTint = adaptive(light: 0xe0372f, dark: 0xff6a62, lightAlpha: 0.10, darkAlpha: 0.14)
    static let accent = signalInk
    static let warning = dangerInk
    static let destructive = dangerInk
    static let onDestructive = Color.white
    static let text = ink
    static let secondary = adaptive(light: 0x646468, dark: 0x929296)
    static let border = ink.opacity(0.12)
    static let shadow = Color.black.opacity(0.07)

    static func color(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }

    private static func adaptive(light: UInt32, dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) -> Color {
        Color(uiColor: UIColor { traits in
            let isDark = traits.userInterfaceStyle == .dark
            let c = isDark ? dark : light
            return UIColor(red: Double((c >> 16) & 255) / 255, green: Double((c >> 8) & 255) / 255, blue: Double(c & 255) / 255, alpha: isDark ? darkAlpha : lightAlpha)
        })
    }
}

struct RootView: View {
    @Bindable var model: GhostModel
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Group {
            if model.connection == nil {
                ConnectView(model: model)
            } else {
                TabView(selection: $model.tab) {
                    ConversationsScreen(model: model)
                        .tabItem { Label("대화", systemImage: "bubble.left.and.bubble.right") }
                        .tag(AppTab.conversations)
                    WorkListScreen(model: model)
                        .tabItem { Label("맡긴 일", systemImage: "checklist") }
                        .tag(AppTab.works)
                    InboxScreen(model: model)
                        .tabItem { Label("소식", systemImage: "bell") }
                        .badge(model.snapshot.pendingDecisions.count)
                        .tag(AppTab.inbox)
                    SettingsScreen(model: model)
                        .tabItem { Label("연결", systemImage: "network") }
                        .tag(AppTab.connection)
                }
            }
        }
        .tint(GhostStyle.text)
        .onOpenURL { url in
            // Parsed strictly before any network or storage use; an already
            // connected device ignores pairing links.
            if model.connection == nil { model.pairing.handleDeepLink(url) }
        }
        .onChange(of: phase) {
            if phase != .active { model.saveDrafts() }
            if phase == .active { Task { await model.refresh() } }
        }
        .task(id: "register-\(model.connection?.origin.absoluteString ?? "")") {
            guard model.connection != nil else { return }
            #if DEBUG
            if MobileUIFixture.enabled { return }
            #endif
            AppDelegate.coordinator.requestAuthorizationAndRegister(model: model)
            await model.retryPendingPushToken()
        }
        .task(id: "stream-\(model.connection?.origin.absoluteString ?? "")-\(phase == .active)") {
            guard phase == .active, model.connection != nil else {
                model.stopEventStream()
                return
            }
            #if DEBUG
            if MobileUIFixture.enabled { return }
            #endif
            await model.refresh()
            await model.runEventStream()
        }
        .safeAreaInset(edge: .top) {
            if model.connection != nil && !model.isOnline {
                Label("연결 확인 중 · 마지막으로 받은 내용", systemImage: "wifi.slash")
                    .font(.caption).frame(maxWidth: .infinity).padding(8).background(GhostStyle.under)
            }
        }
    }
}

struct ConnectView: View {
    let model: GhostModel
    var body: some View {
        PairingFlowView(model: model)
    }
}

struct SettingsScreen: View {
    let model: GhostModel
    @State private var confirmingDisconnect = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) {
                        GhostMark(size: 56)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("내 Ghost").font(.title2.weight(.semibold))
                            Text("이야기하고, 맡기고, 함께하는 개인 비서")
                                .font(.footnote).foregroundStyle(GhostStyle.secondary)
                        }
                    }.padding(.vertical, 12)
                }.listRowBackground(Color.clear)
                Section("연결") {
                    LabeledContent("주소", value: model.connection?.origin.host() ?? "")
                    LabeledContent("상태", value: model.isOnline ? "연결됨" : "연결 확인 중")
                    LabeledContent("호스트", value: model.snapshot.runtime.ready ? "준비됨" : "준비되지 않음")
                    if let error = model.connectionError { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                    if !model.pending.isEmpty {
                        Text("전송이 확인되지 않은 요청 \(model.pending.count)개가 보존되어 있습니다. 연결이 회복되면 같은 요청으로 다시 시도됩니다.")
                            .font(.footnote).foregroundStyle(GhostStyle.secondary)
                    }
                }
                Section("알림") {
                    LabeledContent("푸시 알림", value: model.pushStatus ?? "등록됨")
                    if model.pendingPushToken != nil {
                        Text("등록되지 않은 알림 토큰이 보존되어 있습니다. 연결이 회복되면 다시 등록됩니다.")
                            .font(.footnote).foregroundStyle(GhostStyle.secondary)
                    }
                    Text("확인 필요·완료 소식만 전송되며 알림 본문에는 결과 내용이 담기지 않습니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                Section {
                    Button("이 iPhone에서 연결 해제", role: .destructive) { confirmingDisconnect = true }
                    Text("진행 중인 맡긴 일은 계속됩니다. 기기의 서버 접근 권한을 완전히 끊으려면 PC에서 이 기기를 철회해 주세요.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
            }.scrollContentBackground(.hidden).background(GhostStyle.canvas)
                .navigationTitle("내 Ghost").navigationBarTitleDisplayMode(.inline)
                .confirmationDialog("이 iPhone에서 연결을 해제할까요?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
                    Button("연결 해제", role: .destructive) { model.disconnect() }
                } message: {
                    Text("다시 연결하려면 PC에서 새 연결 코드를 만들어야 합니다. 진행 중인 맡긴 일은 계속됩니다.")
                }
        }
    }
}
