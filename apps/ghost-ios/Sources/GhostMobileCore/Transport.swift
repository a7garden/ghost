import Foundation
import CryptoKit

public enum JSON: Codable, Sendable, Equatable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSON { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    public var text: String { if case .string(let v) = self { return v }; return "" }
    public var items: [JSON] { if case .array(let v) = self { return v }; return [] }
    public var flag: Bool { self == .bool(true) }
    public var dictionary: [String: JSON] { if case .object(let v) = self { return v }; return [:] }
}

public enum MobileError: LocalizedError {
    case invalidServer, invalidToken, response(String)
    public var errorDescription: String? {
        switch self {
        case .invalidServer: "경로가 없는 HTTPS 서버 주소를 입력해 주세요."
        case .invalidToken: "이 기기에 발급한 64자리 연결 키를 입력해 주세요."
        case .response(let message): message
        }
    }
}
// The single canonical HTTPS origin validator shared by saved connections and
// pairing targets: exact scheme/host/port form, no credentials, path, query,
// or fragment — an origin is a security principal, never a free-form URL.
// Host is lowercased, the default 443 port is dropped, and the path is empty.
public func canonicalHTTPSOrigin(_ server: String) throws -> URL {
    guard var u = URLComponents(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
          u.scheme?.lowercased() == "https", let host = u.host, !host.isEmpty,
          u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
          u.path.isEmpty || u.path == "/",
          u.port == nil || (1...65535).contains(u.port!) else { throw MobileError.invalidServer }
    u.scheme = "https"; u.host = host.lowercased(); u.path = ""
    if u.port == 443 { u.port = nil }
    guard let url = u.url else { throw MobileError.invalidServer }
    return url
}

public struct Connection: Codable, Sendable, Equatable {
    public let origin: URL
    public let token: String
    public init(server: String, token: String) throws {
        let url = try canonicalHTTPSOrigin(server)
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanToken.count == 64, cleanToken.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw MobileError.invalidToken }
        self.origin = url; self.token = cleanToken
    }
    public func url(_ path: String) -> URL { origin.appending(path: path) }
}

public struct Envelope: Codable, Sendable, Equatable {
    public let request_id: String
    public let command: JSON
    public init(command: JSON) { self.init(requestID: UUID().uuidString.lowercased(), command: command) }
    fileprivate init(requestID: String, command: JSON) { self.request_id = requestID; self.command = command }
}

public struct LifetimeIdentity: Sendable, Equatable {
    public let actor_ref: String
    public let authority_epoch: UInt64
    public init(authorityEpoch: UInt64) throws {
        guard authorityEpoch > 0, authorityEpoch <= 9_007_199_254_740_991 else { throw MobileError.response("Lifetime authority epoch must be a positive safe integer.") }
        self.actor_ref = "owner"
        self.authority_epoch = authorityEpoch
    }
}

public struct LifetimeJournalNamespace: Sendable, Equatable {
    public let workspaceID: String
    public let deviceID: String
    public let authorityEpoch: UInt64

    public init(workspaceID: String, deviceID: String, authorityEpoch: UInt64) throws {
        guard let workspace = UUID(uuidString: workspaceID),
              let device = UUID(uuidString: deviceID),
              authorityEpoch > 0,
              authorityEpoch <= 9_007_199_254_740_991 else {
            throw MobileError.response("Lifetime journal requires a validated workspace, device, and authority epoch.")
        }
        self.workspaceID = workspace.uuidString.lowercased()
        self.deviceID = device.uuidString.lowercased()
        self.authorityEpoch = authorityEpoch
    }
    public var fileName: String { "lifetime-\(workspaceID)-\(deviceID)-\(authorityEpoch).json" }

    public func file(in directory: URL) -> URL {
        directory.appending(path: fileName)
    }
}

public struct LifetimeBindingPair: Sendable, Equatable, Identifiable {
    public let ghostID: String
    public let conversationID: String
    public let runtimeKind: String
    public var id: String { "\(ghostID):\(conversationID)" }
}

public func lifetimeBindingPairs(snapshot: JSON, ghostIDs: Set<String>, conversationIDs: Set<String>) -> [LifetimeBindingPair] {
    var pairs: [String: LifetimeBindingPair] = [:]
    for binding in snapshot["bindings"].items {
        let ghostID = binding["ghost_id"].text
        let conversationID = binding["conversation_id"].text
        guard !ghostID.isEmpty, !conversationID.isEmpty,
              ghostIDs.contains(ghostID), conversationIDs.contains(conversationID) else { continue }
        let pair = LifetimeBindingPair(ghostID: ghostID, conversationID: conversationID, runtimeKind: binding["runtime_kind"].text)
        pairs[pair.id] = pair
    }
    return pairs.values.sorted { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }
}

public enum LifetimeReconciliationStatus: String, Sendable, Equatable {
    case confirmedSuccess = "confirmed_success"
    case confirmedNoEffect = "confirmed_no_effect"
    case notFound = "not_found"
    case unresolved
}

public struct LifetimeReconciliation: Sendable, Equatable {
    public let status: LifetimeReconciliationStatus
    public let commandID: String
    public let authorityEpoch: UInt64
}

public struct LifetimeRecoveryItem: Sendable, Equatable, Identifiable {
    public let id: String
    public let workspaceID: String?
    public let deviceID: String?
    public let authorityEpoch: UInt64?
    public let commandID: String?
    public let issue: String?
    fileprivate let journalFileName: String
    fileprivate let originalEnvelope: Envelope?
    public var canReconcile: Bool { originalEnvelope != nil && commandID != nil && authorityEpoch != nil && issue == nil }
}

private let hexDigits = Array("0123456789abcdef")
private func quoteJSON(_ value: String) -> String {
    var output = "\""
    for scalar in value.unicodeScalars {
        switch scalar.value {
        case 0x22: output += "\\\""
        case 0x5c: output += "\\\\"
        case 0x08: output += "\\b"
        case 0x09: output += "\\t"
        case 0x0a: output += "\\n"
        case 0x0c: output += "\\f"
        case 0x0d: output += "\\r"
        case 0...0x1f:
            output += "\\u00"
            output.append(hexDigits[Int(scalar.value >> 4)])
            output.append(hexDigits[Int(scalar.value & 0x0f)])
        default: output.unicodeScalars.append(scalar)
        }
    }
    output += "\""
    return output
}

private func canonicalJSON(_ value: JSON) throws -> String {
    switch value {
    case .object(let object):
        let keys = object.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
        var output = "{"
        for (index, key) in keys.enumerated() {
            guard let item = object[key] else { throw MobileError.response("Lifetime payload object changed while encoding.") }
            if index > 0 { output.append(",") }
            output += quoteJSON(key) + ":" + (try canonicalJSON(item))
        }
        output.append("}")
        return output
    case .array(let values):
        var output = "["
        for (index, item) in values.enumerated() {
            if index > 0 { output.append(",") }
            output += (try canonicalJSON(item))
        }
        output.append("]")
        return output
    case .string(let string): return quoteJSON(string)
    case .number(let number):
        guard number.isFinite, number.rounded(.towardZero) == number, abs(number) <= 9_007_199_254_740_991 else {
            throw MobileError.response("Lifetime payload numbers must be safe integers.")
        }
        return String(Int64(number))
    case .bool(let value): return value ? "true" : "false"
    case .null: return "null"
    }
}

private func canonicalDigest(_ value: JSON) throws -> String {
    let bytes = Data(try canonicalJSON(value).utf8)
    let digest = SHA256.hash(data: bytes)
    var output = String()
    output.reserveCapacity(64)
    for byte in digest {
        output.append(hexDigits[Int(byte >> 4)])
        output.append(hexDigits[Int(byte & 0x0f)])
    }
    return output
}

private func validConversationTurnBody(_ body: JSON, expectedRevision: UInt64?) -> Bool {
    guard expectedRevision == nil,
          case .object(let fields) = body,
          Set(fields.keys) == Set(["method", "ghost_id", "conversation_id", "turn_id"]),
          case .string(let method) = body["method"],
          ["conversation.turn.inspect", "conversation.cancel_turn"].contains(method),
          case .string(let ghostID) = body["ghost_id"], !ghostID.isEmpty, ghostID.utf8.count <= 400,
          case .string(let conversationID) = body["conversation_id"], !conversationID.isEmpty, conversationID.utf8.count <= 400,
          case .string(let turnID) = body["turn_id"], !turnID.isEmpty, turnID.utf8.count <= 400 else { return false }
    return true
}
private func lifetimeConversationTurnBody(method: String, ghostID: String, conversationID: String, turnID: String) throws -> JSON {
    let body = JSON.object([
        "method": .string(method),
        "ghost_id": .string(ghostID),
        "conversation_id": .string(conversationID),
        "turn_id": .string(turnID),
    ])
    guard validConversationTurnBody(body, expectedRevision: nil) else {
        throw MobileError.response("A canonical conversation turn request needs its exact bounded target.")
    }
    return body
}


