// A distinct functional observer. None of its clocks grant or revoke Work
// authority, settle SDK tasks, restart a wait, or authorize another model call.
use super::*;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub(super) const MODE: &str = "a04-functional-policy/1";
pub(super) const WINDOW_MS: u64 = 120_000;
const PROVIDER_REQUEST_MS: u64 = 180_000;
const NATIVE_OPERATION_MS: u64 = 180_000;
const COMMAND_OBSERVATION_MS: u64 = 130_000;
const PHASE_MODEL_CALLS: u64 = 40;
// Measured on the registered external path (a04 20261025T145642 trace): the
// original local-route budget of 400 (then 600) was consumed by legitimate
// per-fence transport before the third model call — ~45 Host fences per model
// call (turn/assignment inspection contract) plus selection/authority reads
// and 64 KiB-interval stream gates. 40 calls x ~53 callbacks ≈ 2,120; 3,000
// keeps a bounded ~1.4x headroom. Loop detection still trips via
// identical-request repeats and the 180s no-progress watchdog.
pub(super) const PHASE_CALLBACKS: u64 = 3_000;
const PHASE_DELIVERIES: u64 = 64;
const GRAPH_POLICY_MS: u64 = 1_800_000;
const FILE: &str = "a04-functional-observation.json";
const MAX_BYTES: usize = 262_144;

/// A conservative observation ceiling derived from existing independent
/// limits, not a product SLA or an extension of any Work/request authority.
fn safety_ceiling_ms() -> u64 {
    PHASE_MODEL_CALLS * PROVIDER_REQUEST_MS
        + PHASE_CALLBACKS * NATIVE_OPERATION_MS
        + PHASE_DELIVERIES * COMMAND_OBSERVATION_MS
        + GRAPH_POLICY_MS
}

pub(super) struct Observer {
    root: PathBuf,
    record: Value,
    phase_started_ms: u64,
    semantic_digest: Option<String>,
    semantic_progress_ms: u64,
    latest_progress: Value,
    probe_id: Option<String>,
    barrier: Option<Value>,
    sequence: u64,
    next_status_ms: u64,
    next_policy_ms: u64,
}

impl Observer {
    pub(super) fn open(root: &Path) -> Result<Self> {
        let now = crate::host::now_ms();
        let path = root.join(FILE);
        let mut record = if path.exists() {
            let bytes = std::fs::read(&path)?;
            ensure!(bytes.len() <= MAX_BYTES, "A04 functional observation bound");
            let value: Value = serde_json::from_slice(&bytes)?;
            ensure!(
                value["kind"] == "ghost-a04-functional-observation/1"
                    && value["mode"] == MODE
                    && !matches!(value["state"].as_str(), Some("accepted" | "failed")),
                "A04 functional observation identity/state changed"
            );
            value
        } else {
            json!({"kind":"ghost-a04-functional-observation/1","mode":MODE,"state":"observing","functional_verdict":"pending","observation_window_ms":WINDOW_MS,"windows_elapsed":0,"started_at_ms":now,"updated_at_ms":now,"elapsed_ms":0,"latest_checkpoint":null,"latest_idle_result":null,"policy_observation":null,"attention_reason":null,"attention_count":0,"runtime_open_count":0,"scope":null})
        };
        record["runtime_open_count"] =
            json!(record["runtime_open_count"].as_u64().unwrap_or(0) + 1);
        ensure!(
            record["runtime_open_count"].as_u64().unwrap() <= 2,
            "A04 functional observer cannot open a replacement runtime"
        );
        let observer = Self {
            root: root.into(),
            record,
            phase_started_ms: now,
            semantic_digest: None,
            semantic_progress_ms: now,
            latest_progress: Value::Null,
            probe_id: None,
            barrier: None,
            sequence: 0,
            next_status_ms: now,
            next_policy_ms: now,
        };
        observer.persist()?;
        Ok(observer)
    }

    pub(super) fn begin_probe(&mut self, id: &str, ghost: &str, conversation: &str) -> Result<()> {
        self.probe_id = Some(id.into());
        self.barrier = None;
        self.sequence = 0;
        self.record["scope"] =
            json!({"ghost_id":ghost,"conversation_id":conversation,"probe_id":id});
        self.record["latest_checkpoint"] = Value::Null;
        self.record["latest_idle_result"] = Value::Null;
        self.next_status_ms = crate::host::now_ms().saturating_add(WINDOW_MS);
        self.persist()
    }

    pub(super) fn invalidate_probe(&mut self) -> Result<()> {
        self.probe_id = None;
        self.barrier = None;
        self.sequence = 0;
        self.record["scope"] = Value::Null;
        self.record["latest_checkpoint"] = Value::Null;
        self.record["latest_idle_result"] = Value::Null;
        self.persist()
    }

