use super::{lifetime, Host};
use crate::lifetime_contract::{Envelope, Response, ResponseStatus, RetryClass};
use anyhow::{bail, Result};
use serde_json::{json, Value};

impl Host {
    /// Only the authenticated owner control surface calls this façade. Worker and
    /// Pi callbacks receive their own scoped transport rather than impersonating owner.
    pub(crate) fn lifetime_action(&self, envelope: &Envelope) -> Result<Value> {
        if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
            bail!("Ghost host is stopping");
        }
        if envelope.body["method"].as_str().is_some_and(|method|method.starts_with("memory.publication.")) {
            return self.memory_publication_owner(envelope);
        }
        if matches!(envelope.body["method"].as_str(),Some("bot.provision"|"bot.activate")) {
            return self.provision_bot(envelope);
        }
        let result = (|| -> Result<Response> {
            envelope.validate()?;
            let state = self.lock()?;
            if envelope.actor_ref != "owner" {
                return Ok(Response {
                    status: ResponseStatus::Error, summary: "authenticated owner does not match envelope actor".into(),
                    object_refs: vec![], artifacts: vec![], next_actions: vec![],
                    error_code: Some("unauthorized".into()), retry_class: RetryClass::Never, data: Value::Null,
                });
            }
            let method = envelope.body.get("method").and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing lifetime method"))?;
            let authority = lifetime::authority::current(&state.journal.0)?;
            if authority.epoch != self.authority_epoch && !matches!(method, "snapshot" | "command.inspect" | "work.artifact") {
                return Ok(Response {
                    status: ResponseStatus::Error, summary: "Host writer generation is fenced; reopen the current authority before writing".into(),
                    object_refs: vec![], artifacts: vec![], next_actions: vec![],
                    error_code: Some("authority_fenced".into()), retry_class: RetryClass::Never, data: Value::Null,
                });
            }
            if method=="work.memory.profile.configure" {
                let owner=envelope.body["ghost_id"].as_str().ok_or_else(||anyhow::anyhow!("Work memory owner missing"))?;
                if !state.profiles.contains_key(owner) {
                    let command=envelope.body["creation_command_id"].as_str().ok_or_else(||anyhow::anyhow!("future memory metadata requires its Owner creation command"))?;
                    anyhow::ensure!(super::bots_memory::planned_identity(command)?["ghost_id"]==owner,"future memory owner differs from planned creation");
                }
            }
            if matches!(method, "work.memory.bind" | "work.memory.revoke" | "work.experience.inspect" | "work.experience.resume") {
                let work_id=envelope.body["work_id"].as_str().ok_or_else(||anyhow::anyhow!("Work memory identity missing"))?;
                let owner:String=state.journal.0.query_row("SELECT json_extract(payload,'$.owner') FROM lifetime_work WHERE id=?1",[work_id],|row|row.get(0))?;
                anyhow::ensure!(state.profiles.contains_key(&owner),"Work memory owner profile missing");
                if method=="work.experience.resume" {anyhow::ensure!(self.pi_local_route.is_some(),"experience recovery requires an accepted local route");}
            }
            if matches!(method, "bot.definition.update" | "bot.definition.inspect") {
                let ghost_id = if method == "bot.definition.update" {
                    envelope.body.get("definition").and_then(|value| value.get("ghost_id"))
                } else { envelope.body.get("ghost_id") }.and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("missing bot Ghost identity"))?;
                if !state.profiles.contains_key(ghost_id) {
                    bail!("bot profile missing");
                }
            }
            if matches!(method, "goal.submit" | "registry.ensure" | "conversation.input" | "conversation.inspect" | "conversation.cancel_turn" | "conversation.turn.inspect") {
                let ghost_id = envelope.body.get("ghost_id").and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("missing ghost identity"))?;
                let profile = state.profiles.get(ghost_id)
                    .ok_or_else(|| anyhow::anyhow!("profile missing"))?;
                let conversation = envelope.body.get("conversation_id").and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("missing conversation identity"))?;
                uuid::Uuid::parse_str(conversation)?;
                if profile.runtime.session.committed()?.conversations.contains_key(conversation) {
                    bail!("legacy conversation is bound to its existing runtime; create a new Pi conversation");
                }
            }
            if method == "snapshot" {
                if let Some(response) = lifetime::authority::guard(&state.journal.0, envelope)? {
                    return Ok(response);
                }
                return Ok(Response {
                    status: ResponseStatus::Success,
                    summary: "Lifetime ledger snapshot".into(),
                    object_refs: vec![], artifacts: vec![], next_actions: vec![],
                    error_code: None, retry_class: RetryClass::SameId,
                    data: serde_json::to_value(lifetime::snapshot(&state.journal.0)?)?,
                });
            }
            // Owner artifact reads are uncached: like the snapshot, they run
            // through the authority guard (epoch + dispatch state) but never
            // enter the command receipt table, so bounded artifact bytes are
            // never retained in receipts. The authenticated owner actor and
            // the exact work/goal/execution/digest/locator binding are
            // enforced inside the read.
            if method == "work.artifact" {
                if let Some(response) = lifetime::authority::guard(&state.journal.0, envelope)? {
                    return Ok(response);
                }
                return lifetime::artifact_read(&state.journal.0, self.native_computers.as_ref(), &self.root.join("pi-execution"), &envelope.body);
            }
            if method=="work.verify" {
                if let Some(response)=lifetime::authority::guard(&state.journal.0,envelope)? {return Ok(response);}
                let fields=envelope.body.as_object().ok_or_else(||anyhow::anyhow!("verification body missing"))?;
                anyhow::ensure!(fields.len()==2 && fields.contains_key("work_id"),"work.verify requires exactly method and work_id");
                let work_id=envelope.body["work_id"].as_str().ok_or_else(||anyhow::anyhow!("verification Work missing"))?;
                return self.verify_pi_work(&state.journal.0,envelope,work_id);
            }
            if matches!(method,"work.submit"|"work.steer") {
                if let Some(response)=lifetime::authority::guard(&state.journal.0,envelope)? {return Ok(response);}
                use rusqlite::OptionalExtension;
                let cached:Option<(String,String,u64,String)>=state.journal.0.query_row("SELECT payload_digest,actor_ref,authority_epoch,response FROM lifetime_commands WHERE command_id=?1",[&envelope.command_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
                if let Some((digest,actor,epoch,response))=cached {
                    if digest==envelope.payload_digest && actor==envelope.actor_ref && epoch==envelope.authority_epoch {return Ok(serde_json::from_str(&response)?);}
                    anyhow::bail!("Legacy command identity conflicts with its original receipt");
                }
                return Ok(Response {status:ResponseStatus::Error,summary:"Fresh OMP admission and steering are retired; reconcile original execution before any explicit Pi migration".into(),
                    object_refs:vec![],artifacts:vec![],next_actions:vec!["inspect_original_execution".into()],error_code:Some("legacy_execution_retired".into()),retry_class:RetryClass::Never,data:json!({"host_effect_class":"no_effect"})});
            }
            if matches!(method,"bot.creation.plan"|"work.memory.profile.inspect") {
                if let Some(response)=lifetime::authority::guard(&state.journal.0,envelope)? {return Ok(response);}
                return if method=="bot.creation.plan" {super::bots_memory::plan(&state.journal.0,envelope)} else {super::work_memory::apply_owner(&state.journal.0,envelope,"owner")};
            }
            if method=="bot.surface.inspect" {
                if let Some(response)=lifetime::authority::guard(&state.journal.0,envelope)? {return Ok(response);}
                let mut response=super::bot_lifecycle::surface(&state.journal.0,envelope,"owner")?;
                for bot in response.data["bots"].as_array_mut().ok_or_else(||anyhow::anyhow!("bot surface roster missing"))? {
                    let available=bot["ghost_id"].as_str().is_some_and(|ghost|self.native_computers.as_ref().is_some_and(|computers|computers.pi_available(ghost,self.authority_epoch,bot["disclosure"].as_str().unwrap_or("local_only")).unwrap_or(false)));
                    bot["admission_allowed"]=json!(available && bot["admission_allowed"]==true);
                    if let Some(ghost)=bot["ghost_id"].as_str() {
                        if let Some(definition)=super::bots_store::active_definition(&state.journal.0,ghost)? {
                            if let Some(memory)=super::bots_memory::surface(&state.journal.0,&definition)? {bot["memory"]=memory;}
                        }
                    }
                }
                return Ok(response);
            }
            let bot_discovery=if method=="bot.discover" {
                let mut response=super::bots_provisioning::discover(&state.journal.0,envelope,"owner")?;
                let records=response.data["bots"].as_array_mut().ok_or_else(||anyhow::anyhow!("bot discovery records missing"))?;
                records.retain(|bot|bot["ghost_id"].as_str().is_some_and(|ghost|self.native_computers.as_ref().is_some_and(|computers|computers.pi_available(ghost,self.authority_epoch,bot["disclosure"].as_str().unwrap_or("local_only")).unwrap_or(false))));
                response.data["no_fit"]=json!(response.data["bots"].as_array().is_some_and(|bots|bots.is_empty()));
                Some(response)
            }else{None};
            let bot_prepare_cached=method=="bot.prepare" && state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_commands WHERE command_id=?1)",[&envelope.command_id],|r|r.get::<_,bool>(0))?;
            let bot_assets=if method=="bot.prepare" && !bot_prepare_cached {
                Some(super::bots_provisioning::prepare_assets(&state,&self.root,&envelope.body)?)
            }else{None};
            // Identity is supplied here after control-server bearer/HMAC checks.
            lifetime::apply_with_admission(&state.journal.0, envelope, "owner",
                |conn| {
                    if method.starts_with("skill.catalog.") {return super::shared_skills::owner_action(conn,&state,&self.root,envelope).map(Some);}
                    if let Some(response)=bot_discovery {return Ok(Some(response));}
                    if let Some(assets)=bot_assets {return super::bots_provisioning::prepare(conn,envelope,"owner",assets).map(Some);}
                    self.native_work_admission(conn, envelope)
                })
        })();
        Ok(match result {
            Ok(response) => json!({"ok": true, "result": response}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        })
    }
    /// The private Pi-controller credential is checked by the HTTP route.
    /// Scope is bound to an existing Host conversation, never to model arguments.
    pub(crate) async fn lifetime_pi_action(&self, request: &lifetime::PiToolRequest, scope: lifetime::PiInferenceScope) -> Result<Value> {
        if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
            bail!("Ghost host is stopping");
        }
        if let Some(response)=self.publication_effect_guard(request,scope).await? {
            return Ok(json!({"ok":true,"result":response}));
        }
        if request.envelope.body["method"].as_str().is_some_and(|method|method.starts_with("memory.publication.")) {
            let response=self.memory_publication_pi(request,scope).await.unwrap_or_else(|_|super::memory_publication::denied());
            return Ok(json!({"ok":true,"result":response}));
        }
        if request.envelope.body["method"].as_str().is_some_and(|method|matches!(method,"bot.prepare"|"bot.evaluate"|"bot.activate"|"bot.repair")) {
            return Ok(match self.scoped_bot_action(request,scope) {
                Ok(response)=>json!({"ok":true,"result":response}),
                Err(error)=>json!({"ok":true,"result":{"status":"error","summary":error.to_string(),"object_refs":[],"artifacts":[],"next_actions":[],"error_code":"bot_intent_blocked","retry_class":"same_id","data":{"host_effect_class":"no_effect"}}})
            });
        }
        let memory = request.envelope.body.get("method").and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("memory."));
        let work_memory=request.envelope.body["method"].as_str().is_some_and(|method|method.starts_with("work.memory."));
        let document = request.envelope.body.get("method").and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("documents."));
        let execution = request.envelope.body.get("method").and_then(Value::as_str)
            .is_some_and(|method| matches!(method,"work.execute"|"work.execution.complete"));
        let mut result = if let Some(response)=self.lifetime_memory_reply_guard(request,scope).await? {
            Ok(response)
        } else if let Some(response)=self.work_memory_coordination_guard(request,scope).await? {
            Ok(response)
        } else if work_memory {
            self.lifetime_work_memory_action(request,scope).await
        } else if execution {
            self.lifetime_pi_execution_action(request, scope).await
        } else if memory {
            self.lifetime_memory_action(request, scope).await
        } else if document {
            self.lifetime_documents_action(request, scope)
        } else {
            (|| -> Result<Response> {
                let state = self.lock()?;
                if let Some(response) = self.check_pi_host_scope(&state, request, scope)? {
                    return Ok(response);
                }
                if let Some(response)=self.memory_reply_current(&state,request,scope)? {return Ok(response);}
                if let Some(response)=self.work_memory_coordination_current(&state,request,scope)? {return Ok(response);}
                if request.envelope.body["method"] == "work.delegate" && request.envelope.body.get("template_ref").is_some() {
                    let normalized=lifetime::task_contracts::resolve_delegation(&state.journal.0,&request.envelope.body)?;
                    let target=normalized["target_ghost_id"].as_str().ok_or_else(||anyhow::anyhow!("Task target missing"))?;
                    let parent_id=normalized["parent_work_id"].as_str().unwrap();
                    let privacy:String=state.journal.0.query_row("SELECT json_extract(g.payload,'$.privacy') FROM lifetime_work w JOIN lifetime_goals g ON g.id=w.goal_id WHERE w.id=?1",[parent_id],|r|r.get(0))?;
                    anyhow::ensure!(self.native_computers.as_ref().is_some_and(|c|c.pi_available(target,self.authority_epoch,&privacy).unwrap_or(false)),"Selected eligible bot has no current accepted native route");
                }
                lifetime::pi_tool_apply(&state.journal.0, request, scope, self.native_computers.as_ref())
            })()
        };
        if request.envelope.body["method"]=="conversation.report.inspect" {
            if let Ok(response)=&mut result {if response.status==ResponseStatus::Success {
                let state=self.lock()?;
                if let Some(descriptor)=super::bots_provisioning::repair_descriptor(&state.journal.0,request,scope)? {
                    response.data.as_object_mut().ok_or_else(||anyhow::anyhow!("report inspection data missing"))?.insert("bot_repair".into(),descriptor);
                }
            }}
        }
        if request.envelope.body["method"]=="registry.inspect" {
            if let Ok(response)=&mut result {
                if response.status==ResponseStatus::Success {
                    let state=self.lock()?;
                    let mut ready=super::bots_provisioning::discovery_records(&state.journal.0,&[],scope==lifetime::PiInferenceScope::Local)?;
                    ready.retain(|bot|bot["ghost_id"].as_str().is_some_and(|ghost|self.native_computers.as_ref().is_some_and(|computers|computers.pi_available(ghost,self.authority_epoch,bot["disclosure"].as_str().unwrap_or("local_only")).unwrap_or(false))));
                    response.data.as_object_mut().ok_or_else(||anyhow::anyhow!("registry inspection data missing"))?.insert("ready_bots".into(),json!(ready));
                }
            }
        }
        if request.envelope.body["method"]=="conversation.assignment.inspect" {
            if let Ok(response)=&mut result {
                if response.status==ResponseStatus::Success && response.data["execution"]["engine"]=="pi" {
                    let state=self.lock()?;
                    let work_id=response.data["assignment"]["work_id"].as_str().ok_or_else(||anyhow::anyhow!("Pi assignment lacks Work"))?;
                    let work:crate::lifetime_contract::Work=state.journal.0.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[work_id],|r|r.get::<_,String>(0)).map_err(anyhow::Error::from).and_then(|raw|serde_json::from_str(&raw).map_err(anyhow::Error::from))?;
                    let memory=super::work_memory::assignment_view(&state.journal.0,&work,scope==lifetime::PiInferenceScope::Local)?;
                    response.data.as_object_mut().unwrap().insert("work_memory".into(),memory);
                    let publications=super::memory_publication::assignment_view(&state.journal.0,&work)?;
                    response.data.as_object_mut().unwrap().insert("publications".into(),publications);
                    let refs=lifetime::pi_execution::skill_refs(&state.journal.0,&work)?;
                    if scope!=lifetime::PiInferenceScope::Local && refs.iter().any(|skill|skill.privacy!="public") {
                        return Ok(json!({"ok":true,"result":{"status":"error","summary":"Protected pinned skills require a local Pi route","object_refs":[],"artifacts":[],"next_actions":[],"error_code":"disclosure_blocked","retry_class":"never","data":null}}));
                    }
                    let profile=state.profiles.get(&request.ghost_id).ok_or_else(||anyhow::anyhow!("Pi Ghost profile missing"))?;
                    let mut skills=super::skills::payloads_for_refs(&self.root,&profile.name,&refs)?;
                    let bot_assets=super::bots_provisioning::assets_for_work(&state.journal.0,&work)?;
                    if scope!=lifetime::PiInferenceScope::Local && bot_assets.iter().any(|asset|asset["privacy"]!="public") {
                        anyhow::bail!("Protected bot instructions require a local Pi route");
                    }
                    skills.extend(bot_assets);
                    response.data.as_object_mut().unwrap().insert("skills".into(),serde_json::to_value(skills)?);
                }
            }
        }
        Ok(match result {
            Ok(response) => json!({"ok": true, "result": response}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        })
    }

    pub(crate) fn check_pi_host_scope(&self, state: &super::State, request: &lifetime::PiToolRequest, scope: lifetime::PiInferenceScope) -> Result<Option<Response>> {
        let authority = lifetime::authority::current(&state.journal.0)?;
        if self.stopping.load(std::sync::atomic::Ordering::Acquire)
            || authority.epoch != self.authority_epoch
            || (scope == lifetime::PiInferenceScope::Local && self.pi_local_route.is_none()) {
            return Ok(Some(Response {
                status: ResponseStatus::Error, summary: "Captured Pi writer or local route is no longer authoritative".into(),
                object_refs: vec![], artifacts: vec![], next_actions: vec![],
                error_code: Some("authority_fenced".into()), retry_class: RetryClass::Never, data: Value::Null,
            }));
        }
        if !state.profiles.contains_key(&request.ghost_id) {
            return Ok(Some(Response {
                status: ResponseStatus::Error,
                summary: "Pi controller Ghost scope is not registered in this Host".into(),
                object_refs: vec![], artifacts: vec![], next_actions: vec![],
                error_code: Some("unauthorized".into()), retry_class: RetryClass::Never,
                data: Value::Null,
            }));
        }
        Ok(None)
    }
}
