// Opt-in disposable Pi/Host bridge. This file never discovers an installed Host,
// credentials, provider defaults, shell executable or alternate model route.
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createRegisteredModelProvider } from "../src/registered-models.js";
import { createHostToolTransport } from "../src/host-transport.js";
import { openGhostIndex } from "../src/storage.js";

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let configResolve;
const first = new Promise(resolve => { configResolve = resolve; });
const pending = new Map(); let callbackId = 0, runtime;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  if (Buffer.byteLength(line, "utf8") > 8 * 1024 * 1024) throw new Error("Bridge frame exceeds its bound.");
  const frame = JSON.parse(line);
  if (frame.type === "config") configResolve(frame);
  else if (frame.type === "callback_result" && pending.has(frame.id)) { const resolve = pending.get(frame.id); pending.delete(frame.id); resolve(frame.frame); }
});
lines.on("close", () => { for (const resolve of pending.values()) resolve({ ok: false }); pending.clear(); });

const started = Date.now(); let calls = 0, completed = false, errorCode = null;
const usedTools = new Set();
try {
  const config = await first;
  if (!isAbsolute(config.root) || !isAbsolute(config.host_root ?? config.root) || config.model !== undefined || config.assignment?.body?.method !== "conversation.assignment"
    || config.assignment.body.privacy !== "public" || !Number.isSafeInteger(config.authority_epoch) || config.authority_epoch < 1
    || !Number.isSafeInteger(config.deadline_ms) || config.deadline_ms < 1 || config.deadline_ms > 120000
    || !Array.isArray(config.expected_tools) || config.expected_tools.some(name => !["read", "write", "edit", "bash", "publish_artifact", "browser"].includes(name))) {
    throw Object.assign(new Error("Invalid explicit disposable canary config."), { code: "canary_config_invalid" });
  }
  const modelProvider = createRegisteredModelProvider({ hostRoot: config.host_root ?? config.root,
    fetchImpl: async (...args) => { calls += 1; if (calls > 12) throw new Error("Canary model-call budget exhausted."); return fetch(...args); },
    onDiagnostic: value => process.stderr.write(`${JSON.stringify({ code: value.code, name: value.name ?? null })}\n`) });
  const transport = createHostToolTransport({ hostRoot: config.host_root ?? config.root,
    callbackToken: "stdio-canary-has-no-http-credential", authorityEpoch: config.authority_epoch,
    dispatch: (request, scope) => new Promise(resolve => {
      const id = ++callbackId;
      pending.set(id, frame => {
        const method = request.envelope.body.method;
        if (method === "work.execute" && frame?.ok && frame.result?.status === "success") usedTools.add(request.envelope.body.operation);
        if (method === "work.execution.complete" && frame?.ok && frame.result?.status === "success") completed = true;
        resolve(frame);
      });
      emit({ type: "callback", id, request, inference_scope: scope?.inferenceScope ?? null });
    }) });
  runtime = await openGhostRuntime({ root: config.root, mode: "broker", modelProvider, hostToolTransport: transport,
    onDiagnostic: value => process.stderr.write(`${JSON.stringify({ code: value.code, name: value.name ?? null })}\n`) });
  const admitted = await runtime.handle(config.assignment);
  if (admitted.status !== "success") throw Object.assign(new Error("Canary assignment not admitted."), { code: admitted.error_code ?? "canary_admission_failed" });
  let timer;
  try {
    await Promise.race([runtime.waitForIdle(config.assignment.body.ghost_id, config.assignment.body.conversation_id),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Canary deadline exceeded."), { code: "canary_deadline" })), config.deadline_ms); })]);
  } finally { clearTimeout(timer); }
  const index = await openGhostIndex(config.root, config.assignment.body.ghost_id);
  let run;
  try { run = await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", config.assignment.command_id); } finally { await index.close(); }
  if (run?.status !== "answered" || !completed || config.expected_tools.some(name => !usedTools.has(name))) throw Object.assign(new Error("Live Pi task did not complete its required direct tool contract."), { code: "canary_execution_incomplete" });
} catch (error) {
  errorCode = typeof error.code === "string" && /^[a-z0-9_:-]{1,100}$/iu.test(error.code) ? error.code : "canary_failed";
  process.exitCode = 1;
} finally {
  for (const resolve of pending.values()) resolve({ ok: false }); pending.clear();
  await runtime?.close().catch(() => {});
  emit({ type: "result", status: errorCode === null ? "success" : "error", model_calls: calls, tool_names: [...usedTools], completed,
    elapsed_ms: Date.now() - started, error_code: errorCode });
  lines.close();
}
