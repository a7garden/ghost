//! Host-only source-view publication transport. This does not widen a shared
//! memory binding or put a credential in an operation, receipt, or model tool.
use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicationCapability {
    pub id: String,
    pub ghost_id: String,
    pub origin_space: String,
    pub destination_space: String,
    pub origin_token_env: String,
    pub destination_token_env: String,
    pub policy_revision: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration { version: u64, capabilities: Vec<PublicationCapability> }

/// Safe immutable authorization pin. Credential values are never retained.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicationAuthorization {
    pub capability: PublicationCapability,
    pub configuration_revision: String,
    pub origin_space_id: String,
    pub destination_space_id: String,
    pub destination_revision: String,
}
// Deliberately no Debug/Serialize: credentials stay inside this boundary.
struct Capture { capability: PublicationCapability, origin: String, destination: String, revision: String }
fn unavailable() -> anyhow::Error { anyhow!("source-view publication capability unavailable") }
fn valid_ref(value: &str) -> bool { !value.is_empty() && value.len() <= 256 && !value.contains('\0') }
fn valid_env(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().enumerate().all(|(i,b)| b == b'_' || b.is_ascii_uppercase() || (i > 0 && b.is_ascii_digit()))
}
fn configured_capability(owner: &str, capability_id: &str) -> Result<PublicationCapability> {
    use std::io::Read;
    let path = std::env::var_os("GHOST_BRAIN_PUBLICATIONS").ok_or_else(unavailable)?;
    let mut options = std::fs::OpenOptions::new(); options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
    let mut file = options.open(path).map_err(|_| unavailable())?;
    ensure!(file.metadata()?.is_file() && file.metadata()?.len() <= 65536, "publication policy exceeds its bound");
    let mut bytes=Vec::new(); file.by_ref().take(65537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "publication policy exceeds its bound");
    let cfg: Configuration=serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    ensure!(cfg.version == 1 && cfg.capabilities.len() <= 64, "unsupported publication policy");
    let mut ids=BTreeSet::new();
    for cap in &cfg.capabilities {
        ensure!([&cap.id,&cap.ghost_id,&cap.origin_space,&cap.destination_space].iter().all(|v|valid_ref(v))
            && valid_env(&cap.origin_token_env) && valid_env(&cap.destination_token_env)
            && cap.policy_revision > 0 && ids.insert((&cap.ghost_id,&cap.id)), "invalid publication capability");
    }
    cfg.capabilities.into_iter().find(|cap|cap.ghost_id == owner && cap.id == capability_id).ok_or_else(unavailable)
}
fn capture(owner: &str, capability_id: &str) -> Result<Capture> {
    let cap=configured_capability(owner,capability_id)?;
    let origin=std::env::var(&cap.origin_token_env).map_err(|_| unavailable())?;
    let destination=std::env::var(&cap.destination_token_env).map_err(|_| unavailable())?;
    ensure!(!origin.is_empty() && !destination.is_empty() && origin != destination,"publication requires separate credentials");
    let revision=format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"capability":cap,
        "origin":format!("{:x}",Sha256::digest(origin.as_bytes())),"destination":format!("{:x}",Sha256::digest(destination.as_bytes())),
        "executable":std::env::var_os("GHOST_BRAIN_EXECUTABLE").map(|v|v.to_string_lossy().into_owned()),
        "directory":std::env::var_os("GHOST_BRAIN_DIR").map(|v|v.to_string_lossy().into_owned())}))?));
    Ok(Capture {capability:cap,origin,destination,revision})
}
pub(crate) fn configuration_current(owner: &str, pin: &PublicationAuthorization) -> Result<()> {
    let current=capture(owner,&pin.capability.id)?;
    ensure!(current.capability == pin.capability && current.revision == pin.configuration_revision,"publication authority changed; reconcile the original occurrence"); Ok(())
}
pub(crate) fn capability(owner: &str, id: &str) -> Result<PublicationCapability> { configured_capability(owner,id) }
pub(crate) fn has_owned_source_space(owner:&str)->Result<bool> {
    #[cfg(feature="memory")] {Ok(super::Brain::space_for_owner(owner)?.is_some())}
    #[cfg(not(feature="memory"))] {let _=owner;Ok(false)}
}
pub(crate) fn owns_origin(owner:&str,cap:&PublicationCapability)->Result<bool> {
    #[cfg(feature="memory")] {Ok(super::Brain::space_for_owner(owner)?.as_deref()==Some(cap.origin_space.as_str()))}
    #[cfg(not(feature="memory"))] {let _=(owner,cap);Ok(false)}
}
fn destination_stamp(cap:&PublicationCapability,secret:&str)->Result<String> {
    Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"capability":cap,"destination":format!("{:x}",Sha256::digest(secret.as_bytes())),
        "executable":std::env::var_os("GHOST_BRAIN_EXECUTABLE").map(|v|v.to_string_lossy().into_owned()),"directory":std::env::var_os("GHOST_BRAIN_DIR").map(|v|v.to_string_lossy().into_owned())}))?)))
}
pub(crate) fn destination_current(owner:&str,pin:&PublicationAuthorization)->Result<()> {
    let cap=configured_capability(owner,&pin.capability.id)?;
    let secret=std::env::var(&cap.destination_token_env).map_err(|_|unavailable())?;
    ensure!(cap==pin.capability&&destination_stamp(&cap,&secret)?==pin.destination_revision,"publication destination authority changed");Ok(())
}

