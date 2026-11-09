import { SecureFormRequest, validate } from "@ghost/contract";
import type { Access } from "../core/access.ts";
import type { Core } from "../core/core.ts";
import { CommandError, conflict, forbidden, invalid, notFound } from "../core/errors.ts";
import { Vault, type VaultInput } from "../stores/vault.ts";

const MAX_BODY = 8 * 1024 * 1024;
/** Unlike commands, this bounded write-only input never enters receipts, digests, events or logs. */
async function body(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw invalid("vault request body is too large");
  if (!request.body) throw invalid("vault JSON body is required");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw invalid("vault request body is too large"); }
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks);
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("invalid vault JSON body");
      return value as Record<string, unknown>;
    } finally { bytes.fill(0); }
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw invalid("invalid vault JSON body");
  } finally { for (const chunk of chunks) chunk.fill(0); reader.releaseLock(); }
}

function routeId(raw: string): string {
  let id: string;
  try { id = decodeURIComponent(raw); } catch { throw invalid("invalid vault request id"); }
  if (!id.length || id.length > 128 || id.includes("\0")) throw invalid("invalid vault request id");
  return id;
}

/** Called only after server authentication; every route independently requires the owner. */
export async function serveVault(request: Request, url: URL, access: Access, core: Core, vault: Vault | null): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    if (!access.isOwner) throw forbidden("vault access requires the owner");
    if (!vault) throw new CommandError("unavailable", "vault is not available");
    const path = url.pathname;
    if (path === "/api/vault/items") {
      if (request.method === "GET") return json({ items: vault.list() });
      if (request.method === "POST") return json(vault.create(await body(request) as unknown as VaultInput), 201);
    }
    const itemMatch = /^\/api\/vault\/items\/([^/]+)$/.exec(path);
    if (itemMatch) {
      const id = routeId(itemMatch[1]!);
      if (request.method === "PATCH") return json(vault.update(id, await body(request)));
      if (request.method === "DELETE") { vault.remove(id); return json({ ok: true }); }
    }
    if (path === "/api/vault/import" && request.method === "POST") {
      const input = await body(request);
      if (Object.keys(input).some((key) => key !== "csv") || typeof input.csv !== "string") throw invalid("vault import requires CSV");
      return json(vault.importCsv(input.csv));
    }
    const formMatch = /^\/api\/vault\/requests\/([^/]+)$/.exec(path);
    if (formMatch && request.method === "POST") {
      const input = await body(request), decisionId = routeId(formMatch[1]!);
      if (typeof input.save !== "boolean") throw invalid("secure form requires a save choice");
      const decision = core.ledger.findDecision(decisionId);
      if (!decision) throw notFound("secure form decision not found");
      if (decision.state !== "pending") throw conflict("secure form decision is no longer pending");
      const form = decision.proposal?.secureForm;
      if (decision.kind !== "question" || !validate(SecureFormRequest, form)) throw invalid("decision is not a secure form request");
      const { save, ...fields } = input;
      const item = vault.answerSecureForm(decisionId, decision.ghostId, form, fields as unknown as VaultInput, save);
      core.decisions.resolveSecureFormState(decisionId, item);
      await core.run(`decision:${decisionId}`, () => core.decisions.finishResolution(decisionId));
      return json(item, 201);
    }
    throw notFound("vault route not found");
  } catch (error) {
    if (error instanceof CommandError) {
      const statuses = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 };
      return json({ ok: false, error: { code: error.code, message: error.message } }, statuses[error.code]);
    }
    // SQLite/JSON/URI/engine errors must never cross this write-only boundary or be logged.
    return json({ ok: false, error: { code: "internal", message: "vault request failed" } }, 500);
  }
}
