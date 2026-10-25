// Acceptance-only accounting. Never serialize requests, completions or secrets.
import { createHash } from 'node:crypto';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const MAX_PROJECTED_REQUEST_BYTES = 1024 * 1024;
const KNOWN_GHOST_TOOLS = new Set([
  'source_view_list', 'source_view_read', 'work_memory_recall', 'work_memory_record',
  'read', 'write', 'edit', 'bash', 'publish_artifact', 'browser',
  'work_submit', 'work_inspect', 'work_steer', 'work_cancel', 'goal_inspect',
  'task_contract_inspect', 'goal_create', 'goal_update',
  'memory_search', 'memory_recall', 'memory_session_list', 'memory_retain', 'memory_session_record',
  'document_list_spaces', 'document_list_pages', 'document_read_page', 'document_review_page', 'document_inspect_review',
  'bot_prepare', 'bot_evaluate', 'bot_activate', 'bot_repair', 'registry_inspect',
  'work_delegate', 'work_wait', 'work_children', 'ghost_message', 'ghost_messages',
]);
const OWNER_SCOPE_MARKER = 'Current authenticated input kind: owner. Turn ID: ';
const OWNER_TASK_MARKER = 'The Host confirms the actual Owner selected this current task: ';
const OWNER_TASK_END = '. Its immutable input is already supplied through the registered task';

