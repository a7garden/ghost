import Foundation
import Testing
@testable import GhostMobileCore

private func lifetimeGolden() throws -> JSON {
    var root = URL(fileURLWithPath: #filePath)
    root = root.deletingLastPathComponent()
    root = root.deletingLastPathComponent()
    root = root.deletingLastPathComponent()
    root = root.deletingLastPathComponent()
    root = root.deletingLastPathComponent()
    return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: root.appending(path: "contracts/lifetime/golden.json")))
}

private struct StubReply: @unchecked Sendable {
    let statusCode: Int?
    let body: Data
    let failure: URLError?
    init(statusCode: Int, body: Data) { self.statusCode = statusCode; self.body = body; self.failure = nil }
    init(failure: URLError) { self.statusCode = nil; self.body = Data(); self.failure = failure }
}

private final class ReplyQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [StubReply]
    private var bodies: [Data] = []
    private var paths: [String] = []
    private let responder: (@Sendable (URLRequest, Data) -> StubReply)?

    init(_ replies: [StubReply], responder: (@Sendable (URLRequest, Data) -> StubReply)? = nil) {
        self.replies = replies
        self.responder = responder
    }
    func take(_ request: URLRequest) -> StubReply {
        lock.lock()
        defer { lock.unlock() }
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
            if !readable { return StubReply(failure: URLError(.cannotDecodeContentData)) }
        }
        bodies.append(body)
        paths.append(request.url?.path ?? "")
        if !replies.isEmpty { return replies.removeFirst() }
        return responder?(request, body) ?? StubReply(statusCode: 500, body: Data())
    }

    func captured() -> (bodies: [Data], paths: [String]) {
        lock.lock()
        defer { lock.unlock() }
        return (bodies, paths)
    }
}

private func encodedJSON(_ value: JSON) -> Data {
    (try? JSONEncoder().encode(value)) ?? Data()
}

private final class StubProtocolRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var queues: [String: ReplyQueue] = [:]

    func install(_ queue: ReplyQueue, host: String) {
        lock.lock()
        defer { lock.unlock() }
        queues[host] = queue
    }

    func remove(host: String) {
        lock.lock()
        defer { lock.unlock() }
        queues.removeValue(forKey: host)
    }

    func take(_ request: URLRequest) -> StubReply? {
        guard let host = request.url?.host else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return queues[host]?.take(request)
    }
}

private let stubProtocolRegistry = StubProtocolRegistry()

private final class GhostStubURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".stub.invalid") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let reply = stubProtocolRegistry.take(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        if let failure = reply.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
        guard let url = request.url, let statusCode = reply.statusCode,
              let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json", "Content-Length": String(reply.body.count)]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test func lifetimeReadAuthorityCannotFetchOwnerWideSnapshot() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let queue = ReplyQueue([StubReply(statusCode: 200, body: encodedJSON(.object(["private_owner_data": .string("must not be fetched")])) )])
    stubProtocolRegistry.install(queue, host: host)
    defer { stubProtocolRegistry.remove(host: host) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GhostStubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let identity = try LifetimeIdentity(authorityEpoch: 1)
    let namespace = try LifetimeJournalNamespace(workspaceID: UUID().uuidString, deviceID: UUID().uuidString, authorityEpoch: 1)
    let api = GhostAPI(
        connection: try Connection(server: "https://\(host)", token: String(repeating: "a", count: 64)),
        pendingFile: FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString)/pending.json"),
        lifetimeIdentity: identity,
        lifetimeNamespace: namespace,
        lifetimeCapabilities: ["lifetime.read"],
        session: session
    )
    await #expect(throws: MobileError.self) { try await api.ownerSnapshot() }
    #expect(queue.captured().paths.isEmpty)
}

@Test func serverAddressRejectsCredentialLeaks() throws {
    let token = String(repeating: "a", count: 64)
    for url in ["http://ghost.example", "https://u:p@ghost.example", "https://ghost.example/path", "https://ghost.example?token=x", "https://ghost.example#x"] {
        #expect(throws: MobileError.self) { try Connection(server: url, token: token) }
    }
    let valid = try Connection(server: "https://ghost.example:8443", token: token)
    #expect(valid.url("mobile/v1/snapshot").absoluteString == "https://ghost.example:8443/mobile/v1/snapshot")
    #expect(try Connection(server: "https://GHOST.EXAMPLE:443/", token: token).origin == Connection(server: "https://ghost.example", token: token).origin)
}
@Test func retrySurvivesProcessStateAndRemainsBoundToCommand() async throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "pending.json")
    let command = JSON.object(["type": .string("submit"), "prompt": .string("original")])
    let first = try await PendingCommands(file: file).prepare(command)
    let reopened = PendingCommands(file: file)
    #expect(try await reopened.prepare(command) == first)
    let different = try await reopened.prepare(.object(["type": .string("submit"), "prompt": .string("changed")]))
    #expect(different.request_id != first.request_id)
    try await reopened.finish(first)
    #expect(try await reopened.prepare(command).request_id != first.request_id)
}
@Test func corruptedJournalFailsBeforeDispatch() async throws {
    let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    try Data("broken".utf8).write(to: file)
    await #expect(throws: (any Error).self) { try await PendingCommands(file: file).prepare(.object(["type": .string("submit")])) }
}

