/**
 * One-shot importer from a pre-Bun legacy state root (`workspace.db` + friends)
 * into a fresh ledger. The legacy root is never written: its databases are
 * copied into a scratch directory and read there, because opening a WAL
 * database in place would create side files next to it. Everything that cannot
 * be carried over is reported in `skipped`.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  Avatar,
  Conversation,
  Ghost,
  Provider,
  Schedule,
  Work,
  parse,
  type ArtifactRef,
  type ModelRef,
  type Privacy,
} from "@ghost/contract";
import type { Core } from "../core/core.ts";
import { sha256 } from "../core/ids.ts";
import type { Engine } from "../core/ports.ts";
import type { Ledger } from "../ledger/ledger.ts";

export interface ImportReport {
  ghosts: number;
  conversations: number;
  messages: number;
  works: number;
  devices: number;
  providers: number;
  schedules: number;
  avatars: number;
  skipped: string[];
}

interface PlannedMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

interface PlannedArtifact {
  ref: ArtifactRef;
  bytes: Uint8Array;
  name: string;
}

interface PlannedWork {
  work: Work;
  artifacts: PlannedArtifact[];
}

interface PlannedAvatar {
  avatar: Avatar;
  bytes: Uint8Array;
  mediaType: string;
}

interface PlannedConversation {
  conversation: Conversation;
  pair: { ghostId: string; conversationId: string };
}

interface PlannedGhost {
  ghost: Ghost;
  conversations: PlannedConversation[];
}

interface LegacyTurn {
  ghostId: string;
  conversationId: string;
  sequence: number;
  senderKind: string;
  kind: string;
  text: string;
  attachments: string;
  at: number;
}

interface LegacyAvatar {
  id: string;
  name: string;
  description: string;
  design: Record<string, unknown> | null;
  createdAt: number;
}

interface LegacySelection {
  provider: string;
  model: string;
  effort: string;
}

interface LegacyInference {
  default: LegacySelection;
  conversations: Record<string, LegacySelection>;
  image_provider: string;
  credentials: Record<string, boolean>;
}

interface LegacyResultArtifact {
  digest: string;
  locator: string;
  producingAttempt: string;
}

interface LegacyGoal {
  revision: number;
  ghost: string;
  replyConversation: string;
  prompt: string;
  acceptanceSpec: Record<string, unknown> | null;
}

interface LegacyWork {
  id: string;
  goalId: string;
  state: string;
  executionId: string | null;
  cancellation: string;
  blocker: string | null;
}

interface LegacyLink {
  parentId: string;
  depth: number;
}

/** Everything read from the legacy root. Pure data; no open handles. */
interface Legacy {
  registry: { ghostId: string; kind: string; conversationId: string; mode: string }[];
  bindings: { conversationId: string; ghostId: string }[];
  turns: LegacyTurn[];
  disclosures: Map<string, string>;
  goals: Map<string, LegacyGoal>;
  works: LegacyWork[];
  links: Map<string, LegacyLink>;
  results: Map<string, { summary: string; artifacts: LegacyResultArtifact[] }>;
  acceptedWorks: Set<string>;
  profiles: Map<string, { name: string; persona: string; createdAt: number }>;
  displayNames: Map<string, string>;
  defaultGhostId: string | null;
  avatars: LegacyAvatar[];
  avatarImages: Map<string, { bytes: Uint8Array; mediaType: string }>;
  ghostAvatars: Map<string, string | null>;
  inference: LegacyInference;
  credentialKeys: { provider: string; apiKey: string }[];
  wakes: { id: string; profileId: string; prompt: string; nextRunAt: number; createdAt: number; paused: boolean }[];
  devices: number;
  kindCounts: Map<string, number>;
  hasProfiles: boolean;
  lifetimePlumbingRows: number;
  piExecutionRows: number;
}

type Row = Record<string, unknown>;

const THINKING: Record<string, "off" | "low" | "medium" | "high"> = {
  off: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** Legacy inference catalog (src/host/inference.rs), minus the retired transport detail. */
const PROVIDER_CATALOG: Record<string, { kind: Provider["kind"]; name: string; models: string[]; local: boolean }> = {
  codex: { kind: "openai", name: "Codex", models: ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"], local: false },
  "zai-coding": { kind: "zai", name: "Z.AI Coding Plan", models: ["glm-5.3"], local: false },
  minimax: { kind: "minimax", name: "MiniMax", models: ["MiniMax-M3.1-Flash-Preview"], local: false },
  local: { kind: "openai_compatible", name: "Local model", models: [], local: true },
};

const LEGACY_PRIVACY: Record<string, Privacy> = { public: "public", private: "private", local_only: "local" };

const MEDIA_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".csv": "text/csv",
};

const DEFAULT_INFERENCE: LegacyInference = {
  default: { provider: "codex", model: "gpt-6-luna", effort: "high" },
  conversations: {},
  image_provider: "codex",
  credentials: {},
};

function clip(text: unknown, max: number): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  return [...value].slice(0, max).join("").trim();
}

function toMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

/** `journal.put` stores JSON; tolerate raw text payloads from older roots. */
function payload<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

