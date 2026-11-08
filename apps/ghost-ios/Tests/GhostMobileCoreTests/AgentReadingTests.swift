import Foundation
import Testing
@testable import GhostMobileCore

@Suite struct AgentReadingTests {
    private let workID = "1adb2c3d-4e5f-4a1b-9c2d-3e4f5a6b7c8d"

    private func ghost(_ id: String, _ name: String, isDefault: Bool = false, state: GhostState = .active, deletedAt: Int? = nil) -> Ghost {
        Ghost(id: id, name: name, persona: "", look: Look(avatarId: nil), model: nil, isDefault: isDefault, state: state,
              directConversationId: "conv-\(id)", deletedAt: deletedAt, createdAt: 1, updatedAt: 1)
    }

    private func work(_ id: String, ghost: String = "g1", parent: String? = nil, root: String? = nil, origin: String = "conv-g1",
                      state: WorkState = .running, updatedAt: Int = 10) -> Work {
        Work(id: id, parentId: parent, rootId: root ?? id, ghostId: ghost, originConversationId: origin, conversationId: nil,
             title: "일 \(id)", brief: "", acceptance: Acceptance(criteria: ""), state: state, revision: 1, revisionsUsed: 0,
             deadlineAt: nil, result: nil, verdict: nil, reason: nil, createdAt: updatedAt, startedAt: nil, endedAt: nil, updatedAt: updatedAt)
    }

    private func decision(_ id: String, ghost: String, work: String? = nil, kind: DecisionKind = .question, state: DecisionState = .pending, at: Int = 1) -> Decision {
        Decision(id: id, kind: kind, ghostId: ghost, conversationId: "conv-\(ghost)", workId: work, effectId: nil, title: "결정 \(id)",
                 detail: "", options: [], proposal: nil, state: state, answer: nil, createdAt: at, resolvedAt: nil)
    }

    private func snapshot(ghosts: [Ghost] = [], conversations: [Conversation] = [], works: [Work] = [], decisions: [Decision] = []) -> GhostStateSnapshot {
        GhostStateSnapshot(seq: 1, principal: .owner, runtime: Runtime(ready: true, detail: "", version: "t"),
                           ghosts: ghosts, conversations: conversations, works: works, decisions: decisions, notifications: [])
    }

    @Test func referencesTakeOnlyTheirOwnParentheses() {
        #expect(RefScanner.split("결과(\(workID))를 보세요") == [.text("결과"), .ref(Ref(kind: .id, value: workID)), .text("를 보세요")])
        #expect(RefScanner.split("(1adb2c3d… 진행") == [.text("("), .ref(Ref(kind: .id, value: "1adb2c3d")), .text(" 진행")])
        #expect(RefScanner.split("01a1ba5c-5590-... 끝") == [.ref(Ref(kind: .id, value: "01a1ba5c-5590")), .text(" 끝")])
        // A Korean particle right after a digest still ends it, as JavaScript's ASCII `\b` does.
        #expect(RefScanner.split("파일은 a3f9c2e1b7d4에 있어요") == [.text("파일은 "), .ref(Ref(kind: .digest, value: "a3f9c2e1b7d4")), .text("에 있어요")])
        #expect(RefScanner.split("파일 a3f9c2e1b7d4 확인") == [.text("파일 "), .ref(Ref(kind: .digest, value: "a3f9c2e1b7d4")), .text(" 확인")])
        // Plain numbers and hex-only words stay prose.
        #expect(RefScanner.split("전화 123456789012 와 deadbeefcafe") == [.text("전화 123456789012 와 deadbeefcafe")])
        #expect(RefScanner.whole(" \(workID) ") == Ref(kind: .id, value: workID))
        #expect(RefScanner.whole("id \(workID)") == nil)
    }

    @Test func shortenedIdsResolveOnlyWhenUnique() {
        let state = snapshot(ghosts: [ghost("1adb9999-0000-4000-8000-000000000000", "도우미")], works: [work(workID)])
        #expect(ResolvedRef.resolve(Ref(kind: .id, value: "1adb2c3d"), in: state) == .work(state.works[0]))
        #expect(ResolvedRef.resolve(Ref(kind: .id, value: "1adb"), in: state) == .unresolved(Ref(kind: .id, value: "1adb")))
        #expect(ResolvedRef.resolve(Ref(kind: .id, value: "1adb9999"), in: state) == .ghost(state.ghosts[0]))
    }

