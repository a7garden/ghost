import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/integrations/browser.ts";
import { tempDir } from "./support.ts";
import { LoginCapture, UnknownOwnerText, isPanLike, isNumericCode, type LoginField, type LoginPage } from "../src/integrations/login-capture.ts";
import { chromeLoginScript } from "../src/integrations/login-capture-chrome-script.ts";
import { CommandError } from "../src/core/errors.ts";
import type { LoginObserver } from "../src/integrations/browser-login.ts";
import { BrowserCdp, type CdpDisconnect } from "../src/integrations/browser-cdp.ts";

function isolatedField(type: string, autocomplete: string, child = false) {
  class Input {
    value = ""; selectionStart = 0; selectionEnd = 0;
    form = {}; name = "code"; id = "code"; disabled = false; readOnly = false;
    attributes: Record<string,string> = {};
    labels: {textContent:string}[] = [];
    constructor(readonly type: string, readonly autocomplete: string) {}
    getAttribute(name: string) { return name === "autocomplete" ? this.autocomplete : this.attributes[name] ?? null; }
  }
  const input = new Input(type,autocomplete);
  const listeners = new Map<string,(event: Record<string,unknown>) => void>();
  const emitted: Record<string,unknown>[] = [];
  const window: {top?: unknown; addEventListener(name: string, listener: (event: Record<string,unknown>) => void): void} = {addEventListener(name,listener) { listeners.set(name,listener); }};
  window.top = child ? {} : window;
  const context = {window,document:{querySelectorAll:()=>[input],activeElement:input},location:{href:"https://example.com/",origin:"https://example.com"},HTMLInputElement:Input,HTMLButtonElement:class {},crypto:{getRandomValues:(values:Uint32Array)=>values.fill(1)},publish:(value:string)=>emitted.push(JSON.parse(value))};
  runInNewContext(chromeLoginScript("controller","publish"),context);
  return {input,listeners,emitted,context};
}

test("card, OTP and new-password autocomplete tokens are redaction-only, regardless of case or section tokens", () => {
  for (const [type,autocomplete,kind] of [
    ["text","cc-number","sensitive"], ["password","cc-csc","sensitive"],
    ["text"," section-checkout\tBILLING\nCC-EXP ","sensitive"],
    ["text","shipping CC-NAME","sensitive"], ["tel","section-card cc-number webauthn","sensitive"],
    ["password","one-time-code","sensitive"], ["number"," SECTION-code ONE-TIME-CODE ","sensitive"],
    ["password","section-register NEW-PASSWORD","sensitive"],
    ["password","section-login CURRENT-PASSWORD","password"],
    ["email","section-login USERNAME","username"], ["text","off","username"],
  ]) {
    const {context} = isolatedField(type!,autocomplete!);
    expect(runInNewContext("controller.metadata().fields[0].kind",context)).toBe(kind);
  }
});

test("trusted native sensitive edits carry event bytes, never a DOM credential-value fallback", () => {
  const {input,listeners,emitted,context} = isolatedField("password","SECTION-code ONE-TIME-CODE");
  runInNewContext("controller.native(true,false)",context);
  listeners.get("keydown")!({isTrusted:true,target:input,key:"7"});
  listeners.get("beforeinput")!({isTrusted:true,target:input,inputType:"insertText",data:"7"});
  input.value = "7"; input.selectionStart = input.selectionEnd = 1;
  listeners.get("input")!({isTrusted:true,target:input});
  expect(emitted.find(event=>event.type === "edit")).toMatchObject({field:{kind:"sensitive"},edit:{type:"insert",text:"7"}});
  input.value = "page-owned-forgery-value";
  listeners.get("input")!({isTrusted:true,target:input});
  expect(emitted.at(-1)).toMatchObject({field:{kind:"sensitive"},edit:{type:"unknown"}});
  expect(JSON.stringify(emitted)).not.toContain(input.value);
});

