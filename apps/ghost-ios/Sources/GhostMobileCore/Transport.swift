import Foundation
import CryptoKit

/// Dynamic JSON value for contract fields the phone passes through untouched
/// (decision proposals and similar free-form records).
public enum JSON: Codable, Sendable, Equatable, Hashable {
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

    /// Stable, readable serialization for proposal previews.
    public var pretty: String {
        let encoded = try? JSONSerialization.data(withJSONObject: serializable, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        return encoded.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    private var serializable: Any {
        switch self {
        case .object(let v): return v.mapValues(\.serializable)
        case .array(let v): return v.map(\.serializable)
        case .string(let v): return v
        case .number(let v): return v
        case .bool(let v): return v
        case .null: return NSNull()
        }
    }
}

public enum MobileError: LocalizedError, Sendable {
    case invalidServer, invalidPairingURL, invalidPairingCode, response(String)

    public var errorDescription: String? {
        switch self {
        case .invalidServer: "서버 주소 형식이 올바르지 않습니다. https:// 또는 로컬 http:// 주소를 입력해 주세요."
        case .invalidPairingURL: "QR 코드가 Ghost 연결 형식이 아닙니다."
        case .invalidPairingCode: "PC 화면의 연결 코드를 입력해 주세요."
        case .response(let message): message
        }
    }
}

/// Canonical origin validator: exact scheme/host/port form, no credentials,
/// path, query or fragment — an origin is a security principal, never a
/// free-form URL. HTTPS is always allowed; plain HTTP is allowed only for
/// loopback hosts so a locally served host can be paired from this device.
public func canonicalOrigin(_ server: String) throws -> URL {
    guard var u = URLComponents(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
          let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http",
          let host = u.host, !host.isEmpty,
          u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
          u.path.isEmpty || u.path == "/",
          u.port == nil || (1...65535).contains(u.port!) else { throw MobileError.invalidServer }
    let loopback = ["localhost", "127.0.0.1", "::1"].contains(host.lowercased())
    guard scheme == "https" || loopback else { throw MobileError.invalidServer }
    u.scheme = scheme; u.host = host.lowercased(); u.path = ""
    if u.port == schemeDefaultPort(scheme) { u.port = nil }
    guard let url = u.url else { throw MobileError.invalidServer }
    return url
}

private func schemeDefaultPort(_ scheme: String) -> Int? { scheme == "https" ? 443 : 80 }

/// One paired host: the claimed origin, this device's id and its bearer token.
/// Persisted as JSON in the Keychain.
public struct Connection: Codable, Sendable, Equatable {
    public let origin: URL
    public let deviceId: String
    public let token: String

    public init(origin: URL, deviceId: String, token: String) {
        self.origin = origin
        self.deviceId = deviceId
        self.token = token
    }

    public init(origin: String, deviceId: String, token: String) throws {
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty, trimmedToken.utf8.count <= 512, !deviceId.isEmpty, deviceId.utf8.count <= 128 else {
            throw MobileError.response("연결 정보가 올바르지 않습니다. 다시 연결해 주세요.")
        }
        self.origin = try canonicalOrigin(origin)
        self.deviceId = deviceId
        self.token = trimmedToken
    }

    public func url(_ path: String, query: [String: String] = [:]) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.path = path
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return components.url!
    }
}

// MARK: - Command journal (request-id reuse)

/// One queued mutation with its client-chosen requestId. A retry re-sends the
/// same id and bytes, so the host returns the original outcome instead of
/// applying the command twice.
public struct Envelope: Codable, Sendable, Equatable {
    public let requestId: String
    public let command: DeviceCommand

    public init(requestId: String, command: DeviceCommand) {
        self.requestId = requestId
        self.command = command
    }

    public init(requestId: UUID, command: DeviceCommand) {
        self.init(requestId: requestId.uuidString.lowercased(), command: command)
    }

    public init(command: DeviceCommand) {
        self.init(requestId: UUID(), command: command)
    }

    /// Canonical request bytes: identical retries must be byte-identical,
    /// so the journal serializes with sorted keys.
    var body: Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(CommandRequest(requestId: requestId, command: command))) ?? Data()
    }
}

