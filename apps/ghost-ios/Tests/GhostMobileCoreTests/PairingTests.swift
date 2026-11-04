import Foundation
import CryptoKit
import Testing
@testable import GhostMobileCore

// Deterministic, isolated pairing-core tests: strict QR URI parsing, code
// normalization, TXT origins, the verification-code derivation, and the
// pending-attempt lifecycle (persist-before-network, byte-identical retry
// after an unknown outcome, candidate-key status proof, approval binding,
// and the terminal states that can never connect). The stub transport
// answers on hosts under `.stub.invalid` only; storage uses temp-dir file
// stores, never the Keychain.

private struct PairingStubResponse: @unchecked Sendable {
    let statusCode: Int?
    let body: Data
    let failure: URLError?

    init(statusCode: Int, body: Data) { self.statusCode = statusCode; self.body = body; self.failure = nil }
    init(failure: URLError) { self.statusCode = nil; self.body = Data(); self.failure = failure }
}

private final class PairingStubRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [PairingStubResponse]
    private var capturedRequests: [(path: String, body: Data, authorization: String?)] = []

    init(_ responses: [PairingStubResponse]) {
        self.responses = responses
    }

    func setResponses(_ values: [PairingStubResponse]) {
        lock.lock(); defer { lock.unlock() }
        responses = values
    }

    func take(_ request: URLRequest, body: Data) -> PairingStubResponse {
        lock.lock()
        defer { lock.unlock() }
        capturedRequests.append((request.url?.path ?? "", body, request.value(forHTTPHeaderField: "Authorization")))
        guard !responses.isEmpty else { return PairingStubResponse(statusCode: 500, body: Data()) }
        return responses.removeFirst()
    }

    func captured() -> [(path: String, body: Data, authorization: String?)] {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequests
    }
}

private final class PairingStubRegistry: @unchecked Sendable {
    static let shared = PairingStubRegistry()
    private let lock = NSLock()
    private var recorders: [String: PairingStubRecorder] = [:]

    func install(_ recorder: PairingStubRecorder, host: String) {
        lock.lock(); defer { lock.unlock() }
        recorders[host] = recorder
    }

    func remove(host: String) {
        lock.lock(); defer { lock.unlock() }
        recorders.removeValue(forKey: host)
    }

    func take(_ request: URLRequest) -> PairingStubResponse? {
        guard let host = request.url?.host else { return nil }
        lock.lock(); defer { lock.unlock() }
        guard let recorder = recorders[host] else { return nil }
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            let readable = withUnsafeTemporaryAllocation(of: UInt8.self, capacity: 4096) { buffer -> Bool in
                while true {
                    let count = stream.read(buffer.baseAddress!, maxLength: buffer.count)
                    if count < 0 || body.count + max(count, 0) > 1_048_576 { return false }
                    if count == 0 { return true }
                    body.append(buffer.baseAddress!, count: count)
                }
            }
            if !readable { return PairingStubResponse(failure: URLError(.cannotDecodeContentData)) }
        }
        return recorder.take(request, body: body)
    }
}

private final class PairingStubURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".stub.invalid") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let reply = PairingStubRegistry.shared.take(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        if let failure = reply.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
        guard let url = request.url, let statusCode = reply.statusCode,
              let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func encodedJSON(_ value: JSON) -> Data {
    (try? JSONEncoder().encode(value)) ?? Data()
}

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PairingStubURLProtocol.self]
    return URLSession(configuration: configuration)
}

private let invitationID = UUID(uuidString: "2F0C9DBC-1E5A-4B8E-9A1F-0C9DBC1E5A4B")!
private let ticket = String(repeating: "ab", count: 32)
private let key1 = String(repeating: "11", count: 32)
private let key2 = String(repeating: "22", count: 32)
private let keyDigest1 = SHA256.hash(data: Data(key1.utf8)).map { String(format: "%02x", $0) }.joined()
private let claimID = "00000000-0000-4000-8000-000000000001"
private let deviceID = "00000000-0000-4000-8000-0000000000ab"
private let expiresAt = "2026-10-12T09:05:00.000Z"
private let frozenNow = Date(timeIntervalSince1970: 1_781_193_600)

private func pairingScope(ghost: String = UUID().uuidString.lowercased(), conversation: String = UUID().uuidString.lowercased()) -> JSON {
    .object([
        "kind": .string("lifetime"),
        "ghost_ids": .array([.string(ghost)]),
        "conversation_ids": .array([.string(conversation)]),
        "capabilities": .array([.string("lifetime.read"), .string("lifetime.write")]),
    ])
}

