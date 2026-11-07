import SwiftUI
import GhostMobileCore

// 맡긴 일 tab: live and recent settled work with state, result, verdict and
// the cancel / resume / edit controls.
struct WorkListScreen: View {
    let model: GhostModel
    @State private var path = NavigationPath()

    private var active: [Work] {
        model.snapshot.works.filter { !$0.state.isTerminal }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private var settled: [Work] {
        model.snapshot.works.filter { $0.state.isTerminal }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if model.snapshot.works.isEmpty {
                    ContentUnavailableView("맡긴 일 없음", systemImage: "checklist",
                        description: Text("대화에서 Ghost에게 일을 맡기면 여기에 표시됩니다."))
                }
                if !active.isEmpty {
                    Section("진행 중") {
                        ForEach(active) { work in
                            NavigationLink(value: work.id) { WorkRow(model: model, work: work) }
                                .accessibilityIdentifier("work-\(work.id)")
                        }
                    }
                }
                if !settled.isEmpty {
                    Section("완료") {
                        ForEach(settled) { work in
                            NavigationLink(value: work.id) { WorkRow(model: model, work: work) }
                                .accessibilityIdentifier("work-\(work.id)")
                        }
                    }
                }
                if let error = model.error {
                    Section { Text(error).font(.caption).foregroundStyle(GhostStyle.warning) }
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("맡긴 일")
            .navigationDestination(for: String.self) { workId in
                WorkDetailScreen(model: model, workId: workId)
            }
            .refreshable { await model.refresh() }
        }
        .onChange(of: model.notificationRoute) {
            guard let route = model.notificationRoute,
                  let notification = model.snapshot.notifications.first(where: { $0.id == route.notificationId }),
                  let workId = notification.workId else { return }
            path.append(workId)
        }
    }
}

private struct WorkRow: View {
    let model: GhostModel
    let work: Work

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(work.title).font(.subheadline.weight(.medium)).lineLimit(2)
            HStack(spacing: 8) {
                GhostStatusBadge(state: GhostStateToken.workState(work.state, needsOwner: model.snapshot.decisions.contains { $0.workId == work.id && $0.isPending }))
                Text(model.ghostName(work.ghostId)).font(.caption).foregroundStyle(GhostStyle.secondary)
                if let deadline = work.deadlineAt, !work.state.isTerminal {
                    Text("기한 \(model.deadlineText(deadline))").font(.caption).foregroundStyle(GhostStyle.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct WorkThreadCard: View {
    let model: GhostModel
    let work: Work
    private var needsOwner: Bool { model.snapshot.decisions.contains { $0.workId == work.id && $0.isPending } }
    private var displayState: String { GhostStateToken.workState(work.state, needsOwner: needsOwner) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                StateGlyph(state: displayState, size: 20).padding(.top, 2)
                VStack(alignment: .leading, spacing: 6) {
                    Text(work.title).font(.callout.weight(.semibold)).foregroundStyle(GhostStyle.ink)
                    HStack(spacing: 6) {
                        GhostPortrait(ghost: model.ghost(work.ghostId), size: 24)
                        Text(model.ghostName(work.ghostId)).font(.caption).foregroundStyle(GhostStyle.secondary)
                        Spacer(minLength: 4)
                        GhostStatusBadge(state: displayState)
                    }
                }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(GhostStyle.secondary).padding(.top, 4)
            }
            LifecycleTrack(state: work.state, needsOwner: needsOwner, compact: true)
        }.padding(16).frame(maxWidth: 680, alignment: .leading)
            .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 18))
            .shadow(color: GhostStyle.shadow, radius: 8, y: 2)
    }
}

struct WorkDetailScreen: View {
    let model: GhostModel
    let workId: String
    @State private var detail: WorkDetail?
    @State private var loadError: String?
    @State private var showingEdit = false
    @State private var confirmingCancel = false
    @State private var confirmingResume = false
    @State private var actionIssue: String?
    @State private var selectedDigest: String?

    private var work: Work? { detail?.work }

