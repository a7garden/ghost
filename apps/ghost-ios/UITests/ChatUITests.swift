import XCTest

@MainActor final class ChatUITests: XCTestCase {
    private func launch(reset: Bool = true, incoming: Bool = false, longConversation: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"] + (reset ? ["--reset-fixture"] : [])
        if incoming { app.launchArguments.append("--ui-testing-incoming") }
        if longConversation { app.launchArguments.append("--long-conversation") }
        app.launch()
        let conversation = app.buttons["conversation-fixture-conversation"].firstMatch
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        conversation.tap()
        return app
    }
    private func select(_ conversationID: String, in app: XCUIApplication) {
        app.tabBars.buttons["대화"].tap()
        app.buttons["conversation-\(conversationID)"].firstMatch.tap()
    }
    private func screenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; add(attachment)
    }
    func testConversationDraftsStaySeparate() {
        let app = launch()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap(); composer.typeText("Draft for first")
        select("fixture-second-conversation", in: app)
        let secondComposer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(secondComposer.waitForExistence(timeout: 5))
        XCTAssertNotEqual(secondComposer.value as? String, "Draft for first")
        secondComposer.tap(); secondComposer.typeText("Draft for second")
        select("fixture-conversation", in: app)
        XCTAssertEqual(app.descendants(matching: .any)["chat-composer"].value as? String, "Draft for first")
        select("fixture-second-conversation", in: app)
        XCTAssertEqual(app.descendants(matching: .any)["chat-composer"].value as? String, "Draft for second")
        screenshot("Separate conversation draft", app: app)
    }
    func testDraftSurvivesAppRelaunch() {
        let app = launch()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap(); composer.typeText("Saved after relaunch")
        // Backgrounding exercises the scene's durable-draft flush before termination.
        XCUIDevice.shared.press(.home)
        app.terminate()
        let reopened = launch(reset: false)
        XCTAssertEqual(reopened.descendants(matching: .any)["chat-composer"].value as? String, "Saved after relaunch")
        screenshot("Restored draft", app: reopened)
    }
    func testHistoryStartsAtLatestAndAllowsReadingEarlierMessages() {
        let app = launch(longConversation: true)
        let latest = app.staticTexts["짧게 읽을 수 있는 에세이 위주로 보고 싶어."]
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: latest)
        waitForExpectations(timeout: 5)
        let history = app.scrollViews["chat-history"]
        history.swipeDown()
        let jump = app.buttons["latest-messages"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        screenshot("Reading earlier messages", app: app)
        jump.tap()
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: latest)
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
