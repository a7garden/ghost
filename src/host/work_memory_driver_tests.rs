// Included in work_memory::tests, sharing exact artifact/acceptance fixtures.
include!("work_memory_verifier_driver_tests.rs");
fn a13_write_context_receipts(conn:&rusqlite::Connection,path:&std::path::Path)->Result<()> {
    // Read the original Host seals; this controlled receiver does not invent
    // or recompute a clean context identity, claim a generation, or run a model.
    let mut query=conn.prepare("SELECT id,json_extract(payload,'$.reference') FROM workspace_objects WHERE kind='ghost_work_context_v1'")?;
    let rows=query.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<std::collections::BTreeMap<_,_>>>()?;
    let pending=path.with_extension("pending");
    fs::write(&pending,serde_json::to_vec(&rows)?)?;fs::rename(pending,path)?;Ok(())
}
async fn a13_stop_driver(host: &Host, job: &mut tokio::task::JoinHandle<()>) -> bool {
    host.stopping
        .store(true, std::sync::atomic::Ordering::Release);
    match tokio::time::timeout(std::time::Duration::from_secs(3), &mut *job).await {
        Ok(result) => result.is_ok(),
        Err(_) => {
            job.abort();
            let _ = job.await;
            false
        }
    }
}
#[tokio::test]
async fn actual_lifetime_driver_dispatches_another_ghost_while_index_proof_hangs_and_reopens_same_source(
) {
    use std::{
        sync::{atomic::Ordering, Arc},
        time::Duration,
    };
    let (mut f, _environment, engine, space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), Some(&space.id));
    let stamp = inspect(&f).await;
    let artifact = publish(&f, &stamp).await;
    let record = memory_request(
        &f,
        "work.memory.record",
        json!({"summary":"One original source while another Ghost progresses","limitations":"index pending","artifact_digests":[artifact.digest]}),
    );
    let receipt = f
        .host
        .lifetime_work_memory_action(&record, PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(receipt.status, ResponseStatus::Success);
    assert_eq!(
        complete(&f, &stamp).await.data["verification"]["status"],
        "success"
    );
    // The old serial driver waits ten seconds here before seeing new outbox
    // entries. This fixture never performs inference or external service I/O.
    let script = engine.join("brain-fixture");
    let code = fs::read_to_string(&script).unwrap();
    assert!(code.contains("write_text('yes');time.sleep(2)"));
    fs::write(
        &script,
        code.replace(
            "write_text('yes');time.sleep(2)",
            "write_text('yes');time.sleep(10)",
        ),
    )
    .unwrap();
    fs::write(engine.join("hang-source-proof"), "hang").unwrap();
    let entry = f._root.path().join("a13-pi-fixture.mjs");
    let log = f._root.path().join("a13-pi-receipts.jsonl");
    let contexts=f._root.path().join("a13-host-context-seals.json");
    a13_write_context_receipts(&f.host.lock().unwrap().journal.0,&contexts).unwrap();
    let handshake = json!({"protocol_version":crate::lifetime_contract::VERSION,"contract_revision":crate::lifetime_contract::REVISION,"mode":"fixture","runtime_identity":{"durable":"@earendil-works/pi-durable@1.1.0"}});
    let source=r#"import fs from 'node:fs';
import readline from 'node:readline';
console.log(JSON.stringify(@HANDSHAKE@));
for await(const line of readline.createInterface({input:process.stdin})) {
 const e=JSON.parse(line);
 fs.appendFileSync(@LOG@,JSON.stringify({command_id:e.command_id,method:e.body.method,work_id:e.body.work_id})+'\n');
 let contextRef;
 if(e.body.method==='conversation.assignment') {
  const deadline=Date.now()+2500;
  do {contextRef=JSON.parse(fs.readFileSync(@CONTEXTS@,'utf8'))[e.command_id];if(contextRef) break;await new Promise(resolve=>setTimeout(resolve,5));}while(Date.now()<deadline);
  if(!/^wc-[a-f0-9]{64}$/.test(contextRef??'')) throw Error('Original Host assignment context seal missing');
 }
 console.log(JSON.stringify({status:'success',summary:'Fixture transport receipt; no model ran',object_refs:[],artifacts:[],next_actions:[],error_code:null,retry_class:'same_id',data:{command_id:e.command_id,ghost_id:e.body.ghost_id,conversation_id:e.body.conversation_id,runtime_kind:'pi-durable',runtime_release:'1.1.0',...(contextRef?{context_ref:contextRef,storage_ref:'fixture/a13/work-contexts/'+contextRef+'/durable.sqlite'}:{storage_ref:'fixture://a13/'+e.body.conversation_id})}}));
}
"#.replace("@HANDSHAKE@",&handshake.to_string()).replace("@LOG@",&serde_json::to_string(&log).unwrap()).replace("@CONTEXTS@",&serde_json::to_string(&contexts).unwrap());
    fs::write(&entry, source).unwrap();
    // Independent Ghost has no memory profile or read dependency.
    let other_profile = Host::profile(
        crate::store::ProfileStore::create_profile(
            f._root.path(),
            "a13-independent",
            "No memory prerequisite",
        )
        .unwrap(),
    )
    .unwrap();
    let other = other_profile.id.clone();
    let conversation = uuid::Uuid::new_v4().to_string();
    {
        let mut state = f.host.lock().unwrap();
        state.profiles.insert(other.clone(), other_profile);
    }
    assert_eq!(
        owner(
            &f,
            json!({"method":"registry.ensure","ghost_id":other,"conversation_id":conversation,"kind":"specialist","roles":[]}),
            None
        )["result"]["status"],
        "success"
    );
    let root = f._root;
    let host = Arc::new(f.host);
    let running = Arc::clone(&host);
    let launch = entry.clone();
    let mut job = tokio::spawn(async move {
        crate::host::lifetime_driver::run_fixture_driver(running, launch).await;
    });
    let observed:Result<(Experience,Vec<u8>,String,String,String)>=async {
        tokio::time::timeout(Duration::from_secs(3),async {while !engine.join("proof-started").exists() {tokio::time::sleep(Duration::from_millis(10)).await;}}).await?;
        // Causal ordering matters: the unrelated request did not exist when
        // the hung native index operation started.
        let command=pi::envelope("owner",json!({"method":"goal.submit","ghost_id":other,"conversation_id":conversation,"prompt":"Independent work must receive its original Pi delivery","privacy":"public","acceptance_spec":pi::verifier_spec("expected")}));
        let admitted=host.lifetime_action(&command)?;ensure!(admitted["result"]["status"]=="success","independent Goal admission failed");
        let work=admitted["result"]["data"]["work"]["id"].as_str().unwrap().to_owned();
        let (outbox,assignment):(i64,String)=host.lock()?.journal.0.query_row("SELECT id,delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&work],|r|Ok((r.get(0)?,r.get(1)?)))?;
        a13_write_context_receipts(&host.lock()?.journal.0,&contexts)?;
        tokio::time::timeout(Duration::from_secs(3),async {loop {let ack:bool=host.lock().unwrap().journal.0.query_row("SELECT acknowledged FROM lifetime_outbox WHERE id=?1",[outbox],|r|r.get(0)).unwrap();if ack {break;}tokio::time::sleep(Duration::from_millis(10)).await;}}).await?;
        let state=host.lock()?;let raw:String=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind=?1",[EXPERIENCES],|r|r.get(0))?;let pending:Experience=serde_json::from_str(&raw)?;
        ensure!(pending.state=="written_index_pending","dependent indexing was falsely completed");
        ensure!(pending.last_reason.as_deref()==Some("registered_document_index_not_confirmed"),"pending reason was lost");
        let bytes=fs::read(space.path.join(format!("{}.md",pending.page_id)))?;
        ensure!(pending.hash.as_deref()==Some(documents::digest(&bytes).as_str()),"original source digest changed");
        let original_receipt:String=state.journal.0.query_row("SELECT payload FROM lifetime_delivery_receipts WHERE outbox_id=?1",[outbox],|row|row.get(0))?;
        Ok((pending,bytes,assignment,work,original_receipt))
    }.await;
    let joined = a13_stop_driver(&host, &mut job).await;
    let (pending, bytes, assignment, other_work, original_receipt) = observed.expect(
        "real driver must deliver independent Work before the ten-second index wait finishes",
    );
    assert!(
        joined,
        "driver shutdown must abort and join its original continuation"
    );
    let frames = || {
        fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        frames()
            .iter()
            .filter(|frame| frame["command_id"] == assignment)
            .count(),
        1
    );
    // Stop/join then reopen the Host journal; retries retain the original
    // candidate, exact source bytes, page UUID and receiver receipt.
    {
        let mut state = host.lock().unwrap();
        state.journal =
            crate::host::scheduler::Journal::open(&root.path().join("workspace.db")).unwrap();
        let mut due = pending.clone();
        due.next_attempt_ms = 0;
        save_experience(&state.journal.0, &due).unwrap();
    }
    fs::remove_file(engine.join("hang-source-proof")).unwrap();
    host.stopping.store(false, Ordering::Release);
    let running = Arc::clone(&host);
    let mut job = tokio::spawn(async move {
        crate::host::lifetime_driver::run_fixture_driver(running, entry).await;
    });
    let recovered = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let row: Experience = {
                let state = host.lock().unwrap();
                let raw: String = state
                    .journal
                    .0
                    .query_row(
                        "SELECT payload FROM workspace_objects WHERE kind=?1",
                        [EXPERIENCES],
                        |r| r.get(0),
                    )
                    .unwrap();
                serde_json::from_str(&raw).unwrap()
            };
            if row.state == "indexed" {
                break row;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(
        a13_stop_driver(&host, &mut job).await,
        "resumed driver must join all owned tasks"
    );
    let recovered = recovered.expect("same durable experience must finish after index recovery");
    assert_eq!(recovered.id, pending.id);
    assert_eq!(recovered.page_id, pending.page_id);
    assert_eq!(recovered.hash, pending.hash);
    assert_eq!(recovered.body, pending.body);
    assert_eq!(
        fs::read(space.path.join(format!("{}.md", pending.page_id))).unwrap(),
        bytes
    );
    assert_eq!(documents::list(&space, "").unwrap().len(), 1);
    assert_eq!(
        frames()
            .iter()
            .filter(|frame| frame["command_id"] == assignment)
            .count(),
        1,
        "restart must not redeliver the already acknowledged Work"
    );
    let state = host.lock().unwrap();
    let retained: String = state
        .journal
        .0
        .query_row(
            "SELECT payload FROM lifetime_delivery_receipts WHERE receiver_command_id=?1",
            [assignment],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        retained, original_receipt,
        "reopen keeps the exact original Pi receiver receipt"
    );
    let count: i64 = state
        .journal
        .0
        .query_row(
            "SELECT count(*) FROM workspace_objects WHERE kind=?1",
            [EXPERIENCES],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let no_memory:bool=state.journal.0.query_row("SELECT NOT EXISTS(SELECT 1 FROM workspace_objects WHERE kind='work_memory_grant_v1' AND json_extract(payload,'$.work_id')=?1)",[other_work],|r|r.get(0)).unwrap();
    assert!(no_memory);
    drop(state);
    // Restore an index-unconfirmed checkpoint, then exercise actual
    // Host.shutdown, which aborts its tracked driver rather than reaching
    // run()'s normal tail. A detached continuation would keep this child and
    // the Host alive for the rest of its ten-second I/O wait.
    let code = fs::read_to_string(&script).unwrap();
    fs::write(
        &script,
        code.replace(
            "write_text('yes');time.sleep(10)",
            "write_text(str(__import__('os').getpid()));time.sleep(10)",
        ),
    )
    .unwrap();
    fs::remove_file(engine.join("proof-started")).unwrap();
    fs::write(engine.join("hang-source-proof"), "hang").unwrap();
    {
        let state = host.lock().unwrap();
        let mut pending = recovered.clone();
        pending.state = "written_index_pending".into();
        pending.next_attempt_ms = 0;
        save_experience(&state.journal.0, &pending).unwrap();
    }
    host.stopping.store(false, Ordering::Release);
    let running = Arc::clone(&host);
    let launch = root.path().join("a13-pi-fixture.mjs");
    host.spawn(async move {
        crate::host::lifetime_driver::run_fixture_driver(running, launch).await;
    });
    let entered = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(child) = fs::read_to_string(engine.join("proof-started"))
                .ok()
                .and_then(|text| text.parse::<i32>().ok())
            {
                break child;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    // Issue both normal driver stop and Host task cancellation concurrently.
    // Exact delayed-drop interleaving is separately covered by the tracked
    // continuation helper test; this exercises the actual I/O/driver boundary.
    let (_, shutdown) = tokio::join!(
        async {
            host.stopping.store(true, Ordering::Release);
            tokio::task::yield_now().await;
        },
        async {
            tokio::task::yield_now().await;
            tokio::time::timeout(Duration::from_secs(3), host.shutdown()).await
        }
    );
    shutdown
        .expect("Hostshutdown cannot wait for the ten-second optional index operation")
        .unwrap();
    let child = entered.expect("actual Host-owned continuation entered native wait");
    assert!(host.workers.lock().unwrap().is_empty());
    assert_eq!(
        Arc::strong_count(&host),
        1,
        "shutdown must join every continuation that retains the Host"
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while unsafe { libc::kill(child, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("canceled index client must not leave its child alive");
    assert_eq!(documents::list(&space, "").unwrap().len(), 1);
    assert_eq!(
        fs::read(space.path.join(format!("{}.md", pending.page_id))).unwrap(),
        bytes
    );
}
