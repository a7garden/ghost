import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLocalAuth, localAuthSources } from "../src/api/local-auth.ts";
import { LocalAuth } from "../src/integrations/local-auth.ts";
import { harness } from "./support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const EXP = Math.floor(Date.now() / 1000) + 3600;
const access = jwt({ exp: EXP, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

function home(files: { codex?: unknown; pi?: unknown; omp?: { provider: string; type: string; data: unknown; disabled?: string }[] }) {
  const root = mkdtempSync(join(tmpdir(), "ghost-local-auth-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  if (files.codex) { mkdirSync(join(root, ".codex")); writeFileSync(join(root, ".codex", "auth.json"), JSON.stringify(files.codex)); }
  if (files.pi) { mkdirSync(join(root, ".pi", "agent"), { recursive: true }); writeFileSync(join(root, ".pi", "agent", "auth.json"), JSON.stringify(files.pi)); }
  if (files.omp) {
    mkdirSync(join(root, ".omp", "agent"), { recursive: true });
    const db = new Database(join(root, ".omp", "agent", "agent.db"));
    db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL)");
    for (const row of files.omp) db.run("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)", [row.provider, row.type, JSON.stringify(row.data), row.disabled ?? null]);
    db.close();
  }
  return root;
}

const codexFile = { auth_mode: "chatgpt", OPENAI_API_KEY: "sk-codex-key-1234", tokens: { access_token: access, refresh_token: "refresh-1", account_id: "acct-1", id_token: jwt({ email: "me@example.com" }) } };

test("scan offers only credentials Ghost can use, once per secret, and skips unusable ones", () => {
  const root = home({
    codex: codexFile,
    omp: [
      { provider: "openai-codex", type: "oauth", data: { access, refresh: "refresh-1", expires: 1, email: "dup@example.com" } },
      { provider: "anthropic", type: "oauth", data: { access: "a", refresh: "r", expires: 1 } },
      { provider: "minimax-code", type: "api_key", data: { key: "mm-key-5678", source: "x" } },
      { provider: "zai", type: "api_key", data: { key: "zai-key-0000" }, disabled: "invalid" },
    ],
    pi: { openai: { type: "api_key", key: "OPENAI_API_KEY" }, google: { type: "api_key", key: "!pass show google" }, anthropic: { type: "api_key", key: "sk-ant-9999" } },
  });
  const entries = new LocalAuth({ home: root, codexHome: join(root, ".codex") }).scan();
  expect(entries.map(entry => [entry.id, entry.kind, entry.authType, entry.account])).toEqual([
    ["codex:chatgpt", "openai", "oauth", "me@example.com"],
    ["codex:api-key", "openai", "api_key", "…1234"],
    ["omp:3", "minimax", "api_key", "…5678"],
    ["pi:anthropic", "anthropic", "api_key", "…9999"],
  ]);
  const login = entries[0]!.credential;
  expect(login).toEqual({ type: "oauth", access, refresh: "refresh-1", expires: EXP * 1000, accountId: "acct-1" });
});

test("a missing or malformed store yields nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-local-auth-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), "{ not json");
  expect(new LocalAuth({ home: root, codexHome: join(root, ".codex") }).scan()).toEqual([]);
});

function setup(files: Parameters<typeof home>[0]) {
  const { core, ledger } = harness();
  cleanup.push(() => ledger.close());
  const root = home(files);
  return { core, ledger, auth: new LocalAuth({ home: root, codexHome: join(root, ".codex") }) };
}

test("importing a ChatGPT login adds the OpenAI provider and never exposes the secret", async () => {
  const { core, ledger, auth } = setup({ codex: codexFile });
  const sources = localAuthSources(core, auth);
  expect(sources.find(source => source.id === "codex:chatgpt")?.target).toEqual({ providerId: "openai", name: "OpenAI", exists: false, hasCredential: false });
  expect(JSON.stringify(sources)).not.toContain("refresh-1");
  expect(JSON.stringify(sources)).not.toContain("sk-codex-key-1234");

  const result = await importLocalAuth(core, auth, { sourceId: "codex:chatgpt" });
  expect(result).toEqual({ providerId: "openai", created: true });
  expect(ledger.providers().find(provider => provider.id === "openai")).toMatchObject({ kind: "openai", baseUrl: null });
  expect(core.secrets.credential("openai")).toMatchObject({ type: "oauth", refresh: "refresh-1", accountId: "acct-1" });
});

test("an existing credential is replaced only on confirmation", async () => {
  const { core, ledger, auth } = setup({ codex: codexFile });
  ledger.putProvider({ id: "mine", kind: "openai", name: "Mine", baseUrl: null, models: [] });
  core.secrets.put("mine", "sk-existing");
  await expect(importLocalAuth(core, auth, { sourceId: "codex:api-key" })).rejects.toMatchObject({ code: "conflict" });
  expect(core.secrets.get("mine")).toBe("sk-existing");
  expect(await importLocalAuth(core, auth, { sourceId: "codex:api-key", replace: true })).toEqual({ providerId: "mine", created: false });
  expect(core.secrets.get("mine")).toBe("sk-codex-key-1234");
});

test("a provider pointed at another server never receives an imported key", async () => {
  const { core, ledger, auth } = setup({ codex: codexFile });
  ledger.putProvider({ id: "proxy", kind: "openai", name: "Proxy", baseUrl: "https://proxy.example.com/v1", models: [] });
  const result = await importLocalAuth(core, auth, { sourceId: "codex:api-key" });
  expect(result).toEqual({ providerId: "openai", created: true });
  expect(core.secrets.has("proxy")).toBe(false);
});

test("an unknown source is refused", async () => {
  const { core, auth } = setup({ codex: codexFile });
  await expect(importLocalAuth(core, auth, { sourceId: "omp:99" })).rejects.toMatchObject({ code: "not_found" });
});
