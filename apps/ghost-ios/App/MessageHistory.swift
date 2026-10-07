import SwiftUI
import GhostMobileCore

private struct HistoryPreference: PreferenceKey {
    static let defaultValue = true
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}

struct MessageHistory: View {
    let profileName: String
    let messages: [JSON]
    let scrollRequest: UUID
    @State private var followsLatest = true
    @State private var hasNewMessages = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let bottomID = "history-bottom"

    var body: some View {
        let rows = messageRows(messages)
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if rows.isEmpty {
                            ContentUnavailableView("새 대화", systemImage: "bubble.left.and.bubble.right", description: Text("메시지를 입력하거나 음성 통화를 시작하세요."))
                        }
                        ForEach(rows) { row in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(row.value["role"].text == "user" ? "나" : profileName).font(.caption).foregroundStyle(GhostStyle.secondary)
                                Text(row.value["text"].text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(16).background(row.value["role"].text == "user" ? GhostStyle.under : GhostStyle.surface, in: RoundedRectangle(cornerRadius: 20))
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
    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        followsLatest = true; hasNewMessages = false
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
    }
}

private struct ObserveHistoryGeometry: ViewModifier {
    let update: (Bool) -> Void
    @State private var userScrolling = false
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
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
