import SwiftUI
import GhostMobileCore

struct DecisionCard: View {
    let model: GhostModel
    let decision: Decision
    /// Opens the decision's Work; nil where the card already sits inside that Work.
    var openWork: ((String) -> Void)? = nil
    @State private var customAnswer = ""
    @State private var confirming: DecisionOutcome?
    @State private var issue: String?
    @State private var resolving = false
    @State private var showingRequest = false
    @State private var artifact: ArtifactRef?

    private var heading: String { model.snapshot.heading(of: decision) }
    private var labels: (approve: String, deny: String) { decision.kind.actionLabels }
    private var disabled: Bool { resolving || model.busy || !model.isOnline || !decision.isPending }
    private var command: String? {
        guard let value = decision.proposal?.dictionary["command"], case .string(let command) = value else { return nil }
        return command
    }
    private var proseActions: TranscriptActions {
        TranscriptActions(openWork: { openWork?($0) }, openFile: { artifact = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            metadata
            Text(heading).font(.headline).fixedSize(horizontal: false, vertical: true)
            if !decision.detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               decision.detail.trimmingCharacters(in: .whitespacesAndNewlines) != heading.trimmingCharacters(in: .whitespacesAndNewlines),
               command == nil {
                GhostProse(text: decision.detail, state: model.snapshot, actions: proseActions, font: .callout)
            }
            switch decision.kind {
            case .accept_result: receipt
            case .approve_effect, .reconcile_effect: requestPreview
            case .document_review: documentPreview
            case .question: EmptyView()
            }
            actions
            if resolving {
                HStack(spacing: 8) { ProgressView(); Text("전달 중").font(.caption) }
                    .foregroundStyle(GhostStyle.secondary).accessibilityElement(children: .combine)
            }
            if let issue { Text(issue).font(.caption).foregroundStyle(GhostStyle.warning).accessibilityAddTraits(.isStaticText) }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(GhostStyle.ink)
        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay { RoundedRectangle(cornerRadius: 20).stroke(GhostStyle.border, lineWidth: 1) }
        .overlay(alignment: .leading) { Capsule().fill(GhostStyle.amber).frame(width: 3).padding(.vertical, 20).accessibilityHidden(true) }
        .confirmationDialog(confirmTitle, isPresented: Binding(
            get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            Button(confirmTitle, role: confirming == .deny ? .destructive : nil) {
                let outcome = confirming
                confirming = nil
                if let outcome { resolve(outcome) }
            }
            Button("취소", role: .cancel) { confirming = nil }
        } message: { Text(confirmMessage) }
        .sheet(item: $artifact) { ArtifactScreen(model: model, artifact: $0) }
    }

    private var metadata: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { identity; Spacer(minLength: 4); workLink }
            VStack(alignment: .leading, spacing: 4) { identity; workLink }
        }
    }

    private var identity: some View {
        HStack(spacing: 8) {
            GhostPortrait(ghost: model.ghost(decision.ghostId), size: 20)
            Text(model.ghostName(decision.ghostId)).fontWeight(.medium)
            Text(decision.kind.label).foregroundStyle(GhostStyle.amberInk)
            Text(model.relativeTime(decision.createdAt)).foregroundStyle(GhostStyle.secondary)
        }.font(.caption)
    }

    @ViewBuilder private var workLink: some View {
        if let id = decision.workId, let openWork {
            Button { openWork(id) } label: { Label("맡긴 일", systemImage: "arrow.up.right").labelStyle(TrailingIconLabel()) }
                .font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary).frame(minHeight: 44)
        }
    }

