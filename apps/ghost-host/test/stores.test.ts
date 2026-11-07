import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    expect(await store.size(digest)).toBe(content.byteLength);
    expect(await store.read(digest, 4)).toEqual(content.subarray(0, 4));
    expect(await store.read(digest, 0)).toEqual(new Uint8Array());
    expect(await store.read(digest, 1024)).toEqual(content);
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

/** Canonical OAuth credential fixture with token-shaped fields. */
const oauthCredential = {
  type: "oauth",
  refresh: "refresh-private-token",
  access: "access-private-token",
  expires: Date.now() + 3_600_000,
  accountId: "acct-123",
} as const;

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
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ type: "api_key", key: "sk-test" });
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

  test("reads legacy {apiKey} files as API key credentials", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets", "zai.json"), JSON.stringify({ apiKey: "sk-legacy" }), { mode: 0o600 });

    const secrets = new FileSecrets(root);
    expect(secrets.credential("zai")).toEqual({ type: "api_key", key: "sk-legacy" });
    expect(secrets.get("zai")).toBe("sk-legacy");
    expect(secrets.has("zai")).toBe(true);
    expect(await secrets.list()).toEqual([{ providerId: "zai", type: "api_key" }]);
  });

  test("oauth credentials survive reopening and list without secrets", async () => {
    const root = tempRoot();
    const secrets = new FileSecrets(root);
    const persisted = await secrets.modify("openai", async () => ({ ...oauthCredential }));
    expect(persisted).toEqual(oauthCredential);

    const reopened = new FileSecrets(root);
    expect(reopened.credential("openai")).toEqual(oauthCredential);
    expect(reopened.has("openai")).toBe(true);
    expect(reopened.get("openai")).toBeNull();
    expect(await reopened.list()).toEqual([{ providerId: "openai", type: "oauth" }]);
    expect(JSON.stringify(await reopened.list())).not.toContain("private-token");

    // A canonical OAuth credential on disk resolves through the store.
    expect(await reopened.read("openai")).toEqual(oauthCredential);
  });

  test("modify returning undefined leaves the entry unchanged", async () => {
    const root = tempRoot();
    const secrets = new FileSecrets(root);
    await secrets.modify("openai", async () => ({ ...oauthCredential }));
    const post = await secrets.modify("openai", async () => undefined);
    expect(post).toEqual(oauthCredential);
    expect(new FileSecrets(root).credential("openai")).toEqual(oauthCredential);
  });

  test("serializes concurrent modify writers per provider", async () => {
    const secrets = new FileSecrets(tempRoot());
    const releaseFirst = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = secrets.modify("openai", async (current) => {
      order.push(`one:${current?.type ?? "empty"}`);
      await releaseFirst.promise;
      return { type: "api_key", key: "one" };
    });
    const second = secrets.modify("openai", async (current) => {
      order.push(`two:${current?.type === "api_key" ? current.key : "empty"}`);
      return { type: "api_key", key: `${current?.type === "api_key" ? current.key : ""}-two` };
    });
    releaseFirst.resolve();
    expect(await first).toEqual({ type: "api_key", key: "one" });
    expect(await second).toEqual({ type: "api_key", key: "one-two" });
    expect(order).toEqual(["one:empty", "two:one"]);
  });

  test("an api key put during an in-flight write cannot be overwritten", async () => {
    const root = tempRoot();
    const secrets = new FileSecrets(root);
    await secrets.modify("openai", async () => ({ ...oauthCredential }));

    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const refresh = secrets.modify("openai", async (current) => {
      started.resolve();
      await gate.promise;
      // A refresh would produce a new OAuth credential, e.g. with a rotated refresh token.
      return { ...(current as typeof oauthCredential), access: "access-new", expires: Date.now() + 3_600_000 };
    });
    await started.promise;
    secrets.put("openai", "sk-replacement");
    gate.resolve();

    expect(await refresh).toEqual({ type: "api_key", key: "sk-replacement" });
    expect(secrets.get("openai")).toBe("sk-replacement");
    expect(JSON.parse(readFileSync(join(root, "secrets", "openai.json"), "utf8"))).toEqual({
      type: "api_key",
      key: "sk-replacement",
    });
    expect(new FileSecrets(root).credential("openai")).toEqual({ type: "api_key", key: "sk-replacement" });
  });

  test("a delete during an in-flight write cannot be resurrected", async () => {
    const root = tempRoot();
    const secrets = new FileSecrets(root);
    await secrets.modify("openai", async () => ({ ...oauthCredential }));

    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const refresh = secrets.modify("openai", async (current) => {
      started.resolve();
      await gate.promise;
      return { ...(current as typeof oauthCredential), access: "access-new" };
    });
    await started.promise;
    await secrets.delete("openai");
    gate.resolve();

    expect(await refresh).toBeUndefined();
    expect(secrets.has("openai")).toBe(false);
    expect(existsSync(join(root, "secrets", "openai.json"))).toBe(false);
    expect(new FileSecrets(root).has("openai")).toBe(false);
  });
});