test("owned card/OTP bytes stay redacted but cannot create or overwrite a login, including explicit completion", async () => {
  const saved: unknown[] = [], redacted: {value:string;scope?:string;sensitive?:boolean}[] = [];
  const capture = new LoginCapture(async login=>{saved.push({...login});},(value,scope,sensitive)=>redacted.push({value,scope,sensitive}));
  const field = (id:string,kind:LoginField["kind"]):LoginField => ({id,form:"form",kind,length:0,start:0,end:0,score:100});
  const base: LoginPage = {targetId:"page",documentId:"document",url:"https://example.com/",origin:"https://example.com",fields:[],focused:null,clicked:null};
  for (const fields of [
    [{field:field("pan","sensitive"),value:"4242424242424242"},{field:field("cvc","sensitive"),value:"679"}],
    [{field:field("user","username"),value:"owner@example.com"},{field:field("otp","sensitive"),value:"123456"}],
  ]) {
    const page = {...base,fields:fields.map(entry=>entry.field)};
    for (const entry of fields) capture.edit(page,entry.field,{type:"insert",text:entry.value});
    const populated = {...page,fields:fields.map(entry=>({...entry.field,length:entry.value.length,start:entry.value.length,end:entry.value.length}))};
    await capture.observe(populated);
    capture.submit(populated,"form");
    for (const entry of fields.filter(entry=>entry.field.kind === "sensitive")) expect(redacted).toContainEqual({value:entry.value,scope:undefined,sensitive:true});
    await capture.observe({...page,fields:[]});
    await capture.observe({...page,fields:[]},true);
    expect(saved).toEqual([]);
    capture.clear();
  }
  const fields = [field("user","username"),field("password","password"),field("otp","sensitive")];
  const values = ["owner@example.com","genuine-owner-password","654321"] as const;
  const page = {...base,fields};
  fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
  const populated = {...page,fields:fields.map((field,index)=>({...field,length:values[index]!.length,start:values[index]!.length,end:values[index]!.length}))};
  await capture.observe(populated); capture.submit(populated,"form");
  await capture.observe({...page,fields:[]});
  expect(saved).toEqual([{origin:base.origin,username:values[0],password:values[1]}]);
  expect(redacted).toContainEqual({value:values[2],scope:undefined,sensitive:true});
});

test("PAN and numeric-code owner-byte policy has explicit conservative boundaries", () => {
  for (const value of ["424242424242","4242 4242-4242 4242","1234567890123456789"]) expect(isPanLike(value)).toBe(true);
  for (const value of ["12345678901","12345678901234567890","owner123456789012","+123456789012"]) expect(isPanLike(value)).toBe(false);
  for (const value of ["679","123-456","12345678"]) expect(isNumericCode(value)).toBe(true);
  for (const value of ["12","123456789","123abc"]) expect(isNumericCode(value)).toBe(false);
});

test("unknown owner text is bounded and scoped; edit boundaries never supply credential values", () => {
  const trail = new UnknownOwnerText();
  let values: readonly string[] = [];
  for (const text of "4532015112830366") values = trail.edit("target/document/focus",{type:"insert",text});
  expect(values).toContain("4532015112830366");
  expect(trail.edit("other-target/document/focus",{type:"insert",text:"67"})).toEqual([]);
  expect(trail.edit("other-target/document/focus",{type:"insert",text:"9"})).toEqual(["679"]);
  expect(trail.edit("other-target/new-document/focus",{type:"insert",text:"12"})).toEqual([]);
  trail.reset();
  expect(trail.edit("other-target/new-document/focus",{type:"insert",text:"3"})).toEqual([]);
  expect(trail.edit("other-target/new-document/focus",{type:"unknown"})).toEqual([]);
  expect(trail.edit("other-target/new-document/focus",{type:"insert",text:"45"})).toEqual([]);
  expect(trail.edit("other-target/new-document/focus",{type:"backspace"})).toEqual([]);
  expect(trail.edit("other-target/new-document/focus",{type:"insert",text:"6"})).toEqual([]);
  values = trail.edit("overflow",{type:"insert",text:"x".repeat(UnknownOwnerText.limit * 2)+"123456"});
  expect(values).toEqual(["123456"]);
  values = trail.edit("overflow",{type:"insert",text:"9".repeat(UnknownOwnerText.limit * 2)});
  expect(values).toEqual(["9".repeat(19)]);
  values = trail.edit("mixed",{type:"insert",text:"OTP: 123-456; CVC: 679"});
  expect(values).toEqual(["123-456","679"]);
  values = trail.edit("large-mixed-paste",{type:"insert",text:"4532015112830366"+"x".repeat(UnknownOwnerText.limit*2)});
  expect(values).toContain("4532015112830366");
});

