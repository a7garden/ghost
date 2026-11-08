import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelInfo, ProviderPreset, Provider as ContractProvider } from "@ghost/contract";
import type { Api, Model, Provider as PiProvider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export type CatalogFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The contract caps one bundled catalog at 256 entries. */
const CATALOG_LIMIT = 256;

/** The only remote catalog source; never configurable, never sent credentials. */
const CATALOG_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 10_000;
/** The live api.json measures ~6 MB today; 32 MiB leaves room for provider growth while staying bounded. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** The cache holds only normalized mapped keys, far smaller than the raw response. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
/** A snapshot younger than this is considered fresh and is not re-fetched. */
const FRESH_MS = 6 * 60 * 60 * 1000;
/** How often the background timer re-checks freshness. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_VERSION = 1;

/**
 * Static chat metadata of one bundled SDK provider. Building the provider and
 * calling `getModels()` is pure — no credential is read and no request is made —
 * so this is safe at module scope. Duplicate ids keep the first entry's
 * metadata, and the catalog is capped at the contract limit.
 */
function chatCatalog(provider: PiProvider): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const model of provider.getModels()) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const info: ModelInfo = { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning };
    const inputs = [...model.input].filter((entry) => entry === "text" || entry === "image");
    if (inputs.length > 0) info.input = inputs;
    models.push(info);
    if (models.length === CATALOG_LIMIT) break;
  }
  return models;
}

/** The suggested default id only when the list actually contains it; null, never a guessed fallback. */
const recommended = (models: readonly ModelInfo[], suggested: string | null): string | null =>
  suggested !== null && models.some((model) => model.id === suggested) ? suggested : null;

const openai = openaiProvider();
const codex = openaiCodexProvider();
const anthropic = anthropicProvider();
const google = googleProvider();
const zai = zaiProvider();
const minimax = minimaxProvider();

const openaiModels = chatCatalog(openai);
const codexModels = chatCatalog(codex);
const anthropicModels = chatCatalog(anthropic);
const googleModels = chatCatalog(google);
const zaiModels = chatCatalog(zai);
const minimaxModels = chatCatalog(minimax);

const CAPABILITY_SOURCES: Record<ContractProvider["kind"], readonly PiProvider[]> = {
  openai: [openai],
  openai_compatible: [openai, zai, anthropic, google, minimax],
  anthropic: [anthropic],
  google: [google],
  zai: [zai],
  minimax: [minimax],
};

/** Static SDK capabilities only; unknown custom model ids remain text-only. */
export function modelInputFor(kind: ContractProvider["kind"], id: string, api: Api): Model<Api>["input"] {
  const sources = api === "openai-codex-responses" ? [codex] : CAPABILITY_SOURCES[kind];
  for (const source of sources) {
    const model = source.getModels().find((model) => model.id === id);
    if (model) return model.input;
  }
  return ["text"];
}

/**
 * Cold-start seeds: default base urls come from the SDK factories, catalogs and
 * recommendations from their static metadata. `ProviderCatalog.presets` merges
 * these with the refreshed remote catalog, so the suggestions stay fixed while
 * the lists grow.
 */
interface PresetSeed {
  readonly id: string;
  readonly kind: ContractProvider["kind"];
  readonly name: string;
  readonly baseUrl: string | null;
  readonly credentialUrl: string | null;
  readonly models: readonly ModelInfo[];
  readonly oauthModels: readonly ModelInfo[];
  readonly suggestedModelId: string | null;
  readonly suggestedOAuthModelId: string | null;
}