#[cfg(feature="memory")]
async fn spawn() -> Result<oxibrain_client::BrainClient> {
    use oxibrain_client::{BrainClient, LocalProcessEndpoint};
    Ok(BrainClient::spawn_local_without_models(LocalProcessEndpoint::new(std::env::var_os("GHOST_BRAIN_EXECUTABLE").ok_or_else(unavailable)?,std::env::var_os("GHOST_BRAIN_DIR").ok_or_else(unavailable)?)).await?)
}
#[cfg(feature="memory")]
async fn exact_scope(secret: &str, space: &str, cap: &str) -> Result<(oxibrain_client::BrainClient,String)> {
    let mut client=spawn().await?;
    client.auth(secret).await.map_err(|_|unavailable())?;
    client.handshake(oxibrain_client::default_client_hello(env!("CARGO_PKG_VERSION"))).await.map_err(|_|unavailable())?;
    let scope=client.authenticated_scope().cloned().ok_or_else(unavailable)?;
    ensure!(scope["caps"] == json!([cap]) && scope["predicate_filter"].is_null() && scope["entity_type_filter"].is_null(),"publication credential exceeds its exact capability");
    let spaces=client.list_spaces().await.map_err(|_|unavailable())?;
    ensure!(spaces.len() == 1 && spaces[0].name == space && scope["spaces"] == json!([spaces[0].id]),"publication credential exceeds its exact space");
    let id=spaces[0].id.clone(); Ok((client,id))
}
pub(crate) async fn authorize(owner: &str, id: &str, check: &(impl Fn()->Result<()>+Send+Sync)) -> Result<PublicationAuthorization> {
    check()?;
    #[cfg(not(feature="memory"))] { let _=(owner,id); anyhow::bail!("memory feature unavailable"); }
    #[cfg(feature="memory")] {
        let captured=capture(owner,id)?;
        let (origin,origin_id)=exact_scope(&captured.origin,&captured.capability.origin_space,"read").await?; origin.close().await.map_err(|_|unavailable())?;
        let (destination,destination_id)=exact_scope(&captured.destination,&captured.capability.destination_space,"write").await?; destination.close().await.map_err(|_|unavailable())?;
        check()?;
        let destination_revision=destination_stamp(&captured.capability,&captured.destination)?;
        let pin=PublicationAuthorization{capability:captured.capability,configuration_revision:captured.revision,origin_space_id:origin_id,destination_space_id:destination_id,destination_revision};
        configuration_current(owner,&pin)?; Ok(pin)
    }
}
pub(crate) async fn execute(owner:&str,pin:&PublicationAuthorization,operation:&str,request:Value,check:&(impl Fn()->Result<()>+Send+Sync))->Result<Value> {
    ensure!(matches!(operation,"publish"|"withdraw"),"unsupported publication operation");
    check()?; if operation=="withdraw" {destination_current(owner,pin)?;} else {configuration_current(owner,pin)?;}
    #[cfg(not(feature="memory"))] {let _=(operation,request);anyhow::bail!("memory feature unavailable");}
    #[cfg(feature="memory")] {
        if operation == "withdraw" {
            let cap=configured_capability(owner,&pin.capability.id)?;
            let secret=std::env::var(&cap.destination_token_env).map_err(|_|unavailable())?;
            let (mut client,id)=exact_scope(&secret,&cap.destination_space,"write").await?;
            ensure!(id == pin.destination_space_id,"publication destination changed");
            let result=client.call_rpc_json("source_view.withdraw",request).await.map_err(|_|unavailable());
            client.close().await.map_err(|_|unavailable())?; check()?; destination_current(owner,pin)?;
            exact_scope(&secret,&cap.destination_space,"write").await?.0.close().await.map_err(|_|unavailable())?;
            return result;
        }
        ensure!(authorize(owner,&pin.capability.id,check).await? == *pin,"publication authorization changed");
        let captured=capture(owner,&pin.capability.id)?;
        let mut client=spawn().await?;
        client.auth_publication(&captured.origin,&captured.destination).await.map_err(|_|unavailable())?;
        client.handshake(oxibrain_client::default_client_hello(env!("CARGO_PKG_VERSION"))).await.map_err(|_|unavailable())?;
        configuration_current(owner,pin)?; check()?;
        let result=client.call_rpc_json(&format!("source_view.{operation}"),request).await.map_err(|_|unavailable());
        client.close().await.map_err(|_|unavailable())?;
        check()?; ensure!(authorize(owner,&pin.capability.id,check).await? == *pin,"publication authorization changed during I/O");
        result
    }
}
pub(crate) async fn episode_origin(owner:&str,pin:&PublicationAuthorization,id:&str,source_sha256:&str,check:&(impl Fn()->Result<()>+Send+Sync))->Result<Value> {
    check()?;configuration_current(owner,pin)?;
    #[cfg(not(feature="memory"))] {let _=(id,source_sha256);anyhow::bail!("memory feature unavailable");}
    #[cfg(feature="memory")] {
        let captured=capture(owner,&pin.capability.id)?;
        let (mut client,space)=exact_scope(&captured.origin,&captured.capability.origin_space,"read").await?;
        ensure!(space==pin.origin_space_id,"publication origin changed");
        let descriptor=client.call_rpc_json("source_view.origin.inspect",json!({"version":"source-view-publication/1","space":space,"episode_id":id})).await.map_err(|_|unavailable())?;
        ensure!(descriptor["version"]=="source-view-origin/1"&&descriptor["source_sha256"]==source_sha256&&descriptor["source_bytes"].as_u64().is_some_and(|size|size<=8*1024*1024)
            && descriptor["revision"].as_str().is_some_and(|value|value.len()==64&&value.bytes().all(|byte|byte.is_ascii_hexdigit()))&&descriptor.as_object().is_some_and(|map|map.len()==4),"publication source differs from the canonical Host receipt");
        client.close().await.map_err(|_|unavailable())?;exact_scope(&captured.origin,&captured.capability.origin_space,"read").await?.0.close().await.map_err(|_|unavailable())?;check()?;configuration_current(owner,pin)?;
        Ok(json!({"kind":"episode","space":space,"episode_id":id,"revision":descriptor["revision"]}))
    }
}
pub(crate) async fn document_origin(owner:&str,pin:&PublicationAuthorization,uuid:&str,raw_sha256:&str,expected_path:&Path,check:&(impl Fn()->Result<()>+Send+Sync))->Result<Value> {
    check()?; configuration_current(owner,pin)?;
    #[cfg(not(feature="memory"))] {let _=(uuid,raw_sha256,expected_path);anyhow::bail!("memory feature unavailable");}
    #[cfg(feature="memory")] {
        let captured=capture(owner,&pin.capability.id)?;
        let (mut client,id)=exact_scope(&captured.origin,&captured.capability.origin_space,"read").await?;
        ensure!(id == pin.origin_space_id,"publication origin space changed");
        let proof=client.document_source_proof(&id,uuid,raw_sha256).await.map_err(|_|unavailable())?.ok_or_else(unavailable)?;
        let path=Path::new(&proof.canonical_root).join(&proof.locator).canonicalize().map_err(|_|unavailable())?;
        ensure!(proof.fresh && proof.root_generation>0 && proof.space==id && proof.document_uuid==uuid && proof.source_sha256==raw_sha256 && path==expected_path.canonicalize().map_err(|_|unavailable())?,"publication document proof differs from the Host source");
        let document_id=proof.document_id.filter(|v|valid_ref(v)).ok_or_else(unavailable)?;
        let decoder=proof.decoder.filter(|v|valid_ref(v)).ok_or_else(unavailable)?;
        client.close().await.map_err(|_|unavailable())?; check()?; configuration_current(owner,pin)?;
        Ok(json!({"kind":"document","space":id,"root":proof.root_alias,"document_id":document_id,"document_uuid":uuid,"revision":proof.source_revision,"decoder":decoder}))
    }
}