function select(db: Database, sql: string, ...params: (string | number)[]): Row[] {
  try {
    return db.query(sql).all(...params) as Row[];
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return [];
    throw error;
  }
}

function lookup(db: Database, sql: string, key?: string): Row | null {
  const row = key === undefined ? db.query(sql).get() : db.query(sql).get(key);
  return (row as Row | null) ?? null;
}

function mediaTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return MEDIA_BY_EXTENSION[extension] ?? "application/octet-stream";
}

interface LegacyWorkspace {
  db: Database;
  /** Scratch directory holding copies of the legacy databases. */
  scratch: string;
  cleanup: () => void;
}

/**
 * Copies the legacy workspace into a scratch directory before opening it.
 * A read-only SQLite connection to a WAL database still creates `-shm`/`-wal`
 * files next to the database, so the source root is never opened in place.
 */
function openLegacyWorkspace(from: string): LegacyWorkspace {
  const source = join(from, "workspace.db");
  if (!existsSync(source)) throw new Error(`import refused: ${source} does not look like a legacy state root`);
  const scratch = mkdtempSync(join(tmpdir(), "ghost-import-"));
  const copy = join(scratch, "workspace.db");
  copyFileSync(source, copy);
  const wal = `${source}-wal`;
  if (existsSync(wal)) copyFileSync(wal, `${copy}-wal`);
  const db = new Database(copy);
  return {
    db,
    scratch,
    cleanup: () => {
      db.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

function readLegacy(from: string, db: Database, scratch: string): Legacy {
  const kindCounts = new Map<string, number>();
  for (const row of select(db, "SELECT kind, COUNT(*) AS n FROM workspace_objects GROUP BY kind")) {
    kindCounts.set(String(row.kind), Number(row.n));
  }

  const registry = select(db, "SELECT ghost_id, kind, conversation_id, mode FROM lifetime_registry").map((row) => ({
    ghostId: String(row.ghost_id),
    kind: String(row.kind),
    conversationId: String(row.conversation_id),
    mode: String(row.mode),
  }));

  const bindings = select(db, "SELECT conversation_id, ghost_id FROM lifetime_bindings").map((row) => ({
    conversationId: String(row.conversation_id),
    ghostId: String(row.ghost_id),
  }));

  const turns: LegacyTurn[] = select(
    db,
    "SELECT ghost_id, conversation_id, sequence, sender_kind, kind, text, attachments, created_at_ms FROM lifetime_turns ORDER BY ghost_id, conversation_id, sequence",
  ).map((row) => ({
    ghostId: String(row.ghost_id),
    conversationId: String(row.conversation_id),
    sequence: Number(row.sequence),
    senderKind: String(row.sender_kind),
    kind: String(row.kind),
    text: typeof row.text === "string" ? row.text : "",
    attachments: typeof row.attachments === "string" ? row.attachments : "[]",
    at: toMs(row.created_at_ms),
  }));

  const disclosures = new Map<string, string>();
  for (const row of select(db, "SELECT conversation_id, privacy FROM lifetime_conversation_disclosure")) {
    disclosures.set(String(row.conversation_id), String(row.privacy));
  }

  const goals = new Map<string, LegacyGoal>();
  for (const row of select(db, "SELECT id, revision, accountable_ghost, reply_conversation, payload FROM lifetime_goals")) {
    const body = payload<Record<string, unknown>>(row.payload, {});
    goals.set(String(row.id), {
      revision: Number(row.revision),
      ghost: String(row.accountable_ghost),
      replyConversation: String(row.reply_conversation),
      prompt: clip(body.prompt, 32768),
      acceptanceSpec: typeof body.acceptance_spec === "object" && body.acceptance_spec !== null ? (body.acceptance_spec as Record<string, unknown>) : null,
    });
  }

  const works: LegacyWork[] = select(db, "SELECT id, goal_id, state, execution_id, cancellation, payload FROM lifetime_work").map((row) => {
    const body = payload<{ blocker?: string | null }>(row.payload, {});
    return {
      id: String(row.id),
      goalId: String(row.goal_id),
      state: String(row.state),
      executionId: row.execution_id === null || row.execution_id === undefined ? null : String(row.execution_id),
      cancellation: String(row.cancellation ?? "none"),
      blocker: typeof body.blocker === "string" && body.blocker.length > 0 ? clip(body.blocker, 4096) : null,
    };
  });

  const links = new Map<string, LegacyLink>();
  for (const row of select(db, "SELECT child_work_id, parent_work_id, depth FROM lifetime_work_links WHERE current = 1")) {
    links.set(String(row.child_work_id), { parentId: String(row.parent_work_id), depth: Number(row.depth) });
  }

  const results = new Map<string, { summary: string; artifacts: LegacyResultArtifact[] }>();
  for (const row of select(db, "SELECT execution_id, payload FROM lifetime_results")) {
    const record = payload<{ event?: { summary?: unknown; artifacts?: unknown } }>(row.payload, {});
    const event = record.event ?? {};
    const artifacts = Array.isArray(event.artifacts) ? event.artifacts : [];
    results.set(String(row.execution_id), {
      summary: clip(event.summary, 16384),
      artifacts: artifacts
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          digest: String(item.digest ?? ""),
          locator: String(item.locator ?? ""),
          producingAttempt: String(item.producing_attempt ?? ""),
        }))
        .filter((item) => /^[a-f0-9]{64}$/.test(item.digest)),
    });
  }

  const acceptedWorks = new Set<string>(select(db, "SELECT work_id FROM lifetime_acceptances").map((row) => String(row.work_id)));

  // Profile stores supply persona and fallback names. Read-only; missing or
  // locked stores are skipped (display names already cover identity).
  const profiles = new Map<string, { name: string; persona: string; createdAt: number }>();
  const profilesDir = join(from, "profiles");
  if (existsSync(profilesDir)) {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const store = join(profilesDir, entry.name, "ghost.db");
      if (!existsSync(store)) continue;
      try {
        // Copied first: opening a WAL store in place would create side files
        // under the legacy root.
        const profileCopy = join(scratch, `profile-${entry.name}.db`);
        copyFileSync(store, profileCopy);
        const meta = new Database(profileCopy);
        try {
          const row = lookup(meta, "SELECT uuid, name, persona, created_at FROM meta WHERE id = 1");
          if (row) {
            profiles.set(String(row.uuid), {
              name: clip(row.name, 128) || entry.name,
              persona: clip(row.persona, 8192),
              createdAt: toMs(row.created_at),
            });
          }
        } finally {
          meta.close();
        }
      } catch {
        // A locked or unreadable profile store must not block identity import.
      }
    }
  }

  const displayNames = new Map<string, string>();
  for (const row of select(db, "SELECT id, payload FROM workspace_objects WHERE kind = 'display_name'")) {
    const name = clip(payload<string>(row.payload, ""), 128);
    if (name) displayNames.set(String(row.id), name);
  }

  const defaultGhostRow = lookup(db, "SELECT payload FROM workspace_objects WHERE kind = 'meta' AND id = 'default_ghost'");
  const defaultGhostId = defaultGhostRow ? clip(payload<string>(defaultGhostRow.payload, ""), 128) || null : null;

  const avatars: LegacyAvatar[] = [];
  const avatarImages = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  for (const row of select(db, "SELECT id, payload FROM workspace_objects WHERE kind = 'avatar'")) {
    const body = payload<Record<string, unknown>>(row.payload, {});
    const imageRow = lookup(db, "SELECT payload FROM workspace_objects WHERE kind = 'avatar_image' AND id = ?", String(row.id));
    if (imageRow) {
      const dataUrl = payload<string>(imageRow.payload, "");
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (match) avatarImages.set(String(row.id), { bytes: new Uint8Array(Buffer.from(match[2]!, "base64")), mediaType: match[1]! });
    }
    avatars.push({
      id: String(row.id),
      name: clip(body.name, 128) || "avatar",
      description: clip(body.description, 2048),
      design: typeof body.design === "object" && body.design !== null ? (body.design as Record<string, unknown>) : null,
      createdAt: toMs(body.created_ms),
    });
  }

  const ghostAvatars = new Map<string, string | null>();
  for (const row of select(db, "SELECT id, payload FROM workspace_objects WHERE kind = 'profile_avatar'")) {
    const body = payload<{ avatar_id?: string | null }>(row.payload, {});
    ghostAvatars.set(String(row.id), typeof body.avatar_id === "string" ? body.avatar_id : null);
  }

  const inferenceRow = lookup(db, "SELECT payload FROM workspace_objects WHERE kind = 'inference_settings_v1' AND id = 'workspace'");
  const inference = inferenceRow ? { ...DEFAULT_INFERENCE, ...payload<Partial<LegacyInference>>(inferenceRow.payload, {}) } : DEFAULT_INFERENCE;

  const credentialKeys: { provider: string; apiKey: string }[] = [];
  const credentialsDir = join(from, "inference-credentials");
  if (existsSync(credentialsDir)) {
    for (const entry of readdirSync(credentialsDir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const body = payload<{ api_key?: unknown }>(readFileSync(join(credentialsDir, entry), "utf8"), {});
        if (typeof body.api_key === "string" && body.api_key.length > 0) credentialKeys.push({ provider: entry.slice(0, -".json".length), apiKey: body.api_key });
      } catch {
        // Unreadable credentials are reported through the skipped notes below.
      }
    }
  }

  const wakes = select(db, "SELECT id, payload FROM workspace_objects WHERE kind = 'wake'").map((row) => {
    const body = payload<Record<string, unknown>>(row.payload, {});
    const origin = typeof body.origin === "object" && body.origin !== null ? (body.origin as Record<string, unknown>) : {};
    return {
      id: String(row.id),
      profileId: String(body.profile_id ?? ""),
      prompt: clip(body.prompt, 8192),
      nextRunAt: toMs(body.next_run_ms),
      createdAt: toMs(origin.created_ms),
      paused: body.paused === true,
    };
  });

  let devices = 0;
  for (const path of [join(from, "devices.json"), join(dirname(from), "devices.json")]) {
    if (!existsSync(path)) continue;
    try {
      const registry = payload<{ devices?: unknown }>(readFileSync(path, "utf8"), {});
      devices = Array.isArray(registry.devices) ? registry.devices.filter((device) => typeof device === "object" && device !== null).length : 0;
    } catch {
      devices = 0;
    }
    break;
  }

  const lifetimePlumbingRows = ["lifetime_outbox", "lifetime_mailbox", "lifetime_notifications"].reduce(
    (sum, table) => sum + select(db, `SELECT 1 FROM ${table} LIMIT 1`).length,
    0,
  );
  const piExecutionRows = ["lifetime_pi_executions", "lifetime_pi_effects"].reduce((sum, table) => sum + select(db, `SELECT 1 FROM ${table} LIMIT 1`).length, 0);

  return {
    registry,
    bindings,
    turns,
    disclosures,
    goals,
    works,
    links,
    results,
    acceptedWorks,
    profiles,
    displayNames,
    defaultGhostId,
    avatars,
    avatarImages,
    ghostAvatars,
    inference,
    credentialKeys,
    wakes,
    devices,
    kindCounts,
    hasProfiles: profiles.size > 0,
    lifetimePlumbingRows,
    piExecutionRows,
  };
}