const PRESET_SEEDS: readonly PresetSeed[] = [
  {
    id: "openai",
    kind: "openai",
    name: "OpenAI",
    baseUrl: openai.baseUrl ?? null,
    credentialUrl: "https://platform.openai.com/api-keys",
    models: openaiModels,
    oauthModels: codexModels,
    suggestedModelId: "gpt-6-luna",
    suggestedOAuthModelId: "gpt-6-luna",
  },
  {
    id: "anthropic",
    kind: "anthropic",
    name: "Anthropic",
    baseUrl: anthropic.baseUrl ?? null,
    credentialUrl: "https://platform.claude.com/settings/keys",
    models: anthropicModels,
    oauthModels: [],
    suggestedModelId: "claude-sonnet-5-5",
    suggestedOAuthModelId: null,
  },
  {
    id: "google",
    kind: "google",
    name: "Google Gemini",
    baseUrl: google.baseUrl ?? null,
    credentialUrl: "https://aistudio.google.com/apikey",
    models: googleModels,
    oauthModels: [],
    suggestedModelId: "gemini-3.8-flash",
    suggestedOAuthModelId: null,
  },
  {
    id: "zai",
    kind: "zai",
    name: "Z.AI Coding Plan",
    baseUrl: zai.baseUrl ?? null,
    credentialUrl: "https://z.ai/manage-apikey/apikey-list",
    models: zaiModels,
    oauthModels: [],
    suggestedModelId: "glm-5.3",
    suggestedOAuthModelId: null,
  },
  {
    id: "minimax",
    kind: "minimax",
    name: "MiniMax",
    baseUrl: minimax.baseUrl ?? null,
    credentialUrl: "https://platform.minimax.io/console/keys",
    models: minimaxModels,
    oauthModels: [],
    suggestedModelId: "MiniMax-M3",
    suggestedOAuthModelId: null,
  },
  {
    id: "custom",
    kind: "openai_compatible",
    name: "OpenAI 호환 서버",
    baseUrl: null,
    credentialUrl: null,
    models: [],
    oauthModels: [],
    suggestedModelId: null,
    suggestedOAuthModelId: null,
  },
];

/**
 * Remote catalog keys per endpoint. `null` baseUrl means the kind's default
 * upstream address; otherwise only an exact match on an official endpoint may
 * expand. MiniMax serves its API and coding-plan catalogs from the same
 * endpoint, so both key sets apply there. Custom, nonstandard and
 * OpenAI-compatible endpoints never expand, and the ChatGPT (Codex) OAuth
 * endpoint is deliberately absent: the API-key catalog must never leak into the
 * subscription catalog.
 */
const DEFAULT_KEYS: Record<ContractProvider["kind"], readonly string[]> = {
  openai: ["openai"],
  openai_compatible: [],
  anthropic: ["anthropic"],
  google: ["google"],
  zai: ["zai-coding-plan"],
  minimax: ["minimax", "minimax-coding-plan"],
};

const EXACT_KEYS: readonly (readonly [url: string, kind: ContractProvider["kind"], keys: readonly string[]])[] = [
  ["https://api.openai.com/v1", "openai", ["openai"]],
  ["https://api.anthropic.com", "anthropic", ["anthropic"]],
  ["https://generativelanguage.googleapis.com/v1beta", "google", ["google"]],
  ["https://api.z.ai/api/coding/paas/v4", "zai", ["zai-coding-plan"]],
  ["https://api.z.ai/api/paas/v4", "zai", ["zai"]],
  ["https://api.minimax.io/anthropic", "minimax", ["minimax", "minimax-coding-plan"]],
];

const catalogKeysFor = (kind: ContractProvider["kind"], baseUrl: string | null): readonly string[] => {
  if (baseUrl === null) return DEFAULT_KEYS[kind];
  for (const [url, urlKind, keys] of EXACT_KEYS) {
    if (urlKind === kind && url === baseUrl) return keys;
  }
  return [];
};

/** Whether `modelsFor` would append remote catalog models for this configured endpoint. */
export function supportsAutomaticModels(provider: Pick<ContractProvider, "kind" | "baseUrl">): boolean {
  return catalogKeysFor(provider.kind, provider.baseUrl).length > 0;
}

/** One validated remote entry; `deprecated` stays internal and never reaches ModelInfo. */
interface CatalogModel extends ModelInfo {
  deprecated?: true;
}

interface Snapshot {
  readonly fetchedAt: number;
  readonly providers: Record<string, CatalogModel[]>;
}

const isPositiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

const boundedString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Keep only declared, bounded protocol values, in stable order for cache comparisons. */
const reasoningEfforts = (value: unknown): ModelInfo["reasoningEfforts"] => {
  if (!Array.isArray(value)) return undefined;
  const efforts = REASONING_EFFORTS.filter((effort) => value.includes(effort));
  return efforts.length > 0 ? efforts : undefined;
};

/**
 * Validates one models.dev model entry against the automatic-options bar:
 * tool calling, text in and out, and positive context/output limits. Entries
 * that cannot prove text chat behavior are ignored entirely; deprecated ones
 * are kept so explicitly saved ids keep refreshing.
 */
