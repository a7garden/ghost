import { expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/integrations/browser.ts";
import { serveBrowser } from "../src/api/browser.ts";
import { createVault } from "../src/stores/vault.ts";
import type { LoginPage } from "../src/integrations/login-capture.ts";
import { harness, tempDir } from "./support.ts";

const ref = { ghostId: "live-ghost", conversationId: "live-conversation" };
test("one upstream serves four clients, bypasses a long Ghost read and isolates secret fills", async () => {
  const root = tempDir(), received: Record<string, unknown>[] = [];
  let connections = 0, cdpConnections = 0, pageVersion = 0;
  // Protocol-only SOF fixture; real Chrome tests below decode the actual rendered JPEG.
  const image = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,2,88,3,32,1,1,0x11,0,0xff,0xd9]);
  const reopened = Promise.withResolvers<void>();
  const mouse = Promise.withResolvers<void>(), key = Promise.withResolvers<void>();
  const upstream = Bun.serve<{cdp:boolean}>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/reload") { pageVersion++; return new Response("reloaded"); }
      if (server.upgrade(request,{data:{cdp:path.startsWith("/devtools/browser")}})) return;
      return new Response("upgrade",{status:400});
    },
    websocket: {
      open(ws) {
        if (ws.data.cdp) { cdpConnections++; return; }
        connections++;
        if (connections === 2) reopened.resolve();
        ws.send(JSON.stringify({ type: "status", viewportWidth: 800, viewportHeight: 600, debug: "do not forward" }));
        ws.send(JSON.stringify({ type: "tabs", tabs: [{ active: true, targetId: "fixture-tab", url: "https://example.com/", title: "Example" }] }));
        ws.send(JSON.stringify({ type: "frame", data: "AAAA" }));
      },
      message(ws, message) {
        const value = JSON.parse(String(message));
        if (ws.data.cdp) {
          let result: Record<string,unknown> = {};
          if (value.method === "Target.attachToTarget") result = {sessionId:"fixture-session"};
          else if (value.method === "Page.getLayoutMetrics") result = {cssVisualViewport:{pageX:0,pageY:0,clientWidth:800,clientHeight:600}};
          else if (value.method === "Page.captureScreenshot") { image[14] = pageVersion; result = {data:image.toString("base64")}; }
          ws.send(JSON.stringify({id:value.id,result}));
        } else { received.push(value); if (value.type === "input_mouse") mouse.resolve(); else key.resolve(); }
      },
    },
  });
  const executable = join(root, "fake-browser");
  writeFileSync(executable, `#!${process.execPath}\nconst args=process.argv.slice(process.argv.indexOf('--json')+1); if(args[0]==='hold') await fetch(args[1]); if(args[0]==='reload') await fetch('http://127.0.0.1:${upstream.port}/reload'); const data=args[0]==='stream'?{port:${upstream.port}}:args[0]==='get'&&args[1]==='cdp-url'?{cdpUrl:'ws://127.0.0.1:${upstream.port}/devtools/browser/live'}:{};process.stdout.write(JSON.stringify({success:true,data,error:null}));\n`);
  chmodSync(executable, 0o700);
  const browser = new AgentBrowser({ executable }, root);
  type ObserverSession = { loginObserver?: { snapshot: () => Promise<LoginPage>; close: () => void } };
  (browser as unknown as { ensureLogin(session: ObserverSession): Promise<void> }).ensureLogin = async session => {
    session.loginObserver ??= {
      snapshot: async () => ({ targetId: "fixture-tab", documentId: `fixture-${pageVersion}`, url: "https://example.com/", origin: "https://example.com", fields: [], focused: null, clicked: null }),
      close: () => {},
    };
  };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>();
  const hold = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { entered.resolve(); return release.promise; } });
  const stops: (() => void)[] = [];
  try {
    await browser.run(ref, ["open", "https://example.com/"]);
    const gotFrame = Promise.withResolvers<void>(), events: unknown[] = [];
    let firstPixels: string | undefined;
    stops.push(await browser.live(ref, { maxFps: 8 }, event => { events.push(event); if (event.type === "frame") { firstPixels = event.data; gotFrame.resolve(); } }));
    await gotFrame.promise;
    // A late viewer must receive fresh pixels even though the unchanged daemon emits no more damage.
    stops.pop()!();
    const replayed = Promise.withResolvers<void>();
    stops.push(await browser.live(ref, { maxFps: 8 }, event => { events.push(event); if (event.type === "frame") replayed.resolve(); }));
    await replayed.promise;
    expect(cdpConnections).toBe(1);
    expect(connections).toBe(1);
    await browser.run(ref, ["reload"]);
    const nextDocument = Promise.withResolvers<string>();
    const stopAfterNavigation = await browser.live(ref, { maxFps: 8 }, event => { if (event.type === "frame") nextDocument.resolve(event.data); });
    expect(await nextDocument.promise).not.toBe(firstPixels);
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

test("deferred owner metadata capture republishes fresh pixels after damage arrived while busy", async () => {
  const root = tempDir();
  const deferred = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>(), fresh = Promise.withResolvers<{ type: "frame"; width: number; height: number; data: string }>();
  let version = 0, snapshots = 0, connections = 0;
  let peer: Bun.ServerWebSocket<{ cdp: boolean }> | undefined;
  const jpeg = (revision: number) => {
    const image = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,2,88,3,32,1,1,0x11,0,0xff,0xd9]);
    image[14] = revision;
    return image.toString("base64");
  };
  const upstream = Bun.serve<{ cdp: boolean }>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { cdp: new URL(request.url).pathname.startsWith("/devtools/browser") } })) return;
      return new Response("upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.cdp) return;
        peer = ws; connections++;
        ws.send(JSON.stringify({ type: "status", viewportWidth: 800, viewportHeight: 600 }));
        ws.send(JSON.stringify({ type: "tabs", tabs: [{ active: true, targetId: "fixture-tab", url: "https://example.com/", title: "Example" }] }));
        ws.send(JSON.stringify({ type: "frame", data: "AAAA" }));
      },
      message(ws, message) {
        if (!ws.data.cdp) return;
        const command = JSON.parse(String(message));
        let result: Record<string, unknown> = {};
        if (command.method === "Target.attachToTarget") result = { sessionId: "fixture-session" };
        else if (command.method === "Page.getLayoutMetrics") result = { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
        else if (command.method === "Page.captureScreenshot") result = { data: jpeg(version) };
        ws.send(JSON.stringify({ id: command.id, result }));
      },
    },
  });
  const executable = join(root, "fake-browser");
  writeFileSync(executable, `#!${process.execPath}\nconst args=process.argv.slice(process.argv.indexOf('--json')+1);const data=args[0]==='stream'?{port:${upstream.port}}:args[0]==='get'&&args[1]==='cdp-url'?{cdpUrl:'ws://127.0.0.1:${upstream.port}/devtools/browser/deferred'}:{};process.stdout.write(JSON.stringify({success:true,data,error:null}));\n`);
  chmodSync(executable, 0o700);
  const browser = new AgentBrowser({ executable }, root);
  type ObserverSession = { loginObserver?: { snapshot: () => Promise<LoginPage>; close: () => void } };
  // Private test seams replace only credential metadata and observe the real upstream transport.
  const fixtureBrowser = browser as unknown as {
    ensureLogin(session: ObserverSession): Promise<void>;
    sessionMap: Map<string, { bridge?: { socket?: WebSocket } }>;
  };
  fixtureBrowser.ensureLogin = async session => {
    session.loginObserver ??= {
      snapshot: async () => {
        if (++snapshots === 3) { deferred.resolve(); await release.promise; }
        return { targetId: "fixture-tab", documentId: "fixture-document", url: "https://example.com/", origin: "https://example.com", fields: [], focused: null, clicked: null };
      },
      close: () => {},
    };
  };
  let stop: (() => void) | undefined;
  try {
    await browser.run(ref, ["open", "https://example.com/"]);
    stop = await browser.live(ref, { maxFps: 15 }, event => {
      if (event.type !== "frame") return;
      first.resolve();
      if (event.data === jpeg(1)) fresh.resolve(event);
    });
    await first.promise;
    await browser.input(ref, { type: "key", event: "down", key: "Tab", code: "Tab" });
    await deferred.promise;
    // Observe actual socket delivery as the barrier, not a sleep or a private scheduling assertion.
    const socket = fixtureBrowser.sessionMap.get(ref.conversationId)!.bridge!.socket!;
    const damageHandled = Promise.withResolvers<void>();
    const onDamage = (event: MessageEvent) => {
      if (JSON.parse(String(event.data)).data !== "AAAB") return;
      socket.removeEventListener("message", onDamage);
      damageHandled.resolve();
    };
    socket.addEventListener("message", onDamage);
    version = 1;
    peer!.send(JSON.stringify({ type: "frame", data: "AAAB" }));
    await damageHandled.promise;
    release.resolve();
    // There is no subsequent daemon damage, owner input, subscriber, or reconnect to rescue this frame.
    expect(await fresh.promise).toEqual({ type: "frame", width: 800, height: 600, data: jpeg(1) });
    expect(connections).toBe(1);
  } finally {
    release.resolve(); stop?.(); await browser.shutdown(); await upstream.stop(true);
  }
}, 10_000);

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

