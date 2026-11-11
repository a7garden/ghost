import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewOf, type Connection, type Conversation, type Ghost } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Core } from "../src/core/core.ts";
import { SourceConnections, validateConnectionConfig, type ActivitySourceFetch } from "../src/integrations/activity-sources.ts";
import type { BrowserHandoffEnd, BrowserPort, BrowserSessionRef } from "../src/integrations/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { createVault, type Vault } from "../src/stores/vault.ts";
import { createToolSet } from "../src/tools/index.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const TOKEN = "notion-secret-token-abc123";
const API_CONFIG = { kind: "api" as const, baseUrl: "https://api.notion.com/v1", authHeader: "Authorization", authPrefix: "Bearer", testPath: "/users/me", headers: { "Notion-Version": "2025-09-03" }, ghostIds: [] as string[] };
/** A public https literal so Ghost-created registrations never depend on DNS in tests. */
const PUBLIC_API_CONFIG = { ...API_CONFIG, baseUrl: "https://198.51.100.10/v1" };

/** One api fixture: correct headers, writes recorded, and an endpoint that echoes the credential to test redaction. */
function notionFetch(requests: { path: string; method: string; auth: string | null }[], writes: { path: string; method: string }[]): ActivitySourceFetch {
  return (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const auth = init?.headers ? new Headers(init.headers).get("authorization") : null;
    requests.push({ path: url.pathname, method: init?.method ?? "GET", auth });
    if (auth !== `Bearer ${TOKEN}`) return new Response("nope", { status: 401 });
    if (init?.method && init.method !== "GET") {
      writes.push({ path: url.pathname, method: init.method });
      return Response.json({ object: "page", id: "page-9" }, { status: 201 });
    }
    if (url.pathname === "/v1/echo") return Response.json({ object: "user", id: "user-1", echoed: `Bearer ${TOKEN}` });
    return Response.json({ object: "user", id: "user-1", name: "Garden" });
  }) as ActivitySourceFetch;
}

/** The Ghost-side browser, fake enough for origin binding and ref capture. */
class FakeBrowser implements BrowserPort {
  url = "https://notion.so/my-keys";
  value = TOKEN;
  readonly commands: string[][] = [];
  async captureCredential(_session: BrowserSessionRef, input: { origin: string; ref?: string; selector?: string }) {
    if (new URL(this.url).origin !== input.origin) throw new Error("origin changed");
    return this.value;
  }
  async run(_session: BrowserSessionRef, argv: string[]) {
    this.commands.push([...argv]);
    if (argv[0] === "focus") return { ok: true, data: null, error: null };
    if (argv[0] === "eval") {
      const origin = new URL(this.url).origin;
      return { ok: true, data: { result: argv[1]?.includes("document.activeElement") ? JSON.stringify({ origin, value: this.value }) : origin }, error: null };
    }
    return { ok: false, data: null, error: "unexpected command" };
  }
  async handoff() {}
  sessions() { return []; }
  async live(): Promise<() => void> { throw new Error("not used by account capture fixtures"); }
  async input(): Promise<void> { throw new Error("not used by account capture fixtures"); }
  async endHandoff(): Promise<BrowserHandoffEnd> { return { fallback: false }; }
  async close() {}
  async shutdown() {}
}

interface Setup {
  root: string;
  core: Core;
  ledger: Ledger;
  engine: FakeEngine;
  ghost: Ghost;
  other: Ghost;
  tools: ToolSet;
  sources: SourceConnections;
  browser: FakeBrowser;
  vault: Vault;
  connection: Connection;
  requests: { path: string; method: string; auth: string | null }[];
  writes: { path: string; method: string }[];
  pi: string;
  close(): void;
}

