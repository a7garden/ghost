#[test]
fn episode_attempt_nonce_prevents_delayed_busy_aba_and_never_resets_unknown_or_recorded() {
    let root = tempfile::tempdir().unwrap();
    let brain_dir = root.path().join("brain");
    fs::create_dir(&brain_dir).unwrap();
    let ledger = SourceLedgerConfig::new(root.path().join("source-ledger.sqlite")).unwrap();
    let content = "original bytes";
    let origin = source_origin("owner", "original", "1", content, SourceDisclosure::Private);
    let PreparedIngest::Work(record) =
        prepare_ingest(&origin, content, "fixture-space", &ledger, &brain_dir, None).unwrap()
    else {
        panic!("prepared")
    };
    let first =
        episode_write::begin_attempt(&origin, "fixture-space", &ledger, &brain_dir, &record)
            .unwrap()
            .unwrap();
    assert!(episode_write::finish_attempt(
        &origin,
        "fixture-space",
        &ledger,
        &brain_dir,
        &first,
        "prepared",
        None
    )
    .unwrap());
    let prepared = load_source_record(&origin, "fixture-space", &ledger, &brain_dir)
        .unwrap()
        .unwrap();
    assert_eq!(prepared.attempt_nonce.as_deref(), Some(first.as_str()));
    let second =
        episode_write::begin_attempt(&origin, "fixture-space", &ledger, &brain_dir, &prepared)
            .unwrap()
            .unwrap();
    assert_ne!(first, second);
    assert!(!episode_write::finish_attempt(
        &origin,
        "fixture-space",
        &ledger,
        &brain_dir,
        &first,
        "prepared",
        None
    )
    .unwrap());
    let actual = load_source_record(&origin, "fixture-space", &ledger, &brain_dir)
        .unwrap()
        .unwrap();
    assert_eq!(actual.ingest_state, "sent");
    assert_eq!(actual.attempt_nonce.as_deref(), Some(second.as_str()));
    let mut forged = origin.clone();
    forged.content_sha256 = "f".repeat(64);
    assert!(!episode_write::finish_attempt(
        &forged,
        "fixture-space",
        &ledger,
        &brain_dir,
        &second,
        "prepared",
        None
    )
    .unwrap());
    assert!(episode_write::finish_attempt(
        &origin,
        "fixture-space",
        &ledger,
        &brain_dir,
        &second,
        "recorded",
        Some(&"e".repeat(64))
    )
    .unwrap());
    assert!(!episode_write::finish_attempt(
        &origin,
        "fixture-space",
        &ledger,
        &brain_dir,
        &second,
        "prepared",
        None
    )
    .unwrap());
    let recorded = load_source_record(&origin, "fixture-space", &ledger, &brain_dir)
        .unwrap()
        .unwrap();
    assert_eq!(recorded.ingest_state, "recorded");
    assert_eq!(recorded.episode_id, Some("e".repeat(64)));
    let other = source_origin("owner", "other", "1", content, SourceDisclosure::Private);
    let PreparedIngest::Work(record) =
        prepare_ingest(&other, content, "fixture-space", &ledger, &brain_dir, None).unwrap()
    else {
        panic!("prepared")
    };
    let nonce = episode_write::begin_attempt(&other, "fixture-space", &ledger, &brain_dir, &record)
        .unwrap()
        .unwrap();
    assert!(episode_write::finish_attempt(
        &other,
        "fixture-space",
        &ledger,
        &brain_dir,
        &nonce,
        "effect_unknown",
        None
    )
    .unwrap());
    assert!(!episode_write::finish_attempt(
        &other,
        "fixture-space",
        &ledger,
        &brain_dir,
        &nonce,
        "prepared",
        None
    )
    .unwrap());
    assert_eq!(
        load_source_record(&other, "fixture-space", &ledger, &brain_dir)
            .unwrap()
            .unwrap()
            .ingest_state,
        "effect_unknown"
    );
}

