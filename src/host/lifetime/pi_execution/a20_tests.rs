//! Bounded paired workload acceptance. Uses the production Pi runtime and Host
//! tool/graph/verifier paths with disposable state and a pinned local model.
use super::{db, tests::{envelope, setup_with_spec, verifier_spec}, PiInferenceScope, PiToolRequest};
use crate::{host::{self, Host}, lifetime_contract::{canonical_digest, Response, ResponseStatus}, store::ProfileStore};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, io::Write, path::{Path, PathBuf}, time::{Duration, Instant}};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
#[path="a20_workload.rs"]
mod workload;

struct Bridge {
    process: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: Lines<BufReader<tokio::process::ChildStdout>>,
    commands: u64,
    parked_commands: u64,
    callbacks: u64,
    denials: u64,
    duplicate_effect_responses: u64,
    effects: BTreeSet<String>,
    methods: BTreeMap<String, u64>,
    metrics: Value,
    root_ghost: String,
    collab: bool,
    raw_source_disclosures: u64,
}
impl Bridge {
    async fn frame(&mut self, host: &Host) -> Result<Value> {
        loop {
            let line=tokio::time::timeout(Duration::from_secs(130),self.output.next_line()).await??.ok_or_else(||anyhow::anyhow!("A20 bridge exited"))?;
            ensure!(line.len()<=1_048_576,"A20 bridge frame bound");
            let frame:Value=serde_json::from_str(&line)?;
            if frame["type"]!="callback" {if frame["metrics"].is_object(){self.metrics=frame["metrics"].clone();}ensure!(frame["type"]!="failure","A20 runtime trial failed");return Ok(frame);}
            self.callbacks+=1;ensure!(self.callbacks<=400,"A20 callback budget");
            let request:PiToolRequest=serde_json::from_value(frame["request"].clone())?;
            let method=request.envelope.body["method"].as_str().unwrap_or("unknown").to_owned();
            *self.methods.entry(method.clone()).or_default()+=1;
            let response=host.lifetime_pi_action(&request,host::lifetime::test_callback_inference_scope(&frame)).await?;
            if self.collab && request.ghost_id==self.root_ghost {
                let encoded=serde_json::to_string(&response)?;
                if encoded.contains("Correction: the 32-hour claim") || encoded.contains("Vendor has not supplied a comparable battery measurement") {self.raw_source_disclosures+=1;}
            }
            if response["ok"]!=true || response["result"]["status"]=="error" {self.denials+=1;}
            if method=="work.execute" && response["result"]["status"]=="success" {
                let key=canonical_digest(&json!([request.ghost_id,request.envelope.body["work_id"],request.envelope.body["task_id"],request.envelope.body["call_id"]]))?;
                if !self.effects.insert(key) {self.duplicate_effect_responses+=1;}
            }
            self.input.write_all(format!("{}\n",json!({"type":"callback_result","id":frame["id"],"frame":response})).as_bytes()).await?;
            self.input.flush().await?;
        }
    }
    async fn start(host:&Host,root_ghost:&str,collab:bool)->Result<Self>{
        let mut process=tokio::process::Command::new("/opt/homebrew/bin/node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/ghost-durable/scripts/a20-live-canary.mjs"))
            .env_clear().env("PATH","/opt/homebrew/bin:/usr/bin:/bin").env("HOME",&host.root)
            .current_dir(env!("CARGO_MANIFEST_DIR")).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn()?;
        let input=process.stdin.take().unwrap();let output=BufReader::new(process.stdout.take().unwrap()).lines();
        let mut b=Self{process,input,output,commands:0,parked_commands:0,callbacks:0,denials:0,duplicate_effect_responses:0,effects:BTreeSet::new(),methods:BTreeMap::new(),metrics:Value::Null,root_ghost:root_ghost.into(),collab,raw_source_disclosures:0};
        b.input.write_all(format!("{}\n",json!({"type":"config","root":host.root.join("pi-a20-store"),"host_root":host.root,"authority_epoch":1,"allow_work_parks":collab})).as_bytes()).await?;b.input.flush().await?;
        ensure!(b.frame(host).await?["type"]=="configured","A20 bridge configure");Ok(b)
    }
    async fn deliver_next(&mut self,host:&Host)->Result<bool>{
        let next={let state=host.lock()?;let items=host::lifetime::pending_outbox(&state.journal.0)?;
            let eligible=|item:&&host::lifetime::OutboxItem|{
                if item.target!="pi" {return false;}
                if item.payload["body"]["method"]=="conversation.assignment" {
                    return item.payload["body"]["work_id"].as_str().and_then(|id|db::work(&state.journal.0,id).ok().flatten()).is_some_and(|w|matches!(w.state.as_str(),"queued"|"active"));
                }
                true
            };
            items.iter().filter(eligible).find(|item|item.payload["body"]["method"]=="conversation.open").cloned().or_else(||items.iter().rev().find(eligible).cloned())};
        let Some(next)=next else{return Ok(false)};
        self.commands+=1;ensure!(self.commands<=24,"A20 delivery budget");
        self.input.write_all(format!("{}\n",json!({"type":"command","id":self.commands,"command":next.payload})).as_bytes()).await?;self.input.flush().await?;
        let reply=self.frame(host).await?;
        ensure!(reply["type"]=="command_result" && reply["receipt"]["status"]=="success","A20 delivery refused");
        if reply["parked"].is_object() { self.parked_commands+=1; }
        host::lifetime::ack_outbox(&host.lock()?.journal.0,next.id,&reply["receipt"])?;Ok(true)
    }
    async fn stop(&mut self,host:&Host)->Result<()>{
        self.input.write_all(b"{\"type\":\"stop\"}\n").await?;self.input.flush().await?;
        ensure!(self.frame(host).await?["type"]=="stopped","A20 stop receipt");
        ensure!(tokio::time::timeout(Duration::from_secs(10),self.process.wait()).await??.success(),"A20 process exit");Ok(())
    }
}

