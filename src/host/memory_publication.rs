//! Owner-authorized source-view intents and receiver dependencies. The journal
//! stores operation requests/receipts; Oxibrain remains the knowledge owner.
use super::{lifetime, now_ms, Host, State};
use crate::{adapters::memory::{publication as engine, Brain}, domain::Policy,
    lifetime_contract::{canonical_digest, Envelope, Response, ResponseStatus, RetryClass, Work}};
use anyhow::{anyhow, bail, ensure, Result};
use lifetime::{PiInferenceScope, PiToolRequest};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
const INTENTS:&str="memory_publication_intent_v1";
const PROFILES:&str="memory_publication_profile_v1";
const PINS:&str="memory_publication_work_pin_v1";
const DEPENDENCIES:&str="memory_publication_dependencies_v1";
const MAX_REFS:usize=8;

#[derive(Clone,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
enum Source {
    Episode { episode_id:String, source_sha256:String },
    Document { document_uuid:String, raw_sha256:String, path:std::path::PathBuf },
    Publication { publication_id:String, revision:String },
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    id:String, owner:String, conversation:String, capability_id:String,
    capability:engine::PublicationCapability,
    source:Source, source_ref:String, bytes:String, start:usize,end:usize,
    created_ms:u64, dispatch_epoch:u64, revision:u64, generation:u64,
    operation:String, state:String, attempts:u32,next_attempt_ms:u64,
    authorization:Option<engine::PublicationAuthorization>, request:Option<Value>,receipt:Option<Value>,
}
#[derive(Clone,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
struct Reference {
    reference:String, publication_id:String, view_revision:String, space:String,binding_id:String,
    profile:crate::adapters::memory_bindings::WorkMemoryProfile,
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile { revision:u64,references:Vec<Reference> }
#[derive(Clone,Serialize,Deserialize,Default)]
#[serde(deny_unknown_fields)]
struct Dependencies { references:Vec<Reference>, blocked:bool }
fn load<T:for<'de>Deserialize<'de>>(conn:&Connection,kind:&str,id:&str)->Result<Option<T>> {
    let raw:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",params![kind,id],|r|r.get(0)).optional()?;
    raw.map(|raw|serde_json::from_str(&raw).map_err(Into::into)).transpose()
}
fn put(conn:&Connection,kind:&str,id:&str,value:&impl Serialize)->Result<()> {
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![kind,id,serde_json::to_string(value)?])?; Ok(())
}
fn text<'a>(value:&'a Value,key:&str)->Result<&'a str> {value[key].as_str().filter(|v|!v.is_empty()&&v.len()<=400).ok_or_else(||anyhow!("publication identity is invalid"))}
fn fields(value:&Value,allowed:&[&str])->Result<()> {ensure!(value.as_object().is_some_and(|v|v.keys().all(|key|allowed.contains(&key.as_str()))),"unexpected publication field");Ok(())}
fn success(data:Value)->Response {Response{status:ResponseStatus::Success,summary:"Source-view publication state; publication is not accepted truth".into(),object_refs:vec![],artifacts:vec![],next_actions:vec![],error_code:None,retry_class:RetryClass::SameId,data}}
pub(crate) fn denied()->Response {Response{status:ResponseStatus::Error,summary:"Published source context cannot be revalidated; use a fresh authorized context or reconcile the original operation".into(),object_refs:vec![],artifacts:vec![],next_actions:vec!["inspect_original_publication".into()],error_code:Some("publication_context_unavailable".into()),retry_class:RetryClass::Never,data:Value::Null}}
fn work(conn:&Connection,id:&str)->Result<Work> {let raw:String=conn.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[id],|r|r.get(0))?;Ok(serde_json::from_str(&raw)?)}
fn work_key(work:&Work)->String {format!("work:{}:{}:{}:{}",work.owner,work.id,work.goal_revision,work.owner_revision)}
fn public_intent(entry:&Intent)->Value {json!({"version":"ghost-memory-publication/1","publication_ref":entry.id,"revision":entry.revision,"state":entry.state,"operation":entry.operation,"source_ref":entry.source_ref,"capability_id":entry.capability_id,"destination":entry.capability.destination_space,"view_digest":blake3::hash(entry.bytes.as_bytes()).to_hex().as_str(),"range":{"start":entry.start,"end":entry.end},"receipt":entry.receipt})}
fn source_ref(kind:&str,id:&str)->Result<String> {Ok(format!("source-{}",canonical_digest(&json!([kind,id]))?))}
fn exact_source_ref(kind:&str,occurrence:&str,source:&Source)->Result<String> {source_ref(kind,&canonical_digest(&json!([occurrence,source]))?)}

