import Foundation
import Testing
@testable import GhostMobileCore

@Test @MainActor func draftsSurviveReopenAndStayInTheirConversation() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appending(path: "drafts.json")
    let first = DraftAddress(workspaceID: "w", profileID: "p", conversationID: "one")
    let second = DraftAddress(workspaceID: "w", profileID: "p", conversationID: "two")
    let store = try ConversationDrafts(file: file)
    store.update("첫 대화 초안", at: first); store.update("다른 대화 초안", at: second)
    try store.save()
    let reopened = try ConversationDrafts(file: file)
    #expect(reopened.draft(at: first)?.text == "첫 대화 초안")
    #expect(reopened.draft(at: second)?.text == "다른 대화 초안")
    #expect(reopened.draft(at: DraftAddress(workspaceID: "other", profileID: "p", conversationID: "one")) == nil)
    #expect(reopened.draft(at: DraftAddress(workspaceID: "w", profileID: "other", conversationID: "one")) == nil)
    #expect(try ConversationDrafts(file: directory.appending(path: "other-server.json")).draft(at: first) == nil)
}

@Test @MainActor func sendCompletionCannotEraseLaterTypingOrAnotherConversation() throws {
    let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    let store = try ConversationDrafts(file: file)
    let address = DraftAddress(workspaceID: "w", profileID: "p", conversationID: "one")
    let other = DraftAddress(workspaceID: "w", profileID: "p", conversationID: "two")
    store.update("original", at: address)
    let submitted = try #require(store.draft(at: address))
    store.update("", at: address); store.update("original", at: address)
    store.update("another conversation", at: other)
    store.clear(submitted, at: address)
    #expect(store.draft(at: address)?.text == "original")
    #expect(store.draft(at: address)?.revision != submitted.revision)
    #expect(store.draft(at: other)?.text == "another conversation")
    let current = try #require(store.draft(at: address))
    store.clear(current, at: address); try store.save()
    #expect(try ConversationDrafts(file: file).draft(at: address) == nil)
}

@Test @MainActor func creatingConversationMovesTheLatestDraftWithoutErasingNewText() throws {
    let store = try ConversationDrafts(file: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    let provisional = DraftAddress(workspaceID: "w", profileID: "p", conversationID: "")
    let created = DraftAddress(workspaceID: "w", profileID: "p", conversationID: "created")
    store.update("submit this", at: provisional)
    let submitted = try #require(store.draft(at: provisional))
    store.update("keep this next message", at: provisional)
    store.move(from: provisional, to: created); store.clear(submitted, at: created)
    #expect(store.draft(at: provisional) == nil)
    #expect(store.draft(at: created)?.text == "keep this next message")
}

@Test @MainActor func corruptDraftsAreNotSilentlyOverwritten() throws {
    let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    try Data("broken".utf8).write(to: file)
    #expect(throws: (any Error).self) { try ConversationDrafts(file: file) }
    #expect(try String(contentsOf: file, encoding: .utf8) == "broken")
}