const apiOf = (piConversationId: string, callId: string): ToolExecutionApi =>
  ({ conversationId: piConversationId, callId, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;
const testContext = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;
async function call(tool: { execute: (args: never, api: ToolExecutionApi, context: Context) => Promise<ToolExecutionResult> }, args: unknown, api: ToolExecutionApi): Promise<ToolExecutionResult> {
  return tool.execute(args as never, api, testContext());
}
function contentOf(result: ToolExecutionResult): string {
  return (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
}
function toolOf(setup: Setup, conversation: Conversation, ghost: Ghost, name: string) {
  for (const extension of setup.tools.extensionsFor(conversation, ghost, null)) {
    const found = extension.tools?.find((candidate) => candidate.name === name);
    if (found) return found;
  }
  throw new Error(`${name} is not visible to a ${conversation.kind} conversation`);
}
/** Every persisted effect and decision row that still carries the raw secret. */
function leaks(setup: Setup, secret: string): string[] {
  const hits: string[] = [];
  for (const state of ["pending", "done", "denied", "unknown"] as const) {
    for (const effect of setup.ledger.effectsInState(state)) {
      if (JSON.stringify(effect).includes(secret)) hits.push(`effect ${effect.id} (${state})`);
    }
  }
  for (const decision of setup.ledger.pendingDecisions()) {
    if (JSON.stringify(decision).includes(secret)) hits.push(`decision ${decision.id}`);
  }
  return hits;
}

function setup(fetch?: ActivitySourceFetch): Setup {
  const root = mkdtempSync(join(tmpdir(), "ghost-connections-"));
  const requests: Setup["requests"] = [];
  const writes: Setup["writes"] = [];
  const ledger = new Ledger(":memory:");
  const sources = new SourceConnections({ root, fetch: fetch ?? notionFetch(requests, writes), currentConnection: (id) => ledger.findConnection(id) });
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), activitySources: sources, log: () => {} });
  const engine = new FakeEngine();
  core.attach(engine);
  const browser = new FakeBrowser();
  const vault = createVault(root);
  const tools = createToolSet({ core, sandbox: {} as never, memory: null, documents: null, skills: null, vault, browser });
  const ghost = core.createGhost({ name: "Garden", persona: "", model: { provider: "test", model: "test-model" } });
  const other = core.createGhost({ name: "Other", persona: "" });
  const connection: Connection = { id: "notion", name: "Notion", config: { ...API_CONFIG, ghostIds: [ghost.id] }, hasCredential: true, credentialVersion: "cred-1", createdAt: 1, updatedAt: 1 };
  ledger.tx(() => ledger.putConnection(connection));
  void sources.setCredential("notion", TOKEN, "cred-1");
  const pi = "pi-direct";
  ledger.setPiConversationId(ghost.directConversationId, pi);
  ledger.setPiConversationId(other.directConversationId, "pi-other");
  return {
    root, core, ledger, engine, ghost, other, tools, sources, browser, vault, connection, requests, writes, pi,
    close() { core.stop(); void core.idle().then(() => { ledger.close(); vault.close(); rmSync(root, { recursive: true, force: true }); }); },
  };
}

async function resolveOwner(setup: Setup, effectId: string, outcome: "approve" | "deny") {
  const decision = setup.ledger.pendingDecisions({ effectId }).find((entry) => entry.kind === "approve_effect");
  if (!decision) throw new Error("no pending approval decision");
  await setup.core.decisions.resolve(decision.id, { outcome }, "owner");
  await setup.core.idle();
  return decision.id;
}

