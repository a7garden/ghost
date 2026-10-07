//! Host controls and normalized provider results. Credentials are never part
//! of these serializable activity records.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub struct Cancellation {
    inner: Arc<CancelState>,
}
#[derive(Default)]
struct CancelState {
    flag: AtomicBool,
    notify: Notify,
}
impl Cancellation {
    pub fn cancel(&self) {
        self.inner.flag.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.inner.flag.load(Ordering::SeqCst)
    }
    pub(crate) async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
pub struct RunControl {
    pub cancellation: Cancellation,
    pub timeout: Duration,
}
impl Default for RunControl {
    fn default() -> Self {
        Self {
            cancellation: Cancellation::default(),
            timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub provider_id: String,
    pub model: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum StreamEvent {
    DispatchStarted,
    TextDelta(String),
    Usage(TokenUsage),
    Completed,
}

pub struct CallResult {
    pub content: String,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Policy,
    Configuration,
    Authentication,
    RateLimit,
    Server,
    Redirect,
    Protocol,
    Network,
    Timeout,
    Cancelled,
    Limit,
    Observer,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeClass {
    NotSent,
    Rejected,
    Uncertain,
}

#[derive(Debug)]
pub struct CallFailure {
    pub kind: FailureKind,
    pub outcome: OutcomeClass,
}
impl CallFailure {
    pub fn new(kind: FailureKind, outcome: OutcomeClass) -> Self {
        Self { kind, outcome }
    }
    pub fn task_status(&self) -> &'static str {
        match (self.kind, self.outcome) {
            (_, OutcomeClass::Uncertain) => "uncertain",
            (FailureKind::Cancelled, OutcomeClass::NotSent) => "cancelled",
            (FailureKind::Policy, _) => "denied",
            _ => "failed",
        }
    }
}
impl std::fmt::Display for CallFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "provider {:?}; outcome {:?}; no automatic replay",
            self.kind, self.outcome
        )
    }
}
impl std::error::Error for CallFailure {}