    /// Stale/duplicate observer results cannot settle a later delivery. Only
    /// the existing SDK wait's own final result may settle this exact barrier.
    pub(super) fn frame(&mut self, event: &Value) -> Result<bool> {
        if event["id"].as_str() != self.probe_id.as_deref() {
            return Ok(false);
        }
        let valid = event["mode"] == MODE
            && matches!(
                event["type"].as_str(),
                Some("observation_checkpoint" | "idle_result")
            )
            && event["observation_seq"].as_u64().is_some_and(|seq| seq > 0)
            && (event["barrier_id"].is_string() || event["barrier_id"].as_u64().is_some());
        if !valid {
            self.attention("observation_frame_unconfirmed")?;
            return Ok(false);
        }
        let seq = event["observation_seq"].as_u64().unwrap();
        if seq <= self.sequence {
            return Ok(false);
        }
        if self
            .barrier
            .as_ref()
            .is_some_and(|old| old != &event["barrier_id"])
        {
            self.attention("observation_barrier_changed")?;
            return Ok(false);
        }
        self.barrier = Some(event["barrier_id"].clone());
        self.sequence = seq;
        ensure!(
            serde_json::to_vec(event)?.len() <= MAX_BYTES / 2,
            "A04 functional frame metadata bound"
        );
        self.latest_progress = event["progress"].clone();
        if event["type"] == "observation_checkpoint" {
            self.record["latest_checkpoint"] = event.clone();
            if event["reason_code"] == "observer_window_elapsed" {
                self.record["windows_elapsed"] =
                    json!(self.record["windows_elapsed"].as_u64().unwrap_or(0) + 1);
            }
            self.persist()?;
            return Ok(false);
        }
        self.record["latest_idle_result"] = event.clone();
        if event["observation"] != "settled"
            || event.get("error_code").is_some()
            || event["wait_pending"] != false
        {
            self.attention("original_idle_wait_unconfirmed")?;
            return Ok(false);
        }
        self.persist()?;
        Ok(true)
    }

    pub(super) fn status_due(&mut self, now: u64) -> bool {
        if self.probe_id.is_none() || now < self.next_status_ms {
            return false;
        }
        // Read-only status requests do not create waits, reset elapsed time or
        // consume another command/model admission. Cadence matches Host driver.
        self.next_status_ms = now.saturating_add(1_000);
        true
    }

    pub(super) fn refresh(&mut self, host: &Host) -> Result<()> {
        let now = crate::host::now_ms();
        if now < self.next_policy_ms {
            return Ok(());
        }
        self.next_policy_ms = now.saturating_add(1_000);
        match policy_observation(host, now) {
            Ok(policy) => {
                let key = semantic_key(&policy, &self.latest_progress)?;
                if self.semantic_digest.as_ref() != Some(&key) {
                    self.semantic_digest = Some(key);
                    self.semantic_progress_ms = now;
                }
                self.record["policy_observation"] = policy;
            }
            Err(_) => {
                self.record["policy_observation"] = json!({"kind":"ghost-a04-policy-observation/1","diagnostic_only":true,"source":"production-persisted-policy","observed_at_ms":now,"state":"unavailable"});
                self.attention("policy_observation_unavailable")?;
            }
        }
        if self.record["policy_observation"]["works"]
            .as_array()
            .is_some_and(|works| {
                works.iter().any(|work| {
                    matches!(
                        work["state"].as_str(),
                        Some("queued" | "running" | "blocked")
                    ) && work["execution_time_policy"]["effect_authority_alive"] == false
                })
            })
        {
            self.attention("effect_authority_observation_elapsed")?;
        }
        let progress_fresh = self.latest_progress["observed_at_ms"]
            .as_u64()
            .is_some_and(|observed| now.saturating_sub(observed) <= 1_000);
        if progress_fresh
            && self.latest_progress["provider_requests"]["active"]
                .as_array()
                .is_some_and(|requests| {
                    requests.iter().any(|request| {
                        request["deadline_at_ms"]
                            .as_u64()
                            .is_some_and(|deadline| now > deadline)
                    })
                })
        {
            self.attention("provider_request_observation_overdue")?;
        }
        self.record["safety_observation"] = json!({"diagnostic_only":true,"phase_started_at_ms":self.phase_started_ms,"conservative_phase_ceiling_ms":safety_ceiling_ms(),"derivation":{"model_calls":PHASE_MODEL_CALLS,"provider_request_ms":PROVIDER_REQUEST_MS,"callbacks":PHASE_CALLBACKS,"native_operation_ms":NATIVE_OPERATION_MS,"deliveries":PHASE_DELIVERIES,"command_observation_ms":COMMAND_OBSERVATION_MS,"graph_policy_ms":GRAPH_POLICY_MS},"last_semantic_progress_at_ms":self.semantic_progress_ms,"no_progress_watchdog_ms":PROVIDER_REQUEST_MS.max(NATIVE_OPERATION_MS),"does_not_stop_worker":true});
        if now.saturating_sub(self.phase_started_ms) >= safety_ceiling_ms() {
            self.attention("observation_safety_ceiling_reached")?;
        } else if now.saturating_sub(self.semantic_progress_ms)
            >= PROVIDER_REQUEST_MS.max(NATIVE_OPERATION_MS)
        {
            self.attention("scheduler_progress_unconfirmed")?;
        }
        self.persist()
    }

