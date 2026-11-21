import SwiftUI

// The few native surfaces left in the shell (first load, unreachable host, pairing) share these.

/// The face from the app icon: a disc with two bar eyes and a small mouth, so the first thing on screen is the
/// icon that was tapped. `size` is the disc's diameter and the proportions are the icon's, in units of it. The
/// face is cut in the canvas colour, so it reads on light and dark; the launch screen image
/// (`Assets.xcassets/LaunchMark`) is this same drawing and must stay in step with it.
struct GhostMark: View {
    /// The mark's size on the launch screen and the first-load view; `LaunchMark` in the asset catalog is drawn at it.
    static let launchSize: CGFloat = 112
    var size: CGFloat = 36
    var body: some View {
        ZStack {
            Circle().fill(GhostStyle.ink)
            ForEach([-1.0, 1.0], id: \.self) { side in
                Capsule().fill(GhostStyle.canvas)
                    .frame(width: size * 0.170, height: size * 0.058)
                    .offset(x: side * size * 0.167, y: -size * 0.158)
            }
            Circle().fill(GhostStyle.canvas).frame(width: size * 0.066).offset(y: -size * 0.012)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The icon's blue working arc travelling once around the mark every 1.6 s, fading in where the icon draws it.
/// With Reduce Motion it stays there.
struct WorkingArc: View {
    let size: CGFloat
    var color = GhostStyle.signal
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var shown = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
            let turn = reduceMotion ? 0 : (timeline.date.timeIntervalSince(start) / 1.6).truncatingRemainder(dividingBy: 1)
            Circle().trim(from: 0, to: 95.0 / 360)
                .stroke(color, style: StrokeStyle(lineWidth: size * 0.054, lineCap: .round))
                .frame(width: size * 1.19, height: size * 1.19)
                .rotationEffect(.degrees(-62 + turn * 360))
        }
        .frame(width: size * 1.3, height: size * 1.3)
        .opacity(shown ? 1 : 0)
        .onAppear { withAnimation(.easeOut(duration: 0.3)) { shown = true } }
        .accessibilityHidden(true)
    }
}

/// The mark with its working arc, for a moment the owner waits through.
struct GhostWorking: View {
    let size: CGFloat
    var body: some View {
        ZStack {
            GhostMark(size: size)
            WorkingArc(size: size)
        }
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
