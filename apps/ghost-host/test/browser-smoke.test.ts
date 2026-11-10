import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { readdirSync } from "node:fs";
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

(process.env.GHOST_BROWSER_SMOKE === "1" ? test : test.skip)("real Chrome: WebRTC globals are immutable and no STUN reaches a local UDP listener", async () => {
  const socket = createSocket("udp4");
  const bound = Promise.withResolvers<void>();
  socket.bind(0, "127.0.0.1", bound.resolve); await bound.promise;
  const address = socket.address(); if (typeof address === "string") throw new Error("No UDP address");
  let packets = 0; socket.on("message", () => packets++);
  const root = tempDir();
  const browser = new AgentBrowser({ executable: join(homedir(), ".local/bin/agent-browser") }, root);
  const session = { ghostId: "rtc", conversationId: "rtc" };
  try {
    expect((await browser.run(session, ["open", "https://example.com"])).ok).toBe(true);
    // This real network-observation interval must exercise Chrome and UDP, not a fake JS clock.
    const probe = await browser.run(session, ["eval", `(async () => {
      const frame = document.createElement("iframe"); document.body.appendChild(frame);
      const result = [];
      for (const realm of [window, frame.contentWindow]) {
        for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate"]) {
          const descriptor = Object.getOwnPropertyDescriptor(realm, name);
          result.push({ name, missing: typeof realm[name] === "undefined", immutable: descriptor?.configurable === false && descriptor?.writable === false });
        }
        try {
          const peer = new realm.RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${address.port}" }] });
          peer.createDataChannel("probe"); await peer.setLocalDescription(await peer.createOffer());
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      frame.remove(); return result;
    })()`]);
    expect(probe.ok).toBe(true);
    if (!probe.data || typeof probe.data !== "object" || !("result" in probe.data) || !Array.isArray(probe.data.result)) throw new Error("No RTC probe result");
    for (const item of probe.data.result) expect(item).toMatchObject({ missing: true, immutable: true });
    expect(probe.data.result).toHaveLength(8); expect(packets).toBe(0);
    console.log("WebRTC UDP packets:", packets, "root:", root);
  } finally { await browser.shutdown(); socket.close(); }
}, 120_000);

(process.env.GHOST_BROWSER_SMOKE === "1" ? test : test.skip)("real Chrome: password/tab and card/session screenshot locks survive navigation as specified", async () => {
  const root = tempDir();
  const browser = new AgentBrowser({ executable: join(homedir(), ".local/bin/agent-browser") }, root);
  const session = { ghostId: "privacy", conversationId: "privacy" };
  try {
    expect((await browser.run(session, ["open", "https://example.com"])).ok).toBe(true);
    await browser.run(session, ["eval", 'document.body.insertAdjacentHTML("beforeend", "<input id=password type=password>"); "ready"']);
    await browser.run(session, ["eval", "--stdin"], { stdin: 'document.querySelector("#password").value = "test-password-only"; "filled"', sensitive: { value: "test-password-only", field: "password", origin: "https://example.com" } });
    await expect(browser.run(session, ["screenshot"])).rejects.toThrow("until that tab's URL changes");
    expect((await browser.run(session, ["open", "https://example.com/?password-cleared"])).ok).toBe(true);
    expect((await browser.run(session, ["screenshot"])).ok).toBe(true);
    expect(readdirSync(join(root, "browser/downloads"), { recursive: true }).some((name) => String(name).endsWith(".png"))).toBe(false);
    await browser.run(session, ["eval", "--stdin"], { stdin: '"filled"', sensitive: { value: "4111111111111111", field: "card_number", origin: "https://example.com" } });
    for (const argv of [["screenshot"], ["back"], ["reload"], ["open", "https://www.iana.org/help/example-domains"]]) {
      if (argv[0] !== "screenshot") await browser.run(session, argv);
      await expect(browser.run(session, ["screenshot"])).rejects.toThrow("close the browser session to reset");
    }
    await browser.close(session);
    expect((await browser.run(session, ["open", "https://example.com"])).ok).toBe(true);
    expect((await browser.run(session, ["screenshot"])).ok).toBe(true);
    console.log("Screenshot privacy lifecycle passed; root:", root);
  } finally { await browser.shutdown(); }
}, 180_000);

(process.env.GHOST_BROWSER_SMOKE === "1" ? test : test.skip)("real Chrome: the owner's final headed page and login state resume headlessly", async () => {
  const root = tempDir();
  const browser = new AgentBrowser({ executable: join(homedir(), ".local/bin/agent-browser") }, root);
  const session = { ghostId: "handoff", conversationId: "handoff" };
  const completed = "https://example.com/?owner-finished=1";
  try {
    expect((await browser.run(session, ["open", "https://example.com/"])).ok).toBe(true);
    await browser.handoff(session, "https://example.com/");
    expect((await browser.run(session, ["open", completed])).ok).toBe(true);
    expect((await browser.run(session, ["eval", 'localStorage.setItem("ghost_handoff_probe", "retained"); "stored"'])).ok).toBe(true);
    expect(await browser.endHandoff(session)).toEqual({ fallback: false });
    const resumed = await browser.run(session, ["get", "url"]);
    expect(resumed.data).toMatchObject({ url: completed });
    expect((await browser.run(session, ["eval", 'localStorage.getItem("ghost_handoff_probe")'])).data).toMatchObject({ result: "retained" });
    const snapshot = await browser.run(session, ["snapshot", "-i"]);
    expect(snapshot.ok).toBe(true);
    console.log("Headed-to-headless handoff retained page:", completed, "and login state; root:", root);
  } finally { await browser.shutdown(); }
}, 180_000);

(process.env.GHOST_BROWSER_SMOKE === "1" ? test : test.skip)("real Chrome: credential capture protects issuer fields atomically and remains host-readable", async () => {
  const root = tempDir();
  const browser = new AgentBrowser({ executable: join(homedir(), ".local/bin/agent-browser") }, root);
  const session = { ghostId: "connection-capture", conversationId: "capture" };
  const secret = "synthetic-service-token-for-capture";
  try {
    expect((await browser.run(session, ["open", "https://example.com"])).ok).toBe(true);
    await browser.run(session, ["eval", `document.body.insertAdjacentHTML("beforeend", '<input id="key" value="${secret}"><input id="other" value="unrelated">'); "ready"`]);
    await expect(browser.captureCredential(session, { origin: "https://www.iana.org", selector: "#key" })).rejects.toThrow();
    await expect(browser.captureCredential(session, { origin: "https://example.com", selector: "input" })).rejects.toThrow();
    expect(await browser.captureCredential(session, { origin: "https://example.com", selector: "#key" })).toBe(secret);
    const observed = await browser.run(session, ["eval", "document.querySelector('#key').value"]);
    expect(observed.data).toMatchObject({ result: "[redacted]" });
    expect(JSON.stringify(await browser.run(session, ["snapshot", "-i"]))).not.toContain(secret);
    await expect(browser.run(session, ["screenshot"])).rejects.toThrow();
    // Approval re-captures the same field privately despite model-output redaction.
    expect(await browser.captureCredential(session, { origin: "https://example.com", selector: "#key" })).toBe(secret);
  } finally { await browser.shutdown(); }
}, 120_000);
