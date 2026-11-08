import SwiftUI
import GhostMobileCore

struct WorkListScreen: View {
    let model: GhostModel
    @State private var path = NavigationPath()
    @State private var finished = false
    @State private var showingCreate = false

    private var availableGhosts: [Ghost] {
        model.snapshot.visibleGhosts.filter { model.grantedGhostIDs.contains($0.id) }
    }
    private var filterGhosts: [Ghost] {
        availableGhosts.filter { ghost in model.snapshot.works.contains { $0.ghostId == ghost.id } }
    }
    private var roots: [Work] {
        model.snapshot.works.filter { work in
            guard work.parentId == nil else { return false }
            guard let ghostId = model.workFilterGhostId else { return true }
            return work.ghostId == ghostId || model.snapshot.delegates(of: work).contains { $0.ghostId == ghostId }
        }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private var current: [Work] { roots.filter { $0.state.isTerminal == finished } }
    private var selection: Binding<String?> {
        Binding(get: { model.workFilterGhostId }, set: { model.workFilterGhostId = $0 })
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    controls
                    if current.isEmpty {
                        ContentUnavailableView(finished ? "끝난 일 없음" : "진행 중인 일 없음", systemImage: "checklist")
                            .frame(maxWidth: .infinity).padding(.vertical, 32)
                    }
                    ForEach(current) { work in
                        VStack(alignment: .leading, spacing: 8) {
                            NavigationLink(value: work.id) { WorkRow(model: model, work: work) }
                                .buttonStyle(.plain).accessibilityIdentifier("work-\(work.id)")
                            ForEach(delegationRows(for: work), id: \.work.id) { row in
                                Branch(color: model.snapshot.glyph(for: row.work).branch) {
                                    NavigationLink(value: row.work.id) { WorkDelegateRow(model: model, work: row.work) }
                                        .buttonStyle(.plain).accessibilityIdentifier("work-\(row.work.id)")
                                }.padding(.leading, CGFloat(min(row.depth, 4)) * 16)
                            }
                        }
                    }
                    if let error = model.error {
                        Text(error).font(.footnote).foregroundStyle(GhostStyle.warning)
                    }
                }.padding(20)
            }
            .background(GhostStyle.canvas)
            .navigationTitle("맡긴 일")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingCreate = true } label: { Image(systemName: "plus") }
                        .frame(minWidth: 44, minHeight: 44).accessibilityLabel("일 맡기기")
                        .disabled(availableGhosts.isEmpty || !model.isOnline)
                }
            }
            .sheet(isPresented: $showingCreate) { NewWorkSheet(model: model) }
            .navigationDestination(for: String.self) { id in WorkDetailScreen(model: model, workId: id) }
            .refreshable { await model.refresh() }
        }
        .onChange(of: model.notificationRoute) {
            guard let route = model.notificationRoute,
                  let notification = model.snapshot.notifications.first(where: { $0.id == route.notificationId }),
                  let workId = notification.workId else { return }
            path.append(workId)
        }
        .onChange(of: availableGhosts.map(\.id)) {
            if let id = model.workFilterGhostId, !availableGhosts.contains(where: { $0.id == id }) {
                model.workFilterGhostId = nil
            }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 16) {
            if filterGhosts.count > 1 {
                if filterGhosts.count <= 6 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            filterChip("전체", ghost: nil)
                            ForEach(filterGhosts) { ghost in filterChip(ghost.name, ghost: ghost) }
                        }
                    }
                } else {
                    Picker("담당 Ghost", selection: selection) {
                        Text("모든 Ghost").tag(String?.none)
                        ForEach(filterGhosts) { ghost in Text(ghost.name).tag(Optional(ghost.id)) }
                    }.pickerStyle(.menu).frame(minHeight: 44)
                }
            } else if model.workFilterGhostId != nil {
                Button("전체") { model.workFilterGhostId = nil }.frame(minHeight: 44)
            }
            Picker("진행 상태", selection: $finished) {
                Text("진행 중 \(roots.filter { !$0.state.isTerminal }.count)").tag(false)
                Text("끝난 일 \(roots.filter { $0.state.isTerminal }.count)").tag(true)
            }.pickerStyle(.segmented)
        }
    }

    private func filterChip(_ name: String, ghost: Ghost?) -> some View {
        let selected = model.workFilterGhostId == ghost?.id
        return Button { model.workFilterGhostId = ghost?.id } label: {
            HStack(spacing: 8) {
                if let ghost { GhostPortrait(ghost: ghost, size: 20) }
                Text(name).font(.footnote.weight(selected ? .semibold : .regular))
            }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(selected ? GhostStyle.surface : GhostStyle.canvas, in: Capsule())
            .overlay { Capsule().stroke(selected ? GhostStyle.border : .clear, lineWidth: 1) }
        }
        .buttonStyle(.plain).foregroundStyle(selected ? GhostStyle.ink : GhostStyle.secondary)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func delegationRows(for root: Work) -> [(work: Work, depth: Int)] {
        let children = Dictionary(grouping: model.snapshot.delegates(of: root), by: { $0.parentId ?? root.id })
        var seen: Set<String> = [root.id]
        var result: [(work: Work, depth: Int)] = []
        func append(_ parentId: String, depth: Int) {
            for child in children[parentId] ?? [] where seen.insert(child.id).inserted {
                result.append((child, depth))
                append(child.id, depth: depth + 1)
            }
        }
        append(root.id, depth: 0)
        return result
    }
}