test("isolated control readiness acknowledges exact modes without requiring a credential-ready DOM or origin",()=>{
  const {context,emitted}=isolatedField("text","off");
  context.location.href="about:blank";context.location.origin="null";
  Object.defineProperty(context.document,"querySelectorAll",{value(){throw new Error("Control bootstrap read credential metadata");}});
  Object.defineProperty(context.document,"activeElement",{get(){throw new Error("Control bootstrap read focus metadata");}});
  const ack=runInNewContext("controller.native(true,false,false,false)",context);
  expect(ack).toMatchObject({version:1,allowed:true,ownerApi:false});
  expect(typeof ack.documentId).toBe("string");
  expect(Object.keys(ack).sort()).toEqual(["allowed","documentId","ownerApi","version"]);
  expect(runInNewContext("controller.native(false,true)",context)).toMatchObject({version:1,documentId:ack.documentId,allowed:false,ownerApi:true});
  expect(emitted).toEqual([]);
});

test("child-frame listener emits byte-only privacy edits, never descriptors or DOM values", () => {
  const {input,listeners,emitted,context} = isolatedField("password","current-password",true);
  Object.defineProperty(input,"value",{get(){throw new Error("Child privacy listener read a DOM value");}});
  runInNewContext("controller.native(true,false)",context);
  listeners.get("keydown")!({isTrusted:true,target:input,key:"7"});
  listeners.get("beforeinput")!({isTrusted:true,target:input,inputType:"insertText",data:"7"});
  listeners.get("input")!({isTrusted:true,target:input});
  expect(emitted.find(event=>event.type === "privacy-edit")).toMatchObject({allowed:true,ownerApi:false,edit:{type:"insert",text:"7"},meta:{fields:[],focused:null}});
  expect(emitted.some(event=>event.type === "edit" || event.type === "submit")).toBe(false);
  const count = emitted.length;
  listeners.get("beforeinput")!({isTrusted:false,target:input,inputType:"insertText",data:"forged"});
  expect(emitted).toHaveLength(count);
  listeners.get("keydown")!({isTrusted:true,target:input,key:"Tab"});
  expect(emitted.at(-1)).toMatchObject({type:"privacy-boundary"});
  listeners.get("keydown")!({isTrusted:true,target:input,key:"Enter"});
  expect(emitted.some(event=>event.type === "edit" || event.type === "submit")).toBe(false);
  listeners.get("beforeinput")!({isTrusted:true,target:input,inputType:"insertReplacementText",data:null});
  expect(emitted.at(-1)).toMatchObject({type:"privacy-edit",edit:{type:"unknown"},meta:{fields:[],focused:null}});
  runInNewContext("controller.native(false,true)",context);
  listeners.get("beforeinput")!({isTrusted:true,target:input,inputType:"insertText",data:"8"});
  expect(emitted.at(-1)).toMatchObject({allowed:false,ownerApi:true,edit:{type:"insert",text:"8"}});
});