fn expected_spec(value:&Value)->Value {let mut spec=verifier_spec(&workload::canonical(value));spec["verifier"]["artifact_path"]=json!("answer.json");spec}
fn published_bytes(host:&Host,work_id:&str)->Result<Option<Vec<u8>>>{
    let state=host.lock()?;let work=db::work(&state.journal.0,work_id)?.unwrap();let Some(execution)=work.execution_id else{return Ok(None)};
    let mut query=state.journal.0.prepare("SELECT arguments_json,response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='publish_artifact' AND state='complete' ORDER BY rowid DESC")?;
    for row in query.query_map([&execution],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
        let (arguments,response)=row?;let arguments:Value=serde_json::from_str(&arguments)?;if arguments["path"]!="answer.json"{continue;}
        let response:Response=serde_json::from_str(&response)?;
        if let Some(artifact)=response.artifacts.first(){return Ok(Some(crate::worker::journal::read_verified_artifact(&host.root.join("pi-execution"),&execution,&artifact.digest,Path::new(&artifact.locator))?));}
    }Ok(None)
}
async fn trial(case:&Value,collab:bool,repetition:usize,report:&Path)->Result<Value>{
    let implementation_before=implementation_fingerprint()?;
    let mut f=setup_with_spec(json!({}));let root=std::mem::replace(&mut f._root,tempfile::tempdir()?).keep();
    crate::host::inference::install_external_test_inference(&f.host)?;
    f.host.native_computers.as_mut().unwrap().set_pi_fixture_cli(Path::new("/opt/homebrew/bin/container"))?;
    let child_profile=Host::profile(ProfileStore::create_profile(&root,"a20-researcher","A20 evidence researcher")?)?;
    let child=child_profile.id.clone();let child_conversation=uuid::Uuid::new_v4().to_string();
    {
        let mut state=f.host.lock()?;state.profiles.insert(child.clone(),child_profile);
        let registered=host::lifetime::apply(&state.journal.0,&envelope("owner",json!({"method":"registry.ensure","ghost_id":child,"conversation_id":child_conversation,"kind":"specialist","roles":["a20_researcher"]})),"owner")?;
        ensure!(registered.status==ResponseStatus::Success,"A20 researcher registration");
        f.host.native_computers.as_ref().unwrap().provision_pi_ghost(&state.journal.0,&f.ghost,&child,1,"pi-default/1")?;
        host::skills::save(&state,&root,"a20-source-import",&child,"a20-source-evidence",&workload::source_skill(),None)?;
        ensure!(super::skill_refs(&state.journal.0,&db::work(&state.journal.0,&f.work)?.unwrap())?.is_empty(),"Root inherited researcher source skill");
    }
    let mut spec=expected_spec(&workload::answer(case));
    if collab {spec["delegation_contracts"]=json!([{"target_ghost_id":child,"prompt":workload::evidence_prompt(),"acceptance_spec":expected_spec(&workload::evidence()),"artifact_refs":[]}]);}
    let goal_id=db::work(&f.host.lock()?.journal.0,&f.work)?.unwrap().goal_id;
    let mut revised=envelope("owner",json!({"method":"goal.update","goal_id":goal_id,"prompt":workload::root_prompt(case,collab),"acceptance_spec":spec}));revised.expected_revision=Some(1);
    let started=Instant::now();
    let response=f.host.lifetime_action(&revised)?;ensure!(response["result"]["status"]=="success","A20 initial admission");
    let name=format!("{}-{}-{repetition}",case["id"].as_str().unwrap(),if collab{"collaborative"}else{"single"});
    let attempt=report.join(format!("{name}.json"));ensure!(!attempt.exists(),"A20 trial identity already recorded");
    std::fs::write(&attempt,serde_json::to_vec_pretty(&json!({"trial_id":name,"status":"running","host_root":root,"root_work":f.work,"corpus_sha256":workload::source_digest(),"implementation_before":implementation_before}))?)?;
    let mut bridge=Bridge::start(&f.host,&f.ghost,collab).await?;
    let run=async {
        for _ in 0..24 {
            if !bridge.deliver_next(&f.host).await? {break;}
            let state=f.host.lock()?;
            let accepted=db::work(&state.journal.0,&f.work)?.is_some_and(|w|w.state=="accepted");
            let reported:bool=state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_report_replies r JOIN lifetime_outbox o ON o.id=r.outbox_id WHERE json_extract(o.payload,'$.body.goal_id')=?1)",[&goal_id],|r|r.get(0))?;
            if accepted && reported {break;}
        }
        let state=f.host.lock()?;ensure!(db::work(&state.journal.0,&f.work)?.unwrap().state=="accepted","A20 root not independently accepted");Ok::<(),anyhow::Error>(())
    }.await;
    let stop=bridge.stop(&f.host).await;
    let bytes=published_bytes(&f.host,&f.work)?;let quality=workload::quality(bytes.as_deref(),&workload::answer(case));
    let (root_state,children,accepted_children,reads_child,worker_outbox,report_replies)={
        let state=f.host.lock()?;let root_work=db::work(&state.journal.0,&f.work)?.unwrap();
        let children:Vec<String>=state.journal.0.prepare("SELECT child_work_id FROM lifetime_work_links WHERE parent_work_id=?1 AND current=1")?.query_map([&f.work],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;
        let accepted=children.iter().filter(|id|db::work(&state.journal.0,id).ok().flatten().is_some_and(|w|w.state=="accepted")).count();
        let offered=super::artifact_inputs(&state.journal.0,&root_work)?;
        let mut reads=0;
        for artifact in offered {reads+=state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='read' AND state='complete' AND json_extract(arguments_json,'$.path')=?2 AND json_extract(response_json,'$.data.output.sha256')=?3",rusqlite::params![root_work.execution_id,artifact["path"].as_str(),artifact["artifact"]["digest"].as_str()],|r|r.get::<_,u64>(0))?;}
        let worker=state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",[],|r|r.get::<_,u64>(0))?;
        let replies=state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_report_replies r JOIN lifetime_outbox o ON o.id=r.outbox_id WHERE json_extract(o.payload,'$.body.goal_id')=?1",[&goal_id],|r|r.get::<_,u64>(0))?;
        (root_work.state,children,accepted,reads,worker,replies)
    };
    let coordination=if collab {children.len()==1 && accepted_children==1 && reads_child>0 && bridge.methods.contains_key("work.delegate") && bridge.methods.contains_key("work.wait") && bridge.raw_source_disclosures==0} else {children.is_empty()};
    let implementation_after=implementation_fingerprint()?;
    let source_stable=implementation_before==implementation_after;
    let status=if !source_stable {"source_contaminated"} else if run.is_ok() && stop.is_ok() && root_state=="accepted" && quality["passed"]==true && quality["canonical_bytes"]==true && coordination && worker_outbox==0 && report_replies>0 {"passed"} else {"failed"};
    let record=json!({"trial_id":name,"case_id":case["id"],"lane":if collab{"collaborative"}else{"single"},"repetition":repetition,"status":status,"source_stable":source_stable,"implementation_before":implementation_before,"implementation_after":implementation_after,"failure_code":if !source_stable{Some("implementation_changed")}else if run.is_err(){Some("execution_or_acceptance_failed")}else if stop.is_err(){Some("runtime_stop_unconfirmed")}else{None},"elapsed_ms":started.elapsed().as_millis(),"quality":quality,"root_state":root_state,"root_work":f.work,"child_work_ids":children,"accepted_children":accepted_children,"root_read_child_artifacts":reads_child,"raw_source_disclosures_to_root":bridge.raw_source_disclosures,"worker_outbox":worker_outbox,"report_replies":report_replies,"owner_mediations":0,"owner_mediation_definition":"only initial Owner admission; no copied child results or trial repair input","callbacks":bridge.callbacks,"verified_parked_commands":bridge.parked_commands,"tool_denials":bridge.denials,"duplicate_effect_responses":bridge.duplicate_effect_responses,"methods":bridge.methods,"inference":bridge.metrics,"host_root":root,"corpus_sha256":workload::source_digest()});
    let temporary=attempt.with_extension("tmp");std::fs::write(&temporary,serde_json::to_vec_pretty(&record)?)?;std::fs::rename(temporary,attempt)?;Ok(record)
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="opt-in frozen representative product workload:3 paired single/collaborative registered external-inference trials"]
async fn a20_paired_representative_product_workload()->Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_A20").as_deref()==Ok("1"),"Explicit A20 physical external-inference opt-in required");workload::validate()?;
    let repetitions=std::env::var("GHOST_PI_A20_REPETITIONS").ok().map(|v|v.parse::<usize>()).transpose()?.unwrap_or(1);ensure!((1..=5).contains(&repetitions),"A20 repetitions outside1..5");
    let report:PathBuf=tempfile::Builder::new().prefix("ghost-a20-").tempdir()?.keep();
    let implementation_before=implementation_fingerprint()?;
    let manifest=json!({"version":"ghost-a20-acceptance/2","implementation_before":implementation_before,"corpus_sha256":workload::source_digest(),"classification":"frozen representative fixture; not live product research","model":{"endpoint":"https://api.z.ai/api/v1","id":"zai-coding/glm-5.3"},"cases":workload::cases().iter().map(|c|c["id"].clone()).collect::<Vec<_>>(),"repetitions":repetitions,"max_calls_per_trial":40,"max_calls_batch":240*repetitions,"owner_repair_inputs_allowed":false,"expected_outputs_disclosed":false,"cost_basis":"self-host resource cost unmeasured; no fabricated zero price","latency_percentile":"nearest-rank descriptive mixed-corpus sample, not stable performance estimate"});
    std::fs::write(report.join("manifest.json"),serde_json::to_vec_pretty(&manifest)?)?;std::fs::write(report.join("corpus.json"),workload::RAW)?;
    eprintln!("A20 frozen manifest {}",report.join("manifest.json").display());
    let mut records=vec![];let mut journal=std::fs::OpenOptions::new().create_new(true).write(true).open(report.join("trials.jsonl"))?;
    for repetition in 0..repetitions {for (index,case) in workload::cases().iter().enumerate(){for collab in if (index+repetition)%2==0 {[false,true]}else{[true,false]} {
        let record=match trial(case,collab,repetition,&report).await {Ok(value)=>value,Err(_)=>json!({"trial_id":format!("{}-{}-{repetition}",case["id"].as_str().unwrap(),if collab{"collaborative"}else{"single"}),"case_id":case["id"],"lane":if collab{"collaborative"}else{"single"},"status":"failed","failure_code":"harness_or_setup_failed","corpus_sha256":workload::source_digest()})};
        writeln!(journal,"{}",serde_json::to_string(&record)?)?;journal.flush()?;eprintln!("A20 trial {}",json!({"id":record["trial_id"],"status":record["status"],"calls":record["inference"]["model_calls"],"elapsed_ms":record["elapsed_ms"]}));records.push(record);
    }}}
    let mut summary=json!({"version":"ghost-a20-results/1","corpus_sha256":workload::source_digest(),"trials":records.len(),"lanes":{},"limitations":["Mixed three-case fixture sample; p95 is descriptive maximum at n=3","No live market research or measured self-host resource price","Serialization checks are separate from semantic quality","No production store/service/model configuration changed"]});
    for lane in ["single","collaborative"] {let rows=records.iter().filter(|r|r["lane"]==lane).collect::<Vec<_>>();let elapsed=rows.iter().filter(|r|r["status"]=="passed").filter_map(|r|r["elapsed_ms"].as_u64()).collect::<Vec<_>>();let failed_elapsed=rows.iter().filter(|r|r["status"]!="passed").filter_map(|r|r["elapsed_ms"].as_u64()).collect::<Vec<_>>();summary["lanes"][lane]=json!({"sample_count":rows.len(),"passed":rows.iter().filter(|r|r["status"]=="passed").count(),"semantic_passed":rows.iter().filter(|r|r["quality"]["passed"]==true).count(),"canonical_passed":rows.iter().filter(|r|r["quality"]["canonical_bytes"]==true).count(),"latency_samples":elapsed.len(),"latency_basis":"admission through independent root acceptance plus Owner report; successful source-stable trials only","failed_attempt_terminal_ms":failed_elapsed,"p50_ms":workload::percentile(&elapsed,50).ok(),"p95_ms":workload::percentile(&elapsed,95).ok(),"model_calls":rows.iter().filter_map(|r|r["inference"]["model_calls"].as_u64()).sum::<u64>(),"usage_missing_calls":rows.iter().filter_map(|r|r["inference"]["usage_missing_calls"].as_u64()).sum::<u64>(),"known_prompt_tokens":rows.iter().filter_map(|r|r["inference"]["known_prompt_tokens"].as_u64()).sum::<u64>(),"known_completion_tokens":rows.iter().filter_map(|r|r["inference"]["known_completion_tokens"].as_u64()).sum::<u64>(),"cost_usd":null});}
    let implementation_after=implementation_fingerprint()?;
    summary["source_stable"]=json!(implementation_before==implementation_after);
    summary["implementation_after"]=implementation_after;
    summary["classification"]=json!(if summary["source_stable"]==true {"source-stable representative fixture batch"} else {"source-contaminated; invalid for paired acceptance"});
    std::fs::write(report.join("summary.json"),serde_json::to_vec_pretty(&summary)?)?;eprintln!("A20 preserved results {}",report.display());
    ensure!(summary["source_stable"]==true,"A20 source changed across batch; preserve without attributing comparison");
    ensure!(records.iter().all(|r|r["status"]=="passed"),"A20 trial failures preserved; do not silently retry");Ok(())
}