describe("connection tools", () => {
  test("connection_list exposes metadata only, never credentials or endpoint secrets", async () => {
    const s = setup();
    try {
      const listed = await call(toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_list"), {}, apiOf(s.pi, "list-1"));
      expect(listed.isError).toBeFalsy();
      const rows = JSON.parse(contentOf(listed));
      expect(rows).toContainEqual(expect.objectContaining({ id: "notion", kind: "api", hasCredential: true, apiGranted: true }));
      expect(contentOf(listed)).not.toContain(TOKEN);
      expect(contentOf(listed)).not.toContain("Bearer");
      const other = await call(toolOf(s, s.ledger.conversation(s.other.directConversationId), s.other, "connection_list"), {}, apiOf("pi-other", "list-2"));
      expect(JSON.parse(contentOf(other))).toContainEqual(expect.objectContaining({ id: "notion", apiGranted: false }));
    } finally { s.close(); }
  });

  test("GET reads run at once, redact the credential, and confine escapes to the configured origin", async () => {
    const s = setup();
    try {
      const request = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_request");
      const read = await call(request, { connection_id: "notion", method: "GET", path: "/users/me" }, apiOf(s.pi, "get-1"));
      expect(read.isError).toBeFalsy();
      expect(s.requests.at(-1)).toMatchObject({ path: "/v1/users/me", method: "GET", auth: `Bearer ${TOKEN}` });
      // Notion-Version rides along from configuration only.
      expect(s.writes).toHaveLength(0);
      const echo = await call(request, { connection_id: "notion", method: "GET", path: "/v1/echo" }, apiOf(s.pi, "get-2"));
      expect(echo.isError).toBeFalsy();
      expect(contentOf(echo)).toContain("[redacted]");
      expect(contentOf(echo)).not.toContain(TOKEN);
      expect(contentOf(echo)).toContain("Untrusted connection response");
      for (const path of ["//evil.com/x", "https://evil.com/x", "/v1/users/me#frag", "/a b", "/v1/../../evil"]) {
        const refused = await call(request, { connection_id: "notion", method: "GET", path }, apiOf(s.pi, `escape:${path}`));
        expect(refused.isError, path).toBe(true);
        expect(s.requests.every((entry) => new URL(`https://api.notion.com${entry.path}`).pathname.startsWith("/v1/"))).toBe(true);
      }
      const ungranted = await call(request, { connection_id: "notion", method: "GET", path: "/users/me" }, apiOf("pi-other", "get-other"));
      expect(ungranted.isError).toBe(true);
      expect(contentOf(ungranted)).toContain("not granted");
    } finally { s.close(); }
  });

  test("writes wait for owner approval, run exactly once, and are not main-settleable", async () => {
    const s = setup();
    try {
      const request = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_request");
      const proposed = await call(request, { connection_id: "notion", method: "POST", path: "/v1/pages", body: JSON.stringify({ page: "Plan" }), reason: "새 페이지 생성" }, apiOf(s.pi, "post-1"));
      expect(proposed.isError).toBeFalsy();
      expect(contentOf(proposed)).toContain("awaiting owner approval");
      expect(s.writes).toHaveLength(0);
      const decision = s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!;
      expect(decision.kind).toBe("approve_effect");
      expect(s.core.decisions.reversible(decision)).toBe(false);
      expect(reviewOf(decision.proposal)).toBeNull();
      const effectId = decision.effectId!;
      const resolvedId = await resolveOwner(s, effectId, "approve");
      expect(s.writes).toEqual([{ path: "/v1/pages", method: "POST" }]);
      const settled = s.ledger.decision(resolvedId);
      expect(settled.state).toBe("approved");
      expect(JSON.stringify(settled)).not.toContain(TOKEN);
      const notified = s.engine.to(s.ghost.directConversationId).at(-1);
      expect(notified?.text).toContain("HTTP 201");
      // A retry of the same call replays the recorded outcome instead of writing again.
      const replay = await call(request, { connection_id: "notion", method: "POST", path: "/v1/pages", body: JSON.stringify({ page: "Plan" }) }, apiOf(s.pi, "post-1"));
      expect(replay.isError).toBeFalsy();
      expect(s.writes).toHaveLength(1);
      expect(leaks(s, TOKEN)).toEqual([]);
    } finally { s.close(); }
  });

  test("revoked grants and revoked credentials stop in-flight approvals and later calls honestly", async () => {
    const s = setup();
    try {
      const request = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_request");
      const proposed = await call(request, { connection_id: "notion", method: "PUT", path: "/v1/pages/page-9", body: "{}" }, apiOf(s.pi, "put-1"));
      expect(proposed.isError).toBeFalsy();
      const decision = s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!;
      // The owner removes the Ghost's grant while the approval waits.
      s.ledger.tx(() => s.ledger.putConnection({ ...s.connection, config: { ...API_CONFIG, ghostIds: [] }, updatedAt: Date.now() }));
      await resolveOwner(s, decision.effectId!, "approve");
      expect(s.writes).toHaveLength(0);
      const denied = s.ledger.pendingDecisions({ effectId: decision.effectId! });
      const settled = s.ledger.effectsInState("denied").find((effect) => effect.id === decision.effectId);
      expect(settled?.state).toBe("denied");
      expect(denied).toHaveLength(0);
      const refused = await call(request, { connection_id: "notion", method: "GET", path: "/users/me" }, apiOf(s.pi, "get-revoked"));
      expect(refused.isError).toBe(true);
      // Credential removal stops even a granted call.
      s.ledger.tx(() => s.ledger.putConnection({ ...s.connection, config: { ...API_CONFIG, ghostIds: [s.ghost.id] }, hasCredential: false, credentialVersion: null, updatedAt: Date.now() }));
      await s.sources.setCredential("notion", null, null);
      const noCredential = await call(request, { connection_id: "notion", method: "GET", path: "/users/me" }, apiOf(s.pi, "get-nocred"));
      expect(noCredential.isError).toBe(true);
      expect(s.requests.every((entry) => entry.auth === `Bearer ${TOKEN}`)).toBe(true);
    } finally { s.close(); }
  });

  test("activity policy deny blocks writes but keeps reads", async () => {
    const s = setup();
    try {
      const activity = s.core.activities.create({
        ghostId: s.ghost.id, name: "Watch Notion", prompt: "Check the workspace.", acceptanceCriteria: "Report changes.",
        execution: { kind: "container" }, tools: ["connection_request"],
        source: { kind: "schedule", spec: { kind: "every", seconds: 3600, startAt: Date.now() } },
        policy: { maxRunsPerDay: 5, maxConcurrent: 1, runTimeoutSeconds: 300, allowSelfCheck: false, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" },
      });
      const outcome = await s.core.activities.run(activity.id, {});
      await s.core.idle();
      const run = s.ledger.findActivityRun(outcome.runIds[0]!)!;
      const work = s.ledger.work(run.workId!);
      const conversation = s.ledger.conversation(work.conversationId!);
      const pi = "pi-activity";
      s.ledger.setPiConversationId(conversation.id, pi);
      const request = toolOf(s, conversation, s.ghost, "connection_request");
      const write = await call(request, { connection_id: "notion", method: "POST", path: "/v1/pages", body: "{}" }, apiOf(pi, "post-deny"));
      expect(write.isError).toBe(true);
      expect(s.writes).toHaveLength(0);
      const read = await call(request, { connection_id: "notion", method: "GET", path: "/users/me" }, apiOf(pi, "get-deny"));
      expect(read.isError).toBeFalsy();
    } finally { s.close(); }
  });

  test("registration from a granted vault item stores the secret without any transcript leak", async () => {
    const s = setup();
    try {
      const item = s.vault.create({ kind: "secret", title: "Notion integration token", value: TOKEN, ghostIds: [s.ghost.id] });
      const register = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_register");
      const proposed = await call(register, { name: "Notion", service_id: "notion", icon_url: `/api/artifacts/${"a".repeat(64)}`, config: PUBLIC_API_CONFIG, secret: { source: "vault", item_id: item.id, field: "value" } }, apiOf(s.pi, "reg-1"));
      expect(proposed.isError).toBeFalsy();
      const decision = s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!;
      expect(decision.detail).toContain("https://198.51.100.10");
      expect(JSON.stringify(decision)).not.toContain(TOKEN);
      expect(s.core.decisions.reversible(decision)).toBe(false);
      const resolvedId = await resolveOwner(s, decision.effectId!, "approve");
      const stored = s.ledger.connections().find(connection => connection.id !== s.connection.id && connection.serviceId === "notion")!;
      expect(stored).toMatchObject({ name: "Notion", serviceId: "notion", hasCredential: true });
      expect(stored.credentialVersion).not.toBe("cred-1");
      expect(s.sources.credentialPresent(stored.id)).toBe(true);
      const settled = s.ledger.decision(resolvedId);
      expect(JSON.stringify(settled)).not.toContain(TOKEN);
      const listed = await call(toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_list"), {}, apiOf(s.pi, "list-3"));
      expect(contentOf(listed)).toContain("\"serviceId\":\"notion\"");
      expect(leaks(s, TOKEN)).toEqual([]);
      // A revoked vault item refuses at approval time.
      const second = s.vault.create({ kind: "secret", title: "Second token", value: "second-secret-value-token", ghostIds: [s.ghost.id] });
      const proposed2 = await call(register, { name: "Notion", config: PUBLIC_API_CONFIG, secret: { source: "vault", item_id: second.id, field: "value" } }, apiOf(s.pi, "reg-2"));
      expect(proposed2.isError).toBeFalsy();
      s.vault.update(second.id, { ghostIds: [] });
      await resolveOwner(s, s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!.effectId!, "approve");
      const denied = s.ledger.effectsInState("denied").at(-1)!;
      expect(denied.result).toContain("vault");
    } finally { s.close(); }
  });

  test("browser capture binds the explicit credential origin before and after approval and never exposes the value", async () => {
    const s = setup();
    try {
      const register = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_register");
      s.browser.url = "https://other.example/keys";
      const wrongPage = await call(register, { name: "Notion", config: PUBLIC_API_CONFIG, ghost_ids: [s.ghost.id], secret: { source: "browser", ref: "@e5", credential_origin: "https://notion.so" } }, apiOf(s.pi, "reg-page-1"));
      expect(wrongPage.isError).toBe(true);
      s.browser.url = "https://notion.so/my-keys";
      const proposed = await call(register, { name: "Notion", service_id: "notion", config: PUBLIC_API_CONFIG, ghost_ids: [s.ghost.id], secret: { source: "browser", ref: "@e5", credential_origin: "https://notion.so" } }, apiOf(s.pi, "reg-page-2"));
      expect(proposed.isError).toBeFalsy();
      const decision = s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!;
      expect(decision.detail).toContain("https://notion.so");
      expect(decision.detail).toContain("https://198.51.100.10");
      expect(JSON.stringify(decision)).not.toContain(TOKEN);
      // The page navigated away while the approval waited: capture refuses honestly.
      s.browser.url = "https://mail.google.com/mail";
      await resolveOwner(s, decision.effectId!, "approve");
      const denied = s.ledger.effectsInState("denied").find((effect) => effect.id === decision.effectId)!;
      expect(denied.state).toBe("denied");
      expect(s.ledger.connections().every((connection) => connection.createdAt === 1)).toBe(true);
      // Back on the issuer page: approval captures through the Host only.
      s.browser.url = "https://notion.so/my-keys";
      const proposed2 = await call(register, { name: "Notion", config: PUBLIC_API_CONFIG, ghost_ids: [s.ghost.id], secret: { source: "browser", ref: "@e5", credential_origin: "https://notion.so" } }, apiOf(s.pi, "reg-page-3"));
      expect(proposed2.isError).toBeFalsy();
      await resolveOwner(s, s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!.effectId!, "approve");
      const created = s.ledger.connections().find((connection) => connection.name === "Notion" && connection.createdAt !== 1)!;
      expect(created.config.kind).toBe("api");
      expect((created.config as typeof API_CONFIG).ghostIds).toEqual([s.ghost.id]);
      expect(s.sources.credentialPresent(created.id)).toBe(true);
      expect(leaks(s, TOKEN)).toEqual([]);
      const read = await call(toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_request"), { connection_id: created.id, method: "GET", path: "/users/me" }, apiOf(s.pi, "get-new"));
      expect(read.isError).toBeFalsy();
    } finally { s.close(); }
  });

  test("Ghost registration requires a public https endpoint and leaves private or plain-HTTP to the owner", async () => {
    const s = setup();
    try {
      const register = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_register");
      for (const baseUrl of ["http://100.81.146.46:3000/api/v1", "https://10.0.0.1:3000/api/v1", "http://api.notion.com/v1"]) {
        const refused = await call(register, {
          name: "Gitea", config: { ...API_CONFIG, baseUrl }, secret: { source: "browser", ref: "@e1", credential_origin: "https://git.example.com" },
        }, apiOf(s.pi, `private:${baseUrl}`));
        expect(refused.isError, baseUrl).toBe(true);
        expect(contentOf(refused)).toMatch(/https base URL|private|fetchable| refused|blocked/i);
      }
      expect(s.ledger.connections()).toHaveLength(1);
    } finally { s.close(); }
  });

  test("mail registration captures app passwords and shows host, SMTP and issuer origin to the owner", async () => {
    const s = setup();
    try {
      s.browser.url = "https://myaccount.google.com/apppasswords";
      const register = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_register");
      const mailConfig = { kind: "mail" as const, host: "imap.gmail.com", port: 993, username: "owner@gmail.com", mailbox: "INBOX", smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true, authType: "password" as const };
      const proposed = await call(register, { name: "Gmail", config: mailConfig, secret: { source: "browser", ref: "@e3", credential_origin: "https://myaccount.google.com" } }, apiOf(s.pi, "reg-mail"));
      expect(proposed.isError).toBeFalsy();
      const decision = s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!;
      expect(decision.detail).toContain("imap.gmail.com:993");
      expect(decision.detail).toContain("smtp.gmail.com:465");
      expect(decision.detail).toContain("https://myaccount.google.com");
      expect(JSON.stringify(decision)).not.toContain(TOKEN);
      await resolveOwner(s, decision.effectId!, "approve");
      const created = s.ledger.connections().find((connection) => connection.name === "Gmail")!;
      expect(created.config.kind).toBe("mail");
      expect(s.sources.credentialPresent(created.id)).toBe(true);
      expect(validateConnectionConfig({ ...mailConfig, authType: "oauth2" })).toBeUndefined();
      expect(leaks(s, TOKEN)).toEqual([]);
    } finally { s.close(); }
  });

  test("review conversations never hold connection tools", () => {
    const s = setup();
    try {
      const review = { id: "review", ghostId: s.ghost.id, kind: "review", workId: null, title: "", model: null, busy: false, createdAt: 1, lastActivityAt: 1 } as Conversation;
      const names = s.tools.extensionsFor(review, s.ghost, null).flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
      expect(names.filter((name) => name.startsWith("connection_"))).toEqual([]);
    } finally { s.close(); }
  });

});

test("Slack GET mutations require owner approval, dispatch once, and cannot hide in identity probes", async () => {
  const messages: string[] = [];
  const s = setup((async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/chat.postMessage")) messages.push(url.searchParams.get("text")!);
    return Response.json({ ok: true, user_id: "U1", ts: "1" });
  }) as ActivitySourceFetch);
  try {
    const slack: Connection = { ...s.connection, serviceId: "slack", name: "Slack", config: { ...API_CONFIG, baseUrl: "https://slack.com/api/", testPath: "auth.test", ghostIds: [s.ghost.id] } };
    s.ledger.tx(() => s.ledger.putConnection(slack));
    const request = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_request");
    const args = { connection_id: slack.id, method: "GET", path: "chat.postMessage?channel=C1&text=approved-message" };
    expect((await call(request, args, apiOf(s.pi, "slack-post"))).isError).toBeFalsy();
    expect(messages).toEqual([]);
    const decision = s.ledger.pendingDecisions({ conversationId: s.ghost.directConversationId }).at(-1)!;
    await resolveOwner(s, decision.effectId!, "approve");
    expect(messages).toEqual(["approved-message"]);
    await call(request, args, apiOf(s.pi, "slack-post"));
    expect(messages).toEqual(["approved-message"]);
    expect((await call(request, { connection_id: slack.id, method: "GET", path: "auth.test" }, apiOf(s.pi, "slack-read"))).isError).toBeFalsy();
    expect(s.ledger.pendingDecisions()).toEqual([]);
    const unsafe: Connection = { ...slack, config: { ...slack.config, testPath: args.path } as typeof API_CONFIG };
    s.ledger.tx(() => s.ledger.putConnection(unsafe));
    await expect(s.sources.test(unsafe)).rejects.toThrow();
    expect(messages).toEqual(["approved-message"]);
  } finally { s.close(); }
});

test("credential replacement invalidates an old approved write even when its Ghost grant stays", async () => {
  const s = setup();
  try {
    const request = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_request");
    await call(request, { connection_id: s.connection.id, method: "POST", path: "pages", body: "{}" }, apiOf(s.pi, "old-credential"));
    const decision = s.ledger.pendingDecisions().at(-1)!;
    s.ledger.tx(() => s.ledger.putConnection({ ...s.connection, credentialVersion: "replaced-account" }));
    await s.sources.setCredential(s.connection.id, "replacement-token", "replaced-account");
    await resolveOwner(s, decision.effectId!, "approve");
    expect(s.requests).toEqual([]);
    expect(s.ledger.effect(decision.effectId!).state).toBe("denied");
  } finally { s.close(); }
});

test("tool revocation while OAuth refresh waits prevents the subsequent external dispatch", async () => {
  const s = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    s.sources.setOAuthRefresher(async () => { entered.resolve(); await release.promise; });
    const request = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "connection_request");
    await call(request, { connection_id: s.connection.id, method: "POST", path: "pages", body: "{}" }, apiOf(s.pi, "refresh-revocation"));
    const decision = s.ledger.pendingDecisions().at(-1)!;
    const resolution = resolveOwner(s, decision.effectId!, "approve");
    await entered.promise;
    s.ledger.tx(() => s.ledger.putGhost({ ...s.ghost, tools: s.ghost.tools.filter(tool => tool !== "connection_request") }));
    release.resolve();
    await resolution;
    expect(s.requests).toEqual([]);
    expect(s.ledger.effect(decision.effectId!).state).toBe("denied");
  } finally { release.resolve(); s.close(); }
});
