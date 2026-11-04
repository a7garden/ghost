//! Lifetime inference preferences and provider consent. Secret values are accepted
//! only by the authenticated owner endpoint and never enter receipts/snapshots.
use super::Host;
use anyhow::{anyhow, bail, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};

const KIND: &str = "inference_settings_v1";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection { pub provider: String, pub model: String, pub effort: String }
impl Default for Selection { fn default() -> Self { Self { provider: "codex".into(), model: "gpt-6-luna".into(), effort: "high".into() } } }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    pub version: u64,
    pub default: Selection,
    pub conversations: BTreeMap<String, Selection>,
    pub external_grants: BTreeMap<String, Vec<String>>,
    pub credentials: BTreeMap<String, bool>,
    pub image_provider: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_reports_actual_provider_transport() {
        let providers = catalog(None);
        let rows = providers.as_array().unwrap();
        assert_eq!(rows.iter().find(|p| p["id"] == "codex").unwrap()["transport"], "official_codex_cli");
        for id in ["zai-coding", "minimax"] {
            assert_eq!(rows.iter().find(|p| p["id"] == id).unwrap()["transport"], "native_responses");
        }
        assert_eq!(rows.iter().find(|p| p["id"] == "local").unwrap()["transport"], "loopback");
    }
    #[tokio::test]
    async fn inference_defaults_keys_and_cas_are_separate_from_action_receipts() {
        use std::os::unix::fs::PermissionsExt;
        let root=tempfile::tempdir().unwrap();
        let app=Host::open(root.path(),tokio::runtime::Handle::current(),Some("mock")).unwrap();
        assert_eq!(app.inference_settings().unwrap()["settings"]["default"]["model"],"gpt-6-luna");
        let secret="test-API-key-must-stay-out-of-the-ledger";
        let value=app.configure_inference(&json!({"operation":"set_api_key","version":0,"provider":"minimax","api_key":secret})).unwrap();
        assert!(!value.to_string().contains(secret));
        assert_eq!(value["settings"]["credentials"]["minimax"],true);
        let path=root.path().join("inference-credentials/minimax.json");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode()&0o777,0o600);
        assert!(app.configure_inference(&json!({"operation":"set_api_key","version":0,"provider":"minimax","api_key":"other-test-secret"})).is_err());
        assert!(fs::read_to_string(path).unwrap().contains(secret));
        let stored:String=app.lock().unwrap().journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind=?1",[KIND],|row|row.get(0)).unwrap();
        assert!(!stored.contains(secret));
        assert!(app.configure_inference(&json!({"operation":"set_default","version":1,"selection":{"provider":"codex","model":"gpt-6-luna","effort":"high"},"api_key":secret})).is_err());
        app.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn inference_consent_is_provider_and_conversation_specific() {
        let root=tempfile::tempdir().unwrap();
        let app=Host::open(root.path(),tokio::runtime::Handle::current(),Some("mock")).unwrap();
        let ghost=uuid::Uuid::new_v4().to_string(); let conversation=uuid::Uuid::new_v4().to_string();
        app.lock().unwrap().journal.0.execute("INSERT INTO lifetime_registry(ghost_id,kind,conversation_id,roles,mode) VALUES(?1,'primary',?2,'[]','active')",[&ghost,&conversation]).unwrap();
        app.lock().unwrap().journal.0.execute("INSERT INTO lifetime_bindings(conversation_id,ghost_id,runtime_kind,runtime_release,storage_ref) VALUES(?1,?2,'pi-durable','test','test')",[&conversation,&ghost]).unwrap();
        app.configure_inference(&json!({"operation":"select","version":0,"ghost_id":ghost,"conversation_id":conversation,"selection":Selection::default(),"allow_external":true})).unwrap();
        {
            let state=app.lock().unwrap(); let conn=&state.journal.0;
            assert!(external_allowed(conn,&ghost,&conversation).unwrap());
            assert!(!external_allowed(conn,&ghost,"another-conversation").unwrap());
        }
        // A different provider never inherits Codex's history consent.
        app.configure_inference(&json!({"operation":"select","version":1,"ghost_id":ghost,"conversation_id":conversation,"selection":{"provider":"minimax","model":"MiniMax-M3.1-Flash-Preview","effort":"high"}})).unwrap();
        assert!(!external_allowed(&app.lock().unwrap().journal.0,&ghost,&conversation).unwrap());
        app.shutdown().await.unwrap();
    }
    #[test]
    fn inference_catalog_rejects_unsupported_provider_reasoning() {
        let selection=|provider:&str,model:&str,effort:&str|Selection{provider:provider.into(),model:model.into(),effort:effort.into()};
        assert!(valid_selection(&selection("zai-coding","glm-5.3","max")));
        assert!(!valid_selection(&selection("zai-coding","glm-5.3","medium")));
        assert!(!valid_selection(&selection("zai-coding","glm-5.3","xhigh")));
        assert!(valid_selection(&selection("minimax","MiniMax-M3.1-Flash-Preview","medium")));
        assert!(!valid_selection(&selection("minimax","MiniMax-M2.7","max")));
    }
    #[tokio::test]
    async fn provider_can_be_selected_before_a_registered_ghosts_first_turn() {
        let root=tempfile::tempdir().unwrap();
        let app=Host::open(root.path(),tokio::runtime::Handle::current(),Some("mock")).unwrap();
        let ghost=uuid::Uuid::new_v4().to_string();let conversation=uuid::Uuid::new_v4().to_string();
        app.lock().unwrap().journal.0.execute(
            "INSERT INTO lifetime_registry(ghost_id,kind,conversation_id,roles,mode) VALUES(?1,'primary',?2,'[]','active')",
            [&ghost,&conversation]).unwrap();
        let selection=json!({"provider":"zai-coding","model":"glm-5.3","effort":"high"});
        let response=app.configure_inference(&json!({"operation":"select","version":0,"ghost_id":ghost,
            "conversation_id":conversation,"selection":selection,"allow_external":true})).unwrap();
        assert_eq!(response["settings"]["version"],1);
        let state=app.lock().unwrap();
        assert!(external_allowed(&state.journal.0,&ghost,&conversation).unwrap());
        assert_eq!(state.journal.0.query_row("SELECT count(*) FROM lifetime_bindings",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        drop(state);
        for (foreign_ghost,foreign_conversation) in [(uuid::Uuid::new_v4().to_string(),conversation.clone()),(ghost.clone(),uuid::Uuid::new_v4().to_string())] {
            assert!(app.configure_inference(&json!({"operation":"select","version":1,"ghost_id":foreign_ghost,
                "conversation_id":foreign_conversation,"selection":selection,"allow_external":true})).is_err());
        }
        assert_eq!(app.inference_settings().unwrap()["settings"]["version"],1);
        app.shutdown().await.unwrap();
    }
}
impl Default for Settings { fn default() -> Self { Self { version: 0, default: Selection::default(), conversations: BTreeMap::new(), external_grants: BTreeMap::new(), credentials: BTreeMap::new(), image_provider: "codex".into() } } }
pub(crate) fn key(ghost: &str, conversation: &str) -> String { format!("{ghost}/{conversation}") }
fn valid_selection(s: &Selection) -> bool {
    let model = match s.provider.as_str() {
        "codex" => matches!(s.model.as_str(), "gpt-6-luna" | "gpt-6-sol" | "gpt-6.1-sol" | "gpt-6-astra"),
        "zai-coding" => s.model == "glm-5.3",
        "minimax" => s.model == "MiniMax-M3.1-Flash-Preview",
        "local" => !s.model.is_empty() && s.model.len() <= 300 && !s.model.chars().any(char::is_whitespace),
        _ => false,
    };
    model && match s.provider.as_str() {
        "local" => s.effort == "off",
        "zai-coding" => matches!(s.effort.as_str(), "low" | "high" | "max"),
        _ => matches!(s.effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max"),
    }
}
pub(crate) fn load(conn: &rusqlite::Connection) -> Result<Settings> {
    use rusqlite::OptionalExtension;
    let value: Option<String> = conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND id='workspace'", [KIND], |row| row.get(0)).optional()?;
    let settings: Settings = value.map(|raw| serde_json::from_str(&raw)).transpose()?.unwrap_or_default();
    ensure!(valid_selection(&settings.default) && settings.conversations.values().all(valid_selection), "invalid stored inference selection");
    Ok(settings)
}
pub(crate) fn selected(conn: &rusqlite::Connection, ghost: &str, conversation: &str) -> Result<(Settings, Selection)> {
    let settings = load(conn)?;
    let selection = settings.conversations.get(&key(ghost, conversation)).cloned().unwrap_or_else(|| settings.default.clone());
    Ok((settings, selection))
}
pub(crate) fn external_allowed(conn: &rusqlite::Connection, ghost: &str, conversation: &str) -> Result<bool> {
    let (settings, selection) = selected(conn, ghost, conversation)?;
    Ok(selection.provider != "local" && settings.external_grants.get(&key(ghost, conversation)).is_some_and(|grants| grants.contains(&selection.provider)))
}
pub(crate) fn selection_view(conn: &rusqlite::Connection, ghost: &str, conversation: &str) -> Result<Value> {
    let (settings, selection) = selected(conn, ghost, conversation)?;
    Ok(json!({"version":settings.version,"selection":selection,"external_allowed":external_allowed(conn,ghost,conversation)?,"credentials_present": settings.credentials.get(&selection.provider).copied().unwrap_or(selection.provider=="codex" || selection.provider=="local")}))
}
fn catalog(local: Option<&super::lifetime_runtime::LocalPiRoute>) -> Value {
    json!([
        {"id":"codex","name":"Codex · ChatGPT OAuth","auth":"codex_oauth","models":["gpt-6-luna","gpt-6-sol","gpt-6.1-sol","gpt-6-astra"],"efforts":["low","medium","high","xhigh","max"],"default_model":"gpt-6-luna","default_effort":"high","image":true,"transport":"official_codex_cli"},
        {"id":"zai-coding","name":"Z.AI Coding Plan","auth":"api_key","models":["glm-5.3"],"efforts":["low","high","max"],"default_model":"glm-5.3","default_effort":"high","image":false,"transport":"native_responses"},
        {"id":"minimax","name":"MiniMax","auth":"api_key","models":["MiniMax-M3.1-Flash-Preview"],"efforts":["low","medium","high","xhigh","max"],"default_model":"MiniMax-M3.1-Flash-Preview","default_effort":"high","image":true,"transport":"native_responses"},
        {"id":"local","name":"로컬 모델","auth":"none","models":local.map(|route|vec![route.model_id.clone()]).unwrap_or_default(),"efforts":["off"],"default_model":local.map(|route|route.model_id.clone()),"default_effort":"off","image":true,"transport":"loopback","image_note":"Dyno 로컬 평가 · 자원 조건에 따라 차단"}
    ])
}
fn save_secret(path: &Path, value: &[u8]) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let parent = path.parent().ok_or_else(||anyhow!("missing credential directory"))?;
    ensure!(!parent.is_symlink() && !path.is_symlink(), "credential path must not be a symlink");
    fs::create_dir_all(parent)?; fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let temporary = parent.join(format!(".pending-{}",uuid::Uuid::new_v4()));
    let result=(|| { use std::io::Write; let mut file=fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?; file.write_all(value)?; file.sync_all()?; fs::rename(&temporary,path)?; Ok(()) })();
    if result.is_err() { let _=fs::remove_file(&temporary); } result
}
impl Host {
    pub(crate) fn inference_settings(&self) -> Result<Value> {
        let state=self.lock()?; let settings=load(&state.journal.0)?;
        Ok(json!({"ok":true,"settings":settings,"providers":catalog(self.pi_local_route.as_ref())}))
    }
    pub(crate) fn configure_inference(&self, input: &Value) -> Result<Value> {
        ensure!(input.is_object(), "invalid inference configuration");
        let mut state=self.lock()?;
        let mut settings=load(&state.journal.0)?;
        ensure!(input.get("version").and_then(Value::as_u64)==Some(settings.version), "inference settings changed; reload before saving");
        let operation=input.get("operation").and_then(Value::as_str).ok_or_else(||anyhow!("missing inference operation"))?;
        let allowed: &[&str] = match operation {
            "select"=> &["version","operation","ghost_id","conversation_id","selection","allow_external"],
            "set_default"=> &["version","operation","selection"],
            "set_api_key"=> &["version","operation","provider","api_key"],
            "image_provider"=> &["version","operation","provider"],
            "revoke_external"=> &["version","operation","ghost_id","conversation_id"],
            _=>bail!("unsupported inference operation"),
        };
        ensure!(input.as_object().unwrap().keys().all(|key|allowed.contains(&key.as_str())),"unsupported inference configuration field");
        if let Some(value)=input.get("allow_external") { ensure!(value.is_boolean(),"allow_external must be a boolean"); }
        let mut secret_restore: Option<(std::path::PathBuf,Option<Vec<u8>>)>=None;
        match operation {
            "select" | "set_default" => {
                let selection: Selection=serde_json::from_value(input.get("selection").cloned().ok_or_else(||anyhow!("missing selection"))?)?;
                ensure!(valid_selection(&selection), "unsupported provider/model/reasoning selection");
                if selection.provider=="local" { ensure!(self.pi_local_route.as_ref().is_some_and(|route| route.model_id==selection.model), "local model is not configured"); }
                if operation=="set_default" {
                    let active:bool=state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE state IN ('queued','running','effect_unknown'))",[],|row|row.get(0))?;
                    ensure!(!active,"finish or reconcile active turns before changing the default");
                    settings.default=selection;
                }
                else {
                    let ghost=input.get("ghost_id").and_then(Value::as_str).ok_or_else(||anyhow!("missing Ghost"))?;
                    let conversation=input.get("conversation_id").and_then(Value::as_str).ok_or_else(||anyhow!("missing conversation"))?;
                    let bound:bool=state.journal.0.query_row(
                        "SELECT EXISTS(SELECT 1 FROM lifetime_bindings WHERE ghost_id=?1 AND conversation_id=?2)
                         OR EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1 AND conversation_id=?2)",
                        [ghost,conversation],|row|row.get(0))?;
                    ensure!(bound,"conversation is outside the selected Ghost");
                    let active:bool=state.journal.0.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE ghost_id=?1 AND conversation_id=?2 AND state IN ('queued','running','effect_unknown'))",[ghost,conversation],|row|row.get(0))?;
                    ensure!(!active,"finish or reconcile the current turn before switching models");
                    let k=key(ghost,conversation);
                    if input.get("allow_external").and_then(Value::as_bool)==Some(true) && selection.provider!="local" {
                        let grants=settings.external_grants.entry(k.clone()).or_default();
                        if !grants.contains(&selection.provider) { grants.push(selection.provider.clone()); }
                    }
                    settings.conversations.insert(k,selection);
                }
            },
            "set_api_key" => {
                let provider=input.get("provider").and_then(Value::as_str).ok_or_else(||anyhow!("missing provider"))?;
                ensure!(matches!(provider,"zai-coding"|"minimax"),"this provider does not accept an API key");
                let secret=input.get("api_key").and_then(Value::as_str).ok_or_else(||anyhow!("missing API key"))?;
                ensure!((8..=4096).contains(&secret.len()) && !secret.chars().any(char::is_whitespace),"invalid API key shape");
                let path=self.root.join("inference-credentials").join(format!("{provider}.json"));
                ensure!(!path.is_symlink() && !path.parent().unwrap().is_symlink(),"credential path must not be a symlink");
                let previous=match fs::read(&path) { Ok(value)=>Some(value),Err(error) if error.kind()==std::io::ErrorKind::NotFound=>None,Err(error)=>return Err(error.into()) };
                save_secret(&path,serde_json::to_vec(&json!({"api_key":secret}))?.as_slice())?;
                secret_restore=Some((path,previous)); settings.credentials.insert(provider.into(),true);
            },
            "image_provider" => {
                let provider=input.get("provider").and_then(Value::as_str).ok_or_else(||anyhow!("missing provider"))?;
                ensure!(matches!(provider,"codex"|"minimax"|"local"),"unsupported image provider"); settings.image_provider=provider.into();
            },
            "revoke_external" => {
                let ghost=input.get("ghost_id").and_then(Value::as_str).ok_or_else(||anyhow!("missing Ghost"))?;
                let conversation=input.get("conversation_id").and_then(Value::as_str).ok_or_else(||anyhow!("missing conversation"))?;
                settings.external_grants.remove(&key(ghost,conversation));
            },
            _=>bail!("unsupported inference operation"),
        }
        settings.version=settings.version.checked_add(1).ok_or_else(||anyhow!("version exhausted"))?;
        if let Err(error)=state.journal.put(KIND,"workspace",&settings) {
            if let Some((path,previous))=secret_restore { match previous { Some(value)=>save_secret(&path,&value)?,None=>fs::remove_file(path)? } }
            return Err(error);
        }
        Ok(json!({"ok":true,"settings":settings,"providers":catalog(self.pi_local_route.as_ref())}))
    }
}