fn implementation_fingerprint() -> Result<Value> {
    fn collect(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(path)? {
            let path = entry?.path();
            if path.is_dir() { collect(&path, files)?; }
            else if matches!(path.extension().and_then(|v| v.to_str()), Some("js" | "mjs")) { files.push(path); }
        }
        Ok(())
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![std::env::current_exe()?];
    collect(&root.join("apps/ghost-durable/src"), &mut files)?;
    for name in ["apps/ghost-durable/scripts/a20-live-canary.mjs", "apps/ghost-durable/scripts/a20-metrics.mjs", "apps/ghost-durable/scripts/a20-work-park.mjs",
        "apps/ghost-durable/package.json", "apps/ghost-durable/package-lock.json",
        "src/host/lifetime/pi_execution/a20_tests.rs", "src/host/lifetime/pi_execution/a20_workload.rs",
        "tests/fixtures/a20/product-comparison-v1.json"] { let path=root.join(name); if path.exists() { files.push(path); } }
    files.sort();
    let mut values=serde_json::Map::new();
    for path in files {
        let name=path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
        let bytes=std::fs::read(&path)?;
        values.insert(name,json!({"sha256":workload::sha(&bytes),"bytes":bytes.len()}));
    }
    Ok(Value::Object(values))
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="explicit NEW single diagnostic after preserved first batch; no acceptance batch replay"]
async fn a20_diagnostic_commute_single() -> Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_A20_DIAGNOSTIC").as_deref()==Ok("1"),"Explicit single diagnostic opt-in required");
    workload::validate()?;
    let report=tempfile::Builder::new().prefix("ghost-a20-diagnostic-").tempdir()?.keep();
    let before=implementation_fingerprint()?;
    std::fs::write(report.join("manifest.json"),serde_json::to_vec_pretty(&json!({
        "version":"ghost-a20-diagnostic/1", "purpose":"new single trial to identify primary failure; original failed batch retained",
        "case_id":"commute-value","lane":"single","corpus_sha256":workload::source_digest(),
        "max_calls":40,"automatic_retries":0,
        "model":{"endpoint":"https://api.z.ai/api/v1","id":"zai-coding/glm-5.3"},
        "implementation":before
    }))?)?;
    eprintln!("A20 NEW diagnostic manifest {}",report.join("manifest.json").display());
    let result=trial(&workload::cases()[0],false,0,&report).await?;
    std::fs::write(report.join("result.json"),serde_json::to_vec_pretty(&result)?)?;
    let after=implementation_fingerprint()?;
    std::fs::write(report.join("implementation-after.json"),serde_json::to_vec_pretty(&after)?)?;
    eprintln!("A20 NEW diagnostic results {} status={} calls={} diagnostics={}",report.display(),result["status"],result["inference"]["model_calls"],result["inference"]["provider_diagnostics"]);
    ensure!(before==after,"A20 diagnostic implementation changed during trial");
    ensure!(result["inference"]["model_calls"].as_u64().is_some_and(|n|n>0),"A20 diagnostic submitted no model request");
    Ok(())
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="explicit NEW corrected-bound single; not a paired batch retry"]
async fn a20_corrected_bound_commute_single() -> Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_A20_CORRECTED_SINGLE").as_deref()==Ok("1"),"Explicit corrected single opt-in required");
    workload::validate()?;
    let report=tempfile::Builder::new().prefix("ghost-a20-single4096-").tempdir()?.keep();
    let before=implementation_fingerprint()?;
    std::fs::write(report.join("manifest.json"),serde_json::to_vec_pretty(&json!({
        "version":"ghost-a20-corrected-single/1","purpose":"new assignment with explicit Owner route output bound; prior failures retained",
        "case_id":"commute-value","lane":"single","corpus_sha256":workload::source_digest(),
        "max_calls":40,"automatic_retries":0,
        "model":{"endpoint":"https://api.z.ai/api/v1","id":"zai-coding/glm-5.3"},"implementation":before
    }))?)?;
    eprintln!("A20 NEW corrected single manifest {}",report.join("manifest.json").display());
    let result=trial(&workload::cases()[0],false,0,&report).await?;
    std::fs::write(report.join("result.json"),serde_json::to_vec_pretty(&result)?)?;
    let after=implementation_fingerprint()?;
    std::fs::write(report.join("implementation-after.json"),serde_json::to_vec_pretty(&after)?)?;
    eprintln!("A20 NEW corrected single results {} status={} calls={} diagnostics={}",report.display(),result["status"],result["inference"]["model_calls"],result["inference"]["provider_diagnostics"]);
    ensure!(before==after,"A20 corrected single implementation changed during trial");
    ensure!(result["status"]=="passed","A20 corrected single failed; preserve result without silent retry");
    Ok(())
}
