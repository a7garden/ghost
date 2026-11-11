import SwiftUI
import UIKit
import WebKit
import GhostMobileCore

/// The paired Host's web UI, full screen. The page draws every Ghost surface and
/// handles safe areas and the keyboard itself; the shell only covers the moments
/// the page cannot: first load and an unreachable Host.
struct WebShellView: View {
    let model: GhostModel
    let connection: Connection
    @Environment(\.scenePhase) private var scenePhase
    @State private var controller: ShellController
    @State private var confirmingForget = false

    init(model: GhostModel, connection: Connection) {
        self.model = model
        self.connection = connection
        _controller = State(initialValue: ShellController(model: model, connection: connection))
    }

    var body: some View {
        ZStack {
            // The page draws under the bars, but the keyboard shrinks the web view itself, so the
            // page's own layout keeps the composer directly above the keyboard without offsets.
            ShellWebView(webView: controller.webView)
                .ignoresSafeArea(.container)
                .opacity(controller.phase == .ready ? 1 : 0)
                .accessibilityHidden(controller.phase != .ready)
            switch controller.phase {
            case .loading: loading
            case .unreachable: unreachable
            case .ready: EmptyView()
            }
        }
        .background(GhostStyle.canvas.ignoresSafeArea())
        .preferredColorScheme(controller.scheme)
        .animation(.easeOut(duration: 0.2), value: controller.phase)
        .onChange(of: model.outbox) { controller.flush() }
        .task { await renewPush() }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            if controller.phase == .unreachable { controller.retry() } else { model.enqueue(.resume) }
            Task { await renewPush() }
        }
        .confirmationDialog("이 iPhone에서 연결을 지울까요?", isPresented: $confirmingForget, titleVisibility: .visible) {
            Button("연결 지우기", role: .destructive) { model.disconnect() }
        } message: {
            Text("PC의 기기 목록에서도 이 iPhone을 해제해 주세요.")
        }
    }

    /// After pairing iOS asks once for alerts; an allowed device renews its APNs token on
    /// open and on return (e.g. from Settings) and retries a failed upload.
    private func renewPush() async {
        #if DEBUG
        if MobileUIFixture.enabled { return }
        #endif
        _ = await AppDelegate.coordinator.requestAndRegister()
        await model.retryPendingPushToken()
    }

    private var loading: some View {
        ZStack {
            GhostMark(size: 56)
            TravellingArc().frame(width: 84, height: 84)
        }
        .accessibilityElement()
        .accessibilityLabel("PC Ghost를 여는 중")
        .accessibilityIdentifier("shell-loading")
    }

    private var unreachable: some View {
        VStack(spacing: 24) {
            Spacer()
            GhostMark(size: 56)
            VStack(spacing: 8) {
                Text("PC Ghost에 연결할 수 없습니다").font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                Text(connection.origin.host() ?? connection.origin.absoluteString)
                    .font(.footnote.monospaced()).foregroundStyle(GhostStyle.secondary)
            }
            Spacer()
            VStack(spacing: 12) {
                Button { controller.retry() } label: { Text("다시 시도").frame(maxWidth: .infinity) }
                    .buttonStyle(GhostPrimaryButtonStyle())
                    .accessibilityIdentifier("shell-retry")
                Button("연결 지우기") { confirmingForget = true }
                    .font(.callout).foregroundStyle(GhostStyle.secondary)
                    .frame(minHeight: 44)
            }
            .frame(maxWidth: 440)
        }
        .padding(.horizontal, 24).padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(GhostStyle.canvas)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("shell-unreachable")
    }
}

private struct ShellWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ webView: WKWebView, context: Context) {}
}

/// Owns the web view for one paired connection and answers the page's bridge requests.
@MainActor @Observable final class ShellController: NSObject {
    enum Phase: Equatable { case loading, ready, unreachable }

    private(set) var phase: Phase = .loading
    /// The page's resolved theme; nil follows the system until the page reports it.
    private(set) var scheme: ColorScheme?

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private let model: GhostModel
    @ObservationIgnored private let connection: Connection
    @ObservationIgnored private var pageReady = false
    @ObservationIgnored private var downloads: [ObjectIdentifier: URL] = [:]

