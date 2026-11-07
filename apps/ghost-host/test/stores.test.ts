import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe("FsArtifactStore", () => {
  test("addresses bytes by sha256 digest and reads them back", async () => {
    const root = tempRoot();
    const store = new FsArtifactStore(root);
    const content = bytes("artifact body");
    const digest = createHash("sha256").update(content).digest("hex");

    const ref = await store.put(content, "notes.txt", "text/plain");
    expect(ref).toEqual({ digest, name: "notes.txt", mediaType: "text/plain", size: content.byteLength });
    expect(store.has(digest)).toBe(true);
    expect(store.has("0".repeat(64))).toBe(false);
    expect(store.path(digest)).toBe(join(root, "artifacts", "sha256", digest.slice(0, 2), digest));
    expect(readFileSync(join(root, "artifacts", "sha256", digest.slice(0, 2), digest)).toString()).toBe("artifact body");
    expect(Buffer.from(await store.read(digest))).toEqual(Buffer.from(content));
  });

  test("re-putting the same bytes is idempotent", async () => {
    const store = new FsArtifactStore(tempRoot());
    const content = bytes("same bytes");
    const first = await store.put(content, "a.bin", "application/octet-stream");
    const second = await store.put(content, "b.bin", "image/png");
    expect(second.digest).toBe(first.digest);
    expect(store.has(first.digest)).toBe(true);
  });

  test("rejects digests that could traverse the filesystem", () => {
    const store = new FsArtifactStore(tempRoot());
    expect(() => store.path("../escape")).toThrow();
    expect(() => store.read("../../etc/passwd".padEnd(64, "0"))).toThrow();
    expect(() => store.has(`${"a".repeat(64)}/..`)).toThrow();
    expect(() => store.has("".padEnd(64, "A").toUpperCase())).toThrow();
  });
});

describe("FileSecrets", () => {
  test("stores provider keys as 0600 files in a 0700 directory", () => {
    const root = tempRoot();
    const secrets = new FileSecrets(root);
    expect(secrets.has("openai")).toBe(false);
    expect(secrets.get("openai")).toBeNull();

    secrets.put("openai", "sk-test");
    expect(secrets.has("openai")).toBe(true);
    expect(secrets.get("openai")).toBe("sk-test");
    const file = join(root, "secrets", "openai.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ apiKey: "sk-test" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "secrets")).mode & 0o777).toBe(0o700);
  });

  test("put with null deletes the secret", () => {
    const secrets = new FileSecrets(tempRoot());
    secrets.put("anthropic", "key");
    secrets.put("anthropic", null);
    expect(secrets.has("anthropic")).toBe(false);
    expect(secrets.get("anthropic")).toBeNull();
    secrets.put("anthropic", null);
  });

  test("provider ids cannot traverse the filesystem", () => {
    const secrets = new FileSecrets(tempRoot());
    for (const id of ["../secrets-evil", "a/b", "UPPER", ".hidden", "a".repeat(65)]) {
      expect(() => secrets.put(id, "x")).toThrow();
      expect(() => secrets.get(id)).toThrow();
    }
    secrets.put("a_b-c9", "ok");
    expect(secrets.get("a_b-c9")).toBe("ok");
  });
});
