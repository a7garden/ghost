import Foundation

// Phone-side pairing: strict `ghost://pair?origin=…&code=…` URLs (scanned or
// opened), or typing the origin and code by hand, then one claim against the
// paired origin. The host answers with this device's id and bearer token;
// both persist only in the injected attempt store — the Keychain-backed app
// store, or an isolated file store in tests.

// MARK: - Strict pairing URL (ghost://pair?origin=…&code=…)

public struct PairingOffer: Sendable, Equatable {
    public let origin: URL
    public let code: String

    public init(origin: URL, code: String) {
        self.origin = origin
        self.code = code
    }
}

public enum PairingQR {
    public static let scheme = "ghost"
    public static let host = "pair"
    private static let fields: Set<String> = ["origin", "code"]

    // Parses the exact expected fields and nothing else: one value per field,
    // no extra arguments, no fragment, no credentials, and an origin that is
    // a canonical http(s) origin (plain HTTP only for loopback hosts).
    // Parsing fails before any network or storage use.
    public static func parse(_ raw: String) throws -> PairingOffer {
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == scheme,
              components.host?.lowercased() == host,
              components.user == nil, components.password == nil, components.port == nil,
              components.path.isEmpty || components.path == "/",
              components.fragment == nil,
              components.query != nil else {
            throw MobileError.invalidPairingURL
        }
        let items = components.queryItems ?? []
        let names = items.map(\.name)
        guard !names.contains(""),
              names.count == fields.count,
              Set(names) == fields else {
            throw MobileError.invalidPairingURL
        }
        let code = items.first(where: { $0.name == "code" })?.value ?? ""
        guard (6...32).contains(code.count) else { throw MobileError.invalidPairingCode }
        let originText = items.first(where: { $0.name == "origin" })?.value ?? ""
        let origin: URL
        do {
            origin = try canonicalOrigin(originText)
        } catch {
            throw MobileError.response("QR 코드의 서버 주소가 올바르지 않습니다. https:// 또는 로컬 http:// 주소만 연결할 수 있습니다.")
        }
        return PairingOffer(origin: origin, code: code)
    }

    /// Builds the URL the owner-side UI shows as a QR code.
    public static func build(origin: URL, code: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.queryItems = [
            URLQueryItem(name: "origin", value: origin.absoluteString),
            URLQueryItem(name: "code", value: code),
        ]
        return components.url
    }
}

// MARK: - Pairing attempt

/// A pairing run in progress: the confirmed offer plus the device name that
/// will claim it. Survives relaunch through the injected store so an
/// interrupted claim is retried instead of silently dropped.
public struct PairingAttempt: Codable, Sendable, Equatable {
    public let origin: URL
    public let code: String
    public let deviceName: String

    public init(origin: URL, code: String, deviceName: String) {
        self.origin = origin
        self.code = code
        self.deviceName = deviceName
    }
}

public protocol PairingAttemptStoring: Sendable {
    func load() throws -> PairingAttempt?
    func save(_ attempt: PairingAttempt) throws
    func clear() throws
}

/// Isolated file store for tests and previews; the app uses the Keychain store.
public struct PairingFileStore: PairingAttemptStoring {
    private let file: URL
    private let lock = NSLock()

    public init(file: URL) { self.file = file }

    public func load() throws -> PairingAttempt? {
        try lock.withLock {
            guard FileManager.default.fileExists(atPath: file.path) else { return nil }
            return try JSONDecoder().decode(PairingAttempt.self, from: Data(contentsOf: file))
        }
    }

    public func save(_ attempt: PairingAttempt) throws {
        let data = try JSONEncoder().encode(attempt)
        try lock.withLock {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if os(iOS)
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: file, options: .atomic)
            #endif
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
    }

    public func clear() throws {
        try lock.withLock {
            guard FileManager.default.fileExists(atPath: file.path) else { return }
            try FileManager.default.removeItem(at: file)
        }
    }
}

/// Owns the one pending pairing attempt and the claim call. The attempt is
/// persisted before the claim leaves the device; an unknown network outcome
/// never replaces it — only an explicit retry (same body) or cancel does.
public actor PairingSession {
    private let store: PairingAttemptStoring
    private let makeClient: @Sendable (URL) -> PairingClient
    private var record: PairingAttempt?

    public init(store: PairingAttemptStoring,
                makeClient: @escaping @Sendable (URL) -> PairingClient = { PairingClient(origin: $0) }) {
        self.store = store
        self.makeClient = makeClient
    }

    public func restore() -> PairingAttempt? {
        if let record { return record }
        guard let stored = try? store.load() else { return nil }
        record = stored
        return stored
    }

    /// Called after a completed pairing has been adopted into the saved
    /// connection: the attempt served its purpose and must not resurrect.
    public func discard() {
        record = nil
        try? store.clear()
    }

    public func begin(_ offer: PairingOffer, deviceName: String) throws -> PairingAttempt {
        let name = Self.validDeviceName(deviceName)
        let attempt = PairingAttempt(origin: offer.origin, code: offer.code, deviceName: name)
        try store.save(attempt)
        record = attempt
        return attempt
    }

    /// One claim. The same origin, code, and device name are sent on every
    /// retry; a definitive rejection clears the attempt, an unknown outcome
    /// keeps it so the retry re-sends identical bytes.
    public func claim() async throws -> PairingResult {
        guard let attempt = record ?? restore() else {
            throw MobileError.response("진행 중인 연결 요청이 없습니다. QR 코드를 스캔하거나 코드를 입력해 주세요.")
        }
        record = attempt
        let client = makeClient(attempt.origin)
        do {
            let result = try await client.claim(code: attempt.code, deviceName: attempt.deviceName)
            try store.clear()
            record = nil
            return result
        } catch let error as CommandError where error.code == "conflict" || error.code == "not_found" {
            try store.clear()
            record = nil
            throw error
        }
    }

    public func cancel() {
        record = nil
        try? store.clear()
    }

    public static func validDeviceName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "내 iPhone" }
        return String(trimmed.prefix(100))
    }
}
