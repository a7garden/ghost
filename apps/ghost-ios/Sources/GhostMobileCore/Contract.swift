import Foundation

// Codable mirrors of packages/ghost-contract for the subsets the phone reads.
// Field names follow the contract exactly (camelCase); timestamps are epoch
// milliseconds. Decoders ignore contract fields the phone does not use.

/// Epoch milliseconds → Date.
public func contractDate(_ ms: Int) -> Date {
    Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
}

public struct ModelRef: Codable, Hashable, Sendable {
    public var provider: String
    public var model: String
    public var thinking: String?
}

public struct Look: Codable, Hashable, Sendable {
    public var avatarId: String?
    public var body: String?
    public var background: String?

    public init(avatarId: String?, body: String? = nil, background: String? = nil) {
        self.avatarId = avatarId
        self.body = body
        self.background = background
    }
}

public enum GhostState: String, Codable, Sendable {
    case active, paused, retired
}

public struct Ghost: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var persona: String
    public var look: Look
    public var model: ModelRef?
    public var isDefault: Bool
    public var state: GhostState
    public var directConversationId: String
    public var createdAt: Int
    public var updatedAt: Int

    public init(id: String, name: String, persona: String, look: Look, model: ModelRef?, isDefault: Bool, state: GhostState, directConversationId: String, createdAt: Int, updatedAt: Int) {
        self.id = id; self.name = name; self.persona = persona; self.look = look; self.model = model
        self.isDefault = isDefault; self.state = state; self.directConversationId = directConversationId
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

public enum ConversationKind: String, Codable, Sendable {
    case direct, work, review
}

public struct Conversation: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var ghostId: String
    public var kind: ConversationKind
    public var workId: String?
    public var title: String
    public var busy: Bool
    public var createdAt: Int
    public var lastActivityAt: Int

    public init(id: String, ghostId: String, kind: ConversationKind, workId: String?, title: String, busy: Bool, createdAt: Int, lastActivityAt: Int) {
        self.id = id; self.ghostId = ghostId; self.kind = kind; self.workId = workId
        self.title = title; self.busy = busy; self.createdAt = createdAt; self.lastActivityAt = lastActivityAt
    }
}

public struct ArtifactRef: Codable, Hashable, Sendable {
    public var digest: String
    public var name: String
    public var mediaType: String
    public var size: Int
}

public struct WorkResult: Codable, Hashable, Sendable {
    public var summary: String
    public var artifacts: [ArtifactRef]
}

public struct Work: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var parentId: String?
    public var rootId: String
    public var ghostId: String
    public var originConversationId: String
    public var conversationId: String?
    public var title: String
    public var brief: String
    public var acceptance: Acceptance
    public var state: WorkState
    public var revision: Int
    public var revisionsUsed: Int
    public var deadlineAt: Int?
    public var result: WorkResult?
    public var verdict: Verdict?
    public var reason: String?
    public var createdAt: Int
    public var startedAt: Int?
    public var endedAt: Int?
    public var updatedAt: Int

    public init(id: String, parentId: String?, rootId: String, ghostId: String, originConversationId: String, conversationId: String?,
                title: String, brief: String, acceptance: Acceptance, state: WorkState, revision: Int, revisionsUsed: Int,
                deadlineAt: Int?, result: WorkResult?, verdict: Verdict?, reason: String?,
                createdAt: Int, startedAt: Int?, endedAt: Int?, updatedAt: Int) {
        self.id = id; self.parentId = parentId; self.rootId = rootId; self.ghostId = ghostId
        self.originConversationId = originConversationId; self.conversationId = conversationId
        self.title = title; self.brief = brief; self.acceptance = acceptance; self.state = state
        self.revision = revision; self.revisionsUsed = revisionsUsed; self.deadlineAt = deadlineAt
        self.result = result; self.verdict = verdict; self.reason = reason
        self.createdAt = createdAt; self.startedAt = startedAt; self.endedAt = endedAt; self.updatedAt = updatedAt
    }
}

public struct Verdict: Codable, Hashable, Sendable {
    public var outcome: String
    public var source: String
    public var reasons: String
    public var at: Int
}

public struct Acceptance: Codable, Hashable, Sendable {
    public var criteria: String

    public init(criteria: String) { self.criteria = criteria }
}

public enum WorkState: String, Codable, Sendable, CaseIterable {
    case queued, running, waiting, verifying, blocked, done, failed, cancelled