    @Test func outcomesAndWakesReadInTheOwnersLanguage() {
        let failed = Wake.parseOutcome("Work \"주간 보고\" (\(workID)) is failed.\n\n모델 한도에 걸렸습니다.")
        #expect(failed == Outcome(workId: workID, title: "주간 보고", state: "failed", reason: "모델 한도에 걸렸습니다."))
        #expect(Wake.parseOutcome("Work \"주간 보고\" (\(workID)) is done.\n\n요약")?.reason == "")
        #expect(Wake.parseOutcome("Work finished") == nil)

        let resumed = Wake.describe(origin: "work", text: "The owner resumed this Work.\n\n# 회의 메모 요약\n본문")
        #expect(resumed.label == "재개" && resumed.line == "회의 메모 요약" && resumed.detail != nil)
        let stopped = Wake.describe(origin: "work", text: "You stopped without finishing. Complete it.")
        #expect(stopped == WakeView(label: "이어서 진행", line: "결과 없이 멈춰서 마무리를 다시 요청했습니다", detail: nil))
        let answered = Wake.describe(origin: "decision", text: "The owner answered \"분위기?\": 차분한 이야기")
        #expect(answered == WakeView(label: "답변", line: "차분한 이야기", detail: nil))
        let schedule = Wake.describe(origin: "schedule", text: "매일 아침 정리\n세부")
        #expect(schedule.label == "반복 작업" && schedule.line == "매일 아침 정리" && schedule.detail == "매일 아침 정리\n세부")

        let handoff = Message(id: "t", conversationId: "c", role: .tool, origin: nil,
                              text: "Delegated \"자료 조사\" (\(workID)) to 연구원. Its result arrives here.",
                              tool: MessageToolInfo(callId: "x", name: "delegate", isError: false), createdAt: 1)
        #expect(Wake.delegation(handoff) == Delegation(title: "자료 조사", ghost: "연구원"))
    }

    @Test func conversationDecisionsCoverItsThreadsAtAnyDepth() {
        let root = work("root", origin: "conv-g1")
        let child = work("child", ghost: "g2", parent: "root", root: "root")
        let elsewhere = work("other", ghost: "g2", origin: "conv-g2")
        let state = snapshot(works: [root, child, elsewhere], decisions: [
            decision("own", ghost: "g1", at: 3),
            decision("deep", ghost: "g2", work: "child", at: 1),
            decision("foreign", ghost: "g2", work: "other", at: 2),
            decision("done", ghost: "g1", state: .answered, at: 0),
        ])
        #expect(state.chatDecisions(ghostId: "g1", conversationId: "conv-g1").map(\.id) == ["deep", "own"])
        #expect(state.chatDecisions(ghostId: "g1", conversationId: nil).map(\.id) == ["own"])
    }

    @Test func rosterHidesRetiredAndDeletedGhostsAndRanksPresence() {
        let ghosts = [ghost("g3", "하늘"), ghost("g1", "도우미", isDefault: true), ghost("g2", "가람"),
                      ghost("g4", "은퇴", state: .retired), ghost("g5", "삭제", state: .retired, deletedAt: 9)]
        let busy = Conversation(id: "conv-g2", ghostId: "g2", kind: .direct, workId: nil, title: "", busy: true, createdAt: 1, lastActivityAt: 1)
        let now = Date(timeIntervalSince1970: 1_000_000)
        let nowMs = 1_000_000_000
        let state = snapshot(ghosts: ghosts, conversations: [busy],
                             works: [work("w1", ghost: "g1", state: .running), work("f3", ghost: "g3", state: .failed, updatedAt: nowMs - 1000)],
                             decisions: [decision("d1", ghost: "g1")])
        #expect(state.visibleGhosts.map(\.name) == ["도우미", "가람", "하늘"])
        #expect(state.presence(of: ghosts[1], now: now) == PresenceReading(state: .attention, line: "결정 d1", rank: 0))
        #expect(state.presence(of: ghosts[2], now: now) == PresenceReading(state: .working, line: "응답 중", rank: 2))
        #expect(state.presence(of: ghosts[0], now: now) == PresenceReading(state: .attention, line: "일 f3", rank: 4))
        #expect(state.presence(of: ghosts[0], now: now.addingTimeInterval(86_400)).state == .idle)
        #expect(GlyphState(work: .running, needsOwner: true) == .attention)
        #expect(GlyphState(work: .done, needsOwner: true) == .done)
    }

    @Test func starterAndQuoteCopy() {
        #expect(GhostCopy.starters(persona: "자료를 찾는 리서처입니다. 출처를 남깁니다.").map(\.label) == ["조사 시작", "비교 기준"])
        #expect(GhostCopy.starters(persona: "리서처이자 에디터").map(\.label) == ["요청 구체화", "단계 나누기"])
        #expect(GhostCopy.profileSummary("work_create 도구를 쓴다") == "역할 지시가 설정되어 있습니다.")
        #expect(GhostCopy.quoteForReply(" 첫 줄\n둘째 줄 ") == "> 첫 줄\n> 둘째 줄\n\n")
        #expect(GhostCopy.workTitle("\n보고서 정리\n세부 내용") == "보고서 정리")
    }

    @Test func workCreateCarriesCriteriaAndReportingConversation() throws {
        let command = DeviceCommand.workCreate(ghostId: "g2", title: "자료 조사", brief: "자료 조사\n범위", criteria: "출처 3개",
                                               deadlineAt: nil, originConversationId: "conv-g1")
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        #expect(object["originConversationId"] as? String == "conv-g1")
        let acceptance = try #require(object["acceptance"] as? [String: Any])
        #expect(acceptance["criteria"] as? String == "출처 3개")
        #expect((acceptance["checks"] as? [Any])?.isEmpty == true)
        #expect(acceptance["reviewer"] is NSNull)
        #expect(object["deadlineAt"] == nil)
        #expect(try JSONDecoder().decode(DeviceCommand.self, from: JSONEncoder().encode(command)) == command)
        let plain = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            DeviceCommand.workCreate(ghostId: "g1", title: "t", brief: "b", criteria: "", deadlineAt: nil))) as? [String: Any])
        #expect(plain["acceptance"] == nil && plain["originConversationId"] == nil)
    }
}
