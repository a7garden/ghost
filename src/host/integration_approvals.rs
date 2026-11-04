//! Pi proposes external effects; only an authenticated Owner action can dispatch one.
use super::{integrations, lifetime, now_ms, Host, State};
use crate::lifetime_contract::{canonical_digest, Response, ResponseStatus, RetryClass};
use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const RECORD: &str = "integration_approval_v1";
const MAX_TURN_PROPOSALS: u32 = 8;
const MAX_RESULT_BYTES: usize = 16_384;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ApprovalState {
    Pending,
    Dispatching,
    Sent,
    Failed,
    Uncertain,
    Declined,
}

#[derive(Clone, Serialize, Deserialize)]
struct Approval {
    id: String,
    ghost_id: String,
    conversation_id: String,
    #[serde(default)]
    turn_id: String,
    authority_epoch: u64,
    integration_id: String,
    integration_name: String,
    integration_version: u64,
    tool: String,
    schema: Value,
    arguments: Value,
    proposal_digest: String,
    state: ApprovalState,
    created_ms: u64,
    dispatch_id: Option<String>,
    #[serde(default)]
    result: Option<ApprovalResult>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ApprovalResult {
    text: String,
    truncated: bool,
}

fn review_result(value: &Value) -> ApprovalResult {
    let structured = value.get("structuredContent").filter(|value| value.is_object());
    let content = value["content"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut text = structured.map(|value| serde_json::to_string_pretty(value).unwrap_or_default()).unwrap_or_default();
    let mut truncated = false;
    if structured.is_none() {
        for block in content {
            let Some(part) = block["text"].as_str().filter(|_| block["type"] == "text") else {
                truncated = true;
                continue;
            };
            if !text.is_empty() { text.push_str("\n\n"); }
            text.push_str(part);
            if text.len() > MAX_RESULT_BYTES { break; }
        }
    }
    if text.len() > MAX_RESULT_BYTES {
        let mut end = MAX_RESULT_BYTES;
        while !text.is_char_boundary(end) { end -= 1; }
        text.truncate(end);
        truncated = true;
    }
    ApprovalResult { text, truncated }
}

impl Approval {
    fn summary(&self) -> Value {
        json!({
            "id": self.id, "ghost_id": self.ghost_id, "conversation_id": self.conversation_id,
            "integration_id": self.integration_id, "integration_name": self.integration_name,
            "tool": self.tool, "state": self.state, "created_ms": self.created_ms,
        })
    }

    fn current(&self, host: &Host, state: &State) -> Result<()> {
        let authority = lifetime::authority::current(&state.journal.0)?;
        ensure!(
            authority.dispatch_enabled && host.dispatch_enabled && authority.epoch == host.authority_epoch
                && authority.epoch == self.authority_epoch,
            "승인 요청의 실행 권한이 변경되었습니다."
        );
        let active: bool = state.journal.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1 AND conversation_id=?2 AND mode='active')",
            [&self.ghost_id, &self.conversation_id],
            |r| r.get(0),
        )?;
        ensure!(active, "승인을 요청한 Ghost 대화가 비활성 상태입니다.");
        let item = integrations::allowed(state, &self.integration_id, Some(&self.ghost_id))?;
        ensure!(
            item.version == self.integration_version
                && item.data.approved_tools.as_ref().is_some_and(|tools| tools.contains(&self.tool)),
            "승인을 요청한 연동이나 기능 권한이 변경되었습니다."
        );
        ensure!(
            item.tools.iter().any(|tool| tool["name"] == self.tool && tool.get("inputSchema") == Some(&self.schema)),
            "외부 도구의 입력 형식이 변경되었습니다."
        );
        Ok(())
    }
}

pub(super) fn summaries(state: &State) -> Result<Vec<Value>> {
    let mut query = state.journal.0.prepare(
        "WITH approvals AS (
           SELECT payload, json_extract(payload,'$.state') AS state, json_extract(payload,'$.created_ms') AS created
           FROM workspace_objects WHERE kind=?1
         ), history AS (
           SELECT * FROM approvals WHERE state NOT IN ('pending','dispatching') ORDER BY created DESC LIMIT 100
         )
         SELECT payload FROM (SELECT * FROM approvals WHERE state IN ('pending','dispatching')
           UNION ALL SELECT * FROM history) ORDER BY created DESC"
    )?;
    let rows = query.query_map([RECORD], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str::<Approval>(&row?)?.summary())).collect()
}

pub(super) fn recover_interrupted(journal: &super::scheduler::Journal) -> Result<()> {
    // The workspace lock excludes any live sender while reopening the journal.
    for mut record in journal.objects::<Approval>(RECORD)? {
        if record.state == ApprovalState::Dispatching {
            record.state = ApprovalState::Uncertain;
            journal.put(RECORD, &record.id, &record)?;
        }
    }
    Ok(())
}