function normalizeModel(raw: unknown): CatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = boundedString(record.id, 256);
  if (id === null || record.tool_call !== true) return null;
  const modalities = record.modalities as Record<string, unknown> | null;
  const inputs = Array.isArray(modalities?.input) ? modalities.input : [];
  const outputs = Array.isArray(modalities?.output) ? modalities.output : [];
  if (!inputs.includes("text") || !outputs.includes("text")) return null;
  const limit = record.limit as Record<string, unknown> | null;
  if (!isPositiveInt(limit?.context) || !isPositiveInt(limit?.output)) return null;
  const model: CatalogModel = { id, name: boundedString(record.name, 256) ?? id, contextWindow: limit.context, maxTokens: limit.output };
  model.input = (inputs as unknown[]).includes("image") ? ["text", "image"] : ["text"];
  if (record.reasoning === true) model.reasoning = true;
  if (Array.isArray(record.reasoning_options)) {
    const declared: unknown[] = [];
    for (const option of record.reasoning_options) {
      if (typeof option !== "object" || option === null) continue;
      const choice = option as Record<string, unknown>;
      if (choice.type === "toggle") model.reasoningToggle = true;
      if (choice.type === "effort" && Array.isArray(choice.values)) {
        for (const effort of choice.values) declared.push(effort);
      }
    }
    const efforts = reasoningEfforts(declared);
    if (efforts !== undefined) model.reasoningEfforts = efforts;
  }
  if (record.deprecated === true || record.status === "deprecated") model.deprecated = true;
  return model;
}

/**
 * Validates a whole models.dev payload (or a persisted cache `providers` map)
 * down to the endpoint keys this host maps. At least one mapped provider must
 * survive, so a malformed or empty payload never wipes a good catalog. Model
 * order is canonicalized by id to keep change detection and cache writes stable.
 */
function normalizeProviders(root: unknown): Record<string, CatalogModel[]> | null {
  if (typeof root !== "object" || root === null) return null;
  const mapped = root as Record<string, unknown>;
  const providers: Record<string, CatalogModel[]> = {};
  let kept = 0;
  for (const key of CATALOG_KEYS) {
    const entry = mapped[key] as Record<string, unknown> | null;
    const rawModels = typeof entry === "object" && entry !== null ? entry.models : null;
    if (typeof rawModels !== "object" || rawModels === null) continue;
    const models: CatalogModel[] = [];
    const seen = new Set<string>();
    for (const raw of Object.values(rawModels)) {
      const model = normalizeModel(raw);
      if (model === null || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    if (models.length > 0) {
      models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      providers[key] = models;
      kept += models.length;
    }
  }
  return kept > 0 ? providers : null;
}

const cachedInputs = (value: unknown): ("text" | "image")[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const inputs = [...new Set(value)].filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
  return inputs.length > 0 ? inputs : undefined;
};

/** Validates one persisted entry; the cache stores normalized CatalogModels, never raw models.dev shapes. */
function parseCachedModel(raw: unknown): CatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = boundedString(record.id, 256);
  if (id === null) return null;
  const model: CatalogModel = { id, name: boundedString(record.name, 256) ?? id };
  if (isPositiveInt(record.contextWindow)) model.contextWindow = record.contextWindow;
  if (isPositiveInt(record.maxTokens)) model.maxTokens = record.maxTokens;
  const inputs = cachedInputs(record.input);
  if (inputs !== undefined) model.input = inputs;
  if (typeof record.reasoning === "boolean") model.reasoning = record.reasoning;
  const efforts = reasoningEfforts(record.reasoningEfforts);
  if (efforts !== undefined) model.reasoningEfforts = efforts;
  if (typeof record.reasoningToggle === "boolean") model.reasoningToggle = record.reasoningToggle;
  if (record.deprecated === true) model.deprecated = true;
  return model;
}

/** Validates the persisted providers map: mapped keys only, nonempty, canonical order like fresh snapshots. */
function parseCachedProviders(root: unknown): Record<string, CatalogModel[]> | null {
  if (typeof root !== "object" || root === null) return null;
  const mapped = root as Record<string, unknown>;
  const providers: Record<string, CatalogModel[]> = {};
  let kept = 0;
  for (const key of CATALOG_KEYS) {
    const rawModels = mapped[key];
    if (!Array.isArray(rawModels)) continue;
    const models: CatalogModel[] = [];
    const seen = new Set<string>();
    for (const raw of rawModels) {
      const model = parseCachedModel(raw);
      if (model === null || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    if (models.length > 0) {
      models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      providers[key] = models;
      kept += models.length;
    }
  }
  return kept > 0 ? providers : null;
}

/** A future fetchedAt marks a clock-skewed or tampered cache; reject it and stay on the bundled fallback. */
function parseCache(text: string, now: () => number): Snapshot | null {
  try {
    const record = JSON.parse(text) as Record<string, unknown> | null;
    if (record === null || typeof record !== "object" || record.version !== CACHE_VERSION) return null;
    if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt) || record.fetchedAt <= 0 || record.fetchedAt > now()) return null;
    const providers = parseCachedProviders(record.providers);
    return providers === null ? null : { fetchedAt: record.fetchedAt, providers };
  } catch {
    return null;
  }
}

const toModelInfo = (model: CatalogModel): ModelInfo => ({
  id: model.id,
  name: model.name,
  ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
  ...(model.input !== undefined ? { input: model.input } : {}),
  ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
  ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: model.reasoningEfforts } : {}),
  ...(model.reasoningToggle !== undefined ? { reasoningToggle: model.reasoningToggle } : {}),
});

