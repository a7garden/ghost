import SwiftUI
import UIKit
import GhostMobileCore

struct HistoryPreference: PreferenceKey {
    static let defaultValue = true
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}

/// One durable conversation with a Ghost. Work it takes on branches off as threads where it
/// began and returns as an outcome line; host wakes read as quiet events; tools fold into one
/// trail. The Ghost's face lives in the header, so replies are open text without a portrait.
struct MessageHistory: View {
    let model: GhostModel
    let ghost: Ghost?
    let conversationId: String
    let messages: [Message]
    var live: Live?
    let scrollRequest: UUID
    var actions = TranscriptActions()
    var hasOlder = false
    var loadingOlder = false
    var loadOlder: () async -> Void = {}
    @State private var followsLatest = true
    @State private var hasNewMessages = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let bottomID = "history-bottom"

    var body: some View {
        let transcript = rows
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if hasOlder {
                            Button { Task { await loadOlder() } } label: {
                                Text(loadingOlder ? "불러오는 중…" : "이전 메시지").font(.footnote.weight(.medium))
                                    .foregroundStyle(GhostStyle.secondary).frame(minHeight: 44)
                            }
                            .buttonStyle(.plain).disabled(loadingOlder).frame(maxWidth: .infinity)
                        }
                        if transcript.isEmpty && live?.running != true {
                            EmptyConversation(ghost: ghost, onStarter: actions.useStarter)
                        }
                        ForEach(transcript) { row in
                            rowView(row)
                        }
                        if let live, live.running {
                            LiveReply(live: live, ghost: ghost, state: model.snapshot, actions: actions)
                        }
                        Color.clear.frame(height: 1).id(bottomID).accessibilityHidden(true)
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 20).padding(.vertical, 16)
                    .frame(maxWidth: 720).frame(maxWidth: .infinity)
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
                .overlay(alignment: .bottom) {
                    if !followsLatest {
                        Button { jumpToLatest(proxy) } label: {
                            Label(hasNewMessages ? "새 메시지" : "최신 메시지", systemImage: "arrow.down")
                                .font(.footnote.weight(.semibold)).padding(.horizontal, 14).frame(minHeight: 36)
                                .background(.regularMaterial, in: Capsule())
                                .overlay { Capsule().stroke(GhostStyle.border) }
                                .frame(minHeight: 44).contentShape(Capsule())
                        }
                        .buttonStyle(.plain).foregroundStyle(GhostStyle.text)
                        .accessibilityIdentifier("latest-messages").padding(12)
                        .transition(.opacity)
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

    // MARK: Rows

    private enum Row: Identifiable, Equatable {
        case owner(Message)
        case reply(Message)
        case note(Message)
        case trail([Message])
        case thread(Work)
        case outcome(Outcome, Message)
        case wake(WakeView, Message)
        case delegation(Delegation, Message)

        var id: String {
            switch self {
            case .owner(let m), .reply(let m), .note(let m): "message-\(m.id)"
            case .trail(let tools): "tools-\(tools[0].id)"
            case .thread(let work): "work-\(work.id)"
            case .outcome(_, let m), .wake(_, let m), .delegation(_, let m): "event-\(m.id)"
            }
        }
    }

    private var rows: [Row] {
        let threads = model.snapshot.threads(of: conversationId)
        var entries: [(at: Int, order: Int, row: Row?)] = []
        entries.reserveCapacity(messages.count + threads.count)
        // A thread sits at the moment it began, before messages of that same moment.
        for work in threads { entries.append((work.createdAt, 0, .thread(work))) }
        for message in messages { entries.append((message.createdAt, 1, row(for: message))) }
        entries.sort { ($0.at, $0.order) < ($1.at, $1.order) }
        var result: [Row] = []
        result.reserveCapacity(entries.count)
        var trail: [Message] = []
        for entry in entries {
            if case .trail(let tools)? = entry.row {
                trail += tools
                continue
            }
            if !trail.isEmpty { result.append(.trail(trail)); trail = [] }
            if let row = entry.row { result.append(row) }
        }
        if !trail.isEmpty { result.append(.trail(trail)) }
        return result
    }

    private func row(for message: Message) -> Row? {
        switch message.role {
        case .tool:
            if let handoff = Wake.delegation(message) { return .delegation(handoff, message) }
            return .trail([message])
        case .user:
            guard let origin = message.origin, origin != "owner" else { return .owner(message) }
            if origin == "report" || origin == "child_result", let outcome = Wake.parseOutcome(message.text) { return .outcome(outcome, message) }
            return .wake(Wake.describe(origin: origin, text: message.text), message)
        case .assistant:
            let empty = message.text.isEmpty && (message.thinking ?? "").isEmpty && message.attachments.isEmpty
            return empty ? nil : .reply(message)
        case .note:
            return .note(message)
        }
    }

    @ViewBuilder private func rowView(_ row: Row) -> some View {
        let state = model.snapshot
        switch row {
        case .owner(let message):
            OwnerBubble(message: message, actions: actions)
        case .reply(let message):
            AssistantReply(message: message, state: state, actions: actions)
        case .note(let message):
            Text(message.text).font(.caption).foregroundStyle(GhostStyle.secondary)
                .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 2)
        case .trail(let tools):
            ToolTrail(results: tools)
        case .thread(let work):
            ThreadCard(work: work, state: state, model: model, open: { actions.openWork(work.id) })
        case .outcome(let outcome, let message):
            OutcomeLine(outcome: outcome, state: state, model: model, actions: actions)
                .accessibilityIdentifier("event-\(message.id)")
        case .wake(let view, let message):
            WakeEventRow(view: view, state: state, actions: actions)
                .accessibilityIdentifier("event-\(message.id)")
        case .delegation(let handoff, let message):
            EventLine(kind: "위임") {
                HStack(spacing: 6) {
                    if let target = state.ghosts.first(where: { $0.name == handoff.ghost }) { GhostPortrait(ghost: target, size: 16) }
                    Text("\(handoff.ghost) · \(handoff.title)")
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("event-\(message.id)")
        }
    }

    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        followsLatest = true; hasNewMessages = false
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
    }
}

// MARK: - Messages

private struct OwnerBubble: View {
    let message: Message
    let actions: TranscriptActions
    var body: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 8) {
                Text(message.text)
                    .font(.body).lineSpacing(3).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(GhostStyle.onInk)
                    .padding(.horizontal, 15).padding(.vertical, 10)
                    .background(GhostStyle.ink, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                if !message.attachments.isEmpty {
                    Flow { ForEach(message.attachments) { file in FileChip(artifact: file) { actions.openFile(file) } } }
                }
            }
        }
        .contextMenu {
            Button("메시지 복사", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
            Button("입력창으로 가져오기", systemImage: "arrow.uturn.down") { actions.reuse(message.text) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("나: \(message.text)")
    }
}

private struct AssistantReply: View {
    let message: Message
    let state: GhostStateSnapshot
    let actions: TranscriptActions
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let thinking = message.thinking, !thinking.isEmpty {
                ReasoningDisclosure(text: thinking, isThinking: false)
            }
            if !message.text.isEmpty {
                GhostProse(text: message.text, state: state, actions: actions)
                    .foregroundStyle(GhostStyle.text)
            }
            if !message.attachments.isEmpty {
                Flow { ForEach(message.attachments) { file in FileChip(artifact: file) { actions.openFile(file) } } }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            if !message.text.isEmpty {
                Button("메시지 복사", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                Button("인용해서 답장", systemImage: "text.quote") { actions.quote(message.text) }
            }
        }
    }
}

/// The generation in progress: running tools, then reasoning and the reply as they stream.
private struct LiveReply: View {
    let live: Live
    let ghost: Ghost?
    let state: GhostStateSnapshot
    let actions: TranscriptActions
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !live.tools.isEmpty { ToolTrail(results: [], running: live.tools) }
            if let thinking = live.thinking, !thinking.isEmpty {
                ReasoningDisclosure(text: thinking, isThinking: live.partial?.isEmpty != false)
            }
            if let partial = live.partial, !partial.isEmpty {
                GhostProse(text: partial, state: state, actions: actions).foregroundStyle(GhostStyle.text)
            } else if (live.thinking ?? "").isEmpty {
                HStack(spacing: 8) {
                    GhostPortrait(ghost: ghost, size: 22, presence: .working)
                    Text("응답 중").font(.footnote.weight(.medium)).foregroundStyle(GhostStyle.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("\(ghost?.name ?? "Ghost") · 응답 작성 중")
    }
}

/// The empty conversation is the Ghost's name and a few ways in; the header already shows its face.
private struct EmptyConversation: View {
    let ghost: Ghost?
    let onStarter: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(ghost?.name ?? "Ghost")
                .font(.system(.largeTitle, design: .rounded, weight: .semibold)).tracking(-0.6)
            if let persona = ghost?.persona, !persona.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Flow(spacing: 8) {
                    ForEach(GhostCopy.starters(persona: persona), id: \.label) { starter in
                        Button { onStarter(starter.prompt) } label: {
                            Text(starter.label).font(.subheadline.weight(.medium))
                                .padding(.horizontal, 14).frame(minHeight: 40)
                                .background(GhostStyle.surface, in: Capsule())
                                .overlay { Capsule().stroke(GhostStyle.border) }
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain).foregroundStyle(GhostStyle.text)
                        .accessibilityHint(starter.prompt)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("대화 시작 제안")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 48).padding(.bottom, 16)
    }
}

// MARK: - Threads and outcomes

/// A Work this conversation spun off, kept live where it began. Settled, it folds to one line
/// because its outcome returns below; live, it shows its carrier, lifecycle and delegates.
private struct ThreadCard: View {
    let work: Work
    let state: GhostStateSnapshot
    let model: GhostModel
    let open: () -> Void
    private let shownDelegates = 4

    var body: some View {
        let glyph = state.glyph(for: work)
        let delegates = state.delegates(of: work)
        let settled = work.state.isTerminal
        Branch(color: settled ? glyph.branch : GhostStyle.ink.opacity(0.16), turnAt: settled ? 16 : 26) {
            Button(action: open) {
                if settled {
                    HStack(spacing: 8) {
                        StateGlyph(state: glyph.rawValue, size: 16)
                        Text(work.title).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text(GhostCopy.relativeTime(work.endedAt ?? work.updatedAt)).font(.caption).foregroundStyle(GhostStyle.secondary)
                            .monospacedDigit()
                    }
                    .frame(minHeight: 32)
                } else {
                    liveCard(glyph: glyph, delegates: delegates)
                }
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("스레드: \(work.title), \(glyph.label)\(delegates.isEmpty ? "" : ", 위임 \(delegates.count)")")
            .accessibilityIdentifier("thread-\(work.id)")
            .contextMenu { Button("스레드 열기", systemImage: "arrow.triangle.branch", action: open) }
        }
    }

    private func liveCard(glyph: GlyphState, delegates: [Work]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                StateGlyph(state: glyph.rawValue, size: 18).padding(.top, 1)
                VStack(alignment: .leading, spacing: 6) {
                    Text(work.title).font(.subheadline.weight(.semibold)).foregroundStyle(GhostStyle.text)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    Flow(spacing: 6) {
                        HStack(spacing: 5) {
                            GhostPortrait(ghost: model.ghost(work.ghostId), size: 16)
                            Text(model.ghostName(work.ghostId))
                        }
                        Text(glyph.label).foregroundStyle(glyph.ink)
                        Text(GhostCopy.relativeTime(work.updatedAt)).monospacedDigit()
                    }
                    .font(.caption).foregroundStyle(GhostStyle.secondary)
                    LifecycleTrack(state: work.state, needsOwner: glyph == .attention, compact: true)
                        .frame(width: 64).padding(.top, 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !delegates.isEmpty {
                Flow(spacing: 6) {
                    ForEach(delegates.prefix(shownDelegates)) { child in
                        HStack(spacing: 5) {
                            StateGlyph(state: state.glyph(for: child).rawValue, size: 12)
                            GhostPortrait(ghost: model.ghost(child.ghostId), size: 14)
                            Text(model.ghostName(child.ghostId)).lineLimit(1)
                        }
                        .font(.caption2.weight(.medium)).foregroundStyle(GhostStyle.secondary)
                        .padding(.horizontal, 8).frame(height: 24)
                        .background(GhostStyle.under, in: Capsule())
                    }
                    if delegates.count > shownDelegates {
                        Text("+\(delegates.count - shownDelegates)").font(.caption2.weight(.medium)).foregroundStyle(GhostStyle.secondary)
                            .padding(.horizontal, 8).frame(height: 24).background(GhostStyle.under, in: Capsule())
                    }
                }
                .padding(.leading, 28)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(GhostStyle.border.opacity(0.7), lineWidth: 1) }
    }
}

/// A Work coming back to where it branched off: one tinted line with its state, the files it
/// made or why it failed. Audit facts sit behind a long press instead of a hover.
private struct OutcomeLine: View {
    let outcome: Outcome
    let state: GhostStateSnapshot
    let model: GhostModel
    let actions: TranscriptActions

    var body: some View {
        let work = state.works.first { $0.id == outcome.workId }
        let glyph = GlyphState(rawValue: work?.state.rawValue ?? outcome.state) ?? .done
        let title = work?.title ?? outcome.title
        let reason = glyph == .done ? "" : (work?.reason ?? outcome.reason)
        let files = glyph == .done ? (work?.result?.artifacts ?? []) : []
        Branch(color: glyph.branch, turnAt: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Button { actions.openWork(outcome.workId) } label: {
                    HStack(spacing: 8) {
                        StateGlyph(state: glyph.rawValue, size: 16)
                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(GhostStyle.text).lineLimit(1)
                        Text(glyph.label).font(.caption.weight(.medium)).foregroundStyle(glyph.ink)
                    }
                    .padding(.leading, 9).padding(.trailing, 13).frame(minHeight: 34)
                    .background(glyph.tint, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("\(title), \(glyph.label)")
                .contextMenu { facts(work: work) }
                if !reason.isEmpty {
                    GhostProse(text: reason, state: state, actions: actions, font: .subheadline)
                        .foregroundStyle(GhostStyle.secondary).lineLimit(3).padding(.leading, 4)
                }
                if !files.isEmpty {
                    Flow { ForEach(files) { file in FileChip(artifact: file) { actions.openFile(file) } } }
                }
            }
        }
    }

    @ViewBuilder private func facts(work: Work?) -> some View {
        if let work {
            Text("담당 · \(model.ghostName(work.ghostId))")
            if let verdict = work.verdict { Text("판정 · \(Self.judge(verdict.source)) · \(Self.ruling(verdict.outcome))") }
            if let took = GhostCopy.duration(work) { Text("걸린 시간 · \(took)") }
            if work.revisionsUsed > 0 { Text("수정 · \(work.revisionsUsed)회") }
        }
        Button("스레드 열기", systemImage: "arrow.triangle.branch") { actions.openWork(outcome.workId) }
        Button("식별자 복사", systemImage: "number") { UIPasteboard.general.string = outcome.workId }
    }

    static func judge(_ source: String) -> String {
        switch source { case "checks": "자동 검사"; case "review": "검토 Ghost"; case "owner": "직접 확인"; default: source }
    }
    static func ruling(_ outcome: String) -> String {
        switch outcome { case "pass": "통과"; case "revise": "수정 요청"; case "fail": "불합격"; default: outcome }
    }
}

// MARK: - Events

/// A quiet line in the transcript: what kind of thing happened, then one line of it.
private struct EventLine<Content: View>: View {
    let kind: String
    @ViewBuilder var content: Content
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(kind).font(.caption2.weight(.semibold)).foregroundStyle(GhostStyle.secondary)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            content.font(.footnote).foregroundStyle(GhostStyle.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
    }
}

/// A wake the host sent on the owner's behalf, in the owner's words; the Ghost's exact text unfolds below.
private struct WakeEventRow: View {
    let view: WakeView
    let state: GhostStateSnapshot
    let actions: TranscriptActions
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { if view.detail != nil { open.toggle() } } label: {
                EventLine(kind: view.label) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(GhostInline.render(view.line, state: state)).lineLimit(open ? nil : 2).multilineTextAlignment(.leading)
                        if view.detail != nil {
                            Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                                .rotationEffect(.degrees(open ? 180 : 0))
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .environment(\.openURL, OpenURLAction { url in GhostProse.handle(url, state: state, actions: actions) })
            .accessibilityHint(view.detail != nil ? (open ? "원문 접기" : "원문 펼치기") : "")
            if open, let detail = view.detail {
                Text(detail).font(.caption.monospaced()).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }
}

/// Tools a Ghost used, in order, folded into one line of chips; opening shows every output.
private struct ToolTrail: View {
    let results: [Message]
    var running: [LiveTool] = []
    @State private var open = false

    private struct Step: Identifiable {
        let id: String, name: String, output: String, failed: Bool, live: Bool
    }
    private var steps: [Step] {
        results.map { Step(id: $0.id, name: $0.tool?.name ?? "도구", output: $0.text, failed: $0.tool?.isError == true, live: false) }
            + running.map { Step(id: $0.callId, name: $0.name, output: $0.output, failed: false, live: true) }
    }

    var body: some View {
        let all = steps
        let failed = all.filter(\.failed).count
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.16)) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text(running.isEmpty ? "도구 \(all.count)개 사용" : "도구 사용 중").font(.caption.weight(.medium))
                    if failed > 0 { Text("실패 \(failed)").font(.caption.weight(.medium)).foregroundStyle(GhostStyle.dangerInk) }
                    ViewThatFits(in: .horizontal) {
                        chips(all.suffix(6), more: max(0, all.count - 6))
                        chips(all.suffix(2), more: max(0, all.count - 2))
                        EmptyView()
                    }
                }
                .foregroundStyle(GhostStyle.secondary).frame(minHeight: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(running.isEmpty ? "도구 \(all.count)개 사용\(failed > 0 ? ", 실패 \(failed)" : "")" : "도구 사용 중")
            .accessibilityHint(open ? "접기" : "펼치기")
            if open {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(all) { step in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Text(step.name).font(.caption.monospaced().weight(.semibold))
                                if step.failed { Text("실패").font(.caption2.weight(.semibold)).foregroundStyle(GhostStyle.dangerInk) }
                                if step.live { Text("실행 중").font(.caption2.weight(.semibold)).foregroundStyle(GhostStyle.signalInk) }
                            }
                            if !step.output.isEmpty {
                                Text(step.output).font(.caption.monospaced()).foregroundStyle(GhostStyle.secondary)
                                    .lineLimit(12).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func chips(_ shown: ArraySlice<Step>, more: Int) -> some View {
        HStack(spacing: 4) {
            ForEach(shown) { step in
                Text(step.name).font(.caption2.monospaced())
                    .foregroundStyle(step.failed ? GhostStyle.dangerInk : (step.live ? GhostStyle.signalInk : GhostStyle.secondary))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    .lineLimit(1).fixedSize()
            }
            if more > 0 { Text("+\(more)").font(.caption2.monospaced()) }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Reasoning

struct ReasoningDisclosure: View {
    let text: String
    let isThinking: Bool
    @State private var expanded = false
    private var lines: [String] {
        text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    /// While thinking, the newest step names it: the latest bold heading, else the latest line.
    private var newestStep: String {
        let headings = lines.filter { $0.hasPrefix("**") && $0.hasSuffix("**") && $0.count > 4 }
        return (headings.last ?? lines.last ?? "").replacingOccurrences(of: "**", with: "")
    }
    var body: some View {
        let open = isThinking || expanded
        VStack(alignment: .leading, spacing: 6) {
            Button { if !isThinking { withAnimation(.easeOut(duration: 0.16)) { expanded.toggle() } } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if isThinking { StateGlyph(state: "running", size: 12) }
                    else { Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(open ? 90 : 0)) }
                    Text(isThinking ? "생각 중" : "생각 과정").font(.caption.weight(.medium))
                    if isThinking, !newestStep.isEmpty {
                        Text(newestStep).font(.caption).foregroundStyle(GhostStyle.text.opacity(0.7)).lineLimit(2)
                    }
                }
                .frame(minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text((isThinking ? lines.dropLast().suffix(3) : lines[...]).joined(separator: "\n").replacingOccurrences(of: "**", with: ""))
                    .font(.footnote).lineSpacing(3).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Capsule().fill(GhostStyle.border).frame(width: 2) }
            }
        }
        .foregroundStyle(GhostStyle.secondary)
        .onChange(of: isThinking) { expanded = false }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(isThinking ? "live-reasoning" : "message-reasoning")
    }
}

/// Press feedback without the system button chrome.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
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
