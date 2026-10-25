//! A producer-only snapshot of the exact contract behind a causally prior
//! accepted Work. This reference is scoped to one authenticated creation turn;
//! it never selects a current template pointer or conveys verifier authority.
use super::*;
use crate::host::lifetime::task_contracts::{self, TemplateRef};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProducerContract {
    pub instructions: String,
    pub privacy: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub input_contract: Value,
    pub output_contract: Value,
    pub required_capabilities: Vec<String>,
    pub artifact_path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Pin {
    pub kind: String,
    pub reference: String,
    pub owner_turn_id: String,
    pub owner_request_digest: String,
    pub authority_epoch: u64,
    pub ghost_id: String,
    pub conversation_id: String,
    pub source: SourceAcceptance,
    pub template_ref: TemplateRef,
    pub producer: ProducerContract,
}
impl Pin {
    fn expected_ref(&self) -> Result<String> {
        let mut value=serde_json::to_value(self)?;
        value.as_object_mut().unwrap().remove("reference");
        Ok(format!("bsc-{}",canonical_digest(&value)?))
    }
    pub(crate) fn instructions(&self) -> Result<String> {
        // Schema and destination are contract data, never executable verifier
        // code. Keep the source procedure intact rather than asking a model
        // to paraphrase or reconstruct it from one completed instance.
        let text=format!("{}\n\nPinned reusable task contract:\nInput JSON schema: {}\nOutput JSON schema: {}\nRelative output artifact path: {}\nPreserve these schemas, contracts and the source procedure for each new input. Instance inputs and expected outputs are not part of this reusable contract.",self.producer.instructions,serde_json::to_string(&self.producer.input_schema)?,serde_json::to_string(&self.producer.output_schema)?,self.producer.artifact_path);
        ensure!(text.len()<=32768,"source contract instructions exceed candidate bound");
        Ok(text)
    }
    pub(crate) fn with_notes(&self, notes:&str) -> Result<String> {
        ensure!(!notes.is_empty() && notes.len()<=32768,"repair notes exceed bound");
        let value=format!("{}\n\nImplementation notes (subordinate to the pinned contract):\n{}",self.instructions()?,notes);
        ensure!(value.len()<=32768,"source contract and repair notes exceed candidate bound");
        Ok(value)
    }
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(self.kind=="ghost-bot-source-contract/1" && self.reference==self.expected_ref()?,"source contract pin digest changed");
        ensure!(!self.owner_turn_id.is_empty() && self.owner_turn_id.len()<=256
            && self.authority_epoch>0 && self.owner_request_digest.len()==64
            && self.source.work.state=="accepted" && self.source.work.cancellation=="none"
            && self.source.work.owner==self.ghost_id
            && self.source.work.id==self.source.acceptance.work_id
            && self.source.work.goal_revision==self.source.acceptance.goal_revision
            && self.template_ref.revision>0 && self.template_ref.digest.len()==64,
            "source contract provenance is malformed");
        ensure!(self.producer.input_contract.is_object() && self.producer.output_contract.is_object()
            && matches!(self.producer.privacy.as_str(),"public"|"private"|"local_only")
            && !self.producer.instructions.is_empty() && !self.producer.artifact_path.is_empty(),"source producer contract is invalid");
        self.instructions()?;
        Ok(())
    }
    pub(crate) fn validate_candidate(&self,c:&Candidate) -> Result<()> {
        self.validate()?;
        if let Some(turn)=&c.intent_turn_id {
            ensure!(turn==&self.owner_turn_id && c.issuer_ghost.as_deref()==Some(self.ghost_id.as_str())
                && c.source_work_ids==vec![self.source.work.id.clone()] && c.source_acceptances==vec![self.source.clone()],
                "candidate source snapshot differs from original creation intent or acceptance");
        } else if !c.source_acceptances.is_empty() {
            ensure!(c.source_acceptances==vec![self.source.clone()],"lifecycle candidate changed source acceptance provenance");
        }
        let baseline=self.instructions()?;
        let instructions=&c.assets.first().ok_or_else(||anyhow!("source instruction asset missing"))?.content;
        ensure!(instructions==&baseline || instructions.starts_with(&(baseline+"\n\nImplementation notes (subordinate to the pinned contract):\n")),"candidate dropped its pinned source procedure");
        ensure!(c.definition.content.input_contract==self.producer.input_contract
            && c.definition.content.output_contract==self.producer.output_contract
            && c.definition.content.required_capabilities==self.producer.required_capabilities,
            "candidate differs from pinned source contracts or capabilities");
        let mut privacy=c.privacy.clone();raise_privacy(&mut privacy,&self.producer.privacy)?;
        ensure!(privacy==c.privacy,"candidate lowered source contract privacy");
        Ok(())
    }
    fn descriptor(&self)->Result<Value> {
        Ok(json!({"source_contract_ref":self.reference,"source_work_id":self.source.work.id,
            "template_ref":self.template_ref,"instructions_digest":format!("{:x}",Sha256::digest(self.producer.instructions.as_bytes())),
            "input_schema_digest":canonical_digest(&self.producer.input_schema)?,
            "output_schema_digest":canonical_digest(&self.producer.output_schema)?,
            "input_contract":self.producer.input_contract,"output_contract":self.producer.output_contract,
            "required_capabilities":self.producer.required_capabilities,"artifact_path":self.producer.artifact_path}))
    }
}