private func receiptJSON(origin: String, invitation: UUID = invitationID, claim: String = claimID,
                         code: String = "430599", scope: JSON = pairingScope()) -> JSON {
    .object([
        "claim_id": .string(claim),
        "invitation_id": .string(invitation.uuidString.lowercased()),
        "origin": .string(origin),
        "expires_at": .string(expiresAt),
        "status": .string("pending"),
        "verification_code": .string(code),
        "scope": scope,
    ])
}

private func statusJSON(status: String, origin: String, invitation: UUID = invitationID, claim: String = claimID,
                        code: String = "430599", scope: JSON = pairingScope(), device: String? = nil) -> JSON {
    var fields: [String: JSON] = [
        "claim_id": .string(claim),
        "invitation_id": .string(invitation.uuidString.lowercased()),
        "origin": .string(origin),
        "expires_at": .string(expiresAt),
        "status": .string(status),
        "verification_code": .string(code),
        "scope": scope,
    ]
    if let device { fields["device_id"] = .string(device) }
    return .object(fields)
}

private func tempPairingFile() -> URL {
    FileManager.default.temporaryDirectory
        .appending(path: "pairing-tests-\(UUID().uuidString)")
        .appending(path: "attempt.json")
}

private final class KeyIssuer: @unchecked Sendable {
    private let lock = NSLock()
    private let keys: [String]
    private var index = 0
    init(_ keys: [String]) { self.keys = keys }
    func next() -> String {
        lock.lock(); defer { lock.unlock() }
        defer { index += 1 }
        return keys[min(index, keys.count - 1)]
    }
}

// One stubbed origin with its recorder and a session bound to it.
private final class TestContext: @unchecked Sendable {
    let host: String
    let origin: URL
    let store: PairingFileStore
    let recorder: PairingStubRecorder
    let session: PairingSession

    init(keys: [String] = [key1]) {
        host = "\(UUID().uuidString.lowercased()).stub.invalid"
        origin = URL(string: "https://\(host)")!
        store = PairingFileStore(file: tempPairingFile())
        recorder = PairingStubRecorder([])
        PairingStubRegistry.shared.install(recorder, host: host)
        let issuer = KeyIssuer(keys)
        session = PairingSession(
            store: store,
            makeClient: { [origin] _ in PairingClient(origin: origin, session: stubSession()) },
            makeKey: { issuer.next() },
            now: { frozenNow })
    }

    func drop() {
        PairingStubRegistry.shared.remove(host: host)
    }
}

