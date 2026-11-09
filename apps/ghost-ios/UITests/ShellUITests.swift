import XCTest

/// The shell against an isolated test Host with a paired device. Opt-in: needs
/// `TEST_RUNNER_GHOST_SHELL_ORIGIN`, `..._DEVICE` and `..._TOKEN` in the runner environment.
@MainActor final class ShellUITests: XCTestCase {
    private func launch(route: String? = nil, dark: Bool = false) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        guard let origin = environment["GHOST_SHELL_ORIGIN"], let device = environment["GHOST_SHELL_DEVICE"], let token = environment["GHOST_SHELL_TOKEN"] else {
            throw XCTSkip("Set TEST_RUNNER_GHOST_SHELL_ORIGIN/DEVICE/TOKEN to a paired test Host.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--shell-origin", origin, "--shell-device", device, "--shell-token", token]
            + (route.map { ["--shell-route", $0] } ?? []) + (dark ? ["--dark"] : [])
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
        XCTAssertFalse(app.otherElements["shell-unreachable"].exists)
        return app
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func settle(_ app: XCUIApplication, text: String) {
        let match = app.webViews.firstMatch.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 20), "missing \(text)")
    }

    /// The page opens with the device token (no owner token on a non-loopback request path),
    /// and each top-level destination renders on the phone.
    func testDestinations() throws {
        let screens: [(String, String, String)] = [
            ("home", "/", "홈"),
            ("inbox", "/inbox", "받은 일"),
            ("work", "/work", "맡긴 일"),
            ("settings", "/settings", "설정"),
            ("devices", "/settings?tab=devices", "이 기기"),
        ]
        for dark in [false, true] {
            for (name, route, text) in screens {
                let app = try launch(route: route, dark: dark)
                settle(app, text: text)
                capture("shell-\(name)-\(dark ? "dark" : "light")", app: app)
                app.terminate()
            }
        }
    }

    /// A conversation with rich answers, then the composer with the keyboard up.
    func testConversation() throws {
        guard let route = ProcessInfo.processInfo.environment["GHOST_SHELL_CONVERSATION"] else {
            throw XCTSkip("Set TEST_RUNNER_GHOST_SHELL_CONVERSATION to a conversation route.")
        }
        let app = try launch(route: route)
        settle(app, text: "메시지")
        capture("shell-conversation", app: app)
        let editable = NSPredicate(format: "elementType == %d OR elementType == %d",
                                   XCUIElement.ElementType.textView.rawValue, XCUIElement.ElementType.textField.rawValue)
        let composer = app.webViews.firstMatch.descendants(matching: .any).matching(editable).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        composer.typeText("모바일에서 보내는 메시지")
        capture("shell-conversation-keyboard", app: app)
        // The system accessory bar's Done closes the keyboard.
        let done = app.toolbars.buttons["완료"].exists ? app.toolbars.buttons["완료"] : app.buttons["Done"]
        if done.exists { done.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    }
}