#[test]
fn episode_attempt_v1_v2_migration_preserves_legacy_rows_and_null_uncertain_attempts() {
    for version in [1, 2] {
        let root = tempfile::tempdir().unwrap();
        let brain_dir = root.path().join("brain");
        fs::create_dir(&brain_dir).unwrap();
        let ledger = SourceLedgerConfig::new(root.path().join("source-ledger.sqlite")).unwrap();
        create_private_ledger_file(&ledger.path).unwrap();
        let old = Connection::open(&ledger.path).unwrap();
        old.execute_batch("CREATE TABLE source_records(owner TEXT NOT NULL,space TEXT NOT NULL,source_id TEXT NOT NULL,revision TEXT NOT NULL,disclosure TEXT NOT NULL,content_sha256 TEXT NOT NULL,source_locator TEXT NOT NULL,ingest_state TEXT NOT NULL,episode_id TEXT,prior_revision TEXT,prior_episode_id TEXT,redaction_state TEXT NOT NULL,redaction_closure_sha256 TEXT,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(owner,source_id,revision),UNIQUE(space,source_locator));").unwrap();
        if version == 2 {
            old.execute_batch("ALTER TABLE source_records ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'note'; ALTER TABLE source_records ADD COLUMN session_id TEXT; CREATE UNIQUE INDEX source_session_ids ON source_records(space,session_id) WHERE source_kind='session';").unwrap();
        }
        for (i, state) in ["prepared", "sent", "effect_unknown", "recorded"]
            .iter()
            .enumerate()
        {
            let origin = TrustedSourceOrigin::new(
                "owner",
                format!("legacy-{i}"),
                "1",
                SourceDisclosure::Private,
                "a".repeat(64),
            )
            .unwrap();
            old.execute("INSERT INTO source_records(owner,space,source_id,revision,disclosure,content_sha256,source_locator,ingest_state,episode_id,prior_revision,prior_episode_id,redaction_state,redaction_closure_sha256,updated_at_ms) VALUES('owner','fixture-space',?1,'1','private',?2,?3,?4,?5,NULL,NULL,'none',NULL,17)",params![origin.source_id,"a".repeat(64),source_locator(&origin),state,(*state=="recorded").then(||"b".repeat(64))]).unwrap();
        }
        old.pragma_update(None, "application_id", SOURCE_LEDGER_APPLICATION_ID)
            .unwrap();
        old.pragma_update(None, "user_version", version).unwrap();
        let original:String=old.query_row("SELECT json_group_array(json_array(owner,space,source_id,revision,disclosure,content_sha256,source_locator,ingest_state,episode_id,prior_revision,prior_episode_id,redaction_state,redaction_closure_sha256,updated_at_ms)) FROM source_records",[],|r|r.get(0)).unwrap();
        drop(old);
        let migrated = open_source_ledger(&ledger, &brain_dir).unwrap();
        assert_eq!(
            migrated
                .pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            3
        );
        assert_eq!(migrated.query_row::<String,_,_>("SELECT json_group_array(json_array(owner,space,source_id,revision,disclosure,content_sha256,source_locator,ingest_state,episode_id,prior_revision,prior_episode_id,redaction_state,redaction_closure_sha256,updated_at_ms)) FROM source_records",[],|r|r.get(0)).unwrap(),original);
        assert_eq!(
            migrated
                .query_row::<u64, _, _>(
                    "SELECT COUNT(*) FROM source_records WHERE attempt_nonce IS NULL",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
            4
        );
        drop(migrated);
        let legacy = TrustedSourceOrigin::new(
            "owner",
            "legacy-1",
            "1",
            SourceDisclosure::Private,
            "a".repeat(64),
        )
        .unwrap();
        assert!(!episode_write::finish_attempt(
            &legacy,
            "fixture-space",
            &ledger,
            &brain_dir,
            &"1".repeat(32),
            "prepared",
            None
        )
        .unwrap());
        let unchanged = load_source_record(&legacy, "fixture-space", &ledger, &brain_dir)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.ingest_state, "sent");
        assert_eq!(unchanged.attempt_nonce, None);
    }
}
