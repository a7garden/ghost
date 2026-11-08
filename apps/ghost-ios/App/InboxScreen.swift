import SwiftUI
import GhostMobileCore

struct InboxScreen: View {
    let model: GhostModel
    @State private var workId: String?
    @State private var openingNotificationId: String?

    private var pendingDecisions: [Decision] { model.snapshot.pendingDecisions }
    private var settledDecisions: [Decision] {
        model.snapshot.decisions.filter { !$0.isPending }
            .sorted { ($0.resolvedAt ?? $0.createdAt) > ($1.resolvedAt ?? $1.createdAt) }
    }
    private var notifications: [GhostNotification] {
        model.snapshot.notifications.sorted {
            if $0.isRead != $1.isRead { return !$0.isRead }
            return $0.createdAt > $1.createdAt
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    decisionsSection
                    notificationsSection
                    if let error = model.error { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                }.padding(16).frame(maxWidth: 720).frame(maxWidth: .infinity)
            }
            .background(GhostStyle.canvas).foregroundStyle(GhostStyle.ink)
            .navigationTitle("소식")
            .refreshable { await model.refresh() }
            .onDisappear { model.saveDrafts() }
            .onChange(of: model.busy) { if !model.busy { openingNotificationId = nil } }
            .sheet(isPresented: Binding(get: { workId != nil }, set: { if !$0 { workId = nil } })) {
                NavigationStack {
                    if let workId { WorkDetailScreen(model: model, workId: workId) }
                }.presentationDetents([.large]).presentationDragIndicator(.visible)
            }
        }
    }

    private var decisionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("확인 필요").font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
            if pendingDecisions.isEmpty {
                Text("확인할 결정 없음").font(.callout).foregroundStyle(GhostStyle.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                    .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 20))
            }
            ForEach(pendingDecisions) { decision in
                DecisionCard(model: model, decision: decision, openWork: { workId = $0 })
            }
            ForEach(settledDecisions.prefix(5)) { decision in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: decision.state == .approved || decision.state == .answered ? "checkmark.circle" : "xmark.circle")
                    Text(model.snapshot.heading(of: decision)).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                    Text(decisionStateLabel(decision.state)).font(.caption)
                }.foregroundStyle(GhostStyle.secondary).padding(12)
            }
        }
    }

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("새 소식").font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
            if notifications.isEmpty {
                Text("새 소식이 오면 알려드릴게요").font(.callout).foregroundStyle(GhostStyle.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                    .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 20))
            } else {
                VStack(spacing: 0) {
                    ForEach(notifications) { notification in
                        notificationRow(notification)
                        if notification.id != notifications.last?.id {
                            Rectangle().fill(GhostStyle.border).frame(height: 1).padding(.horizontal, 16)
                        }
                    }
                }.background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 20))
                    .overlay { RoundedRectangle(cornerRadius: 20).stroke(GhostStyle.border, lineWidth: 1) }
            }
        }
    }

    private func notificationRow(_ notification: GhostNotification) -> some View {
        Button {
            openingNotificationId = notification.id
            model.route(notification)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Circle().fill(notification.isRead ? GhostStyle.border : GhostStyle.signal)
                    .frame(width: 8, height: 8).padding(.top, 8).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(notification.title).font(.subheadline.weight(notification.isRead ? .regular : .semibold))
                        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    if !notification.body.isEmpty {
                        Text(notification.body).font(.footnote).foregroundStyle(GhostStyle.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading).lineLimit(3)
                    }
                    Text(model.relativeTime(notification.createdAt)).font(.caption).foregroundStyle(GhostStyle.secondary)
                }
                if openingNotificationId == notification.id { ProgressView().accessibilityLabel("읽음 표시 중") }
            }.padding(16).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(GhostStyle.ink)
        .disabled(!model.isOnline || model.busy || openingNotificationId != nil)
        .accessibilityValue(notification.isRead ? "읽음" : "읽지 않음")
        .accessibilityIdentifier("notification-\(notification.id)")
    }

    private func decisionStateLabel(_ state: DecisionState) -> String {
        switch state {
        case .approved: "승인됨"
        case .denied: "거절됨"
        case .answered: "답변됨"
        case .cancelled: "취소됨"
        case .pending: "확인 필요"
        }
    }
}
