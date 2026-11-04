import Foundation

// Native voice media signaling. The phone owns one bound call at a time; a
// late offer response must still be ended, and a failed end keeps its
// original pc identifier for retry. Media state lives in the app engine;
// this actor only owns the server-side call lifetime.
public struct VoiceMediaAnswer: Sendable, Equatable {
    public let sdp: String
    public let pcID: String
    public init(sdp: String, pcID: String) {
        self.sdp = sdp
        self.pcID = pcID
    }
}

public struct VoiceICECandidate: Codable, Sendable, Equatable {
    public let candidate: String
    public let sdpMid: String
    public let sdpMlineIndex: Int
    public init(candidate: String, sdpMid: String, sdpMlineIndex: Int) {
        self.candidate = candidate
        self.sdpMid = sdpMid
        self.sdpMlineIndex = sdpMlineIndex
    }
}

public struct VoiceTurnCancelState: Sendable, Equatable {
    public let turnID: String
    public let state: String
    public let cancelRequested: Bool
    public let cancelCompleted: Bool
}

public struct MobileNotification: Sendable, Equatable, Identifiable {
    public let id: String
    public let conversationID: String
    public let workID: String
    public let goalRevision: Int
    public let eventKind: String
    public let state: String
    public init(id: String, conversationID: String, workID: String, goalRevision: Int, eventKind: String, state: String) {
        self.id = id
        self.conversationID = conversationID
        self.workID = workID
        self.goalRevision = goalRevision
        self.eventKind = eventKind
        self.state = state
    }
}

// Server-side observation of one start identity, as agreed with the gateway:
// `unknownStart` is definitive never-created evidence from the bounded start
// ledger; a lost or expired ledger entry surfaces as a thrown unknown
// outcome instead.
public enum VoiceStartObservation: Sendable, Equatable {
    case live(pcID: String)
    case ended(pcID: String)
    case unknownStart
}

public protocol VoiceMediaTransport: Sendable {
    func offer(sdp: String, startID: String) async throws -> VoiceMediaAnswer
    func ice(pcID: String, candidates: [VoiceICECandidate]) async throws -> Int
    func cancelTurn(pcID: String, turnID: String) async throws -> VoiceTurnCancelState
    func hangup(pcID: String) async throws
    func startState(startID: String) async throws -> VoiceStartObservation
}

extension GhostAPI: VoiceMediaTransport {
    public func offer(sdp: String, startID: String) async throws -> VoiceMediaAnswer { try await voiceOffer(sdp: sdp, startID: startID) }
    public func ice(pcID: String, candidates: [VoiceICECandidate]) async throws -> Int { try await voiceICE(pcID: pcID, candidates: candidates) }
    public func cancelTurn(pcID: String, turnID: String) async throws -> VoiceTurnCancelState { try await voiceCancelTurn(pcID: pcID, turnID: turnID) }
    public func hangup(pcID: String) async throws { try await voiceHangup(pcID: pcID) }
    public func startState(startID: String) async throws -> VoiceStartObservation { try await voiceStartState(startID: startID) }
}

// Definite transport outcomes never created a server session; anything else
// leaves the start outcome unknown until the server self-closes an
// unconnected session.
public enum VoiceMediaError: LocalizedError {
    case definite(String)
    // The agreed start observation reported that this start identity never
    // created a session; this is definitive evidence, not a failure.
    case startUnknown
    public var errorDescription: String? {
        if case .definite(let message) = self { return message }
        return nil
    }
    public static func isDefinite(_ error: any Error) -> Bool {
        if case .definite = error as? VoiceMediaError { return true }
        return false
    }
}

