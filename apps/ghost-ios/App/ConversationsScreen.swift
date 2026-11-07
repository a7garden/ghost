import SwiftUI
import GhostMobileCore

// 대화 tab: the direct conversations this device is granted, grouped per
// Ghost, with the live transcript, streaming text, and the composer.
struct ConversationsScreen: View {
    let model: GhostModel
    @State private var path = NavigationPath()

    private var entries: [(ghost: Ghost, conversations: [Conversation])] {
        let grouped = Dictionary(grouping: model.grantedConversations, by: \.ghostId)
        let ghosts = model.snapshot.ghosts
            .filter { model.grantedGhostIDs.contains($0.id) }
            .sorted { lhs, rhs in
                if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
        return ghosts.map { ghost in
            let conversations = (grouped[ghost.id] ?? []).sorted { $0.lastActivityAt > $1.lastActivityAt }
            return (ghost, conversations)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if entries.isEmpty {
                    ContentUnavailableView("연결된 대화 없음", systemImage: "bubble.left",
                        description: Text("PC에서 이 기기의 Ghost 사용 권한을 조정해 주세요."))
                }
                ForEach(entries, id: \.ghost.id) { entry in
                    Section(entry.ghost.name) {
                        ForEach(entry.conversations) { conversation in
                            NavigationLink(value: conversation.id) {
                                HStack(spacing: 14) {
                                    Image(systemName: "bubble.left.fill")
                                        .font(.title3)
                                        .frame(width: 42, height: 42)
                                        .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 13))
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(conversation.title.isEmpty ? "대화" : conversation.title)
                                            .font(.subheadline.weight(.medium))
                                        HStack(spacing: 6) {
                                            if conversation.busy {
                                                Label("응답 중", systemImage: "circle.dotted").font(.caption)
                                            } else if let live = model.liveByConversation[conversation.id], live.running {
                                                Label("입력 중", systemImage: "circle.dotted").font(.caption)
                                            }
                                            Text(model.relativeTime(conversation.lastActivityAt))
                                                .font(.caption).foregroundStyle(GhostStyle.secondary)
                                        }
                                        .foregroundStyle(GhostStyle.secondary)
                                    }
                                }.padding(.vertical, 4)
                            }
                            .accessibilityIdentifier("conversation-\(conversation.id)")
                        }
                    }
                }
                if let error = model.error {
                    Section { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("대화")
            .navigationDestination(for: String.self) { conversationId in
                ChatScreen(model: model, conversationId: conversationId)
            }
            .refreshable { await model.refresh() }
        }
        .onChange(of: model.chatRoute) {
            guard let route = model.chatRoute else { return }
            path.append(route.conversationId)
        }
        .onChange(of: model.notificationRoute) {
            guard let route = model.notificationRoute,
                  let notification = model.snapshot.notifications.first(where: { $0.id == route.notificationId }),
                  let conversationId = notification.conversationId else { return }
            path.append(conversationId)
        }
    }
}

struct ChatScreen: View {
    let model: GhostModel
    let conversationId: String
    @State private var messages: [Message] = []
    @State private var olderBefore: String?
    @State private var loadingOlder = false
    @State private var loadError: String?
    @State private var sending = false
    @State private var scrollRequest = UUID()

    private var conversation: Conversation? { model.snapshot.conversations.first { $0.id == conversationId } }
    private var ghost: Ghost? { conversation.map { model.ghost($0.ghostId) } ?? nil }
    private var title: String { conversation?.title.isEmpty == false ? conversation!.title : (ghost?.name ?? "대화") }
    private var live: Live? { model.liveByConversation[conversationId] }
    private var isBusy: Bool { conversation?.busy == true || live?.running == true }

    private var draftAddress: DraftAddress { model.draftAddress(conversationId: conversationId) }
    private var draftText: Binding<String> {
        let address = draftAddress
        return Binding(
            get: { model.drafts?.draft(at: address)?.text ?? "" },
            set: { model.drafts?.update($0, at: address) })
    }

    var body: some View {
        MessageHistory(ghostName: ghost?.name ?? "Ghost", messages: messages, live: live, scrollRequest: scrollRequest)
        .id(conversationId)
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if isBusy {
                    Button {
                        Task { await cancel() }
                    } label: {
                        Label("응답 중지", systemImage: "stop.circle")
                    }
                    .disabled(sending || !model.isOnline)
                    .accessibilityIdentifier("chat-stop")
                }
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
                    }.accessibilityLabel(sending ? "보내는 중" : "메시지 보내기")
                        .disabled(sending || (model.drafts?.draft(at: draftAddress)?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.isOnline)
                }.padding(12).background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 28))
            }.padding(.horizontal, 16).padding(.bottom, 8).background(GhostStyle.surface)
        }
        .task(id: conversationId) { await loadLatest() }
        .overlay {
            if messages.isEmpty, let loadError {
                ContentUnavailableView("대화를 불러오지 못했습니다", systemImage: "wifi.exclamationmark", description: Text(loadError))
            }
        }
        .onChange(of: model.appendedMessages[conversationId]?.count ?? 0) {
            let fresh = model.drainAppendedMessages(conversationId: conversationId, loadedIDs: Set(messages.map(\.id)))
            guard !fresh.isEmpty else { return }
            if olderBefore == nil {
                messages += fresh
                model.noteLoadedMessages(conversationId: conversationId, ids: fresh.map(\.id))
            }
        }
        .task(id: draft?.revision) {
            do { try await Task.sleep(for: .milliseconds(300)); model.saveDrafts() } catch { }
        }
        .onDisappear { model.saveDrafts() }
    }

    private func loadLatest() async {
        do {
            let page = try await model.conversationPage(id: conversationId)
            messages = page.messages
            olderBefore = page.before
            loadError = nil
            model.noteLoadedMessages(conversationId: conversationId, ids: page.messages.map(\.id))
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func loadOlder() async {
        guard let before = olderBefore, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await model.conversationPage(id: conversationId, before: before)
            let pageIDs = Set(page.messages.map(\.id))
            messages = page.messages + messages.filter { !pageIDs.contains($0.id) }
            olderBefore = page.before
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func submit() async {
        guard !sending, let drafts = model.drafts, let submitted = draft else { return }
        let text = submitted.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, model.saveDrafts() else { return }
        sending = true
        defer { sending = false }
        do {
            _ = try await model.send(.messageSend(conversationId: conversationId, text: text))
            drafts.clear(submitted, at: draftAddress)
            try drafts.save()
            scrollRequest = UUID()
            model.error = nil
            await loadLatest()
        } catch { /* model.send already surfaced the error */ }
    }

    private var draft: ConversationDraft? { model.drafts?.draft(at: draftAddress) }

    private func cancel() async {
        _ = try? await model.send(.messageCancel(conversationId: conversationId))
        await loadLatest()
    }
}
