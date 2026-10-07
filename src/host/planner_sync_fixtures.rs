//! Account-free deterministic adapter used only by tests.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[derive(Default)]
pub(crate) struct Synthetic {
    pub binding: String,
    pub items: Mutex<BTreeMap<String, RemoteResource>>,
    pub requests: Mutex<Vec<ConditionalWrite>>,
    pub lose_reply: AtomicBool,
    pub fail_read: AtomicBool,
    pub partial: AtomicBool,
}
impl Synthetic {
    pub fn new(binding: &str) -> Self {
        Self {
            binding: binding.into(),
            ..Default::default()
        }
    }
    pub fn seed(&self, uid: &str, raw: String) {
        self.items.lock().unwrap().insert(
            uid.into(),
            RemoteResource {
                uid: uid.into(),
                href: format!("{uid}.ics"),
                etag: "\"seed\"".into(),
                raw,
            },
        );
    }
    pub fn external(&self, uid: &str, raw: String) {
        let mut items = self.items.lock().unwrap();
        let r = items.get_mut(uid).unwrap();
        r.raw = raw;
        r.etag = "\"external\"".into();
    }
}
impl Adapter for Synthetic {
    fn binding(&self) -> &str {
        &self.binding
    }
    fn inventory(&self) -> AdapterFuture<'_, Inventory> {
        Box::pin(async move {
            Ok(Inventory {
                complete: !self.partial.load(Ordering::SeqCst),
                items: self.items.lock().unwrap().values().cloned().collect(),
            })
        })
    }
    fn observe_uid<'a>(&'a self, uid: &'a str) -> AdapterFuture<'a, Option<RemoteResource>> {
        Box::pin(async move {
            if self.fail_read.swap(false, Ordering::SeqCst) {
                bail!("synthetic unavailable read");
            }
            Ok(self.items.lock().unwrap().get(uid).cloned())
        })
    }
    fn write(&self, request: ConditionalWrite) -> AdapterFuture<'_, WriteOutcome> {
        Box::pin(async move {
            let mut items = self.items.lock().unwrap();
            let mut req = self.requests.lock().unwrap();
            req.push(request.clone());
            // DAV preconditions apply to the locator, not a UID dictionary.
            let old = items.values().find(|r| r.href == request.href);
            let replaced_uid = old.map(|r| r.uid.clone());
            let valid = match &request.condition {
                Condition::Absent => old.is_none(),
                Condition::Match(etag) => old.is_some_and(|r| r.etag == *etag),
            };
            if !valid {
                return Ok(WriteOutcome::PreconditionFailed);
            }
            if let Some(uid) = replaced_uid {
                items.remove(&uid);
            }
            if let Some(raw) = request.raw {
                items.insert(
                    request.uid.clone(),
                    RemoteResource {
                        uid: request.uid,
                        href: request.href,
                        etag: format!("\"write-{}\"", req.len()),
                        raw,
                    },
                );
            } else {
                items.remove(&request.uid);
            }
            Ok(if self.lose_reply.swap(false, Ordering::SeqCst) {
                WriteOutcome::Uncertain
            } else {
                WriteOutcome::Applied
            })
        })
    }
}

/// Controlled replies capture the observation before the host awaits it.
/// Notify permits are explicit; tests never rely on timing/sleeps for order.
pub(crate) struct ReadGate {
    pub entered: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
    observed: Option<RemoteResource>,
    fail: bool,
}
pub(crate) struct Controlled {
    pub remote: Synthetic,
    reads: Mutex<std::collections::VecDeque<Arc<ReadGate>>>,
}
impl Controlled {
    pub fn new(binding: &str) -> Self {
        Self {
            remote: Synthetic::new(binding),
            reads: Mutex::new(Default::default()),
        }
    }
    pub fn gate(&self, observed: Option<RemoteResource>, fail: bool) -> Arc<ReadGate> {
        let gate = Arc::new(ReadGate {
            entered: Default::default(),
            release: Default::default(),
            observed,
            fail,
        });
        self.reads.lock().unwrap().push_back(gate.clone());
        gate
    }
}
impl Adapter for Controlled {
    fn binding(&self) -> &str {
        self.remote.binding()
    }
    fn inventory(&self) -> AdapterFuture<'_, Inventory> {
        self.remote.inventory()
    }
    fn write(&self, request: ConditionalWrite) -> AdapterFuture<'_, WriteOutcome> {
        self.remote.write(request)
    }
    fn observe_uid<'a>(&'a self, uid: &'a str) -> AdapterFuture<'a, Option<RemoteResource>> {
        Box::pin(async move {
            let gate = self.reads.lock().unwrap().pop_front();
            if let Some(gate) = gate {
                gate.entered.notify_one();
                gate.release.notified().await;
                if gate.fail {
                    bail!("controlled delayed read failure");
                }
                Ok(gate.observed.clone())
            } else {
                self.remote.observe_uid(uid).await
            }
        })
    }
}
pub(crate) fn ics(uid: &str, kind: Kind, extra: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//EN\r\nBEGIN:{}\r\nUID:{uid}\r\nDTSTAMP:20261003T090000Z\r\nSUMMARY:{uid}\r\n{extra}END:{}\r\nEND:VCALENDAR\r\n",kind.tag(),kind.tag())
}
pub(crate) fn mutation(
    cid: &str,
    uid: Option<&str>,
    version: Option<u64>,
    operation: Verb,
    changes: Value,
) -> Mutation {
    Mutation {
        collection_id: cid.into(),
        uid: uid.map(str::to_string),
        expected_version: version,
        operation,
        changes: serde_json::from_value(changes).unwrap(),
    }
}
pub(crate) fn owner(app: &Arc<Host>, action: crate::control::api::OwnerAction) -> Value {
    app.action(crate::control::api::Action {
        request_id: uuid::Uuid::new_v4().to_string(),
        command: crate::control::api::Command::Workspace { action },
    })
    .unwrap()
}
pub(crate) fn configure_fixture(app: &Arc<Host>, cid: &str, kind: Kind, profiles: Vec<String>) {
    let reply = owner(
        app,
        crate::control::api::OwnerAction::SavePlannerCollection {
            collection: CollectionInput {
                id: cid.into(),
                binding: format!("fixture:{cid}"),
                kind,
                profiles,
                enabled: true,
            },
            version: None,
        },
    );
    assert_eq!(reply["ok"], true, "{reply}");
}
