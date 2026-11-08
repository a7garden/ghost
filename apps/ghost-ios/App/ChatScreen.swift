import SwiftUI
import GhostMobileCore

struct ChatScreen: View {
    let model: GhostModel
    let conversationId: String
    @State private var selectedConversationId: String?
    @State private var messages: [Message] = []
    @State private var olderBefore: String?
    @State private var loadingOlder = false
    @State private var loading = false
    @State private var loadError: String?
    @State private var sending = false
    @State private var stopping = false
    @State private var scrollRequest = UUID()
    @State private var focusRequest = UUID()
    @State private var composerFocused = false
    @State private var pageLive: Live?
    @State private var threadSheet = false
    @State private var threadPath: [String] = []
    @State private var artifact: ArtifactRef?

    private var currentId: String { selectedConversationId ?? conversationId }
    private var conversation: Conversation? { model.snapshot.conversations.first { $0.id == currentId } }
    private var ghost: Ghost? { conversation.flatMap { model.ghost($0.ghostId) } }
    private var live: Live? { model.liveByConversation[currentId] ?? pageLive }
    private var isBusy: Bool { conversation?.busy == true || live?.running == true }
    private var liveThreads: [Work] {
        model.snapshot.works.filter { $0.ghostId == ghost?.id && $0.parentId == nil && !$0.state.isTerminal }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    private var draftAddress: DraftAddress { model.draftAddress(conversationId: currentId) }
    private var draft: ConversationDraft? { model.drafts?.draft(at: draftAddress) }
    private var draftText: Binding<String> {
        let address = draftAddress
        return Binding(get: { model.drafts?.draft(at: address)?.text ?? "" }, set: { model.drafts?.update($0, at: address) })
    }
    private var actions: TranscriptActions {
        TranscriptActions(openWork: openWork, openFile: { artifact = $0 }, quote: { text in
            let existing = draftText.wrappedValue
            draftText.wrappedValue = existing + (existing.isEmpty || existing.hasSuffix("\n") ? "" : "\n\n") + GhostCopy.quoteForReply(text)
            focusRequest = UUID()
        }, reuse: { text in
            draftText.wrappedValue = text
            focusRequest = UUID()
        }, useStarter: { prompt in
            draftText.wrappedValue = prompt
            focusRequest = UUID()
        })
    }

    var body: some View {
        MessageHistory(model: model, ghost: ghost, conversationId: currentId, messages: messages,
            live: live, scrollRequest: scrollRequest, actions: actions,
            hasOlder: olderBefore != nil, loadingOlder: loadingOlder, loadOlder: { await loadOlder() })
        .id(currentId)
        .background(GhostStyle.canvas)
        .navigationTitle(ghost?.name ?? "대화").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 8) {
                    GhostPortrait(ghost: ghost, size: 32, presence: ghost.map { GhostPresence(model.snapshot.presence(of: $0).state) } ?? .idle)
                    Text(ghost?.name ?? "대화").font(.headline).lineLimit(1)
                }.accessibilityElement(children: .combine)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { threadPath = []; threadSheet = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.branch")
                        if !liveThreads.isEmpty { Text("\(liveThreads.count)").font(.caption.monospacedDigit()) }
                    }.frame(minWidth: 44, minHeight: 44)
                }.accessibilityLabel(liveThreads.isEmpty ? "스레드" : "스레드, 진행 중 \(liveThreads.count)")
                    .accessibilityIdentifier("chat-threads")
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 8) {
                if let error = model.draftError { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                if let error = model.error { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                if let ghost {
                    DecisionDeck(model: model, ghostId: ghost.id, conversationId: currentId, openWork: openWork, composerFocused: composerFocused)
                        .id(currentId)
                }
                ChatComposer(model: model, ghost: ghost, conversationId: currentId, text: draftText,
                    sending: sending, stopping: stopping, isRunning: isBusy, focusRequest: focusRequest,
                    submit: { await submit($0) }, cancel: { await cancel() }, focusChanged: { composerFocused = $0 })
            }.padding(.horizontal, 12).padding(.bottom, 8).background(GhostStyle.canvas)
        }
        .sheet(isPresented: $threadSheet) {
            NavigationStack(path: $threadPath) {
                ThreadDirectory(model: model, ghost: ghost, currentConversationId: currentId, selectConversation: { id in
                    model.saveDrafts()
                    selectedConversationId = id
                    threadSheet = false
                }, openAllWorks: {
                    threadSheet = false
                    model.workFilterGhostId = nil
                    model.tab = .works
                })
                .navigationDestination(for: String.self) { id in
                    WorkDetailScreen(model: model, workId: id)
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("닫기") { threadSheet = false }.frame(minHeight: 44) } }
                }
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("닫기") { threadSheet = false }.frame(minHeight: 44) } }
            }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .sheet(item: $artifact) { ArtifactScreen(model: model, artifact: $0) }
        .task(id: currentId) {
            messages = []; olderBefore = nil; pageLive = nil; loadError = nil; loadingOlder = false
            await loadLatest()
        }
        #if DEBUG
        .task(id: "fixture-incoming-\(currentId)") {
            if MobileUIFixture.incoming, currentId == MobileUIFixture.conversationID {
                do { try await Task.sleep(for: .seconds(12)); model.appendUITestMessage() } catch { }
            }
        }
        #endif
        .overlay {
            if messages.isEmpty {
                if loading { ProgressView("대화를 불러오는 중").padding(24).background(GhostStyle.canvas) }
                else if let loadError {
                    ContentUnavailableView("대화를 불러오지 못했습니다", systemImage: "wifi.exclamationmark", description: Text(loadError))
                }
            }
        }
        .overlay(alignment: .top) {
            if !messages.isEmpty, let loadError {
                Text(loadError).font(.caption).foregroundStyle(GhostStyle.warning).padding(12)
                    .frame(maxWidth: .infinity).background(GhostStyle.surface)
            }
        }
        .onChange(of: model.appendedMessages[currentId]?.count ?? 0) {
            let fresh = model.drainAppendedMessages(conversationId: currentId, loadedIDs: Set(messages.map(\.id)))
            guard !fresh.isEmpty else { return }
            messages += fresh
            if fresh.contains(where: { $0.role == .assistant }) { pageLive = nil }
            model.noteLoadedMessages(conversationId: currentId, ids: fresh.map(\.id))
        }
        .task(id: draft?.revision) {
            do { try await Task.sleep(for: .milliseconds(300)); model.saveDrafts() } catch { }
        }
        .onDisappear { model.saveDrafts() }
    }

    private func openWork(_ id: String) {
        threadPath = [id]
        threadSheet = true
    }

    private func loadLatest() async {
        let id = currentId
        loading = true
        defer { if currentId == id { loading = false } }
        do {
            let page = try await model.conversationPage(id: id)
            guard currentId == id, !Task.isCancelled else { return }
            let pageIds = Set(page.messages.map(\.id))
            if messages.isEmpty { olderBefore = page.before }
            messages = (messages.filter { !pageIds.contains($0.id) } + page.messages).sorted { $0.createdAt < $1.createdAt }
            loadError = nil
            pageLive = page.live
            model.noteLoadedMessages(conversationId: id, ids: page.messages.map(\.id))
        } catch {
            if currentId == id, !Task.isCancelled { loadError = error.localizedDescription }
        }
    }

    private func loadOlder() async {
        guard let before = olderBefore, !loadingOlder else { return }
        let id = currentId
        loadingOlder = true
        defer { if currentId == id { loadingOlder = false } }
        do {
            let page = try await model.conversationPage(id: id, before: before)
            guard currentId == id, !Task.isCancelled else { return }
            let pageIds = Set(page.messages.map(\.id))
            messages = page.messages + messages.filter { !pageIds.contains($0.id) }
            olderBefore = page.before
            loadError = nil
            model.noteLoadedMessages(conversationId: id, ids: page.messages.map(\.id))
        } catch { if currentId == id, !Task.isCancelled { loadError = error.localizedDescription } }
    }

    private func submit(_ command: DeviceCommand) async -> Bool {
        guard !sending, model.isOnline, let drafts = model.drafts, let submitted = draft else { return false }
        let address = draftAddress
        let id = currentId
        guard !submitted.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.saveDrafts() else { return false }
        sending = true
        defer { sending = false }
        do {
            _ = try await model.send(command)
            model.error = nil
            drafts.clear(submitted, at: address)
            model.saveDrafts()
            if currentId == id { scrollRequest = UUID(); await loadLatest() }
            return true
        } catch {
            if model.error == nil { model.error = error.localizedDescription }
            return false
        }
    }

    private func cancel() async {
        guard !stopping, model.isOnline else { return }
        stopping = true
        defer { stopping = false }
        _ = try? await model.send(.messageCancel(conversationId: currentId))
        await loadLatest()
    }
}

