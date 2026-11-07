import SwiftUI
import GhostMobileCore

// The connect screen: pairing only. There is no manual connection-key entry
// anywhere — a `ghost://pair` QR scan, a `ghost://pair` deep link, or typing
// the server origin and code from the owner screen.
struct PairingFlowView: View {
    let model: GhostModel
    @Bindable private var pairing: PairingModel
    @State private var scanning = false
    @State private var scanSink = QRScanSink()

    init(model: GhostModel) {
        self.model = model
        _pairing = Bindable(model.pairing)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 20) {
                        GhostMark(size: 56)
                        Text("어디서든,\n내 Ghost와 이야기하세요.")
                            .font(.system(.largeTitle, design: .rounded, weight: .semibold)).tracking(-0.8)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("PC의 Ghost와 한 번 연결하면 대화와 맡긴 일을 휴대폰에서 이어갈 수 있어요.")
                            .foregroundStyle(GhostStyle.secondary)
                    }.padding(.vertical, 20)
                }.listRowBackground(Color.clear)

                if let attempt = pairing.attempt {
                    attemptCard(attempt)
                } else {
                    intakeSections
                }

                if let issue = pairing.error {
                    Section { Text(issue).foregroundStyle(GhostStyle.warning).font(.callout) }
                }
                if let issue = pairing.connectIssue {
                    Section { Text(issue).foregroundStyle(GhostStyle.warning).font(.callout) }
                }
                if let issue = pairing.intakeIssue {
                    Section { Text(issue).foregroundStyle(GhostStyle.warning).font(.callout) }
                }
            }
            .scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("Ghost").navigationBarTitleDisplayMode(.inline)
            .tint(GhostStyle.ink)
            .sheet(isPresented: $scanning) {
                QRScannerSheet(sink: scanSink)
            }
            .task {
                scanSink.onOffer = { offer in
                    pairing.acceptOffer(offer)
                    scanning = false
                }
                await pairing.restore()
            }
        }
    }

    // MARK: Pending attempt card

    @ViewBuilder private func attemptCard(_ attempt: PairingAttempt) -> some View {
        Section("연결 요청") {
            VStack(alignment: .leading, spacing: 10) {
                Text(attempt.deviceName).font(.headline)
                Text(attempt.origin.absoluteString).font(.footnote).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                Text("연결 코드 \(attempt.code)").font(.subheadline.monospaced()).textSelection(.enabled)
                if pairing.isBusy {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("연결 요청을 전달하는 중입니다.").font(.subheadline).foregroundStyle(GhostStyle.secondary)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("pairing-attempt-card")
            HStack {
                Button("전송 다시 시도") {
                    Task { await pairing.resume() }
                }
                .disabled(pairing.isBusy)
                .accessibilityIdentifier("pairing-resume")
                Spacer()
                Button("기록 지우기", role: .destructive) {
                    Task { await pairing.cancel() }
                }
                .disabled(pairing.isBusy)
                .accessibilityIdentifier("pairing-cancel-attempt")
            }
        }
        Section {
            Text("요청이 끊겼다면 같은 요청을 다시 보냅니다. 새 코드를 사용하려면 기록을 지운 뒤 다시 입력해 주세요.")
                .font(.footnote).foregroundStyle(GhostStyle.secondary)
        }
    }

    // MARK: Intake (QR scan or manual origin + code)

    @ViewBuilder private var intakeSections: some View {
        Section {
            Button {
                scanning = true
            } label: {
                HStack(spacing: 12) { Image(systemName: "qrcode.viewfinder").font(.title2); Text("QR 코드로 연결").font(.headline); Spacer(); Image(systemName: "arrow.right") }.frame(minHeight: 48)
            }
            .foregroundStyle(GhostStyle.onInk).padding(16)
            .background(GhostStyle.ink, in: RoundedRectangle(cornerRadius: 20))
            .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            .accessibilityIdentifier("pairing-scan-qr")
            Text("PC 화면의 QR 코드를 스캔하면 서버 주소와 코드가 채워집니다.")
                .font(.footnote).foregroundStyle(GhostStyle.secondary)
        }

        Section("직접 입력") {
            TextField("서버 주소 (https://… 또는 로컬 http://…)", text: $pairing.draftOrigin)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("pairing-origin-field")
            TextField("연결 코드", text: $pairing.draftCode)
                .autocorrectionDisabled()
                .monospaced()
                .accessibilityIdentifier("pairing-code-field")
                .onChange(of: pairing.draftCode) { _, newValue in
                    if newValue.count > 32 { pairing.draftCode = String(newValue.prefix(32)) }
                }
            DeviceNameField(pairing: pairing)
            Button {
                Task { await pairing.submitManual() }
            } label: {
                HStack { Text("연결 요청"); Spacer(); if pairing.isBusy { ProgressView() } else { Image(systemName: "arrow.right") } }
            }
            .disabled(!pairing.canSubmitManual)
            .accessibilityIdentifier("pairing-code-submit")
        }
    }
}

private struct DeviceNameField: View {
    @Bindable var pairing: PairingModel

    var body: some View {
        TextField("이 기기의 이름", text: $pairing.deviceName)
            .disabled(pairing.isBusy)
            .accessibilityIdentifier("pairing-device-name")
            .onChange(of: pairing.deviceName) { _, newValue in
                if newValue.count > 100 { pairing.deviceName = String(newValue.prefix(100)) }
            }
    }
}