private func lifetimeCommand(body: JSON, identity: LifetimeIdentity, commandID: String, expectedRevision: UInt64?) throws -> JSON {
    let method = body["method"].text
    guard case .object = body,
          (lifetimeMutationMethods.contains(method) || lifetimeReadMethods.contains(method) || method == "command.inspect"),
          (!["conversation.turn.inspect", "conversation.cancel_turn"].contains(method) || validConversationTurnBody(body, expectedRevision: expectedRevision)),
          !commandID.isEmpty,
          expectedRevision.map({ $0 > 0 && $0 <= 9_007_199_254_740_991 }) ?? true else { throw MobileError.response("Invalid lifetime command.") }
    let envelope = JSON.object([
        "protocol_version": .string("ghost-lifetime/1"),
        "command_id": .string(commandID),
        "payload_digest": .string(try canonicalDigest(body)),
        "actor_ref": .string(identity.actor_ref),
        "authority_epoch": .number(Double(identity.authority_epoch)),
        "expected_revision": expectedRevision.map { .number(Double($0)) } ?? .null,
        "correlation_id": .string(commandID),
        "body": body,
    ])
    return .object(["type": .string("lifetime"), "envelope": envelope])
}

private struct LifetimeEnvelopeDetails {
    let commandID: String
    let actorRef: String
    let authorityEpoch: UInt64
    let payloadDigest: String
}

private func validLifetimeAttachment(_ value: JSON) -> Bool {
    guard case .object(let fields) = value, fields.count == 4 else { return false }
    let digest = value["digest"].text
    return digest.count == 64
        && digest.allSatisfy({ "0123456789abcdef".contains($0) })
        && !value["locator"].text.isEmpty
        && !value["producing_attempt"].text.isEmpty
        && ["public", "private", "local_only"].contains(value["privacy"].text)
}

private let lifetimeMutationMethods: Set<String> = ["goal.submit", "goal.update", "work.steer", "work.cancel", "work.delegate", "conversation.input", "conversation.cancel_turn"]
private let lifetimeReadMethods: Set<String> = ["goal.inspect", "work.inspect", "work.artifact", "conversation.inspect", "conversation.turn.inspect"]

public struct LifetimeConversationRun: Sendable, Equatable {
    public let turnID: String
    public let ghostID: String
    public let conversationID: String
    public let state: String
    public let cancelRequested: Bool
    public let cancelCommandID: String?
    public let submissionID: String?
    public let entryID: String?
    public let reasonCode: String?
    public let latestStatusCommandID: String?
    public let createdAtMS: UInt64
    public let updatedAtMS: UInt64
}

// One durable owner question with its exact normalized action target. The
// decision binds `actionID`; every other field is the fact surface the owner
// reads BEFORE deciding — URL, target ref/role/name, typed value, page
// snapshot, profile scope, and the authority generation the question was
// proposed under.
public struct OwnerQuestion: Sendable, Equatable, Identifiable {
    public let ghostID: String
    public let actionID: String
    public let computerID: String
    public let executionID: String
    public let argumentsDigest: String
    public let requestedEpoch: UInt64
    public let operation: String
    public let url: String
    public let snapshotID: UInt64
    public let targetRef: String
    public let targetRole: String
    public let targetName: String
    public let value: String?
    public let profileScope: String
    public let authorityEpoch: UInt64
    public var id: String { "\(ghostID):\(actionID)" }
}

// Digest-verified bytes of one current work artifact. `data` is returned only
// after the SHA-256 recomputation matches the requested digest, so the viewer
// renders exactly the bytes the Host ledger reported.
public struct WorkArtifactContent: Sendable, Equatable {
    public let workID: String
    public let goalID: String
    public let goalRevision: UInt64
    public let executionID: String
    public let digest: String
    public let privacy: String
    public let data: Data
}

private let lifetimeConversationRunFields: Set<String> = [
    "turn_id", "ghost_id", "conversation_id", "state", "cancel_requested", "cancel_command_id",
    "submission_id", "entry_id", "reason_code", "latest_status_command_id", "created_at_ms", "updated_at_ms",
]
private let lifetimeConversationRunStates: Set<String> = ["queued", "running", "answered", "failed", "cancelled", "effect_unknown"]
private let lifetimeConversationRunReasons: Set<String> = [
    "model_request_failed", "runtime_failure", "admission_blocked", "answer_unprojectable",
    "owner_cancelled", "effect_unconfirmed", "reply_delivery_unconfirmed", "authority_revoked",
]

private func boundedLifetimeRunID(_ value: JSON, nullable: Bool = false, maximumBytes: Int = 400) -> Bool {
    switch value {
    case .null: return nullable
    case .string(let identifier): return !identifier.isEmpty && identifier.utf8.count <= maximumBytes
    default: return false
    }
}

private func lifetimeRunTimestamp(_ value: JSON) -> UInt64? {
    guard case .number(let number) = value,
          number.isFinite,
          number >= 0,
          number.rounded(.towardZero) == number,
          number <= 9_007_199_254_740_991 else { return nil }
    return UInt64(number)
}

public func parseLifetimeConversationRuns(
    _ value: JSON,
    ghostID: String,
    conversationID: String,
    referencedTurnIDs: Set<String>
) throws -> [LifetimeConversationRun] {
    guard case .array(let values) = value else {
        throw MobileError.response("Host returned a missing or malformed conversation turn run list.")
    }
    var runs: [LifetimeConversationRun] = []
    var seenTurnIDs: Set<String> = []
    runs.reserveCapacity(values.count)
    for value in values {
        guard case .object(let fields) = value,
              Set(fields.keys) == lifetimeConversationRunFields,
              case .string(let turnID) = value["turn_id"], !turnID.isEmpty, turnID.utf8.count <= 400,
              value["ghost_id"] == .string(ghostID),
              value["conversation_id"] == .string(conversationID),
              case .string(let state) = value["state"],
              lifetimeConversationRunStates.contains(state),
              case .bool(let cancelRequested) = value["cancel_requested"],
              boundedLifetimeRunID(value["cancel_command_id"], nullable: true),
              boundedLifetimeRunID(value["submission_id"], nullable: true, maximumBytes: 512),
              boundedLifetimeRunID(value["entry_id"], nullable: true, maximumBytes: 512),
              boundedLifetimeRunID(value["latest_status_command_id"], nullable: true),
              let createdAtMS = lifetimeRunTimestamp(value["created_at_ms"]),
              let updatedAtMS = lifetimeRunTimestamp(value["updated_at_ms"]),
              updatedAtMS >= createdAtMS,
              referencedTurnIDs.contains(turnID),
              seenTurnIDs.insert(turnID).inserted else {
            throw MobileError.response("Host returned a malformed, foreign, duplicate, or unreferenced conversation turn run.")
        }
        let reasonCode: String?
        switch value["reason_code"] {
        case .null:
            reasonCode = nil
        case .string(let reason) where lifetimeConversationRunReasons.contains(reason):
            reasonCode = reason
        default:
            throw MobileError.response("Host returned an unrecognized conversation turn reason code.")
        }
        func optionalID(_ field: String) -> String? {
            if case .string(let identifier) = value[field] { return identifier }
            return nil
        }
        runs.append(LifetimeConversationRun(
            turnID: turnID,
            ghostID: ghostID,
            conversationID: conversationID,
            state: state,
            cancelRequested: cancelRequested,
            cancelCommandID: optionalID("cancel_command_id"),
            submissionID: optionalID("submission_id"),
            entryID: optionalID("entry_id"),
            reasonCode: reasonCode,
            latestStatusCommandID: optionalID("latest_status_command_id"),
            createdAtMS: createdAtMS,
            updatedAtMS: updatedAtMS
        ))
    }
    return runs
}

public func mergeLifetimeConversationRun(
    current: LifetimeConversationRun,
    incoming: LifetimeConversationRun
) throws -> LifetimeConversationRun {
    guard current.turnID == incoming.turnID,
          current.ghostID == incoming.ghostID,
          current.conversationID == incoming.conversationID else {
        throw MobileError.response("Cannot merge conversation turn runs from different targets.")
    }
    guard incoming.updatedAtMS > current.updatedAtMS else { return current }
    return incoming
}

