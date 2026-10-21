//! Scoped persistent skill store: discovery, pinning, update, recovery and the
//! user-controlled improvement path.
//!
//! Skills are explicit, per-Ghost artifacts — never ambient discovery. Each
//! Ghost's store lives under its profile directory
//! (`profiles/<name>/skills/<skill>/SKILL.md`) with immutable revision copies
//! (`revisions/<digest>/SKILL.md`); the workspace journal (`kind: skill`) holds
//! the digest-pinned revision, status and truthful origin. Work admissions pin
//! the digest they were admitted with, so an update never silently changes a
//! running execution. Improvement candidates are separate objects that reach
//! `active` only through an explicit Owner promotion command — no tool, no
//! autonomous path, and no candidate can alter permissions or verifiers.
//!
//! Delivery into an OMP session is an explicit pinned manifest (name, digest,
//! bounded content) consumed by the scoped guest runtime; without a manifest the
//! session keeps `skills: []` exactly as the historical native proof requires.
use super::{now_ms, State};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(crate) const SKILL_KIND: &str = "skill";
pub(crate) const SKILL_CANDIDATE_KIND: &str = "skill_candidate";
const MAX_SKILL_BYTES: usize = 262_144;
const MAX_NAME_BYTES: usize = 64;
/// The digest of empty content; rejected so a store skill always has bytes.
const EMPTY_DIGEST: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Skill {
    /// Human skill name; the journal object key also includes `profile_id`.
    pub id: String,
    pub profile_id: String,
    /// SHA-256 of the active SKILL.md bytes.
    pub digest: String,
    /// Monotonic revision; every import/promotion increments it.
    pub revision: u64,
    /// `active` | `disabled`
    pub status: String,
    /// Source classification: `public` only when the SKILL.md frontmatter says
    /// so; defaults to `private` (source default local/private).
    pub privacy: String,
    /// Truthful origin: `{"kind":"owner",…}`, `{"kind":"candidate",…}` or `{"kind":"recover",…}`.
    pub origin: Value,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub title: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SkillCandidate {
    pub id: String,
    pub profile_id: String,
    pub skill: String,
    pub digest: String,
    pub note: String,
    /// `draft` | `promoted` | `rejected`
    pub status: String,
    pub created_ms: u64,
    pub origin: Value,
}

fn skill_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_NAME_BYTES
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        bail!("skill name must be 1..=64 characters of a-z, 0-9, '-' or '_'");
    }
    Ok(trimmed.to_owned())
}

