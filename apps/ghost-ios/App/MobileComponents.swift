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

/// The mark alive: the wait is the face's own behaviour, not a widget. It breathes (the glow swells and the disc floats a
/// little above it), blinks now and then and looks around: `.searching` glances from side to side as if looking for the
/// PC, `.idle` mostly looks at the owner and glances away rarely. With `wakes` the first frame is the launch image (slit
/// eyes) and the eyes spring open after 0.15 s. When `ready` turns true the face recognises: the eyes come to the centre
/// and widen and the mouth smiles, over `recognition`. Reduce Motion moves nothing: the eyes open in place and the glow
/// and the face breathe in brightness.
struct GhostAwake: View {
    /// How long recognising takes once `ready`, before the caller lets the page in.
    static let recognition: TimeInterval = 0.3

    let size: CGFloat
    var wakes = false
    var mood = GhostMarkPose.Mood.searching
    var ready = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date.now
    @State private var readyAt: Date?

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = elapsed(timeline.date)
            let greeting = recognised(timeline.date, t)
            GhostMarkLayers(size: size, pose: reduceMotion
                ? .still(t, wakes: wakes, greeting: greeting)
                : .moving(t, wakes: wakes, mood: mood, greeting: greeting))
        }
        .onChange(of: ready, initial: true) { readyAt = ready ? .now : nil }
    }

    private func elapsed(_ date: Date) -> TimeInterval {
        #if DEBUG
        if let frozen = MobileUIFixture.markAt { return frozen }
        #endif
        return max(date.timeIntervalSince(start), 0)
    }

    /// Seconds since `ready` turned true, or nil before it.
    private func recognised(_ date: Date, _ t: TimeInterval) -> TimeInterval? {
        #if DEBUG
        if let at = MobileUIFixture.markReadyAt { return t >= at ? t - at : nil }
        #endif
        return readyAt.map { max(date.timeIntervalSince($0), 0) }
    }
}

/// One moment of the mark. Every motion starts from the launch image's values, so time zero is that picture.
struct GhostMarkPose {
    enum Mood { case searching, idle }

    var open: CGFloat = 1
    /// Where the face looks, -1...1 each way (`GhostMarkArt.eyes`).
    var gaze: CGPoint = .zero
    var smile: CGFloat = 0
    var face: Double = 1
    var glow: Double = 1
    var glowScale: CGFloat = 1
    var discScale: CGFloat = 1
    /// Vertical offset of the disc and face over the glow, in diameters (negative is up).
    var float: CGFloat = 0

    private static let wakeDelay = 0.15
    private static let breath = 4.2

    /// Where the face looks and for how long, in order; the last glance returns to the first, so the loop has no seam.
    /// Uneven holds and targets keep a long wait from reading as a cycle.
    private static let glances: [Mood: (move: Double, steps: [(x: Double, y: Double, hold: Double)])] = [
        .searching: (0.34, [(0, 0, 0.9), (-0.85, 0.05, 1.1), (0.75, -0.12, 1.3), (0.15, 0.22, 0.8),
                            (-0.5, -0.2, 1.2), (0.9, 0.08, 1.0), (0, 0, 1.4)]),
        .idle: (0.42, [(0, 0, 3.4), (-0.6, 0.1, 1.3), (0, 0, 3.8), (0.55, -0.1, 1.1)]),
    ]
    /// Seconds between blinks, repeating.
    private static let blinks = [3.4, 4.6, 2.6, 5.2, 3.9]

    static func moving(_ t: TimeInterval, wakes: Bool, mood: Mood, greeting: TimeInterval?) -> GhostMarkPose {
        let woke = max(t - (wakes ? wakeDelay : 0), 0)
        let breathing = (1 - cos(2 * .pi * t / breath)) / 2
        // The eyes spring open (slightly past, then back), and the disc and glow lift a little as they do.
        var pose = GhostMarkPose(
            open: (wakes ? spring(woke) : 1) * blink(t - (wakes ? 1.9 : 1.2)),
            gaze: look(woke, mood: mood),
            glow: 1 - 0.2 * breathing,
            glowScale: 1 + 0.07 * (wakes ? pulse(woke / 0.32) : 0) + 0.045 * breathing,
            discScale: 1 + 0.035 * (wakes ? pulse(woke / 0.22) : 0),
            float: -0.014 * breathing)
        if let greeting {
            // Recognition: the gaze comes home, the eyes widen past awake, the mouth smiles and the glow comes up.
            let settle = smootherstep(greeting / 0.18)
            pose.gaze = CGPoint(x: pose.gaze.x * (1 - settle), y: pose.gaze.y * (1 - settle))
            pose.open += (1 + 0.22 * spring(greeting) - pose.open) * settle
            pose.smile = smootherstep(greeting / 0.22)
            pose.glow += (1 - pose.glow) * settle
            pose.glowScale += 0.06 * smootherstep(greeting / 0.25)
        }
        return pose
    }

