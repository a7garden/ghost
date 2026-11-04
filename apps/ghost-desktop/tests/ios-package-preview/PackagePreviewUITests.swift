import XCTest

final class PackagePreviewUITests: XCTestCase {
    func testZeroOneAndMultipleWorkspaceViews() {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "dev.projectoxi.ghost.package-preview")
        app.launch()

        func button(_ name: String) -> XCUIElement { app.buttons.matching(identifier: name).firstMatch }
        func text(_ name: String) -> XCUIElement { app.staticTexts.matching(identifier: name).firstMatch }
        func tap(_ name: String) {
            let target = button(name)
            XCTAssertTrue(target.waitForExistence(timeout: 12), "Missing button: \(name)")
            if target.exists { target.tap() }
        }
        func show(_ name: String) {
            XCTAssertTrue(text(name).waitForExistence(timeout: 12), "Missing text: \(name)")
        }

        XCTAssertTrue(button("Ghost 전환 · Sage").waitForExistence(timeout: 15))
        XCTAssertTrue(button("대화").exists)
        XCTAssertTrue(button("확인할 일").exists)
        XCTAssertFalse(button("작업실").exists)

        tap("Ghost 전환 · Sage")
        tap("Milo")
        tap("작업실")
        tap("변경 파일 보기")
        show("workspace.tsx · 12줄 추가")

        tap("Ghost 전환 · Milo")
        tap("Nova")
        tap("작업실")
        tap("검증")
        tap("격리 확인")
        show("프레임 격리 통과")

        tap("변경으로 돌아가기")
        tap("변경 파일 보기")
        show("workspace.tsx · 12줄 추가")
        tap("Ghost 전환 · Nova")
        tap("Sage")
        XCTAssertFalse(button("작업실").exists)
        tap("Ghost 전환 · Sage")
        tap("Nova")
        XCTAssertTrue(button("변경 파일 보기").waitForExistence(timeout: 12))
    }
}
