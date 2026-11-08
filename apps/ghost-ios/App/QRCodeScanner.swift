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
    var onOffer: ((PairingOffer) -> Void)?

    func handle(raw: String) {
        do {
            parseIssue = nil
            onOffer?(try PairingQR.parse(raw))
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

// The full-screen scan sheet: the live preview with a clear frame to aim at, and the
// actual way forward when the camera is refused — open Settings or type the code.
struct QRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sink: QRScanSink
    /// Leaves the camera for the typed-code fallback.
    var typeInstead: () -> Void = {}
    @State private var controller: QRScannerController?
    @State private var outcome: QRScannerStartOutcome?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let controller {
                GeometryReader { geometry in
                    ScannerPreview(session: controller.session)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .task { outcome = await controller.start() }
                }
                .ignoresSafeArea()
            }
            if outcome == .running { ScanFrame() }
            statusOverlay
        }
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel("닫기").padding(16)
        }
        .preferredColorScheme(.dark)
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
            VStack(spacing: 16) {
                Spacer()
                Text(sink.parseIssue ?? "PC 화면의 QR 코드를 틀 안에 맞춰 주세요")
                    .font(.callout.weight(.medium)).foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(sink.parseIssue == nil ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(GhostStyle.danger.opacity(0.85)), in: Capsule())
                Button("코드로 연결", action: typeInstead)
                    .font(.callout.weight(.semibold)).foregroundStyle(.white).frame(minHeight: 44)
                Spacer().frame(height: 24)
            }
            .padding(.horizontal, 24)
        case .permissionDenied, .permissionRestricted:
            refusal(title: "카메라를 쓸 수 없어요", detail: "설정에서 Ghost의 카메라를 허용하거나 코드로 연결하세요.", settings: true)
        case .unavailable(let message):
            refusal(title: "카메라를 쓸 수 없어요", detail: message, settings: false)
        case .none:
            ProgressView().tint(.white)
        }
    }

    private func refusal(title: String, detail: String, settings: Bool) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.badge.ellipsis").font(.largeTitle).foregroundStyle(.white)
            Text(title).font(.headline).foregroundStyle(.white)
            Text(detail).font(.callout).foregroundStyle(.white.opacity(0.8)).multilineTextAlignment(.center)
            if settings {
                Button("설정 열기") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(GhostPrimaryButtonStyle())
            }
            Button("코드로 연결", action: typeInstead)
                .font(.callout.weight(.semibold)).foregroundStyle(.white).frame(minHeight: 44)
        }
        .padding(32)
    }
}

/// The aiming frame: four rounded corners over a gently dimmed camera.
private struct ScanFrame: View {
    var body: some View {
        GeometryReader { geometry in
            let side = min(geometry.size.width, geometry.size.height) * 0.66
            let rect = CGRect(x: (geometry.size.width - side) / 2, y: (geometry.size.height - side) / 2 - 24, width: side, height: side)
            ZStack {
                Path { path in
                    path.addRect(CGRect(origin: .zero, size: geometry.size))
                    path.addRoundedRect(in: rect, cornerSize: CGSize(width: 28, height: 28))
                }
                .fill(Color.black.opacity(0.45), style: FillStyle(eoFill: true))
                Corners(rect: rect)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 4, lineCap: .round))
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    private struct Corners: Shape {
        let rect: CGRect
        func path(in _: CGRect) -> Path {
            var p = Path()
            let arm: CGFloat = 34, r: CGFloat = 28
            for (x, y, sx, sy) in [(rect.minX, rect.minY, 1.0, 1.0), (rect.maxX, rect.minY, -1.0, 1.0),
                                   (rect.minX, rect.maxY, 1.0, -1.0), (rect.maxX, rect.maxY, -1.0, -1.0)] {
                p.move(to: CGPoint(x: x, y: y + sy * (r + arm - r)))
                p.addLine(to: CGPoint(x: x, y: y + sy * r))
                p.addQuadCurve(to: CGPoint(x: x + sx * r, y: y), control: CGPoint(x: x, y: y))
                p.addLine(to: CGPoint(x: x + sx * (r + arm - r), y: y))
            }
            return p
        }
    }
}
