//! Native source-occurrence acceptance only. No model, PDC indexing, SDK
//! generation, installed service, or production store is exercised here.
use super::*;
use crate::{
    control::{
        api::{Action, Command, OwnerAction},
        server::pi_test_http::Server,
    },
    host::lifetime::pi_execution::tests as pi,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const TEXT: &str = "A17 identical source bytes retained as independent occurrences.";

fn private_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn native(binary: &Path, store: &Path, args: &[&str]) -> String {
    let mut child = std::process::Command::new(binary)
        .arg("--dir")
        .arg(store)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("isolated native setup exceeded its test-process bound");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "isolated native setup failed; credential-bearing output withheld"
    );
    String::from_utf8(output.stdout).unwrap()
}

fn token(binary: &Path, store: &Path, space: &str) -> String {
    native(
        binary,
        store,
        &[
            "admin",
            "token",
            "issue",
            "--space",
            space,
            "--caps",
            "read,ingest",
        ],
    )
    .lines()
    .find_map(|line| line.strip_prefix("secret (shown once): "))
    .unwrap()
    .to_owned()
}

fn request(ghost: &str, conversation: &str, turn: &str, command: &str) -> Value {
    let mut envelope = pi::envelope(
        ghost,
        json!({"method":"memory.retain", "ghost_id":ghost,
        "conversation_id":conversation, "turn_id":turn, "text":TEXT}),
    );
    envelope.command_id = command.into();
    envelope.correlation_id = command.into();
    json!({"ghost_id":ghost, "conversation_id":conversation, "envelope":envelope})
}

