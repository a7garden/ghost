import Foundation
import Security
import CryptoKit
import Observation
import GhostMobileCore

/// Keychain-backed saved connection: one generic-password item holding
/// `{origin, deviceId, token}` as JSON, device-only availability.
@MainActor enum CredentialStore {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.a7garden.ghost.connection",
        kSecAttrAccount as String: "device",
    ]

    static func load() throws -> Connection? {
        var request = query
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw MobileError.response("저장된 연결 정보를 읽지 못했습니다.")
        }
        return try JSONDecoder().decode(Connection.self, from: data)
    }

    static func save(_ connection: Connection) throws {
        let data = try JSONEncoder().encode(connection)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil) == errSecSuccess else {
                throw MobileError.response("연결 정보를 안전하게 저장하지 못했습니다.")
            }
        } else if updated != errSecSuccess {
            throw MobileError.response("연결 정보를 갱신하지 못했습니다.")
        }
    }

    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw MobileError.response("연결 정보를 지우지 못했습니다.")
        }
    }
}

struct LoadedArtifact {
    var data: Data?
    var digest: String
    var error: String?
    var isLoading: Bool
}

struct ChatRoute: Equatable {
    let conversationId: String
    let identifier = UUID()
    static func == (lhs: ChatRoute, rhs: ChatRoute) -> Bool { lhs.identifier == rhs.identifier }
}

/// One notification tap: exactly the tapped row's target, never a fallback.
struct NotificationRoute: Equatable {
    let notificationId: String
    let identifier = UUID()
    static func == (lhs: NotificationRoute, rhs: NotificationRoute) -> Bool { lhs.identifier == rhs.identifier }
}

@MainActor @Observable final class GhostModel {
    private(set) var connection: Connection?
    let pairing: PairingModel

    private(set) var snapshot = GhostStateSnapshot(
        seq: 0, principal: .owner,
        runtime: Runtime(ready: false, detail: "", version: ""),
        ghosts: [], conversations: [], works: [], decisions: [], notifications: [])

    private(set) var isOnline = false
    var error: String?
    private(set) var connectionError: String?
    var busy = false
    private(set) var pending: [Envelope] = []
    var pushStatus: String?
    var pendingPushToken: String?

    private(set) var drafts: ConversationDrafts?
    private(set) var draftError: String?

    // Live conversation state from the event stream.
    private(set) var liveByConversation: [String: Live] = [:]
    /// Messages appended after the visible page was loaded, per conversation.
    private(set) var appendedMessages: [String: [Message]] = [:]

    private(set) var loadedArtifacts: [String: LoadedArtifact] = [:]

    var chatRoute: ChatRoute?
    var notificationRoute: NotificationRoute?

    @ObservationIgnored private(set) var api: GhostAPI?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var flushingPending = false
    @ObservationIgnored private let deadlineFormatter: DateFormatter

