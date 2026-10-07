//! Root-journal A/B routing contracts. This module never opens a database,
//! invokes a model, dispatches a runtime task, or executes an external effect.
//! The host supplies current authenticated access while holding its state lock.
use anyhow::{bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const INPUT_SCHEMA: &str = "ghost-routing-input/1";
pub const PROPOSAL_SCHEMA: &str = "ghost-routing-proposal/2";
pub const RECORD_SCHEMA: u32 = 2;
const WORK: &str = "routing_work_v2";
const DECISION: &str = "routing_decision_v2";
const ADMISSION: &str = "routing_admission_v2";
const INTENT: &str = "routing_intent_v2";
const RESOLUTION: &str = "routing_resolution_v2";
const UNAVAILABLE: RoutingErrorCode = RoutingErrorCode::TargetUnavailable;

/// Stable UI recovery categories; the transport adapter can downcast anyhow
/// errors without matching human text. SQLite errors remain underlying errors.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutingErrorCode {
    TargetUnavailable,
    OriginUnavailable,
    RevisionConflict,
    InputCollision,
    AuthorityChanged,
    ClarificationAlreadyAnswered,
    MutationConflict,
}
impl std::fmt::Display for RoutingErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::MutationConflict => "multiple mutation groups target the same work",
            Self::TargetUnavailable => "routing target unavailable",
            Self::OriginUnavailable => "routing origin unavailable",
            Self::RevisionConflict => "routing revision conflict",
            Self::InputCollision => "message identity collision with different input",
            Self::AuthorityChanged => "routing authority changed during admission or query",
            Self::ClarificationAlreadyAnswered => {
                "clarification already answered; recover its receipt"
            }
        })
    }
}
impl std::error::Error for RoutingErrorCode {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    pub owner_id: String,
    pub entry_profile_id: String,
    pub conversation_id: String,
    pub message_id: String,
}