    public var isTerminal: Bool { self == .done || self == .failed || self == .cancelled }
}

public enum DecisionKind: String, Codable, Sendable, CaseIterable {
    case approve_effect
    case question
    case accept_result
    case document_review
    case reconcile_effect
}

public enum DecisionState: String, Codable, Sendable {
    case pending, approved, denied, answered, cancelled
}

public struct Decision: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: DecisionKind
    public var ghostId: String
    public var conversationId: String
    public var workId: String?
    public var effectId: String?
    public var title: String
    public var detail: String
    public var options: [String]
    public var proposal: JSON?
    public var state: DecisionState
    public var answer: String?
    public var createdAt: Int
    public var resolvedAt: Int?

    public var isPending: Bool { state == .pending }
}

public enum NotificationKind: String, Codable, Sendable {
    case decision
    case work_done
    case work_failed
    case message
}

/// Contract `Notification`; renamed because Swift's Foundation type shares the name.
public struct GhostNotification: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: NotificationKind
    public var ghostId: String?
    public var conversationId: String?
    public var workId: String?
    public var decisionId: String?
    public var title: String
    public var body: String
    public var createdAt: Int
    public var readAt: Int?

    public var isRead: Bool { readAt != nil }
}

public struct ToolCallView: Codable, Hashable, Sendable {
    public var callId: String
    public var name: String
    public var args: String
}

public struct MessageToolInfo: Codable, Hashable, Sendable {
    public var callId: String
    public var name: String
    public var isError: Bool
}

public enum MessageRole: String, Codable, Sendable {
    case user, assistant, tool, note
}

public struct Message: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var conversationId: String
    public var role: MessageRole
    public var origin: String?
    public var text: String
    public var toolCalls: [ToolCallView]
    public var tool: MessageToolInfo?
    public var attachments: [ArtifactRef]
    public var createdAt: Int

    public var isFromUser: Bool { role == .user }

    public init(
        id: String, conversationId: String, role: MessageRole, origin: String?, text: String,
        toolCalls: [ToolCallView] = [], tool: MessageToolInfo? = nil, attachments: [ArtifactRef] = [], createdAt: Int
    ) {
        self.id = id
        self.conversationId = conversationId
        self.role = role
        self.origin = origin
        self.text = text
        self.toolCalls = toolCalls
        self.tool = tool
        self.attachments = attachments
        self.createdAt = createdAt
    }

    public static func assistant(id: String, conversationId: String, text: String) -> Message {
        Message(id: id, conversationId: conversationId, role: .assistant, origin: nil, text: text, createdAt: 1)
    }
}

public struct LiveTool: Codable, Hashable, Sendable {
    public var callId: String
    public var name: String
    public var output: String
}

public struct Live: Codable, Hashable, Sendable {
    public var conversationId: String
    public var running: Bool
    public var partial: String?
    public var tools: [LiveTool]
}

public struct Effect: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var workId: String?
    public var conversationId: String
    public var tool: String
    public var summary: String
    public var state: String
    public var result: String?
    public var createdAt: Int
    public var endedAt: Int?
}

public struct DeviceGrant: Codable, Hashable, Sendable {
    public var ghostId: String
    public var conversationId: String?

    public init(ghostId: String, conversationId: String?) {
        self.ghostId = ghostId
        self.conversationId = conversationId
    }
}

public struct Runtime: Codable, Hashable, Sendable {
    public var ready: Bool
    public var detail: String
    public var version: String

    public init(ready: Bool, detail: String, version: String) {
        self.ready = ready; self.detail = detail; self.version = version
    }
}

/// Contract `Principal`: owner or a device with its grants.
public enum Principal: Codable, Hashable, Sendable {
    case owner
    case device(deviceId: String, name: String, grants: [DeviceGrant])

    public var grants: [DeviceGrant] {
        if case .device(_, _, let grants) = self { return grants }
        return []
    }

    private enum CodingKeys: String, CodingKey { case kind, deviceId, name, grants }
    private enum Kind: String, Decodable { case owner, device }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .owner:
            self = .owner
        case .device:
            self = .device(
                deviceId: try container.decode(String.self, forKey: .deviceId),
                name: try container.decode(String.self, forKey: .name),
                grants: try container.decode([DeviceGrant].self, forKey: .grants))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .owner:
            try container.encode("owner", forKey: .kind)
        case .device(let deviceId, let name, let grants):
            try container.encode("device", forKey: .kind)
            try container.encode(deviceId, forKey: .deviceId)
            try container.encode(name, forKey: .name)
            try container.encode(grants, forKey: .grants)
        }
    }
}