private struct WorkRow: View {
    let model: GhostModel
    let work: Work
    private var glyph: GlyphState { model.snapshot.glyph(for: work) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StateGlyph(state: glyph.rawValue, size: 20).padding(.top, 4)
            VStack(alignment: .leading, spacing: 8) {
                Text(work.title).font(.body.weight(.medium)).foregroundStyle(GhostStyle.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 8) {
                    GhostPortrait(ghost: model.ghost(work.ghostId), size: 20)
                    Text(model.ghostName(work.ghostId))
                    Text(model.relativeTime(work.endedAt ?? work.updatedAt))
                }.font(.caption).foregroundStyle(GhostStyle.secondary)
                if !work.state.isTerminal {
                    LifecycleTrack(state: work.state, needsOwner: model.snapshot.needsOwner(workId: work.id), compact: true)
                        .frame(maxWidth: 120).padding(.top, 4)
                }
            }
        }
        .padding(16).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay { RoundedRectangle(cornerRadius: 20).stroke(GhostStyle.border, lineWidth: 1) }
        .contentShape(RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(work.title), \(model.ghostName(work.ghostId)), \(glyph.label)")
    }
}

private struct WorkDelegateRow: View {
    let model: GhostModel
    let work: Work
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            StateGlyph(state: model.snapshot.glyph(for: work).rawValue, size: 16)
            GhostPortrait(ghost: model.ghost(work.ghostId), size: 16)
            VStack(alignment: .leading, spacing: 4) {
                Text(model.ghostName(work.ghostId)).font(.caption).foregroundStyle(GhostStyle.secondary)
                Text(work.title).font(.footnote).foregroundStyle(GhostStyle.ink)
            }
            Spacer(minLength: 0)
        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            .accessibilityElement(children: .combine)
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
    @State private var performingAction = false
    @State private var selectedArtifact: ArtifactRef?
    @State private var linkedWorkId: String?

