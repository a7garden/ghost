import Network
import SwiftUI
import GhostMobileCore

// One nearby Ghost server advertised over Bonjour `_ghost-pair._tcp` with a
// TXT record carrying the exact HTTPS origin. The service name is display
// only; the validated origin is what the user confirms.
struct GhostServerCandidate: Identifiable, Equatable, Sendable {
    let name: String
    let origin: URL

    var id: String { "\(name)|\(origin.absoluteString)" }

    static func parse(_ results: Set<NWBrowser.Result>) -> [GhostServerCandidate] {
        var seen = Set<String>()
        var candidates: [GhostServerCandidate] = []
        for result in results {
            guard case .bonjour(let record) = result.metadata,
                  let origin = PairingServiceTXT.origin(record.dictionary) else { continue }
            let name: String
            if case .service(let serviceName, _, _, _) = result.endpoint, !serviceName.isEmpty {
                name = serviceName
            } else {
                name = origin.host() ?? "Ghost 서버"
            }
            let candidate = GhostServerCandidate(name: name, origin: origin)
            guard seen.insert(candidate.id).inserted else { continue }
            candidates.append(candidate)
        }
        return candidates.sorted { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }
    }
}

// Real Bonjour browsing with the Network framework while the connect screen
// is visible; `stop()` cancels the browser so discovery never outlives the
// view. Peer-to-peer interfaces are included so phones on the same LAN spot
// the server without manual addresses.
@MainActor @Observable final class PairingDiscovery {
    static let serviceType = "_ghost-pair._tcp."

    private(set) var candidates: [GhostServerCandidate] = []
    private(set) var isBrowsing = false
    private(set) var issue: String?
    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private let browserQueue = DispatchQueue(label: "io.a7garden.ghost.pairing.browse")

    func start() {
        guard browser == nil else { return }
        issue = nil
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: parameters)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let items = GhostServerCandidate.parse(results)
            Task { @MainActor in self?.apply(candidates: items) }
        }
        browser.stateUpdateHandler = { [weak self] state in
            let failed: String?
            switch state {
            case .failed(let error): failed = "근처 Ghost 서버를 찾는 중 문제가 생겼습니다. (\(String(describing: error)))"
            case .cancelled: failed = nil
            default: failed = nil
            }
            let ready: Bool
            if case .ready = state { ready = true } else { ready = false }
            Task { @MainActor in self?.apply(state: failed, ready: ready) }
        }
        self.browser = browser
        isBrowsing = true
        browser.start(queue: browserQueue)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        isBrowsing = false
        candidates = []
    }

    private func apply(candidates: [GhostServerCandidate]) {
        guard browser != nil else { return }
        self.candidates = candidates
    }

    private func apply(state failed: String?, ready: Bool) {
        guard browser != nil else { return }
        if ready { issue = nil }
        else if let failed { issue = failed }
        if ready { isBrowsing = true }
    }
}
