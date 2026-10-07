import SwiftUI
import WebKit
import GhostMobileCore

struct VoiceScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var controller: VoiceController
    init(model: GhostModel, profileID: String, conversationID: String) {
        self.controller = VoiceController(model: model, profileID: profileID, conversationID: conversationID)
    }
    var body: some View {
        NavigationStack {
            VoiceWebView(controller: controller)
                .navigationTitle("Ghost와 통화").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("닫기") { controller.close(); dismiss() } } }
                .safeAreaInset(edge: .bottom) { Text("앱을 벗어나면 통화를 마칩니다. 맡긴 작업은 계속됩니다.").font(.footnote).foregroundStyle(.secondary).padding(12) }
        }
        .onChange(of: phase) { if phase == .background { controller.close(); dismiss() } }
        .onDisappear { controller.close() }
    }
}

private struct VoiceWebView: UIViewRepresentable {
    let controller: VoiceController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) { }
}

// WKWebView is used specifically for its audio/WebRTC permission delegate and
// an isolated request/reply bridge on iOS 17+. Credentials stay in URLSession.
@MainActor final class VoiceController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    let webView: WKWebView
    private let model: GhostModel
    private let api: GhostAPI?
    private let origin: URL?
    private let profileID: String
    private let conversationID: String
    private let session: VoiceCallSession?
    private var closed = false

    init(model: GhostModel, profileID: String, conversationID: String) {
        self.model = model; self.api = model.api; self.origin = model.connection?.origin
        if let api = model.api {
            session = VoiceCallSession(profileID: profileID, conversationID: conversationID, action: { try await api.action($0) })
        } else { session = nil }
        self.profileID = profileID; self.conversationID = conversationID
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        self.webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "ghostVoice")
        webView.navigationDelegate = self; webView.uiDelegate = self
        if let url = origin?.appending(path: "mobile/voice") { webView.load(URLRequest(url: url)) }
    }
    private func matches(_ securityOrigin: WKSecurityOrigin) -> Bool {
        securityOrigin.protocol == "https" && securityOrigin.host == origin?.host() && (securityOrigin.port == 0 ? 443 : securityOrigin.port) == (origin?.port ?? 443)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        navigationAction.request.url == origin?.appending(path: "mobile/voice") ? .allow : .cancel
    }
    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        !closed && frame.isMainFrame && matches(origin) && type == .microphone ? .prompt : .deny
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { model.error = "음성 화면 연결이 끊겼습니다."; close() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { model.error = "통화 화면을 열지 못했습니다. 서버 연결을 확인해 주세요." }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard !closed, message.frameInfo.isMainFrame, matches(message.frameInfo.securityOrigin),
              message.frameInfo.request.url == origin?.appending(path: "mobile/voice"),
              let fields = message.body as? [String: Any], JSONSerialization.isValidJSONObject(fields),
              let data = try? JSONSerialization.data(withJSONObject: fields), data.count <= 131072,
              let value = try? JSONDecoder().decode(JSON.self, from: data) else { return (nil, "허용되지 않은 음성 요청입니다.") }
        do {
            let result = try await handle(value)
            let encoded = try JSONEncoder().encode(result)
            return (try JSONSerialization.jsonObject(with: encoded, options: .fragmentsAllowed), nil)
        } catch { return (nil, error.localizedDescription) }
    }
    private func handle(_ value: JSON) async throws -> JSON {
        guard let api, let session else { throw MobileError.response("서버 연결이 없습니다.") }
        switch value["operation"].text {
        case "start":
            return try await session.start(sdp: value["sdp"])
        case "end":
            try await session.end()
            await model.refresh()
            return .object(["ended": .bool(true)])
        case "snapshot":
            let snapshot = try await api.get("mobile/v1/snapshot")
            return snapshot["profiles"].items.first { $0["id"].text == profileID }?["conversations"].items.first { $0["id"].text == conversationID } ?? .null
        case "event", "work":
            if value["operation"].text == "event" {
                return try await session.event(id: value["event_id"], role: value["role"], transcript: value["transcript"])
            }
            return try await session.work(id: value["function_id"], prompt: value["prompt"])
        default: throw MobileError.response("지원하지 않는 음성 요청입니다.")
        }
    }
    private func hangup() async {
        do { try await session?.close() }
        catch { model.error = "마이크는 닫혔지만 서버의 통화 종료는 확인하지 못했습니다. 진행 중 화면에서 확인해 주세요." }
        await model.refresh()
    }
    func close() {
        guard !closed else { return }
        closed = true
        webView.evaluateJavaScript("window.ghostStop?.()", completionHandler: nil)
        webView.setMicrophoneCaptureState(.none, completionHandler: nil)
        webView.setAllMediaPlaybackSuspended(true, completionHandler: nil)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "ghostVoice", contentWorld: .page)
        webView.stopLoading()
        Task { await hangup() }
    }
}