    private var pending: [Decision] {
        guard let detail else { return [] }
        var decisions = Dictionary(uniqueKeysWithValues: detail.decisions.map { ($0.id, $0) })
        for decision in model.snapshot.decisions where decision.workId == workId { decisions[decision.id] = decision }
        return decisions.values.filter(\.isPending).sorted { $0.createdAt < $1.createdAt }
    }
    private var actions: TranscriptActions {
        TranscriptActions(openWork: { linkedWorkId = $0 }, openFile: { selectedArtifact = $0 })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                if let detail {
                    header(detail.work)
                    if !pending.isEmpty {
                        section("확인 필요") { ForEach(pending) { DecisionCard(model: model, decision: $0) } }
                    }
                    receipt(detail)
                    section("요청 내용") {
                        GhostProse(text: detail.work.brief, state: model.snapshot, actions: actions, font: .callout)
                        if !detail.work.acceptance.criteria.isEmpty {
                            Text("완료 기준").font(.caption.weight(.medium)).foregroundStyle(GhostStyle.secondary)
                            GhostProse(text: detail.work.acceptance.criteria, state: model.snapshot, actions: actions, font: .callout)
                        }
                    }
                    if !detail.ancestors.isEmpty || !detail.children.isEmpty { delegation(detail) }
                    section("실행 기록") {
                        if detail.effects.isEmpty {
                            Text("실행 기록 없음").font(.footnote).foregroundStyle(GhostStyle.secondary)
                        } else {
                            ForEach(detail.effects.sorted { $0.createdAt < $1.createdAt }) { effect in
                                WorkEffectRow(effect: effect)
                            }
                        }
                    }
                    NavigationLink {
                        WorkConversationScreen(model: model, conversationId: detail.work.conversationId)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.bubble.right")
                            Text("작업 대화")
                            Spacer(minLength: 8)
                            if detail.work.conversationId == nil {
                                Text("아직 시작 전").font(.caption).foregroundStyle(GhostStyle.secondary)
                            }
                            Image(systemName: "chevron.right").font(.caption)
                        }.frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                } else if let loadError {
                    GhostNotice(title: "맡긴 일을 불러오지 못했습니다", detail: loadError, symbol: "exclamationmark.circle", isError: true)
                } else {
                    ProgressView("불러오는 중").frame(maxWidth: .infinity).padding(.vertical, 32)
                }
                if let issue = actionIssue {
                    Text(issue).font(.footnote).foregroundStyle(GhostStyle.warning)
                }
            }.padding(20).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(GhostStyle.canvas)
        .navigationTitle("맡긴 일").navigationBarTitleDisplayMode(.inline)
        .task(id: workId) { await load() }
        .onChange(of: model.snapshot.works.first(where: { $0.id == workId })?.updatedAt) { Task { await load() } }
        .refreshable { await load() }
        .sheet(isPresented: $showingEdit) {
            if let work = detail?.work { WorkEditSheet(model: model, work: work) { await load() } }
        }
        .sheet(item: $selectedArtifact) { ArtifactScreen(model: model, artifact: $0) }
        .navigationDestination(item: $linkedWorkId) { WorkDetailScreen(model: model, workId: $0) }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.subheadline.weight(.medium)).foregroundStyle(GhostStyle.secondary)
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(_ work: Work) -> some View {
        let glyph = GlyphState(work: work.state, needsOwner: !pending.isEmpty)
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                StateGlyph(state: glyph.rawValue, size: 32).padding(.top, 4)
                Text(work.title).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            }
            Flow(spacing: 12) {
                HStack(spacing: 8) {
                    GhostPortrait(ghost: model.ghost(work.ghostId), size: 24)
                    Text(model.ghostName(work.ghostId))
                }
                Text(glyph.label).foregroundStyle(glyph.ink)
                Text("맡김 \(model.relativeTime(work.createdAt))")
                if let deadline = work.deadlineAt { Text("기한 \(model.deadlineText(deadline))") }
                Text("수정 \(work.revisionsUsed)회")
            }.font(.caption).foregroundStyle(GhostStyle.secondary)
            LifecycleTrack(state: work.state, needsOwner: !pending.isEmpty)
            if let reason = work.reason, !reason.isEmpty {
                Text(reason).font(.callout).foregroundStyle(GhostStyle.warning).textSelection(.enabled)
            }
            if !work.state.isTerminal || ((work.state == .failed || work.state == .blocked) && work.parentId == nil) {
                actionBar(work)
            }
        }
    }

    private func actionBar(_ work: Work) -> some View {
        HStack(spacing: 12) {
            if !work.state.isTerminal {
                Button("수정") { showingEdit = true }.buttonStyle(GhostSecondaryButtonStyle())
                    .accessibilityIdentifier("work-edit")
                Button("취소", role: .destructive) { confirmingCancel = true }.buttonStyle(GhostSecondaryButtonStyle())
                    .accessibilityIdentifier("work-cancel")
            }
            if work.state == .failed || work.state == .blocked, work.parentId == nil {
                Button("재개") { confirmingResume = true }.buttonStyle(GhostPrimaryButtonStyle())
                    .accessibilityIdentifier("work-resume")
            }
            if performingAction { ProgressView() }
        }
        .frame(minHeight: 44)
        .disabled(performingAction || model.busy || !model.isOnline)
        .confirmationDialog("이 맡긴 일을 취소할까요?", isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("취소", role: .destructive) { Task { await send(.workCancel(workId: workId)) } }
        } message: { Text("진행 중인 하위 일도 함께 취소됩니다.") }
        .confirmationDialog("이 맡긴 일을 다시 진행할까요?", isPresented: $confirmingResume, titleVisibility: .visible) {
            Button("재개") { Task { await send(.workResume(workId: workId)) } }
        } message: { Text("현재 내용으로 다시 진행합니다.") }
    }

    @ViewBuilder private func receipt(_ detail: WorkDetail) -> some View {
        let work = detail.work
        let artifacts = receiptArtifacts(detail)
        if work.state.isTerminal || work.result != nil || work.verdict != nil || !artifacts.isEmpty {
            section("작업 결과") {
                VStack(alignment: .leading, spacing: 16) {
                    if let verdict = work.verdict {
                        HStack(spacing: 8) {
                            Image(systemName: verdict.outcome == "pass" ? "checkmark.seal" : "exclamationmark.circle")
                            Text(verdictLabel(verdict)).fontWeight(.semibold)
                            Text(verdictSource(verdict)).foregroundStyle(GhostStyle.secondary)
                        }
                        .font(.footnote)
                        .foregroundStyle(verdict.outcome == "pass" ? GhostStyle.successInk : (verdict.outcome == "fail" ? GhostStyle.dangerInk : GhostStyle.amberInk))
                        if !verdict.reasons.isEmpty {
                            Text(verdict.reasons).font(.footnote).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                        }
                    }
                    if let result = work.result {
                        GhostProse(text: result.summary, state: model.snapshot, actions: actions, font: .callout)
                    } else if work.state.isTerminal {
                        Text(work.state == .cancelled ? "취소되었습니다." : (work.state == .failed ? "완료되지 못했습니다." : "결과 없음"))
                            .font(.callout).foregroundStyle(GhostStyle.secondary)
                    }
                    if !artifacts.isEmpty {
                        Flow(spacing: 8) {
                            ForEach(artifacts) { artifact in
                                FileChip(artifact: artifact) { selectedArtifact = artifact }.frame(minHeight: 44)
                            }
                        }
                    }
                }
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 20))
            }
        }
    }

    private func receiptArtifacts(_ detail: WorkDetail) -> [ArtifactRef] {
        var seen = Set<String>()
        return ((detail.work.result?.artifacts ?? []) + detail.artifacts).filter { seen.insert($0.digest).inserted }
    }

    private func delegation(_ detail: WorkDetail) -> some View {
        section("위임") {
            ForEach(Array(detail.ancestors.enumerated()), id: \.element.id) { index, work in
                branchLink(work, depth: index)
            }
            Branch(color: model.snapshot.glyph(for: detail.work).branch) {
                WorkDelegateRow(model: model, work: detail.work).fontWeight(.semibold)
            }.padding(.leading, CGFloat(min(detail.ancestors.count, 4)) * 16)
            ForEach(detail.children) { child in branchLink(child, depth: min(detail.ancestors.count + 1, 4)) }
        }
    }

    private func branchLink(_ work: Work, depth: Int) -> some View {
        Branch(color: model.snapshot.glyph(for: work).branch) {
            NavigationLink { WorkDetailScreen(model: model, workId: work.id) } label: {
                WorkDelegateRow(model: model, work: work)
            }.buttonStyle(.plain)
        }.padding(.leading, CGFloat(min(depth, 4)) * 16)
    }

    private func load() async {
        do {
            detail = try await model.workDetail(id: workId)
            loadError = nil
        } catch { loadError = error.localizedDescription }
    }

    private func send(_ command: DeviceCommand) async {
        guard !performingAction else { return }
        performingAction = true
        actionIssue = nil
        defer { performingAction = false }
        do {
            _ = try await model.send(command)
            await load()
        } catch { actionIssue = model.error ?? error.localizedDescription }
    }

    private func verdictLabel(_ verdict: Verdict) -> String {
        switch verdict.outcome {
        case "pass": "통과"
        case "revise": "수정 지시"
        default: "미달"
        }
    }

    private func verdictSource(_ verdict: Verdict) -> String {
        switch verdict.source {
        case "checks": "확인 규칙"
        case "review": "검토"
        default: "사용자 확인"
        }
    }
}

