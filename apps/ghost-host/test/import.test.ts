import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRef } from "@ghost/contract";
import { GHOST_TOOLS } from "@ghost/contract";
import { sha256 } from "../src/core/ids.ts";
import { runImport } from "../src/import/index.ts";
import { harness, tempDir } from "./support.ts";

// The legacy tables the importer reads, taken from contracts/lifetime/migration-*.sql.
const LEGACY_SCHEMA = `
CREATE TABLE workspace_objects (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE lifetime_bindings (
 conversation_id TEXT PRIMARY KEY, ghost_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
 runtime_release TEXT NOT NULL, storage_ref TEXT NOT NULL);
CREATE TABLE lifetime_goals (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, requirement_digest TEXT NOT NULL,
 accountable_ghost TEXT NOT NULL, reply_conversation TEXT NOT NULL, privacy TEXT NOT NULL,
 state TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE lifetime_work (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES lifetime_goals(id),
 goal_revision INTEGER NOT NULL, owner TEXT NOT NULL, owner_revision INTEGER NOT NULL,
 state TEXT NOT NULL, execution_id TEXT UNIQUE, cancellation TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE lifetime_results (
 execution_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES lifetime_work(id),
 goal_revision INTEGER NOT NULL, payload_digest TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE lifetime_acceptances (
 work_id TEXT PRIMARY KEY REFERENCES lifetime_work(id), goal_revision INTEGER NOT NULL,
 artifact_digest TEXT NOT NULL, verifier_revision TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE lifetime_registry (
 ghost_id TEXT PRIMARY KEY, kind TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
 roles TEXT NOT NULL, mode TEXT NOT NULL);
CREATE TABLE lifetime_turns (
 id TEXT PRIMARY KEY, ghost_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL, sender_kind TEXT NOT NULL, sender_ref TEXT NOT NULL,
 text TEXT NOT NULL, privacy TEXT NOT NULL, kind TEXT NOT NULL, source_turn_id TEXT,
 attachments TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE lifetime_conversation_disclosure (
 ghost_id TEXT NOT NULL, conversation_id TEXT NOT NULL, privacy TEXT NOT NULL,
 PRIMARY KEY (ghost_id, conversation_id));
CREATE TABLE lifetime_work_links (
 child_work_id TEXT PRIMARY KEY, parent_work_id TEXT NOT NULL, parent_goal_revision INTEGER NOT NULL,
 root_goal_id TEXT NOT NULL, depth INTEGER NOT NULL, current INTEGER NOT NULL DEFAULT 1);
`;

const GHOST_A = "11111111-1111-4111-8111-111111111111";
const GHOST_B = "22222222-2222-4222-8222-222222222222";
const CONV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV_A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const REPORT_BYTES = new TextEncoder().encode("quarterly report body");
const REPORT_DIGEST = sha256(REPORT_BYTES);

function hashTree(root: string): Map<string, string> {
  const digests = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else digests.set(path, sha256(new Uint8Array(readFileSync(path))));
    }
  };
  walk(root);
  return digests;
}

/**
 * A synthetic pre-Bun state root: two registry Ghosts, a public extra
 * conversation with disclosure, turns, one accepted Work with a stored result
 * artifact, one unfinished Work, an avatar, an active and a paused wake, a
 * provider with credential, and a gateway device registry next to the root.
 */
