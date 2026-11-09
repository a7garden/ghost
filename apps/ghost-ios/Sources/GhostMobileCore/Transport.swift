import Foundation

public enum MobileError: LocalizedError, Sendable, Equatable {
    case invalidServer, invalidPairingURL, invalidPairingCode, revoked, response(String)

    public var errorDescription: String? {
        switch self {
        case .invalidServer: "서버 주소 형식이 올바르지 않습니다. https:// 또는 로컬 http:// 주소를 입력해 주세요."
        case .invalidPairingURL: "QR 코드가 Ghost 연결 형식이 아닙니다."
        case .invalidPairingCode: "PC 화면의 연결 코드를 입력해 주세요."
        case .revoked: "기기 연결이 해제됐습니다. 새 연결 코드로 다시 연결해 주세요."
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
}

/// Contract `{ ok: false, error: { code, message } }` body.
public struct ApiErrorBody: Codable, Sendable, Equatable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
        self.code = code; self.message = message
    }
}

/// A definitive rejection from the host.
public struct CommandError: Error, Sendable, Equatable {
    public var code: String
    public var message: String
}

/// Canonical `/api` route URL on one origin.
public func routeURL(_ origin: URL, path: String) -> URL {
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
    components.path = path
    return components.url!
}

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
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data), !envelope.error.code.isEmpty {
            // A typed rejection is definitive: the code cannot be used as-is.
            throw CommandError(code: envelope.error.code, message: Self.serverMessage(code: envelope.error.code))
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

private struct ErrorEnvelope: Decodable { let error: ApiErrorBody }

// MARK: - Device client

/// The one call the native shell makes itself: everything else goes through the web UI.
public struct DeviceClient: Sendable {
    public let connection: Connection
    private let session: URLSession

    public init(connection: Connection, session: URLSession? = nil) {
        self.connection = connection
        self.session = session ?? {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 20
            return URLSession(configuration: configuration)
        }()
    }

    private struct PushCommand: Encodable {
        let type = "device.push_register"
        let token: String
        let environment: String
    }

    private struct Request: Encodable {
        let requestId: String
        let command: PushCommand
    }

    private struct Outcome: Decodable {
        let ok: Bool
        let error: ApiErrorBody?
    }

    /// `device.push_register`. Registration replaces the stored token, so a retry
    /// may use a fresh request id.
    public func registerPush(token: String, environment: String) async throws {
        var request = URLRequest(url: routeURL(connection.origin, path: "/api/commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(Request(
            requestId: UUID().uuidString.lowercased(),
            command: PushCommand(token: token, environment: environment)))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MobileError.response("서버 응답을 확인하지 못했습니다.")
        }
        if http.statusCode == 401 { throw MobileError.revoked }
        let outcome = try? JSONDecoder().decode(Outcome.self, from: data)
        if outcome?.ok == true { return }
        if let error = outcome?.error, !error.code.isEmpty { throw CommandError(code: error.code, message: error.message) }
        throw MobileError.response("요청을 처리하지 못했습니다. (\(http.statusCode))")
    }
}