private struct WorkEffectRow: View {
    let effect: Effect
    @State private var expanded = false
    var body: some View {
        Branch {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(effect.tool).font(.footnote.weight(.medium).monospaced())
                    GhostStatusBadge(state: effect.state)
                }
                if !effect.summary.isEmpty {
                    Text(effect.summary).font(.footnote).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                }
                if let output = effect.result, !output.isEmpty {
                    Button { expanded.toggle() } label: {
                        HStack(spacing: 8) {
                            Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption)
                            Text("출력").font(.footnote)
                        }.frame(minHeight: 44)
                    }.buttonStyle(.plain).accessibilityValue(expanded ? "펼침" : "접힘")
                    if expanded {
                        ScrollView(.horizontal) {
                            Text(output).font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding(12)
                        }.background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct WorkConversationScreen: View {
    let model: GhostModel
    let conversationId: String?
    @State private var messages: [Message] = []
    @State private var before: String?
    @State private var pageLive: Live?
    @State private var loading = false
    @State private var loaded = false
    @State private var issue: String?
    @State private var selectedArtifact: ArtifactRef?
    @State private var linkedWorkId: String?
    private var actions: TranscriptActions {
        TranscriptActions(openWork: { linkedWorkId = $0 }, openFile: { selectedArtifact = $0 })
    }
    private var live: Live? { conversationId.flatMap { model.liveByConversation[$0] } ?? pageLive }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if conversationId == nil {
                    ContentUnavailableView("아직 시작 전", systemImage: "bubble.left")
                } else if !loaded && loading {
                    ProgressView("불러오는 중").frame(maxWidth: .infinity)
                } else if messages.isEmpty && issue == nil {
                    ContentUnavailableView("기록 없음", systemImage: "bubble.left")
                }
                if before != nil {
                    Button("이전 메시지") { Task { await load(older: true) } }
                        .frame(minHeight: 44).disabled(loading)
                }
                ForEach(messages) { message in
                    if message.role == .assistant {
                        GhostProse(text: message.text, state: model.snapshot, actions: actions)
                    } else if message.role == .user, let origin = message.origin, origin != "owner" {
                        let wake = Wake.describe(origin: origin, text: message.text)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(wake.label).font(.caption.weight(.medium))
                            if !wake.line.isEmpty { Text(wake.line).font(.footnote) }
                        }.foregroundStyle(GhostStyle.secondary)
                    } else {
                        Text(message.text).font(.callout).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                    }
                }
                if let live, live.running {
                    if let partial = live.partial, !partial.isEmpty { GhostProse(text: partial, state: model.snapshot, actions: actions) }
                    else { ProgressView("응답 중") }
                }
                if let issue { Text(issue).font(.footnote).foregroundStyle(GhostStyle.warning) }
            }.padding(20).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(GhostStyle.canvas).navigationTitle("작업 대화").navigationBarTitleDisplayMode(.inline)
        .task(id: conversationId) { await load() }
        .onChange(of: conversationId.flatMap { model.appendedMessages[$0]?.count }) { Task { await load() } }
        .refreshable { await load() }
        .sheet(item: $selectedArtifact) { ArtifactScreen(model: model, artifact: $0) }
        .navigationDestination(item: $linkedWorkId) { WorkDetailScreen(model: model, workId: $0) }
    }