/// Opt-in live-test bootstrap for the registered external provider structure.
/// Copies the Owner's already-registered zai-coding credential into the
/// isolated test Host and commits it as the default selection, so every
/// canary conversation runs on external inference exactly as the installed
/// product does. The secret value never enters logs, receipts or snapshots.
#[cfg(test)]
pub(crate) fn install_external_test_inference(host: &Host) -> Result<()> {
    let home = std::env::var("HOME").map_err(|_| anyhow!("HOME is required to locate the Owner zai-coding credential"))?;
    let raw = fs::read(Path::new(&home).join("Library/Application Support/Ghost/inference-credentials/zai-coding.json"))
        .map_err(|error| anyhow!("registered external inference requires the Owner zai-coding credential: {error}"))?;
    let secret = serde_json::from_slice::<Value>(&raw)?
        .get("api_key").and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Owner zai-coding credential is malformed"))?
        .to_owned();
    let value = host.configure_inference(&json!({"operation":"set_api_key","version":0,"provider":"zai-coding","api_key":secret}))?;
    ensure!(value["settings"]["credentials"]["zai-coding"]==true, "zai-coding credential was not registered");
    let value = host.configure_inference(&json!({"operation":"set_default","version":1,"selection":{"provider":"zai-coding","model":"glm-5.3","effort":"max"}}))?;
    ensure!(value["settings"]["default"]["provider"]=="zai-coding" && value["settings"]["default"]["model"]=="glm-5.3",
        "external default selection was not committed");
    Ok(())
}
