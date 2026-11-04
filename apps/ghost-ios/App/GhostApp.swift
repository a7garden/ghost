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
// state and routing stay in the model and the Host ledger.
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
            if model.connection == nil { ConnectView(model: model) }
            else if model.isLifetimeConnection { LifetimeScreen(model: model) }
            else {
                TabView {
                        GhostList(model: model).tabItem { Label("Ghosts", systemImage: "bubble.left.and.bubble.right") }
                        ActivityView(model: model).tabItem { Label("진행 중", systemImage: "checklist") }
                    SettingsView(model: model).tabItem { Label("연결", systemImage: "network") }
                }
            }
        }
        .tint(GhostStyle.text)
        .onOpenURL { url in
            // Parsed strictly before any network or storage use; an already
            // connected device ignores pairing links.
            model.handlePairingURL(url)
        }
        .onChange(of: phase) { if phase != .active { model.saveDrafts() } }
        .task(id: "register-\(model.connection?.origin.absoluteString ?? "")") {
            guard model.connection != nil else { return }
            #if DEBUG
            if MobileUIFixture.enabled { return }
            #endif
            AppDelegate.coordinator.requestAuthorizationAndRegister(model: model)
            await model.retryPendingPushToken()
        }
        .task(id: "\(model.connection?.origin.absoluteString ?? "")-\(phase == .active)") {
            guard phase == .active, model.connection != nil else { return }
            while !Task.isCancelled {
                await model.refresh()
                // Bootstrap + snapshot cost two requests. Active chat observes
                // its own page every two seconds; leave room under the scoped
                // gateway's 60 requests/minute budget for sending and receipts.
                do { try await Task.sleep(for: .seconds(8)) } catch { return }
            }
        }
        .safeAreaInset(edge: .top) {
            if model.connection != nil && !model.isOnline {
                Label("연결 확인 중 · 마지막으로 받은 내용", systemImage: "wifi.slash")
                    .font(.caption).frame(maxWidth: .infinity).padding(8).background(GhostStyle.under)
            }
        }
    }
}

// Pairing-only connect screen: QR scan, Bonjour-discovered nearby server
// with the 8-character code, or the ghost://connect deep link. The manual
// server-address and connection-key form is gone — existing saved
// connections still load exactly as before.
struct ConnectView: View {
    let model: GhostModel
    var body: some View {
        PairingFlowView(model: model)
    }
}

struct GhostList: View {
    let model: GhostModel
    @State private var path = NavigationPath()
    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(model.profiles) { profile in
                    NavigationLink(value: profile.id) {
                        HStack(spacing: 16) {
                            Image(systemName: "bubble.left.fill").font(.title2).frame(width: 48, height: 48).background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 15))
                            VStack(alignment: .leading, spacing: 6) {
                                Text(profile.value["name"].text).font(.headline)
                                Text(profile.value["persona"].text).font(.subheadline).foregroundStyle(GhostStyle.secondary).lineLimit(2)
                            }.padding(.vertical, 8)
                        }
                    }.accessibilityIdentifier("profile-\(profile.id)")
                }
                if model.profiles.isEmpty { ContentUnavailableView("아직 Ghost가 없습니다", systemImage: "bubble.left", description: Text("데스크톱에서 Ghost를 만든 뒤 아래로 당겨 새로고침하세요.")) }
            }.navigationTitle("Ghosts")
                .navigationDestination(for: String.self) { profileID in
                    ChatView(model: model, profileID: profileID, initialConversationID: model.chatRoute?.profileID == profileID ? model.chatRoute?.conversationID : nil)
                }
                .refreshable { await model.refresh() }
        }
        .onChange(of: model.chatRoute) {
            guard let route = model.chatRoute else { return }
            path.append(route.profileID)
        }
    }
}