test("first mode acknowledgement preserves only creation-time native privacy, never model/API echoes or login authority", () => {
  for (const [initialNative,initialApi,retained] of [[true,false,true],[false,false,false],[false,true,false],[true,true,false]]) {
    const {input,listeners,emitted,context} = isolatedField("password","current-password",true);
    Object.defineProperty(input,"value",{get(){throw new Error("Deferred privacy read a DOM value");}});
    listeners.get("keydown")!({isTrusted:true,target:input,key:"7"});
    listeners.get("beforeinput")!({isTrusted:true,target:input,inputType:"insertText",data:"7"});
    listeners.get("input")!({isTrusted:true,target:input});
    expect(emitted.some(event=>event.type === "privacy-edit")).toBe(false);
    // A different current mode must not reclassify bytes from the resume gap.
    runInNewContext(`controller.native(${!initialNative},false,${initialNative},${initialApi})`,context);
    const privacy=emitted.filter(event=>event.type === "privacy-edit");
    expect(privacy).toHaveLength(retained ? 1 : 0);
    if(retained) expect(privacy[0]).toMatchObject({allowed:true,ownerApi:false,edit:{type:"insert",text:"7"},meta:{fields:[],focused:null}});
    runInNewContext("controller.native(true,false,true,false)",context);
    expect(emitted.filter(event=>event.type === "privacy-edit")).toHaveLength(retained ? 1 : 0);
    expect(emitted.some(event=>event.type === "edit" || event.type === "submit")).toBe(false);
  }
});

test("pre-ack privacy queue overflow is bounded and fails closed without exporting DOM or oversized event values", () => {
  const {input,listeners,emitted,context} = isolatedField("text","off",true);
  Object.defineProperty(input,"value",{get(){throw new Error("Overflow privacy read a DOM value");}});
  for(let i=0;i<130;i++) listeners.get("beforeinput")!({isTrusted:true,target:input,inputType:"insertText",data:"7"});
  listeners.get("beforeinput")!({isTrusted:true,target:input,inputType:"insertText",data:"8".repeat(5000)});
  expect(emitted).toEqual([]);
  runInNewContext("controller.native(true,false,true,false)",context);
  expect(emitted.filter(event=>event.type === "privacy-edit")).toHaveLength(129);
  expect(emitted.at(-1)).toMatchObject({type:"privacy-edit",allowed:true,ownerApi:false,edit:{type:"unknown"}});
  expect(JSON.stringify(emitted)).not.toContain("8".repeat(5000));
  expect(emitted.some(event=>event.type === "edit" || event.type === "submit")).toBe(false);
});

test("precise field and associated-label hints exclude unhinted card/OTP roles without matching generic code names", () => {
  for (const hint of [
    {name:"cardNumber"}, {id:"cc_csc"}, {aria:"Verification code"}, {label:"카드 번호"},
    {label:"One-time password"}, {name:"otp_code"}, {id:"credit_card_number"},
  ]) {
    const {input,context} = isolatedField("text","off");
    input.name = "ordinary"; input.id = "ordinary";
    if ("name" in hint) input.name = hint.name!;
    if ("id" in hint) input.id = hint.id!;
    if ("aria" in hint) input.attributes["aria-label"] = hint.aria!;
    if ("label" in hint) input.labels = [{textContent:hint.label!}];
    expect(runInNewContext("controller.metadata().fields[0].kind",context)).toBe("sensitive");
  }
  const {context} = isolatedField("password","off");
  expect(runInNewContext("controller.metadata().fields[0].kind",context)).toBe("password");
});

function ownerFields(kinds: LoginField["kind"][], forms = kinds.map(()=>"form")) {
  const fields: LoginField[] = kinds.map((kind,index)=>({id:String(index),form:forms[index]!,kind,length:0,start:0,end:0,score:100}));
  const page: LoginPage = {targetId:"page",documentId:"document",url:"https://example.com/",origin:"https://example.com",fields,focused:null,clicked:null};
  return {fields,page,populated:(values:string[])=>({...page,fields:fields.map((field,index)=>({...field,length:values[index]!.length,start:values[index]!.length,end:values[index]!.length}))})};
}

test("unhinted payment bytes taint that form even with a plausible username/password and after later PAN edits", async () => {
  const saved:unknown[] = [], privateValues:string[] = [];
  const capture = new LoginCapture(async login=>{saved.push({...login});},(value,scope,sensitive)=>{if(sensitive && scope === undefined) privateValues.push(value);});
  const {fields,page,populated} = ownerFields(["username","username","password"]);
  const values = ["owner@example.com","4242424242424242","looks-like-a-real-password"];
  fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
  let current = populated(values);
  await capture.observe(current);
  capture.edit(current,{...current.fields[1]!,start:0,end:values[1]!.length},{type:"insert",text:"now-public-looking"});
  values[1] = "now-public-looking"; current = populated(values);
  await capture.observe(current); capture.submit(current,"form");
  await capture.observe({...page,fields:[]},true);
  expect(saved).toEqual([]);
  expect(privateValues).toContain("4242424242424242");
});