private func safeLifetimeEpoch(_ value: JSON) -> UInt64? {
    guard case .number(let number) = value,
          number.isFinite,
          number >= 1,
          number.rounded(.towardZero) == number,
          number <= 9_007_199_254_740_991 else { return nil }
    return UInt64(number)
}

private extension Data {
    var sha256Hex: String {
        SHA256.hash(data: self).map { String(format: "%02x", $0) }.joined()
    }
}

private func lifetimeEnvelopeDetails(_ envelope: Envelope) throws -> LifetimeEnvelopeDetails {
    let value = envelope.command["envelope"]
    let body = value["body"]
    let method = body["method"].text
    let commandID = value["command_id"].text
    let actorRef = value["actor_ref"].text
    let expectedDigest = value["payload_digest"].text
    guard value["protocol_version"] == .string("ghost-lifetime/1"),
          !commandID.isEmpty,
          !value["correlation_id"].text.isEmpty,
          actorRef == "owner",
          let epoch = safeLifetimeEpoch(value["authority_epoch"]),
          case .object = body,
          ["goal.submit", "goal.update", "goal.inspect", "work.inspect", "work.steer", "work.cancel", "command.inspect", "conversation.inspect", "conversation.input", "conversation.turn.inspect", "conversation.cancel_turn"].contains(method),
          (!["conversation.turn.inspect", "conversation.cancel_turn"].contains(method)
            || (value["expected_revision"] == .null && validConversationTurnBody(body, expectedRevision: nil))),
          expectedDigest.count == 64,
          expectedDigest.allSatisfy({ "0123456789abcdef".contains($0) }),
          value["expected_revision"] == .null || safeLifetimeEpoch(value["expected_revision"]) != nil,
          expectedDigest == (try canonicalDigest(body)) else {
        throw MobileError.response("저장된 Lifetime envelope를 검증할 수 없습니다. 원래 요청을 보존했습니다.")
    }
    return LifetimeEnvelopeDetails(commandID: commandID, actorRef: actorRef, authorityEpoch: epoch, payloadDigest: expectedDigest)
}

// Persist before dispatch. Explicit retries reuse the same ID after disconnects
// or app restarts; no pending command is automatically replayed.
private struct PendingCommandRecord: Codable, Sendable {
    let request_id: String
    let command: JSON
    let lifetime_intent_key: String?
    init(_ envelope: Envelope, lifetimeIntentKey: String? = nil) {
        self.request_id = envelope.request_id
        self.command = envelope.command
        self.lifetime_intent_key = lifetimeIntentKey
    }
    var envelope: Envelope { Envelope(requestID: request_id, command: command) }
}

public actor PendingCommands {
    private let file: URL
    public init(file: URL) { self.file = file }
    private func read() throws -> [PendingCommandRecord] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try JSONDecoder().decode([PendingCommandRecord].self, from: Data(contentsOf: file))
    }
    private func write(_ values: [PendingCommandRecord]) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try JSONEncoder().encode(values).write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try JSONEncoder().encode(values).write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    public func prepare(_ command: JSON) throws -> Envelope {
        var values = try read()
        if let existing = values.first(where: { $0.lifetime_intent_key == nil && $0.command == command }) { return existing.envelope }
        let envelope = Envelope(command: command)
        values.append(PendingCommandRecord(envelope)); try write(values); return envelope
    }
    public func prepareLifetime(_ body: JSON, identity: LifetimeIdentity, expectedRevision: UInt64? = nil) throws -> Envelope {
        let intent = JSON.object([
            "actor_ref": .string(identity.actor_ref),
            "authority_epoch": .number(Double(identity.authority_epoch)),
            "body": body,
            "expected_revision": expectedRevision.map { .number(Double($0)) } ?? .null,
        ])
        let key = try canonicalDigest(intent)
        var values = try read()
        if let existing = values.first(where: { $0.lifetime_intent_key == key }) { return existing.envelope }
        let command = try lifetimeCommand(body: body, identity: identity, commandID: UUID().uuidString.lowercased(), expectedRevision: expectedRevision)
        let envelope = Envelope(command: command)
        values.append(PendingCommandRecord(envelope, lifetimeIntentKey: key)); try write(values); return envelope
    }
    public func finish(_ envelope: Envelope) throws { try write(read().filter { $0.request_id != envelope.request_id }) }
    public func all() throws -> [Envelope] { try read().map(\.envelope) }
    fileprivate func contains(_ envelope: Envelope) throws -> Bool { try read().contains { $0.envelope == envelope } }
}