@Test func lifetimeOutboxRequiresReceiptInspectionAfterAmbiguousDispatch() async throws {
    let golden = try lifetimeGolden()
    let body = golden["body"]
    let identity = try LifetimeIdentity(authorityEpoch: 1)
    let workspaceID = UUID().uuidString.lowercased()
    let deviceID = UUID().uuidString.lowercased()
    let namespace = try LifetimeJournalNamespace(workspaceID: workspaceID, deviceID: deviceID, authorityEpoch: 1)
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let file = root.appending(path: "pending.json")
    let journalFile = namespace.file(in: root)
    defer { try? FileManager.default.removeItem(at: root) }

    let success = JSON.object([
        "status": .string("success"),
        "summary": .string("admitted"),
        "object_refs": .array([]),
        "artifacts": .array([]),
        "next_actions": .array([]),
        "error_code": .null,
        "retry_class": .string("same_id"),
        "data": .null,
    ])
    let queue = ReplyQueue([StubReply(failure: URLError(.notConnectedToInternet))], responder: { _, requestBody in
        let wire = (try? JSONDecoder().decode(Envelope.self, from: requestBody)) ?? Envelope(command: .null)
        let body = wire.command["envelope"]["body"]
        if body["method"] == .string("command.inspect") {
            let commandID = body["command_id"].text
            let receiptResponse = JSON.object([
                "status": .string("success"),
                "summary": .string("original request admitted"),
                "object_refs": .array([]), "artifacts": .array([]), "next_actions": .array([]), "data": .null,
                "retry_class": .string("same_id"),
                "error_code": .null,
            ])
            let inspection = JSON.object([
                "status": .string("success"),
                "summary": .string("receipt inspected"),
                "object_refs": .array([]),
                "artifacts": .array([]),
                "next_actions": .array([]),
                "error_code": .null,
                "retry_class": .string("same_id"),
                "data": .object([
                    "command_id": .string(commandID),
                    "found": .bool(true),
                    "authority_epoch": .number(1),
                    "payload_digest": golden["payload_digest"],
                    "response": receiptResponse,
                ]),
            ])
            return StubReply(statusCode: 200, body: encodedJSON(.object(["ok": .bool(true), "result": inspection])))
        }
        return StubReply(statusCode: 200, body: encodedJSON(.object(["ok": .bool(true), "result": success])))
    })
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    stubProtocolRegistry.install(queue, host: host)
    defer { stubProtocolRegistry.remove(host: host) }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GhostStubURLProtocol.self]
    configuration.timeoutIntervalForRequest = 5
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let connection = try Connection(server: "https://\(host)", token: String(repeating: "a", count: 64))
    let api = GhostAPI(
        connection: connection,
        pendingFile: file,
        lifetimeIdentity: identity,
        lifetimeNamespace: namespace,
        lifetimeCapabilities: ["lifetime.read", "lifetime.write"],
        session: session
    )

    await #expect(throws: (any Error).self) { try await api.lifetimeAction(body) }
    let pending = try await api.pendingCommands()
    #expect(pending.count == 1)
    let persistedAfterRestart = try await PendingCommands(file: journalFile).prepareLifetime(body, identity: identity)
    #expect(persistedAfterRestart.request_id == pending[0].request_id)

    let firstCapture = queue.captured()
    let firstWire = try JSONDecoder().decode(Envelope.self, from: firstCapture.bodies[0])
    let firstInner = firstWire.command["envelope"]
    #expect(firstInner["payload_digest"] == golden["payload_digest"])
    #expect(firstInner["authority_epoch"] == .number(1))

    await #expect(throws: (any Error).self) { try await api.retry(pending[0]) }
    #expect(queue.captured().bodies.count == 1)
    let reconciliation = try await api.inspectLifetimeCommand(pending[0])
    #expect(reconciliation.status == .confirmedSuccess)
    #expect(reconciliation.commandID == firstInner["command_id"].text)
    #expect(try await api.pendingCommands().isEmpty)

    _ = try await api.lifetimeAction(body)
    let requests = queue.captured()
    let inspectWire = try JSONDecoder().decode(Envelope.self, from: requests.bodies[1])
    let newIntentWire = try JSONDecoder().decode(Envelope.self, from: requests.bodies[2])
    #expect(inspectWire.command["envelope"]["body"]["method"] == .string("command.inspect"))
    #expect(inspectWire.command["envelope"]["body"]["command_id"] == firstInner["command_id"])
    #expect(inspectWire.command["envelope"]["authority_epoch"] == .number(1))
    #expect(inspectWire.command["envelope"]["command_id"] != firstInner["command_id"])
    #expect(newIntentWire.request_id != firstWire.request_id)
    #expect(newIntentWire.command["envelope"]["command_id"] != firstInner["command_id"])
    #expect(try await api.pendingCommands().isEmpty)
}

@Test func bindingScopeKeepsOnlyAdvertisedPairs() {
    let snapshot = JSON.object([
        "bindings": .array([
            .object(["ghost_id": .string("g1"), "conversation_id": .string("c1"), "runtime_kind": .string("pi")]),
            .object(["ghost_id": .string("g2"), "conversation_id": .string("c2"), "runtime_kind": .string("web")]),
            .object(["ghost_id": .string("g1"), "conversation_id": .string("c1"), "runtime_kind": .string("pi")]),
        ]),
    ])
    let pairs = lifetimeBindingPairs(snapshot: snapshot, ghostIDs: ["g1", "g2"], conversationIDs: ["c1", "c2"])
    #expect(pairs.map(\.id) == ["g1:c1", "g2:c2"])
    #expect(!pairs.contains { $0.ghostID == "g1" && $0.conversationID == "c2" })
}