    static func still(_ t: TimeInterval, wakes: Bool, greeting: TimeInterval?) -> GhostMarkPose {
        let breathing = (1 - cos(2 * .pi * t / breath)) / 2
        var pose = GhostMarkPose(
            open: wakes ? smootherstep((t - wakeDelay) / 0.35) : 1,
            face: 1 - 0.2 * breathing,
            glow: 1 - 0.32 * breathing)
        if let greeting {
            let settle = smootherstep(greeting / 0.2)
            pose.smile = settle
            pose.face += (1 - pose.face) * settle
            pose.glow += (1 - pose.glow) * settle
        }
        return pose
    }

    /// The glance sequence eased between targets, with a slow drift so a hold is never dead still.
    private static func look(_ t: Double, mood: Mood) -> CGPoint {
        let (move, steps) = glances[mood]!
        let cycle = steps.reduce(0) { $0 + $1.hold + move }
        var time = t.truncatingRemainder(dividingBy: cycle)
        var x = 0.0, y = 0.0
        for (index, step) in steps.enumerated() {
            let next = steps[(index + 1) % steps.count]
            if time < step.hold { x = step.x; y = step.y; break }
            time -= step.hold
            if time < move {
                let k = smootherstep(time / move)
                x = step.x + (next.x - step.x) * k
                y = step.y + (next.y - step.y) * k
                break
            }
            time -= move
        }
        return CGPoint(x: x + 0.05 * sin(1.1 * t), y: y + 0.04 * sin(0.83 * t))
    }

    /// Closes the eyes to slits for 0.17 s at each of the uneven `blinks` intervals, from `t` = 0.
    private static func blink(_ t: Double) -> CGFloat {
        guard t > 0 else { return 1 }
        var time = t.truncatingRemainder(dividingBy: blinks.reduce(0, +))
        for interval in blinks {
            if time < 0.17 { return 1 - sin(.pi * time / 0.17) }
            if time < interval { return 1 }
            time -= interval
        }
        return 1
    }

    /// A damped spring from 0 to 1 that overshoots by about 12 %.
    private static func spring(_ t: Double) -> CGFloat {
        let omega = 16.0, zeta = 0.55
        let damped = omega * (1 - zeta * zeta).squareRoot()
        return 1 - exp(-zeta * omega * t) * (cos(damped * t) + zeta * omega / damped * sin(damped * t))
    }

    /// Rises from 0 to 1 at `x` = 1 and eases back to 0.
    private static func pulse(_ x: Double) -> Double { x * exp(1 - x) }

    private static func smootherstep(_ x: Double) -> Double {
        let x = min(max(x, 0), 1)
        return x * x * x * (x * (x * 6 - 15) + 10)
    }
}

/// The mark's layers in one `GhostMarkArt.side * size` square centred on the disc. Glow and disc are images rendered
/// once by `GhostMarkArt`; the face is the same path drawn live so it can wake, look and smile.
struct GhostMarkLayers: View {
    let size: CGFloat
    let pose: GhostMarkPose
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale

    var body: some View {
        let look = scheme == .dark ? GhostMarkArt.Look.dark : .light
        ZStack {
            layer(.glow, look).scaleEffect(pose.glowScale).opacity(pose.glow)
            ZStack {
                layer(.disc, look)
                GhostFace(size: size, open: pose.open, gaze: pose.gaze, smile: pose.smile)
                    .fill(Color(cgColor: GhostMarkArt.color(look.eye)))
                    .opacity(pose.face)
            }
            .scaleEffect(pose.discScale)
            .offset(y: pose.float * size)
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
    let gaze: CGPoint
    let smile: CGFloat
    func path(in rect: CGRect) -> Path {
        Path(GhostMarkArt.facePath(d: size, open: open, gaze: gaze, smile: smile)).offsetBy(dx: rect.midX, dy: rect.midY)
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
