import Foundation
import Observation

public struct DraftAddress: Codable, Hashable, Sendable {
    public let workspaceID: String
    public let profileID: String
    public let conversationID: String
    public init(workspaceID: String, profileID: String, conversationID: String) {
        self.workspaceID = workspaceID; self.profileID = profileID; self.conversationID = conversationID
    }
}

public struct ConversationDraft: Codable, Equatable, Sendable {
    public let text: String
    public let revision: UUID
    fileprivate init(text: String) { self.text = text; revision = UUID() }
}

// These are local composer states, not canonical user documents. Each server
// gets its own file; addresses also separate workspaces, Ghosts and conversations.
@MainActor @Observable public final class ConversationDrafts {
    private struct Entry: Codable { let address: DraftAddress; let draft: ConversationDraft }
    private var values: [DraftAddress: ConversationDraft] = [:]
    @ObservationIgnored private let file: URL
    @ObservationIgnored private var dirty = false

    public init(file: URL) throws {
        self.file = file
        if FileManager.default.fileExists(atPath: file.path) {
            let entries = try JSONDecoder().decode([Entry].self, from: Data(contentsOf: file))
            for entry in entries {
                guard values.updateValue(entry.draft, forKey: entry.address) == nil else {
                    throw MobileError.response("저장된 초안에 중복된 대화가 있습니다.")
                }
            }
        }
    }
    public func draft(at address: DraftAddress) -> ConversationDraft? { values[address] }
    public func update(_ text: String, at address: DraftAddress) {
        guard text != (values[address]?.text ?? "") else { return }
        values[address] = text.isEmpty ? nil : ConversationDraft(text: text)
        dirty = true
    }
    // A send completion can clear only the exact revision it submitted. Even
    // deleting and retyping identical text while sending creates a new revision.
    public func clear(_ submitted: ConversationDraft, at address: DraftAddress) {
        guard values[address] == submitted else { return }
        values[address] = nil; dirty = true
    }
    public func move(from source: DraftAddress, to destination: DraftAddress) {
        guard source != destination, let value = values[source], values[destination] == nil else { return }
        values[destination] = value; values[source] = nil; dirty = true
    }
    public func save() throws {
        guard dirty else { return }
        let entries = values.map { Entry(address: $0.key, draft: $0.value) }
        let data = try JSONEncoder().encode(entries)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        dirty = false
    }
}
