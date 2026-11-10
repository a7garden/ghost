import { expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/integrations/browser.ts";
import { serveBrowser } from "../src/api/browser.ts";
import { createVault } from "../src/stores/vault.ts";
import { harness, tempDir } from "./support.ts";

const ref = { ghostId: "live-ghost", conversationId: "live-conversation" };
test("one upstream serves four clients, bypasses a long Ghost read and isolates secret fills", async () => {
  const root = tempDir(), received: Record<string, unknown>[] = [];
  let connections = 0;
  const reopened = Promise.withResolvers<void>();
  const mouse = Promise.withResolvers<void>(), key = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("upgrade", { status: 400 }); },
    websocket: {
      open(ws) {
        connections++;
        if (connections === 2) reopened.resolve();
        ws.send(JSON.stringify({ type: "status", viewportWidth: 800, viewportHeight: 600, debug: "do not forward" }));
        ws.send(JSON.stringify({ type: "tabs", tabs: [{ active: true, url: "https://example.com/", title: "Example" }] }));
        ws.send(JSON.stringify({ type: "frame", data: "AAAA" }));
      },
      message(_ws, message) { const value = JSON.parse(String(message)); received.push(value); if (value.type === "input_mouse") mouse.resolve(); else key.resolve(); },
    },
  });
  const executable = join(root, "fake-browser");
  writeFileSync(executable, `#!${process.execPath}\nconst args=process.argv.slice(process.argv.indexOf('--json')+1); if(args[0]==='hold') await fetch(args[1]); process.stdout.write(JSON.stringify({success:true,data:args[0]==='stream'?{port:${upstream.port}}:{},error:null}));\n`);
  chmodSync(executable, 0o700);
  const browser = new AgentBrowser({ executable }, root);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>();
  const hold = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { entered.resolve(); return release.promise; } });
  const stops: (() => void)[] = [];
  try {
    await browser.run(ref, ["open", "https://example.com/"]);
    const gotFrame = Promise.withResolvers<void>(), events: unknown[] = [];
    stops.push(await browser.live(ref, { maxFps: 8 }, event => { events.push(event); if (event.type === "frame") gotFrame.resolve(); }));
    await gotFrame.promise;
    // Obscura is damage-driven: the upstream emits nothing further for an unchanged page.
    stops.pop()!();
    let replayed: unknown;
    stops.push(await browser.live(ref, { maxFps: 8 }, event => { events.push(event); if (event.type === "frame") replayed = event; }));
    expect(replayed).toEqual({ type: "frame", data: "AAAA", width: 800, height: 600 });
    expect(connections).toBe(1);
    await browser.run(ref, ["reload"]);
    const staleFrames: unknown[] = [];
    const stopAfterNavigation = await browser.live(ref, { maxFps: 8 }, event => { if (event.type === "frame") staleFrames.push(event); });
    expect(staleFrames).toEqual([]);
    stopAfterNavigation();
    for (let n=0;n<3;n++) stops.push(await browser.live(ref, { maxFps: 8 }, () => {}));
    await expect(browser.live(ref, { maxFps: 8 }, () => {})).rejects.toThrow("four live");
    expect(connections).toBe(1);
    expect(JSON.stringify(events)).not.toContain("debug");
    const long = browser.run(ref, ["hold", `http://127.0.0.1:${hold.port}`]);
    await entered.promise;
    await browser.input(ref, { type: "mouse", event: "down", x: 10000, y: 10000 });
    await mouse.promise;
    expect(received[0]).toMatchObject({ type: "input_mouse", eventType: "mousePressed", x: 800, y: 600 });
    release.resolve(new Response("released")); await long;
    const exclusiveEntered = Promise.withResolvers<void>(), exclusiveRelease = Promise.withResolvers<void>();
    const filling = browser.exclusive(ref, async () => { exclusiveEntered.resolve(); await exclusiveRelease.promise; });
    await exclusiveEntered.promise;
    const owner = browser.input(ref, { type: "key", event: "down", key: "a", code: "KeyA" });
    await Promise.resolve(); await Promise.resolve();
    expect(received).toHaveLength(1);
    exclusiveRelease.resolve(); await filling; await owner; await key.promise;
    expect(received[1]).toMatchObject({ type: "input_keyboard", key: "a" });
    expect(browser.takeNotice(ref)).toContain("owner used");
    expect(browser.takeNotice(ref)).toBeNull();
    const h = harness();
    const path = new URL(`http://host/api/browser/sessions/${ref.conversationId}/live`);
    expect((await serveBrowser(new Request(path), path, h.core, browser)).status).toBe(409);
    h.core.stop(); h.ledger.close();
    await browser.handoff(ref, "https://example.com/");
    expect(events).toContainEqual({type:"end",reason:"engine_changed"});
    stops.push(await browser.live(ref,{maxFps:8},()=>{}));
    await reopened.promise; // Re-resolve the upstream after runtime replacement; socket-open is the barrier.
    expect(connections).toBe(2);
    await browser.close(ref);
    expect(JSON.stringify(events)).toContain('"type":"end"');
    expect(browser.sessions()).toEqual([]);
  } finally { release.resolve(new Response("released")); for (const stop of stops) stop(); await browser.shutdown(); await upstream.stop(true); await hold.stop(true); }
});

