import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentBrowser } from "../src/integrations/browser.ts";
import { tempDir } from "./support.ts";

// Opt-in integration: real Chrome, real public HTTPS and real host process deadlines.
// CI without Chrome never starts a browser. Every byte and listener uses a temporary root/port.
(process.env.GHOST_BROWSER_SMOKE === "1" ? test : test.skip)("real Chrome: public pages, proxy refusal, encrypted per-Ghost restore", async () => {
  const root = tempDir();
  const browser = new AgentBrowser({ executable: join(homedir(), ".local/bin/agent-browser") }, root);
  const first = { ghostId: "smoke", conversationId: "first" };
  const second = { ghostId: "smoke", conversationId: "second" };
  let localRequests = 0;
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { localRequests++; return new Response("LOCAL_SECRET", { headers: { "Access-Control-Allow-Origin": "*" } }); } });
  try {
    const opened = await browser.run(first, ["open", "https://example.com"]);
    console.log("browser smoke root:", root, "open:", opened); expect(opened.ok).toBe(true);
    const snapshot = await browser.run(first, ["snapshot", "-i"]);
    console.log("snapshot:", snapshot); expect(snapshot.ok).toBe(true);
    const refs = (snapshot.data as { refs: Record<string, { role: string }> }).refs;
    const link = Object.keys(refs).find((key) => refs[key]?.role === "link"); expect(link).toBeDefined();
    const click = await browser.run(first, ["click", `@${link}`]); console.log("click:", click); expect(click.ok).toBe(true);
    const afterClick = await browser.run(first, ["get", "url"]); console.log("after click:", afterClick); expect(JSON.stringify(afterClick.data)).toContain("iana.org");
    expect((await browser.run(first, ["open", "https://example.com"])).ok).toBe(true);
    const refusal = await browser.run(first, ["eval", `fetch("http://localhost:${local.port}/probe").then(()=>"UNSAFE").catch(()=>"refused")`]);
    console.log("local fetch:", refusal, "local requests:", localRequests); expect(refusal.data).toMatchObject({ result: "refused" }); expect(localRequests).toBe(0);
    expect((await browser.run(first, ["eval", 'document.cookie="ghost_smoke=preserved; Secure; SameSite=Lax; max-age=600"; localStorage.setItem("ghost_smoke", "preserved"); "stored"'])).ok).toBe(true);
    await browser.close(first);
    expect((await browser.run(second, ["open", "https://example.com"])).ok).toBe(true);
    const restored = await browser.run(second, ["eval", '({cookie: document.cookie.includes("ghost_smoke=preserved"), storage: localStorage.getItem("ghost_smoke")})']);
    console.log("restored second conversation:", restored);
    expect(restored.data).toMatchObject({ result: { cookie: true, storage: "preserved" } });
    await browser.close(second); console.log("closed both smoke sessions");
  } finally { await browser.shutdown(); await local.stop(true); }
}, 180_000);
