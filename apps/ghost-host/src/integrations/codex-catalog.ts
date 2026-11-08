import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelInfo, Provider } from "@ghost/contract";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { Secrets } from "../core/ports.ts";
import type { CatalogFetch, ProviderCatalog } from "./provider-catalog.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/models?client_version=0.159.0";
const MAX_BYTES = 8 * 1024 * 1024;
const FRESH_MS = 6 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

interface Entry { identity: string; fetchedAt: number; models: ModelInfo[] }
interface Options {
  catalog: ProviderCatalog;
  secrets: Secrets;
  providers: () => Provider[];
  cachePath?: string;
  fetch?: CatalogFetch;
  now?: () => number;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

/** Only typed model metadata is consumed; remote instructions and tools are ignored. */
function parseModels(value: unknown): ModelInfo[] {
  if (!record(value) || !Array.isArray(value.models)) throw new Error("invalid Codex model catalog");
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of value.models) {
    if (!record(item) || item.visibility !== "list" || !label(item.slug) || !label(item.display_name) || !positive(item.context_window)) continue;
    if (!Array.isArray(item.input_modalities) || !item.input_modalities.includes("text") || seen.has(item.slug)) continue;
    seen.add(item.slug);
    models.push({
      id: item.slug, name: item.display_name, contextWindow: item.context_window,
      input: item.input_modalities.includes("image") ? ["text", "image"] : ["text"],
      reasoning: Array.isArray(item.supported_reasoning_levels) && item.supported_reasoning_levels.some((level) => record(level) && typeof level.effort === "string" && level.effort !== "none"),
    });
    if (models.length === 256) break;
  }
  if (models.length === 0) throw new Error("empty Codex model catalog");
  return models;
}

/** Account + subject, never a persisted bearer/refresh token. Opaque test/legacy tokens use a one-way hash. */
function identityOf(credential: OAuthCredential): string {
  let subject: string | undefined;
  try {
    const body: unknown = JSON.parse(Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (record(body) && typeof body.sub === "string") subject = body.sub;
  } catch { /* An opaque access token is valid too. */ }
  return createHash("sha256").update(`${credential.accountId ?? ""}\0${subject ?? credential.refresh}`).digest("hex");
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Codex model discovery unavailable");
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body.cancel();
    throw new Error("Codex model catalog too large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Codex model catalog too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

/** Account-scoped Codex discovery. Public models.dev data is never used to infer subscription eligibility. */
export class CodexCatalog {
  private readonly options: Options;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly identities = new Map<string, string>();
  private pending: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private onChange: (() => void) | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private membershipDirty = false;

  constructor(options: Options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    if (options.cachePath) {
      try {
        if (statSync(options.cachePath).size > MAX_BYTES) return;
        const file: unknown = JSON.parse(readFileSync(options.cachePath, "utf8"));
        if (!record(file) || file.version !== 1 || !record(file.providers)) return;
        for (const [id, value] of Object.entries(file.providers)) {
          if (!record(value) || typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity) || !positive(value.fetchedAt) || value.fetchedAt > this.now() || !Array.isArray(value.models) || value.models.length > 256) continue;
          const models: ModelInfo[] = [];
          for (const model of value.models) {
            if (!record(model) || !label(model.id) || !label(model.name) || !positive(model.contextWindow) || typeof model.reasoning !== "boolean" || !Array.isArray(model.input) || !model.input.includes("text") || model.input.some((input) => input !== "text" && input !== "image")) continue;
            models.push({ id: model.id, name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning, input: model.input.includes("image") ? ["text", "image"] : ["text"] });
          }
          if (models.length) this.entries.set(id, { identity: value.identity, fetchedAt: value.fetchedAt, models });
        }
      } catch { /* A missing/corrupt cache must not affect host startup. */ }
    }
  }

  /** Synchronous identity invalidation; never starts network work until start(). */
  sync(): boolean {
    if (this.closed) return false;
    let changed = false;
    let membershipChanged = false;
    const active = new Set<string>();
    for (const provider of this.options.providers()) {
      if (provider.kind !== "openai") continue;
      const credential = this.options.secrets.credential(provider.id);
      if (credential?.type !== "oauth") continue;
      active.add(provider.id);
      const identity = identityOf(credential);
      if (this.identities.get(provider.id) === identity) continue;
      membershipChanged = true;
      changed = this.options.catalog.clearOAuthModels(provider.id) || changed;
      this.identities.set(provider.id, identity);
      const entry = this.entries.get(provider.id);
      if (entry?.identity === identity) changed = this.options.catalog.setOAuthModels(provider.id, entry.models) || changed;
      else this.entries.delete(provider.id);
    }
    for (const id of this.identities.keys()) {
      if (active.has(id)) continue;
      membershipChanged = true;
      this.identities.delete(id);
      this.entries.delete(id);
      changed = this.options.catalog.clearOAuthModels(id) || changed;
    }
    if (membershipChanged && this.onChange) {
      if (this.pending) this.membershipDirty = true;
      else this.schedule();
    }
    return changed;
  }

  refresh(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      let changed = this.sync();
      for (const [id, identity] of this.identities) {
        if (this.closed) break;
        const previous = this.entries.get(id);
        if (previous?.identity === identity && this.now() - previous.fetchedAt < FRESH_MS) continue;
        const credential = this.options.secrets.credential(id);
        if (credential?.type !== "oauth" || credential.expires <= this.now()) continue;
        const controller = new AbortController();
        this.controller = controller;
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const response = await (this.options.fetch ?? globalThis.fetch)(ENDPOINT, {
            headers: { Authorization: `Bearer ${credential.access}`, ...(typeof credential.accountId === "string" ? { "ChatGPT-Account-Id": credential.accountId } : {}) },
            redirect: "error", signal: controller.signal,
          });
          const models = parseModels(await boundedJson(response));
          const current = this.options.secrets.credential(id);
          if (this.closed || current?.type !== "oauth" || identityOf(current) !== identity || !this.options.providers().some((provider) => provider.id === id && provider.kind === "openai")) continue;
          this.entries.set(id, { identity, fetchedAt: this.now(), models });
          changed = this.options.catalog.setOAuthModels(id, models) || changed;
          this.persist();
        } catch { /* Keep only this account's last good metadata; never log response bodies or credentials. */ }
        finally { controller.abort(); clearTimeout(timeout); this.controller = null; }
      }
      return changed;
    }).finally(() => {
      this.pending = null;
      if (this.membershipDirty && this.onChange && !this.closed) {
        this.membershipDirty = false;
        this.schedule();
      }
    });
    return this.pending;
  }

  start(onChange: () => void): void {
    if (this.closed || this.timer) return;
    this.onChange = onChange;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), CHECK_MS);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onChange = null;
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.pending;
  }

  private schedule(): void {
    void this.refresh().then((changed) => { if (changed && !this.closed) this.onChange?.(); });
  }

  private persist(): void {
    if (!this.options.cachePath) return;
    try {
      mkdirSync(dirname(this.options.cachePath), { recursive: true, mode: 0o700 });
      const temp = `${this.options.cachePath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, providers: Object.fromEntries(this.entries) }), { mode: 0o600 });
      renameSync(temp, this.options.cachePath);
    } catch { /* A read-only cache is not a conversation failure. */ }
  }
}