    private var receipt: some View {
        let work = model.snapshot.works.first { $0.id == decision.workId }
        let result = decision.proposal?.dictionary["result"]
        let summary = result?.dictionary["summary"]?.text ?? work?.result?.summary ?? ""
        let criteria = decision.proposal?.dictionary["criteria"]?.text ?? work?.acceptance.criteria ?? ""
        let files = receiptFiles(result: result, work: work)
        return VStack(alignment: .leading, spacing: 12) {
            if !summary.isEmpty { GhostProse(text: summary, state: model.snapshot, actions: proseActions, font: .callout) }
            ForEach(files) { file in FileChip(artifact: file) { artifact = file }.frame(minHeight: 44, alignment: .leading) }
            if !criteria.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("완료 기준").font(.caption.weight(.semibold)).foregroundStyle(GhostStyle.secondary)
                    Text(criteria).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
    }

    private func receiptFiles(result: JSON?, work: Work?) -> [ArtifactRef] {
        if let value = result?.dictionary["artifacts"],
           let data = try? JSONEncoder().encode(value),
           let files = try? JSONDecoder().decode([ArtifactRef].self, from: data) { return files }
        return work?.result?.artifacts ?? []
    }

    @ViewBuilder private var requestPreview: some View {
        if let command {
            let proposal = decision.proposal
            VStack(alignment: .leading, spacing: 12) {
                if let reason = proposal?["reason"].text, !reason.isEmpty {
                    Text(reason).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                let cwd = proposal?["cwd"].text ?? ""
                Text("\(cwd.isEmpty ? "" : cwd + " ")$ \(command)")
                    .font(.footnote.monospaced()).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12).background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
                if let risk = proposal?["risk"].text, !risk.isEmpty {
                    Label(risk, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(GhostStyle.amberInk).fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if let proposal = decision.proposal, !proposal.pretty.isEmpty {
            let pretty = proposal.pretty
            VStack(alignment: .leading, spacing: 8) {
                if pretty.count > 480 {
                    Button { showingRequest.toggle() } label: {
                        HStack(spacing: 8) {
                            Text("요청 내용 보기")
                            Image(systemName: showingRequest ? "chevron.up" : "chevron.down")
                        }.font(.caption).frame(minHeight: 44)
                    }.accessibilityValue(showingRequest ? "펼쳐짐" : "접힘")
                }
                if pretty.count <= 480 || showingRequest {
                    Text(pretty).font(.footnote.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var documentPreview: some View {
        let proposal = decision.proposal?.dictionary ?? [:]
        let pageId = [proposal["pageId"]?.text, proposal["page_id"]?.text].compactMap { $0 }.first { !$0.isEmpty } ?? ""
        let title = proposal["title"]?.text ?? ""
        let body = proposal["body"]?.text ?? ""
        return VStack(alignment: .leading, spacing: 12) {
            Text(pageId.isEmpty ? "제안된 문서 · 새 페이지" : "제안된 문서 · 기존 페이지 수정")
                .font(.caption).foregroundStyle(GhostStyle.secondary)
            if !title.isEmpty { Text(title).font(.headline).fixedSize(horizontal: false, vertical: true) }
            GhostProse(text: body.isEmpty ? "(본문 없음)" : body, state: model.snapshot, actions: proseActions, font: .callout)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private var actions: some View {
        if decision.kind == .question {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(decision.options.enumerated()), id: \.offset) { index, option in
                    Button { resolve(.answer, answer: option) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text("\(index + 1)").font(.caption.monospaced()).frame(minWidth: 24, minHeight: 24)
                                .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 8))
                            Text(option).font(.callout).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                        }.padding(12).frame(minHeight: 44).foregroundStyle(GhostStyle.ink)
                            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain).disabled(disabled)
                }
                HStack(alignment: .bottom, spacing: 4) {
                    TextField(decision.options.isEmpty ? "답변을 적어 주세요" : "직접 답하기", text: $customAnswer, axis: .vertical)
                        .lineLimit(1...4).accessibilityLabel("답변").disabled(disabled)
                        .padding(.leading, 14).padding(.vertical, 12)
                    Button { resolve(.answer, answer: customAnswer) } label: { Image(systemName: "arrow.up") }
                        .buttonStyle(GhostSendButtonStyle()).accessibilityLabel("답변 보내기")
                        .disabled(disabled || customAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(GhostStyle.border, lineWidth: 1) }
            }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { denyButton; approveButton }
                VStack(alignment: .leading, spacing: 8) { approveButton; denyButton }
            }
        }
    }

    private var approveButton: some View {
        Button(labels.approve) { confirming = .approve }.buttonStyle(GhostPrimaryButtonStyle())
            .disabled(disabled).accessibilityIdentifier("decision-approve-\(decision.id)")
    }
    private var denyButton: some View {
        Button(labels.deny) { confirming = .deny }.buttonStyle(GhostSecondaryButtonStyle())
            .disabled(disabled).accessibilityIdentifier("decision-deny-\(decision.id)")
    }
    private var confirmTitle: String { confirming == .approve ? labels.approve : labels.deny }
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

    private func resolve(_ outcome: DecisionOutcome, answer: String? = nil) {
        guard !resolving, model.isOnline else { return }
        guard model.snapshot.decisions.first(where: { $0.id == decision.id })?.isPending == true else {
            issue = "이미 처리된 결정입니다."
            return
        }
        let answer = answer?.trimmingCharacters(in: .whitespacesAndNewlines)
        if outcome == .answer && (answer ?? "").isEmpty { issue = "답변을 적어 주세요."; return }
        issue = nil
        resolving = true
        Task {
            defer { resolving = false }
            do {
                _ = try await model.send(.decisionResolve(decisionId: decision.id, outcome: outcome, answer: answer))
                if outcome == .answer { customAnswer = "" }
            } catch { issue = model.error ?? "결정을 전달하지 못했습니다. 다시 시도해 주세요." }
        }
    }
}