test("unhinted 3–8 digit passwords never auto-save, but a real password plus a separate numeric OTP still does", async () => {
  for (const code of ["679","123456","12345678","123-456"]) {
    const saved:unknown[] = [];
    const capture = new LoginCapture(async login=>{saved.push({...login});},()=>{});
    const {fields,page,populated} = ownerFields(["username","password"]);
    const values = ["owner@example.com",code];
    fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
    const current = populated(values);
    await capture.observe(current); capture.submit(current,"form");
    await capture.observe({...page,fields:[]}); await capture.observe(null,true);
    expect(saved).toEqual([]);
  }
  const saved:unknown[] = [];
  const capture = new LoginCapture(async login=>{saved.push({...login});},()=>{});
  const {fields,page,populated} = ownerFields(["username","password","password"]);
  const values = ["owner@example.com","genuine-owner-password","123456"];
  fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
  const current = populated(values);
  await capture.observe(current); capture.submit(current,"form"); await capture.observe({...page,fields:[]});
  expect(saved).toEqual([{origin:page.origin,username:values[0],password:values[1]}]);
});

test("masked/non-credential edits retain only owner-byte PAN privacy, never DOM value ownership", async () => {
  const saved:unknown[] = [], privateValues:string[] = [];
  const capture = new LoginCapture(async login=>{saved.push({...login});},(value,_scope,sensitive)=>{if(sensitive)privateValues.push(value);});
  const {fields,page} = ownerFields(["other"]);
  let visible = "";
  for (const digit of "4242424242424242") {
    const field = {...fields[0]!,length:visible.length,start:visible.length,end:visible.length};
    capture.edit({...page,fields:[field]},field,{type:"insert",text:digit});
    visible = (visible.replace(/\D/g,"")+digit).replace(/(\d{4})(?=\d)/g,"$1 ");
    await capture.observe({...page,fields:[{...field,length:visible.length,start:visible.length,end:visible.length}]});
  }
  capture.submit({...page,fields:[{...fields[0]!,length:visible.length,start:visible.length,end:visible.length}]},"form");
  await capture.observe({...page,fields:[]},true);
  expect(privateValues).toContain("4242424242424242");
  expect(saved).toEqual([]);
});

test("unlocated PAN blocks document-level credential authority; located PAN does not poison an independent login form", async () => {
  const saved:unknown[] = [], privateValues:string[] = [];
  const capture = new LoginCapture(async login=>{saved.push({...login});},(value,_scope,sensitive)=>{if(sensitive)privateValues.push(value);});
  const {fields,page,populated} = ownerFields(["username","password"]);
  capture.protectPan({...page,fields:[]},"4242-4242-4242-4242");
  const values = ["owner@example.com","genuine-owner-password"];
  fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
  capture.submit(populated(values),"form"); await capture.observe({...page,fields:[]},true);
  expect(saved).toEqual([]); expect(privateValues).toContain("4242-4242-4242-4242");
  capture.clear();
  const separate = ownerFields(["other","username","password"],["payment","login","login"]);
  const separateValues = ["4242424242424242",...values];
  separate.fields.forEach((field,index)=>capture.edit(separate.page,field,{type:"insert",text:separateValues[index]!}));
  capture.submit(separate.populated(separateValues),"login"); await capture.observe({...separate.page,fields:[]});
  expect(saved).toEqual([{origin:page.origin,username:values[0],password:values[1]}]);
});