private actor JournalRegistry {
    static let shared = JournalRegistry()
    private var journals: [URL: PendingCommands] = [:]
    func commands(at file: URL) -> PendingCommands {
        if let existing = journals[file] { return existing }
        let journal = PendingCommands(file: file)
        journals[file] = journal
        return journal
    }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public actor GhostAPI {
    public let connection: Connection
    public nonisolated let lifetimeDispatchEnabled: Bool
    public let lifetimeCapabilities: Set<String>
    private let pendingFile: URL
    private let lifetimeIdentity: LifetimeIdentity?
    private let lifetimeNamespace: LifetimeJournalNamespace?
    private let lifetimeConfigurationIssue: String?
    private let session: URLSession
    public init(
        connection: Connection,
        pendingFile: URL,
        lifetimeIdentity: LifetimeIdentity? = nil,
        lifetimeNamespace: LifetimeJournalNamespace? = nil,
        dispatchEnabled: Bool = true,
        lifetimeCapabilities: Set<String> = [],
        session: URLSession? = nil
    ) {
        self.connection = connection
        self.lifetimeIdentity = lifetimeIdentity
        self.lifetimeNamespace = lifetimeNamespace
        self.lifetimeDispatchEnabled = dispatchEnabled
        self.lifetimeCapabilities = lifetimeCapabilities
        let baseFile = pendingFile.standardizedFileURL
        if let lifetimeNamespace {
            self.pendingFile = lifetimeNamespace.file(in: baseFile.deletingLastPathComponent())
        } else {
            self.pendingFile = baseFile
        }
        if let lifetimeIdentity {
            if lifetimeNamespace == nil || lifetimeNamespace?.authorityEpoch != lifetimeIdentity.authority_epoch {
                self.lifetimeConfigurationIssue = "Lifetime storage namespace does not match the captured authority."
            } else {
                self.lifetimeConfigurationIssue = nil
            }
        } else {
            self.lifetimeConfigurationIssue = nil
        }
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 65
            config.timeoutIntervalForResource = 70
            self.session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        }
    }
    public func pendingCommands() async throws -> [Envelope] { try await JournalRegistry.shared.commands(at: pendingFile).all() }
    public func bootstrap() async throws -> JSON {
        try await request("mobile/v1/bootstrap", body: nil)
    }

    // MARK: Voice media signaling (conversation-bound streaming service)

    // Classification is role-aware: only definitive no-session admission
    // failures count as definite. Anything observed after dispatch — a lost
    // hangup above all — stays an unknown outcome that the client retries
    // with the same session identifier.
    private enum VoiceRequestRole {
        case admission
        case sessionControl
        case hangup
        case startObservation
    }

    private func voiceRequest(_ path: String, method: String, body: Data?, role: VoiceRequestRole) async throws -> JSON {
        var urlRequest = URLRequest(url: connection.url(path))
        urlRequest.httpMethod = method
        urlRequest.httpBody = body
        urlRequest.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        if body != nil { urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (bytes, response) = try await session.bytes(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw MobileError.response("서버 응답을 확인하지 못했습니다.") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 1_048_576 else { throw MobileError.response("서버 응답이 너무 큽니다.") }
            data.append(byte)
        }
        let value = (try? JSONDecoder().decode(JSON.self, from: data)) ?? .null
        if http.statusCode == 200 { return value }
        let code = value["error"].text
        switch role {
        case .admission:
            switch (http.statusCode, code) {
            case (400, "offer_invalid"), (400, "offer_fields_invalid"):
                throw VoiceMediaError.definite("서버가 음성 연결 요청을 거절했습니다.")
            case (413, _):
                throw VoiceMediaError.definite("음성 연결 요청이 서버 한도를 초과했습니다.")
            case (429, "voice_call_limit"):
                throw VoiceMediaError.definite("서버의 동시 통화 한도가 찼습니다. 잠시 후 다시 시도해 주세요.")
            case (503, "media_shutting_down"):
                throw VoiceMediaError.definite("서버 음성 서비스가 종료 중입니다. 잠시 후 다시 시도해 주세요.")
            case (409, "voice_offer_in_progress"):
                // The server is still creating the session for this start
                // identity: not a rejection. The start stays unresolved and
                // the start observation settles it.
                throw MobileError.response("통화 연결이 아직 완성되지 않았습니다. 잠시 후 통화 상태를 확인해 주세요.")
            case (409, "voice_start_unresolved"):
                // The device still owns an earlier unresolved start; the new
                // offer was not admitted. Settle the earlier start through
                // the start observation.
                throw MobileError.response("이전 통화의 시작이 아직 정리되지 않았습니다. 상태를 확인한 뒤 다시 시도해 주세요.")
            case (409, "voice_start_limit"):
                // The bounded per-device ledger is full of non-expired
                // receipts and nothing is unresolved: a plain capacity
                // refusal for this new attempt, which provably created
                // nothing.
                throw VoiceMediaError.definite("서버의 통화 시작 기록 한도가 찼습니다. 잠시 후 다시 시도해 주세요.")
            case (409, _):
                throw VoiceMediaError.definite("음성 요청이 현재 통화 상태와 맞지 않습니다.")
            case (404, _):
                throw VoiceMediaError.definite("음성 연결 경로를 찾을 수 없습니다. 앱과 서버 버전을 확인해 주세요.")
            default:
                throw MobileError.response("음성 서버의 응답을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.")
            }
        case .sessionControl:
            switch (http.statusCode, code) {
            case (404, _):
                throw VoiceMediaError.definite("해당 음성 세션을 찾을 수 없습니다. 통화를 다시 시작해 주세요.")
            case (409, _):
                throw VoiceMediaError.definite("음성 요청이 현재 통화 상태와 맞지 않습니다.")
            default:
                throw MobileError.response("음성 서버의 응답을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.")
            }
        case .hangup:
            // A lost, rejected, or absent session end is never proof of
            // closure: the same identifier stays retryable.
            throw MobileError.response("서버 통화 종료를 확인하지 못했습니다. 종료를 다시 확인해 주세요.")
        case .startObservation:
            switch (http.statusCode, code) {
            case (404, "voice_start_unknown"):
                throw VoiceMediaError.startUnknown
            case (403, "voice_start_forbidden"):
                // The start exists under a different device or a stale
                // authority fence: evidence exists but not for this
                // principal, so the fence stays.
                throw MobileError.response("이 통화 시작은 다른 기기·권한에 속해 있어 이 연결에서 확인할 수 없습니다.")
            default:
                throw MobileError.response("이전 통화 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.")
            }
        }
    }

    // Agreed start identity: canonical lowercase UUID v4, sent with every
    // offer for one call attempt so the server binds retries to it.
    private static func canonicalStartID(_ value: String) -> Bool {
        value.utf8.count == 36 && value == value.lowercased() && UUID(uuidString: value) != nil
    }

    public func voiceOffer(sdp: String, startID: String) async throws -> VoiceMediaAnswer {
        guard !sdp.isEmpty, sdp.utf8.count <= 65_536, Self.canonicalStartID(startID) else {
            throw MobileError.response("음성 연결 요청을 만들 수 없습니다.")
        }
        let body = try JSONEncoder().encode(JSON.object(["sdp": .string(sdp), "type": .string("offer"), "start_id": .string(startID)]))
        return try validatedVoiceMediaAnswer(try await voiceRequest("mobile/v1/voice/offer", method: "POST", body: body, role: .admission))
    }

    // Server-side observation of this start identity: live returns the
    // session to adopt, ended confirms closure, and a definitive
    // never-created answer proves no session exists.
    public func voiceStartState(startID: String) async throws -> VoiceStartObservation {
        guard Self.canonicalStartID(startID) else { throw MobileError.response("이전 통화 상태를 확인할 수 없습니다.") }
        do {
            let value = try await voiceRequest("mobile/v1/voice/starts/\(percentEncoded(startID))", method: "GET", body: nil, role: .startObservation)
            guard case .string(let pcID) = value["pc_id"], !pcID.isEmpty, pcID.utf8.count <= 128 else {
                throw MobileError.response("이전 통화 상태를 확인하지 못했습니다.")
            }
            switch value["state"].text {
            case "live": return .live(pcID: pcID)
            case "ended": return .ended(pcID: pcID)
            default: throw MobileError.response("이전 통화 상태를 확인하지 못했습니다.")
            }
        } catch let error as VoiceMediaError {
            if case .startUnknown = error { return .unknownStart }
            throw error
        }
    }

    public func voiceICE(pcID: String, candidates: [VoiceICECandidate]) async throws -> Int {
        guard !pcID.isEmpty, pcID.utf8.count <= 128, !candidates.isEmpty, candidates.count <= 32,
              candidates.allSatisfy({ $0.candidate.utf8.count <= 2048 && $0.sdpMid.utf8.count <= 128 && (0...16).contains($0.sdpMlineIndex) }) else {
            throw MobileError.response("음성 연결 후보를 보낼 수 없습니다.")
        }
        let payload = JSON.object(["candidates": .array(candidates.map {
            .object(["candidate": .string($0.candidate), "sdp_mid": .string($0.sdpMid), "sdp_mline_index": .number(Double($0.sdpMlineIndex))])
        })])
        let value = try await voiceRequest("mobile/v1/voice/sessions/\(percentEncoded(pcID))/ice", method: "PATCH", body: try JSONEncoder().encode(payload), role: .sessionControl)
        guard case .number(let accepted) = value["accepted"], accepted >= 0 else { throw MobileError.response("서버의 연결 후보 응답을 확인하지 못했습니다.") }
        return Int(accepted)
    }

    public func voiceCancelTurn(pcID: String, turnID: String) async throws -> VoiceTurnCancelState {
        guard UUID(uuidString: turnID) != nil else { throw MobileError.response("취소할 발화를 확인해 주세요.") }
        let body = try JSONEncoder().encode(JSON.object(["turn_id": .string(turnID)]))
        return try validatedTurnCancelState(try await voiceRequest("mobile/v1/voice/sessions/\(percentEncoded(pcID))/cancel_turn", method: "POST", body: body, role: .sessionControl))
    }

    public func voiceHangup(pcID: String) async throws {
        guard !pcID.isEmpty, pcID.utf8.count <= 128 else { throw MobileError.response("종료할 통화를 확인해 주세요.") }
        _ = try await voiceRequest("mobile/v1/voice/sessions/\(percentEncoded(pcID))/hangup", method: "POST", body: nil, role: .hangup)
    }

    private func percentEncoded(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    // MARK: Notification inbox and push registration

    public func registerPushToken(_ token: String, environment: String) async throws {
        guard token.count >= 32, token.count <= 128, token.allSatisfy({ $0.isHexDigit }),
              environment == "sandbox" || environment == "production" else {
            throw MobileError.response("이 기기의 알림 토큰을 등록할 수 없습니다.")
        }
        let body = try JSONEncoder().encode(JSON.object(["device_token": .string(token), "environment": .string(environment)]))
        let value = try await request("mobile/v1/notifications/register", body: body)
        guard value["registered"].flag else { throw MobileError.response("알림 등록 응답을 확인하지 못했습니다.") }
    }

    public func notificationInbox(recipientID: String) async throws -> [MobileNotification] {
        guard UUID(uuidString: recipientID) != nil else { throw MobileError.response("알림함 대상을 확인해 주세요.") }
        let body = try JSONEncoder().encode(JSON.object(["recipient_id": .string(recipientID)]))
        let reply = try await request("mobile/v1/notifications/inspect", body: body)
        guard reply["ok"].flag else { throw MobileError.response(reply["error"].text) }
        // The gateway forwards the Host lifetime envelope: the notification
        // list lives in result.data.notifications, not at the top level.
        let result = reply["result"]
        guard result["status"] == .string("success") else { throw MobileError.response("서버의 알림함 응답을 확인하지 못했습니다.") }
        return try validatedNotificationInbox(result["data"])
    }

    public func acknowledgeNotification(recipientID: String, notificationID: String, state: String) async throws {
        guard UUID(uuidString: recipientID) != nil,
              !notificationID.isEmpty, notificationID.utf8.count <= 400,
              state == "transport_accepted" || state == "client_seen" else {
            throw MobileError.response("알림 확인 상태를 갱신할 수 없습니다.")
        }
        let body = try JSONEncoder().encode(JSON.object([
            "recipient_id": .string(recipientID),
            "notification_id": .string(notificationID),
            "state": .string(state),
        ]))
        // The gateway answers definitive rejections and unknown outcomes
        // with failure bodies; both leave the notification pending, but the
        // reason stays visible and is never reported as seen.
        let reply = try await request("mobile/v1/notifications/ack", body: body, failureStatuses: [403, 404, 502])
        guard reply["ok"].flag else {
            switch reply["error"].text {
            case "host_acknowledgement_rejected", "notification_not_found":
                throw MobileError.response("호스트가 알림 확인을 거절했습니다. 알림은 전달됨 상태로 남습니다.")
            case "host_unavailable_or_outcome_unknown":
                throw MobileError.response("알림 확인 결과가 아직 확정되지 않았습니다. 잠시 후 다시 확인해 주세요.")
            case let detail where !detail.isEmpty:
                throw MobileError.response(detail)
            default:
                throw MobileError.response("알림 확인 결과를 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.")
            }
        }
        // Outer success is not an effect: only a Host success bound to this
        // exact recipient, notification, and resulting state confirms the
        // acknowledgement.
        let result = reply["result"]
        let data = result["data"]
        let resultingState = data["state"].text
        if result["status"] == .string("success") {
            let stateConfirmed = state == "client_seen" ? resultingState == "client_seen"
                : resultingState == "transport_accepted" || resultingState == "client_seen"
            guard data["recipient_id"] == .string(recipientID),
                  data["notification_id"] == .string(notificationID),
                  stateConfirmed else {
                throw MobileError.response("서버의 알림 확인 응답이 요청과 일치하지 않습니다.")
            }
            return
        }
        if result["status"] == .string("error") {
            throw MobileError.response("호스트가 알림 확인을 거절했습니다. 알림은 전달됨 상태로 남습니다.")
        }
        throw MobileError.response("알림 확인 결과가 아직 확정되지 않았습니다. 잠시 후 다시 확인해 주세요.")
    }

    public func ownerSnapshot() async throws -> JSON {
        guard lifetimeIdentity == nil else { throw MobileError.response("Lifetime 연결에는 Owner 전체 상태를 요청할 수 없습니다.") }
        return try await request("mobile/v1/snapshot", body: nil)
    }
    public func acknowledge(_ envelope: Envelope) async throws {
        guard envelope.command["type"] != .string("lifetime") else {
            throw MobileError.response("Lifetime 요청은 영수증이 확인되기 전까지 보존합니다.")
        }
        try await JournalRegistry.shared.commands(at: pendingFile).finish(envelope)
    }
    public func action(_ command: JSON) async throws -> JSON {
        guard command["type"] != .string("lifetime") else {
            throw MobileError.response("Lifetime requests require the fenced Lifetime transport.")
        }
        let pending = await JournalRegistry.shared.commands(at: pendingFile)
        let envelope = try await pending.prepare(command)
        let response = try await request("mobile/v1/action", body: JSONEncoder().encode(envelope))
        guard response["ok"].flag else { throw MobileError.response(response["error"].text) }
        try await pending.finish(envelope)
        return response["result"]
    }

    public func lifetimeRecoveryItems() async throws -> [LifetimeRecoveryItem] {
        guard lifetimeIdentity != nil else { throw MobileError.response("Lifetime transport identity is not configured.") }
        let directory = pendingFile.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            .filter { ($0.lastPathComponent.hasPrefix("lifetime-") && $0.pathExtension == "json") || $0.lastPathComponent == "pending.json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        var items: [LifetimeRecoveryItem] = []
        for file in files {
            let name = file.lastPathComponent
            let coordinates = lifetimeJournalCoordinates(name)
            let fileValues: URLResourceValues
            do {
                fileValues = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            } catch {
                items.append(LifetimeRecoveryItem(id: "\(name):unreadable", workspaceID: coordinates.workspaceID, deviceID: coordinates.deviceID,
                    authorityEpoch: coordinates.authorityEpoch, commandID: nil, issue: "unreadable_journal", journalFileName: name, originalEnvelope: nil))
                continue
            }
            guard fileValues.isSymbolicLink != true, fileValues.isRegularFile == true else {
                items.append(LifetimeRecoveryItem(id: "\(name):unsafe", workspaceID: coordinates.workspaceID, deviceID: coordinates.deviceID,
                    authorityEpoch: coordinates.authorityEpoch, commandID: nil, issue: "unsafe_journal", journalFileName: name, originalEnvelope: nil))
                continue
            }
            let journal = await JournalRegistry.shared.commands(at: file.standardizedFileURL)
            let envelopes: [Envelope]
            do {
                envelopes = try await journal.all()
            } catch {
                items.append(LifetimeRecoveryItem(id: "\(name):unreadable", workspaceID: coordinates.workspaceID, deviceID: coordinates.deviceID,
                    authorityEpoch: coordinates.authorityEpoch, commandID: nil, issue: "unreadable_journal", journalFileName: name, originalEnvelope: nil))
                continue
            }
            for (index, envelope) in envelopes.enumerated() {
                if envelope.command["type"] != .string("lifetime") { continue }
                let commandID = envelope.command["envelope"]["command_id"].text
                let fallbackEpoch = safeLifetimeEpoch(envelope.command["envelope"]["authority_epoch"])
                let stableID = "\(name):\(envelope.request_id):\(index)"
                let details: LifetimeEnvelopeDetails
                do {
                    details = try lifetimeEnvelopeDetails(envelope)
                } catch {
                    items.append(LifetimeRecoveryItem(id: stableID, workspaceID: coordinates.workspaceID, deviceID: coordinates.deviceID,
                        authorityEpoch: fallbackEpoch ?? coordinates.authorityEpoch, commandID: commandID.isEmpty ? nil : commandID,
                        issue: "invalid_lifetime_envelope", journalFileName: name, originalEnvelope: nil))
                    continue
                }
                if name == lifetimeNamespace?.fileName,
                   details.actorRef == lifetimeIdentity?.actor_ref,
                   details.authorityEpoch == lifetimeIdentity?.authority_epoch {
                    continue
                }
                let epochMismatch = coordinates.authorityEpoch.map { $0 != details.authorityEpoch } ?? false
                let namespaceIssue = coordinates.workspaceID == nil
                    ? "ambiguous_namespace"
                    : (coordinates.workspaceID != lifetimeNamespace?.workspaceID ? "different_workspace" : (epochMismatch ? "namespace_mismatch" : nil))
                items.append(LifetimeRecoveryItem(id: stableID, workspaceID: coordinates.workspaceID, deviceID: coordinates.deviceID,
                    authorityEpoch: details.authorityEpoch, commandID: details.commandID, issue: namespaceIssue,
                    journalFileName: name, originalEnvelope: namespaceIssue == nil ? envelope : nil))
            }
        }
        return items
    }

    public func reconcileLifetime(_ recoveryID: String) async throws -> LifetimeReconciliation {
        let (identity, _) = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.read") else {
            throw MobileError.response("이 연결에는 영수증 확인 권한이 없습니다. 미확정 요청을 보존하고 새 변경을 차단합니다.")
        }
        guard let item = try await lifetimeRecoveryItems().first(where: { $0.id == recoveryID }),
              item.canReconcile,
              let originalEnvelope = item.originalEnvelope,
              let originalCommandID = item.commandID,
              let originalEpoch = item.authorityEpoch else {
            throw MobileError.response("이전 요청 기록이 모호하거나 읽을 수 없어 영수증 확인을 보낼 수 없습니다.")
        }
        let details = try lifetimeEnvelopeDetails(originalEnvelope)
        guard details.commandID == originalCommandID, details.authorityEpoch == originalEpoch else {
            throw MobileError.response("이전 요청의 ID 또는 권한 epoch가 변경되어 영수증 확인을 보낼 수 없습니다.")
        }
        let reconciliation = try await inspectLifetimeReceipt(
            commandID: originalCommandID,
            originalEpoch: originalEpoch,
            originalPayloadDigest: details.payloadDigest,
            identity: identity
        )
        guard reconciliation.commandID == originalCommandID,
              reconciliation.authorityEpoch == originalEpoch,
              (reconciliation.status == .confirmedSuccess || reconciliation.status == .confirmedNoEffect) else {
            return reconciliation
        }

        let refreshed = try await lifetimeRecoveryItems()
        guard let current = refreshed.first(where: { $0.id == recoveryID }),
              current.originalEnvelope == originalEnvelope,
              current.canReconcile else {
            return LifetimeReconciliation(status: .unresolved, commandID: originalCommandID, authorityEpoch: originalEpoch)
        }
        let file = pendingFile.deletingLastPathComponent().appending(path: current.journalFileName)
        let journal = await JournalRegistry.shared.commands(at: file.standardizedFileURL)
        guard try await journal.contains(originalEnvelope) else {
            return LifetimeReconciliation(status: .unresolved, commandID: originalCommandID, authorityEpoch: originalEpoch)
        }
        try await journal.finish(originalEnvelope)
        return reconciliation
    }
    /// Receipt inspection is the only recovery action for a persisted write; it never replays the original payload.
    public func inspectLifetimeCommand(_ envelope: Envelope) async throws -> LifetimeReconciliation {
        let (identity, _) = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.read") else {
            throw MobileError.response("이 연결에는 영수증 확인 권한이 없습니다. 미확정 요청을 보존하고 새 변경을 차단합니다.")
        }
        let details = try lifetimeEnvelopeDetails(envelope)
        guard envelope.command["type"] == .string("lifetime"),
              details.actorRef == identity.actor_ref,
              details.authorityEpoch == identity.authority_epoch else {
            throw MobileError.response("현재 연결의 저장된 Lifetime 요청만 영수증 확인을 보낼 수 있습니다.")
        }
        let pending = await JournalRegistry.shared.commands(at: pendingFile)
        guard try await pending.contains(envelope) else {
            throw MobileError.response("저장된 요청을 찾지 못했습니다.")
        }
        let reconciliation = try await inspectLifetimeReceipt(
            commandID: details.commandID,
            originalEpoch: details.authorityEpoch,
            originalPayloadDigest: details.payloadDigest,
            identity: identity
        )
        guard reconciliation.status == .confirmedSuccess || reconciliation.status == .confirmedNoEffect,
              try await pending.contains(envelope) else { return reconciliation }
        try await pending.finish(envelope)
        return reconciliation
    }

    private func inspectLifetimeReceipt(
        commandID: String,
        originalEpoch: UInt64,
        originalPayloadDigest: String,
        identity: LifetimeIdentity
    ) async throws -> LifetimeReconciliation {
        let inspectBody = JSON.object(["method": .string("command.inspect"), "command_id": .string(commandID)])
        let inspectCommand = try lifetimeCommand(
            body: inspectBody,
            identity: identity,
            commandID: UUID().uuidString.lowercased(),
            expectedRevision: nil
        )
        let reply = try await request("mobile/v1/lifetime/action", body: JSONEncoder().encode(Envelope(command: inspectCommand)))
        guard reply["ok"].flag else {
            let message = reply["error"].text
            throw MobileError.response(message.isEmpty ? "원래 요청의 영수증을 확인하지 못했습니다." : message)
        }
        let response = reply["result"]
        let receipt = response["data"]
        let unresolved = LifetimeReconciliation(status: .unresolved, commandID: commandID, authorityEpoch: originalEpoch)
        guard validLifetimeResponse(response), receipt["command_id"] == .string(commandID) else { return unresolved }
        if receipt["found"] == .bool(false) {
            let authoritativeAbsence = response["status"] == .string("warning")
                && response["error_code"] == .string("not_found")
                && response["retry_class"] == .string("reconcile_first")
            return authoritativeAbsence
                ? LifetimeReconciliation(status: .notFound, commandID: commandID, authorityEpoch: originalEpoch)
                : unresolved
        }
        guard response["status"] == .string("success"),
              receipt["found"] == .bool(true),
              safeLifetimeEpoch(receipt["authority_epoch"]) == originalEpoch,
              receipt["payload_digest"] == .string(originalPayloadDigest),
              validLifetimeResponse(receipt["response"]) else { return unresolved }
        let originalResponse = receipt["response"]
        if originalResponse["status"] == .string("success") {
            return LifetimeReconciliation(status: .confirmedSuccess, commandID: commandID, authorityEpoch: originalEpoch)
        }
        let noEffectCodes: Set<String> = ["authority_fenced", "conflict", "dispatch_off", "invalid_request", "not_found", "unauthorized", "unsupported_version"]
        let confirmedNoEffect = originalResponse["status"] == .string("error")
            && originalResponse["data"]["host_effect_class"] == .string("no_effect")
            && noEffectCodes.contains(originalResponse["error_code"].text)
            && originalResponse["retry_class"] != .string("reconcile_first")
        return confirmedNoEffect
            ? LifetimeReconciliation(status: .confirmedNoEffect, commandID: commandID, authorityEpoch: originalEpoch)
            : unresolved
    }

    /// Lifetime requests are resolved through command.inspect, never replayed from this retry path.
    public func retry(_ envelope: Envelope) async throws -> JSON {
        let pending = await JournalRegistry.shared.commands(at: pendingFile)
        guard try await pending.contains(envelope) else { throw MobileError.response("저장된 요청을 찾지 못했습니다.") }
        guard envelope.command["type"] != .string("lifetime") else {
            throw MobileError.response("저장된 Lifetime 요청은 재전송하지 않습니다. 같은 ID의 영수증을 명시적으로 확인하세요.")
        }
        let response = try await request("mobile/v1/action", body: JSONEncoder().encode(envelope))
        guard response["ok"].flag else { throw MobileError.response(response["error"].text) }
        try await pending.finish(envelope)
        return response["result"]
    }

    public func lifetimeSnapshot() async throws -> JSON {
        _ = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.read") else { throw MobileError.response("이 연결에는 Lifetime 읽기 권한이 없습니다.") }
        return try await request("mobile/v1/lifetime/snapshot", body: nil)
    }

    public func inferenceSettings() async throws -> JSON {
        _ = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.read") else { throw MobileError.response("모델 설정을 읽을 권한이 없습니다.") }
        let result = try await request("mobile/v1/inference/settings", body: nil)
        guard result["ok"].flag, !result["providers"].items.isEmpty else { throw MobileError.response("모델 설정을 확인하지 못했습니다.") }
        return result
    }
    public func imageOperation(_ body: JSON) async throws -> JSON {
        try await requireLifetimeMutationAuthority()
        let reply = try await request("mobile/v1/inference/images", body: JSONEncoder().encode(body))
        guard reply["ok"].flag else { throw MobileError.response("제공자 등록과 이 대화의 외부 전송 허용을 확인해 주세요.") }
        return reply["result"]
    }
    public func selectInference(ghostID: String, conversationID: String, version: JSON, selection: JSON, allowExternal: Bool) async throws -> JSON {
        try await requireLifetimeMutationAuthority()
        let body: JSON = .object(["operation": .string("select"), "version": version,
            "ghost_id": .string(ghostID), "conversation_id": .string(conversationID), "selection": selection, "allow_external": .bool(allowExternal)])
        let result = try await request("mobile/v1/inference/settings", body: JSONEncoder().encode(body))
        guard result["ok"].flag else { throw MobileError.response("모델을 바꾸지 못했습니다. 진행 중인 응답이 있으면 끝난 뒤 설정을 다시 확인해 주세요.") }
        return result
    }

    public func lifetimeAction(_ body: JSON, expectedRevision: UInt64? = nil) async throws -> JSON {
        let (identity, _) = try lifetimeContext()
        let method = body["method"].text
        if ["conversation.turn.inspect", "conversation.cancel_turn"].contains(method),
           !validConversationTurnBody(body, expectedRevision: expectedRevision) {
            throw MobileError.response("A canonical conversation turn request needs its exact bounded target.")
        }
        if lifetimeMutationMethods.contains(method) {
            try await requireLifetimeMutationAuthority()
        } else if lifetimeReadMethods.contains(method) {
            guard lifetimeCapabilities.contains("lifetime.read") else { throw MobileError.response("이 연결에는 Lifetime 읽기 권한이 없습니다.") }
        } else {
            throw MobileError.response("이 Lifetime 동작은 지원되지 않습니다.")
        }
        if lifetimeReadMethods.contains(method) {
            let envelope = Envelope(command: try lifetimeCommand(
                body: body,
                identity: identity,
                commandID: UUID().uuidString.lowercased(),
                expectedRevision: expectedRevision
            ))
            return try await receiveLifetime(envelope, pending: nil)
        }
        let pending = await JournalRegistry.shared.commands(at: pendingFile)
        let envelope = try await pending.prepareLifetime(body, identity: identity, expectedRevision: expectedRevision)
        return try await receiveLifetime(envelope, pending: pending)
    }
    public func inspectLifetimeConversation(
        ghostID: String,
        conversationID: String,
        beforeSequence: UInt64? = nil,
        limit: Int = 100
    ) async throws -> JSON {
        guard !ghostID.isEmpty, !conversationID.isEmpty,
              (1...100).contains(limit),
              beforeSequence.map({ $0 > 0 && $0 <= 9_007_199_254_740_991 }) ?? true else {
            throw MobileError.response("Invalid canonical conversation page request.")
        }
        var body: [String: JSON] = [
            "method": .string("conversation.inspect"),
            "ghost_id": .string(ghostID),
            "conversation_id": .string(conversationID),
            "limit": .number(Double(limit)),
        ]
        if let beforeSequence { body["before_sequence"] = .number(Double(beforeSequence)) }
        return try await lifetimeAction(.object(body))
    }
    public func inspectLifetimeConversationTurn(
        ghostID: String,
        conversationID: String,
        turnID: String
    ) async throws -> JSON {
        try await lifetimeAction(lifetimeConversationTurnBody(
            method: "conversation.turn.inspect",
            ghostID: ghostID,
            conversationID: conversationID,
            turnID: turnID
        ))
    }

    public func cancelLifetimeConversationTurn(
        ghostID: String,
        conversationID: String,
        turnID: String
    ) async throws -> JSON {
        try await lifetimeAction(lifetimeConversationTurnBody(
            method: "conversation.cancel_turn",
            ghostID: ghostID,
            conversationID: conversationID,
            turnID: turnID
        ))
    }


    public func submitLifetimeConversation(
        ghostID: String,
        conversationID: String,
        text: String,
        privacy: String = "local_only",
        attachments: [JSON] = []
    ) async throws -> JSON {
        guard !ghostID.isEmpty, !conversationID.isEmpty,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 65_536,
              ["public", "private", "local_only"].contains(privacy),
              attachments.count <= 16,
              attachments.allSatisfy(validLifetimeAttachment) else {
            throw MobileError.response("Canonical conversation input must use bounded text and existing Artifact references.")
        }
        return try await lifetimeAction(.object([
            "method": .string("conversation.input"),
            "ghost_id": .string(ghostID),
            "conversation_id": .string(conversationID),
            "text": .string(text),
            "privacy": .string(privacy),
            "attachments": .array(attachments),
        ]))
    }


    // MARK: Owner decision surface (exact-scope gateway routes)

    // Pending owner questions for exactly this device's scope, with the full
    // normalized action target visible before any decision is possible.
    public func ownerQuestions() async throws -> [OwnerQuestion] {
        _ = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.read") else {
            throw MobileError.response("이 연결에는 질문 목록을 읽을 권한이 없습니다.")
        }
        let reply = try await request("mobile/v1/lifetime/questions", body: nil)
        guard reply["ok"].flag, case .array(let items) = reply["questions"], items.count <= 64 else {
            throw MobileError.response("결정 필요 질문 목록의 형식을 확인하지 못했습니다.")
        }
        return try items.map(parseOwnerQuestion)
    }

    /// Owner decision on one exact question. The reply carries the recorded
    /// action state and the truthful wake result; a refused or unknown wake is
    /// returned, never flattened into success.
    public func decideOwnerQuestion(ghostID: String, actionID: String, approve: Bool) async throws -> JSON {
        _ = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.write") else {
            throw MobileError.response("이 연결에는 결정을 기록할 권한이 없습니다.")
        }
        guard UUID(uuidString: ghostID) != nil,
              actionID.hasPrefix("ba-"), actionID.count == 39,
              UUID(uuidString: String(actionID.dropFirst(3))) != nil else {
            throw MobileError.response("결정할 질문을 정확히 지정해 주세요.")
        }
        let body = JSON.object([
            "ghost_id": .string(ghostID),
            "action_id": .string(actionID),
            "decision": .string(approve ? "approve" : "deny"),
        ])
        let reply = try await request("mobile/v1/lifetime/questions/decision", body: JSONEncoder().encode(body))
        guard reply["ok"].flag, case .object = reply["action"] else {
            let message = reply["error"].text
            throw MobileError.response(message.isEmpty ? "결정 기록을 확인하지 못했습니다." : message)
        }
        return reply
    }

    /// Per-Ghost home/browser lifecycle through the durable registry:
    /// idle_stop, recreate, or stop for one Ghost in this device's scope.
    public func computerLifecycle(ghostID: String, operation: String) async throws -> JSON {
        _ = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.write") else {
            throw MobileError.response("이 연결에는 컴퓨터 제어 권한이 없습니다.")
        }
        guard UUID(uuidString: ghostID) != nil,
              ["idle_stop", "recreate", "stop"].contains(operation) else {
            throw MobileError.response("컴퓨터 제어 요청을 확인해 주세요.")
        }
        let body = JSON.object(["ghost_id": .string(ghostID), "operation": .string(operation)])
        let reply = try await request("mobile/v1/lifetime/computer/lifecycle", body: JSONEncoder().encode(body))
        guard reply["ok"].flag, case .object = reply["result"] else {
            let message = reply["error"].text
            throw MobileError.response(message.isEmpty ? "컴퓨터 제어 결과를 확인하지 못했습니다." : message)
        }
        return reply
    }

    /// Delegates durable child work from one owned parent work to another
    /// registered Ghost. The parent Goal's current revision travels as the
    /// CAS expected_revision; artifact references are opaque digests of the
    /// parent's own reported results.
    public func delegateWork(
        parentWorkID: String,
        targetGhostID: String,
        summary: String,
        artifactRefs: [String],
        acceptanceSpec: JSON,
        expectedRevision: UInt64
    ) async throws -> JSON {
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard UUID(uuidString: parentWorkID) != nil,
              UUID(uuidString: targetGhostID) != nil,
              !trimmed.isEmpty, trimmed.utf8.count <= 8_192,
              artifactRefs.count <= 32,
              artifactRefs.allSatisfy({ $0.count == 64 && $0.allSatisfy(\.isHexDigit) }),
              case .object = acceptanceSpec else {
            throw MobileError.response("위임 요청의 형식이 계약과 일치하지 않습니다.")
        }
        return try await lifetimeAction(.object([
            "method": .string("work.delegate"),
            "parent_work_id": .string(parentWorkID),
            "target_ghost_id": .string(targetGhostID),
            "summary": .string(trimmed),
            "artifact_refs": .array(artifactRefs.map(JSON.string)),
            "acceptance_spec": acceptanceSpec,
        ]), expectedRevision: expectedRevision)
    }

    /// Opens the exact bytes of one current work artifact. The Host re-proves
    /// result currency; this side re-verifies the digest over the received
    /// bytes so the viewer never renders unverified content.
    public func readWorkArtifact(
        workID: String,
        executionID: String,
        digest: String,
        locator: String
    ) async throws -> WorkArtifactContent {
        _ = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.read") else {
            throw MobileError.response("이 연결에는 결과물을 열 권한이 없습니다.")
        }
        let nativeExecution = executionID.hasPrefix("pi-") && executionID.count == 67
            && executionID.dropFirst(3).allSatisfy({ "0123456789abcdef".contains($0) })
        guard UUID(uuidString: workID) != nil, (UUID(uuidString: executionID) != nil || nativeExecution),
              digest.count == 64, digest.allSatisfy({ "0123456789abcdef".contains($0) }),
              !locator.isEmpty, locator.utf8.count <= 1024,
              !locator.contains(where: { $0.unicodeScalars.contains(where: { $0.value < 0x20 }) }) else {
            throw MobileError.response("결과물 요청을 확인해 주세요.")
        }
        let result = try await lifetimeAction(.object([
            "method": .string("work.artifact"),
            "work_id": .string(workID),
            "execution_id": .string(executionID),
            "digest": .string(digest),
            "locator": .string(locator),
        ]))
        guard result["status"].text == "success" else {
            throw MobileError.response(result["summary"].text)
        }
        let data = result["data"]
        guard data["work_id"].text == workID, data["execution_id"].text == executionID,
              data["digest"].text == digest, data["encoding"].text == "base64",
              let byteLength = safeLifetimeEpoch(data["byte_length"]), byteLength <= 1_048_576,
              let raw = Data(base64Encoded: data["data"].text), raw.count == Int(byteLength),
              raw.sha256Hex == digest.lowercased() else {
            throw MobileError.response("결과물 내용이 보고된 digest와 일치하지 않습니다. 열지 않고 보존합니다.")
        }
        guard let revision = safeLifetimeEpoch(data["goal_revision"]), !data["goal_id"].text.isEmpty else {
            throw MobileError.response("결과물의 목표 revision 연결을 확인하지 못했습니다.")
        }
        return WorkArtifactContent(
            workID: data["work_id"].text.isEmpty ? workID : data["work_id"].text,
            goalID: data["goal_id"].text,
            goalRevision: revision,
            executionID: data["execution_id"].text.isEmpty ? executionID : data["execution_id"].text,
            digest: digest.lowercased(),
            privacy: data["privacy"].text,
            data: raw)
    }

    private func parseOwnerQuestion(_ value: JSON) throws -> OwnerQuestion {
        func bounded(_ key: String, maximum: Int) throws -> String {
            let text = value[key].text
            guard !text.isEmpty, text.utf8.count <= maximum else {
                throw MobileError.response("질문의 \(key) 값을 확인하지 못했습니다.")
            }
            return text
        }
        guard case .object = value,
              let ghostID = try? bounded("ghost_id", maximum: 64), UUID(uuidString: ghostID) != nil,
              let actionID = try? bounded("action_id", maximum: 64), actionID.hasPrefix("ba-"),
              UUID(uuidString: String(actionID.dropFirst(3))) != nil,
              let requestedEpoch = safeLifetimeEpoch(value["requested_epoch"]),
              let authorityEpoch = safeLifetimeEpoch(value["authority_epoch"]),
              authorityEpoch == lifetimeIdentity?.authority_epoch,
              let snapshotID = safeLifetimeEpoch(value["snapshot_id"]),
              let argumentsDigest = try? bounded("arguments_digest", maximum: 64),
              argumentsDigest.allSatisfy({ "0123456789abcdef".contains($0) }) else {
            throw MobileError.response("게이트웨이가 제공한 질문 형식이 계약과 일치하지 않습니다.")
        }
        let target = value["target"]
        let targetRef = target["ref"].text
        guard !targetRef.isEmpty, targetRef.utf8.count <= 400 else {
            throw MobileError.response("질문의 대상 ref를 확인하지 못했습니다.")
        }
        return OwnerQuestion(
            ghostID: ghostID,
            actionID: actionID,
            computerID: value["computer_id"].text,
            executionID: try bounded("execution_id", maximum: 400),
            argumentsDigest: argumentsDigest,
            requestedEpoch: requestedEpoch,
            operation: try bounded("operation", maximum: 32),
            url: value["url"].text,
            snapshotID: snapshotID,
            targetRef: targetRef,
            targetRole: target["role"].text,
            targetName: target["name"].text,
            value: value["value"].text.isEmpty ? nil : value["value"].text,
            profileScope: value["profile_scope"].text,
            authorityEpoch: authorityEpoch)
    }

    private func lifetimeContext() throws -> (LifetimeIdentity, LifetimeJournalNamespace) {
        guard let lifetimeIdentity else { throw MobileError.response("Lifetime transport identity is not configured.") }
        guard lifetimeConfigurationIssue == nil, let lifetimeNamespace,
              lifetimeNamespace.authorityEpoch == lifetimeIdentity.authority_epoch else {
            throw MobileError.response(lifetimeConfigurationIssue ?? "Lifetime storage namespace is not configured.")
        }
        return (lifetimeIdentity, lifetimeNamespace)
    }

    private func requireLifetimeMutationAuthority() async throws {
        _ = try lifetimeContext()
        guard lifetimeCapabilities.contains("lifetime.write") else { throw MobileError.response("이 연결에는 Lifetime 변경 권한이 없습니다.") }
        guard lifetimeDispatchEnabled else { throw MobileError.response("Host 복구 모드에서는 Lifetime 변경을 사용할 수 없습니다.") }
        guard try await lifetimeRecoveryItems().isEmpty else {
            throw MobileError.response("이전 연결의 미확정 요청을 먼저 확인해야 새 변경을 보낼 수 있습니다.")
        }
        let pending = await JournalRegistry.shared.commands(at: pendingFile)
        guard try await pending.all().allSatisfy({ $0.command["type"] != .string("lifetime") }) else {
            throw MobileError.response("현재 연결의 미확정 Lifetime 요청을 먼저 영수증 확인해야 새 변경을 보낼 수 있습니다.")
        }
    }

    private func lifetimeJournalCoordinates(_ fileName: String) -> (workspaceID: String?, deviceID: String?, authorityEpoch: UInt64?) {
        guard fileName.hasSuffix(".json") else { return (nil, nil, nil) }
        let stem = String(fileName.dropLast(".json".count))
        let parts = stem.split(separator: "-")
        func uuid(_ components: ArraySlice<Substring>) -> String? {
            guard let parsed = UUID(uuidString: components.joined(separator: "-")) else { return nil }
            return parsed.uuidString.lowercased()
        }
        if parts.count == 12, parts[0] == "lifetime",
           let workspace = uuid(parts[1...5]), let device = uuid(parts[6...10]),
           let epoch = UInt64(parts[11]), epoch > 0, epoch <= 9_007_199_254_740_991 {
            return (workspace, device, epoch)
        }
        if parts.count == 7, parts[0] == "lifetime",
           let device = uuid(parts[1...5]), let epoch = UInt64(parts[6]), epoch > 0, epoch <= 9_007_199_254_740_991 {
            return (nil, device, epoch)
        }
        return (nil, nil, nil)
    }

    private func validLifetimeResponse(_ value: JSON) -> Bool {
        guard case .object(let fields) = value, fields.count == 8,
              fields["data"] != nil, fields["error_code"] != nil,
              ["success", "warning", "error"].contains(value["status"].text),
              ["same_id", "reconcile_first", "new_revision", "never"].contains(value["retry_class"].text),
              !value["summary"].text.isEmpty,
              case .array(let refs) = value["object_refs"],
              case .array(let artifacts) = value["artifacts"],
              case .array(let actions) = value["next_actions"] else { return false }
        guard refs.allSatisfy({ if case .string = $0 { return true }; return false }),
              actions.allSatisfy({ if case .string = $0 { return true }; return false }) else { return false }
        switch value["error_code"] {
        case .null, .string: break
        default: return false
        }
        return artifacts.allSatisfy {
            guard case .object(let artifact) = $0, artifact.count == 4,
                  $0["digest"].text.count == 64,
                  $0["digest"].text.allSatisfy({ "0123456789abcdef".contains($0) }),
                  !$0["locator"].text.isEmpty, !$0["producing_attempt"].text.isEmpty,
                  ["public", "private", "local_only"].contains($0["privacy"].text) else { return false }
            return true
        }
    }

    private func receiveLifetime(_ envelope: Envelope, pending: PendingCommands?) async throws -> JSON {
        let reply = try await request("mobile/v1/lifetime/action", body: JSONEncoder().encode(envelope))
        guard reply["ok"].flag else {
            let message = reply["error"].text
            throw MobileError.response(message.isEmpty ? "Lifetime request was not accepted." : message)
        }
        let result = reply["result"]
        guard validLifetimeResponse(result) else {
            throw MobileError.response("Lifetime response does not match contract revision 1.")
        }
        let noEffectCodes: Set<String> = ["authority_fenced", "conflict", "dispatch_off", "invalid_request", "not_found", "unauthorized", "unsupported_version"]
        let confirmedNoEffect = result["status"] == .string("error")
            && result["data"]["host_effect_class"] == .string("no_effect")
            && noEffectCodes.contains(result["error_code"].text)
            && result["retry_class"] != .string("reconcile_first")
        if result["status"] == .string("success") || confirmedNoEffect, let pending {
            try await pending.finish(envelope)
        }
        return result
    }
    private func request(_ path: String, body: Data?, failureStatuses: Set<Int> = []) async throws -> JSON {
        var request = URLRequest(url: connection.url(path))
        request.httpMethod = body == nil ? "GET" : "POST"; request.httpBody = body
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw MobileError.response("서버 응답을 확인하지 못했습니다.") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 8_388_608 else { throw MobileError.response("서버 응답이 너무 큽니다.") }
            data.append(byte)
        }
        if http.statusCode == 401 { throw MobileError.response("기기 연결이 해제됐습니다. 새 연결 키로 다시 연결해 주세요.") }
        if http.statusCode == 429 {
            throw MobileError.response("조회 요청이 많아 잠시 대기 중입니다. 잠시 뒤 다시 확인해 주세요. 전송 결과가 미확정인 요청은 다시 보내지 마세요.")
        }
        guard (200..<300).contains(http.statusCode) || http.statusCode == 409 || failureStatuses.contains(http.statusCode) else {
            throw MobileError.response("요청 결과를 확인하지 못했습니다. 연결을 확인한 뒤 같은 요청으로 다시 시도해 주세요.")
        }
        return try JSONDecoder().decode(JSON.self, from: data)
    }
}
