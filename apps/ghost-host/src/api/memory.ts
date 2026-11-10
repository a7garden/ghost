import { MemoryDeleteRequest, MemoryWriteRequest, parse, type MemoryView } from "@ghost/contract";
import type { Access } from "../core/access.ts";
import type { Core } from "../core/core.ts";
import { CommandError, conflict, invalid, notFound } from "../core/errors.ts";
import type { MemoryStore } from "../stores/memory.ts";

const MAX_BODY = 48 * 1024;

/** Bounded JSON body: a declared or actual size over the cap is refused before parsing. */
async function body(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw invalid("memory request body is too large");
  const reader = request.body?.getReader();
  if (!reader) throw invalid("memory JSON body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY) {
        await reader.cancel();
        throw invalid("memory request body is too large");
      }
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw invalid("malformed JSON body");
  } finally {
    reader.releaseLock();
  }
}

function routeId(raw: string): string {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw invalid("invalid memory route id");
  }
  if (id.length === 0 || id.length > 128 || id.includes("\0")) throw invalid("invalid memory route id");
  return id;
}

function revisionPath(url: URL): string {
  const path = url.searchParams.get("path") ?? "";
  if (path.length === 0 || path.length > 256) throw invalid("the path query parameter is required");
  return path;
}

/**
 * Owner routes over the Host memory store: `GET /api/memory/:ghostId`,
 * `GET /api/memory/:ghostId/revisions?path=`, `PUT`/`DELETE /api/memory/:ghostId` and
 * `POST /api/memory/:ghostId/dream`. Paired devices are owner-equivalent; every edit is
 * bound to `owner:<principal>:<requestId>`, so a replay is the same edit and a borrowed
 * request id from another device is a different, hash-checked write. Deleted and retired
 * Ghosts keep serving reads; only an active Ghost accepts edits.
 *
 * Called only after server authentication; throws CommandError for `failure()`.
 */
export async function serveMemory(
  request: Request,
  url: URL,
  core: Core,
  memory: MemoryStore | null,
  dreams: { request(ghostId: string): void } | null,
  access: Access,
): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (!memory) throw new CommandError("unavailable", "memory is not available");

  const dream = /^\/api\/memory\/([^/]+)\/dream$/.exec(url.pathname);
  if (dream !== null) {
    if (request.method !== "POST") throw notFound("memory route not found");
    const ghost = core.ledger.ghost(routeId(dream[1]!));
    if (ghost.deletedAt !== null || ghost.state !== "active") throw conflict("memory consolidation needs an active Ghost");
    if (!dreams) throw new CommandError("unavailable", "memory consolidation is not available");
    dreams.request(ghost.id);
    return json({ ok: true }, 202);
  }

  const revisions = /^\/api\/memory\/([^/]+)\/revisions$/.exec(url.pathname);
  if (revisions !== null) {
    if (request.method !== "GET") throw notFound("memory route not found");
    const ghost = core.ledger.ghost(routeId(revisions[1]!));
    return json(memory.revisions(ghost.id, revisionPath(url)));
  }

  const view = /^\/api\/memory\/([^/]+)$/.exec(url.pathname);
  if (view === null) throw notFound("memory route not found");
  const ghost = core.ledger.ghost(routeId(view[1]!));
  if (request.method === "GET") {
    return json({ files: memory.list(ghost.id), runs: memory.runs(ghost.id) } satisfies MemoryView);
  }
  if (request.method !== "PUT" && request.method !== "DELETE") throw notFound("memory route not found");
  if (ghost.deletedAt !== null) throw conflict(`${ghost.name} was deleted; its memory is read-only`);
  if (ghost.state !== "active") throw conflict(`${ghost.name} is ${ghost.state}; only an active Ghost's memory can be edited`);
  const principal = access.principal.kind === "owner" ? "owner" : `device:${access.principal.deviceId}`;
  const edit = (path: string, content: string | null, expectedHash: string | null, requestId: string) =>
    memory.write({ ghostId: ghost.id, path, content, expectedHash, actor: "owner", operationId: `owner:${principal}:${requestId}`, reason: "Owner edit" });
  if (request.method === "PUT") {
    const input = parse(MemoryWriteRequest, await body(request));
    return json(edit(input.path, input.content, input.expectedHash, input.requestId));
  }
  const input = parse(MemoryDeleteRequest, await body(request));
  return json(edit(input.path, null, input.expectedHash, input.requestId));
}