test("other/sensitive fields cannot be reclassified into credential authority by later markup changes", async () => {
  for (const kind of ["other","sensitive"] as const) {
    const saved:unknown[] = [];
    const capture = new LoginCapture(async login=>{saved.push({...login});},()=>{});
    const {fields,page,populated} = ownerFields([kind,"password"]);
    const values = ["original","genuine-owner-password"];
    fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
    await capture.observe(populated(values));
    const changed = {...populated(values),fields:populated(values).fields.map((field,index)=>index===0?{...field,kind:"username" as const,start:0,end:values[0]!.length}:field)};
    capture.edit(changed,changed.fields[0]!,{type:"insert",text:"replacement"});
    values[0] = "replacement";
    const final = {...changed,fields:changed.fields.map((field,index)=>({...field,length:values[index]!.length,start:values[index]!.length,end:values[index]!.length}))};
    capture.submit(final,"form"); await capture.observe({...final,fields:[]},true);
    expect(saved).toEqual([]);
  }
});

test("recognizing an ambiguous numeric code invalidates a pending attempt from that same field", async () => {
  const saved:unknown[] = [];
  const capture = new LoginCapture(async login=>{saved.push({...login});},()=>{});
  const {fields,page,populated} = ownerFields(["username","password"]);
  const values = ["owner@example.com","1"];
  fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
  const pending = populated(values);
  capture.submit(pending,"form"); await capture.observe(pending);
  capture.edit(pending,pending.fields[1]!,{type:"insert",text:"23456"});
  values[1] = "123456";
  await capture.observe(populated(values));
  await capture.observe({...page,fields:[]},true);
  expect(saved).toEqual([]);
});

test("native paste supplies detached PAN privacy from trusted clipboard event bytes, not element values", () => {
  const {input,listeners,emitted,context} = isolatedField("text","off");
  input.value = "page-owned-forgery-value";
  runInNewContext("controller.native(true,false)",context);
  listeners.get("paste")!({isTrusted:true,target:{},clipboardData:{getData:()=>"4242424242424242"}});
  expect(emitted.at(-1)).toMatchObject({type:"privacy",text:"4242424242424242",field:null});
  expect(JSON.stringify(emitted)).not.toContain(input.value);
});

test("blocked actor edits can protect PAN privacy but never acquire credential ownership", async () => {
  const saved:unknown[] = [], privateValues:string[] = [];
  const capture = new LoginCapture(async login=>{saved.push({...login});},(value,_scope,sensitive)=>{if(sensitive)privateValues.push(value);});
  const {fields,page,populated} = ownerFields(["username","password"]);
  const values = ["4242424242424242","genuine-owner-password"];
  capture.edit(page,fields[0]!,{type:"insert",text:values[0]!},false);
  capture.edit(page,fields[1]!,{type:"insert",text:values[1]!});
  capture.submit(populated(values),"form"); await capture.observe({...page,fields:[]},true);
  expect(privateValues).toContain(values[0]!);
  expect(saved).toEqual([]);
});

