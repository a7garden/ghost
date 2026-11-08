import Foundation
import Testing
@testable import GhostMobileCore

@Suite struct ContractDecodingTests {
    private let stateJSON = """
    {
      "seq": 42,
      "principal": {"kind": "device", "deviceId": "device-1", "name": "Test iPhone"},
      "runtime": {"ready": true, "detail": "", "version": "1.0.0"},
      "ghosts": [{"id": "ghost-1", "name": "Ghost", "persona": "비서", "look": {"avatarId": null},
                  "model": null, "isDefault": true, "state": "active",
                  "directConversationId": "conv-1", "createdAt": 1700000000000, "updatedAt": 1700000001000}],
      "conversations": [{"id": "conv-1", "ghostId": "ghost-1", "kind": "direct", "workId": null,
                         "title": "대화", "model": null, "busy": false,
                         "createdAt": 1700000000000, "lastActivityAt": 1700000002000}],
      "works": [{"id": "work-1", "parentId": null, "rootId": "work-1", "ghostId": "ghost-1",
                 "originConversationId": "conv-1", "conversationId": "conv-9",
                 "title": "책 목록 정리", "brief": "정리해 주세요",
                 "acceptance": {"criteria": "파일로 남는다", "checks": [], "reviewer": null},
                 "state": "running", "revision": 1, "revisionsUsed": 0,
                 "deadlineAt": null, "result": null, "verdict": null, "reason": null,
                 "createdAt": 1700000000000, "startedAt": 1700000000500, "endedAt": null,
                 "updatedAt": 1700000002000}],
      "decisions": [{"id": "decision-1", "kind": "question", "ghostId": "ghost-1",
                     "conversationId": "conv-1", "workId": null, "effectId": null,
                     "title": "어느 책?", "detail": "고르세요", "options": ["에세이", "소설"],
                     "proposal": {"format": "md"}, "state": "pending", "answer": null,
                     "createdAt": 1700000000000, "resolvedAt": null}],
      "notifications": [{"id": "notification-1", "kind": "work_done", "ghostId": "ghost-1",
                         "conversationId": null, "workId": "work-1", "decisionId": null,
                         "title": "완료", "body": "맡긴 일이 끝났습니다.",
                         "createdAt": 1700000000000, "readAt": null}],
      "schedules": [], "spaces": [], "avatars": [],
      "settings": {"defaultModel": null, "reviewModel": null, "providers": []},
      "devices": [], "sandboxes": []
    }
    """

    @Test func decodesStateSnapshotForDevicePrincipal() throws {
        let state = try JSONDecoder().decode(GhostStateSnapshot.self, from: json(stateJSON))
        #expect(state.seq == 42)
        #expect(state.principal == .device(deviceId: "device-1", name: "Test iPhone"))
        #expect(state.runtime.ready)
        #expect(state.ghosts[0].isDefault)
        #expect(state.ghosts[0].state == .active)
        #expect(state.conversations[0].kind == .direct)
        #expect(state.conversations[0].busy == false)
        #expect(state.works[0].state == .running)
        #expect(state.works[0].acceptance.criteria == "파일로 남는다")
        #expect(state.decisions[0].kind == .question)
        #expect(state.decisions[0].isPending)
        #expect(state.decisions[0].proposal?.dictionary["format"]?.text == "md")
        #expect(state.notifications[0].kind == .work_done)
        #expect(!state.notifications[0].isRead)
        #expect(contractDate(state.works[0].startedAt!).timeIntervalSince1970 == 1_700_000_000.5)
    }

