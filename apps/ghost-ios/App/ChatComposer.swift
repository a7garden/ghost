import SwiftUI
import GhostMobileCore

struct ChatComposer: View {
    let model: GhostModel
    let ghost: Ghost?
    let conversationId: String
    @Binding var text: String
    let sending: Bool
    let stopping: Bool
    let isRunning: Bool
    let focusRequest: UUID
    let submit: (DeviceCommand) async -> Bool
    let cancel: () async -> Void
    var focusChanged: (Bool) -> Void = { _ in }
    @FocusState private var focused: Bool
    @State private var workMode = false
    @State private var assigneeId: String?
    @State private var criteria = ""
    @State private var hasDeadline = false
    @State private var deadline = Date().addingTimeInterval(3600)

    private var candidates: [Ghost] { model.snapshot.visibleGhosts.filter { $0.state == .active } }
    private var recipient: Ghost? {
        if let assigneeId { return candidates.first { $0.id == assigneeId } }
        return ghost
    }
    private var disabled: Bool { !model.isOnline || model.drafts == nil || sending || model.busy }
    private var placeholder: String {
        if workMode { return "\(recipient?.name ?? "Ghost")에게 맡길 일을 적어 주세요. 첫 줄이 제목이 됩니다." }
        return isRunning ? "응답 중에도 덧붙일 수 있습니다" : "\(ghost?.name ?? "Ghost")에게 메시지"
    }
    private var trigger: (Character, String)? {
        guard !workMode, let first = text.first, first == "/" || first == "@", !text.contains(where: \.isWhitespace) else { return nil }
        return (first, String(text.dropFirst()))
    }
    private var workCommandMatches: Bool {
        guard let trigger, trigger.0 == "/" else { return false }
        return ["일로 맡기기", "맡기기", "일", "work", "assign"].contains { $0.localizedLowercase.hasPrefix(trigger.1.localizedLowercase) }
    }
    private var matchingGhosts: [Ghost] {
        guard let trigger, trigger.0 == "@" else { return [] }
        return candidates.filter { trigger.1.isEmpty || $0.name.localizedCaseInsensitiveContains(trigger.1) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            suggestions
            if workMode { workFields }
            HStack(alignment: .bottom, spacing: 4) {
                plusMenu
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(.body).lineLimit(1...6).focused($focused)
                    .disabled(model.drafts == nil || !model.isOnline)
                    .accessibilityIdentifier("chat-composer")
                    .accessibilityLabel(placeholder)
                    .padding(.vertical, 11).padding(.horizontal, 4)
                if isRunning {
                    Button { Task { await cancel() } } label: {
                        Group {
                            if stopping { ProgressView().controlSize(.small) }
                            else { Image(systemName: "stop.fill").font(.caption2.weight(.bold)) }
                        }
                        .foregroundStyle(GhostStyle.ink)
                        .frame(width: 32, height: 32).background(GhostStyle.under, in: Circle())
                        .frame(width: 44, height: 44).contentShape(Circle())
                    }
                    .buttonStyle(PressableStyle())
                    .accessibilityLabel("응답 중지").accessibilityIdentifier("chat-stop")
                    .disabled(stopping || sending || !model.isOnline || model.busy)
                }
                Button { Task { await send() } } label: {
                    if sending { ProgressView().controlSize(.small).tint(GhostStyle.onInk) }
                    else { Image(systemName: workMode ? "arrow.turn.up.right" : "arrow.up") }
                }
                .buttonStyle(GhostSendButtonStyle())
                .accessibilityLabel(sending ? "보내는 중" : workMode ? "일 맡기기" : "메시지 보내기")
                .disabled(disabled || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (workMode && recipient?.state != .active))
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
        .padding(.top, workMode || trigger != nil ? 8 : 0)
        .foregroundStyle(GhostStyle.ink)
        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(GhostStyle.border, lineWidth: 1) }
        .shadow(color: GhostStyle.shadow, radius: 12, y: 4)
        .onChange(of: focusRequest) { focused = true }
        .onChange(of: focused) { focusChanged(focused) }
        .onChange(of: conversationId) { workMode = false; assigneeId = nil; criteria = ""; hasDeadline = false }
    }

    private var plusMenu: some View {
        Menu {
            Button("일로 맡기기", systemImage: "arrow.turn.up.right") { enterWork(ghost) }
                .disabled(workMode || ghost?.state != .active)
            if candidates.count > 1 {
                Menu("다른 Ghost에게 맡기기", systemImage: "person.2") {
                    ForEach(candidates.filter { $0.id != ghost?.id }) { candidate in
                        Button(candidate.name) { enterWork(candidate) }
                    }
                }
            }
        } label: {
            Image(systemName: "plus").font(.body.weight(.medium))
                .frame(width: 32, height: 32).background(GhostStyle.under, in: Circle())
                .frame(width: 44, height: 44).contentShape(Circle())
        }
        .accessibilityLabel("더하기").disabled(disabled)
    }

    @ViewBuilder private var suggestions: some View {
        if workCommandMatches {
            suggestionGroup("명령") {
                Button { enterWork(ghost, clear: true) } label: {
                    suggestionRow(title: "일로 맡기기", hint: nil) { Image(systemName: "arrow.turn.up.right").frame(width: 24) }
                }.buttonStyle(.plain).disabled(disabled || ghost?.state != .active)
            }
        } else if !matchingGhosts.isEmpty {
            suggestionGroup("맡길 Ghost") {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(matchingGhosts) { candidate in
                            Button { enterWork(candidate, clear: true) } label: {
                                suggestionRow(title: candidate.name, hint: candidate.id == ghost?.id ? "이 대화" : GhostCopy.profileSummary(candidate.persona)) {
                                    GhostPortrait(ghost: candidate, size: 24)
                                }
                            }.buttonStyle(.plain).disabled(disabled)
                        }
                    }
                }
                .frame(maxHeight: 176).scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    private func suggestionGroup<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(GhostStyle.secondary).padding(.horizontal, 12)
            content()
        }
        .padding(.top, 4)
        .overlay(alignment: .bottom) { Rectangle().fill(GhostStyle.border).frame(height: 1).padding(.horizontal, 8) }
        .padding(.bottom, 2)
    }