    private func load(older: Bool = false) async {
        guard let conversationId, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await model.conversationPage(id: conversationId, before: older ? before : nil)
            if !older { pageLive = page.live }
            if older {
                let ids = Set(messages.map(\.id))
                messages = page.messages.filter { !ids.contains($0.id) } + messages
            } else if loaded {
                let fresh = Set(page.messages.map(\.id))
                messages = messages.filter { !fresh.contains($0.id) } + page.messages
            } else { messages = page.messages }
            if older || !loaded { before = page.before }
            loaded = true
            issue = nil
        } catch { issue = error.localizedDescription }
    }
}

private struct NewWorkSheet: View {
    let model: GhostModel
    @Environment(\.dismiss) private var dismiss
    @State private var ghostId = ""
    @State private var title = ""
    @State private var brief = ""
    @State private var criteria = ""
    @State private var hasDeadline = false
    @State private var deadline = Date().addingTimeInterval(86_400)
    @State private var saving = false
    @State private var issue: String?
    private var ghosts: [Ghost] {
        model.snapshot.visibleGhosts.filter { model.grantedGhostIDs.contains($0.id) }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("맡길 Ghost").font(.caption).foregroundStyle(GhostStyle.secondary)
                        Picker("맡길 Ghost", selection: $ghostId) {
                            ForEach(ghosts) { ghost in Text(ghost.name + (ghost.isDefault ? " · 메인" : "")).tag(ghost.id) }
                        }.pickerStyle(.menu).frame(minHeight: 44)
                    }
                    WorkRequestFields(title: $title, brief: $brief)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("완료 기준").font(.caption).foregroundStyle(GhostStyle.secondary)
                        TextField("무엇이 되면 끝난 것인지", text: $criteria, axis: .vertical).lineLimit(3...8)
                            .padding(12).background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
                    }
                    Toggle("기한", isOn: $hasDeadline).frame(minHeight: 44)
                    if hasDeadline { DatePicker("기한", selection: $deadline) }
                    if let issue { Text(issue).font(.footnote).foregroundStyle(GhostStyle.warning) }
                }.padding(20)
            }
            .background(GhostStyle.canvas).navigationTitle("일 맡기기").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("일 맡기기") }
                    }.disabled(saving || model.busy || !model.isOnline || !ghosts.contains(where: { $0.id == ghostId })
                        || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { if ghostId.isEmpty { ghostId = ghosts.first?.id ?? "" } }
            .onChange(of: ghosts.map(\.id)) {
                if !ghosts.contains(where: { $0.id == ghostId }) { ghostId = ghosts.first?.id ?? "" }
            }
            .interactiveDismissDisabled(saving)
        }
    }
    private func save() async {
        guard !saving else { return }
        saving = true
        issue = nil
        defer { saving = false }
        do {
            _ = try await model.send(.workCreate(ghostId: ghostId,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                brief: brief.trimmingCharacters(in: .whitespacesAndNewlines),
                criteria: criteria.isEmpty ? nil : criteria,
                deadlineAt: hasDeadline ? Int(deadline.timeIntervalSince1970 * 1000) : nil,
                originConversationId: nil))
            dismiss()
        } catch { issue = model.error ?? error.localizedDescription }
    }
}

