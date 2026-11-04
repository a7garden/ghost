import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { initializeTurnStatusObservations } from "./turn-status-observations.js";

function keyFor(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function prepareDatabase(path) {
  const database = await openNodeSqliteDatabase(path, {
    busyTimeoutMs: 5_000,
    walAutoCheckpointPages: 1_000,
  });
  try {
    // The upstream Node adapter defaults this connection to NORMAL. FULL is per-connection.
    await database.exec("PRAGMA synchronous = FULL");
    const synchronous = await database.get("PRAGMA synchronous");
    const journalMode = await database.get("PRAGMA journal_mode");
    if (Number(synchronous?.synchronous) !== 2 || String(journalMode?.journal_mode).toLowerCase() !== "wal") {
      throw new Error("SQLite durability readback did not report WAL and synchronous=FULL.");
    }
    return database;
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

export async function acquireGhostLock(root, ghostId) {
  const ghostDirectory = join(resolve(root), keyFor(ghostId));
  await mkdir(ghostDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(ghostDirectory, ".runtime-lock.sqlite");
  const lock = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    await chmod(lockPath, 0o600);
    lock.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    lock.close();
  };
}

export async function openGhostIndex(root, ghostId) {
  const ghostDirectory = join(resolve(root), keyFor(ghostId));
  const database = await prepareDatabase(join(ghostDirectory, "runtime.sqlite"));
  try {
    await database.exec("CREATE TABLE IF NOT EXISTS ghost_runtime_identity (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await database.exec("CREATE TABLE IF NOT EXISTS ghost_conversations (external_id TEXT PRIMARY KEY, pi_id INTEGER NOT NULL, storage_ref TEXT NOT NULL, privacy TEXT NOT NULL DEFAULT 'unknown')");
    await database.exec(`CREATE TABLE IF NOT EXISTS ghost_command_receipts (
      command_id TEXT PRIMARY KEY,
      payload_digest TEXT NOT NULL,
      actor_ref TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      pi_request_id TEXT,
      response_json TEXT
    )`);
    await database.exec(`CREATE TABLE IF NOT EXISTS ghost_canonical_turns (
      turn_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      privacy TEXT NOT NULL,
      prompt TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'admitting', 'running', 'answered', 'unanswered', 'blocked')),
      submission_id TEXT,
      assistant_entry_id TEXT,
      reply_invocation_id TEXT,
      reply_text_digest TEXT,
      reply_state TEXT NOT NULL DEFAULT 'not_ready' CHECK (reply_state IN ('not_ready', 'pending', 'sent', 'blocked')),
      reply_receipt_json TEXT
    )`);
    await database.exec("CREATE UNIQUE INDEX IF NOT EXISTS ghost_one_active_canonical_turn ON ghost_canonical_turns (conversation_id) WHERE state IN ('admitting', 'running')");
    await database.exec(`CREATE TABLE IF NOT EXISTS ghost_canonical_turn_runs (
      turn_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'answered', 'failed', 'cancelled', 'effect_unknown')),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      cancel_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (cancel_confirmed IN (0, 1)),
      cancel_command_id TEXT,
      submission_id TEXT,
      entry_id TEXT,
      reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
        'model_request_failed', 'runtime_failure', 'admission_blocked', 'answer_unprojectable',
        'owner_cancelled', 'effect_unconfirmed', 'reply_delivery_unconfirmed', 'authority_revoked'
      )),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    )`);
    await database.exec(`CREATE INDEX IF NOT EXISTS ghost_canonical_turn_runs_by_conversation
      ON ghost_canonical_turn_runs (conversation_id, status)`);
    await database.exec(`CREATE TABLE IF NOT EXISTS ghost_turn_status_reports (
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'answered', 'failed', 'cancelled', 'effect_unknown')),
      invocation_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (delivery_state IN ('pending', 'acknowledged', 'rejected', 'observed', 'conflict')),
      receipt_json TEXT,
      observed_json TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      PRIMARY KEY (turn_id, status)
    )`);
    await database.exec("CREATE TABLE IF NOT EXISTS ghost_runtime_migrations (migration_id TEXT PRIMARY KEY, applied_at_ms INTEGER NOT NULL)");
    await initializeTurnStatusObservations(database);
    await database.transaction(async (transaction) => {
      const marker = await transaction.get(
        "SELECT migration_id FROM ghost_runtime_migrations WHERE migration_id = ?",
        "canonical-turn-runs-v1",
      );
      if (marker) return;
      const legacyTurns = await transaction.all(
        "SELECT turn_id, conversation_id, submission_id, assistant_entry_id FROM ghost_canonical_turns ORDER BY rowid",
      );
      const migratedAt = Date.now();
      for (const turn of legacyTurns) {
        await transaction.run(
          `INSERT OR IGNORE INTO ghost_canonical_turn_runs
            (turn_id, conversation_id, status, submission_id, entry_id, reason_code, created_at_ms, updated_at_ms)
           VALUES (?, ?, 'effect_unknown', ?, ?, 'effect_unconfirmed', ?, ?)`,
          turn.turn_id,
          turn.conversation_id,
          turn.submission_id,
          turn.assistant_entry_id,
          migratedAt,
          migratedAt,
        );
      }
      await transaction.run(
        "INSERT INTO ghost_runtime_migrations (migration_id, applied_at_ms) VALUES (?, ?)",
        "canonical-turn-runs-v1",
        migratedAt,
      );
    });

    await database.transaction(async (transaction) => {
      const marker = await transaction.get(
        "SELECT migration_id FROM ghost_runtime_migrations WHERE migration_id = ?",
        "canonical-work-report-origin-v1",
      );
      if (marker) return;
      await transaction.run(
        `ALTER TABLE ghost_canonical_turns
         ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'owner'
         CHECK (origin_kind IN ('owner', 'work_report'))`,
      );
      await transaction.run(
        "ALTER TABLE ghost_canonical_turns ADD COLUMN origin_goal_id TEXT",
      );
      await transaction.run(
        `ALTER TABLE ghost_canonical_turns ADD COLUMN origin_goal_revision INTEGER
         CHECK (origin_goal_revision IS NULL OR origin_goal_revision > 0)`,
      );
      await transaction.run(
        "ALTER TABLE ghost_canonical_turns ADD COLUMN origin_source_command_id TEXT",
      );
      await transaction.run(
        "INSERT INTO ghost_runtime_migrations (migration_id, applied_at_ms) VALUES (?, ?)",
        "canonical-work-report-origin-v1",
        Date.now(),
      );
    });

    // Old prototype receipts did not bind actor/epoch. Their ownership cannot
    // be inferred safely; preserve that store and require explicit migration.
    await database.get("SELECT actor_ref, authority_epoch FROM ghost_command_receipts LIMIT 1");
    await database.run("INSERT OR IGNORE INTO ghost_runtime_identity (key, value) VALUES (?, ?)", "ghost_id", ghostId);
    const identity = await database.get("SELECT value FROM ghost_runtime_identity WHERE key = ?", "ghost_id");
    if (identity?.value !== ghostId) throw new Error("Ghost runtime storage identity mismatch.");
    return database;
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

export async function openPiConversationStorage(root, ghostId, conversationId, context = null) {
  const ghostKey = keyFor(ghostId);
  const conversationKey = keyFor(conversationId);
  const absolutePath = context
    ? join(resolve(root), ghostKey, "work-contexts", context.ref, "durable.sqlite")
    : join(resolve(root), ghostKey, conversationKey, "durable.sqlite");
  const database = await prepareDatabase(absolutePath);
  try {
    await database.exec("CREATE TABLE IF NOT EXISTS ghost_runtime_identity (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await database.transaction(async tx=>{
      if(context && !await tx.get("SELECT value FROM ghost_runtime_identity WHERE key='work_context'")) {
        const initialized=await tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('ghost_runtime_identity','sqlite_sequence') LIMIT 1");
        if(initialized) throw new Error("Existing initialized Pi storage has no exact Work context seal; explicit reconciliation is required.");
      }
      for (const [key, value] of [["ghost_id", ghostId], ["conversation_id", conversationId], ...(context ? [["work_context", JSON.stringify(context)]] : [])]) {
        await tx.run("INSERT OR IGNORE INTO ghost_runtime_identity (key, value) VALUES (?, ?)", key, value);
        const identity = await tx.get("SELECT value FROM ghost_runtime_identity WHERE key = ?", key);
        if (identity?.value !== value) throw new Error("Pi conversation storage identity mismatch.");
      }
    });
    const storage = await SqliteStorage.open(database);
    return {
      database,
      storage,
      path: absolutePath,
      storageRef: relative(resolve(root), absolutePath).split("\\").join("/"),
    };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}
