import SwiftUI
import GhostMobileCore

// The connect screen. One path does the work: scan the QR the PC shows. Typing the
// server and code is the fallback, kept in a sheet so the first screen stays a single
// decision. Connecting, an interrupted request and a failure each replace the action
// area with their own state; nothing stacks warnings in a form.
struct PairingFlowView: View {
    let model: GhostModel
    @Bindable private var pairing: PairingModel
    @State private var scanning = false
    @State private var typing = false
    @State private var renaming = false
    @State private var typeAfterScan = false
    @State private var scanSink = QRScanSink()

    init(model: GhostModel) {
        self.model = model
        _pairing = Bindable(model.pairing)
    }

    private var issue: String? { pairing.error ?? pairing.connectIssue ?? pairing.intakeIssue }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            hero
            Spacer(minLength: 32)
            Group {
                if pairing.isBusy {
                    ConnectingState(origin: pairing.attempt?.origin ?? URL(string: pairing.draftOrigin))
                } else if let attempt = pairing.attempt {
                    interrupted(attempt)
                } else {
                    actions
                }
            }
            .frame(maxWidth: 440)
            .animation(.easeOut(duration: 0.2), value: pairing.isBusy)
        }
        .padding(.horizontal, 24).padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(GhostStyle.canvas)
        .tint(GhostStyle.ink)
        .sheet(isPresented: $scanning, onDismiss: {
            if typeAfterScan { typeAfterScan = false; typing = true }
        }) {
            QRScannerSheet(sink: scanSink, typeInstead: { typeAfterScan = true; scanning = false })
        }
        .sheet(isPresented: $typing) {
            ManualPairingSheet(pairing: pairing) { typing = false }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .alert("이 iPhone의 이름", isPresented: $renaming) {
            TextField("이름", text: $pairing.deviceName)
                .accessibilityIdentifier("pairing-device-name")
            Button("확인") { pairing.deviceName = PairingModel.sanitizedDeviceName(pairing.deviceName) }
        } message: {
            Text("PC의 기기 목록에 이 이름으로 보입니다.")
        }
        .task {
            scanSink.onOffer = { offer in
                scanning = false
                pairing.acceptOffer(offer)
            }
            await pairing.restore()
        }
    }

    private var hero: some View {
        VStack(spacing: 20) {
            GhostMark(size: 72)
            Text("내 Ghost와 연결")
                .font(.system(.largeTitle, design: .rounded, weight: .semibold)).tracking(-0.6)
                .multilineTextAlignment(.center)
            SettingsPath(steps: ["PC Ghost", "설정", "기기", "기기 연결"])
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("PC Ghost의 설정, 기기에서 기기 연결을 누르면 QR 코드가 나타납니다")
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            if let issue { IssueLine(text: issue) }
            Button { pairing.dismissIssues(); scanning = true } label: {
                Label("QR 코드 스캔", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .foregroundStyle(GhostStyle.onInk)
                    .background(GhostStyle.ink, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(PressableStyle())
            .accessibilityIdentifier("pairing-scan-qr")
            Button { pairing.dismissIssues(); typing = true } label: {
                Text("코드로 연결").font(.callout.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain).foregroundStyle(GhostStyle.text)
            .accessibilityIdentifier("pairing-type-code")
            Button { renaming = true } label: {
                HStack(spacing: 6) {
                    Image(systemName: "iphone").imageScale(.small)
                    Text(pairing.deviceName).lineLimit(1)
                    Image(systemName: "pencil").imageScale(.small)
                }
                .font(.footnote).foregroundStyle(GhostStyle.secondary).frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("이 iPhone의 이름 \(pairing.deviceName), 바꾸기")
        }
    }

    /// A claim that was sent but never answered: it can only be sent again unchanged or dropped.
    private func interrupted(_ attempt: PairingAttempt) -> some View {
        VStack(spacing: 16) {
            VStack(spacing: 6) {
                Text("연결 요청이 끊겼어요").font(.headline)
                Text(attempt.origin.host() ?? attempt.origin.absoluteString)
                    .font(.footnote.monospaced()).foregroundStyle(GhostStyle.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("pairing-attempt-card")
            if let issue { IssueLine(text: issue) }
            Button("다시 보내기") { Task { await pairing.resume() } }
                .buttonStyle(GhostPrimaryButtonStyle()).frame(maxWidth: .infinity)
                .accessibilityIdentifier("pairing-resume")
            Button("처음부터") { Task { await pairing.cancel() } }
                .buttonStyle(GhostSecondaryButtonStyle())
                .accessibilityIdentifier("pairing-cancel-attempt")
        }
        .padding(20).frame(maxWidth: .infinity)
        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(GhostStyle.border, lineWidth: 1) }
    }
}

/// Where the QR lives on the PC, drawn as the path itself instead of a sentence about it.
private struct SettingsPath: View {
    let steps: [String]
    var body: some View {
        Flow(spacing: 4) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(spacing: 4) {
                    Text(step)
                        .font(.footnote.weight(index == steps.count - 1 ? .semibold : .medium))
                        .foregroundStyle(index == steps.count - 1 ? GhostStyle.text : GhostStyle.secondary)
                        .padding(.horizontal, 10).frame(height: 28)
                        .background(index == steps.count - 1 ? GhostStyle.surface : GhostStyle.under, in: Capsule())
                        .overlay { if index == steps.count - 1 { Capsule().stroke(GhostStyle.border, lineWidth: 1) } }
                    if index < steps.count - 1 {
                        Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(GhostStyle.secondary)
                    }
                }
            }
        }
    }
}

/// The claim in flight: the Ghost mark with the working arc and where it is going.
private struct ConnectingState: View {
    let origin: URL?
    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                GhostMark(size: 52)
                TravellingArc().frame(width: 64, height: 64)
            }
            Text("연결하는 중").font(.headline)
            if let host = origin?.host() {
                Text(host).font(.footnote.monospaced()).foregroundStyle(GhostStyle.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 160)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pairing-connecting")
    }
}

private struct IssueLine: View {
    let text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(GhostStyle.dangerInk)
            Text(text).font(.footnote).foregroundStyle(GhostStyle.text).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(GhostStyle.dangerTint, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// The fallback: the server address and the code the PC shows, then one connect action.
private struct ManualPairingSheet: View {
    @Bindable var pairing: PairingModel
    let done: () -> Void
    @FocusState private var field: Field?
    private enum Field { case origin, code }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                fieldBox("서버 주소") {
                    TextField("https://ghost.example.com", text: $pairing.draftOrigin)
                        .keyboardType(.URL).textContentType(.URL)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .focused($field, equals: .origin).submitLabel(.next)
                        .onSubmit { field = .code }
                        .accessibilityIdentifier("pairing-origin-field")
                }
                fieldBox("연결 코드") {
                    TextField("ABCD2345", text: $pairing.draftCode)
                        .font(.system(.title3, design: .monospaced).weight(.semibold)).tracking(2)
                        .autocorrectionDisabled().textInputAutocapitalization(.characters).keyboardType(.asciiCapable)
                        .focused($field, equals: .code).submitLabel(.go)
                        .onSubmit { connect() }
                        .accessibilityIdentifier("pairing-code-field")
                        .onChange(of: pairing.draftCode) { _, value in
                            let cleaned = String(value.uppercased().filter { !$0.isWhitespace }.prefix(32))
                            if cleaned != value { pairing.draftCode = cleaned }
                        }
                }
                if let issue = pairing.intakeIssue { IssueLine(text: issue) }
                Spacer(minLength: 0)
                Button(action: connect) {
                    Text("연결").font(.headline).frame(maxWidth: .infinity, minHeight: 52)
                        .foregroundStyle(pairing.canSubmitManual ? GhostStyle.onInk : GhostStyle.secondary)
                        .background(pairing.canSubmitManual ? GhostStyle.ink : GhostStyle.ink.opacity(0.1), in: Capsule())
                }
                .buttonStyle(PressableStyle())
                .disabled(!pairing.canSubmitManual)
                .accessibilityIdentifier("pairing-code-submit")
            }
            .padding(20)
            .background(GhostStyle.canvas)
            .navigationTitle("코드로 연결").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기", action: done) } }
            .onAppear { field = pairing.draftOrigin.isEmpty ? .origin : .code }
        }
    }

    private func connect() {
        guard pairing.canSubmitManual, pairing.validateManual() else { return }
        done()
        Task { await pairing.submitManual() }
    }

    private func fieldBox<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(GhostStyle.secondary)
            content()
                .padding(.horizontal, 14).frame(minHeight: 50)
                .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(GhostStyle.border, lineWidth: 1) }
        }
    }
}