fn load(state: &State, id: &str) -> Result<Approval> {
    state.journal.get(RECORD, id)?.ok_or_else(|| anyhow!("승인 요청을 찾을 수 없습니다."))
}

pub(super) fn approved_features(state: &State, ghost: &str) -> Result<Vec<Value>> {
    Ok(integrations::list(state)?
        .into_iter()
        .filter(|item| item.data.enabled && item.error.is_none() && item.data.profiles.iter().any(|id| id == ghost))
        .flat_map(|item| {
            let tools = item.data.approved_tools.unwrap_or_default();
            item.tools.into_iter().filter_map(move |tool| {
                let name = tool.get("name")?.as_str()?;
                let schema = tool.get("inputSchema")?;
                if !tools.iter().any(|allowed| allowed == name) || !safe_schema(schema) {
                    return None;
                }
                Some(json!({"integration_id": item.id, "integration_name": item.data.name,
                    "tool": name, "input_schema": schema}))
            })
        })
        .take(64)
        .collect())
}

// The proposal validator never resolves remote schemas or follows unbounded references.
fn safe_schema(schema: &Value) -> bool {
    fn safe(value: &Value, depth: usize) -> bool {
        depth < 32 && match value {
            Value::Object(object) => object.iter().all(|(key, value)| {
                !matches!(key.as_str(), "$ref" | "$dynamicRef" | "$recursiveRef" | "$id" | "$schema")
                    && safe(value, depth + 1)
            }),
            Value::Array(items) => items.iter().all(|item| safe(item, depth + 1)),
            _ => true,
        }
    }
    schema["type"] == "object" && schema.to_string().len() <= 8192 && safe(schema, 0)
}

fn success(summary: &str, data: Value) -> Response {
    Response {
        status: ResponseStatus::Success, summary: summary.into(), object_refs: vec![],
        artifacts: vec![], next_actions: vec![], error_code: None,
        retry_class: RetryClass::Never, data,
    }
}

impl Host {
    pub(super) fn integration_approval_inspect(&self, id: &str) -> Result<Value> {
        let state = self.lock()?;
        let approval = load(&state, id)?;
        let mut detail = approval.summary();
        detail["approval_allowed"] = json!(approval.state == ApprovalState::Pending && approval.current(self, &state).is_ok());
        detail["arguments"] = approval.arguments;
        if let Some(result) = approval.result {
            detail["result"] = json!(result);
        }
        Ok(detail)
    }