    @Test func decodesOwnerPrincipal() throws {
        let ownerState = stateJSON.replacingOccurrences(
            of: #"{"kind": "device", "deviceId": "device-1", "name": "Test iPhone"}"#,
            with: #"{"kind": "owner"}"#)
        let state = try JSONDecoder().decode(GhostStateSnapshot.self, from: json(ownerState))
        #expect(state.principal == .owner)
    }

    @Test func decodesConversationPage() throws {
        let pageJSON = """
        {
          "conversation": {"id": "conv-1", "ghostId": "ghost-1", "kind": "direct", "workId": null,
                           "title": "대화", "model": null, "busy": true,
                           "createdAt": 1, "lastActivityAt": 2},
          "messages": [
            {"id": "m-1", "conversationId": "conv-1", "role": "user", "origin": "owner",
             "text": "안녕?", "toolCalls": [], "tool": null, "attachments": [], "createdAt": 10},
            {"id": "m-2", "conversationId": "conv-1", "role": "assistant", "origin": null,
             "text": "실행했습니다.", "toolCalls": [{"callId": "c-1", "name": "bash", "args": "ls"}],
             "tool": {"callId": "c-1", "name": "bash", "isError": false}, "attachments": [], "createdAt": 20}
          ],
          "before": "m-0",
          "live": {"conversationId": "conv-1", "running": true, "partial": "결과는", "tools": []}
        }
        """
        let page = try JSONDecoder().decode(ConversationPage.self, from: json(pageJSON))
        #expect(page.conversation.busy)
        #expect(page.messages.count == 2)
        #expect(page.messages[1].toolCalls[0].name == "bash")
        #expect(page.messages[1].tool?.isError == false)
        #expect(page.before == "m-0")
        #expect(page.live?.partial == "결과는")
    }

    @Test func decodesWorkDetail() throws {
        let detailJSON = """
        {
          "work": {"id": "work-1", "parentId": null, "rootId": "work-1", "ghostId": "ghost-1",
                   "originConversationId": "conv-1", "conversationId": "conv-9",
                   "title": "책 목록 정리", "brief": "정리해 주세요",
                   "acceptance": {"criteria": "파일로", "checks": [], "reviewer": null},
                   "state": "done", "revision": 2, "revisionsUsed": 1, "deadlineAt": null,
                   "result": {"summary": "완료했습니다.", "artifacts": [
                       {"digest": "\(String(repeating: "a", count: 64))", "name": "books.md", "mediaType": "text/markdown", "size": 3}]},
                   "verdict": {"outcome": "pass", "source": "checks", "reasons": "일치", "at": 5},
                   "reason": null, "createdAt": 1, "startedAt": 2, "endedAt": 3, "updatedAt": 4},
          "ancestors": [],
          "children": [{"id": "work-2", "parentId": "work-1", "rootId": "work-1", "ghostId": "ghost-1",
                        "originConversationId": "conv-9", "conversationId": "conv-10",
                        "title": "하위", "brief": "b", "acceptance": {"criteria": "", "checks": [], "reviewer": null},
                        "state": "cancelled", "revision": 1, "revisionsUsed": 0, "deadlineAt": null,
                        "result": null, "verdict": null, "reason": "부모 취소", "createdAt": 1,
                        "startedAt": null, "endedAt": 2, "updatedAt": 3}],
          "effects": [{"id": "effect-1", "workId": "work-1", "conversationId": "conv-9",
                       "callId": "c-1", "tool": "write", "summary": "books.md 저장",
                       "inputDigest": "\(String(repeating: "b", count: 64))", "state": "done",
                       "result": "books.md", "createdAt": 1, "endedAt": 2}],
          "decisions": [],
          "artifacts": [{"digest": "\(String(repeating: "a", count: 64))", "name": "books.md", "mediaType": "text/markdown", "size": 3}]
        }
        """
        let detail = try JSONDecoder().decode(WorkDetail.self, from: json(detailJSON))
        #expect(detail.work.state == .done)
        #expect(detail.work.result?.summary == "완료했습니다.")
        #expect(detail.work.verdict?.outcome == "pass")
        #expect(detail.children[0].state == .cancelled)
        #expect(detail.effects[0].tool == "write")
        #expect(detail.artifacts[0].name == "books.md")
    }

    @Test func commandEncodingMatchesContract() throws {
        let body = try JSONEncoder().encode(CommandRequest(
            requestId: "0123abcd-1234-5678-9abc-def012345678",
            command: .messageSend(conversationId: "conv-1", text: "안녕?")))
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(object["requestId"] as? String == "0123abcd-1234-5678-9abc-def012345678")
        let command = try #require(object["command"] as? [String: Any])
        #expect(command["type"] as? String == "message.send")
        #expect(command["conversationId"] as? String == "conv-1")
        #expect(command["text"] as? String == "안녕?")

        let update = try JSONEncoder().encode(CommandRequest(
            requestId: "0123abcd-1234-5678-9abc-def012345679",
            command: .workUpdate(workId: "work-1", title: .keep, brief: .set("새 내용"), deadlineAt: .clear)))
        let updateObject = try #require(JSONSerialization.jsonObject(with: update) as? [String: Any])
        let updateCommand = try #require(updateObject["command"] as? [String: Any])
        #expect(updateCommand["type"] as? String == "work.update")
        #expect(updateCommand["workId"] as? String == "work-1")
        #expect(updateCommand["brief"] as? String == "새 내용")
        #expect((updateCommand["deadlineAt"] as? NSNull) != nil)
        #expect(updateCommand["title"] == nil)

        let resolve = try JSONEncoder().encode(CommandRequest(
            requestId: "0123abcd-1234-5678-9abc-def012345680",
            command: .decisionResolve(decisionId: "decision-1", outcome: .answer, answer: "에세이")))
        let resolveObject = try #require(JSONSerialization.jsonObject(with: resolve) as? [String: Any])
        let resolveCommand = try #require(resolveObject["command"] as? [String: Any])
        #expect(resolveCommand["type"] as? String == "decision.resolve")
        #expect(resolveCommand["outcome"] as? String == "answer")
        #expect(resolveCommand["answer"] as? String == "에세이")

        let roundTrip = try JSONDecoder().decode(CommandRequest.self, from: update)
        #expect(roundTrip.command == .workUpdate(workId: "work-1", title: .keep, brief: .set("새 내용"), deadlineAt: .clear))
    }
}

@Suite struct SSEParsingTests {
    private func ledgerEventFrame(seq: Int) -> String {
        "event: ledger\nid: \(seq)\ndata: {\"seq\": \(seq), \"at\": 1700000000000, \"data\": {\"type\": \"conversation\", \"conversation\": {\"id\": \"conv-1\", \"ghostId\": \"ghost-1\", \"kind\": \"direct\", \"workId\": null, \"title\": \"대화\", \"model\": null, \"busy\": false, \"createdAt\": 1, \"lastActivityAt\": 2}}}\n\n"
    }

