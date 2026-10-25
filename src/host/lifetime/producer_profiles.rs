//! Owner-private producer selections and immutable per-assignment environment pins.
//! Neither a model callback nor a later route selection can change an admitted Work.
use crate::computers::{
    AcceptedProducerProfile, ProducerProfileManifest, ProducerRuntimeFactsReceipt,
};
use crate::host::bots::RevisionRef;
use crate::lifetime_contract::canonical_digest;
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CATALOG: &str = "pi_producer_profile_acceptance_v1";
const SELECTION: &str = "pi_producer_profile_selection_v1";
const PIN: &str = "pi_producer_profile_pin_v1";
const EXECUTION: &str = "pi_execution_profile_binding_v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OwnerAcceptedProfile {
    pub(crate) manifest: ProducerProfileManifest,
    pub(crate) runtime_facts: ProducerRuntimeFactsReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogEntry {
    profile: OwnerAcceptedProfile,
    owner_config_acceptance: String,
}

fn read<T: for<'de> Deserialize<'de>>(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> Result<Option<T>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| Ok(serde_json::from_str(&raw)?)).transpose()
}

fn immutable(conn: &Connection, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
    let raw = serde_json::to_string(value)?;
    conn.execute(
        "INSERT OR IGNORE INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![kind, id, raw],
    )?;
    let stored: String = conn.query_row(
        "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
        params![kind, id],
        |r| r.get(0),
    )?;
    ensure!(
        stored == raw,
        "Producer profile immutable identity conflict"
    );
    Ok(())
}

pub(crate) fn legacy_ref() -> Result<RevisionRef> {
    Ok(RevisionRef {
        namespace: "host".into(),
        id: "pi-default".into(),
        revision: 1,
        digest: canonical_digest(&json!({"profile":"pi-default/1"}))?,
    })
}

pub(crate) fn is_legacy(reference: &RevisionRef) -> Result<bool> {
    Ok(*reference == legacy_ref()?)
}

fn profile_ref(manifest: &ProducerProfileManifest) -> Result<RevisionRef> {
    Ok(RevisionRef {
        namespace: "host".into(),
        id: manifest.profile_id.clone(),
        revision: manifest.revision,
        digest: manifest.digest()?,
    })
}

fn accepted(entry: &CatalogEntry) -> Result<AcceptedProducerProfile> {
    let provenance = format!(
        "owner-pi-config:{}",
        canonical_digest(&serde_json::to_value(&entry.profile)?)?
    );
    ensure!(
        entry.owner_config_acceptance == provenance,
        "Producer profile Owner configuration provenance changed"
    );
    AcceptedProducerProfile::from_owner_accepted(
        entry.profile.manifest.clone(),
        entry.profile.runtime_facts.clone(),
        provenance,
    )
}

/// Only the existing private Owner configuration loader calls this function.
/// This validates supplied fixed-probe evidence; it does not probe or attest a
/// malicious machine Owner, and does not install/select any image.
pub(crate) fn accept_config(
    conn: &Connection,
    profile: OwnerAcceptedProfile,
) -> Result<RevisionRef> {
    let reference = profile_ref(&profile.manifest)?;
    reference.validate()?;
    ensure!(
        !is_legacy(&reference)? && reference.id != "pi-default",
        "The legacy execution profile identity is reserved"
    );
    let entry = CatalogEntry {
        owner_config_acceptance: format!(
            "owner-pi-config:{}",
            canonical_digest(&serde_json::to_value(&profile)?)?
        ),
        profile,
    };
    accepted(&entry)?;
    // A profile revision cannot silently acquire another manifest or receipt.
    let id = format!("{}:{}", reference.id, reference.revision);
    immutable(conn, CATALOG, &id, &entry)?;
    Ok(reference)
}

pub(crate) fn resolve(
    conn: &Connection,
    reference: &RevisionRef,
) -> Result<Option<AcceptedProducerProfile>> {
    reference.validate()?;
    if is_legacy(reference)? {
        return Ok(None);
    }
    ensure!(
        reference.namespace == "host" && reference.id != "pi-default",
        "Unsupported producer profile reference"
    );
    let entry: CatalogEntry = read(
        conn,
        CATALOG,
        &format!("{}:{}", reference.id, reference.revision),
    )?
    .ok_or_else(|| anyhow!("Accepted producer profile missing"))?;
    ensure!(
        profile_ref(&entry.profile.manifest)? == *reference,
        "Accepted producer profile digest changed"
    );
    Ok(Some(accepted(&entry)?))
}

