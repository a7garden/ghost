import SwiftUI
import WebKit
import GhostMobileCore

// Owner decision surface: the durable questions a worker paused on, with the
// exact normalized action target visible before any decision, plus per-Ghost
// home/browser lifecycle. Every action rides the scoped gateway routes; the
// recorded action state and the wake result are always shown truthfully.

struct OwnerQuestionsSection: View {
    let model: GhostModel
    @State private var pendingDecision: DecisionDraft?
    @State private var decisionNotice: String?

    struct DecisionDraft: Identifiable {
        let id = UUID()
        let question: OwnerQuestion
        let approve: Bool
    }

    var body: some View {
        Section("결정 필요 · 소유자 승인") {
            if model.ownerQuestions.isEmpty {
                Text(model.ownerQuestionsError == nil
                    ? "승인 대기 중인 질문이 없습니다."
                    : "승인 대기 질문을 확인하지 못했습니다.")
                    .foregroundStyle(GhostStyle.secondary)
            }
            ForEach(model.ownerQuestions) { question in
                questionCard(question)
            }
            if let error = model.ownerQuestionsError {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }
            if let notice = decisionNotice {
                Text(notice).font(.callout).foregroundStyle(GhostStyle.text).textSelection(.enabled)
            }
        }
    }

    private func questionCard(_ question: OwnerQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(executionTitle(question), systemImage: "hand.raised.fill")
                .font(.callout.weight(.semibold))
            LabeledContent("동작", value: question.operation)
            if !question.url.isEmpty {
                Text(question.url)
                    .font(.caption.monospaced())
                    .foregroundStyle(GhostStyle.secondary)
                    .textSelection(.enabled)
            }
            LabeledContent("대상 ref", value: question.targetRef)
                .font(.caption.monospaced())
                .textSelection(.enabled)
            LabeledContent("역할", value: question.targetRole.isEmpty ? "미보고" : question.targetRole)
            if !question.targetName.isEmpty {
                LabeledContent("이름", value: question.targetName).textSelection(.enabled)
            }
            if let value = question.value, !value.isEmpty {
                LabeledContent("입력값", value: value).textSelection(.enabled)
            }
            LabeledContent("snapshot", value: String(question.snapshotID))
            LabeledContent("권한 세대", value: String(question.authorityEpoch))
            LabeledContent("profile", value: question.profileScope.isEmpty ? "미보고" : question.profileScope)
            LabeledContent("실행", value: question.executionID)
                .font(.caption.monospaced())
                .textSelection(.enabled)
            Text("아무 효과도 실행되지 않았습니다. 이 화면의 사실과 같은 대상·같은 권한 세대에만 결정이 기록됩니다. 대상이 바뀌었다면 이 결정은 무효가 되고 새 질문이 필요합니다.")
                .font(.caption)
                .foregroundStyle(GhostStyle.secondary)
            HStack {
                Button("승인") { pendingDecision = DecisionDraft(question: question, approve: true) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.isOnline || model.isDecidingQuestion)
                Button("거절", role: .destructive) { pendingDecision = DecisionDraft(question: question, approve: false) }
                    .buttonStyle(.bordered)
                    .disabled(!model.isOnline || model.isDecidingQuestion)
                if model.isDecidingQuestion { ProgressView() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
        .confirmationDialog(
            pendingDecision?.approve == true
                ? "이 정확한 동작을 승인할까요?"
                : "이 동작을 거절할까요?",
            isPresented: Binding(get: { pendingDecision != nil }, set: { if !$0 { pendingDecision = nil } }),
            titleVisibility: .visible,
            presenting: pendingDecision
        ) { draft in
            Button(draft.approve ? "승인하고 실행 재개" : "거절", role: draft.approve ? nil : .destructive) {
                let draft = pendingDecision
                pendingDecision = nil
                if let draft { Task { await decide(draft) } }
            }
            Button("취소", role: .cancel) { pendingDecision = nil }
        } message: { draft in
            Text("\(draft.question.url)\nref \(draft.question.targetRef) · \(draft.question.targetRole) · \(draft.question.targetName)\nsnapshot \(draft.question.snapshotID) · 권한 세대 \(draft.question.authorityEpoch)")
        }
    }

    private func decide(_ draft: DecisionDraft) async {
        decisionNotice = nil
        guard let reply = await model.decideOwnerQuestion(draft.question, approve: draft.approve) else { return }
        let action = reply["action"]
        let wake = reply["wake"]
        var lines: [String] = []
        if let state = action["state"].text.nilIfEmpty {
            lines.append("확인된 동작 상태: \(state)")
        }
        if let approver = action["approved_by"].text.nilIfEmpty { lines.append("기록된 승인자: \(approver)") }
        if wake["status"].text == "success", wake["data"]["resumed"].flag {
            lines.append(wake["data"]["executed"].flag
                ? "정확한 동작을 실행했고 같은 실행의 세션을 재개했습니다."
                : "동작을 실행하지 않고 같은 실행의 세션을 재개했습니다.")
        } else if wake["data"]["fresh_consent_required"].flag {
            lines.append("대상이 바뀌어 새 동의가 필요합니다. 기존 동의를 새 대상에 적용하지 않았습니다.")
        } else {
            lines.append("실행 재개가 확인되지 않았습니다.")
        }
        if let summary = wake["summary"].text.nilIfEmpty { lines.append(summary) }
        if let code = wake["error_code"].text.nilIfEmpty { lines.append("코드: \(code)") }
        decisionNotice = lines.joined(separator: "\n")
    }

    private func executionTitle(_ question: OwnerQuestion) -> String {
        let ghost = model.lifetimeConversationTargets.first { $0.ghostID == question.ghostID }
        let role = ghost?.roles.joined(separator: " · ") ?? "Ghost"
        return "\(role) · \(question.operation) 승인 대기"
    }
}

struct ComputerControlSection: View {
    let model: GhostModel
    @State private var pendingOperation: LifecycleDraft?
    @State private var expanded = false

    struct LifecycleDraft: Identifiable {
        let id = UUID()
        let ghostID: String
        let operation: String
        var title: String { operationLabel(operation) }
    }

    private var scopedGhosts: [String] { model.lifetimeGhostIDs.sorted() }

    var body: some View {
        Section("이 Ghost의 컴퓨터 · 브라우저 수명") {
            if !model.lifetimeCapabilities.contains("lifetime.write") {
                Text("이 연결에는 컴퓨터 제어 권한이 없습니다. 상태는 표시하지 않습니다.")
                    .foregroundStyle(GhostStyle.secondary)
            } else {
                DisclosureGroup(isExpanded: $expanded) {
                    ForEach(scopedGhosts, id: \.self) { ghostID in
                        lifecycleControls(ghostID)
                    }
                } label: {
                    Label("전용 컴퓨터·브라우저 중지/재생성", systemImage: "desktopcomputer")
                }
                if let result = model.lifecycleResult {
                    lifecycleResultCard(result)
                }
                Text("중지는 실행 중인 OMP·브라우저 세션을 멈춥니다. 재개는 다음 실행 admission에서 일어나며, 결과가 불명확한 중지는 레지스트리가 먼저 대사를 요구합니다.")
                    .font(.caption)
                    .foregroundStyle(GhostStyle.secondary)
            }
        }
    }

    private func lifecycleControls(_ ghostID: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ghostLabel(ghostID)).font(.callout.weight(.medium))
            HStack {
                Button("idle 중지") { pendingOperation = LifecycleDraft(ghostID: ghostID, operation: "idle_stop") }
                    .buttonStyle(.bordered)
                Button("재생성") { pendingOperation = LifecycleDraft(ghostID: ghostID, operation: "recreate") }
                    .buttonStyle(.bordered)
                Button("중지", role: .destructive) { pendingOperation = LifecycleDraft(ghostID: ghostID, operation: "stop") }
                    .buttonStyle(.bordered)
            }
            .disabled(!model.isOnline)
            Text(ghostID)
                .font(.caption2.monospaced())
                .foregroundStyle(GhostStyle.secondary)
                .textSelection(.enabled)
        }
        .confirmationDialog(
            "이 Ghost의 컴퓨터를 \(pendingOperation?.title ?? "제어")할까요?",
            isPresented: Binding(get: { pendingOperation != nil }, set: { if !$0 { pendingOperation = nil } }),
            titleVisibility: .visible,
            presenting: pendingOperation
        ) { draft in
            Button("\(draft.title) 실행") {
                let draft = pendingOperation
                pendingOperation = nil
                if let draft { Task { await model.runComputerLifecycle(ghostID: draft.ghostID, operation: draft.operation) } }
            }
            Button("취소", role: .cancel) { pendingOperation = nil }
        } message: { draft in
            Text("\(ghostLabel(draft.ghostID)) · \(draft.title). 효과 접수는 레지스트리 receipt로 확인됩니다.")
        }
    }

