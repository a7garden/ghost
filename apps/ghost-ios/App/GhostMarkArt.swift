import CoreGraphics
import Foundation

/// The Ghost mark's drawing, shared by the app (`GhostMark`, `GhostAwake`) and `scripts/render-launch-mark.swift`, so
/// the launch image and the first frame of the app are the same pixels. Pure Core Graphics in a y-down space whose
/// origin is the disc's centre; lengths are in units of the disc's diameter `d`. Every layer fills the same square of
/// `side * d`, so layers stack by centring them.
enum GhostMarkArt {
    /// The square around the disc, in diameters: room for the glow to fade to nothing.
    static let side: CGFloat = 3

    /// One appearance. Colours are sRGB hex; `canvas`, the eye colour of the light look and `signal` match `GhostStyle`.
    struct Look: Sendable {
        var canvas: UInt32
        var discTop: UInt32
        var discBottom: UInt32
        var eye: UInt32
        var signal: UInt32
        var glow: UInt32
        /// Peak opacity of the glow behind the disc.
        var glowStrength: CGFloat
        /// Opacity of the soft light on the disc's upper left.
        var sheen: CGFloat
        /// Opacity of the hairline catching the light along the disc's top edge.
        var rim: CGFloat
        static let light = Look(canvas: 0xfafaf9, discTop: 0x2c2e36, discBottom: 0x0c0d10, eye: 0xfafaf9,
                                signal: 0x3d5cf5, glow: 0x4a68ff, glowStrength: 0.30, sheen: 0.10, rim: 0.0)
        static let dark = Look(canvas: 0x121214, discTop: 0x2e3039, discBottom: 0x16161b, eye: 0xf2f3f7,
                               signal: 0x7088ff, glow: 0x4d68ff, glowStrength: 0.46, sheen: 0.07, rim: 0.16)
    }

    /// The static layers, back to front. The face is drawn live on top (`face`) so the eyes can open.
    enum Layer: CaseIterable, Sendable { case glow, arc, disc }

    // MARK: Geometry
    /// The icon's eye bars when `open` is 0 (slits); upright, rounder eyes at 1. Values past 1 overshoot.
    static func eyes(d: CGFloat, open: CGFloat) -> [CGRect] {
        let width = d * (0.170 - 0.052 * open)
        let height = d * (0.058 + 0.090 * open)
        return [-1.0, 1.0].map { side in
            CGRect(x: side * d * 0.167 - width / 2, y: -d * 0.158 - height / 2, width: width, height: height)
        }
    }

    static func mouth(d: CGFloat) -> CGRect {
        let size = d * 0.066
        return CGRect(x: -size / 2, y: -d * 0.012 - size / 2, width: size, height: size)
    }

    /// The working arc: a ring segment outside the disc, from the upper right clockwise, as on the icon.
    static let arcStart: CGFloat = -62
    static let arcSweep: CGFloat = 95
    static func arcRadius(d: CGFloat) -> CGFloat { d * 0.595 }
    static func arcWidth(d: CGFloat) -> CGFloat { d * 0.054 }

    // MARK: Drawing

    static func draw(_ layer: Layer, in context: CGContext, d: CGFloat, look: Look) {
        context.saveGState()
        defer { context.restoreGState() }
        switch layer {
        case .glow: drawGlow(context, d: d, look: look)
        case .arc: drawArc(context, d: d, look: look)
        case .disc: drawDisc(context, d: d, look: look)
        }
    }

    /// The eyes and mouth, cut in the eye colour.
    static func drawFace(in context: CGContext, d: CGFloat, look: Look, open: CGFloat) {
        context.saveGState()
        defer { context.restoreGState() }
        context.setFillColor(color(look.eye))
        context.addPath(facePath(d: d, open: open))
        context.fillPath()
    }

    static func facePath(d: CGFloat, open: CGFloat) -> CGPath {
        let path = CGMutablePath()
        for eye in eyes(d: d, open: open) {
            let radius = min(eye.width, eye.height) / 2
            path.addRoundedRect(in: eye, cornerWidth: radius, cornerHeight: radius)
        }
        path.addEllipse(in: mouth(d: d))
        return path
    }