fn save_intent(conn:&Connection,entry:&Intent)->Result<bool> {Ok(conn.execute("UPDATE workspace_objects SET payload=?3 WHERE kind=?1 AND id=?2 AND json_extract(payload,'$.generation')=?4",params![INTENTS,entry.id,serde_json::to_string(entry)?,entry.generation])?==1)}
pub(crate) fn pin_work(conn:&Connection,work:&Work)->Result<()> {
    let key=work_key(work);
    if load::<Profile>(conn,PINS,&key)?.is_none() {
        let profile=load::<Profile>(conn,PROFILES,&work.owner)?.unwrap_or(Profile{revision:0,references:vec![]});
        put(conn,PINS,&key,&profile)?;
    } Ok(())
}
pub(crate) fn has_work_references(conn:&Connection,work:&Work)->Result<bool> {Ok(load::<Profile>(conn,PINS,&work_key(work))?.is_some_and(|p|!p.references.is_empty())||has_work_dependencies(conn,work)?)}
pub(crate) fn has_work_dependencies(conn:&Connection,work:&Work)->Result<bool> {Ok(load::<Dependencies>(conn,DEPENDENCIES,&work_key(work))?.is_some_and(|p|p.blocked||!p.references.is_empty()))}
pub(crate) fn experience_dependencies(conn:&Connection,work:&Work)->Result<Vec<Value>> {
    let deps=load::<Dependencies>(conn,DEPENDENCIES,&work_key(work))?.unwrap_or_default();
    let mut refs=deps.references.into_iter().map(|r|json!({"reference":r.reference,"citation":format!("publication://{}",r.publication_id),"view_revision":r.view_revision})).collect::<Vec<_>>();
    if deps.blocked {refs.push(json!({"blocked":true}));} Ok(refs)
}
pub(crate) fn assignment_view(conn:&Connection,work:&Work)->Result<Value> {
    let refs=load::<Profile>(conn,PINS,&work_key(work))?.map(|p|p.references).unwrap_or_default();
    Ok(json!({"version":"ghost-memory-publication/1","references":refs.iter().map(|r|json!({"reference":r.reference,"citation":format!("publication://{}",r.publication_id),"view_revision":r.view_revision})).collect::<Vec<_>>(),
        "required":has_work_dependencies(conn,work)?}))
}

fn owner_source(view:&Value)->Result<Option<(String,Source)>> {
    // A standing corrected source can report recorded+redaction complete;
    // only its actual active receipt, exact episode and digest identify it.
    if !["recorded","already_recorded","correction_complete"].contains(&view["receipt"]["status"].as_str().unwrap_or("")) {return Ok(None);}
    let Some(sha)=view["origin"]["content_sha256"].as_str().filter(|value|value.len()==64&&value.bytes().all(|byte|byte.is_ascii_hexdigit())) else{return Ok(None);};
    let Some(id)=view["receipt"]["episode_id"].as_str() else{return Ok(None);};
    let Some(source)=view["origin"]["source_id"].as_str() else{return Ok(None);};
    let Some(revision)=view["origin"]["revision"].as_str() else{return Ok(None);};
    let identity=canonical_digest(&json!([source,revision,id,sha]))?;
    Ok(Some((source_ref("owner",&identity)?,Source::Episode{episode_id:id.into(),source_sha256:sha.into()})))
}

