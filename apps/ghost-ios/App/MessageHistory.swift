import SwiftUI
import GhostMobileCore

struct HistoryPreference: PreferenceKey {
    static let defaultValue = true
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}

struct MessageHistory: View {
    let model: GhostModel
    let ghost: Ghost?
    let works: [Work]
    let messages: [Message]
    var live: Live?
    let scrollRequest: UUID
    @State private var followsLatest = true
    @State private var hasNewMessages = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let bottomID = "history-bottom"

    var body: some View {
        let transcript = rows
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if transcript.isEmpty {
                            GhostEmptyConversation(ghost: ghost)
                        }
                        ForEach(transcript) { row in
                            rowView(row)
                        }
                        if let live, live.running {
                            VStack(alignment: .leading, spacing: 12) {
                                if let thinking = live.thinking, !thinking.isEmpty {
                                    ReasoningDisclosure(text: thinking, isThinking: live.partial?.isEmpty != false)
                                        .padding(.leading, 42)
                                }
                                if let partial = live.partial, !partial.isEmpty { streamingBubble(partial) }
                                if !live.tools.isEmpty {
                                    DisclosureGroup {
                                        ForEach(live.tools, id: \.callId) { tool in
                                            VStack(alignment: .leading, spacing: 6) {
                                                Text(tool.name).font(.caption.monospaced().weight(.medium))
                                                Text(tool.output).font(.caption.monospaced()).textSelection(.enabled)
                                            }.padding(.vertical, 6)
                                        }
                                    } label: {
                                        Label(live.tools.map(\.name).joined(separator: " · "), systemImage: "gearshape")
                                            .font(.caption).foregroundStyle(GhostStyle.secondary)
                                    }
                                }
                            }
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
                .modifier(ObserveHistoryGeometry(followsLatest: followsLatest) { nearBottom in
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
                .onChange(of: transcript.last) {
                    if followsLatest { proxy.scrollTo(bottomID, anchor: .bottom) }
                    else { hasNewMessages = true }
                }
                .onChange(of: scrollRequest) { jumpToLatest(proxy) }
                .onChange(of: live) { if followsLatest { proxy.scrollTo(bottomID, anchor: .bottom) } }
                .onChange(of: viewport.size.height) { if followsLatest { proxy.scrollTo(bottomID, anchor: .bottom) } }
            }
        }
        .background(GhostStyle.canvas)
    }

    private enum Row: Identifiable, Equatable {
        case message(Message), tools([Message]), work(Work)
        var id: String {
            switch self {
            case .message(let m): "message-\(m.id)"
            case .tools(let tools): "tools-\(tools[0].id)"
            case .work(let work): "work-\(work.id)"
            }
        }
    }
    private var rows: [Row] {
        var entries: [(at: Int, row: Row)] = []
        entries.reserveCapacity(messages.count + works.count)
        for message in messages { entries.append((message.createdAt, .message(message))) }
        for work in works { entries.append((work.createdAt, .work(work))) }
        entries.sort { $0.at == $1.at ? $0.row.id < $1.row.id : $0.at < $1.at }
        var result: [Row] = []
        result.reserveCapacity(entries.count)
        var trail: [Message] = []
        for entry in entries {
            if case .message(let message) = entry.row, message.role == .tool {
                trail.append(message)
            } else {
                if !trail.isEmpty { result.append(.tools(trail)); trail = [] }
                result.append(entry.row)
            }
        }
        if !trail.isEmpty { result.append(.tools(trail)) }
        return result
    }

    @ViewBuilder private func rowView(_ row: Row) -> some View {
        switch row {
        case .work(let work):
            NavigationLink { WorkDetailScreen(model: model, workId: work.id) } label: {
                WorkThreadCard(model: model, work: work)
            }.buttonStyle(.plain).accessibilityIdentifier("thread-\(work.id)")
        case .tools(let tools):
            DisclosureGroup {
                ForEach(tools) { tool in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(tool.tool?.name ?? "도구").font(.caption.monospaced().weight(.medium))
                        Text(tool.text).font(.caption.monospaced()).textSelection(.enabled)
                    }.foregroundStyle(tool.tool?.isError == true ? GhostStyle.dangerInk : GhostStyle.secondary)
                        .padding(.vertical, 6)
                }
            } label: {
                Label(tools.map { $0.tool?.name ?? "도구" }.joined(separator: " · "), systemImage: "gearshape")
                    .font(.caption).foregroundStyle(GhostStyle.secondary)
            }.padding(12).background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
        case .message(let message):
            if let origin = message.origin, origin != "owner" {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "arrow.turn.down.right").padding(.top, 2)
                    Text(message.text).textSelection(.enabled)
                }
                .font(.caption).foregroundStyle(GhostStyle.secondary)
                .padding(.vertical, 4).padding(.leading, 12)
                .accessibilityIdentifier("event-\(message.id)")
            } else {
                switch message.role {
                case .user:
                    GhostMessageBubble(text: message.text, isUser: true, label: "나") { EmptyView() }
                case .assistant:
                    VStack(alignment: .leading, spacing: 12) {
                        if let thinking = message.thinking, !thinking.isEmpty {
                            ReasoningDisclosure(text: thinking, isThinking: false).padding(.leading, 42)
                        }
                        GhostMessageBubble(text: message.text, isUser: false, label: ghost?.name ?? "Ghost", ghost: ghost) {
                            if !message.attachments.isEmpty { attachmentsRow(message.attachments) }
                        }
                    }
                case .tool: EmptyView() // Consecutive tools are grouped above.
                case .note:
                    Text(message.text).font(.caption).foregroundStyle(GhostStyle.secondary)
                        .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 2)
                }
            }
        }
    }

    private func streamingBubble(_ text: String) -> some View {
        GhostMessageBubble(text: text, isUser: false, label: ghost?.name ?? "Ghost", ghost: ghost) {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("입력 중").font(.caption).foregroundStyle(GhostStyle.secondary)
            }
        }
    }

    @ViewBuilder
    private func attachmentsRow(_ attachments: [ArtifactRef]) -> some View {
        // Attachment names only; opening artifact bytes is a work-detail surface.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                ForEach(attachments, id: \.digest) { attachment in
                    Label(attachment.name, systemImage: "paperclip")
                        .font(.caption).padding(.horizontal, 10).padding(.vertical, 6)
                        .background(GhostStyle.under, in: Capsule())
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(attachments, id: \.digest) { attachment in
                    Label(attachment.name, systemImage: "paperclip").font(.caption)
                }
            }
        }
    }

    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        followsLatest = true; hasNewMessages = false
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
    }
}

