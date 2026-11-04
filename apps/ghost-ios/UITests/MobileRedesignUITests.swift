import XCTest

@MainActor final class MobileRedesignUITests: XCTestCase {
    private func launch(empty: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture"] + (empty ? ["--empty-conversation"] : [])
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["허용 안 함"].waitForExistence(timeout: 2) { springboard.buttons["허용 안 함"].tap() }
        return app
    }
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name
        attachment.lifetime = .keepAlways; add(attachment)
    }
    func testConversationWorkNotificationsAndDraft() {
        let app = launch()
        let composer = app.textFields["lifetime-chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["모델 설정 확인 중"].exists)
        XCTAssertTrue(app.staticTexts["짧게 읽을 수 있는 에세이 위주로 보고 싶어."].waitForExistence(timeout: 8))
        capture("Conversation first — iPhone14", app: app)
        app.tabBars.buttons["맡긴 일"].tap()
        XCTAssertTrue(app.staticTexts["주말에 읽을 책 목록 정리하기"].waitForExistence(timeout: 5))
        capture("Work index", app: app)
        app.tabBars.buttons["알림"].tap()
        XCTAssertTrue(app.staticTexts["새 소식이 오면 알려드릴게요"].waitForExistence(timeout: 5))
        capture("Notifications", app: app)
        app.tabBars.buttons["대화"].tap()
        composer.tap(); composer.typeText("Draft preserved")
        capture("Conversation keyboard", app: app)
        XCTAssertEqual(composer.value as? String, "Draft preserved")
        app.buttons["내 Ghost와 연결 설정"].tap()
        XCTAssertTrue(app.buttons["닫기"].waitForExistence(timeout: 3))
        capture("My Ghost", app: app)
        app.buttons["닫기"].tap()
        XCTAssertEqual(composer.value as? String, "Draft preserved")
    }
    func testEmptyConversationAndVoiceAvailability() {
        let app = launch(empty: true)
        XCTAssertTrue(app.staticTexts["무슨 일을\n함께할까요?"].waitForExistence(timeout: 8))
        capture("Empty conversation", app: app)
        app.buttons["Ghost와 통화"].tap()
        XCTAssertTrue(app.staticTexts["통화 연결을 준비하고 있어요"].waitForExistence(timeout: 4))
        capture("Voice unavailable — truthful state", app: app)
        app.buttons["닫기"].tap()
        app.buttons["대화 옵션"].tap()
        XCTAssertTrue(app.navigationBars["대화 옵션"].waitForExistence(timeout: 4))
        capture("Conversation options", app: app)
        app.buttons["완료"].tap()
        XCTAssertTrue(app.textFields["lifetime-chat-composer"].exists)
    }
    func testResponsiveNativeLayouts() {
        let app = XCUIApplication()
        for width in [320, 375, 414, 768] {
            app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "--review-width=\(width)"]
            app.launch()
            let history = app.scrollViews["lifetime-chat-history"]
            XCTAssertTrue(history.waitForExistence(timeout: 8))
            XCTAssertTrue(app.staticTexts["짧게 읽을 수 있는 에세이 위주로 보고 싶어."].waitForExistence(timeout: 8))
            XCTAssertLessThanOrEqual(history.frame.width, Double(width) + 2)
            capture("Native transcript width \(width)", app: app)
            app.terminate()
            app.launchArguments.append("--empty-conversation")
            app.launch()
            XCTAssertTrue(app.staticTexts["무슨 일을\n함께할까요?"].waitForExistence(timeout: 8))
            capture("Native empty width \(width)", app: app)
            app.terminate()
        }
    }
    func testCompactAccessibilityType() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let composer = app.descendants(matching: .any)["lifetime-chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["메시지 보내기"].exists)
        capture("Compact phone — largest accessibility type", app: app)
        app.tabBars.buttons["맡긴 일"].tap()
        XCTAssertTrue(app.staticTexts["주말에 읽을 책 목록 정리하기"].waitForExistence(timeout: 5))
        capture("Compact work — largest accessibility type", app: app)
    }

    func testLifetimeReceivesMessagesWithoutMovingEarlierReading() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "--lifetime-incoming"]
        app.launch()
        let history = app.scrollViews["lifetime-chat-history"]
        XCTAssertTrue(app.staticTexts["Latest lifetime message"].waitForExistence(timeout: 8))
        history.swipeDown()
        let jump = app.buttons["lifetime-latest-messages"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "label CONTAINS '새 메시지'"), evaluatedWith: jump)
        waitForExpectations(timeout: 25)
        XCTAssertFalse(app.staticTexts["Incoming lifetime message"].isHittable)
        capture("Lifetime incoming while reading", app: app)
        jump.tap()
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: app.staticTexts["Incoming lifetime message"])
        waitForExpectations(timeout: 5)
        capture("Lifetime new message", app: app)
    }

}
