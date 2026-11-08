import SwiftUI
import WebKit
import CoreTransferable
import UniformTypeIdentifiers
import GhostMobileCore

struct ArtifactScreen: View {
    let model: GhostModel
    let artifact: ArtifactRef
    @Environment(\.dismiss) private var dismiss
    @State private var reading = true
    @State private var wrapLines = true

    private var loaded: LoadedArtifact? { model.loadedArtifacts[artifact.digest] }
    private var text: String? {
        guard let data = loaded?.data, !artifact.mediaType.hasPrefix("image/") else { return nil }
        let type = UTType(mimeType: artifact.mediaType)
        guard isMarkdown || isHTML || artifact.mediaType.hasPrefix("text/") || type?.conforms(to: .text) == true else { return nil }
        return String(data: data, encoding: .utf8)
    }
    private var isMarkdown: Bool {
        artifact.mediaType == "text/markdown" || artifact.name.lowercased().hasSuffix(".md")
            || artifact.name.lowercased().hasSuffix(".markdown")
    }
    private var isHTML: Bool {
        artifact.mediaType == "text/html" || artifact.name.lowercased().hasSuffix(".html")
            || artifact.name.lowercased().hasSuffix(".htm")
    }
    private var lineCount: Int? { text.map { $0.isEmpty ? 0 : $0.reduce(1) { $1 == "\n" ? $0 + 1 : $0 } } }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let text, !isHTML {
                    HStack(spacing: 16) {
                        if isMarkdown {
                            Picker("표시 방식", selection: $reading) {
                                Text("읽기").tag(true)
                                Text("원문").tag(false)
                            }.pickerStyle(.segmented)
                        } else { Spacer(minLength: 0) }
                        if !isMarkdown || !reading {
                            Toggle("줄 접기", isOn: $wrapLines).toggleStyle(.button)
                                .accessibilityLabel("긴 줄 접기")
                        }
                    }
                    .font(.footnote).padding(.horizontal, 16).padding(.vertical, 8)
                    .opacity(text.isEmpty ? 0 : 1)
                }
                documentBody.frame(maxWidth: .infinity, maxHeight: .infinity)
                if loaded?.data != nil {
                    HStack(spacing: 8) {
                        Text(artifact.mediaType)
                        Text("·")
                        Text(artifact.sizeLabel)
                        if let lineCount { Text("·"); Text("\(lineCount)줄") }
                        Spacer(minLength: 0)
                    }
                    .font(.caption).foregroundStyle(GhostStyle.secondary)
                    .padding(16).overlay(alignment: .top) { Rectangle().fill(GhostStyle.border).frame(height: 1) }
                }
            }
            .background(GhostStyle.surface)
            .navigationTitle(artifact.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 8) {
                        Image(systemName: artifact.symbol).foregroundStyle(GhostStyle.secondary)
                        Text(artifact.name).font(.headline).lineLimit(1).truncationMode(.middle)
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if let text {
                        Button { UIPasteboard.general.string = text } label: { Image(systemName: "doc.on.doc") }
                            .frame(minWidth: 44, minHeight: 44).accessibilityLabel("파일 내용 복사")
                    }
                    if let data = loaded?.data {
                        ShareLink(item: VerifiedArtifactFile(data: data, name: artifact.name),
                            preview: SharePreview(artifact.name)) { Image(systemName: "square.and.arrow.up") }
                            .frame(minWidth: 44, minHeight: 44).accessibilityLabel("저장")
                    }
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .frame(minWidth: 44, minHeight: 44).accessibilityLabel("파일 닫기")
                }
            }
            .task(id: artifact.digest) { await model.loadArtifact(digest: artifact.digest) }
        }
    }

    @ViewBuilder private var documentBody: some View {
        if let loaded, let data = loaded.data {
            if data.isEmpty {
                ContentUnavailableView("빈 파일", systemImage: artifact.symbol)
            } else if isHTML, let text {
                SafeHTMLView(html: text)
            } else if artifact.mediaType.hasPrefix("image/"), let image = UIImage(data: data) {
                ScrollView {
                    Image(uiImage: image).resizable().scaledToFit().padding(16)
                        .accessibilityLabel(artifact.name)
                }
            } else if let text {
                if isMarkdown && reading {
                    ScrollView {
                        // Untrusted documents render inertly: no URL, mark or remote image acquires an action.
                        GhostProse(text: text, state: model.snapshot, inert: true)
                            .foregroundStyle(GhostStyle.text)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                    }
                } else {
                    ArtifactSource(text: text, wrapLines: wrapLines)
                }
            } else {
                ContentUnavailableView {
                    Label(artifact.name, systemImage: artifact.symbol)
                } description: {
                    Text("이 파일은 저장해서 열어 주세요.")
                }
            }
        } else if loaded?.error != nil {
            ContentUnavailableView("파일을 읽지 못했습니다.", systemImage: "doc.questionmark")
                .accessibilityAddTraits(.updatesFrequently)
        } else {
            ProgressView("파일을 읽는 중…")
        }
    }
}

private struct ArtifactSource: View {
    let text: String
    let wrapLines: Bool
    private var lines: [Substring]? {
        let count = text.reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
        return count <= 10_000 ? text.split(separator: "\n", omittingEmptySubsequences: false) : nil
    }

    var body: some View {
        Group {
            if wrapLines {
                ScrollView { source.frame(maxWidth: .infinity, alignment: .leading) }
            } else {
                ScrollView([.horizontal, .vertical]) { source.fixedSize(horizontal: true, vertical: false) }
            }
        }
    }

    @ViewBuilder private var source: some View {
        if let lines {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(lines.indices, id: \.self) { index in
                    HStack(alignment: .top, spacing: 16) {
                        Text("\(index + 1)").foregroundStyle(GhostStyle.secondary)
                            .frame(width: CGFloat(String(lines.count).count) * 12, alignment: .trailing)
                            .accessibilityHidden(true)
                        Text(lines[index].isEmpty ? " " : String(lines[index]))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
            }
            .font(.system(.footnote, design: .monospaced)).padding(16)
        } else {
            Text(text).font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled).padding(16)
        }
    }
}

private struct VerifiedArtifactFile: Transferable, Sendable {
    let data: Data
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data) { file in
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let basename = (file.name as NSString).lastPathComponent
            let url = directory.appendingPathComponent(basename.isEmpty || basename == "." || basename == ".." ? "파일" : basename)
            try file.data.write(to: url, options: .atomic)
            return SentTransferredFile(url)
        }
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