public actor VoiceMediaSession {
    // One start identity per session actor: every offer for this call carries
    // the same identifier, so the server can bind retries to one attempt.
    public let startID: String
    private var transport: VoiceMediaTransport
    private var pcID: String?
    private var startTask: Task<VoiceMediaAnswer, any Error>?
    private var endTask: Task<Void, any Error>?
    private var endRequested = false
    private var unresolvedStart = false
    private(set) var closed = false

    public init(transport: VoiceMediaTransport, startID: String) {
        self.transport = transport
        self.startID = startID
    }

    // Reconstructs the server-lifetime actor from a persisted fence after an
    // app relaunch. No audio or CallKit is restored: the actor exists only
    // so reconciliation can end or adopt the recorded session with its
    // exact identifier.
    public init(transport: VoiceMediaTransport, startID: String, restoringPCID: String?, unresolvedStart: Bool) {
        self.transport = transport
        self.startID = startID
        self.pcID = restoringPCID
        self.unresolvedStart = unresolvedStart
    }

    public var activePCID: String? { pcID }

    public func begin(offerSDP: String) async throws -> VoiceMediaAnswer {
        guard !closed, !unresolvedStart, startTask == nil, endTask == nil, pcID == nil else {
            throw MobileError.response("이전 통화의 종료를 먼저 확인해 주세요.")
        }
        endRequested = false
        unresolvedStart = true
        let task = Task { [transport] in
            let answer = try await transport.offer(sdp: offerSDP, startID: startID)
            self.accepted(answer: answer)
            return answer
        }
        startTask = task
        defer { startTask = nil }
        do {
            let answer = try await task.value
            if closed || endRequested {
                try await hangup()
                throw MobileError.response("통화 연결을 취소했습니다.")
            }
            return answer
        } catch {
            // A definite server rejection never created a session. An
            // ambiguous transport failure keeps the start outcome unknown:
            // ending reports it instead of assuming the call never existed.
            if VoiceMediaError.isDefinite(error) { unresolvedStart = false }
            throw error
        }
    }

    private func accepted(answer: VoiceMediaAnswer) {
        pcID = answer.pcID
        unresolvedStart = false
    }

    // Reconciliation for an ambiguous start: the agreed start observation
    // found the session this start created, so the actor takes over that
    // exact identifier and a later `end()` ends the same session. Adoption
    // is refused when this actor already owns different server state.
    public func adopt(pcID identifier: String) throws {
        guard !identifier.isEmpty, identifier.utf8.count <= 128,
              pcID == nil, unresolvedStart else {
            throw MobileError.response("이전 통화 상태를 이어받을 수 없습니다.")
        }
        pcID = identifier
        unresolvedStart = false
    }

    // After a reconnect the captured connection is stale; the retained actor
    // keeps its unresolved identity but retries through the new transport.
    // In-flight offers or hangups keep the transport they started with.
    public func adoptTransport(_ replacement: VoiceMediaTransport) {
        guard startTask == nil, endTask == nil else { return }
        transport = replacement
    }

    public func end() async throws {
        endRequested = true
        // Do not cancel the network request: it may have created a media session.
        if let startTask { _ = try? await startTask.value }
        guard !unresolvedStart else { throw MobileError.response("통화 시작 결과가 불명확합니다. 잠시 후 서버의 통화 상태를 확인해 주세요.") }
        try await hangup()
    }

    public func cancelTurn(turnID: String) async throws -> VoiceTurnCancelState {
        guard let pcID, !closed, !endRequested else { throw MobileError.response("활성 통화가 없습니다.") }
        return try await transport.cancelTurn(pcID: pcID, turnID: turnID)
    }

    private func hangup() async throws {
        if let endTask { try await endTask.value; return }
        guard let pcID else { return }
        let identifier = pcID
        let task = Task { [transport] in
            try await transport.hangup(pcID: identifier)
            self.completedHangup(identifier: identifier)
        }
        endTask = task
        defer { endTask = nil }
        do {
            try await task.value
        } catch {
            // Keep the original pc identifier so the retry ends the same session.
            throw error
        }
    }

    private func completedHangup(identifier: String) {
        if pcID == identifier { pcID = nil }
    }

    public func close() async throws {
        closed = true
        try await end()
    }
}

func validatedVoiceMediaAnswer(_ value: JSON) throws -> VoiceMediaAnswer {
    guard value["type"] == .string("answer"),
          case .string(let sdp) = value["sdp"], !sdp.isEmpty, sdp.utf8.count <= 65_536,
          case .string(let pcID) = value["pc_id"], !pcID.isEmpty, pcID.utf8.count <= 128 else {
        throw MobileError.response("서버의 음성 응답을 확인하지 못했습니다.")
    }
    return VoiceMediaAnswer(sdp: sdp, pcID: pcID)
}

func validatedTurnCancelState(_ value: JSON) throws -> VoiceTurnCancelState {
    guard case .string(let turnID) = value["turn_id"], !turnID.isEmpty,
          case .string(let state) = value["state"], !state.isEmpty,
          case .bool(let cancelRequested) = value["cancel_requested"],
          case .bool(let cancelCompleted) = value["cancel_completed"] else {
    throw MobileError.response("서버의 취소 응답을 확인하지 못했습니다.")
    }
    return VoiceTurnCancelState(turnID: turnID, state: state, cancelRequested: cancelRequested, cancelCompleted: cancelCompleted)
}

public func validatedNotificationInbox(_ value: JSON) throws -> [MobileNotification] {
    guard case .array(let items) = value["notifications"] else {
        throw MobileError.response("서버의 알림함 응답을 확인하지 못했습니다.")
    }
    return try items.map { item in
        let id = item["id"].text
        let conversationID = item["conversation_id"].text
        let workID = item["work_id"].text
        let eventKind = item["event_kind"].text
        let state = item["state"].text
        guard case .number(let revision) = item["goal_revision"], revision >= 1,
              revision.rounded(.towardZero) == revision,
              !id.isEmpty, id.utf8.count <= 400,
              !conversationID.isEmpty, UUID(uuidString: conversationID) != nil,
              !workID.isEmpty, workID.utf8.count <= 400,
              ["result", "acceptance", "briefing"].contains(eventKind),
              ["pending", "transport_accepted", "client_seen"].contains(state) else {
            throw MobileError.response("서버의 알림 기록을 확인하지 못했습니다.")
        }
        return MobileNotification(id: id, conversationID: conversationID, workID: workID,
            goalRevision: Int(revision), eventKind: eventKind, state: state)
    }
}
