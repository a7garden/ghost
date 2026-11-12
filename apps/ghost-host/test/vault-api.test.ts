import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { VaultItem, parse } from "@ghost/contract";
import type { Config } from "../src/config.ts";
import { startServer } from "../src/api/server.ts";
import { digestOf, idFor } from "../src/core/ids.ts";
import { hashSecret } from "../src/core/commands.ts";
import { createVault } from "../src/stores/vault.ts";
import { createVaultTools } from "../src/tools/vault.ts";
import { harness, tempDir, hostTaskId } from "./support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const root = tempDir(), ledgerPath = join(root, "ledger.db");
  const h = harness(ledgerPath), vault = createVault(root);
  const config: Config = { root, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: "owner-test", documents: null, skills: null, vault });
  const base = `http://127.0.0.1:${server.port}`;
  cleanup.push(async () => { await server.stop(); vault.close(); h.ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (path: string, method = "GET", body?: unknown, token = "owner-test") => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ghost = h.core.createGhost({ name: "Vault", persona: "" });
  const conversation = h.ledger.conversation(ghost.directConversationId);
  h.ledger.setPiConversationId(conversation.id, "pi-vault-test");
  const extension = createVaultTools(h.core, vault);
  async function tool(name: string, args: unknown, callId = name) {
    const selected = extension.tools!.find((entry) => entry.name === name)!;
    const invoke = selected.execute as (args: unknown, api: ToolExecutionApi) => Promise<unknown>;
    return invoke(args, { conversationId: "pi-vault-test", callId, taskId: hostTaskId() } as unknown as ToolExecutionApi);
  }
  return { ...h, root, ledgerPath, vault, ghost, conversation, request, tool };
}

const PASSWORD = "SYNTHETIC-owner-password-not-in-ledger", SEED = "JBSWY3DPEHPK3PXP", VALUE = "SYNTHETIC-owner-private-token";
function assertNoValues(text: string) { for (const value of [PASSWORD, SEED, VALUE, "4111111111111111", "SYNTHETIC PRIVATE CARD NAME"]) expect(text).not.toContain(value); }

test("owner routes accept write-only values, return only validated metadata, and never journal requests", async () => {
  const h = fixture();
  const created = await h.request("/api/vault/items", "POST", { kind: "login", title: "Login", origin: "https://example.com", username: "user", password: PASSWORD, totp: SEED, ghostIds: [h.ghost.id] });
  expect(created.status).toBe(201);
  const item = parse(VaultItem, await created.json()); assertNoValues(JSON.stringify(item));
  expect(h.vault.reveal(h.ghost.id, item.id, "password")).toBe(PASSWORD);
  const patch = await h.request(`/api/vault/items/${item.id}`, "PATCH", { password: VALUE, hints: "Use for testing" });
  expect(patch.status).toBe(200); assertNoValues(await patch.text());
  expect(h.vault.history(item.id).length).toBe(2);
  const card = await h.request("/api/vault/items", "POST", { kind: "card", title: "Card", card: { number: "4111111111111111", expiry: "12/30", cvc: "987", name: "SYNTHETIC PRIVATE CARD NAME" } });
  expect(card.status).toBe(201); assertNoValues(await card.text());
  const secret = await h.request("/api/vault/items", "POST", { kind: "secret", title: "Token", value: VALUE });
  expect(secret.status).toBe(201); assertNoValues(await secret.text());
  const listing = await h.request("/api/vault/items"); expect(listing.status).toBe(200); assertNoValues(await listing.text());
  const imported = await h.request("/api/vault/import", "POST", { csv: `name,url,username,password,note\nImported,https://import.example,user,${PASSWORD},\n` });
  expect(await imported.json()).toEqual({ imported: 1, skipped: 0, rejected: 0 });
  for (const input of [{ kind: "login", title: "bad", origin: "http://example.com", password: PASSWORD }, { kind: "login", title: "bad", origin: "https://example.com", password: { private: PASSWORD } }, { kind: "card", title: "bad", card: { number: PASSWORD } }]) {
    const response = await h.request("/api/vault/items", "POST", input); expect(response.status).toBe(400); assertNoValues(await response.text());
  }
  const malformed = await h.request(`/api/vault/items/${item.id}`, "PATCH", { password: null }); expect(malformed.status).toBe(400); assertNoValues(await malformed.text());
  expect((await h.request("/api/vault/items", "GET", undefined, "wrong-token")).status).toBe(401);
  expect((await h.request(`/api/vault/items/${item.id}`, "DELETE")).status).toBe(200);
  expect(() => h.vault.itemFor(h.ghost.id, item.id)).toThrow("not found");
  const db = new Database(h.ledgerPath); const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM requests").get()!; expect(count.n).toBe(0); db.exec("PRAGMA wal_checkpoint(FULL)"); db.close();
  for (const path of [h.ledgerPath, `${h.ledgerPath}-wal`]) if (existsSync(path)) assertNoValues(readFileSync(path).toString());
});

test("secure form tool to owner API to Ghost is metadata-only; ordinary answers are refused before hashing", async () => {
  const h = fixture(), callId = "secure-request";
  const result = await h.tool("vault_request", { kind: "login", title: "Account", origin: "https://EXAMPLE.com:443/", reason: "Sign in" }, callId);
  assertNoValues(JSON.stringify(result));
  const decisionId = idFor(h.conversation.id, callId), decision = h.ledger.decision(decisionId);
  expect(decision.proposal?.secureForm).toEqual({ kind: "login", title: "Account", origin: "https://example.com", reason: "Sign in" });
  await h.tool("vault_request", { kind: "login", title: "Account", origin: "https://example.com", reason: "Sign in" }, callId);
  expect(h.ledger.pendingDecisions().length).toBe(1);
  const command = { type: "decision.resolve", decisionId, outcome: "answer", answer: PASSWORD } as const;
  const refusal = await h.request("/api/commands", "POST", { requestId: idFor("test", "insecure-answer"), command });
  expect(refusal.status).toBe(409); expect(await refusal.text()).toContain("secure form");
  expect(h.ledger.request(idFor("test", "insecure-answer"))).toBeNull();
  const wrongKind = await h.request(`/api/vault/requests/${decisionId}`, "POST", { save: true, kind: "secret", title: "wrong", value: VALUE }); expect(wrongKind.status).toBe(400);
  const wrongOrigin = await h.request(`/api/vault/requests/${decisionId}`, "POST", { save: true, kind: "login", title: "wrong", origin: "https://attacker.example", password: PASSWORD }); expect(wrongOrigin.status).toBe(400);
  const before = Date.now();
  const response = await h.request(`/api/vault/requests/${decisionId}`, "POST", { save: false, kind: "login", title: "Account", password: PASSWORD, totp: SEED });
  expect(response.status).toBe(201); const item = parse(VaultItem, await response.json());
  expect(item.ghostIds).toEqual([h.ghost.id]); expect(item.expiresAt!).toBeGreaterThanOrEqual(before + 86400000);
  const resolved = h.ledger.decision(decisionId); expect(resolved.state).toBe("answered");
  expect(JSON.parse(resolved.answer!)).toEqual({ id: item.id, kind: "login", title: "Account" });
  const submission = h.engine.submissions.get(`decision:${decisionId}`)!;
  expect(submission.submission.text).toContain(item.id); assertNoValues(submission.submission.text);
  expect((await h.request(`/api/vault/requests/${decisionId}`, "POST", { save: false, kind: "login", title: "Account", password: PASSWORD })).status).toBe(409);
  expect((await h.request("/api/vault/requests/missing", "POST", { save: true })).status).toBe(404);
  const plain = h.core.decisions.ask(h.conversation.id, "Ordinary", "Question", []);
  expect((await h.request(`/api/vault/requests/${plain.id}`, "POST", { save: true, kind: "login", title: "No", password: PASSWORD })).status).toBe(400);
  const db = new Database(h.ledgerPath); db.exec("PRAGMA wal_checkpoint(FULL)"); db.close();
  for (const path of [h.ledgerPath, `${h.ledgerPath}-wal`]) if (existsSync(path)) {
    const bytes = readFileSync(path).toString(); assertNoValues(bytes); expect(bytes).not.toContain(digestOf(command));
  }
  assertNoValues(JSON.stringify(h.ledger.eventsAfter(0))); assertNoValues(JSON.stringify([...h.engine.submissions.values()]));
});

test("secure form denial works without an answer; values on a denial are also refused", async () => {
  const h = fixture(); await h.tool("vault_request", { kind: "secret", reason: "Need token" }, "deny-request");
  const decisionId = idFor(h.conversation.id, "deny-request");
  expect((await h.request("/api/commands", "POST", { requestId: idFor("test", "deny-with-value"), command: { type: "decision.resolve", decisionId, outcome: "deny", answer: VALUE } })).status).toBe(409);
  expect((await h.request("/api/commands", "POST", { requestId: idFor("test", "deny-request"), command: { type: "decision.resolve", decisionId, outcome: "deny" } })).status).toBe(200);
  expect(h.ledger.decision(decisionId).state).toBe("denied"); expect(h.engine.submissions.get(`decision:${decisionId}`)?.submission.text).toContain("declined"); expect(h.vault.list()).toEqual([]);
});

test("vault tools resolve current permissions, list hints and generate deterministic saved logins", async () => {
  const h = fixture();
  const generated = await h.tool("vault_generate_login", { origin: "https://EXAMPLE.com:443/", username: "user", title: "Generated" }, "generate");
  await h.tool("vault_generate_login", { origin: "https://example.com", username: "user", title: "Generated" }, "generate");
  await h.tool("vault_generate_login", { origin: "https://example.com", username: "user", title: "Different call" }, "generate-again");
  expect(h.vault.list().length).toBe(1); assertNoValues(JSON.stringify(generated));
  const item = h.vault.list()[0]!; h.vault.update(item.id, { hints: "Use this account" });
  const list = await h.tool("vault_list", { origin: "https://example.com", kind: "login" }); expect(JSON.stringify(list)).toContain("Use this account");
  const generatedPassword = h.vault.reveal(h.ghost.id, item.id, "password"); expect(JSON.stringify(generated)).not.toContain(generatedPassword);
  h.ledger.tx(() => h.ledger.putGhost({ ...h.ledger.ghost(h.ghost.id), tools: [] }));
  const denied = await h.tool("vault_generate_login", { origin: "https://example.com", username: "user" }, "revoked"); expect(JSON.stringify(denied)).toContain("not enabled"); expect(h.vault.list().length).toBe(1);
});

test("a crash after secure vault commit can resume without duplicating the saved value", async () => {
  const h = fixture(); await h.tool("vault_request", { kind: "secret", reason: "Need token" }, "recover");
  const decisionId = idFor(h.conversation.id, "recover"), decision = h.ledger.decision(decisionId);
  const form = { kind: "secret", origin: null, title: null, reason: "Need token" } as const;
  const first = h.vault.answerSecureForm(decisionId, decision.ghostId, form, { kind: "secret", title: "Token", value: VALUE }, true);
  const response = await h.request(`/api/vault/requests/${decisionId}`, "POST", { save: true, kind: "secret", title: "Token", value: VALUE }); expect(response.status).toBe(201);
  const item = parse(VaultItem, await response.json()); expect(item.id).toBe(first.id); expect(h.vault.list().length).toBe(1); expect(h.ledger.decision(decisionId).state).toBe("answered");
});

test("a paired device answers a secure form only through the vault route; ordinary answers stay refused", async () => {
  const h = fixture();
  await h.tool("vault_request", { kind: "secret", reason: "Need token" }, "device-form");
  const secureId = idFor(h.conversation.id, "device-form");
  const device = { id: "paired-device", name: "Phone", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: Date.now(), lastSeenAt: null };
  h.ledger.tx(() => h.ledger.insertDevice(device, hashSecret("device-token")));
  const requestId = idFor("device-answer", secureId);
  const response = await h.request("/api/commands", "POST", { requestId, command: { type: "decision.resolve", decisionId: secureId, outcome: "answer", answer: PASSWORD } }, "device-token");
  expect(response.status).toBe(409);
  assertNoValues(await response.text());
  expect(h.ledger.request(requestId)).toBeNull();
  expect(h.ledger.decision(secureId).state).toBe("pending");
  const vaultRoute = await h.request(`/api/vault/requests/${secureId}`, "POST", { save: true, kind: "secret", title: "Token", value: VALUE }, "device-token");
  expect(vaultRoute.status).toBe(201);
  const item = parse(VaultItem, await vaultRoute.json());
  assertNoValues(JSON.stringify(item));
  expect(h.ledger.decision(secureId).state).toBe("answered");
});