test("native snapshot refs survive arbitrary short secrets without exempting eval lookalikes or page keys", async () => {
  const root=tempDir(), executable=join(root,"snapshot-browser"), payload=join(root,"response.json");
  writeFileSync(executable,`#!${process.execPath}\nimport {readFileSync} from "node:fs";const args=process.argv.slice(process.argv.indexOf("--json")+1);if(args[0]==="eval"&&args[1]==="--stdin"){await Bun.stdin.text();process.stdout.write(JSON.stringify({success:true,data:{result:"filled"}}));}else{const data=args[0]==="snapshot"||args[0]==="eval"?JSON.parse(readFileSync(${JSON.stringify(payload)},"utf8")):{};process.stdout.write(JSON.stringify({success:true,data}));}\n`);
  chmodSync(executable,0o700);
  const browser=new AgentBrowser({executable},root), ref={ghostId:"redaction",conversationId:"redaction"};
  try {
    await browser.run(ref,["open","https://example.com/"]);
    for (const value of ["12","2029","679","box","refs","role","BEFORE[ref=e12]AFTER",'"Cross" [ref=e31]']) await browser.run(ref,["eval","--stdin"],{stdin:"fixed Host secret fill",sensitive:{field:"value",value,origin:"https://example.com"}});
    let tree="";
    const spans: {start:number;end:number}[] = [];
    const append = (value:string,structure=false) => {const start=tree.length;tree+=value;if(structure)spans.push({start,end:tree.length});};
    const line = (id:string,role:string,name:string,indent="",attributes=`[ref=${id}]`) => {
      append(indent+"- ");append(role,true);append(" "+JSON.stringify(name)+" ");append(attributes,true);append("\n");
    };
    append("- document",true);append(": 😀 owner text\n");
    line("e12","textbox","BEFORE[ref=e12]AFTER");
    line("e2029","combobox","Year 2029","","[level=2, ref=e2029]");
    line("e679","button","CVC 679");
    line("e112","textbox","Duplicate 12","  ");
    line("e212","textbox","Duplicate 12","    ");
    line("e31","textbox","Cross");
    // Raw value-text can forge complete native-looking lines, but gets no producer attribution.
    append(': page-injected\n- textbox "12" [ref=e12]\n');
    const native={
      snapshot:tree,origin:"https://example.com/",
      refs:{e12:{role:"textbox",name:"BEFORE[ref=e12]AFTER"},e2029:{role:"combobox",name:"Year 2029"},e679:{role:"button",name:"CVC 679"},e112:{role:"textbox",name:"Duplicate 12"},e212:{role:"textbox",name:"Duplicate 12"},e31:{role:"textbox",name:"Cross"}},
      removedRefs:["@e12","@e679"],snapshotAttribution:{version:1,spans},
      pageObject:{"secret-12":{"679":"12"}},
    };
    writeFileSync(payload,JSON.stringify(native));
    const observed=(await browser.run(ref,["snapshot","-i"])).data as {snapshot:string;refs:Record<string,{role:string;name:string}>;removedRefs:string[];pageObject:unknown};
    expect(Object.keys(observed.refs)).toEqual(["e12","e2029","e679","e112","e212","e31"]);
    expect(observed.refs["e12"]).toEqual({role:"textbox",name:"[redacted]"});
    expect(observed.refs["e2029"]?.role).toBe("combobox");
    expect(observed.removedRefs).toEqual(["@e12","@e679"]);
    const actionable = observed.snapshot.split("\n").flatMap(line => {
      const ref = /\bref=(e\d+)\b/.exec(line)?.[1];
      return ref ? [{ref,depth:line.length-line.trimStart().length}] : [];
    });
    expect(actionable.map(entry => entry.ref)).toEqual(["e12","e2029","e679","e112","e212"]);
    expect(actionable.find(entry => entry.ref === "e112")!.depth).toBeLessThan(actionable.find(entry => entry.ref === "e212")!.depth);
    expect(observed.snapshot).not.toContain('[ref=e31]'); // A whole secret crossing structure must still be removed.
    expect(observed.snapshot).not.toContain("Cross");
    expect(observed.snapshot).not.toContain('page-injected\n- textbox "12" [ref=e12]');
    expect("snapshotAttribution" in observed).toBe(false);
    expect(observed.snapshot).not.toContain("BEFORE");
    expect(observed.snapshot).not.toContain("AFTER");
    expect(observed.snapshot).not.toContain('"Year 2029"');
    expect(JSON.stringify(observed.pageObject)).not.toContain("12");
    expect(JSON.stringify(observed.pageObject)).not.toContain("679");
    const evaluated=JSON.stringify((await browser.run(ref,["eval","page expression"])).data);
    expect(evaluated).not.toContain('"refs"');
    expect(evaluated).not.toContain('"e12"');
    expect(evaluated).not.toContain('"textbox"');
    expect(evaluated).not.toContain('"role"');
    expect(evaluated).not.toContain("BEFORE");
    expect(evaluated).not.toContain("AFTER");
    const emoji=tree.indexOf("😀");
    for (const attribution of [
      undefined,{version:2,spans},{version:1,spans:[{start:-1,end:2}]},
      {version:1,spans:[{start:2,end:2}]},{version:1,spans:[{start:0,end:tree.length+1}]},
      {version:1,spans:[{start:4,end:8},{start:2,end:3}]},
      {version:1,spans:[{start:2,end:8},{start:7,end:9}]},
      {version:1,spans:[{start:2.5,end:3}]},
      {version:1,spans:[{start:emoji+1,end:emoji+2}]},
    ]) {
      writeFileSync(payload,JSON.stringify({...native,snapshotAttribution:attribution}));
      await expect(browser.run(ref,["snapshot","-i"])).rejects.toMatchObject({code:"unavailable",message:"Browser snapshot attribution is missing or invalid; update the Host browser build"});
    }
  } finally {await browser.shutdown();}
});

