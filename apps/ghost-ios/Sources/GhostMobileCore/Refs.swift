import Foundation

/// A machine reference inside prose: an entity id (or the abbreviated head of one) or a content digest.
/// Mirrors apps/ghost-ui/src/components/refs.ts so both clients read Ghost prose the same way.
public struct Ref: Hashable, Sendable {
    public enum Kind: String, Sendable { case id, digest }
    public var kind: Kind
    public var value: String

    public init(kind: Kind, value: String) {
        self.kind = kind
        self.value = value
    }
}

public enum RefPiece: Hashable, Sendable {
    case text(String)
    case ref(Ref)
}

public enum RefScanner {
    private static let uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    /// Ghosts shorten ids as `66eb43f1-…` or `01a1ba5c-5590-...`; the head still names one entity.
    private static let abbreviated = "[0-9a-f]{8}(?:-[0-9a-f]{4}){0,3}-?(?:…|\\.{3})"
    // JavaScript's `\b` is ASCII-only, so "a3f9…1a에" ends a digest there; ICU's Unicode `\b`
    // would not. Explicit ASCII lookarounds keep both clients splitting Korean prose alike.
    private static let start = "(?<![0-9A-Za-z_])"
    private static let end = "(?![0-9A-Za-z_])"
    // Candidates only; a digest also needs a digit and a letter, so plain numbers and words stay text.
    private static let candidate = try! NSRegularExpression(
        pattern: "(\\()?\(start)(\(uuid)\(end)|\(abbreviated)|[0-9a-f]{12,64}\(end))(\\))?", options: [.caseInsensitive])
    private static let wholePattern = try! NSRegularExpression(
        pattern: "^(?:\(uuid)|\(abbreviated)|[0-9a-f]{12,64})$", options: [.caseInsensitive])

    static func ref(of value: String) -> Ref? {
        let lower = value.lowercased()
        let hasDigit = lower.contains(where: \.isNumber)
        if lower.hasSuffix("…") || lower.hasSuffix("...") {
            guard hasDigit else { return nil }
            var head = lower
            if head.hasSuffix("…") { head.removeLast() } else { head.removeLast(3) }
            if head.hasSuffix("-") { head.removeLast() }
            return Ref(kind: .id, value: head)
        }
        if lower.count == 36 && lower.contains("-") { return Ref(kind: .id, value: lower) }
        return hasDigit && lower.contains(where: { "abcdef".contains($0) }) ? Ref(kind: .digest, value: lower) : nil
    }

    /// Prose split around machine references. A reference wrapped in its own parentheses takes
    /// them along, so "(1adb…)" leaves no empty brackets once it becomes a mark.
    public static func split(_ text: String) -> [RefPiece] {
        let ns = text as NSString
        var pieces: [RefPiece] = []
        var last = 0
        for match in candidate.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let valueRange = match.range(at: 2)
            guard let ref = ref(of: ns.substring(with: valueRange)) else { continue }
            let open = match.range(at: 1).location != NSNotFound
            let close = match.range(at: 3).location != NSNotFound
            var start = match.range.location
            var end = match.range.location + match.range.length
            // Only a matched pair is absorbed; a lone bracket stays with the prose around it.
            if open && !close { start += 1 }
            if close && !open { end -= 1 }
            if start > last { pieces.append(.text(ns.substring(with: NSRange(location: last, length: start - last)))) }
            pieces.append(.ref(ref))
            last = end
        }
        if last < ns.length { pieces.append(.text(ns.substring(from: last))) }
        return pieces
    }

    /// The single reference a short code span holds, if that is all it holds.
    public static func whole(_ text: String) -> Ref? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(location: 0, length: (value as NSString).length)
        return wholePattern.firstMatch(in: value, range: range) == nil ? nil : ref(of: value)
    }
}

/// What a reference points at in the device's snapshot. A shortened id resolves only when
/// exactly one entity of any kind starts with it; a digest prefix names a result file.
public enum ResolvedRef: Hashable, Sendable {
    case work(Work)
    case ghost(Ghost)
    case conversation(Conversation)
    case file(ArtifactRef)
    case unresolved(Ref)

    public static func resolve(_ ref: Ref, in state: GhostStateSnapshot) -> ResolvedRef {
        switch ref.kind {
        case .id:
            func matches(_ id: String) -> Bool { ref.value.count == 36 ? id == ref.value : id.hasPrefix(ref.value) }
            let works = state.works.filter { matches($0.id) }
            let ghosts = state.ghosts.filter { matches($0.id) }
            let conversations = state.conversations.filter { matches($0.id) }
            guard works.count + ghosts.count + conversations.count == 1 else { return .unresolved(ref) }
            if let work = works.first { return .work(work) }
            if let ghost = ghosts.first { return .ghost(ghost) }
            return .conversation(conversations[0])
        case .digest:
            let file = state.works.lazy.flatMap { $0.result?.artifacts ?? [] }.first { $0.digest.hasPrefix(ref.value) }
            return file.map(ResolvedRef.file) ?? .unresolved(ref)
        }
    }
}