@Test func previousWorkspaceJournalPreservesOriginalIDAndEpochAndBlocksMutation() async throws {
    let golden = try lifetimeGolden()
    let identity = try LifetimeIdentity(authorityEpoch: 2)
    let oldIdentity = try LifetimeIdentity(authorityEpoch: 1)
    let oldWorkspaceID = UUID().uuidString.lowercased()
    let currentWorkspaceID = oldWorkspaceID
    let deviceID = UUID().uuidString.lowercased()
    let oldNamespace = try LifetimeJournalNamespace(workspaceID: oldWorkspaceID, deviceID: deviceID, authorityEpoch: 1)
    let namespace = try LifetimeJournalNamespace(workspaceID: currentWorkspaceID, deviceID: deviceID, authorityEpoch: 2)
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let oldFile = oldNamespace.file(in: root)
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try await PendingCommands(file: oldFile).prepareLifetime(golden["body"], identity: oldIdentity)

    let receiptResponse = JSON.object([
        "status": .string("success"),
        "summary": .string("old request admitted"),
        "object_refs": .array([]), "artifacts": .array([]), "next_actions": .array([]), "data": .null,
        "retry_class": .string("same_id"),
        "error_code": .null,
    ])
    let success = JSON.object([
        "status": .string("success"),
        "summary": .string("admitted"),
        "object_refs": .array([]),
        "artifacts": .array([]),
        "next_actions": .array([]),
        "error_code": .null,
        "retry_class": .string("same_id"),
        "data": .null,
    ])
    let queue = ReplyQueue([], responder: { _, requestBody in
        let wire = (try? JSONDecoder().decode(Envelope.self, from: requestBody)) ?? Envelope(command: .null)
        let body = wire.command["envelope"]["body"]
        if body["method"] == .string("command.inspect") {
            let inspection = JSON.object([
                "status": .string("success"),
                "summary": .string("receipt inspected"),
                "retry_class": .string("same_id"),
                "object_refs": .array([]), "artifacts": .array([]), "next_actions": .array([]),
                "error_code": .null,
                "data": .object([
                    "command_id": body["command_id"],
                    "found": .bool(true),
                    "authority_epoch": .number(1),
                    "payload_digest": original.command["envelope"]["payload_digest"],
                    "response": receiptResponse,
                ]),
            ])
            return StubReply(statusCode: 200, body: encodedJSON(.object(["ok": .bool(true), "result": inspection])))
        }
        return StubReply(statusCode: 200, body: encodedJSON(.object(["ok": .bool(true), "result": success])))
    })
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    stubProtocolRegistry.install(queue, host: host)
    defer { stubProtocolRegistry.remove(host: host) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GhostStubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let connection = try Connection(server: "https://\(host)", token: String(repeating: "b", count: 64))
    let api = GhostAPI(
        connection: connection,
        pendingFile: root.appending(path: "pending.json"),
        lifetimeIdentity: identity,
        lifetimeNamespace: namespace,
        lifetimeCapabilities: ["lifetime.read", "lifetime.write"],
        session: session
    )

    let recovery = try await api.lifetimeRecoveryItems()
    #expect(recovery.count == 1)
    #expect(recovery[0].workspaceID == oldWorkspaceID)
    #expect(recovery[0].deviceID == deviceID)
    #expect(recovery[0].commandID == original.command["envelope"]["command_id"].text)
    #expect(recovery[0].authorityEpoch == 1)
    #expect(recovery[0].canReconcile)
    await #expect(throws: (any Error).self) { try await api.lifetimeAction(golden["body"]) }
    #expect(queue.captured().paths.isEmpty)

    let result = try await api.reconcileLifetime(recovery[0].id)
    #expect(result.status == .confirmedSuccess)
    #expect(result.commandID == original.command["envelope"]["command_id"].text)
    #expect(result.authorityEpoch == 1)
    #expect(try await PendingCommands(file: oldFile).all().isEmpty)
    #expect(original.command["envelope"]["authority_epoch"] == .number(1))
    _ = try await api.lifetimeAction(golden["body"])

    let requests = queue.captured()
    let inspect = try JSONDecoder().decode(Envelope.self, from: requests.bodies[0])
    #expect(inspect.command["envelope"]["body"]["method"] == .string("command.inspect"))
    #expect(inspect.command["envelope"]["body"]["command_id"] == original.command["envelope"]["command_id"])
    #expect(inspect.command["envelope"]["authority_epoch"] == .number(2))
    #expect(inspect.command["envelope"]["command_id"] != original.command["envelope"]["command_id"])
    #expect(original.command["envelope"]["authority_epoch"] == .number(1))
    #expect(requests.bodies.count == 2)
}

@Test func dispatchOffKeepsReadsButBlocksWritesBeforeTransport() async throws {
    let golden = try lifetimeGolden()
    let identity = try LifetimeIdentity(authorityEpoch: 1)
    let namespace = try LifetimeJournalNamespace(
        workspaceID: UUID().uuidString.lowercased(),
        deviceID: UUID().uuidString.lowercased(),
        authorityEpoch: 1
    )
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let accepted = JSON.object([
        "status": .string("success"),
        "summary": .string("accepted"),
        "object_refs": .array([]),
        "artifacts": .array([]),
        "next_actions": .array([]),
        "error_code": .null,
        "retry_class": .string("same_id"),
        "data": .null,
    ])
    let queue = ReplyQueue([
        StubReply(statusCode: 200, body: Data("{}".utf8)),
        StubReply(statusCode: 200, body: encodedJSON(.object(["ok": .bool(true), "result": accepted]))),
    ])
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    stubProtocolRegistry.install(queue, host: host)
    defer { stubProtocolRegistry.remove(host: host) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GhostStubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let connection = try Connection(server: "https://\(host)", token: String(repeating: "c", count: 64))
    let api = GhostAPI(
        connection: connection,
        pendingFile: root.appending(path: "pending.json"),
        lifetimeIdentity: identity,
        lifetimeNamespace: namespace,
        dispatchEnabled: false,
        lifetimeCapabilities: ["lifetime.read", "lifetime.write"],
        session: session
    )

    _ = try await api.lifetimeSnapshot()
    let target = (
        ghostID: UUID().uuidString.lowercased(),
        conversationID: UUID().uuidString.lowercased(),
        turnID: UUID().uuidString.lowercased()
    )
    _ = try await api.inspectLifetimeConversationTurn(
        ghostID: target.ghostID,
        conversationID: target.conversationID,
        turnID: target.turnID
    )
    await #expect(throws: (any Error).self) {
        try await api.lifetimeAction(.object([
            "method": .string("conversation.turn.inspect"),
            "ghost_id": .string(target.ghostID),
            "conversation_id": .string(target.conversationID),
            "turn_id": .string(target.turnID),
            "unexpected": .string("reject-before-dispatch"),
        ]))
    }
    await #expect(throws: (any Error).self) {
        try await api.cancelLifetimeConversationTurn(
            ghostID: target.ghostID,
            conversationID: target.conversationID,
            turnID: target.turnID
        )
    }
    await #expect(throws: (any Error).self) { try await api.lifetimeAction(golden["body"]) }
    let requests = queue.captured()
    #expect(requests.paths == ["/mobile/v1/lifetime/snapshot", "/mobile/v1/lifetime/action"])
    let inspectWire = try JSONDecoder().decode(Envelope.self, from: requests.bodies[1])
    #expect(inspectWire.command["envelope"]["body"] == .object([
        "method": .string("conversation.turn.inspect"),
        "ghost_id": .string(target.ghostID),
        "conversation_id": .string(target.conversationID),
        "turn_id": .string(target.turnID),
    ]))

    #expect(try await api.pendingCommands().isEmpty)

}

