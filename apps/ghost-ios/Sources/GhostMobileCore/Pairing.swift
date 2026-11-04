import Foundation
import CryptoKit
import Security

// Phone-side pairing core: strict QR connect URIs, the 8-character Crockford
// code, Bonjour TXT origin parsing, the pending-claim state machine, and the
// typed public pairing routes. Secrets (the fresh phone key and the QR
// ticket) are generated on this device and persist only in the injected
// attempt store — the Keychain-backed app store, or an isolated file store in
// tests. Network responses are validated against the frozen contract before
// any state moves; an unknown network outcome never replaces the pending
// attempt, so retries retain the same key, nonce and claim fields.

// MARK: - Strict QR connect URI (ghost://connect?v=1&origin=…&invitation=…&ticket=…)

// One scanned invitation. The origin is a validated canonical HTTPS origin;
// the ticket is a 64-hex secret sent only to the confirmed HTTPS claim route.
public struct PairingInvitation: Sendable, Equatable {
    public let origin: URL
    public let invitationID: UUID
    public let ticket: String

    public init(origin: URL, invitationID: UUID, ticket: String) {
        self.origin = origin
        self.invitationID = invitationID
        self.ticket = ticket
    }
}

public enum PairingQR {
    public static let scheme = "ghost"
    public static let host = "connect"
    public static let version = "1"
    private static let fields: Set<String> = ["v", "origin", "invitation", "ticket"]

    // Parses the exact expected fields and nothing else: one value per field,
    // no extra arguments, no fragment, no credentials, no ports on the deep
    // link itself, and an HTTPS origin without path, query, or fragment.
    // Parsing fails before any network or storage use.
    public static func parse(_ raw: String) throws -> PairingInvitation {
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == scheme,
              components.host?.lowercased() == host,
              components.user == nil, components.password == nil, components.port == nil,
              components.path.isEmpty || components.path == "/",
              components.fragment == nil,
              components.query != nil else {
            throw MobileError.response("QR 코드가 Ghost 연결 형식이 아닙니다.")
        }
        let items = components.queryItems ?? []
        let names = items.map(\.name)
        guard !names.contains(""),
              names.count == fields.count,
              Set(names) == fields,
              Set(names).count == names.count else {
            throw MobileError.response("QR 코드의 항목이 연결 형식과 일치하지 않습니다.")
        }
        func sole(_ name: String) throws -> String {
            let values = items.filter { $0.name == name }.compactMap(\.value)
            guard values.count == 1 else {
                throw MobileError.response("QR 코드의 항목이 연결 형식과 일치하지 않습니다.")
            }
            return values[0]
        }
        guard try sole("v") == version else {
            throw MobileError.response("지원하지 않는 QR 코드 버전입니다.")
        }
        let invitationText = try sole("invitation")
        guard let invitationID = UUID(uuidString: invitationText) else {
            throw MobileError.response("QR 코드의 초대 ID가 올바르지 않습니다.")
        }
        let ticket = try sole("ticket")
        guard ticket.count == 64, ticket.allSatisfy({ $0.isHexDigit }) else {
            throw MobileError.response("QR 코드의 티켓이 올바르지 않습니다.")
        }
        let origin: URL
        do {
            origin = try canonicalHTTPSOrigin(try sole("origin"))
        } catch {
            throw MobileError.response("QR 코드의 서버 주소가 올바르지 않습니다. HTTPS 주소만 연결할 수 있습니다.")
        }
        return PairingInvitation(origin: origin, invitationID: invitationID, ticket: ticket.lowercased())
    }
}

// MARK: - 8-character Crockford pairing code

public enum PairingCode {
    public static let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    // The PC shows XXXX-XXXX; whitespace, hyphens, and case are normalized on
    // both ends. Characters outside the unambiguous alphabet (no I, L, O, U)
    // are rejected — they are never silently mapped onto other digits.
    public static func normalize(_ raw: String) throws -> String {
        let compact = raw.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        guard compact.count == 8, compact.allSatisfy({ alphabet.contains($0) }) else {
            throw MobileError.response("PC 화면의 8자리 연결 코드를 입력해 주세요.")
        }
        return compact
    }
}