fn events(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join("events.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn sources(host: &Host, ghost: &str, conversation: &str) -> Vec<Value> {
    host.owner_memory_source_list(ghost, conversation).unwrap()["data"]["sources"]
        .as_array()
        .unwrap()
        .clone()
}

fn source_identity(row: &Value) -> Value {
    json!({"origin":row["origin"], "source_locator":row["receipt"]["source_locator"]})
}

fn turn_snapshots(host: &Host, requests: &[Value]) -> Value {
    let state = host.lock().unwrap();
    json!(requests.iter().map(|request| {
        let turn=request["envelope"]["body"]["turn_id"].as_str().unwrap();
        let actual:Option<(String,bool)>=state.journal.0.query_row(
            "SELECT state,cancel_requested FROM lifetime_turn_runs WHERE turn_id=?1 AND ghost_id=?2 AND conversation_id=?3",
            rusqlite::params![turn,request["ghost_id"].as_str().unwrap(),request["conversation_id"].as_str().unwrap()],
            |row|Ok((row.get(0)?,row.get(1)?))).optional().unwrap();
        json!({"turn_id":turn,"ghost_id":request["ghost_id"],"conversation_id":request["conversation_id"],
            "run_present":actual.is_some(),"state":actual.as_ref().map(|row|row.0.as_str()),
            "cancel_requested":actual.as_ref().map(|row|row.1)})
    }).collect::<Vec<_>>())
}

fn episodes(store: &Path) -> Vec<Value> {
    let db = Connection::open_with_flags(store.join("brain.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    let mut query = db.prepare("SELECT id,space_id,source_id,occurrence_id,hex(content_hash),content,source_kind,source_ref,trust,kind FROM episodes ORDER BY id").unwrap();
    let rows = query
        .query_map([], |row| {
            Ok(
                json!({"id":row.get::<_,String>(0)?, "space":row.get::<_,String>(1)?,
        "source_id":row.get::<_,String>(2)?, "occurrence_id":row.get::<_,String>(3)?,
        "content_hash":row.get::<_,String>(4)?, "content":row.get::<_,String>(5)?,
        "source_kind":row.get::<_,String>(6)?, "source_ref":row.get::<_,String>(7)?,
        "trust":row.get::<_,String>(8)?, "kind":row.get::<_,String>(9)?}),
            )
        })
        .unwrap();
    let rows: Vec<Value> = rows.map(|row| row.unwrap()).collect();
    assert!(
        rows.len() <= 2,
        "isolated source fixture returned unexpected extra episodes"
    );
    // Capture actual native coordinates before this read-only connection
    // closes; subsequent external database access is not assumed available.
    let proof = json!({"kind":"ghost-a17-native-episode-snapshot/1","count":rows.len(),
        "coordinates":episode_coordinates(&rows)});
    private_json(
        &store.parent().unwrap().join(format!(
            "native-episode-snapshot-{}.json",
            uuid::Uuid::now_v7()
        )),
        &proof,
    );
    eprintln!("{proof}");
    rows
}

fn episode_coordinates(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            json!({"id":row["id"],"space":row["space"],
        "source_id":row["source_id"],"occurrence_id":row["occurrence_id"],
        "content_hash":row["content_hash"],"source_ref":row["source_ref"],
        "trust":row["trust"],"kind":row["kind"]})
        })
        .collect()
}

fn assert_native_write_lock_refusals(responses: &[Value]) {
    assert!(
        responses.len() == 2
            && responses.iter().all(|response| {
                let frame = &response["frame"];
                response["http_status"] == 200
                    && frame["ok"] == true
                    && frame["result"]["status"] == "error"
                    && frame["result"]["error_code"] == "memory_busy"
                    && frame["result"]["retry_class"] == "same_id"
                    && frame["result"]["data"]["status"] == "prepared"
                    && frame["result"]["data"]["episode_id"].is_null()
                    && frame["result"]["next_actions"] == json!(["retry_original_memory_command"])
            }),
        "expected native episode-not-committed lock refusal; safe classifications: {}",
        response_classifications(responses)
    );
}

fn source_attempt_nonce(origin: &Value) -> String {
    let ledger = SourceLedgerConfig::from_env().unwrap();
    let db = Connection::open_with_flags(ledger.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let nonce:Option<String>=db.query_row("SELECT attempt_nonce FROM source_records WHERE owner=?1 AND source_id=?2 AND revision=?3",
        rusqlite::params![origin["owner"].as_str().unwrap(),origin["source_id"].as_str().unwrap(),origin["revision"].as_str().unwrap()],|row|row.get(0)).unwrap();
    let nonce = nonce.expect("new known-no-commit source must retain its actual attempt nonce");
    assert!(
        nonce.len() == 32
            && nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    nonce
}

fn assert_not_committed_proof(
    store: &Path,
    proof: &Value,
    space: &str,
    locator: &str,
    nonce: &str,
) {
    let db = Connection::open_with_flags(store.join("brain.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    let space_id: String = db
        .query_row("SELECT id FROM spaces WHERE name=?1", [space], |row| {
            row.get(0)
        })
        .unwrap();
    let arguments = json!({"content":TEXT,"space":space,"source_path":locator,"extract":false,"trust":"untrusted"});
    let content_digest = blake3::hash(TEXT.as_bytes()).to_hex().to_string();
    assert_eq!(proof["version"], "oxibrain.episode-write/1");
    assert_eq!(proof["tool"], "ingest");
    assert_eq!(proof["status"], "episode_not_committed");
    assert_eq!(proof["reason"], "writer_busy");
    assert_eq!(proof["attempt_nonce"], nonce);
    assert_eq!(proof["phase"], "source_registration");
    assert_eq!(proof["space"], space);
    assert_eq!(proof["space_id"], space_id);
    assert_eq!(
        proof["request_digest"],
        blake3::hash(&serde_json::to_vec(&arguments).unwrap())
            .to_hex()
            .as_str()
    );
    assert_eq!(proof["content_digest"], content_digest);
    assert_eq!(
        proof["source"],
        json!({"kind":"note","source_path":locator,"occurrence_id":content_digest})
    );
    assert!(proof["episode_id"].is_null());
}

fn forwarded_ingests(root: &Path, locator: &str) -> usize {
    events(root)
        .iter()
        .filter(|event| event["event"] == "ingest_forwarded" && event["source_locator"] == locator)
        .count()
}

async fn client(root: &Path, config: &Path, mode: &str) -> tokio::process::Child {
    let script = root.join("clients.mjs");
    tokio::process::Command::new("node")
        .arg(script)
        .arg(config)
        .arg(mode)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

fn response_classifications(responses: &[Value]) -> Value {
    let label = |value: &Value, allowed: &[&str]| match value.as_str() {
        Some(value) if allowed.contains(&value) => json!(value),
        Some(_) => json!("unclassified"),
        None => Value::Null,
    };
    json!(responses.iter().map(|response| {
        let frame=&response["frame"];
        let outer_error=match frame["error"].as_str() {
            Some("scoped memory authentication failed")=>json!("scoped_memory_authentication_failed"),
            Some(_)=>json!("unclassified"), None=>Value::Null,
        };
        let guard_reason=match frame["result"]["summary"].as_str() {
            Some("the Owner controller turn no longer permits new source effects")=>json!("owner_turn_no_longer_admits_source"),
            Some("memory origin is not an immutable Owner turn in this registered conversation")=>json!("owner_turn_pair_missing"),
            Some("memory request exceeds the authenticated Pi pair")=>json!("memory_pair_mismatch"),
            Some("unauthorized: Pi controller scope does not match envelope actor")=>json!("envelope_actor_mismatch"),
            Some("unauthorized: Pi conversation scope is not bound")=>json!("conversation_unbound"),
            Some("unauthorized: Pi conversation scope is not bound to this Ghost")=>json!("conversation_ghost_mismatch"),
            Some("Memory requires current permission, an explicit source ledger and an accepted local Pi route")=>json!("memory_configuration_or_permission_unavailable"),
            Some(_)=>json!("unclassified"),None=>Value::Null,
        };
        json!({"http_status":response["http_status"].as_u64(), "outer_ok":frame["ok"].as_bool(),
            "outer_error":outer_error,
            "guard_reason":guard_reason,
            "result_status":label(&frame["result"]["status"],&["success","error","partial","pending"]),
            "error_code":label(&frame["result"]["error_code"],&["unauthorized","disclosure_blocked","effect_unknown","memory_busy","invalid_request","execution_context_fenced","authority_fenced","dispatch_off","waiting_host","conflict"]),
            "retry_class":label(&frame["result"]["retry_class"],&["never","same_id","reconcile_first"]),
            "source_status":label(&frame["result"]["data"]["status"],&["prepared","recorded","already_recorded","effect_unknown"]),
        })
    }).collect::<Vec<_>>())
}

async fn finish_client(child: tokio::process::Child, root: &Path, stage: &str) -> Vec<Value> {
    let observed = tokio::time::timeout(Duration::from_secs(75), child.wait_with_output()).await;
    if observed.is_err() {
        private_json(
            &root.join(format!("{stage}-client.json")),
            &json!({"stage":stage,"state":"observation_elapsed"}),
        );
    }
    let output = observed
        .expect("bounded native client observation")
        .unwrap();
    private_json(
        &root.join(format!("{stage}-client.json")),
        &json!({"stage":stage,
        "exit_code":output.status.code(),"stdout_bytes":output.stdout.len(),"stderr_bytes":output.stderr.len()}),
    );
    assert!(
        output.status.success(),
        "authenticated test client failed; private client output withheld"
    );
    let responses: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    private_json(
        &root.join(format!("{stage}-responses.json")),
        &response_classifications(&responses),
    );
    responses
}

async fn wait_until(mut condition: impl FnMut() -> bool, description: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "{description}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit GHOST_OXIBRAIN_TEST_BINARY; isolated native store, two authenticated HTTP clients and real post-commit ACK loss; no model or PDC-index claim"]
async fn a17_native_two_ghost_clients_preserve_occurrences_across_lock_and_lost_ack() {
    let binary = PathBuf::from(
        std::env::var_os("GHOST_OXIBRAIN_TEST_BINARY")
            .expect("explicit source-built native executable"),
    );
    assert!(
        binary.is_absolute() && binary.is_file(),
        "native executable must be explicitly pinned by the caller"
    );
    let mut f = pi::setup_with_spec(json!({}));
    // Keep the original fixture, including failed evidence, before any native
    // process opens its store. Never relocate or reconstruct it after failure.
    f._root.disable_cleanup(true);
    fs::set_permissions(f._root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    eprintln!("A17 private evidence root: {}", f._root.path().display());
    let second = Host::profile(
        crate::store::ProfileStore::create_profile(
            f._root.path(),
            "a17-second",
            "Independent source owner",
        )
        .unwrap(),
    )
    .unwrap();
    let second_ghost = second.id.clone();
    let second_conversation = uuid::Uuid::now_v7().to_string();
    f.host
        .lock()
        .unwrap()
        .profiles
        .insert(second_ghost.clone(), second);
    let (_, mut environment, _, bindings) = scoped_fixture(f._root.path(), &f.ghost).await;
    environment.capture_extra(&[
        "OXIBRAIN_MODELS_DIR",
        "GHOST_A17_NATIVE_BINARY",
        "GHOST_A17_RELAY_STATE",
    ]);
    std::env::set_var("OXIBRAIN_MODELS_DIR", f._root.path().join("empty-models"));
    let store = f._root.path().join("native");
    for space in ["own-a", "own-b"] {
        native(&binary, &store, &["admin", "init", "--space", space]);
    }
    let first_token = token(&binary, &store, "own-a");
    let second_token = token(&binary, &store, "own-b");
    std::env::set_var("GHOST_BRAIN_TOKEN_OWN_FIXTURE", &first_token);
    std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", &second_token);
    let spaces = f._root.path().join("spaces.json");
    private_json(&spaces, &json!({&f.ghost:"own-a", &second_ghost:"own-b"}));
    private_json(
        &bindings,
        &json!({"version":1, "owners":{
        &f.ghost:[{"id":"own", "grant_ref":"first", "kind":"own", "spaces":["own-a"], "capabilities":["read","ingest"], "policy_revision":1}],
        &second_ghost:[{"id":"own", "grant_ref":"second", "kind":"own", "spaces":["own-b"], "capabilities":["read","ingest"], "policy_revision":1}]},
        "grants":{"first":"GHOST_BRAIN_TOKEN_OWN_FIXTURE", "second":"GHOST_BRAIN_TOKEN_SHARED_FIXTURE"}}),
    );
    let relay_state = f._root.path().join("relay");
    fs::create_dir(&relay_state).unwrap();
    let relay = relay_state.join("native-receipt-relay");
    fs::write(
        &relay,
        include_str!("../../tests/fixtures/a17/native-receipt-relay.py"),
    )
    .unwrap();
    fs::set_permissions(&relay, fs::Permissions::from_mode(0o700)).unwrap();
    std::env::set_var("GHOST_A17_NATIVE_BINARY", &binary);
    std::env::set_var("GHOST_A17_RELAY_STATE", &relay_state);
    std::env::set_var("GHOST_BRAIN_EXECUTABLE", &relay);
    std::env::set_var("GHOST_BRAIN_DIR", &store);
    f.host.brain = Brain::default();
    f.host.pi_callback_token = "b".repeat(64);
    f.host.pi_local_route = Some(crate::host::lifetime_runtime::LocalPiRoute {
        base_url: "http://127.0.0.1:9/v1".into(),
        model_id: "a17-no-inference".into(),
        max_output_tokens: 1024,
        callback_token: "c".repeat(64),
    });
    let pairs = [
        (&f.ghost, &f.conversation, "a17-turn-a"),
        (&second_ghost, &second_conversation, "a17-turn-b"),
    ];
    for (index, (ghost, conversation, turn)) in pairs.iter().enumerate() {
        if index == 1 {
            let response = f
                .host
                .lifetime_action(&pi::envelope(
                    "owner",
                    json!({"method":"registry.ensure", "ghost_id":ghost,
                "conversation_id":conversation, "kind":"specialist", "roles":[]}),
                ))
                .unwrap();
            assert_eq!(response["result"]["status"], "success");
        }
        f.host
            .lock()
            .unwrap()
            .journal
            .put(
                "policy",
                ghost,
                &Policy {
                    memory: true,
                    ..Default::default()
                },
            )
            .unwrap();
        let mut input = pi::envelope(
            "owner",
            json!({"method":"conversation.input", "ghost_id":ghost,
            "conversation_id":conversation, "text":TEXT, "privacy":"private", "attachments":[]}),
        );
        input.command_id = (*turn).into();
        assert_eq!(
            f.host.lifetime_action(&input).unwrap()["result"]["status"],
            "success"
        );
    }
    let originals = [
        request(&f.ghost, &f.conversation, "a17-turn-a", "a17-retain-a"),
        request(
            &second_ghost,
            &second_conversation,
            "a17-turn-b",
            "a17-retain-b",
        ),
    ];
    private_json(
        &f._root.path().join("original-requests.json"),
        &json!(originals),
    );
    let host = Arc::new(f.host);
    let server = Server::start_concurrent(Arc::clone(&host), "a".repeat(64));
    let config = f._root.path().join("clients.json");
    private_json(
        &config,
        &json!({"root":host.root, "callback":"c".repeat(64), "requests":originals,
        "foreign_turn":request(&second_ghost,&second_conversation,"a17-turn-a","a17-cross-ghost-turn"),
        "discovery":concat!(env!("CARGO_MANIFEST_DIR"), "/apps/ghost-durable/src/host-discovery.js")}),
    );
    fs::write(f._root.path().join("clients.mjs"), r#"import fs from 'node:fs/promises';
const c=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const {discover}=await import(c.discovery);
const {origin}=await discover(c.root);
async function call(request,credential=c.callback){
 const response=await fetch(origin+'/api/v1/pi/local-action',{method:'POST',signal:AbortSignal.timeout(60000),headers:{Authorization:'Bearer '+credential,'X-Ghost-CSRF':credential,Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify(request)});
 return {http_status:response.status,frame:await response.json()};
}
let results;const mode=process.argv[3];
if(mode==='negative'){
 const forged=structuredClone(c.requests[0]);forged.ghost_id=c.requests[1].ghost_id;forged.conversation_id=c.requests[1].conversation_id;
 results=[await call(c.requests[0],'wrong-local-callback'),await call(forged),await call(c.foreign_turn)];
}else if(mode==='both'){results=await Promise.all(c.requests.map(request=>call(request)));}
else{results=[await call(c.requests[Number(mode)])];}
console.log(JSON.stringify(results));
"#).unwrap();

    let negative = finish_client(
        client(f._root.path(), &config, "negative").await,
        f._root.path(),
        "negative",
    )
    .await;
    assert_eq!(negative[0]["http_status"], 403);
    assert_eq!(negative[1]["frame"]["result"]["error_code"], "unauthorized");
    assert_eq!(negative[2]["frame"]["result"]["error_code"], "unauthorized");
    assert!(!SourceLedgerConfig::from_env().unwrap().path.exists());
    assert!(
        events(&relay_state).is_empty(),
        "denied clients cannot open a native source session"
    );
    assert!(episodes(&store).is_empty());
    private_json(
        &f._root.path().join("turns-before-collision.json"),
        &turn_snapshots(&host, &originals),
    );

    fs::write(
        relay_state.join("collision-phase"),
        b"gate actual ingests after authentication",
    )
    .unwrap();
    let collision = client(f._root.path(), &config, "both").await;
    wait_until(
        || server.peak_active_callbacks() >= 2,
        "two authenticated callbacks must overlap inside Host routing",
    )
    .await;
    let mut gated_nonces = Vec::<String>::new();
    for _ in 0..2 {
        wait_until(
            || {
                events(&relay_state).iter().any(|event| {
                    event["event"] == "native_ingest_ready"
                        && event["attempt_nonce"]
                            .as_str()
                            .is_some_and(|nonce| !gated_nonces.iter().any(|seen| seen == nonce))
                })
            },
            "authenticated native ingest must reach its real pre-write boundary",
        )
        .await;
        let ready = events(&relay_state)
            .into_iter()
            .find(|event| {
                event["event"] == "native_ingest_ready"
                    && event["attempt_nonce"]
                        .as_str()
                        .is_some_and(|nonce| !gated_nonces.iter().any(|seen| seen == nonce))
            })
            .unwrap();
        let nonce = ready["attempt_nonce"].as_str().unwrap().to_owned();
        assert!(
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        // Brain handles are lock-free after startup. Hold exactly the native
        // advisory lock only across this already-authenticated tool write.
        let holder = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(store.join(".oxibrain.lock"))
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&holder).unwrap();
        private_json(
            &f._root
                .path()
                .join(format!("native-advisory-lock-{nonce}.json")),
            &json!({"path":store.join(".oxibrain.lock"),"holder_pid":std::process::id(),
                "protocol":"fs2-exclusive","attempt_nonce":nonce,"source_locator":ready["source_locator"],"acquired_after_auth":true}),
        );
        fs::write(
            relay_state.join(format!("forward-ingest-{nonce}")),
            b"actual native write may proceed under contention",
        )
        .unwrap();
        wait_until(
            || {
                events(&relay_state).iter().any(|event| {
                    event["event"] == "native_ingest_outcome_held"
                        && event["attempt_nonce"] == nonce
                })
            },
            "actual native write outcome must arrive within its bounded retry window",
        )
        .await;
        fs2::FileExt::unlock(&holder).unwrap();
        drop(holder);
        private_json(
            &f._root
                .path()
                .join(format!("native-advisory-unlock-{nonce}.json")),
            &json!({"attempt_nonce":nonce,"released_before_outcome_delivery":true}),
        );
        fs::write(
            relay_state.join(format!("return-outcome-{nonce}")),
            b"forward unchanged native outcome after lock release",
        )
        .unwrap();
        gated_nonces.push(nonce);
    }
    fs::remove_file(relay_state.join("collision-phase")).unwrap();
    let refusals = finish_client(collision, f._root.path(), "collision").await;
    private_json(
        &f._root.path().join("turns-after-collision.json"),
        &turn_snapshots(&host, &originals),
    );
    assert_native_write_lock_refusals(&refusals);
    let observed_gates = events(&relay_state);
    for nonce in &gated_nonces {
        assert_eq!(
            observed_gates
                .iter()
                .filter(|event| event["event"] == "native_ingest_ready"
                    && event["attempt_nonce"] == *nonce
                    && event["authenticated"] == true)
                .count(),
            1
        );
        assert_eq!(
            observed_gates
                .iter()
                .filter(|event| event["event"] == "native_ingest_outcome_held"
                    && event["attempt_nonce"] == *nonce
                    && event["known_busy"] == true
                    && event["tool_error"] == true)
                .count(),
            1
        );
    }
    assert_eq!(
        events(&relay_state)
            .iter()
            .filter(|row| row["event"] == "native_ingest_not_committed_locked")
            .count(),
        2
    );
    assert!(episodes(&store).is_empty());
    let prepared = [
        sources(&host, &f.ghost, &f.conversation),
        sources(&host, &second_ghost, &second_conversation),
    ];
    let mut prepared_nonces = Vec::new();
    for (index, rows) in prepared.iter().enumerate() {
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["receipt"]["status"], "prepared");
        let original = &originals[index];
        assert_eq!(
            rows[0]["origin"]["source_id"],
            format!(
                "canonical:{}:{}:{}:effect:{}",
                original["ghost_id"].as_str().unwrap(),
                original["conversation_id"].as_str().unwrap(),
                original["envelope"]["body"]["turn_id"].as_str().unwrap(),
                original["envelope"]["command_id"].as_str().unwrap()
            )
        );
        assert_eq!(rows[0]["origin"]["owner"], original["ghost_id"]);
        assert_eq!(
            rows[0]["origin"]["content_sha256"],
            crate::adapters::documents::digest(TEXT.as_bytes())
        );
        assert_eq!(
            refusals[index]["frame"]["result"]["data"]["source_id"],
            rows[0]["origin"]["source_id"]
        );
        let observed = events(&relay_state);
        let proofs: Vec<_> = observed
            .iter()
            .filter(|event| {
                event["event"] == "native_ingest_not_committed_locked"
                    && event["source_locator"] == rows[0]["receipt"]["source_locator"]
            })
            .collect();
        assert_eq!(proofs.len(), 1);
        let prepared_nonce = source_attempt_nonce(&rows[0]["origin"]);
        assert_eq!(proofs[0]["request_attempt_nonce"], prepared_nonce);
        assert_not_committed_proof(
            &store,
            &proofs[0]["proof"],
            if index == 0 { "own-a" } else { "own-b" },
            rows[0]["receipt"]["source_locator"].as_str().unwrap(),
            &prepared_nonce,
        );
        prepared_nonces.push(prepared_nonce);
    }
    fs::write(
        relay_state.join("drop-next-ingest-ack"),
        b"one genuine native receipt",
    )
    .unwrap();
    let lost = finish_client(
        client(f._root.path(), &config, "0").await,
        f._root.path(),
        "lost-ack",
    )
    .await;
    assert_eq!(lost[0]["frame"]["result"]["error_code"], "effect_unknown");
    let unknown = sources(&host, &f.ghost, &f.conversation);
    assert_eq!(unknown[0]["receipt"]["status"], "effect_unknown");
    assert_eq!(
        source_identity(&unknown[0]),
        source_identity(&prepared[0][0])
    );
    let committed = episodes(&store);
    assert_eq!(
        committed.len(),
        1,
        "native ingest committed before the Host lost its ACK"
    );
    let dropped = events(&relay_state)
        .into_iter()
        .find(|row| row["event"] == "native_committed_ack_dropped")
        .unwrap();
    assert_eq!(dropped["episode_id"], committed[0]["id"]);
    let committed_nonce = source_attempt_nonce(&unknown[0]["origin"]);
    assert_ne!(
        committed_nonce, prepared_nonces[0],
        "an explicit retry must acquire a fresh attempt nonce"
    );
    assert_eq!(dropped["attempt_nonce"], committed_nonce);
    let first_locator = unknown[0]["receipt"]["source_locator"].as_str().unwrap();
    let original_attempts = forwarded_ingests(&relay_state, first_locator);
    assert_eq!(
        original_attempts, 2,
        "one confirmed no-commit refusal, then one committed retry"
    );
    let inspected = tokio::time::timeout(
        Duration::from_secs(60),
        host.action_async(Action {
            request_id: uuid::Uuid::now_v7().to_string(),
            command: Command::Workspace {
                action: OwnerAction::MemorySourceInspect {
                    profile_id: f.ghost.clone(),
                    conversation_id: f.conversation.clone(),
                    origin: serde_json::from_value(unknown[0]["origin"].clone()).unwrap(),
                    content: TEXT.into(),
                },
            },
        }),
    )
    .await
    .expect("bounded original source inspection")
    .unwrap();
    assert_eq!(inspected["result"]["data"]["status"], "recorded");
    assert_eq!(
        inspected["result"]["data"]["episode_id"],
        committed[0]["id"]
    );
    let recovered_a = finish_client(
        client(f._root.path(), &config, "0").await,
        f._root.path(),
        "recovered-a",
    )
    .await;
    assert_eq!(
        recovered_a[0]["frame"]["result"]["data"]["status"],
        "already_recorded"
    );
    assert_eq!(
        forwarded_ingests(&relay_state, first_locator),
        original_attempts,
        "reconciling genuine post-commit ACK loss must not issue another ingest"
    );
    let recovered_b = finish_client(
        client(f._root.path(), &config, "1").await,
        f._root.path(),
        "recovered-b",
    )
    .await;
    assert_eq!(recovered_b[0]["frame"]["result"]["status"], "success");
    let before_replay = episodes(&store);
    assert_eq!(before_replay.len(), 2);
    let replay = finish_client(
        client(f._root.path(), &config, "both").await,
        f._root.path(),
        "replay",
    )
    .await;
    assert!(replay
        .iter()
        .all(|response| response["frame"]["result"]["data"]["status"] == "already_recorded"));
    assert_eq!(episodes(&store), before_replay);
    assert_ne!(before_replay[0]["id"], before_replay[1]["id"]);
    assert_ne!(before_replay[0]["space"], before_replay[1]["space"]);
    assert_ne!(before_replay[0]["source_id"], before_replay[1]["source_id"]);
    assert_eq!(
        before_replay[0]["occurrence_id"],
        before_replay[1]["occurrence_id"]
    );
    assert_eq!(
        before_replay[0]["content_hash"],
        before_replay[1]["content_hash"]
    );
    for row in &before_replay {
        assert_eq!(row["content"], TEXT);
        assert_eq!(row["source_kind"], "note");
        assert_eq!(row["trust"], "untrusted");
        assert_eq!(row["kind"], "primary");
    }
    for (index, (ghost, conversation, _)) in pairs.iter().enumerate() {
        let rows = sources(&host, ghost, conversation);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["receipt"]["status"], "recorded");
        assert_eq!(
            source_identity(&rows[0]),
            source_identity(&prepared[index][0])
        );
        let locator = rows[0]["receipt"]["source_locator"].as_str().unwrap();
        let final_nonce = source_attempt_nonce(&rows[0]["origin"]);
        assert_ne!(final_nonce, prepared_nonces[index]);
        let actual_events = events(&relay_state);
        let forwarded: Vec<_> = actual_events
            .iter()
            .filter(|event| {
                event["event"] == "ingest_forwarded" && event["source_locator"] == locator
            })
            .collect();
        assert_eq!(forwarded.len(), 2);
        assert_eq!(forwarded[0]["attempt_nonce"], prepared_nonces[index]);
        assert_eq!(forwarded[1]["attempt_nonce"], final_nonce);
        assert_eq!(
            events(&relay_state)
                .iter()
                .filter(|event| event["event"] == "ingest_forwarded"
                    && event["source_locator"] == locator)
                .count(),
            2,
            "exactly one known no-commit refusal and one committed ingest per original occurrence"
        );
        assert!(before_replay
            .iter()
            .any(|episode| episode["id"] == rows[0]["receipt"]["episode_id"]
                && episode["source_ref"] == locator));
    }
    assert_eq!(
        events(&relay_state)
            .iter()
            .filter(|row| row["event"] == "ingest_forwarded")
            .count(),
        4
    );
    assert!(server.errors().is_empty());
    let proof = json!({"kind":"ghost-a17-native-source-contention/1", "authenticated_clients":2,
        "peak_authenticated_callbacks":server.peak_active_callbacks(), "native_lock_refusals":2,
        "ingest_faults_after_auth":gated_nonces.len(),
        "native_ingests_forwarded":events(&relay_state).iter().filter(|row|row["event"]=="ingest_forwarded").count(),
        "dropped_native_episode_id":dropped["episode_id"], "episodes":episode_coordinates(&before_replay),
        "full_a17_accepted":false, "pdc_index_evaluated":false});
    drop(server);
    host.shutdown().await.unwrap();
    wait_until(|| events(&relay_state).iter().filter(|row| row["event"] == "native_started")
        .all(|row| ["native_pid","relay_pid","supervisor_pid"].iter().all(|field| unsafe {libc::kill(row[*field].as_u64().unwrap().try_into().unwrap(), 0)} == -1)),
        "every relay-owned native process must have exited").await;
    assert!(!events(&relay_state)
        .iter()
        .any(|row| row["event"] == "native_watchdog_expired"
            || row["event"] == "native_test_gate_expired"));
    let lifecycle = events(&relay_state);
    for started in lifecycle
        .iter()
        .filter(|row| row["event"] == "native_started")
    {
        assert_eq!(
            lifecycle
                .iter()
                .filter(|row| row["event"] == "native_reaped"
                    && row["native_pid"] == started["native_pid"])
                .count(),
            1,
            "every actual native child must have an owned wait/reap receipt"
        );
    }
    private_json(&f._root.path().join("a17-native-source-proof.json"), &proof);
    eprintln!("{proof}");
    eprintln!("A17 native source contention passed: two authenticated overlapping Ghost clients; native lock refusals; same occurrence recovery; real committed ACK loss; no PDC-index or full A17 acceptance claim");
}