@Test func writeOnlyConnectionDoesNotRequestSnapshotsOrReceipts() async throws {
    let golden = try lifetimeGolden()
    let identity = try LifetimeIdentity(authorityEpoch: 1)
    let namespace = try LifetimeJournalNamespace(
        workspaceID: UUID().uuidString.lowercased(),
        deviceID: UUID().uuidString.lowercased(),
        authorityEpoch: 1
    )
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let journalFile = namespace.file(in: root)
    let original = try await PendingCommands(file: journalFile).prepareLifetime(golden["body"], identity: identity)

    let queue = ReplyQueue([])
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    stubProtocolRegistry.install(queue, host: host)
    defer { stubProtocolRegistry.remove(host: host) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GhostStubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let connection = try Connection(server: "https://\(host)", token: String(repeating: "d", count: 64))
    let api = GhostAPI(
        connection: connection,
        pendingFile: root.appending(path: "pending.json"),
        lifetimeIdentity: identity,
        lifetimeNamespace: namespace,
        lifetimeCapabilities: ["lifetime.write"],
        session: session
    )

    await #expect(throws: (any Error).self) { try await api.lifetimeSnapshot() }
    await #expect(throws: (any Error).self) { try await api.inspectLifetimeCommand(original) }
    await #expect(throws: (any Error).self) { try await api.action(.object(["type": .string("lifetime")])) }
    await #expect(throws: (any Error).self) { try await api.acknowledge(original) }
    await #expect(throws: (any Error).self) { try await api.lifetimeAction(golden["body"]) }
    #expect(queue.captured().paths.isEmpty)
    #expect(try await PendingCommands(file: journalFile).all() == [original])
}

@Test func canonicalConversationRunParserRejectsForeignUnreferencedAndMalformedRows() throws {
    let turnID = UUID().uuidString.lowercased()
    let valid: [String: JSON] = [
        "turn_id": .string(turnID),
        "ghost_id": .string("ghost"),
        "conversation_id": .string("conversation"),
        "state": .string("running"),
        "cancel_requested": .bool(false),
        "cancel_command_id": .null,
        "submission_id": .string("opaque-submission"),
        "entry_id": .null,
        "reason_code": .null,
        "latest_status_command_id": .null,
        "created_at_ms": .number(1),
        "updated_at_ms": .number(2),
    ]
    let parsed = try parseLifetimeConversationRuns(
        .array([.object(valid)]),
        ghostID: "ghost",
        conversationID: "conversation",
        referencedTurnIDs: [turnID]
    )
    #expect(parsed.count == 1)
    #expect(parsed[0].turnID == turnID)
    #expect(parsed[0].state == "running")
    #expect(parsed[0].cancelRequested == false)

    var foreign = valid
    foreign["conversation_id"] = .string("other-conversation")
    var unreferenced = valid
    unreferenced["turn_id"] = .string(UUID().uuidString.lowercased())
    var unknownState = valid
    unknownState["state"] = .string("completed")
    var unknownReason = valid
    unknownReason["reason_code"] = .string("raw-model-diagnostic")
    var malformedCancel = valid
    malformedCancel["cancel_requested"] = .string("false")
    var extraField = valid
    extraField["host_prompt"] = .string("private")
    var negativeTimestamp = valid
    negativeTimestamp["updated_at_ms"] = .number(-1)
    var reversedTimestamp = valid
    reversedTimestamp["created_at_ms"] = .number(3)
    var excessiveUTF8Identity = valid
    excessiveUTF8Identity["submission_id"] = .string(String(repeating: "é", count: 257))

    for invalid in [foreign, unreferenced, unknownState, unknownReason, malformedCancel, extraField, negativeTimestamp, reversedTimestamp, excessiveUTF8Identity] {
        #expect(throws: MobileError.self) {
            try parseLifetimeConversationRuns(
                .array([.object(invalid)]),
                ghostID: "ghost",
                conversationID: "conversation",
                referencedTurnIDs: [turnID]
            )
        }
    }
    #expect(throws: MobileError.self) {
        try parseLifetimeConversationRuns(
            .array([.object(valid), .object(valid)]),
            ghostID: "ghost",
            conversationID: "conversation",
            referencedTurnIDs: [turnID]
        )
    }
    #expect(throws: MobileError.self) {
        try parseLifetimeConversationRuns(
            .null,
            ghostID: "ghost",
            conversationID: "conversation",
            referencedTurnIDs: [turnID]
        )
    }
}

