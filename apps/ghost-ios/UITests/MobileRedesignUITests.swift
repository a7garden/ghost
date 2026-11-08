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
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Owner bubbles read "나: …" to VoiceOver, so text is found by containment.
    private func text(_ value: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }
    /// The chat hides the tab bar; its back button returns to the roster.
    private func leaveChat(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 5))
    }
    private func positionCard(_ title: String, in app: XCUIApplication) {
        let heading = app.staticTexts[title]
        for _ in 0..<18 {
            let distance = heading.exists ? heading.frame.minY - 110 : 140
            if abs(distance) < 18 { return }
            let shift = max(-140, min(140, distance))
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -shift)),
                        withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        XCTAssertTrue(heading.isHittable)
    }

    func testConversationWorkNotificationsAndSettings() {
        let app = launch()
        app.buttons["conversation-fixture-conversation"].tap()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue(text("짧게 읽을 수 있는 에세이 위주로 보고 싶어.", in: app).waitForExistence(timeout: 8))
        capture("Conversation first — iPhone14", app: app)

        leaveChat(app)
        app.tabBars.buttons["맡긴 일"].tap()
        XCTAssertTrue(app.staticTexts["주말에 읽을 책 목록 정리하기"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["진행 중 1"].firstMatch.exists)
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
        app.buttons["conversation-fixture-conversation"].tap()
        // Native text controls expose their placeholder as value while empty on iOS 27.
        let value = app.descendants(matching: .any)["chat-composer"].value as? String
        XCTAssertTrue(value == "" || value == "Ghost에게 메시지")
    }

    func testEmptyConversation() {
        let app = launch(empty: true)
        let conversation = app.buttons["conversation-fixture-conversation"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 8))
        conversation.tap()
        XCTAssertTrue(app.staticTexts["Ghost"].waitForExistence(timeout: 8))
        // The fixture persona plans and reports, so its starters are the planner ones.
        XCTAssertTrue(app.buttons["맡긴 일 진행"].exists)
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
            XCTAssertTrue(text("짧게 읽을 수 있는 에세이 위주로 보고 싶어.", in: app).waitForExistence(timeout: 8))
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
        leaveChat(app)
        app.tabBars.buttons["맡긴 일"].tap()
        XCTAssertTrue(app.staticTexts["주말에 읽을 책 목록 정리하기"].waitForExistence(timeout: 5))
        capture("Compact work — largest accessibility type", app: app)
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

    func testShippedDesignLightAndDark() {
        for dark in [false, true] {
            let theme = dark ? "dark" : "light"
            let app = launch(extraArguments: ["--design-review"] + (dark ? ["--dark"] : []))
            capture("ios-roster-\(theme)", app: app)
            app.buttons["conversation-fixture-conversation"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["live-reasoning"].waitForExistence(timeout: 8))
            XCTAssertTrue(app.descendants(matching: .any)["event-review-event"].exists)
            XCTAssertTrue(app.buttons["예산 안건"].exists || app.staticTexts["예산 안건"].exists)
            capture("ios-conversation-\(theme)", app: app)
            app.buttons["확인 필요 접기"].tap()
            capture("ios-conversation-folded-\(theme)", app: app)
            app.scrollViews["chat-history"].swipeDown()
            XCTAssertTrue(app.buttons["thread-fixture-work"].waitForExistence(timeout: 5))
            capture("ios-conversation-earlier-\(theme)", app: app)
            app.scrollViews["chat-history"].swipeDown()
            capture("ios-conversation-start-\(theme)", app: app)

            app.buttons["chat-threads"].tap()
            XCTAssertTrue(app.staticTexts["진행 중"].waitForExistence(timeout: 5))
            capture("ios-threads-\(theme)", app: app)
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH '주간 보고 초안'")).firstMatch.tap()
            XCTAssertTrue(app.staticTexts["작업 결과"].waitForExistence(timeout: 5))
            capture("ios-thread-work-\(theme)", app: app)
            app.buttons["주간-보고.md 열기"].firstMatch.tap()
            XCTAssertTrue(app.buttons["파일 닫기"].waitForExistence(timeout: 5))
            capture("ios-file-\(theme)", app: app)
            app.buttons["파일 닫기"].tap()
            app.buttons["닫기"].firstMatch.tap()
            // The chat hides the tab bar; going back reveals it.
            app.navigationBars.buttons.element(boundBy: 0).tap()
            capture("ios-roster-after-\(theme)", app: app)

            app.tabBars.buttons["맡긴 일"].tap()
            capture("ios-works-\(theme)", app: app)
            app.buttons["work-fixture-work"].tap()
            XCTAssertTrue(app.staticTexts["요청 내용"].waitForExistence(timeout: 8))
            XCTAssertTrue(app.descendants(matching: .any)["진행 단계: 검증"].exists)
            capture("ios-work-\(theme)", app: app)

            app.tabBars.buttons["소식"].tap()
            XCTAssertTrue(app.staticTexts["어떤 항목부터 조사할까요?"].waitForExistence(timeout: 8))
            capture("ios-inbox-\(theme)", app: app)
            positionCard("다운로드 폴더 용량 확인", in: app)
            capture("ios-approval-\(theme)", app: app)
            positionCard("회의 메모 요약", in: app)
            capture("ios-receipt-\(theme)", app: app)
            app.terminate()
        }
    }
}
