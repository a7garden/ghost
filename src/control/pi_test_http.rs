//! Test-only actual loopback HTTP boundary for an existing Host. Serial by
//! default, with a bounded concurrent opt-in; not the full serve lifecycle.
use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};

// Only explicitly registered fixture roots receive bounded callback metadata.
// The actual production route invokes Host exactly once; never retain bodies,
// source text, bearer headers, raw errors or credential-bearing arguments.
#[derive(Default)]
struct ObservationLog { rows:Vec<Value>, total:usize, first_host_error:Option<Value>, active:usize, peak_active:usize }
type Observations = Arc<Mutex<ObservationLog>>;
static OBSERVERS: std::sync::OnceLock<Mutex<std::collections::BTreeMap<std::path::PathBuf,std::sync::Weak<Mutex<ObservationLog>>>>> = std::sync::OnceLock::new();
struct ActiveCallback { command_id:String, context_ref:Option<String>, inner_errors:Vec<Value> }
thread_local! {static ACTIVE_CALLBACK:std::cell::RefCell<Option<ActiveCallback>>=const{std::cell::RefCell::new(None)};}
pub(super) struct CallbackScope(Option<Observations>);
impl Drop for CallbackScope {fn drop(&mut self){
    ACTIVE_CALLBACK.with(|slot|slot.borrow_mut().take());
    if let Some(target)=&self.0 {target.lock().unwrap().active-=1;}
}}
pub(super) fn begin_observation(root:&std::path::Path,input:&crate::host::lifetime::PiToolRequest)->CallbackScope {
    let target=OBSERVERS.get().and_then(|all|all.lock().unwrap().get(root).and_then(std::sync::Weak::upgrade));
    if let Some(target)=&target {let mut log=target.lock().unwrap();log.active+=1;log.peak_active=log.peak_active.max(log.active);}
    ACTIVE_CALLBACK.with(|slot|*slot.borrow_mut()=target.is_some().then(||ActiveCallback{command_id:input.envelope.command_id.clone(),context_ref:input.context_ref.clone(),inner_errors:vec![]}));
    CallbackScope(target)
}
// Exact static labels and typed numeric facts only. Unknown messages remain
// unknown; neither raw errors nor hashes of credential-bearing errors escape.
fn error_facts(error:&anyhow::Error)->Value {
    const REASONS:&[(&str,&str)]=&[
        ("Original isolated Pi context authority is unavailable","isolated_context_guard"),
        ("Bot is paused or retired; no new Work execution was started","bot_start_unavailable"),
        ("memory-derived delegation requires the target's explicit shared read profile","delegation_target_read_profile_missing"),
        ("Pi context canonical audience mismatch","context_audience"),
        ("Pi context epoch is no longer current","context_epoch"),
        ("Pi context assignment bytes changed","context_assignment_bytes"),
        ("Pi context Work missing","context_work_missing"),
        ("Pi context Work revision changed","context_work_revision"),
        ("Pi context Work cancelled","context_work_cancelled"),
        ("Pi context terminal scope changed","context_terminal_scope"),
        ("Terminal Pi context permits only exact original receipt recovery","context_terminal_replay"),
        ("Pi context execution lineage changed","context_execution_lineage"),
        ("Pi context reference malformed","context_reference_format"),
        ("Pi context reference not admitted","context_reference_unadmitted"),
        ("Isolated Pi callback requires its exact assignment and Work pair","context_pair"),
        ("Isolated Pi inspection requires its original assignment","context_inspection_assignment"),
        ("Pi context Work selector mismatch","context_work_selector"),
        ("Pi context assignment mismatch","context_assignment_selector"),
        ("Pi context has no durable generation claim","context_claim_missing"),
        ("Pi context generation mismatch","context_generation"),
        ("Pi context original execution is no longer current","context_execution_current"),
        ("Goal assignment does not match the current target Goal","assignment_target_goal"),
        ("Goal assignment Work is no longer current, uncancelled, and admissible","assignment_work_scope"),
        ("Goal assignment ancestry, revision, or graph deadline is no longer current","assignment_graph_scope"),
        ("Goal assignment continuation has no matching committed target work.submit","assignment_continuation"),
        ("Work memory authority changed during I/O","work_memory_authority_changed"),
        ("memory binding authority changed during I/O","binding_authority_changed"),
        ("Work memory assignment is stale or cancelled","work_memory_scope"),
        ("Work memory binding policy changed","work_memory_policy"),
        ("Work memory grant was revoked","work_memory_grant_revoked"),
        ("Work memory permission was revoked","work_memory_permission_revoked"),
        ("memory binding credential is unavailable","binding_credential_unavailable"),
        ("scoped memory authentication failed","native_authentication"),
        ("scoped memory space verification unavailable","native_space_verification"),
        ("server closed the connection","native_connection_closed"),
        ("read response","native_response_read"),
        ("parse response","native_response_json"),
    ];
    let mut causes=vec![];
    for cause in error.chain().take(4) {
        let text=cause.to_string();
        let reason=REASONS.iter().find_map(|(message,code)|(*message==text).then_some(*code));
        let fact=if let Some(sqlite)=cause.downcast_ref::<rusqlite::Error>() {
            match sqlite {
                rusqlite::Error::SqliteFailure(code,_)=>json!({"type":"sqlite","code":code.extended_code}),
                rusqlite::Error::QueryReturnedNoRows=>json!({"type":"sqlite","reason":"no_rows"}),
                _=>json!({"type":"sqlite","reason":"other"}),
            }
        }else if let Some(io)=cause.downcast_ref::<std::io::Error>() {
            json!({"type":"io","kind":format!("{:?}",io.kind()),"os_code":io.raw_os_error()})
        }else if let Some(json)=cause.downcast_ref::<serde_json::Error>() {
            json!({"type":"json","category":format!("{:?}",json.classify())})
        }else if cause.is::<tokio::time::error::Elapsed>() {json!({"type":"timeout"})}
        else {json!({"type":"untyped","reason":reason.unwrap_or("unclassified")})};
        causes.push(fact);
    }
    json!({"kind":"host_result_error","causes":causes})
}
pub(crate) fn observe_context_error(input:&crate::host::lifetime::PiToolRequest,error:&anyhow::Error) {
    ACTIVE_CALLBACK.with(|slot| {
        if let Some(active)=slot.borrow_mut().as_mut() {
            if active.command_id==input.envelope.command_id && active.context_ref==input.context_ref && active.inner_errors.len()<4 {
                active.inner_errors.push(error_facts(error));
            }
        }
    });
}
fn host_error_facts(result:&Result<Value>)->Option<Value> {
    match result {
        Err(error)=>Some(error_facts(error)),
        Ok(value) if value["ok"]==false=>value["error"].as_str().map(|message|error_facts(&anyhow::anyhow!(message.to_owned()))),
        _=>None,
    }
}
pub(super) fn observe(root:&std::path::Path,input:&crate::host::lifetime::PiToolRequest,result:&Result<Value>) {
    let Some(observers)=OBSERVERS.get() else{return};
    let target=observers.lock().unwrap().get(root).and_then(std::sync::Weak::upgrade);
    let Some(target)=target else{return};
    let inner_errors=ACTIVE_CALLBACK.with(|slot|slot.borrow_mut().as_mut().filter(|active|active.command_id==input.envelope.command_id&&active.context_ref==input.context_ref).map(|active|std::mem::take(&mut active.inner_errors)).unwrap_or_default());
    let mut log=target.lock().unwrap();
    let text=|value:&Value,limit|value.as_str().map(|s|s.chars().take(limit).collect::<String>());
    let body=&input.envelope.body;
    let response=result.as_ref().ok().map(|v|&v["result"]);
    let host_error=host_error_facts(result);
    let row=json!({"sequence":log.total,"method":text(&body["method"],80),"assignment_id":text(&body["assignment_id"],400),"work_id":text(&body["work_id"],400),"context_ref":input.context_ref.as_ref().map(|s|s.chars().take(400).collect::<String>()),"authority_epoch":input.envelope.authority_epoch,"status":response.and_then(|r|text(&r["status"],80)),"error_code":response.and_then(|r|text(&r["error_code"],80)),"host_error":host_error,"context_errors":inner_errors});
    log.total+=1;
    if host_error.is_some()&&log.first_host_error.is_none(){log.first_host_error=Some(row.clone());}
    if log.rows.len()==512{log.rows.remove(0);}
    log.rows.push(row);
}

