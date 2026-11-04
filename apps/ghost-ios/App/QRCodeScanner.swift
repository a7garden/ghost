import AVFoundation
import SwiftUI
import UIKit
import GhostMobileCore

// Real AVFoundation QR scanning for the pairing flow. The camera session,
// its queue, and the metadata delegate live in one confined controller; the
// SwiftUI layer only renders the preview and the truthful outcome of
// permission or hardware failures. Camera authorization is requested only
// from the user's explicit scan action — never on app launch or deep link.

enum QRScannerStartOutcome: Equatable {
    case running
    case permissionDenied
    case permissionRestricted
    case unavailable(String)
}

// All AVCapture state is confined to `sessionQueue`; `emitLock` guards the
// deduplication of repeated scans of the same code.
final class QRScannerController: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let metadataOutput = AVCaptureMetadataOutput()
    private let sessionQueue = DispatchQueue(label: "io.a7garden.ghost.pairing.camera")
    private let emitLock = NSLock()
    private var lastEmitted: String?
    private var configured = false
    // Invoked on `sessionQueue` for each newly seen QR payload.
    private let onCode: (String) -> Void

    init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
        super.init()
    }

    func start() async -> QRScannerStartOutcome {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        var authorized = status == .authorized
        if status == .notDetermined {
            authorized = await AVCaptureDevice.requestAccess(for: .video)
        }
        guard authorized else {
            return status == .restricted ? .permissionRestricted : .permissionDenied
        }
        guard !Task.isCancelled else { return .unavailable("QR 스캔이 종료되었습니다.") }
        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                continuation.resume(returning: self.beginSession())
            }
        }
    }

    func stop() {
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    // Queue-confined session setup: wide back camera, metadata output limited
    // to QR, delegate callbacks on the same queue.
    private func beginSession() -> QRScannerStartOutcome {
        if session.isRunning { return .running }
        if !configured {
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                return .unavailable("이 기기에서 카메라를 사용할 수 없습니다.")
            }
            session.beginConfiguration()
            session.addInput(input)
            guard session.canAddOutput(metadataOutput) else {
                session.commitConfiguration()
                return .unavailable("이 기기에서 QR 코드 인식을 사용할 수 없습니다.")
            }
            session.addOutput(metadataOutput)
            metadataOutput.setMetadataObjectsDelegate(self, queue: sessionQueue)
            guard metadataOutput.availableMetadataObjectTypes.contains(.qr) else {
                session.commitConfiguration()
                return .unavailable("이 기기에서 QR 코드 인식을 사용할 수 없습니다.")
            }
            metadataOutput.metadataObjectTypes = [.qr]
            session.commitConfiguration()
            configured = true
        }
        session.startRunning()
        return session.isRunning ? .running : .unavailable("카메라 촬영을 시작하지 못했습니다. 스캔 화면을 닫고 다시 열어 주세요.")
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let payload = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
            .first(where: { $0.type == .qr })?.stringValue, !payload.isEmpty else { return }
        emitLock.lock()
        let fresh = lastEmitted != payload
        lastEmitted = payload
        emitLock.unlock()
        guard fresh else { return }
        onCode(payload)
    }
}

// Collects raw QR payloads from the scanner queue onto the main actor and
// parses them strictly; an unparseable QR is reported, never acted on.
@MainActor @Observable final class QRScanSink {
    private(set) var parseIssue: String?
    var onInvitation: ((PairingInvitation) -> Void)?

    func handle(raw: String) {
        do {
            parseIssue = nil
            onInvitation?(try PairingQR.parse(raw))
        } catch {
            parseIssue = error.localizedDescription
        }
    }
}