/** Bundled offline fallback per remote key, used only where the snapshot has no models for a key. */
const SDK_FALLBACK: Record<string, readonly ModelInfo[]> = {
  openai: openaiModels,
  anthropic: anthropicModels,
  google: googleModels,
  "zai-coding-plan": zaiModels,
  zai: zaiModels,
  minimax: minimaxModels,
  "minimax-coding-plan": minimaxModels,
};

/** First catalog entry per id across the mapped keys; a key without snapshot data falls back to the bundled SDK list. */
function modelIndex(snapshot: Snapshot | null, keys: readonly string[]): Map<string, CatalogModel> {
  const index = new Map<string, CatalogModel>();
  for (const key of keys) {
    const models = snapshot !== null && snapshot.providers[key] !== undefined ? snapshot.providers[key] : SDK_FALLBACK[key];
    for (const model of models ?? []) {
      if (!index.has(model.id)) index.set(model.id, model);
    }
  }
  return index;
}

/**
 * Stored ids first, catalog metadata authoritative for ids the catalog knows,
 * stored metadata preserved for manual-only ids. `fallback` is always listed
 * (the bundled OAuth catalog); `additions` appends fresh catalog-only ids while
 * skipping deprecated ones — explicitly saved deprecated ids were already kept
 * and refreshed in the stored pass.
 */
function mergeModels(stored: readonly ModelInfo[], fallback: readonly ModelInfo[], index: Map<string, CatalogModel>, additions: boolean): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const push = (model: ModelInfo): void => {
    if (models.length >= CATALOG_LIMIT || seen.has(model.id)) return;
    models.push(model);
    seen.add(model.id);
  };
  for (const list of [stored, fallback]) {
    for (const model of list) {
      if (models.length >= CATALOG_LIMIT) break;
      const refreshed = index.get(model.id);
      push(refreshed !== undefined ? toModelInfo(refreshed) : model);
    }
  }
  if (additions) {
    for (const model of index.values()) {
      if (models.length >= CATALOG_LIMIT) break;
      if (model.deprecated !== true) push(toModelInfo(model));
    }
  }
  return models;
}

/**
 * Live account catalogs win for their ids; stored manual ids keep their place
 * and metadata. The Codex endpoint reports no maxTokens, so missing live fields
 * fall back to the remote OpenAI catalog or the bundled SDK entry; unknown
 * OAuth-only ids keep only the live fields and inherit the runtime defaults.
 */
function mergeLiveOAuth(stored: readonly ModelInfo[], live: readonly ModelInfo[], catalog: Map<string, CatalogModel>): ModelInfo[] {
  const base = new Map<string, ModelInfo>();
  const addBase = (model: ModelInfo): void => {
    if (!base.has(model.id)) base.set(model.id, model);
  };
  for (const model of catalog.values()) addBase(toModelInfo(model));
  for (const model of codexModels) addBase(model);
  const liveById = new Map<string, ModelInfo>();
  for (const model of live) {
    const fallback = base.get(model.id);
    const merged: ModelInfo = fallback !== undefined ? { ...fallback } : { id: model.id, name: model.name };
    merged.name = model.name;
    if (model.contextWindow !== undefined) merged.contextWindow = model.contextWindow;
    if (model.maxTokens !== undefined) merged.maxTokens = model.maxTokens;
    if (model.input !== undefined) merged.input = model.input;
    if (model.reasoning !== undefined) merged.reasoning = model.reasoning;
    if (model.reasoningEfforts !== undefined) merged.reasoningEfforts = model.reasoningEfforts;
    if (model.reasoningToggle !== undefined) merged.reasoningToggle = model.reasoningToggle;
    liveById.set(model.id, merged);
  }
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const push = (model: ModelInfo): void => {
    if (models.length >= CATALOG_LIMIT || seen.has(model.id)) return;
    models.push(model);
    seen.add(model.id);
  };
  for (const model of stored) push(liveById.get(model.id) ?? model);
  for (const model of liveById.values()) push(model);
  return models;
}

