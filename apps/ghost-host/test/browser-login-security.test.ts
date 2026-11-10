import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { AgentBrowser } from "../src/integrations/browser.ts";
import { BrowserCdp } from "../src/integrations/browser-cdp.ts";
import { createVault } from "../src/stores/vault.ts";
import { tempDir } from "./support.ts";

const executable = process.env.GHOST_TEST_AGENT_BROWSER;
const chrome = process.env.GHOST_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeTest = executable && existsSync(chrome) ? test : test.skip;
const ownerPassword = "native-owner-password-7389";
const fixture = `document.body.innerHTML='<form id=login><label>아이디<input id=user name=username autocomplete=username></label><label>비밀번호<input id=password name=password type=password autocomplete=current-password></label><button id=submit>로그인</button></form>'; document.querySelector('form').onsubmit=e=>{e.preventDefault(); if(document.querySelector('#password').value===${JSON.stringify(ownerPassword)}) document.body.innerHTML='<h1>로그인 성공</h1>'; }; "ready"`;
const forged = `(() => {
  const input=document.querySelector('#password'); input.value='page-forged-password';
  const state=window[Symbol.for('ghost.owner-login-capture')]={baseline:new WeakMap(),touched:new WeakSet([input]),submitted:true,activity:99};
  window.ghostOwnerCapture={username:'owner',password:'page-forged-password',submitted:true};
  input.dispatchEvent(typeof InputEvent==='function' ? new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:'page-forged-password'}) : new Event('input',{bubbles:true}));
  input.focus();
  if(typeof document.execCommand==='function') { document.execCommand('insertText',false,'page-forged-password'); document.execCommand('selectAll'); document.execCommand('insertReplacementText',false,'page-forged-password'); }
  return 'ready';
})()`;

chromeTest("real headed Chrome: page-forged capture cannot overwrite a login; real isolated native typing can", async () => {
  const root=tempDir(), vault=createVault(root), saved:string[]=[];
  const ref={ghostId:"native-provenance",conversationId:"native-provenance"};
  const item=vault.saveLogin(ref.ghostId,{origin:"https://example.com",username:"owner",password:"existing-real-password"});
  const browser=new AgentBrowser({executable:executable!,chrome},root,(session,login)=>{const stored=vault.saveLogin(session.ghostId,login);saved.push(stored.id);return stored.id;});
  let native:BrowserCdp|undefined;
  try {
    await browser.run(ref,["open","https://example.com/"]);
    await browser.handoff(ref,"https://example.com/");
    await browser.run(ref,["eval",fixture]);
    const endpoint=await browser.run(ref,["get","cdp-url"]);
    if (!endpoint.data || typeof endpoint.data!=="object" || !("cdpUrl" in endpoint.data) || typeof endpoint.data.cdpUrl!=="string") throw new Error("Missing test CDP endpoint");
    native=await BrowserCdp.connect(endpoint.data.cdpUrl);
    const listed=await native.request("Target.getTargets");
    if (!Array.isArray(listed.targetInfos)) throw new Error("Missing test targets");
    const target=listed.targetInfos.find((target:Record<string,unknown>)=>target.type==="page" && typeof target.url==="string" && target.url.startsWith("https://example.com/"));
    if (!target || typeof target.targetId!=="string") throw new Error("Missing test page");
    const attached=await native.request("Target.attachToTarget",{targetId:target.targetId,flatten:true});
    if (typeof attached.sessionId!=="string") throw new Error("Missing test attachment");
    const sid=attached.sessionId;
    const evaluate=(expression:string)=>native!.request("Runtime.evaluate",{expression,returnByValue:true},sid);
    const focus=async(selector:string)=>{
      const root=await native!.request("DOM.getDocument",{depth:0},sid);
      if (!root.root || typeof root.root!=="object" || !("nodeId" in root.root)) throw new Error("Missing test document");
      const found=await native!.request("DOM.querySelector",{nodeId:root.root.nodeId,selector},sid);
      if (typeof found.nodeId!=="number" || !found.nodeId) throw new Error("Missing test field");
      await native!.request("DOM.focus",{nodeId:found.nodeId},sid);
    };
    // A separate private CDP connection supplies real renderer keyboard events, like the Mac window.
    // It bypasses the Host owner API deliberately, exercising native isolated capture rather than API bookkeeping.
    const type=async(text:string)=>{for(const key of text){await native!.request("Input.dispatchKeyEvent",{type:"keyDown",key,code:"Unidentified",text:key,windowsVirtualKeyCode:0},sid);await native!.request("Input.dispatchKeyEvent",{type:"keyUp",key,code:"Unidentified",windowsVirtualKeyCode:0},sid);}};
    await focus("#user"); await type("owner");
    // This executes as malicious page code while native capture is enabled, not as a model command.
    await evaluate(forged);
    await native.request("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",text:"\r",windowsVirtualKeyCode:13},sid);
    await native.request("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13},sid);
    await browser.run(ref,["snapshot"]);
    await evaluate(`document.querySelector('#password').remove(); 'ready'`);
    await browser.run(ref,["snapshot"]);
    expect(saved).toEqual([]);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe("existing-real-password");
    expect(vault.history(item.id)).toHaveLength(1);
    // Page-realm API tampering, invented values, programmatic submit and ordinary clicks did not gain authority.
    await browser.run(ref,["eval",fixture]);
    await focus("#user"); await type("owner");
    await focus("#password"); await type(ownerPassword);
    expect(saved).toEqual([]);
    await native.request("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",text:"\r",windowsVirtualKeyCode:13},sid);
    await native.request("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13},sid);
    await browser.run(ref,["get","url"]);
    expect(saved).toEqual([item.id]);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe(ownerPassword);
    expect(vault.history(item.id)).toHaveLength(2);
  } finally {native?.close();await browser.shutdown();vault.close();}
},90_000);

