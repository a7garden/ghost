import SwiftUI
import GhostMobileCore

/// What this conversation needs from the owner, docked above the composer: the oldest decision
/// on top and actionable, the rest peeking behind as slivers. It never takes more than a part
/// of the screen; long cards scroll inside, and it folds to one line while the owner types.
struct DecisionDeck: View {
    let model: GhostModel
    let ghostId: String
    let conversationId: String
    var openWork: (String) -> Void = { _ in }
    var composerFocused = false
    @State private var selectedId: String?
    @State private var collapsed = false
    @State private var cardHeight: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var decisions: [Decision] { model.snapshot.chatDecisions(ghostId: ghostId, conversationId: conversationId) }
    private var index: Int { decisions.firstIndex { $0.id == selectedId } ?? 0 }

    var body: some View {
        if !decisions.isEmpty {
            let decision = decisions[index]
            let behind = min(2, decisions.count - 1)
            VStack(spacing: 6) {
                if collapsed {
                    bar(decision)
                } else {
                    head
                    ScrollView {
                        DecisionCard(model: model, decision: decision, openWork: openWork)
                            .id(decision.id)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { cardHeight = $0 }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: min(cardHeight == 0 ? 240 : cardHeight, maxCardHeight))
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .background(alignment: .bottom) {
                        // Slivers of the decisions waiting behind, sized by the card itself.
                        ZStack(alignment: .bottom) {
                            ForEach(Array((0..<behind).reversed()), id: \.self) { layer in
                                RoundedRectangle(cornerRadius: 20, style: .continuous)
                                    .fill(GhostStyle.surface)
                                    .overlay { RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(GhostStyle.border, lineWidth: 1) }
                                    .padding(.horizontal, CGFloat(layer + 1) * 10)
                                    .offset(y: CGFloat(layer + 1) * 5)
                            }
                        }
                        .accessibilityHidden(true)
                    }
                    .padding(.bottom, CGFloat(behind) * 5)
                    .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: collapsed)
            .onChange(of: composerFocused) { if composerFocused { collapsed = true } }
            .onChange(of: decisions.map(\.id)) { old, new in
                if let selectedId, !new.contains(selectedId) {
                    let oldIndex = old.firstIndex(of: selectedId) ?? 0
                    self.selectedId = new.isEmpty ? nil : new[min(oldIndex, new.count - 1)]
                }
            }
        }
    }

    /// At most about two fifths of the screen, so the conversation stays readable.
    private var maxCardHeight: CGFloat { max(220, UIScreen.main.bounds.height * 0.4) }

    private var head: some View {
        HStack(spacing: 2) {
            StateGlyph(state: "attention", size: 14)
            Text("확인 필요").font(.caption.weight(.semibold)).padding(.leading, 4)
            Text("\(decisions.count)").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(GhostStyle.amberInk)
            Spacer(minLength: 4)
            if decisions.count > 1 {
                Button { select(index - 1) } label: { Image(systemName: "chevron.left").frame(width: 36, height: 36) }
                    .accessibilityLabel("이전 항목").disabled(index == 0)
                Text("\(index + 1) / \(decisions.count)").font(.caption.monospacedDigit())
                    .accessibilityLabel("\(decisions.count)개 중 \(index + 1)번째")
                Button { select(index + 1) } label: { Image(systemName: "chevron.right").frame(width: 36, height: 36) }
                    .accessibilityLabel("다음 항목").disabled(index == decisions.count - 1)
            }
            Button { collapsed = true } label: { Image(systemName: "chevron.down").frame(width: 36, height: 36) }
                .accessibilityLabel("확인 필요 접기")
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(GhostStyle.secondary)
        .padding(.leading, 6)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func bar(_ decision: Decision) -> some View {
        Button { collapsed = false } label: {
            HStack(spacing: 10) {
                StateGlyph(state: "attention", size: 16)
                Text(model.snapshot.heading(of: decision)).font(.footnote.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if decisions.count > 1 {
                    Text("\(decisions.count)").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(GhostStyle.amberInk)
                }
                Image(systemName: "chevron.up").font(.caption.weight(.semibold)).foregroundStyle(GhostStyle.secondary)
            }
            .foregroundStyle(GhostStyle.text)
            .padding(.horizontal, 14).frame(minHeight: 44)
            .background(GhostStyle.amberTint, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("확인 필요 \(decisions.count)개, \(model.snapshot.heading(of: decision))")
        .accessibilityHint("펼치기")
        .transition(.opacity)
    }

    private func select(_ index: Int) {
        guard decisions.indices.contains(index) else { return }
        selectedId = decisions[index].id
    }
}
