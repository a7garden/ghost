// Included in memory::tests to share the existing serialized environment guard.
fn scoped_policy(owner: &str) -> Value {
    json!({"version":1,"owners":{owner:[
        {"id":"own","grant_ref":"own","kind":"own","spaces":["fixture-space"],"capabilities":["read","ingest"],"policy_revision":1},
        {"id":"shared","grant_ref":"shared","kind":"shared","spaces":["common"],"capabilities":["read"],"policy_revision":1}
    ]},"grants":{"own":"GHOST_BRAIN_TOKEN_OWN_FIXTURE","shared":"GHOST_BRAIN_TOKEN_SHARED_FIXTURE"}})
}

pub(crate) async fn scoped_fixture(
    root: &Path,
    owner: &str,
) -> (Brain, SourceEnvGuard, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let directory = root.join("brain");
    fs::create_dir_all(&directory).unwrap();
    let environment = source_env(root, &directory, owner).await;
    std::env::set_var("GHOST_BRAIN_TOKEN_OWN_FIXTURE", "own-fixture-token");
    std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", "shared-fixture-token");
    let policy = root.join("bindings.json");
    fs::write(&policy, serde_json::to_vec(&scoped_policy(owner)).unwrap()).unwrap();
    std::env::set_var("GHOST_BRAIN_BINDINGS", &policy);
    fs::write(
        directory.join("grants.json"),
        serde_json::to_vec(&json!({
            "own-fixture-token":{"spaces":["fixture-space"],"caps":["read","ingest"],"label":"own"},
            "shared-fixture-token":{"spaces":["common"],"caps":["read"],"label":"shared"}
        }))
        .unwrap(),
    )
    .unwrap();
    let info = serde_json::to_string(&oxibrain_client::protocol::server_info(
        "oxibrain",
        "scoped-fixture",
    ))
    .unwrap();
    let script = r#"#!/usr/bin/python3
import sys,json,time,hashlib
from pathlib import Path
root=Path(sys.argv[-1]);info=json.loads('''@INFO@''');token=None
def grants():return json.loads((root/'grants.json').read_text())
def deny(req):
 print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-32001,'message':'scoped fixture denied'}}),flush=True)
