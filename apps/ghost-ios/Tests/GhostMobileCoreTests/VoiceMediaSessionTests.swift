import XCTest
import os
@testable import GhostMobileCore

// Contract tests for the native media signaling lifetime: a late offer
// answer must still end its session, ending keeps the identifier on failure,
// and no new call starts before the previous end is confirmed.
final class VoiceMediaSessionTests: XCTestCase {
    private final class Recorder: VoiceMediaTransport, @unchecked Sendable {
        private let state = OSAllocatedUnfairLock<RecorderState>(initialState: RecorderState())

        func offer(sdp: String, startID: String) async throws -> VoiceMediaAnswer {
            // While held, the response is "in flight": end() can happen
            // before the server answer arrives.
            while state.withLock({ $0.held }) {
                try? await Task.sleep(for: .milliseconds(5))
            }
            let result: RecorderState = state.withLock { $0.record(offer: sdp, startID: startID) }
            switch result.offerResult {
            case .success(let answer): return answer
            case .failure(let error): throw error
            case nil: throw MobileError.response("offer response lost")
            }
        }
        func holdOffer() { state.withLock { $0.held = true } }
        func releaseOffer() { state.withLock { $0.held = false } }
        func ice(pcID: String, candidates: [VoiceICECandidate]) async throws -> Int { candidates.count }
        func cancelTurn(pcID: String, turnID: String) async throws -> VoiceTurnCancelState {
            VoiceTurnCancelState(turnID: turnID, state: "cancelled", cancelRequested: true, cancelCompleted: true)
        }
        func hangup(pcID: String) async throws {
            let result = state.withLock { $0.record(hangup: pcID) }
            if case .failure(let error) = result.hangupResult { throw error }
        }
        func startState(startID: String) async throws -> VoiceStartObservation {
            try state.withLock { $0.startObservation }.get()
        }
        func failOffer() {
            state.withLock { $0.offerResult = .failure(VoiceMediaError.definite("서버가 음성 연결 요청을 거절했습니다.")) }
        }
        func failHangup() {
            state.withLock { $0.hangupResult = .failure(MobileError.response("음성 서버의 응답을 확인하지 못했습니다.")) }
        }
        func succeedHangup() {
            state.withLock { $0.hangupResult = .success(()) }
        }
        func succeedOffer(pcID: String) {
            state.withLock { $0.offerResult = .success(VoiceMediaAnswer(sdp: "answer", pcID: pcID)) }
        }
        func observe(_ observation: VoiceStartObservation) {
            state.withLock { $0.startObservation = .success(observation) }
        }
        var recordedHangups: [String] { state.withLock { $0.hangups } }
        var recordedStartIDs: [String] { state.withLock { $0.startIDs } }
    }

    private final class RecorderState: @unchecked Sendable {
        var offers: [String] = []
        var startIDs: [String] = []
        var hangups: [String] = []
        var offerResult: Result<VoiceMediaAnswer, Error>?
        var hangupResult: Result<Void, Error> = .success(())
        var startObservation: Result<VoiceStartObservation, Error> = .failure(MobileError.response("start observation unavailable"))
        var held = false

        func record(offer sdp: String, startID: String) -> RecorderState { offers.append(sdp); startIDs.append(startID); return self }
        func record(hangup pcID: String) -> RecorderState { hangups.append(pcID); return self }
    }

    func testLateOfferResponseAfterEndStillHangsUp() async throws {
        let transport = Recorder()
        let session = VoiceMediaSession(transport: transport, startID: "00000000-0000-4000-8000-000000000001")
        transport.holdOffer()
        transport.succeedOffer(pcID: "pc-1")
        let begin = Task { try await session.begin(offerSDP: "v=0 offer") }
        try await Task.sleep(for: .milliseconds(50))
        let ending = Task { try await session.end() }
        try await Task.sleep(for: .milliseconds(50))
        transport.releaseOffer()
        // The answer arrives after the user already ended the call; ending
        // completes once the late session is hung up with its own identifier.
        _ = try? await begin.value
        try await ending.value
        XCTAssertEqual(transport.recordedHangups, ["pc-1"], "late session must be ended with its own identifier")
    }

    func testDefiniteOfferRejectionLeavesNoIdentifierToHangUp() async throws {
        let transport = Recorder()
        transport.failOffer()
        let session = VoiceMediaSession(transport: transport, startID: "00000000-0000-4000-8000-000000000001")
        do { _ = try await session.begin(offerSDP: "v=0"); XCTFail("rejection must throw") }
        catch { }
        XCTAssertTrue(transport.recordedHangups.isEmpty)
        // A fresh call is allowed again after a definite rejection.
        transport.succeedOffer(pcID: "pc-2")
        let answer = try await session.begin(offerSDP: "v=0")
        XCTAssertEqual(answer.pcID, "pc-2")
    }

    func testAmbiguousOfferFailureReportsUnknownStart() async throws {
        let transport = Recorder()
        let session = VoiceMediaSession(transport: transport, startID: "00000000-0000-4000-8000-000000000001")
        let begin = Task { try await session.begin(offerSDP: "v=0") }
        _ = try? await begin.value // response lost: no identifier exists
        do { try await session.end(); XCTFail("unknown start must stay unresolved") }
        catch {
            XCTAssertTrue(error.localizedDescription.contains("불명확") || error.localizedDescription.contains("확인"), error.localizedDescription)
        }
        XCTAssertTrue(transport.recordedHangups.isEmpty)
    }