/// Durable journal of envelopes that have not been confirmed by the host.
/// The envelope is persisted before dispatch; only a definitive outcome
/// (success, or a typed server rejection) removes it. Identical commands
/// collapse onto the pending envelope so a re-tap never doubles the effect.
public actor PendingCommands {
    private let file: URL
    public init(file: URL) { self.file = file }

    private func read() throws -> [Envelope] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try JSONDecoder().decode([Envelope].self, from: Data(contentsOf: file))
    }

    private func write(_ values: [Envelope]) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(values)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    public func prepare(_ command: DeviceCommand) throws -> Envelope {
        var values = try read()
        if let existing = values.first(where: { $0.command == command }) { return existing }
        let envelope = Envelope(command: command)
        values.append(envelope)
        try write(values)
        return envelope
    }

    public func finish(_ envelope: Envelope) throws {
        try write(try read().filter { $0 != envelope })
    }

    public func all() throws -> [Envelope] { try read() }
}

// MARK: - SSE parsing

/// Incremental SSE parser: feed raw bytes, receive complete frames. The
/// scan runs on UTF-8 bytes — Swift grapheme clustering would fuse a CRLF
/// pair into one character and hide the LF. Handles `event:`, `id:`,
/// `data:` fields and comment lines; a frame ends at the first empty line.
/// Multi-line data fields join with newlines.
public struct SSEParser: Sendable {
    private var buffer: [UInt8] = []
    private var eventName = "message"
    private var dataLines: [String] = []
    private var lastID: String?

    public init() {}

    public mutating func feed(_ bytes: some DataProtocol) -> [SSEFrame] {
        buffer.append(contentsOf: bytes)
        return drain()
    }

    public mutating func feed(text chunk: String) -> [SSEFrame] {
        buffer.append(contentsOf: Array(chunk.utf8))
        return drain()
    }

    private mutating func drain() -> [SSEFrame] {
        var frames: [SSEFrame] = []
        var lineStart = 0
        var index = 0
        while index < buffer.count {
            if buffer[index] == 0x0A {
                var lineEnd = index
                if lineEnd > lineStart, buffer[lineEnd - 1] == 0x0D { lineEnd -= 1 }
                let line = String(decoding: buffer[lineStart..<lineEnd], as: UTF8.self)
                if line.isEmpty {
                    if let frame = completeFrame() { frames.append(frame) }
                } else {
                    applyLine(line)
                }
                lineStart = index + 1
            }
            index += 1
        }
        if lineStart > 0 { buffer.removeFirst(lineStart) }
        return frames
    }

    private mutating func applyLine(_ line: String) {
        if line.hasPrefix(":") {
            // comment
        } else if let colon = line.firstIndex(of: ":") {
            let name = String(line[..<colon])
            var value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
            applyField(name, value)
        } else {
            applyField(line, "")
        }
    }

    private mutating func applyField(_ name: String, _ value: String) {
        switch name {
        case "event": eventName = value.isEmpty ? "message" : value
        case "data": dataLines.append(value)
        case "id": lastID = value
        default: break
        }
    }

    private mutating func completeFrame() -> SSEFrame? {
        guard !dataLines.isEmpty else { return nil }
        defer {
            eventName = "message"
            dataLines = []
        }
        return SSEFrame(event: eventName == "message" ? nil : eventName, id: lastID, data: dataLines.joined(separator: "\n"))
    }
}

public struct SSEFrame: Equatable, Sendable {
    public let event: String?
    public let id: String?
    public let data: String

    /// Decodes a frame into a contract StreamFrame; unknown event names and
    /// undecodable payloads are skipped by the caller.
    public func streamFrame() throws -> StreamFrame {
        let data = self.data.data(using: .utf8) ?? Data()
        switch event {
        case "ledger":
            let value = try JSONDecoder().decode(LedgerWireEvent.self, from: data)
            return .ledger(LedgerEvent(seq: value.seq, at: value.at, data: value.data))
        case "live":
            return .live(try JSONDecoder().decode(LiveEvent.self, from: data))
        case "reset":
            let value = try JSONDecoder().decode(ResetBody.self, from: data)
            return .reset(seq: value.seq)
        default:
            struct UnknownFrameError: Error {}
            throw UnknownFrameError()
        }
    }
}