pub(super) fn resolve(conn:&Connection,intent:&CreationIntent,work_id:&str)->Result<Option<Pin>> {
    ensure!(intent.mode=="create","source contract requires a create-from-task Owner intent");
    let source=source_acceptance(conn,work_id,&intent.turn_id)?;
    let own:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_goals WHERE id=?1 AND accountable_ghost=?2 AND reply_conversation=?3)",params![source.work.goal_id,intent.ghost_id,intent.conversation_id],|r|r.get(0))?;
    ensure!(own && source.work.owner==intent.ghost_id,"source contract is outside the actual Owner conversation");
    let Some((input,template))=task_contracts::work_source(conn,&source.work)? else{return Ok(None)};
    ensure!(input.ghost_id==intent.ghost_id && input.conversation_id==intent.conversation_id
        && input.authority_epoch==intent.authority_epoch && template.ghost_id==intent.ghost_id
        && template.conversation_id==intent.conversation_id,"source task contract authority changed");
    let content=template.content;
    let mut pin=Pin {kind:"ghost-bot-source-contract/1".into(),reference:String::new(),
        owner_turn_id:intent.turn_id.clone(),owner_request_digest:intent.source_request_digest.clone(),
        authority_epoch:intent.authority_epoch,ghost_id:intent.ghost_id.clone(),conversation_id:intent.conversation_id.clone(),source,
        template_ref:input.selection.template,
        producer:ProducerContract {instructions:content.instructions,privacy:content.privacy,
            input_schema:content.input_schema,output_schema:content.output_schema,input_contract:content.input_contract,
            output_contract:content.output_contract,required_capabilities:content.required_capabilities,artifact_path:content.artifact_path}};
    pin.reference=pin.expected_ref()?;pin.validate()?;Ok(Some(pin))
}

