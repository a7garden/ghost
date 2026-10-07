import Foundation
import Security
import CryptoKit
import Observation
import GhostMobileCore

@MainActor enum CredentialStore {
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "io.a7garden.ghost.connection", kSecAttrAccount as String: "owner"]
    static func load() throws -> Connection? {
        var request = query
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw MobileError.response("저장된 연결 키를 읽지 못했습니다.") }
        let saved = try JSONDecoder().decode(Connection.self, from: data)
        return try Connection(server: saved.origin.absoluteString, token: saved.token)
    }
    static func save(_ connection: Connection) throws {
        let data = try JSONEncoder().encode(connection)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil) == errSecSuccess else { throw MobileError.response("연결 키를 안전하게 저장하지 못했습니다.") }
        } else if updated != errSecSuccess { throw MobileError.response("연결 키를 갱신하지 못했습니다.") }
    }
    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw MobileError.response("연결 키를 지우지 못했습니다.") }
    }
}

struct Record: Identifiable {
    let value: JSON
    var id: String { value["id"].text }
}

@MainActor @Observable final class GhostModel {
    private(set) var connection: Connection?
    private(set) var snapshot: JSON = .null
    private(set) var isOnline = false
    var error: String?
    private(set) var connectionError: String?
    var busy = false
    private(set) var pending: [Envelope] = []
    private(set) var drafts: ConversationDrafts?
    private(set) var draftError: String?
    @ObservationIgnored private(set) var api: GhostAPI?
    #if DEBUG
    @ObservationIgnored private var fixtureRefreshes = 0
    #endif
    var profiles: [Record] { snapshot["profiles"].items.map { Record(value: $0) } }
    var voiceConfigured: Bool { snapshot["connectors"]["voice"].flag }