// MARK: - Bonjour TXT record

public enum PairingServiceTXT {
    // The advertisement carries `origin=<exact HTTPS origin>` and nothing
    // secret. Anything that is not a canonical HTTPS origin is ignored, so a
    // forged or malformed TXT can never route a claim off the confirmed
    // origin the user then sees and confirms.
    public static func origin(_ record: [String: String]) -> URL? {
        guard let text = record["origin"], !text.isEmpty else { return nil }
        return try? canonicalHTTPSOrigin(text)
    }
}

// MARK: - Scope

// The one scope a new pairing device may receive: the gateway's canonical
// lifetime scope over concrete Ghost·conversation pairs with both read and
// write capability. Arbitrary caller-chosen identifiers or a full owner
// fallback are rejected before approval can move any state.
public func validPairingScope(_ value: JSON) -> Bool {
    guard case .object(let fields) = value,
          Set(fields.keys) == Set(["kind", "ghost_ids", "conversation_ids", "capabilities"]) || Set(fields.keys) == Set(["kind", "ghost_ids", "conversation_ids", "capabilities", "targets"]),
          value["kind"].text == "lifetime",
          case .array(let ghostIDs) = value["ghost_ids"], !ghostIDs.isEmpty,
          case .array(let conversationIDs) = value["conversation_ids"], !conversationIDs.isEmpty,
          case .array(let capabilities) = value["capabilities"], !capabilities.isEmpty else { return false }
    func uniqueCanonicalUUIDs(_ values: [JSON]) -> Bool {
        var seen = Set<String>()
        for item in values {
            let id = item.text
            guard id.count == 36, id == id.lowercased(), UUID(uuidString: id) != nil, seen.insert(id).inserted else { return false }
        }
        return true
    }
    let validBase = uniqueCanonicalUUIDs(ghostIDs)
        && uniqueCanonicalUUIDs(conversationIDs)
        && capabilities.count == 2 && Set(capabilities.map(\.text)).count == capabilities.count
        && capabilities.allSatisfy { !$0.text.isEmpty && $0.text.utf8.count <= 100 }
        && capabilities.contains(.string("lifetime.read"))
        && capabilities.contains(.string("lifetime.write"))
    guard validBase else { return false }
    guard fields["targets"] != nil else { return true } // Existing device receipts remain readable.
    guard case .array(let targets) = value["targets"], !targets.isEmpty, targets.count <= 16 else { return false }
    var pairs = Set<String>(), ghosts = Set<String>(), conversations = Set<String>()
    for target in targets {
        guard case .object(let fields) = target, Set(fields.keys) == Set(["ghost_id", "conversation_id"]),
              uniqueCanonicalUUIDs([target["ghost_id"]]), uniqueCanonicalUUIDs([target["conversation_id"]]) else { return false }
        let ghost = target["ghost_id"].text, conversation = target["conversation_id"].text
        guard pairs.insert("\(ghost)/\(conversation)").inserted else { return false }
        ghosts.insert(ghost); conversations.insert(conversation)
    }
    return ghosts.count == targets.count && conversations.count == targets.count
        && ghosts == Set(ghostIDs.map(\.text)) && conversations == Set(conversationIDs.map(\.text))
}

/// Older grants use ID sets; new grants additionally bind each exact pair.
public func lifetimeScopeAllowsPair(_ scope: JSON, ghostID: String, conversationID: String) -> Bool {
    guard scope["ghost_ids"].items.contains(.string(ghostID)), scope["conversation_ids"].items.contains(.string(conversationID)) else { return false }
    guard scope.dictionary["targets"] != nil else { return true }
    guard case .array(let targets) = scope["targets"] else { return false }
    return targets.contains { $0["ghost_id"].text == ghostID && $0["conversation_id"].text == conversationID }
}