function assertEmptyTarget(ledger: Ledger): void {
  const tables = [
    "ghosts",
    "conversations",
    "works",
    "decisions",
    "effects",
    "artifacts",
    "schedules",
    "notifications",
    "devices",
    "pairings",
    "spaces",
    "avatars",
    "providers",
    "requests",
  ];
  const total = ledger.db.query(`SELECT (${tables.map((table) => `(SELECT COUNT(*) FROM ${table})`).join(" + ")}) AS total`).get() as { total: number };
  if (Number(total.total) > 0) throw new Error("import refused: the target ledger already contains data");
}

/**
 * Reads result artifact bytes, verifying the digest: from `pi-execution/` in the legacy root,
 * then from each extra worker journal root (the native workers kept theirs outside the root).
 */
function readResultArtifact(from: string, artifact: LegacyResultArtifact, executionId: string, artifactRoots: readonly string[]): Uint8Array | null {
  const piRoot = resolve(join(from, "pi-execution"));
  const candidates: string[] = [];
  if (artifact.locator && !artifact.locator.includes("..")) {
    const candidate = resolve(piRoot, artifact.locator);
    if (candidate.startsWith(`${piRoot}/`)) candidates.push(candidate);
  }
  const executionKey = artifact.producingAttempt || executionId;
  if (executionKey) {
    for (const root of [piRoot, ...artifactRoots]) candidates.push(join(resolve(root), "artifacts", sha256(executionKey), `${artifact.digest}.json`));
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const bytes = new Uint8Array(readFileSync(path));
      if (sha256(bytes) === artifact.digest) return bytes;
    } catch {
      return null;
    }
  }
  return null;
}

