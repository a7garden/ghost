import SwiftUI
import GhostMobileCore

// Native call UI. The CallKit controller owns the audio session and the
// lock-screen call interface, so leaving this screen never ends the call.
// The controller lives on the model: the call continues after this screen is
// dismissed and ends through CallKit or the in-call controls.
struct VoiceScreen: View {
    @Environment(\.dismiss) private var dismiss
    let model: GhostModel

    var body: some View {
        NavigationStack {
            Group {
                if let controller = model.activeCall {
                    CallContent(model: model, controller: controller, leave: dismiss)
                } else {
                    ContentUnavailableView("진행 중인 통화가 없습니다", systemImage: "phone.badge.xmark",
                        description: Text("이 화면은 닫혀도 통화가 계속됩니다."))
            }
            }
            .navigationTitle("Ghost와 통화").navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled(model.activeCall.map { $0.phase == .connecting || $0.phase == .ending } ?? false)
    }
}

private struct CallContent: View {
    let model: GhostModel
    let controller: VoiceCallController
    let leave: DismissAction

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            GhostMark(size: 96)
            Text("Ghost").font(.largeTitle.weight(.semibold))
            Text(statusText).font(.headline).multilineTextAlignment(.center)
            if controller.phase == .active || controller.phase == .reconnecting {
                Text(timeString(controller.elapsed)).font(.title2.monospacedDigit()).foregroundStyle(GhostStyle.secondary)
                if !controller.turnState.isEmpty {
                    Text(turnLabel).font(.callout).foregroundStyle(GhostStyle.secondary)
                }
            }
            if let error = controller.errorText {
                Text(error).font(.callout).foregroundStyle(GhostStyle.warning).multilineTextAlignment(.center).padding(.horizontal, 24)
            }
            Spacer()
            controls.padding(.bottom, 48)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(GhostStyle.surface)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("닫기") { leave() }
                    .disabled(controller.phase == .connecting || controller.phase == .ending)
            }
        }
        .onChange(of: controller.phase) {
            if controller.phase == .ended {
                controller.stop()
                model.activeCallDidEnd()
            }
        }
    }

    private var statusText: String {
        switch controller.phase {
        case .idle: "통화를 시작합니다."
        case .connecting: "통화 연결 중"
        case .active: controller.muted ? "마이크가 꺼진 통화 중" : "Ghost와 통화 중"
        case .reconnecting: "음성 연결 복구 중"
        case .ending: "통화 종료 확인 중"
        case .unconfirmed: "서버 종료 확인 필요"
        case .ended: "통화 종료"
        }
    }

    private var turnLabel: String {
        switch controller.turnState {
        case "queued": "Ghost가 요청을 준비하는 중"
        case "running": "Ghost가 답변하는 중"
        case "answered": "답변 완료"
        case "cancelled": "취소된 요청"
        default: "발화 상태: \(controller.turnState)"
        }
    }

    @ViewBuilder private var controls: some View {
        switch controller.phase {
        case .connecting:
            Button("연결 취소", role: .destructive) { controller.cancelWhileConnecting() }
                .controlSize(.large).buttonStyle(.bordered)
        case .active, .reconnecting:
            HStack(spacing: 40) {
                Button { controller.setMuted(!controller.muted) } label: {
                    VStack(spacing: 6) {
                        Image(systemName: controller.muted ? "mic.slash.fill" : "mic.fill").font(.title2)
                            .frame(width: 72, height: 72)
                            .background(GhostStyle.under, in: Circle())
                        Text(controller.muted ? "마이크 켜기" : "마이크 끄기").font(.caption)
                    }
                }
                .accessibilityLabel(controller.muted ? "마이크 켜기" : "마이크 끄기")
                Button(role: .destructive) { controller.end() } label: {
                    VStack(spacing: 6) {
                        Image(systemName: "phone.down.fill").font(.title2).foregroundStyle(GhostStyle.onDestructive)
                            .frame(width: 72, height: 72).background(GhostStyle.destructive, in: Circle())
                        Text("통화 종료").font(.caption)
                    }
                }
            }.buttonStyle(.plain).controlSize(.large)
        case .unconfirmed:
            VStack(spacing: 12) {
                Button("서버 종료 다시 확인") { controller.retryServerHangup() }
                    .controlSize(.large).buttonStyle(.borderedProminent)
                Text("마이크는 닫혔습니다. 같은 통화에 대해 서버 종료를 다시 확인합니다. 화면을 닫아도 종료 확인은 유지됩니다.").font(.footnote).foregroundStyle(GhostStyle.secondary)
            }
        default:
            Button("닫기") { leave() }.buttonStyle(.plain).controlSize(.large).buttonStyle(.bordered)
        }
    }

    private func timeString(_ interval: TimeInterval) -> String {
        let seconds = Int(interval)
        return "\(seconds / 60):" + String(format: "%02d", seconds % 60)
    }
}
