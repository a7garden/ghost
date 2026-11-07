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
struct DecisionCard: View {
    let model: GhostModel
    let decision: Decision
    @State private var customAnswer = ""
    @State private var confirming: DecisionOutcome?
    @State private var issue: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 10) {
                StateGlyph(state: "pending", size: 22)
                VStack(alignment: .leading, spacing: 6) {
                    Text(decision.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Text(model.ghostName(decision.ghostId))
                        Text(kindLabel)
                    }.font(.caption).foregroundStyle(GhostStyle.secondary)
                }
            }
            if !decision.detail.isEmpty {
                Text(decision.detail).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if decision.kind == .accept_result {
                resultReceipt
            } else if let proposal = decision.proposal, !proposal.pretty.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("요청").font(.caption.weight(.semibold)).foregroundStyle(GhostStyle.secondary)
                    Text(proposal.pretty).font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.padding(14).background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 14))
            }
            actions
            if let issue {
                Text(issue).font(.caption).foregroundStyle(GhostStyle.warning)
            }
        }
        .padding(.vertical, 12)
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

    private var resultReceipt: some View {
        let work = model.snapshot.works.first { $0.id == decision.workId }
        let submitted = decision.proposal?.dictionary["result"]
        let summary = submitted?.dictionary["summary"]?.text ?? work?.result?.summary ?? ""
        let criteria = decision.proposal?.dictionary["criteria"]?.text ?? work?.acceptance.criteria ?? ""
        let files = submitted?.dictionary["artifacts"]?.items.map { $0["name"].text } ?? work?.result?.artifacts.map(\.name) ?? []
        return VStack(alignment: .leading, spacing: 14) {
            if !summary.isEmpty { Text(summary).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            ForEach(Array(files.enumerated()), id: \.offset) { _, name in
                Label(name, systemImage: "doc.text").font(.footnote).fixedSize(horizontal: false, vertical: true)
            }
            if !criteria.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("완료 기준").font(.caption.weight(.semibold)).foregroundStyle(GhostStyle.secondary)
                    Text(criteria).font(.footnote).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let proposal = decision.proposal, !proposal.pretty.isEmpty {
                DisclosureGroup("결과 상세") {
                    Text(proposal.pretty).font(.caption.monospaced()).textSelection(.enabled)
                }.font(.caption).foregroundStyle(GhostStyle.secondary)
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 14))
    }

    private var kindLabel: String {
        switch decision.kind {
        case .approve_effect: "실행 승인"
        case .question: "답변 대기"
        case .accept_result: "결과 확인"
        case .document_review: "문서 검토"
        case .reconcile_effect: "결과 미확정"
        }
    }

    @ViewBuilder
    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch decision.kind {
            case .approve_effect, .document_review, .reconcile_effect, .accept_result:
                HStack(spacing: 12) {
                    Button(approveLabel) { confirming = .approve }
                        .buttonStyle(GhostPrimaryButtonStyle())
                        .disabled(model.busy || !model.isOnline)
                        .accessibilityIdentifier("decision-approve-\(decision.id)")
                    Button(denyLabel, role: .destructive) { confirming = .deny }
                        .buttonStyle(.bordered)
                        .disabled(model.busy || !model.isOnline)
                        .accessibilityIdentifier("decision-deny-\(decision.id)")
                }
            case .question:
                if !decision.options.isEmpty {
                    ForEach(Array(decision.options.enumerated()), id: \.offset) { index, option in
                        Button { resolve(.answer, answer: option) } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text("\(index + 1)").font(.caption.monospaced().weight(.semibold))
                                    .frame(width: 24, height: 24).background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 7))
                                Text(option).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                            }.foregroundStyle(GhostStyle.ink).padding(12).frame(minHeight: 48)
                                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
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
                    .buttonStyle(GhostPrimaryButtonStyle())
                    .disabled(model.busy || !model.isOnline || customAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    // Same words as the web deck, and what the host does with each outcome.
    private var approveLabel: String {
        switch decision.kind {
        case .accept_result: "결과 확인"
        case .document_review: "저장 승인"
        case .reconcile_effect: "의도대로 처리됨"
        default: "승인"
        }
    }

    private var denyLabel: String {
        switch decision.kind {
        case .accept_result: "수정 요청"
        case .reconcile_effect: "처리되지 않음"
        default: "거부"
        }
    }

    private var confirmTitle: String {
        switch confirming {
        case .approve: approveLabel
        case .deny: denyLabel
        default: ""
        }
    }

    private var confirmLabel: String {
        confirming == .approve ? approveLabel : denyLabel
    }

    private var confirmMessage: String {
        switch (decision.kind, confirming) {
        case (.approve_effect, .approve?): "Ghost가 요청한 실행을 진행합니다."
        case (.document_review, .approve?): "제안된 문서를 저장합니다."
        case (.reconcile_effect, .approve?): "이 실행이 실제로 일어났다고 기록하고 맡긴 일을 이어갑니다."
        case (.reconcile_effect, .deny?): "이 실행이 일어나지 않았다고 기록하고 맡긴 일을 이어갑니다."
        case (.accept_result, .approve?): "결과를 받아들이고 맡긴 일을 끝냅니다."
        case (.accept_result, .deny?): "Ghost에게 결과를 고쳐 달라고 전달합니다."
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