    init() {
        pairing = PairingModel(store: PairingKeychainStore())
        let formatter = DateFormatter()
        formatter.dateFormat = "M월 d일 HH:mm"
        deadlineFormatter = formatter
        pairing.onApproved = { [weak self] origin, deviceId, token in
            guard let self else { return false }
            return await self.connectPaired(origin: origin, deviceId: deviceId, token: token)
        }
        #if DEBUG
        if configureUITestsIfNeeded() { return }
        #endif
        do {
            if let saved = try CredentialStore.load() {
                try adopt(connection: saved)
                // A saved connection means any pending pairing attempt either
                // produced it or is stale; it must not resurrect.
                pairing.discardAdoptedAttempt()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Connect / disconnect

    /// Wires the saved or freshly claimed credential to a live API client and
    /// drafts store. Throws when the stored connection is malformed.
    private func adopt(connection saved: Connection) throws {
        connection = saved
        api = makeAPI(saved)
        do {
            drafts = try ConversationDrafts(file: storageDirectory(saved).appending(path: "drafts.json"))
            draftError = nil
        } catch {
            drafts = nil
            draftError = "저장된 초안을 읽지 못했습니다. \(error.localizedDescription)"
        }
    }

    /// Completes a pairing: stores the credential and connects immediately.
    func connectPaired(origin: URL, deviceId: String, token: String) async -> Bool {
        guard connection == nil else { return true }
        do {
            let saved = try Connection(origin: origin.absoluteString, deviceId: deviceId, token: token)
            try CredentialStore.save(saved)
            try adopt(connection: saved)
            error = nil
            await refresh()
            return isOnline
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func disconnect() {
        do { try drafts?.save() } catch { }
        eventTask?.cancel()
        eventTask = nil
        do {
            try CredentialStore.remove()
            connection = nil
            api = nil
            snapshot = GhostStateSnapshot(seq: 0, principal: .owner,
                runtime: Runtime(ready: false, detail: "", version: ""),
                ghosts: [], conversations: [], works: [], decisions: [], notifications: [])
            isOnline = false
            pending = []
            drafts = nil
            draftError = nil
            liveByConversation = [:]
            appendedMessages = [:]
            loadedArtifacts = [:]
            chatRoute = nil
            notificationRoute = nil
            pushStatus = nil
            error = nil
            connectionError = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func makeAPI(_ connection: Connection) -> GhostAPI {
        #if DEBUG
        if MobileUIFixture.enabled && connection.origin.host() == "ui-test.invalid" {
            return GhostAPI(connection: connection, pendingFile: storageDirectory(connection).appending(path: "pending.json"), session: MobileUIFixture.session)
        }
        #endif
        return GhostAPI(connection: connection, pendingFile: storageDirectory(connection).appending(path: "pending.json"))
    }

    private func storageDirectory(_ connection: Connection) -> URL {
        let key = SHA256.hash(data: Data(connection.origin.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return URL.applicationSupportDirectory.appending(path: "Ghost/\(key)")
    }

    // MARK: Snapshot + event stream

    func refresh() async {
        guard let api else { return }
        do {
            let state = try await api.state()
            guard self.api === api else { return }
            applySnapshot(state)
            isOnline = true
            connectionError = nil
            pending = (try? await api.pendingCommands()) ?? pending
            await retryPendingPushToken()
            await flushPendingCommands()
        } catch is CancellationError {
        } catch {
            if self.api === api {
                isOnline = false
                connectionError = error.localizedDescription
            }
        }
    }

    /// Long-lived event stream: snapshot already applied, so events replay
    /// from the last applied seq; `reset` refetches the snapshot. Errors
    /// back off and reconnect with the same seq — the stream is the only
    /// writer of `appendedMessages` and `liveByConversation`.
    func runEventStream() async {
        guard let api, let connection else { return }
        eventTask?.cancel()
        let task = Task { [weak self] in
            var backoff: Duration = .seconds(1)
            while !Task.isCancelled {
                guard let self, self.api === api, self.connection == connection else { return }
                let seq = self.snapshot.seq
                let conversations = Array(self.monitoredConversations().prefix(16))
                do {
                    let (bytes, response) = try await api.rawBytes(api.eventRequest(after: seq, conversations: conversations))
                    guard response.statusCode == 200 else {
                        throw MobileError.response("이벤트 스트림을 열지 못했습니다. (\(response.statusCode))")
                    }
                    backoff = .seconds(1)
                    await self.consume(bytes: bytes, api: api)
                } catch is CancellationError {
                    return
                } catch {
                    if self.api !== api { return }
                    self.isOnline = false
                    self.connectionError = error.localizedDescription
                    try? await Task.sleep(for: backoff)
                    backoff = min(backoff * 2, .seconds(30))
                    await self.refresh()
                }
            }
        }
        eventTask = task
        await task.value
    }

    func stopEventStream() {
        eventTask?.cancel()
        eventTask = nil
    }

    /// Direct conversations this device may read; the stream subscribes to
    /// them so chat pages and the ghost list stay live.
    private func monitoredConversations() -> [String] {
        snapshot.conversations
            .filter { isAllowed($0) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
            .map(\.id)
    }

    private func consume(bytes: URLSession.AsyncBytes, api: GhostAPI) async {
        var parser = SSEParser()
        do {
            var buffer = [UInt8]()
            buffer.reserveCapacity(4096)
            for try await byte in bytes {
                buffer.append(byte)
                if byte == UInt8(ascii: "\n") {
                    for frame in parser.feed(text: String(decoding: buffer, as: UTF8.self)) {
                        buffer.removeAll(keepingCapacity: true)
                        await apply(frame: frame, api: api)
                    }
                    buffer.removeAll(keepingCapacity: true)
                }
            }
            // Stream closed by the server: reconnect through the caller.
        } catch is CancellationError {
        } catch {
            if self.api === api {
                isOnline = false
                connectionError = error.localizedDescription
            }
        }
    }

    private func apply(frame: SSEFrame, api: GhostAPI) async {
        guard let streamFrame = try? frame.streamFrame() else { return }
        switch streamFrame {
        case .ledger(let event):
            applyLedger(event)
        case .live(let event):
            applyLive(event)
        case .reset(let seq):
            _ = seq
            await refresh()
        }
    }

    func applySnapshot(_ state: GhostStateSnapshot) {
        snapshot = state
        for id in liveByConversation.keys where state.conversations.first(where: { $0.id == id }) == nil {
            liveByConversation.removeValue(forKey: id)
        }
    }

    private func applyLedger(_ event: LedgerEvent) {
        guard event.seq > snapshot.seq else { return }
        var state = snapshot
        state.seq = event.seq
        switch event.data {
        case .ghost(let ghost):
            upsert(&state.ghosts, ghost)
        case .conversation(let conversation):
            upsert(&state.conversations, conversation)
        case .conversationRemoved(let id):
            state.conversations.removeAll { $0.id == id }
            liveByConversation.removeValue(forKey: id)
            appendedMessages.removeValue(forKey: id)
        case .work(let work):
            upsert(&state.works, work)
        case .decision(let decision):
            upsert(&state.decisions, decision)
        case .effect:
            break // effects arrive through WorkDetail fetches
        case .notification(let notification):
            upsert(&state.notifications, notification)
        case .other:
            break
        }
        snapshot = state
    }

    private func applyLive(_ event: LiveEvent) {
        switch event {
        case .live(let live):
            liveByConversation[live.conversationId] = live
        case .message(let message):
            var appended = appendedMessages[message.conversationId] ?? []
            guard !appended.contains(where: { $0.id == message.id }) else { return }
            appended.append(message)
            appendedMessages[message.conversationId] = appended
            if var live = liveByConversation[message.conversationId] {
                live.running = false
                live.partial = nil
                liveByConversation[message.conversationId] = live
            }
        }
    }

    /// Messages the visible page should append beyond its loaded window.
    func drainAppendedMessages(conversationId: String, loadedIDs: Set<String>) -> [Message] {
        let fresh = (appendedMessages[conversationId] ?? []).filter { !loadedIDs.contains($0.id) }
        return fresh
    }

    func noteLoadedMessages(conversationId: String, ids: [String]) {
        var appended = appendedMessages[conversationId] ?? []
        appended.removeAll { ids.contains($0.id) }
        appendedMessages[conversationId] = appended
    }

    private func upsert<Entity: Identifiable>(_ values: inout [Entity], _ entity: Entity) where Entity.ID == String {
        if let index = values.firstIndex(where: { $0.id == entity.id }) {
            values[index] = entity
        } else {
            values.append(entity)
        }
    }

    // MARK: Grants

    var grantedGhostIDs: Set<String> {
        switch snapshot.principal {
        case .owner: return Set(snapshot.ghosts.map(\.id))
        case .device(_, _, let grants): return Set(grants.map(\.ghostId))
        }
    }

    func isAllowed(_ conversation: Conversation) -> Bool {
        guard conversation.kind == .direct, grantedGhostIDs.contains(conversation.ghostId) else { return false }
        switch snapshot.principal {
        case .owner: return true
        case .device(_, _, let grants):
            return grants.contains { $0.ghostId == conversation.ghostId && ($0.conversationId == nil || $0.conversationId == conversation.id) }
        }
    }

    var grantedConversations: [Conversation] {
        snapshot.conversations
            .filter { isAllowed($0) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    func ghost(_ id: String) -> Ghost? { snapshot.ghosts.first { $0.id == id } }

    func ghostName(_ id: String) -> String { ghost(id)?.name ?? "Ghost" }

    // MARK: Commands

    @discardableResult
    func send(_ command: DeviceCommand) async throws -> JSON {
        guard let api else { throw MobileError.response("서버에 먼저 연결해 주세요.") }
        busy = true
        defer { busy = false }
        do {
            let result = try await api.send(command)
            await refresh()
            return result
        } catch let error as CommandError {
            self.error = Self.commandMessage(error)
            await reloadPending()
            throw error
        } catch {
            self.error = error.localizedDescription
            await reloadPending()
            throw error
        }
    }

    static func commandMessage(_ error: CommandError) -> String {
        switch error.code {
        case "not_found": "대상을 찾을 수 없습니다. 새로고침한 뒤 다시 시도해 주세요."
        case "forbidden": "이 기기에 허용되지 않은 요청입니다."
        case "conflict": "요청이 현재 상태와 맞지 않습니다. 화면을 새로고침해 주세요."
        case "invalid": "요청 내용을 확인해 주세요."
        case "unavailable": "서버가 지금 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요."
        default: error.message
        }
    }

    private func reloadPending() async {
        guard let api else { return }
        pending = (try? await api.pendingCommands()) ?? pending
    }

    /// Re-sends journaled envelopes with their original requestIds. The host
    /// deduplicates by requestId, so a lost response never double-applies.
    func flushPendingCommands() async {
        guard let api, !flushingPending else { return }
        flushingPending = true
        defer { flushingPending = false }
        let queued = (try? await api.pendingCommands()) ?? []
        for envelope in queued {
            do {
                _ = try await api.retry(envelope)
            } catch is CommandError {
                // Definitive rejection: the envelope is already cleared.
            } catch {
                break // unknown outcome: keep the rest for the next flush
            }
        }
        pending = (try? await api.pendingCommands()) ?? []
    }

    // MARK: Page fetches (surfaced through the model for consistent errors)

    func conversationPage(id: String, before: String? = nil, limit: Int = 60) async throws -> ConversationPage {
        guard let api else { throw MobileError.response("서버에 먼저 연결해 주세요.") }
        do {
            let page = try await api.conversation(id: id, before: before, limit: limit)
            isOnline = true
            connectionError = nil
            return page
        } catch {
            await surface(error)
            throw error
        }
    }

    func workDetail(id: String) async throws -> WorkDetail {
        guard let api else { throw MobileError.response("서버에 먼저 연결해 주세요.") }
        do {
            let detail = try await api.work(id: id)
            isOnline = true
            connectionError = nil
            return detail
        } catch {
            await surface(error)
            throw error
        }
    }

    private func surface(_ error: Error) async {
        if error is MobileError || error is URLError || error is DecodingError {
            isOnline = false
            connectionError = error.localizedDescription
        }
    }

    // MARK: Drafts

    func draftAddress(conversationId: String) -> DraftAddress {
        DraftAddress(workspaceID: connection?.origin.absoluteString ?? "", profileID: "ghost", conversationID: conversationId)
    }

    @discardableResult func saveDrafts() -> Bool {
        guard let drafts else { return false }
        do {
            try drafts.save()
            draftError = nil
            return true
        } catch {
            draftError = "초안을 저장하지 못했습니다. \(error.localizedDescription)"
            return false
        }
    }

    // MARK: Artifacts

    func loadArtifact(digest: String) async {
        if let existing = loadedArtifacts[digest], existing.data != nil || existing.isLoading { return }
        loadedArtifacts[digest] = LoadedArtifact(data: nil, digest: digest, error: nil, isLoading: true)
        guard let api else {
            loadedArtifacts[digest] = LoadedArtifact(data: nil, digest: digest, error: "서버에 먼저 연결해 주세요.", isLoading: false)
            return
        }
        do {
            let data = try await api.artifact(digest: digest)
            loadedArtifacts[digest] = LoadedArtifact(data: data, digest: digest, error: nil, isLoading: false)
        } catch {
            loadedArtifacts[digest] = LoadedArtifact(data: nil, digest: digest, error: error.localizedDescription, isLoading: false)
        }
    }

    // MARK: Notifications

    func markNotificationsRead(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        Task { [weak self] in
            _ = try? await self?.send(.notificationRead(notificationIds: ids))
        }
    }

    func route(_ notification: GhostNotification) {
        markNotificationsRead([notification.id])
        notificationRoute = NotificationRoute(notificationId: notification.id)
    }

    /// A push tap routes to exactly the tapped notification; an unknown or
    /// absent id never falls back to an unrelated row.
    func openNotification(notificationID: String) async {
        if snapshot.notifications.first(where: { $0.id == notificationID }) == nil {
            await refresh()
        }
        guard let notification = snapshot.notifications.first(where: { $0.id == notificationID }) else { return }
        route(notification)
    }

    // MARK: Push registration

    func registerPushToken(_ token: String, environment: String) async {
        guard let api, isOnline else {
            pendingPushToken = token
            return
        }
        do {
            _ = try await api.send(.pushRegister(token: token, environment: environment))
            pendingPushToken = nil
            pushStatus = nil
        } catch {
            pendingPushToken = token
            pushStatus = "알림 토큰 등록이 실패했습니다. 연결 후 다시 시도됩니다."
        }
    }

    func retryPendingPushToken() async {
        guard let token = pendingPushToken else { return }
        await registerPushToken(token, environment: PushEnvironment.current)
    }

    // MARK: Formatting helpers

    func deadlineText(_ ms: Int?) -> String {
        guard let ms else { return "" }
        return deadlineFormatter.string(from: contractDate(ms))
    }

    func relativeTime(_ ms: Int) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.locale = Locale(identifier: "ko_KR")
        return formatter.localizedString(for: contractDate(ms), relativeTo: Date())
    }

    // MARK: UI-test fixture

    #if DEBUG
    private func configureUITestsIfNeeded() -> Bool {
        guard MobileUIFixture.enabled else { return false }
        do {
            let directory = URL.applicationSupportDirectory.appending(path: "GhostUITests")
            if ProcessInfo.processInfo.arguments.contains("--reset-fixture"), FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.removeItem(at: directory)
            }
            connection = try Connection(origin: "https://ui-test.invalid", deviceId: "fixture-device", token: String(repeating: "a", count: 32))
            drafts = try ConversationDrafts(file: directory.appending(path: "drafts.json"))
            api = makeAPI(connection!)
            applySnapshot(MobileUIFixture.state)
            isOnline = true
        } catch {
            self.error = error.localizedDescription
        }
        return true
    }

    func appendUITestMessage() {
        applyLive(.message(MobileUIFixture.incomingMessage()))
    }
    #endif
}