/** Endpoint keys this host maps, in table order; everything else is ignored. */
const CATALOG_KEYS = [...new Set([...Object.values(DEFAULT_KEYS).flat(), ...EXACT_KEYS.map(([, , keys]) => keys).flat()])];

/**
 * Externally refreshed provider catalog. The bundled SDK snapshot is the
 * cold-start fallback; `refresh()`/`start()` merge the models.dev catalog into
 * `presets` and `modelsFor`, validated and persisted atomically at `cachePath`.
 * Network access happens only inside `refresh()`/`start()`, always against the
 * fixed catalog URL, and never carries credentials. API failures keep the last
 * good catalog and never block the host.
 */
export class ProviderCatalog {
  private readonly cachePath: string | undefined;
  private readonly doFetch: CatalogFetch;
  private readonly doNow: () => number;
  private snapshot: Snapshot | null = null;
  /** When the current snapshot was last confirmed good (cache load or successful refresh). */
  private goodAt = 0;
  /** Whether the current snapshot already has a copy on disk. */
  private persisted = false;
  private closed = false;
  private inflight: Promise<boolean> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Live OAuth catalogs reported by the host; in-memory only, never persisted. */
  private readonly liveOAuth = new Map<string, ModelInfo[]>();

  constructor(options?: { cachePath?: string; fetch?: CatalogFetch; now?: () => number }) {
    this.cachePath = options?.cachePath;
    this.doFetch = options?.fetch ?? ((url: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(url, init));
    this.doNow = options?.now ?? Date.now;
    const cached = this.readCache();
    if (cached !== null) {
      this.snapshot = cached;
      this.goodAt = cached.fetchedAt;
      this.persisted = true;
    }
  }

  /** Bundled presets merged with the latest validated remote snapshot; with a snapshot present the list is the active catalog, SDK seeds only fill cold start. */
  get presets(): ProviderPreset[] {
    return PRESET_SEEDS.map((seed) => {
      const models = mergeModels([], [], modelIndex(this.snapshot, catalogKeysFor(seed.kind, seed.baseUrl)), true);
      const oauthModels =
        seed.kind === "openai"
          ? // Known ChatGPT-login ids pick up refreshed metadata; API-only models are never advertised.
            mergeModels(seed.oauthModels, [], modelIndex(this.snapshot, ["openai"]), false)
          : [];
      return {
        id: seed.id,
        kind: seed.kind,
        name: seed.name,
        baseUrl: seed.baseUrl,
        credentialUrl: seed.credentialUrl,
        models,
        oauthModels,
        recommendedModelId: recommended(models, seed.suggestedModelId),
        recommendedOAuthModelId: recommended(oauthModels, seed.suggestedOAuthModelId),
      };
    });
  }

  /**
   * The catalog for one configured provider: stored ids first (manual-only
   * metadata preserved), then compatible catalog ids from the provider's
   * endpoint. OAuth OpenAI uses the live account catalog when the host reported
   * one, falling back to the bundled ChatGPT-login catalog.
   */
  modelsFor(provider: ContractProvider, authType?: "api_key" | "oauth"): ModelInfo[] {
    if (provider.kind === "openai" && authType === "oauth") {
      const live = this.liveOAuth.get(provider.id);
      if (live !== undefined) return mergeLiveOAuth(provider.models, live, modelIndex(this.snapshot, ["openai"]));
      // No live list: bundled ChatGPT-login catalog, with known ids picking up refreshed metadata.
      return mergeModels(provider.models, codexModels, modelIndex(this.snapshot, ["openai"]), false);
    }
    return mergeModels(provider.models, [], modelIndex(this.snapshot, catalogKeysFor(provider.kind, provider.baseUrl)), true);
  }

  /**
   * Replaces the live OAuth catalog for one configured provider id. In-memory
   * only: never written to the shared disk cache. True when a nonempty valid
   * list was set for a fresh id or the list actually changed.
   */
  setOAuthModels(providerId: string, models: readonly ModelInfo[]): boolean {
    if (this.closed || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId)) return false;
    const live: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const model of models) {
      const id = boundedString(model?.id, 256);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      const entry: ModelInfo = { id, name: boundedString(model?.name, 256) ?? id };
      if (isPositiveInt(model?.contextWindow)) entry.contextWindow = model.contextWindow;
      if (isPositiveInt(model?.maxTokens)) entry.maxTokens = model.maxTokens;
      const inputs = Array.isArray(model?.input) ? [...new Set(model.input)].filter((value): value is "text" | "image" => value === "text" || value === "image") : [];
      if (inputs.length > 0) entry.input = inputs;
      if (typeof model?.reasoning === "boolean") entry.reasoning = model.reasoning;
      const efforts = reasoningEfforts(model?.reasoningEfforts);
      if (efforts !== undefined) entry.reasoningEfforts = efforts;
      if (typeof model?.reasoningToggle === "boolean") entry.reasoningToggle = model.reasoningToggle;
      live.push(entry);
      if (live.length >= CATALOG_LIMIT) break;
    }
    if (live.length === 0) return false;
    const current = this.liveOAuth.get(providerId);
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(live)) return false;
    this.liveOAuth.set(providerId, live);
    return true;
  }

  /** Drops the live OAuth catalog for one provider id; true when one existed. */
  clearOAuthModels(providerId: string): boolean {
    return this.liveOAuth.delete(providerId);
  }

  /**
   * Fetches and validates the remote catalog. True only when effective
   * metadata changed; network, body, and validation failures return false and
   * leave the last good catalog and its cache untouched.
   */
  refresh(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    this.inflight ??= this.runRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Background mode: an immediate due check (cache older than six hours or
   * absent), then hourly freshness checks. The callback fires only when a
   * refresh changed effective metadata. Refreshes are single-flight.
   */
  start(onChange: () => void): void {
    if (this.closed || this.initialTimer !== null || this.timer !== null) return;
    const tick = (): void => {
      if (this.closed || this.inflight !== null) return;
      if (this.doNow() - this.goodAt < FRESH_MS) return;
      void this.refresh().then(
        (changed) => {
          if (changed && !this.closed) onChange();
        },
        () => {},
      );
    };
    this.initialTimer = setTimeout(tick, 0);
    this.initialTimer.unref?.();
    this.timer = setInterval(tick, REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stops the background timers and settles any in-flight refresh before shutdown continues. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.liveOAuth.clear();
    await this.inflight?.catch(() => {});
  }

  private async runRefresh(): Promise<boolean> {
    try {
      const providers = normalizeProviders(await this.fetchCatalog());
      if (providers === null) return false;
      const fetchedAt = this.doNow();
      if (this.snapshot !== null && JSON.stringify(this.snapshot.providers) === JSON.stringify(providers)) {
        this.goodAt = fetchedAt;
        if (!this.persisted) this.persist(fetchedAt, providers);
        return false;
      }
      this.snapshot = { fetchedAt, providers };
      this.persisted = false;
      this.goodAt = fetchedAt;
      this.persist(fetchedAt, providers);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchCatalog(): Promise<unknown> {
    const response = await this.doFetch(CATALOG_URL, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`catalog fetch failed with status ${response.status}`);
    const text = await readBoundedText(response);
    return JSON.parse(text) as unknown;
  }

  private readCache(): Snapshot | null {
    if (this.cachePath === undefined) return null;
    try {
      if (statSync(this.cachePath).size > MAX_CACHE_BYTES) return null;
      return parseCache(readFileSync(this.cachePath, "utf8"), this.doNow);
    } catch {
      return null;
    }
  }

  /** Atomic write: temp file in the same directory, then rename. Failures keep the in-memory catalog. */
  private persist(fetchedAt: number, providers: Record<string, CatalogModel[]>): void {
    if (this.cachePath === undefined) {
      this.persisted = true;
      return;
    }
    const payload = JSON.stringify({ version: CACHE_VERSION, fetchedAt, providers } satisfies CacheFile);
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const temp = `${this.cachePath}.tmp`;
      writeFileSync(temp, payload);
      renameSync(temp, this.cachePath);
      this.persisted = true;
    } catch {
      // The next successful refresh retries; conversation readiness never depends on the cache.
    }
  }
}

interface CacheFile {
  version: number;
  fetchedAt: number;
  providers: Record<string, CatalogModel[]>;
}

/** Streams at most MAX_BODY_BYTES from the response, rejecting bigger bodies before parsing. */
async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("catalog response exceeds the body limit");
    return text;
  }
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("catalog response exceeds the body limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}
