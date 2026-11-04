import SwiftUI
import GhostMobileCore

struct LifetimeScreen: View {
    let model: GhostModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var mobileTab = "chat"
    @State private var workNavigationPath: [String] = []
    @State private var showingSettings = false
    @State private var showingOptions = false
    @State private var optionDestination = ""
    @State private var showingInference = false
    @State private var showingImageComposer = false
    @State private var inferenceConfiguration: JSON = .null
    @State private var showingRecovery = false
    @State private var showingVoice = false
    @State private var showingVoiceInfo = false
    @FocusState private var composerFocused: Bool
    @State private var latestScrollRequest = UUID()
    @State private var followsLatest = true
    @State private var hasNewMessages = false
    @State private var goalDrafts: [String: String] = [:]
    @State private var steerDrafts: [String: String] = [:]
    @State private var selectedConversationTargetKey = ""
    @State private var requestedConversationPrivacy = "local_only"
    @State private var selectedArtifactKeys: Set<String> = []
    @State private var conversationTurns: [JSON] = []
    @State private var conversationTurnRuns: [String: LifetimeConversationRun] = [:]
    @State private var conversationPrivacy = "local_only"
    @State private var conversationHasOlder = false
    @State private var conversationOldestSequence: UInt64?
    @State private var conversationLoadedKey = ""
    @State private var conversationLoading = false
    @State private var conversationLoadingOlderKey: String?
    @State private var conversationPageError: String?
    @State private var submittedDraft: ConversationDraft?
    @State private var submittedDraftAddress: DraftAddress?
    @State private var lifetimeAuthorityKeyAtEntry = ""
    @State private var recoveryItems: [LifetimeRecoveryItem] = []
    @State private var recoveryScanError: String?
    @State private var recoveryLoaded = false
    @State private var recoveryBusy = false
    @State private var notice: String?
    @State private var actionError: String?
    @State private var delegationDrafts: [String: String] = [:]
    @State private var delegationTargets: [String: String] = [:]
    @State private var delegationArtifactKeys: [String: Set<String>] = [:]
    @State private var presentedArtifact: ArtifactSheet?

    struct ArtifactSheet: Identifiable {
        let content: WorkArtifactContent
        var id: String { content.digest }
    }

    init(model: GhostModel) { self.model = model }

    private var ghostIDs: Set<String> { model.lifetimeGhostIDs }
    private var conversationIDs: Set<String> { model.lifetimeConversationIDs }
    private var capabilities: Set<String> { model.lifetimeCapabilities }

    private var validScope: Bool {
        model.lifetimeScope["kind"] == .string("lifetime")
            && !ghostIDs.isEmpty
            && !conversationIDs.isEmpty
    }

    private var canRead: Bool {
        model.isLifetimeConnection && validScope && capabilities.contains("lifetime.read")
    }

    private var canWrite: Bool {
        model.isLifetimeConnection && validScope && capabilities.contains("lifetime.write")
    }

    private var dispatchEnabled: Bool { model.api?.lifetimeDispatchEnabled == true }
    private var authorityUnchanged: Bool {
        model.isLifetimeConnection
            && !lifetimeAuthorityKeyAtEntry.isEmpty
            && lifetimeAuthorityKeyAtEntry == model.lifetimeAuthorityKey
    }
    private var canMutate: Bool {
        authorityUnchanged && canWrite && dispatchEnabled && model.isOnline && !model.busy && !recoveryBusy
            && recoveryLoaded && recoveryScanError == nil && recoveryItems.isEmpty && visiblePending.isEmpty
    }
    private func captureInitialLifetimeAuthority() {
        guard lifetimeAuthorityKeyAtEntry.isEmpty, model.isLifetimeConnection else { return }
        lifetimeAuthorityKeyAtEntry = model.lifetimeAuthorityKey
    }
    private var lifetimeRecoveryKey: String {
        let origin = model.connection?.origin.absoluteString ?? "unconnected"
        let ghosts = ghostIDs.sorted().joined(separator: ",")
        let conversations = conversationIDs.sorted().joined(separator: ",")
        return "\(model.isLifetimeConnection):\(model.isOnline):\(origin):\(model.lifetimeAuthorityKey):\(model.lifetimeScope["kind"].text):\(ghosts):\(conversations)"
    }
    private var ownerQuestionsKey: String {
        "\(model.isLifetimeConnection):\(model.isOnline):\(model.lifetimeAuthorityKey)"
    }
    private var targetPairs: [LifetimeConversationTarget] { model.lifetimeConversationTargets }
    private var activeTargetPairs: [LifetimeConversationTarget] { targetPairs.filter { $0.mode == "active" } }
    private func targetSelectionKey(_ target: LifetimeConversationTarget) -> String {
        "\(model.lifetimeAuthorityKey)|\(target.id)"
    }
    private func targetSelectionKey(ghostID: String, conversationID: String) -> String {
        let id = "\(ghostID.utf8.count):\(ghostID)\(conversationID.utf8.count):\(conversationID)"
        return "\(model.lifetimeAuthorityKey)|\(id)"
    }
    private var pendingConversationInputs: [Envelope] {
        visiblePending.filter { $0.command["envelope"]["body"]["method"].text == "conversation.input" }
    }
    private var pendingConversationTargetKey: String {
        guard pendingConversationInputs.count == 1,
              let envelope = pendingConversationInputs.first else { return "none:\(pendingConversationInputs.count)" }
        let body = envelope.command["envelope"]["body"]
        return "\(envelope.request_id):\(body["ghost_id"].text):\(body["conversation_id"].text)"
    }
    private func restorePendingConversationTarget() {
        guard authorityUnchanged, selectedConversationTargetKey.isEmpty,
              pendingConversationInputs.count == 1,
              let envelope = pendingConversationInputs.first else { return }
        let body = envelope.command["envelope"]["body"]
        selectedConversationTargetKey = targetSelectionKey(ghostID: body["ghost_id"].text, conversationID: body["conversation_id"].text)
    }
    private var selectedTarget: LifetimeConversationTarget? {
        if !selectedConversationTargetKey.isEmpty {
            return targetPairs.first { targetSelectionKey($0) == selectedConversationTargetKey }
        }
        guard authorityUnchanged else { return nil }
        if !pendingConversationInputs.isEmpty {
            guard pendingConversationInputs.count == 1, let envelope = pendingConversationInputs.first else { return nil }
            let body = envelope.command["envelope"]["body"]
            return targetPairs.first {
                $0.ghostID == body["ghost_id"].text && $0.conversationID == body["conversation_id"].text
            }
        }
        let primaries = activeTargetPairs.filter { $0.kind == "primary" }
        return primaries.count == 1 ? primaries[0] : nil
    }
    private var targetIsInScope: Bool {
        guard validScope, model.lifetimeTargetIssue == nil, let target = selectedTarget else { return false }
        return ghostIDs.contains(target.ghostID) && conversationIDs.contains(target.conversationID)
    }
    private var conversationLoadKey: String {
        let targetKey = selectedTarget.map { targetSelectionKey($0) } ?? "no-target"
        return "\(scenePhase == .active):\(model.isOnline):\(canRead):\(model.lifetimeAuthorityKey):\(targetKey)"
    }
    private var selectedDraftAddress: DraftAddress? {
        guard let target = selectedTarget else { return nil }
        return model.draftAddress(profileID: target.ghostID, conversationID: target.conversationID)
    }
    private var selectedDraft: ConversationDraft? {
        guard let address = selectedDraftAddress else { return nil }
        return model.drafts?.draft(at: address)
    }
    private var draftText: Binding<String> {
        let address = selectedDraftAddress
        return Binding(
            get: { address.flatMap { model.drafts?.draft(at: $0)?.text } ?? "" },
            set: { text in if let address { model.drafts?.update(text, at: address) } }
        )
    }
    private var canSendConversation: Bool {
        guard canMutate, targetIsInScope, let target = selectedTarget,
              target.mode == "active", model.drafts != nil, model.draftError == nil,
              let address = selectedDraftAddress,
              let draft = model.drafts?.draft(at: address),
              !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              draft.text.utf8.count <= 65_536,
              selectedConversationAttachments.count <= 16 else { return false }
        return !canRead || (conversationLoadedKey == conversationLoadKey && conversationPageError == nil)
    }
    private var visibleGoals: [LifetimeScreenRecord] {
        guard canRead else { return [] }
        return lifetimeRecords(model.snapshot["goals"].items, key: "id").filter { record in
            targetPairs.contains {
                $0.ghostID == record.value["accountable_ghost"].text
                    && $0.conversationID == record.value["reply_conversation"].text
            }
        }
    }



    private var visibleWork: [LifetimeScreenRecord] {
        let goalIDs = Set(visibleGoals.map { $0.value["id"].text })
        return lifetimeRecords(model.snapshot["work"].items, key: "id").filter { record in
            goalIDs.contains(record.value["goal_id"].text)
                && ghostIDs.contains(record.value["owner"].text)
        }
    }

    private var selectedConversationHasActiveWork: Bool {
        guard let target = selectedTarget else { return false }
        let goalIDs = Set(model.snapshot["goals"].items.compactMap { goal -> String? in
            guard goal["accountable_ghost"].text == target.ghostID,
                  goal["reply_conversation"].text == target.conversationID,
                  !goal["id"].text.isEmpty else { return nil }
            return goal["id"].text
        })
        let terminalStates: Set<String> = ["accepted", "complete", "completed", "cancelled", "failed", "rejected"]
        return model.snapshot["work"].items.contains { work in
            goalIDs.contains(work["goal_id"].text)
                && work["owner"].text == target.ghostID
                && !terminalStates.contains(work["state"].text)
        }
    }
    private var eligibleConversationArtifacts: [JSON] {
        guard canRead, targetIsInScope, let target = selectedTarget else { return [] }
        let goalIDs = Set(model.snapshot["goals"].items.compactMap { goal -> String? in
            guard goal["accountable_ghost"].text == target.ghostID,
                  goal["reply_conversation"].text == target.conversationID else { return nil }
            return goal["id"].text.isEmpty ? nil : goal["id"].text
        })
        let attempts = Set(model.snapshot["work"].items.compactMap { work -> String? in
            guard goalIDs.contains(work["goal_id"].text), work["owner"].text == target.ghostID,
                  !work["execution_id"].text.isEmpty else { return nil }
            return work["execution_id"].text
        })
        var seen: Set<String> = []
        return model.snapshot["artifacts"].items.filter { artifact in
            guard attempts.contains(artifact["producing_attempt"].text), isCanonicalArtifact(artifact) else { return false }
            return seen.insert(artifactKey(artifact)).inserted
        }
    }
    private var selectedConversationAttachments: [JSON] {
        eligibleConversationArtifacts.filter { selectedArtifactKeys.contains(artifactKey($0)) }
    }
    private var effectiveConversationPrivacy: String {
        let inherited = canRead ? conversationPrivacy : "local_only"
        let turnPrivacy = conversationTurns.flatMap { turn in
            [turn["privacy"].text] + turn["attachments"].items.map { $0["privacy"].text }
        }
        let values = [inherited, requestedConversationPrivacy] + turnPrivacy
            + selectedConversationAttachments.map { $0["privacy"].text }
        return values.max { privacyRank($0) < privacyRank($1) } ?? "local_only"
    }

