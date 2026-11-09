import Foundation
import Testing
@testable import GhostMobileCore

@Suite struct PairingQRTests {
    private let offerJSON = "ghost://pair?origin=https%3A%2F%2Fghost.example.com%3A8443&code=AB12CD"

    @Test func parsesCanonicalPairingURL() throws {
        let offer = try PairingQR.parse(offerJSON)
        #expect(offer.origin.absoluteString == "https://ghost.example.com:8443")
        #expect(offer.code == "AB12CD")
    }

    @Test func normalizesSchemeHostCaseAndDefaultPort() throws {
        let offer = try PairingQR.parse("GHOST://PAIR?origin=HTTPS%3A%2F%2FGHOST.Example.com%3A443&code=AB12CD")
        #expect(offer.origin.absoluteString == "https://ghost.example.com")
        #expect(offer.code == "AB12CD")
    }

    @Test func acceptsLoopbackHTTPOrigin() throws {
        let offer = try PairingQR.parse("ghost://pair?origin=http%3A%2F%2F127.0.0.1%3A43110&code=AB12CD")
        #expect(offer.origin.absoluteString == "http://127.0.0.1:43110")
    }

    @Test func buildsRoundTripURL() throws {
        let origin = try canonicalOrigin("https://ghost.example.com:8443")
        let url = try #require(PairingQR.build(origin: origin, code: "AB12CD"))
        let parsed = try PairingQR.parse(url.absoluteString)
        #expect(parsed.origin == origin)
        #expect(parsed.code == "AB12CD")
    }

    @Test func rejectsMaliciousOrMalformedPairingURL() {
        let cases = [
            "ghost://connect?origin=https%3A%2F%2Fghost.example.com&code=AB12CD",
            "https://ghost.example.com?origin=https%3A%2F%2Fghost.example.com&code=AB12CD",
            "ghost://pair?origin=https%3A%2F%2Fghost.example.com",
            "ghost://pair?code=AB12CD",
            "ghost://pair?origin=https%3A%2F%2Fghost.example.com&code=AB12CD&extra=1",
            "ghost://pair?origin=https%3A%2F%2Fghost.example.com&code=AB12CD&code=ZZ99ZZ",
            "ghost://pair?origin=https%3A%2F%2Fghost.example.com&code=ABC",
            "ghost://pair?origin=https%3A%2F%2Fghost.example.com&code=%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20AB12CD",
            "ghost://pair?origin=http%3A%2F%2Fghost.example.com&code=AB12CD",
            "ghost://pair?origin=https%3A%2F%2Fuser%40ghost.example.com&code=AB12CD",
            "ghost://pair?origin=https%3A%2F%2Fghost.example.com%2Fapi&code=AB12CD",
            "ghost://pair?origin=https%3A%2F%2Fghost.example.com%3Fx%3D1&code=AB12CD",
            "ghost://pair/pivot?origin=https%3A%2F%2Fghost.example.com&code=AB12CD",
            "ghost://pair?origin=ftp%3A%2F%2Fghost.example.com&code=AB12CD",
            "ghost://pair?origin=%20&code=AB12CD",
        ]
        for raw in cases {
            #expect(throws: (any Error).self) { try PairingQR.parse(raw) }
        }
    }

    @Test func canonicalOriginRejectsFreeFormURLs() throws {
        #expect(throws: MobileError.self) { try canonicalOrigin("https://ghost.example.com/api") }
        #expect(throws: MobileError.self) { try canonicalOrigin("https://user:pass@ghost.example.com") }
        #expect(throws: MobileError.self) { try canonicalOrigin("http://ghost.example.com") }
        #expect(try canonicalOrigin(" http://LOCALHOST:43110 ").absoluteString == "http://localhost:43110")
        #expect(try canonicalOrigin("https://ghost.example.com:443").absoluteString == "https://ghost.example.com")
    }
}

@Suite struct PairingSessionTests {
    private func makeContext() -> (PairingSession, StubLane, PairingOffer, URL) {
        let (origin, lane) = makeStubOrigin()
        let store = FileManager.default.temporaryDirectory
            .appending(path: "pairing-tests/\(UUID().uuidString)/attempt.json")
        let session = PairingSession(store: PairingFileStore(file: store)) { laneOrigin in
            PairingClient(origin: laneOrigin, session: StubURLProtocol.makeSession())
        }
        let offer = PairingOffer(origin: origin, code: "AB12CD")
        return (session, lane, offer, store)
    }

    private func successfulResult() -> Data {
        stubJSON(PairingResult(deviceId: "device-1", token: "token-1"))
    }