// MARK: - Verification code derivation

public enum PairingVerification {
    // Deterministic check for the 6-digit code the gateway derives:
    // SHA-256 over ASCII "invitationUUID:claimUUID:deviceTokenDigest",
    // the whole hex digest reduced modulo 1e6 by byte iteration (no
    // big-integer type needed — the running value stays below 10^6).
    public static func derive(invitationID: String, claimID: String, keyDigest: String) -> String {
        let seed = Data("\(invitationID):\(claimID):\(keyDigest)".utf8)
        let digest = SHA256.hash(data: seed)
        var remainder: UInt64 = 0
        for byte in digest {
            remainder = (remainder * 256 + UInt64(byte)) % 1_000_000
        }
        return String(remainder).padding(toLength: 6, withPad: "0", startingAt: 0)
    }
}

// MARK: - Attempt record

// The fresh 32-byte device key, generated before any claim, plus the QR
// ticket when the attempt came from a scanned invitation. Hex is lowercase.
public struct PairingSecret: Codable, Sendable, Equatable {
    public let key: String
    public let ticket: String?

    public init(key: String, ticket: String?) {
        self.key = key
        self.ticket = ticket
    }
}

public enum PairingAttemptStatus: String, Codable, Sendable, Equatable {
    case claiming
    case pending
    case approved
    case cancelled
    case expired
    case revoked

    public var isTerminal: Bool { self == .cancelled || self == .expired || self == .revoked }
}

// Everything the pending pairing attempt remembers between launches. The
// matching secret lives beside it in the same store record so the key and
// nonce can never drift apart. `deviceName` is stored exactly as sent — the
// server binds retries to the same request identity and claim fields.
public struct PairingAttempt: Codable, Sendable, Equatable {
    public let requestID: String
    public var invitationID: UUID?
    public let origin: URL
    public let deviceName: String
    public let code: String?
    public var claimID: String?
    public var status: PairingAttemptStatus
    public var verificationCode: String?
    public var scope: JSON?
    public var deviceID: String?
    public var expiresAt: Date?
    public var claimedAt: Date?

    public init(requestID: String, invitationID: UUID?, origin: URL, deviceName: String, code: String?,
                claimID: String? = nil, status: PairingAttemptStatus, verificationCode: String? = nil,
                scope: JSON? = nil, deviceID: String? = nil, expiresAt: Date? = nil, claimedAt: Date? = nil) {
        self.requestID = requestID
        self.invitationID = invitationID
        self.origin = origin
        self.deviceName = deviceName
        self.code = code
        self.claimID = claimID
        self.status = status
        self.verificationCode = verificationCode
        self.scope = scope
        self.deviceID = deviceID
        self.expiresAt = expiresAt
        self.claimedAt = claimedAt
    }
}

public struct PairingRecord: Codable, Sendable, Equatable {
    public var secret: PairingSecret
    public var attempt: PairingAttempt

    public init(secret: PairingSecret, attempt: PairingAttempt) {
        self.secret = secret
        self.attempt = attempt
    }
}

// MARK: - Attempt storage

public protocol PairingAttemptStoring: Sendable {
    func load() throws -> PairingRecord?
    func save(_ record: PairingRecord) throws
    func clear() throws
}

// Isolated file store for tests and previews; the app uses the Keychain
// store. Writes are atomic with complete file protection and 0600, matching
// the pending-command journal convention.
public struct PairingFileStore: PairingAttemptStoring {
    private let file: URL
    private let lock = NSLock()

    public init(file: URL) { self.file = file }

    public func load() throws -> PairingRecord? {
        try lock.withLock {
            guard FileManager.default.fileExists(atPath: file.path) else { return nil }
            return try JSONDecoder().decode(PairingRecord.self, from: Data(contentsOf: file))
        }
    }