private func percentEncode(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

private func scannedInvitation(origin: URL) throws -> PairingInvitation {
    try PairingQR.parse("ghost://connect?v=1&origin=\(percentEncode(origin.absoluteString))&invitation=\(invitationID.uuidString)&ticket=\(ticket)")
}

// MARK: - Strict QR URI parsing

@Test func parsesCanonicalQRInvitation() throws {
    let raw = "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)"
    let parsed = try PairingQR.parse(raw)
    #expect(parsed.origin.absoluteString == "https://ghost.example.com")
    #expect(parsed.invitationID == invitationID)
    #expect(parsed.ticket == ticket)
}

@Test func normalizesSchemeHostCaseAndDefaultPort() throws {
    let raw = "GHOST://CONNECT/?v=1&origin=HTTPS%3A%2F%2FGHOST.Example.COM%3A443&invitation=2F0C9DBC-1E5A-4B8E-9A1F-0C9DBC1E5A4B&ticket=\(ticket.uppercased())"
    let parsed = try PairingQR.parse(raw)
    #expect(parsed.origin.absoluteString == "https://ghost.example.com")
    #expect(parsed.ticket == ticket)
}

@Test func keepsExplicitNonDefaultPort() throws {
    let raw = "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com%3A8443&invitation=\(invitationID.uuidString)&ticket=\(ticket)"
    #expect(try PairingQR.parse(raw).origin.absoluteString == "https://ghost.example.com:8443")
}

@Test func rejectsMaliciousOrMalformedQR() {
    let good = "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)"
    let bad: [String] = [
        // Wrong scheme, host, credentials, port, or path on the deep link itself.
        "ghosts://connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "https://connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://pair?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://connect:443?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://user:secret@connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://connect/v2?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        // Extra, duplicate, or missing fields; wrong version.
        good + "&extra=1",
        good.replacingOccurrences(of: "v=1&", with: "v=1&v=2&"),
        good.replacingOccurrences(of: "&ticket=\(ticket)", with: ""),
        good.replacingOccurrences(of: "?v=1", with: "?v=2"),
        "ghost://connect?v=1&origin=&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        good + "#tracking",
        // Non-origin targets.
        "ghost://connect?v=1&origin=http%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://connect?v=1&origin=javascript%3Aalert(1)&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://connect?v=1&origin=https%3A%2F%2Fuser%3Apass%40ghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com%2Fadmin&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com%3Fnext%3D1&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com%23x&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        // Double-encoded origin survives decoding as a literal percent.
        "ghost://connect?v=1&origin=https%253A%252F%252Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(ticket)",
        // Wrong invitation or ticket shape.
        "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=not-a-uuid&ticket=\(ticket)",
        "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(String(repeating: "ab", count: 31))",
        "ghost://connect?v=1&origin=https%3A%2F%2Fghost.example.com&invitation=\(invitationID.uuidString)&ticket=\(String(repeating: "zz", count: 32))",
        // Not a connect URI at all.
        "",
        "https://ghost.example.com/pair",
    ]
    for raw in bad {
        #expect(throws: (any Error).self) { try PairingQR.parse(raw) }
    }
}

// MARK: - Code and TXT normalization

@Test func pairingCodeNormalization() throws {
    #expect(try PairingCode.normalize("ab cd-e1 gh") == "ABCDE1GH")
    #expect(try PairingCode.normalize("AB-CD-E1-GH") == "ABCDE1GH")
    #expect(try PairingCode.normalize("T3STVWXZ") == "T3STVWXZ")
    let rejected = ["", "ABCD", "ABCDEFG", "ABCDEFGHI", "ABCD123I", "ABCD123L", "ABCD123O", "ABCD123U", "ABCD12-345"]
    for raw in rejected {
        #expect(throws: (any Error).self) { try PairingCode.normalize(raw) }
    }
}

@Test func serviceTXTOriginStrictness() {
    #expect(PairingServiceTXT.origin(["origin": "https://near.example.com"])?.absoluteString == "https://near.example.com")
    #expect(PairingServiceTXT.origin(["origin": "http://near.example.com"]) == nil)
    #expect(PairingServiceTXT.origin(["origin": "https://near.example.com/admin"]) == nil)
    #expect(PairingServiceTXT.origin([:]) == nil)
    #expect(PairingServiceTXT.origin(["origin": "", "name": "Ghost"]) == nil)
}

// MARK: - Verification code derivation

@Test func verificationCodeMatchesBackendFormula() {
    // Golden from the backend formula: SHA-256 over ASCII
    // "invitationUUID:claimUUID:deviceTokenDigest", whole-hex integer mod 1e6.
    #expect(PairingVerification.derive(
        invitationID: invitationID.uuidString.lowercased(),
        claimID: claimID,
        keyDigest: keyDigest1) == "430599")
    #expect(PairingVerification.derive(
        invitationID: invitationID.uuidString.lowercased(),
        claimID: claimID,
        keyDigest: String(repeating: "0", count: 64)).count == 6)
}

// MARK: - Pending attempt lifecycle

@Test func beginPersistsKeyAndNonceBeforeAnyNetwork() async throws {
    let context = TestContext()
    defer { context.drop() }
    _ = try await context.session.begin(code: "ABCD-E1GH", origin: context.origin, deviceName: "테스트 iPhone")
    let persisted = try context.store.load()
    #expect(persisted?.attempt.status == .claiming)
    #expect(persisted?.secret.key == key1)
    #expect(context.recorder.captured().isEmpty)
}

@Test func qrBeginPersistsTicketAndInvitation() async throws {
    let context = TestContext()
    defer { context.drop() }
    _ = try await context.session.begin(invitation: scannedInvitation(origin: context.origin), deviceName: "테스트 iPhone")
    let persisted = try context.store.load()
    #expect(persisted?.secret.ticket == ticket)
    #expect(persisted?.attempt.invitationID == invitationID)
    #expect(persisted?.attempt.code == nil)
}