    pub(super) fn integration_approval_pi(
        &self,
        request: &lifetime::PiToolRequest,
        scope: lifetime::PiInferenceScope,
    ) -> Result<Response> {
        request.envelope.validate()?;
        let state = self.lock()?;
        if let Some(response) = self.check_pi_host_scope(&state, request, scope)?
            .or(lifetime::pi_tool_guard(&state.journal.0, request, scope)?) {
            return Ok(response);
        }
        let body = &request.envelope.body;
        let method = body["method"].as_str().unwrap_or_default();
        let fields: &[&str] = match method {
            "integrations.list" => &["method", "ghost_id", "conversation_id", "turn_id"],
            "integrations.propose" => &["method", "ghost_id", "conversation_id", "turn_id", "integration_id", "tool", "arguments"],
            _ => anyhow::bail!("unsupported integration method"),
        };
        ensure!(body.as_object().is_some_and(|value| value.len() == fields.len() && fields.iter().all(|key| value.contains_key(*key))),
            "invalid integration proposal fields");
        ensure!(request.context_ref.is_none() && body["ghost_id"] == request.ghost_id && body["conversation_id"] == request.conversation_id,
            "integration proposal requires the exact authenticated Owner conversation");
        ensure!(scope == lifetime::PiInferenceScope::Local
            || lifetime::conversation_is_public(&state.journal.0, &request.ghost_id, &request.conversation_id)?,
            "비공개 대화의 외부 작업 제안에는 로컬 추론이 필요합니다.");
        let turn_id = body["turn_id"].as_str().ok_or_else(|| anyhow!("missing Owner turn"))?;
        let live: bool = state.journal.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs r JOIN lifetime_turns t ON t.id=r.turn_id
              WHERE r.turn_id=?1 AND r.ghost_id=?2 AND r.conversation_id=?3
              AND t.ghost_id=r.ghost_id AND t.conversation_id=r.conversation_id
              AND t.kind='user' AND t.sender_kind='owner' AND t.sender_ref='owner'
              AND r.cancel_requested=0 AND r.state IN ('queued','running'))",
            [turn_id, &request.ghost_id, &request.conversation_id],
            |row| row.get(0),
        )?;
        ensure!(live, "외부 작업 제안은 현재 사용자 대화에서만 만들 수 있습니다.");
        if method == "integrations.list" {
            return Ok(success("Owner-enabled external functions require a separate approval.", json!({
                "features": approved_features(&state, &request.ghost_id)?,
            })));
        }
        let id = canonical_digest(&json!([request.ghost_id, request.conversation_id, request.envelope.command_id]))?;
        if let Some(existing) = state.journal.get::<Approval>(RECORD, &id)? {
            ensure!(existing.proposal_digest == request.envelope.payload_digest, "integration proposal identity collision");
            return Ok(success("Original approval request.", existing.summary()));
        }
        let count: u32 = state.journal.0.query_row(
            "SELECT count(*) FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.turn_id')=?2",
            [RECORD, turn_id], |row| row.get(0),
        )?;
        ensure!(count < MAX_TURN_PROPOSALS, "한 대화 입력에서 요청할 수 있는 외부 승인 수를 초과했습니다.");
        let integration_id = body["integration_id"].as_str().ok_or_else(|| anyhow!("missing connection id"))?;
        let name = body["tool"].as_str().ok_or_else(|| anyhow!("missing tool name"))?;
        let item = integrations::allowed(&state, integration_id, Some(&request.ghost_id))?;
        ensure!(item.error.is_none() && item.data.approved_tools.as_ref().is_some_and(|tools| tools.iter().any(|tool| tool == name)),
            "이 기능은 해당 Ghost에 승인 요청용으로 설정되지 않았습니다.");
        let schema = item.tools.iter().find(|tool| tool["name"] == name)
            .and_then(|tool| tool.get("inputSchema")).filter(|schema| safe_schema(schema))
            .ok_or_else(|| anyhow!("사용 가능한 도구 입력 형식을 먼저 확인해 주세요."))?;
        let arguments = &body["arguments"];
        ensure!(arguments.is_object() && arguments.to_string().len() <= 32_768, "외부 도구 입력은 32 KiB 이하의 객체여야 합니다.");
        let validator = jsonschema::validator_for(schema).map_err(|_| anyhow!("도구 입력 형식을 해석할 수 없습니다."))?;
        ensure!(validator.is_valid(arguments), "외부 도구 입력이 등록된 형식과 일치하지 않습니다.");
        let approval = Approval {
            id, ghost_id: request.ghost_id.clone(), conversation_id: request.conversation_id.clone(),
            turn_id: turn_id.into(), authority_epoch: request.envelope.authority_epoch, integration_id: item.id,
            integration_name: item.data.name, integration_version: item.version,
            tool: name.into(), schema: schema.clone(), arguments: arguments.clone(),
            proposal_digest: request.envelope.payload_digest.clone(), state: ApprovalState::Pending,
            created_ms: now_ms(), dispatch_id: None, result: None,
        };
        approval.current(self, &state)?;
        state.journal.put(RECORD, &approval.id, &approval)?;
        Ok(success("Waiting for Owner approval; no external call was made.", approval.summary()))
    }

    pub(super) async fn decide_integration_approval(&self, request_id: &str, id: &str, approve: bool) -> Result<Value> {
        let approval = {
            let state = self.lock()?;
            let mut record = load(&state, id)?;
            ensure!(record.state == ApprovalState::Pending, "이미 처리했거나 결과를 확인 중인 승인 요청입니다.");
            if !approve {
                record.state = ApprovalState::Declined;
                state.journal.put(RECORD, id, &record)?;
                return Ok(record.summary());
            }
            record.current(self, &state)?;
            record
        };
        let result = integrations::run_approved(self, &approval.integration_id, &approval.ghost_id,
            &approval.tool, approval.arguments.clone(), (approval.integration_version, &approval.schema), || {
                let state = self.lock()?;
                let mut record = load(&state, id)?;
                ensure!(record.state == ApprovalState::Pending, "승인 요청이 이미 처리되었습니다.");
                record.current(self, &state)?;
                // Reserve before external I/O. A crash leaves an unresolved receipt, never a replayable request.
                record.state = ApprovalState::Dispatching;
                record.dispatch_id = Some(request_id.into());
                state.journal.put(RECORD, id, &record)
            }).await;
        let state = self.lock()?;
        let mut record = load(&state, id)?;
        if record.dispatch_id.as_deref() != Some(request_id) {
            // No tools/call can have been issued by this command.
            result?;
            anyhow::bail!("외부 호출을 예약하지 못했습니다.");
        }
        record.state = match result {
            Ok(value) => {
                let output = review_result(&value);
                record.result = (!output.text.is_empty() || output.truncated).then_some(output);
                if value["isError"] == true { ApprovalState::Failed } else { ApprovalState::Sent }
            }
            Err(_) => ApprovalState::Uncertain,
        };
        state.journal.put(RECORD, id, &record)?;
        Ok(record.summary())
    }
}