/// Receiver path: only its independently granted shared Read binding is used.
pub(crate) async fn read(owner:&str,binding_id:&str,space:&str,id:&str,check:&(impl Fn()->Result<()>+Send+Sync))->Result<Value> {
    check()?;
    #[cfg(not(feature="memory"))] {let _=(owner,binding_id,space,id);anyhow::bail!("memory feature unavailable");}
    #[cfg(feature="memory")] {
        let snapshot=super::scoped::snapshot(owner)?.ok_or_else(unavailable)?.restrict_shared(&[binding_id.into()])?;
        let binding=snapshot.bindings.first().ok_or_else(unavailable)?;
        ensure!(binding.spaces.iter().any(|candidate|candidate==space),"publication audience is not granted");
        let mut client=snapshot.connect_without_models(binding,owner,check).await?;
        let spaces=client.list_spaces().await?;
        let actual=spaces.iter().find(|candidate|candidate.name==space).ok_or_else(unavailable)?.id.clone();
        let value=client.call_rpc_json("source_view.read",json!({"version":"source-view-publication/1","destination":actual,"publication_id":id})).await.map_err(|_|unavailable())?;
        client.close().await.map_err(|_|unavailable())?; snapshot.connect_without_models(binding,owner,check).await?.close().await.map_err(|_|unavailable())?; snapshot.check(owner,check)?;
        ensure!(value["version"]=="source-view-publication/1" && value["publication_id"]==id && value["citation"]==format!("publication://{id}")
            && value["extractable"]==false && value["independent_support"]==false && ["current","closed","redacted"].contains(&value["state"].as_str().unwrap_or("")),"invalid publication audience view");
        let bytes=value["bytes"].as_str().ok_or_else(unavailable)?;
        ensure!(bytes.len()<=65536 && (value["state"]!="current" || value["view_revision"]==blake3::hash(bytes.as_bytes()).to_hex().as_str()),"invalid publication view revision");
        ensure!(value.as_object().is_some_and(|map|map.keys().all(|key|["version","publication_id","citation","view_revision","range","bytes","state","extractable","independent_support","uncertainty"].contains(&key.as_str()))),"publication audience fields exceed the safe DTO");
        Ok(value)
    }
}
