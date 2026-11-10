import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { LoginCapture, type LoginField, type LoginPage } from "../src/integrations/login-capture.ts";
import { chromeLoginScript } from "../src/integrations/login-capture-chrome-script.ts";

function isolatedField(type: string, autocomplete: string) {
  class Input {
    value = ""; selectionStart = 0; selectionEnd = 0;
    form = {}; name = "code"; id = "code"; disabled = false; readOnly = false;
    constructor(readonly type: string, readonly autocomplete: string) {}
    getAttribute(name: string) { return name === "autocomplete" ? this.autocomplete : null; }
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
  const values = ["owner@example.com","genuine-owner-password","654321"];
  const page = {...base,fields};
  fields.forEach((field,index)=>capture.edit(page,field,{type:"insert",text:values[index]!}));
  const populated = {...page,fields:fields.map((field,index)=>({...field,length:values[index]!.length,start:values[index]!.length,end:values[index]!.length}))};
  await capture.observe(populated); capture.submit(populated,"form");
  await capture.observe({...page,fields:[]});
  expect(saved).toEqual([{origin:base.origin,username:values[0],password:values[1]}]);
  expect(redacted).toContainEqual({value:values[2],scope:undefined,sensitive:true});
});