    init(model: GhostModel, connection: Connection) {
        self.model = model
        self.connection = connection
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = "GhostShell/\(version)"
        configuration.userContentController.addUserScript(WKUserScript(
            source: Shell.bootstrapScript(connection: connection, version: version),
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.addScriptMessageHandler(WeakBridge(self), contentWorld: .page, name: Shell.handlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = GhostStyle.canvasColor
        webView.scrollView.backgroundColor = GhostStyle.canvasColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        load()
    }

    func retry() {
        phase = .loading
        load()
    }

    /// Delivers queued native events once the page has said it is ready.
    func flush() {
        guard pageReady else { return }
        for event in model.drainOutbox() {
            webView.evaluateJavaScript(Shell.dispatchScript(event))
        }
    }

    private func load() {
        pageReady = false
        var url = routeURL(connection.origin, path: "/")
        #if DEBUG
        if let route = MobileUIFixture.shellRoute, let routed = URL(string: "#" + route, relativeTo: url)?.absoluteURL { url = routed }
        #endif
        webView.load(URLRequest(url: url))
    }

    private func fail(_ error: Error) {
        let error = error as NSError
        // A cancelled load or a navigation that turned into a download is not a failure.
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain" && error.code == 102 { return }
        pageReady = false
        phase = .unreachable
    }

    /// Bridge messages are honored only from the paired origin's main frame.
    fileprivate func handle(_ message: WKScriptMessage) async -> (Any?, String?) {
        let origin = message.frameInfo.securityOrigin
        let reported = Shell.origin(scheme: origin.protocol, host: origin.host, port: origin.port == 0 ? nil : origin.port)
        guard message.frameInfo.isMainFrame, reported == Shell.origin(connection.origin) else { return (nil, "untrusted frame") }
        guard let request = ShellRequest(body: message.body) else { return (nil, "unsupported request") }
        switch request {
        case .ready:
            pageReady = true
            return (["events": model.drainOutbox().map(\.payload)], nil)
        case .notificationsStatus:
            return (["status": await AppDelegate.coordinator.status()], nil)
        case .notificationsRequest:
            return (["status": await AppDelegate.coordinator.requestAndRegister()], nil)
        case .notificationsSettings:
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { await UIApplication.shared.open(url) }
            return ([:], nil)
        case .appInstall(let requested):
            guard let url = Shell.installURL(requested.absoluteString, origin: connection.origin) else {
                return (nil, "unsupported request")
            }
            return (["opened": await UIApplication.shared.open(url)], nil)
        case .theme(let dark):
            scheme = dark ? .dark : .light
            return ([:], nil)
        case .haptic(let style):
            switch style {
            case .selection: UISelectionFeedbackGenerator().selectionChanged()
            case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
            case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
            }
            return ([:], nil)
        case .disconnected, .revoked:
            model.disconnect()
            return ([:], nil)
        }
    }

    private func openOutside(_ url: URL) {
        guard ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") else { return }
        UIApplication.shared.open(url)
    }

    private func present(_ controller: UIViewController) {
        guard var top = webView.window?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        controller.popoverPresentationController?.sourceView = webView
        controller.popoverPresentationController?.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.maxY - 1, width: 1, height: 1)
        top.present(controller, animated: true)
    }
}

extension ShellController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.shouldPerformDownload { return .download }
        guard let url = action.request.url else { return .cancel }
        if Shell.staysInside(url, origin: connection.origin) { return .allow }
        // Only a top-level link leaves the app; a subframe never navigates the owner away.
        if action.targetFrame?.isMainFrame ?? true { openOutside(url) }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if !response.canShowMIMEType { return .download }
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 500 {
            pageReady = false
            phase = .unreachable
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// A new document replaces the page only once it commits; a navigation that turns
    /// into a download leaves the current page (and its readiness) in place.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        pageReady = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        phase = .ready
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        retry()
    }
}

extension ShellController: WKUIDelegate {
    /// `target=_blank` and `window.open`: Host pages stay in the shell, the rest opens outside.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if Shell.staysInside(url, origin: connection.origin) { webView.load(action.request) } else { openOutside(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "확인", style: .default) { _ in continuation.resume() })
            present(alert)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "확인", style: .default) { _ in continuation.resume(returning: true) })
            present(alert)
        }
    }
}

extension ShellController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let folder = FileManager.default.temporaryDirectory.appending(path: "downloads/\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = suggestedFilename.isEmpty ? "file" : suggestedFilename
        let destination = folder.appending(path: name)
        downloads[ObjectIdentifier(download)] = destination
        return destination
    }

    /// A saved file goes straight to the share sheet: Files, AirDrop or another app.
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        present(UIActivityViewController(activityItems: [file], applicationActivities: nil))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }
}

/// Breaks the retain cycle between the content controller and the shell controller.
private final class WeakBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: ShellController?
    init(_ target: ShellController) { self.target = target }

    @MainActor func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let target else { return (nil, "shell closed") }
        return await target.handle(message)
    }
}
