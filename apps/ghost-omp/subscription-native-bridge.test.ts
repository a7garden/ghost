import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { OAuthCredential } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import {
  extractResponseIdentity,
  readCanonicalCredentialSnapshot,
  validateConfigureFrame,
  validateNativePayload,
} from "./subscription-native-bridge";

const MODEL_SELECTOR = "openai-codex/gpt-6-luna";

interface TemporaryAuthStore {
  root: string;
  database: string;
  storage: Database;
}

async function createTemporaryAuthStore(credentials: OAuthCredential[]): Promise<TemporaryAuthStore> {
  const createdRoot = await mkdtemp(join(tmpdir(), "ghost-subscription-b7-"));
  const root = await realpath(createdRoot);
  let storage: Database | undefined;
  try {
    const database = join(root, "agent.db");
    storage = new Database(database, { create: true, strict: true });
    storage.run("PRAGMA journal_mode = WAL");
    storage.run("CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    storage.run("INSERT INTO auth_schema_version VALUES (1, 8)");
    storage.run(`CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
      data TEXT NOT NULL, disabled_cause TEXT)`);
    const insert = storage.query(
      "INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)",
    );
    for (const { type, ...data } of credentials) {
      insert.run("openai-codex", type, JSON.stringify(data));
    }
    for (const path of [database, `${database}-wal`]) {
      await chmod(path, 0o600);
    }
    await chmod(`${database}-shm`, 0o644);
    return { root, database, storage };
  } catch (error) {
    storage?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeTemporaryAuthStore(fixture: TemporaryAuthStore): Promise<void> {
  fixture.storage.close();
  await rm(fixture.root, { recursive: true, force: true });
}

function fixtureCredential(accountId: string): OAuthCredential {
  return {
    type: "oauth",
    access: `fixture-access-${accountId}`,
    refresh: `fixture-refresh-${accountId}`,
    expires: 2_000_000_000_000,
    accountId,
  };
}

test("configure refuses selector aliases and unrecognized fields", () => {
  const configure = {
    version: 1,
    kind: "configure",
    sdk_package_root: "/pinned/pi-ai",
    auth_file: "/private/agent.db",
    selector: MODEL_SELECTOR,
    thinking: "max",
    max_tokens: 1024,
    deadline_ms: 180000,
  };
  expect(() =>
    validateConfigureFrame({ ...configure, selector: "openai-codex/gpt-6-luna-max" }),
  ).toThrow("invalid_config");
  expect(() =>
    validateConfigureFrame({ ...configure, unexpected: true }),
  ).toThrow("invalid_config");
});

test("authority epochs reject strings, zero and inexact integers before dispatch", () => {
  const request = {
    request_id: "8ae16012-3adb-4d4e-bd51-c6d6dd072dba",
    execution_id: "epoch-boundary-fixture",
    authority_epoch: 1,
    payload_json: "{}",
    payload_sha256: "0".repeat(64),
  };
  for (const authority_epoch of ["1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(extractResponseIdentity({ ...request, authority_epoch })).toBeUndefined();
  }
});

test("native request rejects transport overrides and unscoped tools", () => {
  const base = {
    modelId: MODEL_SELECTOR,
    context: {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    options: { maxTokens: 1024, reasoning: "max" },
    stream: true,
  };
  const withHeaders = {
    ...base,
    options: { ...base.options, headers: { Authorization: "Bearer fixture" } },
  };
  const withUnscopedTool = {
    ...base,
    context: {
      ...base.context,
      tools: [{ name: "canary_read", description: "read a file", parameters: { type: "object" } }],
    },
  };
  expect(() => validateNativePayload(JSON.stringify(withUnscopedTool), "max")).toThrow("invalid_native_payload");
  expect(() => validateNativePayload(JSON.stringify(withHeaders), "max")).toThrow("invalid_native_payload");
});

test("native edit grammar rejects capability expansion and malformed formats", () => {
  const format = { syntax: "lark", definition: 'start: "patch"\n' };
  const edit = { name: "edit", description: "edit a local file", parameters: { type: "object" } };
  const rejectedTools = [
    { ...edit, name: "read", customFormat: format },
    { ...edit, customFormat: null },
    { ...edit, customFormat: { ...format, syntax: "regex" } },
    { ...edit, customFormat: { ...format, definition: "" } },
    { ...edit, customFormat: { ...format, url: "https://example.invalid" } },
    { ...edit, customFormat: format, native: { type: "computer" } },
    { ...edit, customFormat: format, customWireName: "computer" },
  ];
  for (const tool of rejectedTools) {
    const payload = {
      modelId: MODEL_SELECTOR,
      context: {
        messages: [{ role: "user", content: [{ type: "text", text: "edit a local file" }] }],
        tools: [tool],
      },
      options: { maxTokens: 1024, reasoning: "max" },
      stream: true,
    };
    expect(() => validateNativePayload(JSON.stringify(payload), "max")).toThrow("invalid_native_payload");
  }
});

test("credential snapshot reads committed WAL data without changing source files", async () => {
  const fixture = await createTemporaryAuthStore([fixtureCredential("account_fixture_1")]);
  try {
    const paths = [fixture.database, `${fixture.database}-wal`, `${fixture.database}-shm`];
    const before = await Promise.all(paths.map(path => readFile(path)));
    const credential = await readCanonicalCredentialSnapshot(fixture.database);
    expect(credential.accountId).toBe("account_fixture_1");
    expect(credential.type).toBe("oauth");
    const after = await Promise.all(paths.map(path => readFile(path)));
    for (let index = 0; index < paths.length; index++) {
      expect(after[index]!.equals(before[index]!)).toBe(true);
    }
  } finally {
    await closeTemporaryAuthStore(fixture);
  }
});

test("credential snapshot rejects a corrupted committed WAL instead of using older auth", async () => {
  const fixture = await createTemporaryAuthStore([fixtureCredential("account_fixture_1")]);
  try {
    const walPath = `${fixture.database}-wal`;
    const wal = await readFile(walPath);
    wal[wal.length - 1] = wal[wal.length - 1]! ^ 1;
    await writeFile(walPath, wal);
    await expect(readCanonicalCredentialSnapshot(fixture.database)).rejects.toMatchObject({
      code: "auth_snapshot_unavailable",
    });
  } finally {
    await closeTemporaryAuthStore(fixture);
  }
});

test("credential snapshot rejects multiple active Codex accounts instead of selecting a fallback", async () => {
  const fixture = await createTemporaryAuthStore([
    fixtureCredential("account_fixture_1"),
    fixtureCredential("account_fixture_2"),
  ]);
  try {
    await expect(readCanonicalCredentialSnapshot(fixture.database)).rejects.toMatchObject({
      code: "credential_ambiguous",
    });
  } finally {
    await closeTemporaryAuthStore(fixture);
  }
});

test("credential snapshot refuses a symlinked auth database", async () => {
  const fixture = await createTemporaryAuthStore([fixtureCredential("account_fixture_1")]);
  const alias = join(fixture.root, "agent-alias.db");
  try {
    await symlink(fixture.database, alias);
    await expect(readCanonicalCredentialSnapshot(alias)).rejects.toMatchObject({
      code: "auth_snapshot_unsafe",
    });
  } finally {
    await closeTemporaryAuthStore(fixture);
  }
});
