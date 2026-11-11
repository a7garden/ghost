import Foundation

public enum PushEnvironment {
    /// APNs follows the signing profile, not the Debug/Release configuration.
    /// App Store and TestFlight apps have no embedded profile and use production.
    public static func fromProvisioningProfile(_ profile: Data?) -> String {
        guard let profile,
              let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex),
              let plist = try? PropertyListSerialization.propertyList(
                from: profile[start.lowerBound..<end.upperBound], options: [], format: nil),
              let values = plist as? [String: Any],
              let entitlements = values["Entitlements"] as? [String: Any],
              entitlements["aps-environment"] as? String == "development" else { return "production" }
        return "sandbox"
    }
}