const obscura=process.env.GHOST_TEST_OBSCURA;
const obscuraTest=executable && obscura && process.platform==="darwin" && existsSync(chrome) ? test : test.skip;
obscuraTest("real Obscura: takeover carries cookies/viewport into headless Chrome, drops old input, and only saves owner bytes",async()=>{
  const root=tempDir(),vault=createVault(root),saved:string[]=[];
  const ref={ghostId:"obscura-provenance",conversationId:"obscura-provenance"};
  const item=vault.saveLogin(ref.ghostId,{origin:"https://example.com",username:"owner",password:"existing-real-password"});
  const browser=new AgentBrowser({executable:executable!,chrome,obscura:{executable:obscura!,loginOrigins:["https://example.com"]}},root,(session,login)=>{const stored=vault.saveLogin(session.ghostId,login);saved.push(stored.id);return stored.id;});
  const key=async(key:string,modifiers=0)=>{await browser.input(ref,{type:"key",event:"down",key,code:key,modifiers});await browser.input(ref,{type:"key",event:"up",key,code:key,modifiers});};
  try {
    await browser.run(ref,["open","https://example.com/"],{engine:"obscura"});
    await browser.run(ref,["eval","document.cookie='takeover_provenance=keepme;path=/;secure'; 'ready'"]);
    await browser.input(ref,{type:"viewport",width:530,height:480});
    expect(browser.sessions()[0]).toMatchObject({engine:"obscura",headed:false});
    await expect(browser.input(ref,{type:"text",text:"must-not-replay"})).rejects.toMatchObject({code:"conflict"});
    expect(browser.sessions()[0]).toMatchObject({engine:"chrome",headed:false});
    expect((await browser.run(ref,["eval","document.cookie.includes('takeover_provenance=keepme')"])).data).toMatchObject({result:true});
    expect((await browser.run(ref,["eval","innerWidth+'x'+innerHeight"])).data).toMatchObject({result:"530x480"});
    await browser.run(ref,["eval",fixture]);
    await key("Tab"); await browser.input(ref,{type:"text",text:"owner"});
    await browser.run(ref,["eval",forged]);
    await browser.run(ref,["snapshot"]);
    await browser.run(ref,["eval","document.querySelector('#password').remove(); 'ready'"]);
    await browser.run(ref,["snapshot"]);
    expect(saved).toEqual([]);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe("existing-real-password");
    expect(vault.history(item.id)).toHaveLength(1);
    await browser.run(ref,["eval",fixture]);
    await key("Tab"); await browser.input(ref,{type:"text",text:"owner"});
    await key("Tab"); await key("Tab",8);
    expect((await browser.run(ref,["eval","document.activeElement.id"])).data).toMatchObject({result:"user"});
    await key("Tab"); await browser.input(ref,{type:"text",text:ownerPassword});
    expect(saved).toEqual([]);
    await key("Enter");
    await browser.run(ref,["snapshot"]);
    expect(saved).toEqual([item.id]);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe(ownerPassword);
    expect(vault.history(item.id)).toHaveLength(2);
  } finally {await browser.shutdown();vault.close();}
},90_000);