private struct ThreadDirectory: View {
    let model: GhostModel
    let ghost: Ghost?
    let currentConversationId: String
    let selectConversation: (String) -> Void
    let openAllWorks: () -> Void

    private var roots: [Work] { model.snapshot.works.filter { $0.ghostId == ghost?.id && $0.parentId == nil } }
    private var live: [Work] { roots.filter { !$0.state.isTerminal }.sorted { $0.updatedAt > $1.updatedAt } }
    private var settled: [Work] { roots.filter { $0.state.isTerminal }.sorted { $0.updatedAt > $1.updatedAt } }
    private var conversations: [Conversation] {
        model.directConversations.filter { $0.ghostId == ghost?.id && $0.id != currentConversationId }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if roots.isEmpty { Text("아직 스레드 없음").font(.callout).foregroundStyle(GhostStyle.secondary).padding(.vertical, 20) }
                if !live.isEmpty { workSection("진행 중", works: live) }
                if !settled.isEmpty { workSection("끝난 일", works: Array(settled.prefix(5))) }
                if !conversations.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        sectionTitle("이전 대화")
                        ForEach(conversations) { conversation in
                            Button { selectConversation(conversation.id) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "bubble.left").foregroundStyle(GhostStyle.secondary)
                                    Text(conversationName(conversation)).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(GhostStyle.secondary)
                                }.padding(16).frame(minHeight: 44).background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 16))
                            }.buttonStyle(.plain).accessibilityIdentifier("conversation-\(conversation.id)")
                        }
                    }
                }
                Button(action: openAllWorks) {
                    HStack { Text("맡긴 일 전체"); Spacer(); Image(systemName: "arrow.up.right") }
                        .font(.callout).padding(16).frame(minHeight: 44)
                        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.plain)
            }.padding(16)
        }.background(GhostStyle.canvas).foregroundStyle(GhostStyle.ink)
            .navigationTitle("스레드").navigationBarTitleDisplayMode(.inline)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
    }
    private func workSection(_ title: String, works: [Work]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle(title)
            ForEach(works) { work in
                NavigationLink(value: work.id) {
                    HStack(alignment: .top, spacing: 12) {
                        StateGlyph(state: model.snapshot.glyph(for: work).rawValue, size: 20)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(work.title).font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                            Text(model.relativeTime(work.endedAt ?? work.updatedAt)).font(.caption).foregroundStyle(GhostStyle.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(GhostStyle.secondary)
                    }.padding(16).frame(minHeight: 44).background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.plain)
            }
        }
    }
    private func conversationName(_ conversation: Conversation) -> String {
        if conversation.id == ghost?.directConversationId { return "기본 대화" }
        if !conversation.title.isEmpty { return conversation.title }
        return contractDate(conversation.createdAt).formatted(.dateTime.locale(Locale(identifier: "ko_KR")).year().month().day())
    }
}
