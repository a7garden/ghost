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
    static let surface = adaptive(light: (0.993, 0.989, 0.979), dark: (0.10, 0.10, 0.096))
    static let under = adaptive(light: (0.952, 0.945, 0.930), dark: (0.155, 0.155, 0.148))
    static let canvas = surface
    static let ink = adaptive(light: (0.17, 0.18, 0.17), dark: (0.94, 0.94, 0.91))
    static let onInk = adaptive(light: (0.99, 0.98, 0.96), dark: (0.13, 0.14, 0.13))
    static let accent = adaptive(light: (0.67, 0.27, 0.19), dark: (0.92, 0.64, 0.52))
    static let warning = adaptive(light: (0.72, 0.15, 0.12), dark: (1.0, 0.52, 0.46))
    static let destructive = Color(red: 0.72, green: 0.15, blue: 0.12)
    static let onDestructive = Color.white
    static let text = Color.primary
    static let secondary = adaptive(light: (0.40, 0.41, 0.39), dark: (0.68, 0.69, 0.65))
    static let border = adaptive(light: (0.86, 0.85, 0.82), dark: (0.29, 0.29, 0.27))
    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
}

struct RootView: View {
    let model: GhostModel
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Group {
            if model.connection == nil {
                ConnectView(model: model)
            } else {
                TabView {
                    ConversationsScreen(model: model)
                        .tabItem { Label("대화", systemImage: "bubble.left.and.bubble.right") }
                    WorkListScreen(model: model)
                        .tabItem { Label("맡긴 일", systemImage: "checklist") }
                    InboxScreen(model: model)
                        .tabItem { Label("소식", systemImage: "bell") }
                    SettingsScreen(model: model)
                        .tabItem { Label("연결", systemImage: "network") }
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