    @Test func parsesFramesSplitAcrossChunks() throws {
        var parser = SSEParser()
        let frame = "event: ledger\r\nid: 7\r\ndata: {\"seq\": 7, \"at\": 1700000000000, \"data\": {\"type\": \"work.removed\", \"id\": \"work-1\"}}\r\n\r\n"
        var received: [SSEFrame] = []
        for index in frame.indices {
            received += parser.feed(text: String(frame[index...index]))
        }
        #expect(received.count == 1)
        #expect(received[0].event == "ledger")
        #expect(received[0].id == "7")
        guard case .ledger(let event) = try received[0].streamFrame() else {
            Issue.record("expected ledger frame"); return
        }
        #expect(event.seq == 7)
        #expect(event.data == .other("work.removed"))
    }

    @Test func ledgerUnionMapsKnownAndUnknownTypes() throws {
        var parser = SSEParser()
        let conversation = ledgerEventFrame(seq: 7)
        let frames = parser.feed(text: conversation)
        #expect(frames.count == 1)
        guard case .ledger(let event) = try frames[0].streamFrame() else {
            Issue.record("expected ledger frame"); return
        }
        #expect(event.seq == 7)
        #expect(event.data == .conversation(try JSONDecoder().decode(Conversation.self, from: json(#"{"id": "conv-1", "ghostId": "ghost-1", "kind": "direct", "workId": null, "title": "대화", "model": null, "busy": false, "createdAt": 1, "lastActivityAt": 2}"#))))

        var unknownParser = SSEParser()
        let unknown = "event: ledger\ndata: {\"seq\": 9, \"at\": 1, \"data\": {\"type\": \"space.removed\", \"id\": \"space-1\"}}\n\n"
        guard case .ledger(let unknownEvent) = try unknownParser.feed(text: unknown)[0].streamFrame() else {
            Issue.record("expected ledger frame"); return
        }
        #expect(unknownEvent.data == .other("space.removed"))

        var removedParser = SSEParser()
        let removed = "event: ledger\ndata: {\"seq\": 10, \"at\": 1, \"data\": {\"type\": \"conversation.removed\", \"id\": \"conv-1\"}}\n\n"
        guard case .ledger(let removedEvent) = try removedParser.feed(text: removed)[0].streamFrame() else {
            Issue.record("expected ledger frame"); return
        }
        #expect(removedEvent.data == .conversationRemoved("conv-1"))
    }