for line in sys.stdin:
 req=json.loads(line);method=req['method'];grant=grants().get(token)
 if method=='auth':
  token=req['params']['token'];grant=grants().get(token)
  if grant is None:deny(req);continue
  result={'authenticated':True,'scope':{'spaces':grant['spaces'],'caps':grant['caps'],'predicate_filter':None,'entity_type_filter':None,'expires_at':None,'label':grant['label']}}
 elif method=='handshake':result=info
 elif grant is None:deny(req);continue
 elif method=='spaces/list':
  result={'spaces':[{'id':s,'name':s,'created_at':0,'episode_count':0,'entity_count':0} for s in grant['spaces']]}
 elif method=='tools/list':
  names=['search','recall','session_list','get_entity']
  if 'ingest' in grant['caps']:names+=['ingest','session_record']
  if 'write' in grant['caps']:names+=['declare']
  result={'tools':[{'name':n,'inputSchema':{'type':'object','x-oxibrain-session-trust':'untrusted'}} for n in names]}
 elif method=='document_source.inspect':
  if (root/'hang-source-proof').exists():
   (root/'proof-started').write_text('yes');time.sleep(2)
  proof=None
  if (root/'document-root').exists():
   docroot=Path((root/'document-root').read_text()).resolve();page=docroot/(req['params']['document_uuid']+'.md')
   if page.exists():
    digest=hashlib.sha256(page.read_bytes()).hexdigest()
    if digest==req['params']['expected_source_sha256']:
     proof={'space':grant['spaces'][0],'document_uuid':page.stem,'root_alias':'fixture-documents','canonical_root':str(docroot),'locator':page.name,'source_revision':'fixture:'+digest,'source_sha256':digest,'root_generation':1,'fresh':True}
  if (root/'proof-override.json').exists():proof=json.loads((root/'proof-override.json').read_text())
  result={'proof':proof}
 elif method=='resources/read':
  episode=json.loads((root/'episode.json').read_text())
  result={'contents':[{'uri':req['params']['uri'],'mimeType':'application/json','text':json.dumps(episode)}]}
 elif method=='tools/call':
  name=req['params']['name'];args=req['params']['arguments'];space=args['space']
  with (root/'scope-calls.jsonl').open('a') as out:out.write(json.dumps({'label':grant['label'],'name':name,'space':space,'token_budget':args.get('token_budget')})+'\n')
  if space not in grant['spaces']:deny(req);continue
  if name=='search' and args.get('planes')==['documents']:
   hits=[]
   if (root/'document-root').exists():
    docroot=Path((root/'document-root').read_text())
    for page in docroot.glob('*.md'):
     text=page.read_text()
     if args['query'] in text:
      hits.append({'document_id':page.stem,'root':'fixture-documents','locator':page.name,'revision':'fixture:'+hashlib.sha256(text.encode()).hexdigest(),'ordinal':0,'text':{'kind':'untrusted','text':text,'provenance':{'ref':page.name,'trust':'untrusted'}},'modified_at':0,'score':1.0})
   text=json.dumps({'data':{'memory':[],'documents':hits,'freshness':{'reconciled_roots':['fixture-documents'],'skipped_roots':[],'skipped_files':0,'stale_after_retry':[],'dense_coverage':None}},'meta':{}})
  elif name=='ingest':
   if 'ingest' not in grant['caps']:deny(req);continue
   content=args['content'];eid=hashlib.sha256((space+args['source_path']+content).encode()).hexdigest()
   episode={'id':eid,'space':space,'kind':'primary','trust':args['trust'],'content_hash':[0]*32,'content':content,'source':{'kind':'note','ref':{'path':args['source_path']}},'redacted_at':None}
   (root/'episode.json').write_text(json.dumps(episode));text='Ingested as episode: '+eid
  else:
   if args.get('query')=='slow':
    (root/'query-started').write_text('yes');time.sleep(.2)
   marker='private marker' if space=='fixture-space' else 'common marker'
   evidence={'reference':'episode://'+space,'revision':'1','view':'raw','range':{'start':0,'end':len(marker)},'uncertainty':['single_source']}
   text=json.dumps({'data':{'context':marker,'evidence':[evidence]},'meta':{'partial':False,'frontier':space+'-frontier'}})
   if (root/'revoke-during-query').exists():
    current=grants();current.pop(token,None);(root/'grants.json').write_text(json.dumps(current));(root/'revoke-during-query').unlink()
  result={'content':[{'type':'text','text':text}]}
 else:raise Exception('unexpected scoped fixture method '+method)
 print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
"#.replace("@INFO@",&info);
    let executable = directory.join("brain-fixture");
    fs::write(&executable, script).unwrap();
    fs::set_permissions(executable, fs::Permissions::from_mode(0o700)).unwrap();
    (Brain::default(), environment, directory, policy)
}

#[tokio::test]
async fn scoped_reads_preserve_evidence_and_bound_total_budget() {
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, _policy) = scoped_fixture(root.path(), "owner-a").await;
    let output = brain
        .read_memory(
            "owner-a",
            "session-a",
            &ai::ToolCall::new(
                "recall",
                "memory_recall",
                json!({"query":"markers","token_budget":1025}),
            ),
            || Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(output.status, ToolStatus::Success);
    assert_eq!(output.content["partial"], false);
    assert_eq!(output.content["evidence"].as_array().unwrap().len(), 2);
    let scopes = output.content["scopes"].as_array().unwrap();
    assert_eq!(
        scopes
            .iter()
            .map(|scope| scope["token_budget"].as_u64().unwrap())
            .sum::<u64>(),
        1025
    );
    assert_eq!(scopes[0]["result"]["data"]["context"], "private marker");
    assert_eq!(scopes[1]["result"]["meta"]["frontier"], "common-frontier");
    let calls = fs::read_to_string(directory.join("scope-calls.jsonl")).unwrap();
    for call in calls
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
    {
        assert_eq!(
            call["space"],
            if call["label"] == "own" {
                "fixture-space"
            } else {
                "common"
            }
        );
    }
    assert!(
        brain.client.lock().await.is_none(),
        "scoped session must not be cached"
    );
}

