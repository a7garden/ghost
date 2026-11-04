//! Explicit caller-owned brain transport. Cancellation drops the in-flight
//! connection so an unread response cannot be mistaken for the next request.
use crate::durable::durable::{ai, ToolOutput, ToolStatus};
use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};

#[cfg(feature = "memory")]
use anyhow::anyhow;
#[cfg(feature = "memory")]
use anyhow::Context;

#[cfg(feature = "memory")]
use oxibrain_client::{BrainClient, LocalProcessEndpoint};
#[cfg(feature = "memory")]
use serde_json::{json, Value};
#[cfg(feature = "memory")]
use std::{collections::BTreeMap, fs, path::Path};
#[cfg(feature = "memory")]
use tokio::sync::Mutex;
#[cfg(feature = "memory")]
#[path = "memory_scoped.rs"]
mod scoped;
#[cfg(feature = "memory")]
#[path = "memory_episode_write.rs"]
mod episode_write;
#[cfg(feature = "memory")]
#[path = "memory_source_recovery.rs"]
mod source_recovery;
#[cfg(feature = "memory")]
#[path = "memory_query.rs"]
pub(crate) mod query;
pub(crate) fn read_error_code(output:&ToolOutput)->Option<&'static str> {
    #[cfg(feature="memory")] {query::error_code(output)}
    #[cfg(not(feature="memory"))] {let _=output;None}
}
#[path = "memory_publication.rs"]
#[cfg(feature = "lifetime")]
pub(crate) mod publication;
#[cfg(feature = "memory")]
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
#[cfg(feature = "memory")]
use std::{
    fs::OpenOptions,
    io::ErrorKind,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(all(feature = "memory", unix))]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

#[cfg(feature = "memory")]
const SOURCE_LEDGER_VERSION: i64 = 3;
#[cfg(feature = "memory")]
const SOURCE_LEDGER_APPLICATION_ID: i64 = 0x4753_4231;
#[cfg(feature = "memory")]
const MAX_SOURCE_LEDGER_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(feature = "memory")]
const MAX_SOURCE_LEDGER_ROWS: i64 = 100_000;
#[cfg(feature = "memory")]
const MAX_SOURCE_LIST_ROWS: usize = 4_096;
#[cfg(feature = "memory")]
const MAX_SOURCE_CONTENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SOURCE_FIELD_BYTES: usize = 512;
#[cfg(feature = "memory")]
const MAX_SOURCE_QUERY_BUDGET: u64 = 2048;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceDisclosure {
    Public,
    Private,
    LocalOnly,
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceOriginKind {
    Note,
    Session { session_id: String },
}
/// Identity supplied by the trusted Host/source boundary, never by model tool arguments.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TrustedSourceOrigin {
    pub owner: String,
    pub source_id: String,
    pub revision: String,
    pub disclosure: SourceDisclosure,
    pub content_sha256: String,
    pub kind: SourceOriginKind,
}

impl TrustedSourceOrigin {
    pub fn new(
        owner: impl Into<String>,
        source_id: impl Into<String>,
        revision: impl Into<String>,
        disclosure: SourceDisclosure,
        content_sha256: impl Into<String>,
    ) -> Result<Self> {
        let origin = Self {
            owner: owner.into(),
            source_id: source_id.into(),
            revision: revision.into(),
            disclosure,
            content_sha256: content_sha256.into(),
            kind: SourceOriginKind::Note,
        };
        validate_origin(&origin)?;
        Ok(origin)
    }

    pub fn new_session(
        owner: impl Into<String>,
        source_id: impl Into<String>,
        revision: impl Into<String>,
        disclosure: SourceDisclosure,
        content_sha256: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<Self> {
        let origin = Self {
            owner: owner.into(),
            source_id: source_id.into(),
            revision: revision.into(),
            disclosure,
            content_sha256: content_sha256.into(),
            kind: SourceOriginKind::Session {
                session_id: session_id.into(),
            },
        };
        validate_origin(&origin)?;
        Ok(origin)
    }
}

/// Explicit Ghost-owned source ledger location; never inferred from cwd.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceLedgerConfig {
    pub path: std::path::PathBuf,
}

impl SourceLedgerConfig {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Result<Self> {
        let path = path.into();
        if !path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(anyhow::anyhow!(
                "source ledger path must be absolute and contain no parent traversal"
            ));
        }
        Ok(Self { path })
    }

    pub fn from_env() -> Result<Self> {
        let path = std::env::var_os("GHOST_BRAIN_SOURCE_LEDGER")
            .ok_or_else(|| anyhow::anyhow!("GHOST_BRAIN_SOURCE_LEDGER is not configured"))?;
        Self::new(path)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    NotFound,
    Prepared,
    Recorded,
    AlreadyRecorded,
    EffectUnknown,
    Redacted,
    CorrectionComplete,
    CorrectionBlocked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceCapabilities {
    pub notes: bool,
    pub sessions: bool,
}

/// Receipt contains identities and hashes, never source text or redaction plan tokens.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceReceipt {
    pub status: SourceStatus,
    pub owner: String,
    pub source_id: String,
    pub revision: String,
    pub disclosure: SourceDisclosure,
    pub content_sha256: String,
    pub source_locator: String,
    pub episode_id: Option<String>,
    pub prior_episode_id: Option<String>,
    pub redaction_closure_sha256: Option<String>,
}

pub struct Brain {
    #[cfg(feature = "memory")]
    client: Mutex<Option<BrainClient>>,
}

impl Default for Brain {
    fn default() -> Self {
        Self {
            #[cfg(feature = "memory")]
            client: Mutex::new(None),
        }
    }
}

impl Brain {
    pub fn configured() -> bool {
        #[cfg(feature = "memory")]
        {
            let Some(path) = std::env::var_os("GHOST_BRAIN_SPACE_MAP") else {
                return false;
            };
            let safe_map = fs::symlink_metadata(Path::new(&path))
                .map(|metadata| {
                    metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && metadata.len() <= 65_536
                })
                .unwrap_or(false);
            safe_map
                && std::env::var_os("GHOST_BRAIN_EXECUTABLE").is_some()
                && std::env::var_os("GHOST_BRAIN_DIR").is_some()
                && (scoped::enabled() || std::env::var("GHOST_BRAIN_TOKEN").is_ok_and(|token| !token.is_empty()))
        }
        #[cfg(not(feature = "memory"))]
        {
            false
        }
    }

