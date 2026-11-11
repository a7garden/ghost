import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { LoginCapture, isPanLike, isNumericCode, type LoginField, type LoginPage } from "../src/integrations/login-capture.ts";
import { chromeLoginScript } from "../src/integrations/login-capture-chrome-script.ts";

function isolatedField(type: string, autocomplete: string) {
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
  window.top = window;
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
