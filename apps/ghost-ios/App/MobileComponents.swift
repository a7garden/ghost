// Hallmark · native: Long Document / Index First · theme: Coral / Ghost porcelain
// Hallmark · pre-emit critique: P4 H4 E4 S4 R5 V4 · native adaptation verified.
import SwiftUI

struct GhostMark: View {
    var size: CGFloat = 36
    var body: some View {
        GhostSilhouette()
            .fill(GhostStyle.ink, style: FillStyle(eoFill: true))
            .frame(width: size * 0.56, height: size * 0.64)
            .frame(width: size, height: size)
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: size * 0.34))
            .accessibilityHidden(true)
    }
}

// A small, original vector mark, shared with the generated app icon.
struct GhostSilhouette: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height) }
        p.move(to: point(0.05, 0.94))
        p.addLine(to: point(0.05, 0.43))
        p.addCurve(to: point(0.5, 0.02), control1: point(0.05, 0.18), control2: point(0.23, 0.02))
        p.addCurve(to: point(0.95, 0.43), control1: point(0.77, 0.02), control2: point(0.95, 0.18))
        p.addLine(to: point(0.95, 0.94))
        p.addQuadCurve(to: point(0.73, 0.84), control: point(0.85, 1.02))
        p.addQuadCurve(to: point(0.5, 0.96), control: point(0.62, 1.02))
        p.addQuadCurve(to: point(0.27, 0.84), control: point(0.38, 1.02))
        p.addQuadCurve(to: point(0.05, 0.94), control: point(0.15, 1.02))
        p.closeSubpath()
        for x: CGFloat in [0.30, 0.59] {
            p.addRoundedRect(in: CGRect(x: rect.minX + x * rect.width, y: rect.minY + 0.36 * rect.height, width: 0.11 * rect.width, height: 0.18 * rect.height), cornerSize: CGSize(width: rect.width * 0.055, height: rect.width * 0.055))
        }
        return p
    }
}

struct GhostEmptyConversation: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            GhostMark(size: 52)
            Text("무슨 일을\n함께할까요?")
                .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                .tracking(-0.8)
                .fixedSize(horizontal: false, vertical: true)
            Text("짧은 질문부터 오래 걸리는 일까지.\n평소처럼 이야기해 주세요.")
                .font(.body).lineSpacing(5).foregroundStyle(GhostStyle.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 28).padding(.vertical, 32)
        .accessibilityElement(children: .combine)
    }
}

struct GhostMessageBubble<Accessory: View>: View {
    let text: String
    let isUser: Bool
    var label = "Ghost"
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isUser { Spacer(minLength: 44) }
            if !isUser { GhostMark(size: 28).padding(.top, 2) }
            VStack(alignment: .leading, spacing: 8) {
                if !isUser {
                    Text(label).font(.caption.weight(.semibold)).foregroundStyle(GhostStyle.secondary)
                }
                Text(text)
                    .font(.body).lineSpacing(4).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                accessory
            }
            .padding(isUser ? 16 : 0)
            .foregroundStyle(isUser ? GhostStyle.onInk : GhostStyle.text)
            .background {
                if isUser { RoundedRectangle(cornerRadius: 22).fill(GhostStyle.ink) }
            }
            if !isUser { Spacer(minLength: 8) }
        }
        .frame(maxWidth: 680, alignment: isUser ? .trailing : .leading)
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }
}

struct GhostStatusBadge: View {
    let state: String
    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(isIssue ? GhostStyle.warning : GhostStyle.secondary)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(GhostStyle.under, in: Capsule())
            .fixedSize(horizontal: false, vertical: true)
    }
    private var isIssue: Bool { ["failed", "blocked", "pending", "denied"].contains(state) }
    private var title: String {
        switch state {
        case "queued": "대기 중"
        case "running": "진행 중"
        case "waiting": "대기 중 · 확인 필요"
        case "verifying": "검수 중"
        case "blocked": "확인 필요"
        case "done": "완료"
        case "failed": "실패"
        case "cancelled": "취소됨"
        case "approved": "승인됨"
        case "answered": "답변됨"
        case "denied": "거절됨"
        case "pending": "확인 필요"
        case "unknown": "결과 확인 필요"
        default: "상태 확인 중"
        }
    }
    private var symbol: String {
        switch state {
        case "done", "approved", "answered": "checkmark.circle.fill"
        case "running", "verifying": "circle.dotted"
        case "failed", "blocked", "pending", "unknown": "exclamationmark.circle"
        case "cancelled", "denied": "pause.circle"
        default: "clock"
        }
    }
}

struct GhostNotice: View {
    let title: String
    var detail: String? = nil
    var symbol = "info.circle"
    var isError = false
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.callout.weight(.medium))
                if let detail, !detail.isEmpty { Text(detail).font(.footnote).textSelection(.enabled) }
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(isError ? GhostStyle.warning : GhostStyle.secondary)
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 16))
    }
}
