import Foundation
import Testing
import GhostMobileCore

// Shared stub transport for core tests: a URLProtocol whose behavior and
// recorded requests are controlled per test. Swift Testing runs suites in
// parallel, so each test gets an isolated lane keyed by a unique host.
struct StubRequest: Sendable, Equatable {
    var method: String
    var path: String
    var query: String
    var body: Data
}

struct StubResponse: Sendable {
    enum Action: Sendable {
        case reply(status: Int, body: Data)
        case networkFailure
    }
    var action: Action
}

final class StubLane: @unchecked Sendable {
    let host: String
    private let lock = NSLock()
    init(host: String) { self.host = host }
    private var requests: [StubRequest] = []
    private var responses: [StubResponse] = []
    private var defaultResponse: StubResponse?

    func reset() {
        lock.withLock {
            requests = []
            responses = []
            defaultResponse = nil
        }
    }

    func enqueue(_ response: StubResponse) {
        lock.withLock { responses.append(response) }
    }

    func setDefault(_ response: StubResponse) {
        lock.withLock { defaultResponse = response }
    }

    func record(_ request: StubRequest) -> StubResponse {
        lock.withLock {
            requests.append(request)
            if !responses.isEmpty { return responses.removeFirst() }
            return defaultResponse ?? StubResponse(action: .networkFailure)
        }
    }

    func allRequests() -> [StubRequest] {
        lock.withLock { requests }
    }

    func clearRequests() {
        lock.withLock { requests = [] }
    }
}

final class StubRegistry: @unchecked Sendable {
    static let shared = StubRegistry()
    private let lock = NSLock()
    private var lanes: [String: StubLane] = [:]

    func lane(for host: String) -> StubLane {
        lock.withLock {
            if let existing = lanes[host] { return existing }
            let lane = StubLane(host: host)
            lanes[host] = lane
            return lane
        }
    }
}

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".invalid") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override func startLoading() {
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            let bufferSize = 4096
            var buffer = [UInt8](repeating: 0, count: bufferSize)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: bufferSize)
                guard read > 0 else { break }
                body.append(buffer, count: read)
            }
        } else {
            body = request.httpBody ?? Data()
        }
        let stub = StubRequest(
            method: request.httpMethod ?? "GET",
            path: components.path,
            query: components.query ?? "",
            body: body)
        let lane = StubRegistry.shared.lane(for: request.url!.host!)
        let outcome = lane.record(stub)
        switch outcome.action {
        case .reply(let status, let responseBody):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: responseBody)
            client?.urlProtocolDidFinishLoading(self)
        case .networkFailure:
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        }
    }

    override func stopLoading() { }
}

/// A unique https origin plus its private stub lane; every parallel test
/// gets its own so enqueues never cross.
func makeStubOrigin() -> (origin: URL, lane: StubLane) {
    // The host is already lowercase because canonicalOrigin lowercases it;
    // the lane key must match the host URLSession reports back.
    let origin = try! canonicalOrigin("https://t-\(UUID().uuidString).invalid")
    let host = origin.host() ?? ""
    return (origin, StubRegistry.shared.lane(for: host))
}

func stubJSON(_ value: some Encodable) -> Data {
    (try? JSONEncoder().encode(value)) ?? Data()
}

func json(_ text: String) -> Data {
    Data(text.utf8)
}