fn own_publication_sources(conn:&Connection,owner:&str,conversation:&str)->Result<Vec<(String,Source)>> {
    let mut out=vec![];
    let mut query=conn.prepare("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.owner')=?2 AND json_extract(payload,'$.conversation')=?3 AND json_extract(payload,'$.state')='confirmed' AND json_extract(payload,'$.operation')='publish' ORDER BY id LIMIT 65")?;
    let entries=query.query_map(params![INTENTS,owner,conversation],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    ensure!(entries.len()<=64,"publication source list exceeds its bound");
    for raw in entries {let entry:Intent=serde_json::from_str(&raw)?;if let Some(receipt)=entry.receipt {let source=Source::Publication{publication_id:text(&receipt,"publication_id")?.into(),revision:text(&receipt,"view_revision")?.into()};out.push((exact_source_ref("publication",&entry.id,&source)?,source));}}
    Ok(out)
}

impl Host {
    fn publication_owner_sources(&self,owner:&str,conversation:&str)->Result<Vec<(String,Source)>> {
        let listed=if crate::adapters::memory::SourceLedgerConfig::from_env().is_ok()&&engine::has_owned_source_space(owner)? {self.owner_memory_source_list(owner,conversation)?} else {Value::Null};
        let mut out=vec![];
        if let Some(sources)=listed["data"]["sources"].as_array() {
            for view in sources {if let Some(source)=owner_source(view)? {out.push(source);}}

        }
        let state=self.lock()?; let conn=&state.journal.0;
        let mut query=conn.prepare("SELECT payload FROM workspace_objects WHERE kind='work_experience_outbox_v1' AND json_extract(payload,'$.owner')=?1 AND json_extract(payload,'$.state')='indexed' ORDER BY id LIMIT 65")?;
        let experiences=query.query_map([owner],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        ensure!(experiences.len()<=64,"publication source list exceeds its bound");
        for raw in experiences {
            let e:Value=serde_json::from_str(&raw)?;
            let w=work(conn,text(&e,"work_id")?)?;
            // A model summary cannot launder an existing publication into a
            // new source family. Only exact parent-view recitation is allowed.
            if has_work_dependencies(conn,&w)? {continue;}
            let grant:Value=load(conn,"work_memory_grant_v1",text(&e,"grant_key")?)?.ok_or_else(||anyhow!("experience grant missing"))?;
            let root=grant["experience_space"]["path"].as_str().ok_or_else(||anyhow!("experience source root missing"))?;
            let source=Source::Document{document_uuid:text(&e,"page_id")?.into(),raw_sha256:text(&e,"hash")?.into(),path:std::path::Path::new(root).join(format!("{}.md",text(&e,"page_id")?))};
            out.push((exact_source_ref("experience",text(&e,"id")?,&source)?,source));
        }
        out.extend(own_publication_sources(conn,owner,conversation)?);
        // Only explicitly pinned, independently configured receiver references
        // may be offered for cross-Ghost re-citation. Never scan foreign intents.
        if let Some(profile)=load::<Profile>(conn,PROFILES,owner)? {for reference in profile.references {
            if Brain::work_profile(owner,&[reference.binding_id.clone()]).ok().as_ref()!=Some(&reference.profile) {continue;}
            let source=Source::Publication{publication_id:reference.publication_id,revision:reference.view_revision};
            out.push((exact_source_ref("reference",&reference.reference,&source)?,source));
        }}
        ensure!(out.len()<=128,"publication source list exceeds its bound");Ok(out)
    }

    /// Called only from the authenticated Owner ingress. The original exact
    /// source/view/destination request is immutable before engine effects.
    pub(crate) fn memory_publication_owner(&self,envelope:&Envelope)->Result<Value> {
        envelope.validate()?; ensure!(envelope.actor_ref=="owner","publication requires authenticated Owner");
        let body=&envelope.body;let method=text(body,"method")?;
        let owner=text(body,"ghost_id")?;let conversation=text(body,"conversation_id")?;
        {let state=self.lock()?;ensure!(state.profiles.contains_key(owner),"publication Ghost missing");
            let bound:bool=state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_bindings WHERE conversation_id=?1 AND ghost_id=?2 AND runtime_kind='pi-durable')",params![conversation,owner],|row|row.get(0))?;
            ensure!(bound,"publication conversation is not registered to this Ghost");
            ensure!(lifetime::authority::guard(&state.journal.0,envelope)?.is_none(),"publication Host authority unavailable");}
        let sources=if matches!(method,"memory.publication.sources"|"memory.publication.prepare") {self.publication_owner_sources(owner,conversation)?} else {vec![]};
        let state=self.lock()?;let conn=&state.journal.0;
        let response=lifetime::apply_with_admission(conn,envelope,"owner",|conn| {
            let policy:Policy=load(conn,"policy",owner)?.unwrap_or_default();ensure!(policy.memory,"publication memory permission is disabled");
            match method {
                "memory.publication.sources"=>{fields(body,&["method","ghost_id","conversation_id"])?;Ok(Some(success(json!({"sources":sources.iter().map(|(reference,source)|json!({"source_ref":reference,"kind":match source {Source::Episode{..}=>"owner_source",Source::Document{..}=>"experience",Source::Publication{..}=>"publication"}})).collect::<Vec<_>>()}))))},
                "memory.publication.prepare"=>{
                    fields(body,&["method","ghost_id","conversation_id","capability_id","source_ref","bytes","range"])?;
                    let source_id=text(body,"source_ref")?;
                    let source=sources.iter().find(|(id,_)|id==source_id).ok_or_else(||anyhow!("publication source handle is not available in this Owner scope"))?.1.clone();
                    let cap=engine::capability(owner,text(body,"capability_id")?)?;
                    if !matches!(source,Source::Publication{..}) {ensure!(engine::owns_origin(owner,&cap)?,"publication capability origin differs from the owned source space");}
                    let bytes=body["bytes"].as_str().filter(|v|!v.is_empty()&&v.len()<=65536).ok_or_else(||anyhow!("publication view exceeds its bound"))?;
                    let start=body["range"]["start"].as_u64().ok_or_else(||anyhow!("publication range missing"))? as usize;
                    let end=body["range"]["end"].as_u64().ok_or_else(||anyhow!("publication range missing"))? as usize;
                    fields(&body["range"],&["start","end"])?;ensure!(start<end&&end<=8*1024*1024&&end-start==bytes.len(),"publication range differs from its view");
                    let id=format!("mp-{}",canonical_digest(&json!(["ghost-memory-publication/1",owner,conversation,envelope.command_id]))?);
                    let entry=Intent{id:id.clone(),owner:owner.into(),conversation:conversation.into(),capability_id:cap.id.clone(),capability:cap,source,source_ref:source_id.into(),bytes:bytes.into(),start,end,created_ms:now_ms(),dispatch_epoch:envelope.authority_epoch,revision:1,generation:0,operation:"publish".into(),state:"prepared".into(),attempts:0,next_attempt_ms:0,authorization:None,request:None,receipt:None};
                    ensure!(load::<Intent>(conn,INTENTS,&id)?.is_none(),"publication occurrence already exists");put(conn,INTENTS,&id,&entry)?;Ok(Some(success(public_intent(&entry))))
                },
                "memory.publication.profile.configure"=>{
                    fields(body,&["method","ghost_id","conversation_id","references"])?;
                    let prior=load::<Profile>(conn,PROFILES,owner)?;ensure!(envelope.expected_revision==prior.as_ref().map(|p|p.revision),"publication profile revision conflict");
                    let selections=body["references"].as_array().filter(|v|v.len()<=MAX_REFS).ok_or_else(||anyhow!("publication reference selection exceeds its bound"))?;
                    let mut refs=vec![];let mut ids=std::collections::BTreeSet::new();
                    for selection in selections {
                        fields(selection,&["publication_ref","binding_id"])?;
                        let id=text(selection,"publication_ref")?;ensure!(ids.insert(id),"duplicate publication reference");
                        let entry:Intent=load(conn,INTENTS,id)?.ok_or_else(||anyhow!("publication receipt missing"))?;
                        ensure!(entry.state=="confirmed"&&entry.operation=="publish","publication has no confirmed receipt");
                        let receipt=entry.receipt.ok_or_else(||anyhow!("publication receipt missing"))?;
                        let auth=entry.authorization.ok_or_else(||anyhow!("publication destination pin missing"))?;
                        let binding=text(selection,"binding_id")?;
                        let profile=Brain::work_profile(owner,&[binding.into()])?;
                        ensure!(profile.bindings.iter().any(|b|b.id==binding&&b.spaces.contains(&auth.capability.destination_space)),"recipient has no independent destination Read binding");
                        refs.push(Reference{reference:id.into(),publication_id:text(&receipt,"publication_id")?.into(),view_revision:text(&receipt,"view_revision")?.into(),space:auth.capability.destination_space,binding_id:binding.into(),profile});
                    }
                    let p=Profile{revision:prior.map_or(1,|p|p.revision+1),references:refs};put(conn,PROFILES,owner,&p)?;
                    Ok(Some(success(json!({"revision":p.revision,"references":p.references.iter().map(|r|json!({"reference":r.reference,"citation":format!("publication://{}",r.publication_id)})).collect::<Vec<_>>()}))))
                },
                "memory.publication.commit"|"memory.publication.inspect"|"memory.publication.withdraw"|"memory.publication.resume"=>{
                    fields(body,&["method","ghost_id","conversation_id","publication_ref"])?;
                    let id=text(body,"publication_ref")?;let mut entry:Intent=load(conn,INTENTS,id)?.ok_or_else(||anyhow!("publication intent missing"))?;
                    ensure!(entry.owner==owner&&entry.conversation==conversation,"publication intent belongs to another Owner scope");
                    if method=="memory.publication.inspect" {return Ok(Some(success(public_intent(&entry))));}
                    ensure!(envelope.expected_revision==Some(entry.revision),"publication intent revision conflict");
                    if method=="memory.publication.withdraw" {
                        ensure!(entry.state=="confirmed"&&entry.operation=="publish","publication is not confirmed");
                        let receipt=entry.receipt.as_ref().ok_or_else(||anyhow!("publication receipt missing"))?;
                        let auth=entry.authorization.as_ref().ok_or_else(||anyhow!("publication authorization missing"))?;
                        let id=format!("mw-{}",canonical_digest(&json!([owner,envelope.command_id]))?);
                        entry.request=Some(json!({"version":"source-view-publication/1","destination":auth.destination_space_id,"publication_id":receipt["publication_id"],"occurrence_id":id}));
                        entry.id=id;entry.operation="withdraw".into();entry.receipt=None;entry.attempts=0;
                    } else if method=="memory.publication.commit" {ensure!(entry.state=="prepared","publication is already dispatched; inspect original occurrence");}
                    else {ensure!(["blocked","pending","unknown"].contains(&entry.state.as_str()),"publication does not need reconciliation");}
                    entry.dispatch_epoch=envelope.authority_epoch;entry.revision+=1;entry.generation+=1;entry.state="pending".into();entry.next_attempt_ms=now_ms();
                    put(conn,INTENTS,&entry.id,&entry)?;Ok(Some(success(public_intent(&entry))))
                },
                _=>bail!("unsupported Owner publication operation"),
            }
        })?;Ok(json!({"ok":true,"result":response}))
    }

    fn publication_intent_current(&self,entry:&Intent)->Result<()> {
        let state=self.lock()?;let authority=lifetime::authority::current(&state.journal.0)?;
        ensure!(authority.epoch==self.authority_epoch&&authority.epoch==entry.dispatch_epoch&&authority.dispatch_enabled,"publication Host is fenced");
        let policy:Policy=load(&state.journal.0,"policy",&entry.owner)?.unwrap_or_default();ensure!(policy.memory,"publication permission revoked");
        let current:Intent=load(&state.journal.0,INTENTS,&entry.id)?.ok_or_else(||anyhow!("publication intent missing"))?;
        ensure!(engine::capability(&entry.owner,&entry.capability_id)?==entry.capability,"publication capability changed since Owner approval");
        ensure!(current.generation==entry.generation&&current.state==entry.state,"publication continuation was superseded");Ok(())
    }
    pub(crate) async fn advance_memory_publications_bounded(&self,timeout:Duration)->Result<bool> {
        let entry={let state=self.lock()?;let raw:Option<String>=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.state') IN ('pending','unknown') AND json_extract(payload,'$.next_attempt_ms')<=?2 ORDER BY id LIMIT 1",params![INTENTS,now_ms()],|r|r.get(0)).optional()?;raw.map(|r|serde_json::from_str::<Intent>(&r)).transpose()?};
        let Some(mut entry)=entry else{return Ok(true);};
        if entry.attempts>=8||self.publication_intent_current(&entry).is_err() {entry.state="blocked".into();let state=self.lock()?;save_intent(&state.journal.0,&entry)?;return Ok(false);}
        entry.attempts+=1;entry.next_attempt_ms=now_ms().saturating_add(1000u64<<entry.attempts.min(8));
        {let state=self.lock()?;if !save_intent(&state.journal.0,&entry)? {return Ok(false);}}
        let attempt=async {
            let check=||self.publication_intent_current(&entry);
            let auth=match &entry.authorization {Some(pin)=>{if entry.operation=="withdraw" {engine::destination_current(&entry.owner,pin)?;} else {engine::configuration_current(&entry.owner,pin)?;}pin.clone()},None=>engine::authorize(&entry.owner,&entry.capability_id,&check).await?};
            let request=match &entry.request {Some(request)=>request.clone(),None=>{
                let origin=match &entry.source {
                    Source::Episode{episode_id,source_sha256}=>engine::episode_origin(&entry.owner,&auth,episode_id,source_sha256,&check).await?,
                    Source::Publication{publication_id,revision}=>json!({"kind":"publication","space":auth.origin_space_id,"publication_id":publication_id,"revision":revision}),
                    Source::Document{document_uuid,raw_sha256,path}=>engine::document_origin(&entry.owner,&auth,document_uuid,raw_sha256,path,&check).await?,
                };
                json!({"version":"source-view-publication/1","request":{"occurrence_id":entry.id,"origin":origin,"range":{"start":entry.start,"end":entry.end},"bytes":entry.bytes,"digest":blake3::hash(entry.bytes.as_bytes()).to_hex().as_str(),"destination":auth.destination_space_id,"policy_revision":format!("{}:{}",auth.capability.id,auth.capability.policy_revision),"occurred_at":entry.created_ms}})
            }};
            // Freeze actual engine request and non-secret grant pin before I/O.
            {let state=self.lock()?;let mut frozen=entry.clone();frozen.authorization=Some(auth.clone());frozen.request=Some(request.clone());ensure!(save_intent(&state.journal.0,&frozen)?,"publication continuation superseded");}
            let output=engine::execute(&entry.owner,&auth,&entry.operation,request,&check).await?;
            if entry.operation=="publish" {ensure!(output["version"]=="source-view-publication/1"&&output["citation"]==format!("publication://{}",text(&output,"publication_id")?)&&output["view_revision"]==blake3::hash(entry.bytes.as_bytes()).to_hex().as_str()&&output.as_object().is_some_and(|o|o.len()==4),"publication receipt does not match the exact view");}
            check()?;Ok::<_,anyhow::Error>(output)
        };
        let result=tokio::time::timeout(timeout,attempt).await;
        let state=self.lock()?;let Some(mut actual)=load::<Intent>(&state.journal.0,INTENTS,&entry.id)? else{return Ok(false);};
        if actual.generation!=entry.generation {return Ok(false);}
        match result {Ok(Ok(receipt))=>{actual.receipt=Some(receipt);actual.state="confirmed".into();},_=>actual.state="unknown".into()};
        save_intent(&state.journal.0,&actual)?;Ok(actual.state=="confirmed")
    }
}

fn scope_locked(state:&State,request:&PiToolRequest)->Result<(String,Vec<Reference>)> {
    let conn=&state.journal.0;let body=&request.envelope.body;
    if let Some(id)=body.get("work_id").or_else(||body.get("parent_work_id")).and_then(Value::as_str) {
        let actual=work(conn,id)?;ensure!(actual.owner==request.ghost_id,"publication Work owner differs");
        let goal:Value=serde_json::from_str(&conn.query_row("SELECT payload FROM lifetime_goals WHERE id=?1",[&actual.goal_id],|r|r.get::<_,String>(0))?)?;
        ensure!(goal["accountable_ghost"]==request.ghost_id&&goal["reply_conversation"]==request.conversation_id,"publication Work conversation differs");
        if let Some(assignment)=body["assignment_id"].as_str() {
            // Read the committed binding, not the dispatch projection: revoked
            // dependencies can change privacy and invalidate that projection.
            // Their durable blocker must still guard effects and receipt replay.
            let raw:String=conn.query_row("SELECT payload FROM lifetime_outbox WHERE delivery_ref=?1 AND target='pi'",[assignment],|row|row.get(0))?;
            let delivery:Envelope=serde_json::from_str(&raw)?;delivery.validate()?;
            ensure!(delivery.command_id==assignment&&delivery.body["method"]=="conversation.assignment"&&delivery.body["work_id"]==id&&delivery.body["ghost_id"]==request.ghost_id&&delivery.body["conversation_id"]==request.conversation_id,"publication assignment binding differs");
        }
        let key=work_key(&actual);let refs=load::<Profile>(conn,PINS,&key)?.map(|p|p.references).unwrap_or_default();
        return Ok((key,refs));
    }
    let turn=text(body,"turn_id")?;
    let valid:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE turn_id=?1 AND ghost_id=?2 AND conversation_id=?3 AND cancel_requested=0)",params![turn,request.ghost_id,request.conversation_id],|r|r.get(0))?;
    ensure!(valid,"publication Owner turn is not authoritative");
    let refs=load::<Profile>(conn,PROFILES,&request.ghost_id)?.map(|p|p.references).unwrap_or_default();
    Ok((format!("turn:{}:{}:{turn}",request.ghost_id,request.conversation_id),refs))
}
fn current_locked(state:&State,request:&PiToolRequest,route:PiInferenceScope)->Result<(String,Dependencies)> {
    let (key,refs)=scope_locked(state,request)?;
    let deps=load::<Dependencies>(&state.journal.0,DEPENDENCIES,&key)?.unwrap_or_default();
    ensure!(!deps.blocked,"publication dependency mapping is blocked");
    if deps.references.is_empty() {return Ok((key,deps));}
    let policy:Policy=load(&state.journal.0,"policy",&request.ghost_id)?.unwrap_or_default();
    ensure!(route==PiInferenceScope::Local&&policy.memory&&!deps.blocked&&deps.references.len()<=MAX_REFS,"publication context is unavailable");
    for dep in &deps.references {
        ensure!(refs.contains(dep)&&Brain::work_profile(&request.ghost_id,&[dep.binding_id.clone()])?==dep.profile,"publication recipient authority changed");
    }
    Ok((key,deps))
}
pub(crate) fn child_dependencies(conn:&Connection,parent:&Work,child:&Work)->Result<()> {
    let parent_refs=load::<Profile>(conn,PINS,&work_key(parent))?.map(|p|p.references).unwrap_or_default();
    let mut child_profile=load::<Profile>(conn,PINS,&work_key(child))?.unwrap_or(Profile{revision:0,references:vec![]});
    child_profile.references.retain(|r|parent_refs.iter().any(|p|p.publication_id==r.publication_id&&p.view_revision==r.view_revision&&p.space==r.space));
    put(conn,PINS,&work_key(child),&child_profile)?;
    let Some(deps)=load::<Dependencies>(conn,DEPENDENCIES,&work_key(parent))? else{return Ok(());};
    if deps.references.is_empty()&&!deps.blocked {return Ok(());}
    ensure!(!deps.blocked,"publication parent context is blocked");
    let target=load::<Profile>(conn,PINS,&work_key(child))?.ok_or_else(||anyhow!("child publication profile is missing"))?;
    let mut inherited=vec![];
    for dep in deps.references {
        let own=target.references.iter().find(|r|r.publication_id==dep.publication_id&&r.view_revision==dep.view_revision&&r.space==dep.space).ok_or_else(||anyhow!("child has no independent published-view Read grant"))?;
        inherited.push(own.clone());
    }
    put(conn,DEPENDENCIES,&work_key(child),&Dependencies{references:inherited,blocked:false})
}
pub(crate) fn absorb_child_dependencies(conn:&Connection,child:&Work,parent:&Work)->Result<()> {
    let Some(child)=load::<Dependencies>(conn,DEPENDENCIES,&work_key(child))? else{return Ok(());};
    if child.references.is_empty()&&!child.blocked{return Ok(());}
    let permitted=load::<Profile>(conn,PINS,&work_key(parent))?.map(|p|p.references).unwrap_or_default();
    let mut deps=load::<Dependencies>(conn,DEPENDENCIES,&work_key(parent))?.unwrap_or_default();
    deps.blocked|=child.blocked;
    for reference in child.references {
        let Some(actual)=permitted.iter().find(|p|p.publication_id==reference.publication_id&&p.view_revision==reference.view_revision&&p.space==reference.space) else{deps.blocked=true;continue;};
        if !deps.references.contains(actual) {deps.references.push(actual.clone());}
    }
    ensure!(deps.references.len()<=MAX_REFS,"publication dependency bound exceeded");
    deps.references.sort_by(|a,b|a.reference.cmp(&b.reference));put(conn,DEPENDENCIES,&work_key(parent),&deps)
}
pub(crate) fn validate_delegation_target(conn:&Connection,parent:&Work,target:&str)->Result<()> {
    let Some(deps)=load::<Dependencies>(conn,DEPENDENCIES,&work_key(parent))? else{return Ok(());};
    if deps.references.is_empty()&&!deps.blocked{return Ok(());}
    ensure!(!deps.blocked,"publication parent context is blocked");
    let target=load::<Profile>(conn,PROFILES,target)?.ok_or_else(||anyhow!("target has no independent publication grant"))?;
    for dep in deps.references {ensure!(target.references.iter().any(|r|r.publication_id==dep.publication_id&&r.view_revision==dep.view_revision&&r.space==dep.space),"target publication audience is not independently granted");}
    Ok(())
}

fn work_context_revision(conn:&Connection,expected:&Work)->Result<String> {
    let mut current=work(conn,&expected.id)?;let mut lineage=vec![];let mut visited=std::collections::BTreeSet::new();
    loop {
        ensure!(visited.insert(current.id.clone())&&visited.len()<=16,"publication Work ancestry exceeds its bound");
        let deps=load::<Dependencies>(conn,DEPENDENCIES,&work_key(&current))?.unwrap_or_default();
        lineage.push(json!([work_key(&current),current.execution_id,deps]));
        let parent:Option<String>=conn.query_row("SELECT parent_work_id FROM lifetime_work_links WHERE child_work_id=?1 AND current=1",[&current.id],|row|row.get(0)).optional()?;
        match parent {Some(id)=>current=work(conn,&id)?,None=>return canonical_digest(&Value::Array(lineage))}
    }
}

fn work_references(conn:&Connection,expected:&Work)->Result<Vec<(String,Reference)>> {
    let mut current=work(conn,&expected.id)?;let mut refs=vec![];let mut visited=std::collections::BTreeSet::new();
    loop {
        ensure!(visited.insert(current.id.clone())&&visited.len()<=16,"publication Work ancestry exceeds its bound");
        let deps=load::<Dependencies>(conn,DEPENDENCIES,&work_key(&current))?.unwrap_or_default();
        refs.extend(deps.references.into_iter().map(|reference|(current.owner.clone(),reference)));
        let parent:Option<String>=conn.query_row("SELECT parent_work_id FROM lifetime_work_links WHERE child_work_id=?1 AND current=1",[&current.id],|row|row.get(0)).optional()?;
        match parent {Some(id)=>current=work(conn,&id)?,None=>return Ok(refs)}
    }
}

impl Host {
    /// Verifiers consume generated bytes just as an inference does. Resolve
    /// provenance from the actual Work/ancestry, without caller-supplied stamps.
    pub(crate) fn publication_work_current(&self,state:&State,expected:&Work)->Result<()> {
        self.publication_work_conn(&state.journal.0,expected)
    }
    pub(crate) fn publication_work_revision(&self,conn:&Connection,expected:&Work)->Result<String> {
        self.publication_work_conn(conn,expected)?;
        work_context_revision(conn,expected)
    }
    pub(crate) fn publication_work_conn(&self,conn:&Connection,expected:&Work)->Result<()> {
        let actual=work(conn,&expected.id)?;
        ensure!(work_key(&actual)==work_key(expected)&&actual.execution_id==expected.execution_id,"publication verification Work changed");
        let authority=lifetime::authority::current(conn)?;
        ensure!(authority.epoch==self.authority_epoch&&authority.dispatch_enabled&&!self.stopping.load(std::sync::atomic::Ordering::Acquire),"publication Host authority fenced");
        let mut current=actual;let mut visited=std::collections::BTreeSet::new();
        loop {
            ensure!(visited.insert(current.id.clone())&&visited.len()<=16,"publication Work ancestry exceeds its bound");
            let deps=load::<Dependencies>(conn,DEPENDENCIES,&work_key(&current))?.unwrap_or_default();
            ensure!(!deps.blocked,"publication Work context is blocked");
            if !deps.references.is_empty() {
                ensure!(current.cancellation=="none"&&lifetime::work_scope_current(conn,&current.id)?,"publication Work scope changed");
                let policy:Policy=load(conn,"policy",&current.owner)?.unwrap_or_default();
                ensure!(self.pi_local_route.is_some()&&policy.memory&&deps.references.len()<=MAX_REFS,"publication verification requires the accepted local route");
                let refs=load::<Profile>(conn,PINS,&work_key(&current))?.ok_or_else(||anyhow!("publication Work grant missing"))?;
                for dep in deps.references {ensure!(refs.references.contains(&dep)&&Brain::work_profile(&current.owner,&[dep.binding_id.clone()])?==dep.profile,"publication verification authority changed");}
            }
            let parent:Option<String>=conn.query_row("SELECT parent_work_id FROM lifetime_work_links WHERE child_work_id=?1 AND current=1",[&current.id],|row|row.get(0)).optional()?;
            match parent {Some(id)=>current=work(conn,&id)?,None=>return Ok(())}
        }
    }
    pub(crate) async fn publication_work_guard(&self,expected:&Work)->Result<String> {
        let (captured,captured_revision)={let state=self.lock()?;self.publication_work_current(&state,expected)?;(work_references(&state.journal.0,expected)?,work_context_revision(&state.journal.0,expected)?)};
        if captured.is_empty(){return Ok(captured_revision);}
        let check=||{let state=self.lock()?;self.publication_work_current(&state,expected)?;
            ensure!(work_context_revision(&state.journal.0,expected)?==captured_revision,"publication verification dependency set changed");Ok(())};
        let validate=async {
            let mut bytes=0usize;
            for (owner,reference) in captured {
                let view=engine::read(&owner,&reference.binding_id,&reference.space,&reference.publication_id,&check).await?;
                ensure!(view["state"]=="current"&&view["view_revision"]==reference.view_revision,"publication verification source is closed or superseded");
                bytes=bytes.saturating_add(view["bytes"].as_str().map_or(0,str::len));ensure!(bytes<=262144,"publication verification read budget exhausted");
            } check()?;Ok::<_,anyhow::Error>(())
        };
        if !matches!(tokio::time::timeout(Duration::from_secs(15),validate).await,Ok(Ok(()))) {
            // Concurrent dependency growth denies this verification attempt.
            // Keep exact lineage so a later bounded attempt can validate it.
            bail!("publication verification source authority or dependency set cannot be revalidated");
        }
        Ok(captured_revision)
    }

    fn publication_scope(&self,request:&PiToolRequest,route:PiInferenceScope)->Result<(String,Vec<Reference>)> {
        let state=self.lock()?;
        ensure!(self.check_pi_host_scope(&state,request,route)?.is_none()&&lifetime::pi_tool_guard(&state.journal.0,request,route)?.is_none(),"publication Host scope is fenced");
        ensure!(route==PiInferenceScope::Local,"publication source context requires the accepted local route");
        let policy:Policy=load(&state.journal.0,"policy",&request.ghost_id)?.unwrap_or_default();ensure!(policy.memory,"publication memory permission revoked");
        scope_locked(&state,request)
    }
    async fn validate_publication_dependencies(&self,request:&PiToolRequest,route:PiInferenceScope)->Result<(String,Dependencies)> {
        let captured={let state=self.lock()?;match current_locked(&state,request,route) {Ok(value)=>value,Err(error)=>{
            if let Ok((key,_))=scope_locked(&state,request) {if let Some(mut deps)=load::<Dependencies>(&state.journal.0,DEPENDENCIES,&key)? {deps.blocked=true;put(&state.journal.0,DEPENDENCIES,&key,&deps)?;}}
            return Err(error);
        }}};
        let check=||{self.publication_scope(request,route)?;let state=self.lock()?;current_locked(&state,request,route)?;Ok(())};
        let validate=async {
            let mut bytes=0usize;
            for dep in &captured.1.references {
                let view=engine::read(&request.ghost_id,&dep.binding_id,&dep.space,&dep.publication_id,&check).await?;
                ensure!(view["state"]=="current"&&view["view_revision"]==dep.view_revision,"publication view is no longer current");
                bytes=bytes.saturating_add(view["bytes"].as_str().map_or(0,str::len));ensure!(bytes<=262144,"publication dependency read budget exhausted");
            }
            check()?;Ok::<_,anyhow::Error>(())
        };
        if !matches!(tokio::time::timeout(Duration::from_secs(15),validate).await,Ok(Ok(()))) {
            let state=self.lock()?;
            if let Some(mut deps)=load::<Dependencies>(&state.journal.0,DEPENDENCIES,&captured.0)? {deps.blocked=true;put(&state.journal.0,DEPENDENCIES,&captured.0,&deps)?;}
            bail!("published source dependency cannot be verified");
        }
        let state=self.lock()?;current_locked(&state,request,route)
    }

    pub(crate) async fn memory_publication_pi(&self,request:&PiToolRequest,route:PiInferenceScope)->Result<Response> {
        request.envelope.validate()?;
        let method=text(&request.envelope.body,"method")?;
        fields(&request.envelope.body,&["method","ghost_id","conversation_id","turn_id","assignment_id","work_id","reference"])?;
        ensure!(matches!(method,"memory.publication.read"|"memory.publication.context.inspect"|"memory.publication.capabilities"),"unsupported publication callback");
        let (key,refs)=self.publication_scope(request,route)?;
        if method=="memory.publication.capabilities" {return Ok(success(json!({"version":"ghost-memory-publication/1","references":refs.iter().map(|r|json!({"reference":r.reference,"citation":format!("publication://{}",r.publication_id),"view_revision":r.view_revision})).collect::<Vec<_>>()})));}
        if method=="memory.publication.read" {
            let reference=text(&request.envelope.body,"reference")?;
            let selected=refs.iter().find(|r|r.reference==reference).ok_or_else(||anyhow!("publication reference is not granted in this exact scope"))?.clone();
            // Exact read only in a live turn; terminal context inspection is
            // still allowed for guarded reply receipt reconciliation.
            if let Some(turn)=request.envelope.body["turn_id"].as_str() {let state=self.lock()?;let live:bool=state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE turn_id=?1 AND state IN ('queued','running'))",[turn],|r|r.get(0))?;ensure!(live,"publication turn no longer admits new context");}
            let check=||{self.publication_scope(request,route)?;ensure!(Brain::work_profile(&request.ghost_id,&[selected.binding_id.clone()])?==selected.profile,"publication binding changed");Ok(())};
            let view=tokio::time::timeout(Duration::from_secs(15),engine::read(&request.ghost_id,&selected.binding_id,&selected.space,&selected.publication_id,&check)).await.map_err(|_|anyhow!("publication read deadline exceeded"))??;
            ensure!(view["state"]=="current"&&view["view_revision"]==selected.view_revision,"publication view is closed or superseded");
            {let state=self.lock()?;let (_,current_refs)=scope_locked(&state,request)?;ensure!(current_refs.contains(&selected),"publication grant changed before delivery");
                let mut deps=load::<Dependencies>(&state.journal.0,DEPENDENCIES,&key)?.unwrap_or_default();ensure!(!deps.blocked,"publication context is blocked");
                if !deps.references.contains(&selected) {ensure!(deps.references.len()<MAX_REFS,"publication dependency limit exceeded");deps.references.push(selected.clone());deps.references.sort_by(|a,b|a.reference.cmp(&b.reference));}
                put(&state.journal.0,DEPENDENCIES,&key,&deps)?;
            }
            self.validate_publication_dependencies(request,route).await?;
            return Ok(success(json!({"view":view,"dependency":{"reference":selected.reference,"view_revision":selected.view_revision}})));
        }
        let (_,deps)=self.validate_publication_dependencies(request,route).await?;
        let public=deps.references.iter().map(|r|json!({"reference":r.reference,"view_revision":r.view_revision})).collect::<Vec<_>>();
        let stamp=canonical_digest(&json!({"scope":key,"dependencies":public,"epoch":self.authority_epoch}))?;
        Ok(success(json!({"context_revision":stamp,"memory_permitted":true,"dependencies":public})))
    }

    /// Stored lineage, not a caller claim, gates every output and replay.
    pub(crate) async fn publication_effect_guard(&self,request:&PiToolRequest,route:PiInferenceScope)->Result<Option<Response>> {
        let method=request.envelope.body["method"].as_str().unwrap_or("");
        if matches!(method,"memory.publication.read"|"memory.publication.context.inspect"|"memory.publication.capabilities"|"conversation.cancel_turn"|"work.cancel") {return Ok(None);}
        let captured={let state=self.lock()?;match scope_locked(&state,request) {Ok((key,_))=>load::<Dependencies>(&state.journal.0,DEPENDENCIES,&key)?,Err(_)=>None}};
        if !captured.as_ref().is_some_and(|deps|deps.blocked||!deps.references.is_empty()) {return Ok(None);}
        if matches!(method,"memory.retain"|"memory.session_record"|"goal.create"|"mailbox.send"|"bot.prepare"|"bot.repair") || method.starts_with("documents.") {return Ok(Some(denied()));}
        match self.validate_publication_dependencies(request,route).await {Ok(_)=>Ok(None),Err(_)=>Ok(Some(denied()))}
    }
    pub(crate) fn publication_effect_current(&self,state:&State,request:&PiToolRequest,route:PiInferenceScope)->Result<Option<Response>> {
        let stored=match scope_locked(state,request) {Ok((key,_))=>load::<Dependencies>(&state.journal.0,DEPENDENCIES,&key)?,Err(_)=>None};
        if !stored.is_some_and(|d|d.blocked||!d.references.is_empty()) {return Ok(None);}
        Ok(current_locked(state,request,route).err().map(|_|denied()))
    }
}

#[cfg(test)]
#[path="memory_publication_tests.rs"]
mod tests;