function planGhost(
  row: { ghostId: string; kind: string; conversationId: string; mode: string },
  legacy: Legacy,
  defaultId: string | null,
  selectionFor: (ghostId: string, conversationId: string) => ModelRef | null,
  lastActivityAt: number,
  now: number,
): PlannedGhost {
  const profile = legacy.profiles.get(row.ghostId);
  const name = legacy.displayNames.get(row.ghostId) ?? profile?.name ?? row.ghostId;
  const createdAt = profile?.createdAt ?? now;
  const lastActivity = lastActivityAt;
  const ghost: Ghost = {
    id: row.ghostId,
    name,
    persona: profile?.persona ?? "",
    look: { avatarId: legacy.ghostAvatars.get(row.ghostId) ?? null },
    // Model choices were per conversation in the legacy host; the Ghost follows the default.
    model: null,
    isDefault: row.ghostId === defaultId,
    // Draining Ghosts accepted no new work; paused preserves that posture.
    state: row.mode === "draining" ? "paused" : "active",
    directConversationId: row.conversationId,
    createdAt,
    updatedAt: now,
  };
  const canonical: PlannedConversation = {
    conversation: {
      id: row.conversationId,
      ghostId: row.ghostId,
      kind: "direct",
      workId: null,
      title: name,
      // The legacy disclosure is a privacy boundary the owner set; it is never loosened.
      privacy: LEGACY_PRIVACY[legacy.disclosures.get(row.conversationId) ?? "private"] ?? "private",
      model: selectionFor(row.ghostId, row.conversationId),
      busy: false,
      createdAt,
      lastActivityAt: lastActivity,
    },
    pair: { ghostId: row.ghostId, conversationId: row.conversationId },
  };
  return { ghost, conversations: [canonical] };
}

/** Owner turns are the user's messages; Ghost turns are the assistant's. */
function turnRole(turn: LegacyTurn): "user" | "assistant" | null {
  if (turn.senderKind === "owner" || turn.kind === "user") return "user";
  if (turn.senderKind === "ghost" || turn.kind === "assistant_advisory") return "assistant";
  return null;
}

