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

struct LifetimeConversationTarget: Identifiable, Equatable {
    let ghostID: String
    let conversationID: String
    let kind: String
    let roles: [String]
    let mode: String
    var id: String { "\(ghostID.utf8.count):\(ghostID)\(conversationID.utf8.count):\(conversationID)" }
    var label: String {
        let role = roles.joined(separator: " · ")
        return kind == "primary" ? (role.isEmpty ? "주 Ghost" : "주 Ghost · \(role)") : (role.isEmpty ? "전문 담당" : role)
    }
}

@MainActor @Observable final class GhostModel {
    private(set) var connection: Connection?
    let pairing: PairingModel
    private(set) var snapshot: JSON = .null
    private(set) var isOnline = false
    var error: String?
    private(set) var connectionError: String?
    var busy = false
    private(set) var pending: [Envelope] = []
    private(set) var isLifetimeConnection = false
    private(set) var lifetimeScope: JSON = .null
    private(set) var lifetimeGhostIDs: Set<String> = []
    private(set) var lifetimeConversationIDs: Set<String> = []
    private(set) var lifetimeConversationTargets: [LifetimeConversationTarget] = []
    private(set) var lifetimeTargetIssue: String?
    private(set) var lifetimeCapabilities: Set<String> = []
    private(set) var voiceMediaGhostID = ""
    private(set) var voiceMediaConversationID = ""
    var pushStatus: String?
    var pendingPushToken: String?
    private(set) var notifications: [NotificationEntry] = []
    private(set) var notificationError: String?
    private(set) var notificationAckIssue: String?
    private(set) var activeCall: VoiceCallController?

    // Owner decision surface: pending questions for this device's exact
    // scope, per-Ghost lifecycle results, and opened artifact documents.
    private(set) var ownerQuestions: [OwnerQuestion] = []
    private(set) var ownerQuestionsError: String?
    private(set) var isDecidingQuestion = false
    private(set) var lifecycleResult: LifecycleOutcome?
    private(set) var loadedArtifacts: [String: LoadedArtifact] = [:]

    struct LifecycleOutcome: Identifiable {
        let id = UUID()
        let ghostID: String
        let operation: String
        let status: String
        let summary: String
        let detail: JSON
    }

    struct LoadedArtifact {
        var content: WorkArtifactContent?
        var error: String?
        var isLoading: Bool
    }

    // Unresolved server-side voice state. The fence is persisted (metadata
    // only, bound to the original gateway/workspace/device/authority) before
    // the offer is dispatched, so an ambiguous start or an unconfirmed end
    // survives disconnect, controller replacement, and app relaunch, and
    // blocks new calls until the server confirms closure or proves the
    // start never created a session. Reconciliation through a foreign
    // connection is refused before any request leaves the device.
    private(set) var voiceCallFence: VoiceCallFence?
    private(set) var voiceFenceIssue: String?
    private(set) var resolvingVoiceFence = false
    @ObservationIgnored private var voiceSession: VoiceMediaSession?
    @ObservationIgnored private var voiceFenceStore: VoiceCallFenceStore?
    var chatRoute: ChatRoute?
    var lifetimeRouteTarget: LifetimeRouteTarget?
    @ObservationIgnored private var bootstrap: JSON = .null
    private(set) var drafts: ConversationDrafts?
    private(set) var draftError: String?
    @ObservationIgnored private(set) var api: GhostAPI?
    #if DEBUG
    @ObservationIgnored private var fixtureRefreshes = 0
    #endif
    var profiles: [Record] { snapshot["profiles"].items.map { Record(value: $0) } }
    var voiceConfigured: Bool { snapshot["connectors"]["voice"].flag }
    var voiceMediaTarget: (ghostID: String, conversationID: String)? {
        voiceMediaGhostID.isEmpty || voiceMediaConversationID.isEmpty ? nil : (voiceMediaGhostID, voiceMediaConversationID)
    }

    struct NotificationEntry: Identifiable, Equatable {
        let recipientID: String
        let notification: MobileNotification
        var id: String { "\(recipientID):\(notification.id)" }
        var phrase: String {
            switch notification.eventKind {
            case "acceptance": "맡긴 작업이 수용됐습니다."
            case "briefing": "맡긴 브리핑이 준비됐습니다."
            default: "맡긴 작업의 결과가 도착했습니다."
            }
        }
    }