    private func suggestionRow<Icon: View>(title: String, hint: String?, @ViewBuilder icon: () -> Icon) -> some View {
        HStack(spacing: 10) {
            icon()
            Text(title).font(.callout.weight(.medium))
            if let hint { Text(hint).font(.caption).foregroundStyle(GhostStyle.secondary).lineLimit(1) }
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle())
    }

    /// A 맡긴 일 in the making: the token says where it goes; criteria and a deadline are optional.
    private var workFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.turn.up.right").font(.caption2.weight(.bold))
                    Text("맡기기").font(.caption.weight(.semibold))
                    if let recipient, recipient.id != ghost?.id {
                        GhostPortrait(ghost: recipient, size: 16)
                        Text(recipient.name).font(.caption.weight(.semibold))
                    }
                    Button { workMode = false; assigneeId = nil; focused = true } label: {
                        Image(systemName: "xmark").font(.caption2.weight(.bold)).frame(width: 28, height: 28).contentShape(Rectangle())
                    }
                    .accessibilityLabel("일반 메시지로").disabled(sending)
                }
                .foregroundStyle(GhostStyle.signalInk)
                .padding(.leading, 10).frame(minHeight: 30)
                .background(GhostStyle.signalTint, in: Capsule())
                Spacer(minLength: 4)
                if hasDeadline {
                    DatePicker("기한", selection: $deadline, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                        .labelsHidden().datePickerStyle(.compact).environment(\.locale, Locale(identifier: "ko_KR"))
                        .disabled(disabled).scaleEffect(0.9, anchor: .trailing)
                    Button { hasDeadline = false } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(GhostStyle.secondary) }
                        .frame(width: 32, height: 44).accessibilityLabel("기한 빼기")
                } else {
                    Button { hasDeadline = true } label: {
                        Label("기한", systemImage: "calendar").font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
                            .padding(.horizontal, 10).frame(minHeight: 30)
                            .overlay { Capsule().stroke(GhostStyle.border, lineWidth: 1) }
                            .frame(minHeight: 44).contentShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(disabled)
                }
            }
            .padding(.horizontal, 6)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "checkmark.seal").font(.caption).foregroundStyle(GhostStyle.secondary)
                TextField("완료 기준 · 무엇이 되면 끝난 것인지", text: $criteria, axis: .vertical).lineLimit(1...3)
                    .font(.callout).disabled(disabled).accessibilityLabel("완료 기준")
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 4)
        }
    }

    private func enterWork(_ assignee: Ghost?, clear: Bool = false) {
        assigneeId = assignee?.id
        workMode = true
        if clear { text = "" }
        focused = true
    }

    private func send() async {
        guard !disabled else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        if workMode {
            guard let recipient, recipient.state == .active else { return }
            let command = DeviceCommand.workCreate(ghostId: recipient.id, title: GhostCopy.workTitle(body), brief: body,
                criteria: criteria.trimmingCharacters(in: .whitespacesAndNewlines),
                deadlineAt: hasDeadline ? Int(deadline.timeIntervalSince1970 * 1000) : nil,
                originConversationId: conversationId)
            if await submit(command) { workMode = false; assigneeId = nil; criteria = ""; hasDeadline = false }
        } else {
            _ = await submit(.messageSend(conversationId: conversationId, text: body))
        }
    }
}