#[tokio::test]
async fn scoped_shared_reads_cannot_write_or_use_overbroad_engine_grants() {
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, policy) = scoped_fixture(root.path(), "owner-a").await;
    let mut configuration = scoped_policy("owner-a");
    configuration["owners"]["owner-a"] = json!([configuration["owners"]["owner-a"][1].clone()]);
    fs::write(&policy, serde_json::to_vec(&configuration).unwrap()).unwrap();
    let content = "attempted shared contribution";
    let origin = source_origin(
        "owner-a",
        "attempt",
        "1",
        content,
        SourceDisclosure::Private,
    );
    let ledger = SourceLedgerConfig::from_env().unwrap();
    assert!(brain
        .ingest_source(&origin, content, &ledger, || Ok(()))
        .await
        .is_err());
    assert!(
        !ledger.path.exists(),
        "denied source must not create a ledger row"
    );
    let mut grants: Value =
        serde_json::from_slice(&fs::read(directory.join("grants.json")).unwrap()).unwrap();
    grants["shared-fixture-token"]["caps"] = json!(["read", "ingest"]);
    fs::write(
        directory.join("grants.json"),
        serde_json::to_vec(&grants).unwrap(),
    )
    .unwrap();
    let output = brain
        .read_memory(
            "owner-a",
            "session-a",
            &ai::ToolCall::new("recall", "memory_recall", json!({"query":"marker"})),
            || Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(output.content["partial"], true);
    assert_eq!(output.content["evidence"], json!([]));
    assert!(
        !directory.join("scope-calls.jsonl").exists(),
        "overbroad token must fail before query"
    );
}

#[tokio::test]
async fn scoped_exact_read_grant_rejects_capabilities_hidden_from_tool_catalogue() {
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, policy) = scoped_fixture(root.path(), "owner-a").await;
    let mut configuration = scoped_policy("owner-a");
    configuration["owners"]["owner-a"] = json!([configuration["owners"]["owner-a"][1].clone()]);
    fs::write(&policy, serde_json::to_vec(&configuration).unwrap()).unwrap();
    for hidden in ["admin", "sample", "trusted_ingest"] {
        let grants = json!({"shared-fixture-token":{"spaces":["common"],"caps":["read",hidden],"label":"shared"}});
        fs::write(
            directory.join("grants.json"),
            serde_json::to_vec(&grants).unwrap(),
        )
        .unwrap();
        let output = brain
            .read_memory(
                "owner-a",
                "session-a",
                &ai::ToolCall::new("hidden", "memory_recall", json!({"query":"marker"})),
                || Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(output.content["partial"], true, "{hidden}");
        assert_eq!(output.content["evidence"], json!([]), "{hidden}");
        assert!(
            !directory.join("scope-calls.jsonl").exists(),
            "hidden capability reached query"
        );
    }
}

#[tokio::test]
async fn scoped_own_write_uses_own_grant_and_keeps_same_source_receipt() {
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, _policy) = scoped_fixture(root.path(), "owner-a").await;
    let content = "owner observation";
    let origin = source_origin(
        "owner-a",
        "observation",
        "1",
        content,
        SourceDisclosure::Private,
    );
    let ledger = SourceLedgerConfig::from_env().unwrap();
    let receipt = brain
        .ingest_source(&origin, content, &ledger, || Ok(()))
        .await
        .unwrap();
    assert_eq!(receipt.status, SourceStatus::Recorded);
    let replay = brain
        .ingest_source(&origin, content, &ledger, || Ok(()))
        .await
        .unwrap();
    assert_eq!(replay.status, SourceStatus::AlreadyRecorded);
    assert_eq!(receipt.episode_id, replay.episode_id);
    let calls = fs::read_to_string(directory.join("scope-calls.jsonl")).unwrap();
    let writes: Vec<Value> = calls
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|value: &Value| value["name"] == "ingest")
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["label"], "own");
    assert_eq!(writes[0]["space"], "fixture-space");
}

#[tokio::test]
async fn scoped_revoke_during_query_withholds_result_and_context_reuse() {
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, _policy) = scoped_fixture(root.path(), "owner-a").await;
    fs::write(directory.join("revoke-during-query"), b"revoke").unwrap();
    let output = brain
        .read_memory(
            "owner-a",
            "session-a",
            &ai::ToolCall::new("recall", "memory_recall", json!({"query":"marker"})),
            || Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(output.status, ToolStatus::Denied);
    assert!(brain.validate_context("owner-a", || Ok(())).await.is_err());
}