function buildLegacyRoot(): string {
  const parent = tempDir();
  const from = join(parent, "legacy");
  mkdirSync(join(from, "pi-execution", "artifacts", sha256("exec1")), { recursive: true });
  mkdirSync(join(from, "inference-credentials"), { recursive: true });

  const db = new Database(join(from, "workspace.db"));
  db.exec(LEGACY_SCHEMA);
  // A WAL-mode legacy database: reading it in place would create -shm/-wal
  // files next to it, so the importer must never open the source root.
  db.exec("PRAGMA journal_mode = WAL;");
  const object = (kind: string, id: string, payload: unknown): void => {
    db.query("INSERT INTO workspace_objects(kind, id, payload) VALUES (?, ?, ?)").run(kind, id, JSON.stringify(payload));
  };
  const registry = db.query("INSERT INTO lifetime_registry(ghost_id, kind, conversation_id, roles, mode) VALUES (?, ?, ?, '[]', 'active')");
  registry.run(GHOST_A, "primary", CONV_A);
  registry.run(GHOST_B, "specialist", CONV_B);
  object("display_name", GHOST_A, "Alpha");
  object("display_name", GHOST_B, "Beta");
  object("meta", "default_ghost", GHOST_A);
  const bindings = db.query("INSERT INTO lifetime_bindings(conversation_id, ghost_id, runtime_kind, runtime_release, storage_ref) VALUES (?, ?, 'pi-durable', '1.1.0', 'ref')");
  bindings.run(CONV_A, GHOST_A);
  bindings.run(CONV_A2, GHOST_A);
  bindings.run(CONV_B, GHOST_B);
  db.query("INSERT INTO lifetime_conversation_disclosure(ghost_id, conversation_id, privacy) VALUES (?, ?, 'public')").run(GHOST_A, CONV_A2);
  const turn = db.query(
    "INSERT INTO lifetime_turns(id, ghost_id, conversation_id, sequence, sender_kind, sender_ref, text, privacy, kind, source_turn_id, attachments, created_at_ms) VALUES (?, ?, ?, ?, ?, 'owner', ?, 'private', ?, NULL, '[]', ?)",
  );
  const base = 1_700_000_000_000;
  turn.run("t1", GHOST_A, CONV_A, 1, "owner", "hello ghost", "user", base);
  turn.run("t2", GHOST_A, CONV_A, 2, "ghost", "hi owner", "assistant_advisory", base + 1000);
  turn.run("t3", GHOST_A, CONV_A, 3, "ghost", "", "assistant_advisory", base + 2000);
  turn.run("t4", GHOST_A, CONV_A, 4, "host", "authority report", "host_fact", base + 3000);
  turn.run("t5", GHOST_A, CONV_A2, 1, "owner", "public hello", "user", base + 4000);
  turn.run("t6", GHOST_B, CONV_B, 1, "owner", "hi beta", "user", base + 5000);

  const goal = db.query(
    "INSERT INTO lifetime_goals(id, revision, requirement_digest, accountable_ghost, reply_conversation, privacy, state, payload) VALUES (?, 1, 'req', ?, ?, 'private', 'open', ?)",
  );
  goal.run("goal1", GHOST_A, CONV_A, JSON.stringify({ prompt: "Write the report", acceptance_spec: { required_checks: ["exists"] } }));
  goal.run("goal2", GHOST_A, CONV_A, JSON.stringify({ prompt: "Fix the bug", acceptance_spec: {} }));
  goal.run("goal3", GHOST_A, CONV_A, JSON.stringify({ prompt: "Draft the appendix", acceptance_spec: {} }));
  const work = db.query(
    "INSERT INTO lifetime_work(id, goal_id, goal_revision, owner, owner_revision, state, execution_id, cancellation, payload) VALUES (?, ?, 1, ?, 1, ?, ?, 'none', ?)",
  );
  work.run("work1", "goal1", GHOST_A, "accepted", "exec1", JSON.stringify({ blocker: null }));
  work.run("work2", "goal2", GHOST_A, "running", "exec2", JSON.stringify({ blocker: null }));
  work.run("work3", "goal3", GHOST_A, "queued", null, JSON.stringify({ blocker: null }));
  db.query("INSERT INTO lifetime_work_links(child_work_id, parent_work_id, parent_goal_revision, root_goal_id, depth, current) VALUES ('work3', 'work1', 1, 'goal1', 1, 1)").run();
  const result = db.query("INSERT INTO lifetime_results(execution_id, work_id, goal_revision, payload_digest, payload) VALUES (?, ?, 1, 'digest', ?)");
  result.run(
    "exec1",
    "work1",
    JSON.stringify({
      event: {
        summary: "report written",
        state: "completed",
        goal_revision: 1,
        artifacts: [{ digest: REPORT_DIGEST, locator: `artifacts/${sha256("exec1")}/${REPORT_DIGEST}.json`, privacy: "public", producing_attempt: "exec1" }],
      },
      producer: "pi-result:owner:exec1",
      epoch: 1,
      sequence: 1,
      current: true,
      reason: null,
    }),
  );
  result.run("exec2", "work2", JSON.stringify({ event: { summary: "still running when exported", state: "running", goal_revision: 1, artifacts: [] }, producer: "p", epoch: 1, sequence: 2, current: false, reason: "stale_requirement" }));
  db.query("INSERT INTO lifetime_acceptances(work_id, goal_revision, artifact_digest, verifier_revision, payload) VALUES ('work1', 1, 'digest', 'v1', '{}')").run();

  object("avatar", "av1", { id: "av1", name: "Alpha Sprite", description: "imported", sprite_version: 1, design: { body: "#fff" }, created_ms: 1_700_000_000_000 });
  object("avatar_image", "av1", `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  object("profile_avatar", GHOST_A, { avatar_id: "av1", version: 1 });

  object("wake", "w1", {
    id: "w1",
    profile_id: GHOST_A,
    conversation_id: CONV_A,
    prompt: "morning brief",
    timezone: "Asia/Seoul",
    local_time: "08:00",
    next_run_ms: 1_790_000_000_000,
    paused: false,
    origin: { kind: "owner", created_ms: 1_700_000_000_000 },
  });
  object("wake", "w2", {
    id: "w2",
    profile_id: GHOST_A,
    conversation_id: CONV_A,
    prompt: "paused brief",
    timezone: "Asia/Seoul",
    local_time: "09:00",
    next_run_ms: 1_790_000_000_000,
    paused: true,
    origin: {},
  });

  object("inference_settings_v1", "workspace", {
    version: 3,
    default: { provider: "zai-coding", model: "glm-5.3", effort: "high" },
    conversations: {},
    external_grants: {},
    credentials: { "zai-coding": true },
    image_provider: "codex",
  });
  writeFileSync(join(from, "inference-credentials", "zai-coding.json"), JSON.stringify({ api_key: "sk-legacy-test-key" }));
  writeFileSync(join(from, "pi-execution", "artifacts", sha256("exec1"), `${REPORT_DIGEST}.json`), REPORT_BYTES);
  writeFileSync(join(parent, "devices.json"), JSON.stringify({ version: 1, devices: [{ id: "device-1", name: "iPhone", digest: "d".repeat(64), created_at: "2026-01-01T00:00:00Z" }] }));
  db.close();
  return from;
}

describe("runImport", () => {
  test("carries ghosts, conversations, history, works, providers, schedules and avatars; leaves the root untouched", async () => {
    const from = buildLegacyRoot();
    const before = hashTree(from);
    const { ledger, core, engine, artifacts } = harness();
    const logLines: string[] = [];
    const report = await runImport({ from, ledger, engine, core, log: (line) => logLines.push(line) });
    expect(hashTree(from)).toEqual(before);

    // Ghosts: names, default flag, avatar look, preserved direct conversation id.
    expect(report.ghosts).toBe(2);
    const alpha = ledger.ghost(GHOST_A);
    expect(alpha.name).toBe("Alpha");
    expect(alpha.isDefault).toBe(true);
    expect(alpha.look).toEqual({ avatarId: "av1" });
    expect(alpha.tools).toEqual([...GHOST_TOOLS]);
    expect(alpha.directConversationId).toBe(CONV_A);
    expect(ledger.defaultGhost()?.id).toBe(GHOST_A);
    const beta = ledger.ghost(GHOST_B);
    expect(beta.name).toBe("Beta");
    expect(beta.isDefault).toBe(false);

    // Conversations keep their legacy ids; model choices stay on conversations.
    expect(report.conversations).toBe(3);
    expect(ledger.conversation(CONV_A)).toMatchObject({ ghostId: GHOST_A, kind: "direct" });
    expect(ledger.conversation(CONV_A2)).toMatchObject({ ghostId: GHOST_A, kind: "direct" });
    expect(ledger.conversations({ ghostId: GHOST_A })).toHaveLength(2);
    expect(ledger.ghosts().every((ghost) => ghost.model === null)).toBe(true);

    // History: owner → user, ghost → assistant, ordered by sequence; empty and host turns dropped.
    expect(report.messages).toBe(4);
    const historyFor = (conversationId: string) => engine.history.filter((message) => message.conversationId === conversationId).map(({ role, text }) => ({ role, text }));
    expect(historyFor(CONV_A)).toEqual([
      { role: "user", text: "hello ghost" },
      { role: "assistant", text: "hi owner" },
    ]);
    expect(historyFor(CONV_A2)).toEqual([{ role: "user", text: "public hello" }]);
    expect(historyFor(CONV_B)).toEqual([{ role: "user", text: "hi beta" }]);
    expect(engine.opened.map((setup) => setup.conversation.id).sort()).toEqual([CONV_A, CONV_A2, CONV_B].sort());

    // Works: accepted → done with result and copied artifact; unfinished → failed.
    const done = ledger.work("work1");
    expect(done.state).toBe("done");
    expect(done.conversationId).toBeNull();
    expect(done.result).toMatchObject({ summary: "report written", artifacts: [{ digest: REPORT_DIGEST }] });
    expect(done.verdict).toMatchObject({ outcome: "pass", source: "owner" });
    expect(JSON.parse(done.acceptance.criteria)).toEqual({ required_checks: ["exists"] });
    expect(artifacts.has(REPORT_DIGEST)).toBe(true);
    expect(new TextDecoder().decode(await artifacts.read(REPORT_DIGEST))).toBe("quarterly report body");
    const failed = ledger.work("work2");
    expect(failed.state).toBe("failed");
    expect(failed.reason).toBe("imported unfinished");
    expect(failed.conversationId).toBeNull();
    // The legacy delegation link survives as a parent/child Work pair.
    const delegated = ledger.work("work3");
    expect(delegated.parentId).toBe("work1");
    expect(delegated.rootId).toBe("work1");
    expect(delegated.state).toBe("failed");
    expect(report.works).toBe(3);

    // Providers: the default selection (zai-coding) and the image provider (codex).
    expect(report.providers).toBe(2);
    expect(ledger.providers()).toEqual([
      expect.objectContaining({ id: "codex", kind: "openai", models: expect.arrayContaining([expect.objectContaining({ id: "gpt-6-luna" })]) }),
      expect.objectContaining({ id: "zai-coding", kind: "zai" }),
    ]);
    expect(core.secrets.get("zai-coding")).toBe("sk-legacy-test-key");
    expect(core.secrets.get("codex")).toBeNull();
    const defaultModel = ledger.setting<ModelRef | null>("defaultModel", null);
    expect(defaultModel).toEqual({ provider: "zai-coding", model: "glm-5.3", thinking: "high" });

    // Schedules: the active wake lands on the Ghost's direct conversation.
    expect(report.schedules).toBe(1);
    expect(ledger.schedules()).toEqual([
      expect.objectContaining({
        id: "w1",
        ghostId: GHOST_A,
        conversationId: CONV_A,
        prompt: "morning brief",
        spec: { kind: "every", seconds: 86400, startAt: 1_790_000_000_000 },
        state: "active",
      }),
    ]);

    // Avatars: image bytes stored by digest, row carries the digest.
    expect(report.avatars).toBe(1);
    expect(ledger.avatars()).toEqual([expect.objectContaining({ id: "av1", imageDigest: sha256(PNG) })]);

    // Loss report: devices, paused wake, dropped turns.
    expect(report.devices).toBe(1);
    expect(report.skipped).toEqual([
      "schedules: 1 paused wake schedule(s) are not carried",
      "devices: 1 paired device(s) require re-pairing; legacy gateway token hashes are incompatible with the host's secret hashing",
      "history: 1 empty message(s) dropped",
      "history: 1 host-generated notice(s) dropped",
    ]);
    expect(logLines.join("\n")).toContain("imported 2 ghosts");
  });

  test("refuses to import into a ledger that already holds data", async () => {
    const from = buildLegacyRoot();
    const { ledger, core, engine } = harness();
    await runImport({ from, ledger, engine, core, log: () => {} });
    await expect(runImport({ from, ledger, engine, core, log: () => {} })).rejects.toThrow("import refused: the target ledger already contains data");
  });

  test("refuses a directory without a legacy workspace.db", async () => {
    const { ledger, core, engine } = harness();
    await expect(runImport({ from: tempDir(), ledger, engine, core, log: () => {} })).rejects.toThrow("does not look like a legacy state root");
  });
});