    #[cfg(feature = "memory")]
    fn space_for_owner(owner: &str) -> Result<Option<String>> {
        let path = std::env::var_os("GHOST_BRAIN_SPACE_MAP")
            .ok_or_else(|| anyhow!("explicit brain space map is not configured"))?;
        let path = Path::new(&path);
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 65_536 {
            bail!("brain space map must be a small regular file, not a symlink");
        }
        let map = crate::adapters::memory_bindings::LegacySpaceMap::parse(&fs::read(path)?)?;
        let Some(space) = map.mapped_space(owner).map(str::to_owned) else {
            return Ok(None);
        };
        if space.is_empty()
            || space.len() > 80
            || !space
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            bail!("configured brain space name is invalid");
        }
        Ok(Some(space))
    }

    #[cfg(feature = "memory")]
    async fn connect() -> Result<BrainClient> {
        let executable = std::env::var_os("GHOST_BRAIN_EXECUTABLE")
            .ok_or_else(|| anyhow!("brain executable is not configured"))?;
        let dir = std::env::var_os("GHOST_BRAIN_DIR")
            .ok_or_else(|| anyhow!("explicit brain directory is not configured"))?;
        let mut client =
            BrainClient::spawn_local(LocalProcessEndpoint::new(executable, dir)).await?;
        let token = std::env::var("GHOST_BRAIN_TOKEN")
            .map_err(|_| anyhow!("scoped brain token is not configured"))?;
        client
            .bring_up(
                Some(&token),
                oxibrain_client::default_client_hello(env!("CARGO_PKG_VERSION")),
            )
            .await?;
        Ok(client)
    }

    /// Opaque configuration stamp. This is provenance, never a credential or
    /// evidence that the engine accepted the scoped token.
    pub fn context_revision(owner: &str) -> Result<String> {
        #[cfg(not(feature = "memory"))]
        { let _ = owner; bail!("memory feature unavailable"); }
        #[cfg(feature = "memory")]
        {
            use sha2::{Digest, Sha256};
            if let Some(snapshot) = scoped::snapshot(owner)? { return Ok(snapshot.revision); }
            let space = Self::space_for_owner(owner)?;
            let secret = std::env::var("GHOST_BRAIN_TOKEN").unwrap_or_default();
            let payload = json!({"owner":owner,"space":space,
                "token_digest":format!("{:x}",Sha256::digest(secret.as_bytes())),
                "executable":std::env::var_os("GHOST_BRAIN_EXECUTABLE").map(|value|value.to_string_lossy().into_owned()),
                "directory":std::env::var_os("GHOST_BRAIN_DIR").map(|value|value.to_string_lossy().into_owned())});
            Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&payload)?)))
        }
    }

    pub fn read_available(owner: &str) -> Result<bool> {
        #[cfg(not(feature = "memory"))]
        { let _ = owner; return Ok(false); }
        #[cfg(feature = "memory")]
        { Ok(if let Some(snapshot) = scoped::snapshot(owner)? { !snapshot.bindings.is_empty() }
            else { Self::configured() && Self::space_for_owner(owner)?.is_some() }) }
    }

    pub fn work_profile(owner: &str, ids: &[String]) -> Result<crate::adapters::memory_bindings::WorkMemoryProfile> {
        #[cfg(not(feature="memory"))]
        {let _=(owner,ids);bail!("memory feature unavailable");}
        #[cfg(feature="memory")]
        {Ok(scoped::snapshot(owner)?.ok_or_else(||anyhow!("Work memory requires explicit scoped bindings"))?
            .restrict_shared(ids)?.work_profile())}
    }

    #[cfg(feature="memory")]
    fn work_snapshot(owner:&str,profile:&crate::adapters::memory_bindings::WorkMemoryProfile)->Result<scoped::ScopeSnapshot> {
        let ids:Vec<_>=profile.bindings.iter().map(|binding|binding.id.clone()).collect();
        let snapshot=scoped::snapshot(owner)?.ok_or_else(||anyhow!("Work memory bindings are unavailable"))?.restrict_shared(&ids)?;
        ensure!(snapshot.work_profile()==*profile,"Work memory grant changed; a new admitted revision is required");
        Ok(snapshot)
    }

    pub async fn validate_work_context(&self,owner:&str,profile:&crate::adapters::memory_bindings::WorkMemoryProfile,
        check:impl Fn()->Result<()>+Send+Sync)->Result<String> {
        check()?;
        #[cfg(not(feature="memory"))]
        {let _=(owner,profile);bail!("memory feature unavailable");}
        #[cfg(feature="memory")]
        {
            let snapshot=Self::work_snapshot(owner,profile)?;
            let mut slot=self.client.lock().await;drop(slot.take());
            for binding in &snapshot.bindings {drop(snapshot.connect(binding,owner,&check).await?);}
            snapshot.check(owner,&check)?;
            Ok(snapshot.revision)
        }
    }

    pub async fn read_work_memory(&self,owner:&str,session:&str,profile:&crate::adapters::memory_bindings::WorkMemoryProfile,
        call:&ai::ToolCall,check:impl Fn()->Result<()>+Send+Sync)->Result<ToolOutput> {
        check()?;
        ensure!(call.name=="memory_recall","Work memory permits recall only");
        #[cfg(not(feature="memory"))]
        {let _=(owner,session,profile,call);bail!("memory feature unavailable");}
        #[cfg(feature="memory")]
        {let snapshot=Self::work_snapshot(owner,profile)?;self.scoped_read(owner,session,call,&snapshot,&check).await}
    }

    /// A read of the existing documents plane triggers its normal registered-root
    /// reconciliation. This never registers a root or ingests an episode.
    pub async fn experience_document_indexed(&self,owner:&str,page_id:&str,expected_root:&std::path::Path,expected_sha256:&str,
        check:impl Fn()->Result<()>+Send+Sync)->Result<bool> {
        check()?;
        #[cfg(not(feature="memory"))]
        {let _=(owner,page_id,expected_root,expected_sha256);bail!("memory feature unavailable");}
        #[cfg(feature="memory")]
        {
            use crate::adapters::memory_bindings::MemoryCapability::Read;
            ensure!(Self::source_permission(owner,&[Read])?,"own document read capability is not granted");
            let revision=Self::context_revision(owner)?;
            let guarded=||{check()?;ensure!(Self::context_revision(owner)?==revision,"memory authority changed during document reconciliation");Ok(())};
            let space=Self::space_for_owner(owner)?.ok_or_else(||anyhow!("own document space is not mapped"))?;
            let mut slot=self.client.lock().await;drop(slot.take());
            let mut client=Self::connect_source(owner,&[Read],None,&guarded).await?;
            let proof=client.document_source_proof(&space,page_id,expected_sha256).await?;
            let proof_space_allowed=proof.as_ref().is_none_or(|proof|client.authenticated_scope().and_then(|scope|scope["spaces"].as_array()).is_some_and(|spaces|spaces.iter().any(|space|space.as_str()==Some(proof.space.as_str()))));
            guarded()?;
            drop(Self::connect_source(owner,&[Read],None,&guarded).await?);
            let Some(proof)=proof else{return Ok(false);};
            if !proof_space_allowed {return Ok(false);}
            let expected=expected_root.canonicalize()?.join(format!("{page_id}.md")).canonicalize()?;
            let root=std::path::Path::new(&proof.canonical_root);
            let relative=std::path::Path::new(&proof.locator);
            if !root.is_absolute() || relative.components().any(|component|!matches!(component,std::path::Component::Normal(_))) {return Ok(false);}
            let observed=root.join(relative).canonicalize()?;
            Ok(proof.fresh && proof.root_generation>0 && !proof.source_revision.is_empty()
                && proof.document_uuid==page_id && proof.source_sha256==expected_sha256
                && observed==expected && observed.starts_with(root.canonicalize()?))
        }
    }

    /// Reauthenticate rather than trusting a cached engine Scope. A failed
    /// check makes prior memory context unsafe to reuse, even with no query.
    pub async fn validate_context(&self, owner: &str,
        check: impl Fn() -> Result<()> + Send + Sync) -> Result<String> {
        check()?;
        #[cfg(not(feature = "memory"))]
        { let _ = owner; bail!("memory feature unavailable"); }
        #[cfg(feature = "memory")]
        {
            let revision = Self::context_revision(owner)?;
            let mut slot = self.client.lock().await;
            drop(slot.take());
            if let Some(snapshot) = scoped::snapshot(owner)? {
                for binding in &snapshot.bindings {
                    drop(snapshot.connect(binding,owner,&check).await?);
                }
                snapshot.check(owner,&check)?;
            } else {
                let space = Self::space_for_owner(owner)?.ok_or_else(||anyhow!("owner has no mapped memory space"))?;
                let mut client = Self::connect().await?;
                verify_engine_owner_space(&mut client,owner,&space,&check).await?;
            }
            check()?;
            ensure!(Self::context_revision(owner)? == revision,"memory authority changed during context inspection");
            Ok(revision)
        }
    }

    #[cfg(feature = "memory")]
    fn source_permission(owner: &str, required: &[crate::adapters::memory_bindings::MemoryCapability]) -> Result<bool> {
        Ok(match scoped::snapshot(owner)? {
            Some(snapshot) => snapshot.source(required)?.is_some(),
            None => true,
        })
    }

    #[cfg(feature = "memory")]
    async fn connect_source(owner: &str, required: &[crate::adapters::memory_bindings::MemoryCapability],
        cached: Option<BrainClient>, check: &(impl Fn() -> Result<()> + Send + Sync)) -> Result<BrainClient> {
        // Every operation authenticates a fresh session; never reuse a token's
        // previously resolved Scope after a policy or engine revocation.
        drop(cached);
        if let Some(snapshot) = scoped::snapshot(owner)? {
            let binding = snapshot.source(required)?.ok_or_else(||anyhow!("own source memory capability is not granted"))?;
            snapshot.connect(binding,owner,check).await
        } else { Self::connect().await }
    }

    #[cfg(feature = "memory")]
    async fn finish_source(owner: &str, required: &[crate::adapters::memory_bindings::MemoryCapability],
        client: BrainClient, cached: &mut Option<BrainClient>, mut result: Result<SourceReceipt>,
        check: &(impl Fn() -> Result<()> + Send + Sync)) -> Result<SourceReceipt> {
        if scoped::enabled() {
            drop(client);
            // Even engine-side revocation with an unchanged config must fence
            // delivery. Preserve the original source/receipt identity and let
            // the existing ledger reconcile; never issue another ingest.
            if result.is_ok() && Self::connect_source(owner,required,None,check).await.is_err() {
                if let Ok(receipt) = &mut result { receipt.status = SourceStatus::EffectUnknown; }
            }
        } else if result.as_ref().is_ok_and(|receipt| !matches!(receipt.status,
            SourceStatus::EffectUnknown | SourceStatus::CorrectionBlocked)) {
            *cached = Some(client);
        }
        result
    }

    pub async fn read_memory(
        &self,
        owner: &str,
        current_session_id: &str,
        call: &ai::ToolCall,
        check: impl Fn() -> Result<()> + Send + Sync,
    ) -> Result<ToolOutput> {
        check()?;
        if !matches!(
            call.name.as_str(),
            "memory_search" | "memory_recall" | "memory_session_list"
        ) {
            return Ok(ToolOutput::error(
                ToolStatus::Denied,
                "memory writes require a Host-provided trusted source identity and receipt ledger",
            ));
        }
        #[cfg(not(feature = "memory"))]
        {
            let _ = (owner, current_session_id, call);
            return Ok(ToolOutput::error(
                ToolStatus::Failed,
                "memory adapter unavailable; enable the `memory` feature",
            ));
        }

        #[cfg(feature = "memory")]
        {
            if !Self::configured() {
                return Ok(ToolOutput::error(
                    ToolStatus::Failed,
                    "oxibrain is not configured with a scoped token and profile space map",
                ));
            }
            if let Some(snapshot) = scoped::snapshot(owner)? {
                return self.scoped_read(owner,current_session_id,call,&snapshot,&check).await;
            }
            let space = match Self::space_for_owner(owner) {
                Ok(Some(space)) => space,
                Ok(None) => {
                    return Ok(ToolOutput::error(
                        ToolStatus::Denied,
                        "this Ghost profile has no mapped memory space",
                    ))
                }
                Err(_) => {
                    return Ok(ToolOutput::error(
                        ToolStatus::Failed,
                        "oxibrain profile space map is invalid",
                    ))
                }
            };
            let captured_revision = Self::context_revision(owner)?;
            let guarded = || { check()?; ensure!(Self::context_revision(owner)? == captured_revision,
                "memory authority changed during I/O"); Ok(()) };
            let mut output = self.memory_connected(&space,current_session_id,call,&guarded).await?;
            if output.status == ToolStatus::Success {
                if self.validate_context(owner,&guarded).await.is_err() {
                    return Ok(ToolOutput::error(ToolStatus::Denied,"Memory authority cannot be revalidated; retrieved content withheld"));
                }
                if let Some(value) = output.content.as_object_mut() {
                    value.insert("context_revision".into(),json!(captured_revision));
                }
            }
            Ok(output)
        }
    }
    /// Source-backed ingest configured only through an explicit Ghost ledger.
    pub fn source_configured() -> bool {
        #[cfg(feature = "memory")]
        {
            Self::configured() && SourceLedgerConfig::from_env().is_ok()
        }
        #[cfg(not(feature = "memory"))]
        {
            false
        }
    }

    pub async fn source_capabilities(
        &self,
        owner: &str,
        ledger: &SourceLedgerConfig,
        check: impl Fn() -> Result<()> + Send + Sync,
    ) -> Result<SourceCapabilities> {
        check()?;
        #[cfg(not(feature = "memory"))]
        {
            let _ = (owner, ledger);
            bail!("source-backed memory requires the `memory` feature");
        }
        #[cfg(feature = "memory")]
        {
            ensure_brain_configured()?;
            use crate::adapters::memory_bindings::MemoryCapability::{Read, Ingest};
            if !Self::source_permission(owner,&[Read,Ingest])? {
                return Ok(SourceCapabilities { notes:false, sessions:false });
            }
            let captured_revision = Self::context_revision(owner)?;
            let upstream_check = check;
            let check = || { upstream_check()?;
                ensure!(Self::context_revision(owner)? == captured_revision,"memory authority changed during I/O"); Ok(()) };
            let space = Self::space_for_owner(owner)?
                .ok_or_else(|| anyhow!("owner has no mapped OxiBrain space"))?;
            let brain_dir = configured_brain_dir()?;
            check_owner_authority(owner, &space, &check)?;
            let mut slot = self.client.lock().await;
            let mut client = Self::connect_source(owner,&[Read,Ingest],slot.take(),&check).await?;
            let result: Result<SourceCapabilities> = async {
                verify_engine_owner_space(&mut client, owner, &space, &check).await?;
                let capabilities =
                    probe_source_capabilities(&mut client, owner, &space, &check).await?;
                drop(open_source_ledger(ledger, &brain_dir)?);
                check_owner_authority(owner, &space, &check)?;
                Ok(capabilities)
            }
            .await;
            if scoped::enabled() {
                drop(client);
                if result.is_ok() { drop(Self::connect_source(owner,&[Read,Ingest],None,&check).await?); }
            } else if result.is_ok() {
                *slot = Some(client);
            }
            result
        }
    }

    pub async fn ingest_source(
        &self,
        origin: &TrustedSourceOrigin,
        content: &str,
        ledger: &SourceLedgerConfig,
        check: impl Fn() -> Result<()> + Send + Sync,
    ) -> Result<SourceReceipt> {
        check()?;
        #[cfg(not(feature = "memory"))]
        {
            let _ = (origin, content, ledger);
            bail!("source-backed memory requires the `memory` feature");
        }
        #[cfg(feature = "memory")]
        {
            validate_origin_content(origin, content)?;
            ensure_brain_configured()?;
            use crate::adapters::memory_bindings::MemoryCapability::{Read, Ingest};
            ensure!(Self::source_permission(&origin.owner,&[Read,Ingest])?,"own memory ingest capability is not granted");
            let captured_revision = Self::context_revision(&origin.owner)?;
            let upstream_check = check;
            let check = || { upstream_check()?;
                ensure!(Self::context_revision(&origin.owner)? == captured_revision,"memory authority changed during I/O"); Ok(()) };
            let space = Self::space_for_owner(&origin.owner)?
                .ok_or_else(|| anyhow!("owner has no mapped OxiBrain space"))?;
            let brain_dir = configured_brain_dir()?;
            check_source_authority(origin, &space, &check)?;
            if matches!(&origin.kind, SourceOriginKind::Session { .. }) {
                let mut slot = self.client.lock().await;
                let mut client = Self::connect_source(&origin.owner,&[Read,Ingest],slot.take(),&check).await?;
                let result = async {
                    verify_engine_space(&mut client, origin, &space, &check).await?;
                    require_session_record_schema(&mut client, origin, &space, &check).await?;
                    let prepared =
                        prepare_ingest(origin, content, &space, ledger, &brain_dir, None)?;
                    let record = match prepared {
                        PreparedIngest::Local(receipt) => return Ok(receipt),
                        PreparedIngest::Work(record) => record,
                    };
                    execute_ingest(
                        &mut client,
                        origin,
                        content,
                        &space,
                        ledger,
                        &brain_dir,
                        record,
                        &check,
                    )
                    .await
                }
                .await;
                return Self::finish_source(&origin.owner,&[Read,Ingest],client,&mut slot,result,&check).await;
            }
            let prepared = match prepare_ingest(origin, content, &space, ledger, &brain_dir, None)? {
                PreparedIngest::Local(receipt) => return Ok(receipt),
                PreparedIngest::Work(record) => record,
            };
            let mut slot = self.client.lock().await;
            let mut client = Self::connect_source(&origin.owner,&[Read,Ingest],slot.take(),&check).await?;
            let result = execute_ingest(
                &mut client,
                origin,
                content,
                &space,
                ledger,
                &brain_dir,
                prepared,
                &check,
            )
            .await;
            Self::finish_source(&origin.owner,&[Read,Ingest],client,&mut slot,result,&check).await
        }
    }

    pub async fn inspect_source(
        &self,
        origin: &TrustedSourceOrigin,
        content: &str,
        ledger: &SourceLedgerConfig,
        check: impl Fn() -> Result<()> + Send + Sync,
    ) -> Result<SourceReceipt> {
        check()?;
        #[cfg(not(feature = "memory"))]
        {
            let _ = (origin, content, ledger);
            bail!("source-backed memory requires the `memory` feature");
        }
        #[cfg(feature = "memory")]
        {
            validate_origin_content(origin, content)?;
            ensure_brain_configured()?;
            use crate::adapters::memory_bindings::MemoryCapability::Read;
            ensure!(Self::source_permission(&origin.owner,&[Read])?,"own memory read capability is not granted");
            let captured_revision = Self::context_revision(&origin.owner)?;
            let upstream_check = check;
            let check = || { upstream_check()?;
                ensure!(Self::context_revision(&origin.owner)? == captured_revision,"memory authority changed during I/O"); Ok(()) };
            let space = Self::space_for_owner(&origin.owner)?
                .ok_or_else(|| anyhow!("owner has no mapped OxiBrain space"))?;
            let brain_dir = configured_brain_dir()?;
            check_source_authority(origin, &space, &check)?;
            let record = match load_source_record(origin, &space, ledger, &brain_dir)? {
                Some(record) => record,
                None => {
                    return Ok(receipt(
                        origin,
                        &source_locator(origin),
                        SourceStatus::NotFound,
                        None,
                        None,
                        None,
                    ))
                }
            };
            if record.ingest_state == "prepared" {
                return Ok(record_receipt(origin, &record, SourceStatus::Prepared));
            }
            let mut slot = self.client.lock().await;
            let mut client = Self::connect_source(&origin.owner,&[Read],slot.take(),&check).await?;
            let result = inspect_record(
                &mut client,
                origin,
                content,
                &space,
                &brain_dir,
                ledger,
                &record,
                &check,
            )
            .await;
            Self::finish_source(&origin.owner,&[Read],client,&mut slot,result,&check).await
        }
    }

    pub async fn correct_source(
        &self,
        prior: &TrustedSourceOrigin,
        expected_prior_episode_id: &str,
        prior_content: &str,
        replacement: &TrustedSourceOrigin,
        replacement_content: &str,
        ledger: &SourceLedgerConfig,
        check: impl Fn() -> Result<()> + Send + Sync,
    ) -> Result<SourceReceipt> {
        check()?;
        #[cfg(not(feature = "memory"))]
        {
            let _ = (
                prior,
                expected_prior_episode_id,
                prior_content,
                replacement,
                replacement_content,
                ledger,
            );
            bail!("source-backed memory requires the `memory` feature");
        }
        #[cfg(feature = "memory")]
        {
            validate_origin_content(prior, prior_content)?;
            validate_origin_content(replacement, replacement_content)?;
            ensure!(
                prior.owner == replacement.owner
                    && prior.source_id == replacement.source_id
                    && prior.revision != replacement.revision
                    && match (&prior.kind, &replacement.kind) {
                        (SourceOriginKind::Note, SourceOriginKind::Note) => true,
                        (
                            SourceOriginKind::Session { session_id: prior_id },
                            SourceOriginKind::Session {
                                session_id: replacement_id,
                            },
                        ) => prior_id != replacement_id,
                        _ => false,
                    },
                "correction must preserve provenance kind and use a distinct revision/session id"
            );
            ensure!(
                valid_episode_id(expected_prior_episode_id),
                "prior episode id is malformed"
            );
            ensure_brain_configured()?;
            use crate::adapters::memory_bindings::MemoryCapability::{Read,Ingest,Redact};
            ensure!(Self::source_permission(&prior.owner,&[Read,Ingest,Redact])?,"own memory correction capability is not granted");
            let captured_revision = Self::context_revision(&prior.owner)?;
            let upstream_check = check;
            let check = || { upstream_check()?;
                ensure!(Self::context_revision(&prior.owner)? == captured_revision,"memory authority changed during I/O"); Ok(()) };
            let space = Self::space_for_owner(&prior.owner)?
                .ok_or_else(|| anyhow!("owner has no mapped OxiBrain space"))?;
            let brain_dir = configured_brain_dir()?;
            check_source_authority(prior, &space, &check)?;
            let mut slot = self.client.lock().await;
            let mut client = Self::connect_source(&prior.owner,&[Read,Ingest,Redact],slot.take(),&check).await?;
            let result = execute_correction(
                &mut client,
                prior,
                expected_prior_episode_id,
                prior_content,
                replacement,
                replacement_content,
                &space,
                ledger,
                &brain_dir,
                &check,
            )
            .await;
            Self::finish_source(&prior.owner,&[Read,Ingest,Redact],client,&mut slot,result,&check).await
        }
    }

    /// Bounded read-only listing of one owner's source-revision receipts from
    /// the Ghost-owned ledger, latest first. Read-only: no OxiBrain contact,
    /// no state transition, and never any source text. Every retained or
    /// session revision is listed, including the redacted prior of a
    /// completed Owner correction; correction revisions keep the same source
    /// id, so revision identity stays explicit for the review surface. The
    /// flag reports whether older revisions exist beyond the listing bound.
    pub fn list_source_receipts(
        &self,
        owner: &str,
        ledger: &SourceLedgerConfig,
        check: impl Fn() -> Result<()> + Send + Sync,
    ) -> Result<(Vec<ListedSource>, bool)> {
        check()?;
        #[cfg(not(feature = "memory"))]
        {
            let _ = (owner, ledger);
            bail!("source-backed memory requires the `memory` feature");
        }
        #[cfg(feature = "memory")]
        {
            ensure_brain_configured()?;
            let space = Self::space_for_owner(owner)?
                .ok_or_else(|| anyhow!("owner has no mapped OxiBrain space"))?;
            let brain_dir = configured_brain_dir()?;
            check_owner_authority(owner, &space, &check)?;
            let connection = open_source_ledger(ledger, &brain_dir)?;
            let mut statement = connection.prepare(
                "SELECT owner,source_id,revision,source_kind,session_id,disclosure,space,
                        content_sha256,source_locator,ingest_state,episode_id,prior_revision,
                        prior_episode_id,redaction_state,redaction_closure_sha256,attempt_nonce
                 FROM source_records WHERE owner=?1
                 ORDER BY updated_at_ms DESC, rowid DESC",
            )?;
            let mut rows = statement.query(params![owner])?;
            let mut heads: Vec<ListedSource> = Vec::new();
            let mut more = false;
            let mut scanned = 0usize;
            while let Some(row) = rows.next()? {
                scanned += 1;
                if scanned % 1_024 == 0 {
                    check()?;
                }
                if heads.len() >= MAX_SOURCE_LIST_ROWS {
                    more = true;
                    break;
                }
                let owner_value: String = row.get(0)?;
                let source_id: String = row.get(1)?;
                let revision: String = row.get(2)?;
                let source_kind: String = row.get(3)?;
                let session_id: Option<String> = row.get(4)?;
                let disclosure: String = row.get(5)?;
                let space_value: String = row.get(6)?;
                let content_sha256: String = row.get(7)?;
                let source_locator: String = row.get(8)?;
                let ingest_state: String = row.get(9)?;
                let episode_id: Option<String> = row.get(10)?;
                let prior_revision: Option<String> = row.get(11)?;
                let prior_episode_id: Option<String> = row.get(12)?;
                let redaction_state: String = row.get(13)?;
                let redaction_closure_sha256: Option<String> = row.get(14)?;
                ensure!(
                    owner_value == owner && space_value == space,
                    "owner memory-space mapping changed"
                );
                let origin = TrustedSourceOrigin {
                    owner: owner_value,
                    source_id,
                    revision,
                    disclosure: match disclosure.as_str() {
                        "public" => SourceDisclosure::Public,
                        "private" => SourceDisclosure::Private,
                        "local_only" => SourceDisclosure::LocalOnly,
                        _ => bail!("source ledger contains an unsupported disclosure"),
                    },
                    content_sha256,
                    kind: match source_kind.as_str() {
                        "note" => SourceOriginKind::Note,
                        "session" => SourceOriginKind::Session {
                            session_id: session_id
                                .clone()
                                .ok_or_else(|| anyhow!("session source lacks its session id"))?,
                        },
                        _ => bail!("source ledger contains an unsupported source kind"),
                    },
                };
                validate_origin(&origin)?;
                let record = SourceRecord {
                    space: space_value,
                    source_kind,
                    session_id,
                    disclosure,
                    content_sha256: origin.content_sha256.clone(),
                    source_locator,
                    ingest_state,
                    episode_id,
                    prior_revision: prior_revision.clone(),
                    prior_episode_id,
                    redaction_state,
                    redaction_closure_sha256,
                    attempt_nonce:row.get(15)?,
                };
                check_record_identity(&origin, &record.space, &record)?;
                let status = listed_receipt_status(&record)?;
                heads.push(ListedSource {
                    receipt: record_receipt(&origin, &record, status),
                    origin,
                    prior_revision,
                    redaction_state: record.redaction_state,
                });
            }
            check()?;
            Ok((heads, more))
        }
    }

    #[cfg(feature = "memory")]
    async fn scoped_read(&self, owner: &str, current_session_id: &str, call: &ai::ToolCall,
        snapshot: &scoped::ScopeSnapshot, check: &(impl Fn() -> Result<()> + Send + Sync)) -> Result<ToolOutput> {
        snapshot.check(owner,check)?;
        let query_scope=match query::QueryScope::parse(&call.arguments) {Ok(scope)=>scope,Err(error)=>return Ok(error.output())};
        let mut slot = self.client.lock().await;
        drop(slot.take());
        snapshot.check(owner,check)?;
        let count = snapshot.bindings.iter().map(|binding|binding.spaces.len()).sum::<usize>();
        if count == 0 { return Ok(ToolOutput::error(ToolStatus::Denied,"No read memory binding is granted")); }
        let budget = call.arguments["token_budget"].as_u64().unwrap_or(1024).clamp(128,2048) as usize;
        let limit = if call.name == "memory_session_list" { call.arguments["limit"].as_u64().unwrap_or(10).clamp(1,20) as usize } else { 12 };
        let mut scopes = Vec::new();
        let mut evidence = Vec::new();
        let mut index = 0usize;
        let mut partial = false;
        let mut result_bytes = 0usize;
        let mut delivered_bindings = Vec::new();
        for binding in &snapshot.bindings {
            snapshot.check(owner,check)?;
            let connected = snapshot.connect(binding,owner,check).await;
            if snapshot.check(owner,check).is_err() {
                return Ok(ToolOutput::error(ToolStatus::Denied,"Memory grant changed; retrieved content withheld"));
            }
            let mut client = connected.ok();
            if let Some(client)=client.as_mut() {if let Some(error)=query_scope.validate_native(client,if call.name=="memory_search" {"search"} else {"recall"}).await? {return Ok(error);}}
            let mut delivered = false;
            for space in &binding.spaces {
                let scope_budget = budget / count + usize::from(index < budget % count);
                let scope_limit = limit / count + usize::from(index < limit % count);
                index += 1;
                if scope_limit == 0 && call.name != "memory_recall" {
                    partial = true;
                    scopes.push(json!({"binding_id":binding.id,"space":space,"partial":true,"reason":"total_result_limit"}));
                    continue;
                }
                let result: Result<Value> = async {
                    let client = client.as_mut().ok_or_else(||anyhow!("scoped memory unavailable"))?;
                    snapshot.check(owner,check)?;
                    let value = match call.name.as_str() {
                        "memory_recall" => {let mut args=json!({"space":space,
                            "query":call.arguments["query"],"session_id":current_session_id,"token_budget":scope_budget});query_scope.apply(&mut args);client.call_tool_json("recall",args).await?},
                        "memory_search" => {let mut args=json!({"space":space,
                            "query":call.arguments["query"],"mode":"auto","limit":scope_limit});query_scope.apply(&mut args);client.call_tool_json("search",args).await?},
                        "memory_session_list" => client.call_tool_json("session_list",json!({"space":space,
                            "session_id":current_session_id,"limit":scope_limit})).await?,
                        _ => bail!("unsupported scoped memory read"),
                    };
                    snapshot.check(owner,check)?;
                    Ok(value)
                }.await;
                match result {
                    Ok(value) => {
                        let bytes = serde_json::to_vec(&value)?.len();
                        if bytes > 262_144 || result_bytes + bytes > 524_288 {
                            partial = true;
                            scopes.push(json!({"binding_id":binding.id,"space":space,"partial":true,"reason":"result_size_limit"}));
                            continue;
                        }
                        result_bytes += bytes;
                        delivered = true;
                        if let Some(items) = value.pointer("/data/evidence").and_then(Value::as_array) {
                            for item in items { evidence.push(json!({"binding_id":binding.id,"space":space,"source":item})); }
                        }
                        let scope_partial = value.pointer("/meta/partial").and_then(Value::as_bool).unwrap_or(false);
                        partial |= scope_partial;
                        scopes.push(json!({"binding_id":binding.id,"space":space,"policy_revision":binding.policy_revision,
                            "token_budget":scope_budget,"partial":scope_partial,"result":value}));
                    }
                    Err(_) => {
                        partial = true;
                        scopes.push(json!({"binding_id":binding.id,"space":space,"partial":true,"reason":"scope_unavailable"}));
                    }
                }
                if snapshot.check(owner,check).is_err() {
                    return Ok(ToolOutput::error(ToolStatus::Denied,"Memory grant changed; retrieved content withheld"));
                }
            }
            drop(client);
            if delivered { delivered_bindings.push(binding); }
        }
        // A token can be revoked in the engine without changing Host config.
        // Fresh post-query authentication fences such in-flight results too.
        for binding in delivered_bindings {
            if snapshot.connect(binding,owner,check).await.is_err() {
                return Ok(ToolOutput::error(ToolStatus::Denied,"Memory grant cannot be revalidated; retrieved content withheld"));
            }
        }
        snapshot.check(owner,check)?;
        Ok(ToolOutput::success("Scoped source evidence; independent space ranks are not comparable",json!({
            "context_revision":snapshot.revision,"partial":partial,"token_budget":budget,"scopes":scopes,"evidence":evidence,
            "query_scope":query_scope.metadata(),"global_snapshot":false
        })))
    }

    #[cfg(feature = "memory")]
    async fn memory_connected(
        &self,
        space: &str,
        current_session_id: &str,
        call: &ai::ToolCall,
        check: &(impl Fn() -> Result<()> + Send + Sync),
    ) -> Result<ToolOutput> {
        if !matches!(
            call.name.as_str(),
            "memory_search" | "memory_recall" | "memory_session_list"
        ) {
            return Ok(ToolOutput::error(
                ToolStatus::Denied,
                "memory writes require a Host-provided trusted source identity and receipt ledger",
            ));
        }
        let query_scope=match query::QueryScope::parse(&call.arguments) {Ok(scope)=>scope,Err(error)=>return Ok(error.output())};
        let mut slot = self.client.lock().await;
        let mut client = match slot.take() {
            Some(client) => client,
            None => Self::connect().await?,
        };
        check()?;
        if let Some(error)=query_scope.validate_native(&mut client,if call.name=="memory_search" {"search"} else {"recall"}).await? {return Ok(error);}
        let result: Result<Value> = match call.name.as_str() {
            "memory_search" => {let mut args=json!({"query":call.arguments["query"].as_str().ok_or_else(||anyhow!("query required"))?,"space":space,"mode":"auto","limit":12});query_scope.apply(&mut args);client.call_tool_data("search",args).await},
            "memory_recall" => {
                let query = call.arguments["query"]
                    .as_str()
                    .ok_or_else(|| anyhow!("query required"))?;
                let token_budget = call.arguments["token_budget"]
                    .as_u64()
                    .unwrap_or(1024)
                    .clamp(128, 2048) as usize;
                let mut args=json!({
                            "query":query,
                            "space":space,
                            "token_budget":token_budget,
                            "session_id":current_session_id
                        });query_scope.apply(&mut args);client.call_tool_json("recall",args).await
            }
            "memory_session_list" => {
                let limit = call.arguments["limit"].as_u64().unwrap_or(10).clamp(1, 20);
                client
                    .call_tool_data(
                        "session_list",
                        json!({
                            "space":space,
                            "limit":limit,
                            "session_id":current_session_id
                        }),
                    )
                    .await
            }
            _ => unreachable!("read-only memory operation allowlist is exhaustive"),
        };
        match result {
            Ok(value) => {
                *slot = Some(client);
                if check().is_err() {
                    return Ok(ToolOutput::error(
                        ToolStatus::Denied,
                        "Work or memory authority changed; retrieved content withheld",
                    ));
                }
                Ok(ToolOutput::success(
                    "Brain result with caller-session provenance; retrieved content is untrusted",
                    value,
                ))
            }
            Err(_) => Ok(ToolOutput::error(
                ToolStatus::Failed,
                "OxiBrain operation failed; no alternate store was queried",
            )),
        }
    }
}