    private func lifecycleResultCard(_ result: GhostModel.LifecycleOutcome) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("요청", value: "\(ghostLabel(result.ghostID)) · \(operationLabel(result.operation))")
            LabeledContent("상태", value: result.status)
            Text(result.summary)
                .font(.footnote)
                .foregroundStyle(result.status == "success" ? GhostStyle.secondary : .red)
                .textSelection(.enabled)
            if let code = result.detail["error_code"].text.nilIfEmpty {
                Text("오류 코드: \(code)").font(.caption.monospaced()).foregroundStyle(.red)
            }
            let nextActions = result.detail["next_actions"].items.map(\.text)
            ForEach(nextActions, id: \.self) { action in
                Text("다음: \(action)").font(.caption).foregroundStyle(GhostStyle.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
    }

    private func ghostLabel(_ ghostID: String) -> String {
        let target = model.lifetimeConversationTargets.first { $0.ghostID == ghostID }
        return target.map { $0.label } ?? "Ghost"
    }
}

private func operationLabel(_ operation: String) -> String {
    switch operation {
    case "idle_stop": return "idle 중지"
    case "recreate": return "재생성"
    case "stop": return "중지"
    default: return operation
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// One opened artifact document. Bytes are digest-verified before this view
// exists; rendering is read-only: Markdown becomes plain attributed text
// without links or image fetches, HTML is shown in a JavaScript-disabled web
// view that cancels every navigation and subresource load, images decode from
// the verified bytes. Nothing writes back to the document.
struct ArtifactDocumentView: View {
    let content: WorkArtifactContent

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(documentKindLabel).font(.headline)
                    Text("SHA-256 \(content.digest.prefix(12))… · \(content.data.count) bytes · \(privacyLabel(content.privacy))")
                        .font(.caption.monospaced())
                        .foregroundStyle(GhostStyle.secondary)
                    Text("Goal \(content.goalID.prefix(8))… revision \(content.goalRevision) · execution \(content.executionID.prefix(12))…")
                        .font(.caption2.monospaced())
                        .foregroundStyle(GhostStyle.secondary)
                }
                documentBody
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(GhostStyle.surface)
        .navigationTitle("결과 문서")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var documentBody: some View {
        switch DocumentKind(bytes: content.data) {
        case .markdown(let text):
            markdownText(text)
        case .html(let text):
            SafeHTMLView(html: text)
                .frame(minHeight: 320)
                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
        case .image:
            if let image = UIImage(data: content.data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
            } else {
                Text("이미지 데이터를 해독하지 못했습니다. 원본 bytes는 검증된 상태로 보존되어 있습니다.")
                    .foregroundStyle(.red)
            }
        case .text(let text):
            Text(text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
        }
    }

    private func markdownText(_ text: String) -> some View {
        Group {
            if let attributed = inertMarkdown(text) {
                Text(attributed).textSelection(.enabled)
            } else {
                Text(text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            }
        }
    }

    private func inertMarkdown(_ text: String) -> AttributedString? {
        guard var attributed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else { return nil }
        attributed.link = nil
        return attributed
    }

    private var documentKindLabel: String {
        switch DocumentKind(bytes: content.data) {
        case .markdown: return "문서 · Markdown"
        case .html: return "문서 · HTML (스크립트·외부 자원 차단)"
        case .image: return "이미지"
        case .text: return "텍스트"
        }
    }

    private func privacyLabel(_ value: String) -> String {
        switch value {
        case "public": return "공개"
        case "private": return "비공개"
        case "local_only": return "이 기기에서만"
        default: return value.isEmpty ? "미보고" : value
        }
    }
}

private enum DocumentKind {
    case markdown(String)
    case html(String)
    case image
    case text(String)

    init(bytes: Data) {
        if Self.imagePrefix(bytes) {
            self = .image
        } else if let text = String(data: bytes, encoding: .utf8) {
            var trimmed = text
            while let first = trimmed.unicodeScalars.first, first == "\u{feff}" || first == "\u{200b}" || first.properties.isWhitespace {
                trimmed.removeFirst()
            }
            let lowered = trimmed.lowercased()
            if lowered.hasPrefix("<!doctype html") || lowered.hasPrefix("<html") {
                self = .html(text)
            } else {
                self = .markdown(text)
            }
        } else {
            self = .text("(이진 내용 · 텍스트로 표시할 수 없습니다)")
        }
    }

    private static func imagePrefix(_ bytes: Data) -> Bool {
        bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) ||
            bytes.starts(with: [0xFF, 0xD8, 0xFF]) ||
            bytes.starts(with: [0x47, 0x49, 0x46, 0x38])
    }
}

// The verified document inherits a restrictive CSP before any artifact bytes
// are parsed. Inline styling and embedded data images are local; scripts,
// frames, forms and external resources are forbidden. Only an explicitly
// armed load of the local document may navigate; the store is nonpersistent.
private struct SafeHTMLView: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.load(html: html, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.reloadIfChanged(html: html, in: webView)
    }

    func makeCoordinator() -> Coordinator { Coordinator(html: html) }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private var currentHTML: String
        private var documentLoadArmed = false

        init(html: String) { self.currentHTML = html }

        func load(html: String, in webView: WKWebView) {
            documentLoadArmed = true
            let policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'; object-src 'none'; media-src 'none'"
            webView.loadHTMLString("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"></head><body>\(html)</body></html>", baseURL: nil)
        }

        func reloadIfChanged(html: String, in webView: WKWebView) {
            guard html != currentHTML else { return }
            currentHTML = html
            load(html: html, in: webView)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            let allowed = documentLoadArmed && navigationAction.navigationType == .other &&
                navigationAction.targetFrame?.isMainFrame == true &&
                navigationAction.request.url?.absoluteString == "about:blank"
            if allowed { documentLoadArmed = false }
            decisionHandler(allowed ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
            let allowed = navigationResponse.isForMainFrame &&
                navigationResponse.canShowMIMEType &&
                navigationResponse.response.url?.absoluteString == "about:blank"
            decisionHandler(allowed ? .allow : .cancel)
        }
    }
}
