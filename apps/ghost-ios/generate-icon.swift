// Reproducible original vector icon. Matches GhostSilhouette in MobileComponents.
import AppKit
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
                        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.952, green: 0.945, blue: 0.930, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: 272 + x * 480, y: 785 - y * 548) }
let p = CGMutablePath()
p.move(to: point(0.05, 0.94)); p.addLine(to: point(0.05, 0.43))
p.addCurve(to: point(0.5, 0.02), control1: point(0.05, 0.18), control2: point(0.23, 0.02))
p.addCurve(to: point(0.95, 0.43), control1: point(0.77, 0.02), control2: point(0.95, 0.18))
p.addLine(to: point(0.95, 0.94))
p.addQuadCurve(to: point(0.73,0.84), control: point(0.85,1.02))
p.addQuadCurve(to: point(0.5,0.96), control: point(0.62,1.02))
p.addQuadCurve(to: point(0.27,0.84), control: point(0.38,1.02))
p.addQuadCurve(to: point(0.05,0.94), control: point(0.15,1.02)); p.closeSubpath()
for x: CGFloat in [0.30, 0.59] {
    let top = point(x, 0.36)
    p.addRoundedRect(in: CGRect(x: top.x, y: top.y - 0.18*548, width: 0.11*480, height: 0.18*548), cornerWidth: 0.055*480, cornerHeight: 0.055*480)
}
context.setFillColor(CGColor(red: 0.17, green: 0.18, blue: 0.17, alpha: 1))
context.addPath(p); context.drawPath(using: .eoFill)
let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
