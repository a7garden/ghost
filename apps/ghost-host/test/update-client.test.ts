import { expect, test } from "bun:test";
import { GitHubClient, type GitHubRelease } from "../src/update/github.ts";

const release: GitHubRelease = { tag_name: "v2.2.0", assets: [{ name: "asset", size: 4, url: "https://api.github.com/repos/test/ghost/releases/assets/1" }] };

test("GitHub client bounds streamed bodies and supplies an abort deadline", async () => {
  let signal: AbortSignal | null | undefined;
  const client = new GitHubClient("test/ghost", () => "secret", async (_input, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); controller.close(); } }));
  });
  await expect(client.asset(release, "asset", 8)).rejects.toThrow("너무 큽니다");
  expect(signal).toBeInstanceOf(AbortSignal);
  const aborted = AbortSignal.abort();
  const observing = new GitHubClient("test/ghost", () => "secret", async (_input, init) => { expect(init?.signal?.aborted).toBe(true); throw init?.signal?.reason; });
  await expect(observing.asset(release, "asset", 8, aborted)).rejects.toThrow();
});

test("GitHub client rejects unsafe redirects and caps redirect chains", async () => {
  for (const location of ["http://insecure.example/asset", "https://user:pass@assets.example/asset", null]) {
    const client = new GitHubClient("test/ghost", () => "secret", async () => new Response(null, { status: 302, headers: location ? { location } : {} }));
    await expect(client.asset(release, "asset", 8)).rejects.toThrow();
  }
  let requests = 0;
  const looping = new GitHubClient("test/ghost", () => "secret", async () => { requests++; return new Response(null, { status: 302, headers: { location: "https://assets.example/loop" } }); });
  await expect(looping.asset(release, "asset", 8)).rejects.toThrow();
  expect(requests).toBe(6);
});

test("GitHub client rejects API asset URLs outside the configured repository", async () => {
  const client = new GitHubClient("test/ghost", () => "secret", async () => Response.json({ tag_name: "v2.2.0", assets: [{ name: "asset", size: 4, url: "https://evil.example/steal-token" }] }));
  await expect(client.release()).rejects.toThrow("경로");
});