    @Test func parsesLiveAndResetFrames() throws {
        var parser = SSEParser()
        let live = "event: live\ndata: {\"type\": \"live\", \"live\": {\"conversationId\": \"conv-1\", \"running\": true, \"partial\": \"결\", \"tools\": [{\"callId\": \"c-1\", \"name\": \"write\", \"output\": \"ok\"}]}}\n\n"
        let message = "event: live\ndata: {\"type\": \"message\", \"message\": {\"id\": \"m-2\", \"conversationId\": \"conv-1\", \"role\": \"assistant\", \"origin\": null, \"text\": \"결과입니다\", \"toolCalls\": [], \"tool\": null, \"attachments\": [], \"createdAt\": 5}}\n\n"
        let reset = "event: reset\ndata: {\"seq\": 3}\n\n"
        let frames = parser.feed(text: live + message + reset)
        #expect(frames.count == 3)
        guard case .live(.live(let live)) = try frames[0].streamFrame() else {
            Issue.record("expected live frame"); return
        }
        #expect(live.running)
        #expect(live.tools[0].name == "write")
        guard case .live(.message(let message)) = try frames[1].streamFrame() else {
            Issue.record("expected message frame"); return
        }
        #expect(message.text == "결과입니다")
        guard case .reset(let seq) = try frames[2].streamFrame() else {
            Issue.record("expected reset frame"); return
        }
        #expect(seq == 3)
    }

    @Test func unknownEventNamesAreRejectedByStreamFrame() {
        var parser = SSEParser()
        let frames = parser.feed(text: "event: future\ndata: {}\n\n")
        #expect(frames.count == 1)
        #expect(throws: (any Error).self) { try frames[0].streamFrame() }
    }

    @Test func multilineDataJoinsAndCommentsAreIgnored() throws {
        var parser = SSEParser()
        let frame = ": keep-alive\n: ping\nevent: reset\ndata: {\"seq\":\ndata: 12}\n\n"
        let frames = parser.feed(text: frame)
        #expect(frames.count == 1)
        #expect(frames[0].event == "reset")
        guard case .reset(let seq) = try frames[0].streamFrame() else {
            Issue.record("expected reset frame"); return
        }
        #expect(seq == 12)
    }
}

@Suite struct GhostAPITests {
    private func makeAPI() -> (GhostAPI, StubLane, URL) {
        let (origin, lane) = makeStubOrigin()
        let connection = try! Connection(origin: origin, deviceId: "device-1", token: "device-token")
        let pendingFile = FileManager.default.temporaryDirectory
            .appending(path: "api-tests/\(UUID().uuidString)/pending.json")
        let api = GhostAPI(connection: connection, pendingFile: pendingFile, session: StubURLProtocol.makeSession())
        return (api, lane, pendingFile)
    }

    private func ok(_ body: String) -> StubResponse {
        StubResponse(action: .reply(status: 200, body: json(body)))
    }

    @Test func decodesStateAndSendsBearerToken() async throws {
        let (api, registry, _) = makeAPI()
        let snapshot = GhostStateSnapshot(seq: 1, principal: .owner,
            runtime: Runtime(ready: true, detail: "", version: "1"),
            ghosts: [], conversations: [], works: [], decisions: [], notifications: [])
        registry.enqueue(ok(String(data: stubJSON(snapshot), encoding: .utf8)!))
        let state = try await api.state()
        #expect(state.seq == 1)
        let request = registry.allRequests()[0]
        #expect(request.path == "/api/state")
    }