/// UTF-8 byte ranges in the original input. Gaps may contain whitespace only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    pub id: String,
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoutingInput {
    pub schema: String,
    pub origin: Origin,
    pub text: String,
    pub segments: Vec<Segment>,
    /// Explicit answers to held clarification segments; never inferred by ID reuse.
    #[serde(default)]
    pub resolves: Vec<ResolutionRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResolutionRef {
    pub source_admission_id: String,
    pub source_segment_id: String,
    pub expected_input_hash: String,
    pub answer_segment_id: String,
}
impl RoutingInput {
    pub fn hash(&self) -> Result<String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }
    pub fn admission_id(&self) -> Result<String> {
        identity(&[
            "admission",
            &self.origin.owner_id,
            &self.origin.conversation_id,
            &self.origin.message_id,
        ])
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.schema == INPUT_SCHEMA,
            "unsupported routing input schema"
        );
        for value in [
            &self.origin.owner_id,
            &self.origin.entry_profile_id,
            &self.origin.conversation_id,
            &self.origin.message_id,
        ] {
            identifier(value)?;
        }
        text(&self.text, 8192)?;
        ensure!(
            (1..=32).contains(&self.segments.len()),
            "invalid segment count"
        );
        let mut last = 0;
        let mut ids = BTreeSet::new();
        for segment in &self.segments {
            identifier(&segment.id)?;
            ensure!(ids.insert(&segment.id), "duplicate segment identity");
            ensure!(
                segment.start_byte >= last
                    && segment.end_byte > segment.start_byte
                    && segment.end_byte <= self.text.len()
                    && self.text.is_char_boundary(segment.start_byte)
                    && self.text.is_char_boundary(segment.end_byte),
                "invalid or overlapping UTF-8 segment range"
            );
            ensure!(
                self.text[last..segment.start_byte].trim().is_empty(),
                "input segment coverage is incomplete"
            );
            text(&self.text[segment.start_byte..segment.end_byte], 8192)?;
            last = segment.end_byte;
        }
        ensure!(
            self.text[last..].trim().is_empty(),
            "input segment coverage is incomplete"
        );
        ensure!(
            self.resolves.len() <= self.segments.len(),
            "too many clarification answers"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub work_id: String,
    pub expected_work_revision: u64,
    pub expected_decision_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    New {
        title: String,
        scope: String,
        responsible_profile_id: String,
        dependencies: Vec<Target>,
    },
    Amend {
        target: Target,
        scope: String,
    },
    Continue {
        target: Target,
    },
    Question {
        target: Option<Target>,
    },
    Cancel {
        target: Target,
    },
    Clarify {
        question: String,
        candidates: Vec<Target>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProposedSegment {
    /// First source segment in input order; anchors the operation identity.
    pub segment_id: String,
    /// Ordered, noncontiguous sources of this one amendment.
    #[serde(default)]
    pub additional_segment_ids: Vec<String>,
    pub operation: Operation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoutingProposal {
    pub schema: String,
    pub items: Vec<ProposedSegment>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    Pending,
    /// Admission of a cancellation request is not a runtime cancellation receipt.
    CancelRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Work {
    pub schema: u32,
    pub id: String,
    pub owner_id: String,
    pub title: String,
    pub scope: String,
    pub responsible_profile_id: String,
    pub origin: Origin,
    pub conversation_ids: Vec<String>,
    pub work_revision: u64,
    pub decision_revision: u64,
    pub status: WorkStatus,
    pub dependency_ids: Vec<String>,
    pub created_ms: u64,
    pub updated_ms: u64,
}
impl Work {
    pub fn target(&self) -> Target {
        Target {
            work_id: self.id.clone(),
            expected_work_revision: self.work_revision,
            expected_decision_revision: self.decision_revision,
        }
    }
}

/// Exact original slices; joined requested_text is only a convenience projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceFragment {
    pub segment_id: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub schema: u32,
    pub id: String,
    pub work_id: String,
    pub revision: u64,
    pub supersedes: Option<u64>,
    pub scope: String,
    pub status: WorkStatus,
    pub source_admission_id: String,
    pub source_segment_id: String,
    pub source_fragments: Vec<SourceFragment>,
    pub requested_text: String,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntentKind {
    New,
    Amend,
    Continue,
    Cancel,
}

/// An immutable dispatch request. No worker consumes it in this A/B module.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionIntent {
    pub schema: u32,
    pub id: String,
    pub work_id: String,
    pub decision_revision: u64,
    pub kind: IntentKind,
    pub source_admission_id: String,
    pub source_segment_id: String,
    pub source_fragments: Vec<SourceFragment>,
    pub requested_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcceptedSegment {
    pub segment_id: String,
    /// All members share this anchor, intent and single decision mutation.
    pub group_anchor_segment_id: String,
    pub work_id: Option<String>,
    pub work_revision: Option<u64>,
    pub decision_revision: Option<u64>,
    pub intent_id: Option<String>,
    pub operation: Operation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub schema: u32,
    pub id: String,
    pub input_hash: String,
    pub proposal_hash: String,
    pub input: RoutingInput,
    pub authority_revision: String,
    pub items: Vec<AcceptedSegment>,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    pub schema: u32,
    pub id: String,
    pub source_admission_id: String,
    pub source_segment_id: String,
    pub answer_admission_id: String,
    pub answer_segment_id: String,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdmissionView {
    pub admission: Admission,
    pub resolutions: Vec<Resolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub target: Target,
    pub title: String,
    pub scope_excerpt: String,
    pub responsible_profile_id: String,
    pub status: WorkStatus,
}

/// Trusted host capability adapter; deliberately not deserializable from model
/// output or a transport request. Policies/grants remain in their existing stores.
/// The caller holds the host state lock for the complete query/admission.
pub trait RoutingAccess {
    fn owner_id(&self) -> &str;
    fn revision(&self) -> String;
    /// Permission to submit the current input, not historical visibility.
    fn accepts_origin(&self, origin: &Origin) -> bool;
    /// Current explicit permission for a stored source conversation/profile.
    fn may_read_origin(&self, origin: &Origin) -> bool;
    /// Current permission for all raw input and derived clarification text in this receipt.
    fn may_read_receipt_content(&self, receipt: &Admission) -> bool;
    /// Separate current permission to consume this held segment exactly once.
    fn may_resolve_clarification(&self, receipt: &Admission, segment_id: &str) -> bool;
    fn may_create(&self) -> bool;
    fn may_assign(&self, profile_id: &str) -> bool;
    fn may_read(&self, work: &Work) -> bool;
    fn may_change(&self, work: &Work) -> bool;
}

impl super::scheduler::Journal {
    /// Receipt lookup is read-only: caller retry recovery runs this before any
    /// second model proposal. Current origin and all referenced work are checked.
    pub fn routing_receipt(
        &self,
        access: &impl RoutingAccess,
        origin: &Origin,
    ) -> Result<Option<AdmissionView>> {
        for id in [
            &origin.owner_id,
            &origin.entry_profile_id,
            &origin.conversation_id,
            &origin.message_id,
        ] {
            identifier(id)?;
        }
        ensure!(
            origin.owner_id == access.owner_id() && access.may_read_origin(origin),
            RoutingErrorCode::OriginUnavailable
        );
        let authority_revision = access.revision();
        let id = identity(&[
            "admission",
            &origin.owner_id,
            &origin.conversation_id,
            &origin.message_id,
        ])?;
        let Some(admission) = get::<Admission>(&self.0, ADMISSION, &id)? else {
            return Ok(None);
        };
        receipt_visible(&self.0, access, &admission)?;
        let mut resolutions = Vec::new();
        for item in &admission.items {
            if let Some(resolution) = get::<Resolution>(
                &self.0,
                RESOLUTION,
                &identity(&["resolution", &id, &item.segment_id])?,
            )? {
                let answer: Admission =
                    get(&self.0, ADMISSION, &resolution.answer_admission_id)?
                        .ok_or_else(|| anyhow::anyhow!("clarification answer receipt missing"))?;
                receipt_visible(&self.0, access, &answer)?;
                resolutions.push(resolution);
            }
        }
        ensure!(
            access.revision() == authority_revision,
            RoutingErrorCode::AuthorityChanged
        );
        Ok(Some(AdmissionView {
            admission,
            resolutions,
        }))
    }
    pub fn routing_candidates(
        &self,
        access: &impl RoutingAccess,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Candidate>> {
        ensure!(
            query.len() <= 200 && (1..=50).contains(&limit),
            "invalid candidate query"
        );
        let revision = access.revision();
        let query = query.to_lowercase();
        let mut works: Vec<Work> = records(&self.0, WORK)?;
        works.retain(|work| {
            work.owner_id == access.owner_id()
                && access.may_read(work)
                && (query.is_empty()
                    || work.title.to_lowercase().contains(&query)
                    || work.scope.to_lowercase().contains(&query))
        });
        ensure!(
            works.iter().all(|work| work.schema == RECORD_SCHEMA),
            "unsupported work record schema"
        );
        works.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.id.cmp(&b.id)));
        let candidates = works
            .into_iter()
            .take(limit)
            .map(|work| Candidate {
                target: work.target(),
                title: work.title,
                scope_excerpt: work.scope.chars().take(256).collect(),
                responsible_profile_id: work.responsible_profile_id,
                status: work.status,
            })
            .collect();
        ensure!(
            access.revision() == revision,
            RoutingErrorCode::AuthorityChanged
        );
        Ok(candidates)
    }

    pub fn routing_work(&self, access: &impl RoutingAccess, id: &str) -> Result<Work> {
        let revision = access.revision();
        let work = visible_work(&self.0, access, id, false)?;
        ensure!(
            access.revision() == revision,
            RoutingErrorCode::AuthorityChanged
        );
        Ok(work)
    }

    pub fn routing_decisions(
        &self,
        access: &impl RoutingAccess,
        id: &str,
    ) -> Result<Vec<Decision>> {
        let epoch = access.revision();
        let work = visible_work(&self.0, access, id, false)?;
        let history = (1..=work.decision_revision)
            .map(|revision| {
                get(&self.0, DECISION, &format!("{}:{revision}", work.id))?
                    .ok_or_else(|| anyhow::anyhow!("decision history missing"))
            })
            .collect::<Result<Vec<Decision>>>()?;
        for decision in &history {
            let source: Admission = get(&self.0, ADMISSION, &decision.source_admission_id)?
                .ok_or_else(|| anyhow::anyhow!(UNAVAILABLE))?;
            receipt_visible(&self.0, access, &source)?;
        }
        ensure!(
            access.revision() == epoch,
            RoutingErrorCode::AuthorityChanged
        );
        Ok(history)
    }

    /// Same input returns the originally committed plan, even if a new model
    /// proposal differs. It rechecks receipt visibility and never writes/dispatches.
    pub fn admit_routing(
        &self,
        access: &impl RoutingAccess,
        input: &RoutingInput,
        proposal: &RoutingProposal,
        now_ms: u64,
    ) -> Result<Admission> {
        input.validate()?;
        ensure!(
            input.origin.owner_id == access.owner_id() && access.accepts_origin(&input.origin),
            RoutingErrorCode::OriginUnavailable
        );
        let authority_revision = access.revision();
        text(&authority_revision, 256)?;
        let id = input.admission_id()?;
        let input_hash = input.hash()?;
        // IMMEDIATE serializes the read/validate/write admission across processes.
        // Existing root workspace_objects is the sole record store.
        let tx = Transaction::new_unchecked(&self.0, TransactionBehavior::Immediate)?;
        if let Some(saved) = get::<Admission>(&tx, ADMISSION, &id)? {
            ensure!(
                saved.input_hash == input_hash && saved.input == *input,
                RoutingErrorCode::InputCollision
            );
            receipt_visible(&tx, access, &saved)?;
            ensure!(
                access.revision() == authority_revision,
                RoutingErrorCode::AuthorityChanged
            );
            tx.commit()?;
            return Ok(saved);
        }
        ensure!(
            proposal.schema == PROPOSAL_SCHEMA,
            "unsupported routing proposal schema"
        );
        ensure!(
            !proposal.items.is_empty() && proposal.items.len() <= input.segments.len(),
            "one operation group required per covered segment"
        );
        let mut seen = BTreeSet::new();
        let mut mutations = BTreeSet::new();
        // Each original segment belongs to exactly one operation group. Groups
        // can span disjoint ranges; they never swallow an intervening operation.
        for item in &proposal.items {
            ensure!(
                item.additional_segment_ids.is_empty()
                    || matches!(item.operation, Operation::Amend { .. }),
                "only amendments support multiple source segments"
            );
            let mut previous = None;
            for id in std::iter::once(&item.segment_id).chain(&item.additional_segment_ids) {
                let index = input
                    .segments
                    .iter()
                    .position(|s| &s.id == id)
                    .ok_or_else(|| {
                        anyhow::anyhow!("missing, unknown or duplicate segment mapping")
                    })?;
                ensure!(
                    seen.insert(id),
                    "missing, unknown or duplicate segment mapping"
                );
                ensure!(
                    previous.is_none_or(|p| p < index),
                    "group source segments must follow input order"
                );
                previous = Some(index);
            }
            match &item.operation {
                Operation::New {
                    title,
                    scope,
                    responsible_profile_id,
                    dependencies,
                } => {
                    text(title, 160)?;
                    text(scope, 8192)?;
                    identifier(responsible_profile_id)?;
                    ensure!(
                        access.may_create() && access.may_assign(responsible_profile_id),
                        "routing creation unavailable"
                    );
                    ensure!(dependencies.len() <= 32, "too many dependencies");
                    let mut dependencies_seen = BTreeSet::new();
                    for target in dependencies {
                        checked_target(&tx, access, target, false)?;
                        ensure!(
                            dependencies_seen.insert(&target.work_id),
                            "duplicate dependency"
                        );
                    }
                }
                Operation::Amend { target, scope } => {
                    text(scope, 8192)?;
                    pending_target(&tx, access, target)?;
                    ensure!(
                        mutations.insert(&target.work_id),
                        RoutingErrorCode::MutationConflict
                    );
                }
                Operation::Continue { target } | Operation::Cancel { target } => {
                    pending_target(&tx, access, target)?;
                    ensure!(
                        mutations.insert(&target.work_id),
                        RoutingErrorCode::MutationConflict
                    );
                }
                Operation::Question { target } => {
                    if let Some(target) = target {
                        checked_target(&tx, access, target, false)?;
                    }
                }
                Operation::Clarify {
                    question,
                    candidates,
                } => {
                    text(question, 2048)?;
                    ensure!(candidates.len() <= 8, "too many clarification candidates");
                    let mut ids = BTreeSet::new();
                    for target in candidates {
                        checked_target(&tx, access, target, false)?;
                        ensure!(
                            ids.insert(&target.work_id),
                            "duplicate clarification candidate"
                        );
                    }
                }
            }
        }
        ensure!(
            seen.len() == input.segments.len(),
            "missing, unknown or duplicate segment mapping"
        );
        let mut source_segments = BTreeSet::new();
        let mut answer_segments = BTreeSet::new();
        for reference in &input.resolves {
            identifier(&reference.source_admission_id)?;
            identifier(&reference.source_segment_id)?;
            ensure!(
                source_segments
                    .insert((&reference.source_admission_id, &reference.source_segment_id))
                    && answer_segments.insert(&reference.answer_segment_id),
                "duplicate clarification answer mapping"
            );
            let answer = proposal
                .items
                .iter()
                .find(|item| {
                    item.segment_id == reference.answer_segment_id
                        || item
                            .additional_segment_ids
                            .contains(&reference.answer_segment_id)
                })
                .ok_or_else(|| anyhow::anyhow!("clarification answer segment missing"))?;
            ensure!(
                !matches!(answer.operation, Operation::Clarify { .. }),
                "clarification remains unresolved"
            );
            let source: Admission = get(&tx, ADMISSION, &reference.source_admission_id)?
                .ok_or_else(|| anyhow::anyhow!(UNAVAILABLE))?;
            receipt_visible(&tx, access, &source)?;
            ensure!(
                access.may_resolve_clarification(&source, &reference.source_segment_id),
                UNAVAILABLE
            );
            ensure!(
                source.input_hash == reference.expected_input_hash,
                "clarification receipt conflict"
            );
            ensure!(
                source
                    .items
                    .iter()
                    .any(|item| item.segment_id == reference.source_segment_id
                        && matches!(item.operation, Operation::Clarify { .. })),
                "source segment is not a held clarification"
            );
            let resolution_id =
                identity(&["resolution", &source.id, &reference.source_segment_id])?;
            ensure!(
                get::<Resolution>(&tx, RESOLUTION, &resolution_id)?.is_none(),
                RoutingErrorCode::ClarificationAlreadyAnswered
            );
        }
        let mut items = Vec::new();
        // Canonical input order, independent of the model's output item order.
        for segment in &input.segments {
            let Some(item) = proposal.items.iter().find(|i| i.segment_id == segment.id) else {
                continue;
            };
            let source_fragments: Vec<SourceFragment> = std::iter::once(&item.segment_id)
                .chain(&item.additional_segment_ids)
                .map(|id| {
                    let s = input
                        .segments
                        .iter()
                        .find(|s| &s.id == id)
                        .expect("validated group");
                    SourceFragment {
                        segment_id: s.id.clone(),
                        start_byte: s.start_byte,
                        end_byte: s.end_byte,
                        text: input.text[s.start_byte..s.end_byte].to_string(),
                    }
                })
                .collect();
            let requested_text = source_fragments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let mut accepted = AcceptedSegment {
                segment_id: segment.id.clone(),
                group_anchor_segment_id: segment.id.clone(),
                work_id: None,
                work_revision: None,
                decision_revision: None,
                intent_id: None,
                operation: item.operation.clone(),
            };
            let action = match &item.operation {
                Operation::New {
                    title,
                    scope,
                    responsible_profile_id,
                    dependencies,
                } => {
                    let work = Work {
                        schema: RECORD_SCHEMA,
                        id: identity(&["work", &id, &segment.id])?,
                        owner_id: input.origin.owner_id.clone(),
                        title: title.clone(),
                        scope: scope.clone(),
                        responsible_profile_id: responsible_profile_id.clone(),
                        origin: input.origin.clone(),
                        conversation_ids: vec![input.origin.conversation_id.clone()],
                        work_revision: 1,
                        decision_revision: 1,
                        status: WorkStatus::Pending,
                        dependency_ids: dependencies.iter().map(|t| t.work_id.clone()).collect(),
                        created_ms: now_ms,
                        updated_ms: now_ms,
                    };
                    // Creation must not produce a record invisible/unwritable to its
                    // admitting host principal. These checks cannot be model grants.
                    ensure!(
                        access.may_read(&work) && access.may_change(&work),
                        "routing creation unavailable"
                    );
                    insert(&tx, WORK, &work.id, &work)?;
                    insert_decision(
                        &tx,
                        &work,
                        &id,
                        segment,
                        &source_fragments,
                        &requested_text,
                        now_ms,
                    )?;
                    Some((work, IntentKind::New))
                }
                Operation::Amend { target, scope } => {
                    let old = pending_target(&tx, access, target)?;
                    let mut work = old.clone();
                    work.scope = scope.clone();
                    work.decision_revision = increment(work.decision_revision)?;
                    advance_work(&mut work, input, now_ms)?;
                    replace_work(&tx, &old, &work)?;
                    insert_decision(
                        &tx,
                        &work,
                        &id,
                        segment,
                        &source_fragments,
                        &requested_text,
                        now_ms,
                    )?;
                    Some((work, IntentKind::Amend))
                }
                Operation::Continue { target } => {
                    let old = pending_target(&tx, access, target)?;
                    let mut work = old.clone();
                    advance_work(&mut work, input, now_ms)?;
                    replace_work(&tx, &old, &work)?;
                    Some((work, IntentKind::Continue))
                }
                Operation::Cancel { target } => {
                    let old = pending_target(&tx, access, target)?;
                    let mut work = old.clone();
                    work.status = WorkStatus::CancelRequested;
                    work.decision_revision = increment(work.decision_revision)?;
                    advance_work(&mut work, input, now_ms)?;
                    replace_work(&tx, &old, &work)?;
                    insert_decision(
                        &tx,
                        &work,
                        &id,
                        segment,
                        &source_fragments,
                        &requested_text,
                        now_ms,
                    )?;
                    Some((work, IntentKind::Cancel))
                }
                Operation::Question { target } => {
                    if let Some(target) = target {
                        accepted.work_id = Some(target.work_id.clone());
                        accepted.work_revision = Some(target.expected_work_revision);
                        accepted.decision_revision = Some(target.expected_decision_revision);
                    }
                    None
                }
                Operation::Clarify { .. } => None,
            };
            if let Some((work, kind)) = action {
                let intent = ExecutionIntent {
                    schema: RECORD_SCHEMA,
                    id: identity(&["intent", &id, &segment.id])?,
                    work_id: work.id.clone(),
                    decision_revision: work.decision_revision,
                    kind,
                    source_admission_id: id.clone(),
                    source_segment_id: segment.id.clone(),
                    source_fragments: source_fragments.clone(),
                    requested_text,
                };
                insert(&tx, INTENT, &intent.id, &intent)?;
                accepted.work_id = Some(work.id);
                accepted.work_revision = Some(work.work_revision);
                accepted.decision_revision = Some(work.decision_revision);
                accepted.intent_id = Some(intent.id);
            }
            for fragment in &source_fragments {
                let mut member = accepted.clone();
                member.segment_id = fragment.segment_id.clone();
                items.push(member);
            }
        }
        items.sort_by_key(|item| {
            input
                .segments
                .iter()
                .position(|s| s.id == item.segment_id)
                .expect("validated coverage")
        });
        let receipt = Admission {
            schema: RECORD_SCHEMA,
            id,
            input_hash,
            proposal_hash: format!("{:x}", Sha256::digest(serde_json::to_vec(proposal)?)),
            input: input.clone(),
            authority_revision: authority_revision.clone(),
            items,
            created_ms: now_ms,
        };
        for reference in &input.resolves {
            let resolution = Resolution {
                schema: RECORD_SCHEMA,
                id: identity(&[
                    "resolution",
                    &reference.source_admission_id,
                    &reference.source_segment_id,
                ])?,
                source_admission_id: reference.source_admission_id.clone(),
                source_segment_id: reference.source_segment_id.clone(),
                answer_admission_id: receipt.id.clone(),
                answer_segment_id: reference.answer_segment_id.clone(),
                created_ms: now_ms,
            };
            insert(&tx, RESOLUTION, &resolution.id, &resolution)?;
        }
        receipt_visible(&tx, access, &receipt)?;
        insert(&tx, ADMISSION, &receipt.id, &receipt)?;
        ensure!(
            access.revision() == authority_revision,
            RoutingErrorCode::AuthorityChanged
        );
        tx.commit()?;
        Ok(receipt)
    }
}

fn text(value: &str, max: usize) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= max,
        "text empty or too large"
    );
    Ok(())
}
fn identifier(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 200
            && value.chars().all(|c| !c.is_whitespace() && !c.is_control()),
        "invalid routing identity"
    );
    Ok(())
}
fn identity(parts: &[&str]) -> Result<String> {
    Ok(uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, &serde_json::to_vec(parts)?).to_string())
}
fn increment(value: u64) -> Result<u64> {
    value
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("routing revision exhausted"))
}
fn get<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> Result<Option<T>> {
    let value: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    value
        .map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
fn records<T: serde::de::DeserializeOwned>(conn: &Connection, kind: &str) -> Result<Vec<T>> {
    let mut stmt =
        conn.prepare("SELECT payload FROM workspace_objects WHERE kind=?1 ORDER BY id")?;
    let rows = stmt.query_map([kind], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}
fn insert(conn: &Connection, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
    conn.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![kind, id, serde_json::to_string(value)?],
    )?;
    Ok(())
}
fn visible_work(
    conn: &Connection,
    access: &impl RoutingAccess,
    id: &str,
    change: bool,
) -> Result<Work> {
    identifier(id)?;
    let Some(work) = get::<Work>(conn, WORK, id)? else {
        bail!(UNAVAILABLE);
    };
    ensure!(
        work.owner_id == access.owner_id()
            && access.may_read(&work)
            && (!change || access.may_change(&work)),
        UNAVAILABLE
    );
    ensure!(
        work.schema == RECORD_SCHEMA,
        "unsupported work record schema"
    );
    Ok(work)
}
fn checked_target(
    conn: &Connection,
    access: &impl RoutingAccess,
    target: &Target,
    change: bool,
) -> Result<Work> {
    let work = visible_work(conn, access, &target.work_id, change)?;
    ensure!(
        work.work_revision == target.expected_work_revision
            && work.decision_revision == target.expected_decision_revision,
        RoutingErrorCode::RevisionConflict
    );
    Ok(work)
}
fn pending_target(conn: &Connection, access: &impl RoutingAccess, target: &Target) -> Result<Work> {
    let work = checked_target(conn, access, target, true)?;
    ensure!(
        work.status == WorkStatus::Pending,
        "work cancellation is pending"
    );
    ensure!(
        access.may_assign(&work.responsible_profile_id),
        "routing responsibility unavailable"
    );
    Ok(work)
}
fn advance_work(work: &mut Work, input: &RoutingInput, now_ms: u64) -> Result<()> {
    work.work_revision = increment(work.work_revision)?;
    work.updated_ms = now_ms.max(work.updated_ms);
    if !work
        .conversation_ids
        .contains(&input.origin.conversation_id)
    {
        ensure!(
            work.conversation_ids.len() < 128,
            "work conversation reference limit reached"
        );
        work.conversation_ids
            .push(input.origin.conversation_id.clone());
    }
    Ok(())
}
fn replace_work(conn: &Connection, old: &Work, work: &Work) -> Result<()> {
    let updated = conn.execute(
        "UPDATE workspace_objects SET payload=?1 WHERE kind=?2 AND id=?3 AND payload=?4",
        params![
            serde_json::to_string(work)?,
            WORK,
            old.id,
            serde_json::to_string(old)?
        ],
    )?;
    ensure!(updated == 1, RoutingErrorCode::RevisionConflict);
    Ok(())
}
fn insert_decision(
    conn: &Connection,
    work: &Work,
    admission: &str,
    segment: &Segment,
    source_fragments: &[SourceFragment],
    requested_text: &str,
    now_ms: u64,
) -> Result<()> {
    let decision = Decision {
        schema: RECORD_SCHEMA,
        id: format!("{}:{}", work.id, work.decision_revision),
        work_id: work.id.clone(),
        revision: work.decision_revision,
        supersedes: work.decision_revision.checked_sub(1).filter(|r| *r > 0),
        scope: work.scope.clone(),
        status: work.status,
        source_admission_id: admission.into(),
        source_segment_id: segment.id.clone(),
        source_fragments: source_fragments.to_vec(),
        requested_text: requested_text.into(),
        created_ms: now_ms,
    };
    insert(conn, DECISION, &decision.id, &decision)
}
fn references(operation: &Operation) -> Vec<&Target> {
    match operation {
        Operation::New { dependencies, .. } => dependencies.iter().collect(),
        Operation::Amend { target, .. }
        | Operation::Continue { target }
        | Operation::Cancel { target } => vec![target],
        Operation::Question { target } => target.iter().collect(),
        Operation::Clarify { candidates, .. } => candidates.iter().collect(),
    }
}
fn receipt_visible(
    conn: &Connection,
    access: &impl RoutingAccess,
    receipt: &Admission,
) -> Result<()> {
    ensure!(
        receipt.schema == RECORD_SCHEMA,
        "unsupported admission record schema"
    );
    ensure!(
        receipt.input.origin.owner_id == access.owner_id()
            && access.may_read_origin(&receipt.input.origin)
            && access.may_read_receipt_content(receipt),
        UNAVAILABLE
    );
    for item in &receipt.items {
        if let Some(id) = &item.work_id {
            visible_work(conn, access, id, false)?;
        }
        for target in references(&item.operation) {
            visible_work(conn, access, &target.work_id, false)?;
        }
    }
    Ok(())
}