struct ChatView: View {
    let model: GhostModel
    let profileID: String
    @State private var conversationID = ""
    @State private var sending = false
    @State private var calling = false
    @State private var scrollRequest = UUID()
    init(model: GhostModel, profileID: String, initialConversationID: String? = nil) {
        self.model = model
        self.profileID = profileID
        _conversationID = State(initialValue: initialConversationID ?? "")
    }
    private var profile: JSON { model.profile(profileID) }
    private var conversations: [Record] { profile["conversations"].items.map { Record(value: $0) } }
    private var selectedID: String { conversationID.isEmpty ? (conversations.first?.id ?? "") : conversationID }
    private var conversation: JSON { conversations.first(where: { $0.id == selectedID })?.value ?? .null }
    private var canStartVoiceCall: Bool {
        guard model.isOnline, model.activeCall == nil, model.voiceCallFence == nil, model.voiceFenceIssue == nil, selectedID.isEmpty == false else { return false }
        guard let target = model.voiceMediaTarget else { return false }
        // The streaming service binds calls to one Ghost·conversation pair.
        return target.ghostID == profileID && target.conversationID == selectedID
    }
    private var draftAddress: DraftAddress { model.draftAddress(profileID: profileID, conversationID: selectedID) }
    private var draft: ConversationDraft? { model.drafts?.draft(at: draftAddress) }
    private var draftText: Binding<String> {
        let address = draftAddress
        return Binding(get: { model.drafts?.draft(at: address)?.text ?? "" }, set: { model.drafts?.update($0, at: address) })
    }
    var body: some View {
        MessageHistory(profileName: profile["name"].text, messages: conversation["messages"].items, scrollRequest: scrollRequest)
        .id(selectedID)
        .navigationTitle(profile["name"].text).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(conversations) { item in
                        Button { model.saveDrafts(); conversationID = item.id } label: {
                            if item.id == selectedID { Label(item.value["title"].text, systemImage: "checkmark") }
                            else { Text(item.value["title"].text) }
                        }
                    }
                    Button("새 대화", systemImage: "plus") { Task { await createConversation() } }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityIdentifier("conversation-menu").disabled(sending || calling)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("음성 통화", systemImage: "phone") {
                    if model.activeCall != nil { calling = true }
                    else if model.startVoiceCall(profileID: profileID, conversationID: selectedID) { calling = true }
                }
                .disabled(!model.isOnline || selectedID.isEmpty || (model.activeCall == nil && !canStartVoiceCall))
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 8) {
                if let error = model.draftError { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                if let error = model.error { Text(error).font(.caption).foregroundStyle(GhostStyle.warning).lineLimit(3) }
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("Ghost에게 이야기하기", text: draftText, axis: .vertical).lineLimit(1...5).padding(.vertical, 10).disabled(model.drafts == nil).accessibilityIdentifier("chat-composer")
                    Button { Task { await submit() } } label: {
                        Group {
                            if sending { ProgressView().tint(GhostStyle.surface) }
                            else { Image(systemName: "arrow.up").font(.headline) }
                        }.foregroundStyle(GhostStyle.surface).frame(width: 44, height: 44).background(GhostStyle.text, in: Circle())
                    }.accessibilityLabel(sending ? "보내는 중" : "메시지 보내기").disabled(sending || (draft?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.isOnline)
                }.padding(12).background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 28))
            }.padding(.horizontal, 16).padding(.bottom, 8).background(GhostStyle.surface)
        }
        .sheet(isPresented: $calling) {
            VoiceScreen(model: model)
        }
        .task(id: draft?.revision) {
            do { try await Task.sleep(for: .milliseconds(300)); model.saveDrafts() } catch { }
        }
        .onDisappear { model.saveDrafts() }
    }
    private func createConversation() async {
        guard !sending else { return }
        let previous = draftAddress
        model.saveDrafts()
        sending = true; defer { sending = false }
        if let result = try? await model.send(command("create_conversation", ["profile_id": .string(profileID), "model": model.snapshot["default_model"], "tools": .bool(true)])), !result["conversation_id"].text.isEmpty {
            conversationID = result["conversation_id"].text
            if previous.conversationID.isEmpty { model.drafts?.move(from: previous, to: draftAddress); model.saveDrafts() }
        }
    }
    private func submit() async {
        guard !sending, let drafts = model.drafts, let submitted = draft else { return }
        let text = submitted.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, model.saveDrafts() else { return }
        var destination = selectedID
        var address = draftAddress
        sending = true; defer { sending = false }
        do {
            if destination.isEmpty {
                let result = try await model.send(command("create_conversation", ["profile_id": .string(profileID), "model": model.snapshot["default_model"], "tools": .bool(true)]))
                destination = result["conversation_id"].text
                guard !destination.isEmpty else { return }
                let created = DraftAddress(workspaceID: address.workspaceID, profileID: profileID, conversationID: destination)
                drafts.move(from: address, to: created)
                address = created; conversationID = destination
                try drafts.save()
            }
            _ = try await model.send(command("submit", ["profile_id": .string(profileID), "conversation_id": .string(destination), "prompt": .string(text), "kind": .string("follow_up")]))
            drafts.clear(submitted, at: address)
            try drafts.save()
            scrollRequest = UUID(); model.error = nil
        } catch { model.error = error.localizedDescription }
    }
}

