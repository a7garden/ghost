// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GhostMobileCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "GhostMobileCore", targets: ["GhostMobileCore"])],
    targets: [
        .target(name: "GhostMobileCore"),
        .testTarget(name: "GhostMobileCoreTests", dependencies: ["GhostMobileCore"])
    ]
)
