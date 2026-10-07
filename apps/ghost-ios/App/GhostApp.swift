import SwiftUI
import GhostMobileCore

@main struct GhostApp: App {
    @State private var model = GhostModel()
    var body: some Scene { WindowGroup { RootView(model: model) } }
}

// Semantic monochrome tokens from codex-design; native type and touch sizes
// follow Dynamic Type and iOS accessibility rather than desktop pixel sizes.
enum GhostStyle {
    static let surface = Color(uiColor: .systemBackground)
    static let under = Color(uiColor: .secondarySystemBackground)
    static let text = Color.primary
    static let secondary = Color.primary.opacity(0.65)
    static let border = Color.primary.opacity(0.08)
}

struct RootView: View {
    let model: GhostModel
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Group {
            if model.connection == nil { ConnectView(model: model) }
            else {
                TabView {
                    GhostList(model: model).tabItem { Label("Ghosts", systemImage: "bubble.left.and.bubble.right") }
                    ActivityView(model: model).tabItem { Label("진행 중", systemImage: "checklist") }
                    SettingsView(model: model).tabItem { Label("연결", systemImage: "network") }
                }
            }
        }
        .tint(GhostStyle.text)
        .onChange(of: phase) { if phase != .active { model.saveDrafts() } }
        .task(id: "\(model.connection?.origin.absoluteString ?? "")-\(phase == .active)") {
            guard phase == .active, model.connection != nil else { return }
            while !Task.isCancelled {
                await model.refresh()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
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

struct ConnectView: View {
    let model: GhostModel
    @State private var server = ""
    @State private var token = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right.fill").font(.largeTitle)
                        Text("내 서버 연결").font(.title2.bold())
                        Text("Ghost 서버 주소와 이 iPhone의 연결 키를 입력하세요.")
                            .foregroundStyle(GhostStyle.secondary)
                    }.padding(.vertical, 20)
                }.listRowBackground(Color.clear)
                Section("서버 연결") {
                    TextField("https://ghost.example.com", text: $server).keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("이 iPhone의 연결 키", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button { Task { await model.connect(server: server, token: token); if model.connection != nil { token = "" } } } label: {
                        HStack { Text("Ghost 연결"); Spacer(); if model.busy { ProgressView() } else { Image(systemName: "arrow.right") } }
                    }.disabled(model.busy || server.isEmpty || token.isEmpty)
                }
                if let error = model.error { Section { Text(error).foregroundStyle(.red).font(.callout) } }
                Section { Text("연결 키는 이 기기의 키체인에 보관됩니다. 서버에서 기기의 접근 권한을 해제할 수 있습니다.").font(.footnote).foregroundStyle(GhostStyle.secondary) }
            }.navigationTitle("Ghost")
        }
    }
}

struct GhostList: View {
    let model: GhostModel
    var body: some View {
        NavigationStack {
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
                .navigationDestination(for: String.self) { ChatView(model: model, profileID: $0) }
                .refreshable { await model.refresh() }
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
    private var profile: JSON { model.profile(profileID) }
    private var conversations: [Record] { profile["conversations"].items.map { Record(value: $0) } }
    private var selectedID: String { conversationID.isEmpty ? (conversations.first?.id ?? "") : conversationID }
    private var conversation: JSON { conversations.first(where: { $0.id == selectedID })?.value ?? .null }
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
                Button("음성 통화", systemImage: "phone") { calling = true }
                    .disabled(!model.isOnline || !model.voiceConfigured || !profile["policy"]["voice"].flag || selectedID.isEmpty || sending)
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 8) {
                if let error = model.draftError { Text(error).font(.caption).foregroundStyle(.red) }
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).lineLimit(3) }
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
            VoiceScreen(model: model, profileID: profileID, conversationID: selectedID)
                .interactiveDismissDisabled()
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
                if !model.pending.isEmpty {
                    Section("결과를 확인할 요청") {
                        ForEach(model.pending, id: \.request_id) { envelope in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(envelope.command["prompt"].text.isEmpty ? envelope.command["type"].text : envelope.command["prompt"].text).lineLimit(3)
                                if envelope.command["type"].text != "workspace" {
                                    Button("같은 요청으로 다시 확인") { Task { await model.perform(envelope.command) } }.disabled(model.busy || !model.isOnline)
                                } else { Text("서버의 통화·작업 상태를 먼저 확인하세요.").font(.caption).foregroundStyle(GhostStyle.secondary) }
                                Button("상태를 확인한 요청 기록 닫기") { Task { await model.acknowledge(envelope) } }.font(.caption)
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
                Section("통화") {
                    ForEach(model.snapshot["voice_calls"].items.filter { $0["state"].text != "ended" }.map { Record(value: $0) }) { call in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("통화 · \(call.value["state"].text)")
                            Button("서버 통화 종료", role: .destructive) { Task { await model.perform(owner("voice_end", ["call_id": .string(call.id)])) } }.disabled(model.busy)
                        }
                    }
                }
            }.navigationTitle("진행 중").refreshable { await model.refresh() }
        }
    }
}

struct SettingsView: View {
    let model: GhostModel
    var body: some View {
        NavigationStack {
            Form {
                Section("내 서버") {
                    LabeledContent("주소", value: model.connection?.origin.host() ?? "")
                    LabeledContent("상태", value: model.isOnline ? "연결됨" : "연결 확인 중")
                    if let error = model.connectionError { Text(error).font(.caption).foregroundStyle(.red) }
                    LabeledContent("음성 서비스", value: model.voiceConfigured ? "서버 설정 있음" : "서버 설정 필요")
                    Text("음성 통화는 각 Ghost의 설정에서도 허용해야 합니다.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                Section("컴퓨터") {
                    LabeledContent("서버의 컴퓨터", value: model.snapshot["capabilities"]["computer"]["backend"].text)
                    Text("로컬 PC 연결과 화면 제어는 후속 구현입니다. 현재 앱은 서버에서 보고한 컴퓨터 설정만 표시합니다.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                Section {
                    Button("이 iPhone에서 연결 해제", role: .destructive) { model.disconnect() }
                    Text("진행 중인 Ghost 작업은 계속됩니다. 기기의 서버 접근 권한을 완전히 끊으려면 서버에서 해당 연결 키를 철회하세요.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
            }.navigationTitle("연결")
        }
    }
}
