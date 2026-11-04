import AVFoundation
import CallKit
import GhostMobileCore
@preconcurrency import WebRTC

// Native WebRTC audio engine for the conversation-bound streaming service.
// CallKit owns the audio session and the lock-screen call interface, so the
// call keeps running while the app is backgrounded or the phone is locked.
// Ending stops the local microphone, peer, and call UI immediately; only the
// server-side lifetime may stay unresolved, keeping its exact identifier for
// retry and reconciliation through the owning session actor.
@MainActor final class VoiceCallController: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle, connecting, active, reconnecting, ending, unconfirmed, ended
    }

    // Server-lifetime observations reported to the owning model so the
    // unresolved-call fence survives controller replacement and disconnect.
    enum ServerOutcome: Equatable {
        case identified(pcID: String)
        case confirmedEnd
        case resolvedWithoutSession
        case unconfirmedEnd(pcID: String)
        case unknownStart
    }

    let profileID: String
    let conversationID: String
    private let api: GhostAPI
    private let session: VoiceMediaSession
    var onServerOutcome: ((ServerOutcome) -> Void)?
    private let callController = CXCallController()
    private let provider: CXProvider
    private let callUUID = UUID()
    private let delegateBridge = PeerConnectionDelegateBridge()
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var muted = false
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var turnState = ""
    @Published private(set) var errorText: String?

    private var peer: RTCPeerConnection?
    private var micTrack: RTCAudioTrack?
    private var pendingCandidates: [RTCIceCandidate] = []
    private var pcID: String?
    private var connectedAt: Date?
    private var reconnectDeadline: Date?
    private var timer: Timer?
    private var finished = false
    private var finishStarted = false
    private var systemEndedCall = false

    init(api: GhostAPI, profileID: String, conversationID: String, session: VoiceMediaSession) {
        self.api = api
        self.profileID = profileID
        self.conversationID = conversationID
        self.session = session
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        self.provider = CXProvider(configuration: configuration)
        super.init()
        delegateBridge.controller = self
        delegateBridge.channelBridge.controller = self
        provider.setDelegate(self, queue: nil)
    }

    var canCancelConnection: Bool { phase == .connecting }

    func start() {
        guard phase == .idle else { return }
        phase = .connecting
        startElapsedTimer()
        let start = CXStartCallAction(call: callUUID, handle: CXHandle(type: .generic, value: "Ghost"))
        start.isVideo = false
        callController.request(CXTransaction(action: start)) { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // A delayed CallKit completion is not lifecycle
                // authorization: after End no media is ever created.
                guard !self.finished, self.phase == .connecting else { return }
                if let error {
                    self.errorText = "통화를 시작하지 못했습니다. \(error.localizedDescription)"
                    self.phase = .ended
                    self.onServerOutcome?(.resolvedWithoutSession)
                    return
                }
                await self.connectMedia()
            }
        }
    }

    // Cancelling while connecting must not leave a half-open server session:
    // begin() ends the session when the answer arrives after this call.
    func cancelWhileConnecting() {
        guard canCancelConnection else { return }
        Task { await self.finish() }
    }

    func setMuted(_ value: Bool) {
        muted = value
        micTrack?.isEnabled = !value
    }

    func end() {
        Task { await self.finish() }
    }

    func retryServerHangup() {
        // Retry through the owning session actor: it holds the exact same
        // server identifier, including the one from a late answer, so the
        // retry can never target a different or missing call.
        guard phase == .unconfirmed else { return }
        phase = .ending
        Task {
            do {
                try await session.end()
                phase = .ended
                onServerOutcome?(.confirmedEnd)
            } catch {
                phase = .unconfirmed
                errorText = "서버 통화 종료를 다시 확인해 주세요."
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: Media connection

    private func connectMedia() async {
        // Media exists only while the call is connecting: cancellation or a
        // finished call must not create a peer or an enabled microphone.
        guard !finished, phase == .connecting else { return }
        let audioSession = RTCAudioSession.sharedInstance()
        audioSession.useManualAudio = true
        audioSession.isAudioEnabled = false
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": "true"])
        guard let peer = Self.factory.peerConnection(with: config, constraints: constraints, delegate: delegateBridge) else {
            errorText = "이 기기에서 음성 연결을 만들 수 없습니다."
            await finish()
            return
        }
        self.peer = peer
        let source = Self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = Self.factory.audioTrack(with: source, trackId: "ghost-mic")
        track.isEnabled = !muted
        micTrack = track
        peer.add(track, streamIds: ["ghost-audio"])
        guard let offerSDP = await makeOffer(peer: peer) else { return }
        do {
            let answer = try await session.begin(offerSDP: offerSDP)
            // The actor already hung up a late answer when End arrived
            // first; no media or answer may be applied after that.
            guard !finished else { return }
            pcID = answer.pcID
            onServerOutcome?(.identified(pcID: answer.pcID))
            try await setRemoteAnswer(peer: peer, sdp: answer.sdp)
            flushPendingCandidates()
            if peer.connectionState == .connected { markConnected() }
        } catch {
            guard !finished else { return }
            errorText = error.localizedDescription
            await finish()
        }
    }

    private func makeOffer(peer: RTCPeerConnection) async -> String? {
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "false"],
            optionalConstraints: nil)
        // Only Sendable values cross the continuation boundary; the ObjC
        // session description is reduced to its SDP text inside the callback.
        let offerText: String? = await withCheckedContinuation { continuation in
            peer.offer(for: constraints) { sdp, _ in continuation.resume(returning: sdp?.sdp) }
        }
        guard let offerText else {
            errorText = "음성 연결 요청을 만들 수 없습니다."
            await finish()
            return nil
        }
        let applied: Bool = await withCheckedContinuation { continuation in
            peer.setLocalDescription(RTCSessionDescription(type: .offer, sdp: offerText)) { error in
                continuation.resume(returning: error == nil)
            }
        }
        guard applied else {
            errorText = "음성 연결 요청을 만들 수 없습니다."
            await finish()
            return nil
        }
        let gathered = await waitForIceGathering(peer: peer)
        guard gathered else {
            errorText = "음성 연결 준비 시간이 초과됐습니다. 다시 통화해 주세요."
            await finish()
            return nil
        }
        return peer.localDescription?.sdp ?? offerText
    }

    private func waitForIceGathering(peer: RTCPeerConnection, timeout: TimeInterval = 10) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while peer.iceGatheringState != .complete && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
            if finished { return false }
        }
        return peer.iceGatheringState == .complete
    }

    private func setRemoteAnswer(peer: RTCPeerConnection, sdp: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    private func flushPendingCandidates() {
        guard let pcID, !pendingCandidates.isEmpty else { return }
        let candidates = pendingCandidates
        pendingCandidates = []
        let api = api
        let identifier = pcID
        Task {
            do {
                _ = try await api.voiceICE(pcID: identifier, candidates: candidates.map {
                    VoiceICECandidate(candidate: $0.sdp, sdpMid: $0.sdpMid ?? "", sdpMlineIndex: Int($0.sdpMLineIndex))
                })
            } catch {
                errorText = "음성 연결 후보를 서버에 전달하지 못했습니다."
            }
        }
    }

    private func markConnected() {
        guard phase != .active else { return }
        reconnectDeadline = nil
        phase = .active
        connectedAt = connectedAt ?? Date()
        provider.reportOutgoingCall(with: callUUID, connectedAt: connectedAt)
    }

    private func startElapsedTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.finished, let connectedAt = self.connectedAt else { return }
                self.elapsed = Date().timeIntervalSince(connectedAt)
                if let deadline = self.reconnectDeadline, Date() >= deadline {
                    self.errorText = "음성 연결을 복구하지 못했습니다. 다시 통화해 주세요."
                    self.end()
                }
            }
        }
    }

    // MARK: Call teardown

    private func finish() async {
        guard !finishStarted else { return }
        finishStarted = true
        finished = true
        phase = .ending
        timer?.invalidate()
        // Ending always stops the local side first: capture, the peer
        // connection, and CallKit close BEFORE the awaited server close, so
        // the microphone is dead even when the remote outcome turns out
        // unknown. Local media is never reactivated afterwards.
        completedLocalTeardown()
        do {
            try await session.close()
            phase = .ended
            onServerOutcome?(.confirmedEnd)
        } catch {
            if let active = await session.activePCID {
                // The server session identifier is known: the end stays
                // retryable with the same identifier through the actor.
                phase = .unconfirmed
                errorText = errorText ?? "마이크는 닫혔습니다. 서버 통화 종료를 다시 확인해 주세요."
                onServerOutcome?(.unconfirmedEnd(pcID: active))
                return
            }
            // Ambiguous start: the server may still own a session this call
            // created. The controller is over locally, but the unresolved
            // start stays fenced in the model until reconciliation.
            errorText = errorText ?? error.localizedDescription
            phase = .ended
            onServerOutcome?(.unknownStart)
        }
    }

    private func completedLocalTeardown() {
        timer?.invalidate()
        peer?.close()
        peer = nil
        micTrack = nil
        pendingCandidates = []
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        provider.reportCall(with: callUUID, endedAt: Date(), reason: .remoteEnded)
        if !systemEndedCall {
            callController.request(CXTransaction(action: CXEndCallAction(call: callUUID))) { _ in }
        }
    }

    // MARK: Bridges from WebRTC and CallKit queues

    fileprivate func handleIceState(_ state: RTCIceConnectionState, peer: RTCPeerConnection) {
        guard self.peer === peer, !finished else { return }
        switch state {
        case .connected, .completed:
            markConnected()
        case .disconnected:
            if phase == .active {
                phase = .reconnecting
                reconnectDeadline = Date().addingTimeInterval(15)
            }
        case .failed, .closed:
            if phase == .active || phase == .reconnecting {
                errorText = "음성 연결이 끊겼습니다."
                end()
            }
        default:
            break
        }
    }

    // PeerConnectionState is the authoritative transport signal: ICE can be
    // disconnected while the call stays usable, and only a failed transport
    // ends the call.
    fileprivate func handleConnectionState(_ state: RTCPeerConnectionState, peer: RTCPeerConnection) {
        guard self.peer === peer, !finished else { return }
        switch state {
        case .connected:
            markConnected()
        case .failed, .closed:
            if phase == .active || phase == .reconnecting {
                errorText = "음성 연결이 끊겼습니다."
                end()
            }
        case .disconnected:
            if phase == .active {
                phase = .reconnecting
                reconnectDeadline = Date().addingTimeInterval(15)
            }
        default:
            break
        }
    }

    fileprivate func handleLocalCandidate(_ candidate: RTCIceCandidate, peer: RTCPeerConnection) {
        guard self.peer === peer, !finished else { return }
        pendingCandidates.append(candidate)
        if pcID != nil { flushPendingCandidates() }
    }

    fileprivate func handleTurnState(_ state: String) {
        turnState = state
    }

    fileprivate func handleMuted(_ value: Bool) {
        setMuted(value)
    }

    fileprivate func handleSystemEnded() {
        systemEndedCall = true
        end()
    }
}