@Test func delayedControllerReadsCannotUndoConfirmedCancellation() throws {
    let turnID = "11111111-1111-4111-8111-111111111111"
    let running = LifetimeConversationRun(
        turnID: turnID, ghostID: "ghost", conversationID: "conversation",
        state: "running", cancelRequested: false, cancelCommandID: nil,
        submissionID: "8", entryID: nil, reasonCode: nil,
        latestStatusCommandID: "status-running", createdAtMS: 1, updatedAtMS: 2
    )
    let requested = LifetimeConversationRun(
        turnID: turnID, ghostID: "ghost", conversationID: "conversation",
        state: "running", cancelRequested: true, cancelCommandID: "cancel-original",
        submissionID: "8", entryID: nil, reasonCode: nil,
        latestStatusCommandID: "status-running", createdAtMS: 1, updatedAtMS: 3
    )
    let confirmed = LifetimeConversationRun(
        turnID: turnID, ghostID: "ghost", conversationID: "conversation",
        state: "cancelled", cancelRequested: true, cancelCommandID: "cancel-original",
        submissionID: "8", entryID: nil, reasonCode: "owner_cancelled",
        latestStatusCommandID: "status-cancelled", createdAtMS: 1, updatedAtMS: 4
    )
    let pending = try mergeLifetimeConversationRun(current: running, incoming: requested)
    #expect(pending.state == "running")
    #expect(pending.cancelRequested)
    let completed = try mergeLifetimeConversationRun(current: pending, incoming: confirmed)
    let delayed = try mergeLifetimeConversationRun(current: completed, incoming: running)
    let equalVersion = try mergeLifetimeConversationRun(current: delayed, incoming: confirmed)
    #expect(equalVersion.state == "cancelled")
    #expect(equalVersion.cancelRequested)
    #expect(equalVersion.cancelCommandID == "cancel-original")
    #expect(equalVersion.submissionID == "8")
    #expect(equalVersion.reasonCode == "owner_cancelled")
    #expect(equalVersion.updatedAtMS == 4)
}


@Test func cancellationUsesPersistedOutboxWhileTargetInspectionUsesFreshEphemeralIdentity() async throws {
    let identity = try LifetimeIdentity(authorityEpoch: 1)
    let workspaceID = UUID().uuidString.lowercased()
    let deviceID = UUID().uuidString.lowercased()
    let namespace = try LifetimeJournalNamespace(workspaceID: workspaceID, deviceID: deviceID, authorityEpoch: 1)
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let accepted = JSON.object([
        "status": .string("success"),
        "summary": .string("accepted"),
        "object_refs": .array([]),
        "artifacts": .array([]),
        "next_actions": .array([]),
        "error_code": .null,
        "retry_class": .string("same_id"),
        "data": .null,
    ])
    let queue = ReplyQueue([
        StubReply(failure: URLError(.notConnectedToInternet)),
        StubReply(statusCode: 200, body: encodedJSON(.object(["ok": .bool(true), "result": accepted]))),
        StubReply(statusCode: 200, body: encodedJSON(.object(["ok": .bool(true), "result": accepted]))),
    ])
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    stubProtocolRegistry.install(queue, host: host)
    defer { stubProtocolRegistry.remove(host: host) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GhostStubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let api = GhostAPI(
        connection: try Connection(server: "https://\(host)", token: String(repeating: "e", count: 64)),
        pendingFile: root.appending(path: "pending.json"),
        lifetimeIdentity: identity,
        lifetimeNamespace: namespace,
        lifetimeCapabilities: ["lifetime.read", "lifetime.write"],
        session: session
    )
    let target = (
        ghostID: UUID().uuidString.lowercased(),
        conversationID: UUID().uuidString.lowercased(),
        turnID: UUID().uuidString.lowercased()
    )

    await #expect(throws: (any Error).self) {
        try await api.cancelLifetimeConversationTurn(
            ghostID: target.ghostID,
            conversationID: target.conversationID,
            turnID: target.turnID
        )
    }
    let pending = try await api.pendingCommands()
    #expect(pending.count == 1)
    #expect(pending[0].command["envelope"]["body"] == .object([
        "method": .string("conversation.cancel_turn"),
        "ghost_id": .string(target.ghostID),
        "conversation_id": .string(target.conversationID),
        "turn_id": .string(target.turnID),
    ]))

    _ = try await api.inspectLifetimeConversationTurn(
        ghostID: target.ghostID,
        conversationID: target.conversationID,
        turnID: target.turnID
    )
    _ = try await api.inspectLifetimeConversationTurn(
        ghostID: target.ghostID,
        conversationID: target.conversationID,
        turnID: target.turnID
    )
    let requests = queue.captured()
    #expect(requests.paths == [
        "/mobile/v1/lifetime/action",
        "/mobile/v1/lifetime/action",
        "/mobile/v1/lifetime/action",
    ])
    let cancelWire = try JSONDecoder().decode(Envelope.self, from: requests.bodies[0])
    let inspectWire = try JSONDecoder().decode(Envelope.self, from: requests.bodies[1])
    let repeatedInspectWire = try JSONDecoder().decode(Envelope.self, from: requests.bodies[2])
    #expect(cancelWire.command["envelope"]["body"]["method"] == .string("conversation.cancel_turn"))
    #expect(inspectWire.command["envelope"]["body"] == .object([
        "method": .string("conversation.turn.inspect"),
        "ghost_id": .string(target.ghostID),
        "conversation_id": .string(target.conversationID),
        "turn_id": .string(target.turnID),
    ]))
    #expect(inspectWire.command["envelope"]["command_id"] != cancelWire.command["envelope"]["command_id"])
    #expect(repeatedInspectWire.command["envelope"]["command_id"] != inspectWire.command["envelope"]["command_id"])
    #expect(repeatedInspectWire.request_id != inspectWire.request_id)
    #expect(try await api.pendingCommands() == pending)
}

