use anyhow::{bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use crate::lifetime_contract::Envelope;

#[derive(Debug, Clone, PartialEq)]
pub struct OutboxItem {
    pub id: i64,
    pub command_id: String,
    pub target: String,
    pub payload: Value,
}

pub(super) fn pending_outbox(conn: &Connection) -> Result<Vec<OutboxItem>> {
    let mut statement = conn.prepare(
        "SELECT id,command_id,target,payload FROM lifetime_outbox WHERE acknowledged=0 ORDER BY id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut items = Vec::new();
    for row in rows {
        let (id, command_id, target, payload) = row?;
        items.push(OutboxItem {
            id,
            command_id,
            target,
            payload: serde_json::from_str(&payload)?,
        });
    }
    Ok(items)
}

/// Persist the receiver receipt, binding metadata, and delivery bit atomically.
/// A successful transport write or cancellation ACK is not execution completion.
pub(super) fn ack_outbox(conn: &Connection, id: i64, receipt: &Value) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let Some((acknowledged, target, raw_payload)) = tx.query_row(
        "SELECT acknowledged,target,payload FROM lifetime_outbox WHERE id=?1",
        [id], |row| Ok((row.get::<_, bool>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
    ).optional()? else { bail!("lifetime outbox item not found"); };
    let command: Envelope = serde_json::from_str(&raw_payload)?;
    command.validate()?;
    ensure!(receipt["status"] == "success", "receiver has not durably accepted this command");
    let raw_receipt = serde_json::to_string(receipt)?;
    let digest = format!("{:x}", Sha256::digest(raw_receipt.as_bytes()));
    let stored: Option<String> = tx.query_row(
        "SELECT receipt_digest FROM lifetime_delivery_receipts WHERE outbox_id=?1",
        [id], |row| row.get(0),
    ).optional()?;
    if acknowledged {
        ensure!(stored.as_deref() == Some(digest.as_str()), "an acknowledged intent requires its original durable receipt; reconcile legacy ACKs");
        tx.commit()?;
        return Ok(());
    }
    ensure!(stored.is_none(), "unacknowledged intent has an inconsistent stored receipt");
    if target == "pi" {
        let data = &receipt["data"];
        ensure!(data["command_id"] == command.command_id, "Pi receipt command scope mismatch");
        ensure!(data["conversation_id"] == command.body["conversation_id"] && data["ghost_id"] == command.body["ghost_id"], "Pi receipt conversation scope mismatch");
        ensure!(data["runtime_kind"] == "pi-durable" && data["runtime_release"] == "1.1.0", "Pi receipt runtime identity mismatch");
        let storage = data["storage_ref"].as_str().filter(|value| !value.is_empty() && !value.starts_with("unresolved:"))
            .ok_or_else(|| anyhow::anyhow!("Pi durable storage locator missing"))?;
        let changed = tx.execute(
            "UPDATE lifetime_bindings SET runtime_kind='pi-durable',runtime_release='1.1.0',storage_ref=?1 WHERE conversation_id=?2 AND ghost_id=?3",
            params![storage, command.body["conversation_id"].as_str(), command.body["ghost_id"].as_str()],
        )?;
        ensure!(changed == 1, "Pi receipt does not match a committed Host binding");
    } else if target == "worker" {
        let execution = command.body["spec"]["execution_id"].as_str().or_else(|| command.body["execution_id"].as_str());
        ensure!(execution.is_some() && receipt["data"]["execution_id"].as_str() == execution, "worker receipt execution scope mismatch");
    } else {
        bail!("unknown lifetime receiver");
    }
    tx.execute(
        "INSERT INTO lifetime_delivery_receipts(outbox_id,receiver_command_id,receipt_digest,payload) VALUES(?1,?2,?3,?4)",
        params![id, command.command_id, digest, raw_receipt],
    )?;
    let changed = tx.execute("UPDATE lifetime_outbox SET acknowledged=1 WHERE id=?1 AND acknowledged=0", [id])?;
    ensure!(changed == 1, "lifetime outbox acknowledgement raced");
    tx.commit()?;
    Ok(())
}