    pub(super) fn refresh_force(&mut self, host: &Host) -> Result<()> {
        self.next_policy_ms = 0;
        self.refresh(host)
    }

    pub(super) fn attention(&mut self, reason: &str) -> Result<()> {
        if self.record["attention_reason"] != reason {
            self.record["attention_count"] =
                json!(self.record["attention_count"].as_u64().unwrap_or(0) + 1);
        }
        self.record["state"] = json!("attention");
        self.record["functional_verdict"] = json!("unconfirmed");
        self.record["attention_reason"] = json!(reason);
        self.persist()
    }

    pub(super) fn pending(&mut self, kind: &str, value: Value) -> Result<()> {
        ensure!(
            matches!(
                kind,
                "pending_command" | "pending_callback" | "pending_delivery"
            ),
            "A04 pending observation kind"
        );
        ensure!(
            serde_json::to_vec(&value)?.len() <= 4096,
            "A04 pending observation bound"
        );
        if kind == "pending_callback" && !self.record[kind].is_null() {
            return Ok(());
        }
        self.record[kind] = value;
        self.persist()
    }

    fn persist(&self) -> Result<()> {
        write_record(&self.root, &self.record)
    }
}

fn write_record(root: &Path, record: &Value) -> Result<()> {
    use std::io::Write;
    let mut record = record.clone();
    let now = crate::host::now_ms();
    record["updated_at_ms"] = json!(now);
    record["elapsed_ms"] =
        json!(now.saturating_sub(record["started_at_ms"].as_u64().unwrap_or(now)));
    let bytes = serde_json::to_vec_pretty(&record)?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "A04 functional observation metadata bound"
    );
    let temporary = root.join("a04-functional-observation.next");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    std::fs::rename(temporary, root.join(FILE))?;
    Ok(())
}

pub(super) fn finish(root: &Path, accepted: bool) -> Result<Value> {
    let bytes = std::fs::read(root.join(FILE))?;
    ensure!(bytes.len() <= MAX_BYTES, "A04 functional observation bound");
    let mut record: Value = serde_json::from_slice(&bytes)?;
    ensure!(record["mode"] == MODE, "A04 functional result mode changed");
    record["state"] = json!(if accepted { "accepted" } else { "failed" });
    record["functional_verdict"] = json!(if accepted { "accepted" } else { "failed" });
    write_record(root, &record)?;
    Ok(serde_json::from_slice(&std::fs::read(root.join(FILE))?)?)
}

