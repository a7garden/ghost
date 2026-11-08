import SwiftUI
import UIKit
import GhostMobileCore

// Shared pieces of the agent surface: the branch a thread grows from a conversation, file
// chips, the actions a transcript offers, and Ghost prose with its ids turned into the
// things they name. Screen files compose these; they hold no screen state.

extension ArtifactRef: @retroactive Identifiable {
    public var id: String { digest }
}

/// What a transcript row can ask of the screen that hosts it.
struct TranscriptActions {
    var openWork: (String) -> Void = { _ in }
    var openFile: (ArtifactRef) -> Void = { _ in }
    var quote: (String) -> Void = { _ in }
    var reuse: (String) -> Void = { _ in }
    var useStarter: (String) -> Void = { _ in }
}

extension GhostPresence {
    init(_ state: PresenceState) {
        switch state {
        case .idle: self = .idle
        case .working: self = .working
        case .attention: self = .needsOwner
        }
    }
}

extension GlyphState {
    var ink: Color { GhostStateToken.ink(rawValue) }
    var tint: Color { GhostStateToken.tint(rawValue) }
    /// The stroke of a branch line in this state; muted until the Work settles.
    var branch: Color {
        switch tone {
        case .success: GhostStyle.success.opacity(0.55)
        case .danger: GhostStyle.danger.opacity(0.55)
        case .amber: GhostStyle.amber.opacity(0.6)
        default: GhostStyle.ink.opacity(0.16)
        }
    }
}

/// The "└" a thread card or outcome hangs from: a stem from above that turns toward its row.
struct BranchStem: Shape {
    /// Where the turn meets the row, measured from the top.
    var turnAt: CGFloat = 18
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let x = rect.minX + 1
        let radius = min(9, rect.width - 2, turnAt)
        p.move(to: CGPoint(x: x, y: rect.minY))
        p.addLine(to: CGPoint(x: x, y: rect.minY + turnAt - radius))
        p.addQuadCurve(to: CGPoint(x: x + radius, y: rect.minY + turnAt), control: CGPoint(x: x, y: rect.minY + turnAt))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + turnAt))
        return p
    }
}

/// A row hanging from the conversation's spine: stem on the leading edge, content beside it.
struct Branch<Content: View>: View {
    var color: Color = GhostStyle.ink.opacity(0.16)
    var turnAt: CGFloat = 18
    @ViewBuilder var content: Content
    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            BranchStem(turnAt: turnAt)
                .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                .frame(width: 16, height: turnAt + 1)
                .padding(.top, -10)
                .accessibilityHidden(true)
            content
        }
        .padding(.leading, 6)
    }
}

/// Title first, icon after: for links that leave the current surface.
struct TrailingIconLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.title; configuration.icon.imageScale(.small) }
    }
}

struct FileChip: View {
    let artifact: ArtifactRef
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Image(systemName: artifact.symbol).font(.caption).foregroundStyle(GhostStyle.secondary)
                Text(artifact.name).lineLimit(1).truncationMode(.middle)
            }
            .font(.footnote.weight(.medium)).foregroundStyle(GhostStyle.text)
            .padding(.horizontal, 12).frame(minHeight: 32)
            .background(GhostStyle.surface, in: Capsule())
            .overlay { Capsule().stroke(GhostStyle.border, lineWidth: 1) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(artifact.name) 열기")
    }
}

extension ArtifactRef {
    var symbol: String {
        if mediaType.hasPrefix("image/") { return "photo" }
        if mediaType == "text/markdown" || name.lowercased().hasSuffix(".md") { return "doc.richtext" }
        if mediaType.hasPrefix("text/") || mediaType.contains("json") { return "doc.plaintext" }
        if mediaType == "application/pdf" { return "doc" }
        return "doc"
    }
    var sizeLabel: String {
        if size < 1024 { return "\(size)B" }
        if size < 1024 * 1024 { return String(format: "%.1fKB", Double(size) / 1024) }
        return String(format: "%.1fMB", Double(size) / 1_048_576)
    }
}

