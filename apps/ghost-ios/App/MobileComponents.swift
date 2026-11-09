import SwiftUI

// The few native surfaces left in the shell (pairing, unreachable host) share these.

struct GhostMark: View {
    var size: CGFloat = 36
    var body: some View {
        GhostSilhouette()
            .fill(GhostStyle.ink, style: FillStyle(eoFill: true))
            .frame(width: size * 0.56, height: size * 0.64)
            .frame(width: size, height: size)
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: size * 0.34))
            .accessibilityHidden(true)
    }
}

// A small, original vector mark, shared with the generated app icon.
struct GhostSilhouette: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height) }
        p.move(to: point(0.05, 0.94))
        p.addLine(to: point(0.05, 0.43))
        p.addCurve(to: point(0.5, 0.02), control1: point(0.05, 0.18), control2: point(0.23, 0.02))
        p.addCurve(to: point(0.95, 0.43), control1: point(0.77, 0.02), control2: point(0.95, 0.18))
        p.addLine(to: point(0.95, 0.94))
        p.addQuadCurve(to: point(0.73, 0.84), control: point(0.85, 1.02))
        p.addQuadCurve(to: point(0.5, 0.96), control: point(0.62, 1.02))
        p.addQuadCurve(to: point(0.27, 0.84), control: point(0.38, 1.02))
        p.addQuadCurve(to: point(0.05, 0.94), control: point(0.15, 1.02))
        p.closeSubpath()
        for x: CGFloat in [0.30, 0.59] {
            p.addRoundedRect(in: CGRect(x: rect.minX + x * rect.width, y: rect.minY + 0.36 * rect.height, width: 0.11 * rect.width, height: 0.18 * rect.height), cornerSize: CGSize(width: rect.width * 0.055, height: rect.width * 0.055))
        }
        return p
    }
}

struct TravellingArc: View {
    var color = GhostStyle.signal
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
            Circle().trim(from: 0.05, to: 0.75)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(reduceMotion ? -90 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4 * 360))
        }.accessibilityHidden(true)
    }
}

/// Wraps its children onto as many lines as the width needs.
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

/// Explicit label/fill tokens keep primary actions legible in both appearances.
struct GhostPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(isEnabled ? GhostStyle.onInk : GhostStyle.secondary)
            .padding(.horizontal, 16).padding(.vertical, 10).frame(minHeight: 44)
            .background(isEnabled ? GhostStyle.ink : GhostStyle.ink.opacity(0.12), in: Capsule())
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

/// The quieter partner of the primary action: hairline capsule, ink label.
struct GhostSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(isEnabled ? GhostStyle.ink : GhostStyle.secondary)
            .padding(.horizontal, 16).padding(.vertical, 10).frame(minHeight: 44)
            .background(GhostStyle.surface, in: Capsule())
            .overlay { Capsule().stroke(GhostStyle.ink.opacity(isEnabled ? 0.18 : 0.08), lineWidth: 1) }
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// A gentle press response for plain, card-like buttons.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}