fn valid_source_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SOURCE_FIELD_BYTES
        && !value.chars().any(char::is_control)
}

fn valid_source_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_origin(origin: &TrustedSourceOrigin) -> Result<()> {
    ensure!(
        valid_source_part(&origin.owner)
            && valid_source_part(&origin.source_id)
            && valid_source_part(&origin.revision)
            && match &origin.kind {
                SourceOriginKind::Note => true,
                SourceOriginKind::Session { session_id } => valid_source_part(session_id),
            },
        "trusted source identity is malformed"
    );
    ensure!(
        valid_source_digest(&origin.content_sha256),
        "trusted source content digest is malformed"
    );
    Ok(())
}

#[cfg(feature = "memory")]
fn validate_origin_content(origin: &TrustedSourceOrigin, content: &str) -> Result<()> {
    validate_origin(origin)?;
    ensure!(
        content.len() <= MAX_SOURCE_CONTENT_BYTES,
        "source content exceeds the 4 MiB limit"
    );
    ensure!(
        crate::adapters::documents::digest(content.as_bytes()) == origin.content_sha256,
        "trusted source digest does not match the exact UTF-8 content bytes"
    );
    Ok(())
}

#[cfg(feature = "memory")]
fn source_locator(origin: &TrustedSourceOrigin) -> String {
    let identity = format!(
        "{}:{}{}:{}{}:{}{}",
        origin.owner.len(),
        origin.owner,
        origin.source_id.len(),
        origin.source_id,
        origin.revision.len(),
        origin.revision,
        origin.content_sha256
    );
    match &origin.kind {
        SourceOriginKind::Note => {
            format!("ghost-source/v1/{}", crate::adapters::documents::digest(identity.as_bytes()))
        }
        SourceOriginKind::Session { session_id } => {
            let identity = format!("{}:{}:{identity}", session_id.len(), session_id);
            format!(
                "ghost-session/v1/{}",
                crate::adapters::documents::digest(identity.as_bytes())
            )
        }
    }
}

#[cfg(feature = "memory")]
fn receipt(
    origin: &TrustedSourceOrigin,
    locator: &str,
    status: SourceStatus,
    episode_id: Option<String>,
    prior_episode_id: Option<String>,
    redaction_closure_sha256: Option<String>,
) -> SourceReceipt {
    SourceReceipt {
        status,
        owner: origin.owner.clone(),
        source_id: origin.source_id.clone(),
        revision: origin.revision.clone(),
        disclosure: origin.disclosure,
        content_sha256: origin.content_sha256.clone(),
        source_locator: locator.to_owned(),
        episode_id,
        prior_episode_id,
        redaction_closure_sha256,
    }
}

#[cfg(feature = "memory")]
fn valid_episode_id(value: &str) -> bool {
    valid_source_digest(value)
}

#[cfg(feature = "memory")]
fn valid_redaction_plan_token(value: &str) -> bool {
    value.len() == 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}


#[cfg(feature = "memory")]
#[derive(Debug, Clone)]
struct SourceRecord {
    space: String,
    source_kind: String,
    session_id: Option<String>,
    disclosure: String,
    content_sha256: String,
    source_locator: String,
    ingest_state: String,
    episode_id: Option<String>,
    prior_revision: Option<String>,
    prior_episode_id: Option<String>,
    redaction_state: String,
    redaction_closure_sha256: Option<String>,
    attempt_nonce: Option<String>,
}

/// One latest-per-source-identity ledger head: Host-owned identity and
/// receipt metadata only. The source ledger never stores source text.
#[derive(Debug, Clone)]
pub struct ListedSource {
    pub origin: TrustedSourceOrigin,
    pub receipt: SourceReceipt,
    pub prior_revision: Option<String>,
    /// Standing redaction state of this revision; a completed Owner
    /// correction keeps this "complete" while the source stays inspectable.
    pub redaction_state: String,
}

/// Standing receipt status derived from ledger state alone: no OxiBrain
/// contact and no state transition. Mirrors what `inspect_source` reports
/// for the same row wherever that is determinable without the engine. A
/// ledger row recorded with `redaction_state=complete` is the standing
/// corrected source and reports `Recorded`; `CorrectionComplete` stays the
/// outcome receipt of a correct/resume operation, not a listed state.
#[cfg(feature = "memory")]
fn listed_receipt_status(record: &SourceRecord) -> Result<SourceStatus> {
    Ok(match record.ingest_state.as_str() {
        "prepared" => SourceStatus::Prepared,
        "sent" | "effect_unknown" => SourceStatus::EffectUnknown,
        "redacted" => SourceStatus::Redacted,
        "recorded" => {
            if record.episode_id.is_none() {
                SourceStatus::EffectUnknown
            } else {
                match record.redaction_state.as_str() {
                    "none" | "prepared" | "plan_ready" | "complete" => SourceStatus::Recorded,
                    "sent" | "effect_unknown" => SourceStatus::EffectUnknown,
                    "blocked" => SourceStatus::CorrectionBlocked,
                    _ => bail!("source ledger contains an unsupported redaction state"),
                }
            }
        }
        _ => bail!("source ledger contains an unsupported ingest state"),
    })
}

#[cfg(feature = "memory")]
enum PreparedIngest {
    Local(SourceReceipt),
    Work(SourceRecord),
}

#[cfg(feature = "memory")]
fn disclosure_name(disclosure: SourceDisclosure) -> &'static str {
    match disclosure {
        SourceDisclosure::Public => "public",
        SourceDisclosure::Private => "private",
        SourceDisclosure::LocalOnly => "local_only",
    }
}

#[cfg(feature = "memory")]
fn source_kind_name(kind: &SourceOriginKind) -> &'static str {
    match kind {
        SourceOriginKind::Note => "note",
        SourceOriginKind::Session { .. } => "session",
    }
}

#[cfg(feature = "memory")]
fn session_id_for_origin(kind: &SourceOriginKind) -> Option<&str> {
    match kind {
        SourceOriginKind::Note => None,
        SourceOriginKind::Session { session_id } => Some(session_id),
    }
}

