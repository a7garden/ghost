import SwiftUI
import GhostMobileCore

private let inferenceEfforts = ["off": "사용 안 함", "low": "빠르게", "medium": "균형", "high": "깊게", "xhigh": "더 깊게", "max": "최대"]

func inferenceSelection(_ configuration: JSON, ghostID: String, conversationID: String) -> JSON {
    let saved = configuration["settings"]["conversations"]["\(ghostID)/\(conversationID)"]
    return saved == .null ? configuration["settings"]["default"] : saved
}
func inferenceLabel(_ selection: JSON) -> String {
    let model = selection["model"].text
    guard !model.isEmpty else { return "모델 선택" }
    if selection["effort"].text == "off" { return model }
    return "\(model) · \(inferenceEfforts[selection["effort"].text] ?? selection["effort"].text)"
}

struct InferencePicker: View {
    let api: GhostAPI
    let ghostID: String
    let conversationID: String
    var connected = true
    let saved: (JSON) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var configuration: JSON = .null
    @State private var provider = ""
    @State private var modelID = ""
    @State private var effort = ""
    @State private var allowExternal = false
    @State private var busy = false
    @State private var error: String?
    private var currentProvider: JSON { configuration["providers"].items.first { $0["id"].text == provider } ?? .null }
    private var granted: Bool { configuration["settings"]["external_grants"]["\(ghostID)/\(conversationID)"].items.contains(.string(provider)) }
    private var registered: Bool { currentProvider["auth"].text != "api_key" || configuration["settings"]["credentials"][provider].flag }
    private var canApply: Bool {
        connected && !busy && error == nil && configuration != .null && registered
            && currentProvider["models"].items.contains(.string(modelID))
            && currentProvider["efforts"].items.contains(.string(effort))
            && (provider == "local" || granted || allowExternal)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("제공자", selection: $provider) {
                        ForEach(Array(configuration["providers"].items.filter { !$0["models"].items.isEmpty }.enumerated()), id: \.offset) { _, item in
                            Text(item["name"].text).tag(item["id"].text)
                        }
                    }.accessibilityIdentifier("inference-provider")
                    Picker("모델", selection: $modelID) {
                        ForEach(Array(currentProvider["models"].items.enumerated()), id: \.offset) { _, item in Text(item.text).tag(item.text) }
                    }.accessibilityIdentifier("inference-model")
                    Picker("추론 수준", selection: $effort) {
                        ForEach(Array(currentProvider["efforts"].items.enumerated()), id: \.offset) { _, item in Text(inferenceEfforts[item.text] ?? item.text).tag(item.text) }
                    }.accessibilityIdentifier("inference-effort")
                } footer: { Text("현재 응답이 끝난 뒤 전환할 수 있습니다. 추론 수준이 높을수록 응답에 시간이 더 걸릴 수 있습니다.") }
                if !provider.isEmpty && provider != "local" {
                    Section {
                        if granted { Label("이 대화의 외부 처리 허용됨", systemImage: "checkmark.shield") }
                        else { Toggle("기존 기록과 새 메시지 전송 허용", isOn: $allowExternal) }
                    } footer: { Text("이 대화의 기록을 \(currentProvider["name"].text)에 보냅니다. 개인 기억·문서 저장소의 접근 권한은 추가되지 않습니다.") }
                }
                if !registered { Section { Text("이 제공자의 API 키를 Mac의 Ghost 모델 설정에서 먼저 등록해 주세요.") } }
                if provider == "codex" { Section { Text("이 Mac의 공식 Codex 로그인을 사용합니다. 이미지 생성도 같은 OAuth로 연결됩니다.") } }
                if let error { Section { Text(error).foregroundStyle(.red); Button("설정 다시 확인") { Task { await load() } } } }
            }
            .disabled(busy || !connected)
            .navigationTitle("모델과 추론")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(busy ? "저장 중…" : "적용") { Task { await apply() } }.disabled(!canApply) }
            }
            .task { await load() }
            .onChange(of: connected) { _, current in
                allowExternal = false
                if current { Task { await load() } }
            }
            .onChange(of: provider) { _, next in
                guard let value = configuration["providers"].items.first(where: { $0["id"].text == next }) else { return }
                if !value["models"].items.contains(.string(modelID)) { modelID = value["default_model"].text }
                if !value["efforts"].items.contains(.string(effort)) { effort = value["default_effort"].text }
                allowExternal = false
            }
        }
    }
    @MainActor private func load() async {
        allowExternal = false
        guard connected else { return }
        busy = true
        defer { busy = false }
        do {
            let value = try await api.inferenceSettings()
            configuration = value
            let selection = inferenceSelection(value, ghostID: ghostID, conversationID: conversationID)
            provider = selection["provider"].text; modelID = selection["model"].text; effort = selection["effort"].text
            saved(value); error = nil
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func apply() async {
        guard canApply else { return }
        busy = true
        defer { busy = false }
        do {
            let value = try await api.selectInference(ghostID: ghostID, conversationID: conversationID, version: configuration["settings"]["version"], selection: .object(["provider": .string(provider), "model": .string(modelID), "effort": .string(effort)]), allowExternal: allowExternal)
            saved(value); dismiss()
        } catch { allowExternal = false; self.error = error.localizedDescription }
    }
}
