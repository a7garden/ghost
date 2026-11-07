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
    static var designReview: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--design-review") }
    static var longConversation: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--long-conversation") }
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
        if designReview, conversation == conversationID {
            return [
                Message(id: "review-owner", conversationId: conversation, role: .user, origin: "owner", text: "주말에 읽을 에세이를 파일로 정리해 줘.", createdAt: 1),
                Message(id: "review-reply", conversationId: conversation, role: .assistant, origin: nil, text: "책 목록 정리를 맡겼어요.", createdAt: 2, thinking: "짧게 읽을 수 있는 에세이를 찾습니다.\n읽는 시간과 주제를 비교합니다."),
                Message(id: "review-event", conversationId: conversation, role: .user, origin: "work_report", text: "책 목록 초안이 도착했습니다.", createdAt: 4),
            ]
        }
        let base: [(MessageRole, String)] = [
            (.user, "이번 주말에 읽을 책 목록을 정리해 줘."),
            (.assistant, "어떤 책이 끌리세요? 읽고 싶었던 분야나 요즘 관심 있는 주제를 알려주시면 목록을 함께 정리할게요."),
            (.user, "짧게 읽을 수 있는 에세이 위주로 보고 싶어."),
        ]
        var values: [Message] = []
        if (incoming || longConversation) && conversation == conversationID {
            values = (1...30).map { number in
                Message(
                    id: "fixture-message-\(number)", conversationId: conversation,
                    role: number.isMultiple(of: 2) ? .assistant : .user, origin: number.isMultiple(of: 2) ? nil : "owner",
                    text: number == 30 ? (longConversation ? "짧게 읽을 수 있는 에세이 위주로 보고 싶어." : "Latest message") : "Message \(number)\n대화 기록과 스크롤 위치를 확인하는 테스트 메시지입니다.",
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
            values.append(incomingMessage())
        }
        return values
    }

    static var state: GhostStateSnapshot {
        let ghost = Ghost(
            id: ghostID, name: "Ghost", persona: "iPhone 대화",
            look: Look(avatarId: nil, body: nil, background: nil, shape: .sheet, face: .bars, mark: .headphones), model: nil, isDefault: true,
            state: .active, directConversationId: conversationID, createdAt: 1, updatedAt: 1)
        let conversations = [
            Conversation(id: conversationID, ghostId: ghostID, kind: .direct, workId: nil, title: "First conversation", busy: false, createdAt: 1, lastActivityAt: 2),
            Conversation(id: secondConversationID, ghostId: ghostID, kind: .direct, workId: nil, title: "Second conversation", busy: false, createdAt: 1, lastActivityAt: 1),
        ]
        let work = Work(
            id: workID, parentId: nil, rootId: workID, ghostId: ghostID,
            originConversationId: conversationID, conversationId: nil,
            title: "주말에 읽을 책 목록 정리하기", brief: "읽고 싶은 에세이 목록을 정리해 결과로 남겨 주세요.",
            acceptance: Acceptance(criteria: "짧게 읽을 에세이 5권 · 주제와 읽는 시간 · Markdown 파일"), state: designReview ? .verifying : .running,
            revision: 1, revisionsUsed: 0, deadlineAt: nil, result: designReview ? reviewResult : nil, verdict: nil, reason: nil,
            createdAt: 3, startedAt: 3, endedAt: nil, updatedAt: 4)
        return GhostStateSnapshot(
            seq: 10,
            principal: .device(deviceId: "fixture-device", name: "Fixture iPhone", grants: [DeviceGrant(ghostId: ghostID, conversationId: nil)]),
            runtime: Runtime(ready: true, detail: "", version: "fixture"),
            ghosts: [ghost], conversations: conversations, works: empty ? [] : [work], decisions: designReview ? reviewDecisions : [], notifications: [])
    }

    static func page(conversation: String) -> ConversationPage {
        ConversationPage(
            conversation: state.conversations.first { $0.id == conversation } ?? state.conversations[0],
            messages: messages(for: conversation),
            before: incoming && conversation == conversationID ? "fixture-message-1" : nil,
            live: designReview && conversation == conversationID ? reviewLive : nil)
    }

    static func incomingMessage() -> Message {
        Message(id: "fixture-message-incoming", conversationId: conversationID, role: .assistant, origin: nil, text: "Incoming message", createdAt: 31)
    }

    static var reviewLive: Live? {
        try? JSONDecoder().decode(Live.self, from: Data(#"{"conversationId":"fixture-conversation","running":true,"partial":"","thinking":"목록을 마무리하고 있습니다.\n**읽는 시간과 추천 이유 확인**","tools":[]}"#.utf8))
    }
    private static var reviewResult: WorkResult? {
        try? JSONDecoder().decode(WorkResult.self, from: Data(#"{"summary":"주말에 읽기 좋은 에세이 5권을 정리했습니다.","artifacts":[{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"주말의-에세이.md","mediaType":"text/markdown","size":1280}]}"#.utf8))
    }
    static var reviewDecisions: [Decision] {
        let common: [String: Any] = [
            "ghostId": ghostID, "conversationId": conversationID, "state": "pending",
            "options": [], "createdAt": 1
        ]
        let values: [[String: Any]] = [
            ["id": "review-question", "kind": "question", "title": "어떤 분위기의 책이 좋으세요?", "detail": "목록의 마지막 한 권을 골라 주세요.", "options": ["차분하게 돌아보는 이야기", "가볍고 유쾌한 이야기"], "createdAt": 1],
            ["id": "review-approval", "kind": "approve_effect", "title": "책 목록을 저장할까요?", "detail": "파일을 쓰기 전에 확인해 주세요.", "proposal": ["tool": "write", "target": "주말의-에세이.md", "input": ["content": "에세이 5권과 추천 이유"], "destination": "선택한 프로젝트"], "createdAt": 2],
            ["id": "review-result", "kind": "accept_result", "workId": workID, "title": "에세이 목록이 준비됐어요", "detail": "결과를 확인해 주세요.", "proposal": ["result": ["summary": "주말에 읽기 좋은 에세이 5권을 정리했습니다.", "artifacts": [["digest": String(repeating: "a", count: 64), "name": "주말의-에세이.md", "mediaType": "text/markdown", "size": 1280]]], "criteria": "짧게 읽을 에세이 5권 · 주제와 읽는 시간 · Markdown 파일"], "createdAt": 3]
        ]
        let objects = values.map { common.merging($0) { _, new in new } }
        guard let data = try? JSONSerialization.data(withJSONObject: objects),
              let decisions = try? JSONDecoder().decode([Decision].self, from: data) else { return [] }
        return decisions
    }

    static var workDetailData: Data? {
        guard let fixtureWork = state.works.first,
              let workData = try? JSONEncoder().encode(fixtureWork),
              let work = try? JSONSerialization.jsonObject(with: workData),
              let decisionsData = try? JSONEncoder().encode(state.decisions.filter { $0.workId == workID }),
              let decisions = try? JSONSerialization.jsonObject(with: decisionsData) else { return nil }
        return try? JSONSerialization.data(withJSONObject: [
            "work": work, "ancestors": [], "children": [], "effects": [], "decisions": decisions, "artifacts": []
        ])
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
        case ("GET", let path) where path == "/api/works/\(MobileUIFixture.workID)":
            data = MobileUIFixture.workDetailData ?? Data()
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
