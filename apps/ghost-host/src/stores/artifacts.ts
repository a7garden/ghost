import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactRef } from "@ghost/contract";
import type { ArtifactStore } from "../core/ports.ts";

const DIGEST = /^[0-9a-f]{64}$/;

/** Content-addressed bytes at `<root>/artifacts/sha256/<2 hex>/<digest>`. */
export class FsArtifactStore implements ArtifactStore {
  private readonly base: string;

  constructor(root: string) {
    this.base = join(root, "artifacts", "sha256");
    mkdirSync(this.base, { recursive: true });
  }

  path(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error(`invalid artifact digest ${JSON.stringify(digest)}`);
    return join(this.base, digest.slice(0, 2), digest);
  }

  has(digest: string): boolean {
    return existsSync(this.path(digest));
  }

  async read(digest: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(digest)));
  }

  /** Writes through a temporary file plus fsync plus atomic rename, so a crash never leaves a partial artifact. */
  async put(bytes: Uint8Array, name: string, mediaType: string): Promise<ArtifactRef> {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const target = this.path(digest);
    if (!existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      const temporary = join(this.base, `${digest}.${process.pid}.${crypto.randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o644);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    }
    return { digest, name, mediaType, size: bytes.byteLength };
  }
}
