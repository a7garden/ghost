import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Ghost, MemoryFile, MemoryRevision } from "@ghost/contract";
import type { Config } from "../src/config.ts";
import { startServer } from "../src/api/server.ts";
import { hashSecret } from "../src/core/commands.ts";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { MemoryStore } from "../src/stores/memory.ts";
import { harness, tempDir } from "./support.ts";

/** One host under test: the memory store mounted, a paired device seeded, one active Ghost. */
interface MemoryApi {
  ledger: Ledger;
  core: Core;
  memory: MemoryStore;
  ghost: Ghost;
  request(path: string, method?: string, body?: unknown, token?: string): Promise<Response>;
  /** Ghost ids handed to the consolidation service by POST /dream. */
  requested: string[];
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

/** Omit `dreams` for the recording service; pass null to serve without one. */
function fixture(dreams?: { request(ghostId: string): void } | null): MemoryApi {
  const requested: string[] = [];
  const service = dreams === undefined ? { request: (ghostId: string) => requested.push(ghostId) } : dreams;
  const root = tempDir();
  const h = harness(join(root, "ledger.db"));
  const memory = new MemoryStore(join(root, "memory"));
  const config: Config = { root, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: "owner-test", documents: null, skills: null, memory, memoryDreams: service });
  const base = `http://127.0.0.1:${server.port}`;
  cleanup.push(async () => { await server.stop(); memory.close(); h.ledger.close(); rmSync(root, { recursive: true, force: true }); });
  h.ledger.tx(() => h.ledger.insertDevice({ id: "test-device", name: "iPhone", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: Date.now(), lastSeenAt: null }, hashSecret("device-token")));
  const ghost = h.core.createGhost({ name: "기억", persona: "" });
  const request = (path: string, method = "GET", body?: unknown, token = "owner-test") =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ledger: h.ledger, core: h.core, memory, ghost, request, requested };
}

const put = (f: MemoryApi, body: object, token = "owner-test") =>
  f.request(`/api/memory/${f.ghost.id}`, "PUT", body, token);

const revisionsOf = async (f: MemoryApi, path: string): Promise<MemoryRevision[]> =>
  (await (await f.request(`/api/memory/${f.ghost.id}/revisions?path=${encodeURIComponent(path)}`)).json()) as MemoryRevision[];

test("memory routes need a bearer token and an existing Ghost; reads work with no data", async () => {
  const f = fixture();
  expect((await f.request(`/api/memory/${f.ghost.id}`, "GET", undefined, "")).status).toBe(401);
  expect((await f.request("/api/memory/no-such-ghost")).status).toBe(404);
  const view = (await (await f.request(`/api/memory/${f.ghost.id}`)).json()) as { files: unknown[]; runs: unknown[] };
  expect(view).toEqual({ files: [], runs: [] });
});

test("an owner write creates the file, replays by requestId, and a reused requestId with other input conflicts", async () => {
  const f = fixture();
  const requestId = crypto.randomUUID();
  const first = await put(f, { path: "/me/topic.md", content: "첫 문장", expectedHash: null, requestId });
  expect(first.status).toBe(200);
  const file = (await first.json()) as MemoryFile;
  expect(file.path).toBe("/me/topic.md");
  expect(file.revision).toBe(1);
  expect(file.author).toBe("owner");

  const replay = await put(f, { path: "/me/topic.md", content: "첫 문장", expectedHash: null, requestId });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(file);

  const reused = await put(f, { path: "/me/topic.md", content: "다른 문장", expectedHash: null, requestId });
  expect(reused.status).toBe(409);
  expect(await revisionsOf(f, "/me/topic.md")).toHaveLength(1);
});

test("a paired device is owner-equivalent but cannot replay another principal's requestId into a second write", async () => {
  const f = fixture();
  const requestId = crypto.randomUUID();
  expect((await put(f, { path: "/me/d.md", content: "소유자", expectedHash: null, requestId })).status).toBe(200);
  // Same requestId from the device makes a different operation id; the create-only guard refuses it.
  const stolen = await put(f, { path: "/me/d.md", content: "도청", expectedHash: null, requestId }, "device-token");
  expect(stolen.status).toBe(409);
  const own = await put(f, { path: "/me/d2.md", content: "기기", expectedHash: null, requestId: crypto.randomUUID() }, "device-token");
  expect(own.status).toBe(200);
});

