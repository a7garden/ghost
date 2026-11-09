import XCTest

@MainActor final class PairingUITests: XCTestCase {
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testPairingScreens() {
        for dark in [false, true] {
            let theme = dark ? "dark" : "light"
            let app = XCUIApplication()
            app.launchArguments = ["--ui-testing", "--pairing"] + (dark ? ["--dark"] : [])
            app.launch()
            XCTAssertTrue(app.buttons["pairing-scan-qr"].waitForExistence(timeout: 8))
            XCTAssertTrue(app.staticTexts["내 Ghost와 연결"].exists)
            capture("ios-pairing-\(theme)", app: app)
            app.buttons["pairing-type-code"].tap()
            let origin = app.textFields["pairing-origin-field"]
            XCTAssertTrue(origin.waitForExistence(timeout: 5))
            origin.tap()
            origin.typeText("http://127.0.0.1:62062")
            app.textFields["pairing-code-field"].tap()
            app.textFields["pairing-code-field"].typeText("ab cd2345")
            XCTAssertEqual(app.textFields["pairing-code-field"].value as? String, "ABCD2345")
            XCTAssertTrue(app.buttons["pairing-code-submit"].isEnabled)
            capture("ios-pairing-code-\(theme)", app: app)
            app.terminate()

            app.launchArguments = ["--ui-testing", "--pairing", "--pairing-issue"] + (dark ? ["--dark"] : [])
            app.launch()
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '만료'")).firstMatch.waitForExistence(timeout: 8))
            capture("ios-pairing-issue-\(theme)", app: app)
            app.terminate()
        }
    }

    /// A paired Host that does not answer: the shell says so and offers a retry, never a blank web view.
    func testUnreachableHost() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--shell-origin", "http://127.0.0.1:9", "--shell-device", "device-1", "--shell-token", String(repeating: "a", count: 32)]
        app.launch()
        XCTAssertTrue(app.otherElements["shell-unreachable"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["shell-retry"].exists)
        capture("ios-shell-unreachable", app: app)
    }
}
