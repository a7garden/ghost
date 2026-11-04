import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { discover } from "./host-discovery.js";
import { payloadDigest, PROTOCOL_VERSION } from "./contract.js";
import { validateDirectWorkIdentity } from "./direct-work.js";
import { DOCUMENT_TOOL_NAMES, MEMORY_TOOL_NAMES } from "./models.js";
import { MEMORY_QUERY_FIELDS, memoryQueryArguments } from "./memory-query.js";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 8 * 1_048_576;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function callbackCommandId(ghostId, conversationId, invocationId, method) {
  const identity = JSON.stringify(["ghost-pi-callback-v2", ghostId, conversationId, invocationId, method]);
  return `pi-tool-v2:${sha256(identity)}`;
}

export function taskContractGoalBody({ ghostId, conversationId, turnId, taskContractRef }) {
  if (![ghostId, conversationId, turnId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 400)
    || typeof taskContractRef !== 'string' || !/^ot-[a-f0-9]{64}$/u.test(taskContractRef)) throw new Error('Exact scoped Owner task reference is required');
  return { method: 'goal.create', turn_id: turnId, ghost_id: ghostId, conversation_id: conversationId, task_contract_ref: taskContractRef };
}

function validResponse(value) {
  return value !== null && typeof value === "object"
    && ["success", "warning", "error"].includes(value.status)
    && typeof value.summary === "string"
    && Array.isArray(value.artifacts)
    && Array.isArray(value.next_actions);
}

const MEMORY_TOOL_NAME_SET = new Set(MEMORY_TOOL_NAMES);
const DOCUMENT_TOOL_NAME_SET = new Set(DOCUMENT_TOOL_NAMES);
const MAX_DOCUMENT_TITLE_BYTES = 512;
const MAX_DOCUMENT_BODY_BYTES = 262_144;
const MAX_DOCUMENT_IDENTIFIER_LENGTH = 400;
const MAX_DOCUMENT_QUERY_LENGTH = 512;

function isBoundedText(value, maxBytes) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validateAvailableDocumentTools(response, inferenceScope) {
  if (response?.status === "error") {
    const error = new Error("Host documents.capabilities was rejected; no document tools were exposed.");
    const errorCode = safeErrorCode(response.error_code);
    if (errorCode !== null) error.error_code = errorCode;
    throw error;
  }
  if (response?.status !== "success" || !Array.isArray(response.data?.available_tools)) {
    throw new Error("Host documents.capabilities did not return a successful tool-name list.");
  }
  const seen = new Set();
  for (const name of response.data.available_tools) {
    if (!DOCUMENT_TOOL_NAME_SET.has(name) || seen.has(name)) {
      throw new Error("Host documents.capabilities returned an unknown or duplicate model tool name.");
    }
    seen.add(name);
  }
  if (inferenceScope === "public" && seen.size !== 0) {
    throw new Error("Public inference must not receive document Space tools.");
  }
  return response;
}

const TURN_STATUS_NAMES = new Set(["running", "answered", "failed", "cancelled", "effect_unknown"]);
const TURN_STATUS_REASON_CODES = new Set([
  "model_request_failed",
  "runtime_failure",
  "admission_blocked",
  "answer_unprojectable",
  "owner_cancelled",
  "effect_unconfirmed",
  "reply_delivery_unconfirmed",
  "authority_revoked",
]);


function safeErrorCode(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_:-]{0,99}$/iu.test(value) ? value : null;
}

function validateTurnStatusArguments(args, turnId) {
  if (typeof turnId !== "string" || turnId.length === 0
    || !hasExactArguments(args, ["status", "submission_id", "entry_id", "reason_code"])
    || !TURN_STATUS_NAMES.has(args.status)
    || (args.submission_id !== null && (typeof args.submission_id !== "string" || args.submission_id.length === 0 || args.submission_id.length > 400))
    || (args.entry_id !== null && (typeof args.entry_id !== "string" || args.entry_id.length === 0 || args.entry_id.length > 400))
    || (args.reason_code !== null && !TURN_STATUS_REASON_CODES.has(args.reason_code))
    || (args.status === "running" && (args.submission_id === null || args.entry_id !== null || args.reason_code !== null))
    || (args.status === "answered" && (args.entry_id === null || args.reason_code !== null))
    || (["failed", "cancelled", "effect_unknown"].includes(args.status) && args.reason_code === null)) {
    throw new Error("conversation.turn_status does not match the bounded controller status contract.");
  }
}

function validateAvailableMemoryTools(response, inferenceScope) {
  if (response?.status === "error") {
    const error = new Error("Host memory.capabilities was rejected; no memory tools were exposed.");
    const errorCode = safeErrorCode(response.error_code);
    if (errorCode !== null) error.error_code = errorCode;
    throw error;
  }
  if (response?.status !== "success" || !Array.isArray(response.data?.available_tools)) {
    throw new Error("Host memory.capabilities did not return a successful tool-name list.");
  }
  const seen = new Set();
  for (const name of response.data.available_tools) {
    if (!MEMORY_TOOL_NAME_SET.has(name) || seen.has(name)) {
      throw new Error("Host memory.capabilities returned an unknown or duplicate model tool name.");
    }
    seen.add(name);
  }
  if (inferenceScope === "public" && seen.size !== 0) {
    throw new Error("Public inference must not receive personal memory tools.");
  }
  return response;
}

