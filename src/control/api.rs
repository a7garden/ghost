//! Versioned control-plane payloads shared by the local host, UI, and CLI.
//!
//! Serde names and shapes in this module are part of the local control API. Keep
//! them stable when moving host implementation details between modules.

use crate::{adapters::channels::SlackBinding, domain::Policy};
use serde::{Deserialize, Serialize};

pub use crate::durable::durable::{InputKind, ToolStatus};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub request_id: String,
    pub command: Command,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    /// Authenticated owner control only; model callers use a Task-bound host method.
    Routing {
        action: RoutingAction,
    },
    Workspace {
        action: OwnerAction,
    },
    CreateProfile {
        name: String,
        persona: String,
    },
    CreateConversation {
        profile_id: String,
        model: String,
        tools: bool,
    },
    Submit {
        profile_id: String,
        conversation_id: String,
        prompt: String,
        kind: InputKind,
    },
    Cancel {
        profile_id: String,
        task_id: String,
    },
    Compact {
        profile_id: String,
        conversation_id: String,
    },
    AddSchedule {
        profile_id: String,
        conversation_id: String,
        prompt: String,
        interval_seconds: u64,
    },
    PauseSchedule {
        schedule_id: String,
        paused: bool,
    },
    Grant {
        profile_id: String,
        path: String,
        operation: String,
    },
    Revoke {
        profile_id: String,
        grant_id: i64,
    },
    Reconcile {
        profile_id: String,
        effect_key: String,
        status: ToolStatus,
        summary: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum OwnerAction {
    ModelCatalog,
    DiscoverLocalModels,
    CheckModelProvider {
        id: String,
    },
    SaveModelProvider {
        provider: crate::host::models::Provider,
        version: u64,
    },
    DeleteModelProvider {
        id: String,
        version: u64,
    },
    SelectRoleModel {
        role: crate::host::models::Role,
        model: Option<String>,
        version: u64,
    },
    CreateAvatar {
        avatar: crate::host::avatars::AvatarInput,
    },
    ReadAvatar {
        id: String,
    },
    DeleteAvatar {
        id: String,
    },
    SetProfileAvatar {
        profile_id: String,
        avatar_id: Option<String>,
        version: u64,
    },
    #[cfg(feature = "caldav")]
    SavePlannerCollection {
        collection: crate::host::planner_sync::CollectionInput,
        version: Option<u64>,
    },
    #[cfg(feature = "caldav")]
    PlannerMutation {
        mutation: crate::host::planner_sync::Mutation,
    },
    #[cfg(feature = "caldav")]
    PlannerOperationStatus {
        collection_id: String,
        operation_id: String,
    },
    #[cfg(feature = "caldav")]
    ListConnectedPlanner {
        collection_id: String,
        from_ms: Option<i64>,
        to_ms: Option<i64>,
    },
    #[cfg(feature = "caldav")]
    ReconcilePlannerEffect {
        profile_id: String,
        effect_key: String,
    },
    SaveTodo {
        id: Option<String>,
        version: Option<u64>,
        todo: crate::host::planner::TodoInput,
    },
    DeleteTodo {
        id: String,
        version: u64,
    },
    SaveCalendarEvent {
        id: Option<String>,
        version: Option<u64>,
        event: crate::host::planner::EventInput,
    },
    DeleteCalendarEvent {
        id: String,
        version: u64,
    },
    SaveIntegration {
        id: Option<String>,
        version: Option<u64>,
        integration: crate::host::integrations::IntegrationInput,
    },
    DeleteIntegration {
        id: String,
        version: u64,
    },
    CheckIntegration {
        id: String,
    },
    CollaborationMessages {
        delegation_id: String,
        after: u64,
    },
    CancelDelegation {
        delegation_id: String,
        reason: String,
    },
    Backup {
        destination: String,
    },
    RecoverProfile {
        profile_id: String,
    },
    CreateSpace {
        name: String,
        path: String,
        writable: bool,
        profiles: Vec<String>,
    },
    SpaceAccess {
        space_id: String,
        writable: bool,
        profiles: Vec<String>,
    },
    UnlinkSpace {
        space_id: String,
    },
    ImportAsset {
        space_id: String,
        path: String,
    },
    ListPages {
        space_id: String,
        query: String,
    },
    ReadPage {
        space_id: String,
        page_id: Option<String>,
        locator: Option<String>,
    },
    SavePage {
        space_id: String,
        page_id: Option<String>,
        expected_hash: Option<String>,
        title: String,
        body: String,
        profile: String,
    },
    DecideReview {
        review_id: String,
        approve: bool,
    },
    PageChat {
        space_id: String,
        page_id: String,
        profile_id: String,
    },
    Policy {
        profile_id: String,
        policy: Policy,
    },
    Persona {
        profile_id: String,
        persona: String,
    },
    ConversationModel {
        profile_id: String,
        conversation_id: String,
        model: String,
    },
    Fork {
        profile_id: String,
        conversation_id: String,
    },
    Reset {
        profile_id: String,
        conversation_id: String,
    },
    History {
        profile_id: String,
        conversation_id: String,
        before_revision: u64,
    },
    DeleteSchedule {
        schedule_id: String,
    },
    Goal {
        profile_id: String,
        title: String,
        criteria: String,
        instruction: String,
        dependencies: Vec<String>,
        event: Option<String>,
    },
    GoalState {
        goal_id: String,
        state: String,
        evidence: Vec<String>,
    },
    Event {
        profile_id: String,
        name: String,
    },
    Computer {
        profile_id: String,
        verb: String,
    },
    SlackBinding {
        binding: SlackBinding,
    },
    SendSlack {
        outbox_id: String,
    },
    SlackReceipt {
        outbox_id: String,
        state: String,
        note: String,
    },
    VoiceStart {
        profile_id: String,
        conversation_id: String,
        sdp: String,
    },
    VoiceEnd {
        call_id: String,
    },
    VoiceEvent {
        call_id: String,
        event_id: String,
        role: String,
        transcript: String,
    },
    VoiceWork {
        call_id: String,
        function_id: String,
        prompt: String,
    },
    ResolveVoice {
        call_id: String,
        note: String,
    },
    Receipts,
    DismissReceipt {
        receipt_id: String,
        note: String,
    },
}

/// Owner selectors are resolved against current host state, never interpreted as grants.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct RoutingEntry {
    pub profile_id: String,
    pub conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct RoutingPermissions {
    pub read_work: bool,
    pub change_work: bool,
    pub read_content: bool,
    pub resolve_clarification: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoutingAction {
    RoutingCapability,
    RoutingView {
        entry: RoutingEntry,
        limit: usize,
        before_admission_id: Option<String>,
    },
    RoutingNatural {
        entry: RoutingEntry,
        text: String,
        kind: InputKind,
        #[serde(default)]
        resolves: Vec<crate::host::work_routing::ResolutionRef>,
        clarification_target: Option<crate::host::work_routing::Target>,
    },
    RoutingResults {
        entry: RoutingEntry,
    },
    RoutingCandidates {
        entry: RoutingEntry,
        query: String,
        limit: usize,
    },
    RoutingWork {
        entry: RoutingEntry,
        work_id: String,
    },
    RoutingDecisions {
        entry: RoutingEntry,
        work_id: String,
    },
    RoutingReceipt {
        entry: RoutingEntry,
        message_id: String,
    },
    RoutingAdmit {
        entry: RoutingEntry,
        text: String,
        segments: Vec<crate::host::work_routing::Segment>,
        #[serde(default)]
        resolves: Vec<crate::host::work_routing::ResolutionRef>,
        proposal: crate::host::work_routing::RoutingProposal,
    },
    /// Explicit routing content/work share, independent of general delegation.
    RoutingShareAccess {
        id: Option<String>,
        expected_version: Option<u64>,
        source: RoutingEntry,
        recipient: RoutingEntry,
        permissions: RoutingPermissions,
        enabled: bool,
        delegation_id: Option<String>,
    },
}
