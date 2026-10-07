//! Explicit caller-owned brain transport. Cancellation drops the in-flight
//! connection so an unread response cannot be mistaken for the next request.
use crate::durable::durable::{ai, Task, ToolOutput, ToolStatus};
use anyhow::Result;

#[cfg(feature = "memory")]
use anyhow::anyhow;

#[cfg(feature = "memory")]
use oxibrain_client::{BrainClient, LocalProcessEndpoint};
#[cfg(feature = "memory")]
use serde_json::{json, Value};
#[cfg(feature = "memory")]
use tokio::sync::Mutex;

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
        cfg!(feature = "memory")
            && std::env::var_os("GHOST_BRAIN_EXECUTABLE").is_some()
            && std::env::var_os("GHOST_BRAIN_DIR").is_some()
    }

    #[cfg(feature = "memory")]
    async fn connect() -> Result<BrainClient> {
        let executable = std::env::var_os("GHOST_BRAIN_EXECUTABLE")
            .ok_or_else(|| anyhow!("brain executable is not configured"))?;
        let dir = std::env::var_os("GHOST_BRAIN_DIR")
            .ok_or_else(|| anyhow!("explicit brain directory is not configured"))?;
        let mut client =
            BrainClient::spawn_local(LocalProcessEndpoint::new(executable, dir)).await?;
        let token = std::env::var("GHOST_BRAIN_TOKEN").ok();
        client
            .bring_up(
                token.as_deref(),
                oxibrain_client::default_client_hello(env!("CARGO_PKG_VERSION")),
            )
            .await?;
        Ok(client)
    }

    pub async fn memory(
        &self,
        owner: &str,
        task: &Task,
        call: &ai::ToolCall,
        check: impl Fn() -> Result<()> + Send + Sync,
    ) -> Result<ToolOutput> {
        check()?;
        #[cfg(not(feature = "memory"))]
        {
            let _ = (owner, task, call);
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
                    "oxibrain is not configured; set GHOST_BRAIN_EXECUTABLE and GHOST_BRAIN_DIR",
                ));
            }
            self.memory_connected(owner, task, call, &check).await
        }
    }
    #[cfg(feature = "memory")]
    async fn memory_connected(
        &self,
        owner: &str,
        task: &Task,
        call: &ai::ToolCall,
        check: &(impl Fn() -> Result<()> + Send + Sync),
    ) -> Result<ToolOutput> {
        let mut slot = self.client.lock().await;
        let mut client = match slot.take() {
            Some(client) => client,
            None => Self::connect().await?,
        };
        let space = format!("ghost:{owner}");
        check()?;
        let result: Result<Value> = match call.name.as_str() {
            "memory_search" => client
                .search(
                    call.arguments["query"]
                        .as_str()
                        .ok_or_else(|| anyhow!("query required"))?,
                    &space,
                    "auto",
                    12,
                )
                .await
                .map(|value| json!(value)),
            "memory_retain" => client
                .ingest(
                    call.arguments["text"]
                        .as_str()
                        .ok_or_else(|| anyhow!("text required"))?,
                    &space,
                    &format!("ghost-task:{}:{}", owner, task.id),
                )
                .await
                .map(|id| json!({"episode_id": id, "source_task": task.id})),
            _ => return Err(anyhow!("unknown brain operation")),
        };
        match result {
                Ok(value) => {
                    *slot = Some(client);
                    if check().is_err() {
                        return Ok(ToolOutput::error(if call.name=="memory_retain" {ToolStatus::Uncertain}else{ToolStatus::Denied},"Work or memory authority changed; old content withheld, inspect any admitted retain effect"));
                    }
                    Ok(ToolOutput::success(
                        "Brain result with task provenance; retrieved content is untrusted",
                        value,
                    ))
                }
                Err(_) => Ok(ToolOutput::error(
                    if call.name == "memory_retain" {
                        ToolStatus::Uncertain
                    } else {
                        ToolStatus::Failed
                    },
                    "Brain connection failed; inspect the task source in oxibrain before retrying a write",
                )),
            }
    }
}