test("stale hashes conflict and invalid bodies or paths are 400", async () => {
  const f = fixture();
  const created = (await (await put(f, { path: "/me/n.md", content: "v1", expectedHash: null, requestId: crypto.randomUUID() })).json()) as MemoryFile;
  expect((await put(f, { path: "/me/n.md", content: "v2", expectedHash: "0".repeat(64), requestId: crypto.randomUUID() })).status).toBe(409);
  expect((await put(f, { path: "/me/n.md", content: "v2", expectedHash: created.hash, requestId: crypto.randomUUID() })).status).toBe(200);
  expect((await put(f, { path: "/me/n.md", content: "x", expectedHash: "zz", requestId: crypto.randomUUID() })).status).toBe(400);
  expect((await put(f, { path: "/me/../owner.md", content: "x", expectedHash: null, requestId: crypto.randomUUID() })).status).toBe(400);
  expect((await put(f, { path: "/me/note.txt", content: "x", expectedHash: null, requestId: crypto.randomUUID() })).status).toBe(400);
  expect((await put(f, { path: "/me/big.md", content: "x".repeat(32 * 1024 + 1), expectedHash: null, requestId: crypto.randomUUID() })).status).toBe(400);
  expect((await put(f, { path: "/me/huge.md", content: "x".repeat(60 * 1024), expectedHash: null, requestId: crypto.randomUUID() })).status).toBe(400);
  expect((await f.request(`/api/memory/${f.ghost.id}`, "PUT")).status).toBe(400);
  expect((await f.request(`/api/memory/${f.ghost.id}/revisions`)).status).toBe(400);
  expect((await f.request(`/api/memory/${f.ghost.id}`, "PATCH", { path: "/me/n.md" })).status).toBe(404);
});

test("delete removes the file, keeps every revision, and replays its receipt", async () => {
  const f = fixture();
  const v1 = (await (await put(f, { path: "/me/gone.md", content: "초안", expectedHash: null, requestId: crypto.randomUUID() })).json()) as MemoryFile;
  const v2 = (await (await put(f, { path: "/me/gone.md", content: "수정", expectedHash: v1.hash, requestId: crypto.randomUUID() })).json()) as MemoryFile;
  const requestId = crypto.randomUUID();
  expect((await f.request(`/api/memory/${f.ghost.id}`, "DELETE", { path: "/me/gone.md", expectedHash: v2.hash, requestId })).status).toBe(200);
  const view = (await (await f.request(`/api/memory/${f.ghost.id}`)).json()) as { files: { path: string }[] };
  expect(view.files).toEqual([]);
  const history = await revisionsOf(f, "/me/gone.md");
  expect(history.map(revision => revision.content)).toEqual(["초안", "수정", null]);
  expect((await f.request(`/api/memory/${f.ghost.id}`, "DELETE", { path: "/me/gone.md", expectedHash: v2.hash, requestId })).status).toBe(200);
  expect(await revisionsOf(f, "/me/gone.md")).toHaveLength(3);
  // A fresh delete of the now-missing file conflicts.
  expect((await f.request(`/api/memory/${f.ghost.id}`, "DELETE", { path: "/me/gone.md", expectedHash: v2.hash, requestId: crypto.randomUUID() })).status).toBe(409);
});

test("paused, retired and deleted Ghosts keep serving reads but refuse edits and consolidation", async () => {
  const f = fixture();
  const file = (await (await put(f, { path: "/me/keep.md", content: "기록", expectedHash: null, requestId: crypto.randomUUID() })).json()) as MemoryFile;
  const expectRefused = async () => {
    expect((await put(f, { path: "/me/keep.md", content: "x", expectedHash: file.hash, requestId: crypto.randomUUID() })).status).toBe(409);
    expect((await f.request(`/api/memory/${f.ghost.id}/dream`, "POST")).status).toBe(409);
  };

  f.ledger.tx(() => f.ledger.putGhost({ ...f.ghost, state: "paused", updatedAt: Date.now() }));
  const view = (await (await f.request(`/api/memory/${f.ghost.id}`)).json()) as { files: { path: string }[] };
  expect(view.files.map(row => row.path)).toEqual(["/me/keep.md"]);
  expect(await revisionsOf(f, "/me/keep.md")).toHaveLength(1);
  await expectRefused();

  f.ledger.tx(() => f.ledger.putGhost({ ...f.ghost, state: "retired", updatedAt: Date.now() }));
  expect((await f.request(`/api/memory/${f.ghost.id}`)).status).toBe(200);
  await expectRefused();

  f.ledger.tx(() => f.ledger.putGhost({ ...f.ghost, state: "retired", deletedAt: Date.now(), updatedAt: Date.now() }));
  expect((await f.request(`/api/memory/${f.ghost.id}`)).status).toBe(200);
  expect((await revisionsOf(f, "/me/keep.md")).length).toBe(1);
  await expectRefused();
});

test("manual consolidation routes to the dream service and is unavailable without one", async () => {
  const without = fixture(null);
  expect((await without.request(`/api/memory/${without.ghost.id}/dream`, "POST")).status).toBe(503);
  const f = fixture();
  expect((await f.request(`/api/memory/${f.ghost.id}/dream`, "POST")).status).toBe(202);
  expect(f.requested).toEqual([f.ghost.id]);
});
