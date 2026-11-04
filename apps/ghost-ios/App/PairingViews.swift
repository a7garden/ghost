import SwiftUI
import GhostMobileCore

// The connect screen: pairing only. There is no manual server-address or
// connection-key entry anywhere — QR scan, a Bonjour-discovered nearby
// server with the 8-character code, or a `ghost://connect` deep link.
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
                if let issue = pairing.deepLinkIssue {
                    Section { Text(issue).foregroundStyle(GhostStyle.warning).font(.callout) }
                }
            }
            .scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("Ghost").navigationBarTitleDisplayMode(.inline)
            .tint(GhostStyle.ink)
            .sheet(isPresented: $scanning) {
                QRScannerSheet(sink: scanSink)
            }
            .sheet(item: linkDraftBinding) { draft in
                LinkConfirmSheet(pairing: pairing, invitation: draft.invitation)
            }
            .task {
                scanSink.onInvitation = { invitation in
                    pairing.acceptScanned(invitation)
                    scanning = false
                }
                pairing.discovery.start()
                await pairing.runVisibleLoop()
            }
            .onDisappear {
                pairing.discovery.stop()
            }
        }
    }

    private var linkDraftBinding: Binding<LinkDraft?> {
        Binding<LinkDraft?>(
            get: { pairing.linkDraft.map(LinkDraft.init(invitation:)) },
            set: { if $0 == nil { pairing.dismissLinkDraft() } })
    }

    // MARK: Pending attempt card

    @ViewBuilder private func attemptCard(_ attempt: PairingAttempt) -> some View {
        Section("연결 요청") {
            VStack(alignment: .leading, spacing: 10) {
                Text(attempt.deviceName).font(.headline)
                Text(attempt.origin.absoluteString).font(.footnote).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                statusLine(attempt)
                if let code = attempt.verificationCode, attempt.status == .pending || attempt.status == .approved {
                    Text(code)
                        .font(.system(.largeTitle, design: .monospaced, weight: .bold)).tracking(4)
                        .padding(.vertical, 20).foregroundStyle(GhostStyle.accent)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("pairing-verification-code")
                }
                if let issue = pairing.connectIssue {
                    Text(issue).font(.caption).foregroundStyle(GhostStyle.warning)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("pairing-attempt-card")
            HStack {
                if attempt.status != .revoked && attempt.status != .cancelled {
                    Button(resumeLabel(attempt)) {
                        Task { await pairing.resume() }
                    }
                    .disabled(pairing.isBusy)
                    .accessibilityIdentifier("pairing-resume")
                }
                Button(cancelLabel(attempt), role: .destructive) {
                    Task { await pairing.cancel() }
                }
                .disabled(pairing.isBusy)
                .accessibilityIdentifier("pairing-cancel-attempt")
            }
        }
        Section {
            Text(statusDetail(attempt)).font(.footnote).foregroundStyle(GhostStyle.secondary)
        }
    }

    private func statusLine(_ attempt: PairingAttempt) -> some View {
        let label: String
        switch attempt.status {
        case .claiming: label = "요청 전송 중"
        case .pending: label = "PC에서 확인"
        case .approved: label = pairing.connectIssue == nil ? "승인됨 · 연결 중" : "승인됨 · 연결 대기"
        case .cancelled: label = "취소됨"
        case .expired: label = "만료됨"
        case .revoked: label = "철회됨"
        }
        return Text(label).font(.subheadline).foregroundStyle(attempt.status == .pending ? GhostStyle.text : GhostStyle.secondary)
    }

    private func resumeLabel(_ attempt: PairingAttempt) -> String {
        switch attempt.status {
        case .claiming: "전송 다시 시도"
        case .pending: "상태 다시 확인"
        case .approved: "연결 다시 시도"
        case .expired: "서버 상태 확인"
        default: "다시 시도"
        }
    }

    private func cancelLabel(_ attempt: PairingAttempt) -> String {
        attempt.status.isTerminal ? "기록 지우기" : "연결 요청 취소"
    }

    private func statusDetail(_ attempt: PairingAttempt) -> String {
        switch attempt.status {
        case .claiming:
            "연결 요청을 서버에 전달하는 중입니다. 전송 결과를 알 수 없으면 같은 요청을 다시 보내며, 새 키를 만들지 않습니다."
        case .pending:
            "PC의 Ghost 화면에서 이 기기 이름과 위 6자리 확인 코드가 일치하는지 확인한 뒤 승인해 주세요. 요청은 5분 뒤 만료됩니다."
        case .approved:
            "PC에서 승인되었습니다. 승인된 권한 범위로 이 기기를 연결하는 중입니다."
        case .cancelled:
            "PC에서 이 연결 요청이 취소되었습니다. 기록을 지운 뒤 새 요청을 만들 수 있습니다."
        case .expired:
            "연결 요청이 만료되었습니다. 서버의 최종 상태를 확인하거나 기록을 지우고 새 요청을 만들어 주세요."
        case .revoked:
            "이 기기의 접근이 서버에서 철회되었거나 취소되었습니다. 다시 연결하려면 새 요청을 만들어야 합니다."
        }
    }

    // MARK: Intake (QR / nearby code)

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
            Text("PC 화면의 QR 코드를 스캔하면 서버 주소를 직접 입력할 필요가 없습니다.")
                .font(.footnote).foregroundStyle(GhostStyle.secondary)
        }

        Section("근처 서버") {
            if pairing.discovery.candidates.isEmpty {
                Text(pairing.discovery.isBrowsing
                    ? "근처에서 Ghost 서버를 찾는 중입니다. PC와 같은 네트워크에 연결되어 있는지 확인해 주세요."
                    : "근처 서버를 찾지 못했습니다. PC 화면의 QR 코드를 스캔해 주세요.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)
            } else {
                ForEach(pairing.discovery.candidates) { candidate in
                    Button {
                        pairing.select(candidate)
                    } label: {
                        HStack {
                            Image(systemName: "desktopcomputer")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.name).font(.subheadline)
                                Text(candidate.origin.host() ?? "").font(.caption).foregroundStyle(GhostStyle.secondary)
                            }
                            Spacer()
                            if pairing.selectedCandidate?.id == candidate.id {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                    .accessibilityIdentifier("pairing-candidate-\(candidate.origin.host() ?? candidate.name)")
                }
                Text("근처에서 자동으로 찾은 Ghost 서버입니다. 목록을 선택하고 PC 화면의 8자리 코드를 입력하세요.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)
            }
            if let issue = pairing.discovery.issue {
                Text(issue).font(.caption).foregroundStyle(GhostStyle.warning)
            }
        }

        if let candidate = pairing.selectedCandidate {
            Section("8자리 코드 · \(candidate.name)") {
                TextField("XXXX-XXXX", text: $pairing.draftCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .monospaced()
                    .accessibilityIdentifier("pairing-code-field")
                    .onChange(of: pairing.draftCode) { _, newValue in
                        if newValue.count > 16 { pairing.draftCode = String(newValue.prefix(16)) }
                    }
                DeviceNameField(pairing: pairing)
                Button {
                    Task { await pairing.beginWithCode() }
                } label: {
                    HStack { Text("연결 요청"); Spacer(); if pairing.isBusy { ProgressView() } else { Image(systemName: "arrow.right") } }
                }
                .disabled(pairing.isBusy || pairing.normalizedDraftCode == nil)
                .accessibilityIdentifier("pairing-code-submit")
                Text("연결 요청을 보내면 PC에서 기기 이름과 확인 코드를 승인할 때까지 대기 상태로 유지됩니다.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)
            }
        }
    }
}

// Deep-link confirmation: the parsed origin is shown exactly as validated,
// and nothing is claimed until the user presses 연결 요청.
private struct LinkConfirmSheet: View {
    let pairing: PairingModel
    let invitation: PairingInvitation
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("PC의 연결 요청") {
                    LabeledContent("서버", value: invitation.origin.absoluteString)
                        .font(.footnote)
                    LabeledContent("초대 ID", value: invitation.invitationID.uuidString).font(.footnote).textSelection(.enabled)
                }
                Section("이 기기") {
                    DeviceNameField(pairing: pairing)
                }
                Section {
                    Button {
                        Task {
                            await pairing.confirmLinkDraft()
                            dismiss()
                        }
                    } label: {
                        HStack { Text("연결 요청"); Spacer(); if pairing.isBusy { ProgressView() } }
                    }
                    .disabled(pairing.isBusy)
                    .accessibilityIdentifier("pairing-confirm-link")
                    Button("취소", role: .cancel) {
                        pairing.dismissLinkDraft()
                        dismiss()
                    }
                }
                Section {
                    Text("연결 요청을 보내면 이 기기의 새 연결 키가 만들어지고 서버에는 암호화된 지문만 전달됩니다. PC에서 확인 코드를 승인하면 연결됩니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
            }
            .scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("연결 확인")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct DeviceNameField: View {
    @Bindable var pairing: PairingModel

    var body: some View {
        TextField("이 기기의 이름", text: $pairing.deviceName)
            .disabled(pairing.activeAttempt)
            .accessibilityIdentifier("pairing-device-name")
            .onChange(of: pairing.deviceName) { _, newValue in
                if newValue.count > 100 { pairing.deviceName = String(newValue.prefix(100)) }
            }
    }
}

struct LinkDraft: Identifiable, Equatable {
    let invitation: PairingInvitation
    var id: String { invitation.invitationID.uuidString + invitation.origin.absoluteString }
}