private final class ScannerPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    private static let diagnoseCamera = ProcessInfo.processInfo.environment["GHOST_CAMERA_DIAGNOSTICS"] == "1"
    private var scheduledCameraDiagnostic = false

    override func layoutSubviews() {
        super.layoutSubviews()
        guard Self.diagnoseCamera,
              window != nil, !scheduledCameraDiagnostic else { return }
        scheduledCameraDiagnostic = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.window != nil else { return }
            let layer = self.previewLayer
            var hidden = false
            var opacity: CGFloat = 1
            var ancestor: UIView? = self
            while let view = ancestor {
                hidden = hidden || view.isHidden
                opacity *= view.alpha
                ancestor = view.superview
            }
            let state: [String: Any] = [
                "observed_at": Date().timeIntervalSince1970,
                "view_width": self.bounds.width,
                "view_height": self.bounds.height,
                "layer_width": layer.bounds.width,
                "layer_height": layer.bounds.height,
                "attached": self.window != nil,
                "hidden": hidden,
                "effective_alpha": opacity,
                "previewing": layer.isPreviewing,
                "connection_present": layer.connection != nil,
                "connection_enabled": layer.connection?.isEnabled ?? false,
                "connection_active": layer.connection?.isActive ?? false,
                "input_ports": layer.connection?.inputPorts.count ?? 0,
                "session_running": layer.session?.isRunning ?? false,
                "session_interrupted": layer.session?.isInterrupted ?? false,
                "inputs": layer.session?.inputs.count ?? 0,
                "outputs": layer.session?.outputs.count ?? 0
            ]
            do {
                let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
                let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("ghost-camera-diagnostic.json")
                try data.write(to: url, options: [.atomic, .completeFileProtection])
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            } catch {
                print("Camera diagnostic write failed: \(error.localizedDescription)")
            }
        }
    }
}

private struct ScannerPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> ScannerPreviewView {
        let view = ScannerPreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: ScannerPreviewView, context: Context) {
        if uiView.previewLayer.session !== session {
            uiView.previewLayer.session = session
        }
    }
}

// The full-screen scan sheet: live preview while running, and the actual
// workflow when the camera is refused — open Settings, or fall back to the
// nearby-server list and the 8-character code.
struct QRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sink: QRScanSink
    @State private var controller: QRScannerController?
    @State private var outcome: QRScannerStartOutcome?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let controller {
                    GeometryReader { geometry in
                        ScannerPreview(session: controller.session)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .task {
                                outcome = await controller.start()
                            }
                    }
                    .ignoresSafeArea()
                }
                statusOverlay
            }
            .navigationTitle("QR 스캔")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("닫기") { dismiss() }
                }
            }
        }
        .task {
            guard controller == nil else { return }
            let sink = sink
            let controller = QRScannerController(onCode: { raw in
                Task { @MainActor in sink.handle(raw: raw) }
            })
            self.controller = controller
        }
        .onDisappear { controller?.stop() }
    }

    @ViewBuilder private var statusOverlay: some View {
        switch outcome {
        case .running:
            VStack {
                Spacer()
                if let issue = sink.parseIssue {
                    Text(issue)
                        .font(.callout)
                        .foregroundStyle(.white)
                        .padding(12)
                        .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal, 24)
                } else {
                    Text("PC 화면의 QR 코드를 비춰 주세요.")
                        .font(.callout)
                        .foregroundStyle(.white)
                        .padding(12)
                        .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
                }
                Spacer().frame(height: 48)
            }
        case .permissionDenied, .permissionRestricted:
            VStack(spacing: 16) {
                Image(systemName: "camera.badge.ellipsis").font(.largeTitle).foregroundStyle(.white)
                Text("카메라를 사용할 수 없습니다").font(.headline).foregroundStyle(.white)
                Text("iOS 설정 > Ghost > 카메라를 허용한 뒤 다시 스캔해 주세요. 카메라 없이는 근처 서버 목록에서 8자리 코드로 연결할 수 있습니다.")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.85))
                    .multilineTextAlignment(.center)
                Button("설정 열기") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
                Button("닫기") { dismiss() }
            }
            .padding(24)
        case .unavailable(let message):
            VStack(spacing: 16) {
                Image(systemName: "camera.badge.ellipsis").font(.largeTitle).foregroundStyle(.white)
                Text(message).font(.callout).foregroundStyle(.white)
                Button("닫기") { dismiss() }
            }
            .padding(24)
        case .none:
            VStack(spacing: 16) {
                Image(systemName: "camera.badge.ellipsis").font(.largeTitle).foregroundStyle(.white)
                Text("카메라를 준비하고 있습니다.").font(.callout).foregroundStyle(.white)
            }
            .padding(24)
        }
    }
}
