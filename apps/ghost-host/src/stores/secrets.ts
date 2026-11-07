import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Secrets } from "../core/ports.ts";

/** Provider ids become file names; this shape cannot traverse and matches the contract's provider id pattern. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `{apiKey}` JSON per provider at `<root>/secrets/<providerId>.json`, 0600 files in a 0700 directory. */
export class FileSecrets implements Secrets {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, "secrets");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  private file(providerId: string): string {
    if (!PROVIDER_ID.test(providerId)) throw new Error(`invalid provider id ${JSON.stringify(providerId)}`);
    return join(this.dir, `${providerId}.json`);
  }

  has(providerId: string): boolean {
    return existsSync(this.file(providerId));
  }

  get(providerId: string): string | null {
    let text: string;
    try {
      text = readFileSync(this.file(providerId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stored = JSON.parse(text) as { apiKey: unknown };
      return typeof stored.apiKey === "string" ? stored.apiKey : null;
    } catch {
      return null;
    }
  }

  put(providerId: string, apiKey: string | null): void {
    const file = this.file(providerId);
    if (apiKey === null) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ apiKey }), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  }
}