chromeTest("closing a native window without a successful submit never saves a partial or failed password",async()=>{
  const root=tempDir(),vault=createVault(root),saved:string[]=[];
  const ref={ghostId:"native-close",conversationId:"native-close"};
  const item=vault.saveLogin(ref.ghostId,{origin:"https://example.com",username:"owner",password:"existing-real-password"});
  const browser=new AgentBrowser({executable:executable!,chrome},root,(session,login)=>{const stored=vault.saveLogin(session.ghostId,login);saved.push(stored.id);return stored.id;});
  let native:BrowserCdp|undefined,stop:(()=>void)|undefined;
  try {
    await browser.run(ref,["open","https://example.com/"]); await browser.handoff(ref,"https://example.com/");
    await browser.run(ref,["eval",fixture]);
    const endpoint=await browser.run(ref,["get","cdp-url"]);
    if (!endpoint.data || typeof endpoint.data!=="object" || !("cdpUrl" in endpoint.data) || typeof endpoint.data.cdpUrl!=="string") throw new Error("Missing test endpoint");
    native=await BrowserCdp.connect(endpoint.data.cdpUrl);
    const closed=Promise.withResolvers<void>();
    native.onDisconnect(()=>closed.resolve());
    const key=async(key:string)=>{await browser.input(ref,{type:"key",event:"down",key,code:key});await browser.input(ref,{type:"key",event:"up",key,code:key});};
    await key("Tab"); await browser.input(ref,{type:"text",text:"owner"});
    await key("Tab"); await browser.input(ref,{type:"text",text:"partial-not-a-completed-password"});
    await key("Enter"); // The fixture refuses this password and leaves both populated fields in place.
    expect(saved).toEqual([]);
    const resumed=Promise.withResolvers<void>(); let closing=false;
    stop=await browser.live(ref,{maxFps:8},event=>{
      if (closing && !browser.sessions().find(session=>session.conversationId===ref.conversationId)?.headed && (event.type==="frame" || event.type==="end")) resumed.resolve();
    });
    closing=true;
    await native.request("Browser.close").catch(error=>{expect(error.message).toBe("Private browser connection ended");});
    await closed.promise;
    await resumed.promise; // Actual window-close/resume event, not a guessed timer delay.
    expect(saved).toEqual([]);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe("existing-real-password");
    expect(vault.history(item.id)).toHaveLength(1);
  } finally {stop?.();native?.close();await browser.shutdown();vault.close();}
},90_000);

