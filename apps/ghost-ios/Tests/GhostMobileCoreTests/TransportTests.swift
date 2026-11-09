import Foundation
import Testing
@testable import GhostMobileCore

@Suite struct ShellBridgeTests {
    private let connection = Connection(origin: URL(string: "https://macstudio.example.ts.net:8443")!, deviceId: "device-1", token: "tok\"en</script>\u{2028}")

    /// The JSON literal the bootstrap script assigns to `s`.
    private func bootstrapPayload(_ script: String) throws -> [String: String] {
        let start = try #require(script.range(of: "var s = "))
        let end = try #require(script.range(of: ";\n", range: start.upperBound..<script.endIndex))
        let literal = String(script[start.upperBound..<end.lowerBound])
        return try #require(JSONSerialization.jsonObject(with: Data(literal.utf8)) as? [String: String])
    }

    @Test func bootstrapCarriesTokenAndIdentityForThePairedOriginOnly() throws {
        let script = Shell.bootstrapScript(connection: connection, version: "6")
        let payload = try bootstrapPayload(script)
        #expect(payload["token"] == connection.token)
        #expect(payload["origin"] == "https://macstudio.example.ts.net:8443")
        #expect(payload["deviceId"] == "device-1")
        #expect(payload["version"] == "6")
        #expect(payload["platform"] == "ios")
        #expect(script.contains("if (window.location.origin !== s.origin) return;"))
    }

    @Test func originMatchesWhatThePageReports() throws {
        #expect(Shell.origin(URL(string: "https://ghost.example.com")!) == "https://ghost.example.com")
        #expect(Shell.origin(URL(string: "https://Ghost.Example.com:8443/path?q=1")!) == "https://ghost.example.com:8443")
        #expect(Shell.origin(URL(string: "http://[::1]:62199")!) == "http://[::1]:62199")
        #expect(Shell.origin(scheme: "http", host: "[::1]", port: 62199) == Shell.origin(scheme: "HTTP", host: "::1", port: 62199))
    }

    @Test func navigationStaysOnlyOnThePairedHost() {
        let paired = connection.origin
        #expect(Shell.staysInside(URL(string: "https://macstudio.example.ts.net:8443/#/ghosts/a")!, origin: paired))
        #expect(Shell.staysInside(URL(string: "about:srcdoc")!, origin: paired))
        #expect(Shell.staysInside(URL(string: "blob:https://macstudio.example.ts.net:8443/1")!, origin: paired))
        #expect(!Shell.staysInside(URL(string: "https://macstudio.example.ts.net/")!, origin: paired))
        #expect(!Shell.staysInside(URL(string: "http://macstudio.example.ts.net:8443/")!, origin: paired))
        #expect(!Shell.staysInside(URL(string: "https://evil.macstudio.example.ts.net:8443/")!, origin: paired))
        #expect(!Shell.staysInside(URL(string: "mailto:owner@example.com")!, origin: paired))
    }

    @Test func requestsParseOnlyTheContract() {
        #expect(ShellRequest(body: ["type": "ready"]) == .ready)
        #expect(ShellRequest(body: ["type": "notifications.request"]) == .notificationsRequest)
        #expect(ShellRequest(body: ["type": "theme", "scheme": "dark"]) == .theme(dark: true))
        #expect(ShellRequest(body: ["type": "theme", "scheme": "sepia"]) == nil)
        #expect(ShellRequest(body: ["type": "haptic", "style": "success"]) == .haptic(.success))
        #expect(ShellRequest(body: ["type": "haptic", "style": "heavy"]) == nil)
        #expect(ShellRequest(body: ["type": "device.revoke"]) == nil)
        #expect(ShellRequest(body: "ready") == nil)
    }

    @Test func eventsReachThePageAsParseableDetail() throws {
        let script = Shell.dispatchScript(.notificationOpen("decision:\"x\""))
        let start = try #require(script.range(of: "detail: "))
        let end = try #require(script.range(of: " }));", options: .backwards))
        let detail = try #require(JSONSerialization.jsonObject(with: Data(script[start.upperBound..<end.lowerBound].utf8)) as? [String: String])
        #expect(detail == ["type": "notification.open", "notificationId": "decision:\"x\""])
        #expect(ShellEvent.notificationOpen("n1").payload == detail.merging(["notificationId": "n1"]) { $1 })
    }
}

@Suite struct DeviceClientTests {
    private func makeClient() -> (DeviceClient, StubLane) {
        let (origin, lane) = makeStubOrigin()
        let client = DeviceClient(connection: Connection(origin: origin, deviceId: "device-1", token: "token-1"), session: StubURLProtocol.makeSession())
        return (client, lane)
    }

    @Test func pushRegistrationSendsTheContractCommand() async throws {
        let (client, lane) = makeClient()
        lane.enqueue(StubResponse(action: .reply(status: 200, body: json(#"{"ok":true,"result":{}}"#))))
        try await client.registerPush(token: "abcdef0123456789", environment: "sandbox")
        let request = try #require(lane.allRequests().first)
        #expect(request.method == "POST")
        #expect(request.path == "/api/commands")
        let body = try #require(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        #expect((body["requestId"] as? String)?.isEmpty == false)
        let command = try #require(body["command"] as? [String: String])
        #expect(command == ["type": "device.push_register", "token": "abcdef0123456789", "environment": "sandbox"])
    }

    @Test func revokedDeviceIsReportedAsRevoked() async throws {
        let (client, lane) = makeClient()
        lane.enqueue(StubResponse(action: .reply(status: 401, body: json(#"{"ok":false,"error":{"code":"forbidden","message":"unknown device"}}"#))))
        await #expect(throws: MobileError.revoked) { try await client.registerPush(token: "abcdef0123456789", environment: "sandbox") }
    }

    @Test func typedRejectionSurfacesTheHostCode() async throws {
        let (client, lane) = makeClient()
        lane.enqueue(StubResponse(action: .reply(status: 400, body: json(#"{"ok":false,"error":{"code":"invalid","message":"bad token"}}"#))))
        await #expect(throws: CommandError(code: "invalid", message: "bad token")) {
            try await client.registerPush(token: "abcdef0123456789", environment: "sandbox")
        }
    }
}