/// GET /api/state. Device principals receive only what their grants cover;
/// owner-only collections are omitted here because the phone never reads them.
public struct GhostStateSnapshot: Codable, Sendable {
    public var seq: Int
    public var principal: Principal
    public var runtime: Runtime
    public var ghosts: [Ghost]
    public var conversations: [Conversation]
    public var works: [Work]
    public var decisions: [Decision]
    public var notifications: [GhostNotification]

    public init(seq: Int, principal: Principal, runtime: Runtime, ghosts: [Ghost], conversations: [Conversation], works: [Work], decisions: [Decision], notifications: [GhostNotification]) {
        self.seq = seq; self.principal = principal; self.runtime = runtime
        self.ghosts = ghosts; self.conversations = conversations; self.works = works
        self.decisions = decisions; self.notifications = notifications
    }
}

/// GET /api/conversations/:id
public struct ConversationPage: Codable, Sendable {
    public var conversation: Conversation
    public var messages: [Message]
    public var before: String?
    public var live: Live?

    public init(conversation: Conversation, messages: [Message], before: String?, live: Live?) {
        self.conversation = conversation; self.messages = messages; self.before = before; self.live = live
    }
}

/// GET /api/works/:id
public struct WorkDetail: Codable, Sendable {
    public var work: Work
    public var ancestors: [Work]
    public var children: [Work]
    public var effects: [Effect]
    public var decisions: [Decision]
    public var artifacts: [ArtifactRef]
}

// MARK: - Events

/// SSE frames of GET /api/events.
public enum StreamFrame: Sendable, Equatable {
    case ledger(LedgerEvent)
    case live(LiveEvent)
    case reset(seq: Int)
}

// MARK: - Command payloads

/// When a work field is editable, keep / clear / leave alone.
public enum Editable<Value: Equatable & Sendable>: Sendable, Equatable {
    case keep
    case clear
    case set(Value)
}

/// Device commands (contract `DEVICE_COMMANDS`).
public enum DeviceCommand: Sendable, Equatable {
    case messageSend(conversationId: String, text: String)
    case messageCancel(conversationId: String)
    case workCreate(ghostId: String, title: String, brief: String, deadlineAt: Int?)
    case workUpdate(workId: String, title: Editable<String>, brief: Editable<String>, deadlineAt: Editable<Int>)
    case workCancel(workId: String)
    case workResume(workId: String)
    case decisionResolve(decisionId: String, outcome: DecisionOutcome, answer: String?)
    case notificationRead(notificationIds: [String])
    case pushRegister(token: String, environment: String)
}

public enum DecisionOutcome: String, Sendable {
    case approve, deny, answer
}

/// The command discriminator shared by the encoder and decoder.
private enum CommandTypeKey: String, CodingKey { case type }

extension DeviceCommand: Encodable {
    public func encode(to encoder: Encoder) throws {
        // One container for everything: requesting two differently-keyed
        // containers on the same encoder leaves the key order undefined.
        var container = encoder.container(keyedBy: AnyKey.self)
        func encodeField<T: Encodable>(_ key: String, _ value: T) throws {
            try container.encode(value, forKey: AnyKey(key))
        }
        func encodeIfPresent<T: Encodable>(_ key: String, _ value: T?) throws {
            try container.encodeIfPresent(value, forKey: AnyKey(key))
        }
        func editable<T: Encodable>(_ key: String, _ value: Editable<T>, clear: T) throws {
            switch value {
            case .keep: break
            case .clear: try encodeField(key, clear)
            case .set(let changed): try encodeField(key, changed)
            }
        }
        switch self {
        case .messageSend(let conversationId, let text):
            try container.encode("message.send", forKey: AnyKey("type"))
            try encodeField("conversationId", conversationId)
            try encodeField("text", text)
        case .messageCancel(let conversationId):
            try container.encode("message.cancel", forKey: AnyKey("type"))
            try encodeField("conversationId", conversationId)
        case .workCreate(let ghostId, let title, let brief, let deadlineAt):
            try container.encode("work.create", forKey: AnyKey("type"))
            try encodeField("ghostId", ghostId)
            try encodeField("title", title)
            try encodeField("brief", brief)
            try encodeIfPresent("deadlineAt", deadlineAt)
        case .workUpdate(let workId, let title, let brief, let deadlineAt):
            try container.encode("work.update", forKey: AnyKey("type"))
            try encodeField("workId", workId)
            try editable("title", title, clear: "")
            try editable("brief", brief, clear: "")
            // Explicit null clears the deadline; absence keeps it.
            switch deadlineAt {
            case .keep: break
            case .clear: try container.encodeNil(forKey: AnyKey("deadlineAt"))
            case .set(let value): try encodeField("deadlineAt", value)
            }
        case .workCancel(let workId):
            try container.encode("work.cancel", forKey: AnyKey("type"))
            try encodeField("workId", workId)
        case .workResume(let workId):
            try container.encode("work.resume", forKey: AnyKey("type"))
            try encodeField("workId", workId)
        case .decisionResolve(let decisionId, let outcome, let answer):
            try container.encode("decision.resolve", forKey: AnyKey("type"))
            try encodeField("decisionId", decisionId)
            try encodeField("outcome", outcome.rawValue)
            try encodeIfPresent("answer", answer)
        case .notificationRead(let notificationIds):
            try container.encode("notification.read", forKey: AnyKey("type"))
            try encodeField("notificationIds", notificationIds)
        case .pushRegister(let token, let environment):
            try container.encode("device.push_register", forKey: AnyKey("type"))
            try encodeField("token", token)
            try encodeField("environment", environment)
        }
    }
}