for (const lane of ["api","native"] as const) for (const scenario of [
  {name:"card",html:'<input id=first autocomplete="section-payment BILLING CC-NUMBER"><input id=second type=password autocomplete="cc-csc">',first:"4242424242424242",second:"679",formatted:"4242 4242 4242 4242"},
  {name:"otp",html:'<input id=first type=email autocomplete=username><input id=second type=password autocomplete="section-auth ONE-TIME-CODE">',first:"owner@example.com",second:"123456",formatted:"owner@example.com"},
]) chromeTest(`real Chrome ${lane}: ${scenario.name} is redaction-only, never a saved login or a model screenshot`,async()=>{
  const root=tempDir(),vault=createVault(root),saved:string[]=[];
  const ref={ghostId:`sensitive-${lane}-${scenario.name}`,conversationId:`sensitive-${lane}-${scenario.name}`};
  const item=vault.saveLogin(ref.ghostId,{origin:"https://example.com",username:"owner@example.com",password:"existing-real-password"});
  const browser=new AgentBrowser({executable:executable!,chrome},root,(session,login)=>{const stored=vault.saveLogin(session.ghostId,login);saved.push(stored.id);return stored.id;});
  let native:BrowserCdp|undefined;
  try {
    await browser.run(ref,["open","https://example.com/"]);
    if (lane === "native") await browser.handoff(ref,"https://example.com/");
    await browser.run(ref,["eval",`document.body.innerHTML=${JSON.stringify(`<form>${scenario.html}<button>Continue</button></form>`)}; document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.replaceChildren();}; "ready"`]);
    let sid:string|undefined;
    if (lane === "native") {
      const endpoint=await browser.run(ref,["get","cdp-url"]);
      if (!endpoint.data || typeof endpoint.data!=="object" || !("cdpUrl" in endpoint.data) || typeof endpoint.data.cdpUrl!=="string") throw new Error("Missing test CDP endpoint");
      native=await BrowserCdp.connect(endpoint.data.cdpUrl);
      const listed=await native.request("Target.getTargets");
      if (!Array.isArray(listed.targetInfos)) throw new Error("Missing test targets");
      const target=listed.targetInfos.find((target:Record<string,unknown>)=>target.type==="page" && typeof target.url==="string" && target.url.startsWith("https://example.com/"));
      if (!target || typeof target.targetId!=="string") throw new Error("Missing test page");
      const attached=await native.request("Target.attachToTarget",{targetId:target.targetId,flatten:true});
      if (typeof attached.sessionId!=="string") throw new Error("Missing test attachment");
      sid=attached.sessionId;
    }
    const press=async(key:string)=>{
      if (lane === "api") {
        await browser.input(ref,{type:"key",event:"down",key,code:key});
        await browser.input(ref,{type:"key",event:"up",key,code:key});
      } else {
        await native!.request("Input.dispatchKeyEvent",{type:"keyDown",key,code:key,text:key==="Enter"?"\r":undefined,windowsVirtualKeyCode:key==="Enter"?13:9},sid);
        await native!.request("Input.dispatchKeyEvent",{type:"keyUp",key,code:key,windowsVirtualKeyCode:key==="Enter"?13:9},sid);
      }
    };
    const type=async(value:string)=>{
      if (lane === "api") await browser.input(ref,{type:"text",text:value});
      else for (const key of value) {
        await native!.request("Input.dispatchKeyEvent",{type:"keyDown",key,code:"Unidentified",text:key,windowsVirtualKeyCode:0},sid);
        await native!.request("Input.dispatchKeyEvent",{type:"keyUp",key,code:"Unidentified",windowsVirtualKeyCode:0},sid);
      }
    };
    await press("Tab"); await type(scenario.first);
    const first=JSON.stringify((await browser.run(ref,["eval","document.querySelector('#first').value"])).data);
    if (scenario.name === "card") {
      expect(first).not.toContain(scenario.first);
      expect(first).toContain("[redacted]");
      await expect(browser.run(ref,["screenshot"])).rejects.toThrow("Screenshots are disabled");
    }
    await press("Tab"); await type(scenario.second);
    const second=JSON.stringify((await browser.run(ref,["eval","document.querySelector('#second').value"])).data);
    expect(second).not.toContain(scenario.second);
    expect(second).toContain("[redacted]");
    await expect(browser.run(ref,["screenshot"])).rejects.toThrow("Screenshots are disabled");
    await press("Enter");
    await browser.endHandoff(ref);
    expect(saved).toEqual([]);
    expect(vault.history(item.id)).toHaveLength(1);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe("existing-real-password");
    // A page can echo submitted data in a receipt. Both raw and regrouped PANs remain protected.
    const echo=[scenario.first,scenario.formatted,scenario.second].join(" | ");
    await browser.run(ref,["eval",`document.body.textContent=${JSON.stringify(echo)};history.pushState({},'','/after-sensitive-input');"ready"`]);
    const receipt=JSON.stringify((await browser.run(ref,["get","text","body"])).data);
    expect(receipt).not.toContain(scenario.second);
    if (scenario.name === "card") {
      expect(receipt).not.toContain(scenario.first);
      expect(receipt).not.toContain(scenario.formatted);
    }
    expect(receipt).toContain("[redacted]");
    await expect(browser.run(ref,["screenshot"])).rejects.toThrow("Screenshots are disabled");
  } finally {native?.close();await browser.shutdown();vault.close();}
},90_000);
