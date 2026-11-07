import Foundation

/// Shared with the built-in web portrait. Hash wrapping is JavaScript's >>> 0.
public enum GhostAppearance {
    public static let palette = ["#1f2024", "#5d6675", "#ef4b3f", "#ff8a1f", "#f2b600", "#7cc242", "#1fa463", "#14a6a6", "#2f9bff", "#3d5cf5", "#8a5cf6", "#f25ca2"]
    private static let defaultHues = ["#3d5cf5", "#8a5cf6", "#14a6a6", "#ff8a1f", "#f25ca2", "#1fa463", "#2f9bff", "#ef4b3f"]

    public static func defaultBodyColor(id: String) -> String {
        var hash: UInt32 = 0
        for unit in id.utf16 { hash = (hash &* 31) &+ UInt32(unit) }
        return defaultHues[Int(hash % 8)]
    }
}
