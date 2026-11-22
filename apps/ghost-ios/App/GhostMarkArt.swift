import CoreGraphics
import Foundation

/// The Ghost mark's drawing, shared by the app (`GhostMark`, `GhostAwake`) and `scripts/render-launch-mark.swift`, so
/// the launch image and the first frame of the app are the same pixels. Pure Core Graphics in a y-down space whose
/// origin is the disc's centre; lengths are in units of the disc's diameter `d`. Every layer fills the same square of
/// `side * d`, so layers stack by centring them.
enum GhostMarkArt {
    /// The square around the disc, in diameters: room for the glow to fade to nothing.
    static let side: CGFloat = 3

    /// One appearance. Colours are sRGB hex; `canvas` and the eye colour of the light look match `GhostStyle.canvas`.
    struct Look: Sendable {
        var canvas: UInt32
        var discTop: UInt32
        var discBottom: UInt32
        var eye: UInt32
        var glow: UInt32
        /// Peak opacity of the glow behind the disc.
        var glowStrength: CGFloat
        /// Opacity of the soft light on the disc's upper left.
        var sheen: CGFloat
        /// Opacity of the hairline catching the light along the disc's top edge.
        var rim: CGFloat

        static let light = Look(canvas: 0xfafaf9, discTop: 0x2c2e36, discBottom: 0x0c0d10, eye: 0xfafaf9,
                                glow: 0x4a68ff, glowStrength: 0.30, sheen: 0.10, rim: 0.0)
        static let dark = Look(canvas: 0x121214, discTop: 0x2e3039, discBottom: 0x16161b, eye: 0xf2f3f7,
                               glow: 0x4d68ff, glowStrength: 0.46, sheen: 0.07, rim: 0.16)
    }

    /// The static layers, back to front. The face is drawn live on top (`facePath`) so it can wake, look and smile.
    enum Layer: CaseIterable, Sendable { case glow, disc }

    // MARK: Geometry

    /// The icon's eye bars when `open` is 0 (slits); upright, rounder eyes at 1; values past 1 widen them. `gaze` turns
    /// the face (-1...1 each way): the eyes travel further than the mouth, and the eye on the far side narrows, as on a
    /// sphere turning under a fixed light (the sheen and rim stay put).
    static func eyes(d: CGFloat, open: CGFloat, gaze: CGPoint = .zero) -> [CGRect] {
        let height = d * (0.058 + 0.090 * open)
        return [-1.0, 1.0].map { side in
            let width = d * (0.170 - 0.052 * min(open, 1)) * (1 - 0.14 * max(0, side * gaze.x))
            let x = side * d * 0.167 + gaze.x * d * 0.055
            let y = -d * 0.158 + gaze.y * d * 0.035
            return CGRect(x: x - width / 2, y: y - height / 2, width: width, height: height)
        }
    }

    /// The mouth: the icon's dot at `smile` 0, a small upturned curve at 1.
    static func mouth(d: CGFloat, gaze: CGPoint = .zero, smile: CGFloat = 0) -> CGPath {
        let center = CGPoint(x: gaze.x * d * 0.045, y: -d * 0.012 + gaze.y * d * 0.030)
        let dot = d * 0.066
        guard smile > 0 else {
            return CGPath(ellipseIn: CGRect(x: center.x - dot / 2, y: center.y - dot / 2, width: dot, height: dot), transform: nil)
        }
        let half = d * 0.075 * smile, sag = d * 0.032 * smile
        let curve = CGMutablePath()
        curve.move(to: CGPoint(x: center.x - half, y: center.y - sag / 2))
        curve.addQuadCurve(to: CGPoint(x: center.x + half, y: center.y - sag / 2), control: CGPoint(x: center.x, y: center.y + sag * 1.5))
        return curve.copy(strokingWithWidth: dot - d * 0.016 * smile, lineCap: .round, lineJoin: .round, miterLimit: 1)
    }

    static func facePath(d: CGFloat, open: CGFloat, gaze: CGPoint = .zero, smile: CGFloat = 0) -> CGPath {
        let path = CGMutablePath()
        for eye in eyes(d: d, open: open, gaze: gaze) {
            let radius = min(eye.width, eye.height) / 2
            path.addRoundedRect(in: eye, cornerWidth: radius, cornerHeight: radius)
        }
        path.addPath(mouth(d: d, gaze: gaze, smile: smile))
        return path
    }

    // MARK: Drawing

    static func draw(_ layer: Layer, in context: CGContext, d: CGFloat, look: Look) {
        context.saveGState()
        defer { context.restoreGState() }
        switch layer {
        case .glow: drawGlow(context, d: d, look: look)
        case .disc: drawDisc(context, d: d, look: look)
        }
    }

    /// The eyes and mouth in the eye colour.
    static func drawFace(in context: CGContext, d: CGFloat, look: Look, open: CGFloat) {
        context.saveGState()
        defer { context.restoreGState() }
        context.setFillColor(color(look.eye))
        context.addPath(facePath(d: d, open: open))
        context.fillPath()
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

    // MARK: Raster

    /// Layers as one image of `side * d` points at `scale`, y down, centred on the disc; `face` adds the face at rest.
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
