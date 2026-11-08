import Foundation

// Host wakes are written for the Ghost that receives them: exact, English and full of ids.
// The transcript shows the owner what happened in a line of their own language and keeps the
// Ghost's text one disclosure away. Mirrors apps/ghost-ui/src/components/wake.ts.

/// A settled Work as the host reports it to the parent or the owner.
public struct Outcome: Hashable, Sendable {
    public var workId: String
    public var title: String
    public var state: String
    /// A failure's reason; a done Work carries its summary and files on the Work itself.
    public var reason: String
}

/// How one wake reads in the transcript: a kind, one line, and the Ghost's full text when it says more.
public struct WakeView: Hashable, Sendable {
    public var label: String
    public var line: String
    public var detail: String?
}

/// A `delegate` tool result: the child Work's title and the Ghost it went to.
public struct Delegation: Hashable, Sendable {
    public var title: String
    public var ghost: String
}

public enum Wake {
    private static let outcome = try! NSRegularExpression(
        pattern: #"^Work "([\s\S]*?)" \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\) is (\w+)\.(?:\n\n([\s\S]*))?$"#)
    private static let delegated = try! NSRegularExpression(
        pattern: #"^Delegated "([\s\S]+)" \([^)]+\) to ([\s\S]+?)\. Its result arrives here\.$"#)

    public static func parseOutcome(_ text: String) -> Outcome? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let groups = captures(outcome, trimmed) else { return nil }
        let state = groups[2] ?? ""
        return Outcome(workId: groups[1] ?? "", title: groups[0] ?? "", state: state,
                       reason: state == "done" ? "" : (groups[3] ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// A `delegate` result reads as a hand-off event, not a tool chip.
    public static func delegation(_ message: Message) -> Delegation? {
        guard message.role == .tool, message.tool?.name == "delegate", message.tool?.isError == false,
              let groups = captures(delegated, message.text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return Delegation(title: groups[0] ?? "", ghost: groups[1] ?? "")
    }

    private struct Rule: Sendable {
        let pattern: NSRegularExpression
        /// Groups → label, line, detail (`nil` keeps the full text, `.some(nil)` drops it).
        let view: @Sendable (_ groups: [String?], _ text: String) -> (label: String, line: String, detail: String??)
        init(_ pattern: String, _ view: @escaping @Sendable (_ groups: [String?], _ text: String) -> (label: String, line: String, detail: String??)) {
            self.pattern = try! NSRegularExpression(pattern: pattern)
            self.view = view
        }
    }

    private static let originLabel: [String: String] = [
        "work": "맡긴 일", "child_result": "위임 결과", "decision": "결정 전달", "schedule": "반복 작업", "verdict": "수정 요청", "report": "보고",
    ]

    private static func firstLine(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    private static let headingPattern = try! NSRegularExpression(pattern: #"^# (.+)$"#, options: [.anchorsMatchLines])
    private static func heading(_ text: String) -> String {
        (captures(headingPattern, text, anchored: false)?[0] ?? "").trimmingCharacters(in: .whitespaces)
    }

    private static let rules: [String: [Rule]] = [
        "work": [
            Rule(#"^# "#) { _, text in ("맡긴 일", heading(text), nil) },
            Rule(#"^The owner revised this Work"#) { _, text in ("수정된 지시", heading(text), nil) },
            Rule(#"^The owner resumed this Work"#) { _, text in ("재개", heading(text), nil) },
            Rule(#"^The host restarted"#) { _, text in
                let line = heading(text)
                return ("다시 시작", line.isEmpty ? "호스트가 다시 시작되어 이어서 진행합니다" : line, nil)
            },
            Rule(#"^Review the result of this Work"#) { _, text in ("검토 요청", heading(text), nil) },
            Rule(#"^You stopped without finishing"#) { _, _ in ("이어서 진행", "결과 없이 멈춰서 마무리를 다시 요청했습니다", .some(nil)) },
            Rule(#"^Nothing you were waiting on"#) { _, _ in ("대기 끝", "기다리던 결정과 위임이 모두 끝났습니다", .some(nil)) },
        ],
        "verdict": [
            Rule(#"^Verification asked for a revision \(\w+\):\n([\s\S]*?)\n\nFix the result"#) { groups, _ in
                let body = groups[0] ?? ""
                return ("수정 요청", firstLine(body), .some(body.trimmingCharacters(in: .whitespacesAndNewlines)))
            },
        ],
        "decision": [
            Rule(#"^The owner answered "([\s\S]*)": ([\s\S]*)$"#) { groups, _ in
                let answer = groups[1] ?? ""
                let line = firstLine(answer)
                return ("답변", line.isEmpty ? (groups[0] ?? "") : line, .some(answer.trimmingCharacters(in: .whitespacesAndNewlines)))
            },
            Rule(#"^The owner declined to answer "([\s\S]*)"\.$"#) { groups, _ in ("답변 안 함", groups[0] ?? "", .some(nil)) },
            Rule(#"^The owner declined the document proposal "([\s\S]*?)"\."#) { groups, _ in ("문서 거절", groups[0] ?? "", nil) },
            Rule(#"^[\w.-]+ \([^)\n]*\): ([\s\S]*)$"#) { groups, _ in
                let body = groups[0] ?? ""
                return ("승인 결과", firstLine(body), .some(body.trimmingCharacters(in: .whitespacesAndNewlines)))
            },
        ],
    ]

    public static func describe(origin: String, text: String) -> WakeView {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for rule in rules[origin] ?? [] {
            guard let groups = captures(rule.pattern, trimmed) else { continue }
            let view = rule.view(groups, trimmed)
            let line = view.line.isEmpty ? firstLine(trimmed) : view.line
            let detail: String? = view.detail ?? trimmed
            return WakeView(label: view.label, line: line, detail: detail.flatMap { $0.isEmpty || $0 == line ? nil : $0 })
        }
        let line = firstLine(trimmed)
        return WakeView(label: originLabel[origin] ?? "기록", line: line, detail: trimmed != line ? trimmed : nil)
    }

    /// Capture groups of a match from the string start (`nil` per absent group), or nil without a match.
    private static func captures(_ regex: NSRegularExpression, _ text: String, anchored: Bool = true) -> [String?]? {
        let ns = text as NSString
        guard let match = regex.firstMatch(in: text, options: anchored ? [.anchored] : [], range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (1..<max(1, match.numberOfRanges)).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? nil : ns.substring(with: range)
        }
    }
}
