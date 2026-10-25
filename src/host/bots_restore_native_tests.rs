// Included in restore_fixture. Native engine opt-in, no network model provider.
fn native_cli(binary: &Path, directory: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new(binary)
        .arg("--dir")
        .arg(directory)
        .args(args)
        .output()
        .unwrap();
    if !output.status.success() {
        let operation=match args {
            ["admin","token","issue",..]=>"token_issue",
            ["admin","token","revoke",..]=>"token_revoke",
            ["admin","restore",..]=>"restore",
            ["admin","backup",..]=>"backup",
            ["admin","init",..]=>"init",
            _=>"native_operation",
        };
        let credentials=std::env::vars().filter(|(name,_)|name.starts_with("GHOST_BRAIN_TOKEN_") || name=="GHOST_PI_CALLBACK_TOKEN").map(|(_,value)|value).filter(|value|!value.is_empty()).collect::<Vec<_>>();
        let path=record_native_failure(directory,operation,output.status.code(),&output.stderr,&credentials);
        panic!("A19 native {operation} failed (exit {:?}); private diagnostic: {}",output.status.code(),path.display());
    }
    String::from_utf8(output.stdout).unwrap()
}
fn record_native_failure(directory:&Path,operation:&str,exit_code:Option<i32>,stderr:&[u8],credentials:&[String])->PathBuf {
    let mut stderr=String::from_utf8_lossy(stderr).into_owned();
    for value in credentials.iter().filter(|value|!value.is_empty()) {stderr=stderr.replace(value,"[credential redacted]");}
    // Redact complete credentials BEFORE truncation, including secrets crossing
    // the retained output boundary. No native stdout enters this receipt.
    let stderr=stderr.chars().take(4096).collect::<String>();
    use std::os::unix::{fs::{OpenOptionsExt,PermissionsExt}};
    let retained=directory.parent().unwrap().join("native-operation-errors");fs::create_dir_all(&retained).unwrap();fs::set_permissions(&retained,fs::Permissions::from_mode(0o700)).unwrap();
    let path=retained.join(format!("{operation}-{}.json",uuid::Uuid::new_v4()));let mut file=fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).unwrap();
    serde_json::to_writer_pretty(&mut file,&json!({"operation":operation,"exit_code":exit_code,"stderr":stderr})).unwrap();file.sync_all().unwrap();path
}
#[test]
fn a19_native_diagnostic_redacts_before_truncation_and_omits_stdout() {
    use std::os::unix::fs::PermissionsExt;
    let root=tempfile::tempdir().unwrap();let secret="A19_SECRET_CROSSING_THE_RETAINED_BOUNDARY".to_owned();let stderr=format!("{}{} trailing diagnostic","x".repeat(4092),secret);
    let path=record_native_failure(&root.path().join("engine"),"restore",Some(7),stderr.as_bytes(),&[secret.clone()]);let bytes=fs::read(&path).unwrap();let value:Value=serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["exit_code"],7);assert_eq!(value["operation"],"restore");assert_eq!(value.as_object().unwrap().len(),3);assert!(value.get("stdout").is_none());let retained=value["stderr"].as_str().unwrap();assert_eq!(retained.chars().count(),4096);assert!(!retained.contains("A19_"));assert!(!retained.contains(&secret));assert_eq!(fs::metadata(&path).unwrap().permissions().mode()&0o777,0o600);assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode()&0o777,0o700);
}
fn recovery_artifact_cli(root:&Path,args:&[&str])->Value {
    let binary=std::env::var_os("GHOST_RECOVERY_TEST_BINARY").expect("explicit current Ghost operator CLI");
    let output=std::process::Command::new(binary).arg("--root").arg(root.join("unused-operator-state")).arg("recovery").args(args).output().unwrap();
    assert!(output.status.success(),"A19 operator artifact CLI refused operation: {}",String::from_utf8_lossy(&output.stderr));serde_json::from_slice(&output.stdout).unwrap()
}
fn native_token(binary: &Path, directory: &Path, space: &str, caps: &str) -> (String, String) {
    let output = native_cli(
        binary,
        directory,
        &["admin", "token", "issue", "--space", space, "--caps", caps],
    );
    (
        output
            .lines()
            .find_map(|l| l.strip_prefix("issued token id="))
            .unwrap()
            .into(),
        output
            .lines()
            .find_map(|l| l.strip_prefix("secret (shown once): "))
            .unwrap()
            .into(),
    )
}
fn native_space_id(directory: &Path, name: &str) -> String {
    let conn=rusqlite::Connection::open_with_flags(directory.join("brain.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.query_row("SELECT id FROM spaces WHERE name=?1",[name],|row|row.get(0)).unwrap()
}
fn owner(host: &Host, id: &str, body: Value, revision: Option<u64>) -> Value {
    let mut command = env(id, body);
    command.authority_epoch = host.authority_epoch;
    command.expected_revision = revision;
    let response = host.lifetime_action(&command).unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
    response["result"]["data"].clone()
}
fn configure(host: &Host, c: &Candidate, revision: u64, id: &str) -> Value {
    owner(host,id,json!({"method":"work.memory.profile.configure","ghost_id":c.definition.ghost_id,"binding_ids":["shared"],"required":true,"experience_space_id":null}),Some(revision))["profile_ref"].clone()
}
fn update(host: &Host, c: &Candidate, pin: Value, id: &str) -> Candidate {
    let response = owner(
        host,
        id,
        json!({"method":"bot.update.prepare","ghost_id":c.definition.ghost_id,"definition_ref":bots_store::DefinitionPointer::from(&c.definition),"memory_profile_ref":pin}),
        None,
    );
    candidate(
        &host.lock().unwrap().journal.0,
        response["candidate_id"].as_str().unwrap(),
    )
    .unwrap()
}
async fn finish(host: &Host, c: &Candidate) {
    memory_update_evaluation_host(host, c).await;
    memory_update_provision_host(host, c).await;
    host.validate_bot_memory(c).await.unwrap();
    owner(
        host,
        &format!("a19-activate-{}", c.id),
        json!({"method":"bot.activate","candidate_id":c.id,"candidate_digest":c.digest}),
        None,
    );
}
fn request(
    host: &Host,
    c: &Candidate,
    assignment: &str,
    work: &str,
    method: &str,
    args: Value,
    id: &str,
) -> lifetime::PiToolRequest {
    let mut body = json!({"method":method,"assignment_id":assignment,"work_id":work});
    if method.starts_with("work.memory.") {
        body["ghost_id"] = json!(c.definition.ghost_id);
        body["conversation_id"] = json!(c.conversation_id);
    }
    for (key, value) in args.as_object().unwrap() {
        body[key] = value.clone();
    }
    let mut envelope = env(id, body);
    envelope.actor_ref = c.definition.ghost_id.clone();
    envelope.authority_epoch = host.authority_epoch;
    let reference: Option<String> = {
        let state = host.lock().unwrap();
        state.journal.0.query_row("SELECT json_extract(c.payload,'$.reference') FROM workspace_objects c JOIN workspace_objects x ON x.kind='ghost_work_context_claim_v1' AND x.id=json_extract(c.payload,'$.reference') WHERE c.kind='ghost_work_context_v1' AND c.id=?1",[assignment],|r|r.get(0)).optional().unwrap()
    };
    serde_json::from_value(json!({"context_ref":reference,"ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"envelope":envelope})).unwrap()
}
async fn claim_context(host: &Host, c: &Candidate, assignment: &str, work: &str, id: &str) {
    let mut e = env(
        &format!("{id}-assignment-inspect"),
        json!({"method":"conversation.assignment.inspect","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"assignment_id":assignment}),
    );
    e.actor_ref = c.definition.ghost_id.clone();
    e.authority_epoch = host.authority_epoch;
    let r: lifetime::PiToolRequest = serde_json::from_value(
        json!({"ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"envelope":e}),
    )
    .unwrap();
    let inspected = host
        .lifetime_pi_action(&r, lifetime::PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(inspected["result"]["status"], "success", "{inspected}");
    let reference = inspected["result"]["data"]["execution_context"]["ref"]
        .as_str()
        .expect("Host-sealed Work context descriptor");
    let mut r = request(
        host,
        c,
        assignment,
        work,
        "work.context.claim",
        json!({"context_ref":reference,"generation_task_id":7,"provider_session_id":uuid::Uuid::new_v4().to_string(),"storage_ref":format!("work-contexts/{reference}/durable.sqlite")}),
        &format!("{id}-context-claim"),
    );
    r.context_ref = Some(reference.into());
    let response = host
        .lifetime_pi_action(&r, lifetime::PiInferenceScope::Local)
        .await
        .unwrap();
    assert_eq!(response["result"]["status"], "success", "{response}");
}
async fn accepted_work(host: &std::sync::Arc<Host>, c: &Candidate, id: &str, episode: &str, page: &str, document_hash: &str, seed_home: bool, sdk: Option<&actual_sdk::NativeSdk>) -> Value {
    // Bind expected coordinates to the actual native ledger and freshly read
    // source bytes, separately from the controlled Host callback producer.
    let directory = PathBuf::from(std::env::var_os("GHOST_BRAIN_DIR").unwrap());
    let conn = rusqlite::Connection::open_with_flags(directory.join("brain.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (episode_revision, episode_space, episode_space_name): (String, String, String) = conn.query_row("SELECT hex(e.content_hash),e.space_id,s.name FROM episodes e JOIN spaces s ON s.id=e.space_id WHERE e.id=?1", [episode], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    let common_space_id=native_space_id(&directory,"common");
    assert_eq!(episode_space_name,"common");
    assert_eq!(episode_space,common_space_id);
    drop(conn);
    let mut client = oxibrain_client::BrainClient::spawn_local_with_token(
        oxibrain_client::LocalProcessEndpoint::new(std::env::var_os("GHOST_BRAIN_EXECUTABLE").unwrap(), &directory),
        &std::env::var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE").unwrap(),
    ).await.unwrap();
    let proof = client.document_source_proof("common",page,document_hash).await.unwrap().unwrap();
    client.close().await.unwrap();
    assert_eq!(proof.space,common_space_id);
    assert_eq!(proof.document_uuid,page);
    assert_eq!(proof.source_sha256,document_hash);
    assert_eq!(proof.root_alias,"a19-source");
    assert!(proof.fresh && proof.root_generation>0);
    let document_reference=format!("doc://a19-source/{}?rev={}",proof.locator,proof.source_revision);
    let expected = format!(
        "source={episode}@{episode_revision};document={page}@{}#{document_hash};skill={}",
        proof.source_revision,
        c.definition.content.skill_refs[0].digest
    );
    if let Some(sdk)=sdk{sdk.prepare(seed_home);}
    let admitted = owner(
        host,
        id,
        json!({"method":"goal.submit","ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"prompt":if sdk.is_some(){format!("A19_SDK_NATIVE document_hash={document_hash} skill={}",c.definition.content.skill_refs[0].digest)}else{"Use the pinned restored procedure and original source evidence.".into()},"privacy":"private","acceptance_spec":crate::host::lifetime::pi_execution::tests::verifier_spec(&expected)}),
        None,
    );
    let work: Work = serde_json::from_value(admitted["work"].clone()).unwrap();
    let assignment: String = {
        let s = host.lock().unwrap();
        s.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&work.id],|r|r.get(0)).unwrap()
    };
    if let Some(sdk)=sdk {return sdk.accepted_work(host,c,&work,&assignment,&expected,serde_json::to_value(&proof).unwrap(),seed_home).await;}
    claim_context(host, c, &assignment, &work.id, id).await;
    let mut stamp = None;
    let mut observations=serde_json::Map::new();
    let mut observed_episode=None;
    let mut observed_document=None;
    for (label, query, planes) in [
        ("memory", "A19_NATIVE_SOURCE_MARKER", json!(["memory"])),
        ("document", "A19_PDC_SOURCE_MARKER", json!(["documents"])),
    ] {
        let response = host
            .lifetime_work_memory_action(
                &request(
                    host,
                    c,
                    &assignment,
                    &work.id,
                    "work.memory.recall",
                    json!({"query":query,"token_budget":2048,"planes":planes}),
                    &format!("{id}-recall-{label}"),
                ),
                lifetime::PiInferenceScope::Local,
            )
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        assert_eq!(response.data["partial"],false,"{response:?}");
        let scopes=response.data["scopes"].as_array().unwrap();
        assert_eq!(scopes.len(),1,"exact single shared binding");
        let scope=&scopes[0];
        assert_eq!(scope["binding_id"],"shared");
        assert_eq!(scope["space"],"common");
        assert_eq!(scope["partial"],false);
        assert_eq!(scope["result"]["meta"]["scope"]["requested"]["space"],common_space_id);
        let evidence=response.data["evidence"].as_array().unwrap();
        assert!(!evidence.is_empty(),"native {label} evidence unavailable");
        for item in evidence {
            assert_eq!(item["binding_id"],"shared");
            assert_eq!(item["space"],"common");
            let citation=&item["source"];
            let coordinate=&citation["source"];
            let layer=citation["layer_index"].as_u64().unwrap() as usize;
            let text=scope["result"]["data"]["layers"][layer]["text"].as_str().unwrap();
            let start=citation["rendered_text_start"].as_u64().unwrap() as usize;
            let end=citation["rendered_text_end"].as_u64().unwrap() as usize;
            assert!(text[start..end].contains(query),"exact delivered source span lacks marker");
            if label=="memory" {
                assert_eq!(coordinate["reference"],format!("episode://{episode}"));
                assert_eq!(coordinate["revision"],episode_revision);
                assert_eq!(coordinate["view"],"episode-utf8/1");
                observed_episode=Some(format!("{}@{}",coordinate["reference"].as_str().unwrap().strip_prefix("episode://").unwrap(),coordinate["revision"].as_str().unwrap()));
            } else {
                assert_eq!(coordinate["document_uuid"],page);
                assert_eq!(coordinate["reference"],document_reference);
                assert_eq!(coordinate["revision"],proof.source_revision);
                assert_eq!(coordinate["view"],"decoded-utf8/1");
                assert!(coordinate["view_digest"].as_str().is_some());
                let freshness=&scope["result"]["meta"]["freshness"];
                assert!(freshness["reconciled_roots"].as_array().unwrap().iter().any(|v|v=="a19-source"));
                assert_eq!(freshness["skipped_roots"],json!([]));
                assert_eq!(freshness["skipped_files"],0);
                assert_eq!(freshness["stale_after_retry"],json!([]));
                observed_document=Some(format!("{}@{}#{}",coordinate["document_uuid"].as_str().unwrap(),coordinate["revision"].as_str().unwrap(),proof.source_sha256));
            }
        }
        observations.insert(label.into(),response.data.clone());
        stamp = Some(
            response.data["context_revision"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let stamp = stamp.unwrap();
    let observed=format!("source={};document={};skill={}",observed_episode.unwrap(),observed_document.unwrap(),c.definition.content.skill_refs[0].digest);
    assert_eq!(observed,expected);
    let mut replay = None;
    let mut artifact = None;
    for (task, call, operation, args) in [
        (
            10,
            "write",
            "write",
            json!({"path":"answer.txt","content":observed}),
        ),
        (
            11,
            "publish",
            "publish_artifact",
            json!({"path":"answer.txt","privacy":"private"}),
        ),
    ] {
        let tool = request(
            host,
            c,
            &assignment,
            &work.id,
            "work.execute",
            json!({"generation_task_id":7,"task_id":task,"call_id":call,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":args})).unwrap(),"arguments":args,"work_memory_context_revision":stamp}),
            &format!("{id}-{call}"),
        );
        let response = host
            .lifetime_pi_execution_action(&tool, lifetime::PiInferenceScope::Local)
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        if call == "write" {
            replay = Some(tool);
        } else {
            artifact = Some(response.artifacts[0].clone());
        }
    }
    let home_relative=if seed_home {
        // Controlled Owner fixture data enters the already admitted execution's
        // real private HOME lane while its original lease is still active.
        let execution:String=host.lock().unwrap().journal.0.query_row("SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1 AND state='running'",[&work.id],|row|row.get(0)).unwrap();
        let native=host.native_computers.as_ref().unwrap();
        let computer=native.pi_computer(&c.definition.ghost_id).unwrap();
        assert!(native.pi_current(&c.definition.ghost_id,&execution,&computer,host.authority_epoch,"private").unwrap());
        let environment=native.pi_acquire(&c.definition.ghost_id,&execution,host.authority_epoch,"private").unwrap();
        let layout=crate::operations::home_lanes::open_layout_by_marker_at_root(&environment.manifest.home_volume,&computer).unwrap();
        let preference=layout.private.join("a19-original-preference");
        fs::write(&preference,b"original Ghost home preference").unwrap();
        Some(preference.strip_prefix(&host.root).unwrap().to_owned())
    } else {None};
    let response=host.lifetime_pi_execution_action(&request(host,c,&assignment,&work.id,"work.execution.complete",json!({"task_id":7,"summary":"Native restored evidence and pinned skill used","work_memory_context_revision":stamp}),&format!("{id}-complete")),lifetime::PiInferenceScope::Local).await.unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    assert_eq!(response.data["verification"]["status"], "success");
    let s = host.lock().unwrap();
    let actual: Work = serde_json::from_str(
        &s.journal
            .0
            .query_row(
                "SELECT payload FROM lifetime_work WHERE id=?1",
                [&work.id],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(actual.state, "accepted");
    let assets = assets_for_work(&s.journal.0, &actual).unwrap();
    assert!(assets
        .iter()
        .any(|a| a["sha256"] == c.definition.content.skill_refs[0].digest));
    let replay = replay.unwrap();
    let replay = json!({"ghost_id":replay.ghost_id,"conversation_id":replay.conversation_id,"envelope":replay.envelope,"context_ref":replay.context_ref});
    json!({"work":actual,"grant":raw_grant_no_lock(&s.journal.0,&actual),"definition":bots_store::definition_for_work(&s.journal.0,&actual).unwrap(),"replay":replay,"artifact":artifact.unwrap(),"expected":expected,"recall_observations":observations,"document_source_proof":proof,"home_relative":home_relative})
}
fn immutable_objects(host: &Host) -> Vec<(String, String, String)> {
    let s = host.lock().unwrap();
    let mut q=s.journal.0.prepare("SELECT kind,id,payload FROM workspace_objects WHERE kind IN ('bot_definition_v1','bot_definition_active_v1','bot_definition_work_pin_v1','work_memory_profile_revision_v1','work_memory_profile_v1','work_memory_grant_v1','shared_skill_revision_v1','shared_skill_grant_v1') ORDER BY kind,id").unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}
fn history(root: &Path, c: &Candidate, epoch: u64, mode: &str) -> Value {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("apps/ghost-durable/scripts/a19-storage-canary.mjs");
    let output = std::process::Command::new("/opt/homebrew/bin/node")
        .arg(script)
        .arg(mode)
        .arg(root)
        .arg(&c.definition.ghost_id)
        .arg(&c.conversation_id)
        .arg(epoch.to_string())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "A19 SDK storage operation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn native_adopt_procedure(f: &MemoryBotFixture, primary: &str) -> Candidate {
    let source_ref = {
        let s = f.host.lock().unwrap();
        let saved=host::skills::save(&s,&f.host.root,"a19-original-skill",&primary,"a19-source-procedure","---\nprivacy: public\n---\nPreserve original source identity and exact document revision; emit a provenance tuple.",None).unwrap();
        rr(
            &primary,
            "a19-source-procedure",
            1,
            saved["skill"]["digest"].as_str().unwrap().into(),
        )
    };
    let published=owner(&f.host,"a19-publish-procedure",json!({"method":"skill.catalog.publish","namespace":"common","id":"a19-procedure","source":source_ref}),None)["reference"].clone();
    for (id, ghost) in [
        ("a19-grant-target", f.c.definition.ghost_id.as_str()),
        ("a19-grant-evaluator", primary),
    ] {
        owner(
            &f.host,
            id,
            json!({"method":"skill.catalog.grant","reference":published,"ghost_id":ghost,"allow":true}),
            None,
        );
    }
    let before = f.host.lifetime_action(&env("a19-adoption-before-new-case",json!({"method":"bot.update.prepare","ghost_id":f.c.definition.ghost_id,"definition_ref":bots_store::DefinitionPointer::from(&f.c.definition),"skill_adoption":{"reference":published,"alias":"procedure"}}))).unwrap();
    assert_eq!(before["ok"],false);
    assert_eq!(before["error"],"shared adoption requires a new independent evaluation input");
    let old: EvaluationProfile=load(&f.host.lock().unwrap().journal.0,EVALUATOR,"workspace").unwrap().unwrap();
    let mut fixtures=old.fixtures.clone();
    let held_out=Fixture {
        id:"a19-distinct-root-source-correction".into(),
        input:json!({"source_id":"a19-corrected-origin","source_revision":2,"document_uuid":"019a81b4-d4c0-7c00-8000-000000000123","original_root":"quarantined","destination_root":"restored-generation"}),
        expected_output:json!("a19-corrected-origin@2;document=019a81b4-d4c0-7c00-8000-000000000123;preserve-original-identity"),
    };
    assert!(!fixtures.iter().any(|fixture|fixture.input==held_out.input));
    fixtures.push(held_out);
    owner(&f.host,"a19-extend-independent-evaluation",json!({"method":"bot.evaluation_profile.configure","fixtures":fixtures}),Some(old.revision));
    let prepared = owner(
        &f.host,
        "a19-adopt-procedure",
        json!({"method":"bot.update.prepare","ghost_id":f.c.definition.ghost_id,"definition_ref":bots_store::DefinitionPointer::from(&f.c.definition),"skill_adoption":{"reference":published,"alias":"procedure"}}),
        None,
    );
    let c = candidate(
        &f.host.lock().unwrap().journal.0,
        prepared["candidate_id"].as_str().unwrap(),
    )
    .unwrap();
    assert!(old.fixtures.iter().all(|fixture|c.evaluation_profile.fixtures.contains(fixture)));
    assert_eq!(c.evaluation_profile.fixtures.len(),old.fixtures.len()+1);
    c
}

#[tokio::test]
async fn a19_shared_procedure_adoption_requires_fresh_owner_held_out_input() {
    let f=memory_update_active().await;
    let primary:String=f.host.lock().unwrap().journal.0.query_row("SELECT ghost_id FROM lifetime_registry WHERE kind='primary'",[],|row|row.get(0)).unwrap();
    let c=native_adopt_procedure(&f,&primary);
    assert_eq!(c.definition.ghost_id,f.c.definition.ghost_id);
    assert_eq!(c.definition.content.memory_profile_ref,f.c.definition.content.memory_profile_ref);
    finish(&f.host,&c).await;
    assert_eq!(bots_store::active_definition(&f.host.lock().unwrap().journal.0,&c.definition.ghost_id).unwrap().unwrap(),c.definition);
}

fn native_sdk_primary_shared_profile(f:&MemoryBotFixture,primary:&str) {
    let bot=&f.c.definition.ghost_id;
    let before=crate::adapters::memory::Brain::context_revision(bot).unwrap();
    let path=PathBuf::from(std::env::var_os("GHOST_BRAIN_BINDINGS").unwrap());
    let mut bindings:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(bindings["owners"][primary].is_null(),"fixture primary must not inherit an existing wider binding");
    let shared=bindings["owners"][bot].as_array().unwrap().iter().filter(|binding|binding["id"]=="shared").cloned().collect::<Vec<_>>();
    assert_eq!(shared.len(),1);assert_eq!(shared[0]["kind"],"shared");assert_eq!(shared[0]["capabilities"],json!(["read"]));assert_eq!(shared[0]["spaces"],json!(["common"]));
    bindings["owners"][primary]=json!(shared);fs::write(&path,serde_json::to_vec(&bindings).unwrap()).unwrap();
    assert_eq!(crate::adapters::memory::Brain::context_revision(bot).unwrap(),before,"adding a distinct shared reader changed the source bot authority");
    let policy=f.host.action(crate::control::api::Action {
        request_id:uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL,format!("a19-primary-shared-read-policy:{primary}").as_bytes()).to_string(),
        command:crate::control::api::Command::Workspace{action:crate::control::api::OwnerAction::Policy {
            profile_id:primary.into(),policy:crate::domain::Policy{memory:true,..Default::default()},
        }},
    }).unwrap();assert_eq!(policy["ok"],true);
    let configured=owner(&f.host,"a19-primary-shared-read-profile",json!({"method":"work.memory.profile.configure","ghost_id":primary,"binding_ids":["shared"],"required":false,"experience_space_id":null}),None);
    let pin:RevisionRef=serde_json::from_value(configured["profile_ref"].clone()).unwrap();
    let state=f.host.lock().unwrap();let profile=host::work_memory::resolve_definition_profile(&state.journal.0,primary,&pin).unwrap();
    assert_eq!(profile.owner,primary);assert!(!profile.required);assert!(profile.experience_space.is_none());
    let actual=crate::adapters::memory::Brain::work_profile(primary,&["shared".into()]).unwrap();
    assert_eq!(profile.profile.as_ref(),Some(&actual));assert_eq!(actual.bindings.len(),1);assert_eq!(actual.bindings[0].id,"shared");assert_eq!(actual.bindings[0].spaces,vec!["common"]);
    assert_eq!(actual.bindings,crate::adapters::memory::Brain::work_profile(bot,&["shared".into()]).unwrap().bindings);
}

#[tokio::test]
async fn a19_existing_primary_shared_only_profile_is_explicit_without_changing_bot_authority() {
    let f=memory_update_active().await;
    let primary:String=f.host.lock().unwrap().journal.0.query_row("SELECT ghost_id FROM lifetime_registry WHERE kind='primary'",[],|row|row.get(0)).unwrap();
    let before=pi_effect_rows(&f.host);
    native_sdk_primary_shared_profile(&f,&primary);
    assert_eq!(pi_effect_rows(&f.host),before,"shared read metadata provisioning must not execute Work effects");
    assert_eq!(bots_store::active_definition(&f.host.lock().unwrap().journal.0,&f.c.definition.ghost_id).unwrap().unwrap(),f.c.definition);
}

async fn native_source_stage(parent: &Path) {
    let binary = PathBuf::from(
        std::env::var_os("GHOST_OXIBRAIN_TEST_BINARY").expect("explicit native binary"),
    );
    let mut f = memory_update_active().await;
    if std::env::var("GHOST_A19_SOURCE_MODE").as_deref()==Ok("native-sdk") {
        // Preserve this disposable original even on a failed SDK/native stage.
        // Only its path is logged; credential files remain private in the root.
        f.root.disable_cleanup(true);
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(f.root.path(),fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!("A19 native SDK original fixture root: {}",f.root.path().display());
    }
    f._environment.capture_extra(&["OXIBRAIN_MODELS_DIR"]);
    std::env::set_var("OXIBRAIN_MODELS_DIR", parent.join("isolated-empty-models"));
    let primary: String = {
        let s = f.host.lock().unwrap();
        s.journal
            .0
            .query_row(
                "SELECT ghost_id FROM lifetime_registry WHERE kind='primary'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    let c = native_adopt_procedure(&f,&primary);
    finish(&f.host, &c).await;
    f.c = c;
    let directory = parent.join("native-original");
    native_cli(
        &binary,
        &directory,
        &["admin", "init", "--space", "fixture-space"],
    );
    native_cli(&binary, &directory, &["admin", "init", "--space", "common"]);
    let (own_id, own) = native_token(&binary, &directory, "fixture-space", "read,ingest");
    let (read_id, read) = native_token(&binary, &directory, "common", "read");
    let (write_id, write) = native_token(&binary, &directory, "common", "read,ingest");
    std::env::set_var("GHOST_BRAIN_EXECUTABLE", &binary);
    std::env::set_var("GHOST_BRAIN_DIR", &directory);
    std::env::set_var("GHOST_BRAIN_TOKEN_OWN_FIXTURE", &own);
    std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", &read);
    let mut client = oxibrain_client::BrainClient::spawn_local_with_token(
        oxibrain_client::LocalProcessEndpoint::new(&binary, &directory),
        &write,
    )
    .await
    .unwrap();
    let ingested = client
        .ingest(
            "A19_NATIVE_SOURCE_MARKER original measured source facts.",
            "common",
            "a19-source/revision-1",
        )
        .await
        .unwrap();
    let episode = ingested
        .strip_prefix("Ingested as episode: ")
        .expect("native ingest receipt has an exact episode identity")
        .split_whitespace().next().unwrap()
        .to_owned();
    assert_eq!(episode.len(),64);
    assert!(episode.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    client.close().await.unwrap();
    let documents = parent.join("documents-original");
    let page_id = uuid::Uuid::now_v7().to_string();
    let space = crate::adapters::documents::Space {
        id: "a19-documents".into(),
        name: "A19 source vault".into(),
        path: documents.clone(),
        writable: true,
        profiles: vec![f.c.definition.ghost_id.clone()],
    };
    let page = crate::adapters::documents::create(
        &space,
        &page_id,
        "Original source document",
        "A19_PDC_SOURCE_MARKER original durable source bytes.\n",
        "pdc-markdown/1",
        "2026-10-24T00:00:00.000Z",
    )
    .unwrap();
    fs::write(
        directory.join("documents.toml"),
        format!(
            "[[root]]\nalias = \"a19-source\"\npath = {}\nspace = \"common\"\n",
            serde_json::to_string(documents.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    let mut sdk=if std::env::var("GHOST_A19_SOURCE_MODE").as_deref()==Ok("native-sdk") {
        native_sdk_primary_shared_profile(&f,&primary);
        Some(actual_sdk::NativeSdk::start(&mut f.host,&f.c,None))
    }else{None};
    let mut works = vec![];
    for revision in [2, 3] {
        let pin = configure(
            &f.host,
            &f.c,
            revision - 1,
            &format!("a19-native-profile-{revision}"),
        );
        let c = update(
            &f.host,
            &f.c,
            pin,
            &format!("a19-native-definition-{revision}"),
        );
        finish(&f.host, &c).await;
        f.c = c;
        if let Some(sdk)=sdk.as_mut(){sdk.start_driver(&f.host);}
        works.push(
            accepted_work(
                &f.host,
                &f.c,
                &format!("a19-original-work-{revision}"),
                &episode,
                &page_id,
                &page.hash,
                revision==2,
                sdk.as_ref(),
            )
            .await,
        );
        if let Some(sdk)=sdk.as_mut(){sdk.pause_driver(&f.host).await;}
    }
    let parked=if let Some(sdk)=sdk.as_mut(){sdk.pause_driver(&f.host).await;Some(sdk.park(&f.host,&f.c,&primary).await)}else{None};
    let pi_history = if sdk.is_some(){actual_sdk::snapshot(&f.host,&f.c)}else{history(&f.host.root.join("memory-pi"), &f.c, 1, "seed")};
    let native = f.host.native_computers.as_ref().unwrap();
    let computer = native.pi_computer(&f.c.definition.ghost_id).unwrap();
    let relative_home=works[0]["home_relative"].as_str().expect("Owner fixture preference was seeded under the first real Work lease");
    assert_eq!(fs::read(f.host.root.join(relative_home)).unwrap(),b"original Ghost home preference");
    {
        let s = f.host.lock().unwrap();
        s.journal
            .put("meta", "workspace_id", &uuid::Uuid::new_v4().to_string())
            .unwrap();
    }
    let objects = immutable_objects(&f.host);
    let backup = parent.join("native-backup");
    let data = json!({"owner_pid":std::process::id(),"host_root":f.host.root,"primary":primary,"computers":[native.pi_computer(&primary).unwrap(),computer],"candidate":f.c,"works":works,"objects":objects,"effects":pi_effect_rows(&f.host),"episode_id":episode,"document_id":page_id,"document_hash":page.hash,"document_bytes":fs::read(documents.join(&page.locator)).unwrap(),"documents_root":documents,"native_root":directory,"native_backup":backup,"old_token_ids":[own_id,read_id,write_id],"source_episodes":episode_rows(&directory),"history":pi_history,"home_relative":relative_home,"sdk_origin":sdk.as_ref().map(|s|s.origin()),"sdk_parked":parked});
    fs::write(
        f.host.root.join("a19-broker-credential.json"),
        b"A19_EXCLUDED_BROKER_SECRET",
    )
    .unwrap();
    if let Some(sdk)=sdk.as_ref(){sdk.clean();}
    f.host.shutdown().await.unwrap();
    drop(sdk);
    let MemoryBotFixture {
        root,
        host,
        _environment,
        ..
    } = f;
    drop(host);
    native_cli(
        &binary,
        &directory,
        &[
            "admin",
            "backup",
            "--no-projection",
            "--no-cache",
            "--out",
            backup.to_str().unwrap(),
        ],
    );
    let package=parent.join("native-backup-package");fs::create_dir(&package).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&package,fs::Permissions::from_mode(0o700)).unwrap();
    let archive=package.join("native-backup.tar");
    let packed=recovery_artifact_cli(parent,&["pack-native-backup","--source",backup.to_str().unwrap(),"--destination",archive.to_str().unwrap()]);
    let mut data=data;data["native_backup_original"]=json!(backup);data["native_backup"]=json!(package);data["native_backup_archive_sha256"]=packed["archive_sha256"].clone();
    drop(_environment);
    let _preserved = root.keep();
    fs::write(
        parent.join("source.json"),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();
}

fn episode_rows(directory: &Path) -> Vec<Vec<Value>> {
    let conn = rusqlite::Connection::open_with_flags(
        directory.join("brain.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut q = conn.prepare("SELECT * FROM episodes ORDER BY id").unwrap();
    let width = q.column_count();
    q.query_map([], |row| {
        let mut values = Vec::new();
        for i in 0..width {
            values.push(match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(v) => json!(v),
                rusqlite::types::ValueRef::Real(v) => json!(v),
                rusqlite::types::ValueRef::Text(v) => json!(String::from_utf8(v.to_vec()).unwrap()),
                rusqlite::types::ValueRef::Blob(v) => {
                    json!({"blob":v.iter().map(|b|format!("{b:02x}")).collect::<String>()})
                }
            });
        }
        Ok(values)
    })
    .unwrap()
    .collect::<Result<Vec<_>, _>>()
    .unwrap()
}
fn registry_request(
    registry: &mut crate::computers::ComputerRegistry,
    ghost: &str,
    epoch: u64,
    body: Value,
    revision: Option<u64>,
) -> crate::lifetime_contract::Response {
    let mut e = env(&uuid::Uuid::new_v4().to_string(), body);
    e.actor_ref = ghost.into();
    e.authority_epoch = epoch;
    e.expected_revision = revision;
    let response = registry.handle(&e, ghost).unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    response
}
fn held_registry_leases(root:&Path)->Vec<Value> {
    let db=Connection::open_with_flags(root.join("computer-registry.sqlite3"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut q=db.prepare("SELECT computer_id,execution_id,kind,epoch,state FROM computer_leases WHERE state IN ('active','revoked') ORDER BY computer_id,execution_id,kind").unwrap();
    q.query_map([],|r|Ok(json!({"computer_id":r.get::<_,String>(0)?,"execution_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"epoch":r.get::<_,u64>(3)?,"state":r.get::<_,String>(4)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
}
// Disposable controlled-fixture operator reconciliation only. Callers prove
// owned source shutdown and identify the exact original reservation first.
fn release_controlled_parked_pair(registry:&mut crate::computers::ComputerRegistry,root:&Path,ghost:&str,computer:&str,execution:&str,revision:u64)->Value {
    let held=held_registry_leases(root);
    assert_eq!(held,json!([
        {"computer_id":computer,"execution_id":execution,"kind":"collect","epoch":1,"state":"active"},
        {"computer_id":computer,"execution_id":execution,"kind":"process","epoch":1,"state":"active"}
    ]).as_array().unwrap().clone(),"only the exact parked controlled pair may be reconciled");
    let mut receipts=vec![];
    for kind in ["process","collect"] {
        let id=uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL,format!("a19-restored-controlled-cleanup:{ghost}:{computer}:{execution}:{kind}:1").as_bytes()).to_string();
        let mut command=env(&id,json!({"method":"release","computer_id":computer,"execution_id":execution,"kind":kind}));
        command.actor_ref=ghost.into();command.authority_epoch=1;command.expected_revision=Some(revision);
        let response=registry.handle(&command,ghost).unwrap();assert_eq!(response.status,ResponseStatus::Success);assert_eq!(response.data["released"],true);
        assert_eq!(serde_json::to_value(registry.handle(&command,ghost).unwrap()).unwrap(),serde_json::to_value(&response).unwrap(),"operator cleanup must retain its exact original command receipt");
        receipts.push(json!({"command_id":id,"epoch":1,"execution_id":execution,"kind":kind,"result":response}));
    }
    assert!(held_registry_leases(root).is_empty());
    let db=Connection::open_with_flags(root.join("computer-registry.sqlite3"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let retained:u64=db.query_row("SELECT COUNT(*) FROM computer_leases WHERE computer_id=?1 AND execution_id=?2 AND epoch=1 AND kind IN ('process','collect') AND state='released'",params![computer,execution],|r|r.get(0)).unwrap();assert_eq!(retained,2);
    json!({"scope":"controlled disposable fixture cleanup after verified source closure; no physical/operator restore acceptance","before":held,"receipts":receipts,"retained_released_rows":retained})
}
#[tokio::test]
async fn a19_controlled_parked_lease_cleanup_requires_exact_pair_before_epoch_rebind() {
    let f=host_fixture();let native=f.host.native_computers.as_ref().unwrap();
    let computer=native.pi_computer(&f.ghost).unwrap();
    let original_execution=format!("{:x}",Sha256::digest(b"a19-original-parked-execution"));let execution=original_execution.as_str();
    let fresh_execution=format!("{:x}",Sha256::digest(b"a19-fresh-execution"));
    native.pi_acquire(&f.ghost,execution,1,"public").unwrap();
    let root=f.host.root.join("registry");let mut registry=crate::computers::ComputerRegistry::open(&root).unwrap();
    let facts=crate::computers::RuntimeFacts::new("a19-controlled-test", "a".repeat(64)).unwrap();
    registry.register_native_worker_backend_with_runtime(crate::computers::NativeWorkerBackendFacts{configured:true,available:true},vec!["persistent_filesystem".into(),"shell".into()],Some(facts.clone())).unwrap();
    let inspected=registry_request(&mut registry,&f.ghost,1,json!({"method":"inspect","computer_id":computer}),None);
    let mut binding:crate::lifetime_contract::ComputerBinding=serde_json::from_value(inspected.data["binding"].clone()).unwrap();let revision=binding.grant_revision;
    binding.epoch=2;binding.grant_revision+=1;
    let mut rebind=env("a19-controlled-active-rebind",json!({"method":"bind","binding":binding}));rebind.actor_ref=f.ghost.clone();rebind.expected_revision=Some(revision);
    let denied=registry.handle(&rebind,&f.ghost).unwrap();assert_eq!(denied.error_code.as_deref(),Some("leases_active"));
    let receipt=release_controlled_parked_pair(&mut registry,&root,&f.ghost,&computer,execution,revision);assert_eq!(receipt["retained_released_rows"],2);
    registry_request(&mut registry,&f.ghost,1,json!({"method":"bind","binding":binding}),Some(revision));
    registry_request(&mut registry,&f.ghost,2,json!({"method":"accept_runtime","computer_id":computer,"runtime":facts}),Some(revision+1));
    assert!(registry.acquire_worker_home(&computer,&f.ghost,execution,2).is_err(),"an old released reservation cannot be resurrected under epoch2");
    registry.acquire_worker_home(&computer,&f.ghost,&fresh_execution,2).unwrap();
}
fn accept_controlled_computers(host: &Host, source: &Value, cleanup_proof:Option<&Value>) -> Value {
    // This declares the controlled host fixture, never an Apple/probed runtime.
    let mut registry =
        crate::computers::ComputerRegistry::open(&host.root.join("registry")).unwrap();
    let facts = crate::computers::RuntimeFacts::new(
        "a19-controlled-host",
        format!(
            "{:x}",
            Sha256::digest(fs::read(std::env::current_exe().unwrap()).unwrap())
        ),
    )
    .unwrap();
    registry
        .register_native_worker_backend_with_runtime(
            crate::computers::NativeWorkerBackendFacts {
                configured: true,
                available: true,
            },
            vec!["persistent_filesystem".into(), "shell".into()],
            Some(facts.clone()),
        )
        .unwrap();
    assert!(!registry.dispatch_ready_computers(2).unwrap().is_empty());
    let cleanup=if let Some(proof)=cleanup_proof {
        assert_eq!(proof["verified_stopped_owner_pid"],source["owner_pid"]);assert_eq!(proof["source_quarantined"],true);assert_eq!(proof["old_credentials_revoked"],true);
        let quarantined=PathBuf::from(proof["quarantined_host"].as_str().unwrap());
        let original_leases=held_registry_leases(&quarantined.join("registry"));
        let parked=&source["sdk_parked"];let context=&parked["context"];let work=parked["work_id"].as_str().unwrap();let ghost=context["ghost_id"].as_str().unwrap();let execution=context["execution_id"].as_str().unwrap();
        let computer=original_leases.first().unwrap()["computer_id"].as_str().unwrap().to_owned();
        let before_effects=pi_effect_rows(host);
        let (before_work,before_context,before_claim)={let state=host.lock().unwrap();let db=&state.journal.0;
            assert_eq!(db.query_row("SELECT COUNT(*) FROM lifetime_pi_effects WHERE state<>'complete'",[],|r|r.get::<_,u64>(0)).unwrap(),0,"unconfirmed effects prohibit fixture lease reconciliation");
            let work_raw:String=db.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[work],|r|r.get(0)).unwrap();let saved:Work=serde_json::from_str(&work_raw).unwrap();assert_eq!(saved.state,"blocked");assert_eq!(saved.execution_id.as_deref(),Some(execution));assert!(saved.blocker.as_ref().unwrap().starts_with("wait_for:"));
            let context_raw:String=db.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND id=?1",[context["assignment_id"].as_str().unwrap()],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Value>(&context_raw).unwrap(),*context);
            let claim_raw:String=db.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_claim_v1' AND id=?1",[context["reference"].as_str().unwrap()],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Value>(&claim_raw).unwrap(),parked["claim"]);
            (work_raw,context_raw,claim_raw)
        };
        let db=Connection::open_with_flags(host.root.join("registry/computer-registry.sqlite3"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM computer_browser_instances",[],|r|r.get::<_,u64>(0)).unwrap(),0,"this controlled fixture has no physical/browser instance to assume stopped");
        let inspected=registry_request(&mut registry,ghost,1,json!({"method":"inspect","computer_id":computer}),None);let binding:crate::lifetime_contract::ComputerBinding=serde_json::from_value(inspected.data["binding"].clone()).unwrap();assert_eq!(binding.host_id,"pi-fixture-host");
        assert_eq!(held_registry_leases(&host.root.join("registry")),original_leases);
        let receipt=release_controlled_parked_pair(&mut registry,&host.root.join("registry"),ghost,&computer,execution,binding.grant_revision);
        assert_eq!(held_registry_leases(&quarantined.join("registry")),original_leases,"captured original parked reservations must remain untouched");
        assert_eq!(pi_effect_rows(host),before_effects);
        let state=host.lock().unwrap();let db=&state.journal.0;
        assert_eq!(db.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[work],|r|r.get::<_,String>(0)).unwrap(),before_work);
        assert_eq!(db.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND id=?1",[context["assignment_id"].as_str().unwrap()],|r|r.get::<_,String>(0)).unwrap(),before_context);
        assert_eq!(db.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_claim_v1' AND id=?1",[context["reference"].as_str().unwrap()],|r|r.get::<_,String>(0)).unwrap(),before_claim);
        Some(json!({"proof":proof,"reconciliation":receipt}))
    }else{None};
    for id in source["computers"].as_array().unwrap() {
        let id = id.as_str().unwrap();
        let ghost = {
            let conn =
                rusqlite::Connection::open(host.root.join("registry/computer-registry.sqlite3"))
                    .unwrap();
            let raw: String = conn
                .query_row(
                    "SELECT payload FROM computer_bindings WHERE computer_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            serde_json::from_str::<Value>(&raw).unwrap()["ghost_id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let prior = registry_request(
            &mut registry,
            &ghost,
            1,
            json!({"method":"inspect","computer_id":id}),
            None,
        );
        let mut binding: crate::lifetime_contract::ComputerBinding =
            serde_json::from_value(prior.data["binding"].clone()).unwrap();
        let revision = binding.grant_revision;
        binding.epoch = 2;
        binding.grant_revision += 1;
        registry_request(
            &mut registry,
            &ghost,
            1,
            json!({"method":"bind","binding":binding}),
            Some(revision),
        );
        registry_request(
            &mut registry,
            &ghost,
            2,
            json!({"method":"accept_runtime","computer_id":id,"runtime":facts}),
            Some(revision + 1),
        );
    }
    assert!(registry.dispatch_ready_computers(2).unwrap().is_empty());
    json!(cleanup)
}
fn install_current_fixture(host: &mut Host, source: &Value) {
    let primary = source["primary"].as_str().unwrap();
    let mut native = host::lifetime_computers::NativeComputers::pi_fixture_at(
        &host.root.join("registry"),
        primary,
        2,
    )
    .unwrap();
    native.pi_fixture_allow_private(primary).unwrap();
    {
        let state = host.lock().unwrap();
        native
            .restore_provisioned_pi_routes(&state.journal.0, &state.profiles)
            .unwrap();
    }
    host.native_computers = Some(native);
    host.pi_local_route = Some(host::lifetime_runtime::LocalPiRoute {
        base_url: "http://127.0.0.1:9/v1".into(),
        model_id: "fixture".into(),
        max_output_tokens: 1024,
        callback_token: "fixture".into(),
    });
    host.dispatch_enabled = true;
}
fn pi_effect_rows(host: &Host) -> Vec<Vec<Value>> {
    let state=host.lock().unwrap();
    let mut query=state.journal.0.prepare("SELECT * FROM lifetime_pi_effects ORDER BY execution_id,task_id,call_id").unwrap();
    let width=query.column_count();
    query.query_map([],|row| {
        let mut values=Vec::new();
        for i in 0..width {
            values.push(match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null=>Value::Null,
                rusqlite::types::ValueRef::Integer(v)=>json!(v),
                rusqlite::types::ValueRef::Real(v)=>json!(v),
                rusqlite::types::ValueRef::Text(v)=>json!(std::str::from_utf8(v).unwrap()),
                rusqlite::types::ValueRef::Blob(_)=>panic!("unexpected Pi receipt blob"),
            });
        }
        Ok(values)
    }).unwrap().collect::<Result<Vec<_>,_>>().unwrap()
}
fn assert_original_pi_effects_preserved(host:&Host,source:&Value) {
    let current=pi_effect_rows(host);
    for original in source["effects"].as_array().unwrap() {
        let original:Vec<Value>=serde_json::from_value(original.clone()).unwrap();
        assert!(current.contains(&original),"an original Pi effect receipt was lost or rewritten");
    }
}
async fn old_effect_denied(host: &Host, source: &Value) {
    let effects_before=pi_effect_rows(host);
    let dispatch=host.lock().unwrap().journal.0.query_row("SELECT dispatch_enabled FROM lifetime_authority WHERE singleton=1",[],|row|row.get::<_,bool>(0)).unwrap();
    for record in source["works"].as_array().unwrap() {
        let original: lifetime::PiToolRequest =
            serde_json::from_value(record["replay"].clone()).unwrap();
        let result = host
            .lifetime_pi_execution_action(&original, lifetime::PiInferenceScope::Local)
            .await.unwrap();
        // The memory effect guard precedes epoch ingress; this proves revoked
        // disclosure safety, separately from the isolated epoch checks below.
        assert_eq!(result.status,ResponseStatus::Error,"{result:?}");
        assert_eq!(result.error_code.as_deref(),Some("disclosure_blocked"),"{result:?}");
        let mut forged = original.clone();
        forged.envelope.authority_epoch = 2;
        forged.envelope.command_id = format!(
            "a19-forged-current-{}",
            record["work"]["id"].as_str().unwrap()
        );
        let result = host
            .lifetime_pi_execution_action(&forged, lifetime::PiInferenceScope::Local)
            .await.unwrap();
        assert_eq!(result.status,ResponseStatus::Error,"{result:?}");
        assert_eq!(result.error_code.as_deref(),Some("disclosure_blocked"),"{result:?}");
        let mut inference=original;
        inference.envelope.body=json!({"method":"inference.inspect","assignment_id":inference.envelope.body["assignment_id"],"work_id":inference.envelope.body["work_id"]});
        inference.envelope.payload_digest=canonical_digest(&inference.envelope.body).unwrap();
        inference.envelope.command_id=format!("a19-old-inference-{}",record["work"]["id"].as_str().unwrap());
        let denied=host.lifetime_pi_action(&inference,lifetime::PiInferenceScope::Public).await.unwrap();
        assert_eq!(denied["result"]["error_code"],"authority_fenced","{denied}");
        inference.envelope.authority_epoch=2;
        inference.envelope.command_id=format!("a19-forged-inference-{}",record["work"]["id"].as_str().unwrap());
        let denied=host.lifetime_pi_action(&inference,lifetime::PiInferenceScope::Public).await.unwrap();
        assert_eq!(denied["result"]["error_code"],if dispatch {"execution_context_fenced"} else {"dispatch_off"},"{denied}");
    }
    assert_eq!(pi_effect_rows(host),effects_before,"denied replay changed an original effect receipt");
}
fn owner_artifact(host: &Host, record: &Value, id: &str) {
    let a = &record["artifact"];
    let w = &record["work"];
    let data = owner(
        host,
        id,
        json!({"method":"work.artifact","work_id":w["id"],"execution_id":w["execution_id"],"digest":a["digest"],"locator":a["locator"]}),
        None,
    );
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, record["expected"].as_str().unwrap().as_bytes());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit GHOST_OXIBRAIN_TEST_BINARY; distinct-root disposable native restore, no network model or physical runtime"]
async fn a19_native_distinct_root_restore_explicit_adoption_and_new_accepted_work() {
    native_distinct_root_restore(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit native binaries; actual production SDK/Host/driver plus distinct-root native restore; controlled loopback inference and fixture computer only"]
async fn a19_actual_sdk_native_distinct_root_restore_fences_old_generation_and_accepts_new_work() {
    native_distinct_root_restore(true).await;
}
async fn native_distinct_root_restore(actual_sdk: bool) {
    let binary = PathBuf::from(
        std::env::var_os("GHOST_OXIBRAIN_TEST_BINARY").expect("explicit isolated native binary"),
    )
    .canonicalize()
    .unwrap();
    let parent = if let Some(path) = std::env::var_os("GHOST_A19_OUTPUT_DIR") {
        let p = PathBuf::from(path);
        fs::create_dir(&p).expect("A19 output root must be absent");
        p.canonicalize().unwrap()
    } else {
        tempfile::tempdir().unwrap().keep().canonicalize().unwrap()
    };
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&parent,fs::Permissions::from_mode(0o700)).unwrap();
    let binary_hash = format!("{:x}", Sha256::digest(fs::read(&binary).unwrap()));
    let (pid, source) = spawn_source(&parent, if actual_sdk {"native-sdk"}else{"native"});
    let original = PathBuf::from(source["host_root"].as_str().unwrap());
    let c: Candidate = serde_json::from_value(source["candidate"].clone()).unwrap();
    let bundle = parent.join("bundle");
    recovery_bundle::create_bundle(&bundle_request(&source, pid), &bundle).unwrap();
    assert_eq!(
        recovery_bundle::verify_bundle(&bundle).unwrap()["complete"],
        true
    );
    let report =
        recovery_bundle::restore_bundle(&bundle, &parent.join("restored-generation")).unwrap();
    assert_eq!(report.restored_authority_epoch, 2);
    assert!(!report.dispatch_enabled);
    let restored = report.restored_roots["host"].clone();
    let docs = report.restored_roots["documents"].clone();
    for (field, name) in [
        ("host_root", "quarantined-host"),
        ("native_root", "quarantined-engine"),
        ("documents_root", "quarantined-documents"),
        ("native_backup_original", "quarantined-native-backup"),
        ("native_backup", "quarantined-native-package"),
    ] {
        let path = PathBuf::from(source[field].as_str().unwrap());
        fs::rename(&path, parent.join(name)).unwrap();
        assert!(!path.exists(), "original root still reachable");
    }
    let captured_archive=report.restored_roots["native-backup"].join("native-backup.tar");
    assert_eq!(format!("{:x}",Sha256::digest(fs::read(&captured_archive).unwrap())),source["native_backup_archive_sha256"]);
    let manifest:Value=serde_json::from_slice(&fs::read(bundle.join("manifest.json")).unwrap()).unwrap();
    assert!(manifest["entries"].as_array().unwrap().iter().any(|entry|entry["root_label"]=="native-backup" && entry["path"]=="native-backup.tar" && entry["sha256"]==source["native_backup_archive_sha256"]));
    let detached_backup=parent.join("restored-detached-backup");
    recovery_artifact_cli(&parent,&["unpack-native-backup","--archive",captured_archive.to_str().unwrap(),"--sha256",source["native_backup_archive_sha256"].as_str().unwrap(),"--destination",detached_backup.to_str().unwrap()]);
    let engine = parent.join("restored-engine");
    native_cli(
        &binary,
        &engine,
        &[
            "admin",
            "restore",
            detached_backup.to_str().unwrap(),
        ],
    );
    assert_eq!(
        serde_json::to_value(episode_rows(&engine)).unwrap(),
        source["source_episodes"]
    );
    let (_, mut environment, _, _) =
        crate::adapters::memory::tests::scoped_fixture(&parent, &c.definition.ghost_id).await;
    environment.capture_extra(&[
        "OXIBRAIN_MODELS_DIR",
        "GHOST_PI_ARTIFACT_RELOCATION_FILE",
        "GHOST_LIFETIME_MODE",
        "GHOST_PI_COMPUTERS_CONFIG",
        "GHOST_LIFETIME_NATIVE_WORKERS_CONFIG",
        "GHOST_LIFETIME_LOCAL_MODEL_URL",
        "GHOST_LIFETIME_LOCAL_MODEL_ID",
        "GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS",
    ]);
    for key in [
        "GHOST_LIFETIME_MODE",
        "GHOST_PI_COMPUTERS_CONFIG",
        "GHOST_LIFETIME_NATIVE_WORKERS_CONFIG",
        "GHOST_LIFETIME_LOCAL_MODEL_URL",
        "GHOST_LIFETIME_LOCAL_MODEL_ID",
        "GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS",
    ] {
        std::env::remove_var(key);
    }
    std::env::set_var("OXIBRAIN_MODELS_DIR", parent.join("no-models"));
    std::env::set_var("GHOST_BRAIN_EXECUTABLE", &binary);
    std::env::set_var("GHOST_BRAIN_DIR", &engine);
    std::env::set_var("GHOST_BRAIN_BINDINGS", restored.join("bindings.json"));
    std::env::remove_var("GHOST_BRAIN_TOKEN_OWN_FIXTURE");
    std::env::remove_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE");
    let mut host = Host::open(&restored, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    assert_eq!(
        serde_json::to_value(immutable_objects(&host)).unwrap(),
        source["objects"]
    );
    assert_eq!(serde_json::to_value(pi_effect_rows(&host)).unwrap(),source["effects"]);
    assert_eq!(
        bots_store::active_definition(&host.lock().unwrap().journal.0, &c.definition.ghost_id)
            .unwrap()
            .unwrap(),
        c.definition
    );
    assert_eq!(
        host::bots_memory::definition_current(&host.lock().unwrap().journal.0, &c.definition)
            .unwrap_err().to_string(),
        "memory binding credential is unavailable"
    );
    old_effect_denied(&host, &source).await;
    let workspace: String = host
        .lock()
        .unwrap()
        .journal
        .get("meta", "workspace_id")
        .unwrap()
        .unwrap();
    let mapping = crate::operations::pi_artifact_relocation::PiArtifactRelocation {
        version: "ghost-pi-artifact-relocation/1".into(),
        workspace_id: workspace,
        authority_epoch: 2,
        bundle_manifest_sha256: format!(
            "{:x}",
            Sha256::digest(fs::read(bundle.join("manifest.json")).unwrap())
        ),
        bundle_path: bundle.canonicalize().unwrap(),
        host_root_label: "host".into(),
        source_pi_root: original.join("pi-execution"),
        destination_pi_root: restored.join("pi-execution"),
    };
    let mapping_file = parent.join("pi-artifacts.json");
    write_mapping(&mapping_file, &mapping);
    std::env::set_var("GHOST_PI_ARTIFACT_RELOCATION_FILE", &mapping_file);
    for (i, record) in source["works"].as_array().unwrap().iter().enumerate() {
        owner_artifact(&host, record, &format!("a19-quarantine-owner-read-{i}"));
    }
    assert_eq!(
        if actual_sdk{actual_sdk::snapshot(&host,&c)}else{history(&restored.join("memory-pi"), &c, 2, "inspect")},
        source["history"]
    );
    assert_eq!(
        fs::read(restored.join(source["home_relative"].as_str().unwrap())).unwrap(),
        b"original Ghost home preference"
    );
    assert_eq!(
        fs::read(docs.join(format!("{}.md", source["document_id"].as_str().unwrap()))).unwrap(),
        serde_json::from_value::<Vec<u8>>(source["document_bytes"].clone()).unwrap()
    );
    assert!(!restored.join("a19-broker-credential.json").exists());
    assert!(!restored.join("brain/grants.json").exists());
    for id in source["old_token_ids"].as_array().unwrap() {
        native_cli(
            &binary,
            &engine,
            &["admin", "token", "revoke", id.as_str().unwrap()],
        );
    }
    let (_, own) = native_token(&binary, &engine, "fixture-space", "read,ingest");
    let (_, read) = native_token(&binary, &engine, "common", "read");
    std::env::set_var("GHOST_BRAIN_TOKEN_OWN_FIXTURE", &own);
    std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", &read);
    fs::write(
        engine.join("documents.toml"),
        format!(
            "[[root]]\nalias = \"a19-source\"\npath = {}\nspace = \"common\"\n",
            serde_json::to_string(docs.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    let mut client = oxibrain_client::BrainClient::spawn_local_with_token(
        oxibrain_client::LocalProcessEndpoint::new(&binary, &engine),
        &read,
    )
    .await
    .unwrap();
    let proof = client
        .document_source_proof(
            "common",
            source["document_id"].as_str().unwrap(),
            source["document_hash"].as_str().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proof.canonical_root, docs.to_str().unwrap());
    assert_eq!(proof.document_uuid, source["document_id"]);
    assert_eq!(proof.source_sha256, source["document_hash"]);
    assert!(proof.fresh);
    client.close().await.unwrap();
    // New credentials/path alone never retarget the old definition or Work grants.
    assert!(
        !host::bots_memory::definition_current(&host.lock().unwrap().journal.0, &c.definition)
            .unwrap()
    );
    let cleanup_proof=if actual_sdk {
        let quarantined=parent.join("quarantined-host");assert!(!original.exists());assert!(quarantined.is_dir());
        Some(json!({"verified_stopped_owner_pid":pid,"source_quarantined":true,"quarantined_host":quarantined,"old_credentials_revoked":true,"revoked_credential_ids":source["old_token_ids"]}))
    }else{None};
    let controlled_lease_cleanup=accept_controlled_computers(&host, &source,cleanup_proof.as_ref());
    assert_eq!(host.lock().unwrap().journal.0.execute("UPDATE lifetime_authority SET dispatch_enabled=1 WHERE singleton=1 AND authority_epoch=2 AND dispatch_enabled=0",[]).unwrap(),1);
    install_current_fixture(std::sync::Arc::get_mut(&mut host).unwrap(), &source);
    old_effect_denied(&host, &source).await;
    let mut sdk=if actual_sdk{Some(actual_sdk::NativeSdk::start(&mut host,&c,source["sdk_origin"].as_str()))}else{None};
    let sdk_denial=if let Some(sdk)=sdk.as_ref(){Some(sdk.deny_restored(&host,&c,&source).await)}else{None};
    let pin = configure(&host, &c, 3, "a19-restored-profile-v4");
    assert_ne!(
        pin,
        serde_json::to_value(c.definition.content.memory_profile_ref.as_ref().unwrap()).unwrap()
    );
    let next = update(&host, &c, pin, "a19-restored-definition");
    finish(&host, &next).await;
    if let Some(sdk)=sdk.as_mut(){sdk.start_driver(&host);}
    let fresh = accepted_work(
        &host,
        &next,
        "a19-restored-new-work",
        source["episode_id"].as_str().unwrap(),
        source["document_id"].as_str().unwrap(),
        source["document_hash"].as_str().unwrap(),
        false,
        sdk.as_ref(),
    )
    .await;
    if let Some(sdk)=sdk.as_mut(){sdk.pause_driver(&host).await;sdk.clean();}
    assert_ne!(fresh["work"]["id"], source["works"][0]["work"]["id"]);
    {
        let s = host.lock().unwrap();
        for record in source["works"].as_array().unwrap() {
            let w: Work = serde_json::from_value(record["work"].clone()).unwrap();
            assert_eq!(
                raw_grant_no_lock(&s.journal.0, &w),
                record["grant"].as_str().unwrap()
            );
            assert_eq!(
                serde_json::to_value(bots_store::definition_for_work(&s.journal.0, &w).unwrap())
                    .unwrap(),
                record["definition"]
            );
        }
        assert_eq!(
            s.journal
                .0
                .query_row(
                    "SELECT count(*) FROM lifetime_registry WHERE kind='primary'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(s.profiles.len(), 2);
    }
    old_effect_denied(&host, &source).await;
    owner_artifact(&host, &fresh, "a19-new-owner-artifact");
    if actual_sdk {
        assert_eq!(fresh["context"]["ghost_id"],c.definition.ghost_id);
        assert_eq!(fresh["context"]["conversation_id"],c.conversation_id);
        assert_eq!(fresh["context"]["authority_epoch"],2);
        for old in source["works"].as_array().unwrap().iter().chain(std::iter::once(&source["sdk_parked"])) {
            assert_ne!(fresh["context"]["reference"],old["context"]["reference"]);
            assert_ne!(fresh["claim"]["provider_session_id"],old["claim"]["provider_session_id"]);
            assert_ne!(fresh["claim"]["storage_ref"],old["claim"]["storage_ref"]);
        }
    }
    let final_history=if actual_sdk{Some(actual_sdk::snapshot(&host,&next))}else{None};
    if let Some(history)=final_history.as_ref() {
        actual_sdk::assert_preserved(&source["history"],history);
        for original in source["works"].as_array().unwrap().iter().chain(std::iter::once(&source["sdk_parked"])) {
            let assignment=original["context"]["assignment_id"].as_str().unwrap();
            let state=host.lock().unwrap();
            for (kind,id,expected) in [("ghost_work_context_v1",assignment,&original["context"]),("ghost_work_context_claim_v1",original["context"]["reference"].as_str().unwrap(),&original["claim"])] {
                let raw:String=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",params![kind,id],|r|r.get(0)).unwrap();
                assert_eq!(&serde_json::from_str::<Value>(&raw).unwrap(),expected,"fresh Work rewrote an old SDK context or claim");
            }
        }
    }
    assert_original_pi_effects_preserved(&host,&source);
    let final_objects = immutable_objects(&host);
    host.shutdown().await.unwrap();
    drop(sdk);
    drop(host);
    // A second cold Host open preserves committed state; no model backend is configured.
    let reopened = Host::open(&restored, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    assert_eq!(immutable_objects(&reopened), final_objects);
    assert_original_pi_effects_preserved(&reopened,&source);
    assert_eq!(
        bots_store::active_definition(
            &reopened.lock().unwrap().journal.0,
            &next.definition.ghost_id
        )
        .unwrap()
        .unwrap(),
        next.definition
    );
    old_effect_denied(&reopened, &source).await;
    owner_artifact(&reopened, &fresh, "a19-cold-current-artifact");
    assert_eq!(
        if actual_sdk{actual_sdk::snapshot(&reopened,&next)}else{history(&restored.join("memory-pi"), &next, 2, "inspect")},
        final_history.as_ref().unwrap_or(&source["history"]).clone()
    );
    reopened.shutdown().await.unwrap();
    drop(reopened);
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(&binary).unwrap())),
        binary_hash
    );
    fs::write(parent.join("result.json"),serde_json::to_vec_pretty(&json!({"status":"passed","evidence":if actual_sdk{"native Oxi/PDC + production main/SDK + real Host HTTP/existing driver + genuine parked SDK checkpoint fenced at epoch2 + new explicitly adopted accepted Work"}else{"native Oxi/PDC + stopped Host distinct-root restore + controlled callback/file-effect acceptance; separate canonical SDK history persistence only"},"limits":if actual_sdk{json!(["Controlled loopback inference and declared fixture computer only","No physical runtime, external model quality or operational acceptance"])}else{json!(["Work contexts are controlled Host claims, not actual restored SDK Work provider-session/generation continuation","No physical runtime or operational acceptance","No network model inference"])},"sdk_denial":sdk_denial,"controlled_lease_cleanup":controlled_lease_cleanup,"binary_sha256":binary_hash,"old_owner_pid":pid,"restored_epoch":2,"source":source,"new_candidate":next,"new_work":fresh,"restore_report":report})).unwrap()).unwrap();
    eprintln!(
        "A19 native controlled fixture result: {}",
        parent.join("result.json").display()
    );
}

#[tokio::test]
async fn a19_excluded_credentials_return_exact_error_and_rotation_cannot_retarget_definition() {
    let f=memory_update_active().await;
    for key in ["GHOST_BRAIN_TOKEN_OWN_FIXTURE","GHOST_BRAIN_TOKEN_SHARED_FIXTURE"] {
        let original=std::env::var(key).unwrap();
        assert!(host::bots_memory::definition_current(&f.host.lock().unwrap().journal.0,&f.c.definition).unwrap());
        std::env::remove_var(key);
        assert_eq!(host::bots_memory::definition_current(&f.host.lock().unwrap().journal.0,&f.c.definition).unwrap_err().to_string(),"memory binding credential is unavailable");
        std::env::set_var(key,"a19-explicitly-rotated-but-not-adopted-credential");
        // A present new credential changes the immutable configuration binding;
        // it does not select the new authority or trigger native validation.
        assert!(!host::bots_memory::definition_current(&f.host.lock().unwrap().journal.0,&f.c.definition).unwrap());
        assert_eq!(bots_store::active_definition(&f.host.lock().unwrap().journal.0,&f.c.definition.ghost_id).unwrap().unwrap(),f.c.definition);
        std::env::set_var(key,original);
    }
}