@Test func unknownNetworkOutcomeKeepsAttemptAndRetriesIdentically() async throws {
    let context = TestContext()
    defer { context.drop() }
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")

    let scope = pairingScope()
    let receipt = receiptJSON(origin: context.origin.absoluteString, scope: scope)
    context.recorder.setResponses([
        PairingStubResponse(failure: URLError(.networkConnectionLost)),
        PairingStubResponse(statusCode: 200, body: encodedJSON(receipt)),
    ])

    // Unknown outcome: the attempt stays claiming, nothing is replaced.
    do {
        _ = try await context.session.submit()
        Issue.record("expected the lost connection to surface")
    } catch {
        #expect(try context.store.load()?.attempt.status == .claiming)
    }

    // Resume retains the same key and nonce after the unconfirmed dispatch.
    let attempt = try await context.session.submit()
    #expect(attempt.status == .pending)
    #expect(attempt.claimID == claimID)
    #expect(attempt.verificationCode == "430599")
    #expect(attempt.scope == scope)
    let captured = context.recorder.captured()
    #expect(captured.count == 2)
    #expect(captured.allSatisfy { $0.path == "/pairing/claims" })
    #expect(captured[0].authorization == nil)
    let sent = try JSONDecoder().decode(JSON.self, from: captured[0].body)
    #expect(Set(sent.dictionary.keys) == ["request_id", "device_name", "device_token_digest", "code"])
    #expect(sent["code"].text == "ABCDE1GH")
    #expect(sent["device_token_digest"].text == keyDigest1)
    let persisted = try context.store.load()
    #expect(persisted?.attempt.status == .pending)
    #expect(persisted?.attempt.requestID == sent["request_id"].text)
    #expect(persisted?.secret.key == key1)
}

@Test func resumeAcrossRelaunchUsesSameKeyAndNonce() async throws {
    let context = TestContext(keys: [key1, key1])
    defer { context.drop() }
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")

    // A second session over the same store (simulating a relaunch) resumes
    // the same attempt instead of minting a new key or nonce.
    let issuer = KeyIssuer([key2])
    let rehydrated = PairingSession(
        store: context.store,
        makeClient: { [origin = context.origin] _ in PairingClient(origin: origin, session: stubSession()) },
        makeKey: { issuer.next() },
        now: { frozenNow })
    let restored = await rehydrated.restore()
    #expect(restored?.status == .claiming)
    let scope = pairingScope()
    context.recorder.setResponses([PairingStubResponse(statusCode: 200, body: encodedJSON(receiptJSON(origin: context.origin.absoluteString, scope: scope)))])
    let attempt = try await rehydrated.submit()
    #expect(attempt.status == .pending)
    let captured = context.recorder.captured()
    #expect(captured.count == 1)
    let sent = try JSONDecoder().decode(JSON.self, from: captured[0].body)
    let persisted = try context.store.load()
    #expect(persisted?.secret.key == key1)
    #expect(persisted?.attempt.requestID == sent["request_id"].text)
    #expect(persisted?.attempt.status == .pending)
    #expect(persisted?.attempt.code == "ABCDE1GH")
}

@Test func beginRefusesSecondAttemptWhileActive() async throws {
    let context = TestContext(keys: [key1, key2])
    defer { context.drop() }
    let first = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    // Same target: identical resume, same key and nonce.
    let resumed = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    #expect(resumed.requestID == first.requestID)
    // A different target while active: refused until explicit cancel.
    do {
        _ = try await context.session.begin(invitation: scannedInvitation(origin: context.origin), deviceName: "테스트 iPhone")
        Issue.record("expected the second active attempt to be refused")
    } catch { }
    #expect(try context.store.load()?.secret.key == key1)
    // After explicit cancel a fresh attempt may begin with a new key.
    try await context.session.cancel()
    #expect(try context.store.load() == nil)
    let second = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    #expect(second.requestID != first.requestID)
    #expect(try context.store.load()?.secret.key == key2)
}

// MARK: - Status polling and approval binding

@Test func statusPollProvesCandidateKeyAndExactClaim() async throws {
    let context = TestContext()
    defer { context.drop() }
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    let scope = pairingScope()
    context.recorder.setResponses([
        PairingStubResponse(statusCode: 200, body: encodedJSON(receiptJSON(origin: context.origin.absoluteString, scope: scope))),
        PairingStubResponse(statusCode: 200, body: encodedJSON(statusJSON(status: "pending", origin: context.origin.absoluteString, scope: scope))),
    ])
    _ = try await context.session.submit()
    let polled = try await context.session.pollOnce()
    #expect(polled.status == .pending)
    let captured = context.recorder.captured()
    #expect(captured.count == 2)
    #expect(captured[1].path == "/pairing/claims/\(claimID)/status")
    #expect(captured[1].authorization == "Bearer \(key1)")
    let body = try JSONDecoder().decode(JSON.self, from: captured[1].body)
    #expect(Set(body.dictionary.keys) == ["request_id"])
    #expect(body["request_id"].text == (try context.store.load())?.attempt.requestID)
}

