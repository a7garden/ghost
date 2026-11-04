#if DEBUG
import Foundation
import GhostMobileCore

// Isolated UI-test transport: no sockets, real keys, production journals or writes.
// The explicit launch flag and reserved .invalid host are both required.
enum MobileUIFixture {
    static let ghostID = "00000000-0000-4000-8000-000000000001"
    static let conversationID = "fixture-conversation"
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--ui-testing-lifetime") }
    static var reviewWidth: CGFloat? {
        let prefix = "--review-width="
        guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }),
              let width = Double(argument.dropFirst(prefix.count)), [320.0, 375.0, 414.0, 768.0].contains(width) else { return nil }
        return CGFloat(width)
    }
    static var empty: Bool { ProcessInfo.processInfo.arguments.contains("--empty-conversation") }
    static var session: URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MobileFixtureProtocol.self]
        return URLSession(configuration: config)
    }
    static var bootstrap: JSON {
        .object([
            "protocol": .string("ghost-mobile"), "version": .number(1), "role": .string("lifetime"),
            "device": .object(["id": .string("00000000-0000-4000-8000-000000000002")]),
            "lifetime_host": .object(["workspace_id": .string("00000000-0000-4000-8000-000000000003"), "authority_epoch": .number(1), "dispatch_enabled": .bool(true)]),
            "lifetime_identity": .object(["actor_ref": .string("owner"), "authority_epoch": .number(1)]),
            "scope": .object(["kind": .string("lifetime"), "ghost_ids": .array([.string(ghostID)]), "conversation_ids": .array([.string(conversationID)]), "capabilities": .array([.string("lifetime.read"), .string("lifetime.write")])]),
            "target_pairs": .array([.object(["ghost_id": .string(ghostID), "conversation_id": .string(conversationID), "kind": .string("primary"), "mode": .string("active"), "roles": .array([])])])
        ])
    }
    static var snapshot: JSON {
        .object(["protocol_version": .string("ghost-lifetime/1"), "contract_revision": .number(1),
                 "goals": .array(empty ? [] : [.object(["id": .string("fixture-goal"), "state": .string("open"), "prompt": .string("주말에 읽을 책 목록 정리하기"), "revision": .number(1), "accountable_ghost": .string(ghostID), "reply_conversation": .string(conversationID), "privacy": .string("local_only"), "acceptance_spec": .object([:])])]),
                 "work": .array([]), "bindings": .array([]), "artifacts": .array([]), "acceptances": .array([])])
    }
    private static let firstPageTime = ProcessInfo.processInfo.systemUptime
    static var page: JSON {
        let age = ProcessInfo.processInfo.systemUptime - firstPageTime
        var messages = [
            ("user", "이번 주말에 읽을 책 목록을 정리해 줘."),
            ("assistant_advisory", "어떤 책이 끌리세요? 읽고 싶었던 분야나 요즘 관심 있는 주제를 알려주시면 목록을 함께 정리할게요."),
            ("user", "짧게 읽을 수 있는 에세이 위주로 보고 싶어.")
        ]
        if ProcessInfo.processInfo.arguments.contains("--lifetime-incoming") {
            messages = (1...30).map { number in
                (number.isMultiple(of: 2) ? "assistant_advisory" : "user", number == 30 ? "Latest lifetime message" : "Lifetime message \(number)\n대화 기록과 스크롤 위치를 확인하는 테스트 메시지입니다.")
            }
            if age >= 12 { messages.append(("assistant_advisory", "Incoming lifetime message")) }
        }
        let turns: [JSON] = empty ? [] : messages.enumerated().map { index, item in
            .object(["id": .string("fixture-turn-\(index)"), "sequence": .number(Double(index + 1)), "kind": .string(item.0), "sender_kind": .string(item.0 == "user" ? "owner" : "ghost"), "sender_ref": .string(item.0 == "user" ? "owner" : ghostID), "text": .string(item.1), "privacy": .string("local_only"), "attachments": .array([]), "created_at_ms": .number(1)])
        }
        return .object(["ghost_id": .string(ghostID), "conversation_id": .string(conversationID), "privacy": .string("local_only"), "turns": .array(turns), "turn_runs": .array([]), "has_older": .bool(false), "oldest_sequence": turns.isEmpty ? .null : .number(1)])
    }
    static func result(_ data: JSON) -> JSON {
        .object(["status": .string("success"), "summary": .string("UI fixture"), "data": data, "error_code": .null, "retry_class": .string("never"), "object_refs": .array([]), "artifacts": .array([]), "next_actions": .array([])])
    }
}

private final class MobileFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "ui-test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard MobileUIFixture.enabled, let url = request.url, url.host == "ui-test.invalid" else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        let value: JSON
        var status = 200
        switch url.path {
        case "/mobile/v1/bootstrap": value = MobileUIFixture.bootstrap
        case "/mobile/v1/lifetime/snapshot": value = MobileUIFixture.snapshot
        case "/mobile/v1/lifetime/questions": value = .object(["ok": .bool(true), "questions": .array([])])
        case "/mobile/v1/notifications/inspect": value = .object(["ok": .bool(true), "result": MobileUIFixture.result(.object(["notifications": .array([])]))])
        case "/mobile/v1/lifetime/action":
            var bytes = request.httpBody ?? Data()
            if bytes.isEmpty, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    guard count > 0 else { break }; bytes.append(buffer, count: count)
                }
            }
            let payload = try? JSONDecoder().decode(JSON.self, from: bytes)
            if payload?["command"]["envelope"]["body"]["method"].text == "conversation.inspect" {
                value = .object(["ok": .bool(true), "result": MobileUIFixture.result(MobileUIFixture.page)])
            } else { status = 405; value = .object(["error": .string("UI fixture refuses mutations")]) }
        default: status = 404; value = .object(["error": .string("Unsupported fixture route")])
        }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"]), let data = try? JSONEncoder().encode(value) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
#endif
