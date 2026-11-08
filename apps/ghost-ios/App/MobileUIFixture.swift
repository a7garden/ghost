#if DEBUG
import Foundation
import CryptoKit
import GhostMobileCore

// Isolated UI-test transport: no sockets, real keys, production journals or
// writes. The explicit launch flag and reserved .invalid host are both
// required.
enum MobileUIFixture {
    static let ghostID = "ghost-fixture"
    static let researcherID = "ghost-researcher"
    static let scribeID = "ghost-scribe"
    static let conversationID = "fixture-conversation"
    static let secondConversationID = "fixture-second-conversation"
    static let researcherConversationID = "fixture-researcher-conversation"
    static let scribeConversationID = "fixture-scribe-conversation"
    static let workID = "fixture-work"
    static let reportWorkID = "0f3c2a1b-7d4e-4c5f-9a8b-1c2d3e4f5a6b"
    static let researchWorkID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
    static let notesWorkID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"

    static var dark: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--dark") }
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--ui-testing") }
    static var incoming: Bool { ProcessInfo.processInfo.arguments.contains("--ui-testing-incoming") }
    static var empty: Bool { ProcessInfo.processInfo.arguments.contains("--empty-conversation") }
    static var designReview: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--design-review") }
    static var longConversation: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--long-conversation") }
    static var pairing: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--pairing") }
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
    /// Fixture time starts two hours before launch, so relative labels read like a working day.
    static let base = Int(Date().timeIntervalSince1970 * 1000) - 7_200_000
    static func at(_ minutes: Int) -> Int { base + minutes * 60_000 }

    // MARK: Result file (served digest-verified like the host)

    static let reportFile = """
    # 주간 보고 초안

    이번 주에는 세 가지 요청이 들어왔습니다.

    - 보고서 초안: 완료
    - 회의 메모 요약: 검토 중
    - 자료 조사: 다음 주

    > 다음 주 화요일까지 회의 메모를 확정합니다.

    ```
    report.md · 3 sections
    ```
    """
    static var reportData: Data { Data(reportFile.utf8) }
    static var reportDigest: String { SHA256.hash(data: reportData).map { String(format: "%02x", $0) }.joined() }
    static var reportArtifact: ArtifactRef {
        ArtifactRef(digest: reportDigest, name: "주간-보고.md", mediaType: "text/markdown", size: reportData.count)
    }

    // MARK: Messages