/// Decodes the contract `LedgerEvent` (`{ seq, at, data }`) and its
/// `LedgerEventData` union (`{ type, …payload }`). Unrecognized contract
/// types keep the sequence moving as `.other`.
public struct LedgerWireEvent: Decodable, Sendable {
    public let seq: Int
    public let at: Int
    public let data: LedgerEventData

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        at = try c.decode(Int.self, forKey: .at)
        data = try c.decode(LedgerEventDataWire.self, forKey: .data).event
    }

    private enum CodingKeys: String, CodingKey { case seq, at, data }
}

/// One contract `LedgerEventData` row.
public enum LedgerEventData: Sendable, Equatable {
    case ghost(Ghost)
    case conversation(Conversation)
    case conversationRemoved(String)
    case work(Work)
    case decision(Decision)
    case effect(Effect)
    case notification(GhostNotification)
    case other(String)
}

struct LedgerEventDataWire: Decodable {
    let type: String
    let id: String?
    let ghost: Ghost?
    let conversation: Conversation?
    let work: Work?
    let decision: Decision?
    let effect: Effect?
    let notification: GhostNotification?

    private enum CodingKeys: String, CodingKey {
        case type, id, ghost, conversation, work, decision, effect, notification
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        id = try? c.decode(String.self, forKey: .id)
        ghost = try? c.decode(Ghost.self, forKey: .ghost)
        conversation = try? c.decode(Conversation.self, forKey: .conversation)
        work = try? c.decode(Work.self, forKey: .work)
        decision = try? c.decode(Decision.self, forKey: .decision)
        effect = try? c.decode(Effect.self, forKey: .effect)
        notification = try? c.decode(GhostNotification.self, forKey: .notification)
    }

    var event: LedgerEventData {
        switch type {
        case "ghost": return ghost.map { .ghost($0) } ?? .other(type)
        case "conversation": return conversation.map { .conversation($0) } ?? .other(type)
        case "conversation.removed": return .conversationRemoved(id ?? "")
        case "work": return work.map { .work($0) } ?? .other(type)
        case "decision": return decision.map { .decision($0) } ?? .other(type)
        case "effect": return effect.map { .effect($0) } ?? .other(type)
        case "notification": return notification.map { .notification($0) } ?? .other(type)
        default: return .other(type)
        }
    }
}

/// One applied ledger change.
public struct LedgerEvent: Sendable, Equatable {
    public var seq: Int
    public var at: Int
    public var data: LedgerEventData
}

/// Contract `LiveEvent`: an appended transcript message or the live
/// generation state of one conversation.
public enum LiveEvent: Sendable, Equatable, Decodable {
    case message(Message)
    case live(Live)

    private enum CodingKeys: String, CodingKey { case type, message, live }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "message": self = .message(try c.decode(Message.self, forKey: .message))
        case "live": self = .live(try c.decode(Live.self, forKey: .live))
        default:
            struct UnknownLiveEvent: Error {}
            throw UnknownLiveEvent()
        }
    }
}

private struct ResetBody: Decodable { let seq: Int }

// MARK: - Pairing claim

public struct PairingResult: Codable, Sendable, Equatable {
    public var deviceId: String
    public var token: String
}

/// The unauthenticated pairing route: `POST /api/pairing/claim`.
public struct PairingClient: Sendable {
    public let origin: URL
    private let session: URLSession

    private struct ClaimBody: Encodable {
        let code: String
        let deviceName: String
    }

    public init(origin: URL, session: URLSession? = nil) {
        self.origin = origin
        self.session = session ?? {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 20
            return URLSession(configuration: configuration)
        }()
    }