pub(super) fn offers(conn:&Connection,intent:&CreationIntent)->Result<Vec<Pin>> {
    if intent.mode!="create" {return Ok(vec![])}
    // Bound the offered history. Explicit source IDs are resolved independently
    // below; an omitted older offer never becomes authority through a guess.
    let mut q=conn.prepare("SELECT w.id FROM lifetime_work w JOIN lifetime_goals g ON g.id=w.goal_id WHERE w.owner=?1 AND g.accountable_ghost=?1 AND g.reply_conversation=?2 AND w.state='accepted' ORDER BY w.rowid DESC LIMIT 8")?;
    let ids=q.query_map(params![intent.ghost_id,intent.conversation_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut pins=vec![];
    for id in ids {
        // A Work accepted only after this request is not a source offer.
        let prior:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_commands WHERE json_extract(request,'$.body.method')='work.accept' AND json_extract(request,'$.body.acceptance.work_id')=?1 AND json_extract(response,'$.status')='success' AND rowid<(SELECT rowid FROM lifetime_commands WHERE command_id=?2))",params![id,intent.turn_id],|r|r.get(0))?;
        if prior {if let Some(pin)=resolve(conn,intent,&id)? {pins.push(pin)}}
    }
    Ok(pins)
}

/// Validate optional ref arguments before any candidate/intent mutation. The
/// legacy explicit path remains available for unconfigured/custom sources.
pub(super) fn normalize(conn:&Connection,intent:&CreationIntent,args:&Value)->Result<(Value,Option<Pin>)> {
    let mut normalized=args.clone();
    let reference=args.get("source_contract_ref").map(|v|v.as_str().ok_or_else(||anyhow!("source contract ref must be text"))).transpose()?;
    if let Some(reference)=reference {
        // The opaque ref already binds the exact source Work. A scalar model
        // call need not copy a redundant Work-ID array; never parse/coerce a
        // model string into that legacy array shape.
        let pin=if let Some(value)=args.get("source_work_ids") {
            // Preserve exact historical ref+array resolution even when the
            // source has aged beyond the bounded fresh-model offer inventory.
            let legacy_sources:Vec<String>=serde_json::from_value(value.clone())?;
            ensure!(legacy_sources.len()==1,"source contract ref conflicts with legacy source Work IDs");
            let pin=resolve(conn,intent,&legacy_sources[0])?.ok_or_else(||anyhow!("source Work has no pinned task contract"))?;
            ensure!(pin.reference==reference,"source contract ref conflicts with legacy source Work IDs");pin
        }else{
            let mut pins=offers(conn,intent)?.into_iter().filter(|pin|pin.reference==reference).collect::<Vec<_>>();
            ensure!(pins.len()==1,"source contract ref has no unique current scoped offer for this Owner intent");pins.pop().unwrap()
        };
        normalized["source_work_ids"]=json!([pin.source.work.id]);
        for (name,value) in [("instructions",json!(pin.instructions()?)),("input_contract",pin.producer.input_contract.clone()),("output_contract",pin.producer.output_contract.clone()),("required_capabilities",json!(pin.producer.required_capabilities))] {
            ensure!(args.get(name).is_none_or(|supplied|supplied==&value),"explicit {name} conflicts with pinned source contract");
            normalized[name]=value;
        }
        normalized.as_object_mut().ok_or_else(||anyhow!("bot arguments must be object"))?.remove("source_contract_ref");
        return Ok((normalized,Some(pin)));
    }
    let sources:Vec<String>=serde_json::from_value(args["source_work_ids"].clone())?;
    let pins=if intent.mode=="create" {sources.iter().map(|id|resolve(conn,intent,id)).collect::<Result<Vec<_>>>()?.into_iter().flatten().collect::<Vec<_>>()}else{vec![]};
    ensure!(pins.is_empty(),"Known accepted task contract requires its Host-issued source_contract_ref; use explicit Owner requirements for a custom contract");
    Ok((normalized,None))
}

pub(super) fn descriptor(conn:&Connection,intent:&CreationIntent)->Result<Value> {
    let descriptors=offers(conn,intent)?.iter().map(Pin::descriptor).collect::<Result<Vec<_>>>()?;
    let result=json!({"kind":"ghost-bot-creation-descriptor/1","mode":intent.mode,"state":"available",
        "turn_id":intent.turn_id,"ghost_id":intent.ghost_id,"conversation_id":intent.conversation_id,
        "source_contracts":descriptors});
    ensure!(serde_json::to_vec(&result)?.len()<=32768,"creation descriptor exceeds bound");Ok(result)
}
