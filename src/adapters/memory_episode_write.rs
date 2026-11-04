//! Dispatch identity for one source-ledger episode attempt. State alone is
//! insufficient: a delayed busy proof must not reset a later sent attempt.
use super::*;

pub(super) fn begin_attempt(
    origin: &TrustedSourceOrigin,
    space: &str,
    ledger: &SourceLedgerConfig,
    brain_dir: &Path,
    record: &SourceRecord,
) -> Result<Option<String>> {
    check_record_identity(origin, space, record)?;
    ensure!(
        record.ingest_state == "prepared",
        "only a prepared original source can begin an episode attempt"
    );
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    if transition(
        origin,
        space,
        ledger,
        brain_dir,
        "prepared",
        "sent",
        record.attempt_nonce.as_deref(),
        &nonce,
        None,
    )? {
        Ok(Some(nonce))
    } else {
        Ok(None)
    }
}

pub(super) fn finish_attempt(
    origin: &TrustedSourceOrigin,
    space: &str,
    ledger: &SourceLedgerConfig,
    brain_dir: &Path,
    nonce: &str,
    to: &str,
    episode: Option<&str>,
) -> Result<bool> {
    ensure!(
        nonce.len() == 32
            && nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "episode attempt identity is invalid"
    );
    ensure!(
        matches!(to, "prepared" | "effect_unknown" | "recorded" | "redacted"),
        "episode attempt outcome is invalid"
    );
    transition(
        origin,
        space,
        ledger,
        brain_dir,
        "sent",
        to,
        Some(nonce),
        nonce,
        episode,
    )
}

fn transition(
    origin: &TrustedSourceOrigin,
    space: &str,
    ledger: &SourceLedgerConfig,
    brain_dir: &Path,
    from: &str,
    to: &str,
    expected: Option<&str>,
    nonce: &str,
    episode: Option<&str>,
) -> Result<bool> {
    let mut connection = open_source_ledger(ledger, brain_dir)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed=tx.execute("UPDATE source_records SET ingest_state=?1,attempt_nonce=?2,episode_id=COALESCE(?3,episode_id),updated_at_ms=?4 WHERE owner=?5 AND space=?6 AND source_id=?7 AND revision=?8 AND content_sha256=?9 AND source_kind=?10 AND session_id IS ?11 AND disclosure=?12 AND source_locator=?13 AND ingest_state=?14 AND attempt_nonce IS ?15 AND episode_id IS NULL",
        params![to,nonce,episode,current_time_ms(),origin.owner,space,origin.source_id,origin.revision,origin.content_sha256,
            source_kind_name(&origin.kind),session_id_for_origin(&origin.kind),disclosure_name(origin.disclosure),source_locator(origin),from,expected])?;
    tx.commit()?;
    ensure!(
        std::fs::metadata(&ledger.path)?.len() <= MAX_SOURCE_LEDGER_BYTES,
        "source ledger exceeds its 16 MiB bound"
    );
    Ok(changed == 1)
}