    var body: some View {
        List {
            if let detail {
                headerSection(detail)
                briefSection(detail)
                outcomeSection(detail)
                if !detail.children.isEmpty { childrenSection(detail) }
                if !detail.decisions.isEmpty { decisionsSection(detail) }
                if !detail.effects.isEmpty { effectsSection(detail) }
                if !detail.artifacts.isEmpty { artifactsSection(detail.artifacts) }
            } else if let loadError {
                Section { GhostNotice(title: "맡긴 일을 불러오지 못했습니다", detail: loadError, symbol: "exclamationmark.circle", isError: true) }
            } else {
                Section { ProgressView("불러오는 중") }.listRowBackground(Color.clear)
            }
            if let issue = actionIssue {
                Section { Text(issue).font(.caption).foregroundStyle(GhostStyle.warning) }
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(GhostStyle.canvas)
        .navigationTitle("맡긴 일").navigationBarTitleDisplayMode(.inline)
        .task(id: workId) { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingEdit) {
            if let work {
                WorkEditSheet(model: model, work: work) { await load() }
            }
        }
        .navigationDestination(for: String.self) { childId in
            WorkDetailScreen(model: model, workId: childId)
        }
        .sheet(item: Binding(
            get: { selectedDigest.map { ArtifactTarget(digest: $0) } },
            set: { selectedDigest = $0?.digest })) { target in
            ArtifactScreen(model: model, digest: target.digest)
        }
    }

    private struct ArtifactTarget: Identifiable {
        let digest: String
        var id: String { digest }
    }

    // MARK: Sections

    private func headerSection(_ detail: WorkDetail) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text(detail.work.title).font(.title3.weight(.semibold))
                HStack(spacing: 8) {
                    GhostStatusBadge(state: GhostStateToken.workState(detail.work.state, needsOwner: detail.decisions.contains { $0.isPending }))
                    Text(model.ghostName(detail.work.ghostId)).font(.caption).foregroundStyle(GhostStyle.secondary)
                    Text("수정 \(detail.work.revision)회차").font(.caption).foregroundStyle(GhostStyle.secondary)
                }
                LifecycleTrack(state: detail.work.state, needsOwner: detail.decisions.contains { $0.isPending }).padding(.vertical, 8)
                if let deadline = detail.work.deadlineAt {
                    LabeledContent("기한", value: model.deadlineText(deadline))
                }
                if let started = detail.work.startedAt {
                    LabeledContent("시작", value: model.deadlineText(started))
                }
                if let ended = detail.work.endedAt {
                    LabeledContent("종료", value: model.deadlineText(ended))
                }
                if let reason = detail.work.reason, !reason.isEmpty {
                    Text(reason).font(.footnote).foregroundStyle(GhostStyle.warning)
                }
                actionBar(detail.work)
            }
        }
    }

    @ViewBuilder
    private func actionBar(_ work: Work) -> some View {
        HStack(spacing: 12) {
            if !work.state.isTerminal {
                Button("편집") { showingEdit = true }
                    .buttonStyle(.bordered)
                    .disabled(model.busy || !model.isOnline)
                    .accessibilityIdentifier("work-edit")
                Button("취소", role: .destructive) { confirmingCancel = true }
                    .buttonStyle(.bordered)
                    .disabled(model.busy || !model.isOnline)
                    .accessibilityIdentifier("work-cancel")
            }
            if work.state == .failed || work.state == .blocked, work.parentId == nil {
                Button("재개") { confirmingResume = true }
                    .buttonStyle(GhostPrimaryButtonStyle())
                    .disabled(model.busy || !model.isOnline)
                    .accessibilityIdentifier("work-resume")
            }
        }
        .confirmationDialog("이 맡긴 일을 취소할까요?", isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("취소", role: .destructive) { Task { await send(.workCancel(workId: workId)) } }
        } message: {
            Text("진행 중인 하위 일도 함께 취소됩니다.")
        }
        .confirmationDialog("이 맡긴 일을 다시 진행할까요?", isPresented: $confirmingResume, titleVisibility: .visible) {
            Button("재개") { Task { await send(.workResume(workId: workId)) } }
        } message: {
            Text("현재 내용으로 다시 진행합니다.")
        }
    }