// Observes the actual outbound body after provider conversion. This is a
// diagnostic, never evidence that the descriptor or offered tools have authority.
function requestProjection(raw) {
  const unknown = {
    version: 'ghost-outbound-observation/1', diagnostic_only: true, state: 'unknown',
    offered_tool_count: null, known_tool_names: null, unknown_tool_count: null,
    system_message_count: null, owner_task_descriptor_present: null, owner_task_descriptor_sha256: null,
  };
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PROJECTED_REQUEST_BYTES) return unknown;
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256
      || body.messages.some(message => !message || typeof message !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role))) return unknown;
    const tools = body.tools === undefined ? [] : body.tools;
    if (!Array.isArray(tools) || tools.length > 128
      || tools.some(tool => !tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name.length)) return unknown;
    const systems = body.messages.filter(message => message.role === 'system');
    if (systems.some(message => typeof message.content !== 'string')) return unknown;
    const known = new Set(); let unknownCount = 0, descriptor = null;
    for (const tool of tools) {
      if (KNOWN_GHOST_TOOLS.has(tool.function.name)) known.add(tool.function.name);
      else unknownCount++;
    }
    for (const message of systems) {
      const text = message.content, marker = text.indexOf(OWNER_TASK_MARKER);
      if (marker < 0) continue;
      const open = text.indexOf('<ghost-controller>'), close = text.indexOf('</ghost-controller>', open);
      const scope = text.indexOf(OWNER_SCOPE_MARKER, open);
      const end = text.indexOf(OWNER_TASK_END, marker + OWNER_TASK_MARKER.length);
      if (descriptor !== null || open < 0 || close < 0 || scope < open || marker < scope || end > close
        || end < marker || text.indexOf(OWNER_TASK_MARKER, marker + OWNER_TASK_MARKER.length) !== -1) return unknown;
      const encoded = text.slice(marker + OWNER_TASK_MARKER.length, end);
      if (Buffer.byteLength(encoded, 'utf8') > 512) return unknown;
      const value = JSON.parse(encoded);
      if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).sort().join(',') !== 'input_digest,mode,task_contract_ref'
        || typeof value.task_contract_ref !== 'string' || typeof value.input_digest !== 'string'
        || !/^ot-[a-f0-9]{64}$/u.test(value.task_contract_ref)
        || !['direct', 'delegate'].includes(value.mode)
        || !/^[a-f0-9]{64}$/u.test(value.input_digest)) return unknown;
      descriptor = createHash('sha256').update(JSON.stringify({ input_digest: value.input_digest, mode: value.mode, task_contract_ref: value.task_contract_ref })).digest('hex');
    }
    return {
      ...unknown, state: 'observed', offered_tool_count: tools.length,
      known_tool_names: [...known].sort(), unknown_tool_count: unknownCount,
      system_message_count: systems.length, owner_task_descriptor_present: descriptor !== null,
      owner_task_descriptor_sha256: descriptor,
    };
  } catch { return unknown; }
}
export function createInferenceMeter(fetchImpl, { maxCalls = 40, maxBytes = 8 * 1024 * 1024 } = {}) {
  const attempts = [], diagnostics = [];
  return {
    async fetch(...args) {
      if (attempts.length >= maxCalls) throw new Error('A20 inference budget exhausted');
      const rawBody = args[1]?.body;
      const attempt = { id: attempts.length + 1, request_digest: typeof rawBody === 'string' ? createHash('sha256').update(rawBody).digest('hex') : null, request_projection: requestProjection(rawBody), elapsed_ms: 0, http_status: null, prompt_tokens: null, completion_tokens: null, cached_prompt_tokens: null, outcome: 'transport_error' };
      attempts.push(attempt); const started = performance.now();
      try {
        const response = await fetchImpl(...args); attempt.http_status = response.status;
        let size = 0; const chunks = [];
        for await (const chunk of response.clone().body ?? []) { size += chunk.length; if (size > maxBytes) throw new Error('A20 usage response exceeds bound'); chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); attempt.response_json = 'valid'; }
        catch { body = null; attempt.response_json = 'invalid'; }
        const choice = body?.choices?.[0], message = choice?.message;
        attempt.finish_reason = ['stop', 'length', 'tool_calls', 'content_filter'].includes(choice?.finish_reason) ? choice.finish_reason : null;
        attempt.response_bytes = size;
        attempt.content_bytes = typeof message?.content === 'string' ? Buffer.byteLength(message.content) : null;
        const calls = message?.tool_calls;
        attempt.tool_call_count = Array.isArray(calls) ? calls.length : null;
        attempt.tool_argument_bytes = Array.isArray(calls) && calls.every(call => typeof call?.function?.arguments === 'string')
          ? calls.reduce((sum, call) => sum + Buffer.byteLength(call.function.arguments), 0) : null;
        attempt.tool_argument_json = Array.isArray(calls) ? calls.every(call => {
          try { const value = JSON.parse(call?.function?.arguments); return value !== null && typeof value === 'object' && !Array.isArray(value); }
          catch { return false; }
        }) ? 'valid_objects' : 'invalid' : 'absent';
        attempt.prompt_tokens = count(body?.usage?.prompt_tokens);
        attempt.completion_tokens = count(body?.usage?.completion_tokens);
        attempt.cached_prompt_tokens = count(body?.usage?.prompt_tokens_details?.cached_tokens);
        attempt.outcome = response.ok ? 'response' : 'http_error';
        return response;
      } finally { attempt.elapsed_ms = Math.max(0, Math.round(performance.now() - started)); }
    },
    recordProviderDiagnostic(value) {
      if (diagnostics.length >= maxCalls * 2) return;
      const safe = {};
      for (const key of ['code', 'reason', 'finish_reason']) {
        if (typeof value?.[key] === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(value[key])) safe[key] = value[key];
      }
      for (const key of ['elapsed_ms', 'http_status', 'request_bytes', 'requested_max_tokens', 'exposed_tools', 'choices', 'content_chars', 'tool_calls', 'prompt_tokens', 'completion_tokens']) {
        if (count(value?.[key]) !== null) safe[key] = value[key];
      }
      diagnostics.push(safe);
    },
    snapshot() {
      const missing = attempts.filter(attempt => attempt.prompt_tokens === null || attempt.completion_tokens === null).length;
      const requestDigests = attempts.map(attempt => attempt.request_digest).filter(digest => digest !== null);
      return { model_calls: attempts.length, identical_http_request_repeats: requestDigests.length - new Set(requestDigests).size, usage_missing_calls: missing,
        prompt_tokens: missing ? null : attempts.reduce((sum, attempt) => sum + attempt.prompt_tokens, 0),
        completion_tokens: missing ? null : attempts.reduce((sum, attempt) => sum + attempt.completion_tokens, 0),
        known_prompt_tokens: attempts.reduce((sum, attempt) => sum + (attempt.prompt_tokens ?? 0), 0),
        known_completion_tokens: attempts.reduce((sum, attempt) => sum + (attempt.completion_tokens ?? 0), 0),
        provider_diagnostics: structuredClone(diagnostics), cost_usd: null, cost_basis: 'self_host_resource_cost_unmeasured', attempts: structuredClone(attempts) };
    },
  };
}