    @Test func eventRequestCarriesSeqAndConversations() async throws {
        let (api, _, _) = makeAPI()
        let request = api.eventRequest(after: 41, conversations: ["conv-1", "conv-2"])
        let url = try #require(request.url)
        #expect(url.path == "/api/events")
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = try #require(components?.queryItems)
        let after = queryItems.first(where: { $0.name == "after" })?.value
        #expect(after == "41")
        let conversations = queryItems.filter { $0.name == "conversation" }.compactMap(\.value)
        #expect(conversations == ["conv-1", "conv-2"])
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer device-token")
        #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    }

    @Test func unknownOutcomeKeepsEnvelopeAndRetriesSameRequestId() async throws {
        let (api, registry, pendingFile) = makeAPI()
        let journal = PendingCommands(file: pendingFile)
        registry.enqueue(StubResponse(action: .networkFailure))
        let command = DeviceCommand.messageSend(conversationId: "conv-1", text: "첫 메시지")
        do { _ = try await api.send(command); Issue.record("send should fail") }
        catch { /* unknown outcome */ }
        let pending = try await journal.all()
        #expect(pending.count == 1)
        let firstRequest = registry.allRequests()[0]
        let firstBody = try #require(JSONSerialization.jsonObject(with: firstRequest.body) as? [String: Any])
        let requestId = try #require(firstBody["requestId"] as? String)
        #expect(pending[0].requestId == requestId)

        // A retry with the stored envelope sends the same id and bytes.
        registry.enqueue(ok(#"{"ok": true, "result": {"conversationId": "conv-1"}}"#))
        let result = try await api.retry(pending[0])
        #expect(result.dictionary["conversationId"]?.text == "conv-1")
        let requests = registry.allRequests()
        #expect(requests.count == 2)
        let retryBody = try #require(JSONSerialization.jsonObject(with: requests[1].body) as? [String: Any])
        #expect(retryBody["requestId"] as? String == requestId)
        #expect(requests[1].body == firstRequest.body)
        #expect(try await journal.all().isEmpty)
    }

    @Test func identicalPendingCommandCollapsesOntoOneEnvelope() async throws {
        let (api, registry, pendingFile) = makeAPI()
        let journal = PendingCommands(file: pendingFile)
        registry.enqueue(StubResponse(action: .networkFailure))
        registry.enqueue(StubResponse(action: .networkFailure))
        let command = DeviceCommand.messageSend(conversationId: "conv-1", text: "같은 내용")
        for _ in 0..<2 { _ = try? await api.send(command) }
        let requests = registry.allRequests()
        #expect(requests.count == 2)
        #expect(requests[0].body == requests[1].body)
        #expect(try await journal.all().count == 1)
    }

    @Test func definitiveRejectionRemovesEnvelopeAndThrowsCommandError() async throws {
        let (api, registry, pendingFile) = makeAPI()
        let journal = PendingCommands(file: pendingFile)
        registry.enqueue(ok(#"{"ok": false, "error": {"code": "forbidden", "message": "허용되지 않음"}}"#))
        do {
            _ = try await api.send(.workCancel(workId: "work-1"))
            Issue.record("send should fail")
        } catch let error as CommandError {
            #expect(error.code == "forbidden")
        }
        #expect(try await journal.all().isEmpty)
    }

    @Test func artifactBytesVerifyAgainstDigest() async throws {
        let (api, registry, _) = makeAPI()
        let bytes = Data("# 책 목록\n- 에세이".utf8)
        let digest = GhostAPI.sha256Hex(bytes)
        registry.enqueue(StubResponse(action: .reply(status: 200, body: bytes)))
        let loaded = try await api.artifact(digest: digest)
        #expect(loaded == bytes)
        #expect(registry.allRequests()[0].path == "/api/artifacts/\(digest)")

        let wrongDigest = String(repeating: "9", count: 64)
        registry.enqueue(StubResponse(action: .reply(status: 200, body: bytes)))
        await #expect(throws: MobileError.self) { try await api.artifact(digest: wrongDigest) }
    }

    @Test func conversationListPassesPagingQuery() async throws {
        let (api, registry, _) = makeAPI()
        let page = ConversationPage(
            conversation: Conversation(id: "conv-1", ghostId: "ghost-1", kind: .direct, workId: nil,
                title: "대화", busy: false, createdAt: 1, lastActivityAt: 2),
            messages: [], before: nil, live: nil)
        registry.enqueue(ok(String(data: stubJSON(page), encoding: .utf8)!))
        let loaded = try await api.conversation(id: "conv 1", before: "m-9", limit: 30)
        #expect(loaded.messages.isEmpty)
        let request = registry.allRequests()[0]
        #expect(request.path == "/api/conversations/conv%201")
        #expect(request.query.contains("before=m-9"))
        #expect(request.query.contains("limit=30"))
    }

    @Test func unauthorizedStateSurfacesPairingMessage() async throws {
        let (api, registry, _) = makeAPI()
        registry.enqueue(StubResponse(action: .reply(status: 401, body: json(#"{}"#))))
        do { _ = try await api.state(); Issue.record("state should fail") }
        catch let error as MobileError {
            #expect(error.localizedDescription.contains("연결이 해제"))
        }
    }
}
