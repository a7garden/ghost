import Foundation

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
public struct Connection: Codable, Sendable, Equatable {
    public let origin: URL
    public let token: String
    public init(server: String, token: String) throws {
        guard var u = URLComponents(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
              u.scheme?.lowercased() == "https", let host = u.host, !host.isEmpty,
              u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
              u.path.isEmpty || u.path == "/",
              u.port == nil || (1...65535).contains(u.port!) else { throw MobileError.invalidServer }
        u.scheme = "https"; u.host = host.lowercased(); u.path = ""
        if u.port == 443 { u.port = nil }
        guard let url = u.url else { throw MobileError.invalidServer }
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanToken.count == 64, cleanToken.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw MobileError.invalidToken }
        self.origin = url; self.token = cleanToken
    }
    public func url(_ path: String) -> URL { origin.appending(path: path) }
}

public struct Envelope: Codable, Sendable, Equatable {
    public let request_id: String
    public let command: JSON
    public init(command: JSON) { self.request_id = UUID().uuidString.lowercased(); self.command = command }
}

// Persist before dispatch. Explicit retries reuse the same ID after disconnects
// or app restarts; no pending command is automatically replayed.
public actor PendingCommands {
    private let file: URL
    public init(file: URL) { self.file = file }
    private func read() throws -> [Envelope] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try JSONDecoder().decode([Envelope].self, from: Data(contentsOf: file))
    }
    private func write(_ values: [Envelope]) throws {
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
        if let existing = values.first(where: { $0.command == command }) { return existing }
        let envelope = Envelope(command: command)
        values.append(envelope); try write(values); return envelope
    }
    public func finish(_ envelope: Envelope) throws { try write(read().filter { $0.request_id != envelope.request_id }) }
    public func all() throws -> [Envelope] { try read() }
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
    private let pendingFile: URL
    private let session: URLSession
    public init(connection: Connection, pendingFile: URL) {
        self.connection = connection; self.pendingFile = pendingFile.standardizedFileURL
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 65; config.timeoutIntervalForResource = 70
        self.session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    public func get(_ path: String) async throws -> JSON { try await request(path, body: nil) }
    public func pendingCommands() async throws -> [Envelope] { try await JournalRegistry.shared.commands(at: pendingFile).all() }
    public func acknowledge(_ envelope: Envelope) async throws { try await JournalRegistry.shared.commands(at: pendingFile).finish(envelope) }
    public func action(_ command: JSON) async throws -> JSON {
        let pending = await JournalRegistry.shared.commands(at: pendingFile)
        let envelope = try await pending.prepare(command)
        let response = try await request("mobile/v1/action", body: JSONEncoder().encode(envelope))
        guard response["ok"].flag else { throw MobileError.response(response["error"].text) }
        try await pending.finish(envelope)
        return response["result"]
    }
    private func request(_ path: String, body: Data?) async throws -> JSON {
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
        guard (200..<300).contains(http.statusCode) || http.statusCode == 409 else { throw MobileError.response("요청 결과를 확인하지 못했습니다. 연결을 확인한 뒤 같은 요청으로 다시 시도해 주세요.") }
        return try JSONDecoder().decode(JSON.self, from: data)
    }
}