#[tokio::test]
async fn scoped_missing_read_space_is_partial_and_config_revoke_fences_inflight() {
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, policy) = scoped_fixture(root.path(), "owner-a").await;
    let mut grants: Value =
        serde_json::from_slice(&fs::read(directory.join("grants.json")).unwrap()).unwrap();
    grants
        .as_object_mut()
        .unwrap()
        .remove("shared-fixture-token");
    fs::write(
        directory.join("grants.json"),
        serde_json::to_vec(&grants).unwrap(),
    )
    .unwrap();
    let output = brain
        .read_memory(
            "owner-a",
            "session-a",
            &ai::ToolCall::new("partial", "memory_recall", json!({"query":"marker"})),
            || Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(output.status, ToolStatus::Success);
    assert_eq!(output.content["partial"], true);
    assert_eq!(output.content["evidence"].as_array().unwrap().len(), 1);
    let change = async {
        for _ in 0..100 {
            if directory.join("query-started").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let mut configuration = scoped_policy("owner-a");
        configuration["owners"]["owner-a"] = json!([]);
        fs::write(&policy, serde_json::to_vec(&configuration).unwrap()).unwrap();
    };
    let slow_call = ai::ToolCall::new("slow", "memory_recall", json!({"query":"slow"}));
    let read = brain.read_memory("owner-a", "session-a", &slow_call, || Ok(()));
    let (result, ()) = tokio::join!(read, change);
    assert!(result.is_err() || result.unwrap().status == ToolStatus::Denied);
}

#[cfg(feature = "documents")]
#[tokio::test]
async fn document_index_proof_rejects_same_uuid_in_another_root_stale_freshness_and_wrong_hash() {
    use crate::adapters::documents;
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, _policy) = scoped_fixture(root.path(), "owner-a").await;
    let space = documents::Space {
        id: "proof-documents".into(),
        name: "Proof".into(),
        path: root.path().join("documents"),
        writable: true,
        profiles: vec!["owner-a".into()],
    };
    let id = uuid::Uuid::now_v7().to_string();
    let page = documents::create(
        &space,
        &id,
        "Source proof",
        "source marker\n",
        "pdc-markdown/1",
        &documents::timestamp().unwrap(),
    )
    .unwrap();
    fs::write(
        directory.join("document-root"),
        space.path.to_str().unwrap(),
    )
    .unwrap();
    assert!(brain
        .experience_document_indexed("owner-a", &id, &space.path, &page.hash, || Ok(()))
        .await
        .unwrap());
    let other = root.path().join("unrelated-root");
    fs::create_dir_all(&other).unwrap();
    fs::copy(
        space.path.join(format!("{id}.md")),
        other.join(format!("{id}.md")),
    )
    .unwrap();
    let mut proof = json!({"space":"fixture-space","document_uuid":id,"root_alias":"wrong-root","canonical_root":other.canonicalize().unwrap(),"locator":format!("{id}.md"),"source_revision":"observed-revision","source_sha256":page.hash,"root_generation":1,"fresh":true});
    fs::write(
        directory.join("proof-override.json"),
        serde_json::to_vec(&proof).unwrap(),
    )
    .unwrap();
    assert!(!brain
        .experience_document_indexed("owner-a", &id, &space.path, &page.hash, || Ok(()))
        .await
        .unwrap());
    proof["canonical_root"] = json!(space.path.canonicalize().unwrap());
    proof["fresh"] = json!(false);
    fs::write(
        directory.join("proof-override.json"),
        serde_json::to_vec(&proof).unwrap(),
    )
    .unwrap();
    assert!(!brain
        .experience_document_indexed("owner-a", &id, &space.path, &page.hash, || Ok(()))
        .await
        .unwrap());
    proof["fresh"] = json!(true);
    proof["source_sha256"] = json!("0".repeat(64));
    fs::write(
        directory.join("proof-override.json"),
        serde_json::to_vec(&proof).unwrap(),
    )
    .unwrap();
    assert!(!brain
        .experience_document_indexed("owner-a", &id, &space.path, &page.hash, || Ok(()))
        .await
        .unwrap());
}