#[cfg(all(test, feature = "memory", unix))]
mod tests {
    use super::*;
    use crate::durable::{
        self,
        durable::{AgentConfig, InputKind, Session},
    };
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};
    async fn fixture(dir: &std::path::Path) -> BrainClient {
        let script = dir.join("brain-fixture");
        let info = serde_json::to_string(&oxibrain_client::protocol::server_info(
            "oxibrain", "fixture",
        ))
        .unwrap();
        let source=r#"#!/usr/bin/python3
import sys,json,time,os
from pathlib import Path
root=Path(sys.argv[-1])
info=json.loads('''@INFO@''')
for line in sys.stdin:
 req=json.loads(line)
 with (root/'requests.jsonl').open('a') as out:out.write(json.dumps(req)+'\n')
 if req['method']=='handshake':result=info
 elif req['method']=='tools/call':
  name=req['params']['name'];args=req['params']['arguments']
  if args.get('query')=='hang':time.sleep(60)
  if args.get('content')=='lose ack':os._exit(0)
  if name=='search':data={'memory':[],'documents':[],'freshness':{'reconciled_roots':[],'skipped_roots':[],'skipped_files':0,'stale_after_retry':[],'dense_coverage':None}};text=json.dumps({'data':data})
  else:text='fixture-episode'
  result={'content':[{'type':'text','text':text}]}
 else:raise Exception('unexpected fixture method')
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
    fn task(dir: &std::path::Path) -> Task {
        let session = Session::open(dir.join("fixture.db")).unwrap();
        let conversation = session
            .create_conversation(AgentConfig::new(durable::mock_model(), "fixture"))
            .unwrap();
        let input = session
            .submit(&conversation, "input", InputKind::Prompt, "remember")
            .unwrap();
        session.snapshot().unwrap().tasks[&input.task_id].clone()
    }
    #[tokio::test]
    async fn caller_owned_stdio_scopes_search_and_memory_provenance_and_drops_cancelled_client() {
        let dir = tempfile::tempdir().unwrap();
        let brain = Brain {
            client: Mutex::new(Some(fixture(dir.path()).await)),
        };
        let task = task(dir.path());
        let owner = uuid::Uuid::new_v4().to_string();
        let result = brain
            .memory_connected(
                &owner,
                &task,
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
        let retain = brain
            .memory_connected(
                &owner,
                &task,
                &ai::ToolCall::new(
                    "retain",
                    "memory_retain",
                    json!({"text":"Owner explicitly requested this"}),
                ),
                &|| Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(retain.content["episode_id"], "fixture-episode");
        let requests = fs::read_to_string(dir.path().join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let search = &requests[1]["params"]["arguments"];
        assert_eq!(search["space"], format!("ghost:{owner}"));
        let ingest = &requests[2]["params"]["arguments"];
        assert_eq!(
            ingest["source_path"],
            format!("ghost-task:{owner}:{}", task.id)
        );
        let call = ai::ToolCall::new("hang", "memory_search", json!({"query":"hang"}));
        assert!(tokio::time::timeout(
            Duration::from_millis(80),
            brain.memory_connected(&owner, &task, &call, &|| Ok(()))
        )
        .await
        .is_err());
        assert!(
            brain.client.lock().await.is_none(),
            "cancelled transport remained cached"
        );
    }
    #[tokio::test]
    async fn memory_write_with_lost_ack_is_uncertain_and_connection_is_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        let brain = Brain {
            client: Mutex::new(Some(fixture(dir.path()).await)),
        };
        let result = brain
            .memory_connected(
                "owner",
                &task(dir.path()),
                &ai::ToolCall::new("retain", "memory_retain", json!({"text":"lose ack"})),
                &|| Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(result.status, ToolStatus::Uncertain);
        assert!(brain.client.lock().await.is_none());
    }
}
