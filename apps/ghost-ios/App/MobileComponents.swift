import SwiftUI
import GhostMobileCore

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
    var ghost: Ghost?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            GhostPortrait(ghost: ghost, size: 64)
            Text("무슨 일을\n함께할까요?")
                .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                .tracking(-0.8)
                .fixedSize(horizontal: false, vertical: true)
            Text("짧은 질문부터 오래 걸리는 일까지.\n평소처럼 이야기해 주세요.")
                .font(.body).lineSpacing(5).foregroundStyle(GhostStyle.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 28).padding(.vertical, 32)
    }
}

struct GhostMessageBubble<Accessory: View>: View {
    let text: String
    let isUser: Bool
    var label = "Ghost"
    var ghost: Ghost? = nil
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isUser { Spacer(minLength: 44) }
            if !isUser { GhostPortrait(ghost: ghost, size: 32).padding(.top, 2) }
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
        HStack(spacing: 6) {
            StateGlyph(state: state, size: 14)
            Text(title)
        }
            .font(.caption.weight(.medium))
            .foregroundStyle(GhostStateToken.ink(state))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(GhostStateToken.tint(state), in: Capsule())
            .fixedSize(horizontal: false, vertical: true)
    }
    private var title: String {
        switch state {
        case "queued": "대기 중"
        case "running": "진행 중"
        case "waiting": "대기 중"
        case "verifying": "검증 중"
        case "blocked": "결과 미확정"
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

enum GhostStateToken {
    static func ink(_ state: String) -> Color {
        switch state {
        case "running", "verifying": GhostStyle.signalInk
        case "blocked", "pending", "unknown": GhostStyle.amberInk
        case "done", "approved", "answered": GhostStyle.successInk
        case "failed", "denied": GhostStyle.dangerInk
        default: GhostStyle.secondary
        }
    }
    static func tint(_ state: String) -> Color {
        switch state {
        case "running", "verifying": GhostStyle.signalTint
        case "blocked", "pending", "unknown": GhostStyle.amberTint
        case "done", "approved", "answered": GhostStyle.successTint
        case "failed", "denied": GhostStyle.dangerTint
        default: GhostStyle.under
        }
    }
    static func workState(_ state: WorkState, needsOwner: Bool) -> String {
        needsOwner && state != .blocked && !state.isTerminal ? "pending" : state.rawValue
    }
}

struct TravellingArc: View {
    var color = GhostStyle.signal
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
            Circle().trim(from: 0.05, to: 0.75)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(reduceMotion ? -90 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4 * 360))
        }.accessibilityHidden(true)
    }
}

