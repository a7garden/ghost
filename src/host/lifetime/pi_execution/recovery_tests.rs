//! Opt-in actual process cancellation/fencing. Every file and process belongs
//! to the newly created fixture; no installed service is changed.
use super::{tests::{envelope,request,setup_with_spec},PiInferenceScope};
use anyhow::{ensure,Result};
use rusqlite::OptionalExtension;
use serde_json::{json,Value};
use std::{path::Path,time::{Duration,Instant}};

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="physical Apple container cancellation/authority fence; existing service/image only"]
async fn real_pi_active_shell_cancellation_and_epoch_fence_stop_without_replay()->Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_PHYSICAL_CANARY").as_deref()==Ok("1"),"Explicit physical canary opt-in required");
    for fence in [false,true] {
        let mut fixture=setup_with_spec(json!({}));
        fixture.host.native_computers.as_mut().unwrap().set_pi_fixture_cli(Path::new("/opt/homebrew/bin/container"))?;
        let tool=request(&fixture,10,"single-physical-shell","bash",json!({"command":"printf started > started; sleep 8; printf late > late","timeout":15}));
        let operation=fixture.host.lifetime_pi_execution_action(&tool,PiInferenceScope::Public);
        let revoke=async {
            let deadline=Instant::now()+Duration::from_secs(12);
            let directory=loop {
                let execution:Option<String>={let state=fixture.host.lock()?;state.journal.0.query_row("SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1",[&fixture.work],|row|row.get(0)).optional()?};
                if let Some(execution)=execution {
                    let path=fixture.host.native_computers.as_ref().unwrap().pi_fixture_snapshot(&fixture.ghost,&execution,1)?;
                    if path.join("started").is_file() {break path;}
                }
                ensure!(Instant::now()<deadline,"Actual shell never published its start marker");
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            if fence {fixture.host.lock()?.journal.0.execute("UPDATE lifetime_authority SET authority_epoch=2",[])?;}
            else {
                let response=fixture.host.lifetime_action(&envelope("owner",json!({"method":"work.cancel","work_id":fixture.work})))?;
                ensure!(response["result"]["status"]=="success","Actual cancellation request was rejected: {response}");
            }
            Ok::<_,anyhow::Error>((directory,Instant::now()))
        };
        let (outcome,observed)=tokio::join!(operation,revoke);let (directory,revoked_at)=observed?;
        let outcome=outcome?;ensure!(outcome.error_code.as_deref()==Some("authority_fenced"),"Revoked output was delivered: {outcome:?}");
        // Observe past the original guest sleep independently of the reported stop.
        tokio::time::sleep_until(tokio::time::Instant::from_std(revoked_at+Duration::from_secs(9))).await;
        ensure!(!directory.join("late").exists(),"Revoked shell completed its later effect after its original deadline");
        {let state=fixture.host.lock()?;
            let raw:String=state.journal.0.query_row("SELECT response_json FROM lifetime_pi_effects WHERE call_id='single-physical-shell'",[],|row|row.get(0))?;
            let receipt:Value=serde_json::from_str(&raw)?;
            ensure!(receipt["data"]["process_state"]=="stopped","Physical shell stop was not confirmed: {receipt}");
            ensure!(receipt["data"]["receipt"]["state"]=="unknown","Process stop was incorrectly treated as proof of no earlier effect");
            ensure!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",[],|row|row.get::<_,i64>(0))?==0,"Pi cancellation queued a worker control");}
        let _=fixture.host.lifetime_pi_execution_action(&tool,PiInferenceScope::Public).await;
        ensure!(!directory.join("late").exists(),"Original call replayed after revocation");
        ensure!(fixture.host.lock()?.journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_effects",[],|row|row.get::<_,i64>(0))?==1,"Revoked effect was admitted twice");
    }
    Ok(())
}