    public func claim(code: String, deviceName: String) async throws -> PairingResult {
        // Sorted keys keep a retry byte-identical to the first attempt.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let body = try encoder.encode(ClaimBody(code: code, deviceName: deviceName))
        var request = URLRequest(url: routeURL(origin, path: "/api/pairing/claim"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MobileError.response("연결 요청의 응답을 확인하지 못했습니다.")
        }
        if (200..<300).contains(http.statusCode) {
            return try JSONDecoder().decode(PairingResult.self, from: data)
        }
        if let error = try? JSONDecoder().decode(ApiErrorBody.self, from: data), !error.code.isEmpty {
            // A typed rejection is definitive: the code cannot be used as-is.
            throw CommandError(code: error.code, message: Self.serverMessage(code: error.code))
        }
        throw MobileError.response(http.statusCode == 429
            ? "연결 시도가 많습니다. 잠시 후 다시 시도해 주세요."
            : "연결 요청을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.")
    }

    static func serverMessage(code: String) -> String {
        switch code {
        case "invalid": "연결 코드 형식이 올바르지 않습니다. PC 화면의 코드를 다시 확인해 주세요."
        case "not_found": "연결 코드를 찾을 수 없습니다. PC 화면의 코드를 다시 확인해 주세요."
        case "conflict": "이 코드는 이미 사용되었습니다. PC에서 새 연결을 만들어 주세요."
        case "forbidden": "이 연결 코드는 만료되었거나 사용할 수 없습니다."
        default: "연결 요청을 처리하지 못했습니다. (\(code))"
        }
    }
}

// MARK: - API client

final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// The device-side client for one paired host. All routes live under `/api`
/// on the paired origin; every request carries the device bearer token.
public actor GhostAPI {
    public let connection: Connection
    private let session: URLSession
    private let pending: PendingCommands

    public init(connection: Connection, pendingFile: URL, session: URLSession? = nil) {
        self.connection = connection
        self.pending = PendingCommands(file: pendingFile)
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 30
            configuration.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        }
    }

    public func pendingCommands() async throws -> [Envelope] { try await pending.all() }

    /// GET /api/state
    public func state() async throws -> GhostStateSnapshot {
        try await get("/api/state")
    }

    /// GET /api/conversations/:id
    public func conversation(id: String, before: String? = nil, limit: Int? = nil) async throws -> ConversationPage {
        var query: [String: String] = [:]
        if let before { query["before"] = before }
        if let limit { query["limit"] = String(limit) }
        return try await get("/api/conversations/\(percentEncoded(id))", query: query)
    }

    /// GET /api/works/:id
    public func work(id: String) async throws -> WorkDetail {
        try await get("/api/works/\(percentEncoded(id))")
    }

