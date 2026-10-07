//! Explicit paid diagnostic. Never prints credentials or raw HTTP error bodies.
#[cfg(feature = "durable-runtime")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use futures::StreamExt;
    use ghost::durable::{
        durable::{ai, Providers},
        GhostProviders,
    };
    anyhow::ensure!(
        std::env::var("GHOST_LIVE_PROBE").as_deref() == Ok("1"),
        "Set GHOST_LIVE_PROBE=1 to authorize one real model request"
    );
    let id = std::env::var("GHOST_MODEL")?;
    let engine = oxicode_sdk::OxicodeBuilder::new()
        .with_builtins()
        .with_mcp(false)
        .build();
    let model = engine.resolve_model(&id)?;
    println!(
        "{}",
        serde_json::json!({"model": id, "model_base_url": model.base_url})
    );
    let providers = GhostProviders::new();
    let (provider, mut options) = providers.resolve(&model)?;
    options.max_tokens = Some(1024);
    let context = ai::Context {
        system_prompt: None,
        messages: vec![ai::Message::User(ai::UserMessage::new(
            "Reply only with GHOST_SDK_OK.",
        ))],
        tools: vec![],
    };
    let started = std::time::Instant::now();
    let request = async {
        let mut stream = match provider.stream(&model, &context, Some(options)).await {
            Ok(stream) => stream,
            Err(error) => {
                println!(
                    "{}",
                    serde_json::json!({"status":"request_failed","http_status":error.http_status(),"retryable":error.is_retryable(),"category":match error { ai::ProviderError::MissingApiKey => "missing_key", ai::ProviderError::HttpError(_) => "http", ai::ProviderError::RequestFailed(_) => "transport", _ => "other" }})
                );
                return false;
            }
        };
        let mut events = 0;
        while let Some(event) = stream.next().await {
            events += 1;
            match event {
                ai::ProviderEvent::Done { message, .. } => {
                    println!(
                        "{}",
                        serde_json::json!({"status":"complete","events":events,"usage":message.usage,"text":message.content.iter().filter_map(|c| match c { ai::ContentBlock::Text(t) => Some(t.text.as_str()), _ => None }).collect::<String>()})
                    );
                    return message.content.iter().any(|c| matches!(c, ai::ContentBlock::Text(t) if t.text.contains("GHOST_SDK_OK")));
                }
                ai::ProviderEvent::Error { .. } => {
                    println!(
                        "{}",
                        serde_json::json!({"status":"stream_error","events":events})
                    );
                    return false;
                }
                _ => {}
            }
        }
        println!(
            "{}",
            serde_json::json!({"status":"stream_ended_without_done","events":events})
        );
        false
    };
    let ok = tokio::time::timeout(std::time::Duration::from_secs(45), request)
        .await
        .unwrap_or(false);
    println!(
        "{}",
        serde_json::json!({"elapsed_ms":started.elapsed().as_millis(),"ok":ok})
    );
    anyhow::ensure!(ok, "model probe failed");
    Ok(())
}
#[cfg(not(feature = "durable-runtime"))]
fn main() {
    eprintln!("Build with durable-runtime");
}
