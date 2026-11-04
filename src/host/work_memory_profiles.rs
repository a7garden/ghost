//! Immutable metadata selections. A profile reference grants no engine authority.
use super::*;
use crate::host::bots::RevisionRef;
#[derive(Debug)]
pub(crate) struct Unavailable(pub &'static str);
impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Unavailable {}
const REVISIONS: &str = "work_memory_profile_revision_v1";
const RESERVATIONS: &str = "bot_creation_memory_reservation_v1";
fn revision_key(owner: &str, revision: u64) -> String {
    format!("{owner}:{revision}")
}
pub(crate) fn reference(profile: &Profile) -> Result<RevisionRef> {
    Ok(RevisionRef {
        namespace: profile.owner.clone(),
        id: "work-memory".into(),
        revision: profile.revision,
        digest: canonical_digest(&serde_json::to_value(profile)?)?,
    })
}
fn archive(conn: &Connection, profile: &Profile) -> Result<()> {
    let key = revision_key(&profile.owner, profile.revision);
    let encoded = serde_json::to_value(profile)?;
    if let Some(existing) = load::<Value>(conn, REVISIONS, &key)? {
        ensure!(
            existing == encoded,
            "immutable memory profile revision conflict"
        );
    } else {
        put(conn, REVISIONS, &key, profile)?;
    }
    Ok(())
}
pub(crate) fn resolve(conn: &Connection, owner: &str, pin: &RevisionRef) -> Result<Profile> {
    pin.validate()
        .map_err(|_| Unavailable("memory_profile_reference_invalid"))?;
    if pin.namespace != owner || pin.id != "work-memory" {
        return Err(Unavailable("memory_profile_owner_mismatch").into());
    }
    let stored: Option<Profile> = load(conn, REVISIONS, &revision_key(owner, pin.revision))?;
    // Read-only compatibility for a pre-history current head; no inferred old revision.
    let profile = if stored.is_some() {
        stored
    } else {
        load::<Profile>(conn, PROFILES, owner)?.filter(|p| p.revision == pin.revision)
    }
    .ok_or(Unavailable("memory_profile_revision_missing"))?;
    if profile.owner != owner || reference(&profile)? != *pin {
        return Err(Unavailable("memory_profile_digest_mismatch").into());
    }
    Ok(profile)
}
pub(crate) fn for_definition(
    conn: &Connection,
    owner: &str,
    definition: Option<&crate::host::bots::BotDefinition>,
) -> Result<Option<Profile>> {
    if let Some(pin) = definition.and_then(|d| d.content.memory_profile_ref.as_ref()) {
        return resolve(conn, owner, pin).map(Some);
    }
    load(conn, PROFILES, owner)
}
pub(crate) fn configured_current(conn: &Connection, profile: &Profile) -> Result<()> {
    ensure!(profile.owner.len() > 0, "memory profile owner missing");
    let policy: Policy = load(conn, "policy", &profile.owner)?.unwrap_or_default();
    if !policy.memory {
        return Err(Unavailable("memory_permission_missing").into());
    }
    if let Some(read) = &profile.profile {
        let ids = read
            .bindings
            .iter()
            .map(|b| b.id.clone())
            .collect::<Vec<_>>();
        if Brain::work_profile(&profile.owner, &ids)? != *read {
            return Err(Unavailable("memory_binding_changed").into());
        }
    } else {
        if profile.required {
            return Err(Unavailable("memory_binding_missing").into());
        }
    }
    if let Some(space) = &profile.experience_space {
        ensure!(
            serde_json::to_value(private_space(conn, &profile.owner, &space.id)?)?
                == serde_json::to_value(space)?,
            "experience destination permission changed"
        );
    }
    Ok(())
}
pub(crate) fn inspect(conn: &Connection, envelope: &Envelope) -> Result<Response> {
    fields(&envelope.body, &["method", "ghost_id"])?;
    let owner = string(&envelope.body, "ghost_id", 200)?;
    let current: Option<Profile> = load(conn, PROFILES, owner)?;
    Ok(result(
        None,
        "Owner memory profile metadata inspected",
        match current {
            Some(p) => {
                json!({"ghost_id":owner,"profile_ref":reference(&p)?,"required":p.required,"binding_count":p.profile.as_ref().map_or(0,|p|p.bindings.len()),"experience_enabled":p.experience_space.is_some()})
            }
            None => {
                json!({"ghost_id":owner,"profile_ref":null,"required":false,"binding_count":0,"experience_enabled":false})
            }
        },
    ))
}
pub(crate) fn configure(conn: &Connection, envelope: &Envelope) -> Result<Response> {
    let body = &envelope.body;
    fields(
        body,
        &[
            "method",
            "ghost_id",
            "binding_ids",
            "required",
            "experience_space_id",
            "creation_command_id",
        ],
    )?;
    let owner = string(body, "ghost_id", 200)?;
    let creation = body
        .get("creation_command_id")
        .map(|_| string(body, "creation_command_id", 200))
        .transpose()?;
    if let Some(command) = creation {
        let planned = crate::host::bots_memory::planned_identity(command)?;
        ensure!(
            planned["ghost_id"] == owner,
            "future memory profile identity differs from its Owner creation command"
        );
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT actor_ref,request FROM lifetime_commands WHERE command_id=?1",
                [command],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((actor, request)) = existing {
            let request: Envelope = serde_json::from_str(&request)?;
            ensure!(
                actor == "owner" && request.body["method"] == "bot.prepare",
                "creation command belongs to another intent"
            );
        }
        ensure!(load::<Value>(conn,RESERVATIONS,command)?.is_none(),"future creation memory metadata is already reserved; recover its original configure receipt");
    }
    let previous: Option<Profile> = load(conn, PROFILES, owner)?;
    ensure!(
        envelope.expected_revision == previous.as_ref().map(|p| p.revision),
        "Work memory profile revision changed"
    );
    let ids: Vec<String> =
        serde_json::from_value(body.get("binding_ids").cloned().unwrap_or(json!([])))?;
    ensure!(
        ids.len() <= 8 && ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
        "invalid Work memory binding selection"
    );
    let required = body["required"]
        .as_bool()
        .ok_or_else(|| anyhow!("Work memory required must be Boolean"))?;
    let profile = if ids.is_empty() {
        None
    } else {
        let policy: Policy = load(conn, "policy", owner)?.unwrap_or_default();
        ensure!(
            policy.memory || creation.is_some(),
            "Ghost memory permission is not granted"
        );
        Some(Brain::work_profile(owner, &ids)?)
    };
    let destination = body
        .get("experience_space_id")
        .filter(|v| !v.is_null())
        .map(|v| {
            private_space(
                conn,
                owner,
                v.as_str()
                    .ok_or_else(|| anyhow!("experience Space identity invalid"))?,
            )
        })
        .transpose()?;
    let revision = previous
        .as_ref()
        .map(|p| {
            p.revision
                .checked_add(1)
                .ok_or_else(|| anyhow!("Work memory profile revision exhausted"))
        })
        .transpose()?
        .unwrap_or(1);
    let profile = Profile {
        revision,
        owner: owner.into(),
        required,
        profile,
        experience_space: destination,
    };
    if let Some(previous) = previous {
        archive(conn, &previous)?;
    }
    archive(conn, &profile)?;
    put(conn, PROFILES, owner, &profile)?;
    let pin = reference(&profile)?;
    if let Some(command) = creation {
        put(
            conn,
            RESERVATIONS,
            command,
            &json!({"actor_ref":"owner","creation_command_id":command,"configure_command_id":envelope.command_id,"profile_ref":pin}),
        )?;
    }
    Ok(result(
        None,
        "Work memory profile selected for future admission; historical Work is unchanged",
        json!({"ghost_id":owner,"revision":profile.revision,"profile_ref":pin,"required":required,"existing_work_changed":false,"permission_granted":false}),
    ))
}
pub(crate) fn validate_creation(
    conn: &Connection,
    envelope: &Envelope,
    owner: &str,
    pin: &RevisionRef,
) -> Result<Profile> {
    let profile = resolve(conn, owner, pin)?;
    if let Some(reservation) = load::<Value>(conn, RESERVATIONS, &envelope.command_id)? {
        ensure!(
            envelope.actor_ref == "owner"
                && reservation["actor_ref"] == "owner"
                && reservation["creation_command_id"] == envelope.command_id
                && reservation["profile_ref"] == serde_json::to_value(pin)?,
            "creation memory metadata differs from its authenticated Owner intent"
        );
    }
    Ok(profile)
}
