import Foundation
import Observation
import Security
import UIKit
import GhostMobileCore

/// Keychain-backed pending pairing attempt, matching the saved-connection
/// pattern: one generic-password item, device-only availability.
struct PairingKeychainStore: PairingAttemptStoring {
    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "io.a7garden.ghost.pairing",
            kSecAttrAccount as String: "attempt",
        ]
    }

    func load() throws -> PairingAttempt? {
        var request = Self.query
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw MobileError.response("진행 중인 연결 요청을 읽지 못했습니다.")
        }
        return try JSONDecoder().decode(PairingAttempt.self, from: data)
    }

    func save(_ attempt: PairingAttempt) throws {
        let data = try JSONEncoder().encode(attempt)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let query = Self.query
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil) == errSecSuccess else {
                throw MobileError.response("연결 요청을 안전하게 저장하지 못했습니다.")
            }
        } else if updated != errSecSuccess {
            throw MobileError.response("연결 요청을 갱신하지 못했습니다.")
        }
    }

    func clear() throws {
        let status = SecItemDelete(Self.query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw MobileError.response("연결 요청을 지우지 못했습니다.")
        }
    }
}

/// Connect-screen state machine: QR scan or deep link intake, manual origin +
/// code entry, then one claim. A stored attempt survives relaunch and is
/// retried with the exact same body.
@MainActor @Observable final class PairingModel {
    private(set) var attempt: PairingAttempt?
    var error: String?
    var intakeIssue: String?
    var connectIssue: String?
    var draftOrigin: String = ""
    var draftCode: String = ""
    var deviceName: String = PairingModel.sanitizedDeviceName(UIDevice.current.name)
    private(set) var isBusy = false
    private(set) var lastResult: PairingResult?

    /// Set by GhostModel: adopts the claimed credential into the saved
    /// connection. Returns true only after the connection is live.
    @ObservationIgnored var onApproved: ((URL, String, String) async -> Bool)?
    @ObservationIgnored private let session: PairingSession
    @ObservationIgnored private var adopting = false

    init(store: PairingAttemptStoring) {
        session = PairingSession(store: store)
    }

    var normalizedDraftCode: String? {
        let code = draftCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (6...32).contains(code.count) else { return nil }
        return code
    }

    var canSubmitManual: Bool {
        !isBusy && normalizedDraftCode != nil && !draftOrigin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A saved connection exists: any pending attempt either produced it or is
    /// stale, and must not resurrect behind the tab UI.
    func discardAdoptedAttempt() {
        Task {
            await session.discard()
            attempt = nil
        }
    }

    /// Restores a persisted attempt (interrupted claim) when the screen opens.
    func restore() async {
        attempt = await session.restore()
    }

    // MARK: Intake (deep link and QR scan — parse before anything else)

    func handleDeepLink(_ url: URL) {
        intakeIssue = nil
        error = nil
        do {
            let offer = try PairingQR.parse(url.absoluteString)
            acceptOffer(offer)
        } catch {
            intakeIssue = error.localizedDescription
        }
    }

    /// A QR payload already parsed strictly by the scanner sink.
    func acceptOffer(_ offer: PairingOffer) {
        intakeIssue = nil
        error = nil
        draftOrigin = offer.origin.absoluteString
        draftCode = offer.code
        Task { await claim(offer) }
    }

    func submitManual() async {
        guard canSubmitManual else { return }
        do {
            let offer = PairingOffer(origin: try canonicalOrigin(draftOrigin), code: normalizedDraftCode!)
            await claim(offer)
        } catch {
            intakeIssue = error.localizedDescription
        }
    }

    /// Retries the stored attempt with the exact same body.
    func resume() async {
        guard let current = attempt, !isBusy else { return }
        await claim(PairingOffer(origin: current.origin, code: current.code))
    }

    func cancel() async {
        await session.cancel()
        attempt = nil
        error = nil
        connectIssue = nil
    }

    // MARK: Claim

    private func claim(_ offer: PairingOffer) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let stored = try await session.begin(offer, deviceName: deviceName)
            attempt = stored
            error = nil
            connectIssue = nil
            let result = try await session.claim()
            lastResult = result
            attempt = nil
            guard !adopting, let onApproved else { return }
            adopting = true
            defer { adopting = false }
            let connected = await onApproved(offer.origin, result.deviceId, result.token)
            if connected {
                connectIssue = nil
            } else {
                connectIssue = "연결된 서버에 접속하지 못했습니다. 다시 시도해 주세요."
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    static func sanitizedDeviceName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "내 iPhone" }
        return String(trimmed.prefix(100))
    }
}