    private var visiblePending: [Envelope] {
        model.pending.filter { $0.command["type"].text == "lifetime" }
    }
    private var currentInferenceSelection: JSON {
        guard let target = selectedTarget else { return .null }
        return inferenceSelection(inferenceConfiguration, ghostID: target.ghostID, conversationID: target.conversationID)
    }
    private var currentInferenceLabel: String { inferenceLabel(currentInferenceSelection) }
    private var currentInferenceDisclosure: String {
        let provider = currentInferenceSelection["provider"].text
        if provider == "local" { return "로컬에서 처리" }
        guard let target = selectedTarget, !provider.isEmpty else { return "" }
        let allowed = inferenceConfiguration["settings"]["external_grants"]["\(target.ghostID)/\(target.conversationID)"].items.contains(.string(provider))
        return allowed ? "\(provider == "codex" ? "Codex" : provider) 외부 처리 허용" : "외부 전송 허용 필요"
    }

    var body: some View {
        TabView(selection: $mobileTab) {
            NavigationStack { conversationExperience }
                .tabItem { Label("대화", systemImage: "bubble.left.and.bubble.right") }.tag("chat")
            NavigationStack(path: $workNavigationPath) {
                workExperience.navigationDestination(for: String.self) { goalID in
                    if let record = visibleGoals.first(where: { $0.id == goalID }) {
                        List { goalSection(record.value) }
                            .scrollContentBackground(.hidden).background(GhostStyle.canvas)
                            .navigationTitle("맡긴 일").navigationBarTitleDisplayMode(.inline)
                    } else { Text("이 연결에서 요청 기록을 확인할 수 없습니다.") }
                }
            }
                .tabItem { Label("맡긴 일", systemImage: "checklist") }.tag("work")
            ActivityView(model: model)
                .tabItem { Label("알림", systemImage: "bell") }.tag("inbox")
        }
        .tint(GhostStyle.ink)
        .toolbarBackground(GhostStyle.surface, for: .tabBar)
        .task(id: lifetimeRecoveryKey) { await reloadRecoveryItems() }
        .task(id: ownerQuestionsKey) { await model.loadOwnerQuestions() }
        .task(id: model.lifetimeAuthorityKey) { captureInitialLifetimeAuthority() }
        .task(id: conversationLoadKey) { await observeConversation() }
        .task(id: selectedTarget?.id) {
            guard let api = model.api else { return }
            inferenceConfiguration = (try? await api.inferenceSettings()) ?? .null
        }
        .task(id: pendingConversationTargetKey) { restorePendingConversationTarget() }
        .onChange(of: model.lifetimeRouteTarget) {
            guard let target = model.lifetimeRouteTarget else { return }
            selectedConversationTargetKey = targetSelectionKey(ghostID: target.ghostID, conversationID: target.conversationID)
            lifetimeAuthorityKeyAtEntry = model.lifetimeAuthorityKey
            mobileTab = "chat"
        }
        .task(id: selectedDraft?.revision) {
            do { try await Task.sleep(for: .milliseconds(300)); model.saveDrafts() } catch { }
        }
        .sheet(item: $presentedArtifact) { item in NavigationStack { ArtifactDocumentView(content: item.content) } }
        .sheet(isPresented: $showingSettings) { SettingsView(model: model, showsCloseButton: true) }
        .sheet(isPresented: $showingOptions, onDismiss: {
            if optionDestination == "model" { showingInference = true }
            if optionDestination == "image" { showingImageComposer = true }
            optionDestination = ""
        }) { conversationOptions }
        .sheet(isPresented: $showingInference) {
            if let api = model.api, let target = selectedTarget {
                InferencePicker(api: api, ghostID: target.ghostID, conversationID: target.conversationID) { inferenceConfiguration = $0 }
            }
        }
        .sheet(isPresented: $showingImageComposer) {
            if let api = model.api, let target = selectedTarget {
                ImageComposer(api: api, ghostID: target.ghostID, conversationID: target.conversationID, storageNamespace: model.lifetimeAuthorityKey)
            }
        }
        .sheet(isPresented: $showingRecovery) { advancedScreen }
        .sheet(isPresented: $showingVoice) { VoiceScreen(model: model) }
        .sheet(isPresented: $showingVoiceInfo) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: "phone").font(.largeTitle).foregroundStyle(GhostStyle.accent)
                    Text("통화 연결을 준비하고 있어요").font(.title2.weight(.semibold))
                    Text(model.voiceMediaTarget == nil
                         ? "현재 서버에 이 대화의 음성 연결이 설정되어 있지 않습니다. 지금은 메시지로 이야기할 수 있어요."
                         : "이전 통화의 상태를 확인한 뒤 새 통화를 시작할 수 있습니다. 내 Ghost에서 통화 상태를 확인해 주세요.")
                        .foregroundStyle(GhostStyle.secondary)
                    Spacer()
                }.padding(24).background(GhostStyle.surface)
                    .navigationTitle("음성 통화").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { showingVoiceInfo = false } } }
            }.presentationDetents([.medium, .large])
        }
        .onDisappear { model.saveDrafts() }
    }

    private var conversationExperience: some View {
        conversationTimeline
            .background(GhostStyle.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: { GhostMark(size: 32).frame(width: 44, height: 44) }
                        .buttonStyle(.plain).accessibilityLabel("내 Ghost와 연결 설정")
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 2) {
                        Text(selectedTarget?.kind == "specialist" ? (selectedTarget?.label ?? "Ghost") : "Ghost")
                            .font(.headline).foregroundStyle(GhostStyle.text)
                        Button { showingInference = true } label: {
                            HStack(spacing: 3) {
                                Text(model.isOnline ? currentInferenceLabel : "연결 확인 중")
                                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                            }.font(.caption2).foregroundStyle(GhostStyle.secondary)
                        }.accessibilityLabel("모델과 추론 수준 변경").accessibilityIdentifier("inference-picker-open")
                    }.accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { openVoice() } label: { Image(systemName: model.activeCall == nil ? "phone" : "phone.fill").frame(width: 40, height: 44) }
                        .accessibilityLabel(model.activeCall == nil ? "Ghost와 통화" : "진행 중인 통화 열기")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingOptions = true } label: { Image(systemName: "ellipsis").frame(width: 36, height: 44) }
                        .accessibilityLabel("대화 옵션")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { conversationComposer }
    }

    private var conversationTimeline: some View {
        GeometryReader { viewport in
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if needsAttention {
                        Button { showingRecovery = true } label: {
                            GhostNotice(title: "확인이 필요한 요청이 있어요", detail: "기록을 확인하면 대화를 이어갈 수 있습니다.", symbol: "exclamationmark.circle")
                        }.buttonStyle(.plain)
                    }
                    if let error = conversationPageError {
                        GhostNotice(title: "대화를 불러오지 못했어요", detail: error, symbol: "wifi.exclamationmark", isError: true)
                        Button("다시 불러오기") { Task { await loadConversationLatest() } }.disabled(!model.isOnline)
                    }
                    if conversationHasOlder {
                        Button { followsLatest = false; Task { await loadOlderConversationTurns() } } label: {
                            Label("이전 대화", systemImage: "arrow.up").font(.footnote).frame(maxWidth: .infinity, minHeight: 44)
                        }.disabled(conversationLoadingOlderKey == conversationLoadKey || !model.isOnline)
                    }
                    if conversationLoading && conversationTurns.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 48).accessibilityLabel("대화 불러오는 중")
                    } else if conversationTurns.isEmpty && conversationPageError == nil {
                        GhostEmptyConversation().padding(.top, 48)
                    }
                    ForEach(lifetimeRecords(conversationTurns, key: "id")) { row in conversationTurnRow(row.value) }
                    if let notice, !notice.isEmpty { GhostNotice(title: notice) }
                    if let actionError, !actionError.isEmpty { GhostNotice(title: "요청을 확인해 주세요", detail: actionError, isError: true) }
                    Color.clear.frame(height: 1).id("lifetime-chat-bottom")
                }.padding(.horizontal, 20).padding(.vertical, 20)
                    .frame(maxWidth: 760).frame(maxWidth: .infinity)
                    .background {
                        if #unavailable(iOS 18) {
                            GeometryReader { content in
                                Color.clear.preference(key: HistoryPreference.self, value: content.frame(in: .named("history")).maxY - viewport.size.height < 80)
                            }
                        }
                    }
            }
            .accessibilityIdentifier("lifetime-chat-history")
            .scrollDismissesKeyboard(.interactively)
            .coordinateSpace(name: "history")
            .modifier(ObserveHistoryGeometry { nearBottom in
                followsLatest = nearBottom
                if nearBottom { hasNewMessages = false }
            })
            .overlay(alignment: .bottomTrailing) {
                if !followsLatest {
                    Button {
                        followsLatest = true; hasNewMessages = false
                        proxy.scrollTo("lifetime-chat-bottom", anchor: .bottom)
                    } label: {
                        Label(hasNewMessages ? "새 메시지" : "최근 메시지", systemImage: "arrow.down")
                            .font(.callout.weight(.medium)).padding(.horizontal, 16).frame(minHeight: 44)
                            .background(GhostStyle.under, in: Capsule())
                            .overlay { Capsule().stroke(GhostStyle.border) }
                    }.padding(16).accessibilityIdentifier("lifetime-latest-messages")
                }
            }
            .onChange(of: conversationTurns.last) {
                if followsLatest { proxy.scrollTo("lifetime-chat-bottom", anchor: .bottom) }
                else { hasNewMessages = true }
            }
            .onChange(of: viewport.size.height) { if followsLatest { proxy.scrollTo("lifetime-chat-bottom", anchor: .bottom) } }
            .onChange(of: latestScrollRequest) {
                followsLatest = true; hasNewMessages = false
                proxy.scrollTo("lifetime-chat-bottom", anchor: .bottom)
            }
            .task(id: conversationLoadedKey) { followsLatest = true; proxy.scrollTo("lifetime-chat-bottom", anchor: .bottom) }
        }
        }
    }

    private var needsAttention: Bool {
        recoveryScanError != nil || !recoveryItems.isEmpty || !visiblePending.isEmpty || !authorityUnchanged
    }
    private var composerAvailable: Bool {
        canWrite && targetIsInScope && selectedTarget?.mode == "active" && dispatchEnabled
        && !model.busy && canMutate && pendingConversationInputs.isEmpty && model.drafts != nil && model.draftError == nil
    }
    private var conversationComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = model.draftError { Text(error).font(.footnote).foregroundStyle(GhostStyle.warning) }
            if !model.isOnline {
                Text("다시 연결되면 보낼 수 있어요. 작성한 내용은 보관됩니다.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)
            } else if !composerAvailable && !conversationLoading {
                Button("대화를 이어가기 위한 상태 확인") { showingRecovery = true }
                    .font(.footnote).foregroundStyle(GhostStyle.warning)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button { showingOptions = true } label: { Image(systemName: "plus").font(.system(size: 20, weight: .medium)).frame(width: 40, height: 44) }
                    .accessibilityLabel("자료 첨부와 대화 옵션")
                TextField(dynamicTypeSize.isAccessibilitySize ? "메시지" : "Ghost에게 이야기하기", text: draftText, axis: .vertical)
                    .lineLimit(1...(dynamicTypeSize.isAccessibilitySize ? 3 : 6)).padding(.vertical, 12).focused($composerFocused)
                    .disabled(!canWrite || !targetIsInScope || !authorityUnchanged || model.drafts == nil || model.draftError != nil).accessibilityLabel("Ghost에게 메시지")
                    .accessibilityIdentifier("lifetime-chat-composer")
                    .accessibilityHint("처리 범위: \(privacyLabel(effectiveConversationPrivacy))")
                Button {
                    latestScrollRequest = UUID()
                    Task { await submitConversationInput() }
                } label: {
                    Group {
                        if model.busy { ProgressView().tint(GhostStyle.onInk) }
                        else { Image(systemName: "arrow.up").font(.system(size: 18, weight: .semibold)) }
                    }.frame(width: 42, height: 42)
                        .foregroundStyle(GhostStyle.onInk)
                        .background(canSendConversation ? GhostStyle.ink : GhostStyle.secondary, in: Circle())
                }.disabled(!canSendConversation).accessibilityLabel("메시지 보내기")
                    .padding(.bottom, 2).padding(.trailing, 4)
            }.padding(.horizontal, 4)
                .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 26))
            if !dynamicTypeSize.isAccessibilitySize {
                let disclosure = currentInferenceDisclosure
                if !disclosure.isEmpty || !selectedConversationAttachments.isEmpty {
                    HStack(spacing: 4) {
                        if !disclosure.isEmpty {
                            Image(systemName: "lock").font(.system(size: 9))
                            Text(disclosure).font(.caption2)
                        }
                        if !selectedConversationAttachments.isEmpty {
                            if !disclosure.isEmpty { Text("·").font(.caption2) }
                            Text("자료 \(selectedConversationAttachments.count)개").font(.caption2)
                        }
                    }.foregroundStyle(GhostStyle.secondary).padding(.leading, 14)
                }
            }
        }.padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
            .background(GhostStyle.surface)
    }

    private var workExperience: some View {
        List {
            if !model.ownerQuestions.isEmpty || model.ownerQuestionsError != nil { OwnerQuestionsSection(model: model) }
            if needsAttention {
                Section { Button { showingRecovery = true } label: { GhostNotice(title: "확인이 필요한 요청", symbol: "exclamationmark.circle") } }
            }
            if visibleGoals.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 16) {
                        Image(systemName: "checklist").font(.largeTitle).foregroundStyle(GhostStyle.accent)
                        Text("맡긴 일을 한곳에서").font(.title2.weight(.semibold))
                        Text("Ghost에게 부탁한 일과 도착한 결과를 여기서 확인할 수 있어요.").foregroundStyle(GhostStyle.secondary)
                        Button("Ghost에게 부탁하기") { mobileTab = "chat"; composerFocused = true }.buttonStyle(.bordered)
                    }.padding(.vertical, 24)
                }.listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(visibleGoals) { record in
                        NavigationLink(value: record.id) {
                            VStack(alignment: .leading, spacing: 12) {
                                GhostStatusBadge(state: record.value["state"].text)
                                Text(record.value["prompt"].text).font(.body.weight(.medium)).lineLimit(3)
                                let count = visibleWork.filter { $0.value["goal_id"].text == record.value["id"].text }.count
                                if count > 1 { Text("\(count)개 작업으로 진행").font(.caption).foregroundStyle(GhostStyle.secondary) }
                            }.padding(.vertical, 10)
                        }
                    }
                }
            }
        }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("맡긴 일")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showingSettings = true } label: { Image(systemName: "person.crop.circle").frame(width: 44, height: 44) }.accessibilityLabel("내 Ghost") } }
            .refreshable { await model.refresh(); await model.loadOwnerQuestions() }
    }

    private var conversationOptions: some View {
        NavigationStack {
            Form {
                targetSection
                Section {
                    Button("모델과 추론 수준") { optionDestination = "model"; showingOptions = false }
                    Button("이미지 만들기", systemImage: "photo.badge.plus") { optionDestination = "image"; showingOptions = false }
                }
                Section("처리 범위") {
                    Picker("공개 범위", selection: $requestedConversationPrivacy) {
                        Text("보호된 기록").tag("local_only")
                        Text("비공개").tag("private")
                        Text("공개 자료 허용").tag("public")
                    }
                    Text("외부 전송은 모델 설정에서 제공자별로 허용합니다. 기존 기록의 보호 표시는 유지됩니다.").font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                if canRead && !eligibleConversationArtifacts.isEmpty {
                    Section("이 대화의 결과 첨부") {
                        ForEach(eligibleConversationArtifacts.map { LifetimeScreenRecord(id: artifactKey($0), value: $0) }) { row in
                            let artifact = row.value
                            let key = row.id
                            Toggle("결과 문서 · \(String(artifact["digest"].text.prefix(8)))", isOn: Binding(
                                get: { selectedArtifactKeys.contains(key) },
                                set: { selected in if selected { if selectedConversationAttachments.count < 16 { selectedArtifactKeys.insert(key) } } else { selectedArtifactKeys.remove(key) } }
                            ))
                        }
                    }
                }
                Section {
                    NavigationLink("연결과 요청 상태 확인") { advancedContent }
                }
            }.scrollContentBackground(.hidden).background(GhostStyle.canvas)
                .navigationTitle("대화 옵션").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("완료") { showingOptions = false } } }
        }
    }

    private var advancedScreen: some View {
        NavigationStack {
            advancedContent
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { showingRecovery = false } } }
                .refreshable { await model.refresh(); await reloadRecoveryItems() }
        }
    }

    private var advancedContent: some View {
        List {
            connectionSection
            recoverySection
            targetSection
            pendingSection
            ComputerControlSection(model: model)
        }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(GhostStyle.canvas)
            .navigationTitle("연결 및 요청 상태").navigationBarTitleDisplayMode(.inline)
    }

    private func openVoice() {
        if model.activeCall != nil { showingVoice = true; return }
        guard let target = selectedTarget, let media = model.voiceMediaTarget,
              target.ghostID == media.ghostID && target.conversationID == media.conversationID,
              model.isOnline, model.voiceCallFence == nil, model.voiceFenceIssue == nil,
              model.startVoiceCall(profileID: target.ghostID, conversationID: target.conversationID) else {
            showingVoiceInfo = true; return
        }
        showingVoice = true
    }

    private var connectionSection: some View {
        Section {
            HStack {
                Label(
                    model.isOnline ? "서버에 연결됨" : "오프라인 · 마지막 저장 상태",
                    systemImage: model.isOnline ? "checkmark.circle" : "wifi.slash"
                )
                Spacer()
                Text(permissionLabel)
                    .font(.caption)
                    .foregroundStyle(GhostStyle.secondary)
            }
            if !model.isOnline {
                Text("오프라인 상태입니다. 표시된 snapshot은 마지막으로 받은 상태이며 요청은 전송할 수 없습니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
            }
            if let notice, !notice.isEmpty {
                Label(notice, systemImage: "info.circle")
                    .font(.callout)
                    .foregroundStyle(GhostStyle.text)
                    .textSelection(.enabled)
            }
            if let actionError, !actionError.isEmpty {
                Text(actionError)
                    .font(.callout)
                    .foregroundStyle(GhostStyle.warning)
                    .textSelection(.enabled)
            }
            if let error = model.error, !error.isEmpty {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(GhostStyle.warning)
                    .textSelection(.enabled)
            }
        }
    }

    private var permissionLabel: String {
        if !dispatchEnabled { return canRead ? "복구 모드 · 읽기 전용" : "dispatch 차단" }
        if canRead && canWrite { return "읽기 및 요청" }
        if canRead { return "읽기 전용" }
        if canWrite { return "쓰기 권한 · 대상 확인 불가" }
        return "권한 없음"
    }
    private var recoverySection: some View {
        Section("이전 미확정 요청") {
            if !recoveryLoaded {
                ProgressView("저장된 요청 기록 확인 중")
            }
            if let recoveryScanError {
                Label("이전 요청 기록을 확인하지 못했습니다. 변경 요청을 차단했습니다.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(GhostStyle.warning)
                Text(recoveryScanError)
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
                    .textSelection(.enabled)
            } else if recoveryLoaded && recoveryItems.isEmpty {
                Text("이전 연결 범위에서 확인이 필요한 Lifetime 요청이 없습니다.")
                    .foregroundStyle(GhostStyle.secondary)
            }
            ForEach(recoveryItems) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text("보존된 요청 · epoch \(item.authorityEpoch.map { String($0) } ?? "확인 불가")")
                        .font(.headline)
                    if let issue = item.issue {
                        Text("기록 확인 문제: \(issue)")
                            .font(.footnote)
                            .foregroundStyle(GhostStyle.warning)
                    }
                    if !canRead {
                        Text("이 연결에는 이전 요청의 영수증을 조회할 Lifetime 읽기 권한이 없습니다. 기록과 변경 차단을 유지합니다.")
                            .font(.footnote)
                            .foregroundStyle(GhostStyle.secondary)
                    }
                    DisclosureGroup("기술 식별자") {
                        LabeledContent("Workspace", value: item.workspaceID ?? "확인 불가")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        LabeledContent("Device", value: item.deviceID ?? "확인 불가")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        LabeledContent("Command ID", value: item.commandID ?? "확인 불가")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                    Button("저장된 ID의 영수증 확인") {
                        Task { await inspectRecovery(item) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(!item.canReconcile || !canRead || !model.isOnline || model.busy || recoveryBusy)
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func observeConversation() async {
        let key = conversationLoadKey
        while !Task.isCancelled && scenePhase == .active && conversationLoadKey == key {
            await loadConversationLatest(observeActiveWork: true)
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
        }
    }

    private func loadConversationLatest(observeActiveWork: Bool = false) async {
        let requestKey = conversationLoadKey
        guard scenePhase == .active else { return }
        guard canRead else {
            conversationTurns = []
            conversationTurnRuns = [:]
            conversationPrivacy = "local_only"
            conversationHasOlder = false
            conversationOldestSequence = nil
            conversationLoadedKey = ""
            conversationPageError = nil
            conversationLoading = false
            return
        }
        guard model.isOnline, let target = selectedTarget, targetIsInScope, let api = model.api else {
            conversationTurns = []
            conversationTurnRuns = [:]
            conversationHasOlder = false
            conversationOldestSequence = nil
            conversationLoadedKey = ""
            conversationPageError = model.isOnline ? "검증된 정본 대화 대상이 없습니다." : "오프라인 상태이므로 정본 대화를 새로 확인하지 않았습니다."
            conversationLoading = false
            return
        }
        if conversationLoadedKey != requestKey {
            conversationTurns = []
            conversationTurnRuns = [:]
            conversationPrivacy = "local_only"
            conversationHasOlder = false
            conversationOldestSequence = nil
            conversationLoadedKey = ""
        }
        conversationPageError = nil
        var hasLoadedPage = conversationLoadedKey == requestKey
        while !Task.isCancelled && model.api === api && model.isOnline && conversationLoadKey == requestKey {
            conversationLoading = !hasLoadedPage
            do {
                let response = try await api.inspectLifetimeConversation(
                    ghostID: target.ghostID,
                    conversationID: target.conversationID,
                    limit: 100
                )
                guard !Task.isCancelled, model.api === api,
                      conversationLoadKey == requestKey, model.isOnline else {
                    if !Task.isCancelled, model.api === api, conversationLoadKey == requestKey {
                        conversationLoading = false
                    }
                    return
                }
                let page = try parseCanonicalConversationPage(
                    response,
                    ghostID: target.ghostID,
                    conversationID: target.conversationID
                )
                // RootView refreshes authority/snapshot independently. Doing
                // another bootstrap + snapshot on every two-second chat poll
                // exhausts the device rate limit and blocks the next message.
                guard !Task.isCancelled, model.api === api,
                      conversationLoadKey == requestKey, model.isOnline else {
                    if !Task.isCancelled, model.api === api, conversationLoadKey == requestKey {
                        conversationLoading = false
                    }
                    return
                }
                try applyLatestConversationPage(page, requestKey: requestKey)
                hasLoadedPage = true
                conversationLoading = false
                let hasActiveControllerTurn = conversationTurnRuns.values.contains {
                    ["queued", "running", "effect_unknown"].contains($0.state)
                }
                guard observeActiveWork && (hasActiveControllerTurn || selectedConversationHasActiveWork) else { return }
                try await Task.sleep(for: .seconds(showingImageComposer || showingInference ? 6 : 2))
            } catch {
                guard !Task.isCancelled, model.api === api,
                      conversationLoadKey == requestKey, model.isOnline else { return }
                if !hasLoadedPage {
                    conversationTurns = []
                    conversationTurnRuns = [:]
                    conversationHasOlder = false
                    conversationOldestSequence = nil
                    conversationLoadedKey = ""
                }
                conversationPageError = error.localizedDescription
                conversationLoading = false
                let hasActiveControllerTurn = conversationTurnRuns.values.contains {
                    ["queued", "running", "effect_unknown"].contains($0.state)
                }
                guard observeActiveWork && (hasActiveControllerTurn || selectedConversationHasActiveWork) else { return }
                do { try await Task.sleep(for: .seconds(showingImageComposer || showingInference ? 6 : 2)) } catch { return }
            }
        }
        if !Task.isCancelled, model.api === api,
           conversationLoadKey == requestKey, model.isOnline {
            conversationLoading = false
        }
    }

    private func applyLatestConversationPage(_ page: CanonicalConversationPage, requestKey: String) throws {
        guard conversationLoadKey == requestKey else { return }
        var mergedRuns = conversationLoadedKey == requestKey ? conversationTurnRuns : [:]
        for run in page.turnRuns {
            if let current = mergedRuns[run.turnID] {
                mergedRuns[run.turnID] = try mergeLifetimeConversationRun(current: current, incoming: run)
            } else {
                mergedRuns[run.turnID] = run
            }
        }
        if conversationLoadedKey != requestKey {
            conversationTurns = page.turns
            conversationPrivacy = page.privacy
            conversationHasOlder = page.hasOlder
            conversationOldestSequence = page.oldestSequence
        } else {
            var turnsByID: [String: JSON] = [:]
            for turn in conversationTurns { turnsByID[turn["id"].text] = turn }
            for turn in page.turns { turnsByID[turn["id"].text] = turn }
            let mergedTurns = turnsByID.values.sorted {
                (conversationSequence($0["sequence"]) ?? 0) < (conversationSequence($1["sequence"]) ?? 0)
            }
            if let pageOldest = page.oldestSequence {
                let displayedOldest = mergedTurns.first.flatMap { conversationSequence($0["sequence"]) }
                if displayedOldest.map({ $0 >= pageOldest }) ?? true {
                    conversationOldestSequence = pageOldest
                    conversationHasOlder = page.hasOlder
                }
            } else if mergedTurns.isEmpty {
                conversationOldestSequence = nil
                conversationHasOlder = page.hasOlder
            }
            if privacyRank(page.privacy) > privacyRank(conversationPrivacy) {
                conversationPrivacy = page.privacy
            }
            conversationTurns = mergedTurns
        }
        conversationTurnRuns = mergedRuns
        conversationLoadedKey = requestKey
        conversationPageError = nil
    }

    private func loadOlderConversationTurns() async {
        guard canRead, model.isOnline, conversationLoadedKey == conversationLoadKey,
              conversationHasOlder, let beforeSequence = conversationOldestSequence,
              let target = selectedTarget, targetIsInScope, let api = model.api else { return }
        let requestKey = conversationLoadKey
        guard conversationLoadingOlderKey != requestKey else { return }
        conversationLoadingOlderKey = requestKey
        defer {
            if conversationLoadingOlderKey == requestKey { conversationLoadingOlderKey = nil }
        }
        do {
            let response = try await api.inspectLifetimeConversation(
                ghostID: target.ghostID,
                conversationID: target.conversationID,
                beforeSequence: beforeSequence,
                limit: 100
            )
            guard !Task.isCancelled, model.api === api, conversationLoadKey == requestKey, model.isOnline else { return }
            await model.refresh()
            guard !Task.isCancelled, model.api === api, conversationLoadKey == requestKey, model.isOnline else { return }
            let page = try parseCanonicalConversationPage(
                response,
                ghostID: target.ghostID,
                conversationID: target.conversationID
            )
            guard !page.turns.isEmpty,
                  let currentFirst = conversationTurns.first.flatMap({ conversationSequence($0["sequence"]) }),
                  let pageLast = page.turns.last.flatMap({ conversationSequence($0["sequence"]) }),
                  pageLast < currentFirst else {
                throw MobileError.response("Host returned no strictly older conversation turns.")
            }
            var mergedRuns = conversationTurnRuns
            for run in page.turnRuns {
                if let current = mergedRuns[run.turnID] {
                    mergedRuns[run.turnID] = try mergeLifetimeConversationRun(current: current, incoming: run)
                } else {
                    mergedRuns[run.turnID] = run
                }
            }
            conversationTurns = page.turns + conversationTurns
            conversationTurnRuns = mergedRuns
            conversationPrivacy = [conversationPrivacy, page.privacy].max { privacyRank($0) < privacyRank($1) } ?? "local_only"
            conversationHasOlder = page.hasOlder
            conversationOldestSequence = page.oldestSequence
            conversationPageError = nil
        } catch {
            guard !Task.isCancelled, conversationLoadKey == requestKey, model.api === api, model.isOnline else { return }
            await model.refresh()
            guard !Task.isCancelled, conversationLoadKey == requestKey, model.api === api, model.isOnline else { return }
            conversationPageError = error.localizedDescription
        }
    }

    private func reloadRecoveryItems() async {
        guard model.isLifetimeConnection else {
            recoveryItems = []
            recoveryScanError = nil
            recoveryLoaded = true
            return
        }
        recoveryLoaded = false
        guard let api = model.api else {
            recoveryItems = []
            recoveryScanError = "Lifetime transport is not configured."
            recoveryLoaded = true
            return
        }
        do {
            recoveryItems = try await api.lifetimeRecoveryItems()
            recoveryScanError = nil
        } catch {
            recoveryItems = []
            recoveryScanError = error.localizedDescription
        }
        recoveryLoaded = true
    }

    private func inspectPending(_ envelope: Envelope) async {
        restorePendingConversationTarget()
        guard canRead, model.isOnline, let api = model.api else { return }
        recoveryBusy = true
        actionError = nil
        var confirmedInput = false
        do {
            let result = try await api.inspectLifetimeCommand(envelope)
            notice = reconciliationLabel(result.status)
            if result.status == .confirmedSuccess {
                clearConfirmedConversationDraft(envelope)
                confirmedInput = envelope.command["envelope"]["body"]["method"].text == "conversation.input"
            }
            await model.refresh()
            await reloadRecoveryItems()
        } catch {
            actionError = error.localizedDescription
            await reloadRecoveryItems()
        }
        recoveryBusy = false
        if confirmedInput { await loadConversationLatest() }
    }

    private func clearConfirmedConversationDraft(_ envelope: Envelope) {
        let body = envelope.command["envelope"]["body"]
        guard body["method"].text == "conversation.input",
              model.drafts != nil,
              !body["ghost_id"].text.isEmpty,
              !body["conversation_id"].text.isEmpty else { return }
        let address = model.draftAddress(
            profileID: body["ghost_id"].text,
            conversationID: body["conversation_id"].text
        )
        guard address.profileID == body["ghost_id"].text,
              address.conversationID == body["conversation_id"].text else { return }
        let current = model.drafts?.draft(at: address)
        if let submittedDraft {
            guard submittedDraftAddress == address,
                  body["text"].text == submittedDraft.text,
                  current == submittedDraft else { return }
            model.drafts?.clear(submittedDraft, at: address)
        } else {
            guard let current, current.text == body["text"].text else { return }
            model.drafts?.clear(current, at: address)
        }
        if model.saveDrafts() {
            submittedDraft = nil
            submittedDraftAddress = nil
        } else {
            actionError = "Host가 입력을 확인했지만 해당 초안을 저장된 기록에서 지우지 못했습니다."
        }
    }

    private func inspectRecovery(_ item: LifetimeRecoveryItem) async {
        guard item.canReconcile, canRead, model.isOnline, let api = model.api else { return }
        recoveryBusy = true
        actionError = nil
        do {
            let result = try await api.reconcileLifetime(item.id)
            notice = reconciliationLabel(result.status)
            await model.refresh()
            await reloadRecoveryItems()
        } catch {
            actionError = error.localizedDescription
            await reloadRecoveryItems()
        }
        recoveryBusy = false
    }

    private func reconciliationLabel(_ status: LifetimeReconciliationStatus) -> String {
        switch status {
        case .confirmedSuccess: return "영수증으로 요청 완료를 확인했습니다."
        case .confirmedNoEffect: return "영수증으로 요청이 적용되지 않았음을 확인했습니다."
        case .notFound: return "현재 권한 범위에서 영수증을 찾지 못했습니다. 원래 요청을 보존하고 변경을 차단합니다."
        case .unresolved: return "영수증 응답이 확정적이지 않습니다. 원래 요청을 보존하고 변경을 차단합니다."
        }
    }


    private var targetSection: some View {
        Section("허용된 연결 대화") {
            if let issue = model.lifetimeTargetIssue {
                Label("Gateway가 정확한 연결 대상 쌍을 제공하지 않았습니다. 입력은 차단했습니다.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(GhostStyle.warning)
                Text(issue).font(.footnote).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
            } else if targetPairs.isEmpty {
                Label("현재 Gateway bootstrap에서 이 기기의 대화 대상 쌍을 확인하지 못했습니다.", systemImage: "exclamationmark.circle")
                    .foregroundStyle(GhostStyle.secondary)
            } else {
                Picker("대화 대상", selection: Binding(
                    get: { selectedTarget.map { targetSelectionKey($0) } ?? "" },
                    set: { selection in
                        if selection.isEmpty {
                            selectedConversationTargetKey = "explicit-none|\(model.lifetimeAuthorityKey)"
                        } else {
                            if targetPairs.contains(where: { targetSelectionKey($0) == selection }) {
                                lifetimeAuthorityKeyAtEntry = model.lifetimeAuthorityKey
                            }
                            selectedConversationTargetKey = selection
                        }
                    }
                )) {
                    Text("대상을 선택하세요").tag("")
                    ForEach(targetPairs) { target in
                        let status = target.mode == "active" ? "활성" : "읽기 전용 · 종료 중"
                        Text("\(target.label) · \(status)").tag(targetSelectionKey(target))
                    }
                }
                if let target = selectedTarget {
                    DisclosureGroup("기술 식별자") {
                        LabeledContent("Ghost ID", value: target.ghostID)
                            .font(.caption.monospaced()).textSelection(.enabled)
                        LabeledContent("Conversation ID", value: target.conversationID)
                            .font(.caption.monospaced()).textSelection(.enabled)
                    }
                    if target.kind == "specialist" {
                        Text("전문 담당 대화는 Host가 광고한 정확한 pair입니다. 역할 밖의 conversation ID는 선택할 수 없습니다.")
                            .font(.footnote).foregroundStyle(GhostStyle.secondary)
                    }
                } else if !authorityUnchanged {
                    Text("Host workspace 또는 authority epoch이 변경되었습니다. 현재 authority에서 target pair를 명시적으로 선택하세요.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                } else if activeTargetPairs.filter({ $0.kind == "primary" }).count != 1 {
                    Text("활성 Primary 대화가 하나로 확인되지 않았습니다. 전송 전에 광고된 대상을 명시적으로 선택하세요.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
            }
            if !dispatchEnabled {
                Text("이 Host가 dispatch를 비활성화했습니다. 상태 확인은 가능하지만 변경 요청은 차단됩니다.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)
            }
            if canWrite && !canRead {
                Text("Write-only 연결입니다. 대상 pair만 사용하며 snapshot, history와 첨부 목록은 요청하지 않습니다.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)
            } else if canRead && !canWrite {
                Text("읽기 전용 연결입니다. 요청과 변경은 비활성화됩니다. 저장된 요청의 영수증 확인은 계속 가능합니다.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)
            }
        }
    }
    private var conversationSection: some View {
        Section("대화") {
            if let target = selectedTarget, targetIsInScope {
                Text(target.kind == "primary" ? "주 Ghost 대화 · \(target.label)" : "전문 담당 대화 · \(target.label)")
                    .font(.headline)
                if target.mode != "active" {
                    Text("이 대화는 종료 중입니다. 기록은 확인할 수 있지만 새 입력은 차단됩니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                }
                if canRead {
                    if conversationLoading {
                        ProgressView("정본 대화 기록 불러오는 중")
                    } else if let issue = conversationPageError {
                        Label("정본 대화를 확인하지 못했습니다. 읽기 오류 동안 입력은 차단됩니다.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(GhostStyle.warning)
                        Text(issue).font(.footnote).foregroundStyle(GhostStyle.secondary).textSelection(.enabled)
                        if conversationLoadedKey == conversationLoadKey {
                            ForEach(conversationTurns.indices, id: \.self) { index in
                                conversationTurnRow(conversationTurns[index])
                            }
                            if conversationHasOlder {
                                Button {
                                    Task { await loadOlderConversationTurns() }
                                } label: {
                                    if conversationLoadingOlderKey == conversationLoadKey { ProgressView("이전 기록 불러오는 중") }
                                    else { Label("이전 대화 다시 불러오기", systemImage: "arrow.up") }
                                }
                                .disabled(conversationLoadingOlderKey == conversationLoadKey || !model.isOnline)
                            }
                        }
                    } else if conversationLoadedKey == conversationLoadKey {
                        if conversationTurns.isEmpty {
                            Text("Host가 보고한 정본 대화 기록이 비어 있습니다.")
                                .foregroundStyle(GhostStyle.secondary)
                        }
                        ForEach(conversationTurns.indices, id: \.self) { index in
                            conversationTurnRow(conversationTurns[index])
                        }
                        if conversationHasOlder, conversationOldestSequence != nil {
                            Button {
                                Task { await loadOlderConversationTurns() }
                            } label: {
                                if conversationLoadingOlderKey == conversationLoadKey { ProgressView("이전 기록 불러오는 중") }
                                else { Label("이전 대화 불러오기", systemImage: "arrow.up") }
                            }
                            .disabled(conversationLoadingOlderKey == conversationLoadKey || !model.isOnline)
                        }
                    } else {
                        ProgressView("정본 대화를 확인하는 중")
                    }
                } else {
                    Text("이 연결에는 Lifetime 읽기 권한이 없습니다. history 요청 없이 입력할 수 있으며 기본 공개 범위는 이 기기에서만입니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                }

                TextField("Ghost와 이야기하기", text: draftText, axis: .vertical)
                    .lineLimit(2...6)
                    .textInputAutocapitalization(.sentences)
                    .disabled(!canWrite || !targetIsInScope || target.mode != "active" || !dispatchEnabled || model.busy || !canMutate || !pendingConversationInputs.isEmpty || model.drafts == nil || model.draftError != nil)
                    .accessibilityLabel("정본 대화 입력")
                if let error = model.draftError {
                    Text(error).font(.footnote).foregroundStyle(GhostStyle.warning).textSelection(.enabled)
                }
                Text("입력은 UTF-8 65,536 byte 이하의 사용자 turn입니다. Goal이나 완료 상태를 대신 만들지 않습니다.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)

                Picker("자료 범위", selection: $requestedConversationPrivacy) {
                    Text("공개 자료 허용").tag("public")
                    Text("비공개").tag("private")
                    Text("이 기기에서만").tag("local_only")
                }
                Text("적용 범위: \(privacyLabel(effectiveConversationPrivacy)) · 기존 대화와 선택 자료의 더 제한적인 범위는 낮아지지 않습니다.")
                    .font(.footnote).foregroundStyle(GhostStyle.secondary)

                if canRead {
                    if eligibleConversationArtifacts.isEmpty {
                        Text("이 대화 scope에 사용할 수 있는 기존 Artifact가 없습니다. 새 locator를 열거나 가져오지 않습니다.")
                            .font(.footnote).foregroundStyle(GhostStyle.secondary)
                    } else {
                        Text("기존 Artifact 첨부 · 최대 16개").font(.subheadline.weight(.medium))
                        ForEach(eligibleConversationArtifacts.indices, id: \.self) { index in
                            let artifact = eligibleConversationArtifacts[index]
                            let key = artifactKey(artifact)
                            Toggle(isOn: Binding(
                                get: { selectedArtifactKeys.contains(key) },
                                set: { selected in
                                    if selected {
                                        if selectedConversationAttachments.count < 16 { selectedArtifactKeys.insert(key) }
                                    } else {
                                        selectedArtifactKeys.remove(key)
                                    }
                                }
                            )) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("Artifact · \(String(artifact["digest"].text.prefix(12)))")
                                    Text(privacyLabel(artifact["privacy"].text))
                                        .font(.caption).foregroundStyle(GhostStyle.secondary)
                                }
                            }
                        }
                    }
                } else {
                    Text("읽기 권한이 없는 연결에서는 Artifact 목록을 숨기고 첨부 locator를 보내지 않습니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                }

                Button {
                    Task { await submitConversationInput() }
                } label: {
                    Label(model.busy ? "저장 중" : "대화 보내기", systemImage: "arrow.up.circle.fill")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(GhostStyle.text)
                .disabled(!canSendConversation)
                if !canWrite {
                    Text("이 기기에는 lifetime.write 권한이 없습니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                } else if !dispatchEnabled {
                    Text("Host 복구 모드에서는 새 입력이 차단됩니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                } else if canRead && conversationPageError != nil {
                    Text("정본 기록의 오류를 해결할 때까지 새 입력은 전송되지 않습니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                } else if !canMutate {
                    Text("복구 요청, 영수증 확인 또는 현재 요청의 접수 확인이 끝날 때까지 새 입력은 차단됩니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.secondary)
                } else if (selectedDraft?.text.utf8.count ?? 0) > 65_536 {
                    Text("입력이 UTF-8 65,536 byte 제한을 초과했습니다.")
                        .font(.footnote).foregroundStyle(GhostStyle.warning)
                }
            } else if model.lifetimeTargetIssue != nil {
                Text("검증된 target_pairs가 없어 conversation 입력을 차단했습니다.")
                    .foregroundStyle(GhostStyle.secondary)
            } else {
                Text("활성 Primary pair를 확인하거나 광고된 대상을 명시적으로 선택하세요.")
                    .foregroundStyle(GhostStyle.secondary)
            }
        }
    }

    private func conversationTurnRow(_ turn: JSON) -> some View {
        let isUser = turn["kind"].text == "user"
        return VStack(alignment: .leading, spacing: 10) {
            GhostMessageBubble(text: turn["text"].text, isUser: isUser,
                               label: turn["kind"].text == "host_fact" ? "서버 확인" : "Ghost") {
                if turn["kind"].text == "assistant_advisory" {
                    Text("제안 · 실행 결과는 맡긴 일에서 확인")
                        .font(.caption2).foregroundStyle(GhostStyle.secondary)
                }
                ForEach(turn["attachments"].items.map { LifetimeScreenRecord(id: artifactKey($0), value: $0) }) { row in
                    Label("첨부 결과 · \(String(row.value["digest"].text.prefix(8)))", systemImage: "doc.text")
                        .font(.caption)
                }
            }
            if let run = conversationRun(for: turn), run.state != "answered" {
                VStack(alignment: .leading, spacing: 6) {
                    Text(conversationRunStatus(run)).font(.footnote).foregroundStyle(GhostStyle.secondary)
                    if ["queued", "running", "effect_unknown"].contains(run.state) || run.cancelRequested {
                        Button { Task { await requestConversationTurnCancellation(run) } } label: {
                            Label(conversationCancelButtonTitle(run), systemImage: "stop.circle")
                        }.font(.footnote).frame(minHeight: 44)
                            .disabled(!canRequestConversationTurnCancellation(run))
                    }
                }.frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            }
        }
    }

    private func conversationRun(for turn: JSON) -> LifetimeConversationRun? {
        let turnID: String
        switch turn["kind"].text {
        case "user":
            turnID = turn["id"].text
        case "assistant_advisory", "host_fact":
            turnID = turn["source_turn_id"].text
            guard !turnID.isEmpty,
                  !conversationTurns.contains(where: { $0["kind"] == .string("user") && $0["id"].text == turnID }),
                  conversationTurns.first(where: {
                      ["assistant_advisory", "host_fact"].contains($0["kind"].text)
                          && $0["source_turn_id"].text == turnID
                  })?["id"] == turn["id"] else { return nil }
        default:
            return nil
        }
        return conversationTurnRuns[turnID]
    }

    private func conversationRunStatus(_ run: LifetimeConversationRun) -> String {
        let status: String
        switch run.state {
        case "queued": status = "처리 대기 중 · 접수 확인 전"
        case "running": status = "Ghost가 생각하고 있어요"
        case "answered": status = "Controller 답변 확인 · 저장된 Ghost 제안은 별도 검증이 필요합니다."
        case "failed": status = "답변 처리 실패\(run.reasonCode.map { " · \($0)" } ?? "")"
        case "cancelled": status = "중지를 확인했어요"
        case "effect_unknown": status = "처리 결과를 확인하고 있어요 · 다시 보내지 마세요"
        default: status = "처리 상태를 확인할 수 없어요"
        }
        if run.cancelRequested && run.state != "cancelled" {
            return "취소 요청됨 · 완료 미확인. \(status)"
        }
        return status
    }

    private func conversationCancelButtonTitle(_ run: LifetimeConversationRun) -> String {
        if run.state == "cancelled" { return "취소 완료" }
        if run.cancelRequested { return "취소 요청됨 · 완료 확인 대기" }
        if ["answered", "failed"].contains(run.state) { return "이미 종료됨" }
        return "답변 중지 요청"
    }

    private func canRequestConversationTurnCancellation(_ run: LifetimeConversationRun) -> Bool {
        guard canMutate, targetIsInScope, let target = selectedTarget,
              target.ghostID == run.ghostID, target.conversationID == run.conversationID else { return false }
        return !run.cancelRequested && ["queued", "running", "effect_unknown"].contains(run.state)
    }

    private func requestConversationTurnCancellation(_ run: LifetimeConversationRun) async {
        guard canRequestConversationTurnCancellation(run),
              let target = selectedTarget, let api = model.api else { return }
        let requestKey = conversationLoadKey
        let body = JSON.object([
            "method": .string("conversation.cancel_turn"),
            "ghost_id": .string(target.ghostID),
            "conversation_id": .string(target.conversationID),
            "turn_id": .string(run.turnID),
        ])
        guard let response = await sendLifetime(body, expectedRevision: nil),
              !Task.isCancelled, conversationLoadKey == requestKey, model.api === api, model.isOnline,
              response["status"] == .string("success") else { return }
        do {
            let updated = try parseLifetimeConversationRuns(
                .array([response["data"]["run"]]),
                ghostID: target.ghostID,
                conversationID: target.conversationID,
                referencedTurnIDs: [run.turnID]
            )
            guard let latest = updated.first else {
                throw MobileError.response("Host did not return the targeted cancellation state.")
            }
            if let current = conversationTurnRuns[run.turnID] {
                conversationTurnRuns[run.turnID] = try mergeLifetimeConversationRun(current: current, incoming: latest)
            } else {
                conversationTurnRuns[run.turnID] = latest
            }
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func conversationTurnLabel(_ kind: String) -> String {
        switch kind {
        case "user": return "사용자"
        case "assistant_advisory": return "Ghost 제안 · 검증되지 않음"
        case "host_fact": return "Host 사실"
        default: return "알 수 없는 turn"
        }
    }


    @ViewBuilder
    private var pendingSection: some View {
        if !visiblePending.isEmpty {
            Section("접수 확인이 필요한 요청") {
                Text("저장된 Lifetime 요청은 다시 전송하지 않습니다. 같은 ID의 영수증을 명시적으로 확인합니다. 확인이 불가능하면 새 변경은 차단됩니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
                ForEach(visiblePending, id: \.request_id) { envelope in
                    let body = envelope.command["envelope"]["body"]
                    VStack(alignment: .leading, spacing: 8) {
                        Text(pendingLabel(body["method"].text))
                            .font(.headline)
                        Text("확인되지 않음 · command ID \(envelope.command["envelope"]["command_id"].text)")
                            .font(.caption.monospaced())
                            .foregroundStyle(GhostStyle.secondary)
                            .textSelection(.enabled)
                        if body["method"].text == "conversation.input" {
                            DisclosureGroup("보존된 입력·대상 · 다시 보내지 않음") {
                                LabeledContent("Ghost ID", value: body["ghost_id"].text)
                                    .font(.caption.monospaced()).textSelection(.enabled)
                                LabeledContent("Conversation ID", value: body["conversation_id"].text)
                                    .font(.caption.monospaced()).textSelection(.enabled)
                                Text(body["text"].text).textSelection(.enabled)
                                Text("자료 범위 · \(privacyLabel(body["privacy"].text)) · 첨부 \(body["attachments"].items.count)개")
                                    .font(.caption).foregroundStyle(GhostStyle.secondary)
                            }
                        } else if body["method"].text == "conversation.cancel_turn" {
                            DisclosureGroup("보존된 취소 대상 · 다시 보내지 않음") {
                                LabeledContent("Ghost ID", value: body["ghost_id"].text)
                                    .font(.caption.monospaced()).textSelection(.enabled)
                                LabeledContent("Conversation ID", value: body["conversation_id"].text)
                                    .font(.caption.monospaced()).textSelection(.enabled)
                                LabeledContent("Owner turn ID", value: body["turn_id"].text)
                                    .font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                        Button("같은 ID의 영수증 확인") {
                            Task { await inspectPending(envelope) }
                        }
                        .buttonStyle(.bordered)
                        .disabled(!canRead || !model.isOnline || model.busy || recoveryBusy)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    @ViewBuilder
    private var snapshotContent: some View {
        if visibleGoals.isEmpty {
            Section("저장된 목표") {
                Text("이 scope의 snapshot에는 아직 표시할 목표가 없습니다.")
                    .foregroundStyle(GhostStyle.secondary)
            }
        } else {
            ForEach(visibleGoals) { record in
                goalSection(record.value)
            }
        }
    }

    @ViewBuilder
    private func goalSection(_ goal: JSON) -> some View {
        let goalID = goal["id"].text
        let goalRevision = lifetimeRevision(goal["revision"])
        let savedPrompt = goal["prompt"].text
        let draft = goalDrafts[goalID] ?? savedPrompt
        let workItems = visibleWork.filter { $0.value["goal_id"].text == goalID }

        Section {
            GhostStatusBadge(state: goal["state"].text)
            DisclosureGroup("요청 기록") {
            LabeledContent("목표 ID", value: goalID)
                .font(.caption.monospaced())
                .textSelection(.enabled)
            LabeledContent("revision", value: lifetimeRevisionText(goal["revision"]))
            LabeledContent("담당 Ghost", value: goal["accountable_ghost"].text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
            LabeledContent("회신 대화", value: goal["reply_conversation"].text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
            }
            LabeledContent("자료 범위", value: privacyLabel(goal["privacy"].text))
            TextField("목표 내용", text: Binding(
                get: { goalDrafts[goalID] ?? savedPrompt },
                set: { goalDrafts[goalID] = $0 }
            ), axis: .vertical)
            .lineLimit(2...6)
            .disabled(!canWrite)
            Button("부탁한 내용 수정") {
                Task { await updateGoal(goal, prompt: draft) }
            }
            .buttonStyle(.bordered)
            .disabled(!canMutate || goalRevision == nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft == savedPrompt || !isObject(goal["acceptance_spec"]))

            if workItems.isEmpty {
                Text("이 snapshot에는 연결된 work가 없습니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
            } else {
                ForEach(workItems) { record in
                    workCard(record.value, goal: goal)
                }
            }
        } header: {
            Text("부탁한 내용")
        }
    }

    @ViewBuilder
    private func workCard(_ work: JSON, goal: JSON) -> some View {
        let workID = work["id"].text
        let workRevision = lifetimeRevision(work["goal_revision"])
        let executionID = work["execution_id"].text
        let cancellation = work["cancellation"].text
        let state = work["state"].text
        let artifacts = artifactRecords(for: work)
        let acceptances = acceptanceRecords(for: work)
        let acceptedDigests = Set(acceptances.map { $0.value["artifact_digest"].text })
        let terminal = ["accepted", "complete", "completed", "cancelled", "failed", "rejected"].contains(state)
        let steerDraft = steerDrafts[workID] ?? ""
        let canSteer = canMutate && !terminal && cancellation == "none" && workRevision != nil
            && !steerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let canCancel = canMutate && !terminal && cancellation == "none" && workRevision != nil

        VStack(alignment: .leading, spacing: 10) {
            GhostStatusBadge(state: state)
            DisclosureGroup("실행 기록") {
            LabeledContent("Work ID", value: workID)
                .font(.caption.monospaced())
                .textSelection(.enabled)
            LabeledContent("담당자", value: work["owner"].text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
            LabeledContent("Goal revision", value: lifetimeRevisionText(work["goal_revision"]))
            LabeledContent("Owner revision", value: lifetimeRevisionText(work["owner_revision"]))
            if executionID.isEmpty {
                Text("실행 ID가 아직 snapshot에 없습니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
            } else {
                LabeledContent("Execution ID", value: executionID)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            }
            if !work["blocker"].text.isEmpty {
                Label("대기 이유: \(work["blocker"].text)", systemImage: "clock")
                    .font(.callout)
            }
            if cancellation != "none" { LabeledContent("중지 상태", value: cancellationStateLabel(cancellation)) }
            if cancellation == "requested" || state == "cancel_requested" {
                Text("취소 요청이 장부에 기록됐지만 실행 종료는 아직 확인되지 않았습니다. 종료 receipt가 도착해야 취소가 확정되고, 이미 발생한 외부 효과는 사실대로 별도 대사됩니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
            }
            if ["cancelled", "failed", "rejected", "stale"].contains(state) {
                Text("이 work는 종료 상태입니다. 결과는 참조 기록으로만 남고 새 실행이 만들어지지 않습니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
            }
            if ["complete", "completed"].contains(state) {
                Text("실행 완료는 독립 acceptance와 다릅니다. 검수 기록을 별도로 확인하세요.")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(GhostStyle.secondary)
            }

            if artifacts.isEmpty {
                Text("이 소유 work의 producing execution에 연결된 artifact metadata가 snapshot에 없습니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("결과 metadata")
                        .font(.subheadline.weight(.semibold))
                    ForEach(artifacts) { record in
                        artifactCard(record.value, acceptedDigests: acceptedDigests, workID: workID, executionID: executionID)
                    }
                }
            }

            if acceptances.isEmpty {
                Text("이 work의 독립 acceptance 기록이 없습니다.")
                    .font(.footnote)
                    .foregroundStyle(GhostStyle.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("독립 acceptance 기록")
                        .font(.subheadline.weight(.semibold))
                    ForEach(acceptances) { record in
                        acceptanceCard(record.value, currentGoal: goal)
                    }
                }
            }

            if !terminal {
                TextField("다음 방향", text: Binding(
                    get: { steerDrafts[workID] ?? "" },
                    set: { steerDrafts[workID] = $0 }
                ), axis: .vertical)
                .lineLimit(2...5)
                .disabled(!canWrite || model.busy)
                HStack {
                    Button("방향 전달") {
                        Task { await steerWork(work, prompt: steerDraft) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(!canSteer)
                    Button("취소 요청", role: .destructive) {
                        Task { await cancelWork(work) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(!canCancel)
                }
                Text("방향 전달 및 취소 요청에는 화면에 표시된 goal revision \(lifetimeRevisionText(work["goal_revision"]))을 사용합니다.")
                    .font(.caption)
                    .foregroundStyle(GhostStyle.secondary)
                delegationControls(work, goal)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 16))
    }

    private func artifactCard(_ artifact: JSON, acceptedDigests: Set<String>, workID: String, executionID: String) -> some View {
        let digest = artifact["digest"].text
        let state = model.artifactState(workID: workID, digest: digest)
        return VStack(alignment: .leading, spacing: 4) {
            Text(acceptedDigests.contains(digest) ? "독립 검수 기록이 이 결과 digest를 참조합니다" : "결과 metadata 보고됨 · 일치하는 검수 기록 없음")
                .font(.callout.weight(.medium))
            Text("\(privacyLabel(artifact["privacy"].text)) · SHA-256 \(String(digest.prefix(12)))")
                .font(.caption.monospaced())
                .foregroundStyle(GhostStyle.secondary)
            Text("Producing execution · \(executionID)")
                .font(.caption.monospaced())
                .foregroundStyle(GhostStyle.secondary)
            if let state {
                if state.isLoading {
                    HStack { ProgressView(); Text("내용을 검증하는 중") }.font(.caption)
                } else if let error = state.error {
                    Text("열기 실패: \(error)")
                        .font(.caption)
                        .foregroundStyle(GhostStyle.warning)
                        .textSelection(.enabled)
                } else if state.content != nil {
                    Text("열린 문서는 아래 시트에서 볼 수 있습니다. 표시는 읽기 전용이며 원본을 바꾸지 않습니다.")
                        .font(.caption)
                        .foregroundStyle(GhostStyle.secondary)
                }
            }
            Button("문서 열기") {
                Task {
                    await model.loadArtifact(
                        workID: workID, executionID: executionID,
                        digest: digest, locator: artifact["locator"].text)
                    if let content = model.artifactState(workID: workID, digest: digest)?.content {
                        presentedArtifact = ArtifactSheet(content: content)
                    }
                }
            }
            .buttonStyle(.bordered)
            .disabled(!model.isOnline || !canRead || executionID.isEmpty || digest.isEmpty || artifact["locator"].text.isEmpty || state?.isLoading == true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 12))
    }

    // Cancellation is a state machine, not a boolean: requested means the
    // intent is durable but the stop is not yet confirmed.
    private func cancellationStateLabel(_ cancellation: String) -> String {
        switch cancellation {
        case "requested": return "취소 요청됨 · 종료 확인 전"
        case "confirmed": return "취소 확정"
        case "none": return "취소 요청 없음"
        default: return cancellation.isEmpty ? "미보고" : cancellation
        }
    }

    private func delegationCandidateGhostIDs(owner: String) -> [String] {
        let registered = Set(model.lifetimeConversationTargets.filter { $0.mode == "active" }.map(\.ghostID))
        return ghostIDs.filter { $0 != owner && registered.contains($0) }.sorted()
    }

    private func delegateTargetLabel(_ ghostID: String) -> String {
        let target = model.lifetimeConversationTargets.first { $0.ghostID == ghostID }
        return target?.label ?? ghostID
    }

    @ViewBuilder
    private func delegationControls(_ work: JSON, _ goal: JSON) -> some View {
        let workID = work["id"].text
        let candidates = delegationCandidateGhostIDs(owner: work["owner"].text)
        if !candidates.isEmpty, isObject(goal["acceptance_spec"]) {
            let selectedTarget = delegationTargets[workID] ?? ""
            let refs = (delegationArtifactKeys[workID] ?? []).compactMap { key in
                artifactRecords(for: work).first { $0.value["digest"].text == key }?.value["digest"].text
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("다른 담당자에게 위임")
                    .font(.subheadline.weight(.semibold))
                Text("위임은 같은 work 장부에 child work로 기록됩니다. 대상은 이 기기의 등록된 활성 Ghost 중에서만 고를 수 있고, 선택한 결과물은 원문 복사 없이 참조로 전달됩니다. 위임에도 화면의 goal revision을 CAS로 사용합니다.")
                    .font(.caption)
                    .foregroundStyle(GhostStyle.secondary)
                Picker("위임 대상", selection: Binding(
                    get: { delegationTargets[workID] ?? "" },
                    set: { delegationTargets[workID] = $0 })) {
                    Text("대상 선택").tag("")
                    ForEach(candidates, id: \.self) { ghostID in
                        Text(delegateTargetLabel(ghostID)).tag(ghostID)
                    }
                }
                TextField("위임 요약 · 무엇을 어디까지 맡기는지", text: Binding(
                    get: { delegationDrafts[workID] ?? "" },
                    set: { delegationDrafts[workID] = $0 }
                ), axis: .vertical)
                .lineLimit(2...4)
                .disabled(!canWrite)
                ForEach(artifactRecords(for: work)) { record in
                    let digest = record.value["digest"].text
                    Toggle("참조 · \(String(digest.prefix(12))) · \(privacyLabel(record.value["privacy"].text))", isOn: Binding(
                        get: { (delegationArtifactKeys[workID] ?? []).contains(digest) },
                        set: { on in
                            var current = delegationArtifactKeys[workID] ?? []
                            if on { current.insert(digest) } else { current.remove(digest) }
                            delegationArtifactKeys[workID] = current
                        }))
                }
                Button("위임 · revision \(lifetimeRevisionText(work["goal_revision"]))") {
                    Task { await delegateWork(work, goal, refs: refs) }
                }
                .buttonStyle(.bordered)
                .disabled(!canMutate || selectedTarget.isEmpty
                    || (delegationDrafts[workID] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(10)
            .background(GhostStyle.under, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func delegateWork(_ work: JSON, _ goal: JSON, refs: [String]) async {
        let workID = work["id"].text
        guard let revision = lifetimeRevision(work["goal_revision"]),
              let target = delegationTargets[workID], !target.isEmpty else { return }
        let body = JSON.object([
            "method": .string("work.delegate"),
            "parent_work_id": .string(workID),
            "target_ghost_id": .string(target),
            "summary": .string((delegationDrafts[workID] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)),
            "artifact_refs": .array(refs.map(JSON.string)),
            "acceptance_spec": goal["acceptance_spec"],
        ])
        let reply = await sendLifetime(body, expectedRevision: revision)
        if reply != nil {
            delegationDrafts[workID] = ""
            delegationArtifactKeys[workID] = []
            delegationTargets[workID] = ""
        }
    }

    @ViewBuilder
    private func acceptanceCard(_ acceptance: JSON, currentGoal: JSON) -> some View {
        let acceptedRevision = acceptance["goal_revision"]
        let currentRevision = currentGoal["revision"]
        VStack(alignment: .leading, spacing: 6) {
            Text("Goal revision \(lifetimeRevisionText(acceptedRevision)) · current goal revision \(lifetimeRevisionText(currentRevision))")
                .font(.caption)
                .foregroundStyle(GhostStyle.secondary)
            Text("Verifier \(acceptance["verifier_revision"].text) · policy revision \(lifetimeRevisionText(acceptance["policy_revision"]))")
                .font(.caption)
                .foregroundStyle(GhostStyle.secondary)
            if acceptance["checks"].items.isEmpty {
                Text("독립 검수 check가 없습니다.")
                    .font(.footnote)
            } else {
                ForEach(acceptance["checks"].items.indices, id: \.self) { index in
                    let check = acceptance["checks"].items[index]
                    Label(
                        "\(check["id"].text): \(check["passed"].flag ? "통과" : "미통과")",
                        systemImage: check["passed"].flag ? "checkmark.circle" : "xmark.circle"
                    )
                    .font(.footnote)
                }
            }
            Text("검수 근거 원문과 artifact locator는 표시하지 않습니다.")
                .font(.caption)
                .foregroundStyle(GhostStyle.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(GhostStyle.surface, in: RoundedRectangle(cornerRadius: 12))
    }

    private func submitConversationInput() async {
        guard canSendConversation, let target = selectedTarget,
              let address = selectedDraftAddress,
              let draft = model.drafts?.draft(at: address) else { return }
        let attachments = selectedConversationAttachments
        let body = JSON.object([
            "method": .string("conversation.input"),
            "ghost_id": .string(target.ghostID),
            "conversation_id": .string(target.conversationID),
            "text": .string(draft.text),
            "privacy": .string(effectiveConversationPrivacy),
            "attachments": .array(attachments),
        ])
        submittedDraft = draft
        submittedDraftAddress = address
        guard let response = await sendLifetime(body, expectedRevision: nil),
              response["status"] == .string("success") else { return }
        if model.drafts?.draft(at: address) == draft {
            model.drafts?.clear(draft, at: address)
            if !model.saveDrafts() {
                actionError = "Host가 입력을 확인했지만 해당 초안을 저장된 기록에서 지우지 못했습니다."
            }
        }
        submittedDraft = nil
        submittedDraftAddress = nil
        selectedArtifactKeys.subtract(attachments.map(artifactKey))
        await loadConversationLatest()
    }

    private func updateGoal(_ goal: JSON, prompt: String) async {
        let goalID = goal["id"].text
        guard let revision = lifetimeRevision(goal["revision"]), isObject(goal["acceptance_spec"]) else { return }
        let body = JSON.object([
            "method": .string("goal.update"),
            "goal_id": .string(goalID),
            "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
            "acceptance_spec": goal["acceptance_spec"],
        ])
        if let response = await sendLifetime(body, expectedRevision: revision), response["status"] == .string("success"),
           goalDrafts[goalID]?.trimmingCharacters(in: .whitespacesAndNewlines) == prompt.trimmingCharacters(in: .whitespacesAndNewlines) {
            goalDrafts.removeValue(forKey: goalID)
        }
    }

    private func steerWork(_ work: JSON, prompt: String) async {
        guard let revision = lifetimeRevision(work["goal_revision"]) else { return }
        let body = JSON.object([
            "method": .string("work.steer"),
            "work_id": .string(work["id"].text),
            "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
        ])
        if let response = await sendLifetime(body, expectedRevision: revision), response["status"] == .string("success"),
           steerDrafts[work["id"].text]?.trimmingCharacters(in: .whitespacesAndNewlines) == prompt.trimmingCharacters(in: .whitespacesAndNewlines) {
            steerDrafts.removeValue(forKey: work["id"].text)
        }
    }

    private func cancelWork(_ work: JSON) async {
        guard let revision = lifetimeRevision(work["goal_revision"]) else { return }
        let body = JSON.object([
            "method": .string("work.cancel"),
            "work_id": .string(work["id"].text),
        ])
        _ = await sendLifetime(body, expectedRevision: revision)
    }

    private func sendLifetime(_ body: JSON, expectedRevision: UInt64?) async -> JSON? {
        actionError = nil
        notice = nil
        do {
            let response = try await model.sendLifetime(body, expectedRevision: expectedRevision)
            if response["status"] == .string("error") {
                actionError = response["summary"].text.isEmpty ? "요청이 완료되지 않았습니다. 입력을 보존했습니다." : response["summary"].text
            } else {
                notice = response["summary"].text
            }
            return response
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    private func artifactRecords(for work: JSON) -> [LifetimeScreenRecord] {
        guard ghostIDs.contains(work["owner"].text) else { return [] }
        let executionID = work["execution_id"].text
        guard !executionID.isEmpty else { return [] }
        return lifetimeRecords(model.snapshot["artifacts"].items, key: "digest").filter {
            $0.value["producing_attempt"].text == executionID
        }
    }

    private func acceptanceRecords(for work: JSON) -> [LifetimeScreenRecord] {
        let workID = work["id"].text
        return model.snapshot["acceptances"].items.enumerated().compactMap { index, acceptance in
            guard acceptance["work_id"].text == workID else { return nil }
            let digest = acceptance["artifact_digest"].text
            guard !digest.isEmpty else { return nil }
            return LifetimeScreenRecord(id: "\(workID):\(digest):\(index)", value: acceptance)
        }
    }
    private func artifactKey(_ artifact: JSON) -> String {
        [artifact["digest"].text, artifact["locator"].text, artifact["producing_attempt"].text, artifact["privacy"].text]
            .map { "\($0.utf8.count):\($0)" }
            .joined()
    }
}
private struct CanonicalConversationPage {
    let privacy: String
    let turns: [JSON]
    let turnRuns: [LifetimeConversationRun]
    let hasOlder: Bool
    let oldestSequence: UInt64?
}

private func conversationSequence(_ value: JSON, allowZero: Bool = false) -> UInt64? {
    guard case .number(let number) = value,
          number.isFinite,
          number >= (allowZero ? 0 : 1),
          number.rounded(.towardZero) == number,
          number <= 9_007_199_254_740_991 else { return nil }
    return UInt64(number)
}

private func isCanonicalArtifact(_ value: JSON) -> Bool {
    guard case .object(let fields) = value, fields.count == 4 else { return false }
    let digest = value["digest"].text
    return digest.count == 64
        && digest.allSatisfy { "0123456789abcdef".contains($0) }
        && !value["locator"].text.isEmpty
        && !value["producing_attempt"].text.isEmpty
        && ["public", "private", "local_only"].contains(value["privacy"].text)
}

private func isCanonicalConversationTurn(_ value: JSON) -> Bool {
    guard case .object = value,
          case .string(let id) = value["id"], !id.isEmpty,
          conversationSequence(value["sequence"]) != nil,
          case .string(let senderKind) = value["sender_kind"], !senderKind.isEmpty,
          case .string(let senderRef) = value["sender_ref"], !senderRef.isEmpty,
          case .string(_) = value["text"],
          ["public", "private", "local_only"].contains(value["privacy"].text),
          ["user", "assistant_advisory", "host_fact"].contains(value["kind"].text),
          case .array(let attachments) = value["attachments"],
          attachments.allSatisfy(isCanonicalArtifact),
          conversationSequence(value["created_at_ms"], allowZero: true) != nil else { return false }
    switch value["source_turn_id"] {
    case .null: break
    case .string(let sourceTurnID) where !sourceTurnID.isEmpty && sourceTurnID.utf8.count <= 400: break
    default: return false
    }
    switch value["origin_report_id"] {
    case .null: break
    case .string(let reportID) where !reportID.isEmpty && reportID.utf8.count <= 400:
        guard value["kind"] == .string("assistant_advisory"),
              senderKind == "ghost",
              value["source_turn_id"] == .null else { return false }
    default: return false
    }
    return true
}

private func parseCanonicalConversationPage(
    _ response: JSON,
    ghostID: String,
    conversationID: String
) throws -> CanonicalConversationPage {
    let data = response["data"]
    guard response["status"] == .string("success"),
          case .object = data,
          data["ghost_id"] == .string(ghostID),
          data["conversation_id"] == .string(conversationID),
          ["public", "private", "local_only"].contains(data["privacy"].text),
          case .array(let turns) = data["turns"],
          case .bool(let hasOlder) = data["has_older"] else {
        throw MobileError.response(response["summary"].text.isEmpty ? "Host returned an invalid canonical conversation page." : response["summary"].text)
    }
    let oldestSequence: UInt64?
    if data["oldest_sequence"] == .null {
        oldestSequence = nil
    } else if let value = conversationSequence(data["oldest_sequence"]) {
        oldestSequence = value
    } else {
        throw MobileError.response("Host returned an invalid oldest conversation sequence.")
    }
    guard turns.allSatisfy(isCanonicalConversationTurn) else {
        throw MobileError.response("Host returned a malformed canonical conversation turn.")
    }
    let sequences = turns.compactMap { conversationSequence($0["sequence"]) }
    let turnIDs = turns.map { $0["id"].text }
    guard sequences.count == turns.count,
          Set(turnIDs).count == turnIDs.count,
          zip(sequences, sequences.dropFirst()).allSatisfy({ pair in pair.0 < pair.1 }),
          turns.first.map({ conversationSequence($0["sequence"]) == oldestSequence }) ?? (oldestSequence == nil) else {
        throw MobileError.response("Host conversation turns are not in canonical sequence order.")
    }
    var referencedTurnIDs: Set<String> = []
    var nonOwnerTurnIDs: Set<String> = []
    for turn in turns {
        if turn["kind"] == .string("user") {
            referencedTurnIDs.insert(turn["id"].text)
        } else {
            nonOwnerTurnIDs.insert(turn["id"].text)
            if case .string(let sourceTurnID) = turn["source_turn_id"] {
                referencedTurnIDs.insert(sourceTurnID)
            }
        }
    }
    let turnRuns = try parseLifetimeConversationRuns(
        data["turn_runs"],
        ghostID: ghostID,
        conversationID: conversationID,
        referencedTurnIDs: referencedTurnIDs
    )
    guard turnRuns.allSatisfy({ !nonOwnerTurnIDs.contains($0.turnID) }) else {
        throw MobileError.response("Host attributed a controller turn run to a non-Owner conversation turn.")
    }
    return CanonicalConversationPage(
        privacy: data["privacy"].text,
        turns: turns,
        turnRuns: turnRuns,
        hasOlder: hasOlder,
        oldestSequence: oldestSequence
    )
}

private func privacyRank(_ value: String) -> Int {
    switch value {
    case "public": return 0
    case "private": return 1
    case "local_only": return 2
    default: return 2
    }
}

private struct LifetimeScreenRecord: Identifiable {
    let id: String
    let value: JSON
}

private func lifetimeRecords(_ values: [JSON], key: String) -> [LifetimeScreenRecord] {
    var seen: Set<String> = []
    return values.compactMap { value in
        let identifier = value[key].text
        guard !identifier.isEmpty, seen.insert(identifier).inserted else { return nil }
        return LifetimeScreenRecord(id: identifier, value: value)
    }
}

private func lifetimeRevision(_ value: JSON) -> UInt64? {
    guard case .number(let number) = value,
          number.isFinite,
          number >= 1,
          number.rounded(.towardZero) == number,
          number <= 9_007_199_254_740_991 else { return nil }
    return UInt64(number)
}

private func lifetimeRevisionText(_ value: JSON) -> String {
    lifetimeRevision(value).map { String($0) } ?? "미보고"
}

private func privacyLabel(_ value: String) -> String {
    switch value {
    case "private": return "비공개"
    case "local_only": return "로컬에서만 처리"
    case "public": return "공개 자료 허용"
    default: return "범위 미보고"
    }
}

private func pendingLabel(_ method: String) -> String {
    switch method {
    case "goal.submit": return "새 목표 접수"
    case "goal.update": return "목표 수정"
    case "conversation.inspect": return "대화 기록 확인"
    case "conversation.turn.inspect": return "대화 발화 상태 확인"
    case "conversation.cancel_turn": return "대화 발화 취소 요청"
    case "conversation.input": return "정본 대화 입력"
    case "work.inspect": return "진행 확인"
    case "work.steer": return "방향 전달"
    case "work.cancel": return "취소 요청"
    default: return "저장된 Lifetime 요청"
    }
}

private func isObject(_ value: JSON) -> Bool {
    if case .object = value { return true }
    return false
}
