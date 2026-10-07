import XCTest

@MainActor final class ChatUITests: XCTestCase {
    private func launch(reset: Bool = true, incoming: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"] + (reset ? ["--reset-fixture"] : [])
        if incoming { app.launchArguments.append("--ui-testing-incoming") }
        app.launch()
        let profile = app.buttons["profile-test-ghost"]
        XCTAssertTrue(profile.waitForExistence(timeout: 10))
        profile.tap()
        return app
    }
    private func select(_ title: String, in app: XCUIApplication) {
        app.buttons["conversation-menu"].tap()
        app.buttons[title].tap()
    }
    private func screenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testConversationDraftsStaySeparate() {
        let app = launch()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap(); composer.typeText("Draft for first")
        select("Second conversation", in: app)
        XCTAssertNotEqual(composer.value as? String, "Draft for first")
        composer.tap(); composer.typeText("Draft for second")
        select("First conversation", in: app)
        XCTAssertEqual(composer.value as? String, "Draft for first")
        select("Second conversation", in: app)
        XCTAssertEqual(composer.value as? String, "Draft for second")
        screenshot("Separate conversation draft", app: app)
    }
    func testDraftSurvivesAppRelaunch() {
        let app = launch()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap(); composer.typeText("Saved after relaunch")
        select("Second conversation", in: app)
        app.terminate()
        let reopened = launch(reset: false)
        XCTAssertEqual(reopened.descendants(matching: .any)["chat-composer"].value as? String, "Saved after relaunch")
        screenshot("Restored draft", app: reopened)
    }
    func testHistoryStartsAtLatestAndAllowsReadingEarlierMessages() {
        let app = launch()
        let latest = app.staticTexts["Latest message"]
        let visible = NSPredicate(format: "isHittable == true")
        expectation(for: visible, evaluatedWith: latest)
        waitForExpectations(timeout: 5)
        let history = app.scrollViews["chat-history"]
        history.swipeDown()
        let jump = app.buttons["latest-messages"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        XCTAssertFalse(latest.isHittable)
        screenshot("Reading earlier messages", app: app)
        jump.tap()
        expectation(for: visible, evaluatedWith: latest)
        waitForExpectations(timeout: 5)
        screenshot("Latest messages", app: app)
    }
    func testIncomingMessagePreservesReadingPosition() {
        let app = launch(incoming: true)
        let history = app.scrollViews["chat-history"]
        history.swipeDown()
        let jump = app.buttons["latest-messages"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        let earlier = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Message '")).allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(earlier)
        expectation(for: NSPredicate(format: "label CONTAINS '새 메시지'"), evaluatedWith: jump)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(earlier?.isHittable == true)
        XCTAssertFalse(app.staticTexts["Incoming message"].isHittable)
        screenshot("Incoming message while reading", app: app)
        jump.tap()
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: app.staticTexts["Incoming message"])
        waitForExpectations(timeout: 5)
    }
}
