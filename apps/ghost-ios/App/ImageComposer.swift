import SwiftUI
import GhostMobileCore

struct ImageComposer: View {
    let api: GhostAPI
    let ghostID: String
    let conversationID: String
    let storageNamespace: String
    @Environment(\.dismiss) private var dismiss
    @State private var provider = "codex"
    @State private var prompt = ""
    @State private var requestID = ""
    @State private var result: JSON = .null
    @State private var busy = false
    @State private var error: String?
    private var storageKey: String { "ghost-image:\(storageNamespace):\(ghostID)/\(conversationID)" }
    private var image: UIImage? {
        guard let bytes = Data(base64Encoded: result["image"]["base64"].text) else { return nil }
        return UIImage(data: bytes)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("제공자", selection: $provider) {
                        Text("Codex · 같은 OAuth").tag("codex")
                        Text("MiniMax · 등록한 API 키").tag("minimax")
                        Text("로컬 · Dyno 평가").tag("local")
                    }
                    Text("선택한 제공자에 이미지 설명만 보냅니다. 대화 이력은 포함하지 않습니다.").font(.footnote)
                    TextField("만들고 싶은 이미지를 설명하세요", text: $prompt, axis: .vertical).lineLimit(4...8)
                        .onChange(of: prompt) { _, value in if value.count > 1500 { prompt = String(value.prefix(1500)) } }
                    Button("이미지 생성") { Task { await generate() } }.disabled(busy || !requestID.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.disabled(busy || !requestID.isEmpty)
                if let image { Section { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("생성된 이미지") } }
                else if !requestID.isEmpty {
                    Section {
                        if result["state"].text == "running" { ProgressView("이미지를 만들고 있습니다") }
                        else { Text(result["state"].text == "blocked" ? "로컬 자원 보호 조건으로 차단됐습니다." : "생성 여부를 확인해야 합니다. 새로 생성하지 않고 같은 요청의 결과를 조회합니다.") }
                        Button("결과 확인") { Task { await read() } }
                    }
                }
                if ["completed", "blocked"].contains(result["state"].text) { Section { Button("새 이미지") { UserDefaults.standard.removeObject(forKey: storageKey); requestID = ""; result = .null } } }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("이미지 만들기")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { dismiss() } } }
            .task { requestID = UserDefaults.standard.string(forKey: storageKey) ?? ""; if !requestID.isEmpty { await read() } }
            .task(id: result["state"].text) {
                while result["state"].text == "running" && !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    await read()
                }
            }
        }
    }
    private func body(_ operation: String) -> [String: JSON] { ["operation": .string(operation), "id": .string(requestID), "ghost_id": .string(ghostID), "conversation_id": .string(conversationID)] }
    @MainActor private func generate() async {
        guard requestID.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let configuration = try await api.inferenceSettings()
            guard provider != "minimax" || configuration["settings"]["credentials"]["minimax"].flag else { throw MobileError.response("MiniMax API 키를 먼저 등록해 주세요.") }
            requestID = UUID().uuidString.lowercased()
            UserDefaults.standard.set(requestID, forKey: storageKey)
            var value = body("generate"); value["provider"] = .string(provider); value["prompt"] = .string(prompt); value["allow_external"] = .bool(true)
            result = try await api.imageOperation(.object(value)); error = nil
        }
        catch { self.error = error.localizedDescription }
    }
    @MainActor private func read() async {
        do { result = try await api.imageOperation(.object(body("read"))); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
