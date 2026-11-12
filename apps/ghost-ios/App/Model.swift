import Foundation
import Security
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

/// The shell's state: which Host this iPhone is paired with, and the native events
/// (push taps) waiting for the web UI. Every Ghost surface lives in the web UI.
@MainActor @Observable final class GhostModel {
    private(set) var connection: Connection?
    let pairing: PairingModel
    var error: String?
    /// Events for the page, delivered in order once it reports ready.
    private(set) var outbox: [ShellEvent] = []

    @ObservationIgnored private var pendingPushToken: String?

    init() {
        pairing = PairingModel(store: PairingKeychainStore())
        pairing.onApproved = { [weak self] origin, deviceId, token in
            self?.connectPaired(origin: origin, deviceId: deviceId, token: token) ?? false
        }
        #if DEBUG
        if let fixture = MobileUIFixture.connection {
            connection = fixture
            return
        }
        if MobileUIFixture.pairing {
            if ProcessInfo.processInfo.arguments.contains("--pairing-issue") {
                pairing.error = "연결 코드가 만료되었거나 이미 사용되었습니다. PC에서 새 코드를 만들어 주세요."
            }
            return
        }
        #endif
        do {
            if let saved = try CredentialStore.load() {
                connection = saved
                // A saved connection means any pending pairing attempt either
                // produced it or is stale; it must not resurrect.
                pairing.discardAdoptedAttempt()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Completes a pairing: stores the credential; the shell opens the Host right away.
    func connectPaired(origin: URL, deviceId: String, token: String) -> Bool {
        guard connection == nil else { return true }
        do {
            let saved = try Connection(origin: origin.absoluteString, deviceId: deviceId, token: token)
            try CredentialStore.save(saved)
            connection = saved
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Forgets this Host on the phone. Revocation on the Host is the page's job
    /// (`device.revoke`) or already happened when the Host answered 401.
    func disconnect() {
        do {
            try CredentialStore.remove()
        } catch {
            self.error = error.localizedDescription
            return
        }
        connection = nil
        outbox = []
        pendingPushToken = nil
        ShellController.forgetPageData()
    }

    // MARK: Page events

    func enqueue(_ event: ShellEvent) {
        if event == .resume, outbox.contains(.resume) { return }
        outbox.append(event)
    }

    func drainOutbox() -> [ShellEvent] {
        defer { outbox = [] }
        return outbox
    }

    // MARK: Push registration

    func registerPushToken(_ token: String, environment: String) async {
        guard let paired = connection else { pendingPushToken = token; return }
        do {
            try await DeviceClient(connection: paired).registerPush(token: token, environment: environment)
            guard connection == paired else { return }
            pendingPushToken = nil
        } catch MobileError.revoked {
            // A late answer from a Host the owner already left must not clear the new pairing.
            if connection == paired { disconnect() }
        } catch {
            if connection == paired { pendingPushToken = token }
        }
    }

    func retryPendingPushToken() async {
        guard let token = pendingPushToken else { return }
        await registerPushToken(token, environment: PushEnvironment.current)
    }
}
