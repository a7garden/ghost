// Opt-in, no-model Host capability acceptance. The controller coordinates are
// explicitly synthetic; producer execution and independent verification use
// the actual container backend and a genuine previously captured probe receipt.
mod json_compute_acceptance {
    use super::*;
    use crate::host::lifetime::producer_profiles::{self as profiles, OwnerAcceptedProfile};
    use std::path::PathBuf;

    const PROGRAM: &str = r#"import hashlib,json,sys
with open(sys.argv[1],"rb") as stream: raw=stream.read()
payload=json.loads(raw.decode("utf-8"))
encoded=json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(",",":"))
assert json.loads(encoded)==payload
result={"bytes":len(raw),"payload":payload,"sha256":hashlib.sha256(raw).hexdigest()}
with open(sys.argv[2],"w",encoding="utf-8",newline="") as stream: json.dump(result,stream,ensure_ascii=False,sort_keys=True,separators=(",",":"))
"#;
    // This independent package has no case table, producer program, Python
    // dependency or expected-answer literal. It derives the required envelope
    // directly from the immutable Owner input in its read-only compartment.
    const VERIFIER: &str = r#"set -eu
test "$HOME" = /tmp
test "$PATH" = /usr/bin:/bin
test ! -e /workspace/verifier.sh
size=$(/usr/bin/wc -c < "$1" | /usr/bin/tr -d '[:space:]')
digest=$(/usr/bin/sha256sum "$1")
digest=${digest%% *}
{ printf '{"bytes":%s,"payload":' "$size"; /bin/cat "$1"; printf ',"sha256":"%s"}' "$digest"; } > /tmp/independent-envelope.json
/usr/bin/cmp /tmp/independent-envelope.json "$2"
"#;

    fn receipt() -> OwnerAcceptedProfile {
        assert_eq!(
            std::env::var("GHOST_JSON_COMPUTE_CANARY").as_deref(),
            Ok("1")
        );
        let path = PathBuf::from(
            std::env::var_os("GHOST_JSON_COMPUTE_PROFILE_RECEIPT")
                .expect("a genuine fixed-probe profile receipt must be supplied"),
        );
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        assert!(
            path.is_absolute()
                && metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 65_536,
            "bounded regular probe receipt required"
        );
        let profile: OwnerAcceptedProfile =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(profile.runtime_facts.evidence, "owned_container_probe");
        assert_eq!(profile.runtime_facts.sandbox_uid, unsafe {
            libc::geteuid()
        });
        assert_eq!(profile.runtime_facts.sandbox_gid, unsafe {
            libc::getegid()
        });
        profile
            .runtime_facts
            .validate_for_profile(&profile.manifest)
            .unwrap();
        profile
    }
    fn cli() -> PathBuf {
        std::env::var_os("GHOST_JSON_COMPUTE_CLI")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/opt/homebrew/bin/container"))
    }
    fn select(f: &mut HostFixture, reference: &RevisionRef) {
        let mut computers = f.host.native_computers.take().unwrap();
        {
            let state = f.host.lock().unwrap();
            computers
                .select_pi_fixture_profile(&state.journal.0, &f.ghost, reference)
                .unwrap();
        }
        f.host.native_computers = Some(computers);
    }
    fn configure(f: &mut HostFixture, profile: OwnerAcceptedProfile) -> RevisionRef {
        f.host
            .native_computers
            .as_mut()
            .unwrap()
            .set_pi_fixture_cli(&cli())
            .unwrap();
        let reference = {
            let state = f.host.lock().unwrap();
            profiles::accept_config(&state.journal.0, profile).unwrap()
        };
        select(f, &reference);
        reference
    }
    fn register(f: &HostFixture) -> Value {
        let mut body = task_template_body(f, "generic-json-envelope", VERIFIER);
        let c = &mut body["content"];
        c["instructions"] = json!("Parse the immutable JSON input and compute its UTF-8 byte length and SHA256. Publish a compact JSON object containing bytes, the parsed payload, and sha256. Preserve all nested JSON values.");
        c["input_schema"] = json!({"type":["object","array"],"maxProperties":16,"maxItems":16});
        c["output_schema"] = json!({"type":"object","properties":{"bytes":{"type":"integer","minimum":0},"payload":{},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["bytes","payload","sha256"],"additionalProperties":false});
        c["input_contract"] = json!({"type":["object","array"]});
        c["output_contract"] = json!({"type":"object"});
        c["required_capabilities"] = json!(["read", "write", "bash", "publish_artifact"]);
        let registered = f
            .host
            .lifetime_action(&env("json-compute-register", body))
            .unwrap();
        assert_eq!(registered["result"]["status"], "success", "{registered}");
        registered["result"]["data"]["template_ref"].clone()
    }

    struct Controller {
        assignment: String,
        context: String,
    }
    async fn controller(f: &HostFixture, work: &Work) -> Controller {
        let assignment: String = {
            let state = f.host.lock().unwrap();
            state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&work.id],|r|r.get(0)).unwrap()
        };
        let mut inspect = env(
            &format!("json-inspect-{}", work.id),
            json!({"method":"conversation.assignment.inspect","assignment_id":assignment,"ghost_id":f.ghost,"conversation_id":f.conversation}),
        );
        inspect.actor_ref = f.ghost.clone();
        let inspected = f
            .host
            .lifetime_pi_action(
                &lifetime::PiToolRequest {
                    context_ref: None,
                    ghost_id: f.ghost.clone(),
                    conversation_id: f.conversation.clone(),
                    envelope: inspect,
                },
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(inspected["result"]["status"], "success", "{inspected}");
        let context = inspected["result"]["data"]["execution_context"]["ref"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut claim = env(
            &format!("json-controller-claim-{}", work.id),
            json!({"method":"work.context.claim","assignment_id":assignment,"work_id":work.id,"context_ref":context,"generation_task_id":7,
            "provider_session_id":uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL,format!("controlled-json-test-controller:{}",work.id).as_bytes()).to_string(),
            "storage_ref":format!("controlled-json-test-controller/{}/not-an-sdk-store",work.id)}),
        );
        claim.actor_ref = f.ghost.clone();
        let response = f
            .host
            .lifetime_pi_action(
                &lifetime::PiToolRequest {
                    context_ref: Some(context.clone()),
                    ghost_id: f.ghost.clone(),
                    conversation_id: f.conversation.clone(),
                    envelope: claim,
                },
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(response["result"]["status"], "success", "{response}");
        Controller {
            assignment,
            context,
        }
    }
    fn effect_request(
        f: &HostFixture,
        work: &Work,
        controller: &Controller,
        task: u64,
        operation: &str,
        arguments: Value,
    ) -> lifetime::PiToolRequest {
        let call = format!("json-{operation}-{task}");
        let mut envelope = env(
            &format!("json-{}-{call}", work.id),
            json!({"method":"work.execute","assignment_id":controller.assignment,"work_id":work.id,"generation_task_id":7,"task_id":task,"call_id":call,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":arguments})).unwrap(),"arguments":arguments}),
        );
        envelope.actor_ref = f.ghost.clone();
        lifetime::PiToolRequest {
            context_ref: Some(controller.context.clone()),
            ghost_id: f.ghost.clone(),
            conversation_id: f.conversation.clone(),
            envelope,
        }
    }
    async fn effect(
        f: &HostFixture,
        work: &Work,
        controller: &Controller,
        task: u64,
        operation: &str,
        args: Value,
    ) -> Response {
        let response = f
            .host
            .lifetime_pi_execution_action(
                &effect_request(f, work, controller, task, operation, args),
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        response
    }
    async fn complete(f: &HostFixture, work: &Work, controller: &Controller) {
        let mut envelope = env(
            &format!("json-complete-{}", work.id),
            json!({"method":"work.execution.complete","assignment_id":controller.assignment,"work_id":work.id,"task_id":7,"summary":"Computed, read back and published; independent verification remains separate"}),
        );
        envelope.actor_ref = f.ghost.clone();
        let response = f
            .host
            .lifetime_pi_execution_action(
                &lifetime::PiToolRequest {
                    context_ref: Some(controller.context.clone()),
                    ghost_id: f.ghost.clone(),
                    conversation_id: f.conversation.clone(),
                    envelope,
                },
                lifetime::PiInferenceScope::Public,
            )
            .await
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
        assert_eq!(response.data["verification"]["state"], "pending_review");
        f.host.advance_task_verifications().await.unwrap();
    }
    fn work_environment(f: &HostFixture, work: &Work) -> Value {
        let state = f.host.lock().unwrap();
        f.host
            .native_computers
            .as_ref()
            .unwrap()
            .pi_work_execution_environment(&state.journal.0, work)
            .unwrap()
            .unwrap()
    }
    fn work_context(f: &HostFixture, work: &Work) -> String {
        f.host.lock().unwrap().journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND json_extract(payload,'$.work_id')=?1",[&work.id],|r|r.get(0)).unwrap()
    }
    fn effect_receipts(
        f: &HostFixture,
        work: &Work,
    ) -> Vec<(u64, String, String, String, Option<String>)> {
        let state = f.host.lock().unwrap();
        let mut query=state.journal.0.prepare("SELECT task_id,call_id,input_digest,state,response_json FROM lifetime_pi_effects WHERE execution_id=(SELECT execution_id FROM lifetime_work WHERE id=?1) ORDER BY task_id,call_id").unwrap();
        let rows = query
            .query_map([&work.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    }
    fn reopen(f: HostFixture) -> HostFixture {
        let HostFixture {
            root,
            host,
            ghost,
            conversation,
        } = f;
        drop(host);
        let profiles = crate::store::list_profiles(root.path())
            .unwrap()
            .into_iter()
            .map(|name| {
                let p =
                    Host::profile(ProfileStore::open_profile(root.path(), &name).unwrap()).unwrap();
                (p.id.clone(), p)
            })
            .collect();
        let journal = Journal::open(&root.path().join("workspace.db")).unwrap();
        let mut computers = host::lifetime_computers::NativeComputers::pi_fixture(
            &root.path().join("registry"),
            &ghost,
        )
        .unwrap();
        computers.set_pi_fixture_cli(&cli()).unwrap();
        computers
            .select_pi_fixture_profile(
                &journal.0,
                &ghost,
                &profiles::selected(&journal.0, &ghost).unwrap(),
            )
            .unwrap();
        computers
            .restore_provisioned_pi_routes(&journal.0, &profiles)
            .unwrap();
        let app = Host {
            root: root.path().to_path_buf(),
            state: Mutex::new(State { profiles, journal }),
            handle: tokio::runtime::Handle::current(),
            default_model: "mock".into(),
            _lock: host::WorkspaceLock(File::create(root.path().join("test.lock")).unwrap()),
            brain: crate::adapters::memory::Brain::default(),
            computer: crate::adapters::computer::default_backend(),
            integrations: host::integrations::Connections::default(),
            workers: Mutex::new(vec![]),
            profile_workers: Mutex::new(BTreeMap::new()),
            recovery: tokio::sync::Mutex::new(()),
            stopping: AtomicBool::new(false),
            legacy_fixture_reasoning: AtomicBool::new(false),
            dispatch_enabled: true,
            pi_callback_token: "fixture-callback".into(),
            pi_local_route: None,
            authority_epoch: 1,
            native_computers: Some(computers),
        };
        HostFixture {
            root,
            host: app,
            ghost,
            conversation,
        }
    }

    async fn compute(
        f: &HostFixture,
        work: &Work,
        input: &Value,
        controller: &Controller,
        fake: bool,
    ) -> Value {
        let input_path = format!("owner-input-{}.json", canonical_digest(input).unwrap());
        let read = effect(f, work, controller, 10, "read", json!({"path":input_path})).await;
        let raw = read.data["output"]["content"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<Value>(raw).unwrap(), *input);
        assert_eq!(
            read.data["output"]["sha256"],
            format!("{:x}", Sha256::digest(raw.as_bytes()))
        );
        effect(
            f,
            work,
            controller,
            11,
            "write",
            json!({"path":"compute.py","content":PROGRAM}),
        )
        .await;
        let command=format!("exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/workspace TMPDIR=/workspace /usr/local/bin/python3 -I -S compute.py {input_path} answer.json");
        let bash = effect(
            f,
            work,
            controller,
            12,
            "bash",
            json!({"command":command,"timeout":30}),
        )
        .await;
        assert_eq!(bash.data["output"]["exit_code"], 0, "{bash:?}");
        let output = effect(
            f,
            work,
            controller,
            13,
            "read",
            json!({"path":"answer.json"}),
        )
        .await;
        let output_text = output.data["output"]["content"].as_str().unwrap();
        let output_value: Value = serde_json::from_str(output_text).unwrap();
        assert_eq!(
            output_value,
            json!({"bytes":raw.len(),"payload":input,"sha256":format!("{:x}",Sha256::digest(raw.as_bytes()))})
        );
        // A producer-written verifier file and a successful self-check cannot
        // replace the unchanged independently registered verifier package.
        effect(
            f,
            work,
            controller,
            14,
            "write",
            json!({"path":"verifier.sh","content":"exit 0\n"}),
        )
        .await;
        if fake {
            let success = effect(
                f,
                work,
                controller,
                15,
                "bash",
                json!({"command":"printf fake-success","timeout":10}),
            )
            .await;
            assert_eq!(success.data["output"]["exit_code"], 0);
            let mut wrong = output_value.clone();
            wrong["bytes"] = json!(raw.len() + 1);
            effect(
                f,
                work,
                controller,
                16,
                "write",
                json!({"path":"answer.json","content":serde_json::to_string(&wrong).unwrap()}),
            )
            .await;
        }
        let published = effect(
            f,
            work,
            controller,
            17,
            "publish_artifact",
            json!({"path":"answer.json","privacy":"public"}),
        )
        .await;
        assert_eq!(published.artifacts.len(), 1);
        if !fake {
            assert_eq!(
                published.artifacts[0].digest,
                format!("{:x}", Sha256::digest(output_text.as_bytes()))
            );
        }
        complete(f, work, controller).await;
        let state = f.host.lock().unwrap();
        let receipt:String=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind='owner_task_verification_v1' AND json_extract(payload,'$.plan.work_id')=?1",[&work.id],|r|r.get(0)).unwrap();
        let receipt: Value = serde_json::from_str(&receipt).unwrap();
        assert_eq!(receipt["state"], "complete");
        assert_eq!(receipt["passed"], !fake, "{receipt}");
        assert_ne!(
            receipt["plan"]["source_execution"],
            receipt["plan"]["verification_execution"]
        );
        assert_eq!(
            receipt["plan"]["image"],
            crate::computers::PINNED_TASK_IMAGE
        );
        assert_eq!(receipt["plan"]["interpreter"], "/bin/sh");
        assert_eq!(
            receipt["plan"]["script_sha256"],
            format!("{:x}", Sha256::digest(VERIFIER.as_bytes()))
        );
        assert_eq!(
            receipt["plan"]["input_sha256"],
            format!("{:x}", Sha256::digest(raw.as_bytes()))
        );
        let current: String = state
            .journal
            .0
            .query_row(
                "SELECT state FROM lifetime_work WHERE id=?1",
                [&work.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(current == "accepted", !fake);
        assert_eq!(
            state
                .journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        json!({"work_id":work.id,"output_sha256":published.artifacts[0].digest,"payload":output_value["payload"],"producer_program_sha256":format!("{:x}",Sha256::digest(PROGRAM.as_bytes())),"verifier_script_sha256":receipt["plan"]["script_sha256"],"accepted":!fake,"verification":receipt})
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "physical accepted JSON profile; genuine fixed-probe receipt required; no model"]
    async fn real_json_profile_two_nested_inputs_compute_publish_verify_and_cold_pin_reopen() {
        let profile = receipt();
        let mut f = host_fixture();
        f.root.disable_cleanup(true);
        eprintln!(
            "JSON compute controlled-controller/physical-producer root: {}",
            f.root.path().display()
        );
        let legacy=f.host.lifetime_action(&env("json-old-profile-work",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Keep the existing legacy producer plan","privacy":"public","acceptance_spec":{}}))).unwrap();
        assert_eq!(legacy["result"]["status"], "success");
        let old: Work = serde_json::from_value(legacy["result"]["data"]["work"].clone()).unwrap();
        let old_context = work_context(&f, &old);
        let reference = configure(&mut f, profile);
        let old_environment = work_environment(&f, &old);
        assert_eq!(
            old_environment["image_ref"],
            crate::computers::PINNED_TASK_IMAGE
        );
        let template = register(&f);
        let input1 = json!({"title":"안녕 λ ☃","optional":null,"options":{"enabled":true,"items":[false,7,{"text":"quoted \"value\"\nline"}]}});
        let input2 = json!([null,false,{"title":"München 🚲","cells":[true,-11,0,"\\literal\n"]},["终",null]]);
        assert_eq!(
            task_input(
                &f,
                "json-input-one",
                template.clone(),
                "direct",
                input1.clone()
            )["result"]["status"],
            "success"
        );
        let (_, first) = task_goal(&f, "json-input-one", "json-goal-one").await;
        let controller1 = controller(&f, &first).await;
        let first_result = compute(&f, &first, &input1, &controller1, false).await;
        let first_receipts = effect_receipts(&f, &first);
        assert_eq!(
            task_input(&f, "json-input-two", template, "direct", input2.clone())["result"]
                ["status"],
            "success"
        );
        let (_, second) = task_goal(&f, "json-input-two", "json-goal-two").await;
        let controller2 = controller(&f, &second).await;
        let pinned = work_environment(&f, &second);
        assert_eq!(pinned["profile"]["digest"], reference.digest);
        let second_context = work_context(&f, &second);
        select(&mut f, &profiles::legacy_ref().unwrap());
        f = reopen(f);
        assert_eq!(
            profiles::selected(&f.host.lock().unwrap().journal.0, &f.ghost).unwrap(),
            profiles::legacy_ref().unwrap()
        );
        assert_eq!(effect_receipts(&f, &first), first_receipts);
        assert_eq!(work_context(&f, &old), old_context);
        assert_eq!(work_environment(&f, &old), old_environment);
        assert_eq!(work_context(&f, &second), second_context);
        assert_eq!(work_environment(&f, &second), pinned);
        let second_result = compute(&f, &second, &input2, &controller2, false).await;
        assert_eq!(effect_receipts(&f, &first), first_receipts);
        assert_ne!(first.id, second.id);
        assert_ne!(
            first_result["output_sha256"],
            second_result["output_sha256"]
        );
        assert_eq!(
            first_result["producer_program_sha256"],
            second_result["producer_program_sha256"]
        );
        assert_eq!(
            first_result["verifier_script_sha256"],
            second_result["verifier_script_sha256"]
        );
        let evidence = json!({"kind":"ghost-json-compute-capability-acceptance/1","controller":"declared controlled Host controller; no Pi SDK scheduling or model inference","profile_ref":reference,"old_profile_environment":old_environment,"new_profile_environment":pinned,"results":[first_result,second_result]});
        std::fs::write(
            f.root.path().join("json-compute-evidence.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "physical accepted JSON profile; genuine fixed-probe receipt required; no model"]
    async fn real_json_profile_fake_success_cannot_replace_independent_owner_verifier() {
        let profile = receipt();
        let mut f = host_fixture();
        f.root.disable_cleanup(true);
        eprintln!(
            "JSON fake-success controlled-controller/physical-producer root: {}",
            f.root.path().display()
        );
        configure(&mut f, profile);
        let template = register(&f);
        let input = json!({"unrelated":["Ω",null,true,false,{"items":[3,2,1]}]});
        assert_eq!(
            task_input(&f, "json-fake-input", template, "direct", input.clone())["result"]
                ["status"],
            "success"
        );
        let (_, work) = task_goal(&f, "json-fake-input", "json-fake-goal").await;
        let controller = controller(&f, &work).await;
        let evidence = compute(&f, &work, &input, &controller, true).await;
        assert_eq!(evidence["accepted"], false);
        std::fs::write(
            f.root
                .path()
                .join("json-compute-fake-success-evidence.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
    }
}
