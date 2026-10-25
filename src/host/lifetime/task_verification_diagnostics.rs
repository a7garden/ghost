//! Test-only native observation capture. This module and call site do not
//! exist in production builds. The explicit task scope grants no authority.
use super::{hash, Plan};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{future::Future, io::Write, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

const OUTPUT_BYTES: usize = 64 * 1024;
struct Capture {
    host_root: PathBuf,
    directory: PathBuf,
    failures: Mutex<Vec<String>>,
}
tokio::task_local! { static CAPTURE: Arc<Capture>; }

/// Opt-in typed scope, available only in a test binary. Neither environment
/// variables nor model inputs can install this hook in a running Host.
pub(crate) async fn with_verifier_test_diagnostics<F: Future>(host_root: &Path, future: F) -> Result<F::Output> {
    let host_root=host_root.canonicalize()?;
    let directory=host_root.join("independent-verifier-diagnostics");
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(())=>{},
        Err(error) if error.kind()==std::io::ErrorKind::AlreadyExists=>{
            let metadata=std::fs::symlink_metadata(&directory)?;
            ensure!(metadata.is_dir() && !metadata.file_type().is_symlink(),"Test verifier diagnostics directory is not private storage");
            use std::os::unix::fs::PermissionsExt;
            ensure!(metadata.permissions().mode()&0o077==0,"Test verifier diagnostics directory is not private");
        },
        Err(error)=>return Err(error.into()),
    }
    let capture=Arc::new(Capture{host_root,directory,failures:Mutex::new(vec![])});
    let output=CAPTURE.scope(Arc::clone(&capture),future).await;
    let failures=capture.failures.lock().map_err(|_|anyhow::anyhow!("Test verifier diagnostics failure state unavailable"))?;
    ensure!(failures.is_empty(),"Test verifier diagnostic capture failed: {}",failures.join("; "));
    Ok(output)
}
fn bounded(text:&str,maximum:usize)->&str {
    let mut end=text.len().min(maximum);
    while !text.is_char_boundary(end){end-=1;}
    &text[..end]
}
fn path(directory:&Path,execution:&str)->PathBuf {
    directory.join(format!("verification-{}.json",hash(execution.as_bytes())))
}
/// Observe the original backend result once, before its bytes are replaced by
/// hashes. Capture errors never modify a verifier result or acceptance; the
/// enclosing test scope fails separately and retains its disposable root.
pub(super) fn record(host_root:&Path,plan:&Plan,command:&str,outcome:&Result<Value>) -> bool {
    CAPTURE.try_with(|capture| {
        if host_root.canonicalize().ok().as_ref()!=Some(&capture.host_root){return false;}
        let native=match outcome {
            Ok(value)=>{
                let stdout=value["stdout"].as_str().unwrap_or("");let stderr=value["stderr"].as_str().unwrap_or("");
                // Preserve failure diagnostics even when stdout is noisy.
                let kept_stderr=bounded(stderr,OUTPUT_BYTES);let kept_stdout=bounded(stdout,OUTPUT_BYTES-kept_stderr.len());
                json!({"kind":"result","state":value["state"],"success":value["success"],"exit_code":value["exit_code"],
                    "stdout":kept_stdout,"stderr":kept_stderr,"stdout_bytes":stdout.len(),"stderr_bytes":stderr.len(),
                    "stdout_sha256":hash(stdout.as_bytes()),"stderr_sha256":hash(stderr.as_bytes()),
                    "truncated":kept_stdout.len()!=stdout.len()||kept_stderr.len()!=stderr.len()})
            },
            Err(error)=>{let reason=error.to_string();json!({"kind":"error","reason":bounded(&reason,1024),"reason_sha256":hash(reason.as_bytes())})},
        };
        let value=json!({"version":"ghost-test-verifier-observation/1","work_id":plan.work_id,
            "source_execution":plan.source_execution,"verification_execution":plan.verification_execution,
            "authority_epoch":plan.authority_epoch,"goal_revision":plan.goal_revision,"owner_revision":plan.owner_revision,
            "image":plan.image,"interpreter":plan.interpreter,"command_sha256":hash(command.as_bytes()),
            "operation_arguments_sha256":hash(serde_json::to_string(&json!({"command":command,"timeout_ms":30000})).unwrap().as_bytes()),
            "script_sha256":plan.script_sha256,"input_sha256":plan.input_sha256,"output_sha256":plan.output.digest,
            "native":native,"authorizes_acceptance":false});
        let written=(||->Result<()>{
            let mut file=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path(&capture.directory,&plan.verification_execution))?;
            file.write_all(&serde_json::to_vec_pretty(&value)?)?;file.sync_all()?;Ok(())
        })();
        if let Err(error)=written {
            if let Ok(mut failures)=capture.failures.lock(){failures.push(format!("{}: {error}",plan.verification_execution));}
        }
        true
    }).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn plan(id:&str)->Plan {
        Plan{work_id:"work".into(),source_execution:"producer".into(),verification_execution:id.into(),ghost_id:"ghost".into(),computer_id:"computer".into(),authority_epoch:1,goal_revision:1,owner_revision:1,requirement_digest:"a".repeat(64),publication_revision:"b".repeat(64),verifier_revision:"verifier".into(),policy_revision:1,template_digest:"c".repeat(64),script_sha256:"d".repeat(64),input_sha256:"e".repeat(64),output:crate::lifetime_contract::Artifact{digest:"f".repeat(64),locator:"opaque".into(),privacy:"public".into(),producing_attempt:"producer".into()},privacy:"public".into(),interpreter:"/bin/sh".into(),image:crate::computers::PINNED_TASK_IMAGE.into()}
    }
    #[tokio::test]
    async fn verifier_test_diagnostics_are_private_bounded_and_refuse_overwrite_without_changing_verdict() {
        let root=tempfile::tempdir().unwrap();let p=plan("original-verifier");
        let observed=Ok(json!({"state":"stopped","success":false,"exit_code":255,"stdout":"x".repeat(70_000),"stderr":"original failure"}));
        assert!(!record(root.path(),&p,"original command",&observed));
        with_verifier_test_diagnostics(root.path(),async {assert!(record(root.path(),&p,"original command",&observed));}).await.unwrap();
        let file=path(&root.path().join("independent-verifier-diagnostics"),&p.verification_execution);let original=std::fs::read(&file).unwrap();
        let value:Value=serde_json::from_slice(&original).unwrap();assert_eq!(value["native"]["success"],false);assert_eq!(value["native"]["exit_code"],255);assert_eq!(value["authorizes_acceptance"],false);
        assert_eq!(value["native"]["truncated"],true);assert!(value["native"]["stdout"].as_str().unwrap().len()+value["native"]["stderr"].as_str().unwrap().len()<=OUTPUT_BYTES);
        assert_eq!(value["native"]["stderr"],"original failure");assert_eq!(value["native"]["stderr_sha256"],hash(b"original failure"));
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode()&0o777,0o600);assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode()&0o777,0o700);
        assert!(with_verifier_test_diagnostics(root.path(),async {record(root.path(),&p,"replacement",&Ok(json!({"success":true,"exit_code":0})));}).await.is_err());
        assert_eq!(std::fs::read(&file).unwrap(),original);assert_eq!(observed.unwrap()["success"],false,"diagnostic failure cannot alter a native verdict");
    }
    #[tokio::test]
    async fn verifier_test_diagnostics_do_not_bleed_between_hosts_parallel_tasks_or_unscoped_children() {
        let a=tempfile::tempdir().unwrap();let b=tempfile::tempdir().unwrap();let barrier=Arc::new(tokio::sync::Barrier::new(2));
        let run=|root:PathBuf,other:PathBuf,id:&'static str,barrier:Arc<tokio::sync::Barrier>|async move {
            with_verifier_test_diagnostics(&root,async {
                barrier.wait().await;let p=plan(id);let observed=Ok(json!({"state":"stopped","success":false,"exit_code":255,"stdout":"","stderr":"bounded native diagnostic"}));
                assert!(!record(&other,&p,"command",&observed));assert!(record(&root,&p,"command",&observed));
                let child_root=root.clone();assert!(!tokio::spawn(async move{record(&child_root,&plan("unscoped-child"),"command",&Ok(json!({})))}).await.unwrap());
            }).await.unwrap();
        };
        tokio::join!(run(a.path().to_path_buf(),b.path().to_path_buf(),"a",barrier.clone()),run(b.path().to_path_buf(),a.path().to_path_buf(),"b",barrier));
        for root in [a.path(),b.path()] {assert_eq!(std::fs::read_dir(root.join("independent-verifier-diagnostics")).unwrap().count(),1);}
    }
}