function historyMessages(turnsByKey: Map<string, LegacyTurn[]>, pair: { ghostId: string; conversationId: string }): PlannedMessage[] {
  const messages: PlannedMessage[] = [];
  for (const turn of turnsByKey.get(`${pair.ghostId}/${pair.conversationId}`) ?? []) {
    if (turn.text.trim().length === 0) continue;
    const role = turnRole(turn);
    if (role === null) continue;
    messages.push({ role, text: turn.text, at: turn.at });
  }
  return messages;
}

export async function runImport(opts: {
  from: string;
  /** Extra worker journal roots holding `artifacts/<sha256(execution)>/<digest>.json`. */
  artifactRoots?: readonly string[];
  ledger: Ledger;
  engine: Engine;
  core: Core;
  log: (line: string) => void;
}): Promise<ImportReport> {
  const { from, ledger, engine, core, log } = opts;
  const artifactRoots = opts.artifactRoots ?? [];
  assertEmptyTarget(ledger);

  const workspace = openLegacyWorkspace(from);
  let legacy: Legacy;
  try {
    legacy = readLegacy(from, workspace.db, workspace.scratch);
  } finally {
    workspace.cleanup();
  }
  log(`read legacy root ${from}`);

  const skipped: string[] = [];
  const note = (line: string): void => {
    if (!skipped.includes(line)) skipped.push(line);
  };
  const now = Date.now();

  // Turns grouped by conversation, already ordered by sequence.
  const turnsByKey = new Map<string, LegacyTurn[]>();
  for (const turn of legacy.turns) {
    const key = `${turn.ghostId}/${turn.conversationId}`;
    const list = turnsByKey.get(key);
    if (list) list.push(turn);
    else turnsByKey.set(key, [turn]);
  }

  const selectionFor = (ghostId: string, conversationId: string): ModelRef | null => {
    const selection = legacy.inference.conversations[`${ghostId}/${conversationId}`];
    if (!selection) return null;
    const thinking = THINKING[selection.effort];
    return { provider: selection.provider, model: selection.model, ...(thinking ? { thinking } : {}) };
  };

  // ---- Ghost identities ----------------------------------------------------

  const primaryGhost = legacy.registry.find((row) => row.kind === "primary");
  const defaultId =
    legacy.defaultGhostId && legacy.registry.some((row) => row.ghostId === legacy.defaultGhostId)
      ? legacy.defaultGhostId
      : (primaryGhost?.ghostId ?? legacy.registry[0]?.ghostId ?? null);
  const ghostPlans = legacy.registry.map((row) =>
    planGhost(row, legacy, defaultId, selectionFor, turnsByKey.get(`${row.ghostId}/${row.conversationId}`)?.at(-1)?.at ?? now, now),
  );
  const ghostById = new Map(ghostPlans.map((plan) => [plan.ghost.id, plan]));
  const conversationIds = new Set(ghostPlans.map((plan) => plan.ghost.directConversationId));

  // Extra conversations from lifetime_bindings keep their legacy ids too.
  for (const binding of legacy.bindings) {
    const plan = ghostById.get(binding.ghostId);
    if (!plan) {
      note(`conversation ${binding.conversationId}: bound Ghost ${binding.ghostId} is not in the lifetime registry`);
      continue;
    }
    if (conversationIds.has(binding.conversationId)) continue;
    const privacy = LEGACY_PRIVACY[legacy.disclosures.get(binding.conversationId) ?? "private"] ?? "private";
    const lastActivity = turnsByKey.get(`${binding.ghostId}/${binding.conversationId}`)?.at(-1)?.at ?? now;
    plan.conversations.push({
      conversation: {
        id: binding.conversationId,
        ghostId: binding.ghostId,
        kind: "direct",
        workId: null,
        title: plan.ghost.name,
        privacy,
        model: selectionFor(binding.ghostId, binding.conversationId),
        busy: false,
        createdAt: now,
        lastActivityAt: lastActivity,
      },
      pair: { ghostId: binding.ghostId, conversationId: binding.conversationId },
    });
    conversationIds.add(binding.conversationId);
  }

  // ---- Avatars ---------------------------------------------------------------

  const avatarPlans: PlannedAvatar[] = [];
  const importedAvatarIds = new Set<string>();
  for (const avatar of legacy.avatars) {
    const image = legacy.avatarImages.get(avatar.id);
    if (!image) {
      note(`avatar ${avatar.id}: image data is missing or unreadable`);
      continue;
    }
    avatarPlans.push({
      avatar: {
        id: avatar.id,
        name: avatar.name,
        description: avatar.description,
        imageDigest: sha256(image.bytes),
        design: avatar.design,
        createdAt: avatar.createdAt,
      },
      bytes: image.bytes,
      mediaType: image.mediaType,
    });
    importedAvatarIds.add(avatar.id);
  }
  for (const plan of ghostPlans) {
    const wanted = plan.ghost.look.avatarId;
    if (wanted && !importedAvatarIds.has(wanted)) {
      plan.ghost.look = { avatarId: null };
      note(`ghost ${plan.ghost.id}: avatar ${wanted} is unavailable; the Ghost gets no avatar`);
    }
  }

  // ---- Works ------------------------------------------------------------------

  // Legacy delegation links keep their shape: a child Work stays under its
  // parent, and the root Work anchors the tree.
  const eligible: { legacyWork: LegacyWork; goal: LegacyGoal; plan: PlannedGhost }[] = [];
  for (const legacyWork of legacy.works) {
    const goal = legacy.goals.get(legacyWork.goalId);
    if (!goal) {
      note(`work ${legacyWork.id}: its Goal ${legacyWork.goalId} is missing`);
      continue;
    }
    const plan = ghostById.get(goal.ghost);
    if (!plan) {
      note(`work ${legacyWork.id}: accountable Ghost ${goal.ghost} is not in the lifetime registry`);
      continue;
    }
    eligible.push({ legacyWork, goal, plan });
  }
  const eligibleIds = new Set(eligible.map((entry) => entry.legacyWork.id));
  const parentOf = (id: string): string | null => {
    const link = legacy.links.get(id);
    if (!link) return null;
    return eligibleIds.has(link.parentId) ? link.parentId : null;
  };
  const rootOf = (id: string): string => {
    let current = id;
    const seen = new Set<string>([id]);
    for (;;) {
      const parent = parentOf(current);
      if (!parent || seen.has(parent)) return current;
      seen.add(parent);
      current = parent;
    }
  };
  const depthOf = (id: string): number => {
    let depth = 0;
    let current = id;
    const seen = new Set<string>([id]);
    for (;;) {
      const parent = parentOf(current);
      if (!parent || seen.has(parent)) return depth;
      seen.add(parent);
      current = parent;
      depth++;
    }
  };
  for (const entry of eligible) {
    const link = legacy.links.get(entry.legacyWork.id);
    if (link && !eligibleIds.has(link.parentId)) {
      note(`work ${entry.legacyWork.id}: its parent work ${link.parentId} is not carried`);
    }
  }

  const workPlans: PlannedWork[] = [];
  for (const { legacyWork, goal, plan } of eligible) {
    const accepted = legacy.acceptedWorks.has(legacyWork.id) || legacyWork.state === "accepted";
    const cancelled = legacyWork.cancellation !== "none" || legacyWork.state === "cancelled";
    const state = accepted ? "done" : cancelled ? "cancelled" : "failed";
    const resultRecord = legacyWork.executionId ? legacy.results.get(legacyWork.executionId) : undefined;
    const artifacts: PlannedArtifact[] = [];
    const refs: ArtifactRef[] = [];
    for (const artifact of resultRecord?.artifacts ?? []) {
      if (refs.length >= 64) {
        note(`work ${legacyWork.id}: artifact references beyond the first 64 are not carried`);
        break;
      }
      const bytes = readResultArtifact(from, artifact, legacyWork.executionId!, artifactRoots);
      if (!bytes) {
        note(`work ${legacyWork.id}: artifact ${artifact.digest.slice(0, 12)} is not present in the artifact roots; it is not carried`);
        continue;
      }
      const name = clip(basename(artifact.locator || artifact.digest).replace(/\.json$/, ""), 256) || artifact.digest;
      refs.push({ digest: artifact.digest, name, mediaType: mediaTypeFor(name), size: bytes.length });
      artifacts.push({ ref: refs.at(-1)!, bytes, name });
    }
    const title = clip(goal.prompt, 256) || `imported work ${legacyWork.id.slice(0, 12)}`;
    const originConversation = conversationIds.has(goal.replyConversation) ? goal.replyConversation : plan.ghost.directConversationId;
    workPlans.push({
      work: {
        id: legacyWork.id,
        parentId: parentOf(legacyWork.id),
        rootId: rootOf(legacyWork.id),
        ghostId: plan.ghost.id,
        originConversationId: originConversation,
        conversationId: null,
        title,
        brief: goal.prompt || title,
        acceptance: {
          criteria: goal.acceptanceSpec ? clip(JSON.stringify(goal.acceptanceSpec), 8192) : "carried over from the legacy host",
          checks: [],
          reviewer: null,
        },
        state,
        revision: 1,
        revisionsUsed: 0,
        deadlineAt: null,
        result: resultRecord ? { summary: resultRecord.summary, artifacts: refs } : null,
        verdict: accepted ? { outcome: "pass", source: "owner", reasons: "accepted by the owner before import", at: now } : null,
        reason: state === "failed" ? "imported unfinished" : state === "cancelled" ? (legacyWork.blocker ?? "cancelled before import") : null,
        createdAt: now,
        startedAt: null,
        endedAt: now,
        updatedAt: now,
      },
      artifacts,
    });
  }
  // Parents are written before their children so the tree stays intact.
  workPlans.sort((left, right) => depthOf(left.work.id) - depthOf(right.work.id));

  // ---- Providers, credentials, default model ---------------------------------

  const referencedProviders = new Set<string>([
    legacy.inference.default.provider,
    legacy.inference.image_provider,
    ...Object.values(legacy.inference.conversations).map((selection) => selection.provider),
    ...legacy.credentialKeys.map((entry) => entry.provider),
  ].filter(Boolean));
  const providerPlans: Provider[] = [];
  const localModels = new Set<string>();
  if (legacy.inference.default.provider === "local") localModels.add(legacy.inference.default.model);
  for (const selection of Object.values(legacy.inference.conversations)) {
    if (selection.provider === "local") localModels.add(selection.model);
  }
  for (const id of [...referencedProviders].sort()) {
    const entry = PROVIDER_CATALOG[id];
    if (!entry) {
      note(`provider ${id}: unknown legacy provider is not carried`);
      continue;
    }
    const models = entry.models.length > 0 ? entry.models : [...localModels];
    providerPlans.push({
      id,
      kind: entry.kind,
      name: entry.name,
      baseUrl: null,
      models: models.map((model) => ({ id: model, name: model })),
      local: entry.local,
      hasCredential: legacy.credentialKeys.some((key) => key.provider === id),
    });
  }
  const defaultSelection = legacy.inference.default;
  const defaultThinking = THINKING[defaultSelection.effort];
  const defaultModel: ModelRef | null = providerPlans.some((provider) => provider.id === defaultSelection.provider)
    ? { provider: defaultSelection.provider, model: defaultSelection.model, ...(defaultThinking ? { thinking: defaultThinking } : {}) }
    : null;
  if (defaultModel === null) note(`providers: default selection ${defaultSelection.provider}/${defaultSelection.model} has no carried provider`);

  // ---- Schedules ----------------------------------------------------------------

  const schedulePlans: Schedule[] = [];
  let pausedWakes = 0;
  for (const wake of legacy.wakes) {
    if (wake.paused) {
      pausedWakes++;
      continue;
    }
    const plan = ghostById.get(wake.profileId);
    if (!plan) {
      note(`schedule ${wake.id}: its Ghost ${wake.profileId} is not in the lifetime registry`);
      continue;
    }
    if (!wake.prompt) {
      note(`schedule ${wake.id}: empty prompt`);
      continue;
    }
    schedulePlans.push({
      id: wake.id,
      ghostId: plan.ghost.id,
      conversationId: plan.ghost.directConversationId,
      prompt: wake.prompt,
      // Legacy wakes repeat daily at a local wall-clock time; the closest new
      // spec is a daily interval anchored at the stored next occurrence.
      spec: { kind: "every", seconds: 86400, startAt: wake.nextRunAt },
      nextAt: wake.nextRunAt,
      state: "active",
      createdAt: wake.createdAt,
    });
  }
  if (pausedWakes > 0) note(`schedules: ${pausedWakes} paused wake schedule(s) are not carried`);
  if ((legacy.kindCounts.get("wake_run") ?? 0) > 0) note("wake occurrence run records are not carried");

  // ---- Devices --------------------------------------------------------------------

  if (legacy.devices > 0) {
    note(`devices: ${legacy.devices} paired device(s) require re-pairing; legacy gateway token hashes are incompatible with the host's secret hashing`);
  }

  // ---- Everything the new host does not model --------------------------------------

  const kindTotal = (...patterns: RegExp[]): number =>
    [...legacy.kindCounts.entries()].filter(([kind]) => patterns.some((pattern) => pattern.test(kind))).reduce((sum, [, n]) => sum + n, 0);
  if ((legacy.kindCounts.get("todo") ?? 0) + (legacy.kindCounts.get("calendar_event") ?? 0) > 0) {
    note("planner: legacy todos and calendar events are outside the new product scope");
  }
  if (kindTotal(/^routing_/) > 0) note("routing: legacy routing executions and decisions are not carried");
  if (kindTotal(/^(orchestration_|orchestra_)/) > 0) note("orchestration: legacy orchestration plans and reviews are not carried");
  if (kindTotal(/^(integration|incident_|slack_|voice_|spend$)/) > 0) note("integrations: legacy integration, incident and channel state is not carried");
  if (kindTotal(/^(bot_|pi_provisioned_route$)/) > 0) note("bots pipeline: legacy bot definitions and provisioning state are not carried");
  if (kindTotal(/^(work_memory_|shared_skill_)/) > 0 || legacy.kindCounts.has("memory_context_lineage_v1") || existsSync(join(from, "source-ledger.sqlite"))) {
    note("memory publication: legacy memory grants, publications and the source ledger are not carried");
  }
  if (legacy.hasProfiles) note("legacy profile runtime: per-profile stores (sessions, tasks, effects, grants, skills) are retired and not carried");
  if (legacy.lifetimePlumbingRows > 0) note("legacy dispatch ledgers (commands, outbox, mailbox, notifications) are not carried");
  if (legacy.piExecutionRows > 0) note("Pi execution bindings and per-call effect receipts are not carried; imported Works are terminal");
  if (legacy.inference.image_provider !== DEFAULT_INFERENCE.image_provider) {
    note(`inference: image provider preference ${legacy.inference.image_provider} is not carried`);
  }
  if (Object.keys(legacy.inference.conversations).length > 0) {
    note("inference: per-conversation external provider grants are not carried; privacy gates are rebuilt by the host");
  }

  // History notes over the conversations actually imported.
  let droppedAttachments = 0;
  let droppedEmpty = 0;
  let droppedHostFacts = 0;
  for (const plan of ghostPlans) {
    for (const entry of plan.conversations) {
      for (const turn of turnsByKey.get(`${entry.pair.ghostId}/${entry.pair.conversationId}`) ?? []) {
        if (turn.text.trim().length === 0) droppedEmpty++;
        const attachments = payload<unknown[]>(turn.attachments, []);
        if (Array.isArray(attachments) && attachments.length > 0) droppedAttachments++;
        if (turnRole(turn) === null) droppedHostFacts++;
      }
    }
  }
  if (droppedAttachments > 0) note(`history: ${droppedAttachments} message(s) referenced attachments; attachment bytes are not carried`);
  if (droppedEmpty > 0) note(`history: ${droppedEmpty} empty message(s) dropped`);
  if (droppedHostFacts > 0) note(`history: ${droppedHostFacts} host-generated notice(s) dropped`);

  // ---- Phase 1: copy bytes into the artifact store ---------------------------------

  for (const plan of avatarPlans) {
    const extension = plan.mediaType.split("/")[1] ?? "bin";
    const ref = await core.artifacts.put(plan.bytes, `${plan.avatar.name}.${extension}`, plan.mediaType);
    plan.avatar.imageDigest = ref.digest;
  }
  for (const plan of workPlans) {
    for (const artifact of plan.artifacts) {
      const ref = await core.artifacts.put(artifact.bytes, artifact.name, mediaTypeFor(artifact.name));
      artifact.ref = ref;
    }
  }

  // ---- Phase 2: one ledger transaction ----------------------------------------------

  const opened: { conversationId: string; messages: PlannedMessage[] }[] = [];
  const importedConversations = new Set<string>();
  const importedProviders: string[] = [];
  ledger.tx(() => {
    for (const plan of ghostPlans) {
      try {
        ledger.putGhost(parse(Ghost, plan.ghost));
      } catch (error) {
        note(`ghost ${plan.ghost.id}: ${error instanceof Error ? error.message : "invalid data"}`);
        continue;
      }
      for (const entry of plan.conversations) {
        try {
          ledger.putConversation(parse(Conversation, entry.conversation));
        } catch (error) {
          note(`conversation ${entry.conversation.id}: ${error instanceof Error ? error.message : "invalid data"}`);
          continue;
        }
        importedConversations.add(entry.conversation.id);
        opened.push({ conversationId: entry.conversation.id, messages: historyMessages(turnsByKey, entry.pair) });
      }
    }
    for (const plan of avatarPlans) {
      try {
        ledger.putAvatar(parse(Avatar, plan.avatar));
      } catch (error) {
        note(`avatar ${plan.avatar.id}: ${error instanceof Error ? error.message : "invalid data"}`);
      }
    }
    for (const plan of workPlans) {
      if (!importedConversations.has(plan.work.originConversationId)) {
        note(`work ${plan.work.id}: its origin conversation is missing`);
        continue;
      }
      try {
        ledger.putWork(parse(Work, plan.work));
      } catch (error) {
        note(`work ${plan.work.id}: ${error instanceof Error ? error.message : "invalid data"}`);
        continue;
      }
      for (const ref of plan.work.result?.artifacts ?? []) ledger.addArtifact(plan.work.id, ref);
      // History, not news: the old host already reported these.
      ledger.markReported(plan.work.id, now);
    }
    for (const provider of providerPlans) {
      try {
        ledger.putProvider(parse(Provider, provider));
        importedProviders.push(provider.id);
      } catch (error) {
        note(`provider ${provider.id}: ${error instanceof Error ? error.message : "invalid data"}`);
      }
    }
    for (const schedule of schedulePlans) {
      if (!importedConversations.has(schedule.conversationId)) {
        note(`schedule ${schedule.id}: its conversation is missing`);
        continue;
      }
      try {
        ledger.putSchedule(parse(Schedule, schedule));
      } catch (error) {
        note(`schedule ${schedule.id}: ${error instanceof Error ? error.message : "invalid data"}`);
      }
    }
    if (defaultModel && importedProviders.includes(defaultModel.provider)) ledger.putSetting("defaultModel", defaultModel);
  });

  // Credentials land after the ledger commit; losing them must not roll back rows.
  for (const id of importedProviders) {
    const credential = legacy.credentialKeys.find((key) => key.provider === id);
    if (credential) core.secrets.put(id, credential.apiKey);
  }

  // ---- Phase 3: conversations open with their imported history ------------------------

  let messages = 0;
  for (const entry of opened) {
    await core.openConversation(entry.conversationId);
    if (entry.messages.length > 0) {
      await engine.appendHistory(entry.conversationId, entry.messages);
      messages += entry.messages.length;
    }
  }

  log(
    `imported ${ghostPlans.length} ghosts, ${opened.length} conversations, ${messages} messages, ${workPlans.length} works, ` +
      `${importedProviders.length} providers, ${schedulePlans.length} schedules, ${avatarPlans.length} avatars; ${skipped.length} note(s)`,
  );
  return {
    ghosts: ghostPlans.length,
    conversations: opened.length,
    messages,
    works: workPlans.length,
    devices: legacy.devices,
    providers: importedProviders.length,
    schedules: schedulePlans.length,
    avatars: avatarPlans.length,
    skipped,
  };
}