/// Small wrapping flow for chips and option tiles.
struct Flow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = measure(view, width: width)
            if x > 0 && x + size.width > width { y += line + spacing; x = 0; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = measure(view, width: bounds.width)
            if x > bounds.minX && x + size.width > bounds.maxX { y += line + spacing; x = bounds.minX; line = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
    /// An item keeps its natural width up to the line; a longer one wraps within the line.
    private func measure(_ view: LayoutSubview, width: CGFloat) -> CGSize {
        let natural = view.sizeThatFits(.unspecified)
        return natural.width <= width ? natural : view.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }
}

// MARK: - Ghost prose

/// Block structure of the Markdown a Ghost writes. Inline syntax stays inside each block's text.
enum ProseBlock: Hashable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullet([String])
    case ordered(start: Int, items: [String])
    case quote(String)
    case code(String)
    case rule

    static func parse(_ text: String) -> [ProseBlock] {
        var blocks: [ProseBlock] = []
        var paragraph: [String] = []
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)[...]
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        func listItem(_ line: String) -> (ordered: Int?, text: String)? {
            let trimmed = line.drop { $0 == " " }
            if let first = trimmed.first, "-*+".contains(first), trimmed.dropFirst().first == " " {
                return (nil, String(trimmed.dropFirst(2)))
            }
            let digits = trimmed.prefix { $0.isASCII && $0.isNumber }
            if !digits.isEmpty, digits.count < 4, trimmed.dropFirst(digits.count).hasPrefix(". ") {
                return (Int(digits), String(trimmed.dropFirst(digits.count + 2)))
            }
            return nil
        }
        while let line = lines.popFirst() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                var code: [String] = []
                while let next = lines.popFirst(), !next.trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(next) }
                blocks.append(.code(code.joined(separator: "\n")))
            } else if trimmed.isEmpty {
                flush()
            } else if case let level = trimmed.prefix(while: { $0 == "#" }).count, (1...4).contains(level), trimmed.dropFirst(level).first == " " {
                flush()
                blocks.append(.heading(level: level, text: String(trimmed.dropFirst(level + 1))))
            } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flush()
                blocks.append(.rule)
            } else if trimmed.hasPrefix(">") {
                flush()
                var quoted = [String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)]
                while let next = lines.first, next.trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quoted.append(String(lines.removeFirst().trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
            } else if let item = listItem(line) {
                flush()
                var items = [item.text]
                while let next = lines.first, let nextItem = listItem(next), (nextItem.ordered == nil) == (item.ordered == nil) {
                    lines.removeFirst()
                    items.append(nextItem.text)
                }
                blocks.append(item.ordered.map { .ordered(start: $0, items: items) } ?? .bullet(items))
            } else {
                paragraph.append(line)
            }
        }
        flush()
        return blocks
    }
}

/// Inline Markdown with machine references turned into what they name. Tappable marks are
/// `ghost-ref://` links the hosting transcript resolves through `GhostProse.handle`.
enum GhostInline {
    static func render(_ source: String, state: GhostStateSnapshot) -> AttributedString {
        let parsed = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        var output = AttributedString()
        var pendingCloseParen = false
        // A mark set flush against a word gets a thin space so "결과✓" reads as two things.
        func appendMark(_ ref: Ref) {
            if let last = output.characters.last, !last.isWhitespace { output += AttributedString("\u{2009}") }
            output += mark(ref, state: state)
        }
        let runs = Array(parsed.runs)
        for (index, run) in runs.enumerated() {
            var text = String(parsed[run.range].characters)
            let isCode = run.inlinePresentationIntent?.contains(.code) == true
            if pendingCloseParen, text.hasPrefix(")") { text.removeFirst(); pendingCloseParen = false }
            if isCode, let ref = RefScanner.whole(text) {
                // "(`id`)": the brackets sit in the neighbouring text; the mark takes them along.
                if output.characters.last == "(",
                   index + 1 < runs.count, String(parsed[runs[index + 1].range].characters).hasPrefix(")") {
                    output.characters.removeLast()
                    pendingCloseParen = true
                }
                appendMark(ref)
                continue
            }
            var attributes = run.attributes
            if isCode {
                attributes.font = .system(.callout, design: .monospaced)
                attributes.backgroundColor = GhostStyle.under
            }
            if run.link != nil || isCode {
                output += AttributedString(text, attributes: attributes)
                continue
            }
            for piece in RefScanner.split(text) {
                switch piece {
                case .text(let plain): output += AttributedString(plain, attributes: attributes)
                case .ref(let ref): appendMark(ref)
                }
            }
        }
        return output
    }