    struct ChatRoute: Equatable {
        let profileID: String
        let conversationID: String
        let identifier = UUID()
        static func == (lhs: ChatRoute, rhs: ChatRoute) -> Bool { lhs.identifier == rhs.identifier }
    }

    struct LifetimeRouteTarget: Equatable {
        let ghostID: String
        let conversationID: String
        let identifier = UUID()
        static func == (lhs: LifetimeRouteTarget, rhs: LifetimeRouteTarget) -> Bool { lhs.identifier == rhs.identifier }
    }
    var lifetimeAuthorityKey: String {
        let host = bootstrap["lifetime_host"]
        let epoch: String
        if case .number(let value) = host["authority_epoch"] { epoch = String(value) }
        else { epoch = "unverified" }
        let origin = connection?.origin.absoluteString ?? ""
        let workspaceID = host["workspace_id"].text
        return "\(origin.utf8.count):\(origin):\(workspaceID.utf8.count):\(workspaceID):\(epoch)"
    }

    init() {
        pairing = PairingModel(store: PairingKeychainStore())
        #if DEBUG
        if configureUITestsIfNeeded() { configurePairingApproval(); return }
        #endif
        do {
            if let saved = try CredentialStore.load() {
                connection = saved; api = makeAPI(saved)
                do { drafts = try ConversationDrafts(file: storageDirectory(saved).appending(path: "drafts.json")) }
                catch { draftError = "저장된 초안을 읽지 못했습니다. \(error.localizedDescription)" }
                restoreVoiceFence(connection: saved)
                // A saved connection means any pending pairing attempt either
                // produced it or is stale; it must not resurrect.
                pairing.discardAdoptedAttempt()
            }
        } catch { self.error = error.localizedDescription }
        configurePairingApproval()
    }

    // Approved pairing completes through the EXISTING connect path —
    // bootstrap probe, scoped API, Keychain save — with the same fresh key
    // the attempt generated. No owner-scope fallback, no manual key entry.
    private func configurePairingApproval() {
        pairing.onApproved = { [weak self] origin, key in
            guard let self, self.connection == nil else { return false }
            await self.connect(server: origin, token: key)
            return self.connection != nil
        }
    }