    func testFailedHangupKeepsIdentifierForRetryAndNewCallIsBlocked() async throws {
        let transport = Recorder()
        let session = VoiceMediaSession(transport: transport, startID: "00000000-0000-4000-8000-000000000001")
        transport.succeedOffer(pcID: "pc-3")
        _ = try await session.begin(offerSDP: "v=0")
        transport.failHangup()
        do { try await session.end(); XCTFail("unconfirmed hangup must throw") }
        catch { }
        XCTAssertEqual(transport.recordedHangups, ["pc-3"])
        do { _ = try await session.begin(offerSDP: "v=0"); XCTFail("previous end is unconfirmed") }
        catch { }
        transport.succeedHangup()
        try await session.end()
        XCTAssertEqual(transport.recordedHangups, ["pc-3", "pc-3"], "retry ends the same session")
        transport.succeedOffer(pcID: "pc-4")
        let next = try await session.begin(offerSDP: "v=0")
        XCTAssertEqual(next.pcID, "pc-4")
    }

    func testLateAnswerCancelWithFailingHangupStaysRetryableThroughActor() async throws {
        // PHONE-005: the actor learns the identifier from a late answer even
        // though the controller never saw it; every end attempt reuses that
        // exact identifier and the retry runs through the owning actor.
        let transport = Recorder()
        let session = VoiceMediaSession(transport: transport, startID: "00000000-0000-4000-8000-000000000002")
        transport.holdOffer()
        transport.succeedOffer(pcID: "pc-1")
        transport.failHangup()
        let begin = Task { try await session.begin(offerSDP: "v=0") }
        try await Task.sleep(for: .milliseconds(50))
        let ending = Task { try await session.end() }
        try await Task.sleep(for: .milliseconds(50))
        transport.releaseOffer()
        _ = try? await begin.value
        do { try await ending.value; XCTFail("unconfirmed end must throw") }
        catch { }
        let activePCID = await session.activePCID
        XCTAssertEqual(activePCID, "pc-1", "the actor keeps the late answer's identifier")
        transport.succeedHangup()
        try await session.end()
        let endedPCID = await session.activePCID
        XCTAssertNil(endedPCID, "confirmed retry clears the unresolved session")
    }

    func testAmbiguousStartAdoptsObservedSessionAndEndsSameIdentifier() async throws {
        // PHONE-003: an ambiguous start never fakes closure. The agreed
        // start observation resolves it: a live session is adopted under its
        // own identifier and ended; only then is a fresh call allowed.
        let startID = "00000000-0000-4000-8000-000000000003"
        let transport = Recorder()
        let session = VoiceMediaSession(transport: transport, startID: startID)
        transport.holdOffer()
        let begin = Task { try await session.begin(offerSDP: "v=0") }
        try await Task.sleep(for: .milliseconds(50))
        transport.releaseOffer()
        _ = try? await begin.value
        do { try await session.end(); XCTFail("unknown start must stay unresolved") }
        catch { }
        XCTAssertTrue(transport.recordedHangups.isEmpty, "no hangup may be guessed without an identifier")
        try await session.adopt(pcID: "pc-observed")
        do { _ = try await session.adopt(pcID: "pc-other"); XCTFail("double adoption must be refused") }
        catch { }
        transport.succeedHangup()
        try await session.end()
        XCTAssertEqual(transport.recordedHangups, ["pc-observed"], "the observed session is ended with its own identifier")
        transport.succeedOffer(pcID: "pc-next")
        let next = try await session.begin(offerSDP: "v=0")
        XCTAssertEqual(next.pcID, "pc-next", "confirmed closure re-opens admission")
        XCTAssertEqual(transport.recordedStartIDs, [startID, startID], "every offer for this actor carries the same start identity")
    }

    func testUnconfirmedEndRetriesThroughReconnectedTransport() async throws {
        let old = Recorder()
        let session = VoiceMediaSession(transport: old, startID: "00000000-0000-4000-8000-000000000004")
        old.succeedOffer(pcID: "pc-7")
        old.failHangup()
        _ = try await session.begin(offerSDP: "v=0")
        do { try await session.end(); XCTFail("unconfirmed end must throw") }
        catch { }
        XCTAssertEqual(old.recordedHangups, ["pc-7"])
        // After a reconnect the retained actor keeps its identity but sends
        // through the fresh connection.
        let fresh = Recorder()
        fresh.succeedHangup()
        await session.adoptTransport(fresh)
        try await session.end()
        XCTAssertEqual(old.recordedHangups, ["pc-7"])
        XCTAssertEqual(fresh.recordedHangups, ["pc-7"], "the same identifier ends through the new transport")
        let activePCID = await session.activePCID
        XCTAssertNil(activePCID)
    }

    func testNotificationInboxValidationAcceptsContractAndRejectsForeignFields() throws {
        let valid = try validatedNotificationInbox(.object([
            "notifications": .array([.object([
                "id": .string("notification:1"), "conversation_id": .string("11111111-1111-4111-8111-111111111111"),
                "work_id": .string("work-1"), "goal_revision": .number(3),
                "event_kind": .string("result"), "state": .string("pending"),
            ])]),
        ]))
        XCTAssertEqual(valid.count, 1)
        XCTAssertThrowsError(try validatedNotificationInbox(.object([
            "notifications": .array([.object([
                "id": .string("notification:1"), "conversation_id": .string("nope"),
                "work_id": .string("work-1"), "goal_revision": .number(3),
                "event_kind": .string("result"), "state": .string("pending"),
            ])]),
        ])))
    }
}
