import { createHash, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { WORK_MEMORY_TOOLS } from "./work-memory.js";
import { openPublicationContext } from "./publication-context.js";
import { ProtocolError } from "./contract.js";

export const MEMORY_CONTEXT_TOOLS = new Set(["memory_search", "memory_recall", "memory_session_list", "memory_retain", "memory_session_record"]);
const revision = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const revoked = () => new ProtocolError("memory_context_revoked", "Retained memory context cannot be authorized; stop this turn and use a fresh Owner input without the old context.", "never");

export async function openMemoryContext({ index, root, database, ghostId, conversationId, provenanceKey = conversationId, transport, resolveScope, renderSystem, filterAssignment, disclosure, workDescriptor, assignmentBoundary, publicationDescriptor }) {
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_memory_context_provenance (
    conversation_id TEXT NOT NULL, invocation_id TEXT NOT NULL, turn_id TEXT,
    anchor_entry_id INTEGER NOT NULL, context_revision TEXT, provenance_json TEXT NOT NULL,
    PRIMARY KEY (conversation_id, invocation_id)
  ); CREATE TABLE IF NOT EXISTS ghost_memory_context_boundaries (
    conversation_id TEXT PRIMARY KEY, cutoff_entry_id INTEGER NOT NULL
  )`);
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_work_memory_context_provenance (
    conversation_id TEXT NOT NULL, assignment_id TEXT NOT NULL, work_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL, anchor_entry_id INTEGER NOT NULL, context_revision TEXT,
    provenance_json TEXT NOT NULL, PRIMARY KEY (conversation_id, assignment_id, invocation_id)
  )`);
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_work_memory_effect_fences (
    conversation_id TEXT NOT NULL, assignment_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    PRIMARY KEY (conversation_id, assignment_id, invocation_id)
  )`);
  const publications = await openPublicationContext({ index, root, database, ghostId, conversationId, provenanceKey, transport, resolveScope, descriptor: publicationDescriptor, assignmentBoundary });
  let contaminated = false;
  // The append-only Pi ledger still contains original tool entries behind a
  // compaction head. Missing old provenance is deliberately unknown, never
  // inferred from the current grant or a model-authored summary.
  let cursor;
  do {
    const page = await root.commit(tx => tx.scanEntries({ conversationId: root.id, order: "ascending" }, 100, cursor), BACKGROUND_CONTEXT);
    for (const entry of page.items) for (const message of entry.model ?? []) {
      if (entry.kind !== "pi.tool-result" || (!MEMORY_CONTEXT_TOOLS.has(message.toolName) && !WORK_MEMORY_TOOLS.includes(message.toolName))) continue;
      contaminated = true;
      if (WORK_MEMORY_TOOLS.includes(message.toolName)) {
        const provenance = message.details?.context_provenance;
        if (typeof provenance?.assignment_id === "string" && typeof provenance?.work_id === "string" && typeof provenance?.invocation_id === "string") {
          const knownWork = await index.get("SELECT invocation_id FROM ghost_work_memory_context_provenance WHERE conversation_id = ? AND assignment_id = ? AND invocation_id = ?", provenanceKey, provenance.assignment_id, provenance.invocation_id);
          if (!knownWork) await index.run("INSERT OR IGNORE INTO ghost_work_memory_context_provenance VALUES (?, ?, ?, ?, ?, NULL, ?)", provenanceKey, provenance.assignment_id, provenance.work_id, `legacy-entry:${entry.id}`, entry.id, JSON.stringify({ tool: message.toolName, legacy: true }));
          continue;
        }
      }
      const known = message.details?.context_provenance?.invocation_id;
      const row = typeof known === "string" ? await index.get("SELECT invocation_id FROM ghost_memory_context_provenance WHERE conversation_id = ? AND invocation_id = ?", provenanceKey, known) : null;
      if (!row) await index.run("INSERT OR IGNORE INTO ghost_memory_context_provenance VALUES (?, ?, NULL, ?, NULL, ?)",
        provenanceKey, `legacy-entry:${entry.id}`, entry.id, JSON.stringify({ tool: message.toolName, legacy: true }));
    }
    cursor = page.next;
  } while (cursor);
  contaminated ||= Boolean(await index.get("SELECT invocation_id FROM ghost_memory_context_provenance WHERE conversation_id = ? LIMIT 1", provenanceKey));
  contaminated ||= Boolean(await index.get("SELECT invocation_id FROM ghost_work_memory_context_provenance WHERE conversation_id = ? LIMIT 1", provenanceKey));
  const cutoff = async () => (await index.get("SELECT cutoff_entry_id FROM ghost_memory_context_boundaries WHERE conversation_id = ?", provenanceKey))?.cutoff_entry_id ?? 0;
  const activeProvenance = async () => index.all("SELECT turn_id, anchor_entry_id, context_revision FROM ghost_memory_context_provenance WHERE conversation_id = ? AND anchor_entry_id >= ?", provenanceKey, await cutoff());
  const inputEntry = async scope => {
    const turn = await index.get("SELECT request_id FROM ghost_canonical_turns WHERE turn_id = ? AND conversation_id = ?", scope.turnId ?? scope.assignmentId ?? scope.activeTurnId, conversationId);
    if (!turn) return null;
    const row = await database.get("SELECT record FROM submissions WHERE conversation_id = ? AND json_extract(request_id, '$') = ?", root.id, turn.request_id);
    const record = row ? JSON.parse(row.record) : null;
    return Number.isSafeInteger(record?.entry) && record.entry > 0 ? record.entry : null;
  };
  const inspect = async scope => {
    if (scope.originKind !== "owner" || scope.inferenceScope !== "local" || typeof scope.turnId !== "string" || typeof transport !== "function") throw revoked();
    const response = await transport({ method: "memory.context.inspect", invocation_id: randomUUID(), ghost_id: ghostId, conversation_id: conversationId,
      turn_id: scope.turnId, inference_scope: scope.inferenceScope, conversation_disclosure: scope.conversationDisclosure, arguments: {} }, BACKGROUND_CONTEXT);
    if (response?.status !== "success" || response.data?.memory_permitted !== true || !revision(response.data.context_revision)) throw revoked();
    return response.data.context_revision;
  };
  const inspectWork = async scope => {
    if (scope.originKind !== "goal_assignment" || typeof transport !== "function") throw revoked();
    const response = await transport({ method: "work.memory.context.inspect", invocation_id: randomUUID(), ghost_id: ghostId, conversation_id: conversationId,
      assignment_id: scope.assignmentId, work_id: scope.workId, inference_scope: scope.inferenceScope, conversation_disclosure: scope.conversationDisclosure, arguments: {} }, BACKGROUND_CONTEXT);
    if (response?.status !== "success" || response.data?.memory_permitted !== true || !revision(response.data.context_revision)) throw revoked();
    return response.data.context_revision;
  };
  const validateMemory = async ({ rebuild = false } = {}) => {
    const rows = await activeProvenance();
    const scope = await resolveScope();
    if (scope.originKind === "goal_assignment") {
      if (await index.get("SELECT invocation_id FROM ghost_work_memory_effect_fences WHERE conversation_id = ? AND assignment_id = ? LIMIT 1", provenanceKey, scope.assignmentId)) throw revoked();
      const descriptor = workDescriptor?.();
      if (descriptor?.required && (!["ready", "requires_live_authentication"].includes(descriptor.status) || !descriptor.available_tools.includes("work_memory_recall"))) throw new ProtocolError("work_memory_required_unavailable", "This Work requires evidence whose exact read grant is unavailable.", "never");
      const workRows = await index.all("SELECT context_revision FROM ghost_work_memory_context_provenance WHERE conversation_id = ? AND assignment_id = ? AND work_id = ?", provenanceKey, scope.assignmentId, scope.workId);
      if (rows.some(row => row.context_revision === null && row.anchor_entry_id > (assignmentBoundary?.() ?? 0))) throw revoked();
      if (workRows.length || descriptor?.required) {
        const current = await inspectWork(scope);
        if (workRows.some(row => row.context_revision !== current)) throw revoked();
        if (descriptor?.required && !workRows.length) {
          const page = await root.commit(tx => tx.scanEntries({ conversationId: root.id, order: "descending" }, 1), BACKGROUND_CONTEXT);
          const anchor = page.items[0]?.id;
          if (!Number.isSafeInteger(anchor) || anchor < 1) throw revoked();
          await index.run("INSERT OR IGNORE INTO ghost_work_memory_context_provenance VALUES (?, ?, ?, ?, ?, ?, ?)", provenanceKey, scope.assignmentId, scope.workId,
            "required-admission", anchor, current, JSON.stringify({ kind: "required-evidence-admission", context_revision: current }));
          contaminated = true;
        }
      }
      return await cutoff();
    }
    const foreign = await index.all("SELECT anchor_entry_id FROM ghost_work_memory_context_provenance WHERE conversation_id = ? AND anchor_entry_id >= ?", provenanceKey, await cutoff());
    if (!rows.length && !foreign.length) return await cutoff();
    let current;
    try { current = await inspect(scope); } catch { current = null; }
    if (!foreign.length && current !== null && rows.every(row => row.context_revision === current)) return await cutoff();
    if (!rebuild || !["owner", "work_report"].includes(scope.originKind)) throw revoked();
    const entry = await inputEntry(scope);
    if (!entry || rows.some(row => row.turn_id === scope.turnId || row.anchor_entry_id >= entry) || foreign.some(row => row.anchor_entry_id >= entry)) throw revoked();
    await index.run("INSERT INTO ghost_memory_context_boundaries (conversation_id, cutoff_entry_id) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET cutoff_entry_id = excluded.cutoff_entry_id", provenanceKey, entry);
    return entry;
  };
  const validate = async (options = {}) => {
    const publicationBoundary = await publications.validate(options);
    return Math.max(publicationBoundary, await validateMemory(options));
  };
  return {
    publications,
    get contaminated() { return contaminated || publications.contaminated; },
    get requiresWorkGate() { return workDescriptor?.()?.required === true || publications.requiresGate; },
    validate,
    async filter(messages) {
      const boundary = await validate({ rebuild: true });
      const scope = await resolveScope();
      if (scope.originKind === "goal_assignment") {
        if (typeof filterAssignment !== "function") throw revoked();
        return filterAssignment(messages);
      }
      const rows = await activeProvenance();
      if (rows.length && scope.originKind === "owner") {
        const entry = await inputEntry(scope);
        if (!entry) throw revoked();
        // Any answer/tool action after this request can derive from retained
        // memory. Mark the current turn BEFORE inference, not only on recall.
        await index.run("INSERT OR IGNORE INTO ghost_memory_context_provenance VALUES (?, ?, ?, ?, ?, ?)",
          provenanceKey, `derived-turn:${scope.turnId}`, scope.turnId, entry, rows[0].context_revision,
          JSON.stringify({ kind: "derived-context", context_revision: rows[0].context_revision }));
      }
      if (!boundary) return messages;
      const view = await root.context(BACKGROUND_CONTEXT);
      const clean = view.entries.flatMap((entry, i) => entry.id >= boundary ? view.contributions[i] ?? [] : []).filter(message => message.role !== "system");
      return renderSystem ? [renderSystem(messages, scope), ...clean] : clean;
    },
    async validateDelivery(turnId, entryId) {
      await publications.validateDelivery(turnId, entryId);
      const rows = await index.all("SELECT context_revision FROM ghost_memory_context_provenance WHERE conversation_id = ? AND (turn_id = ? OR (turn_id IS NULL AND anchor_entry_id <= ?))", provenanceKey, turnId, entryId);
      if (!rows.length) return null;
      const currentDisclosure = await disclosure();
      if (currentDisclosure !== "non_public") throw revoked();
      const current = await inspect({ originKind: "owner", inferenceScope: "local", conversationDisclosure: currentDisclosure, turnId });
      if (rows.some(row => row.context_revision !== current)) throw revoked();
      return current;
    },
    async beginWorkEffect(scope, invocationId) {
      await index.run("INSERT OR IGNORE INTO ghost_work_memory_effect_fences VALUES (?, ?, ?)", provenanceKey, scope.assignmentId, invocationId);
    },
    async settleWorkEffect(scope, invocationId) {
      await index.run("DELETE FROM ghost_work_memory_effect_fences WHERE conversation_id = ? AND assignment_id = ? AND invocation_id = ?", provenanceKey, scope.assignmentId, invocationId);
    },
    async workRevision() {
      const scope = await resolveScope();
      if (scope.originKind !== "goal_assignment") return null;
      const rows = await index.all("SELECT context_revision FROM ghost_work_memory_context_provenance WHERE conversation_id = ? AND assignment_id = ? AND work_id = ?", provenanceKey, scope.assignmentId, scope.workId);
      if (!rows.length) return null;
      await validate();
      return rows[0].context_revision;
    },
    async recordWork({ name, result, api, invocationId, scope }) {
      if (!["success", "warning"].includes(result?.status)) return result;
      const stamp = result?.data?.context_revision;
      if (!revision(stamp) || await inspectWork(scope) !== stamp) throw revoked();
      const page = await root.commit(tx => tx.scanEntries({ conversationId: root.id, order: "descending" }, 1), BACKGROUND_CONTEXT);
      const anchor = page.items[0]?.id;
      if (!Number.isSafeInteger(anchor) || anchor < 1) throw revoked();
      const provenance = { invocation_id: invocationId, tool: name, task_id: api.taskId, call_id: api.callId, assignment_id: scope.assignmentId, work_id: scope.workId,
        context_revision: stamp, result_sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
      await index.run("INSERT OR IGNORE INTO ghost_work_memory_context_provenance VALUES (?, ?, ?, ?, ?, ?, ?)",
        provenanceKey, scope.assignmentId, scope.workId, invocationId, anchor, stamp, JSON.stringify(provenance));
      contaminated = true;
      return { ...result, context_provenance: provenance };
    },
    async record({ name, result, api, invocationId, scope }) {
      if (!["success", "warning"].includes(result?.status)) return result;
      const stamp = result?.data?.context_revision;
      if (!revision(stamp) || await inspect(scope) !== stamp) throw revoked();
      const page = await root.commit(tx => tx.scanEntries({ conversationId: root.id, order: "descending" }, 1), BACKGROUND_CONTEXT);
      const anchor = page.items[0]?.id;
      if (!Number.isSafeInteger(anchor) || anchor < 1) throw revoked();
      const provenance = { invocation_id: invocationId, tool: name, task_id: api.taskId, call_id: api.callId,
        context_revision: stamp, result_sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
      await index.run("INSERT OR IGNORE INTO ghost_memory_context_provenance VALUES (?, ?, ?, ?, ?, ?)",
        provenanceKey, invocationId, scope.turnId, anchor, stamp, JSON.stringify(provenance));
      contaminated = true;
      return { ...result, context_provenance: provenance };
    },
  };
}

// Pi compaction calls Models.completeSimple directly, including when a stored
// summarize checkpoint resumes without running beforeCompact again.
export function guardMemoryContextModels(models, getGuard) {
  return new Proxy(models, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (["complete", "completeSimple"].includes(property)) return (...args) => {
      if (getGuard()?.contaminated || getGuard()?.requiresWorkGate) throw new ProtocolError("memory_compaction_disabled", "Memory-derived history cannot be compacted without durable summary provenance.", "never");
      return value.apply(target, args);
    };
    if (["stream", "streamSimple"].includes(property)) return (...args) => {
      const guard = getGuard();
      if (!guard?.contaminated && !guard?.requiresWorkGate) return value.apply(target, args);
      const output = createAssistantMessageEventStream();
      const controller = new AbortController();
      const originalOptions = args[2] ?? {};
      const signal = originalOptions.signal ? AbortSignal.any([originalOptions.signal, controller.signal]) : controller.signal;
      (async () => {
        let monitor;
        try {
          signal.throwIfAborted();
          const cleanMessages = await guard.filter(args[1]?.messages ?? []);
          await guard.validate();
          signal.throwIfAborted();
          const forwarded = [...args]; forwarded[1] = { ...args[1], messages: cleanMessages }; forwarded[2] = { ...originalOptions, signal };
          const events = value.apply(target, forwarded);
          let terminal, checking = false, generatedBytes = 0;
          // Fresh authentication also stops a long in-flight inference; only
          // one monitor check can run at a time. Abort reaches the provider's
          // original transport, not merely this result buffer.
          monitor = setInterval(async () => {
            if (checking || signal.aborted) return;
            checking = true;
            try { await guard.validate(); } catch { controller.abort(); }
            finally { checking = false; }
          }, 1000);
          // Do not expose partial memory-derived text before a final fresh
          // policy check. Pi hook exceptions are advisory in the pinned SDK.
          for await (const event of events) {
            signal.throwIfAborted();
            generatedBytes += typeof event.delta === "string" ? Buffer.byteLength(event.delta, "utf8") : 0;
            const state = event.message ?? event.error ?? event.partial;
            if (generatedBytes > 4 * 1024 * 1024 || (state && Buffer.byteLength(JSON.stringify(state), "utf8") > 4 * 1024 * 1024)) throw revoked();
            if (["done", "error"].includes(event.type)) terminal = event;
          }
          const message = await events.result();
          signal.throwIfAborted();
          await guard.validate();
          signal.throwIfAborted();
          output.push(terminal ?? { type: "done", reason: message.stopReason, message });
          output.end();
        } catch {
          const model = args[0], reason = originalOptions.signal?.aborted ? "aborted" : "error";
          const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: reason, errorMessage: "Memory-derived context output was withheld because authority, cancellation or output bounds could not be satisfied.", timestamp: Date.now() };
          output.push({ type: "error", reason, error: message }); output.end();
        } finally { clearInterval(monitor); controller.abort(); }
      })();
      return output;
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
