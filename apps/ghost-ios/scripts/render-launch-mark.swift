// Renders App/Assets.xcassets/LaunchMark: the Ghost mark as the launch screen's image, light and dark, at 2x and 3x,
// with the slit eyes the first-load view (`GhostAwake` in App/MobileComponents.swift) wakes from. A launch screen runs
// no code, so it is drawn here by the same `GhostMarkArt` the app draws with; run this again whenever
// App/GhostMarkArt.swift or `GhostMark.launchSize` changes.
//
//   cd apps/ghost-ios
//   xcrun swiftc -parse-as-library App/GhostMarkArt.swift scripts/render-launch-mark.swift -o /tmp/render-launch-mark
//   /tmp/render-launch-mark

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

@main enum RenderLaunchMark {
    static let size: CGFloat = 112 // GhostMark.launchSize
    static let looks: [(name: String, look: GhostMarkArt.Look)] = [("light", .light), ("dark", .dark)]

    static func main() throws {
        let assets = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Assets.xcassets")
        let mark = assets.appendingPathComponent("LaunchMark.imageset")
        try FileManager.default.createDirectory(at: mark, withIntermediateDirectories: true)

        var images: [String] = []
        for (name, look) in looks {
            for scale in [2, 3] {
                let file = "LaunchMark-\(name)@\(scale)x.png"
                guard let image = GhostMarkArt.image(GhostMarkArt.Layer.allCases, face: 0, d: size, look: look, scale: CGFloat(scale)) else {
                    throw CocoaError(.fileWriteUnknown)
                }
                try write(image, to: mark.appendingPathComponent(file))
                images.append(#"    { "filename": "\#(file)", "idiom": "universal", "scale": "\#(scale)x"\#(appearance(name == "dark")) }"#)
            }
        }
        try (#"{\#n  "images": [\#n"# + images.joined(separator: ",\n") + #"\#n  ],\#n  "info": { "author": "xcode", "version": 1 }\#n}\#n"#)
            .write(to: mark.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)

        // The colour behind it: the app's canvas, so the launch screen and the first screen of the app are one surface.
        let background = assets.appendingPathComponent("LaunchBackground.colorset")
        try FileManager.default.createDirectory(at: background, withIntermediateDirectories: true)
        let colors = looks.map { entry($0.look.canvas, dark: $0.name == "dark") }
        try (#"{\#n  "colors": [\#n"# + colors.joined(separator: ",\n") + #"\#n  ],\#n  "info": { "author": "xcode", "version": 1 }\#n}\#n"#)
            .write(to: background.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
        print("wrote \(mark.path) and \(background.path)")
    }

    static func write(_ image: CGImage, to url: URL) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
    }

    static func appearance(_ dark: Bool) -> String {
        dark ? #", "appearances": [{ "appearance": "luminosity", "value": "dark" }]"# : ""
    }

    static func entry(_ hex: UInt32, dark: Bool) -> String {
        func component(_ shift: UInt32) -> String { String(format: "0x%02X", (hex >> shift) & 255) }
        return #"    { "color": { "color-space": "srgb", "components": { "red": "\#(component(16))", "green": "\#(component(8))", "blue": "\#(component(0))", "alpha": "1.000" } }, "idiom": "universal"\#(appearance(dark)) }"#
    }
}