// MARK: Notification inbox and acknowledgement contract (gateway envelope)

private func stubNotificationAPI(host: String, session: URLSession) throws -> GhostAPI {
    try GhostAPI(
        connection: Connection(server: "https://\(host)", token: String(repeating: "f", count: 64)),
        pendingFile: FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString)/pending.json"),
        session: session
    )
}

private func stubSessionFor(host: String, queue: ReplyQueue) -> URLSession {
    stubProtocolRegistry.install(queue, host: host)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GhostStubURLProtocol.self]
    return URLSession(configuration: configuration)
}

@Test func notificationInboxDecodesActualGatewayEnvelope() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let recipient = UUID().uuidString.lowercased()
    // The exact envelope the gateway produces: outer ok plus the Host
    // lifetime result with status and data.notifications (PHONE-004).
    let gatewayBody = JSON.object([
        "ok": .bool(true),
        "result": .object([
            "status": .string("success"),
            "summary": .string("notification inbox inspected"),
            "object_refs": .array([]),
            "artifacts": .array([]),
            "error_code": .null,
            "retry_class": .string("same_id"),
            "data": .object(["notifications": .array([.object([
                "id": .string("notification:1"),
                "conversation_id": .string(UUID().uuidString.lowercased()),
                "work_id": .string("work-1"),
                "goal_revision": .number(3),
                "event_kind": .string("briefing"),
                "state": .string("pending"),
            ])])]),
        ]),
    ])
    let queue = ReplyQueue([StubReply(statusCode: 200, body: encodedJSON(gatewayBody))])
    let session = stubSessionFor(host: host, queue: queue)
    defer { session.invalidateAndCancel(); stubProtocolRegistry.remove(host: host) }
    let api = try stubNotificationAPI(host: host, session: session)

    let items = try await api.notificationInbox(recipientID: recipient)
    #expect(items.count == 1)
    #expect(items[0].id == "notification:1")
    #expect(items[0].eventKind == "briefing")
    #expect(items[0].state == "pending")
    let captured = queue.captured()
    #expect(captured.paths == ["/mobile/v1/notifications/inspect"])
    #expect(try JSONDecoder().decode(JSON.self, from: captured.bodies[0])["recipient_id"] == .string(recipient))
}

@Test func notificationInboxRejectsForeignEnvelopeLevelsAndHostErrors() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let recipient = UUID().uuidString.lowercased()
    // The old wrong decode target: notifications at the result level.
    let legacy = JSON.object(["ok": .bool(true), "result": .object(["notifications": .array([])])])
    // A non-success Host status must never list notifications.
    let hostError = JSON.object(["ok": .bool(true), "result": .object([
        "status": .string("error"), "error_code": .string("invalid_request"),
        "data": .object(["notifications": .array([])]),
    ])])
    let queue = ReplyQueue([
        StubReply(statusCode: 200, body: encodedJSON(legacy)),
        StubReply(statusCode: 200, body: encodedJSON(hostError)),
    ])
    let session = stubSessionFor(host: host, queue: queue)
    defer { session.invalidateAndCancel(); stubProtocolRegistry.remove(host: host) }
    let api = try stubNotificationAPI(host: host, session: session)

    for _ in 0..<2 {
        do { _ = try await api.notificationInbox(recipientID: recipient); Issue.record("foreign envelope must throw") }
        catch { #expect(error is MobileError) }
    }
}