#[test]
fn callback_error_diagnostics_emit_only_static_labels_and_typed_facts() {
    let secret="FIXTURE_CREDENTIAL_MUST_NOT_ESCAPE";
    for error in [anyhow::anyhow!(format!("unclassified {secret}")),anyhow::Error::new(std::io::Error::new(std::io::ErrorKind::PermissionDenied,secret))] {
        let facts=error_facts(&error).to_string();assert!(!facts.contains(secret));assert!(!facts.contains("unclassified "));
    }
    assert_eq!(error_facts(&anyhow::anyhow!("Pi context epoch is no longer current"))["causes"][0]["reason"],"context_epoch");
    let encoded=Ok(json!({"ok":false,"error":"Bot is paused or retired; no new Work execution was started"}));
    assert_eq!(host_error_facts(&encoded).unwrap()["causes"][0]["reason"],"bot_start_unavailable");
    assert!(!host_error_facts(&Ok(json!({"ok":false,"error":secret}))).unwrap().to_string().contains(secret));
}

pub(crate) struct Server {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    errors: Arc<Mutex<Vec<String>>>,
    posts: Arc<AtomicUsize>,
    bootstraps: Arc<AtomicUsize>,
    origin: String,
    observations: Observations,
    host_root: std::path::PathBuf,
}