// Runs begin → submit → pollOnce; the report is built with the context's
// own origin (echoes of a foreign origin are rejected at the client layer
// first, which `approvalOriginEchoMismatchIsRejected` covers by patching
// the recorder afterwards). The receipt always uses `receiptScope` so a
// switched scope in the report is detected as a mismatch.
@discardableResult
private func runThroughPoll(
    report makeReport: (URL) -> JSON,
    receiptScope: JSON
) async throws -> (attempt: PairingAttempt?, pollError: Error?) {
    let context = TestContext()
    defer { context.drop() }
    let receipt = receiptJSON(origin: context.origin.absoluteString, scope: receiptScope)
    context.recorder.setResponses([
        PairingStubResponse(statusCode: 200, body: encodedJSON(receipt)),
        PairingStubResponse(statusCode: 200, body: encodedJSON(makeReport(context.origin))),
    ])
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    _ = try await context.session.submit()
    var caught: Error?
    do { _ = try await context.session.pollOnce() } catch { caught = error }
    return (try context.store.load()?.attempt, caught)
}

@Test func approvalYieldsCredentialBoundToExactScope() async throws {
    let scope = pairingScope()
    let outcome = try await runThroughPoll(
        report: { statusJSON(status: "approved", origin: $0.absoluteString, scope: scope, device: deviceID) },
        receiptScope: scope)
    #expect(outcome.pollError == nil)
    #expect(outcome.attempt?.status == .approved)
    #expect(outcome.attempt?.deviceID == deviceID)
}

@Test func approvalOriginEchoMismatchIsRejected() async throws {
    let scope = pairingScope()
    let outcome = try await runThroughPoll(
        report: { _ in statusJSON(status: "approved", origin: "https://evil.example.com", scope: scope, device: deviceID) },
        receiptScope: scope)
    #expect(outcome.pollError != nil)
    #expect(outcome.attempt?.status == .pending)
    #expect(outcome.attempt?.deviceID == nil)
}

@Test func approvalScopeSwitchIsRejected() async throws {
    let receiptScope = pairingScope()
    let switchedScope = pairingScope()
    #expect(switchedScope != receiptScope)
    let outcome = try await runThroughPoll(
        report: { statusJSON(status: "approved", origin: $0.absoluteString, scope: switchedScope, device: deviceID) },
        receiptScope: receiptScope)
    #expect(outcome.pollError != nil)
    #expect(outcome.attempt?.status == .pending)
    #expect(outcome.attempt?.deviceID == nil)
    #expect(outcome.attempt?.scope == receiptScope)
}

