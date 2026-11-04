// Included in memory::tests, sharing its serialized environment guard.
#[tokio::test]
async fn temporal_documents_and_invalid_axes_return_typed_errors_before_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let (brain, _environment, directory, _) = scoped_fixture(root.path(), "owner-a").await;
    for (args, code) in [
        (
            json!({"query":"needle","as_of":0,"planes":["documents"]}),
            "unsupported_temporal_scope",
        ),
        (
            json!({"query":"needle","known_at":null}),
            "invalid_temporal_scope",
        ),
    ] {
        let output = brain
            .read_memory(
                "owner-a",
                "session",
                &ai::ToolCall::new("temporal", "memory_recall", args),
                || Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(read_error_code(&output), Some(code));
        assert_eq!(output.status, ToolStatus::Denied);
    }
    assert!(
        !directory.join("scope-calls.jsonl").exists(),
        "unsupported time filters must never become current queries"
    );
    let unsupported = brain
        .read_memory(
            "owner-a",
            "session",
            &ai::ToolCall::new(
                "legacy",
                "memory_recall",
                json!({"query":"needle","as_of":0}),
            ),
            || Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(
        read_error_code(&unsupported),
        Some("unsupported_temporal_scope")
    );
    assert_eq!(
        unsupported.content["plane"], "memory",
        "legacy schemas must not silently ignore temporal fields"
    );
    assert!(!directory.join("scope-calls.jsonl").exists());
}

#[tokio::test]
#[ignore = "requires GHOST_OXIBRAIN_TEST_BINARY built from current Oxibrain source; no model calls"]
async fn actual_native_temporal_memory_distinguishes_valid_and_known_time_without_document_fallback(
) {
    let executable =
        std::env::var_os("GHOST_OXIBRAIN_TEST_BINARY").expect("explicit native test executable");
    let root = tempfile::tempdir().unwrap();
    let (brain, mut environment, _, _) = scoped_fixture(root.path(), "owner-a").await;
    environment.capture_extra(&["OXIBRAIN_MODELS_DIR"]);
    std::env::set_var("OXIBRAIN_MODELS_DIR", root.path().join("empty-models"));
    let directory = root.path().join("actual-engine");
    let cli = |args: &[&str]| {
        let output = std::process::Command::new(&executable)
            .arg("--dir")
            .arg(&directory)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "isolated engine setup failed");
        String::from_utf8(output.stdout).unwrap()
    };
    for space in ["fixture-space", "common"] {
        cli(&["admin", "init", "--space", space]);
    }
    let token = |space: &str, caps: &str| {
        cli(&["admin", "token", "issue", "--space", space, "--caps", caps])
            .lines()
            .find_map(|line| {
                line.strip_prefix("secret (shown once): ")
                    .map(str::to_owned)
            })
            .unwrap()
    };
    let writer = token("fixture-space", "read,write");
    std::env::set_var("GHOST_BRAIN_EXECUTABLE", &executable);
    std::env::set_var("GHOST_BRAIN_DIR", &directory);
    std::env::set_var(
        "GHOST_BRAIN_TOKEN_OWN_FIXTURE",
        token("fixture-space", "read,ingest"),
    );
    std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE", token("common", "read"));
    let mut client = BrainClient::spawn_local(LocalProcessEndpoint::new(&executable, &directory))
        .await
        .unwrap();
    client.auth(&writer).await.unwrap();
    client
        .handshake(oxibrain_client::default_client_hello("temporal-fixture"))
        .await
        .unwrap();
    for (company, from, to) in [
        ("TemporalOldCompany", 1000, 1999),
        ("TemporalNewCompany", 2000, i64::MAX),
    ] {
        let declaration = json!({"op":"add_statement","subject":{"surface":"TemporalPerson","type":"Person"},"predicate":"employed_by","object":{"kind":"entity","surface":company,"type":"Organization"},"polarity":"affirm","valid_from":from,"valid_to":to});
        client
            .call_tool(
                "declare",
                json!({"space":"fixture-space","declaration_json":declaration.to_string()}),
            )
            .await
            .unwrap();
    }
    let unsupported=client.call_tool_json("recall",json!({"space":"fixture-space","query":"TemporalPerson","known_at":0,"planes":["documents"]})).await.unwrap_err();
    assert!(unsupported
        .to_string()
        .contains("unsupported_temporal_scope"));
    client.close().await.unwrap();
    let query = |id: &str, extra: Value| {
        let mut args = json!({"query":"TemporalPerson","token_budget":2048});
        for (key, value) in extra.as_object().unwrap() {
            args[key] = value.clone();
        }
        ai::ToolCall::new(id, "memory_recall", args)
    };
    let past = brain
        .read_memory(
            "owner-a",
            "session",
            &query("past", json!({"as_of":1500})),
            || Ok(()),
        )
        .await
        .unwrap();
    let current = brain
        .read_memory(
            "owner-a",
            "session",
            &query("current", json!({"planes":["memory"]})),
            || Ok(()),
        )
        .await
        .unwrap();
    let unknown = brain
        .read_memory(
            "owner-a",
            "session",
            &query("unknown", json!({"known_at":0,"as_of":1500})),
            || Ok(()),
        )
        .await
        .unwrap();
    for result in [&past, &current, &unknown] {
        assert_eq!(result.status, ToolStatus::Success);
        assert_eq!(result.content["partial"], false);
        assert_eq!(result.content["query_scope"]["planes"], json!(["memory"]));
        assert_eq!(result.content["global_snapshot"], false);
    }
    let result_text =
        |output: &ToolOutput| output.content["scopes"][0]["result"]["data"].to_string();
    assert!(result_text(&past).contains("TemporalOldCompany"));
    assert!(!result_text(&past).contains("TemporalNewCompany"));
    assert!(result_text(&current).contains("TemporalNewCompany"));
    assert!(!result_text(&current).contains("TemporalOldCompany"));
    assert!(!result_text(&unknown).contains("TemporalOldCompany"));
    assert!(!result_text(&unknown).contains("TemporalNewCompany"));
    let documents = brain
        .read_memory(
            "owner-a",
            "session",
            &query("documents", json!({"as_of":1500,"planes":["documents"]})),
            || Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(
        read_error_code(&documents),
        Some("unsupported_temporal_scope")
    );
    assert_eq!(documents.content["plane"], "documents");
}
