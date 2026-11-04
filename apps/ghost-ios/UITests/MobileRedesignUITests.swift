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
        XCTAssertTrue(app.staticTexts["진행 중"].exists)
        capture("Work index", app: app)
        app.tabBars.buttons["확인할 일"].tap()
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

    func testPeerSwitchKeepsIndependentDraftsAndRestoresSelection() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "--multiple-ghosts", "--review-width=375"]
        app.launch()
        let composer = app.textFields["lifetime-chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText("Default draft")
        app.buttons["ghost-switcher-open"].tap()
        let peer = app.buttons["ghost-select-00000000-0000-4000-8000-000000000004"]
        XCTAssertTrue(peer.waitForExistence(timeout: 4))
        capture("Peer Ghost selection", app: app)
        peer.tap()
        XCTAssertTrue(app.staticTexts["Research의 독립 대화입니다."].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Research · 제안"].exists)
        XCTAssertNotEqual(composer.value as? String, "Default draft")
        composer.tap(); composer.typeText("Research draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 4))
        XCTAssertLessThanOrEqual(composer.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        capture("Peer conversation keyboard", app: app)
        app.buttons["ghost-switcher-open"].tap()
        app.buttons["ghost-select-00000000-0000-4000-8000-000000000001"].tap()
        XCTAssertTrue(app.staticTexts["짧게 읽을 수 있는 에세이 위주로 보고 싶어."].waitForExistence(timeout: 8))
        XCTAssertEqual(composer.value as? String, "Default draft")
        app.buttons["ghost-switcher-open"].tap(); peer.tap()
        XCTAssertEqual(composer.value as? String, "Research draft")
        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-fixture" }
        app.launch()
        XCTAssertTrue(app.staticTexts["Research의 독립 대화입니다."].waitForExistence(timeout: 10))
        XCTAssertEqual(app.textFields["lifetime-chat-composer"].value as? String, "Research draft")
    }

    func testOptionsTargetSwitchResetsPublicPrivacyAndRestoresPeer() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "--multiple-ghosts", "--public-history"]
        app.launch()
        let options = app.buttons["대화 옵션"]
        XCTAssertTrue(options.waitForExistence(timeout: 8))
        options.tap()
        let privacy = app.descendants(matching: .any)["conversation-privacy"].firstMatch
        XCTAssertTrue(privacy.waitForExistence(timeout: 5))
        privacy.tap()
        app.descendants(matching: .any)["공개 자료 허용"].firstMatch.tap()
        XCTAssertEqual(privacy.value as? String, "공개 자료 허용")
        app.descendants(matching: .any)["conversation-target"].firstMatch.tap()
        app.descendants(matching: .any)["Research · 활성"].firstMatch.tap()
        XCTAssertEqual(privacy.value as? String, "보호된 기록")
        app.buttons["완료"].tap()
        XCTAssertTrue(app.staticTexts["Research의 독립 대화입니다."].waitForExistence(timeout: 8))

        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-fixture" }
        app.launch()
        XCTAssertTrue(app.staticTexts["Research의 독립 대화입니다."].waitForExistence(timeout: 8))
    }

    func testUnknownInputKeepsOriginalGhostAcrossRelaunch() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "--multiple-ghosts", "--pending-input"]
        app.launch()
        let switcher = app.buttons["ghost-switcher-open"]
        let peer = app.buttons["ghost-select-00000000-0000-4000-8000-000000000004"]
        let original = app.buttons["ghost-select-00000000-0000-4000-8000-000000000001"]
        let notice = "확인 중인 메시지의 접수 결과를 확인한 뒤 다른 Ghost를 선택할 수 있습니다."
        XCTAssertTrue(switcher.waitForExistence(timeout: 8))
        switcher.tap(); peer.tap()
        XCTAssertTrue(app.staticTexts["Research의 독립 대화입니다."].waitForExistence(timeout: 8))
        let composer = app.textFields["lifetime-chat-composer"]
        composer.tap(); composer.typeText("Keep this uncertain draft")
        let send = app.buttons["메시지 보내기"]
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(app.buttons[notice].waitForExistence(timeout: 8))
        switcher.tap()
        XCTAssertTrue(original.waitForExistence(timeout: 4))
        XCTAssertFalse(original.isEnabled)
        XCTAssertTrue(peer.isEnabled)
        app.buttons["닫기"].tap()
        XCTAssertEqual(composer.value as? String, "Keep this uncertain draft")

        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-fixture" }
        app.launch()
        XCTAssertTrue(app.buttons[notice].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Research의 독립 대화입니다."].waitForExistence(timeout: 8))
        XCTAssertEqual(composer.value as? String, "Keep this uncertain draft")
        XCTAssertFalse(send.isEnabled)
    }

    func testNoDefaultGhostPromptsSelectionBeforeModelSettings() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "--multiple-ghosts", "--no-default-ghost"]
        app.launch()
        let prompt = app.buttons["대화할 Ghost를 선택하세요"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["inference-picker-open"].isEnabled)
        prompt.tap()
        app.buttons["ghost-select-00000000-0000-4000-8000-000000000004"].tap()
        XCTAssertTrue(app.staticTexts["Research의 독립 대화입니다."].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["inference-picker-open"].isEnabled)
    }

    func testModelConflictRequiresReload() {
        let app = launch()
        XCTAssertTrue(app.buttons["inference-picker-open"].waitForExistence(timeout: 8))
        app.buttons["inference-picker-open"].tap()
        let apply = app.buttons["적용"]
        XCTAssertTrue(apply.waitForExistence(timeout: 5))
        XCTAssertTrue(apply.isEnabled)
        apply.tap()
        let reload = app.buttons["설정 다시 확인"]
        XCTAssertTrue(reload.waitForExistence(timeout: 5))
        XCTAssertFalse(apply.isEnabled)
        capture("Model conflict locked", app: app)
        reload.tap()
        XCTAssertTrue(apply.waitForExistence(timeout: 5))
        XCTAssertTrue(apply.isEnabled)
    }

    func testDarkPeerSelectionAndCurrentWorkDetail() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-lifetime", "--reset-fixture", "--multiple-ghosts", "--dark"]
        app.launch()
        XCTAssertTrue(app.buttons["ghost-switcher-open"].waitForExistence(timeout: 8))
        app.buttons["ghost-switcher-open"].tap()
        XCTAssertTrue(app.buttons["ghost-select-00000000-0000-4000-8000-000000000004"].waitForExistence(timeout: 4))
        capture("Dark Ghost selector", app: app)
        app.buttons["닫기"].tap()
        app.tabBars.buttons["맡긴 일"].tap()
        app.staticTexts["주말에 읽을 책 목록 정리하기"].tap()
        XCTAssertTrue(app.staticTexts["진행 중"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["대기 중"].exists)
        XCTAssertFalse(app.buttons["방향 전달"].exists)
        XCTAssertTrue(app.buttons["대화 열기"].exists)
        capture("Dark current work detail", app: app)
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
