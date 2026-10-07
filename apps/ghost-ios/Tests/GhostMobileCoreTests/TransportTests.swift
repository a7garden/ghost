import Foundation
import Testing
@testable import GhostMobileCore

@Test func serverAddressRejectsCredentialLeaks() throws {
    let token = String(repeating: "a", count: 64)
    for url in ["http://ghost.example", "https://u:p@ghost.example", "https://ghost.example/path", "https://ghost.example?token=x", "https://ghost.example#x"] {
        #expect(throws: MobileError.self) { try Connection(server: url, token: token) }
    }
    let valid = try Connection(server: "https://ghost.example:8443", token: token)
    #expect(valid.url("mobile/v1/snapshot").absoluteString == "https://ghost.example:8443/mobile/v1/snapshot")
    #expect(try Connection(server: "https://GHOST.EXAMPLE:443/", token: token).origin == Connection(server: "https://ghost.example", token: token).origin)
}
@Test func retrySurvivesProcessStateAndRemainsBoundToCommand() async throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "pending.json")
    let command = JSON.object(["type": .string("submit"), "prompt": .string("original")])
    let first = try await PendingCommands(file: file).prepare(command)
    let reopened = PendingCommands(file: file)
    #expect(try await reopened.prepare(command) == first)
    let different = try await reopened.prepare(.object(["type": .string("submit"), "prompt": .string("changed")]))
    #expect(different.request_id != first.request_id)
    try await reopened.finish(first)
    #expect(try await reopened.prepare(command).request_id != first.request_id)
}
@Test func corruptedJournalFailsBeforeDispatch() async throws {
    let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    try Data("broken".utf8).write(to: file)
    await #expect(throws: (any Error).self) { try await PendingCommands(file: file).prepare(.object(["type": .string("submit")])) }
}