struct ReasoningDisclosure: View {
    let text: String
    let isThinking: Bool
    @State private var expanded = false
    private var lines: [Substring] { text.split(whereSeparator: \.isNewline) }
    private var newestStep: String { String(lines.last ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "**", with: "") }
    var body: some View {
        DisclosureGroup(isExpanded: Binding(
            get: { isThinking || expanded },
            set: { expanded = $0 })) {
                Text(isThinking ? lines.dropLast().suffix(3).joined(separator: "\n").replacingOccurrences(of: "**", with: "") : text)
                    .font(.footnote).lineSpacing(4).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if isThinking { StateGlyph(state: "running", size: 13) }
                        Text(isThinking ? "생각 중" : "생각 과정").font(.caption.weight(.medium))
                    }
                    if isThinking, !newestStep.isEmpty {
                        Text(newestStep).font(.caption).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .foregroundStyle(GhostStyle.secondary)
            .onChange(of: isThinking) { expanded = false }
            .accessibilityIdentifier(isThinking ? "live-reasoning" : "message-reasoning")
    }
}

struct ObserveHistoryGeometry: ViewModifier {
    let followsLatest: Bool
    let update: (Bool) -> Void
    @State private var userScrolling = false
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(followsLatest ? .bottom : nil, for: .sizeChanges)
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
