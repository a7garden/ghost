import Foundation
import Testing
@testable import GhostMobileCore

// Durable voice fence contract: the record survives relaunch, binds to the
// creating gateway/workspace/device/authority, and only that principal may
// reconcile it. A foreign connection or a lost binding never clears.
final class VoiceCallFenceStoreTests {
    private func temporaryFenceFile() -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "\(UUID().uuidString)/voice-fence.json")
    }

    private func sampleFence(origin: String = "https://gateway.example:8443",
                             workspaceID: String = "11111111-1111-4111-8111-111111111111",
                             deviceID: String = "22222222-2222-4222-8222-222222222222",
                             authorityEpoch: UInt64? = nil,
                             pcID: String? = nil,
                             kind: VoiceCallFence.Kind = .unknownStart) -> VoiceCallFence {
        VoiceCallFence(
            startID: "33333333-3333-4333-8333-333333333333",
            pcID: pcID, kind: kind,
            ghostID: "ghost-1", conversationID: "44444444-4444-4444-8444-444444444444",
            origin: origin, workspaceID: workspaceID, deviceID: deviceID,
            authorityEpoch: authorityEpoch, createdAt: Date(timeIntervalSince1970: 1_760_000_000))
    }

    @Test func fenceSurvivesRelaunchAndBindsOriginalPrincipal() throws {
        let file = temporaryFenceFile()
        let fence = sampleFence(pcID: "pc-crash", kind: .unconfirmedEnd)
        try VoiceCallFenceStore(file: file).save(fence)

        // A new store instance reads the same disk state after relaunch.
        let restored = try VoiceCallFenceStore(file: file).load()
        #expect(restored == fence)
        #expect(restored?.pcID == "pc-crash")
        #expect(restored?.kind == .unconfirmedEnd)

        VoiceCallFenceStore(file: file).remove()
        #expect(try VoiceCallFenceStore(file: file).load() == nil, "authoritative closure clears the durable record")
    }

    @Test func corruptedRecordIsNotMistakenForAbsenceEvidence() throws {
        let file = temporaryFenceFile()
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let corrupted = Data("broken".utf8)
        try corrupted.write(to: file)
        #expect(throws: DecodingError.self) {
            try VoiceCallFenceStore(file: file).load()
        }
        #expect(try Data(contentsOf: file) == corrupted, "failed recovery preserves the evidence")
    }

    @Test func reconciliationOnlyThroughTheOriginalPrincipal() {
        let fence = sampleFence(authorityEpoch: 7)
        let bound = VoiceCallConnectionIdentity(
            origin: "https://gateway.example:8443",
            workspaceID: "11111111-1111-4111-8111-111111111111",
            deviceID: "22222222-2222-4222-8222-222222222222",
            authorityEpoch: 7)
        #expect(isVoiceCallFence(fence, boundTo: bound), "the creating principal reconciles")

        let foreignOrigin = bound
        #expect(!isVoiceCallFence(fence, boundTo: VoiceCallConnectionIdentity(
            origin: "https://other.example", workspaceID: foreignOrigin.workspaceID,
            deviceID: foreignOrigin.deviceID, authorityEpoch: 7)), "different gateway origin is foreign")
        #expect(!isVoiceCallFence(fence, boundTo: VoiceCallConnectionIdentity(
            origin: bound.origin, workspaceID: "99999999-9999-4999-8999-999999999999",
            deviceID: bound.deviceID, authorityEpoch: 7)), "different workspace is foreign")
        #expect(!isVoiceCallFence(fence, boundTo: VoiceCallConnectionIdentity(
            origin: bound.origin, workspaceID: bound.workspaceID,
            deviceID: "88888888-8888-4888-8888-888888888888", authorityEpoch: 7)),
            "a re-paired device is a foreign principal")
        #expect(!isVoiceCallFence(fence, boundTo: VoiceCallConnectionIdentity(
            origin: bound.origin, workspaceID: bound.workspaceID,
            deviceID: bound.deviceID, authorityEpoch: 8)), "a different authority generation is foreign")
    }

    @Test func ownerAndLifetimeBindingsDoNotCross() {
        let ownerFence = sampleFence(authorityEpoch: nil)
        let owner = VoiceCallConnectionIdentity(
            origin: ownerFence.origin, workspaceID: ownerFence.workspaceID,
            deviceID: ownerFence.deviceID, authorityEpoch: nil)
        #expect(isVoiceCallFence(ownerFence, boundTo: owner))
        #expect(!isVoiceCallFence(ownerFence, boundTo: VoiceCallConnectionIdentity(
            origin: ownerFence.origin, workspaceID: ownerFence.workspaceID,
            deviceID: ownerFence.deviceID, authorityEpoch: 1)),
            "owner-binding never reconciles through a lifetime authority")
    }

    @Test func identityFailsClosedWithoutAuthenticatedBinding() {
        let origin = "https://gateway.example"
        // No device identity in the bootstrap: no invented scope.
        #expect(VoiceCallConnectionIdentity(bootstrap: .object(["role": .string("owner"), "workspace_id": .string("w")]), origin: origin) == nil)
        #expect(VoiceCallConnectionIdentity(bootstrap: .object(["role": .string("owner"), "device": .object(["id": .string("d")])]), origin: origin) == nil)
        // Lifetime authority requires a usable epoch.
        #expect(VoiceCallConnectionIdentity(bootstrap: .object([
            "role": .string("lifetime"),
            "device": .object(["id": .string("d")]),
            "lifetime_host": .object(["workspace_id": .string("w")]),
        ]), origin: origin) == nil)
        let lifetime = VoiceCallConnectionIdentity(bootstrap: .object([
            "role": .string("lifetime"),
            "device": .object(["id": .string("d")]),
            "lifetime_host": .object(["workspace_id": .string("w"), "authority_epoch": .number(3)]),
        ]), origin: origin)
        #expect(lifetime?.authorityEpoch == 3)
    }

    @Test func restoredActorEndsTheRecordedSessionWithItsOwnIdentifier() async throws {
        let transport = RelaunchRecorder()
        // A persisted unconfirmed end: the identifier is known, the start is
        // resolved, and only ending remains.
        let session = VoiceMediaSession(
            transport: transport, startID: "33333333-3333-4333-8333-333333333333",
            restoringPCID: "pc-relaunch", unresolvedStart: false)
        try await session.end()
        #expect(transport.hangups == ["pc-relaunch"], "relaunch reconcile ends the recorded session, not a new one")
        #expect(await session.activePCID == nil)

        // A persisted unknown start has no identifier: ending stays refused
        // until the observation provides one to adopt.
        let ambiguous = VoiceMediaSession(
            transport: transport, startID: "33333333-3333-4333-8333-333333333333",
            restoringPCID: nil, unresolvedStart: true)
        do { try await ambiguous.end(); Issue.record("restored unknown start must stay unresolved") }
        catch { }
        #expect(transport.hangups == ["pc-relaunch"])
        try await ambiguous.adopt(pcID: "pc-observed")
        try await ambiguous.end()
        #expect(transport.hangups == ["pc-relaunch", "pc-observed"])
    }
}

private final class RelaunchRecorder: VoiceMediaTransport, @unchecked Sendable {
    var hangups: [String] = []
    func offer(sdp: String, startID: String) async throws -> VoiceMediaAnswer {
        Issue.record("a restored fence must never offer again")
        throw MobileError.response("restored fence must not start media")
    }
    func ice(pcID: String, candidates: [VoiceICECandidate]) async throws -> Int { candidates.count }
    func cancelTurn(pcID: String, turnID: String) async throws -> VoiceTurnCancelState {
        VoiceTurnCancelState(turnID: turnID, state: "cancelled", cancelRequested: true, cancelCompleted: true)
    }
    func hangup(pcID: String) async throws { hangups.append(pcID) }
    func startState(startID: String) async throws -> VoiceStartObservation {
        .live(pcID: "pc-observed")
    }
}
