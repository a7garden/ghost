import Foundation

// Durable record of one voice call's unresolved server-side state. Metadata
// only: no tokens, no transcripts. The record exists so an ambiguous start or
// an unconfirmed end survives app relaunch and is never mistaken for closure
// — clearing requires authoritative server evidence obtained through the
// SAME gateway, workspace, and registered device that created the call.
public struct VoiceCallFence: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case inProgress
        case unknownStart
        case unconfirmedEnd
    }

    public let startID: String
    public var pcID: String?
    public var kind: Kind
    public let ghostID: String
    public let conversationID: String
    // Original connection binding. Reconciliation through any other
    // gateway origin, workspace, or registered device is refused before any
    // request leaves the device.
    public let origin: String
    public let workspaceID: String
    public let deviceID: String
    public let authorityEpoch: UInt64?
    public let createdAt: Date

    public init(startID: String, pcID: String?, kind: Kind, ghostID: String, conversationID: String,
                origin: String, workspaceID: String, deviceID: String, authorityEpoch: UInt64?, createdAt: Date) {
        self.startID = startID
        self.pcID = pcID
        self.kind = kind
        self.ghostID = ghostID
        self.conversationID = conversationID
        self.origin = origin
        self.workspaceID = workspaceID
        self.deviceID = deviceID
        self.authorityEpoch = authorityEpoch
        self.createdAt = createdAt
    }
}

// The stable principal of the CURRENT authenticated connection, taken from
// the gateway's authenticated bootstrap. device.id survives credential
// rotation on the same registration; a re-pair is a different device.
public struct VoiceCallConnectionIdentity: Equatable, Sendable {
    public let origin: String
    public let workspaceID: String
    public let deviceID: String
    public let authorityEpoch: UInt64?

    public init?(bootstrap: JSON, origin: String) {
        guard !origin.isEmpty else { return nil }
        let deviceID = bootstrap["device"]["id"].text
        let lifetime = bootstrap["role"].text == "lifetime"
        let workspaceID = lifetime ? bootstrap["lifetime_host"]["workspace_id"].text : bootstrap["workspace_id"].text
        guard !deviceID.isEmpty, deviceID.utf8.count <= 128, !workspaceID.isEmpty, workspaceID.utf8.count <= 128 else {
            // Without an authenticated device/workspace identity there is no
            // safe binding: fail closed instead of inventing scope.
            return nil
        }
        var epoch: UInt64?
        if lifetime {
            guard case .number(let value) = bootstrap["lifetime_host"]["authority_epoch"],
                  value > 0, value.rounded(.towardZero) == value, value <= 9_007_199_254_740_991 else { return nil }
            epoch = UInt64(value)
        }
        self.origin = origin
        self.workspaceID = workspaceID
        self.deviceID = deviceID
        self.authorityEpoch = epoch
    }

    public init(origin: String, workspaceID: String, deviceID: String, authorityEpoch: UInt64?) {
        self.origin = origin
        self.workspaceID = workspaceID
        self.deviceID = deviceID
        self.authorityEpoch = authorityEpoch
    }
}

/// Whether the fence may be reconciled through this connection at all. Only
/// the exact original gateway, workspace, registered device, and authority
/// generation may observe or end the recorded call.
public func isVoiceCallFence(_ fence: VoiceCallFence, boundTo identity: VoiceCallConnectionIdentity) -> Bool {
    guard fence.origin == identity.origin,
          fence.workspaceID == identity.workspaceID,
          fence.deviceID == identity.deviceID else { return false }
    return fence.authorityEpoch == identity.authorityEpoch
}

// One unresolved voice fence per origin directory, written before the offer
// is dispatched. Only ENOENT means absence; unreadable or corrupted evidence
// must block a new call instead of being overwritten as an empty slot.
public struct VoiceCallFenceStore: Sendable {
    public let file: URL

    public init(file: URL) {
        self.file = file
    }

    public func load() throws -> VoiceCallFence? {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: file)
        } catch {
            let failure = error as NSError
            if failure.domain == NSCocoaErrorDomain
                && (failure.code == NSFileReadNoSuchFileError || failure.code == NSFileNoSuchFileError) {
                return nil
            }
            throw error
        }
        defer { try? handle.close() }
        let limit = 16 * 1024
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        guard data.count <= limit else {
            throw MobileError.response("저장된 통화 상태가 너무 커서 확인하지 못했습니다.")
        }
        return try JSONDecoder().decode(VoiceCallFence.self, from: data)
    }

    public func save(_ fence: VoiceCallFence) throws {
        let data = try JSONEncoder().encode(fence)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    public func remove() {
        try? FileManager.default.removeItem(at: file)
    }
}
