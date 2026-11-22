import SwiftUI

// The few native surfaces left in the shell (first load, unreachable host, pairing) share these.

/// The face from the app icon: a disc with two bar eyes and a small mouth, so the first thing on screen is the
/// icon that was tapped. `size` is the disc's diameter; the blue glow behind it overflows that square without
/// taking layout space. The drawing is `GhostMarkArt`, the same code that renders the launch screen image.
struct GhostMark: View {
    /// The mark's size on the launch screen and the first-load view; `LaunchMark` in the asset catalog is drawn at it.
    static let launchSize: CGFloat = 112
    var size: CGFloat = 36
    /// 0 is the icon's slit eyes, 1 awake.
    var open: CGFloat = 1
    var glow = true
    var body: some View {
        GhostMarkLayers(size: size, pose: GhostMarkPose(open: open, glow: glow ? 1 : 0))
    }
}

/// The mark alive: the glow breathes, the eyes blink and, with `arc`, the icon's working arc travels round every 1.6 s.
/// With `wakes` the first frame is the launch image (slit eyes, arc at rest), then the eyes open with a small settle.
/// Reduce Motion keeps everything in place and lets the arc and glow pulse in opacity instead.
struct GhostAwake: View {
    let size: CGFloat
    var wakes = false
    var arc = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date.now

    var body: some View {
        TimelineView(.animation(minimumInterval: arc ? nil : 1.0 / 30)) { timeline in
            let t = elapsed(timeline.date)
            GhostMarkLayers(size: size, pose: reduceMotion ? .still(t, wakes: wakes, arc: arc) : .moving(t, wakes: wakes, arc: arc))
        }
    }

    private func elapsed(_ date: Date) -> TimeInterval {
        #if DEBUG
        if let frozen = MobileUIFixture.markAt { return frozen }
        #endif
        return max(date.timeIntervalSince(start), 0)
    }
}

/// One moment of the mark. Every motion starts from the launch image's values, so time zero is that picture.
struct GhostMarkPose {
    var open: CGFloat = 1
    var glow: Double = 1
    var glowScale: CGFloat = 1
    var discScale: CGFloat = 1
    /// Degrees travelled from the icon's place; nil hides the arc.
    var arc: Double?
    var arcOpacity: Double = 1

    private static let wakeDelay = 0.15
    private static let breath = 3.6
    private static let turn = 1.6

    static func moving(_ t: TimeInterval, wakes: Bool, arc: Bool) -> GhostMarkPose {
        let woke = max(t - (wakes ? wakeDelay : 0), 0)
        let breathing = (1 - cos(2 * .pi * t / breath)) / 2
        // The eyes spring open (slightly past, then back), and the disc and glow lift a little as they do.
        let open = wakes ? spring(woke) : 1
        let lift = wakes ? pulse(woke / 0.22) : 0
        return GhostMarkPose(
            open: open * blink(t, after: wakes ? 2.4 : 1.6),
            glow: 1 - 0.22 * breathing,
            glowScale: 1 + 0.07 * (wakes ? pulse(woke / 0.32) : 0) + 0.05 * breathing,
            discScale: 1 + 0.04 * lift + 0.012 * breathing,
            // Gathers speed from rest instead of jumping to a full turn rate.
            arc: arc ? 360 / turn * (woke - 0.4 * (1 - exp(-woke / 0.4))) : nil)
    }

    static func still(_ t: TimeInterval, wakes: Bool, arc: Bool) -> GhostMarkPose {
        let rise = min(max((t - wakeDelay) / 0.35, 0), 1)
        return GhostMarkPose(
            open: wakes ? rise * rise * (3 - 2 * rise) : 1,
            glow: 1 - 0.3 * (1 - cos(2 * .pi * t / 2.4)) / 2,
            arc: arc ? 0 : nil,
            arcOpacity: 1 - 0.6 * (1 - cos(2 * .pi * t / turn)) / 2)
    }

    /// A damped spring from 0 to 1 that overshoots by about 12 %.
    private static func spring(_ t: Double) -> CGFloat {
        let omega = 16.0, zeta = 0.55
        let damped = omega * (1 - zeta * zeta).squareRoot()
        return 1 - exp(-zeta * omega * t) * (cos(damped * t) + zeta * omega / damped * sin(damped * t))
    }

    /// Rises from 0 to 1 at `x` = 1 and eases back to 0.
    private static func pulse(_ x: Double) -> Double { x * exp(1 - x) }

    /// Closes the eyes to slits for a fifth of a second every 4.8 s.
    private static func blink(_ t: Double, after: Double) -> CGFloat {
        guard t > after else { return 1 }
        let phase = (t - after).truncatingRemainder(dividingBy: 4.8)
        return phase < 0.2 ? 1 - sin(.pi * phase / 0.2) : 1
    }
}

/// The mark's layers in one `GhostMarkArt.side * size` square centred on the disc. Glow, arc and disc are images
/// rendered once by `GhostMarkArt`; the face is the same path drawn live so the eyes can open.
struct GhostMarkLayers: View {
    let size: CGFloat
    let pose: GhostMarkPose
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale

    var body: some View {
        let look = scheme == .dark ? GhostMarkArt.Look.dark : .light
        ZStack {
            layer(.glow, look).scaleEffect(pose.glowScale).opacity(pose.glow)
            if let arc = pose.arc {
                layer(.arc, look).rotationEffect(.degrees(arc)).opacity(pose.arcOpacity)
            }
            ZStack {
                layer(.disc, look)
                GhostFace(size: size, open: pose.open).fill(Color(cgColor: GhostMarkArt.color(look.eye)))
            }
            .scaleEffect(pose.discScale)
        }
        .frame(width: size * GhostMarkArt.side, height: size * GhostMarkArt.side)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func layer(_ layer: GhostMarkArt.Layer, _ look: GhostMarkArt.Look) -> some View {
        Image(decorative: GhostMarkCache.image(layer, size: size, dark: scheme == .dark, look: look, scale: scale), scale: scale)
    }
}

private struct GhostFace: Shape {
    let size: CGFloat
    let open: CGFloat
    func path(in rect: CGRect) -> Path {
        Path(GhostMarkArt.facePath(d: size, open: open)).offsetBy(dx: rect.midX, dy: rect.midY)
    }
}

@MainActor private enum GhostMarkCache {
    struct Key: Hashable { let layer: GhostMarkArt.Layer, size: CGFloat, dark: Bool, scale: CGFloat }
    static var images: [Key: CGImage] = [:]

    static func image(_ layer: GhostMarkArt.Layer, size: CGFloat, dark: Bool, look: GhostMarkArt.Look, scale: CGFloat) -> CGImage {
        let key = Key(layer: layer, size: size, dark: dark, scale: scale)
        if let image = images[key] { return image }
        let image = GhostMarkArt.image([layer], d: size, look: look, scale: scale)!
        images[key] = image
        return image
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