function hasExactArguments(args, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(args);
  return required.every((key) => Object.hasOwn(args, key)) && actual.every((key) => allowed.has(key));
}

function requireCanonicalMemoryScope(scope, turnId) {
  if (scope.inferenceScope !== "local" || scope.conversationDisclosure !== "non_public"
    || typeof turnId !== "string" || turnId.length === 0) {
    throw new Error("Memory operations require a local callback for the exact committed canonical owner turn.");
  }
}

function memoryIdentityFields(ghostId, conversationId, turnId, argumentsFields = {}) {
  return {
    turn_id: turnId,
    ghost_id: ghostId,
    conversation_id: conversationId,
    ...argumentsFields,
  };
}


async function boundedJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error("Pi Host response exceeds the callback limit.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
}

export function createHostToolTransport({ hostRoot, callbackToken, localCallbackToken, authorityEpoch, dispatch }) {
  if (!isAbsolute(hostRoot)) {
    throw new Error("The Host root must be an absolute coordinator-owned path.");
  }
  if (typeof callbackToken !== "string" || callbackToken.length === 0) {
    throw new Error("The Host-issued Pi callback credential is required.");
  }
  if (localCallbackToken !== undefined && (typeof localCallbackToken !== "string" || localCallbackToken.length === 0)) {
    throw new Error("The optional Host-issued local Pi callback credential must be non-empty when configured.");
  }
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1) {
    throw new Error("A captured positive Host authority epoch is required.");
  }

  function verifyWaitResponse(response,envelope) {
    if (envelope.body.method==="work.wait" && envelope.body.assignment_id!==undefined && response.status==="success") {
      const r=response.data?.wait_receipt,b=envelope.body;
      if (!r || r.kind!=="pi-work-wait/1" || r.assignment_id!==b.assignment_id || r.work_id!==b.work_id
        || r.generation_task_id!==b.generation_task_id || r.authority_epoch!==envelope.authority_epoch
        || r.wait_command_id!==envelope.command_id || r.wait_payload_digest!==envelope.payload_digest
        || JSON.stringify(r.wait_for)!==JSON.stringify(b.wait_for)) throw new Error("Host did not confirm the exact immutable Work wait receipt.");
    }
    return response;
  }
  async function command({
    ghostId, conversationId, invocationId, method, fields = {}, expectedRevision = null,
    inferenceScope, conversationDisclosure, contextRef,
  }) {
    let endpointPath;
    let credential;
    if (inferenceScope === "public" && conversationDisclosure === "public") {
      endpointPath = "/api/v1/pi/action";
      credential = callbackToken;
    } else if (inferenceScope === "selected" && ["public", "non_public"].includes(conversationDisclosure)) {
      endpointPath = "/api/v1/pi/selected-action";
      credential = callbackToken;
    } else if (inferenceScope === "local" && ["public", "non_public"].includes(conversationDisclosure)) {
      endpointPath = "/api/v1/pi/local-action";
      credential = localCallbackToken;
      if (!credential) {
        return {
          status: "error",
          summary: "Local Host callback credential is unavailable; no request was sent.",
          object_refs: [],
          artifacts: [],
          next_actions: ["Wait for the coordinator to inject the private local callback credential."],
          error_code: "local_callback_unavailable",
          retry_class: "same_id",
          data: null,
        };
      }
    } else {
      throw new Error("Pi callback scope does not match committed conversation disclosure.");
    }
    const body = { method, ...fields };
    const commandId = callbackCommandId(ghostId, conversationId, invocationId, method);
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      command_id: commandId,
      payload_digest: payloadDigest(body),
      actor_ref: ghostId,
      authority_epoch: authorityEpoch,
      expected_revision: expectedRevision,
      correlation_id: commandId,
      body,
    };
    const outer = { ghost_id: ghostId, conversation_id: conversationId, ...(contextRef === undefined ? {} : { context_ref: contextRef }), envelope };
    const requestBody = JSON.stringify(outer);
    if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error("Pi Host callback request exceeds the one-megabyte endpoint limit.");
    }

    // A trusted in-process/stdio coordinator may supply transport only; the
    // exact body conversion, digest, epoch and identity checks above still run.
    if (dispatch !== undefined) {
      if (typeof dispatch !== "function") throw new Error("Host dispatch must be a trusted function.");
      const frame = await dispatch(outer, { inferenceScope, conversationDisclosure });
      if (frame?.ok !== true || !validResponse(frame.result)) throw Object.assign(new Error("Scoped Host dispatch returned no verified lifetime receipt."), { code: "host_callback_rejected" });
      return verifyWaitResponse(frame.result,envelope);
    }

    let origin;
    try {
      // discover() verifies the Host with its bootstrap HMAC; its owner bearer is never sent to this endpoint.
      ({ origin } = await discover(hostRoot));
    } catch {
      throw Object.assign(new Error("Pi Host discovery failed; stop and inspect the Host before retrying this invocation."), { code: "host_discovery_failed" });
    }

    let response;
    try {
      response = await fetch(`${origin}${endpointPath}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${credential}`,
          "X-Ghost-CSRF": credential,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: requestBody,
      });
    } catch {
      throw Object.assign(new Error("Pi Host callback outcome may be unknown; inspect current state before another mutation."), { code: "host_callback_transport_failed" });
    }

    let frame;
    try {
      frame = await boundedJson(response);
    } catch {
      throw Object.assign(new Error("Pi Host callback did not return a bounded JSON receipt; inspect current state before retrying."), { code: "host_callback_invalid_receipt", http_status: response.status });
    }
    if (!response.ok || frame?.ok !== true || !validResponse(frame.result)) {
      throw Object.assign(new Error("Pi Host callback did not return a verified lifetime Response; inspect current state and stop if unresolved."), { code: "host_callback_rejected", http_status: response.status });
    }
    return verifyWaitResponse(frame.result,envelope);
  }

  async function inspectWork(scope, invocationId, workId) {
    return command({ ...scope, invocationId, method: "work.inspect", fields: { work_id: workId } });
  }

  async function inspectGoal(scope, invocationId, goalId) {
    return command({ ...scope, invocationId, method: "goal.inspect", fields: { goal_id: goalId } });
  }

  async function inspectCanonicalReply(scope, invocationId, turnId, text) {
    // Mutation receipts are immutable; history is a fresh observation of them.
    const inspectionId = randomUUID();
    let beforeSequence;
    let sourceTurnFound = false;
    for (;;) {
      const cursor = beforeSequence === undefined ? "latest" : String(beforeSequence);
      const inspected = await command({
        ...scope,
        invocationId: JSON.stringify(["conversation-reply-inspect-v2", invocationId, inspectionId, cursor]),
        method: "conversation.inspect",
        fields: { ghost_id: scope.ghostId, conversation_id: scope.conversationId, limit: 100, ...(beforeSequence === undefined ? {} : { before_sequence: beforeSequence }) },
      });
      const data = inspected?.data;
      if (inspected?.status !== "success" || data?.ghost_id !== scope.ghostId
        || data?.conversation_id !== scope.conversationId || !Array.isArray(data.turns)
        || typeof data.has_older !== "boolean") {
        throw new Error("Canonical conversation inspection did not return a scoped durable page; no reply was sent.");
      }
      const replies = data.turns.filter((turn) => turn?.kind === "assistant_advisory" && turn.source_turn_id === turnId);
      if (replies.length > 1) {
        throw new Error("Host contains multiple advisory replies for one owner turn; stop without another mutation.");
      }
      if (replies.length === 1) {
        if (replies[0].text !== text) {
          throw new Error("The immutable Host advisory reply differs from the committed Pi entry; stop without rewriting it.");
        }
        return inspected;
      }
      sourceTurnFound ||= data.turns.some((turn) => turn?.id === turnId && turn.kind === "user");
      if (sourceTurnFound || !data.has_older) {
        if (!sourceTurnFound) {
          throw new Error("The exact canonical owner turn is absent from Host history; no advisory reply was sent.");
        }
        return undefined;
      }
      const oldest = data.oldest_sequence;
      if (!Number.isSafeInteger(oldest) || oldest < 1
        || (beforeSequence !== undefined && oldest >= beforeSequence)) {
        throw new Error("Canonical conversation history cursor did not move backwards; no reply was sent.");
      }
      beforeSequence = oldest;
    }
  }

  async function workContext(scope, invocationId, workId) {
    const inspected = await inspectWork(scope, invocationId, workId);
    if (inspected.status !== "success") return { response: inspected };
    const work = inspected.data?.work;
    if (!work || typeof work.goal_id !== "string" || work.owner !== scope.ghostId) {
      throw new Error("Pi Host returned a work item outside the closed-over Ghost scope.");
    }
    const goalReply = await inspectGoal(scope, invocationId, work.goal_id);
    if (goalReply.status !== "success") return { response: goalReply };
    const goal = goalReply.data?.goal;
    if (!goal || goal.accountable_ghost !== scope.ghostId
      || goal.reply_conversation !== scope.conversationId
      || !Number.isSafeInteger(goal.revision) || goal.revision < 1
      || work.goal_revision !== goal.revision) {
      throw new Error("Pi Host work or Goal scope changed; inspect the current Host state before acting.");
    }
    return { work, goal };
  }

  return async ({
    method,
    invocation_id: invocationId,
    ghost_id: ghostId,
    conversation_id: conversationId,
    context_ref: contextRef,
    turn_id: turnId,
    assignment_id: assignmentId,
    report_id: reportId,
    work_id: workId,
    generation_task_id: generationTaskId,
    task_id: taskId,
    call_id: callId,
    input_digest: inputDigest,
    operation,
    memory_context_revision: memoryContextRevision,
    work_memory_context_revision: workMemoryContextRevision,
    wait_goal_revision: waitGoalRevision,
    inference_scope: inferenceScope,
    conversation_disclosure: conversationDisclosure,
    arguments: args,
  }) => {
    if (contextRef !== undefined && (typeof contextRef !== "string" || !/^wc-[a-f0-9]{64}$/u.test(contextRef))) throw new Error("Invalid trusted Work context reference.");
    const scope = { ghostId, conversationId, inferenceScope, conversationDisclosure, contextRef };
    if (typeof invocationId !== "string" || invocationId.length === 0
      || typeof ghostId !== "string" || ghostId.length === 0
      || typeof conversationId !== "string" || conversationId.length === 0
      || args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Pi callback identity and arguments must come from the bound runtime invocation.");
    }

    if (workMemoryContextRevision !== undefined && (typeof workMemoryContextRevision !== "string" || !/^[a-f0-9]{64}$/u.test(workMemoryContextRevision))) throw new Error("Invalid Work memory context provenance stamp.");
    switch (method) {
      case "work.context.claim": {
        if (!contextRef || ![assignmentId,workId].every(value=>isBoundedText(value,400))
          || !hasExactArguments(args,["generation_task_id","provider_session_id","storage_ref"])
          || !Number.isSafeInteger(args.generation_task_id) || args.generation_task_id < 1
          || !isBoundedText(args.provider_session_id,400) || !isBoundedText(args.storage_ref,1024)
          || isAbsolute(args.storage_ref) || args.storage_ref.split(/[\\/]/u).some(part=>!part || part==='..' || part==='.') ) throw new Error("Work context claim requires the original trusted context and exact SDK/store identities.");
        return command({...scope,invocationId,method,fields:{assignment_id:assignmentId,work_id:workId,context_ref:contextRef,...args}});
      }
      case "bot.repair": {
        if (!isBoundedText(reportId, 400) || !hasExactArguments(args, ["candidate_id", "candidate_digest", "instructions"])
          || !isBoundedText(args.candidate_id, 400) || typeof args.candidate_digest !== "string" || !/^[a-f0-9]{64}$/u.test(args.candidate_digest)
          || typeof args.instructions !== "string" || Buffer.byteLength(args.instructions, "utf8") < 1 || Buffer.byteLength(args.instructions, "utf8") > 32768) {
          throw new Error("Bot repair requires the bound report and exact candidate identity with bounded replacement instructions.");
        }
        return command({ ...scope, invocationId, method, fields: { report_id: reportId, arguments: args } });
      }
      case "memory.publication.capabilities":
      case "memory.publication.context.inspect":
      case "memory.publication.read": {
        const work = assignmentId !== undefined || workId !== undefined;
        if (inferenceScope !== "local" || (work ? ![assignmentId, workId].every(value => isBoundedText(value, 400)) || turnId !== undefined : !isBoundedText(turnId, 400))) throw new Error("Published sources require an exact authenticated local Owner turn or Work assignment.");
        if (method === "memory.publication.read" ? !hasExactArguments(args, ["reference"]) || !isBoundedText(args.reference, 400) : Object.keys(args).length !== 0) throw new Error("Published source operations accept only a Host-issued reference or no arguments.");
        return command({ ...scope, invocationId, method, fields: { ghost_id: ghostId, conversation_id: conversationId,
          ...(work ? { assignment_id: assignmentId, work_id: workId } : { turn_id: turnId }), ...args } });
      }
      case "work.memory.context.inspect":
      case "work.memory.recall":
      case "work.memory.record": {
        if (![assignmentId, workId].every(value => isBoundedText(value, 400)) || inferenceScope !== "local") throw new Error("Work memory requires the exact authenticated assignment and local inference route.");
        if (method === "work.memory.context.inspect" && Object.keys(args).length !== 0) throw new Error("Work memory inspection accepts no model arguments.");
        if (method === "work.memory.recall" && (!hasExactArguments(args, ["query"], ["token_budget", ...MEMORY_QUERY_FIELDS]) || typeof args.query !== "string" || Buffer.byteLength(args.query, "utf8") > 8192
          || (args.token_budget !== undefined && (!Number.isInteger(args.token_budget) || args.token_budget < 128 || args.token_budget > 2048)))) throw new Error("Invalid Work memory recall arguments.");
        if (method === "work.memory.record" && (!hasExactArguments(args, ["summary", "limitations", "artifact_digests"]) || typeof args.summary !== "string" || Buffer.byteLength(args.summary, "utf8") < 1 || Buffer.byteLength(args.summary, "utf8") > 16384
          || typeof args.limitations !== "string" || Buffer.byteLength(args.limitations, "utf8") > 8192 || !Array.isArray(args.artifact_digests) || args.artifact_digests.length < 1 || args.artifact_digests.length > 8
          || new Set(args.artifact_digests).size !== args.artifact_digests.length || args.artifact_digests.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)))) throw new Error("Invalid generated Work experience arguments.");
        if (method === "work.memory.recall") memoryQueryArguments(args);
        return command({ ...scope, invocationId, method, fields: { ghost_id: ghostId, conversation_id: conversationId, assignment_id: assignmentId, work_id: workId, ...args } });
      }
      case "work.execute": {
        validateDirectWorkIdentity({ ghostId, conversationId, assignmentId, workId, generationTaskId, taskId, callId, inputDigest, operation, args, invocationId });
        return command({ ...scope, invocationId, method, fields: {
          assignment_id: assignmentId, work_id: workId, generation_task_id: generationTaskId, task_id: taskId,
          call_id: callId, input_digest: inputDigest, operation, arguments: args,
          ...(workMemoryContextRevision === undefined ? {} : { work_memory_context_revision: workMemoryContextRevision }),
        } });
      }
      case "work.execution.complete": {
        if (![assignmentId, workId].every(value => isBoundedText(value, 400))
          || !Number.isSafeInteger(taskId) || taskId < 1
          || !hasExactArguments(args, ["summary"]) || typeof args.summary !== "string" || Buffer.byteLength(args.summary, "utf8") > 32768
          || invocationId !== JSON.stringify(["ghost-pi-complete/1", ghostId, conversationId, assignmentId, taskId])) {
          throw new Error("Pi execution completion requires the original bound assignment and GenerationTask identity.");
        }
        return command({ ...scope, invocationId, method, fields: { assignment_id: assignmentId, work_id: workId, task_id: taskId, summary: args.summary, ...(workMemoryContextRevision === undefined ? {} : { work_memory_context_revision: workMemoryContextRevision }) } });
      }
      case "inference.settings": {
        const bound=assignmentId!==undefined||workId!==undefined;
        if(bound&&![assignmentId,workId].every(value=>isBoundedText(value,400)))throw new Error("Inference settings require the exact outer assignment and Work pair.");
        return command({ ...scope, invocationId, method,fields:bound?{assignment_id:assignmentId,work_id:workId}:{} });
      }
      case "inference.inspect": {
        if (!hasExactArguments(args, [])) throw new Error("Inference inspection accepts no model arguments.");
        const bound = assignmentId !== undefined || workId !== undefined;
        if (bound && ![assignmentId, workId].every(value => isBoundedText(value, 400))) {
          throw new Error("Inference inspection requires the exact outer assignment and Work pair.");
        }
        return command({ ...scope, invocationId, method, fields: bound ? {assignment_id: assignmentId, work_id: workId} : {} });
      }
      case "conversation.assignment.inspect": {
        if (typeof assignmentId !== "string" || assignmentId.length === 0 || assignmentId.length > 400
          || Object.keys(args).length !== 0) {
          throw new Error("conversation.assignment.inspect requires the exact outer assignment ID and no arguments.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: { assignment_id: assignmentId, ghost_id: ghostId, conversation_id: conversationId },
        });
      }
      case "conversation.report.inspect": {
        if (typeof reportId !== "string" || reportId.length === 0 || reportId.length > 400 || Object.keys(args).length !== 0) {
          throw new Error("conversation.report.inspect requires the exact outer report ID and no arguments.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: { report_id: reportId, ghost_id: ghostId, conversation_id: conversationId },
        });
      }
      case "conversation.turn.inspect": {
        if (typeof turnId !== "string" || turnId.length === 0 || turnId.length > 400 || Object.keys(args).length !== 0) {
          throw new Error("conversation.turn.inspect requires one exact owner turn and no arguments.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: { ghost_id: ghostId, conversation_id: conversationId, turn_id: turnId },
        });
      }
      case "conversation.turn_status": {
        validateTurnStatusArguments(args, turnId);
        return command({
          ...scope,
          invocationId,
          method,
          fields: {
            ghost_id: ghostId,
            conversation_id: conversationId,
            turn_id: turnId,
            status: args.status,
            submission_id: args.submission_id,
            entry_id: args.entry_id,
            reason_code: args.reason_code,
          },
        });
      }
      case "memory.context.inspect":
      case "memory.capabilities": {
        if (typeof turnId !== "string" || turnId.length === 0 || Object.keys(args).length !== 0) {
          throw new Error("Runtime memory.capabilities requires the trusted owner turn and no model arguments.");
        }
        const response = await command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId),
        });
        return method === "memory.context.inspect" ? response : validateAvailableMemoryTools(response, inferenceScope);
      }
      case "memory.search": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, ["query"], MEMORY_QUERY_FIELDS) || typeof args.query !== "string") {
          throw new Error("memory.search accepts a query and optional temporal scope.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, { query: args.query, ...memoryQueryArguments(args) }),
        });
      }
      case "memory.recall": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, ["query"], ["token_budget", ...MEMORY_QUERY_FIELDS]) || typeof args.query !== "string"
          || (Object.hasOwn(args, "token_budget")
            && (!Number.isSafeInteger(args.token_budget) || args.token_budget < 128 || args.token_budget > 2_048))) {
          throw new Error("memory.recall requires a query and an optional token_budget from 128 through 2048.");
        }
        const selected = {
          query: args.query,
          ...memoryQueryArguments(args),
          ...(Object.hasOwn(args, "token_budget") ? { token_budget: args.token_budget } : {}),
        };
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, selected),
        });
      }
      case "memory.session_list": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, [], ["limit"])
          || (Object.hasOwn(args, "limit") && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 20))) {
          throw new Error("memory.session_list accepts only an optional limit from 1 through 20.");
        }
        const selected = Object.hasOwn(args, "limit") ? { limit: args.limit } : {};
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, selected),
        });
      }
      case "memory.retain": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, ["text"]) || typeof args.text !== "string"
          || args.text.trim().length === 0 || Buffer.byteLength(args.text, "utf8") > 8_192) {
          throw new Error("memory.retain requires non-empty text of at most 8192 UTF-8 bytes.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, { text: args.text }),
        });
      }
      case "memory.session_record": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, ["summary"]) || typeof args.summary !== "string"
          || args.summary.trim().length === 0 || Buffer.byteLength(args.summary, "utf8") > 8_192) {
          throw new Error("memory.session_record requires a non-empty summary of at most 8192 UTF-8 bytes.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, { summary: args.summary }),
        });
      }
      case "integrations.list":
      case "integrations.propose": {
        if (!isBoundedText(turnId, 400) || contextRef) {
          throw new Error("An authenticated Owner turn is required for integration proposals.");
        }
        const list = method === "integrations.list";
        if (list ? Object.keys(args).length !== 0 : (
          !hasExactArguments(args, ["integration_id", "tool", "arguments"])
          || !isBoundedText(args.integration_id, 400) || !isBoundedText(args.tool, 200)
          || args.arguments === null || typeof args.arguments !== "object" || Array.isArray(args.arguments)
          || Buffer.byteLength(JSON.stringify(args.arguments), "utf8") > 32_768
        )) throw new Error("Invalid integration request arguments.");
        return command({ ...scope, invocationId, method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, args),
        });
      }
      case "documents.capabilities": {
        if (typeof turnId !== "string" || turnId.length === 0 || Object.keys(args).length !== 0) {
          throw new Error("Runtime documents.capabilities requires the trusted owner turn and no model arguments.");
        }
        const response = await command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId),
        });
        return validateAvailableDocumentTools(response, inferenceScope);
      }
      case "documents.list_spaces": {
        requireCanonicalMemoryScope(scope, turnId);
        if (Object.keys(args).length !== 0) {
          throw new Error("documents.list_spaces accepts no model arguments.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId),
        });
      }
      case "documents.list_pages": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, ["space_id"], ["query"])
          || !isBoundedText(args.space_id, MAX_DOCUMENT_IDENTIFIER_LENGTH)
          || (Object.hasOwn(args, "query")
            && (typeof args.query !== "string" || args.query.length > MAX_DOCUMENT_QUERY_LENGTH))) {
          throw new Error("documents.list_pages requires one bounded space_id and an optional bounded query string.");
        }
        const selected = Object.hasOwn(args, "query") ? { query: args.query } : {};
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, { space_id: args.space_id, ...selected }),
        });
      }
      case "documents.read_page": {
        requireCanonicalMemoryScope(scope, turnId);
        const selectorCount = [args.page_id, args.locator].filter((value) => value !== undefined).length;
        if (!isBoundedText(args.space_id, MAX_DOCUMENT_IDENTIFIER_LENGTH)
          || !hasExactArguments(args, ["space_id"], ["page_id", "locator"])
          || selectorCount !== 1
          || (args.page_id !== undefined && !isBoundedText(args.page_id, MAX_DOCUMENT_IDENTIFIER_LENGTH))
          || (args.locator !== undefined && !isBoundedText(args.locator, MAX_DOCUMENT_IDENTIFIER_LENGTH))) {
          throw new Error("documents.read_page requires one bounded space_id and exactly one of page_id or locator.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, {
            space_id: args.space_id,
            ...(args.page_id !== undefined ? { page_id: args.page_id } : { locator: args.locator }),
          }),
        });
      }
      case "documents.review_page": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, ["space_id", "title", "body"], ["profile", "page_id", "expected_hash"])
          || !isBoundedText(args.space_id, MAX_DOCUMENT_IDENTIFIER_LENGTH)
          || !isBoundedText(args.title, MAX_DOCUMENT_TITLE_BYTES)
          || !isBoundedText(args.body, MAX_DOCUMENT_BODY_BYTES)
          || (Object.hasOwn(args, "profile") && !isBoundedText(args.profile, 100))
          || (Object.hasOwn(args, "page_id") && !isBoundedText(args.page_id, MAX_DOCUMENT_IDENTIFIER_LENGTH))
          || (Object.hasOwn(args, "expected_hash") && !isBoundedText(args.expected_hash, 128))) {
          throw new Error("documents.review_page requires bounded space_id, title and body; optional profile, page_id and expected_hash are the only other arguments.");
        }
        const selected = {
          space_id: args.space_id,
          title: args.title,
          body: args.body,
          ...(Object.hasOwn(args, "profile") ? { profile: args.profile } : {}),
          ...(Object.hasOwn(args, "page_id") ? { page_id: args.page_id } : {}),
          ...(Object.hasOwn(args, "expected_hash") ? { expected_hash: args.expected_hash } : {}),
        };
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, selected),
        });
      }
      case "documents.review.inspect": {
        requireCanonicalMemoryScope(scope, turnId);
        if (!hasExactArguments(args, ["review_id"]) || !isBoundedText(args.review_id, MAX_DOCUMENT_IDENTIFIER_LENGTH)) {
          throw new Error("documents.review.inspect requires one bounded review_id.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: memoryIdentityFields(ghostId, conversationId, turnId, { review_id: args.review_id }),
        });
      }
      case "bot.prepare": {
        const sourceRef = args.source_contract_ref;
        const hasSourceRef = typeof sourceRef === "string" && /^bsc-[a-f0-9]{64}$/u.test(sourceRef);
        const validSources = Array.isArray(args.source_work_ids) && args.source_work_ids.length <= 8
          && new Set(args.source_work_ids).size === args.source_work_ids.length
          && args.source_work_ids.every(value => isBoundedText(value, 400));
        const refOnly = hasSourceRef && hasExactArguments(args, ["display_name", "purpose", "source_contract_ref"], ["source_work_ids"])
          && (!Object.hasOwn(args, "source_work_ids") || (validSources && args.source_work_ids.length === 1));
        const explicit = hasExactArguments(args, ["display_name", "purpose", "input_contract", "output_contract", "instructions", "required_capabilities", "source_work_ids"], ["source_contract_ref"])
          && (sourceRef === undefined || hasSourceRef) && isBoundedText(args.instructions, 32768)
          && [args.input_contract, args.output_contract].every(value => value !== null && typeof value === "object" && !Array.isArray(value))
          && Array.isArray(args.required_capabilities) && args.required_capabilities.length <= 5
          && new Set(args.required_capabilities).size === args.required_capabilities.length
          && args.required_capabilities.every(value => ["read", "write", "edit", "bash", "publish_artifact"].includes(value));
        if (!isBoundedText(turnId, 400) || (!refOnly && !explicit)
          || !isBoundedText(args.display_name, 256) || !isBoundedText(args.purpose, 4096)
          || (!refOnly && !validSources)) {
          throw new Error("Bot preparation requires an exact Host source-contract reference or bounded explicit content and scoped source Work IDs from the trusted Owner turn.");
        }
        return command({ ...scope, invocationId, method, fields: { turn_id: turnId, arguments: args } });
      }
      case "bot.evaluate":
      case "bot.activate": {
        if (!isBoundedText(turnId, 400) || !hasExactArguments(args, ["candidate_id", "candidate_digest"]) || !isBoundedText(args.candidate_id, 400)
          || typeof args.candidate_digest !== "string" || !/^[a-f0-9]{64}$/u.test(args.candidate_digest)) {
          throw new Error("Bot evaluation/activation requires the exact candidate identity and digest from the trusted Owner turn.");
        }
        return command({ ...scope, invocationId, method, fields: { turn_id: turnId, arguments: args } });
      }
      case "goal.create": {
        if (Object.hasOwn(args,"task_contract_ref")) {
          if (!isBoundedText(turnId,400) || !hasExactArguments(args,["task_contract_ref"])
            || typeof args.task_contract_ref!=="string" || !/^ot-[a-f0-9]{64}$/u.test(args.task_contract_ref)) {
            throw new Error("Task-bound Goal creation accepts only the current Host-issued task reference.");
          }
          const { method: _method, ...fields } = taskContractGoalBody({ ghostId, conversationId, turnId, taskContractRef: args.task_contract_ref });
          return command({...scope,invocationId,method,fields});
        }
        const argumentFields = Object.keys(args);
        if (typeof turnId !== "string" || turnId.length === 0
          || argumentFields.length !== 2 || !argumentFields.includes("prompt") || !argumentFields.includes("acceptance_spec")
          || typeof args.prompt !== "string" || args.prompt.trim().length === 0
          || args.acceptance_spec === null || typeof args.acceptance_spec !== "object" || Array.isArray(args.acceptance_spec)) {
          throw new Error("Canonical Goal creation requires the trusted owner turn and only prompt/acceptance model arguments.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: {
            turn_id: turnId,
            ghost_id: ghostId,
            conversation_id: conversationId,
            prompt: args.prompt,
            acceptance_spec: args.acceptance_spec,
          },
        });
      }
      case "work.inspect":
        return inspectWork(scope, invocationId, args.work_id);
      case "work.submit": {
        if (!hasExactArguments(args, ["work_id"]) || !isBoundedText(args.work_id, 400)) {
          throw new Error("work.submit accepts only the exact Work ID for same-Ghost Pi admission.");
        }
        // Canonical goal.create already enqueues this Ghost's assignment. This
        // only reconciles that durable admission; no OMP spec or process exists.
        return command({ ...scope, invocationId, method: "work.pi.admit", fields: { work_id: args.work_id,
          ...(workMemoryContextRevision === undefined ? {} : { work_memory_context_revision: workMemoryContextRevision }) } });
      }
      case "work.wait.inspect": {
        if (!hasExactArguments(args,["wait_command_id","wait_payload_digest","wait_for"])
          || !isBoundedText(assignmentId,400) || !isBoundedText(workId,400)
          || !Number.isSafeInteger(generationTaskId) || generationTaskId<1) throw new Error("Exact original Work wait inspection identity is required.");
        return command({...scope,invocationId,method,fields:{assignment_id:assignmentId,work_id:workId,generation_task_id:generationTaskId,...args,
          ...(workMemoryContextRevision===undefined?{}:{work_memory_context_revision:workMemoryContextRevision})}});
      }
      case "work.cancel":
        return command({ ...scope, invocationId, method, fields: { work_id: args.work_id } });
      case "work.steer":
      case "work.wait":
      case "work.delegate": {
        if (method === "work.wait" && assignmentId !== undefined) {
          if (!hasExactArguments(args,["work_id","wait_for"]) || args.work_id!==workId
            || !isBoundedText(assignmentId,400) || !Number.isSafeInteger(generationTaskId) || generationTaskId<1
            || !Number.isSafeInteger(waitGoalRevision) || waitGoalRevision<1) throw new Error("Bound Work wait requires its original assignment, generation and Goal revision.");
          return command({...scope,invocationId,method,expectedRevision:waitGoalRevision,fields:{...args,assignment_id:assignmentId,generation_task_id:generationTaskId,
            ...(workMemoryContextRevision===undefined?{}:{work_memory_context_revision:workMemoryContextRevision})}});
        }
        const context = await workContext(scope, invocationId, args.work_id ?? args.parent_work_id);
        if (context.response) return context.response;
        let fields;
        if (method === "work.steer") fields = { work_id: context.work.id, prompt: args.prompt };
        else if (method === "work.wait") fields = { work_id: context.work.id, wait_for: args.wait_for };
        else if (Object.hasOwn(args,"template_ref")) {
          if (!hasExactArguments(args,["parent_work_id","template_ref","target_ghost_id"])
            || !isBoundedText(args.parent_work_id,400) || !isBoundedText(args.target_ghost_id,400)
            || typeof args.template_ref!=="string" || !/^dt-[a-f0-9]{64}$/u.test(args.template_ref)) {
            throw new Error("Target-free delegation requires the exact Host template and selected eligible target only.");
          }
          fields={parent_work_id:context.work.id,template_ref:args.template_ref,target_ghost_id:args.target_ghost_id};
        }
        else if (Object.hasOwn(args, "contract_ref")) {
          if (!hasExactArguments(args, ["parent_work_id", "contract_ref"])
            || !isBoundedText(args.parent_work_id, 400)
            || typeof args.contract_ref !== "string" || !/^dc-[a-f0-9]{64}$/u.test(args.contract_ref)) {
            throw new Error("Delegation contract requests require only the parent Work and exact Host-issued contract reference.");
          }
          // The Host resolves and revalidates the sealed contract under its
          // writer lock; the model cannot override any of its contents.
          fields = { parent_work_id: context.work.id, contract_ref: args.contract_ref };
        }
        else {
          const summaryBytes = Buffer.byteLength(args.summary, "utf8");
          if (summaryBytes > 8_192) throw new Error("Delegation summary exceeds 8192 UTF-8 bytes.");
          // A Goal whose Host-authenticated acceptance spec names an approved
          // operations ghost must delegate to exactly that role, so the
          // structured incident operations policy reaches the real ops role.
          const operationsPolicy = context.goal.acceptance_spec?.operations_policy;
          if (operationsPolicy !== null && typeof operationsPolicy === "object" && !Array.isArray(operationsPolicy)
            && typeof operationsPolicy.approved_operations_ghost === "string"
            && args.target_ghost_id !== operationsPolicy.approved_operations_ghost) {
            throw new Error("Delegation for this Goal must target the operations ghost approved by its Host inspection; no delegate request was sent.");
          }
          fields = {
            parent_work_id: context.work.id,
            target_ghost_id: args.target_ghost_id,
            summary: args.summary,
            artifact_refs: args.artifact_refs,
            acceptance_spec: args.acceptance_spec,
          };
        }
        return command({
          ...scope,
          invocationId,
          method,
          expectedRevision: context.goal.revision,
          fields: { ...fields, ...(["work.delegate", "work.wait"].includes(method) && workMemoryContextRevision !== undefined
            ? { work_memory_context_revision: workMemoryContextRevision } : {}) },
        });
      }
      case "work.children":
        return command({ ...scope, invocationId, method, fields: { work_id: args.work_id } });
      case "conversation.reply": {
        if (typeof turnId !== "string" || turnId.length === 0
          || Object.keys(args).length !== 1 || !Object.hasOwn(args, "text") || typeof args.text !== "string") {
          throw new Error("Canonical assistant projection requires its committed owner turn and exact text argument.");
        }
        if (memoryContextRevision !== undefined && (typeof memoryContextRevision !== "string" || !/^[a-f0-9]{64}$/u.test(memoryContextRevision))) {
          throw new Error("Memory-derived reply requires its exact opaque context revision outside model arguments.");
        }
        if (memoryContextRevision === undefined) {
          const existing = await inspectCanonicalReply(scope, invocationId, turnId, args.text);
          if (existing) return existing;
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: {
            turn_id: turnId,
            ghost_id: ghostId,
            conversation_id: conversationId,
            text: args.text,
            ...(memoryContextRevision === undefined ? {} : { memory_context_revision: memoryContextRevision }),
          },
        });
      }
      case "conversation.report.reply": {
        if (typeof reportId !== "string" || reportId.length === 0 || reportId.length > 400
          || Object.keys(args).length !== 1 || !Object.hasOwn(args, "text")
          || typeof args.text !== "string" || args.text.trim().length === 0) {
          throw new Error("conversation.report.reply requires the exact outer report ID and one non-empty text argument.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: {
            report_id: reportId,
            ghost_id: ghostId,
            conversation_id: conversationId,
            text: args.text,
          },
        });
      }
      case "goal.inspect":
        return inspectGoal(scope, invocationId, args.goal_id);
      case "goal.update": {
        const inspected = await inspectGoal(scope, invocationId, args.goal_id);
        if (inspected.status !== "success") return inspected;
        const goal = inspected.data?.goal;
        if (!goal || goal.accountable_ghost !== ghostId || goal.reply_conversation !== conversationId
          || !Number.isSafeInteger(goal.revision) || goal.revision < 1) {
          throw new Error("Pi Host Goal scope changed; inspect the current Host state before updating.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          expectedRevision: goal.revision,
          fields: { goal_id: goal.id, prompt: args.prompt, acceptance_spec: args.acceptance_spec },
        });
      }
      case "registry.inspect":
        return command({ ...scope, invocationId, method, fields: {} });
      case "mailbox.send": {
        if (Buffer.byteLength(args.summary, "utf8") > 8_192) {
          throw new Error("Ghost message summary exceeds 8192 UTF-8 bytes.");
        }
        return command({
          ...scope,
          invocationId,
          method,
          fields: {
            sender_id: ghostId,
            message_id: `pi-${sha256(invocationId)}`,
            recipient_ids: args.recipient_ids,
            privacy: inferenceScope === "local" || conversationDisclosure === "non_public" ? "local_only" : "public",
            summary: args.summary,
            object_refs: args.object_refs,
          },
        });
      }
      case "mailbox.inspect":
        return command({
          ...scope,
          invocationId,
          method,
          fields: { recipient_id: ghostId, after_sequence: args.after_sequence, limit: args.limit },
        });
      default:
        throw new Error("Pi callback method is not in the frozen Host tool action space.");
    }
  };
}
