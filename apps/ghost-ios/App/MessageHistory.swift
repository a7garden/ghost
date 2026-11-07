import SwiftUI
import GhostMobileCore

struct HistoryPreference: PreferenceKey {
    static let defaultValue = true
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}

struct MessageHistory: View {
    let ghostName: String
    let messages: [Message]
    var live: Live?
    let scrollRequest: UUID
    @State private var followsLatest = true
    @State private var hasNewMessages = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let bottomID = "history-bottom"

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if rows.isEmpty {
                            GhostEmptyConversation()
                        }
                        ForEach(rows) { row in
                            rowView(row)
                        }
                        if let live, live.running, let partial = live.partial, !partial.isEmpty {
                            streamingBubble(partial)
                        }
                        Color.clear.frame(height: 1).id(bottomID).accessibilityHidden(true)
                    }
                    .scrollTargetLayout()
                    .padding(16)
                    .background {
                        if #unavailable(iOS 18) {
                            GeometryReader { content in
                                Color.clear.preference(key: HistoryPreference.self, value:
                                    content.frame(in: .named("history")).maxY - viewport.size.height < 80)
                            }
                        }
                    }
                }
                .coordinateSpace(name: "history")
                .accessibilityIdentifier("chat-history")
                .scrollDismissesKeyboard(.interactively)
                .modifier(ObserveHistoryGeometry { nearBottom in
                    followsLatest = nearBottom
                    if nearBottom { hasNewMessages = false }
                })
                .overlay(alignment: .bottomTrailing) {
                    if !followsLatest {
                        Button { jumpToLatest(proxy) } label: {
                            Label(hasNewMessages ? "새 메시지" : "최근 메시지", systemImage: "arrow.down")
                                .font(.callout.weight(.medium)).padding(.horizontal, 16).frame(minHeight: 44)
                                .background(GhostStyle.under, in: Capsule())
                                .overlay { Capsule().stroke(GhostStyle.border) }
                        }.accessibilityIdentifier("latest-messages").padding(16)
                    }
                }
                .task { proxy.scrollTo(bottomID, anchor: .bottom) }
                .onChange(of: rows.last) {
                    if followsLatest { proxy.scrollTo(bottomID, anchor: .bottom) }
                    else { hasNewMessages = true }
                }
                .onChange(of: scrollRequest) { jumpToLatest(proxy) }
                .onChange(of: viewport.size.height) { if followsLatest { proxy.scrollTo(bottomID, anchor: .bottom) } }
            }
        }
    }

    private var rows: [Message] { messages }

    @ViewBuilder
    private func rowView(_ message: Message) -> some View {
        switch message.role {
        case .user:
            GhostMessageBubble(text: message.text, isUser: true, label: "나") { EmptyView() }
        case .assistant:
            GhostMessageBubble(text: message.text, isUser: false, label: ghostName) {
                if !message.attachments.isEmpty {
                    attachmentsRow(message.attachments)
                }
            }
        case .tool:
            VStack(alignment: .leading, spacing: 4) {
                Label {
                    Text(message.tool?.name ?? "도구").font(.caption.weight(.medium))
                } icon: {
                    Image(systemName: message.tool?.isError == true ? "exclamationmark.circle" : "gearshape")
                }
                .foregroundStyle(message.tool?.isError == true ? GhostStyle.warning : GhostStyle.secondary)
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.caption.monospaced())
                        .foregroundStyle(GhostStyle.secondary)
                        .lineLimit(6)
                        .textSelection(.enabled)
                }
            }
            .padding(12)
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
            .frame(maxWidth: 680, alignment: .leading)
        case .note:
            Text(message.text)
                .font(.caption).foregroundStyle(GhostStyle.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 2)
        }
    }

    private func streamingBubble(_ text: String) -> some View {
        GhostMessageBubble(text: text, isUser: false, label: ghostName) {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("입력 중").font(.caption).foregroundStyle(GhostStyle.secondary)
            }
        }
    }

    @ViewBuilder
    private func attachmentsRow(_ attachments: [ArtifactRef]) -> some View {
        // Attachment names only; opening artifact bytes is a work-detail surface.
        HStack {
            ForEach(attachments, id: \.digest) { attachment in
                Label(attachment.name, systemImage: "paperclip")
                    .font(.caption)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(GhostStyle.under, in: Capsule())
            }
        }
    }

    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        followsLatest = true; hasNewMessages = false
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
    }
}

struct ObserveHistoryGeometry: ViewModifier {
    let update: (Bool) -> Void
    @State private var userScrolling = false
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 80
            } action: { _, nearBottom in
                if userScrolling { update(nearBottom) }
            }
            .onScrollPhaseChange { _, phase, context in
                // Distinguish user scrolling from row measurement changes and
                // programmatic jumps. Only a threshold change updates the view.
                guard phase != .animating else { userScrolling = false; return }
                let wasUserScrolling = userScrolling
                userScrolling = phase != .idle
                guard userScrolling || wasUserScrolling else { return }
                let geometry = context.geometry
                update(geometry.contentSize.height - geometry.visibleRect.maxY < 80)
            }
        } else {
            content.defaultScrollAnchor(.bottom).onPreferenceChange(HistoryPreference.self, perform: update)
        }
    }
}
