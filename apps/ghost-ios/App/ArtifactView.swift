import SwiftUI
import WebKit
import GhostMobileCore

// One opened artifact document. Bytes arrive digest-verified from the
// transport; rendering is read-only: Markdown becomes plain attributed text
// without links or image fetches, HTML is shown in a JavaScript-disabled web
// view that cancels every navigation and subresource load, images decode from
// the verified bytes. Nothing writes back to the document.
struct ArtifactScreen: View {
    let model: GhostModel
    let digest: String
    @Environment(\.dismiss) private var dismiss

    private var loaded: LoadedArtifact? { model.loadedArtifacts[digest] }

    var body: some View {
        NavigationStack {
            Group {
                if let loaded, let data = loaded.data {
                    ArtifactDocumentView(digest: digest, data: data)
                } else if let loaded, let error = loaded.error {
                    ContentUnavailableView("결과 자료를 열지 못했습니다", systemImage: "doc.questionmark", description: Text(error))
                } else {
                    ProgressView("불러오는 중")
                }
            }
            .background(GhostStyle.surface)
            .navigationTitle("결과 자료").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("닫기") { dismiss() } }
            }
            .task { await model.loadArtifact(digest: digest) }
        }
    }
}

struct ArtifactDocumentView: View {
    let digest: String
    let data: Data

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(documentKindLabel).font(.headline)
                    Text("SHA-256 \(digest.prefix(12))… · \(data.count) bytes")
                        .font(.caption.monospaced())
                        .foregroundStyle(GhostStyle.secondary)
                }
                documentBody
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var documentBody: some View {
        switch DocumentKind(bytes: data) {
        case .markdown(let text):
            markdownText(text)
        case .html(let text):
            SafeHTMLView(html: text)
                .frame(minHeight: 320)
                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
        case .image:
            if let image = UIImage(data: data) {
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
        switch DocumentKind(bytes: data) {
        case .markdown: return "문서 · Markdown"
        case .html: return "문서 · HTML (스크립트·외부 자원 차단)"
        case .image: return "이미지"
        case .text: return "텍스트"
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
            load(html: html, in: webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // Only the armed loadHTMLString of the verified bytes is
            // allowed; every other navigation is cancelled.
            decisionHandler(documentLoadArmed ? .allow : .cancel)
            documentLoadArmed = false
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            decisionHandler(.allow)
        }
    }
}