extension VoiceCallController: @preconcurrency CXProviderDelegate {
    // The provider delegate queue is nil: CallKit delivers on the main queue.
    func providerDidReset(_ provider: CXProvider) {
        if phase == .active || phase == .reconnecting {
            errorText = "통화 시스템이 통화를 종료했습니다."
            end()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        // This product starts calls from the app; answering is not offered.
        action.fail()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        action.fulfill()
        handleSystemEnded()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        action.fulfill()
        handleMuted(action.isMuted)
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        try? audioSession.setMode(.voiceChat)
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.audioSessionDidActivate(audioSession)
        // A stale activation after End (or before the call exists) must not
        // re-open capture; only live media phases may enable audio.
        rtcSession.isAudioEnabled = !finished && (phase == .connecting || phase == .active || phase == .reconnecting)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.isAudioEnabled = false
        rtcSession.audioSessionDidDeactivate(audioSession)
    }
}

// WebRTC invokes these on its internal queue; every state change hops to the
// main actor where the controller lives.
final class PeerConnectionDelegateBridge: NSObject, RTCPeerConnectionDelegate {
    weak var controller: VoiceCallController?
    let channelBridge = DataChannelBridge()

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) { }
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) { }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let controller = self.controller
        Task { @MainActor in
            controller?.handleIceState(newState, peer: peerConnection)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let controller = self.controller
        Task { @MainActor in
            controller?.handleConnectionState(newState, peer: peerConnection)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let controller = self.controller
        Task { @MainActor in
            controller?.handleLocalCandidate(candidate, peer: peerConnection)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        dataChannel.delegate = channelBridge
    }
}

// Forwards server turn-state messages ("ghost.voice.turn") to the controller.
final class DataChannelBridge: NSObject, RTCDataChannelDelegate {
    weak var controller: VoiceCallController?

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) { }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let value = try? JSONDecoder().decode(JSON.self, from: Data(buffer.data)),
              value["type"].text == "ghost.voice.turn" else { return }
        let state = value["state"].text.isEmpty ? value["phase"].text : value["state"].text
        let controller = self.controller
        Task { @MainActor in
            controller?.handleTurnState(state)
        }
    }
}