pub(crate) fn select(
    conn: &Connection,
    ghost: &str,
    reference: Option<&RevisionRef>,
) -> Result<()> {
    let reference = reference.cloned().unwrap_or(legacy_ref()?);
    resolve(conn, &reference)?;
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![SELECTION,ghost,serde_json::to_string(&reference)?])?;
    Ok(())
}

pub(crate) fn selected(conn: &Connection, ghost: &str) -> Result<RevisionRef> {
    Ok(read(conn, SELECTION, ghost)?.unwrap_or(legacy_ref()?))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct PinScope {
    pub(super) ghost_id: String,
    pub(super) conversation_id: String,
    pub(super) assignment_id: String,
    pub(super) assignment_digest: String,
    pub(super) work_id: String,
    pub(super) goal_revision: u64,
    pub(super) owner_revision: u64,
    pub(super) authority_epoch: u64,
    pub(super) execution_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    scope: PinScope,
    profile_ref: RevisionRef,
    acceptance_digest: String,
}

fn pin_ref(pin: &Pin) -> Result<String> {
    Ok(format!(
        "pp-{}",
        canonical_digest(&json!(["ghost-producer-work-pin/1", pin]))?
    ))
}

pub(super) fn admit(conn: &Connection, scope: &PinScope) -> Result<Option<String>> {
    let reference = selected(conn, &scope.ghost_id)?;
    if resolve(conn, &reference)?.is_none() {
        return Ok(None);
    }
    let entry: CatalogEntry = read(
        conn,
        CATALOG,
        &format!("{}:{}", reference.id, reference.revision),
    )?
    .ok_or_else(|| anyhow!("Producer acceptance missing"))?;
    let pin = Pin {
        scope: scope.clone(),
        profile_ref: reference,
        acceptance_digest: canonical_digest(&serde_json::to_value(entry)?)?,
    };
    let id = pin_ref(&pin)?;
    immutable(conn, PIN, &id, &pin)?;
    Ok(Some(id))
}

pub(super) fn pinned(
    conn: &Connection,
    reference: &str,
    scope: &PinScope,
) -> Result<AcceptedProducerProfile> {
    let pin: Pin = read(conn, PIN, reference)?
        .ok_or_else(|| anyhow!("Required producer profile pin missing"))?;
    ensure!(
        pin_ref(&pin)? == reference && pin.scope == *scope,
        "Producer profile pin scope or digest changed"
    );
    let entry: CatalogEntry = read(
        conn,
        CATALOG,
        &format!("{}:{}", pin.profile_ref.id, pin.profile_ref.revision),
    )?
    .ok_or_else(|| anyhow!("Pinned producer acceptance missing"))?;
    ensure!(
        canonical_digest(&serde_json::to_value(entry)?)? == pin.acceptance_digest,
        "Pinned producer acceptance changed"
    );
    resolve(conn, &pin.profile_ref)?
        .ok_or_else(|| anyhow!("A required producer pin cannot resolve to legacy"))
}

/// The execution binding is separate from the mutable route and rechecked
/// before replay, I/O, resume, and completion. Legacy executions stay untouched.
pub(super) fn execution_binding(
    conn: &Connection,
    execution: &str,
    scope: &PinScope,
    pin: Option<&str>,
    create: bool,
) -> Result<()> {
    ensure!(
        execution == scope.execution_id,
        "Producer execution identity changed"
    );
    let stored: Option<Value> = read(conn, EXECUTION, execution)?;
    if pin.is_none() {
        ensure!(stored.is_none(), "Required execution profile pin removed");
        return Ok(());
    }
    let pin = pin.unwrap();
    pinned(conn, pin, scope)?;
    let expected = json!({"scope":scope,"producer_profile_pin":pin});
    if create {
        immutable(conn, EXECUTION, execution, &expected)?;
    } else {
        ensure!(
            stored.as_ref() == Some(&expected),
            "Required execution profile binding missing or changed"
        );
    }
    Ok(())
}