    private func briefSection(_ detail: WorkDetail) -> some View {
        Section("요청 내용") {
            Text(detail.work.brief).font(.callout).textSelection(.enabled)
            if !detail.work.acceptance.criteria.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("완료 기준").font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
                    Text(detail.work.acceptance.criteria).font(.footnote).textSelection(.enabled)
                }
            }
            if let parent = detail.ancestors.last {
                NavigationLink(value: parent.id) {
                    LabeledContent("상위 일", value: parent.title).lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder
    private func outcomeSection(_ detail: WorkDetail) -> some View {
        if detail.work.state.isTerminal || detail.work.result != nil || detail.work.verdict != nil {
            Section("결과") {
                if let result = detail.work.result {
                    Text(result.summary).font(.callout).textSelection(.enabled)
                } else if detail.work.state.isTerminal {
                    Text(detail.work.state == .cancelled ? "취소되었습니다." : (detail.work.state == .failed ? "완료되지 못했습니다." : "결과 없음"))
                        .font(.callout).foregroundStyle(GhostStyle.secondary)
                }
                if let verdict = detail.work.verdict {
                    VStack(alignment: .leading, spacing: 4) {
                        LabeledContent("검수", value: verdictLabel(verdict))
                        Text(verdict.reasons).font(.footnote).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func childrenSection(_ detail: WorkDetail) -> some View {
        Section("위임한 일") {
            ForEach(detail.children) { child in
                NavigationLink(value: child.id) { WorkRow(model: model, work: child) }
            }
        }
    }

    private func decisionsSection(_ detail: WorkDetail) -> some View {
        Section("관련 결정") {
            ForEach(detail.decisions) { decision in
                if decision.isPending {
                    DecisionCard(model: model, decision: decision)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(decision.title).font(.subheadline)
                        GhostStatusBadge(state: decision.state.rawValue)
                        if let answer = decision.answer, !answer.isEmpty {
                            Text(answer).font(.footnote).foregroundStyle(GhostStyle.secondary)
                        }
                    }.padding(.vertical, 2)
                }
            }
        }
    }

    private func effectsSection(_ detail: WorkDetail) -> some View {
        Section("실행 기록") {
            ForEach(detail.effects) { effect in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(effect.tool).font(.caption.weight(.medium).monospaced())
                        GhostStatusBadge(state: effect.state)
                    }
                    Text(effect.summary).font(.caption).foregroundStyle(GhostStyle.secondary).lineLimit(2)
                }.padding(.vertical, 2)
            }
        }
    }

    private func artifactsSection(_ artifacts: [ArtifactRef]) -> some View {
        Section("결과 자료") {
            ForEach(artifacts, id: \.digest) { artifact in
                Button {
                    selectedDigest = artifact.digest
                } label: {
                    HStack {
                        Image(systemName: "doc")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(artifact.name).font(.subheadline)
                            Text("\(artifact.mediaType) · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))")
                                .font(.caption).foregroundStyle(GhostStyle.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(GhostStyle.secondary)
                    }
                }
                .foregroundStyle(GhostStyle.text)
            }
        }
    }

    // MARK: Actions

    private func load() async {
        do {
            detail = try await model.workDetail(id: workId)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func send(_ command: DeviceCommand) async {
        actionIssue = nil
        do {
            _ = try await model.send(command)
            await load()
        } catch {
            actionIssue = model.error ?? error.localizedDescription
        }
    }

    private func verdictLabel(_ verdict: Verdict) -> String {
        switch verdict.outcome {
        case "pass": "통과"
        case "revise": "수정 반영 중"
        case "fail": "미달"
        default: verdict.outcome
        }
    }
}

/// 편집 sheet: title, brief, deadline → `work.update`.
struct WorkEditSheet: View {
    let model: GhostModel
    let work: Work
    let onSaved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var brief: String
    @State private var hasDeadline: Bool
    @State private var deadline: Date
    @State private var saving = false
    @State private var issue: String?

    init(model: GhostModel, work: Work, onSaved: @escaping () async -> Void) {
        self.model = model
        self.work = work
        self.onSaved = onSaved
        _title = State(initialValue: work.title)
        _brief = State(initialValue: work.brief)
        _hasDeadline = State(initialValue: work.deadlineAt != nil)
        _deadline = State(initialValue: work.deadlineAt.map(contractDate) ?? Date().addingTimeInterval(86_400))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("요청") {
                    TextField("제목", text: $title)
                    TextField("내용", text: $brief, axis: .vertical).lineLimit(6...14)
                }
                Section("기한") {
                    Toggle("기한 설정", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker("기한", selection: $deadline)
                    }
                }
                if let issue {
                    Section { Text(issue).font(.caption).foregroundStyle(GhostStyle.warning) }
                }
            }
            .scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("맡긴 일 편집").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await save() } }
                        .disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let deadlineMillis = Int(deadline.timeIntervalSince1970 * 1000)
        let deadlineChange: Editable<Int> = !hasDeadline
            ? .clear
            : (work.deadlineAt == deadlineMillis ? .keep : .set(deadlineMillis))
        do {
            _ = try await model.send(.workUpdate(
                workId: work.id,
                title: title == work.title ? .keep : .set(title),
                brief: brief == work.brief ? .keep : .set(brief),
                deadlineAt: deadlineChange))
            dismiss()
            await onSaved()
        } catch {
            issue = model.error ?? error.localizedDescription
        }
    }
}
