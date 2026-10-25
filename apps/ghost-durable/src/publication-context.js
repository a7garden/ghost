import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ProtocolError } from "./contract.js";
export const PUBLICATION_TOOLS = Object.freeze(["source_view_list", "source_view_read"]);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const identity = value => typeof value === "string" && value.length > 0 && value.length <= 400;
const blocked = () => new ProtocolError("publication_context_unavailable", "Published source context cannot be revalidated; stop this generation or start a fresh Owner input that discards it.", "never");
export function validatePublicationDescriptor(value) {
  if (value === undefined || value === null) return { version: "ghost-memory-publication/1", references: [], required: false };
  if (value.version !== "ghost-memory-publication/1" || typeof value.required !== "boolean" || !Array.isArray(value.references) || value.references.length > 8
    || Object.keys(value).some(key => !["version", "references", "required"].includes(key)) || new Set(value.references.map(ref => ref?.reference)).size !== value.references.length
    || value.references.some(ref => !ref || Object.keys(ref).some(key => !["reference", "citation", "view_revision"].includes(key)) || !identity(ref.reference) || !digest(ref.view_revision)
      || typeof ref.citation !== "string" || !/^publication:\/\/[^\s/]{1,400}$/u.test(ref.citation))) throw blocked();
  return { ...value, references: value.references.map(ref => ({ ...ref })) };
}
export async function openPublicationContext({ index, root, database, ghostId, conversationId, provenanceKey = conversationId, transport, resolveScope, descriptor, assignmentBoundary }) {
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_publication_context_provenance (
    conversation_id TEXT NOT NULL, invocation_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT,
    work_id TEXT, turn_id TEXT, anchor_entry_id INTEGER NOT NULL, reference TEXT, view_revision TEXT,
    PRIMARY KEY (conversation_id, invocation_id, reference)
  ); CREATE TABLE IF NOT EXISTS ghost_publication_context_boundaries (
    conversation_id TEXT PRIMARY KEY, cutoff_entry_id INTEGER NOT NULL
  )`);
  let contaminated = false, cursor;
  do {
    const page = await root.commit(tx => tx.scanEntries({ conversationId: root.id, order: "ascending" }, 100, cursor), BACKGROUND_CONTEXT);
    for (const entry of page.items) for (const message of entry.model ?? []) {
      if (entry.kind !== "pi.tool-result" || message.toolName !== "source_view_read") continue;
      // Failed calls contain no source bytes. Successful historical results
      // without a matching durable provenance row are never assumed current.
      if (message.details?.status === "error") continue;
      contaminated = true;
      const proof = message.details?.publication_provenance;
      const known = identity(proof?.invocation_id) ? await index.get("SELECT invocation_id FROM ghost_publication_context_provenance WHERE conversation_id=? AND invocation_id=? LIMIT 1", provenanceKey, proof.invocation_id) : null;
      if (!known) await index.run("INSERT OR IGNORE INTO ghost_publication_context_provenance VALUES (?, ?, 'unknown', NULL, NULL, NULL, ?, ?, NULL)", provenanceKey, `legacy-entry:${entry.id}`, entry.id, `legacy:${entry.id}`);
    }
    cursor = page.next;
  } while (cursor);
  contaminated ||= Boolean(await index.get("SELECT invocation_id FROM ghost_publication_context_provenance WHERE conversation_id=? LIMIT 1", provenanceKey));
  const cutoff = async () => (await index.get("SELECT cutoff_entry_id FROM ghost_publication_context_boundaries WHERE conversation_id=?", provenanceKey))?.cutoff_entry_id ?? 0;
  const anchor = async () => {
    const page = await root.commit(tx => tx.scanEntries({ conversationId: root.id, order: "descending" }, 1), BACKGROUND_CONTEXT);
    const value = page.items[0]?.id;
    if (!Number.isSafeInteger(value) || value < 1) throw blocked();
    return value;
  };
  const inspect = async scope => {
    if (!["owner", "goal_assignment"].includes(scope.originKind) || scope.inferenceScope !== "local" || typeof transport !== "function") throw blocked();
    const work = scope.originKind === "goal_assignment";
    if (work ? !identity(scope.assignmentId) || !identity(scope.workId) : !identity(scope.turnId)) throw blocked();
    const response = await transport({ method: "memory.publication.context.inspect", invocation_id: randomUUID(), ghost_id: ghostId, conversation_id: conversationId,
      ...(work ? { assignment_id: scope.assignmentId, work_id: scope.workId } : { turn_id: scope.turnId }), inference_scope: scope.inferenceScope, conversation_disclosure: scope.conversationDisclosure, arguments: {} }, BACKGROUND_CONTEXT);
    const data = response?.data;
    if (response?.status !== "success" || data?.memory_permitted !== true || !digest(data.context_revision) || !Array.isArray(data.dependencies) || data.dependencies.length > 8
      || data.dependencies.some(ref => !identity(ref?.reference) || !digest(ref?.view_revision)) || new Set(data.dependencies.map(ref => ref.reference)).size !== data.dependencies.length) throw blocked();
    return data;
  };
  const matches = (rows, current) => rows.every(row => identity(row.reference) && digest(row.view_revision) && current.dependencies.some(ref => ref.reference === row.reference && ref.view_revision === row.view_revision));
  const active = async () => index.all("SELECT * FROM ghost_publication_context_provenance WHERE conversation_id=? AND anchor_entry_id>=?", provenanceKey, await cutoff());
  const inputEntry = async scope => {
    const turn = await index.get("SELECT request_id FROM ghost_canonical_turns WHERE turn_id=? AND conversation_id=?", scope.turnId ?? scope.activeTurnId, conversationId);
    if (!turn) return null;
    const row = await database.get("SELECT record FROM submissions WHERE conversation_id=? AND json_extract(request_id, '$')=?", root.id, turn.request_id);
    const record = row ? JSON.parse(row.record) : null;
    return Number.isSafeInteger(record?.entry) && record.entry > 0 ? record.entry : null;
  };
  return {
    get contaminated() { return contaminated; },
    get requiresGate() { return descriptor?.()?.required === true; },
    async validate({ rebuild = false } = {}) {
      const scope = await resolveScope(), rows = await active();
      if (scope.originKind === "goal_assignment") {
        const own = await index.all("SELECT * FROM ghost_publication_context_provenance WHERE conversation_id=? AND scope_kind='work' AND scope_id=? AND work_id=?", provenanceKey, scope.assignmentId, scope.workId);
        if (rows.some(row => row.scope_kind === "unknown" && row.anchor_entry_id > (assignmentBoundary?.() ?? 0))) throw blocked();
        if (own.length || descriptor?.()?.required) {
          const current = await inspect(scope);
          if (!matches(own, current) || (descriptor?.()?.required && !current.dependencies.length)) throw blocked();
          if (!own.length) {
            const at = await anchor();
            for (const ref of current.dependencies) await index.run("INSERT OR IGNORE INTO ghost_publication_context_provenance VALUES (?, ?, 'work', ?, ?, NULL, ?, ?, ?)", provenanceKey, `required:${scope.assignmentId}`, scope.assignmentId, scope.workId, at, ref.reference, ref.view_revision);
            contaminated = true;
          }
        }
        return await cutoff();
      }
      if (!rows.length) return await cutoff();
      const own = rows.filter(row => row.scope_kind === "owner" && row.turn_id === scope.turnId);
      if (own.length === rows.length) {
        if (!matches(own, await inspect(scope))) throw blocked();
        return await cutoff();
      }
      // A new Owner request may continue only after the complete earlier
      // source-derived history is excluded from the actual provider input.
      if (!rebuild || !["owner", "work_report"].includes(scope.originKind)) throw blocked();
      const entry = await inputEntry(scope);
      if (!entry || rows.some(row => row.turn_id === scope.turnId || row.anchor_entry_id >= entry)) throw blocked();
      await index.run("INSERT INTO ghost_publication_context_boundaries VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET cutoff_entry_id=excluded.cutoff_entry_id", provenanceKey, entry);
      return entry;
    },
    async validateDelivery(turnId, entryId) {
      const rows = await index.all("SELECT * FROM ghost_publication_context_provenance WHERE conversation_id=? AND ((scope_kind='owner' AND turn_id=?) OR (scope_kind='unknown' AND anchor_entry_id<=? AND anchor_entry_id>=?))", provenanceKey, turnId, entryId, await cutoff());
      if (rows.length && !matches(rows, await inspect({ originKind: "owner", inferenceScope: "local", turnId }))) throw blocked();
    },
    async record({ result, scope, invocationId }) {
      if (result?.status !== "success") return result;
      const view = result.data?.view, dep = result.data?.dependency;
      if (view?.state !== "current" || view.extractable !== false || view.independent_support !== false || !identity(dep?.reference) || !digest(dep?.view_revision)
        || view.version !== "source-view-publication/1" || !identity(view.publication_id) || view.citation !== `publication://${view.publication_id}`
        || Object.keys(view).some(key => !["version", "publication_id", "citation", "view_revision", "range", "bytes", "state", "extractable", "independent_support", "uncertainty"].includes(key))
        || view.view_revision !== dep.view_revision || typeof view.bytes !== "string" || Buffer.byteLength(view.bytes, "utf8") > 65536
        || view.range?.start !== 0 || view.range?.end !== Buffer.byteLength(view.bytes, "utf8") || Object.keys(view.range).length !== 2
        || !view.uncertainty || Object.keys(view.uncertainty).length !== 4 || ["contradiction_rate", "single_source_fraction", "staleness", "trust_exclusion_fraction"].some(key => !Number.isFinite(view.uncertainty[key]) || view.uncertainty[key] < 0 || view.uncertainty[key] > 1)) throw blocked();
      const current = await inspect(scope);
      if (!matches([dep], current)) throw blocked();
      const at = await anchor(), work = scope.originKind === "goal_assignment";
      await index.run("INSERT OR IGNORE INTO ghost_publication_context_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", provenanceKey, invocationId, work ? "work" : "owner", work ? scope.assignmentId : scope.turnId, work ? scope.workId : null, work ? null : scope.turnId, at, dep.reference, dep.view_revision);
      const stored = await index.get("SELECT reference, view_revision FROM ghost_publication_context_provenance WHERE conversation_id=? AND invocation_id=? AND reference=?", provenanceKey, invocationId, dep.reference);
      if (!stored || stored.view_revision !== dep.view_revision) throw blocked();
      contaminated = true;
      return { status: "success", summary: "Published source evidence; this is not independent support or accepted truth.", data: { view, dependency: { reference: dep.reference, view_revision: dep.view_revision } },
        publication_provenance: { invocation_id: invocationId, scope_kind: work ? "work" : "owner", scope_id: work ? scope.assignmentId : scope.turnId, reference: dep.reference, view_revision: dep.view_revision } };
    },
  };
}