    /// GET /api/artifacts/:digest — bytes are returned only after the
    /// SHA-256 over the received data matches the requested digest.
    public func artifact(digest: String) async throws -> Data {
        let (data, response) = try await fetch(URLRequest(url: connection.url("/api/artifacts/\(percentEncoded(digest))")))
        guard (200..<300).contains(response.statusCode) else {
            throw MobileError.response(response.statusCode == 404 ? "결과 자료를 찾을 수 없습니다." : "결과 자료를 받지 못했습니다.")
        }
        let observed = Self.sha256Hex(data)
        guard observed == digest.lowercased() else {
            throw MobileError.response("결과 자료가 보고된 지문과 일치하지 않습니다. 받지 않고 보존합니다.")
        }
        return data
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// GET /api/events?after=<seq>&conversation=<id>… as a frame stream.
    /// The request runs until the server closes it; reconnect and reset
    /// handling live with the caller, which remembers the last applied seq.
    public nonisolated func eventRequest(after seq: Int, conversations: [String]) -> URLRequest {
        var queryPairs = [("after", String(max(0, seq)))]
        for id in conversations.prefix(16) { queryPairs.append(("conversation", id)) }
        var request = URLRequest(url: routeURL(connection.origin, path: "/api/events", queryPairs: queryPairs))
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = .infinity
        return request
    }

    /// POST /api/commands with a journaled envelope. Returns the result
    /// object on success and throws `CommandError` on a definitive server
    /// rejection; unknown network outcomes leave the envelope pending.
    public func send(_ command: DeviceCommand) async throws -> JSON {
        let envelope = try await pending.prepare(command)
        let response = try await postCommand(envelope)
        switch response {
        case .success(let result):
            try await pending.finish(envelope)
            return result
        case .definiteFailure(let error):
            try await pending.finish(envelope)
            throw CommandError(code: error.code, message: error.message)
        case .unknown:
            throw MobileError.response("전송 결과가 아직 확인되지 않았습니다. 연결이 회복되면 같은 요청으로 다시 시도됩니다.")
        }
    }

    /// Sends an exact stored envelope again (same requestId, same bytes).
    public func retry(_ envelope: Envelope) async throws -> JSON {
        let response = try await postCommand(envelope)
        switch response {
        case .success(let result):
            try await pending.finish(envelope)
            return result
        case .definiteFailure(let error):
            try await pending.finish(envelope)
            throw CommandError(code: error.code, message: error.message)
        case .unknown:
            throw MobileError.response("전송 결과가 아직 확인되지 않았습니다. 잠시 뒤 다시 확인해 주세요.")
        }
    }

    public func pendingCount() async -> Int {
        (try? await pending.all())?.count ?? 0
    }

    /// Opens the raw byte stream for an authorized request (the SSE endpoint).
    /// Only the initial response crosses the actor; iterating the returned
    /// `AsyncBytes` happens on the caller.
    public func rawBytes(_ request: URLRequest) async throws -> (URLSession.AsyncBytes, HTTPResponse) {
        let (bytes, response) = try await session.bytes(for: authorized(request))
        guard let http = response as? HTTPURLResponse else {
            throw MobileError.response("서버 응답을 확인하지 못했습니다.")
        }
        return (bytes, HTTPResponse(statusCode: http.statusCode))
    }

    private enum CommandOutcome {
        case success(JSON)
        case definiteFailure(ApiErrorBody)
        case unknown
    }

    private func postCommand(_ envelope: Envelope) async throws -> CommandOutcome {
        var request = URLRequest(url: connection.url("/api/commands"))
        request.httpMethod = "POST"
        request.httpBody = envelope.body
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await fetch(request)
        let value = try? JSONDecoder().decode(JSON.self, from: data)
        guard let value else { return .unknown }
        if value["ok"].flag {
            return .success(value["result"])
        }
        let error = value["error"]
        let body = ApiErrorBody(code: error["code"].text, message: error["message"].text)
        if !body.code.isEmpty {
            return .definiteFailure(body)
        }
        // A malformed body on a 2xx/4xx without an error code: the outcome is
        // not provable, so the envelope stays pending.
        return .unknown
    }

    private func get<Response: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> Response {
        let (data, response) = try await fetch(URLRequest(url: connection.url(path, query: query)))
        try Self.checkStatus(response)
        return try JSONDecoder().decode(Response.self, from: data)
    }

    static func checkStatus(_ response: HTTPResponse) throws {
        if (200..<300).contains(response.statusCode) { return }
        switch response.statusCode {
        case 401: throw MobileError.response("기기 연결이 해제됐습니다. 새 연결 코드로 다시 연결해 주세요.")
        case 403: throw MobileError.response("이 기기에 허용되지 않은 내용을 요청했습니다.")
        case 429: throw MobileError.response("요청이 많아 잠시 대기 중입니다. 잠시 뒤 다시 확인해 주세요.")
        default: throw MobileError.response("요청을 처리하지 못했습니다. (\(response.statusCode))")
        }
    }

    private func fetch(_ request: URLRequest) async throws -> (Data, HTTPResponse) {
        let (data, urlResponse) = try await session.data(for: authorized(request))
        guard let http = urlResponse as? HTTPURLResponse else {
            throw MobileError.response("서버 응답을 확인하지 못했습니다.")
        }
        return (data, HTTPResponse(statusCode: http.statusCode))
    }

    private func authorized(_ request: URLRequest) -> URLRequest {
        var request = request
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func percentEncoded(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

/// Canonical `/api` route URL on one origin. Query pairs keep the given
/// order (the events endpoint repeats `conversation`).
public func routeURL(_ origin: URL, path: String, queryPairs: [(String, String)] = []) -> URL {
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
    components.path = path
    if !queryPairs.isEmpty {
        components.queryItems = queryPairs.map { URLQueryItem(name: $0.0, value: $0.1) }
    }
    return components.url!
}

public struct HTTPResponse: Sendable {
    public let statusCode: Int
    public init(statusCode: Int) { self.statusCode = statusCode }
}