    func handlePairingURL(_ url: URL) {
        guard connection == nil else { return }
        pairing.handleDeepLink(url)
    }
    private func storageDirectory(_ connection: Connection) -> URL {
        let key = SHA256.hash(data: Data(connection.origin.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return URL.applicationSupportDirectory.appending(path: "Ghost/\(key)")
    }

    // Restores a persisted voice fence after relaunch as needs-reconcile
    // state only: no audio, no CallKit, never an automatic media reconnect.
    // A crash mid-call leaves the offer outcome unknown, so an in-progress
    // record is promoted to an unknown start before it can gate new calls.
    private func restoreVoiceFence(connection: Connection) {
        let store = VoiceCallFenceStore(file: storageDirectory(connection).appending(path: "voice-fence.json"))
        voiceFenceStore = store
        do {
            guard var fence = try store.load() else {
                voiceFenceIssue = nil
                return
            }
            if fence.kind == .inProgress {
                fence.kind = .unknownStart
                try store.save(fence)
            }
            voiceCallFence = fence
            voiceSession = VoiceMediaSession(
                transport: makeAPI(connection),
                startID: fence.startID,
                restoringPCID: fence.pcID,
                unresolvedStart: fence.pcID == nil)
            voiceFenceIssue = "이전 통화의 서버 상태 확인이 필요합니다. 상태를 확인하기 전까지 새 통화를 시작할 수 없습니다."
        } catch {
            voiceFenceIssue = "저장된 통화 상태를 읽지 못했습니다. 원본을 복구하기 전까지 새 통화를 시작할 수 없습니다."
        }
    }

    // The stable principal of the current authenticated connection; nil
    // means the bootstrap did not provide a safe binding and reconciliation
    // fails closed.
    private func voiceFenceIdentity() -> VoiceCallConnectionIdentity? {
        guard let connection else { return nil }
        return VoiceCallConnectionIdentity(bootstrap: bootstrap, origin: connection.origin.absoluteString)
    }

    private var uiFixtureSession: URLSession? {
        #if DEBUG
        if MobileUIFixture.enabled && connection?.origin.host() == "ui-test.invalid" { return MobileUIFixture.session }
        #endif
        return nil
    }
    private func makeAPI(_ connection: Connection) -> GhostAPI {
        GhostAPI(connection: connection, pendingFile: storageDirectory(connection).appending(path: "pending.json"), session: uiFixtureSession)
    }
    private func configuredAPI(_ connection: Connection, bootstrap: JSON) throws -> GhostAPI {
        guard bootstrap["protocol"].text == "ghost-mobile", bootstrap["version"] == .number(1) else {
            throw MobileError.response("지원하지 않는 Ghost 서버입니다.")
        }
        if bootstrap["role"].text == "owner" { return makeAPI(connection) }
        guard bootstrap["role"].text == "lifetime",
              let deviceID = UUID(uuidString: bootstrap["device"]["id"].text),
              bootstrap["scope"]["kind"].text == "lifetime",
              bootstrap["lifetime_identity"]["actor_ref"].text == "owner",
              case .number(let epoch) = bootstrap["lifetime_identity"]["authority_epoch"],
              epoch.isFinite, epoch > 0, epoch.rounded(.towardZero) == epoch, epoch <= 9_007_199_254_740_991,
              let workspaceID = UUID(uuidString: bootstrap["lifetime_host"]["workspace_id"].text),
              bootstrap["lifetime_host"]["authority_epoch"] == .number(epoch),
              case .bool(let dispatchEnabled) = bootstrap["lifetime_host"]["dispatch_enabled"] else {
            throw MobileError.response("이 기기의 업무 범위와 서버 권한을 확인하지 못했습니다.")
        }
        let identity = try LifetimeIdentity(authorityEpoch: UInt64(epoch))
        let namespace = try LifetimeJournalNamespace(workspaceID: workspaceID.uuidString,
            deviceID: deviceID.uuidString, authorityEpoch: identity.authority_epoch)
        return GhostAPI(connection: connection,
            pendingFile: storageDirectory(connection).appending(path: "pending.json"),
            lifetimeIdentity: identity, lifetimeNamespace: namespace, dispatchEnabled: dispatchEnabled,
            lifetimeCapabilities: Set(bootstrap["scope"]["capabilities"].items.map(\.text)), session: uiFixtureSession)
    }
    private func parseLifetimeTargets(_ value: JSON) throws -> [LifetimeConversationTarget] {
        guard case .array(let advertised) = value["target_pairs"] else {
            throw MobileError.response("Gateway did not advertise canonical conversation targets.")
        }
        let ghostScope = Set(value["scope"]["ghost_ids"].items.map(\.text))
        let conversationScope = Set(value["scope"]["conversation_ids"].items.map(\.text))
        var targets: [String: LifetimeConversationTarget] = [:]
        for item in advertised {
            let rolesValue = item["roles"]
            guard !item["ghost_id"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !item["conversation_id"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  ["primary", "specialist"].contains(item["kind"].text),
                  ["active", "draining"].contains(item["mode"].text),
                  case .array(let roleValues) = rolesValue,
                  roleValues.allSatisfy({ if case .string(let role) = $0 { return !role.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }; return false }) else {
                throw MobileError.response("Gateway advertised a malformed conversation target.")
            }
            let ghostID = item["ghost_id"].text
            let conversationID = item["conversation_id"].text
            guard ghostScope.contains(ghostID), conversationScope.contains(conversationID) else {
                throw MobileError.response("Gateway advertised a target outside the exact device scope.")
            }
            let target = LifetimeConversationTarget(
                ghostID: ghostID,
                conversationID: conversationID,
                kind: item["kind"].text,
                roles: roleValues.map(\.text),
                mode: item["mode"].text
            )
            if let previous = targets[target.id], previous != target {
                throw MobileError.response("Gateway advertised conflicting metadata for one conversation pair.")
            }
            targets[target.id] = target
        }
        return targets.values.sorted { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }
    }

    private func acceptBootstrap(_ value: JSON) {
        guard bootstrap != value else { return }
        bootstrap = value
        isLifetimeConnection = value["role"].text == "lifetime"
        lifetimeScope = isLifetimeConnection ? value["scope"] : .null
        lifetimeGhostIDs = Set(lifetimeScope["ghost_ids"].items.map(\.text))
        lifetimeConversationIDs = Set(lifetimeScope["conversation_ids"].items.map(\.text))
        lifetimeCapabilities = Set(lifetimeScope["capabilities"].items.map(\.text))
        let media = value["voice_media"]
        voiceMediaGhostID = media["ghost_id"].text
        voiceMediaConversationID = media["conversation_id"].text
        if isLifetimeConnection {
            do {
                lifetimeConversationTargets = try parseLifetimeTargets(value)
                lifetimeTargetIssue = nil
            } catch {
                lifetimeConversationTargets = []
                lifetimeTargetIssue = error.localizedDescription
            }
        } else {
            lifetimeConversationTargets = []
            lifetimeTargetIssue = nil
        }
    }
    private func receiveSnapshot(_ api: GhostAPI, bootstrap: JSON) async throws -> JSON {
        let lifetime = bootstrap["role"].text == "lifetime"
        if lifetime && !bootstrap["scope"]["capabilities"].items.contains(.string("lifetime.read")) { return .null }
        let value = try await (lifetime ? api.lifetimeSnapshot() : api.ownerSnapshot())
        try validate(value, lifetime: lifetime)
        return value
    }
    func connect(server: String, token: String) async {
        busy = true; defer { busy = false }
        do {
            let value = try Connection(server: server, token: token)
            let probe = makeAPI(value)
            let bootstrap = try await probe.bootstrap()
            let candidate = try configuredAPI(value, bootstrap: bootstrap)
            let current = try await receiveSnapshot(candidate, bootstrap: bootstrap)
            let savedDrafts = try ConversationDrafts(file: storageDirectory(value).appending(path: "drafts.json"))
            try CredentialStore.save(value)
            connection = value; api = candidate; snapshot = current; isOnline = true; error = nil
            acceptBootstrap(bootstrap)
            // Reloads any persisted fence for this origin (idempotent) so a
            // fresh connect after relaunch still gates new calls.
            restoreVoiceFence(connection: value)
            drafts = savedDrafts; draftError = nil
            pending = try await candidate.pendingCommands()
        } catch { self.error = error.localizedDescription }
    }
    private func validate(_ value: JSON, lifetime: Bool) throws {
        if lifetime {
            guard value["protocol_version"].text == "ghost-lifetime/1", value["contract_revision"] == .number(1),
                  case .array = value["goals"], case .array = value["work"], case .array = value["bindings"],
                  case .array = value["artifacts"], case .array = value["acceptances"] else {
                throw MobileError.response("업무 상태의 서버 계약을 확인하지 못했습니다.")
            }
        } else {
            guard !value["workspace_id"].text.isEmpty, value["host_protocol_version"] == .number(1) else { throw MobileError.response("Ghost 서버 버전을 확인해 주세요.") }
        }
    }
    func refresh() async {
        #if DEBUG
        if connection?.origin.host() == "ui-test.invalid", ProcessInfo.processInfo.arguments.contains("--ui-testing-incoming") {
            fixtureRefreshes += 1
            if fixtureRefreshes == 7 { appendUITestMessage() }
        }
        #endif
        guard let original = api, let connection else { return }
        do {
            let bootstrap = try await original.bootstrap()
            let candidate = bootstrap == self.bootstrap ? original : try configuredAPI(connection, bootstrap: bootstrap)
            let current = try await receiveSnapshot(candidate, bootstrap: bootstrap)
            guard self.api === original, self.connection == connection else { return }
            self.api = candidate; acceptBootstrap(bootstrap)
            snapshot = current; isOnline = true; connectionError = nil; pending = try await candidate.pendingCommands()
            await retryPendingPushToken()
            // A retained unresolved call retries through the fresh
            // connection, and the start observation settles it if possible.
            await resolveVoiceCallFence()
        } catch is CancellationError { }
        catch { if self.api === original { isOnline = false; self.connectionError = error.localizedDescription } }
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
    func sendLifetime(_ body: JSON, expectedRevision: UInt64? = nil) async throws -> JSON {
        guard isLifetimeConnection, let api else { throw MobileError.response("업무 범위가 설정된 기기로 먼저 연결해 주세요.") }
        guard !busy else { throw MobileError.response("앞선 요청의 접수 결과를 확인 중입니다.") }
        busy = true; defer { busy = false }
        do {
            let result: JSON
            if body["method"] == .string("conversation.input") {
                let expectedFields: Set<String> = ["method", "ghost_id", "conversation_id", "text", "privacy", "attachments"]
                guard case .object(let fields) = body,
                      Set(fields.keys) == expectedFields,
                      case .string(let ghostID) = body["ghost_id"],
                      case .string(let conversationID) = body["conversation_id"],
                      case .string(let text) = body["text"],
                      case .string(let privacy) = body["privacy"],
                      case .array(let attachments) = body["attachments"],
                      expectedRevision == nil else {
                    throw MobileError.response("정본 대화 입력의 body 형식이 계약과 일치하지 않습니다.")
                }
                result = try await api.submitLifetimeConversation(
                    ghostID: ghostID,
                    conversationID: conversationID,
                    text: text,
                    privacy: privacy,
                    attachments: attachments
                )
            } else {
                result = try await api.lifetimeAction(body, expectedRevision: expectedRevision)
            }
            await refresh()
            guard result["status"].text == "success" else { throw MobileError.response(result["summary"].text) }
            return result
        } catch {
            if self.api === api {
                pending = (try? await api.pendingCommands()) ?? pending
                self.error = error.localizedDescription
            }
            throw error
        }
    }
    func retryPending(_ envelope: Envelope) async {
        guard !busy, let api else { return }
        busy = true; defer { busy = false }
        do {
            if envelope.command["type"].text == "lifetime" {
                let receipt = try await api.inspectLifetimeCommand(envelope)
                guard self.api === api else { return }
                await refresh()
                if receipt.status != .confirmedSuccess && receipt.status != .confirmedNoEffect {
                    self.error = "원래 요청의 접수 결과가 아직 확인되지 않았습니다. 요청 ID와 기록을 보존했습니다."
                }
            } else {
                _ = try await api.retry(envelope)
                guard self.api === api else { return }
                await refresh()
            }
        } catch {
            if self.api === api {
                pending = (try? await api.pendingCommands()) ?? pending
                self.error = error.localizedDescription
            }
        }
    }
    func perform(_ command: JSON) async {
        busy = true; defer { busy = false }
        _ = try? await send(command)
    }
    func disconnect() {
        do {
            try drafts?.save()
            // Ending the call stops the local microphone immediately; the
            // unresolved-call fence is intentionally NOT cleared here — an
            // ambiguous server outcome must survive disconnect/reconnect.
            activeCall?.end()
            activeCall = nil
            try CredentialStore.remove(); connection = nil; api = nil; snapshot = .null; pending = []; isOnline = false
            drafts = nil; draftError = nil
            isLifetimeConnection = false; lifetimeScope = .null; bootstrap = .null
            lifetimeGhostIDs = []; lifetimeConversationIDs = []; lifetimeConversationTargets = []; lifetimeTargetIssue = nil; lifetimeCapabilities = []
            voiceMediaGhostID = ""; voiceMediaConversationID = ""
            ownerQuestions = []; ownerQuestionsError = nil; isDecidingQuestion = false
            lifecycleResult = nil; loadedArtifacts = [:]
            notifications = []; notificationError = nil; notificationAckIssue = nil; chatRoute = nil; lifetimeRouteTarget = nil
            pushStatus = nil
        }
        catch { self.error = error.localizedDescription }
    }
    @discardableResult func saveDrafts() -> Bool {
        guard let drafts else { return false }
        do { try drafts.save(); draftError = nil; return true }
        catch { draftError = "초안을 저장하지 못했습니다. \(error.localizedDescription)"; return false }
    }

    // MARK: Owner decision surface (questions, decisions, lifecycle, documents)

    func loadOwnerQuestions() async {
        guard isLifetimeConnection, isOnline, lifetimeCapabilities.contains("lifetime.read"), let api else {
            ownerQuestions = []
            return
        }
        do {
            ownerQuestions = try await api.ownerQuestions()
            ownerQuestionsError = nil
        } catch {
            ownerQuestionsError = error.localizedDescription
        }
    }

    // Records the owner's exact decision. The reply is returned so the screen
    // can show the recorded action state and the truthful wake result; a
    // refused wake or a stale action is never presented as an execution.
    func decideOwnerQuestion(_ question: OwnerQuestion, approve: Bool) async -> JSON? {
        guard !isDecidingQuestion, isOnline, let api else { return nil }
        isDecidingQuestion = true
        defer { isDecidingQuestion = false }
        do {
            let reply = try await api.decideOwnerQuestion(
                ghostID: question.ghostID, actionID: question.actionID, approve: approve)
            await loadOwnerQuestions()
            return reply
        } catch {
            ownerQuestionsError = error.localizedDescription
            return nil
        }
    }

    func runComputerLifecycle(ghostID: String, operation: String) async {
        guard isOnline, let api else { return }
        do {
            let reply = try await api.computerLifecycle(ghostID: ghostID, operation: operation)
            let result = reply["result"]
            lifecycleResult = LifecycleOutcome(
                ghostID: ghostID,
                operation: operation,
                status: result["status"].text,
                summary: result["summary"].text,
                detail: result["data"])
        } catch {
            lifecycleResult = LifecycleOutcome(
                ghostID: ghostID, operation: operation,
                status: "error", summary: error.localizedDescription, detail: .null)
        }
    }

    // Opens one current artifact of a work. Bytes arrive digest-verified from
    // the transport; failures keep the metadata-only row with the real reason.
    func loadArtifact(workID: String, executionID: String, digest: String, locator: String) async {
        let key = "\(workID):\(digest)"
        if let existing = loadedArtifacts[key], existing.content != nil || existing.isLoading { return }
        loadedArtifacts[key] = LoadedArtifact(content: nil, error: nil, isLoading: true)
        guard let api else {
            loadedArtifacts[key] = LoadedArtifact(content: nil, error: "서버에 먼저 연결해 주세요.", isLoading: false)
            return
        }
        do {
            let content = try await api.readWorkArtifact(
                workID: workID, executionID: executionID, digest: digest, locator: locator)
            loadedArtifacts[key] = LoadedArtifact(content: content, error: nil, isLoading: false)
        } catch {
            loadedArtifacts[key] = LoadedArtifact(content: nil, error: error.localizedDescription, isLoading: false)
        }
    }

    func artifactState(workID: String, digest: String) -> LoadedArtifact? {
        loadedArtifacts["\(workID):\(digest)"]
    }

    // MARK: Push registration, notification inbox, and active call ownership

    func retryPendingPushToken() async {
        guard let token = pendingPushToken, let api, isOnline else { return }
        do {
            try await api.registerPushToken(token, environment: PushEnvironment.current)
            pendingPushToken = nil
            pushStatus = nil
        } catch {
            pushStatus = "알림 토큰 등록이 실패했습니다. 연결 후 다시 시도됩니다."
        }
    }

    var notificationRecipientIDs: [String] {
        isLifetimeConnection ? lifetimeGhostIDs.sorted() : profiles.map(\.id).sorted()
    }

    func loadNotifications() async {
        guard let api else { return }
        var entries: [NotificationEntry] = []
        var failure: String?
        for recipient in notificationRecipientIDs {
            do {
                for item in try await api.notificationInbox(recipientID: recipient) {
                    entries.append(NotificationEntry(recipientID: recipient, notification: item))
                }
            } catch {
                failure = error.localizedDescription
            }
        }
        notifications = entries
        notificationError = failure
    }

    func openNotification(notificationID: String) async {
        await loadNotifications()
        // A push tap routes to exactly the tapped notification; an unknown
        // or absent id never falls back to an unrelated row.
        guard let entry = notifications.first(where: { $0.notification.id == notificationID }) else {
            notificationError = notificationError ?? "알림 대상을 찾지 못했습니다. 진행 중 화면에서 결과를 확인해 주세요."
            return
        }
        markNotificationSeen(entry)
        if isLifetimeConnection {
            lifetimeRouteTarget = LifetimeRouteTarget(ghostID: entry.recipientID, conversationID: entry.notification.conversationID)
        } else {
            chatRoute = ChatRoute(profileID: entry.recipientID, conversationID: entry.notification.conversationID)
        }
    }

    func markNotificationSeen(_ entry: NotificationEntry) {
        guard entry.notification.state != "client_seen", let api else { return }
        Task {
            do {
                // acknowledgeNotification only returns after the Host
                // accepted this exact recipient, notification, and
                // resulting state.
                try await api.acknowledgeNotification(
                    recipientID: entry.recipientID,
                    notificationID: entry.notification.id,
                    state: "client_seen")
                notificationAckIssue = nil
                if let index = notifications.firstIndex(where: { $0.id == entry.id }) {
                    let item = notifications[index]
                    notifications[index] = NotificationEntry(
                        recipientID: item.recipientID,
                        notification: MobileNotification(id: item.notification.id, conversationID: item.notification.conversationID,
                            workID: item.notification.workID, goalRevision: item.notification.goalRevision,
                            eventKind: item.notification.eventKind, state: "client_seen"))
                }
            } catch {
                // Without a confirmed Host acceptance the notification stays
                // pending and the reason remains visible.
                notificationAckIssue = error.localizedDescription
            }
        }
    }

    func startVoiceCall(profileID: String, conversationID: String) -> Bool {
        // One bound call at a time, and never a new call while a previous
        // one has unresolved server state (in progress, unknown start, or
        // unconfirmed end).
        guard let api, activeCall == nil, voiceCallFence == nil, voiceFenceIssue == nil,
              let identity = voiceFenceIdentity(), let store = voiceFenceStore else { return false }
        let startID = UUID().uuidString.lowercased()
        let session = VoiceMediaSession(transport: api, startID: startID)
        // The fence is durable BEFORE any offer is dispatched: a crash after
        // dispatch must still leave the unknown-start record on disk.
        let fence = VoiceCallFence(
            startID: startID, pcID: nil, kind: .inProgress,
            ghostID: profileID, conversationID: conversationID,
            origin: identity.origin, workspaceID: identity.workspaceID, deviceID: identity.deviceID,
            authorityEpoch: identity.authorityEpoch, createdAt: .now)
        do { try store.save(fence) } catch {
            voiceFenceIssue = "통화 상태를 안전하게 저장하지 못해 통화를 시작하지 않았습니다."
            return false
        }
        voiceSession = session
        voiceCallFence = fence
        let controller = VoiceCallController(api: api, profileID: profileID, conversationID: conversationID, session: session)
        controller.onServerOutcome = { [weak self] outcome in
            self?.applyVoiceCallOutcome(outcome)
        }
        activeCall = controller
        controller.start()
        return true
    }

    private func applyVoiceCallOutcome(_ outcome: VoiceCallController.ServerOutcome) {
        switch outcome {
        case .identified(let pcID):
            voiceCallFence?.pcID = pcID
            persistVoiceFence()
        case .confirmedEnd, .resolvedWithoutSession:
            // Durable clear only on authoritative closure (or proof that no
            // server session was ever created).
            voiceCallFence = nil
            voiceSession = nil
            voiceFenceIssue = nil
            voiceFenceStore?.remove()
        case .unconfirmedEnd(let pcID):
            if let fence = voiceCallFence {
                voiceCallFence = VoiceCallFence(startID: fence.startID, pcID: pcID, kind: .unconfirmedEnd,
                    ghostID: fence.ghostID, conversationID: fence.conversationID, origin: fence.origin,
                    workspaceID: fence.workspaceID, deviceID: fence.deviceID,
                    authorityEpoch: fence.authorityEpoch, createdAt: fence.createdAt)
                persistVoiceFence()
            }
        case .unknownStart:
            if let fence = voiceCallFence {
                voiceCallFence = VoiceCallFence(startID: fence.startID, pcID: nil, kind: .unknownStart,
                    ghostID: fence.ghostID, conversationID: fence.conversationID, origin: fence.origin,
                    workspaceID: fence.workspaceID, deviceID: fence.deviceID,
                    authorityEpoch: fence.authorityEpoch, createdAt: fence.createdAt)
                persistVoiceFence()
            }
        }
    }

    private func persistVoiceFence() {
        guard let fence = voiceCallFence else { return }
        // The server-side per-device ledger remains the authority that gates
        // a second start; this file is the client's durable memory.
        try? voiceFenceStore?.save(fence)
    }

    // Reconciliation for an unresolved previous call — only through the
    // original gateway, workspace, registered device, and authority
    // generation. A known session identifier is retried directly with the
    // same identifier; an unknown start is checked against the agreed start
    // observation. Only a server-confirmed end — or definitive
    // never-created evidence — clears the fence; a lost response, a foreign
    // connection, or a wrong-namespace 404 never counts as closure.
    func resolveVoiceCallFence() async {
        guard !resolvingVoiceFence, isOnline, let api,
              let fence = voiceCallFence, fence.kind != .inProgress,
              let session = voiceSession else { return }
        guard let identity = voiceFenceIdentity() else {
            voiceFenceIssue = "이 연결의 기기·작업 공간 신원을 확인하지 못해 이전 통화 상태를 확인하지 않았습니다."
            return
        }
        guard isVoiceCallFence(fence, boundTo: identity) else {
            voiceFenceIssue = "이 연결은 이전 통화를 시작한 게이트웨이·기기가 아닙니다. 원래 연결에서 상태를 확인해 주세요."
            return
        }
        resolvingVoiceFence = true
        defer { resolvingVoiceFence = false }
        if fence.pcID != nil {
            await retryUnconfirmedVoiceEnd(session: session, transport: api)
            return
        }
        do {
            switch try await api.voiceStartState(startID: fence.startID) {
            case .ended, .unknownStart:
                voiceCallFence = nil
                voiceSession = nil
                voiceFenceIssue = nil
                voiceFenceStore?.remove()
            case .live(let pcID):
                await session.adoptTransport(api)
                try await session.adopt(pcID: pcID)
                voiceCallFence = VoiceCallFence(startID: fence.startID, pcID: pcID, kind: .unconfirmedEnd,
                    ghostID: fence.ghostID, conversationID: fence.conversationID, origin: fence.origin,
                    workspaceID: fence.workspaceID, deviceID: fence.deviceID,
                    authorityEpoch: fence.authorityEpoch, createdAt: fence.createdAt)
                persistVoiceFence()
                try await session.end()
                voiceCallFence = nil
                voiceSession = nil
                voiceFenceIssue = nil
                voiceFenceStore?.remove()
            }
        } catch {
            voiceFenceIssue = "이전 통화 상태가 아직 확인되지 않았습니다. \(error.localizedDescription)"
        }
    }

    private func retryUnconfirmedVoiceEnd(session: VoiceMediaSession, transport: GhostAPI) async {
        await session.adoptTransport(transport)
        do {
            try await session.end()
            voiceCallFence = nil
            voiceSession = nil
            voiceFenceIssue = nil
            voiceFenceStore?.remove()
        } catch {
            voiceFenceIssue = "서버 통화 종료가 아직 확인되지 않았습니다. \(error.localizedDescription)"
        }
    }

    func activeCallDidEnd() {
        if activeCall?.phase == .ended { activeCall = nil }
    }
    func draftAddress(profileID: String, conversationID: String) -> DraftAddress {
        let workspaceID = isLifetimeConnection ? bootstrap["lifetime_host"]["workspace_id"].text : snapshot["workspace_id"].text
        return DraftAddress(workspaceID: workspaceID, profileID: profileID, conversationID: conversationID)
    }
    func acknowledge(_ envelope: Envelope) async {
        guard envelope.command["type"].text != "lifetime" else {
            self.error = "미확정 업무 요청은 원래 영수증을 확인해야 닫을 수 있습니다."
            return
        }
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
        guard ProcessInfo.processInfo.arguments.contains("--ui-testing") || MobileUIFixture.enabled else { return false }
        let directory = URL.applicationSupportDirectory.appending(path: "GhostUITests")
        do {
            if ProcessInfo.processInfo.arguments.contains("--reset-fixture"), FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
            connection = try Connection(server: "https://ui-test.invalid", token: String(repeating: "0", count: 64))
            drafts = try ConversationDrafts(file: directory.appending(path: "drafts.json"))
            if MobileUIFixture.enabled {
                acceptBootstrap(MobileUIFixture.bootstrap)
                snapshot = MobileUIFixture.snapshot
                api = try configuredAPI(connection!, bootstrap: MobileUIFixture.bootstrap)
                isOnline = true
                return true
            }
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
