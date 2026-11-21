#!/usr/bin/env swift
// Renders App/Assets.xcassets/LaunchMark: the Ghost mark (`GhostMark` in App/MobileComponents.swift) as the launch
// screen's image, light and dark, at 2x and 3x. A launch screen runs no code, so it cannot draw the SwiftUI view;
// run this again when the mark's proportions or the canvas and ink tokens in `GhostStyle` change.
//
//   swift apps/ghost-ios/scripts/render-launch-mark.swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let points = 112.0 // GhostMark.launchSize
let looks: [(name: String, ink: UInt32, canvas: UInt32)] = [("light", 0x141518, 0xfafaf9), ("dark", 0xececee, 0x121214)]

func color(_ hex: UInt32) -> CGColor {
    CGColor(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, alpha: 1)
}

func render(ink: UInt32, canvas: UInt32, scale: Int, to url: URL) throws {
    let side = Int(points) * scale
    let size = Double(side)
    let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    // Core Graphics has y up; the mark's offsets are measured down from the middle.
    context.translateBy(x: size / 2, y: size / 2)
    context.setFillColor(color(ink))
    context.fillEllipse(in: CGRect(x: -size / 2, y: -size / 2, width: size, height: size))
    context.setFillColor(color(canvas))
    for side in [-1.0, 1.0] {
        let width = size * 0.170, height = size * 0.058
        let rect = CGRect(x: side * size * 0.167 - width / 2, y: size * 0.158 - height / 2, width: width, height: height)
        context.addPath(CGPath(roundedRect: rect, cornerWidth: height / 2, cornerHeight: height / 2, transform: nil))
        context.fillPath()
    }
    let mouth = size * 0.066
    context.fillEllipse(in: CGRect(x: -mouth / 2, y: size * 0.012 - mouth / 2, width: mouth, height: mouth))
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
}

let assets = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Assets.xcassets")
let mark = assets.appendingPathComponent("LaunchMark.imageset")
try FileManager.default.createDirectory(at: mark, withIntermediateDirectories: true)

var images: [String] = []
for look in looks {
    for scale in [2, 3] {
        let file = "LaunchMark-\(look.name)@\(scale)x.png"
        try render(ink: look.ink, canvas: look.canvas, scale: scale, to: mark.appendingPathComponent(file))
        let appearance = look.name == "dark" ? #", "appearances": [{ "appearance": "luminosity", "value": "dark" }]"# : ""
        images.append(#"    { "filename": "\#(file)", "idiom": "universal", "scale": "\#(scale)x"\#(appearance) }"#)
    }
}
try (#"{\#n  "images": [\#n"# + images.joined(separator: ",\n") + #"\#n  ],\#n  "info": { "author": "xcode", "version": 1 }\#n}\#n"#)
    .write(to: mark.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)

// The colour behind it: the app's canvas, so the launch screen and the first screen of the app are one surface.
func component(_ hex: UInt32, _ shift: UInt32) -> String { String(format: "0x%02X", (hex >> shift) & 255) }
func entry(_ hex: UInt32, dark: Bool) -> String {
    let appearance = dark ? #", "appearances": [{ "appearance": "luminosity", "value": "dark" }]"# : ""
    return #"    { "color": { "color-space": "srgb", "components": { "red": "\#(component(hex, 16))", "green": "\#(component(hex, 8))", "blue": "\#(component(hex, 0))", "alpha": "1.000" } }, "idiom": "universal"\#(appearance) }"#
}
let background = assets.appendingPathComponent("LaunchBackground.colorset")
try FileManager.default.createDirectory(at: background, withIntermediateDirectories: true)
try (#"{\#n  "colors": [\#n"# + [entry(looks[0].canvas, dark: false), entry(looks[1].canvas, dark: true)].joined(separator: ",\n") + #"\#n  ],\#n  "info": { "author": "xcode", "version": 1 }\#n}\#n"#)
    .write(to: background.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
print("wrote \(mark.path) and \(background.path)")