@Test func notificationAckRequiresHostAcceptedBindingAndKeepsFailuresVisible() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let recipient = UUID().uuidString.lowercased()
    let notificationID = "notification:7"
    func ackResult(_ data: JSON, status: String) -> JSON {
        .object(["ok": .bool(true), "result": .object([
            "status": .string(status), "summary": .string("notification delivery state recorded"),
            "object_refs": .array([.string(notificationID)]), "artifacts": .array([]),
            "error_code": status == "success" ? .null : .string("not_found"),
            "retry_class": .string("same_id"), "data": data,
        ])])
    }
    let accepted = ackResult(.object([
        "recipient_id": .string(recipient),
        "notification_id": .string(notificationID),
        "state": .string("client_seen"),
    ]), status: "success")
    let mismatched = ackResult(.object([
        "recipient_id": .string(UUID().uuidString.lowercased()),
        "notification_id": .string(notificationID),
        "state": .string("client_seen"),
    ]), status: "success")
    let hostRejected = ackResult(.null, status: "error")
    let queue = ReplyQueue([
        StubReply(statusCode: 200, body: encodedJSON(accepted)),
        StubReply(statusCode: 200, body: encodedJSON(mismatched)),
        StubReply(statusCode: 200, body: encodedJSON(hostRejected)),
        StubReply(statusCode: 502, body: encodedJSON(.object(["ok": .bool(false), "error": .string("host_acknowledgement_rejected")]))),
        StubReply(statusCode: 502, body: encodedJSON(.object(["ok": .bool(false), "error": .string("host_unavailable_or_outcome_unknown")]))),
        StubReply(statusCode: 404, body: encodedJSON(.object(["ok": .bool(false), "error": .string("notification_not_found")]))),
    ])
    let session = stubSessionFor(host: host, queue: queue)
    defer { session.invalidateAndCancel(); stubProtocolRegistry.remove(host: host) }
    let api = try stubNotificationAPI(host: host, session: session)

    // Only the bound Host success confirms the acknowledgement.
    try await api.acknowledgeNotification(recipientID: recipient, notificationID: notificationID, state: "client_seen")

    do {
        try await api.acknowledgeNotification(recipientID: recipient, notificationID: notificationID, state: "client_seen")
        Issue.record("mismatched binding must throw")
    } catch {
    }
    for _ in 0..<4 {
        do {
            try await api.acknowledgeNotification(recipientID: recipient, notificationID: notificationID, state: "client_seen")
            Issue.record("unconfirmed ack must throw")
        } catch {
        }
    }
    let captured = queue.captured()
    #expect(captured.paths.count == 6)
    #expect(captured.paths.allSatisfy { $0 == "/mobile/v1/notifications/ack" })
}

// MARK: Voice media classification contract