struct MessageRow: Identifiable, Equatable { let id: String; let value: JSON }
func messageRows(_ values: [JSON]) -> [MessageRow] {
    // Revisions are durable server identities. Non-message notices have no
    // revision; collapse repeated identical notices into one stable row.
    var seen = Set<String>()
    return values.compactMap { value in
        let key = value["revision"] == .null ? "\(value["task_id"].text):\(value["role"].text):\(value["text"].text)" : String(describing: value["revision"])
        guard seen.insert(key).inserted else { return nil }
        return MessageRow(id: key, value: value)
    }
}

struct ActivityView: View {
    let model: GhostModel
    var body: some View {
        NavigationStack {
            List {
                if model.isLifetimeConnection && (!model.ownerQuestions.isEmpty || model.ownerQuestionsError != nil) { OwnerQuestionsSection(model: model) }
                if !model.notifications.isEmpty {
                    Section("결과 알림") {
                        ForEach(model.notifications) { entry in
                            Button {
                                model.markNotificationSeen(entry)
                                if model.isLifetimeConnection {
                                    model.lifetimeRouteTarget = GhostModel.LifetimeRouteTarget(ghostID: entry.recipientID, conversationID: entry.notification.conversationID)
                                } else {
                                    model.chatRoute = GhostModel.ChatRoute(profileID: entry.recipientID, conversationID: entry.notification.conversationID)
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.phrase).font(.subheadline)
                                    Text(entry.notification.state == "client_seen" ? "확인함" : "전달됨")
                                        .font(.caption).foregroundStyle(GhostStyle.secondary)
                                }
                            }
                        }
                    }
                }
                if let notificationError = model.notificationError {
                    Section { Text(notificationError).font(.caption).foregroundStyle(GhostStyle.warning) }
                }
                if let ackIssue = model.notificationAckIssue {
                    Section { Text(ackIssue).font(.caption).foregroundStyle(GhostStyle.warning) }
                }
                if !model.pending.isEmpty {
                    Section("결과를 확인할 요청") {
                        ForEach(model.pending, id: \.request_id) { envelope in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(envelope.command["prompt"].text.isEmpty ? envelope.command["type"].text : envelope.command["prompt"].text).lineLimit(3)
                                if envelope.command["type"].text == "lifetime" {
                                    Button("원래 요청 영수증 확인") { Task { await model.retryPending(envelope) } }.disabled(model.busy || !model.isOnline)
                                } else {
                                    if envelope.command["type"].text != "workspace" {
                                        Button("같은 요청으로 다시 확인") { Task { await model.retryPending(envelope) } }.disabled(model.busy || !model.isOnline)
                                    } else { Text("서버의 통화·작업 상태를 먼저 확인하세요.").font(.caption).foregroundStyle(GhostStyle.secondary) }
                                    Button("상태를 확인한 요청 기록 닫기") { Task { await model.acknowledge(envelope) } }.font(.caption)
                                }
                            }
                        }
                    }
                }
                ForEach(model.profiles) { profile in
                    Section(profile.value["name"].text) {
                        ForEach(profile.value["conversations"].items.flatMap { $0["tasks"].items }.map { Record(value: $0) }) { task in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(task.value["name"].text).font(.headline)
                                Text(task.value["phase"].text).font(.caption).foregroundStyle(GhostStyle.secondary)
                                if !task.value["output"].text.isEmpty { Text(task.value["output"].text).lineLimit(6) }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                if !model.isLifetimeConnection {
                Section("통화") {
                    ForEach(model.snapshot["voice_calls"].items.filter { $0["state"].text != "ended" }.map { Record(value: $0) }) { call in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("통화 · \(call.value["state"].text)")
                            Button("서버 통화 종료", role: .destructive) { Task { await model.perform(owner("voice_end", ["call_id": .string(call.id)])) } }.disabled(model.busy)
                        }
                    }
                }
                }
                if model.isLifetimeConnection && model.notifications.isEmpty && model.pending.isEmpty && model.ownerQuestions.isEmpty && model.ownerQuestionsError == nil {
                    Section {
                        VStack(alignment: .leading, spacing: 16) {
                            Image(systemName: "bell").font(.largeTitle).foregroundStyle(GhostStyle.accent)
                            Text("새 소식이 오면 알려드릴게요").font(.title2.weight(.semibold))
                            Text("도착한 결과와 확인이 필요한 소식을 이곳에서 볼 수 있어요.")
                                .foregroundStyle(GhostStyle.secondary)
                        }.padding(.vertical, 24)
                    }.listRowBackground(Color.clear)
                }
            }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(GhostStyle.canvas)
                .navigationTitle(model.isLifetimeConnection ? "확인할 일" : "진행 중")
                .refreshable {
                    await model.refresh()
                    await model.loadNotifications()
                    if model.isLifetimeConnection { await model.loadOwnerQuestions() }
                }
                .task { await model.loadNotifications() }
        }
    }
}