    public func save(_ record: PairingRecord) throws {
        let data = try JSONEncoder().encode(record)
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

// MARK: - Typed public pairing client

public enum PairingCredential: Sendable, Equatable {
    case code(String)
    case invitation(id: UUID, ticket: String)
}

public struct PairingClaimReceipt: Sendable, Equatable {
    public let claimID: String
    public let invitationID: UUID
    public let origin: URL
    public let expiresAt: Date
    public let verificationCode: String
    public let scope: JSON
}

public enum PairingClaimOutcome: Sendable, Equatable {
    case pending
    case approved(deviceID: String)
    case cancelled
    case expired
    case revoked
}

public struct PairingClaimStatusReport: Sendable, Equatable {
    public let claimID: String
    public let invitationID: UUID
    public let origin: URL
    public let expiresAt: Date
    public let outcome: PairingClaimOutcome
    public let verificationCode: String
    public let scope: JSON
}

// Talks to the configured confirmed HTTPS origin only. Redirects are refused
// at the session layer, so the candidate key header can never cross to
// another host. No key material is logged anywhere in this client.
public actor PairingClient {
    public let origin: URL
    private let session: URLSession

    public init(origin: URL, session: URLSession? = nil) {
        self.origin = origin
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 65
            configuration.timeoutIntervalForResource = 70
            self.session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        }
    }

    public func submitClaim(requestID: UUID, deviceName: String, keyDigest: String, credential: PairingCredential) async throws -> PairingClaimReceipt {
        var fields: [String: JSON] = [
            "request_id": .string(requestID.uuidString.lowercased()),
            "device_name": .string(deviceName),
            "device_token_digest": .string(keyDigest),
        ]
        switch credential {
        case .code(let code):
            fields["code"] = .string(code)
        case .invitation(let id, let ticket):
            fields["invitation_id"] = .string(id.uuidString.lowercased())
            fields["ticket"] = .string(ticket)
        }
        let value = try await send("pairing/claims", body: JSONEncoder().encode(JSON.object(fields)), authorization: nil)
        return try Self.receipt(value, expectedOrigin: origin)
    }

    public func claimStatus(claimID: UUID, requestID: UUID, key: String) async throws -> PairingClaimStatusReport {
        let body = JSON.object(["request_id": .string(requestID.uuidString.lowercased())])
        let value = try await send("pairing/claims/\(claimID.uuidString.lowercased())/status",
            body: JSONEncoder().encode(body), authorization: "Bearer \(key)")
        return try Self.report(value, claimID: claimID, expectedOrigin: origin)
    }

    // One capped, redirect-refusing request. Non-200 answers surface the
    // server's error code verbatim; nothing here mutates pairing state.
    private func send(_ path: String, body: Data, authorization: String?) async throws -> JSON {
        var request = URLRequest(url: origin.appending(path: path))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MobileError.response("서버 응답을 확인하지 못했습니다.")
        }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 1_048_576 else { throw MobileError.response("서버 응답이 너무 큽니다.") }
            data.append(byte)
        }
        guard (200..<300).contains(http.statusCode) else {
            let value = (try? JSONDecoder().decode(JSON.self, from: data)) ?? .null
            throw MobileError.response(Self.serverMessage(code: value["error"].text))
        }
        return try JSONDecoder().decode(JSON.self, from: data)
    }

    private static func serverMessage(code: String) -> String {
        switch code {
        case "invitation_not_found": "연결 코드 또는 초대를 찾을 수 없습니다. PC 화면의 코드를 다시 확인해 주세요."
        case "invitation_not_available": "이 초대는 만료되었거나 이미 사용되었습니다. PC에서 새 연결을 만들어 주세요."
        case "claim_conflict": "같은 요청 ID로 다른 내용이 접수되어 거절되었습니다."
        case "pairing_rate_limited": "연결 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."
        case "invalid_claim_request", "invalid_status_request": "연결 요청 형식이 서버와 일치하지 않습니다."
        case "claim_not_found": "진행 중인 연결 요청을 찾을 수 없습니다."
        case "pairing_unconfigured": "서버에서 기기 연결 기능이 아직 설정되지 않았습니다."
        case let code where !code.isEmpty: "서버가 연결 요청을 거절했습니다. (\(code))"
        default: "연결 요청을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요."
        }
    }

    private static func hexDate(_ value: JSON) throws -> Date {
        let text = value.text
        guard !text.isEmpty else { throw MobileError.response("서버 응답의 만료 시각이 올바르지 않습니다.") }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: text) { return date }
        throw MobileError.response("서버 응답의 만료 시각이 올바르지 않습니다.")
    }

    private static func canonicalEcho(_ value: JSON) throws -> URL {
        do { return try canonicalHTTPSOrigin(value.text) }
        catch { throw MobileError.response("서버가 다른 주소로 연결을 안내했습니다. 원래 요청은 보존되었습니다.") }
    }

    private static func sixDigit(_ value: JSON) throws -> String {
        let text = value.text
        guard text.count == 6, text.allSatisfy({ $0.isNumber }) else {
            throw MobileError.response("서버 응답의 확인 코드가 올바르지 않습니다.")
        }
        return text
    }

    private static func canonicalUUID(_ value: JSON) throws -> UUID {
        let text = value.text
        guard text.count == 36, text == text.lowercased(), let id = UUID(uuidString: text) else {
            throw MobileError.response("서버 응답의 초대 ID가 올바르지 않습니다.")
        }
        return id
    }

    static func receipt(_ value: JSON, expectedOrigin: URL) throws -> PairingClaimReceipt {
        guard Set(value.dictionary.keys) == ["claim_id", "invitation_id", "origin", "expires_at", "status", "verification_code", "scope"],
              value["status"].text == "pending",
              value["claim_id"].text.count == 36,
              value["claim_id"].text == value["claim_id"].text.lowercased(),
              UUID(uuidString: value["claim_id"].text) != nil else {
            throw MobileError.response("서버의 연결 접수 응답이 계약과 일치하지 않습니다.")
        }
        let invitationID = try canonicalUUID(value["invitation_id"])
        let echo = try canonicalEcho(value["origin"])
        guard echo == expectedOrigin else {
            throw MobileError.response("서버가 다른 주소로 연결을 안내했습니다. 원래 요청은 보존되었습니다.")
        }
        let scope = value["scope"]
        guard validPairingScope(scope) else {
            throw MobileError.response("서버가 안내한 기기 권한 범위가 계약과 일치하지 않습니다.")
        }
        return PairingClaimReceipt(
            claimID: value["claim_id"].text,
            invitationID: invitationID,
            origin: echo,
            expiresAt: try hexDate(value["expires_at"]),
            verificationCode: try sixDigit(value["verification_code"]),
            scope: scope)
    }

    static func report(_ value: JSON, claimID: UUID, expectedOrigin: URL) throws -> PairingClaimStatusReport {
        var expectedKeys: Set<String> = ["claim_id", "invitation_id", "origin", "expires_at", "status", "verification_code", "scope"]
        let status = value["status"].text
        if status == "approved" { expectedKeys.insert("device_id") }
        guard Set(value.dictionary.keys) == expectedKeys,
              ["pending", "approved", "cancelled", "expired", "revoked"].contains(status) else {
            throw MobileError.response("서버의 연결 상태 응답이 계약과 일치하지 않습니다.")
        }
        guard value["claim_id"].text == claimID.uuidString.lowercased() else {
            throw MobileError.response("서버가 다른 연결 요청의 상태를 보냈습니다.")
        }
        let invitationID = try canonicalUUID(value["invitation_id"])
        let echo = try canonicalEcho(value["origin"])
        guard echo == expectedOrigin else {
            throw MobileError.response("서버가 다른 주소로 연결을 안내했습니다. 원래 요청은 보존되었습니다.")
        }
        let scope = value["scope"]
        guard validPairingScope(scope) else {
            throw MobileError.response("서버가 안내한 기기 권한 범위가 계약과 일치하지 않습니다.")
        }
        let outcome: PairingClaimOutcome
        switch status {
        case "approved":
            let deviceID = value["device_id"].text
            guard deviceID.count == 36, deviceID == deviceID.lowercased(), UUID(uuidString: deviceID) != nil else {
                throw MobileError.response("승인 응답에 기기 ID가 없습니다. 원래 요청은 보존되었습니다.")
            }
            outcome = .approved(deviceID: deviceID)
        case "cancelled": outcome = .cancelled
        case "expired": outcome = .expired
        case "revoked": outcome = .revoked
        default: outcome = .pending
        }
        return PairingClaimStatusReport(
            claimID: claimID.uuidString.lowercased(),
            invitationID: invitationID,
            origin: echo,
            expiresAt: try hexDate(value["expires_at"]),
            outcome: outcome,
            verificationCode: try sixDigit(value["verification_code"]),
            scope: scope)
    }
}

