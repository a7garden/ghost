import Foundation
import Testing
@testable import GhostMobileCore

private actor CallTransport {
    var commands: [JSON] = []
    var delayedStart: Bool
    var endFailures: Int
    var startContinuation: CheckedContinuation<JSON, any Error>?
    var observers: [CheckedContinuation<Void, Never>] = []
    init(delayedStart: Bool = false, endFailures: Int = 0) { self.delayedStart = delayedStart; self.endFailures = endFailures }
    func perform(_ command: JSON) async throws -> JSON {
        commands.append(command)
        let operation = command["action"]["type"].text
        if operation == "voice_start" {
            if delayedStart {
                return try await withCheckedThrowingContinuation { continuation in
                    startContinuation = continuation
                    observers.forEach { $0.resume() }; observers = []
                }
            }
            return .object(["call_id": .string("original-call"), "sdp": .string("answer")])
        }
        if operation == "voice_end", endFailures > 0 { endFailures -= 1; throw MobileError.response("connection lost") }
        return .object(["ok": .bool(true)])
    }
    func waitForStart() async {
        if startContinuation != nil { return }
        await withCheckedContinuation { observers.append($0) }
    }
    func finishStart() { startContinuation?.resume(returning: .object(["call_id": .string("late-call")])); startContinuation = nil }
}

@Test(.timeLimit(.minutes(1))) func closingDuringSignallingEndsTheLateCallAndRejectsFurtherStarts() async throws {
    let transport = CallTransport(delayedStart: true)
    let session = VoiceCallSession(profileID: "ghost", conversationID: "conversation", action: { try await transport.perform($0) })
    let starting = Task { try await session.start(sdp: .string("offer")) }
    await transport.waitForStart()
    let closing = Task { try await session.close() }
    // Wait for the actor's close transition, not for a timing-dependent delay.
    while !(await session.closed) { await Task.yield() }
    await transport.finishStart()
    await #expect(throws: MobileError.self) { try await starting.value }
    try await closing.value
    let commands = await transport.commands
    #expect(commands.filter { $0["action"]["type"].text == "voice_end" }.count == 1)
    #expect(commands.last?["action"]["call_id"].text == "late-call")
    await #expect(throws: MobileError.self) { try await session.start(sdp: .string("new")) }
}

@Test func unknownStartOutcomeIsNeverReportedAsConfirmedEnded() async throws {
    let session = VoiceCallSession(profileID: "ghost", conversationID: "conversation", action: { _ in throw MobileError.response("response lost") })
    await #expect(throws: MobileError.self) { try await session.start(sdp: .string("offer")) }
    await #expect(throws: MobileError.self) { try await session.end() }
    await #expect(throws: MobileError.self) { try await session.start(sdp: .string("second")) }
}

@Test func failedHangupRetainsCallIdentityForRetryAndBlocksNewCalls() async throws {
    let transport = CallTransport(endFailures: 1)
    let session = VoiceCallSession(profileID: "ghost", conversationID: "conversation", action: { try await transport.perform($0) })
    _ = try await session.start(sdp: .string("offer"))
    await #expect(throws: MobileError.self) { try await session.end() }
    await #expect(throws: MobileError.self) { try await session.start(sdp: .string("second")) }
    await #expect(throws: MobileError.self) { try await session.work(id: .string("work"), prompt: .string("no longer connected")) }
    try await session.end()
    let endings = await transport.commands.filter { $0["action"]["type"].text == "voice_end" }
    #expect(endings.count == 2)
    #expect(endings.allSatisfy { $0["action"]["call_id"].text == "original-call" })
    _ = try await session.start(sdp: .string("new-call"))
}

@Test func voiceActionsRemainBoundToTheOriginalGhostAndCall() async throws {
    let transport = CallTransport()
    let session = VoiceCallSession(profileID: "ghost", conversationID: "conversation", action: { try await transport.perform($0) })
    _ = try await session.start(sdp: .string("offer"))
    _ = try await session.event(id: .string("event"), role: .string("user"), transcript: .string("hello"))
    _ = try await session.work(id: .string("work"), prompt: .string("continue"))
    try await session.end()
    let commands = await transport.commands
    #expect(commands.first?["action"]["profile_id"].text == "ghost")
    #expect(commands.first?["action"]["conversation_id"].text == "conversation")
    #expect(commands.dropFirst().allSatisfy { $0["action"]["call_id"].text == "original-call" })
    #expect(commands.allSatisfy { $0["action"]["type"].text != "cancel" })
}
