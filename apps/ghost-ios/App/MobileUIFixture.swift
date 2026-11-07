#if DEBUG
import Foundation
import GhostMobileCore

// Isolated UI-test transport: no sockets, real keys, production journals or
// writes. The explicit launch flag and reserved .invalid host are both
// required.
enum MobileUIFixture {
    static let ghostID = "ghost-fixture"
    static let conversationID = "fixture-conversation"
    static let secondConversationID = "fixture-second-conversation"
    static let workID = "fixture-work"

    static var dark: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--dark") }
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--ui-testing") }
    static var incoming: Bool { ProcessInfo.processInfo.arguments.contains("--ui-testing-incoming") }
    static var empty: Bool { ProcessInfo.processInfo.arguments.contains("--empty-conversation") }
    static var reviewWidth: CGFloat? {
        let prefix = "--review-width="
        guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }),
              let width = Double(argument.dropFirst(prefix.count)), [320.0, 375.0, 414.0, 768.0].contains(width) else { return nil }
        return CGFloat(width)
    }

    static var session: URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MobileFixtureProtocol.self]
        return URLSession(configuration: config)
    }

    private static let firstPageTime = ProcessInfo.processInfo.systemUptime

    static func messages(for conversation: String) -> [Message] {
        let base: [(MessageRole, String)] = [
            (.user, "이번 주말에 읽을 책 목록을 정리해 줘."),
            (.assistant, "어떤 책이 끌리세요? 읽고 싶었던 분야나 요즘 관심 있는 주제를 알려주시면 목록을 함께 정리할게요."),
            (.user, "짧게 읽을 수 있는 에세이 위주로 보고 싶어."),
        ]
        var values: [Message] = []
        if incoming && conversation == conversationID {
            values = (1...30).map { number in
                Message(
                    id: "fixture-message-\(number)", conversationId: conversation,
                    role: number.isMultiple(of: 2) ? .assistant : .user, origin: number.isMultiple(of: 2) ? nil : "owner",
                    text: number == 30 ? "Latest message" : "Message \(number)\n대화 기록과 스크롤 위치를 확인하는 테스트 메시지입니다.",
                    toolCalls: [], tool: nil, attachments: [], createdAt: number)
            }
        } else if conversation == secondConversationID {
            return [.assistant(id: "fixture-second-1", conversationId: conversation, text: "두 번째 대화입니다.")]
        } else if empty {
            return []
        } else {
            values = base.enumerated().map { index, item in
                Message(id: "fixture-message-\(index)", conversationId: conversation, role: item.0, origin: item.0 == .user ? "owner" : nil,
                    text: item.1, toolCalls: [], tool: nil, attachments: [], createdAt: index)
            }
        }
        if incoming, conversation == conversationID, ProcessInfo.processInfo.systemUptime - firstPageTime >= 12 {
            values.append(.assistant(id: "fixture-message-incoming", conversationId: conversation, text: "Incoming message"))
        }
        return values
    }

    static var state: GhostStateSnapshot {
        let ghost = Ghost(
            id: ghostID, name: "Ghost", persona: "iPhone 대화",
            look: Look(avatarId: nil, body: nil, background: nil), model: nil, isDefault: true,
            state: .active, directConversationId: conversationID, createdAt: 1, updatedAt: 1)
        let conversations = [
            Conversation(id: conversationID, ghostId: ghostID, kind: .direct, workId: nil, title: "First conversation", busy: false, createdAt: 1, lastActivityAt: 2),
            Conversation(id: secondConversationID, ghostId: ghostID, kind: .direct, workId: nil, title: "Second conversation", busy: false, createdAt: 1, lastActivityAt: 1),
        ]
        let work = Work(
            id: workID, parentId: nil, rootId: workID, ghostId: ghostID,
            originConversationId: conversationID, conversationId: nil,
            title: "주말에 읽을 책 목록 정리하기", brief: "읽고 싶은 에세이 목록을 정리해 결과로 남겨 주세요.",
            acceptance: Acceptance(criteria: "목록이 파일로 남는다"), state: .running,
            revision: 1, revisionsUsed: 0, deadlineAt: nil, result: nil, verdict: nil, reason: nil,
            createdAt: 1, startedAt: 2, endedAt: nil, updatedAt: 3)
        return GhostStateSnapshot(
            seq: 10,
            principal: .device(deviceId: "fixture-device", name: "Fixture iPhone", grants: [DeviceGrant(ghostId: ghostID, conversationId: nil)]),
            runtime: Runtime(ready: true, detail: "", version: "fixture"),
            ghosts: [ghost], conversations: conversations, works: [work], decisions: [], notifications: [])
    }

    static func page(conversation: String) -> ConversationPage {
        ConversationPage(
            conversation: state.conversations.first { $0.id == conversation } ?? state.conversations[0],
            messages: messages(for: conversation),
            before: incoming && conversation == conversationID ? "fixture-message-1" : nil,
            live: nil)
    }

    static func incomingMessage() -> Message {
        Message.assistant(id: "fixture-message-live-\(UUID().uuidString.prefix(8))", conversationId: conversationID, text: "Incoming message")
    }
}

private struct FixtureErrorBody: Encodable {
    struct ErrorBody: Encodable {
        let code: String
        let message: String
    }
    let ok = false
    let error: ErrorBody
}

private final class MobileFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "ui-test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard MobileUIFixture.enabled, let url = request.url, url.host == "ui-test.invalid" else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        var status = 200
        let data: Data
        switch (request.httpMethod ?? "GET", url.path) {
        case ("GET", "/api/state"):
            data = (try? JSONEncoder().encode(MobileUIFixture.state)) ?? Data()
        case ("GET", let path) where path.hasPrefix("/api/conversations/"):
            data = (try? JSONEncoder().encode(MobileUIFixture.page(conversation: String(path.dropFirst("/api/conversations/".count))))) ?? Data()
        case ("POST", "/api/commands"):
            status = 405
            data = (try? JSONEncoder().encode(FixtureErrorBody(error: .init(code: "invalid", message: "UI fixture refuses mutations")))) ?? Data()
        default:
            status = 404
            data = (try? JSONEncoder().encode(FixtureErrorBody(error: .init(code: "not_found", message: "Unsupported fixture route")))) ?? Data()
        }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
#endif
