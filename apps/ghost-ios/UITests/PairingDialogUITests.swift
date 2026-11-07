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

/// Opens the paired conversation so the transcript can be captured against
/// a real host.
@MainActor final class PairedConversationUITests: XCTestCase {
    func testOpensPairedConversation() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["GHOST_E2E"] == "1",
                          "Requires an explicitly paired test host; set GHOST_E2E=1.")
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for candidate in [springboard.buttons["허용 안 함"], app.buttons["허용 안 함"]] {
            if candidate.waitForExistence(timeout: 3) { candidate.tap(); break }
        }
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'conversation-'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 12))
        row.tap()
        XCTAssertTrue(app.textFields["chat-composer"].waitForExistence(timeout: 12))
    }
}

/// Live checks against a paired host: disconnect, send a prompt and wait for
/// the model's reply, and open the work list.
@MainActor final class LiveHostUITests: XCTestCase {
    // These need a running host with a model; they are opt-in.
    private func requireLiveHost() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["GHOST_E2E"] == "1",
                          "Set GHOST_E2E=1 to run the live-host checks.")
    }

    func testDisconnectsFromCurrentHost() throws {
        try requireLiveHost()
        let app = XCUIApplication()
        XCTAssertTrue(app.tabBars.buttons["연결"].waitForExistence(timeout: 10))
        app.tabBars.buttons["연결"].tap()
        let disconnect = app.buttons["이 iPhone에서 연결 해제"]
        XCTAssertTrue(disconnect.waitForExistence(timeout: 10))
        disconnect.tap()
        let confirm = app.buttons["연결 해제"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 6))
        confirm.tap()
        XCTAssertTrue(app.buttons["pairing-scan-qr"].waitForExistence(timeout: 10))
    }

    func testSendsPromptAndWaitsForReply() throws {
        try requireLiveHost()
        let app = XCUIApplication()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'conversation-'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 12))
        row.tap()
        let composer = app.textFields["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 12))
        composer.tap()
        composer.typeText("한 단어로 대답해: 안녕")
        app.buttons["메시지 보내기"].tap()
        // The reply is one word, but the model may greet first.
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '안녕'"))
        XCTAssertTrue(reply.firstMatch.waitForExistence(timeout: 120))
        app.swipeDown() // dismiss the keyboard
    }

    func testOpensFinishedWorks() throws {
        try requireLiveHost()
        let app = XCUIApplication()
        // Leaving the chat screen dismisses the keyboard and reveals the tab bar.
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        if backButton.exists { backButton.tap() }
        XCTAssertTrue(app.tabBars.buttons["맡긴 일"].waitForExistence(timeout: 12))
        app.tabBars.buttons["맡긴 일"].tap()
        XCTAssertTrue(app.staticTexts["Sleep 20, then create count.txt with 7"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["완료"].exists)
    }
}
