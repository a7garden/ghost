import XCTest

@MainActor final class MobileRedesignUITests: XCTestCase {
    private func launch(empty: Bool = false, extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-fixture"]
            + (empty ? ["--empty-conversation"] : [])
            + extraArguments
        app.launch()
        let conversation = app.buttons["conversation-fixture-conversation"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        return app
    }
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name
        add(attachment)
    }

    func testConversationWorkNotificationsAndSettings() {
        let app = launch()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["짧게 읽을 수 있는 에세이 위주로 보고 싶어."].waitForExistence(timeout: 8))
        capture("Conversation first — iPhone14", app: app)

        app.tabBars.buttons["맡긴 일"].tap()
        XCTAssertTrue(app.staticTexts["주말에 읽을 책 목록 정리하기"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["진행 중"].exists)
        capture("Work index", app: app)

        app.buttons["work-fixture-work"].tap()
        XCTAssertTrue(app.staticTexts["요청 내용"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["work-edit"].exists)
        XCTAssertTrue(app.buttons["work-cancel"].exists)
        capture("Work detail", app: app)

        app.tabBars.buttons["소식"].tap()
        XCTAssertTrue(app.staticTexts["확인할 결정 없음"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["새 소식이 오면 알려드릴게요"].exists)
        capture("Notifications", app: app)

        app.tabBars.buttons["연결"].tap()
        XCTAssertTrue(app.staticTexts["내 Ghost"].waitForExistence(timeout: 5))
        capture("My Ghost", app: app)

        app.tabBars.buttons["대화"].tap()
        XCTAssertEqual(app.descendants(matching: .any)["chat-composer"].value as? String, "")
    }

    func testEmptyConversation() {
        let app = launch(empty: true)
        let conversation = app.buttons["conversation-fixture-conversation"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 8))
        conversation.tap()
        XCTAssertTrue(app.staticTexts["무슨 일을\n함께할까요?"].waitForExistence(timeout: 8))
        capture("Empty conversation", app: app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].exists)
    }

    func testResponsiveNativeLayouts() {
        let app = XCUIApplication()
        for width in [320, 375, 414, 768] {
            app.launchArguments = ["--ui-testing", "--reset-fixture", "--review-width=\(width)"]
            app.launch()
            let conversation = app.buttons["conversation-fixture-conversation"]
            XCTAssertTrue(conversation.waitForExistence(timeout: 8))
            conversation.tap()
            let history = app.scrollViews["chat-history"]
            XCTAssertTrue(history.waitForExistence(timeout: 8))
            XCTAssertTrue(app.staticTexts["짧게 읽을 수 있는 에세이 위주로 보고 싶어."].waitForExistence(timeout: 8))
            XCTAssertLessThanOrEqual(history.frame.width, Double(width) + 2)
            capture("Native transcript width \(width)", app: app)
            app.terminate()
        }
    }

    func testCompactAccessibilityType() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-fixture", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(app.buttons["conversation-fixture-conversation"].waitForExistence(timeout: 8))
        app.buttons["conversation-fixture-conversation"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["메시지 보내기"].exists)
        capture("Compact phone — largest accessibility type", app: app)
        app.tabBars.buttons["맡긴 일"].tap()
        XCTAssertTrue(app.staticTexts["주말에 읽을 책 목록 정리하기"].waitForExistence(timeout: 5))
        capture("Compact work — largest accessibility type", app: app)
    }
}
