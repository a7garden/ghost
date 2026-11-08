import Foundation

// Owner-facing readings of agent state shared by every phone surface. Mirrors the web's
// StateGlyph, ghostState, decisionText, Decision.chatDecisions and conversationSuggestions.

/// Work lifecycle plus the owner-facing "needs you" reading of a live Work.
public enum GlyphState: String, Hashable, Sendable {
    case queued, running, waiting, verifying, blocked, done, failed, cancelled, attention

    public enum Tone: Sendable { case muted, signal, amber, danger, success }

    /// A live Work with a pending owner decision reads as 확인 필요, whichever step it is on.
    public init(work state: WorkState, needsOwner: Bool) {
        if needsOwner && state != .blocked && !state.isTerminal { self = .attention }
        else { self = GlyphState(rawValue: state.rawValue) ?? .queued }
    }

    public var label: String {
        switch self {
        case .queued: "대기 중"
        case .running: "진행 중"
        case .waiting: "위임 결과 대기"
        case .verifying: "검증 중"
        case .blocked: "결과 미확정"
        case .done: "완료"
        case .failed: "실패"
        case .cancelled: "취소됨"
        case .attention: "확인 필요"
        }
    }

    public var tone: Tone {
        switch self {
        case .attention, .blocked: .amber
        case .failed: .danger
        case .done: .success
        case .running, .verifying: .signal
        default: .muted
        }
    }
}

public enum PresenceState: Sendable { case idle, working, attention }

/// What one Ghost is doing right now, in the owner's words; no line when idle.
public struct PresenceReading: Hashable, Sendable {
    public var state: PresenceState
    public var line: String?
    /// 0 decision · 1 blocked · 2 responding · 3 running · 4 recent failure · 5 idle.
    public var rank: Int
}

public extension GhostStateSnapshot {
    /// Ghosts still in circulation: deleted and retired ones leave every list and picker; default leads, then 가나다순.
    var visibleGhosts: [Ghost] {
        ghosts.filter { $0.state != .retired && $0.deletedAt == nil }.sorted { lhs, rhs in
            if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
            return lhs.name.compare(rhs.name, locale: Locale(identifier: "ko_KR")) == .orderedAscending
        }
    }

    var pendingDecisions: [Decision] { decisions.filter(\.isPending).sorted { $0.createdAt < $1.createdAt } }

    func needsOwner(workId: String) -> Bool { decisions.contains { $0.isPending && $0.workId == workId } }

    func glyph(for work: Work) -> GlyphState { GlyphState(work: work.state, needsOwner: needsOwner(workId: work.id)) }

    /// A result to accept is named by its Work; every other decision by its own title.
    func heading(of decision: Decision) -> String {
        if decision.kind == .accept_result, let workId = decision.workId, let work = works.first(where: { $0.id == workId }) { return work.title }
        return decision.title
    }

    func presence(of ghost: Ghost, now: Date = Date()) -> PresenceReading {
        if let decision = pendingDecisions.first(where: { $0.ghostId == ghost.id }) {
            return PresenceReading(state: .attention, line: heading(of: decision), rank: 0)
        }
        let live = works.filter { $0.ghostId == ghost.id && !$0.state.isTerminal }.sorted { $0.updatedAt > $1.updatedAt }
        if let stuck = live.first(where: { $0.state == .blocked }) { return PresenceReading(state: .attention, line: stuck.title, rank: 1) }
        if conversations.contains(where: { $0.ghostId == ghost.id && $0.kind == .direct && $0.busy }) {
            return PresenceReading(state: .working, line: "응답 중", rank: 2)
        }
        if let moving = live.first(where: { $0.state == .running || $0.state == .verifying }) ?? live.first {
            return PresenceReading(state: .working, line: moving.title, rank: 3)
        }
        // A failed root asks for a glance for a day; the notification history keeps it after that.
        let dayAgo = Int(now.timeIntervalSince1970 * 1000) - 86_400_000
        if let failed = works.filter({ $0.ghostId == ghost.id && $0.state == .failed && $0.updatedAt > dayAgo }).max(by: { $0.updatedAt < $1.updatedAt }) {
            return PresenceReading(state: .attention, line: failed.title, rank: 4)
        }
        return PresenceReading(state: .idle, line: nil, rank: 5)
    }

    /// Root Works begun in a conversation, oldest first: the threads it branched.
    func threads(of conversationId: String) -> [Work] {
        works.filter { $0.originConversationId == conversationId && $0.parentId == nil }.sorted { $0.createdAt < $1.createdAt }
    }

    /// Works other Ghosts carry below a thread, at any depth, oldest first.
    func delegates(of root: Work) -> [Work] {
        works.filter { $0.rootId == root.id && $0.id != root.id }.sorted { $0.createdAt < $1.createdAt }
    }

    /// What a Ghost's conversation needs from the owner: every pending decision of that Ghost plus
    /// those of threads begun in this conversation, at any depth, whoever carries them. Oldest first.
    func chatDecisions(ghostId: String, conversationId: String?) -> [Decision] {
        let roots = Set(conversationId.map { id in threads(of: id).map(\.id) } ?? [])
        let inThreads = Set(works.filter { roots.contains($0.rootId) || roots.contains($0.id) }.map(\.id))
        return pendingDecisions.filter { $0.ghostId == ghostId || ($0.workId.map(inThreads.contains) ?? false) }
    }
}