fn digest_of(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn profile_name(s: &State, profile_id: &str) -> Result<String> {
    Ok(s.profiles
        .get(profile_id)
        .ok_or_else(|| anyhow!("Ghost missing"))?
        .name
        .clone())
}

/// Journal keys are profile-scoped (`<profile_id>:<name>`) so two Ghosts can
/// own the same human skill name independently; `Skill.id` stays the name.
fn journal_key(profile_id: &str, name: &str) -> String {
    format!("{profile_id}:{name}")
}

/// Clean up pre-scope journal keys before any consumer reads the store.
/// Keep the original payload bytes; conflicting records require reconciliation.
pub(crate) fn migrate_scope(conn: &rusqlite::Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let legacy = {
        let mut query = tx.prepare(
            "SELECT id,payload FROM workspace_objects WHERE kind=?1 AND instr(id,':')=0",
        )?;
        let rows = query.query_map([SKILL_KIND], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (old_key, payload) in legacy {
        let skill: Skill = serde_json::from_str(&payload)?;
        anyhow::ensure!(old_key == skill_name(&skill.id)? && !skill.profile_id.is_empty(),
            "legacy skill identity is invalid; reconcile before opening the workspace");
        let key = journal_key(&skill.profile_id, &skill.id);
        let current: Option<String> = tx.query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![SKILL_KIND, key], |row| row.get(0),
        ).optional()?;
        if let Some(current) = current {
            anyhow::ensure!(serde_json::from_str::<Value>(&current)? == serde_json::from_str::<Value>(&payload)?,
                "conflicting legacy and scoped skill records; reconcile before opening the workspace");
            tx.execute("DELETE FROM workspace_objects WHERE kind=?1 AND id=?2",
                params![SKILL_KIND, old_key])?;
        } else {
            tx.execute("UPDATE workspace_objects SET id=?1 WHERE kind=?2 AND id=?3",
                params![key, SKILL_KIND, old_key])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn skill_dir(root: &Path, profile_name: &str, name: &str) -> PathBuf {
    root.join("profiles").join(profile_name).join("skills").join(name)
}

fn active_path(root: &Path, profile_name: &str, name: &str) -> PathBuf {
    skill_dir(root, profile_name, name).join("SKILL.md")
}

fn revision_path(root: &Path, profile_name: &str, name: &str, digest: &str) -> PathBuf {
    skill_dir(root, profile_name, name)
        .join("revisions")
        .join(digest)
        .join("SKILL.md")
}

fn candidate_path(root: &Path, profile_name: &str, skill: &str, candidate_id: &str) -> PathBuf {
    skill_dir(root, profile_name, skill)
        .join("candidates")
        .join(format!("{candidate_id}.md"))
}

fn write_atomic(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn read_bounded(path: &Path) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() as usize > MAX_SKILL_BYTES {
        bail!("skill file exceeds {MAX_SKILL_BYTES} bytes");
    }
    Ok(std::fs::read_to_string(path)?)
}

/// Parsed SKILL.md frontmatter: the manifest needs a truthful title/description
/// and a source privacy classification (default `private`).
fn frontmatter(content: &str) -> (String, String, String) {
    let mut title = String::new();
    let mut description = String::new();
    let mut privacy = "private".to_owned();
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some((block, _)) = rest.split_once("\n---") {
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("name:") {
                    title = value.trim().to_owned();
                } else if let Some(value) = line.strip_prefix("description:") {
                    description = value.trim().to_owned();
                } else if let Some(value) = line.strip_prefix("privacy:") {
                    privacy = value.trim().to_owned();
                }
            }
        }
    }
    if !matches!(privacy.as_str(), "public" | "private" | "local_only") {
        privacy = "private".to_owned();
    }
    if title.is_empty() {
        title = content
            .lines()
            .next()
            .unwrap_or_default()
            .trim_start_matches('#')
            .trim()
            .to_owned();
    }
    (title, description, privacy)
}

/// Import or replace a skill from Owner-provided content. The bytes are stored
/// atomically with their digest; the journal row pins that digest. Replacing an
/// existing skill requires its current `version` (CAS), so a stale writer can
/// never overwrite an update it has not seen.
pub(crate) fn save(
    s: &State,
    root: &Path,
    request: &str,
    profile_id: &str,
    name: &str,
    content: &str,
    version: Option<u64>,
) -> Result<Value> {
    let name = skill_name(name)?;
    if content.is_empty() || content.len() > MAX_SKILL_BYTES {
        bail!("skill content must be 1..={MAX_SKILL_BYTES} bytes");
    }
    let digest = digest_of(content);
    if digest == EMPTY_DIGEST {
        bail!("skill content is empty");
    }
    let existing: Option<Skill> = s.journal.get(SKILL_KIND, &journal_key(profile_id, &name))?;
    if let Some(skill) = &existing {
        if skill.profile_id != profile_id {
            bail!("skill belongs to another Ghost");
        }
        if skill.revision
            != version.ok_or_else(|| anyhow!("supply the skill's current version to replace it"))?
        {
            bail!("another change was saved; re-open the skill and retry with its current version");
        }
    } else if version.is_some() {
        bail!("new skills take no version");
    }
    let dir_name = profile_name(s, profile_id)?;
    write_atomic(&active_path(root, &dir_name, &name), content)?;
    write_atomic(&revision_path(root, &dir_name, &name, &digest), content)?;
    let (title, description, privacy) = frontmatter(content);
    let now = now_ms();
    let skill = match existing {
        Some(mut skill) => {
            skill.digest = digest.clone();
            skill.revision += 1;
            skill.updated_ms = now;
            skill.origin = json!({"kind":"owner","request_id":request});
            skill.title = title;
            skill.description = description;
            skill.privacy = privacy;
            skill
        }
        None => Skill {
            id: name.clone(),
            profile_id: profile_id.to_owned(),
            digest: digest.clone(),
            revision: 1,
            status: "active".into(),
            privacy,
            origin: json!({"kind":"owner","request_id":request}),
            created_ms: now,
            updated_ms: now,
            title,
            description,
        },
    };
    s.journal.put(SKILL_KIND, &journal_key(profile_id, &name), &skill)?;
    Ok(json!({"skill": skill, "bytes": content.len()}))
}

pub(crate) fn list(s: &State, profile_id: &str) -> Result<Vec<Skill>> {
    Ok(s.journal
        .objects::<Skill>(SKILL_KIND)?
        .into_iter()
        .filter(|skill| skill.profile_id == profile_id)
        .collect())
}

/// The explicit pinned manifest for a scoped OMP session: exactly the active
/// skills this Ghost owns, with digests. Anything missing from the store or the
/// disk fails closed with the recovery instruction instead of entering a session.
pub(crate) fn manifest(s: &State, root: &Path, profile_id: &str) -> Result<Value> {
    let dir_name = profile_name(s, profile_id)?;
    let mut entries = Vec::new();
    for skill in list(s, profile_id)? {
        if skill.status != "active" {
            continue;
        }
        let path = active_path(root, &dir_name, &skill.id);
        let content = read_bounded(&path).map_err(|error| {
            anyhow!(
                "skill '{}' store content is unreadable ({error}); run skill recover {} before admission",
                skill.id,
                skill.id
            )
        })?;
        if digest_of(&content) != skill.digest {
            bail!(
                "skill '{}' content no longer matches its pinned digest; run skill recover {} before admission",
                skill.id,
                skill.id
            );
        }
        entries.push(json!({
            "name": skill.id,
            "description": skill.description,
            "sha256": skill.digest,
            "privacy": skill.privacy,
            "file": path.to_string_lossy(),
        }));
    }
    Ok(json!({"profile_id": profile_id, "skills": entries}))
}

/// Recovery: verify the active bytes against the pinned digest and restore the
/// pinned revision from the immutable revision copy when they diverge. The
/// pinned digest is authoritative — an unexplained drift never wins.
pub(crate) fn recover(s: &State, root: &Path, profile_id: &str, name: &str) -> Result<Value> {
    let name = skill_name(name)?;
    let mut skill: Skill = s
        .journal
        .get(SKILL_KIND, &journal_key(profile_id, &name))?
        .ok_or_else(|| anyhow!("skill not found"))?;
    if skill.profile_id != profile_id {
        bail!("skill belongs to another Ghost");
    }
    let dir_name = profile_name(s, profile_id)?;
    let active = active_path(root, &dir_name, &name);
    let pinned = revision_path(root, &dir_name, &name, &skill.digest);
    if !pinned.exists() {
        bail!(
            "pinned revision {} is missing from the store; re-import the skill from its Owner source",
            skill.digest
        );
    }
    let drifted = active.exists() && digest_of(&read_bounded(&active)?) != skill.digest;
    let missing = !active.exists();
    if !drifted && !missing {
        return Ok(json!({"skill": name, "status": "verified", "digest": skill.digest}));
    }
    let content = read_bounded(&pinned)?;
    write_atomic(&active, &content)?;
    skill.updated_ms = now_ms();
    skill.origin = json!({"kind":"recover","digest":skill.digest,"at_ms":skill.updated_ms});
    s.journal.put(SKILL_KIND, &journal_key(profile_id, &name), &skill)?;
    Ok(json!({
        "skill": name,
        "status": if missing { "restored" } else { "restored_after_drift" },
        "digest": skill.digest,
    }))
}

/// Save an improvement candidate from Owner-provided content. Candidates never
/// touch the active skill, its permissions or any verifier.
pub(crate) fn save_candidate(
    s: &State,
    root: &Path,
    request: &str,
    profile_id: &str,
    skill: &str,
    content: &str,
    note: &str,
) -> Result<Value> {
    let skill = skill_name(skill)?;
    let parent: Skill = s
        .journal
        .get(SKILL_KIND, &journal_key(profile_id, &skill))?
        .ok_or_else(|| anyhow!("candidate targets an unknown skill"))?;
    if parent.profile_id != profile_id {
        bail!("skill belongs to another Ghost");
    }
    if content.is_empty() || content.len() > MAX_SKILL_BYTES {
        bail!("candidate content must be 1..={MAX_SKILL_BYTES} bytes");
    }
    let digest = digest_of(content);
    if digest == parent.digest {
        bail!("candidate is identical to the active revision; nothing to improve");
    }
    if note.chars().count() > 2048 {
        bail!("candidate note must be at most 2048 characters");
    }
    let id = uuid::Uuid::now_v7().to_string();
    let dir_name = profile_name(s, profile_id)?;
    write_atomic(&candidate_path(root, &dir_name, &skill, &id), content)?;
    let candidate = SkillCandidate {
        id: id.clone(),
        profile_id: profile_id.to_owned(),
        skill: skill.clone(),
        digest,
        note: note.to_owned(),
        status: "draft".into(),
        created_ms: now_ms(),
        origin: json!({"kind":"owner","request_id":request}),
    };
    s.journal.put(SKILL_CANDIDATE_KIND, &id, &candidate)?;
    Ok(json!({
        "candidate": candidate,
        "active_digest": parent.digest,
    }))
}

/// Owner-controlled promotion: the candidate's stored bytes become the active
/// revision with a truthful candidate origin. This is the only path from draft
/// to active; tools and autonomous runs have no such capability.
pub(crate) fn promote_candidate(
    s: &State,
    root: &Path,
    profile_id: &str,
    candidate_id: &str,
) -> Result<Value> {
    let mut candidate: SkillCandidate = s
        .journal
        .get(SKILL_CANDIDATE_KIND, candidate_id)?
        .ok_or_else(|| anyhow!("candidate not found"))?;
    if candidate.profile_id != profile_id {
        bail!("candidate belongs to another Ghost");
    }
    if candidate.status != "draft" {
        bail!("candidate is already {}", candidate.status);
    }
    let dir_name = profile_name(s, profile_id)?;
    let path = candidate_path(root, &dir_name, &candidate.skill, candidate_id);
    if !path.exists() {
        bail!("candidate bytes are missing from the store; re-create the candidate");
    }
    let content = read_bounded(&path)?;
    if digest_of(&content) != candidate.digest {
        bail!("candidate bytes no longer match their recorded digest");
    }
    let mut skill: Skill = s
        .journal
        .get(SKILL_KIND, &journal_key(profile_id, &candidate.skill))?
        .ok_or_else(|| anyhow!("skill vanished"))?;
    if skill.profile_id != profile_id {
        bail!("skill belongs to another Ghost");
    }
    if skill.digest == candidate.digest {
        bail!("candidate is identical to the active revision");
    }
    write_atomic(&active_path(root, &dir_name, &skill.id), &content)?;
    write_atomic(
        &revision_path(root, &dir_name, &skill.id, &candidate.digest),
        &content,
    )?;
    let (title, description, privacy) = frontmatter(&content);
    skill.digest = candidate.digest.clone();
    skill.revision += 1;
    skill.updated_ms = now_ms();
    skill.origin = json!({"kind":"candidate","candidate_id":candidate_id});
    skill.title = title;
    skill.description = description;
    skill.privacy = privacy;
    s.journal.put(SKILL_KIND, &journal_key(profile_id, &skill.id), &skill)?;
    candidate.status = "promoted".into();
    s.journal.put(SKILL_CANDIDATE_KIND, candidate_id, &candidate)?;
    Ok(json!({"skill": skill, "promoted_from": candidate_id}))
}

/// Owner-controlled rejection: the candidate is closed without any store change.
pub(crate) fn reject_candidate(s: &State, profile_id: &str, candidate_id: &str) -> Result<Value> {
    let mut candidate: SkillCandidate = s
        .journal
        .get(SKILL_CANDIDATE_KIND, candidate_id)?
        .ok_or_else(|| anyhow!("candidate not found"))?;
    if candidate.profile_id != profile_id {
        bail!("candidate belongs to another Ghost");
    }
    if candidate.status != "draft" {
        bail!("candidate is already {}", candidate.status);
    }
    candidate.status = "rejected".into();
    s.journal.put(SKILL_CANDIDATE_KIND, candidate_id, &candidate)?;
    Ok(json!({"candidate": candidate_id, "status": "rejected"}))
}

/// Disable or re-enable a skill without deleting its store bytes.
pub(crate) fn set_status(s: &State, profile_id: &str, name: &str, status: &str) -> Result<Value> {
    let name = skill_name(name)?;
    let mut skill: Skill = s
        .journal
        .get(SKILL_KIND, &journal_key(profile_id, &name))?
        .ok_or_else(|| anyhow!("skill not found"))?;
    if skill.profile_id != profile_id {
        bail!("skill belongs to another Ghost");
    }
    if !matches!(status, "active" | "disabled") {
        bail!("skill status must be 'active' or 'disabled'");
    }
    skill.status = status.into();
    skill.updated_ms = now_ms();
    s.journal.put(SKILL_KIND, &journal_key(profile_id, &name), &skill)?;
    Ok(json!(skill))
}

/// Remove a skill and its store directory. Run history keeps the digests it
/// admitted; only this Ghost's store entry is deleted.
pub(crate) fn remove(s: &State, root: &Path, profile_id: &str, name: &str, version: u64) -> Result<Value> {
    let name = skill_name(name)?;
    let skill: Skill = s
        .journal
        .get(SKILL_KIND, &journal_key(profile_id, &name))?
        .ok_or_else(|| anyhow!("skill not found"))?;
    if skill.profile_id != profile_id {
        bail!("skill belongs to another Ghost");
    }
    if skill.revision != version {
        bail!("supply the skill's current version to delete it");
    }
    s.journal.delete(SKILL_KIND, &journal_key(profile_id, &name))?;
    let dir = skill_dir(root, &profile_name(s, profile_id)?, &name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(json!({"deleted": name}))
}

#[cfg(feature = "lifetime")]
/// Host-side derivation of sealed pinned skill refs for a Work admission: the
/// ONLY source is this journal's own authenticated skill store for the work's
/// owner Ghost — never caller/Goal metadata. Sorted by name for determinism;
/// empty store → None (specs stay byte-equivalent).
pub(crate) fn refs_for_work(
    conn: &rusqlite::Connection,
    owner: &str,
) -> Result<Option<Vec<crate::lifetime_contract::WorkerSkillRef>>> {
    use crate::lifetime_contract::WorkerSkillRef;
    let mut statement = conn.prepare(
        "SELECT payload FROM workspace_objects WHERE kind=?1 ORDER BY id",
    )?;
    let rows = statement.query_map([SKILL_KIND], |row| row.get::<_, String>(0))?;
    let mut refs = Vec::new();
    for row in rows {
        let skill: Skill = serde_json::from_str(&row?)?;
        if skill.profile_id != owner || skill.status != "active" {
            continue;
        }
        refs.push(WorkerSkillRef {
            name: skill.id,
            sha256: skill.digest,
            privacy: skill.privacy,
        });
    }
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    if refs.is_empty() {
        return Ok(None);
    }
    Ok(Some(refs))
}

#[cfg(feature = "lifetime")]
/// Aggregate skill payload budget: must fit the 1 MiB worker admission frame
/// alongside the sealed spec/prompt; nothing is truncated or skipped.
pub(crate) const MAX_SKILL_PAYLOAD_TOTAL: usize = 512 * 1024;

#[cfg(feature = "lifetime")]
/// Trusted Host-root fetch of the exact sealed revision bytes for a Work's
/// pinned refs (called by the per-Work dispatcher AFTER the joined-privacy
/// route is admitted). Every ref resolves to the immutable Host-owned revision
/// under `profiles/<profile>/skills/<name>/revisions/<sha256>/SKILL.md`.
/// Containment, symlink refusal and bounded UTF-8 remain enforced; a later
/// Owner upgrade never substitutes the current active file for a sealed pin.
/// Any miss is a hard error — no truncation, no substitution.
pub(crate) fn payloads_for_refs(
    host_root: &Path,
    profile_name: &str,
    refs: &[crate::lifetime_contract::WorkerSkillRef],
) -> Result<Vec<Value>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let skills_root = host_root.join("profiles").join(profile_name).join("skills");
    let skills_root_canonical = std::fs::canonicalize(&skills_root)?;
    let mut total = 0usize;
    let mut payloads = Vec::with_capacity(refs.len());
    for reference in refs {
        let path = revision_path(host_root, profile_name, &reference.name, &reference.sha256);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| anyhow!("pinned skill '{}' is missing from the Host store", reference.name))?;
        if metadata.is_symlink() || !metadata.is_file() || metadata.len() as usize > MAX_SKILL_BYTES {
            bail!("pinned skill '{}' store entry is not a bounded regular file", reference.name);
        }
        let resolved = std::fs::canonicalize(&path)?;
        if !resolved.starts_with(&skills_root_canonical) {
            bail!("pinned skill '{}' escapes the Host skill store", reference.name);
        }
        let content = std::fs::read_to_string(&resolved)?;
        let digest = digest_of(&content);
        if digest != reference.sha256 {
            bail!("pinned skill '{}' bytes do not match the sealed spec digest", reference.name);
        }
        if content.len() > MAX_SKILL_BYTES {
            bail!("pinned skill '{}' exceeds the bounded payload size", reference.name);
        }
        total += content.len();
        if total > MAX_SKILL_PAYLOAD_TOTAL {
            bail!(
                "aggregate skill payload exceeds the worker admission frame budget ({MAX_SKILL_PAYLOAD_TOTAL} bytes)"
            );
        }
        payloads.push(json!({
            "name": reference.name,
            "sha256": reference.sha256,
            "privacy": reference.privacy,
            "content": content,
        }));
    }
    Ok(payloads)
}