fn policy_observation(host: &Host, now: u64) -> Result<Value> {
    let state = host.lock()?;
    let conn = &state.journal.0;
    let mut query = conn.prepare("SELECT payload FROM lifetime_work ORDER BY id LIMIT 65")?;
    let rows = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(rows.len() <= 64, "A04 functional Work bound");
    let mut works = vec![];
    for raw in rows {
        let work: Work = serde_json::from_str(&raw)?;
        let time = lifetime::pi_execution::execution_time_policy(conn, &work, now)?;
        let (effect_count, last_effect) = if let Some(execution) = work.execution_id.as_deref() {
            let count: u64 = conn.query_row(
                "SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1",
                [execution],
                |r| r.get(0),
            )?;
            ensure!(count <= 400, "A04 functional effect bound");
            let mut query=conn.prepare("SELECT rowid,task_id,call_id,state,input_digest,response_json FROM lifetime_pi_effects WHERE execution_id=?1 ORDER BY rowid DESC LIMIT 1")?;
            let rows = query
                .query_map([execution], |r| {
                    Ok((
                        r.get::<_, u64>(0)?,
                        r.get::<_, u64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (count,rows.into_iter().next().map(|(row,task,call,status,digest,response)|json!({"rowid":row,"task_id":task,"call_id":call,"state":status,"input_digest":digest,"response_digest":response.map(|raw|format!("{:x}",Sha256::digest(raw.as_bytes())))})))
        } else {
            (0, None)
        };
        works.push(json!({"work_id":work.id,"goal_id":work.goal_id,"goal_revision":work.goal_revision,"owner_revision":work.owner_revision,"state":work.state,"cancellation":work.cancellation,"execution_time_policy":time,"effect_count":effect_count,"last_effect":last_effect}));
    }
    let mut query=conn.prepare("SELECT root_goal_id,deadline_ms,expired FROM lifetime_graph_budgets ORDER BY root_goal_id LIMIT 65")?;
    let graphs=query.query_map([],|r|Ok(json!({"root_goal_id":r.get::<_,String>(0)?,"deadline_ms":r.get::<_,u64>(1)?,"expired":r.get::<_,bool>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(graphs.len() <= 64, "A04 functional graph bound");
    Ok(
        json!({"kind":"ghost-a04-policy-observation/1","diagnostic_only":true,"state":"observed","observed_at_ms":now,"execution_authority_ms":300000,"provider_request_ms":PROVIDER_REQUEST_MS,"source":"production-persisted-policy","works":works,"graph_budgets":graphs}),
    )
}

fn semantic_key(policy: &Value, progress: &Value) -> Result<String> {
    let works=policy["works"].as_array().map(|works|works.iter().map(|work|json!({"work_id":work["work_id"],"state":work["state"],"cancellation":work["cancellation"],"effect_count":work["effect_count"],"last_effect":work["last_effect"],"execution_id":work["execution_time_policy"]["execution_id"],"execution_state":work["execution_time_policy"]["execution_state"],"paused_ms":work["execution_time_policy"]["paused_ms"]})).collect::<Vec<_>>()).unwrap_or_default();
    let sessions=progress["sessions"].as_array().map(|sessions|sessions.iter().map(|session|{
        let tasks=session["tasks"].as_array().map(|tasks|tasks.iter().map(|task|json!({"task_id":task["task_id"],"status":task["status"],"phase":task["phase"],"attempt":task["attempt"],"abort_requested":task["abort_requested"]})).collect::<Vec<_>>()).unwrap_or_default();
        json!({"context_ref":session["context_ref"],"latest_entry_id":session["latest_entry_id"],"tasks":tasks,"submissions":session["submissions"]})
    }).collect::<Vec<_>>()).unwrap_or_default();
    let requests=progress["provider_requests"]["active"].as_array().map(|requests|requests.iter().map(|request|json!({"request_id":request["request_id"],"request_digest":request["request_digest"]})).collect::<Vec<_>>()).unwrap_or_default();
    canonical_digest(
        &json!({"works":works,"graphs":policy["graph_budgets"],"sessions":sessions,"requests":requests}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn functional_observer_ages_do_not_fabricate_progress_and_stale_probe_cannot_settle() {
        let root = tempfile::tempdir().unwrap();
        let mut observer = Observer::open(root.path()).unwrap();
        observer.begin_probe("new", "g", "c").unwrap();
        let stale = json!({"type":"idle_result","id":"old","mode":MODE,"observation_seq":1,"barrier_id":1,"observation":"settled","wait_pending":false});
        assert!(!observer.frame(&stale).unwrap());
        let checkpoint = json!({"type":"observation_checkpoint","id":"new","mode":MODE,"observation_seq":1,"barrier_id":2,"reason_code":"observer_window_elapsed","wait_pending":true,"progress":{"sessions":[]}});
        assert!(!observer.frame(&checkpoint).unwrap());
        assert_eq!(observer.record["windows_elapsed"], 1);
        assert!(!observer.frame(&checkpoint).unwrap());
        assert_eq!(observer.record["windows_elapsed"], 1);
        let mut wrong = stale.clone();
        wrong["id"] = json!("new");
        wrong["observation_seq"] = json!(2);
        assert!(!observer.frame(&wrong).unwrap());
        let final_event = json!({"type":"idle_result","id":"new","mode":MODE,"observation_seq":2,"barrier_id":2,"observation":"settled","wait_pending":false});
        assert!(observer.frame(&final_event).unwrap());
        let policy = json!({"works":[],"graph_budgets":[]});
        let first = json!({"observed_at_ms":1,"sessions":[{"tasks":[{"task_id":9,"status":"running","phase":"request","attempt":1,"age_ms":2}]}],"provider_requests":{"active":[{"request_id":1,"request_digest":"same","age_ms":2}]}});
        let mut later = first.clone();
        later["observed_at_ms"] = json!(200000);
        later["sessions"][0]["tasks"][0]["age_ms"] = json!(200000);
        later["provider_requests"]["active"][0]["age_ms"] = json!(200000);
        assert_eq!(
            semantic_key(&policy, &first).unwrap(),
            semantic_key(&policy, &later).unwrap()
        );
        observer
            .attention("scheduler_progress_unconfirmed")
            .unwrap();
        assert_eq!(observer.record["functional_verdict"], "unconfirmed");
        assert_eq!(observer.probe_id.as_deref(), Some("new"));
    }
}
