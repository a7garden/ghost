import SwiftUI
import GhostMobileCore

struct ConversationsScreen: View {
    let model: GhostModel
    @State private var path = NavigationPath()
    @State private var search = ""
    @AppStorage("ghost.roster.pinned") private var savedPins = "[]"
    @AppStorage("ghost.roster.expanded") private var expanded = false

    private var ghosts: [Ghost] {
        model.snapshot.visibleGhosts.filter { model.grantedGhostIDs.contains($0.id) }
    }
    private var pins: [String] {
        (try? JSONDecoder().decode([String].self, from: Data(savedPins.utf8))) ?? []
    }
    private var fixed: [Ghost] {
        ghosts.filter(\.isDefault) + pins.compactMap { id in ghosts.first { $0.id == id && !$0.isDefault } }
    }
    private var pool: [Ghost] {
        let fixedIDs = Set(fixed.map(\.id))
        return ghosts.filter { !fixedIDs.contains($0.id) }
    }
    private var shownPool: [Ghost] {
        pool.filter { ghost in
            let matches = search.isEmpty || ghost.name.localizedCaseInsensitiveContains(search)
                || (ghost.persona.split(whereSeparator: \.isNewline).first.map(String.init) ?? "").localizedCaseInsensitiveContains(search)
            return matches && (expanded || !search.isEmpty || model.snapshot.presence(of: ghost).state != .idle)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if ghosts.isEmpty {
                        ContentUnavailableView("연결된 대화 없음", systemImage: "bubble.left",
                            description: Text("PC에서 이 기기의 Ghost 사용 권한을 조정해 주세요."))
                    }
                    if !fixed.isEmpty {
                        Section {
                            ForEach(fixed) { ghost in rosterRow(ghost) }
                        } header: { groupLabel("고정") }
                    }
                    if !pool.isEmpty {
                        Section {
                            if pool.count > 8 {
                                HStack(spacing: 8) {
                                    Image(systemName: "magnifyingglass").foregroundStyle(GhostStyle.secondary)
                                    TextField("Ghost 찾기", text: $search).accessibilityLabel("Ghost 찾기")
                                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    if !search.isEmpty {
                                        Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                                            .frame(minWidth: 44, minHeight: 44).accessibilityLabel("검색 지우기")
                                    }
                                }.padding(.horizontal, 20).frame(minHeight: 44)
                            }
                            ForEach(shownPool) { ghost in rosterRow(ghost) }
                        } header: {
                            Button { expanded.toggle() } label: {
                                HStack(spacing: 8) {
                                    Text("Ghost")
                                    if !expanded { Text("\(pool.count)").monospacedDigit() }
                                    Spacer()
                                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                }
                                .font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
                                .padding(.horizontal, 20).frame(minHeight: 44).background(GhostStyle.canvas)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(expanded ? "Ghost 목록 접기" : "Ghost 목록 펼치기 (\(pool.count))")
                        }
                    }
                    if let error = model.error {
                        Text(error).font(.footnote).foregroundStyle(GhostStyle.warning).padding(20)
                    }
                }.padding(.bottom, 24)
            }
            .background(GhostStyle.canvas)
            .navigationTitle("대화")
            .navigationDestination(for: String.self) { id in ChatScreen(model: model, conversationId: id) }
            .refreshable { await model.refresh() }
        }
        .onAppear { prunePins() }
        .onChange(of: ghosts.map(\.id)) { prunePins() }
        .onChange(of: model.chatRoute) {
            guard let route = model.chatRoute,
                  model.grantedConversations.contains(where: { $0.id == route.conversationId }) else { return }
            path.append(route.conversationId)
        }
        .onChange(of: model.notificationRoute) {
            guard let route = model.notificationRoute,
                  let notification = model.snapshot.notifications.first(where: { $0.id == route.notificationId }),
                  let id = notification.conversationId,
                  model.grantedConversations.contains(where: { $0.id == id }) else { return }
            path.append(id)
        }
    }

    private func groupLabel(_ title: String) -> some View {
        Text(title).font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 20).background(GhostStyle.canvas)
    }

    private func conversation(for ghost: Ghost) -> Conversation? {
        let granted = model.grantedConversations.filter { $0.ghostId == ghost.id }
        return granted.first { $0.id == ghost.directConversationId } ?? granted.first
    }

    @ViewBuilder private func rosterRow(_ ghost: Ghost) -> some View {
        if let conversation = conversation(for: ghost) {
            NavigationLink(value: conversation.id) { rowContent(ghost, conversation: conversation) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("conversation-\(conversation.id)")
                .contextMenu {
                    Button("대화 열기", systemImage: "bubble.left") { path.append(conversation.id) }
                    Button("맡긴 일", systemImage: "checklist") {
                        model.workFilterGhostId = ghost.id
                        model.tab = .works
                    }
                    if !ghost.isDefault {
                        Button(pins.contains(ghost.id) ? "고정 해제" : "고정", systemImage: pins.contains(ghost.id) ? "pin.slash" : "pin") {
                            var updated = pins.filter { $0 != ghost.id }
                            if !pins.contains(ghost.id) { updated.append(ghost.id) }
                            savePins(updated)
                        }
                    }
                }
        } else {
            rowContent(ghost, conversation: nil)
        }
    }

    private func rowContent(_ ghost: Ghost, conversation: Conversation?) -> some View {
        let presence = model.snapshot.presence(of: ghost)
        let count = model.snapshot.works.filter { $0.ghostId == ghost.id && !$0.state.isTerminal }.count
        return HStack(spacing: 12) {
            GhostPortrait(ghost: ghost, size: 44, presence: GhostPresence(presence.state))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(ghost.name).font(.body.weight(.medium)).foregroundStyle(GhostStyle.ink)
                    if ghost.isDefault {
                        Text("메인").font(.caption2).foregroundStyle(GhostStyle.secondary)
                            .padding(.horizontal, 4).padding(.vertical, 4)
                            .overlay { RoundedRectangle(cornerRadius: 4).stroke(GhostStyle.border, lineWidth: 1) }
                    }
                }
                if let line = presence.line {
                    Text(line).font(.footnote).lineLimit(2)
                        .foregroundStyle(presence.state == .attention ? GhostStyle.amberInk : GhostStyle.signalInk)
                } else if let conversation {
                    Text(model.relativeTime(conversation.lastActivityAt)).font(.caption).foregroundStyle(GhostStyle.secondary)
                }
            }
            Spacer(minLength: 8)
            if count > 0 {
                Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(GhostStyle.secondary)
                    .accessibilityLabel("맡긴 일 진행 중 \(count)개")
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }

    private func prunePins() {
        guard model.snapshot.seq > 0 || !model.snapshot.ghosts.isEmpty else { return }
        let valid = Set(ghosts.filter { !$0.isDefault }.map(\.id))
        var seen = Set<String>()
        let updated = pins.filter { valid.contains($0) && seen.insert($0).inserted }
        if updated != pins { savePins(updated) }
    }

    private func savePins(_ ids: [String]) {
        if let data = try? JSONEncoder().encode(ids), let text = String(data: data, encoding: .utf8) { savedPins = text }
    }
}