    init() {
        #if DEBUG
        if configureUITestsIfNeeded() { return }
        #endif
        do {
            if let saved = try CredentialStore.load() {
                connection = saved; api = makeAPI(saved)
                do { drafts = try ConversationDrafts(file: storageDirectory(saved).appending(path: "drafts.json")) }
                catch { draftError = "저장된 초안을 읽지 못했습니다. \(error.localizedDescription)" }
            }
        } catch { self.error = error.localizedDescription }
    }
    private func storageDirectory(_ connection: Connection) -> URL {
        let key = SHA256.hash(data: Data(connection.origin.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return URL.applicationSupportDirectory.appending(path: "Ghost/\(key)")
    }
    private func makeAPI(_ connection: Connection) -> GhostAPI {
        GhostAPI(connection: connection, pendingFile: storageDirectory(connection).appending(path: "pending.json"))
    }
    func connect(server: String, token: String) async {
        busy = true; defer { busy = false }
        do {
            let value = try Connection(server: server, token: token)
            let candidate = makeAPI(value)
            let bootstrap = try await candidate.get("mobile/v1/bootstrap")
            guard bootstrap["protocol"].text == "ghost-mobile", bootstrap["version"] == .number(1) else { throw MobileError.response("지원하지 않는 Ghost 서버입니다.") }
            let current = try await candidate.get("mobile/v1/snapshot")
            try validate(current)
            let savedDrafts = try ConversationDrafts(file: storageDirectory(value).appending(path: "drafts.json"))
            try CredentialStore.save(value)
            connection = value; api = candidate; snapshot = current; isOnline = true; error = nil
            drafts = savedDrafts; draftError = nil
            pending = try await candidate.pendingCommands()
        } catch { self.error = error.localizedDescription }
    }
    private func validate(_ value: JSON) throws {
        guard !value["workspace_id"].text.isEmpty, value["host_protocol_version"] == .number(1) else { throw MobileError.response("Ghost 서버 버전을 확인해 주세요.") }
    }
    func refresh() async {
        #if DEBUG
        if connection?.origin.host() == "ui-test.invalid", ProcessInfo.processInfo.arguments.contains("--ui-testing-incoming") {
            fixtureRefreshes += 1
            if fixtureRefreshes == 7 { appendUITestMessage() }
        }
        #endif
        guard let api else { return }
        do {
            let current = try await api.get("mobile/v1/snapshot")
            try validate(current)
            guard self.api === api else { return }
            snapshot = current; isOnline = true; connectionError = nil; pending = try await api.pendingCommands()
        } catch is CancellationError { }
        catch { if self.api === api { isOnline = false; self.connectionError = error.localizedDescription } }
    }
    func send(_ command: JSON) async throws -> JSON {
        guard let api else { throw MobileError.response("서버에 먼저 연결해 주세요.") }
        do {
            let result = try await api.action(command)
            await refresh(); return result
        } catch {
            pending = (try? await api.pendingCommands()) ?? pending
            self.error = error.localizedDescription
            throw error
        }
    }
    func perform(_ command: JSON) async {
        busy = true; defer { busy = false }
        _ = try? await send(command)
    }
    func disconnect() {
        do {
            try drafts?.save()
            try CredentialStore.remove(); connection = nil; api = nil; snapshot = .null; pending = []; isOnline = false
            drafts = nil; draftError = nil
        }
        catch { self.error = error.localizedDescription }
    }
    @discardableResult func saveDrafts() -> Bool {
        guard let drafts else { return false }
        do { try drafts.save(); draftError = nil; return true }
        catch { draftError = "초안을 저장하지 못했습니다. \(error.localizedDescription)"; return false }
    }
    func draftAddress(profileID: String, conversationID: String) -> DraftAddress {
        DraftAddress(workspaceID: snapshot["workspace_id"].text, profileID: profileID, conversationID: conversationID)
    }
    func acknowledge(_ envelope: Envelope) async {
        do { try await api?.acknowledge(envelope); pending = try await api?.pendingCommands() ?? [] }
        catch { self.error = error.localizedDescription }
    }
    func profile(_ id: String) -> JSON { profiles.first(where: { $0.id == id })?.value ?? .null }

    #if DEBUG
    private func appendUITestMessage() {
        var root = snapshot.dictionary
        var profiles = snapshot["profiles"].items
        var profile = profiles[0].dictionary
        var conversations = profiles[0]["conversations"].items
        var conversation = conversations[0].dictionary
        var messages = conversations[0]["messages"].items
        messages.append(.object(["revision": .number(31), "role": .string("assistant"), "text": .string("Incoming message")]))
        conversation["messages"] = .array(messages); conversations[0] = .object(conversation)
        profile["conversations"] = .array(conversations); profiles[0] = .object(profile)
        root["profiles"] = .array(profiles); snapshot = .object(root)
    }
    // Isolated simulator data; this path never reads credentials or creates an
    // API client, and is absent from Release builds.
    private func configureUITestsIfNeeded() -> Bool {
        guard ProcessInfo.processInfo.arguments.contains("--ui-testing") else { return false }
        let directory = URL.applicationSupportDirectory.appending(path: "GhostUITests")
        do {
            if ProcessInfo.processInfo.arguments.contains("--reset-fixture"), FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
            connection = try Connection(server: "https://ui-test.invalid", token: String(repeating: "0", count: 64))
            drafts = try ConversationDrafts(file: directory.appending(path: "drafts.json"))
            let messages = (1...30).map { number in
                JSON.object(["revision": .number(Double(number)), "role": .string(number.isMultiple(of: 2) ? "assistant" : "user"),
                             "text": .string(number == 30 ? "Latest message" : "Message \(number)\n대화 기록과 스크롤 위치를 확인하는 테스트 메시지입니다.")])
            }
            snapshot = .object(["workspace_id": .string("ui-test"), "host_protocol_version": .number(1), "profiles": .array([
                .object(["id": .string("test-ghost"), "name": .string("Ghost"), "persona": .string("iPhone 대화"), "conversations": .array([
                    .object(["id": .string("first"), "title": .string("First conversation"), "messages": .array(messages)]),
                    .object(["id": .string("second"), "title": .string("Second conversation"), "messages": .array([])])
                ])])
            ])])
            isOnline = true
        } catch { self.error = error.localizedDescription }
        return true
    }
    #endif
}

func command(_ type: String, _ fields: [String: JSON] = [:]) -> JSON { .object(fields.merging(["type": .string(type)], uniquingKeysWith: { _, new in new })) }
func owner(_ type: String, _ fields: [String: JSON] = [:]) -> JSON { command("workspace", ["action": command(type, fields)]) }