struct SettingsView: View {
    let model: GhostModel
    var showsCloseButton = false
    @Environment(\.dismiss) private var dismiss
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
                    if let error = model.connectionError { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                    LabeledContent("음성 통화", value: {
                        if model.activeCall != nil { return "통화 진행 중" }
                        return model.voiceMediaTarget == nil ? "서버 통화 경로 미설정" : "서버 통화 경로 준비됨"
                    }())
                    if let fence = model.voiceCallFence, model.activeCall == nil {
                        VStack(alignment: .leading, spacing: 6) {
                            switch fence.kind {
                            case .unknownStart:
                                Text("이전 통화의 시작 결과가 불명확합니다. 서버 확인 전에는 새 통화를 시작할 수 없습니다.").font(.footnote).foregroundStyle(GhostStyle.warning)
                            case .unconfirmedEnd:
                                Text("이전 통화의 서버 종료가 아직 확인되지 않았습니다. 서버 확인 전에는 새 통화를 시작할 수 없습니다.").font(.footnote).foregroundStyle(GhostStyle.warning)
                            case .inProgress:
                                EmptyView()
                            }
                            if let issue = model.voiceFenceIssue {
                                Text(issue).font(.caption).foregroundStyle(GhostStyle.warning)
                            }
                            Button("서버 통화 상태 확인") { Task { await model.resolveVoiceCallFence() } }
                                .disabled(!model.isOnline || model.resolvingVoiceFence)
                        }
                    }
                    if model.voiceCallFence == nil, let issue = model.voiceFenceIssue {
                        Text(issue).font(.footnote).foregroundStyle(GhostStyle.warning)
                    }
                    Text("음성 통화는 서버가 지정한 Ghost·대화 쌍에서만 시작할 수 있습니다. 통화는 잠금 화면과 백그라운드에서도 계속됩니다.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                Section("알림") {
                    LabeledContent("푸시 알림", value: model.pushStatus ?? "등록 상태 확인 전")
                    if model.pendingPushToken != nil { Text("등록되지 않은 알림 토큰이 보존되어 있습니다. 연결이 회복되면 다시 등록됩니다.").font(.footnote).foregroundStyle(GhostStyle.secondary) }
                    Text("완료·수용 알림만 전송되며 알림 본문에는 결과 내용이 담기지 않습니다.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                Section {
                    DisclosureGroup("서버의 컴퓨터 정보") {
                    LabeledContent("서버의 컴퓨터", value: model.snapshot["capabilities"]["computer"]["backend"].text)
                    Text("컴퓨터 제어와 실행 진단은 대화 옵션의 연결 및 요청 상태에서 확인할 수 있습니다.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                }
                Section {
                    Button("이 iPhone에서 연결 해제", role: .destructive) { confirmingDisconnect = true }
                    Text("진행 중인 Ghost 작업은 계속됩니다. 기기의 서버 접근 권한을 완전히 끊으려면 서버에서 해당 연결 키를 철회하세요.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
            }.scrollContentBackground(.hidden).background(GhostStyle.canvas)
                .navigationTitle("내 Ghost").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if showsCloseButton { ToolbarItem(placement: .confirmationAction) { Button("닫기") { dismiss() } } }
                }
                .confirmationDialog("이 iPhone에서 연결을 해제할까요?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
                    Button("연결 해제", role: .destructive) { model.disconnect() }
                } message: { Text("다시 연결하려면 PC에서 기기를 승인해야 합니다. 진행 중인 작업은 계속됩니다.") }
        }
    }
}