#[cfg(feature = "memory")]
fn configured_brain_dir() -> Result<PathBuf> {
    std::env::var_os("GHOST_BRAIN_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("explicit brain directory is not configured"))
}

#[cfg(feature = "memory")]
fn check_owner_authority(
    owner: &str,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<()> {
    check()?;
    let mapped = Brain::space_for_owner(owner)?
        .ok_or_else(|| anyhow!("owner has no mapped OxiBrain space"))?;
    ensure!(mapped == space, "owner memory-space mapping changed");
    Ok(())
}

#[cfg(feature = "memory")]
fn check_source_authority(
    origin: &TrustedSourceOrigin,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<()> {
    check_owner_authority(&origin.owner, space, check)
}

#[cfg(feature = "memory")]
fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(feature = "memory")]
fn canonical_nofollow_directory(path: &std::path::Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "source ledger parent must be absolute");
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir => current.push("/"),
            std::path::Component::Normal(part) => current.push(part),
            _ => bail!("source ledger parent has an unsafe path component"),
        }
        let metadata = std::fs::symlink_metadata(&current)
            .with_context(|| format!("checking source ledger path component {}", current.display()))?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "source ledger path contains a symlink or non-directory"
        );
    }
    Ok(std::fs::canonicalize(path)?)
}

#[cfg(feature = "memory")]
fn create_private_ledger_file(path: &std::path::Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(feature = "memory")]
fn open_source_ledger(
    config: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
) -> Result<Connection> {
    ensure!(
        config.path.is_absolute()
            && !config.path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            }),
        "source ledger path must be absolute and contain no traversal"
    );
    let parent = config
        .path
        .parent()
        .ok_or_else(|| anyhow!("source ledger parent is missing"))?;
    let canonical_parent = canonical_nofollow_directory(
        &std::fs::canonicalize(parent).context("source ledger parent is unavailable")?,
    )?;
    let file_name = config
        .path
        .file_name()
        .ok_or_else(|| anyhow!("source ledger filename is missing"))?;
    let path = canonical_parent.join(file_name);
    let canonical_brain = std::fs::canonicalize(brain_dir)
        .context("explicit OxiBrain store directory is unavailable")?;
    ensure!(
        !path.starts_with(&canonical_brain),
        "source ledger must be outside the OxiBrain store"
    );
    let parent_metadata = std::fs::metadata(&canonical_parent)?;
    #[cfg(unix)]
    ensure!(
        parent_metadata.mode() & 0o022 == 0,
        "source ledger parent must not be group- or world-writable"
    );
    match create_private_ledger_file(&path) {
        Ok(()) => {}
        Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == ErrorKind::AlreadyExists) => {}
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "source ledger must be a regular non-symlink file"
    );
    #[cfg(unix)]
    ensure!(
        metadata.nlink() == 1 && metadata.mode() & 0o077 == 0,
        "source ledger must be private and not hard-linked"
    );
    ensure!(
        metadata.len() <= MAX_SOURCE_LEDGER_BYTES,
        "source ledger exceeds its 16 MiB bound"
    );

    let mut connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(1))?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    let user_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let table_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if user_version == 0 && application_id == 0 && table_count == 0 {
        connection.pragma_update(None, "page_size", 4096)?;
        connection.execute_batch(
            "CREATE TABLE source_records (
                owner TEXT NOT NULL,
                space TEXT NOT NULL,
                source_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                source_kind TEXT NOT NULL CHECK(source_kind IN ('note','session')),
                session_id TEXT,
                disclosure TEXT NOT NULL CHECK(disclosure IN ('public','private','local_only')),
                content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
                source_locator TEXT NOT NULL,
                ingest_state TEXT NOT NULL CHECK(ingest_state IN ('prepared','sent','effect_unknown','recorded','redacted')),
                episode_id TEXT,
                prior_revision TEXT,
                prior_episode_id TEXT,
                redaction_state TEXT NOT NULL CHECK(redaction_state IN ('none','prepared','plan_ready','sent','effect_unknown','complete','blocked')),
                redaction_closure_sha256 TEXT,
                attempt_nonce TEXT CHECK(attempt_nonce IS NULL OR (length(attempt_nonce)=32 AND attempt_nonce NOT GLOB '*[^a-f0-9]*')),
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(owner,source_id,revision),
                UNIQUE(space,source_locator),
                CHECK((source_kind='note' AND session_id IS NULL)
                    OR (source_kind='session' AND session_id IS NOT NULL))
            );
            CREATE UNIQUE INDEX source_session_ids
                ON source_records(space,session_id) WHERE source_kind='session';",
        )?;
        connection.pragma_update(None, "application_id", SOURCE_LEDGER_APPLICATION_ID)?;
        connection.pragma_update(None, "user_version", SOURCE_LEDGER_VERSION)?;
    } else if matches!(user_version,1|2)
        && application_id == SOURCE_LEDGER_APPLICATION_ID
        && table_count == 1
    {
        let migration = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if user_version==1 {migration.execute_batch(
            "ALTER TABLE source_records
                ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'note'
                CHECK(source_kind IN ('note','session'));
            ALTER TABLE source_records ADD COLUMN session_id TEXT;
            CREATE UNIQUE INDEX source_session_ids
                ON source_records(space,session_id) WHERE source_kind='session';",
        )?;}
        // No backfill: an old sent/unknown row has no dispatch identity and
        // cannot acquire retry authority from this additive migration.
        migration.execute_batch("ALTER TABLE source_records ADD COLUMN attempt_nonce TEXT CHECK(attempt_nonce IS NULL OR (length(attempt_nonce)=32 AND attempt_nonce NOT GLOB '*[^a-f0-9]*'));")?;
        migration.pragma_update(None, "user_version", SOURCE_LEDGER_VERSION)?;
        migration.commit()?;
    } else {
        ensure!(
            user_version == SOURCE_LEDGER_VERSION
                && application_id == SOURCE_LEDGER_APPLICATION_ID
                && table_count == 1,
            "source ledger has an unsupported or foreign schema"
        );
    }
    let page_size: i64 =
        connection.pragma_query_value(None, "page_size", |row| row.get(0))?;
    ensure!(
        page_size == 4096,
        "source ledger must use 4096-byte SQLite pages"
    );
    connection.pragma_update(
        None,
        "max_page_count",
        (MAX_SOURCE_LEDGER_BYTES / page_size as u64) as i64,
    )?;
    let integrity: String =
        connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    ensure!(integrity == "ok", "source ledger integrity check failed");
    ensure!(
        std::fs::metadata(&path)?.len() <= MAX_SOURCE_LEDGER_BYTES,
        "source ledger exceeds its 16 MiB bound"
    );
    Ok(connection)
}

#[cfg(feature = "memory")]
fn read_source_record(
    connection: &Connection,
    origin: &TrustedSourceOrigin,
) -> Result<Option<SourceRecord>> {
    Ok(connection
        .query_row(
            "SELECT space,source_kind,session_id,disclosure,content_sha256,source_locator,
                    ingest_state,episode_id,prior_revision,prior_episode_id,redaction_state,
                    redaction_closure_sha256,attempt_nonce
             FROM source_records WHERE owner=?1 AND source_id=?2 AND revision=?3",
            params![origin.owner, origin.source_id, origin.revision],
            |row| {
                Ok(SourceRecord {
                    space: row.get(0)?,
                    source_kind: row.get(1)?,
                    session_id: row.get(2)?,
                    disclosure: row.get(3)?,
                    content_sha256: row.get(4)?,
                    source_locator: row.get(5)?,
                    ingest_state: row.get(6)?,
                    episode_id: row.get(7)?,
                    prior_revision: row.get(8)?,
                    prior_episode_id: row.get(9)?,
                    redaction_state: row.get(10)?,
                    redaction_closure_sha256: row.get(11)?,
                    attempt_nonce: row.get(12)?,
                })
            },
        )
        .optional()?)
}

#[cfg(feature = "memory")]
fn check_record_identity(
    origin: &TrustedSourceOrigin,
    space: &str,
    record: &SourceRecord,
) -> Result<()> {
    ensure!(
        record.space == space
            && record.source_kind == source_kind_name(&origin.kind)
            && record.session_id.as_deref() == session_id_for_origin(&origin.kind)
            && record.disclosure == disclosure_name(origin.disclosure)
            && record.content_sha256 == origin.content_sha256
            && record.source_locator == source_locator(origin),
        "source revision conflicts with its stored owner, scope, kind, disclosure, or bytes"
    );
    Ok(())
}

#[cfg(feature = "memory")]
fn load_source_record(
    origin: &TrustedSourceOrigin,
    space: &str,
    config: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
) -> Result<Option<SourceRecord>> {
    validate_origin(origin)?;
    ensure!(
        config.path.is_absolute(),
        "source ledger path must be explicitly absolute"
    );
    let connection = open_source_ledger(config, brain_dir)?;
    let record = read_source_record(&connection, origin)?;
    if let Some(record) = &record {
        check_record_identity(origin, space, record)?;
    }
    Ok(record)
}

#[cfg(feature = "memory")]
fn prepare_ingest(
    origin: &TrustedSourceOrigin,
    content: &str,
    space: &str,
    config: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
    correction: Option<(&str, &str)>,
) -> Result<PreparedIngest> {
    validate_origin_content(origin, content)?;
    ensure!(
        !space.is_empty()
            && space.len() <= 80
            && space
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)),
        "mapped OxiBrain space is invalid"
    );
    let mut connection = open_source_ledger(config, brain_dir)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let record = read_source_record(&tx, origin)?;
    let record = if let Some(record) = record {
        check_record_identity(origin, space, &record)?;
        if let Some((prior_revision, prior_episode_id)) = correction {
            ensure!(
                record.prior_revision.as_deref() == Some(prior_revision)
                    && record.prior_episode_id.as_deref() == Some(prior_episode_id),
                "replacement revision is already bound to a different correction"
            );
        }
        record
    } else {
        let rows: i64 =
            tx.query_row("SELECT COUNT(*) FROM source_records", [], |row| row.get(0))?;
        ensure!(rows < MAX_SOURCE_LEDGER_ROWS, "source ledger reached its row limit");
        let locator = source_locator(origin);
        let (prior_revision, prior_episode_id) = correction
            .map(|(revision, episode)| (Some(revision), Some(episode)))
            .unwrap_or((None, None));
        tx.execute(
            "INSERT INTO source_records
             (owner,space,source_id,revision,source_kind,session_id,disclosure,content_sha256,
              source_locator,ingest_state,episode_id,prior_revision,prior_episode_id,
              redaction_state,redaction_closure_sha256,updated_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'prepared',NULL,?10,?11,'none',NULL,?12)",
            params![
                origin.owner,
                space,
                origin.source_id,
                origin.revision,
                source_kind_name(&origin.kind),
                session_id_for_origin(&origin.kind),
                disclosure_name(origin.disclosure),
                origin.content_sha256,
                locator,
                prior_revision,
                prior_episode_id,
                current_time_ms(),
            ],
        )?;
        SourceRecord {
            space: space.to_owned(),
            source_kind: source_kind_name(&origin.kind).to_owned(),
            session_id: session_id_for_origin(&origin.kind).map(str::to_owned),
            disclosure: disclosure_name(origin.disclosure).to_owned(),
            content_sha256: origin.content_sha256.clone(),
            source_locator: locator,
            ingest_state: "prepared".to_owned(),
            episode_id: None,
            prior_revision: prior_revision.map(str::to_owned),
            prior_episode_id: prior_episode_id.map(str::to_owned),
            redaction_state: "none".to_owned(),
            redaction_closure_sha256: None,
            attempt_nonce: None,
        }
    };
    tx.commit()?;
    match record.ingest_state.as_str() {
        "recorded" => Ok(PreparedIngest::Local(record_receipt(
            origin,
            &record,
            SourceStatus::AlreadyRecorded,
        ))),
        "redacted" => Ok(PreparedIngest::Local(record_receipt(
            origin,
            &record,
            SourceStatus::Redacted,
        ))),
        "prepared" => Ok(PreparedIngest::Work(record)),
        "sent" | "effect_unknown" => Ok(PreparedIngest::Work(record)),
        _ => bail!("source ledger contains an unsupported ingest state"),
    }
}

#[cfg(feature = "memory")]
fn record_receipt(
    origin: &TrustedSourceOrigin,
    record: &SourceRecord,
    status: SourceStatus,
) -> SourceReceipt {
    receipt(
        origin,
        &record.source_locator,
        status,
        record.episode_id.clone(),
        record.prior_episode_id.clone(),
        record.redaction_closure_sha256.clone(),
    )
}

#[cfg(feature = "memory")]
fn transition_ingest(
    origin: &TrustedSourceOrigin,
    space: &str,
    config: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
    from: &str,
    to: &str,
    episode_id: Option<&str>,
) -> Result<bool> {
    let mut connection = open_source_ledger(config, brain_dir)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = tx.execute(
        "UPDATE source_records
         SET ingest_state=?1, episode_id=COALESCE(?2,episode_id), updated_at_ms=?3
         WHERE owner=?4 AND space=?5 AND source_id=?6 AND revision=?7
           AND content_sha256=?8 AND ingest_state=?9
           AND source_kind=?10 AND session_id IS ?11",
        params![
            to,
            episode_id,
            current_time_ms(),
            origin.owner,
            space,
            origin.source_id,
            origin.revision,
            origin.content_sha256,
            from,
            source_kind_name(&origin.kind),
            session_id_for_origin(&origin.kind),
        ],
    )?;
    tx.commit()?;
    ensure!(
        std::fs::metadata(&config.path)?.len() <= MAX_SOURCE_LEDGER_BYTES,
        "source ledger exceeds its 16 MiB bound"
    );
    Ok(changed == 1)
}

#[cfg(feature = "memory")]
fn transition_redaction(
    origin: &TrustedSourceOrigin,
    space: &str,
    config: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
    from: &str,
    to: &str,
    closure_sha256: Option<&str>,
) -> Result<bool> {
    let mut connection = open_source_ledger(config, brain_dir)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = tx.execute(
        "UPDATE source_records
         SET redaction_state=?1,
             redaction_closure_sha256=COALESCE(?2,redaction_closure_sha256),
             updated_at_ms=?3
         WHERE owner=?4 AND space=?5 AND source_id=?6 AND revision=?7
           AND content_sha256=?8 AND redaction_state=?9
           AND source_kind=?10 AND session_id IS ?11",
        params![
            to,
            closure_sha256,
            current_time_ms(),
            origin.owner,
            space,
            origin.source_id,
            origin.revision,
            origin.content_sha256,
            from,
            source_kind_name(&origin.kind),
            session_id_for_origin(&origin.kind),
        ],
    )?;
    tx.commit()?;
    Ok(changed == 1)
}

#[cfg(feature = "memory")]
fn complete_correction(
    prior: &TrustedSourceOrigin,
    replacement: &TrustedSourceOrigin,
    space: &str,
    prior_episode_id: &str,
    ledger: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
    redaction_state: &str,
    closure_sha256: &str,
) -> Result<bool> {
    ensure!(valid_source_digest(closure_sha256), "closure digest is malformed");
    let mut connection = open_source_ledger(ledger, brain_dir)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let prior_changed = tx.execute(
        "UPDATE source_records
         SET ingest_state='redacted', updated_at_ms=?1
         WHERE owner=?2 AND space=?3 AND source_id=?4 AND revision=?5
           AND content_sha256=?6 AND episode_id=?7
           AND ingest_state IN ('recorded','redacted')
           AND source_kind=?8 AND session_id IS ?9",
        params![
            current_time_ms(),
            prior.owner,
            space,
            prior.source_id,
            prior.revision,
            prior.content_sha256,
            prior_episode_id,
            source_kind_name(&prior.kind),
            session_id_for_origin(&prior.kind),
        ],
    )?;
    let replacement_changed = tx.execute(
        "UPDATE source_records
         SET redaction_state='complete', redaction_closure_sha256=?1,
             updated_at_ms=?2
         WHERE owner=?3 AND space=?4 AND source_id=?5 AND revision=?6
           AND content_sha256=?7 AND prior_revision=?8 AND prior_episode_id=?9
           AND redaction_state=?10 AND source_kind=?11 AND session_id IS ?12",
        params![
            closure_sha256,
            current_time_ms(),
            replacement.owner,
            space,
            replacement.source_id,
            replacement.revision,
            replacement.content_sha256,
            prior.revision,
            prior_episode_id,
            redaction_state,
            source_kind_name(&replacement.kind),
            session_id_for_origin(&replacement.kind),
        ],
    )?;
    if prior_changed != 1 || replacement_changed != 1 {
        return Ok(false);
    }
    tx.commit()?;
    Ok(true)
}

