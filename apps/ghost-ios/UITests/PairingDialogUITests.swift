import XCTest

/// Deep-link pairing shows the system "'Ghost'에서 열겠습니까?" confirmation.
/// This test confirms the dialog when one is pending (no-op otherwise), so
/// the pairing flow can be verified end to end against a real host.
@MainActor final class PairingDialogUITests: XCTestCase {
    func testConfirmsPendingSystemPairingDialog() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        _ = springboard.wait(for: .runningForeground, timeout: 5)
        let predicate = NSPredicate(format: "label CONTAINS '열기'")
        let queries = [
            springboard.buttons.matching(predicate),
            springboard.alerts.buttons.matching(predicate),
            springboard.otherElements.matching(predicate),
        ]
        for query in queries {
            let element = query.firstMatch
            if element.waitForExistence(timeout: 4) {
                element.tap()
                _ = springboard.wait(for: .runningForeground, timeout: 2)
                if !queries.contains(where: { $0.firstMatch.exists }) { return }
            }
        }
        print("SpringBoard labels: \(springboard.debugDescription)")
    }
}