public extension DecisionKind {
    var label: String {
        switch self {
        case .approve_effect: "실행 승인"
        case .question: "답변 대기"
        case .accept_result: "결과 확인"
        case .document_review: "문서 검토"
        case .reconcile_effect: "결과 미확정"
        }
    }

    /// What approving and denying mean for this kind; the same words as the web deck.
    var actionLabels: (approve: String, deny: String) {
        switch self {
        case .accept_result: ("결과 확인", "수정 요청")
        case .document_review: ("저장 승인", "거부")
        case .reconcile_effect: ("의도대로 처리됨", "처리되지 않음")
        case .approve_effect, .question: ("승인", "거부")
        }
    }
}

public enum GhostCopy {
    /// The first sentence of a persona, for display only; the saved instructions never change.
    public static func profileSummary(_ persona: String) -> String {
        let firstLine = persona.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        var first = firstLine
        if let end = first.firstIndex(where: { ".!?。！？".contains($0) }) {
            let next = first.index(after: end)
            if next < first.endIndex, first[next].isWhitespace { first = String(first[...end]) }
        }
        if first.isEmpty { return "역할 미설정" }
        // Tool identifiers belong in the full instructions, not the role introduction.
        if first.range(of: #"\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b"#, options: .regularExpression) != nil { return "역할 지시가 설정되어 있습니다." }
        return first
    }

    public struct Starter: Hashable, Sendable {
        public var label: String
        public var prompt: String
    }

    private static let general = [
        Starter(label: "요청 구체화", prompt: "맡길 일을 설명할게. 먼저 필요한 정보와 범위를 짚어줘"),
        Starter(label: "단계 나누기", prompt: "내 요청을 단계로 나누고 먼저 확인할 점을 알려줘"),
    ]
    private static let roles: [(pattern: String, starters: [Starter])] = [
        (#"리서처|연구자|조사|researcher|research assistant"#, [
            Starter(label: "조사 시작", prompt: "조사할 주제를 알려줄게. 확인할 질문과 출처부터 정리해줘"),
            Starter(label: "비교 기준", prompt: "비교할 대상을 알려줄게. 판단 기준을 함께 정해줘"),
        ]),
        (#"에디터|편집자|글쓰기|작가|\b(?:editor|writer)\b"#, [
            Starter(label: "문장 다듬기", prompt: "글을 붙여넣을게. 핵심을 유지하면서 문장을 다듬어줘"),
            Starter(label: "글 구성", prompt: "전하고 싶은 내용을 적을게. 글의 순서를 함께 잡아줘"),
        ]),
        (#"개발자|프로그래머|\b(?:developer|programmer|software engineer)\b"#, [
            Starter(label: "기능 설계", prompt: "만들고 싶은 기능을 설명할게. 구현 전에 확인할 조건을 정리해줘"),
            Starter(label: "오류 분석", prompt: "오류 메시지를 붙여넣을게. 원인 후보와 확인 방법을 짚어줘"),
        ]),
        (#"계획|할 일|일정|플래너"#, [
            Starter(label: "맡긴 일 진행", prompt: "맡긴 일의 진행 상황을 정리하고 다음 단계를 짚어줘"),
            Starter(label: "주간 계획", prompt: "이번 주 목표를 작은 할 일로 나누고 필요한 준비를 짚어줘"),
        ]),
    ]

    /// Draft examples from the visible role introduction, not names or tool instructions.
    public static func starters(persona: String) -> [Starter] {
        let summary = profileSummary(persona)
        let matching = roles.filter { summary.range(of: $0.pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        return matching.count == 1 ? matching[0].starters : general
    }

    /// Host timestamps relative to the local clock; dates beyond a day stay absolute.
    public static func relativeTime(_ at: Int, now: Date = Date()) -> String {
        let seconds = max(0, Int((now.timeIntervalSince1970 * 1000 - Double(at)) / 1000))
        if seconds < 45 { return "방금" }
        if seconds < 3600 { return "\(max(1, Int((Double(seconds) / 60).rounded())))분 전" }
        if seconds < 86400 { return "\(seconds / 3600)시간 전" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일"
        return formatter.string(from: contractDate(at))
    }

    /// How long a settled Work ran, or nil before it started and ended.
    public static func duration(_ work: Work) -> String? {
        guard let started = work.startedAt, let ended = work.endedAt else { return nil }
        let minutes = Int((Double(ended - started) / 60_000).rounded())
        if minutes < 1 { return "1분 미만" }
        if minutes < 60 { return "\(minutes)분" }
        return minutes % 60 == 0 ? "\(minutes / 60)시간" : "\(minutes / 60)시간 \(minutes % 60)분"
    }

    /// A quote of a message for the composer: each line prefixed with `> `, then a blank line.
    public static func quoteForReply(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { "> \($0)" }.joined(separator: "\n") + "\n\n"
    }

    /// A 맡긴 일's title is the first line of what the owner wrote.
    public static func workTitle(_ text: String) -> String {
        String((text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first ?? "").trimmingCharacters(in: .whitespaces).prefix(256))
    }
}
