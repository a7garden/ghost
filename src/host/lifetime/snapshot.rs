use anyhow::Result;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::BTreeMap;
use crate::lifetime_contract::{Artifact, RuntimeBinding, Snapshot, REVISION, VERSION};

pub(super) fn snapshot(conn: &Connection) -> Result<Snapshot> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let snapshot = Snapshot {
        protocol_version: VERSION.to_owned(),
        contract_revision: REVISION,
        mode: "live".to_owned(),
        goals: payloads(&tx, "SELECT payload FROM lifetime_goals ORDER BY id")?,
        work: payloads(&tx, "SELECT payload FROM lifetime_work ORDER BY id")?,
        bindings: bindings(&tx)?,
        artifacts: artifacts(&tx)?,
        acceptances: payloads(
            &tx,
            "SELECT payload FROM lifetime_acceptances ORDER BY work_id",
        )?,
    };
    tx.commit()?;
    Ok(snapshot)
}

fn payloads<T: DeserializeOwned>(conn: &Connection, query: &str) -> Result<Vec<T>> {
    let mut statement = conn.prepare(query)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut values = Vec::new();
    for row in rows {
        values.push(serde_json::from_str(&row?)?);
    }
    Ok(values)
}

fn bindings(conn: &Connection) -> Result<Vec<RuntimeBinding>> {
    let mut statement = conn.prepare(
        "SELECT conversation_id,ghost_id,runtime_kind,runtime_release,storage_ref FROM lifetime_bindings ORDER BY conversation_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(RuntimeBinding {
            conversation_id: row.get(0)?,
            ghost_id: row.get(1)?,
            runtime_kind: row.get(2)?,
            runtime_release: row.get(3)?,
            storage_ref: row.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn artifacts(conn: &Connection) -> Result<Vec<Artifact>> {
    let mut statement = conn.prepare(
        "SELECT payload FROM lifetime_inbox ORDER BY epoch,producer,sequence",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut unique = BTreeMap::<String, Artifact>::new();
    for row in rows {
        let stored: Value = serde_json::from_str(&row?)?;
        let event = stored.get("event").unwrap_or(&stored);
        if event.get("method").and_then(Value::as_str) != Some("work.result") {
            continue;
        }
        let Some(items) = event.get("artifacts").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let artifact: Artifact = serde_json::from_value(item.clone())?;
            unique.insert(serde_json::to_string(&artifact)?, artifact);
        }
    }
    Ok(unique.into_values().collect())
}