impl Server {
    pub(crate) fn start(host: Arc<Host>, owner_token: String) -> Self {
        Self::start_mode(host, owner_token, false)
    }
    pub(crate) fn start_concurrent(host: Arc<Host>, owner_token: String) -> Self {
        Self::start_mode(host, owner_token, true)
    }
    fn start_mode(host: Arc<Host>, owner_token: String, concurrent: bool) -> Self {
        let observations=Arc::new(Mutex::new(ObservationLog::default()));
        let host_root=host.root.clone();
        OBSERVERS.get_or_init(||Mutex::new(std::collections::BTreeMap::new())).lock().unwrap().insert(host_root.clone(),Arc::downgrade(&observations));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        metadata::write(&host.root, port, owner_token.clone(), 1).unwrap();
        let session = Arc::new(http::Session::new_with_control_token(port, "pi-report-http", owner_token));
        let origin = session.origin.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let errors = Arc::new(Mutex::new(Vec::new()));
        let observed_errors = Arc::clone(&errors);
        let posts = Arc::new(AtomicUsize::new(0));
        let observed_posts = Arc::clone(&posts);
        let bootstraps = Arc::new(AtomicUsize::new(0));
        let observed_bootstraps = Arc::clone(&bootstraps);
        let thread = std::thread::spawn(move || {
            let mut requests:Vec<std::thread::JoinHandle<()>>=Vec::new();
            while !stopping.load(Ordering::Acquire) {
                let mut pending=Vec::new();
                for request in requests.drain(..) {
                    if request.is_finished() {request.join().expect("HTTP fixture handler panicked");}
                    else {pending.push(request);}
                }
                requests=pending;
                let (mut peer, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => {
                        observed_errors.lock().unwrap().push(e.to_string());
                        break;
                    }
                };
                peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                peer.set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                if concurrent && requests.len()>=MAX_CONNECTIONS {
                    let _=peer.shutdown(Shutdown::Both);
                    continue;
                }
                let host=Arc::clone(&host);
                let session=Arc::clone(&session);
                let observed_posts=Arc::clone(&observed_posts);
                let observed_bootstraps=Arc::clone(&observed_bootstraps);
                let observed_errors=Arc::clone(&observed_errors);
                let mut handle=move || {
                let result =
                    http::read_with_limit(&mut peer, REQUEST_BODY_LIMIT).and_then(|request| {
                        if request.target.starts_with("/api/v1/bootstrap/") {
                            observed_bootstraps.fetch_add(1, Ordering::SeqCst);
                        }
                        if request.target == "/api/v1/pi/action" {
                            observed_posts.fetch_add(1, Ordering::SeqCst);
                        }
                        route(&mut peer, &request, &session, &host, false)
                    });
                if let Err(error) = result {
                    observed_errors.lock().unwrap().push(error.to_string());
                }
                let _ = peer.shutdown(Shutdown::Both);
                };
                if concurrent {requests.push(std::thread::spawn(handle));} else {handle();}
            }
            for request in requests {request.join().expect("HTTP fixture handler panicked");}
        });
        Self {
            stop,
            thread: Some(thread),
            errors,
            posts,
            bootstraps,
            origin,
            observations,
            host_root,
        }
    }

    pub(crate) fn observation_count(&self)->usize {self.observations.lock().unwrap().total}
    pub(crate) fn peak_active_callbacks(&self)->usize {self.observations.lock().unwrap().peak_active}
    pub(crate) fn observations_since(&self,sequence:usize)->Vec<Value> {self.observations.lock().unwrap().rows.iter().filter(|row|row["sequence"].as_u64().unwrap()>=sequence as u64).cloned().collect()}
    pub(crate) fn diagnostic_observations(&self)->Value {
        let log=self.observations.lock().unwrap();
        let tail=log.rows.iter().skip(log.rows.len().saturating_sub(32)).cloned().collect::<Vec<_>>();
        json!({"total":log.total,"first_host_error":log.first_host_error,"tail":tail})
    }
    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }
    pub(crate) fn errors(&self) -> Vec<String> {
        self.errors.lock().unwrap().clone()
    }
    pub(crate) fn posts(&self) -> usize {
        self.posts.load(Ordering::SeqCst)
    }
    pub(crate) fn bootstraps(&self) -> usize {
        self.bootstraps.load(Ordering::SeqCst)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        OBSERVERS.get().unwrap().lock().unwrap().remove(&self.host_root);
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("HTTP fixture handler panicked");
        }
    }
}