// MARK: - Pending attempt session

public func defaultPairingKey() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else {
        throw MobileError.response("이 기기의 연결 키를 안전하게 만들지 못했습니다.")
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
}

func pairingKeyDigest(_ key: String) -> String {
    SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
}

// Owns the one pending pairing attempt. The record (fresh key + nonce +
// origin + status) is persisted BEFORE the first claim leaves the device,
// and an unknown network outcome never regenerates either — only an
// explicit cancel clears it.
public actor PairingSession {
    private let store: PairingAttemptStoring
    private let makeClient: @Sendable (URL) -> PairingClient
    private let makeKey: @Sendable () throws -> String
    private let now: @Sendable () -> Date
    private var record: PairingRecord?

    public init(store: PairingAttemptStoring,
                makeClient: @escaping @Sendable (URL) -> PairingClient = { PairingClient(origin: $0) },
                makeKey: @escaping @Sendable () throws -> String = { try defaultPairingKey() },
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.makeClient = makeClient
        self.makeKey = makeKey
        self.now = now
    }

    public func restore() -> PairingAttempt? {
        if let record { return record.attempt }
        guard let stored = try? store.load() else { return nil }
        record = stored
        return stored.attempt
    }

    public func cancel() throws {
        record = nil
        try store.clear()
    }

    // Called after a completed pairing has been adopted into the saved
    // connection: the attempt served its purpose and must not resurrect.
    public func discardAdopted() throws {
        guard let current = record, current.attempt.status == .approved || current.attempt.status == .pending else {
            record = nil
            try? store.clear()
            return
        }
        record = nil
        try store.clear()
    }

    // MARK: Begin

    public func begin(invitation: PairingInvitation, deviceName: String) throws -> PairingAttempt {
        try begin(intent: .invitation(invitation), deviceName: deviceName)
    }

    public func begin(code: String, origin: URL, deviceName: String) throws -> PairingAttempt {
        try begin(intent: .code(code, origin), deviceName: deviceName)
    }

    private enum Intent {
        case invitation(PairingInvitation)
        case code(String, URL)
    }

    private func begin(intent: Intent, deviceName: String) throws -> PairingAttempt {
        let name = try Self.validDeviceName(deviceName)
        if let current = record, !current.attempt.status.isTerminal {
            guard Self.matches(current.attempt, intent), current.attempt.deviceName == name else {
                throw MobileError.response("이미 진행 중인 연결 요청이 있습니다. 취소한 뒤 다시 시도해 주세요.")
            }
            // Same invitation and name: resume the exact pending attempt —
            // the same key and nonce, never a regeneration.
            return current.attempt
        }
        let key = try makeKey()
        try Self.validKey(key)
        let attempt: PairingAttempt
        let secret: PairingSecret
        switch intent {
        case .invitation(let value):
            attempt = PairingAttempt(requestID: UUID().uuidString.lowercased(), invitationID: value.invitationID,
                origin: value.origin, deviceName: name, code: nil, status: .claiming)
            secret = PairingSecret(key: key, ticket: value.ticket)
        case .code(let code, let origin):
            attempt = PairingAttempt(requestID: UUID().uuidString.lowercased(), invitationID: nil,
                origin: origin, deviceName: name, code: code, status: .claiming)
            secret = PairingSecret(key: key, ticket: nil)
        }
        let fresh = PairingRecord(secret: secret, attempt: attempt)
        // Durable before any network use: a crash here leaves no claim, and a
        // relaunch resumes the same key and nonce.
        try store.save(fresh)
        record = fresh
        return attempt
    }

    // MARK: Claim (idempotent, exact payload)

    public func submit() async throws -> PairingAttempt {
        guard let current = record else { throw MobileError.response("진행 중인 연결 요청이 없습니다.") }
        guard current.attempt.status == .claiming, current.attempt.claimID == nil else { return current.attempt }
        let credential: PairingCredential
        if let code = current.attempt.code {
            credential = .code(code)
        } else {
            guard let invitationID = current.attempt.invitationID, let ticket = current.secret.ticket else {
                throw MobileError.response("저장된 연결 요청이 손상되었습니다. 취소한 뒤 다시 시도해 주세요.")
            }
            credential = .invitation(id: invitationID, ticket: ticket)
        }
        let client = makeClient(current.attempt.origin)
        let digest = pairingKeyDigest(current.secret.key)
        guard let requestID = UUID(uuidString: current.attempt.requestID) else {
            throw MobileError.response("저장된 연결 요청이 손상되었습니다. 취소한 뒤 다시 시도해 주세요.")
        }
        // A rejection here (network unknown, server refusal, malformed
        // reply) intentionally leaves the persisted attempt untouched; the
        // exact same request is what a resume re-sends.
        let receipt = try await client.submitClaim(requestID: requestID,
            deviceName: current.attempt.deviceName, keyDigest: digest, credential: credential)
        try Self.checkReceipt(receipt, attempt: current.attempt, keyDigest: digest)
        var updated = current.attempt
        updated.claimID = receipt.claimID
        if updated.invitationID == nil { updated.invitationID = receipt.invitationID }
        updated.status = .pending
        updated.verificationCode = receipt.verificationCode
        updated.scope = receipt.scope
        updated.expiresAt = receipt.expiresAt
        updated.claimedAt = now()
        let settled = PairingRecord(secret: current.secret, attempt: updated)
        try store.save(settled)
        record = settled
        return updated
    }

    // MARK: Status poll (candidate key is the proof)

    public func pollOnce() async throws -> PairingAttempt {
        guard let current = record, let claimID = current.attempt.claimID,
              let claimUUID = UUID(uuidString: claimID),
              let requestUUID = UUID(uuidString: current.attempt.requestID) else {
            throw MobileError.response("연결 요청이 아직 서버에 접수되지 않았습니다. 다시 시도해 주세요.")
        }
        guard current.attempt.status == .pending || current.attempt.status == .approved
              || current.attempt.status == .expired else {
            throw MobileError.response("이미 종료된 연결 요청입니다.")
        }
        let client = makeClient(current.attempt.origin)
        let report = try await client.claimStatus(claimID: claimUUID, requestID: requestUUID, key: current.secret.key)
        try Self.checkReport(report, attempt: current.attempt)
        var updated = current.attempt
        updated.invitationID = report.invitationID
        updated.verificationCode = report.verificationCode
        updated.scope = report.scope
        updated.expiresAt = report.expiresAt
        switch report.outcome {
        case .pending:
            // The server TTL is authoritative; a locally past expiry is
            // reported as expired without discarding the attempt (a resume
            // still polls the server's final word).
            updated.status = now() > report.expiresAt ? .expired : .pending
        case .approved(let deviceID):
            updated.status = .approved
            updated.deviceID = deviceID
        case .cancelled: updated.status = .cancelled
        case .expired: updated.status = .expired
        case .revoked: updated.status = .revoked
        }
        let settled = PairingRecord(secret: current.secret, attempt: updated)
        try store.save(settled)
        record = settled
        return updated
    }

    // MARK: Approval

    // Only an approved attempt bound to the same invitation, origin, and
    // scope yields a credential; stale, cancelled, expired, or revoked
    // attempts can never connect.
    public func approvedCredential() throws -> (origin: String, key: String) {
        guard let current = record else { throw MobileError.response("진행 중인 연결 요청이 없습니다.") }
        guard current.attempt.status == .approved,
              current.attempt.claimID != nil,
              current.attempt.invitationID != nil,
              current.attempt.deviceID != nil,
              validPairingScope(current.attempt.scope ?? .null) else {
            throw MobileError.response("아직 승인된 연결이 아닙니다. PC에서 확인을 마친 뒤 다시 시도해 주세요.")
        }
        return (origin: current.attempt.origin.absoluteString, key: current.secret.key)
    }

    // MARK: Shared validation

    static func validDeviceName(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, (raw as NSString).length <= 100 else {
            throw MobileError.response("이 기기의 이름을 100자 이내로 입력해 주세요.")
        }
        return raw
    }

    static func validKey(_ key: String) throws {
        guard key.count == 64, key.allSatisfy({ "0123456789abcdef".contains($0) }) else {
            throw MobileError.response("이 기기의 연결 키를 안전하게 만들지 못했습니다.")
        }
    }

    private static func matches(_ attempt: PairingAttempt, _ intent: Intent) -> Bool {
        switch intent {
        case .invitation(let value):
            return attempt.invitationID == value.invitationID && attempt.origin == value.origin
        case .code(let code, let origin):
            return attempt.code == code && attempt.origin == origin
        }
    }

    static func checkReceipt(_ receipt: PairingClaimReceipt, attempt: PairingAttempt, keyDigest: String) throws {
        guard receipt.origin == attempt.origin else {
            throw MobileError.response("서버가 다른 주소로 연결을 안내했습니다. 원래 요청은 보존되었습니다.")
        }
        if let invitationID = attempt.invitationID, receipt.invitationID != invitationID {
            throw MobileError.response("서버가 다른 초대의 접수를 보냈습니다. 원래 요청은 보존되었습니다.")
        }
        guard receipt.verificationCode == PairingVerification.derive(
            invitationID: receipt.invitationID.uuidString.lowercased(),
            claimID: receipt.claimID,
            keyDigest: keyDigest) else {
            throw MobileError.response("확인 코드가 이 요청과 일치하지 않습니다. 원래 요청은 보존되었습니다.")
        }
    }

    static func checkReport(_ report: PairingClaimStatusReport, attempt: PairingAttempt) throws {
        guard report.origin == attempt.origin else {
            throw MobileError.response("서버가 다른 주소로 연결을 안내했습니다. 원래 요청은 보존되었습니다.")
        }
        guard report.invitationID == attempt.invitationID else {
            throw MobileError.response("연결 상태가 다른 초대를 가리킵니다. 원래 요청은 보존되었습니다.")
        }
        guard report.scope == attempt.scope else {
            throw MobileError.response("승인된 기기 권한 범위가 접수 때와 달라졌습니다. 원래 요청은 보존되었습니다.")
        }
        if case .approved = report.outcome {
            guard attempt.scope != nil else {
                throw MobileError.response("승인된 기기 권한 범위를 확인하지 못했습니다.")
            }
        }
    }
}
