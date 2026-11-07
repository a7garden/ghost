import SwiftUI
import GhostMobileCore

// 소식 tab: 확인 필요 (pending decisions with per-kind actions) and the
// notification feed.
struct InboxScreen: View {
    let model: GhostModel

    private var pendingDecisions: [Decision] {
        model.snapshot.decisions.filter { $0.isPending }.sorted { $0.createdAt < $1.createdAt }
    }
    private var settledDecisions: [Decision] {
        model.snapshot.decisions.filter { !$0.isPending }.sorted { ($0.resolvedAt ?? $0.createdAt) > ($1.resolvedAt ?? $1.createdAt) }
    }
    private var notifications: [GhostNotification] {
        model.snapshot.notifications.sorted { lhs, rhs in
            if lhs.isRead != rhs.isRead { return !lhs.isRead }
            return lhs.createdAt > rhs.createdAt
        }
    }

    var body: some View {
        NavigationStack {
            List {
                decisionsSection
                notificationsSection
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("소식")
            .refreshable { await model.refresh() }
            .onDisappear { model.saveDrafts() }
        }
    }

    // MARK: 확인 필요

    @ViewBuilder
    private var decisionsSection: some View {
        Section("확인 필요") {
            if pendingDecisions.isEmpty {
                Text("확인할 결정 없음").font(.callout).foregroundStyle(GhostStyle.secondary)
            }
            ForEach(pendingDecisions) { decision in
                DecisionCard(model: model, decision: decision)
            }
            ForEach(settledDecisions.prefix(5)) { decision in
                HStack(spacing: 8) {
                    Image(systemName: decision.state == .approved || decision.state == .answered ? "checkmark.circle" : "xmark.circle")
                        .foregroundStyle(decision.state == .denied || decision.state == .cancelled ? GhostStyle.secondary : GhostStyle.accent)
                    Text(decision.title).font(.subheadline).foregroundStyle(GhostStyle.secondary).lineLimit(1)
                    Spacer()
                    Text(decisionStateLabel(decision.state)).font(.caption).foregroundStyle(GhostStyle.secondary)
                }
            }
        }
    }

    // MARK: 소식

    @ViewBuilder
    private var notificationsSection: some View {
        Section("새 소식") {
            if notifications.isEmpty {
                VStack(alignment: .leading, spacing: 16) {
                    Image(systemName: "bell").font(.largeTitle).foregroundStyle(GhostStyle.accent)
                    Text("새 소식이 오면 알려드릴게요").font(.title2.weight(.semibold))
                    Text("도착한 결과와 확인이 필요한 소식을 이곳에서 볼 수 있어요.")
                        .foregroundStyle(GhostStyle.secondary)
                }.padding(.vertical, 24)
            }
            ForEach(notifications) { notification in
                Button {
                    model.route(notification)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            if !notification.isRead {
                                Circle().fill(GhostStyle.accent).frame(width: 8, height: 8)
                            }
                            Text(notification.title).font(.subheadline.weight(notification.isRead ? .regular : .semibold))
                            Spacer()
                            Text(model.relativeTime(notification.createdAt)).font(.caption).foregroundStyle(GhostStyle.secondary)
                        }
                        if !notification.body.isEmpty {
                            Text(notification.body).font(.footnote).foregroundStyle(GhostStyle.secondary).lineLimit(2)
                        }
                    }
                }
                .foregroundStyle(GhostStyle.text)
                .accessibilityIdentifier("notification-\(notification.id)")
            }
        }
    }

    private func decisionStateLabel(_ state: DecisionState) -> String {
        switch state {
        case .approved: "승인됨"
        case .denied: "거절됨"
        case .answered: "답변됨"
        case .cancelled: "취소됨"
        case .pending: "확인 필요"
        }
    }
}