/// Hashable dynamic coding key for command bodies.
struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

extension DeviceCommand: Decodable {
    public init(from decoder: Decoder) throws {
        let type = try decoder.container(keyedBy: CommandTypeKey.self).decode(String.self, forKey: .type)
        let c = try decoder.container(keyedBy: AnyKey.self)
        func string(_ key: String) throws -> String { try c.decode(String.self, forKey: AnyKey(key)) }
        func int(_ key: String) throws -> Int { try c.decode(Int.self, forKey: AnyKey(key)) }
        func stringArray(_ key: String) throws -> [String] { try c.decode([String].self, forKey: AnyKey(key)) }
        func present<T: Decodable>(_ key: String) -> T? { try? c.decode(T.self, forKey: AnyKey(key)) }
        func isNull(_ key: String) -> Bool { (try? c.decodeNil(forKey: AnyKey(key))) == true }
        func editable<T: Decodable & Equatable>(_ key: String, clear: T) -> Editable<T> {
            if let value: T = present(key) { return .set(value) }
            if isNull(key) { return .clear }
            return .keep
        }
        func nullableInt(_ key: String) -> Int? { present(key) }
        switch type {
        case "message.send":
            self = .messageSend(conversationId: try string("conversationId"), text: try string("text"))
        case "message.cancel":
            self = .messageCancel(conversationId: try string("conversationId"))
        case "work.create":
            self = .workCreate(ghostId: try string("ghostId"), title: try string("title"), brief: try string("brief"), deadlineAt: nullableInt("deadlineAt"))
        case "work.update":
            self = .workUpdate(workId: try string("workId"), title: editable("title", clear: ""), brief: editable("brief", clear: ""), deadlineAt: editable("deadlineAt", clear: 0))
        case "work.cancel":
            self = .workCancel(workId: try string("workId"))
        case "work.resume":
            self = .workResume(workId: try string("workId"))
        case "decision.resolve":
            self = .decisionResolve(decisionId: try string("decisionId"), outcome: DecisionOutcome(rawValue: try string("outcome")) ?? .answer, answer: present("answer"))
        case "notification.read":
            self = .notificationRead(notificationIds: try stringArray("notificationIds"))
        case "device.push_register":
            self = .pushRegister(token: try string("token"), environment: try string("environment"))
        default:
            struct UnknownCommand: Error {}
            throw UnknownCommand()
        }
    }
}

/// `{ requestId, command }` request body; the same requestId is reused on retry.
public struct CommandRequest: Codable, Sendable {
    public var requestId: String
    public var command: DeviceCommand

    public init(requestId: String, command: DeviceCommand) {
        self.requestId = requestId
        self.command = command
    }
}

public enum CommandErrorCode: String, Codable, Sendable {
    case invalid, not_found, forbidden, conflict, unavailable, internal_error = "internal"
}

public struct ApiErrorBody: Codable, Sendable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
        self.code = code; self.message = message
    }
}

public struct CommandError: Error, Sendable {
    public var code: String
    public var message: String
}