chromeTest("real Chrome: one live viewer receives correctly sized JPEGs after growing and shrinking the owner viewport", async () => {
  const browser = new AgentBrowser({ executable: executable!, chrome }, tempDir());
  const session = { ghostId: "live-resize", conversationId: "live-resize" };
  type Frame = { data: string; width: number; height: number };
  let next = { width: 0, height: 0, frame: Promise.withResolvers<Frame>() };
  let stop: (() => void) | undefined;
  try {
    expect((await browser.run(session, ["open", "https://example.com/"])).ok).toBe(true);
    for (const [width,height] of [[530,480],[356,700],[980,520]] as const) {
      next = { width, height, frame: Promise.withResolvers<Frame>() };
      await browser.input(session, { type: "viewport", width, height });
      stop ??= await browser.live(session, { maxFps: 8 }, event => {
        if (event.type === "frame" && event.width === next.width && event.height === next.height) next.frame.resolve(event);
        if (event.type === "end") next.frame.reject(new Error("Resizing terminated the live viewer"));
      });
      const timeout = setTimeout(() => next.frame.reject(new Error(`No ${width}x${height} frame after resize`)), 10000);
      let frame: Frame;
      try { frame = await next.frame.promise; } finally { clearTimeout(timeout); }
      const decoded = await browser.run(session, ["eval", `(async()=>{const blob=await(await fetch("data:image/jpeg;base64,${frame.data}")).blob();const image=await createImageBitmap(blob);const size=[image.width,image.height];image.close();return size})()`]);
      expect(decoded.ok).toBe(true);
      expect(decoded.data).toMatchObject({ result: [width,height] });
    }
  } finally { stop?.(); await browser.shutdown(); }
}, 90_000);
