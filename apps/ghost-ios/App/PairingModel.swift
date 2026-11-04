import Foundation
import Observation
import Security
import UIKit
import GhostMobileCore

// Keychain-backed pending-attempt store, matching the saved-connection
// pattern: one generic-password item, device-only availability. The fresh
// phone key and QR ticket never appear anywhere else — not in files, not in
// logs.
struct PairingKeychainStore: PairingAttemptStoring {
    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "io.a7garden.ghost.pairing",
            kSecAttrAccount as String: "attempt",
        ]
    }

    func load() throws -> PairingRecord? {
        var request = Self.query
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw MobileError.response("진행 중인 연결 요청을 읽지 못했습니다.")
        }
        return try JSONDecoder().decode(PairingRecord.self, from: data)
    }

    func save(_ record: PairingRecord) throws {
        let data = try JSONEncoder().encode(record)
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

// Connect-screen state machine: discovery, QR deep-link confirmation, the
// 8-character code against a confirmed nearby server, and the pending
// attempt card. The attempt (fresh key + nonce + origin + status) survives
// relaunch in the Keychain; an unknown network outcome is never silently
// replaced — only an explicit resume re-sends the identical request, and
// only an explicit cancel clears it.
@MainActor @Observable final class PairingModel {
    private(set) var attempt: PairingAttempt?
    var error: String?
    var deviceName: String = PairingModel.sanitizedDeviceName(UIDevice.current.name)
    var draftCode: String = ""
    private(set) var linkDraft: PairingInvitation?
    private(set) var deepLinkIssue: String?
    private(set) var connectIssue: String?
    private(set) var isBusy = false
    let discovery = PairingDiscovery()

    // Set by GhostModel: runs the EXISTING connect path (bootstrap probe →
    // scoped API → Keychain save) with the approved credential. Returns true
    // only after the connection is live.
    @ObservationIgnored var onApproved: ((String, String) async -> Bool)?
    @ObservationIgnored private let session: PairingSession
    @ObservationIgnored private var adoptingApproval = false

    init(store: PairingAttemptStoring) {
        session = PairingSession(store: store)
    }

    var activeAttempt: Bool {
        attempt.map { !$0.status.isTerminal } ?? false
    }

    var normalizedDraftCode: String? {
        try? PairingCode.normalize(draftCode)
    }

    @ObservationIgnored private var selectedCandidateID: String?
    var selectedCandidate: GhostServerCandidate? {
        discovery.candidates.first { $0.id == selectedCandidateID }
    }

    func select(_ candidate: GhostServerCandidate) {
        selectedCandidateID = candidate.id
    }

    // MARK: Lifecycle (connect screen visibility)

    // A saved connection exists: any pending attempt either produced it or is
    // stale, and must not resurrect behind the Tab UI.
    func discardAdoptedAttempt() {
        Task {
            try? await session.discardAdopted()
            attempt = nil
        }
    }

    // Runs while ConnectView is visible; SwiftUI cancels the task on
    // disappear, which stops polling but preserves any unknown attempt.
    func runVisibleLoop() async {
        attempt = await session.restore()
        while !Task.isCancelled {
            await stepOnce()
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }

    private func stepOnce() async {
        guard let current = attempt, !isBusy else { return }
        switch current.status {
        case .pending:
            await pollOnce()
        case .approved:
            await adoptApproval()
        case .claiming, .cancelled, .expired, .revoked:
            break
        }
    }

    // MARK: Deep link and QR scan intake (parse before anything else)

    func handleDeepLink(_ url: URL) {
        deepLinkIssue = nil
        do {
            linkDraft = try PairingQR.parse(url.absoluteString)
        } catch {
            deepLinkIssue = error.localizedDescription
        }
    }

    // A QR payload already parsed strictly by the scanner sink.
    func acceptScanned(_ invitation: PairingInvitation) {
        deepLinkIssue = nil
        linkDraft = invitation
    }

    func dismissLinkDraft() {
        linkDraft = nil
        deepLinkIssue = nil
    }

    // MARK: Begin + claim (explicit user actions only)

    func confirmLinkDraft() async {
        guard let draft = linkDraft, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            attempt = try await session.begin(invitation: draft, deviceName: deviceName)
            linkDraft = nil
            await submitOnce()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func beginWithCode() async {
        guard let candidate = selectedCandidate, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let code = try PairingCode.normalize(draftCode)
            attempt = try await session.begin(code: code, origin: candidate.origin, deviceName: deviceName)
            draftCode = ""
            await submitOnce()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // Explicit resume: re-sends the exact stored payload (claiming), polls
    // the server's current word (pending), or retries the approved connect
    // with the same key.
    func resume() async {
        guard !isBusy, let current = attempt else { return }
        isBusy = true
        defer { isBusy = false }
        switch current.status {
        case .claiming: await submitOnce()
        case .pending: await pollOnce()
        case .approved: await adoptApproval()
        case .expired: await pollOnce()
        case .cancelled, .revoked: break
        }
    }

    func cancel() async {
        do {
            try await session.cancel()
            attempt = nil
            error = nil
            connectIssue = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Steps (callers hold `isBusy`)

    private func submitOnce() async {
        do {
            attempt = try await session.submit()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func pollOnce() async {
        do {
            attempt = try await session.pollOnce()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func adoptApproval() async {
        guard !adoptingApproval, let onApproved else { return }
        adoptingApproval = true
        defer { adoptingApproval = false }
        do {
            let credential = try await session.approvedCredential()
            connectIssue = nil
            let connected = await onApproved(credential.origin, credential.key)
            if connected {
                try? await session.cancel()
                attempt = nil
                error = nil
            } else {
                connectIssue = "승인된 연결에 접속하지 못했습니다. 다시 시도해 주세요."
            }
        } catch {
            connectIssue = error.localizedDescription
        }
    }

    static func sanitizedDeviceName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "내 iPhone" }
        return String(trimmed.prefix(100))
    }
}