#[cfg(feature = "memory")]
fn ensure_brain_configured() -> Result<()> {
    ensure!(
        Brain::configured(),
        "OxiBrain is not configured with an explicit executable, store, scoped token, and space map"
    );
    Ok(())
}

#[cfg(feature = "memory")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EpisodeInspection {
    Exact,
    Redacted,
    NotOwned,
}

#[cfg(feature = "memory")]
async fn verify_engine_owner_space(
    client: &mut BrainClient,
    owner: &str,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<String> {
    check_owner_authority(owner, space, check)?;
    let spaces = client
        .list_spaces()
        .await
        .map_err(|_| anyhow!("OxiBrain mapped-space verification is unavailable"))?;
    check_owner_authority(owner, space, check)?;
    spaces
        .iter()
        .find(|candidate| candidate.id == space || candidate.name == space)
        .map(|candidate| candidate.id.clone())
        .ok_or_else(|| anyhow!("the mapped OxiBrain space is unavailable to this scoped session"))
}

#[cfg(feature = "memory")]
async fn verify_engine_space(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<String> {
    verify_engine_owner_space(client, &origin.owner, space, check).await
}

#[cfg(feature = "memory")]
async fn live_source_tools(
    client: &mut BrainClient,
    owner: &str,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<Value> {
    check_owner_authority(owner, space, check)?;
    let tools = client.call_rpc_json("tools/list", json!({})).await?;
    check_owner_authority(owner, space, check)?;
    ensure!(
        tools.get("tools").and_then(Value::as_array).is_some(),
        "OxiBrain tools/list response is malformed"
    );
    Ok(tools)
}

#[cfg(feature = "memory")]
fn listed_input_schema<'a>(tools: &'a Value, name: &str) -> Option<&'a Value> {
    tools
        .get("tools")?
        .as_array()?
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))?
        .get("inputSchema")
}

#[cfg(feature = "memory")]
async fn probe_source_capabilities(
    client: &mut BrainClient,
    owner: &str,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<SourceCapabilities> {
    let tools = live_source_tools(client, owner, space, check).await?;
    let has_recall = tools
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool.get("name").and_then(Value::as_str) == Some("recall"))
        });
    let notes = has_recall
        && listed_input_schema(&tools, "ingest").is_some_and(|schema| {
            schema
                .pointer("/properties/trust/enum")
                .and_then(Value::as_array)
                .is_some_and(|tiers| tiers.iter().any(|tier| tier.as_str() == Some("untrusted")))
                && schema
                    .pointer("/properties/extract/type")
                    .and_then(Value::as_str)
                    == Some("boolean")
        });
    let sessions = tools
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool.get("name").and_then(Value::as_str) == Some("session_list"))
        })
        && listed_input_schema(&tools, "session_record")
            .and_then(|schema| schema.get("x-oxibrain-session-trust"))
            .and_then(Value::as_str)
            == Some("untrusted");
    Ok(SourceCapabilities { notes, sessions })
}