test("sticky screenshot permission is denied before observer I/O; unrelated commands still expose observer failure", async () => {
  const root=tempDir(),executable=join(root,"sticky-browser");
  writeFileSync(executable,`#!${process.execPath}\nif(process.argv.includes("--stdin"))await Bun.stdin.text();process.stdout.write(JSON.stringify({success:true,data:{result:"filled"}}));\n`);
  chmodSync(executable,0o700);
  const ref={ghostId:"sticky-permission",conversationId:"sticky-permission"},browser=new AgentBrowser({executable},root);
  let modeCalls=0;
  try {
    await browser.run(ref,["open","https://example.com/"]);
    await browser.run(ref,["eval","--stdin"],{stdin:"fixed Host fill",sensitive:{field:"value",value:"679",origin:"https://example.com"}});
    // Unit-test seam: inspect the in-process session, not external protocol data.
    const internal=browser as unknown as {sessionMap:Map<string,{loginObserver?:LoginObserver}>};
    const session=internal.sessionMap.get(ref.conversationId)!;
    let closed=false;
    session.loginObserver={
      get ended(){return closed;},
      snapshot:async()=>null,
      updateMode:async()=>{modeCalls++;throw new CommandError("unavailable","Test observer mode acknowledgement failed");},
      close(){closed=true;},
    };
    await expect(browser.run(ref,["screenshot"])).rejects.toMatchObject({code:"forbidden"});
    expect(modeCalls).toBe(0);
    await expect(browser.run(ref,["eval","page expression"])).rejects.toMatchObject({code:"unavailable"});
    expect(modeCalls).toBeGreaterThan(0);
  }finally{await browser.shutdown();}
});

for(const kind of ["host","socket","oversized"] as const) test(`private CDP ${kind} termination retains only fixed classifications and rejects later commands`,async()=>{
  const opened=Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
  const secret="synthetic-private-close-reason";
  const server=Bun.serve<undefined>({
    hostname:"127.0.0.1",port:0,
    fetch(request,server){if(server.upgrade(request))return;return new Response(null,{status:400});},
    websocket:{
      open(socket){opened.resolve(socket);},
      message(socket){if(kind==="socket")socket.close(1001,secret);},
    },
  });
  let cdp:BrowserCdp|undefined;
  try{
    cdp=await BrowserCdp.connect(`ws://127.0.0.1:${server.port}/devtools/browser/privacy-test`);
    const peer=await opened.promise,closed=Promise.withResolvers<CdpDisconnect>();
    cdp.onDisconnect(reason=>closed.resolve(reason));
    const pending=kind==="socket" ? cdp.request("Runtime.evaluate",{expression:secret}).then(()=>null,error=>error) : undefined;
    if(kind==="host")cdp.close();
    else if(kind==="oversized")peer.send(secret.repeat(50_000));
    const reason=await closed.promise;
    expect(reason).toEqual(kind==="host" ? {cause:"host-close",stage:"host"} : kind==="socket" ? {cause:"socket-close",stage:"command",closeCode:1001} : {cause:"protocol-oversized",stage:"receive"});
    expect(JSON.stringify(reason)).not.toContain(secret);
    if(pending)expect(await pending).toMatchObject({code:"unavailable"});
    const terminal=await cdp.request("Target.getTargets").then(()=>null,error=>error);
    expect(terminal).toMatchObject({code:"unavailable"});
    expect(String(terminal)).not.toContain(secret);
  }finally{cdp?.close();server.stop(true);}
});