    @Test func claimPersistsAttemptBeforeNetworkAndStoresResult() async throws {
        let (session, registry, offer, store) = makeContext()
        let attempt = try await session.begin(offer, deviceName: "Test iPhone")
        #expect(attempt.code == "AB12CD")
        #expect(attempt.deviceName == "Test iPhone")
        // The attempt is durable before the claim leaves the device, and
        // begin() itself touches no network.
        #expect(try PairingFileStore(file: store).load() == attempt)
        #expect(registry.allRequests().isEmpty)

        registry.enqueue(StubResponse(action: .reply(status: 200, body: successfulResult())))
        let result = try await session.claim()
        let requests = registry.allRequests()
        #expect(requests.count == 1)
        #expect(requests[0].method == "POST")
        #expect(requests[0].path == "/api/pairing/claim")
        let body = try #require(JSONSerialization.jsonObject(with: requests[0].body) as? [String: Any])
        #expect(body["code"] as? String == "AB12CD")
        #expect(body["deviceName"] as? String == "Test iPhone")
        #expect(result.deviceId == "device-1")
        #expect(result.token == "token-1")
        // A completed pairing leaves no attempt behind.
        let restored = await session.restore()
        #expect(restored == nil)
    }

    @Test func unknownNetworkOutcomeKeepsAttemptAndRetriesIdentically() async throws {
        let (session, registry, offer, _) = makeContext()
        let attempt = try await session.begin(offer, deviceName: "Test iPhone")
        registry.enqueue(StubResponse(action: .networkFailure))
        await #expect(throws: URLError.self) { try await session.claim() }
        // The interrupted attempt survives; the retry sends the same bytes.
        let restored = try #require(await session.restore())
        #expect(restored == attempt)
        registry.clearRequests()
        registry.enqueue(StubResponse(action: .reply(status: 200, body: successfulResult())))
        let result = try await session.claim()
        #expect(result.deviceId == "device-1")
        let retried = registry.allRequests()
        #expect(retried.count == 1)
        #expect(retried[0].body == Data(#"{"code":"AB12CD","deviceName":"Test iPhone"}"#.utf8))
    }

    @Test func definitiveRejectionClearsAttempt() async throws {
        let (session, registry, offer, store) = makeContext()
        _ = try await session.begin(offer, deviceName: "Test iPhone")
        let rejection = json(#"{"ok":false,"error":{"code":"conflict","message":"pairing code already used"}}"#)
        registry.enqueue(StubResponse(action: .reply(status: 409, body: rejection)))
        await #expect(throws: CommandError.self) { try await session.claim() }
        let restored = await session.restore()
        #expect(restored == nil)
        #expect(try PairingFileStore(file: store).load() == nil)
    }

    @Test func emptyDeviceNameFallsBackAndBounded() async throws {
        let (session, registry, offer, _) = makeContext()
        let attempt = try await session.begin(offer, deviceName: "   ")
        #expect(attempt.deviceName == "내 iPhone")
        let long = String(repeating: "가", count: 140)
        registry.setDefault(StubResponse(action: .reply(status: 200, body: successfulResult())))
        _ = try await session.begin(offer, deviceName: long)
        let bounded = try await session.claim()
        #expect(bounded.deviceId == "device-1")
        let lastBody = try #require(registry.allRequests().last?.body)
        let fields = try #require(JSONSerialization.jsonObject(with: lastBody) as? [String: Any])
        #expect((fields["deviceName"] as? String)?.count == 100)
    }

    @Test func attemptSurvivesRelaunchThroughStore() async throws {
        let (session, registry, offer, store) = makeContext()
        _ = try await session.begin(offer, deviceName: "Test iPhone")
        // A new session over the same store sees the exact attempt.
        let relaunched = PairingSession(store: PairingFileStore(file: store)) { origin in
            PairingClient(origin: origin, session: StubURLProtocol.makeSession())
        }
        let restored = await relaunched.restore()
        #expect(restored == PairingAttempt(origin: offer.origin, code: "AB12CD", deviceName: "Test iPhone"))
        registry.enqueue(StubResponse(action: .reply(status: 200, body: successfulResult())))
        let result = try await relaunched.claim()
        #expect(result.token == "token-1")
    }

    @Test func cancelClearsTheAttempt() async throws {
        let (session, _, offer, store) = makeContext()
        _ = try await session.begin(offer, deviceName: "Test iPhone")
        await session.cancel()
        let restored = await session.restore()
        #expect(restored == nil)
        #expect(try PairingFileStore(file: store).load() == nil)
    }
}