#[cfg(feature = "memory")]
async fn require_session_record_schema(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<()> {
    let capabilities =
        probe_source_capabilities(client, &origin.owner, space, check).await?;
    ensure!(
        capabilities.sessions,
        "OxiBrain session recording requires the live untrusted session schema marker and read access"
    );
    Ok(())
}

#[cfg(feature = "memory")]
async fn inspect_episode(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    content: &str,
    space: &str,
    episode_id: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<EpisodeInspection> {
    ensure!(valid_episode_id(episode_id), "stored episode id is malformed");
    let engine_space_id = verify_engine_space(client, origin, space, check).await?;
    check_source_authority(origin, space, check)?;
    let uri = format!("episode://{episode_id}?space={space}");
    let resource = client
        .call_rpc_json("resources/read", json!({"uri":uri}))
        .await
        .map_err(|_| anyhow!("OxiBrain episode evidence is unavailable"))?;
    check_source_authority(origin, space, check)?;
    let text = resource
        .get("contents")
        .and_then(Value::as_array)
        .and_then(|contents| contents.first())
        .and_then(|content| content.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("OxiBrain episode evidence is malformed"))?;
    let episode: Value = serde_json::from_str(text)
        .map_err(|_| anyhow!("OxiBrain episode evidence is malformed"))?;
    let source = &episode["source"];
    let expected_locator = source_locator(origin);
    let source_matches = match &origin.kind {
        SourceOriginKind::Note => {
            source["kind"].as_str() == Some("note")
                && source["ref"]["path"].as_str() == Some(expected_locator.as_str())
        }
        SourceOriginKind::Session { session_id } => {
            source["kind"].as_str() == Some("session")
                && source["ref"]["session_id"].as_str() == Some(session_id.as_str())
        }
    };
    if episode["id"].as_str() != Some(episode_id)
        || episode["space"].as_str() != Some(engine_space_id.as_str())
        || episode["kind"].as_str() != Some("primary")
        || episode["trust"].as_str() != Some("untrusted")
        || !source_matches
    {
        return Ok(EpisodeInspection::NotOwned);
    }
    if episode["redacted_at"].is_null() {
        if episode["content"].as_str() == Some(content)
            && crate::adapters::documents::digest(content.as_bytes()) == origin.content_sha256
        {
            Ok(EpisodeInspection::Exact)
        } else {
            Ok(EpisodeInspection::NotOwned)
        }
    } else if episode["content"].as_str() == Some("[redacted]") {
        Ok(EpisodeInspection::Redacted)
    } else {
        Ok(EpisodeInspection::NotOwned)
    }
}

#[cfg(feature = "memory")]
async fn recall_source_episode_ids(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    content: &str,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<Vec<String>> {
    let query = content.chars().take(512).collect::<String>();
    ensure!(!query.is_empty(), "source content is empty");
    check_source_authority(origin, space, check)?;
    let envelope = client
        .call_tool_json(
            "recall",
            json!({
                "query":query,
                "space":space,
                "token_budget":MAX_SOURCE_QUERY_BUDGET,
            }),
        )
        .await
        .map_err(|_| anyhow!("OxiBrain source provenance recall is unavailable"))?;
    check_source_authority(origin, space, check)?;
    source_recovery::candidate_ids(&envelope)
}

#[cfg(feature = "memory")]
async fn session_source_episode_ids(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    space: &str,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<Vec<String>> {
    let SourceOriginKind::Session { session_id } = &origin.kind else {
        bail!("session episode lookup requires Session provenance");
    };
    check_source_authority(origin, space, check)?;
    let envelope = client
        .call_tool_json("session_list", json!({"space":space,"limit":50}))
        .await
        .map_err(|_| anyhow!("OxiBrain session provenance list is unavailable"))?;
    check_source_authority(origin, space, check)?;
    let sessions = envelope["data"]
        .as_array()
        .ok_or_else(|| anyhow!("OxiBrain session provenance response is malformed"))?;
    let mut ids = Vec::new();
    for session in sessions {
        if session["session_id"].as_str() == Some(session_id.as_str()) {
            let episode_id = session["episode_id"]
                .as_str()
                .filter(|id| valid_episode_id(id))
                .ok_or_else(|| anyhow!("OxiBrain session provenance episode id is malformed"))?;
            ids.push(episode_id.to_owned());
        }
    }
    ensure!(
        ids.len() <= 1,
        "OxiBrain returned duplicate episodes for one session identity"
    );
    Ok(ids)
}

#[cfg(feature = "memory")]
async fn find_source_effect(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    content: &str,
    space: &str,
    known_episode_id: Option<&str>,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<(Option<String>, EpisodeInspection)> {
    if let Some(episode_id) = known_episode_id.filter(|id| valid_episode_id(id)) {
        match inspect_episode(client, origin, content, space, episode_id, check).await? {
            EpisodeInspection::Exact => {
                return Ok((Some(episode_id.to_owned()), EpisodeInspection::Exact));
            }
            EpisodeInspection::Redacted => {
                return Ok((Some(episode_id.to_owned()), EpisodeInspection::Redacted));
            }
            EpisodeInspection::NotOwned => {}
        }
    }
    let candidate_ids = match &origin.kind {
        SourceOriginKind::Note => {
            recall_source_episode_ids(client, origin, content, space, check).await?
        }
        SourceOriginKind::Session { .. } => {
            session_source_episode_ids(client, origin, space, check).await?
        }
    };
    let mut exact = Vec::new();
    let mut redacted = Vec::new();
    for episode_id in candidate_ids {
        match inspect_episode(client, origin, content, space, &episode_id, check).await? {
            EpisodeInspection::Exact => exact.push(episode_id),
            EpisodeInspection::Redacted => redacted.push(episode_id),
            EpisodeInspection::NotOwned => {}
        }
    }
    if exact.len() == 1 {
        return Ok((exact.pop(), EpisodeInspection::Exact));
    }
    if redacted.len() == 1 && exact.is_empty() {
        return Ok((redacted.pop(), EpisodeInspection::Redacted));
    }
    Ok((None, EpisodeInspection::NotOwned))
}

#[cfg(feature = "memory")]
async fn reconcile_ingest(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    content: &str,
    space: &str,
    ledger: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
    record: &SourceRecord,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<SourceReceipt> {
    if verify_engine_space(client, origin, space, check)
        .await
        .is_err()
    {
        return Ok(record_receipt(
            origin,
            record,
            SourceStatus::EffectUnknown,
        ));
    }
    let found = find_source_effect(
        client,
        origin,
        content,
        space,
        record.episode_id.as_deref(),
        check,
    )
    .await;
    let (episode_id, evidence) = match found {
        Ok(found) => found,
        Err(_) => {
            return Ok(record_receipt(
                origin,
                record,
                SourceStatus::EffectUnknown,
            ));
        }
    };
    let Some(episode_id) = episode_id else {
        return Ok(record_receipt(
            origin,
            record,
            SourceStatus::EffectUnknown,
        ));
    };
    let (state, status) = match evidence {
        EpisodeInspection::Exact => ("recorded", SourceStatus::Recorded),
        EpisodeInspection::Redacted => ("redacted", SourceStatus::Redacted),
        EpisodeInspection::NotOwned => {
            return Ok(record_receipt(
                origin,
                record,
                SourceStatus::EffectUnknown,
            ));
        }
    };
    if !transition_ingest(
        origin,
        space,
        ledger,
        brain_dir,
        &record.ingest_state,
        state,
        Some(&episode_id),
    )? {
        return Ok(record_receipt(
            origin,
            record,
            SourceStatus::EffectUnknown,
        ));
    }
    Ok(receipt(
        origin,
        &record.source_locator,
        status,
        Some(episode_id),
        record.prior_episode_id.clone(),
        record.redaction_closure_sha256.clone(),
    ))
}

#[cfg(feature = "memory")]
async fn execute_ingest(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    content: &str,
    space: &str,
    ledger: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
    record: SourceRecord,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<SourceReceipt> {
    validate_origin_content(origin, content)?;
    check_record_identity(origin, space, &record)?;
    if record.ingest_state != "prepared" {
        return reconcile_ingest(
            client, origin, content, space, ledger, brain_dir, &record, check,
        )
        .await;
    }
    let engine_space_id=verify_engine_space(client, origin, space, check).await?;
    check_source_authority(origin, space, check)?;
    let Some(attempt_nonce)=episode_write::begin_attempt(origin,space,ledger,brain_dir,&record)? else {
        let latest = load_source_record(origin, space, ledger, brain_dir)?
            .ok_or_else(|| anyhow!("source receipt disappeared before ingest"))?;
        return reconcile_ingest(
            client, origin, content, space, ledger, brain_dir, &latest, check,
        )
        .await;
    };
    if check_source_authority(origin, space, check).is_err() {
        let _ = episode_write::finish_attempt(
            origin,
            space,
            ledger,
            brain_dir,
            &attempt_nonce,
            "prepared",
            None,
        );
        bail!("source authority changed before OxiBrain ingest");
    }
    let (tool, arguments) = match &origin.kind {
        SourceOriginKind::Note => (
            "ingest",
            json!({
                "content":content,
                "space":space,
                "source_path":record.source_locator,
                "extract":false,
                // Host-originated source content is evidence, never a trusted assertion.
                "trust":"untrusted",
            }),
        ),
        SourceOriginKind::Session { session_id } => (
            "session_record",
            json!({
                "space":space,
                "session_id":session_id,
                "summary":content,
            }),
        ),
    };
    let response = client.call_episode_tool(tool, arguments, &engine_space_id, &attempt_nonce).await;
    let response=match response {
        Ok(oxibrain_client::EpisodeToolResult::Text(text))=>Some(text),
        Ok(oxibrain_client::EpisodeToolResult::NotCommittedBusy {..})=>{
            // This is evidence only for the exact dispatched attempt. The
            // current original-source gate and nonce CAS precede retryability.
            if check_source_authority(origin,space,check).is_ok()
                &&episode_write::finish_attempt(origin,space,ledger,brain_dir,&attempt_nonce,"prepared",None)? {
                return Ok(record_receipt(origin,&record,SourceStatus::Prepared));
            }
            let latest=load_source_record(origin,space,ledger,brain_dir)?
                .ok_or_else(||anyhow!("source receipt disappeared after episode outcome"))?;
            return reconcile_ingest(client,origin,content,space,ledger,brain_dir,&latest,check).await;
        },
        Err(_)=>None,
    };
    let response_prefix = match &origin.kind {
        SourceOriginKind::Note => "Ingested as episode: ".to_owned(),
        SourceOriginKind::Session { session_id } => {
            format!("Recorded session {session_id} as episode: ")
        }
    };
    let episode_id = match response
        .and_then(|text| text.strip_prefix(&response_prefix).map(str::to_owned))
        .filter(|id| valid_episode_id(id))
    {
        Some(episode_id) => episode_id,
        None => {
            let _ = episode_write::finish_attempt(
                origin,
                space,
                ledger,
                brain_dir,
                &attempt_nonce,
                "effect_unknown",
                None,
            );
            return Ok(record_receipt(
                origin,
                &record,
                SourceStatus::EffectUnknown,
            ));
        }
    };
    let verified = inspect_episode(client, origin, content, space, &episode_id, check).await;
    match verified {
        Ok(EpisodeInspection::Exact) => {
            if episode_write::finish_attempt(
                origin,
                space,
                ledger,
                brain_dir,
                &attempt_nonce,
                "recorded",
                Some(&episode_id),
            )? {
                Ok(receipt(
                    origin,
                    &record.source_locator,
                    SourceStatus::Recorded,
                    Some(episode_id),
                    record.prior_episode_id,
                    record.redaction_closure_sha256,
                ))
            } else {
                Ok(receipt(
                    origin,
                    &record.source_locator,
                    SourceStatus::EffectUnknown,
                    Some(episode_id),
                    record.prior_episode_id,
                    record.redaction_closure_sha256,
                ))
            }
        }
        Ok(EpisodeInspection::Redacted) => {
            let _ = episode_write::finish_attempt(
                origin,
                space,
                ledger,
                brain_dir,
                &attempt_nonce,
                "redacted",
                Some(&episode_id),
            );
            Ok(receipt(
                origin,
                &record.source_locator,
                SourceStatus::Redacted,
                Some(episode_id),
                record.prior_episode_id,
                record.redaction_closure_sha256,
            ))
        }
        Ok(EpisodeInspection::NotOwned) | Err(_) => {
            let _ = episode_write::finish_attempt(
                origin,
                space,
                ledger,
                brain_dir,
                &attempt_nonce,
                "effect_unknown",
                Some(&episode_id),
            );
            Ok(receipt(
                origin,
                &record.source_locator,
                SourceStatus::EffectUnknown,
                Some(episode_id),
                record.prior_episode_id,
                record.redaction_closure_sha256,
            ))
        }
    }
}

#[cfg(feature = "memory")]
async fn inspect_record(
    client: &mut BrainClient,
    origin: &TrustedSourceOrigin,
    content: &str,
    space: &str,
    brain_dir: &std::path::Path,
    ledger: &SourceLedgerConfig,
    record: &SourceRecord,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<SourceReceipt> {
    validate_origin_content(origin, content)?;
    check_record_identity(origin, space, record)?;
    verify_engine_space(client, origin, space, check).await?;
    match record.ingest_state.as_str() {
        "sent" | "effect_unknown" => {
            reconcile_ingest(
                client, origin, content, space, ledger, brain_dir, record, check,
            )
            .await
        }
        "recorded" => {
            let Some(episode_id) = record.episode_id.as_deref() else {
                return Ok(record_receipt(
                    origin,
                    record,
                    SourceStatus::EffectUnknown,
                ));
            };
            match inspect_episode(client, origin, content, space, episode_id, check).await {
                Ok(EpisodeInspection::Exact) => {
                    Ok(record_receipt(origin, record, SourceStatus::Recorded))
                }
                Ok(EpisodeInspection::Redacted) => {
                    if transition_ingest(
                        origin,
                        space,
                        ledger,
                        brain_dir,
                        "recorded",
                        "redacted",
                        Some(episode_id),
                    )? {
                        Ok(receipt(
                            origin,
                            &record.source_locator,
                            SourceStatus::Redacted,
                            Some(episode_id.to_owned()),
                            record.prior_episode_id.clone(),
                            record.redaction_closure_sha256.clone(),
                        ))
                    } else {
                        Ok(record_receipt(
                            origin,
                            record,
                            SourceStatus::EffectUnknown,
                        ))
                    }
                }
                Ok(EpisodeInspection::NotOwned) | Err(_) => Ok(record_receipt(
                    origin,
                    record,
                    SourceStatus::EffectUnknown,
                )),
            }
        }
        "redacted" => Ok(record_receipt(origin, record, SourceStatus::Redacted)),
        "prepared" => Ok(record_receipt(origin, record, SourceStatus::Prepared)),
        _ => bail!("source ledger contains an unsupported ingest state"),
    }
}

#[cfg(feature = "memory")]
fn correction_receipt(
    replacement: &TrustedSourceOrigin,
    record: &SourceRecord,
    status: SourceStatus,
    prior_episode_id: &str,
) -> SourceReceipt {
    receipt(
        replacement,
        &record.source_locator,
        status,
        record.episode_id.clone(),
        Some(prior_episode_id.to_owned()),
        record.redaction_closure_sha256.clone(),
    )
}

#[cfg(feature = "memory")]
fn exact_episode_closure(value: &Value, pointer: &str, episode_id: &str) -> bool {
    let Some(episodes)=value.pointer(pointer).and_then(Value::as_array) else{return false;};
    let Some(parent)=pointer.strip_suffix("/episodes") else{return false;};
    let proof=value.pointer(&format!("{parent}/publication_declarations"));
    let declarations=match proof {None=>&[][..],Some(Value::Array(values))=>values.as_slice(),_=>return false};
    if episodes.is_empty()||episodes.len()>4097||declarations.len()>4096 {return false;}
    let mut expected=std::collections::BTreeSet::from([episode_id]);
    for declaration in declarations {
        let Some(id)=declaration.as_str().filter(|id|valid_episode_id(id)) else{return false;};
        if !expected.insert(id) {return false;}
    }
    let mut actual=std::collections::BTreeSet::new();
    episodes.iter().all(|id|id.as_str().is_some_and(|id|actual.insert(id)))&&actual==expected
}

#[cfg(feature = "memory")]
async fn execute_correction(
    client: &mut BrainClient,
    prior: &TrustedSourceOrigin,
    expected_prior_episode_id: &str,
    prior_content: &str,
    replacement: &TrustedSourceOrigin,
    replacement_content: &str,
    space: &str,
    ledger: &SourceLedgerConfig,
    brain_dir: &std::path::Path,
    check: &(impl Fn() -> Result<()> + Send + Sync),
) -> Result<SourceReceipt> {
    validate_origin_content(prior, prior_content)?;
    validate_origin_content(replacement, replacement_content)?;
    ensure!(
        prior.owner == replacement.owner
            && prior.source_id == replacement.source_id
            && prior.revision != replacement.revision
            && match (&prior.kind, &replacement.kind) {
                (SourceOriginKind::Note, SourceOriginKind::Note) => true,
                (
                    SourceOriginKind::Session { session_id: prior_id },
                    SourceOriginKind::Session {
                        session_id: replacement_id,
                    },
                ) => prior_id != replacement_id,
                _ => false,
            },
        "correction must preserve provenance kind and use a distinct revision/session id"
    );
    ensure!(valid_episode_id(expected_prior_episode_id), "prior episode id is malformed");
    verify_engine_space(client, prior, space, check).await?;
    if matches!(&prior.kind, SourceOriginKind::Session { .. }) {
        require_session_record_schema(client, prior, space, check).await?;
    }

    let prior_record = load_source_record(prior, space, ledger, brain_dir)?
        .ok_or_else(|| anyhow!("expected prior source revision is not in the Ghost ledger"))?;
    check_record_identity(prior, space, &prior_record)?;
    ensure!(
        prior_record.episode_id.as_deref() == Some(expected_prior_episode_id),
        "expected prior episode is not the recorded episode for this source revision"
    );
    let existing_replacement =
        load_source_record(replacement, space, ledger, brain_dir)?;
    if let Some(record) = &existing_replacement {
        ensure!(
            record.prior_revision.as_deref() == Some(prior.revision.as_str())
                && record.prior_episode_id.as_deref() == Some(expected_prior_episode_id),
            "replacement revision is already bound to a different correction"
        );
    }
    match prior_record.ingest_state.as_str() {
        "recorded" | "redacted" => {}
        "prepared" => {
            return Ok(record_receipt(prior, &prior_record, SourceStatus::Prepared));
        }
        _ => {
            return Ok(record_receipt(
                prior,
                &prior_record,
                SourceStatus::EffectUnknown,
            ));
        }
    }

    let old_evidence = inspect_episode(
        client,
        prior,
        prior_content,
        space,
        expected_prior_episode_id,
        check,
    )
    .await;
    match old_evidence {
        Ok(EpisodeInspection::Redacted) => {
            if let Some(record) = existing_replacement.as_ref() {
                if matches!(
                    record.redaction_state.as_str(),
                    "sent" | "effect_unknown" | "complete"
                ) {
                    let Some(closure_sha256) = record
                        .redaction_closure_sha256
                        .as_deref()
                        .filter(|hash| valid_source_digest(hash))
                    else {
                        return Ok(correction_receipt(
                            replacement,
                            record,
                            SourceStatus::EffectUnknown,
                            expected_prior_episode_id,
                        ));
                    };
                    let replacement_id = record
                        .episode_id
                        .as_deref()
                        .ok_or_else(|| anyhow!("replacement receipt lacks its episode id"))?;
                    if !matches!(
                        inspect_episode(
                            client,
                            replacement,
                            replacement_content,
                            space,
                            replacement_id,
                            check,
                        )
                        .await,
                        Ok(EpisodeInspection::Exact)
                    ) {
                        return Ok(correction_receipt(
                            replacement,
                            record,
                            SourceStatus::EffectUnknown,
                            expected_prior_episode_id,
                        ));
                    }
                    if record.redaction_state == "complete" {
                        if prior_record.ingest_state == "redacted" {
                            return Ok(correction_receipt(
                                replacement,
                                record,
                                SourceStatus::CorrectionComplete,
                                expected_prior_episode_id,
                            ));
                        }
                        return Ok(correction_receipt(
                            replacement,
                            record,
                            SourceStatus::EffectUnknown,
                            expected_prior_episode_id,
                        ));
                    }
                    if complete_correction(
                        prior,
                        replacement,
                        space,
                        expected_prior_episode_id,
                        ledger,
                        brain_dir,
                        &record.redaction_state,
                        closure_sha256,
                    )? {
                        let mut completed = record.clone();
                        completed.redaction_state = "complete".to_owned();
                        return Ok(correction_receipt(
                            replacement,
                            &completed,
                            SourceStatus::CorrectionComplete,
                            expected_prior_episode_id,
                        ));
                    }
                    return Ok(correction_receipt(
                        replacement,
                        record,
                        SourceStatus::EffectUnknown,
                        expected_prior_episode_id,
                    ));
                }
            }
            return Ok(receipt(
                replacement,
                &source_locator(replacement),
                SourceStatus::CorrectionBlocked,
                None,
                Some(expected_prior_episode_id.to_owned()),
                None,
            ));
        }
        Ok(EpisodeInspection::Exact) => {}
        Ok(EpisodeInspection::NotOwned) | Err(_) => {
            return Ok(receipt(
                replacement,
                &source_locator(replacement),
                SourceStatus::EffectUnknown,
                None,
                Some(expected_prior_episode_id.to_owned()),
                None,
            ));
        }
    }

    let prepared = prepare_ingest(
        replacement,
        replacement_content,
        space,
        ledger,
        brain_dir,
        Some((&prior.revision, expected_prior_episode_id)),
    )?;
    let ingest_receipt = match prepared {
        PreparedIngest::Local(receipt) => receipt,
        PreparedIngest::Work(record) => {
            execute_ingest(
                client,
                replacement,
                replacement_content,
                space,
                ledger,
                brain_dir,
                record,
                check,
            )
            .await?
        }
    };
    if !matches!(
        ingest_receipt.status,
        SourceStatus::Recorded | SourceStatus::AlreadyRecorded
    ) {
        return Ok(SourceReceipt {
            status: ingest_receipt.status,
            owner: replacement.owner.clone(),
            source_id: replacement.source_id.clone(),
            revision: replacement.revision.clone(),
            disclosure: replacement.disclosure,
            content_sha256: replacement.content_sha256.clone(),
            source_locator: ingest_receipt.source_locator,
            episode_id: ingest_receipt.episode_id,
            prior_episode_id: Some(expected_prior_episode_id.to_owned()),
            redaction_closure_sha256: ingest_receipt.redaction_closure_sha256,
        });
    }
    let replacement_id = ingest_receipt
        .episode_id
        .as_deref()
        .ok_or_else(|| anyhow!("recorded replacement lacks an episode id"))?;
    if !matches!(
        inspect_episode(
            client,
            replacement,
            replacement_content,
            space,
            replacement_id,
            check,
        )
        .await,
        Ok(EpisodeInspection::Exact)
    ) {
        return Ok(SourceReceipt {
            status: SourceStatus::EffectUnknown,
            owner: replacement.owner.clone(),
            source_id: replacement.source_id.clone(),
            revision: replacement.revision.clone(),
            disclosure: replacement.disclosure,
            content_sha256: replacement.content_sha256.clone(),
            source_locator: ingest_receipt.source_locator,
            episode_id: Some(replacement_id.to_owned()),
            prior_episode_id: Some(expected_prior_episode_id.to_owned()),
            redaction_closure_sha256: None,
        });
    }
    let mut replacement_record = load_source_record(replacement, space, ledger, brain_dir)?
        .ok_or_else(|| anyhow!("replacement receipt disappeared before correction"))?;
    ensure!(
        replacement_record.episode_id.as_deref() == Some(replacement_id)
            && replacement_record.prior_episode_id.as_deref()
                == Some(expected_prior_episode_id),
        "replacement receipt lost its expected prior episode binding"
    );

    match inspect_episode(
        client,
        prior,
        prior_content,
        space,
        expected_prior_episode_id,
        check,
    )
    .await
    {
        Ok(EpisodeInspection::Exact) => {}
        Ok(EpisodeInspection::Redacted) | Ok(EpisodeInspection::NotOwned) | Err(_) => {
            return Ok(correction_receipt(
                replacement,
                &replacement_record,
                SourceStatus::EffectUnknown,
                expected_prior_episode_id,
            ));
        }
    }
    if replacement_record.redaction_state == "none" {
        if !transition_redaction(
            replacement,
            space,
            ledger,
            brain_dir,
            "none",
            "prepared",
            None,
        )? {
            return Ok(correction_receipt(
                replacement,
                &replacement_record,
                SourceStatus::EffectUnknown,
                expected_prior_episode_id,
            ));
        }
        replacement_record.redaction_state = "prepared".to_owned();
    }
    if replacement_record.redaction_state == "complete" {
        return Ok(correction_receipt(
            replacement,
            &replacement_record,
            SourceStatus::EffectUnknown,
            expected_prior_episode_id,
        ));
    }
    if replacement_record.redaction_state == "blocked" {
        if !transition_redaction(
            replacement,
            space,
            ledger,
            brain_dir,
            "blocked",
            "prepared",
            None,
        )? {
            return Ok(correction_receipt(
                replacement,
                &replacement_record,
                SourceStatus::CorrectionBlocked,
                expected_prior_episode_id,
            ));
        }
        replacement_record.redaction_state = "prepared".to_owned();
    }

    check_source_authority(prior, space, check)?;
    let preview = client
        .call_tool_json(
            "redact",
            json!({
                "space":space,
                "target_kind":"episode",
                "target_id":expected_prior_episode_id,
                "dry_run":true,
                "reason":"Ghost source revision correction",
            }),
        )
        .await;
    let preview = match preview {
        Ok(preview) => preview,
        Err(_) => {
            return Ok(correction_receipt(
                replacement,
                &replacement_record,
                SourceStatus::CorrectionBlocked,
                expected_prior_episode_id,
            ));
        }
    };
    check_source_authority(prior, space, check)?;
    let token = preview["plan"]["token"]
        .as_str()
        .filter(|token| valid_redaction_plan_token(token))
        .ok_or_else(|| anyhow!("OxiBrain redaction preview lacks a valid plan token"))?;
    let closure_sha256 = preview["plan"]["closure_hash"]
        .as_str()
        .filter(|hash| valid_source_digest(hash))
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("OxiBrain redaction preview lacks a valid closure hash"))?;
    if preview.pointer("/plan/affected/closure").is_none() {
        let _ = transition_redaction(
            replacement,
            space,
            ledger,
            brain_dir,
            &replacement_record.redaction_state,
            "blocked",
            None,
        );
        replacement_record.redaction_state = "blocked".to_owned();
        return Ok(correction_receipt(
            replacement,
            &replacement_record,
            SourceStatus::CorrectionBlocked,
            expected_prior_episode_id,
        ));
    }
    if !exact_episode_closure(
        &preview,
        "/plan/affected/closure/episodes",
        expected_prior_episode_id,
    ) {
        let _ = transition_redaction(
            replacement,
            space,
            ledger,
            brain_dir,
            &replacement_record.redaction_state,
            "blocked",
            Some(&closure_sha256),
        );
        replacement_record.redaction_state = "blocked".to_owned();
        replacement_record.redaction_closure_sha256 = Some(closure_sha256.clone());
        return Ok(correction_receipt(
            replacement,
            &replacement_record,
            SourceStatus::CorrectionBlocked,
            expected_prior_episode_id,
        ));
    }
    if !transition_redaction(
        replacement,
        space,
        ledger,
        brain_dir,
        &replacement_record.redaction_state,
        "plan_ready",
        Some(&closure_sha256),
    )? {
        return Ok(correction_receipt(
            replacement,
            &replacement_record,
            SourceStatus::EffectUnknown,
            expected_prior_episode_id,
        ));
    }
    replacement_record.redaction_state = "plan_ready".to_owned();
    replacement_record.redaction_closure_sha256 = Some(closure_sha256.clone());
    if check_source_authority(prior, space, check).is_err() {
        let _ = transition_redaction(
            replacement,
            space,
            ledger,
            brain_dir,
            "plan_ready",
            "prepared",
            Some(&closure_sha256),
        );
        bail!("source authority changed before OxiBrain correction");
    }
    if !transition_redaction(
        replacement,
        space,
        ledger,
        brain_dir,
        "plan_ready",
        "sent",
        Some(&closure_sha256),
    )? {
        return Ok(correction_receipt(
            replacement,
            &replacement_record,
            SourceStatus::EffectUnknown,
            expected_prior_episode_id,
        ));
    }
    replacement_record.redaction_state = "sent".to_owned();
    if check_source_authority(prior, space, check).is_err() {
        let _ = transition_redaction(
            replacement,
            space,
            ledger,
            brain_dir,
            "sent",
            "prepared",
            Some(&closure_sha256),
        );
        bail!("source authority changed before OxiBrain correction");
    }
    let committed = client
        .call_tool_json(
            "redact",
            json!({
                "space":space,
                "target_kind":"episode",
                "target_id":expected_prior_episode_id,
                "dry_run":false,
                "reason":"Ghost source revision correction",
                "plan_token":token,
            }),
        )
        .await;
    match committed {
        Ok(committed)
            if exact_episode_closure(
                &committed,
                "/closure/episodes",
                expected_prior_episode_id,
            ) => {}
        Ok(_) => {
            let _ = transition_redaction(
                replacement,
                space,
                ledger,
                brain_dir,
                "sent",
                "blocked",
                Some(&closure_sha256),
            );
            replacement_record.redaction_state = "blocked".to_owned();
            replacement_record.redaction_closure_sha256 = Some(closure_sha256.clone());
            return Ok(correction_receipt(
                replacement,
                &replacement_record,
                SourceStatus::CorrectionBlocked,
                expected_prior_episode_id,
            ));
        }
        Err(_) => {
            let _ = transition_redaction(
                replacement,
                space,
                ledger,
                brain_dir,
                "sent",
                "effect_unknown",
                Some(&closure_sha256),
            );
            replacement_record.redaction_state = "effect_unknown".to_owned();
            replacement_record.redaction_closure_sha256 = Some(closure_sha256.clone());
            return Ok(correction_receipt(
                replacement,
                &replacement_record,
                SourceStatus::EffectUnknown,
                expected_prior_episode_id,
            ));
        }
    }
    if !matches!(
        inspect_episode(
            client,
            prior,
            prior_content,
            space,
            expected_prior_episode_id,
            check,
        )
        .await,
        Ok(EpisodeInspection::Redacted)
    ) {
        let _ = transition_redaction(
            replacement,
            space,
            ledger,
            brain_dir,
            "sent",
            "effect_unknown",
            Some(&closure_sha256),
        );
        return Ok(correction_receipt(
            replacement,
            &replacement_record,
            SourceStatus::EffectUnknown,
            expected_prior_episode_id,
        ));
    }
    if !complete_correction(
        prior,
        replacement,
        space,
        expected_prior_episode_id,
        ledger,
        brain_dir,
        "sent",
        &closure_sha256,
    )? {
        return Ok(correction_receipt(
            replacement,
            &replacement_record,
            SourceStatus::EffectUnknown,
            expected_prior_episode_id,
        ));
    }
    replacement_record.redaction_state = "complete".to_owned();
    replacement_record.redaction_closure_sha256 = Some(closure_sha256.clone());
    Ok(correction_receipt(
        replacement,
        &replacement_record,
        SourceStatus::CorrectionComplete,
        expected_prior_episode_id,
    ))
}

#[cfg(all(test, feature = "memory", unix))]
pub(crate) mod tests {
    use super::*;
    include!("memory_scoped_tests.rs");
    include!("memory_query_tests.rs");
    include!("memory_episode_write_tests.rs");
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::LazyLock,
        time::Duration,
    };

    const KOREAN_SOURCE_CORPUS: [&str; 2] = [
        "회의실 예약은 금요일 오후 세 시입니다. 담당자는 민지입니다.",
        "정기 점검은 매월 둘째 주 수요일 오전에 진행합니다.",
    ];
    static SOURCE_ENV_LOCK: LazyLock<Mutex<()>> =
        LazyLock::new(|| Mutex::new(()));

    pub(crate) struct SourceEnvGuard {
        _guard: tokio::sync::MutexGuard<'static, ()>,
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }
    impl SourceEnvGuard {
        pub(crate) fn capture_extra(&mut self,keys:&[&'static str]) {
            for key in keys {if !self.previous.iter().any(|(saved,_)|saved==key) {self.previous.push((key,std::env::var_os(key)));}}
        }
    }

    impl Drop for SourceEnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.previous {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    async fn source_env(root: &std::path::Path, brain_dir: &std::path::Path, owner: &str) -> SourceEnvGuard {
        let guard = SOURCE_ENV_LOCK.lock().await;
        let keys = [
            "GHOST_BRAIN_SPACE_MAP",
            "GHOST_BRAIN_EXECUTABLE",
            "GHOST_BRAIN_DIR",
            "GHOST_BRAIN_TOKEN",
            "GHOST_BRAIN_SOURCE_LEDGER",
            "GHOST_BRAIN_BINDINGS",
            "GHOST_BRAIN_TOKEN_OWN_FIXTURE",
            "GHOST_BRAIN_TOKEN_SHARED_FIXTURE",
        ];
        let previous = keys
            .iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect::<Vec<_>>();
        let map_path = root.join("spaces.json");
        let mapping = std::collections::BTreeMap::from([(
            owner.to_owned(),
            "fixture-space".to_owned(),
        )]);
        fs::write(&map_path, serde_json::to_vec(&mapping).unwrap()).unwrap();
        std::env::set_var("GHOST_BRAIN_SPACE_MAP", map_path);
        std::env::set_var("GHOST_BRAIN_EXECUTABLE", brain_dir.join("brain-fixture"));
        std::env::set_var("GHOST_BRAIN_DIR", brain_dir);
        std::env::set_var("GHOST_BRAIN_TOKEN", "fixture-token");
        std::env::remove_var("GHOST_BRAIN_BINDINGS");
        std::env::set_var(
            "GHOST_BRAIN_SOURCE_LEDGER",
            root.join("source-ledger.sqlite"),
        );
        SourceEnvGuard {
            _guard: guard,
            previous,
        }
    }

    async fn fixture(dir: &std::path::Path) -> BrainClient {
        let script = dir.join("brain-fixture");
        let info = serde_json::to_string(&oxibrain_client::protocol::server_info(
            "oxibrain", "fixture",
        ))
        .unwrap();
        let source = r#"#!/usr/bin/python3
import sys,json,time,os,hashlib
from pathlib import Path
root=Path(sys.argv[-1])
fixture_space_id='f'*32
info=json.loads('''@INFO@''')
state_path=root/'episodes.json'
def load_state():
 try:return json.loads(state_path.read_text())
 except FileNotFoundError:return {'episodes':{},'plans':{}}
def save_state(state):
 tmp=root/'episodes.json.tmp'
 tmp.write_text(json.dumps(state,ensure_ascii=False))
 tmp.replace(state_path)
for line in sys.stdin:
 req=json.loads(line)
 with (root/'requests.jsonl').open('a') as out:out.write(json.dumps(req,ensure_ascii=False)+'\n')
 method=req['method']
 if method=='auth':
  if req['params']['token']!='fixture-token':
   print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-32001,'message':'fixture authentication denied'}}),flush=True)
   continue
  result={'authenticated':True}
 elif method=='handshake':
  result=info
 elif method=='spaces/list':
  result={'spaces':[{'id':fixture_space_id,'name':'fixture-space','created_at':0,'episode_count':0,'entity_count':0}]}
 elif method=='resources/read':
  uri=req['params']['uri'];episode_id=uri.split('://',1)[1].split('?',1)[0]
  state=load_state();episode=state['episodes'].get(episode_id)
  if episode is None:
   print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-32602,'message':'missing episode'}}),flush=True)
   continue
  result={'contents':[{'uri':uri,'mimeType':'application/json','text':json.dumps(episode,ensure_ascii=False)}]}
 elif method=='tools/call':
  name=req['params']['name'];args=req['params']['arguments']
  if args.get('query')=='hang':time.sleep(60)
  state=load_state()
  if name=='search':
   data={'memory':[],'documents':[],'freshness':{'reconciled_roots':[],'skipped_roots':[],'skipped_files':0,'stale_after_retry':[],'dense_coverage':None}}
   text=json.dumps({'data':data})
  elif name=='recall':
   query=args.get('query','')
   if 'index unavailable' in query.lower():
    result={'isError':True,'content':[{'type':'text','text':'index unavailable'}]}
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
    continue
   matches=[ep for ep in state['episodes'].values() if ep['space']==(fixture_space_id if args['space']=='fixture-space' else args['space']) and query.lower() in ep['content'].lower() and ep['redacted_at'] is None]
   ids=['episode://'+ep['id'] for ep in matches]
   layers=[] if not matches else [{'kind':'query_neighborhood','text':'\n'.join(ep['content'] for ep in matches),'estimated_tokens':8,'provenance':ids}]
   text=json.dumps({'data':{'layers':layers,'total_tokens':8,'truncated':False},'meta':{'dropped':{}}},ensure_ascii=False)
  elif name=='ingest':
   content=args['content'];source_path=args['source_path'];space=fixture_space_id if args['space']=='fixture-space' else args['space']
   episode_id=hashlib.sha256((space+'\0'+source_path+'\0'+content).encode()).hexdigest()
   state['episodes'][episode_id]={'id':episode_id,'space':space,'kind':'primary','trust':args['trust'],'content_hash':[0]*32,'content':content,'source':{'kind':'note','ref':{'path':source_path}},'redacted_at':None}
   save_state(state)
   if (root/'lose_next_ack').exists():
    (root/'lose_next_ack').unlink()
    os._exit(0)
   text='Ingested as episode: '+episode_id
  elif name=='redact':
   target=args['target_id'];episode=state['episodes'].get(target)
   if episode is None:
    result={'isError':True,'content':[{'type':'text','text':'missing episode'}]}
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
    continue
   if args['dry_run']:
    episodes=[target]
    if 'unsafe-closure' in episode['content']:
     episodes.append('f'*64)
    closure_hash=hashlib.sha256(json.dumps(episodes,separators=(',',':')).encode()).hexdigest()
    token='a'*80
    state['plans'][token]={'target':target,'closure_hash':closure_hash,'episodes':episodes}
    save_state(state)
    text=json.dumps({'plan':{'token':token,'closure_hash':closure_hash,'expires_at':1,'affected':{'closure':{'episodes':episodes}}}})
   else:
    token=args['plan_token'];plan=state['plans'].pop(token,None)
    if plan is None or plan['target']!=target:
     result={'isError':True,'content':[{'type':'text','text':'stale plan'}]}
     print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
     continue
    episode['content']='[redacted]';episode['redacted_at']='2026-10-09T00:00:00Z'
    save_state(state)
    if (root/'lose_next_redact_ack').exists():
     (root/'lose_next_redact_ack').unlink()
     os._exit(0)
    text=json.dumps({'closure':{'episodes':plan['episodes']}})
  else:
   result={'isError':True,'content':[{'type':'text','text':'unsupported tool'}]}
   print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
   continue
  result={'content':[{'type':'text','text':text}]}
 else:
  raise Exception('unexpected method '+method)
 print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
"#.replace("@INFO@",&info);
        fs::write(&script, source).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let mut client = BrainClient::spawn_local(LocalProcessEndpoint::new(&script, dir))
            .await
            .unwrap();
        client
            .bring_up(None, oxibrain_client::default_client_hello("fixture"))
            .await
            .unwrap();
        client
    }

    async fn source_setup(
        root: &std::path::Path,
        owner: &str,
    ) -> (Brain, SourceEnvGuard, std::path::PathBuf) {
        let brain_dir = root.join("brain");
        fs::create_dir_all(&brain_dir).unwrap();
        let environment = source_env(root, &brain_dir, owner).await;
        let client = fixture(&brain_dir).await;
        (
            Brain {
                client: Mutex::new(Some(client)),
            },
            environment,
            brain_dir,
        )
    }

    fn source_origin(
        owner: &str,
        source_id: &str,
        revision: &str,
        content: &str,
        disclosure: SourceDisclosure,
    ) -> TrustedSourceOrigin {
        TrustedSourceOrigin::new(
            owner,
            source_id,
            revision,
            disclosure,
            crate::adapters::documents::digest(content.as_bytes()),
        )
        .unwrap()
    }

    fn requests(dir: &std::path::Path) -> Vec<Value> {
        fs::read_to_string(dir.join("requests.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect()
    }


    #[tokio::test]
    async fn cancelled_stdio_read_drops_the_client_with_its_unread_reply() {
        let dir = tempfile::tempdir().unwrap();
        let brain = Brain {
            client: Mutex::new(Some(fixture(dir.path()).await)),
        };
        let result = brain
            .memory_connected(
                "pc-infra",
                "current-session",
                &ai::ToolCall::new(
                    "search",
                    "memory_search",
                    json!({"query":"owner preference"}),
                ),
                &|| Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(result.status, ToolStatus::Success);

        let hang = ai::ToolCall::new("hang", "memory_search", json!({"query":"hang"}));
        assert!(tokio::time::timeout(
            Duration::from_millis(80),
            brain.memory_connected("pc-infra", "current-session", &hang, &|| Ok(()))
        )
        .await
        .is_err());
        assert!(
            brain.client.lock().await.is_none(),
            "cancelled transport remained cached"
        );
    }

    #[tokio::test]
    async fn generic_model_memory_writes_are_denied_before_engine_io() {
        let dir = tempfile::tempdir().unwrap();
        let brain = Brain {
            client: Mutex::new(Some(fixture(dir.path()).await)),
        };
        let result = brain
            .read_memory(
                "unmapped-owner",
                "current-session",
                &ai::ToolCall::new("retain", "memory_retain", json!({"text":"model claim"})),
                &|| Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(result.status, ToolStatus::Denied);
        assert!(brain.client.lock().await.is_some());
        let calls = requests(dir.path());
        assert!(!calls.iter().any(|request| request["method"] == "tools/call"));
    }

    #[tokio::test]
    async fn source_ingest_is_immutable_private_and_revision_qualified() {
        let root = tempfile::tempdir().unwrap();
        let owner = "owner-a";
        let (brain, _environment, brain_dir) = source_setup(root.path(), owner).await;
        let ledger = SourceLedgerConfig::from_env().unwrap();
        assert!(Brain::source_configured());
        let content = "개인 메모: 회의실 예약은 금요일 오후 세 시입니다.";
        let original = source_origin(
            owner,
            "turn-42:call-7",
            "revision-1",
            content,
            SourceDisclosure::Private,
        );
        let first = brain
            .ingest_source(&original, content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(first.status, SourceStatus::Recorded);
        let duplicate = brain
            .ingest_source(&original, content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(duplicate.status, SourceStatus::AlreadyRecorded);
        assert_eq!(duplicate.episode_id, first.episode_id);

        let changed = "개인 메모: 다른 일정입니다.";
        let changed_origin = source_origin(
            owner,
            "turn-42:call-7",
            "revision-1",
            changed,
            SourceDisclosure::Private,
        );
        assert!(
            brain
                .ingest_source(&changed_origin, changed, &ledger, || Ok(()))
                .await
                .is_err(),
            "a changed byte sequence must not reuse an immutable source revision"
        );
        let new_revision = source_origin(
            owner,
            "turn-42:call-7",
            "revision-2",
            content,
            SourceDisclosure::Private,
        );
        let second = brain
            .ingest_source(&new_revision, content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(second.status, SourceStatus::Recorded);
        assert_ne!(first.source_locator, second.source_locator);
        assert_ne!(first.episode_id, second.episode_id);
        assert!(!first.source_locator.contains("turn-42"));

        let unmapped = source_origin(
            "owner-b",
            "turn-42:call-7",
            "revision-1",
            content,
            SourceDisclosure::Private,
        );
        assert!(
            brain
                .ingest_source(&unmapped, content, &ledger, || Ok(()))
                .await
                .is_err(),
            "an owner without a configured mapped space must be denied"
        );

        let ingests = requests(&brain_dir)
            .into_iter()
            .filter(|request| {
                request["method"] == "tools/call" && request["params"]["name"] == "ingest"
            })
            .collect::<Vec<_>>();
        assert_eq!(ingests.len(), 2, "duplicates and rejected writes must not reach OxiBrain");
        let ledger_bytes = fs::read(&ledger.path).unwrap();
        assert!(!ledger_bytes
            .windows(content.len())
            .any(|window| window == content.as_bytes()));
    }

    #[tokio::test]
    async fn lost_ingest_ack_reconciles_by_exact_source_not_shared_content() {
        let root = tempfile::tempdir().unwrap();
        let owner = "owner-a";
        let (brain, _environment, brain_dir) = source_setup(root.path(), owner).await;
        let ledger = SourceLedgerConfig::from_env().unwrap();
        for (index, content) in KOREAN_SOURCE_CORPUS.iter().enumerate() {
            fs::write(brain_dir.join("lose_next_ack"), b"").unwrap();
            let original = source_origin(
                owner,
                &format!("turn-{index}:call-original"),
                "revision-1",
                content,
                SourceDisclosure::LocalOnly,
            );
            let unknown = brain
                .ingest_source(&original, content, &ledger, || Ok(()))
                .await
                .unwrap();
            assert_eq!(unknown.status, SourceStatus::EffectUnknown);

            let same_bytes_other_source = source_origin(
                owner,
                &format!("turn-{index}:call-other"),
                "revision-1",
                content,
                SourceDisclosure::LocalOnly,
            );
            let other = brain
                .ingest_source(&same_bytes_other_source, content, &ledger, || Ok(()))
                .await
                .unwrap();
            assert_eq!(other.status, SourceStatus::Recorded);

            let recovered = brain
                .inspect_source(&original, content, &ledger, || Ok(()))
                .await
                .unwrap();
            assert_eq!(recovered.status, SourceStatus::Recorded);
            assert_ne!(recovered.episode_id, other.episode_id);
            let state: Value =
                serde_json::from_slice(&fs::read(brain_dir.join("episodes.json")).unwrap())
                    .unwrap();
            let source_path = source_locator(&original);
            let exact_id = state["episodes"]
                .as_object()
                .unwrap()
                .iter()
                .find(|(_, episode)| {
                    episode["source"]["ref"]["path"].as_str() == Some(source_path.as_str())
                })
                .map(|(id, _)| id.clone())
                .unwrap();
            assert_eq!(recovered.episode_id.as_deref(), Some(exact_id.as_str()));
        }
        let calls = requests(&brain_dir);
        assert_eq!(
            calls.iter()
                .filter(|request| {
                    request["method"] == "tools/call" && request["params"]["name"] == "ingest"
                })
                .count(),
            4,
            "inspection must not replay either unknown ingest"
        );
    }


    #[tokio::test]
    async fn korean_recall_keeps_episode_provenance_and_rejects_wrong_owner_scope() {
        let root = tempfile::tempdir().unwrap();
        let owner = "owner-a";
        let (brain, _environment, _brain_dir) = source_setup(root.path(), owner).await;
        let ledger = SourceLedgerConfig::from_env().unwrap();
        let mut episode_ids = Vec::new();
        for (index, content) in KOREAN_SOURCE_CORPUS.iter().enumerate() {
            let origin = source_origin(
                owner,
                &format!("document-{index}"),
                "revision-1",
                content,
                SourceDisclosure::Private,
            );
            let receipt = brain
                .ingest_source(&origin, content, &ledger, || Ok(()))
                .await
                .unwrap();
            episode_ids.push(receipt.episode_id.unwrap());
        }
        for (query, expected_episode) in [
            ("회의실 예약", episode_ids[0].as_str()),
            ("정기 점검", episode_ids[1].as_str()),
        ] {
            let result = brain
                .read_memory(
                    owner,
                    "current-session",
                    &ai::ToolCall::new(
                        "recall",
                        "memory_recall",
                        json!({"query":query,"token_budget":512}),
                    ),
                    &|| Ok(()),
                )
                .await
                .unwrap();
            assert_eq!(result.status, ToolStatus::Success);
            let expected_reference = format!("episode://{expected_episode}");
            assert!(
                result.content["data"]["layers"][0]["provenance"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|id| id.as_str() == Some(expected_reference.as_str()))
            );
        }
        let other = brain
            .read_memory(
                "owner-b",
                "current-session",
                &ai::ToolCall::new("recall", "memory_recall", json!({"query":"회의실"})),
                &|| Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(other.status, ToolStatus::Denied);
    }

    #[tokio::test]
    async fn correction_is_episode_scoped_and_lost_redaction_ack_is_inspect_first() {
        let root = tempfile::tempdir().unwrap();
        let owner = "owner-a";
        let (brain, _environment, brain_dir) = source_setup(root.path(), owner).await;
        let ledger = SourceLedgerConfig::from_env().unwrap();
        let prior_content = "프로젝트 메모: 예전 검토일은 월요일입니다.";
        let replacement_content = "프로젝트 메모: 새 검토일은 목요일입니다.";
        let prior = source_origin(
            owner,
            "project-note-9",
            "revision-1",
            prior_content,
            SourceDisclosure::Private,
        );
        let other_origin = source_origin(
            owner,
            "separate-origin",
            "revision-1",
            prior_content,
            SourceDisclosure::Private,
        );
        let prior_receipt = brain
            .ingest_source(&prior, prior_content, &ledger, || Ok(()))
            .await
            .unwrap();
        let other_receipt = brain
            .ingest_source(&other_origin, prior_content, &ledger, || Ok(()))
            .await
            .unwrap();
        let replacement = source_origin(
            owner,
            "project-note-9",
            "revision-2",
            replacement_content,
            SourceDisclosure::Private,
        );
        fs::write(brain_dir.join("lose_next_redact_ack"), b"").unwrap();
        let uncertain = brain
            .correct_source(
                &prior,
                prior_receipt.episode_id.as_deref().unwrap(),
                prior_content,
                &replacement,
                replacement_content,
                &ledger,
                || Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(uncertain.status, SourceStatus::EffectUnknown);
        let completed = brain
            .correct_source(
                &prior,
                prior_receipt.episode_id.as_deref().unwrap(),
                prior_content,
                &replacement,
                replacement_content,
                &ledger,
                || Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(completed.status, SourceStatus::CorrectionComplete);
        assert_eq!(
            completed.prior_episode_id.as_deref(),
            prior_receipt.episode_id.as_deref()
        );
        assert!(completed.redaction_closure_sha256.is_some());
        let serialized = serde_json::to_string(&completed).unwrap();
        assert!(!serialized.contains(&"a".repeat(80)));

        let prior_status = brain
            .inspect_source(&prior, prior_content, &ledger, || Ok(()))
            .await
            .unwrap();
        let other_status = brain
            .inspect_source(&other_origin, prior_content, &ledger, || Ok(()))
            .await
            .unwrap();
        let replacement_status = brain
            .inspect_source(&replacement, replacement_content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(prior_status.status, SourceStatus::Redacted);
        assert_eq!(other_status.status, SourceStatus::Recorded);
        assert_eq!(other_status.episode_id, other_receipt.episode_id);
        assert_eq!(replacement_status.status, SourceStatus::Recorded);

        let calls = requests(&brain_dir);
        let redactions = calls
            .iter()
            .filter(|request| {
                request["method"] == "tools/call" && request["params"]["name"] == "redact"
            })
            .collect::<Vec<_>>();
        assert_eq!(redactions.len(), 2, "the lost commit ACK must not trigger a second redact");
        assert!(redactions.iter().all(|request| {
            request["params"]["arguments"]["target_kind"] == "episode"
                && request["params"]["arguments"]["target_id"]
                    == prior_receipt.episode_id.as_deref().unwrap()
        }));
        assert_eq!(redactions[0]["params"]["arguments"]["dry_run"], true);
        assert_eq!(redactions[1]["params"]["arguments"]["dry_run"], false);
    }

    #[test]
    fn source_correction_accepts_only_exact_engine_publication_copy_proof() {
        let source_owned="a".repeat(64);let declaration_owned="b".repeat(64);
        let source=source_owned.as_str();let declaration=declaration_owned.as_str();
        let valid=json!({"closure":{"episodes":[source,declaration],"publication_declarations":[declaration]}});
        assert!(exact_episode_closure(&valid,"/closure/episodes",source));
        for invalid in [
            json!({"closure":{"episodes":[source,declaration]}}),
            json!({"closure":{"episodes":[source],"publication_declarations":[declaration]}}),
            json!({"closure":{"episodes":[source,declaration,declaration],"publication_declarations":[declaration]}}),
            json!({"closure":{"episodes":[source,declaration],"publication_declarations":[declaration,declaration]}}),
            json!({"closure":{"episodes":[source,declaration,"unrelated-episode"],"publication_declarations":[declaration]}}),
            json!({"closure":{"episodes":[source],"publication_declarations":[source]}}),
        ] {assert!(!exact_episode_closure(&invalid,"/closure/episodes",source));}
        assert!(exact_episode_closure(&json!({"closure":{"episodes":[source]}}),"/closure/episodes",source));
    }

    #[tokio::test]
    async fn correction_refuses_a_preview_with_any_other_episode() {
        let root = tempfile::tempdir().unwrap();
        let owner = "owner-a";
        let (brain, _environment, brain_dir) = source_setup(root.path(), owner).await;
        let ledger = SourceLedgerConfig::from_env().unwrap();
        let prior_content = "unsafe-closure: 기존 한국어 메모입니다.";
        let replacement_content = "정정된 메모입니다.";
        let prior = source_origin(
            owner,
            "source-with-shared-support",
            "revision-1",
            prior_content,
            SourceDisclosure::LocalOnly,
        );
        let saved = brain
            .ingest_source(&prior, prior_content, &ledger, || Ok(()))
            .await
            .unwrap();
        let replacement = source_origin(
            owner,
            "source-with-shared-support",
            "revision-2",
            replacement_content,
            SourceDisclosure::LocalOnly,
        );
        let result = brain
            .correct_source(
                &prior,
                saved.episode_id.as_deref().unwrap(),
                prior_content,
                &replacement,
                replacement_content,
                &ledger,
                || Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(result.status, SourceStatus::CorrectionBlocked);
        let prior_after = brain
            .inspect_source(&prior, prior_content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(prior_after.status, SourceStatus::Recorded);
        let redactions = requests(&brain_dir)
            .into_iter()
            .filter(|request| {
                request["method"] == "tools/call" && request["params"]["name"] == "redact"
            })
            .collect::<Vec<_>>();
        assert_eq!(redactions.len(), 1);
        assert_eq!(redactions[0]["params"]["arguments"]["dry_run"], true);
    }

    #[tokio::test]
    async fn unavailable_recall_index_keeps_lost_ingest_unknown_without_retry() {
        let root = tempfile::tempdir().unwrap();
        let owner = "owner-a";
        let (brain, _environment, brain_dir) = source_setup(root.path(), owner).await;
        let ledger = SourceLedgerConfig::from_env().unwrap();
        let content = "INDEX UNAVAILABLE: 검색 인덱스가 멈춘 상태입니다.";
        let origin = source_origin(
            owner,
            "index-test-source",
            "revision-1",
            content,
            SourceDisclosure::Private,
        );
        fs::write(brain_dir.join("lose_next_ack"), b"").unwrap();
        let unknown = brain
            .ingest_source(&origin, content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(unknown.status, SourceStatus::EffectUnknown);
        let inspected = brain
            .inspect_source(&origin, content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(inspected.status, SourceStatus::EffectUnknown);
        let calls = requests(&brain_dir);
        assert_eq!(
            calls.iter()
                .filter(|request| {
                    request["method"] == "tools/call" && request["params"]["name"] == "ingest"
                })
                .count(),
            1
        );
        assert!(calls.iter().any(|request| {
            request["method"] == "tools/call" && request["params"]["name"] == "recall"
        }));
    }

    #[tokio::test]
    async fn source_listing_reports_standing_revisions_without_stored_text() {
        let root = tempfile::tempdir().unwrap();
        let owner = "owner-a";
        let (brain, _environment, _brain_dir) = source_setup(root.path(), owner).await;
        let ledger = SourceLedgerConfig::from_env().unwrap();
        let prior_content = KOREAN_SOURCE_CORPUS[0];
        let other_content = KOREAN_SOURCE_CORPUS[1];
        let replacement_content = "정정된 한국어 메모: 검토일은 목요일입니다.";
        let prior = source_origin(
            owner,
            "canonical:owner-a:conv-1:turn-1:effect:cmd-1",
            "revision-1",
            prior_content,
            SourceDisclosure::LocalOnly,
        );
        let prior_receipt = brain
            .ingest_source(&prior, prior_content, &ledger, || Ok(()))
            .await
            .unwrap();
        assert_eq!(prior_receipt.status, SourceStatus::Recorded);
        let other = source_origin(
            owner,
            "canonical:owner-a:conv-2:turn-2:effect:cmd-2",
            "revision-1",
            other_content,
            SourceDisclosure::Private,
        );
        brain
            .ingest_source(&other, other_content, &ledger, || Ok(()))
            .await
            .unwrap();

        // A completed Owner correction keeps the same source id; the standing
        // replacement lists as a recorded, fully inspectable revision while
        // its redacted prior stays in the list as inspect-only history.
        let replacement = source_origin(
            owner,
            "canonical:owner-a:conv-1:turn-1:effect:cmd-1",
            "owner-correction:248a615b-0000-4000-8000-000000000000",
            replacement_content,
            SourceDisclosure::LocalOnly,
        );
        let completed = brain
            .correct_source(
                &prior,
                prior_receipt.episode_id.as_deref().unwrap(),
                prior_content,
                &replacement,
                replacement_content,
                &ledger,
                || Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(completed.status, SourceStatus::CorrectionComplete);

        let (listed, more) = brain.list_source_receipts(owner, &ledger, || Ok(())).unwrap();
        assert!(!more, "the fixture ledger stays under the listing bound");
        assert_eq!(listed.len(), 3, "every retained revision is listed latest first");
        // The replacement is strictly the newest write, so it leads.
        let head = &listed[0];
        assert_eq!(head.origin.source_id, prior.source_id);
        assert_eq!(head.origin.revision, replacement.revision);
        assert_eq!(head.receipt.status, SourceStatus::Recorded);
        assert_eq!(head.redaction_state, "complete");
        assert_eq!(head.prior_revision.as_deref(), Some(prior.revision.as_str()));
        assert_eq!(head.receipt.prior_episode_id, prior_receipt.episode_id);
        let find = |source_id: &str, revision: &str| {
            listed.iter()
                .find(|head| {
                    head.origin.source_id == source_id && head.origin.revision == revision
                })
                .unwrap_or_else(|| panic!("revision {source_id}/{revision} must be listed"))
        };
        let other_head = find(&other.source_id, &other.revision);
        assert_eq!(other_head.receipt.status, SourceStatus::Recorded);
        let redacted_prior = find(&prior.source_id, &prior.revision);
        assert_eq!(redacted_prior.receipt.status, SourceStatus::Redacted);
        assert_eq!(redacted_prior.origin.content_sha256, prior.content_sha256);

        assert!(
            brain.list_source_receipts("owner-b", &ledger, || Ok(())).is_err(),
            "an owner without a mapped space is denied"
        );
    }
}
