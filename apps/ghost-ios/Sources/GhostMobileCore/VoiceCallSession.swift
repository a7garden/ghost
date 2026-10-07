import Foundation

// Signalling lifetime is independent of the screen and the microphone. A late
// start response must still be ended, and a failed end keeps its original ID.
public actor VoiceCallSession {
    private let profileID: String
    private let conversationID: String
    private let action: @Sendable (JSON) async throws -> JSON
    private var callID: String?
    private var startTask: Task<JSON, any Error>?
    private var endTask: Task<Void, any Error>?
    private var endRequested = false
    private var unresolvedStart = false
    private(set) var closed = false

    public init(profileID: String, conversationID: String, action: @escaping @Sendable (JSON) async throws -> JSON) {
        self.profileID = profileID; self.conversationID = conversationID; self.action = action
    }
    private func command(_ type: String, _ fields: [String: JSON]) -> JSON {
        .object(["type": .string("workspace"), "action": .object(fields.merging(["type": .string(type)], uniquingKeysWith: { _, new in new }))])
    }
    public func start(sdp: JSON) async throws -> JSON {
        guard !closed, !unresolvedStart, startTask == nil, endTask == nil, callID == nil else {
            throw MobileError.response("이전 통화의 종료를 먼저 확인해 주세요.")
        }
        endRequested = false
        unresolvedStart = true
        let task = Task {
            let result = try await action(command("voice_start", ["profile_id": .string(profileID), "conversation_id": .string(conversationID), "sdp": sdp]))
            guard !result["call_id"].text.isEmpty else { throw MobileError.response("서버의 통화 응답을 확인하지 못했습니다.") }
            callID = result["call_id"].text
            unresolvedStart = false
            return result
        }
        startTask = task
        defer { startTask = nil }
        let result = try await task.value
        if closed || endRequested {
            try await hangup()
            throw MobileError.response("통화 연결을 취소했습니다.")
        }
        return result
    }
    public func end() async throws {
        endRequested = true
        // Do not cancel the network request: it may have created a remote call.
        if let startTask { _ = try await startTask.value }
        guard !unresolvedStart else { throw MobileError.response("통화 시작 결과가 불명확합니다. 진행 중 화면에서 서버의 통화를 확인해 주세요.") }
        try await hangup()
    }
    private func hangup() async throws {
        if let endTask { try await endTask.value; return }
        guard let callID else { return }
        let task = Task {
            _ = try await action(command("voice_end", ["call_id": .string(callID)]))
            self.callID = nil
        }
        endTask = task
        defer { endTask = nil }
        try await task.value
    }
    public func close() async throws { closed = true; try await end() }
    public func event(id: JSON, role: JSON, transcript: JSON) async throws -> JSON {
        guard let callID, !closed, !endRequested else { throw MobileError.response("활성 통화가 없습니다.") }
        return try await action(command("voice_event", ["call_id": .string(callID), "event_id": id, "role": role, "transcript": transcript]))
    }
    public func work(id: JSON, prompt: JSON) async throws -> JSON {
        guard let callID, !closed, !endRequested else { throw MobileError.response("활성 통화가 없습니다.") }
        return try await action(command("voice_work", ["call_id": .string(callID), "function_id": id, "prompt": prompt]))
    }
}