/// One pending decision with the action set its kind allows.
private struct DecisionCard: View {
    let model: GhostModel
    let decision: Decision
    @State private var customAnswer = ""
    @State private var confirming: DecisionOutcome?
    @State private var issue: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(decision.title, systemImage: "hand.raised.fill")
                .font(.callout.weight(.semibold))
            HStack(spacing: 8) {
                Text(model.ghostName(decision.ghostId)).font(.caption).foregroundStyle(GhostStyle.secondary)
                Text(kindLabel).font(.caption).foregroundStyle(GhostStyle.secondary)
            }
            if !decision.detail.isEmpty {
                Text(decision.detail).font(.footnote).textSelection(.enabled)
            }
            if let proposal = decision.proposal, !proposal.pretty.isEmpty {
                Text(proposal.pretty)
                    .font(.caption.monospaced())
                    .foregroundStyle(GhostStyle.secondary)
                    .lineLimit(10)
                    .textSelection(.enabled)
                    .padding(10)
                    .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 10))
            }
            actions
            if let issue {
                Text(issue).font(.caption).foregroundStyle(GhostStyle.warning)
            }
        }
        .padding(.vertical, 4)
        .confirmationDialog(confirmTitle, isPresented: Binding(
            get: { confirming != nil },
            set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            Button(confirmLabel, role: confirming == .deny ? .destructive : nil) {
                let outcome = confirming
                confirming = nil
                if let outcome { resolve(outcome, answer: nil) }
            }
            Button("취소", role: .cancel) { confirming = nil }
        } message: {
            Text(confirmMessage)
        }
    }

    private var kindLabel: String {
        switch decision.kind {
        case .approve_effect: "효과 승인"
        case .question: "질문"
        case .accept_result: "결과 수락"
        case .document_review: "문서 검토"
        case .reconcile_effect: "효과 확인"
        }
    }

    @ViewBuilder
    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch decision.kind {
            case .approve_effect, .document_review, .reconcile_effect:
                HStack(spacing: 12) {
                    Button(approveLabel) { confirming = .approve }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || !model.isOnline)
                        .accessibilityIdentifier("decision-approve-\(decision.id)")
                    Button("거절", role: .destructive) { confirming = .deny }
                        .buttonStyle(.bordered)
                        .disabled(model.busy || !model.isOnline)
                        .accessibilityIdentifier("decision-deny-\(decision.id)")
                }
            case .accept_result:
                HStack(spacing: 12) {
                    Button("수락") { confirming = .approve }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || !model.isOnline)
                        .accessibilityIdentifier("decision-approve-\(decision.id)")
                    Button("거절", role: .destructive) { confirming = .deny }
                        .buttonStyle(.bordered)
                        .disabled(model.busy || !model.isOnline)
                        .accessibilityIdentifier("decision-deny-\(decision.id)")
                }
            case .question:
                if !decision.options.isEmpty {
                    ForEach(decision.options, id: \.self) { option in
                        Button(option) { resolve(.answer, answer: option) }
                            .buttonStyle(.bordered)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .disabled(model.busy || !model.isOnline)
                    }
                }
                HStack(spacing: 12) {
                    TextField("직접 답변", text: $customAnswer, axis: .vertical).lineLimit(1...3)
                    Button("답변") {
                        let answer = customAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !answer.isEmpty else { return }
                        resolve(.answer, answer: answer)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || !model.isOnline || customAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private var approveLabel: String {
        switch decision.kind {
        case .reconcile_effect: "다시 시도"
        default: "승인"
        }
    }

    private var confirmTitle: String {
        switch confirming {
        case .approve: "\(approveLabel)할까요?"
        case .deny: "거절할까요?"
        default: ""
        }
    }

    private var confirmLabel: String {
        confirming == .approve ? approveLabel : "거절"
    }

    private var confirmMessage: String {
        switch decision.kind {
        case .approve_effect: "이 효과를 승인하면 Ghost가 실행을 계속합니다."
        case .document_review: "이 문서 제안을 승인하면 저장이 진행됩니다."
        case .reconcile_effect: "확인되지 않은 효과를 다시 시도합니다."
        case .accept_result: "이 결과를 수락하면 맡긴 일이 완료됩니다."
        default: ""
        }
    }

    private func resolve(_ outcome: DecisionOutcome, answer: String?) {
        issue = nil
        Task {
            do {
                _ = try await model.send(.decisionResolve(decisionId: decision.id, outcome: outcome, answer: answer))
                if case .answer = outcome { customAnswer = "" }
            } catch {
                issue = model.error ?? error.localizedDescription
            }
        }
    }
}