    /// A reference reads as the thing it points at: a Work by its state and title, a Ghost by
    /// its name, a file by its name. Only an unknown id keeps a short head, tappable to copy.
    static func mark(_ ref: Ref, state: GhostStateSnapshot) -> AttributedString {
        func token(_ text: String, color: Color, link: String?) -> AttributedString {
            var value = AttributedString(text)
            value.foregroundColor = color
            value.font = .callout.weight(.medium)
            if let link, let url = URL(string: link) { value.link = url }
            return value
        }
        switch ResolvedRef.resolve(ref, in: state) {
        case .work(let work):
            let glyph = state.glyph(for: work)
            return token("\(symbol(glyph)) \(work.title)", color: glyph.ink, link: "ghost-ref://work/\(work.id)")
        case .ghost(let ghost):
            return token(ghost.name, color: GhostStyle.text, link: nil)
        case .conversation(let conversation):
            let owner = state.ghosts.first { $0.id == conversation.ghostId }?.name
            return token(conversation.title.isEmpty ? "\(owner ?? "Ghost")와 대화" : conversation.title, color: GhostStyle.secondary, link: nil)
        case .file(let file):
            return token("▤ \(file.name)", color: GhostStyle.text, link: "ghost-ref://file/\(file.digest)")
        case .unresolved(let raw):
            var value = token("#\(raw.value.prefix(6))", color: GhostStyle.secondary, link: "ghost-ref://copy/\(raw.value)")
            value.font = .caption.monospaced()
            return value
        }
    }

    /// One text character per state, so an inline Work reads its state without color.
    static func symbol(_ glyph: GlyphState) -> String {
        switch glyph {
        case .done: "✓"
        case .failed: "✕"
        case .attention, .blocked: "!"
        case .cancelled: "⊘"
        case .running, .verifying: "◐"
        case .waiting: "Ⅱ"
        case .queued: "○"
        }
    }
}

/// Ghost-written Markdown as readable blocks. Links to the web open in the system browser;
/// marks open the Work or file they name through the transcript's actions. `inert` renders
/// untrusted documents with every link and mark stripped of its action.
struct GhostProse: View {
    let text: String
    let state: GhostStateSnapshot
    var actions = TranscriptActions()
    var font: Font = .body
    var inert = false

    var body: some View {
        let blocks = ProseBlock.parse(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .font(font)
        .environment(\.openURL, OpenURLAction { url in inert ? .discarded : Self.handle(url, state: state, actions: actions) })
    }

    @ViewBuilder private func blockView(_ block: ProseBlock) -> some View {
        switch block {
        case .paragraph(let source):
            inline(source).lineSpacing(4)
        case .heading(let level, let source):
            inline(source).font(level == 1 ? .title3.weight(.semibold) : .headline).padding(.top, 4)
        case .bullet(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Circle().fill(GhostStyle.secondary).frame(width: 5, height: 5).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 1 }
                        inline(item).lineSpacing(3)
                    }
                }
            }
        case .ordered(let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(start + index).").monospacedDigit().foregroundStyle(GhostStyle.secondary)
                        inline(item).lineSpacing(3)
                    }
                }
            }
        case .quote(let source):
            HStack(spacing: 10) {
                Capsule().fill(GhostStyle.border).frame(width: 3)
                inline(source).foregroundStyle(GhostStyle.secondary).lineSpacing(3)
            }.fixedSize(horizontal: false, vertical: true)
        case .code(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding(12)
            }
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
        case .rule:
            Rectangle().fill(GhostStyle.border).frame(height: 1).padding(.vertical, 4)
        }
    }

    private func inline(_ source: String) -> some View {
        var rendered = GhostInline.render(source, state: state)
        if inert { rendered.link = nil }
        return Text(rendered)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func handle(_ url: URL, state: GhostStateSnapshot, actions: TranscriptActions) -> OpenURLAction.Result {
        guard url.scheme == "ghost-ref" else {
            return url.scheme == "https" || url.scheme == "http" ? .systemAction : .discarded
        }
        let value = url.lastPathComponent
        switch url.host() {
        case "work": actions.openWork(value)
        case "file":
            if let file = state.works.lazy.flatMap({ $0.result?.artifacts ?? [] }).first(where: { $0.digest == value }) { actions.openFile(file) }
        case "copy": UIPasteboard.general.string = value
        default: break
        }
        return .handled
    }
}