@Test func voiceOfferCarriesStartIdentityAndOnlyAdmissionFailuresAreDefinite() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let startID = UUID().uuidString.lowercased()
    let answer = JSON.object(["type": .string("answer"), "sdp": .string("v=0 answer"), "pc_id": .string("pc-1")])
    let queue = ReplyQueue([
        StubReply(statusCode: 200, body: encodedJSON(answer)),
        StubReply(statusCode: 400, body: encodedJSON(.object(["error": .string("offer_fields_invalid")]))),
        StubReply(statusCode: 502, body: encodedJSON(.object(["error": .string("voice_media_unavailable_or_outcome_unknown")]))),
        StubReply(statusCode: 409, body: encodedJSON(.object(["error": .string("voice_offer_in_progress")]))),
        StubReply(statusCode: 409, body: encodedJSON(.object(["error": .string("voice_start_unresolved")]))),
        StubReply(statusCode: 409, body: encodedJSON(.object(["error": .string("voice_start_limit")]))),
    ])
    let session = stubSessionFor(host: host, queue: queue)
    defer { session.invalidateAndCancel(); stubProtocolRegistry.remove(host: host) }
    let api = try stubNotificationAPI(host: host, session: session)

    let applied = try await api.offer(sdp: "v=0 offer", startID: startID)
    #expect(applied.pcID == "pc-1")
    let body = try JSONDecoder().decode(JSON.self, from: queue.captured().bodies[0])
    #expect(body["start_id"] == .string(startID))
    #expect(body["type"] == .string("offer"))
    #expect(body["sdp"] == .string("v=0 offer"))

    do { _ = try await api.offer(sdp: "v=0 offer", startID: startID); Issue.record("rejection must throw") }
    catch { #expect(VoiceMediaError.isDefinite(error), "definitive admission rejection") }
    // Post-dispatch outcomes never count as definitive no-session evidence.
    do { _ = try await api.offer(sdp: "v=0 offer", startID: startID); Issue.record("unknown outcome must throw") }
    catch { #expect(!VoiceMediaError.isDefinite(error), "502 stays unknown") }
    do { _ = try await api.offer(sdp: "v=0 offer", startID: startID); Issue.record("mid-creation must throw") }
    catch { #expect(!VoiceMediaError.isDefinite(error), "offer_in_progress stays unknown") }
    do { _ = try await api.offer(sdp: "v=0 offer", startID: startID); Issue.record("unresolved previous start must throw") }
    catch {
        #expect(!VoiceMediaError.isDefinite(error), "voice_start_unresolved is not no-session evidence")
    }
    do { _ = try await api.offer(sdp: "v=0 offer", startID: startID); Issue.record("ledger capacity refusal must throw") }
    catch {
        #expect(VoiceMediaError.isDefinite(error), "nothing is unresolved: capacity refusal is definitive for this attempt")
    }
}

@Test func voiceHangupOutcomesNeverCountAsClosureUnlessConfirmed() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let queue = ReplyQueue([
        StubReply(statusCode: 404, body: encodedJSON(.object(["error": .string("voice_session_not_found")]))),
        StubReply(statusCode: 502, body: encodedJSON(.object(["error": .string("voice_media_unavailable_or_outcome_unknown")]))),
        StubReply(statusCode: 200, body: encodedJSON(.object(["state": .string("ended"), "already_ended": .bool(true)]))),
    ])
    let session = stubSessionFor(host: host, queue: queue)
    defer { session.invalidateAndCancel(); stubProtocolRegistry.remove(host: host) }
    let api = try stubNotificationAPI(host: host, session: session)

    for _ in 0..<2 {
        do {
            try await api.hangup(pcID: "pc-1")
            Issue.record("lost end outcome must throw")
        } catch {
            #expect(!VoiceMediaError.isDefinite(error), "hangup absence is not closure")
        }
    }
    // The tombstone replay confirms the same owned session.
    try await api.hangup(pcID: "pc-1")
}

@Test func voiceStartStateParsesAgreedObservationContract() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let startID = UUID().uuidString.lowercased()
    let queue = ReplyQueue([
        StubReply(statusCode: 200, body: encodedJSON(.object(["state": .string("live"), "pc_id": .string("pc-1")]))),
        StubReply(statusCode: 200, body: encodedJSON(.object(["state": .string("ended"), "pc_id": .string("pc-1")]))),
        StubReply(statusCode: 404, body: encodedJSON(.object(["error": .string("voice_start_unknown")]))),
        StubReply(statusCode: 502, body: encodedJSON(.object(["error": .string("voice_start_unknown_outcome")]))),
        StubReply(statusCode: 200, body: encodedJSON(.object(["state": .string("live")]))),
        StubReply(statusCode: 403, body: encodedJSON(.object(["ok": .bool(false), "error": .string("voice_start_forbidden")]))),
    ])
    let session = stubSessionFor(host: host, queue: queue)
    defer { session.invalidateAndCancel(); stubProtocolRegistry.remove(host: host) }
    let api = try stubNotificationAPI(host: host, session: session)

    #expect(try await api.startState(startID: startID) == .live(pcID: "pc-1"))
    #expect(try await api.startState(startID: startID) == .ended(pcID: "pc-1"))
    #expect(try await api.startState(startID: startID) == .unknownStart)
    do { _ = try await api.startState(startID: startID); Issue.record("unresolvable evidence must throw") }
    catch { #expect(error is MobileError, "stays unknown, never treated as ended") }
    do { _ = try await api.startState(startID: startID); Issue.record("observation without pc_id must throw") }
    catch { #expect(error is MobileError) }
    do { _ = try await api.startState(startID: startID); Issue.record("foreign-principal evidence must throw") }
    catch {
        #expect(error is MobileError, "voice_start_forbidden never clears the fence")
    }
    let captured = queue.captured()
    #expect(captured.paths.allSatisfy { $0 == "/mobile/v1/voice/starts/\(startID)" })
}

@Test func nativePiArtifactIdentityAndInvalidTraversal() async throws {
    let host = "\(UUID().uuidString.lowercased()).stub.invalid"
    let workID = UUID().uuidString.lowercased(), executionID = "pi-" + String(repeating: "a", count: 64)
    let bytes = Data("diagnostic\n".utf8), digest = "d8bcbfa307f670d5532559fc030ee82ff7be48160c1fff837950e0d7528d0a4c"
    let artifact: JSON = .object(["work_id": .string(workID), "execution_id": .string(executionID), "goal_id": .string(UUID().uuidString.lowercased()), "goal_revision": .number(1), "digest": .string(digest), "privacy": .string("local_only"), "encoding": .string("base64"), "byte_length": .number(Double(bytes.count)), "data": .string(bytes.base64EncodedString())])
    let reply: JSON = .object(["ok": .bool(true), "result": .object(["status": .string("success"), "summary": .string("artifact"), "object_refs": .array([]), "artifacts": .array([]), "next_actions": .array([]), "retry_class": .string("same_id"), "error_code": .null, "data": artifact])])
    let queue = ReplyQueue([StubReply(statusCode: 200, body: encodedJSON(reply))])
    stubProtocolRegistry.install(queue, host: host); defer { stubProtocolRegistry.remove(host: host) }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [GhostStubURLProtocol.self]
    let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
    let api = GhostAPI(connection: try Connection(server: "https://\(host)", token: String(repeating: "a", count: 64)), pendingFile: FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString)/pending.json"), lifetimeIdentity: try LifetimeIdentity(authorityEpoch: 1), lifetimeNamespace: try LifetimeJournalNamespace(workspaceID: UUID().uuidString, deviceID: UUID().uuidString, authorityEpoch: 1), lifetimeCapabilities: ["lifetime.read"], session: session)
    let content = try await api.readWorkArtifact(workID: workID, executionID: executionID, digest: digest, locator: "/owned/artifact.json")
    #expect(content.data == bytes); #expect(content.executionID == executionID)
    for invalid in ["pi-../secret", "pi-" + String(repeating: "A", count: 64), "pi-" + String(repeating: "a", count: 63)] {
        await #expect(throws: MobileError.self) { try await api.readWorkArtifact(workID: workID, executionID: invalid, digest: digest, locator: "/owned/artifact.json") }
    }
    #expect(queue.captured().paths.count == 1)
}
