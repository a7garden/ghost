// Actual driver regression: a fresh native source guard for an existing
// failed verifier receipt must not serialize unrelated Pi transport.
async fn verification_notice_driver_case(revoke: bool) {
    use std::{
        sync::{atomic::Ordering, Arc},
        time::Duration,
    };
    let (mut f, _environment, engine, space) = fixture().await;
    bind(&mut f, true, json!(["shared"]), Some(&space.id));
    let stamp = inspect(&f).await;
    publish(&f, &stamp).await;
    // Metadata-only failed-verifier fixture: retain the real producing Work,
    // execution and source lineage; no guest verifier, model or acceptance.
    {
        let state = f.host.lock().unwrap();
        let mut work = work(&state.journal.0, &f.work).unwrap();
        work.state = "completed".into();
        state
            .journal
            .0
            .execute(
                "UPDATE lifetime_work SET state=?1,payload=?2 WHERE id=?3",
                params![work.state, serde_json::to_string(&work).unwrap(), work.id],
            )
            .unwrap();
    }
    crate::host::lifetime::task_verification::fixture_terminal_receipt(
        &f.host, &f.work, "complete",
    )
    .unwrap();
    let before: String = f
        .host
        .lock()
        .unwrap()
        .journal
        .0
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='owner_task_verification_v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let script = engine.join("brain-fixture");
    let code = fs::read_to_string(&script).unwrap();
    assert!(code.contains(" if method=='auth':\n"));
    let replacement=" if method=='auth':\n  if (root/'hang-verifier-guard').exists():\n   (root/'verifier-guard-pid').write_text(str(__import__('os').getpid()));(root/'verifier-guard-started').write_text('yes');deadline=time.time()+10\n   while (root/'hang-verifier-guard').exists() and time.time()<deadline:time.sleep(.01)\n   (root/'verifier-guard-returned').write_text('returned')\n";
    fs::write(&script, code.replace(" if method=='auth':\n", replacement)).unwrap();
    fs::write(engine.join("hang-verifier-guard"), "hold").unwrap();
    let contexts = f._root.path().join("verifier-driver-context-seals.json");
    a13_write_context_receipts(&f.host.lock().unwrap().journal.0, &contexts).unwrap();
    let log = f._root.path().join("verifier-driver-pi.jsonl");
    let entry = f._root.path().join("verifier-driver-pi.mjs");
    let handshake = json!({"protocol_version":crate::lifetime_contract::VERSION,"contract_revision":crate::lifetime_contract::REVISION,"mode":"fixture","runtime_identity":{"durable":"@earendil-works/pi-durable@1.1.0"}});
    let source=r#"import fs from 'node:fs';import readline from 'node:readline';
console.log(JSON.stringify(@HANDSHAKE@));
for await(const line of readline.createInterface({input:process.stdin})) {
 const e=JSON.parse(line);let reference;
 if(e.body.method==='conversation.assignment') {
  const deadline=Date.now()+2500;
  do {reference=JSON.parse(fs.readFileSync(@CONTEXTS@,'utf8'))[e.command_id];if(reference) break;await new Promise(r=>setTimeout(r,5));}while(Date.now()<deadline);
  if(!/^wc-[a-f0-9]{64}$/.test(reference??''))throw Error('Host seal missing');
 }
 fs.appendFileSync(@LOG@,JSON.stringify({command_id:e.command_id,method:e.body.method})+'\n');
 console.log(JSON.stringify({status:'success',summary:'Controlled transport only',object_refs:[],artifacts:[],next_actions:[],error_code:null,retry_class:'same_id',data:{command_id:e.command_id,ghost_id:e.body.ghost_id,conversation_id:e.body.conversation_id,runtime_kind:'pi-durable',runtime_release:'1.1.0',...(reference?{context_ref:reference,storage_ref:'fixture/verifier/work-contexts/'+reference+'/durable.sqlite'}:{storage_ref:'fixture/verifier/owner/durable.sqlite'})}}));
}
"#.replace("@HANDSHAKE@",&handshake.to_string()).replace("@CONTEXTS@",&serde_json::to_string(&contexts).unwrap()).replace("@LOG@",&serde_json::to_string(&log).unwrap());
    fs::write(&entry, source).unwrap();
    let other_profile = Host::profile(
        crate::store::ProfileStore::create_profile(
            f._root.path(),
            "verifier-independent",
            "Independent transport",
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
    let _root = f._root;
    let host = Arc::new(f.host);
    let running = Arc::clone(&host);
    let mut driver = tokio::spawn(async move {
        crate::host::lifetime_driver::run_fixture_driver(running, entry).await;
    });
    let observed:Result<(String,u32)>=async {
        tokio::time::timeout(Duration::from_secs(3),async {while !engine.join("verifier-guard-started").exists(){tokio::time::sleep(Duration::from_millis(10)).await;}}).await?;
        let pid:u32=fs::read_to_string(engine.join("verifier-guard-pid"))?.parse()?;ensure!(unsafe{libc::kill(pid as i32,0)}==0,"original guard process already exited");
        let admitted=host.lifetime_action(&pi::envelope("owner",json!({"method":"goal.submit","ghost_id":other,"conversation_id":conversation,"prompt":"Unrelated Ghost progresses while verifier source guard hangs","privacy":"public","acceptance_spec":{}})))?;ensure!(admitted["result"]["status"]=="success","independent admission failed");let id=admitted["result"]["data"]["work"]["id"].as_str().unwrap();
        let (outbox,assignment):(i64,String)={let state=host.lock()?;let pair=state.journal.0.query_row("SELECT id,delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.work_id')=?1",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;a13_write_context_receipts(&state.journal.0,&contexts)?;pair};
        tokio::time::timeout(Duration::from_secs(3),async {loop {let acknowledged:bool=host.lock().unwrap().journal.0.query_row("SELECT acknowledged FROM lifetime_outbox WHERE id=?1",[outbox],|r|r.get(0)).unwrap();if acknowledged{break;}tokio::time::sleep(Duration::from_millis(10)).await;}}).await?;
        ensure!(!engine.join("verifier-guard-returned").exists(),"source guard finished before unrelated ACK");
        ensure!(host.lock()?.journal.0.query_row("SELECT COUNT(*) FROM workspace_objects WHERE kind='owner_task_verification_notice_v1'",[],|r|r.get::<_,i64>(0))?==0,"notice was enqueued without fresh guard completion");
        if revoke {
            let mut grants:Value=serde_json::from_slice(&fs::read(engine.join("grants.json"))?)?;
            grants.as_object_mut().unwrap().remove("shared-fixture-token");fs::write(engine.join("grants.json"),serde_json::to_vec(&grants)?)?;
            fs::remove_file(engine.join("hang-verifier-guard"))?;
            tokio::time::timeout(Duration::from_secs(3),async {while !engine.join("verifier-guard-returned").exists() || unsafe{libc::kill(pid as i32,0)}==0 {tokio::time::sleep(Duration::from_millis(10)).await;}}).await?;
            ensure!(host.lock()?.journal.0.query_row("SELECT COUNT(*) FROM workspace_objects WHERE kind='owner_task_verification_notice_v1'",[],|r|r.get::<_,i64>(0))?==0,"revoked source guard authorized a notice");
        }
        Ok((assignment,pid))
    }.await;
    let joined = a13_stop_driver(&host, &mut driver).await;
    let (assignment,pid)=observed.expect("actual driver must ACK unrelated Work within three seconds of a hung verifier notice guard");
    assert!(
        joined,
        "shutdown must cancel/join the original guard continuation"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while unsafe { libc::kill(pid as i32, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("original native guard process must be stopped, not detached");
    assert_eq!(engine.join("verifier-guard-returned").exists(), revoke);
    assert!(host.stopping.load(Ordering::Acquire));
    assert!(
        host.workers.lock().unwrap().is_empty(),
        "all tracked continuation handles must be joined"
    );
    let state = host.lock().unwrap();
    let retained: String = state
        .journal
        .0
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='owner_task_verification_v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        retained, before,
        "shutdown cannot overwrite or rerun the original terminal receipt"
    );
    assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM workspace_objects WHERE kind='owner_task_verification_notice_v1'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE command_id LIKE 'host-verification-notice:%'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        state
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_acceptances", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let frames = fs::read_to_string(log).unwrap();
    assert_eq!(
        frames
            .lines()
            .map(|s| serde_json::from_str::<Value>(s).unwrap())
            .filter(|r| r["command_id"] == assignment)
            .count(),
        1,
        "one original unrelated delivery, no duplicate"
    );
}

#[tokio::test]
async fn actual_driver_hung_verification_notice_guard_keeps_other_ghost_live_and_cancels_on_shutdown(
) {
    verification_notice_driver_case(false).await;
}

#[tokio::test]
async fn actual_driver_revoked_verification_notice_guard_never_enqueues_after_other_ghost_progresses(
) {
    verification_notice_driver_case(true).await;
}
