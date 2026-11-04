use anyhow::{bail, Context, Result};
use ghost::adapters::{documents::digest, memory::{Brain, SourceDisclosure, SourceLedgerConfig, TrustedSourceOrigin}};
use oxibrain_client::{BrainClient, LocalProcessEndpoint};
use serde_json::{json, Value};

#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1);
    let mode = arguments.next().context("missing operation")?;
    let fixture: Value = serde_json::from_slice(&std::fs::read(arguments.next().context("missing owned fixture")?)?)?;
    let owner = fixture["owner"].as_str().context("missing owner")?;
    let source = fixture["source_id"].as_str().context("missing source")?;
    let content = fixture["content"].as_str().context("missing content")?;
    let origin = if let Some(session_id) = fixture["session_id"].as_str() {
        TrustedSourceOrigin::new_session(owner, source, "1", SourceDisclosure::LocalOnly, digest(content.as_bytes()), session_id)?
    } else {
        TrustedSourceOrigin::new(owner, source, "1", SourceDisclosure::LocalOnly, digest(content.as_bytes()))?
    };
    let ledger = SourceLedgerConfig::from_env()?;
    let brain = Brain::default();
    if mode == "capabilities" {
        let capabilities = brain.source_capabilities(owner, &ledger, || Ok(())).await?;
        println!("{}", serde_json::to_string(&json!({"operation":mode,"capabilities":capabilities,"scope":"isolated live engine schema and source ledger; not model acceptance"}))?);
        return Ok(());
    }
    if mode == "session-list" {
        let current_session_id = arguments.next().context("missing current session identity")?;
        let call = ghost::durable::durable::ai::ToolCall::new(
            "g2-owned-session-list", "memory_session_list", json!({"limit":20}),
        );
        let output = brain.read_memory(owner, &current_session_id, &call, || Ok(())).await?;
        let rows = output.content.as_array().context("missing Session-list data array")?;
        let metadata = rows.iter().map(|row| json!({
            "session_id":row["session_id"], "episode_id":row["episode_id"],
        })).collect::<Vec<_>>();
        println!("{}", serde_json::to_string(&json!({
            "operation":mode, "status":format!("{:?}",output.status),
            "current_session_id":current_session_id, "sessions":metadata,
            "scope":"actual adapter read and current-session exclusion; no artificial Task or model invocation",
        }))?);
        return Ok(());
    }
    let receipt = match mode.as_str() {
        "ingest" => brain.ingest_source(&origin, content, &ledger, || Ok(())).await?,
        "inspect" => brain.inspect_source(&origin, content, &ledger, || Ok(())).await?,
        "correct" => {
            let replacement_content = fixture["replacement"].as_str().context("missing replacement")?;
            let replacement = TrustedSourceOrigin::new(owner, source, "2", SourceDisclosure::LocalOnly, digest(replacement_content.as_bytes()))?;
            let episode = arguments.next().context("missing exact prior episode")?;
            brain.correct_source(&origin, &episode, content, &replacement, replacement_content, &ledger, || Ok(())).await?
        }
        _ => bail!("unsupported operation"),
    };
    let mut engine_evidence = Value::Null;
    if let Some(id) = &receipt.episode_id {
        let endpoint = LocalProcessEndpoint::new(std::env::var_os("GHOST_BRAIN_EXECUTABLE").context("missing executable")?, std::env::var_os("GHOST_BRAIN_DIR").context("missing store")?);
        let mut client = BrainClient::spawn_local(endpoint).await?;
        client.bring_up(Some(&std::env::var("GHOST_BRAIN_TOKEN")?), oxibrain_client::default_client_hello("g1-source-smoke")).await?;
        let resource = client.call_rpc_json("resources/read", json!({"uri":format!("episode://{id}?space=ghost_g1_source_canary")})).await?;
        let episode: Value = serde_json::from_str(resource["contents"][0]["text"].as_str().context("missing episode bytes")?)?;
        let observed_content = episode["content"].as_str().context("missing source bytes")?;
        engine_evidence = json!({
            "episode_id":episode["id"], "space":episode["space"], "trust":episode["trust"], "kind":episode["kind"],
            "source":episode["source"], "redacted_at":episode["redacted_at"],
            "engine_hash_json_type": if episode["content_hash"].is_array() { "array" } else { "other" },
            "engine_hash_byte_count":episode["content_hash"].as_array().map(Vec::len),
            "source_bytes_sha256":digest(observed_content.as_bytes()),
            "source_bytes_match": observed_content == if mode == "correct" { fixture["replacement"].as_str().unwrap() } else { content }
        });
    }
    println!("{}", serde_json::to_string(&json!({"operation":mode,"receipt":receipt,"engine_evidence":engine_evidence,"scope":"isolated adapter only; not Host/model acceptance"}))?);
    Ok(())
}