    /// A soft halo in the signal blue: brightest just outside the disc's edge, then a wide Gaussian falloff that is gone
    /// before the edge of the square.
    private static func drawGlow(_ context: CGContext, d: CGFloat, look: Look) {
        let reach = d * side / 2
        let steps = 48
        var colors: [CGColor] = []
        var locations: [CGFloat] = []
        for step in 0...steps {
            let t = CGFloat(step) / CGFloat(steps)
            let r = t * reach
            let rim = exp(-pow(max(r - d / 2, 0) / (d * 0.22), 2))
            let wide = exp(-pow(r / (d * 0.62), 2))
            locations.append(t)
            colors.append(color(look.glow, alpha: look.glowStrength * (0.35 * rim + 0.65 * wide)))
        }
        let gradient = CGGradient(colorsSpace: sRGB, colors: colors as CFArray, locations: locations)!
        context.drawRadialGradient(gradient, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: reach, options: [])
    }

    /// The disc: a gentle top-to-bottom gradient, a soft sheen on the upper left and, in the dark, a rim of light.
    private static func drawDisc(_ context: CGContext, d: CGFloat, look: Look) {
        let r = d / 2
        let disc = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: d, height: d), transform: nil)
        context.addPath(disc)
        context.clip()
        let body = CGGradient(colorsSpace: sRGB, colors: [color(look.discTop), color(look.discBottom)] as CFArray, locations: [0, 1])!
        context.drawLinearGradient(body, start: CGPoint(x: -r * 0.3, y: -r), end: CGPoint(x: r * 0.3, y: r), options: [])
        let sheenCenter = CGPoint(x: -d * 0.20, y: -d * 0.30)
        let sheen = CGGradient(colorsSpace: sRGB, colors: [CGColor(gray: 1, alpha: look.sheen), CGColor(gray: 1, alpha: 0)] as CFArray, locations: [0, 1])!
        context.drawRadialGradient(sheen, startCenter: sheenCenter, startRadius: 0, endCenter: sheenCenter, endRadius: d * 0.62, options: [])
        guard look.rim > 0 else { return }
        let ring = disc.copy(strokingWithWidth: d * 0.016, lineCap: .butt, lineJoin: .miter, miterLimit: 1)
        context.addPath(ring)
        context.clip()
        let rim = CGGradient(colorsSpace: sRGB, colors: [CGColor(gray: 1, alpha: look.rim), CGColor(gray: 1, alpha: 0)] as CFArray, locations: [0, 1])!
        context.drawLinearGradient(rim, start: CGPoint(x: -r * 0.3, y: -r), end: CGPoint(x: 0, y: -r * 0.2), options: [])
    }

    /// The arc, fading in along its tail so it reads as travelling clockwise.
    private static func drawArc(_ context: CGContext, d: CGFloat, look: Look) {
        let radius = arcRadius(d: d), width = arcWidth(d: d)
        let start = arcStart * .pi / 180, sweep = arcSweep * .pi / 180
        let arc = CGMutablePath()
        arc.addArc(center: .zero, radius: radius, startAngle: start, endAngle: start + sweep, clockwise: false)
        context.addPath(arc.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 1))
        context.clip()
        // An arc under 180° projects monotonically onto its chord, so a gradient along the chord fades the tail evenly.
        let tail = CGPoint(x: cos(start) * radius, y: sin(start) * radius)
        let head = CGPoint(x: cos(start + sweep) * radius, y: sin(start + sweep) * radius)
        let stops = 12
        let locations = (0...stops).map { CGFloat($0) / CGFloat(stops) }
        let colors = locations.map { x in color(look.signal, alpha: 0.28 + 0.72 * x * x * (3 - 2 * x)) }
        let ramp = CGGradient(colorsSpace: sRGB, colors: colors as CFArray, locations: locations)!
        context.drawLinearGradient(ramp, start: tail, end: head, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }

    // MARK: Raster

    /// One layer as an image of `side * d` points at `scale`, y down, centred on the disc.
    static func image(_ layers: [Layer], face open: CGFloat? = nil, d: CGFloat, look: Look, scale: CGFloat) -> CGImage? {
        let pixels = Int((d * side * scale).rounded())
        guard let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.translateBy(x: 0, y: CGFloat(pixels))
        context.scaleBy(x: scale, y: -scale)
        context.translateBy(x: d * side / 2, y: d * side / 2)
        for layer in layers { draw(layer, in: context, d: d, look: look) }
        if let open { drawFace(in: context, d: d, look: look, open: open) }
        return context.makeImage()
    }

    static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

    static func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
        CGColor(colorSpace: sRGB, components: [CGFloat((hex >> 16) & 255) / 255, CGFloat((hex >> 8) & 255) / 255, CGFloat(hex & 255) / 255, alpha])!
    }
}