const executable = process.env.GHOST_TEST_AGENT_BROWSER;
const chrome = process.env.GHOST_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeTest = executable && existsSync(chrome) ? test : test.skip;
chromeTest("real Chrome: NDJSON, owner click/Korean text, successful and failed login capture", async () => {
  const root = tempDir(), vault = createVault(root), h = harness();
  const saved: string[] = [];
  const browser = new AgentBrowser({ executable: executable!, chrome }, root, (session, login) => {
    const item = vault.saveLogin(session.ghostId, login); saved.push(item.id); return item.id;
  });
  const abort = new AbortController();
  let phase = "open";
  try {
    expect((await browser.run(ref, ["open", "https://example.com/"])).ok).toBe(true);
    phase = "DOM fixture";
    // Existing fixture mechanism: inject into an allowed HTTPS page, never bypass the egress proxy for loopback.
    const form = `document.body.innerHTML='<form id=login><label>아이디<input id=user autocomplete=username></label><label>비밀번호<input id=password type=password autocomplete=current-password></label><button>로그인</button></form>'; document.querySelector('form').onsubmit=e=>{e.preventDefault(); if(document.querySelector('#password').value==='한글-password-9823'){ history.pushState({},'', '/account'); document.body.innerHTML='<h1>로그인 완료</h1>'; } }; "ready"`;
    expect((await browser.run(ref, ["eval", form])).ok).toBe(true);
    phase = "live stream";
    const url = new URL(`http://host/api/browser/sessions/${ref.conversationId}/live`);
    const response = await serveBrowser(new Request(url, { signal: abort.signal }), url, h.core, browser);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let framed = false;
    while (!framed) {
      const value = await reader.read(); if (value.done) throw new Error("No browser frame");
      for (const line of new TextDecoder().decode(value.value).trim().split("\n")) {
        const event = JSON.parse(line);
        if (event.type === "frame") { expect(event.width).toBeGreaterThan(0); expect(Buffer.from(event.data, "base64").subarray(0,3).toString("hex")).toBe("ffd8ff"); framed = true; }
      }
    }
    const click = async (selector: string, clickCount: 1 | 2 | 3 = 1) => {
      const position = await browser.run(ref, ["eval", `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`]);
      const data = position.data as { result: { x: number; y: number } }; // Host-authored fixture returns this pair.
      await browser.input(ref, { type: "mouse", event: "down", ...data.result, clickCount });
      await browser.input(ref, { type: "mouse", event: "up", ...data.result, clickCount });
    };
    phase = "owner username input";
    await click("#user"); await browser.input(ref, { type: "text", text: "한글-owner" });
    expect((await browser.run(ref, ["eval", 'document.querySelector("#user").value'])).data).toMatchObject({ result: "한글-owner" });
    phase = "owner editing shortcuts";
    await browser.run(ref, ["eval", `document.body.insertAdjacentHTML("beforeend", '<textarea id="notes"></textarea><div id="editable" contenteditable="true" style="min-height:24px"></div>'); "ready"`]);
    for (const [selector, property, modifiers] of [["#notes", "value", 2], ["#editable", "textContent", 4]] as const) {
      await click(selector); await browser.input(ref, { type: "text", text: "예전 내용" });
      await browser.input(ref, { type: "key", event: "down", key: "a", code: "KeyA", modifiers, keyCode: 65 });
      await browser.input(ref, { type: "key", event: "up", key: "a", code: "KeyA", modifiers, keyCode: 65 });
      await browser.input(ref, { type: "text", text: "새 한글" });
      expect((await browser.run(ref, ["eval", `document.querySelector(${JSON.stringify(selector)})[${JSON.stringify(property)}]`])).data).toMatchObject({ result: "새 한글" });
    }
    phase = "failed login";
    await click("#password"); await browser.input(ref, { type: "text", text: "wrong-password" });
    expect(saved).toHaveLength(0);
    await browser.input(ref, { type: "key", event: "down", key: "Enter", code: "Enter", keyCode: 13 });
    await browser.input(ref, { type: "key", event: "up", key: "Enter", code: "Enter", keyCode: 13 });
    // A real CDP round trip observes submitted page state; no guessed debounce sleep.
    const redacted = await browser.run(ref, ["eval", 'document.querySelector("#password").value']);
    expect(saved).toHaveLength(0);
    expect(JSON.stringify(redacted)).not.toContain("wrong-password");
    phase = "replace owner password";
    await browser.input(ref, { type: "key", event: "down", key: "a", code: "KeyA", modifiers: 4, keyCode: 65 });
    await browser.input(ref, { type: "key", event: "up", key: "a", code: "KeyA", modifiers: 4, keyCode: 65 });
    await browser.input(ref, { type: "text", text: "한글-password-9823" });
    expect((await browser.run(ref, ["eval", 'document.querySelector("#password").value.length'])).data).toMatchObject({ result: "한글-password-9823".length });
    phase = "successful submit";
    await browser.input(ref, { type: "key", event: "down", key: "Enter", code: "Enter", keyCode: 13 });
    await browser.input(ref, { type: "key", event: "up", key: "Enter", code: "Enter", keyCode: 13 });
    expect((await browser.run(ref, ["wait", "--text", "로그인 완료"])).ok).toBe(true);
    await browser.run(ref, ["get", "url"]);
    expect(saved).toHaveLength(1);
    expect(vault.list()).toMatchObject([{ origin: "https://example.com", username: "한글-owner", ghostIds: [ref.ghostId] }]);
    expect(vault.reveal(ref.ghostId, saved[0]!, "password")).toBe("한글-password-9823");
    abort.abort();
    while (!(await reader.read()).done) {}
    expect(browser.sessions()).toHaveLength(1);
  } catch (error) { throw new Error(`Real Chrome failed during ${phase}`, { cause: error }); }
  finally { abort.abort(); await browser.shutdown(); vault.close(); h.core.stop(); h.ledger.close(); }
}, 90_000);