/// A distinct shape for every state; the text badge supplies its accessible name.
struct StateGlyph: View {
    let state: String
    var size: CGFloat = 18
    var body: some View {
        Group {
            if state == "running" { TravellingArc(color: GhostStyle.signalInk) }
            else {
                Canvas { context, rect in
                    let s = rect.width / 20
                    context.scaleBy(x: s, y: s)
                    let color = GraphicsContext.Shading.color(GhostStateToken.ink(state))
                    var p = Path()
                    let cutout = GraphicsContext.Shading.color(GhostStyle.canvas)
                    switch state {
                    case "waiting":
                        context.stroke(Path(ellipseIn: CGRect(x: 3, y: 3, width: 14, height: 14)), with: color, lineWidth: 1.8)
                        p.move(to: CGPoint(x: 8, y: 7.5)); p.addLine(to: CGPoint(x: 8, y: 12.5))
                        p.move(to: CGPoint(x: 12, y: 7.5)); p.addLine(to: CGPoint(x: 12, y: 12.5))
                        context.stroke(p, with: color, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
                    case "verifying":
                        context.stroke(Path(ellipseIn: CGRect(x: 3, y: 3, width: 14, height: 14)), with: color, lineWidth: 1.8)
                        p.addArc(center: CGPoint(x: 10, y: 10), radius: 4.7, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
                        p.closeSubpath()
                        context.fill(p, with: color)
                    case "blocked", "pending", "unknown":
                        context.fill(Path(ellipseIn: CGRect(x: 1.8, y: 1.8, width: 16.4, height: 16.4)), with: color)
                        p.move(to: CGPoint(x: 10, y: 6)); p.addLine(to: CGPoint(x: 10, y: 10.6))
                        context.stroke(p, with: cutout, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        context.fill(Path(ellipseIn: CGRect(x: 8.75, y: 12.5, width: 2.5, height: 2.5)), with: cutout)
                    case "done", "approved", "answered":
                        context.fill(Path(ellipseIn: CGRect(x: 1.8, y: 1.8, width: 16.4, height: 16.4)), with: color)
                        p.move(to: CGPoint(x: 6.6, y: 10.25)); p.addLine(to: CGPoint(x: 8.9, y: 12.5)); p.addLine(to: CGPoint(x: 13.4, y: 7.75))
                        context.stroke(p, with: cutout, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    case "failed", "denied":
                        context.fill(Path(ellipseIn: CGRect(x: 1.8, y: 1.8, width: 16.4, height: 16.4)), with: color)
                        p.move(to: CGPoint(x: 7.25, y: 7.25)); p.addLine(to: CGPoint(x: 12.75, y: 12.75))
                        p.move(to: CGPoint(x: 12.75, y: 7.25)); p.addLine(to: CGPoint(x: 7.25, y: 12.75))
                        context.stroke(p, with: cutout, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    case "cancelled":
                        context.stroke(Path(ellipseIn: CGRect(x: 3, y: 3, width: 14, height: 14)), with: color, lineWidth: 1.8)
                        p.move(to: CGPoint(x: 5.5, y: 14.5)); p.addLine(to: CGPoint(x: 14.5, y: 5.5))
                        context.stroke(p, with: color, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
                    default:
                        context.stroke(Path(ellipseIn: CGRect(x: 3, y: 3, width: 14, height: 14)), with: color, style: StrokeStyle(lineWidth: 1.8, dash: [2.75, 2.6]))
                    }
                }
            }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

struct LifecycleTrack: View {
    let state: WorkState
    var needsOwner = false
    var compact = false
    private let titles = ["접수", "진행", "검증", "완료"]
    private var current: Int {
        switch state {
        case .queued: 0
        case .running, .waiting, .blocked: 1
        case .verifying: 2
        case .done: 3
        case .failed, .cancelled: 1
        }
    }
    private var color: Color { GhostStateToken.ink(GhostStateToken.workState(state, needsOwner: needsOwner)) }
    var body: some View {
        HStack(spacing: 5) {
            ForEach(titles.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 6) {
                    Capsule().fill(index == current ? color : (index < current ? color.opacity(0.30) : GhostStyle.border)).frame(height: compact ? 3 : 4)
                    if !compact {
                        Text(titles[index]).font(.caption2.weight(index == current ? .semibold : .regular))
                            .foregroundStyle(index == current ? color : GhostStyle.secondary)
                    }
                }
            }
        }.accessibilityElement(children: .ignore).accessibilityLabel("진행 단계: \(titles[current])")
    }
}

enum GhostPresence { case idle, working, needsOwner }

/// The web's 100…900 portrait coordinate space, including the approved face.
struct GhostPortrait: View {
    var ghost: Ghost?
    var size: CGFloat = 48
    var presence: GhostPresence = .idle
    private var hex: UInt32 {
        if let body = ghost?.look.body, body.count == 7, body.first == "#",
           let value = UInt32(body.dropFirst(), radix: 16) { return value }
        return UInt32(GhostAppearance.defaultBodyColor(id: ghost?.id ?? "").dropFirst(), radix: 16)!
    }
    private var faceColor: Color {
        let color = hex
        func linearChannel(_ shift: Int) -> Double {
            let v = Double((color >> shift) & 255) / 255
            return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return linearChannel(16) * 0.2126 + linearChannel(8) * 0.7152 + linearChannel(0) * 0.0722 > 0.179 ? .black : .white
    }
    var body: some View {
        Canvas { context, bounds in
            context.scaleBy(x: bounds.width / 800, y: bounds.height / 800)
            context.translateBy(x: -100, y: -100)
            let body = GraphicsContext.Shading.color(GhostStyle.color(hex))
            let face = GraphicsContext.Shading.color(faceColor)
            drawMark(context: &context, color: body, face: face, front: false)
            context.fill(bodyPath, with: body)
            var eyes = Path()
            switch ghost?.look.face ?? .bars {
            case .bars:
                for x: CGFloat in [384, 538] { eyes.addRoundedRect(in: CGRect(x: x, y: 403, width: 78, height: 27), cornerSize: CGSize(width: 13.5, height: 13.5)) }
            case .dots:
                for x: CGFloat in [399, 553] { eyes.addEllipse(in: CGRect(x: x, y: 393, width: 48, height: 48)) }
            case .tall:
                for x: CGFloat in [404, 558] { eyes.addRoundedRect(in: CGRect(x: x, y: 384, width: 38, height: 66), cornerSize: CGSize(width: 19, height: 19)) }
            case .arcs:
                for x: CGFloat in [391, 545] {
                    eyes.move(to: CGPoint(x: x, y: 428))
                    eyes.addQuadCurve(to: CGPoint(x: x + 64, y: 428), control: CGPoint(x: x + 32, y: 392))
                }
            }
            if ghost?.look.face == .arcs { context.stroke(eyes, with: face, style: StrokeStyle(lineWidth: 26, lineCap: .round)) }
            else { context.fill(eyes, with: face) }
            context.fill(Path(ellipseIn: CGRect(x: 485, y: 469, width: 30, height: 30)), with: face)
            drawMark(context: &context, color: body, face: face, front: true)
        }
        .overlay {
            if presence == .working { TravellingArc().padding(2) }
            if presence == .needsOwner {
                Circle().trim(from: 0.035, to: 0.965).stroke(GhostStyle.amber, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90)).padding(2)
                Capsule().fill(GhostStyle.amber).frame(width: 3, height: 7).offset(y: -size / 2 + 3)
            }
        }
        .frame(width: size, height: size).accessibilityHidden(true)
    }

    private var bodyPath: Path {
        var p = Path()
        switch ghost?.look.shape ?? .round {
        case .round:
            p.addEllipse(in: CGRect(x: 212, y: 212, width: 576, height: 576))
        case .egg:
            p.addEllipse(in: CGRect(x: 238, y: 212, width: 524, height: 616))
        case .squircle:
            p.addRoundedRect(in: CGRect(x: 212, y: 212, width: 576, height: 576), cornerSize: CGSize(width: 188, height: 188))
        case .sheet:
            p.addArc(center: CGPoint(x: 500, y: 500), radius: 288, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
            p.addLine(to: CGPoint(x: 788, y: 770))
            p.addQuadCurve(to: CGPoint(x: 644, y: 770), control: CGPoint(x: 716, y: 830))
            p.addQuadCurve(to: CGPoint(x: 500, y: 770), control: CGPoint(x: 572, y: 830))
            p.addQuadCurve(to: CGPoint(x: 356, y: 770), control: CGPoint(x: 428, y: 830))
            p.addQuadCurve(to: CGPoint(x: 212, y: 770), control: CGPoint(x: 284, y: 830))
            p.closeSubpath()
        }
        return p
    }

    private func drawMark(context: inout GraphicsContext, color: GraphicsContext.Shading, face: GraphicsContext.Shading, front: Bool) {
        let mark = ghost?.look.mark ?? .none
        if mark == .ring {
            var ring = Path()
            ring.addArc(center: CGPoint(x: 500, y: 500), radius: 372, startAngle: .degrees(front ? 0 : 180), endAngle: .degrees(front ? 180 : 360), clockwise: false)
            let flattened = ring.applying(CGAffineTransform(translationX: -500, y: -500))
                .applying(CGAffineTransform(scaleX: 1, y: 92.0 / 372))
                .applying(CGAffineTransform(rotationAngle: -.pi / 15))
                .applying(CGAffineTransform(translationX: 500, y: 500))
            context.opacity = front ? 1 : 0.45
            context.stroke(flattened, with: color, style: StrokeStyle(lineWidth: 26, lineCap: .round))
            context.opacity = 1
            return
        }
        if front {
            switch mark {
            case .bow:
                var bow = context
                bow.translateBy(x: 652, y: 262)
                bow.rotate(by: .degrees(-20))
                bow.translateBy(x: -652, y: -262)
                let stroke = StrokeStyle(lineWidth: 16, lineJoin: .round)
                for side in -1...1 where side != 0 {
                    let direction = CGFloat(side)
                    var wing = Path()
                    wing.move(to: CGPoint(x: 652, y: 262))
                    wing.addLine(to: CGPoint(x: 652 + direction * 86, y: 208))
                    wing.addQuadCurve(to: CGPoint(x: 652 + direction * 86, y: 316), control: CGPoint(x: 652 + direction * 106, y: 262))
                    wing.closeSubpath()
                    bow.fill(wing, with: face)
                    bow.stroke(wing, with: color, style: stroke)
                }
                let knot = Path(ellipseIn: CGRect(x: 622, y: 232, width: 60, height: 60))
                bow.fill(knot, with: face)
                bow.stroke(knot, with: color, style: stroke)
            case .headphones:
                var cups = Path()
                cups.addRoundedRect(in: CGRect(x: 140, y: 406, width: 72, height: 140), cornerSize: CGSize(width: 36, height: 36))
                cups.addRoundedRect(in: CGRect(x: 788, y: 406, width: 72, height: 140), cornerSize: CGSize(width: 36, height: 36))
                context.fill(cups, with: face)
                context.stroke(cups, with: color, lineWidth: 18)
            case .glasses:
                var glasses = Path()
                glasses.addEllipse(in: CGRect(x: 369, y: 363, width: 108, height: 108))
                glasses.addEllipse(in: CGRect(x: 523, y: 363, width: 108, height: 108))
                glasses.move(to: CGPoint(x: 477, y: 410))
                glasses.addQuadCurve(to: CGPoint(x: 523, y: 410), control: CGPoint(x: 500, y: 396))
                context.stroke(glasses, with: face, style: StrokeStyle(lineWidth: 16, lineCap: .round))
            default: break
            }
            return
        }
        var p = Path()
        switch mark {
        case .halo:
            context.stroke(Path(ellipseIn: CGRect(x: 350, y: 124, width: 300, height: 68)), with: color, lineWidth: 24)
        case .antenna:
            p.addRoundedRect(in: CGRect(x: 488, y: 128, width: 24, height: 96), cornerSize: CGSize(width: 12, height: 12))
            p.addEllipse(in: CGRect(x: 466, y: 92, width: 68, height: 68))
        case .sprout:
            p.move(to: CGPoint(x: 500, y: 214))
            p.addCurve(to: CGPoint(x: 418, y: 138), control1: CGPoint(x: 500, y: 170), control2: CGPoint(x: 470, y: 140))
            p.addCurve(to: CGPoint(x: 500, y: 214), control1: CGPoint(x: 420, y: 186), control2: CGPoint(x: 452, y: 214))
            p.move(to: CGPoint(x: 500, y: 214))
            p.addCurve(to: CGPoint(x: 600, y: 120), control1: CGPoint(x: 500, y: 160), control2: CGPoint(x: 536, y: 122))
            p.addCurve(to: CGPoint(x: 500, y: 214), control1: CGPoint(x: 598, y: 178), control2: CGPoint(x: 556, y: 214))
        case .spark:
            p.move(to: CGPoint(x: 790, y: 170))
            p.addCurve(to: CGPoint(x: 870, y: 250), control1: CGPoint(x: 798, y: 222), control2: CGPoint(x: 818, y: 242))
            p.addCurve(to: CGPoint(x: 790, y: 330), control1: CGPoint(x: 818, y: 258), control2: CGPoint(x: 798, y: 278))
            p.addCurve(to: CGPoint(x: 710, y: 250), control1: CGPoint(x: 782, y: 278), control2: CGPoint(x: 762, y: 258))
            p.addCurve(to: CGPoint(x: 790, y: 170), control1: CGPoint(x: 762, y: 242), control2: CGPoint(x: 782, y: 222))
        case .crown:
            p.move(to: CGPoint(x: 372, y: 262))
            p.addLine(to: CGPoint(x: 352, y: 134))
            p.addLine(to: CGPoint(x: 432, y: 196))
            p.addLine(to: CGPoint(x: 500, y: 110))
            p.addLine(to: CGPoint(x: 568, y: 196))
            p.addLine(to: CGPoint(x: 648, y: 134))
            p.addLine(to: CGPoint(x: 628, y: 262))
            p.closeSubpath()
            context.stroke(p, with: color, style: StrokeStyle(lineWidth: 18, lineJoin: .round))
        case .ears:
            p.move(to: CGPoint(x: 300, y: 330))
            p.addLine(to: CGPoint(x: 322, y: 166))
            p.addLine(to: CGPoint(x: 440, y: 250))
            p.closeSubpath()
            p.move(to: CGPoint(x: 700, y: 330))
            p.addLine(to: CGPoint(x: 678, y: 166))
            p.addLine(to: CGPoint(x: 560, y: 250))
            p.closeSubpath()
            context.stroke(p, with: color, style: StrokeStyle(lineWidth: 24, lineJoin: .round))
        case .horns:
            p.move(to: CGPoint(x: 352, y: 300))
            p.addCurve(to: CGPoint(x: 332, y: 136), control1: CGPoint(x: 318, y: 252), control2: CGPoint(x: 300, y: 190))
            p.addCurve(to: CGPoint(x: 432, y: 262), control1: CGPoint(x: 352, y: 190), control2: CGPoint(x: 392, y: 228))
            p.closeSubpath()
            p.move(to: CGPoint(x: 648, y: 300))
            p.addCurve(to: CGPoint(x: 668, y: 136), control1: CGPoint(x: 682, y: 252), control2: CGPoint(x: 700, y: 190))
            p.addCurve(to: CGPoint(x: 568, y: 262), control1: CGPoint(x: 648, y: 190), control2: CGPoint(x: 608, y: 228))
            p.closeSubpath()
        case .headphones:
            p.addArc(center: CGPoint(x: 500, y: 476), radius: 324, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
            context.stroke(p, with: color, style: StrokeStyle(lineWidth: 28, lineCap: .round))
            return
        case .none, .ring, .bow, .glasses: break
        }
        context.fill(p, with: color)
    }
}

/// Explicit label/fill tokens keep primary actions legible in both appearances.
struct GhostPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(isEnabled ? GhostStyle.onInk : GhostStyle.secondary)
            .padding(.horizontal, 16).padding(.vertical, 10).frame(minHeight: 44)
            .background(isEnabled ? GhostStyle.ink : GhostStyle.ink.opacity(0.12), in: Capsule())
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