    static func messages(for conversation: String) -> [Message] {
        if designReview, conversation == conversationID { return reviewMessages }
        if designReview, conversation == researcherConversationID {
            return [
                Message(id: "r-1", conversationId: conversation, role: .user, origin: "work", text: "# 회의 참고 자료 조사\n회의 메모 요약에 필요한 자료를 모아 주세요.", createdAt: at(52)),
                Message(id: "r-2", conversationId: conversation, role: .assistant, origin: nil, text: "어떤 항목부터 조사할지 확인을 요청했어요.", createdAt: at(60)),
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
                    toolCalls: [], tool: nil, attachments: [], createdAt: at(number))
            }
        } else if conversation == secondConversationID {
            return [Message(id: "fixture-second-1", conversationId: conversation, role: .assistant, origin: nil, text: "두 번째 대화입니다.", createdAt: at(1))]
        } else if empty || conversation != conversationID {
            return []
        } else {
            values = base.enumerated().map { index, item in
                Message(id: "fixture-message-\(index)", conversationId: conversation, role: item.0, origin: item.0 == .user ? "owner" : nil,
                    text: item.1, toolCalls: [], tool: nil, attachments: [], createdAt: at(index + 1))
            }
        }
        if incoming, conversation == conversationID, ProcessInfo.processInfo.systemUptime - firstPageTime >= 12 {
            values.append(incomingMessage())
        }
        return values
    }

    private static func tool(_ id: String, _ name: String, _ text: String, minute: Int, error: Bool = false) -> Message {
        Message(id: id, conversationId: conversationID, role: .tool, origin: nil, text: text,
                tool: MessageToolInfo(callId: "call-\(id)", name: name, isError: error), createdAt: at(minute))
    }

    private static var reviewMessages: [Message] {
        [
            Message(id: "review-owner", conversationId: conversationID, role: .user, origin: "owner", text: "이번 주 보고서랑 회의 메모 정리해 줘.", createdAt: at(10)),
            tool("review-tool-1", "work_list", "2 live works", minute: 11),
            tool("review-tool-2", "document_read", "notes/2026-11-06.md · 1.2KB", minute: 11),
            Message(id: "review-reply", conversationId: conversationID, role: .assistant, origin: nil,
                    text: "이번 주에는 세 가지 요청이 들어왔어요. **보고서 초안**과 메모 요약부터 진행하고, 나머지는 다음 주로 미뤘어요.",
                    createdAt: at(12), thinking: "요청을 우선순위로 나눕니다.\n**보고서와 메모를 먼저 진행**"),
            tool("review-delegate", "delegate", "Delegated \"참고 자료 정리\" (\(notesWorkID)) to 기록가. Its result arrives here.", minute: 14),
            Message(id: "review-report", conversationId: conversationID, role: .user, origin: "report",
                    text: "Work \"주간 보고 초안\" (\(reportWorkID)) is done.\n\n세 가지 요청을 정리한 초안입니다.", createdAt: at(40)),
            Message(id: "review-mention", conversationId: conversationID, role: .assistant, origin: nil,
                    text: "보고 확인했어요. 결과(`\(reportWorkID)`)는 맡긴 일에서 볼 수 있어요. 파일은 \(String(reportDigest.prefix(12)))에 있어요.",
                    createdAt: at(41)),
            Message(id: "review-event", conversationId: conversationID, role: .user, origin: "decision",
                    text: "The owner answered \"메모 범위는?\": 지난 화요일 회의만\n세부 범위는 안건 3개입니다.", createdAt: at(70)),
        ]
    }

    // MARK: State

    private static func ghost(_ id: String, _ name: String, persona: String, look: Look, isDefault: Bool = false, conversation: String) -> Ghost {
        Ghost(id: id, name: name, persona: persona, look: look, model: nil, isDefault: isDefault, state: .active,
              directConversationId: conversation, createdAt: at(0), updatedAt: at(0))
    }

    private static func work(_ id: String, ghost: String, parent: String? = nil, root: String? = nil, origin: String = conversationID,
                             title: String, brief: String, criteria: String, state: WorkState, result: WorkResult? = nil,
                             created: Int, ended: Int? = nil, updated: Int) -> Work {
        Work(id: id, parentId: parent, rootId: root ?? id, ghostId: ghost, originConversationId: origin, conversationId: nil,
             title: title, brief: brief, acceptance: Acceptance(criteria: criteria), state: state,
             revision: 1, revisionsUsed: 0, deadlineAt: nil, result: result, verdict: nil, reason: nil,
             createdAt: at(created), startedAt: at(created), endedAt: ended.map(at), updatedAt: at(updated))
    }

    static var state: GhostStateSnapshot {
        let main = ghost(ghostID, designReview ? "도우미" : "Ghost", persona: "일정과 보고를 맡는 메인 Ghost입니다.",
                         look: Look(avatarId: nil, body: nil, background: nil, shape: .sheet, face: .bars, mark: designReview ? .halo : .headphones),
                         isDefault: true, conversation: conversationID)
        var ghosts = [main]
        var conversations = [
            Conversation(id: conversationID, ghostId: ghostID, kind: .direct, workId: nil, title: "First conversation", busy: false, createdAt: at(0), lastActivityAt: at(70)),
            Conversation(id: secondConversationID, ghostId: ghostID, kind: .direct, workId: nil, title: "Second conversation", busy: false, createdAt: at(0), lastActivityAt: at(1)),
        ]
        let fixtureWork = work(workID, ghost: ghostID, title: designReview ? "회의 메모 요약" : "주말에 읽을 책 목록 정리하기",
                               brief: designReview ? "지난 화요일 회의 메모를 요약해 결과로 남겨 주세요." : "읽고 싶은 에세이 목록을 정리해 결과로 남겨 주세요.",
                               criteria: designReview ? "안건별 결정 · 담당 · 다음 단계 · Markdown 파일" : "짧게 읽을 에세이 5권 · 주제와 읽는 시간 · Markdown 파일",
                               state: designReview ? .verifying : .running, created: designReview ? 50 : 3, updated: designReview ? 68 : 4)
        var works = empty ? [] : [fixtureWork]
        if designReview {
            ghosts += [
                ghost(researcherID, "연구원", persona: "자료를 찾고 출처를 정리하는 리서처입니다.",
                      look: Look(avatarId: nil, body: "#c8803e", shape: .round, face: .dots, mark: .headphones), conversation: researcherConversationID),
                ghost(scribeID, "기록가", persona: "회의와 문서를 정리하는 에디터입니다.",
                      look: Look(avatarId: nil, body: "#4f9a7c", shape: .squircle, face: .arcs, mark: .glasses), conversation: scribeConversationID),
            ]
            conversations += [
                Conversation(id: researcherConversationID, ghostId: researcherID, kind: .direct, workId: nil, title: "", busy: false, createdAt: at(0), lastActivityAt: at(60)),
                Conversation(id: scribeConversationID, ghostId: scribeID, kind: .direct, workId: nil, title: "", busy: false, createdAt: at(0), lastActivityAt: at(30)),
            ]
            works += [
                work(reportWorkID, ghost: ghostID, title: "주간 보고 초안", brief: "이번 주 요청을 보고서 초안으로 정리해 주세요.",
                     criteria: "요청별 상태 · 다음 단계", state: .done,
                     result: WorkResult(summary: "세 가지 요청을 정리한 초안입니다.", artifacts: [reportArtifact]), created: 13, ended: 39, updated: 39),
                work(notesWorkID, ghost: scribeID, parent: reportWorkID, root: reportWorkID, title: "참고 자료 정리", brief: "보고서에 넣을 메모를 정리해 주세요.",
                     criteria: "", state: .done, created: 14, ended: 30, updated: 30),
                work(researchWorkID, ghost: researcherID, parent: workID, root: workID, title: "회의 참고 자료 조사", brief: "회의 메모 요약에 필요한 자료를 모아 주세요.",
                     criteria: "출처 3개 이상", state: .waiting, created: 52, updated: 60),
            ]
        }
        return GhostStateSnapshot(
            seq: 10,
            principal: .device(deviceId: "fixture-device", name: "Fixture iPhone"),
            runtime: Runtime(ready: true, detail: "", version: "fixture"),
            ghosts: ghosts, conversations: conversations, works: works, decisions: designReview ? reviewDecisions : [], notifications: [])
    }

    static func page(conversation: String) -> ConversationPage {
        ConversationPage(
            conversation: state.conversations.first { $0.id == conversation } ?? state.conversations[0],
            messages: messages(for: conversation),
            before: incoming && conversation == conversationID ? "fixture-message-1" : nil,
            live: designReview && conversation == conversationID ? reviewLive : nil)
    }

    static func incomingMessage() -> Message {
        Message(id: "fixture-message-incoming", conversationId: conversationID, role: .assistant, origin: nil, text: "Incoming message", createdAt: at(31))
    }

    static var reviewLive: Live? {
        try? JSONDecoder().decode(Live.self, from: Data(#"{"conversationId":"fixture-conversation","running":true,"partial":"","thinking":"회의 메모의 안건을 확인하고 있습니다.\n**결정과 담당자 대조**","tools":[]}"#.utf8))
    }

    static var reviewDecisions: [Decision] {
        let values: [[String: Any]] = [
            ["id": "review-result", "kind": "accept_result", "ghostId": ghostID, "conversationId": conversationID, "workId": workID,
             "title": "회의 메모 요약 결과", "detail": "요청한 문서를 작성해 결과로 남겼어요.",
             "proposal": ["result": ["summary": "안건 3개의 결정과 담당, 다음 단계를 정리했어요.", "artifacts": [
                ["digest": reportDigest, "name": "주간-보고.md", "mediaType": "text/markdown", "size": reportData.count]]],
                          "criteria": "안건별 결정 · 담당 · 다음 단계 · Markdown 파일"], "createdAt": at(68)],
            ["id": "review-approval", "kind": "approve_effect", "ghostId": ghostID, "conversationId": conversationID,
             "title": "다운로드 폴더 용량 확인", "detail": "Reason: 정리 전에 용량을 확인합니다.\nCommand: du -sh ~/Downloads",
             "proposal": ["command": "du -sh ~/Downloads", "cwd": "~", "reason": "정리 전에 용량을 확인합니다.", "risk": "읽기 전용"], "createdAt": at(72)],
            ["id": "review-question", "kind": "question", "ghostId": researcherID, "conversationId": researcherConversationID, "workId": researchWorkID,
             "title": "어떤 항목부터 조사할까요?", "detail": "회의 안건 중 먼저 볼 것을 골라 주세요.",
             "options": ["예산 안건", "일정 안건", "담당자 배정"], "createdAt": at(60)],
        ]
        let objects = values.map { ["state": "pending", "options": [String]()].merging($0) { _, new in new } }
        guard let data = try? JSONSerialization.data(withJSONObject: objects),
              let decisions = try? JSONDecoder().decode([Decision].self, from: data) else { return [] }
        return decisions
    }

    static func workDetailData(id: String) -> Data? {
        let snapshot = state
        guard let fixtureWork = snapshot.works.first(where: { $0.id == id }) else { return nil }
        let detail: [String: Any?] = [
            "work": fixtureWork,
            "ancestors": snapshot.works.filter { $0.id == fixtureWork.parentId },
            "children": snapshot.works.filter { $0.parentId == id },
            "decisions": snapshot.decisions.filter { $0.workId == id },
            "artifacts": fixtureWork.result?.artifacts ?? [],
        ]
        var object: [String: Any] = ["effects": []]
        for (key, value) in detail {
            guard let value, let encodable = value as? any Encodable,
                  let data = try? JSONEncoder().encode(encodable),
                  let json = try? JSONSerialization.jsonObject(with: data) else { return nil }
            object[key] = json
        }
        return try? JSONSerialization.data(withJSONObject: object)
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
        var contentType = "application/json"
        var data: Data?
        switch (request.httpMethod ?? "GET", url.path) {
        case ("GET", "/api/state"):
            data = try? JSONEncoder().encode(MobileUIFixture.state)
        case ("GET", let path) where path.hasPrefix("/api/conversations/"):
            data = try? JSONEncoder().encode(MobileUIFixture.page(conversation: String(path.dropFirst("/api/conversations/".count))))
        case ("GET", let path) where path.hasPrefix("/api/works/"):
            data = MobileUIFixture.workDetailData(id: String(path.dropFirst("/api/works/".count)))
        case ("GET", "/api/artifacts/\(MobileUIFixture.reportDigest)"):
            data = MobileUIFixture.reportData
            contentType = "text/markdown"
        case ("POST", "/api/commands"):
            status = 405
            data = try? JSONEncoder().encode(FixtureErrorBody(error: .init(code: "invalid", message: "UI fixture refuses mutations")))
        default:
            break
        }
        if data == nil {
            status = 404
            data = try? JSONEncoder().encode(FixtureErrorBody(error: .init(code: "not_found", message: "Unsupported fixture route")))
        }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": contentType]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
#endif