private struct WorkRequestFields: View {
    @Binding var title: String
    @Binding var brief: String
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("제목").font(.caption).foregroundStyle(GhostStyle.secondary)
                TextField("제목", text: $title).padding(12)
                    .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("할 일").font(.caption).foregroundStyle(GhostStyle.secondary)
                TextField("할 일", text: $brief, axis: .vertical).lineLimit(6...14).padding(12)
                    .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

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
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    WorkRequestFields(title: $title, brief: $brief)
                    Toggle("기한", isOn: $hasDeadline).frame(minHeight: 44)
                    if hasDeadline { DatePicker("기한", selection: $deadline) }
                    if let issue { Text(issue).font(.footnote).foregroundStyle(GhostStyle.warning) }
                }.padding(20)
            }
            .background(GhostStyle.canvas).navigationTitle("맡긴 일 편집").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("저장") }
                    }
                    .disabled(saving || model.busy || !model.isOnline || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        issue = nil
        defer { saving = false }
        let deadlineMillis = Int(deadline.timeIntervalSince1970 * 1000)
        let deadlineChange: Editable<Int> = !hasDeadline ? .clear
            : (work.deadlineAt == deadlineMillis ? .keep : .set(deadlineMillis))
        do {
            _ = try await model.send(.workUpdate(workId: work.id,
                title: title == work.title ? .keep : .set(title),
                brief: brief == work.brief ? .keep : .set(brief), deadlineAt: deadlineChange))
            dismiss()
            await onSaved()
        } catch { issue = model.error ?? error.localizedDescription }
    }
}