@Test func approvalForeignInvitationIsRejected() async throws {
    let scope = pairingScope()
    let other = UUID(uuidString: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")!
    let outcome = try await runThroughPoll(
        report: { statusJSON(status: "approved", origin: $0.absoluteString, invitation: other, scope: scope, device: deviceID) },
        receiptScope: scope)
    #expect(outcome.pollError != nil)
    #expect(outcome.attempt?.status == .pending)
    #expect(outcome.attempt?.invitationID == invitationID)
}

@Test func approvedReportWithoutDeviceIDIsRejected() async throws {
    // The contract requires device_id exactly when approved; its absence is
    // a contract violation, never an approval.
    let scope = pairingScope()
    var fields = statusJSON(status: "approved", origin: "https://irrelevant.example.com", scope: scope, device: deviceID).dictionary
    fields.removeValue(forKey: "device_id")
    let outcome = try await runThroughPoll(report: { _ in JSON.object(fields) }, receiptScope: scope)
    #expect(outcome.pollError != nil)
    #expect(outcome.attempt?.status == .pending)
}

@Test func approvedCredentialOnlyForBoundApproval() async throws {
    let scope = pairingScope()
    let context = TestContext()
    defer { context.drop() }
    context.recorder.setResponses([
        PairingStubResponse(statusCode: 200, body: encodedJSON(receiptJSON(origin: context.origin.absoluteString, scope: scope))),
        PairingStubResponse(statusCode: 200, body: encodedJSON(statusJSON(status: "approved", origin: context.origin.absoluteString, scope: scope, device: deviceID))),
    ])
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")

    // Before approval: no credential.
    do { _ = try await context.session.approvedCredential(); Issue.record("expected refusal before any claim") }
    catch { }
    _ = try await context.session.submit()
    do { _ = try await context.session.approvedCredential(); Issue.record("expected refusal before approval") }
    catch { }

    // After the matching approval: the credential is the fresh key against
    // the confirmed origin, usable through the existing Connection path.
    _ = try await context.session.pollOnce()
    let credential = try await context.session.approvedCredential()
    #expect(credential.key == key1)
    #expect(credential.origin == context.origin.absoluteString)
    let connection = try Connection(server: credential.origin, token: credential.key)
    #expect(connection.origin == context.origin)
    #expect(connection.token == key1)
}

@Test func revokedAttemptCanNeverConnect() async throws {
    let scope = pairingScope()
    let outcome = try await runThroughPoll(
        report: { statusJSON(status: "revoked", origin: $0.absoluteString, scope: scope) },
        receiptScope: scope)
    #expect(outcome.pollError == nil)
    #expect(outcome.attempt?.status == .revoked)
    // The terminal-refusal coverage (no further polling, no credential,
    // even after a server-side revoke) lives in
    // `cancelledAndExpiredAttemptsAreTerminal`.
}

@Test func cancelledAndExpiredAttemptsAreTerminal() async throws {
    let scope = pairingScope()
    let cancelled = try await runThroughPoll(
        report: { statusJSON(status: "cancelled", origin: $0.absoluteString, scope: scope) },
        receiptScope: scope)
    #expect(cancelled.attempt?.status == .cancelled)
    let expired = try await runThroughPoll(
        report: { statusJSON(status: "expired", origin: $0.absoluteString, scope: scope) },
        receiptScope: scope)
    #expect(expired.attempt?.status == .expired)

    // Terminal attempts refuse both further polling and credentials.
    let context = TestContext()
    defer { context.drop() }
    context.recorder.setResponses([
        PairingStubResponse(statusCode: 200, body: encodedJSON(receiptJSON(origin: context.origin.absoluteString, scope: scope))),
        PairingStubResponse(statusCode: 200, body: encodedJSON(statusJSON(status: "revoked", origin: context.origin.absoluteString, scope: scope))),
    ])
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    _ = try await context.session.submit()
    _ = try await context.session.pollOnce()
    do { _ = try await context.session.pollOnce(); Issue.record("terminal attempts must not poll again") }
    catch { }
    do { _ = try await context.session.approvedCredential(); Issue.record("terminal attempts must not connect") }
    catch { }
}

@Test func malformedClaimReceiptLeavesAttemptClaiming() async throws {
    let context = TestContext()
    defer { context.drop() }
    // Receipt with an extra field violates the exact schema.
    var fields = receiptJSON(origin: context.origin.absoluteString).dictionary
    fields["surprise"] = .string("no")
    context.recorder.setResponses([PairingStubResponse(statusCode: 200, body: encodedJSON(JSON.object(fields)))])
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    do {
        _ = try await context.session.submit()
        Issue.record("expected the malformed receipt to be rejected")
    } catch { }
    let persisted = try context.store.load()
    #expect(persisted?.attempt.status == .claiming)
    #expect(persisted?.attempt.claimID == nil)
}

@Test func savedExistingConnectionStillWorksAfterPairing() async throws {
    // The approved key becomes a normal saved connection; the legacy
    // device-key transport must be untouched by pairing.
    let scope = pairingScope()
    let context = TestContext()
    defer { context.drop() }
    context.recorder.setResponses([
        PairingStubResponse(statusCode: 200, body: encodedJSON(receiptJSON(origin: context.origin.absoluteString, scope: scope))),
        PairingStubResponse(statusCode: 200, body: encodedJSON(statusJSON(status: "approved", origin: context.origin.absoluteString, scope: scope, device: deviceID))),
        PairingStubResponse(statusCode: 200, body: encodedJSON(.object([
            "protocol": .string("ghost-mobile"),
            "version": .number(1),
            "role": .string("lifetime"),
            "device": .object(["id": .string(deviceID)]),
            "scope": scope,
            "lifetime_identity": .object(["actor_ref": .string("owner"), "authority_epoch": .number(1)]),
            "lifetime_host": .object(["workspace_id": .string(UUID().uuidString.lowercased()), "authority_epoch": .number(1), "dispatch_enabled": .bool(true)]),
            "voice_media": .null,
        ]))),
    ])
    _ = try await context.session.begin(code: "ABCDE1GH", origin: context.origin, deviceName: "테스트 iPhone")
    _ = try await context.session.submit()
    _ = try await context.session.pollOnce()
    let credential = try await context.session.approvedCredential()
    let connection = try Connection(server: credential.origin, token: credential.key)
    let api = GhostAPI(connection: connection, pendingFile: tempPairingFile().deletingLastPathComponent().appending(path: "pending.json"),
                       session: stubSession())
    let bootstrap = try await api.bootstrap()
    #expect(bootstrap["protocol"].text == "ghost-mobile")
    let captured = context.recorder.captured()
    #expect(captured.last?.path == "/mobile/v1/bootstrap")
    #expect(captured.last?.authorization == "Bearer \(key1)")
}

private func exactPeerScope() -> JSON {
    .object([
        "kind": .string("lifetime"),
        "ghost_ids": .array([.string("00000000-0000-4000-8000-000000000001"), .string("00000000-0000-4000-8000-000000000002")]),
        "conversation_ids": .array([.string("00000000-0000-4000-8000-000000000011"), .string("00000000-0000-4000-8000-000000000012")]),
        "capabilities": .array([.string("lifetime.read"), .string("lifetime.write")]),
        "targets": .array([
            .object(["ghost_id": .string("00000000-0000-4000-8000-000000000001"), "conversation_id": .string("00000000-0000-4000-8000-000000000011")]),
            .object(["ghost_id": .string("00000000-0000-4000-8000-000000000002"), "conversation_id": .string("00000000-0000-4000-8000-000000000012")])
        ])
    ])
}

@Test func exactPeerGrantKeepsPairBoundariesAndSurvivesApproval() async throws {
    let scope = exactPeerScope()
    #expect(validPairingScope(scope))
    #expect(lifetimeScopeAllowsPair(scope, ghostID: scope["ghost_ids"].items[0].text, conversationID: scope["conversation_ids"].items[0].text))
    #expect(!lifetimeScopeAllowsPair(scope, ghostID: scope["ghost_ids"].items[0].text, conversationID: scope["conversation_ids"].items[1].text))
    let outcome = try await runThroughPoll(
        report: { statusJSON(status: "approved", origin: $0.absoluteString, scope: scope, device: deviceID) }, receiptScope: scope)
    #expect(outcome.pollError == nil)
    #expect(outcome.attempt?.scope == scope)
    #expect(outcome.attempt?.status == .approved)
}

@Test func exactPeerGrantRejectsWidenedProjectionDuplicatesAndEmptyTargets() {
    var fields = exactPeerScope().dictionary
    fields["ghost_ids"] = .array(fields["ghost_ids"]!.items + [.string("00000000-0000-4000-8000-000000000003")])
    #expect(!validPairingScope(.object(fields)))
    fields = exactPeerScope().dictionary
    fields["targets"] = .array([fields["targets"]!.items[0], fields["targets"]!.items[0]])
    #expect(!validPairingScope(.object(fields)))
    fields["targets"] = .array([])
    #expect(!validPairingScope(.object(fields)))
    fields["targets"] = .string("invalid")
    #expect(!validPairingScope(.object(fields)))
    #expect(!lifetimeScopeAllowsPair(.object(fields), ghostID: fields["ghost_ids"]!.items[0].text, conversationID: fields["conversation_ids"]!.items[0].text))
}

@Test func exactPeerGrantCannotBeSwappedDuringApproval() async throws {
    let scope = exactPeerScope()
    var fields = scope.dictionary
    fields["targets"] = .array([
        .object(["ghost_id": scope["ghost_ids"].items[0], "conversation_id": scope["conversation_ids"].items[1]]),
        .object(["ghost_id": scope["ghost_ids"].items[1], "conversation_id": scope["conversation_ids"].items[0]])
    ])
    #expect(validPairingScope(.object(fields)))
    let swapped = JSON.object(fields)
    let outcome = try await runThroughPoll(
        report: { statusJSON(status: "approved", origin: $0.absoluteString, scope: swapped, device: deviceID) }, receiptScope: scope)
    #expect(outcome.pollError != nil)
    #expect(outcome.attempt?.status == .pending)
}
