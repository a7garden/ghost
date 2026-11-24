import type { ShadeLogin, ShadeStatus } from "@ghost/contract";
import { normalizeOrigin } from "../stores/vault/model.ts";
import { isRecord, runCli, type CliRunner } from "./cli.ts";
import { findProgram } from "./program.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_TTL_MS = 3000;

export type ShadeAvailability = Omit<ShadeStatus, "saveLogins">;

/**
 * The owner's Shade password app, reached only through its signed `shade` CLI. The owner enables agent access
 * and unlocks inside Shade; Ghost never initialises, unlocks or grants anything. Item metadata may reach the UI,
 * but a password is read only by Host code that hands it straight to the Ghost vault or Shade itself, never to a
 * model or an API response.
 */
export class Shade {
  private cached: { at: number; value: ShadeAvailability } | null = null;
  private inflight: Promise<ShadeAvailability> | null = null;
  constructor(private readonly options: {
    /** Absolute path, or null to look for `shade` where its installer puts it. */
    program?: string | null;
    run?: CliRunner;
    now?: () => number;
    prefs: { saveLogins(): boolean; setSaveLogins(value: boolean): void };
  }) {}

  private program(): string | null { return this.options.program === undefined ? findProgram("shade") : this.options.program; }
  private get run(): CliRunner { return this.options.run ?? runCli; }

  /** Cheap enough to poll: one CLI call per few seconds however many viewers ask. */
  availability(): Promise<ShadeAvailability> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cached.at < STATUS_TTL_MS) return Promise.resolve(this.cached.value);
    this.inflight ??= this.probe().then((value) => { this.cached = { at: now, value }; return value; }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async status(): Promise<ShadeStatus> {
    const value = await this.availability();
    return { ...value, saveLogins: this.options.prefs.saveLogins() };
  }

  setSaveLogins(value: boolean): void { this.options.prefs.setSaveLogins(value); }
  saveLoginsEnabled(): boolean { return this.options.prefs.saveLogins(); }

  private async probe(): Promise<ShadeAvailability> {
    const program = this.program();
    const down: ShadeAvailability = { state: "unavailable", writable: false };
    if (!program) return down;
    try {
      const data = this.data(await this.run(program, ["status", "--json"]));
      if (!data || data.initialized !== true) return down;
      if (data.unlocked !== true) return { state: "locked", writable: false };
      if (data.agent_access !== true) return { state: "agent_off", writable: false };
      return { state: "ready", writable: data.agent_write_enabled === true };
    } catch { return down; }
  }

  private data(result: { code: number; stdout: Buffer }): Record<string, unknown> | null {
    if (result.code !== 0) return null;
    try {
      const envelope: unknown = JSON.parse(result.stdout.toString("utf8"));
      return isRecord(envelope) && envelope.status === "ok" && isRecord(envelope.data) ? envelope.data : null;
    } catch { return null; }
  }

  /** Metadata of the logins Shade holds for exactly this origin. Empty unless Shade is ready. */
  async find(origin: string): Promise<ShadeLogin[]> {
    const program = this.program();
    if (!program || (await this.availability()).state !== "ready") return [];
    const exact = normalizeOrigin(origin);
    try {
      const data = this.data(await this.run(program, ["items", "find", "--origin", exact, "--json"]));
      const items: unknown[] = data && Array.isArray(data.items) ? data.items : [];
      const found: ShadeLogin[] = [];
      for (const item of items) {
        if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id) || item.deleted === true || item.pending_change) continue;
        if (typeof item.origin !== "string" || item.origin !== exact) continue;
        const username = typeof item.username === "string" ? item.username : "";
        found.push({ id: item.id, title: typeof item.title === "string" && item.title ? item.title.slice(0, 256) : new URL(exact).hostname, username: username.slice(0, 512), origin: exact });
      }
      return found.slice(0, 32);
    } catch { return []; }
  }

  /** The login's password, for Host code only. Throws with fixed wording; the CLI's own output is never echoed. */
  async password(id: string): Promise<string> {
    const program = this.program();
    if (!program || !ID.test(id) || (await this.availability()).state !== "ready") throw new Error("Shade에서 암호를 읽을 수 없습니다.");
    const result = await this.run(program, ["secret", "read", id, "--stdout"]);
    try {
      if (result.code !== 0 || result.stdout.length === 0) throw new Error("Shade에서 암호를 읽을 수 없습니다.");
      return result.stdout.toString("utf8");
    } finally { result.stdout.fill(0); }
  }

  /** Add a login Shade does not have yet. A same-origin, same-username item is left alone. Returns whether Shade took it. */
  async saveLogin(input: { origin: string; username: string; password: string; title: string }): Promise<boolean> {
    const program = this.program();
    const state = await this.availability();
    if (!program || state.state !== "ready" || !state.writable || !this.options.prefs.saveLogins()) return false;
    if ((await this.find(input.origin)).some((item) => item.username === input.username)) return true;
    const body = Buffer.from(JSON.stringify({ title: input.title, username: input.username, origin: normalizeOrigin(input.origin), password: input.password, expected_revision: 0 }));
    try {
      const result = await this.run(program, ["item", "put", "--input-fd", "0", "--json"], { stdin: body });
      return result.code === 0;
    } catch { return false; }
    finally { body.fill(0); }
  }
}
