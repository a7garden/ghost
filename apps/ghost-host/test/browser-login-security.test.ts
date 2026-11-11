import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { AgentBrowser } from "../src/integrations/browser.ts";
import { BrowserCdp, type CdpDisconnect } from "../src/integrations/browser-cdp.ts";
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
    await native.request("Browser.close").catch(error=>{expect(error).toMatchObject({code:"unavailable"});});
    await closed.promise;
    await resumed.promise; // Actual window-close/resume event, not a guessed timer delay.
    expect(saved).toEqual([]);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe("existing-real-password");
    expect(vault.history(item.id)).toHaveLength(1);
  } finally {stop?.();native?.close();await browser.shutdown();vault.close();}
},90_000);

for (const lane of ["api","native"] as const) for (const scenario of [
  {name:"card",html:'<input id=first autocomplete="section-payment BILLING CC-NUMBER"><input id=second type=password autocomplete="cc-csc">',first:"4242424242424242",second:"679",formatted:"4242 4242 4242 4242",third:null,genuine:false},
  {name:"otp",html:'<input id=first type=email autocomplete=username><input id=second type=password autocomplete="section-auth ONE-TIME-CODE">',first:"owner@example.com",second:"123456",formatted:"owner@example.com",third:null,genuine:false},
  {name:"card-unhinted",html:'<input id=first autocomplete=off><input id=second type=password autocomplete=off>',first:"4242424242424242",second:"679",formatted:"4242 4242 4242 4242",third:null,genuine:false},
  {name:"card-number-unhinted",html:'<input id=first type=number autocomplete=off><input id=second type=password autocomplete=off>',first:"4242424242424242",second:"679",formatted:"4242 4242 4242 4242",third:null,genuine:false},
  {name:"otp-unhinted",html:'<input id=first type=email autocomplete=off><input id=second type=password autocomplete=off>',first:"owner@example.com",second:"123456",formatted:"owner@example.com",third:null,genuine:false},
  {name:"login-with-unhinted-otp",html:'<input id=first type=email autocomplete=off><input id=second type=password autocomplete=off><input id=third type=password autocomplete=off>',first:"owner@example.com",second:"real-owner-password-7389",formatted:"owner@example.com",third:"123456",genuine:true},
]) chromeTest(`real Chrome ${lane}: ${scenario.name} never saves PAN/OTP as login credentials`,async()=>{
  const root=tempDir(),vault=createVault(root),saved:string[]=[];
  const ref={ghostId:`sensitive-${lane}-${scenario.name}`,conversationId:`sensitive-${lane}-${scenario.name}`};
  const item=vault.saveLogin(ref.ghostId,{origin:"https://example.com",username:"owner@example.com",password:"existing-real-password"});
  const browser=new AgentBrowser({executable:executable!,chrome},root,(session,login)=>{const stored=vault.saveLogin(session.ghostId,login);saved.push(stored.id);return stored.id;});
  let native:BrowserCdp|undefined;
  const nativeClosed=Promise.withResolvers<CdpDisconnect>();
  try {
    await browser.run(ref,["open","https://example.com/"]);
    if (lane === "native") await browser.handoff(ref,"https://example.com/");
    await browser.run(ref,["eval",`document.body.innerHTML=${JSON.stringify(`<form>${scenario.html}<button>Continue</button></form>`)}; document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.replaceChildren();}; "ready"`]);
    let sid:string|undefined;
    if (lane === "native") {
      const endpoint=await browser.run(ref,["get","cdp-url"]);
      if (!endpoint.data || typeof endpoint.data!=="object" || !("cdpUrl" in endpoint.data) || typeof endpoint.data.cdpUrl!=="string") throw new Error("Missing test CDP endpoint");
      native=await BrowserCdp.connect(endpoint.data.cdpUrl);
      native.onDisconnect(reason=>nativeClosed.resolve(reason));
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
        const keyCode = key==="Enter"?13:key==="Backspace"?8:9;
        await native!.request("Input.dispatchKeyEvent",{type:"keyDown",key,code:key,text:key==="Enter"?"\r":undefined,windowsVirtualKeyCode:keyCode},sid);
        await native!.request("Input.dispatchKeyEvent",{type:"keyUp",key,code:key,windowsVirtualKeyCode:keyCode},sid);
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
    if (scenario.name.startsWith("card")) {
      expect(first).not.toContain(scenario.first);
      expect(first).toContain("[redacted]");
      await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
      await press("Backspace"); // Previously entered PANs remain private after later owner edits.
    }
    await press("Tab"); await type(scenario.second);
    const second=JSON.stringify((await browser.run(ref,["eval","document.querySelector('#second').value"])).data);
    expect(second).not.toContain(scenario.second);
    expect(second).toContain("[redacted]");
    await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
    if (scenario.third) {
      await press("Tab"); await type(scenario.third);
      const third=JSON.stringify((await browser.run(ref,["eval","document.querySelector('#third').value"])).data);
      expect(third).not.toContain(scenario.third); expect(third).toContain("[redacted]");
    }
    await press("Enter");
    await browser.endHandoff(ref);
    if(native) {
      // The old headed browser is deliberately closed/reaped by endHandoff.
      // Protocol corruption is not an acceptable explanation for this teardown.
      expect(["socket-close","socket-error"]).toContain((await nativeClosed.promise).cause);
    }
    expect(saved).toEqual(scenario.genuine ? [item.id] : []);
    expect(vault.history(item.id)).toHaveLength(scenario.genuine ? 2 : 1);
    expect(vault.reveal(ref.ghostId,item.id,"password")).toBe(scenario.genuine ? scenario.second : "existing-real-password");
    // A page can echo submitted data in a receipt. Both raw and regrouped PANs remain protected.
    const echo=[scenario.first,scenario.formatted,scenario.formatted.replaceAll(" ","-"),scenario.formatted.replaceAll(" ","%20"),scenario.formatted.replaceAll(" ","+"),scenario.second,...(scenario.third ? [scenario.third] : [])].join(" | ");
    await browser.run(ref,["eval",`document.body.textContent=${JSON.stringify(echo)};history.pushState({},'','/after-sensitive-input');"ready"`]);
    const receipt=JSON.stringify((await browser.run(ref,["get","text","body"])).data);
    expect(receipt).not.toContain(scenario.second);
    if (scenario.third) expect(receipt).not.toContain(scenario.third);
    if (scenario.name.startsWith("card")) {
      expect(receipt).not.toContain(scenario.first);
      expect(receipt).not.toContain(scenario.formatted);
    }
    expect(receipt).toContain("[redacted]");
    await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
    // Denying protected pixels must not conceal a dead replacement observer:
    // legitimate headless continuation still needs a healthy private channel.
    expect((await browser.run(ref,["get","url"])).ok).toBe(true);
  } finally {native?.close();await browser.shutdown();vault.close();}
},90_000);

for (const context of ["iframe","closed-shadow"] as const) chromeTest(`real Chrome API: whole PAN paste stays private with ${context} focus missing from root metadata`,async()=>{
  const root=tempDir(),saved:unknown[]=[];
  const ref={ghostId:`detached-${context}`,conversationId:`detached-${context}`};
  const browser=new AgentBrowser({executable:executable!,chrome},root,(_session,login)=>{saved.push({...login});});
  const pan="4242424242424242";
  try {
    await browser.run(ref,["open","https://example.com/"]);
    const prepare = context === "iframe"
      ? `document.body.innerHTML='<iframe id=frame></iframe>';const child=document.querySelector('iframe').contentDocument;child.body.innerHTML='<input autocomplete=off>';window.pciField=child.querySelector('input');window.pciField.focus();"ready"`
      : `document.body.innerHTML='<div id=host></div>';const shadow=document.querySelector('#host').attachShadow({mode:'closed'});shadow.innerHTML='<input autocomplete=off>';window.pciField=shadow.querySelector('input');window.pciField.focus();"ready"`;
    await browser.run(ref,["eval",prepare]);
    await browser.input(ref,{type:"text",text:pan});
    expect((await browser.run(ref,["eval","window.pciField.value.length"])).data).toMatchObject({result:16});
    const value=JSON.stringify((await browser.run(ref,["eval","window.pciField.value"])).data);
    expect(value).not.toContain(pan); expect(value).toContain("[redacted]");
    await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
    await browser.handoff(ref,"https://example.com/");
    await browser.endHandoff(ref);
    await browser.run(ref,["eval",`document.body.textContent=${JSON.stringify(pan+" | 4242-4242-4242-4242 | 4242%204242%204242%204242")};history.pushState({},'','/after-detached-payment');"ready"`]);
    const receipt=JSON.stringify((await browser.run(ref,["get","text","body"])).data);
    expect(receipt).not.toContain(pan);
    expect(receipt).not.toContain("4242-4242-4242-4242");
    expect(receipt).not.toContain("4242%204242%204242%204242");
    expect(receipt).toContain("[redacted]");
    await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
    expect(saved).toEqual([]);
  } finally {await browser.shutdown();}
},90_000);

for (const lane of ["api","native"] as const) for (const context of ["iframe","cross-origin-iframe","closed-shadow","contenteditable"] as const) chromeTest(`real Chrome ${lane}: segmented unknown ${context} input stays private and never owns a login`,async()=>{
  const root=tempDir(),saved:unknown[]=[];
  const ref={ghostId:`segmented-${lane}-${context}`,conversationId:`segmented-${lane}-${context}`};
  const browser=new AgentBrowser({executable:executable!,chrome},root,context==="contenteditable" && lane==="api" ? undefined : (_session,login)=>{saved.push({...login});});
  let native:BrowserCdp|undefined;
  const interceptionErrors:unknown[]=[];
  try {
    await browser.run(ref,["open","https://example.com/"]);
    if(lane==="native") await browser.handoff(ref,"https://example.com/");
    const endpoint=await browser.run(ref,["get","cdp-url"]);
    if(!endpoint.data || typeof endpoint.data!=="object" || !("cdpUrl" in endpoint.data) || typeof endpoint.data.cdpUrl!=="string") throw new Error("Missing test endpoint");
    native=await BrowserCdp.connect(endpoint.data.cdpUrl);
    const listed=await native.request("Target.getTargets");
    if(!Array.isArray(listed.targetInfos)) throw new Error("Missing test targets");
    const target=listed.targetInfos.find((target:Record<string,unknown>)=>target.type==="page" && typeof target.url==="string" && target.url.startsWith("https://example.com/"));
    if(!target || typeof target.targetId!=="string") throw new Error("Missing synthetic fixture page");
    const attached=await native.request("Target.attachToTarget",{targetId:target.targetId,flatten:true});
    if(typeof attached.sessionId!=="string") throw new Error("Missing fixture attachment");
    const sid=attached.sessionId;
    const evaluate=async(expression:string,stage="fixture edit")=>{
      try{return await native!.request("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true},sid);}
      catch(error){
        throw new Error(`${lane}/${context}: ${stage} (private Runtime.evaluate, root session)`,{cause:error});
      }
    };
    const fieldScript=`const field=document.querySelector('input');const report=()=>parent.postMessage({privacyFixture:true,value:field.value,focused:document.activeElement===field},'*');field.oninput=report;window.addEventListener('message',e=>{if(e.source===parent && e.data==='reset-fixture'){field.value='';field.focus();report();}});`;
    if(context==="cross-origin-iframe"){
      native.onEvent(event=>{
        if(event.method!=="Fetch.requestPaused") return;
        void native!.request("Fetch.fulfillRequest",{requestId:event.params.requestId,responseCode:200,responseHeaders:[{name:"Content-Type",value:"text/html"}],body:Buffer.from(`<input autocomplete=off><script>${fieldScript}</script>`).toString("base64")},event.sessionId).catch(error=>interceptionErrors.push(error));
      });
      await native.request("Fetch.enable",{patterns:[{urlPattern:"https://example.org/ghost-synthetic-frame*",requestStage:"Request"}]},sid);
    }
    const common=`document.body.replaceChildren();window.fixtureReady=false;window.syntheticValue='';window.fixtureWaiters=[];window.reportFixture=value=>{window.syntheticValue=value;window.fixtureReady=true;for(const waiter of window.fixtureWaiters)if(waiter.value===value)waiter.resolve(true);window.fixtureWaiters=window.fixtureWaiters.filter(waiter=>waiter.value!==value);};window.waitFixture=value=>{if(window.fixtureReady && window.syntheticValue===value)return Promise.resolve(true);const pending=Promise.withResolvers();window.fixtureWaiters.push({value,resolve:pending.resolve});return pending.promise;};window.addEventListener('message',e=>{if(e.source===window.fixtureFrame?.contentWindow && e.data?.privacyFixture){window.fixtureFieldFocused=e.data.focused;window.reportFixture(e.data.value);}});`;
    const prepare=context==="iframe" || context==="cross-origin-iframe"
      ? `${common}const f=document.createElement('iframe');window.fixtureFrame=f;window.resetFixture=()=>{window.fixtureReady=false;f.focus();f.contentWindow.postMessage('reset-fixture','*');};f.onload=window.resetFixture;${context==="iframe" ? `f.srcdoc=${JSON.stringify(`<input autocomplete=off><script>${fieldScript}</script>`)};` : `f.src='https://example.org/ghost-synthetic-frame';`}document.body.append(f);"ready"`
      : `${common}const host=document.createElement('div');document.body.append(host);${context==="closed-shadow" ? `const shadow=host.attachShadow({mode:'closed'});shadow.innerHTML='<input autocomplete=off>';const field=shadow.querySelector('input');` : `const field=host;field.contentEditable='true';field.setAttribute('role','textbox');`}const report=()=>window.reportFixture(${context==="contenteditable" ? "field.textContent" : "field.value"});field.oninput=report;window.resetFixture=()=>{${context==="contenteditable" ? "field.textContent" : "field.value"}='';field.focus();report();};window.resetFixture();"ready"`;
    await browser.run(ref,["eval",prepare]);
    const waitValue=async(value:string)=>{
      const result=await evaluate(`window.waitFixture(${JSON.stringify(value)})`,"await synthetic input report");
      expect(result).toMatchObject({result:{value:true}});
    };
    const reset=async()=>{
      await evaluate("window.resetFixture()");await waitValue("");
      if(context==="iframe" || context==="cross-origin-iframe") expect(await evaluate("window.fixtureFieldFocused === true && document.activeElement === window.fixtureFrame","focus acknowledgement")).toMatchObject({result:{value:true}});
      if(lane==="api"){
        await browser.input(ref,{type:"key",event:"down",key:"Escape",code:"Escape"});
        await browser.input(ref,{type:"key",event:"up",key:"Escape",code:"Escape"});
      }else{
        await native!.request("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27},sid);
        await native!.request("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27},sid);
      }
    };
    await waitValue("");
    // The parsing-time child focus is not a widget-readiness contract. Re-focus
    // after prepare's observer-ready barrier and await the loaded child's ack.
    await reset();
    // Model-generated trusted renderer events must not be counted as native owner input.
    expect((await browser.run(ref,["keyboard","inserttext","model731"])).ok).toBe(true);
    await waitValue("model731");
    expect(JSON.stringify((await browser.run(ref,["eval","window.syntheticValue"])).data)).toContain("model731");
    expect((await browser.run(ref,["screenshot"])).ok).toBe(true);
    await reset();
    // A command barrier also acknowledges modes in newly created child contexts.
    await browser.run(ref,["snapshot"]);
    const type=async(text:string)=>{
      for(const key of text){
        if(lane==="api") await browser.input(ref,{type:"text",text:key});
        else{
          await native!.request("Input.dispatchKeyEvent",{type:"keyDown",key,code:"Unidentified",text:key,windowsVirtualKeyCode:0},sid);
          await native!.request("Input.dispatchKeyEvent",{type:"keyUp",key,code:"Unidentified",windowsVirtualKeyCode:0},sid);
        }
      }
    };
    const pan="4532015112830366";
    await type(pan[0]!);await waitValue(pan[0]!);
    // Blocking starts at the first byte, not after a whole card/code packet.
    await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
    await type(pan.slice(1));await waitValue(pan);
    for(const command of [["eval","window.syntheticValue"],["eval","({[window.syntheticValue]:window.syntheticValue,nested:[{code:window.syntheticValue}]})"],["snapshot"]]){
      const value=JSON.stringify((await browser.run(ref,command)).data);
      expect(value).not.toContain(pan);
      if(command[0]==="eval") expect(value).toContain("[redacted]");
    }
    for(const code of ["679","123456"]){
      await reset();await type(code);await waitValue(code);
      const value=JSON.stringify((await browser.run(ref,["eval","window.syntheticValue"])).data);
      expect(value).not.toContain(code);expect(value).toContain("[redacted]");
    }
    if(lane==="api"){
      await browser.input(ref,{type:"key",event:"down",key:"Backspace",code:"Backspace"});
      await browser.input(ref,{type:"key",event:"up",key:"Backspace",code:"Backspace"});
    }else{
      await native.request("Input.dispatchKeyEvent",{type:"keyDown",key:"Backspace",code:"Backspace",windowsVirtualKeyCode:8},sid);
      await native.request("Input.dispatchKeyEvent",{type:"keyUp",key:"Backspace",code:"Backspace",windowsVirtualKeyCode:8},sid);
    }
    await type("9");await waitValue("123459");
    expect(JSON.stringify((await browser.run(ref,["eval","window.syntheticValue"])).data)).not.toContain("123459");
    // Selection and replacement must not turn unknown event bytes into login authority.
    if(lane==="api"){
      await browser.input(ref,{type:"key",event:"down",key:"a",code:"KeyA",modifiers:4});
      await browser.input(ref,{type:"text",text:"864"});
    }else{
      await native.request("Input.dispatchKeyEvent",{type:"keyDown",key:"a",code:"KeyA",modifiers:4,windowsVirtualKeyCode:65,commands:["selectAll"]},sid);
      await native.request("Input.dispatchKeyEvent",{type:"keyUp",key:"a",code:"KeyA",modifiers:4,windowsVirtualKeyCode:65},sid);
      await type("864");
    }
    await waitValue("864");
    const replacement=JSON.stringify((await browser.run(ref,["eval","window.syntheticValue"])).data);
    expect(replacement).not.toContain("864");
    await browser.endHandoff(ref);
    await browser.run(ref,["eval",`document.body.textContent=${JSON.stringify(`${pan} | 4532-0151-1283-0366 | 679 | 123456`)};history.pushState({},'','/after-unknown-owner');"ready"`]);
    const receipt=JSON.stringify((await browser.run(ref,["get","text","body"])).data);
    for(const secret of [pan,"4532-0151-1283-0366","679","123456"]) expect(receipt).not.toContain(secret);
    expect(receipt).toContain("[redacted]");
    await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
    expect(saved).toEqual([]);
    expect(interceptionErrors).toEqual([]);
  }finally{native?.close();await browser.shutdown();}
},90_000);
