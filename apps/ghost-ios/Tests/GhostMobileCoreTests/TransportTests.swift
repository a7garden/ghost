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

    private func installLink(_ manifest: String) -> String {
        var url = URLComponents(string: "itms-services://?")!
        url.queryItems = [
            URLQueryItem(name: "action", value: "download-manifest"),
            URLQueryItem(name: "url", value: manifest),
        ]
        return url.string!
    }

    @Test func installAcceptsTheExactPairedManifest() {
        let raw = "itms-services://?action=download-manifest&url=https%3A%2F%2Fmacstudio.example.ts.net%3A8443%2Fapi%2Fupdate%2Fios%2Fmanifest.plist%3Ft%3Dtoken"
        #expect(Shell.installURL(raw, origin: connection.origin) == URL(string: raw))
        #expect(ShellRequest(body: ["type": "app.install", "url": raw]) == .appInstall(URL(string: raw)!))
        let parsed = ShellRequest(body: ["type": "app.install", "url": raw])
        if case .appInstall(let url) = parsed {
            #expect(Shell.installURL(url.absoluteString, origin: connection.origin) == url)
        } else {
            Issue.record("app.install did not parse")
        }
    }

    @Test func installRejectsOtherOriginsSchemesAndPaths() {
        let manifests = [
            "http://macstudio.example.ts.net:8443/api/update/ios/manifest.plist?t=token",
            "https://other.example.ts.net:8443/api/update/ios/manifest.plist?t=token",
            "https://macstudio.example.ts.net/api/update/ios/manifest.plist?t=token",
            "https://macstudio.example.ts.net:8444/api/update/ios/manifest.plist?t=token",
            "https://macstudio.example.ts.net:8443/api/update/ios/Ghost.ipa?t=token",
            "https://macstudio.example.ts.net:8443/api/update/ios/manifest.plist/?t=token",
            "/api/update/ios/manifest.plist?t=token",
        ]
        for manifest in manifests {
            #expect(Shell.installURL(installLink(manifest), origin: connection.origin) == nil, "\(manifest)")
        }
        let raw = installLink("https://macstudio.example.ts.net:8443/api/update/ios/manifest.plist?t=token")
        for scheme in ["https", "http", "ghost", "javascript", "file"] {
            #expect(Shell.installURL(raw.replacingOccurrences(of: "itms-services:", with: "\(scheme):"), origin: connection.origin) == nil)
        }
    }

    @Test func installRejectsMissingDuplicateAndExtraParameters() {
        let manifest = "https%3A%2F%2Fmacstudio.example.ts.net%3A8443%2Fapi%2Fupdate%2Fios%2Fmanifest.plist%3Ft%3Dtoken"
        let queries = [
            "",
            "action=download-manifest",
            "url=\(manifest)",
            "action=download-manifest&url=",
            "action=other&url=\(manifest)",
            "action=download-manifest&url=\(manifest)&url=\(manifest)",
            "action=download-manifest&url=\(manifest)&%75rl=\(manifest)",
            "action=download-manifest&action=download-manifest&url=\(manifest)",
            "action=download-manifest&url=\(manifest)&extra=true",
        ]
        for query in queries {
            #expect(Shell.installURL("itms-services://?\(query)", origin: connection.origin) == nil, "\(query)")
        }
    }

    @Test func installRejectsCredentialsFragmentsAndOuterAuthority() {
        let base = "https://macstudio.example.ts.net:8443/api/update/ios/manifest.plist?t=token"
        for manifest in [
            base.replacingOccurrences(of: "https://", with: "https://user:password@"),
            base.replacingOccurrences(of: "https://", with: "https://@"),
            base + "#fragment",
            base + "#",
        ] {
            #expect(Shell.installURL(installLink(manifest), origin: connection.origin) == nil)
        }
        let raw = installLink(base)
        for invalid in [
            raw + "#fragment",
            raw + "#",
            raw.replacingOccurrences(of: "itms-services://?", with: "itms-services://host?"),
            raw.replacingOccurrences(of: "itms-services://?", with: "itms-services://user:password@?"),
            raw.replacingOccurrences(of: "itms-services://?", with: "itms-services:///path?"),
            raw.replacingOccurrences(of: "itms-services://?", with: "itms-services:?"),
        ] {
            #expect(Shell.installURL(invalid, origin: connection.origin) == nil, "\(invalid)")
        }
    }

    @Test func installRejectsEncodedPathTricks() {
        for path in [
            "/api/update/ios/manifest.plist%2F..",
            "/api/update/ios/manifest.plist%252F..",
            "/api/update/ios/%2e%2e/ios/manifest.plist",
            "/api/update/ios/../ios/manifest.plist",
            "/api/update/ios%2Fmanifest.plist",
            "/api/update/ios/%6Danifest.plist",
            "/api/update/ios/manifest.plist%5C..",
        ] {
            let raw = installLink("https://macstudio.example.ts.net:8443\(path)?t=token")
            #expect(Shell.installURL(raw, origin: connection.origin) == nil, "\(path)")
            if case .appInstall(let url) = ShellRequest(body: ["type": "app.install", "url": raw]) {
                #expect(Shell.installURL(url.absoluteString, origin: connection.origin) == nil, "\(path)")
            }
        }
    }

    @Test func requestsParseOnlyTheContract() {
        #expect(ShellRequest(body: ["type": "ready"]) == .ready)
        #expect(ShellRequest(body: ["type": "notifications.request"]) == .notificationsRequest)
        #expect(ShellRequest(body: ["type": "theme", "scheme": "dark"]) == .theme(dark: true))
        #expect(ShellRequest(body: ["type": "theme", "scheme": "sepia"]) == nil)
        #expect(ShellRequest(body: ["type": "haptic", "style": "success"]) == .haptic(.success))
        #expect(ShellRequest(body: ["type": "haptic", "style": "heavy"]) == nil)
        #expect(ShellRequest(body: ["type": "app.install"]) == nil)
        #expect(ShellRequest(body: ["type": "app.install", "url": 1]) == nil)
        #expect(ShellRequest(body: ["type": "app.install", "url": "https://["]) == nil)
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

@Suite struct PushEnvironmentTests {
    private func profile(entitlements: [String: Any]) throws -> Data {
        let plist = try PropertyListSerialization.data(
            fromPropertyList: ["Entitlements": entitlements], format: .xml, options: 0)
        // The CMS wrapper need not be UTF-8; only its embedded XML is decoded.
        return Data([0x30, 0x82, 0xff, 0x00]) + plist + Data([0x00, 0xff])
    }

    @Test func developmentSigningUsesSandboxRegardlessOfBuildConfiguration() throws {
        #expect(PushEnvironment.fromProvisioningProfile(
            try profile(entitlements: ["aps-environment": "development"])) == "sandbox")
    }

    @Test func productionSigningUsesProduction() throws {
        #expect(PushEnvironment.fromProvisioningProfile(
            try profile(entitlements: ["aps-environment": "production"])) == "production")
    }

    @Test func missingPushEntitlementDefaultsToProduction() throws {
        #expect(PushEnvironment.fromProvisioningProfile(try profile(entitlements: [:])) == "production")
    }

    @Test func absentOrMalformedProfilesDefaultToProduction() {
        for data: Data? in [
            nil,
            Data(),
            Data([0xff, 0x00, 0x30]),
            Data("<?xml version=\"1.0\"?><plist><dict>".utf8),
            Data("<?xml version=\"1.0\"?><plist>garbage</plist>".utf8),
        ] {
            #expect(PushEnvironment.fromProvisioningProfile(data) == "production")
        }
    }
}
