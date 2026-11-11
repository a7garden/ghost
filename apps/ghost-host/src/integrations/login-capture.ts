import type { BrowserLogin } from "./ports.ts";

export interface LoginField {
  id: string; form: string; kind: "username" | "password" | "sensitive" | "submit" | "other";
  length: number; start: number | null; end: number | null; score: number;
}
export interface LoginPage {
  targetId: string; documentId: string; url: string; origin: string;
  fields: LoginField[]; focused: string | null; clicked: string | null;
}
export type LoginEdit = { type: "insert"; text: string } | { type: "backspace" | "delete" | "unknown" };
interface TypedField { page: LoginPage; field: LoginField; value: string; privacyValue: string; known: boolean; sequence: number; redactionOnly: boolean; pan: boolean }
interface Candidate extends BrowserLogin { targetId: string; documentId: string; url: string; field: string; formKey: string }
const graphemes = new Intl.Segmenter(undefined,{granularity:"grapheme"});
const invalidUtf16 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Conservative owner-byte policy, independent of page-supplied credential labels. */
export function isPanLike(value: string): boolean {
  if (!/^[\d\s-]+$/.test(value)) return false;
  const digits = value.replace(/[\s-]/g,"").length;
  return digits >= 12 && digits <= 19;
}
export function isNumericCode(value: string): boolean {
  if (!/^[\d\s-]+$/.test(value)) return false;
  const digits = value.replace(/[\s-]/g,"").length;
  return digits >= 3 && digits <= 8;
}

/** Bounded owner-byte trail, not a field value and never a source of login authority.
 * Cursor/selection changes discard the trail; already registered secrets stay private.
 */
export class UnknownOwnerText {
  static readonly limit = 4096;
  private scope = "";
  private text = "";
  reset() { this.scope = this.text = ""; }
  edit(scope: string, edit: LoginEdit): readonly string[] {
    if (scope !== this.scope) { this.reset(); this.scope = scope; }
    if (edit.type !== "insert") { this.text = ""; return []; }
    const incoming = this.text + edit.text;
    this.text = incoming.slice(-UnknownOwnerText.limit);
    // Scan the accepted packet before bounding the retained trail: a large mixed
    // paste must not hide a PAN near its beginning. Long runs retain a private
    // suffix rather than letting overflow disable recognition.
    const values: string[] = [];
    for (const match of incoming.matchAll(/\d(?:[\d\s-]*\d)?/g)) {
      const value = match[0], digits = value.replace(/\D/g,"");
      if (isPanLike(value) || isNumericCode(value)) values.push(value);
      else if (digits.length > 19) values.push(digits.slice(-19));
    }
    return values;
  }
}

/** Only owner input supplies credential bytes. Page observations can establish completion, never values. */
export class LoginCapture {
  private readonly fields = new Map<string, TypedField>();
  private candidate: Candidate | null = null;
  private ownerPair: Candidate | null = null;
  private sequence = 0;
  private readonly paymentForms = new Map<string,{targetId:string;documentId:string}>();
  constructor(private readonly save: (login: BrowserLogin) => Promise<void>, private readonly redact: (value: string, scope?: string, sensitive?: boolean) => void, private readonly rejected: (password: string) => boolean = () => false) {}
  /** Privacy only: detached/shadow-frame input must never gain credential authority. */
  protectPan(page: LoginPage | null, value: string, form?: string): boolean {
    if (!isPanLike(value)) return false;
    this.redact(value,undefined,true);
    if (page && this.validPage(page)) this.blockPayment(page,form);
    else { this.dropCandidate(); this.dropOwnerPair(); }
    return true;
  }
  edit(page: LoginPage, field: LoginField, edit: LoginEdit, allowed = true) {
    if (allowed && edit.type === "insert") this.protectPan(page,edit.text,field.form);
    if (!this.validPage(page) || !page.fields.some(entry => entry.id === field.id) || field.kind === "submit") return;
    const secret = field.kind === "password" || field.kind === "sensitive";
    this.dropOwnerPair();
    if (!allowed || edit.type === "unknown") this.dropCandidate();
    const key = `${page.targetId}:${page.documentId}:${field.id}`;
    let entry = this.fields.get(key);
    if (!entry && edit.type === "unknown") return;
    if (entry && (entry.field.form !== field.form || entry.field.kind !== field.kind || entry.page.origin !== page.origin)) {
      const redactionOnly = entry.redactionOnly, pan = entry.pan;
      entry.value = entry.privacyValue = ""; this.fields.delete(key);
      entry = {page,field,value:"",privacyValue:"",known:field.length === 0,sequence:0,redactionOnly,pan};
    }
    if (!entry) entry = {page,field,value:"",privacyValue:"",known:field.length === 0,sequence:0,redactionOnly:field.kind !== "username" && field.kind !== "password",pan:false};
    entry.redactionOnly ||= !allowed || field.kind !== "username" && field.kind !== "password";
    if (entry.pan) this.blockPayment(page,field.form);
    if (!allowed || edit.type === "unknown" || field.start === null || field.end === null || field.start < 0 || field.end < field.start || field.end > field.length) {
      if (edit.type === "insert" && secret) this.redact(edit.text,undefined,field.kind === "sensitive");
      entry.value = ""; entry.known = false; this.dropCandidate();
    } else {
      const replacesAll = field.start === 0 && field.end === field.length;
      if (entry.known && entry.value.length !== field.length) entry.known = false;
      if (edit.type === "insert" && (entry.known || replacesAll)) {
        const base = entry.known ? entry.value : "";
        entry.value = replacesAll ? edit.text : base.slice(0,field.start) + edit.text + base.slice(field.end);
        entry.known = entry.value.length <= 65536;
      } else if (entry.known && (edit.type === "backspace" || edit.type === "delete")) {
        let start = field.start, end = field.end;
        if (start === end) for (const segment of graphemes.segment(entry.value)) {
          if (edit.type === "backspace" && segment.index < field.start) start = segment.index;
          else if (edit.type === "delete" && segment.index <= field.end) end = segment.index + segment.segment.length;
          else break;
        }
        entry.value = entry.value.slice(0,start) + entry.value.slice(end);
      } else { entry.value = ""; entry.known = false; this.dropCandidate(); }
      if (entry.known && invalidUtf16.test(entry.value)) { entry.value = ""; entry.known = false; this.dropCandidate(); }
    }
    // This separate trail is privacy-only: input masks may alter DOM length, never credential ownership.
    if (entry.known) entry.privacyValue = entry.value;
    else if (edit.type === "insert") {
      const append = field.start === field.end && field.end === field.length;
      entry.privacyValue = append && entry.privacyValue.length + edit.text.length <= 65536 ? entry.privacyValue + edit.text : edit.text;
    } else entry.privacyValue = "";
    if (isPanLike(entry.privacyValue)) {
      entry.pan = entry.redactionOnly = true;
      this.protectPan(page,entry.privacyValue,field.form);
    }
    const sensitive = field.kind === "sensitive" || entry.pan || field.kind !== "username" && isNumericCode(entry.privacyValue);
    if (field.kind === "password" && isNumericCode(entry.privacyValue) && this.candidate?.field === field.id && this.candidate.targetId === page.targetId && this.candidate.documentId === page.documentId) this.dropCandidate();
    if (entry.privacyValue && (secret || entry.pan || sensitive)) this.redact(entry.privacyValue,entry.pan ? undefined : key,sensitive);
    if (edit.type === "insert" && !entry.known && secret) this.redact(edit.text,undefined,field.kind === "sensitive");
    entry.field = field; entry.page = page; entry.sequence = ++this.sequence;
    this.fields.set(key,entry);
    this.ownerPair = this.pair(page,field.form);
  }
  submit(page: LoginPage, form: string) {
    if (!this.validPage(page)) return;
    // A submitted card/code remains private across runtime replacement, but never becomes a login.
    for (const entry of this.fields.values()) {
      const current = page.fields.find(field => field.id === entry.field.id);
      const value = entry.known ? entry.value : entry.privacyValue;
      if (value && (entry.field.kind === "sensitive" || entry.pan || entry.field.kind !== "username" && isNumericCode(value)) && entry.page.targetId === page.targetId && entry.page.documentId === page.documentId && entry.page.origin === page.origin && entry.field.form === form && current?.kind === entry.field.kind && current.form === form) this.redact(value,undefined,true);
    }
    this.dropCandidate();
    this.candidate = this.pair(page, form);
    if (this.candidate) this.redact(this.candidate.password);
  }
  async observe(page: LoginPage | null, finished = false) {
    if (page && !this.validPage(page)) return;
    if (finished && !this.candidate && this.ownerPair && (!page || page.targetId === this.ownerPair.targetId)) this.candidate = { ...this.ownerPair };
    if (finished && !this.candidate) {
      const latest = [...this.fields.values()].filter(entry => entry.known && entry.field.kind === "password" && (!page || entry.page.targetId === page.targetId && entry.page.documentId === page.documentId && entry.page.origin === page.origin)).sort((a,b) => b.sequence - a.sequence)[0];
      if (latest) this.candidate = this.pair(latest.page, latest.field.form);
    }
    const candidate = this.candidate;
    const completed = candidate && page && page.targetId === candidate.targetId && (page.documentId !== candidate.documentId || page.url !== candidate.url || !page.fields.some(field => field.id === candidate.field && field.kind === "password" && field.length > 0));
    if (candidate && (finished || completed)) {
      this.redact(candidate.password);
      this.candidate = null;
      try { if (!isPanLike(candidate.username) && !isPanLike(candidate.password) && !isNumericCode(candidate.password) && !this.rejected(candidate.password)) await this.save({origin:candidate.origin,username:candidate.username,password:candidate.password}); }
      finally { candidate.password = ""; candidate.username = ""; this.clear(); }
      return;
    }
    if (page) for (const [key,entry] of this.fields) {
      if (entry.page.targetId !== page.targetId) continue;
      if (entry.page.documentId !== page.documentId) { entry.value = entry.privacyValue = ""; this.fields.delete(key); continue; }
      const current = page.fields.find(field => field.id === entry.field.id);
      if (!current || current.form !== entry.field.form || current.kind !== entry.field.kind || current.length !== entry.value.length) { entry.value = ""; entry.known = false; this.dropCandidate(); if (!current || current.form !== entry.field.form || current.kind !== entry.field.kind) entry.privacyValue = ""; if (current) this.dropOwnerPair(); }
      else { entry.page = page; entry.field = current; }
    }
    if (page) {
      for (const [key,scope] of this.paymentForms) if (scope.targetId === page.targetId && scope.documentId !== page.documentId) this.paymentForms.delete(key);
      const latest = [...this.fields.values()].filter(entry => entry.field.kind === "password" && entry.page.targetId === page.targetId && entry.page.documentId === page.documentId).sort((a,b) => b.sequence - a.sequence)[0];
      const pair = latest?.known && this.pair(page,latest.field.form);
      if (pair) { this.dropOwnerPair(); this.ownerPair = pair; }
    }
  }
  private pair(page: LoginPage, form: string): Candidate | null {
    if (this.paymentForms.has(this.formKey(page)) || this.paymentForms.has(this.formKey(page,form))) return null;
    const same = [...this.fields.values()].filter(entry => {
      const current = page.fields.find(field => field.id === entry.field.id);
      return entry.known && entry.value && entry.page.targetId === page.targetId && entry.page.documentId === page.documentId && entry.page.origin === page.origin && entry.field.form === form && current?.form === form && current.kind === entry.field.kind && current.length === entry.value.length;
    });
    const password = same.filter(entry => entry.field.kind === "password" && !entry.redactionOnly && !isPanLike(entry.value) && !isNumericCode(entry.value)).sort((a,b) => b.sequence - a.sequence)[0];
    const username = same.filter(entry => entry.field.kind === "username" && !entry.redactionOnly && !isPanLike(entry.value)).sort((a,b) => b.field.score - a.field.score || b.sequence - a.sequence)[0];
    if (!password || !username || this.rejected(password.value)) return null;
    return {origin:page.origin,url:page.url,targetId:page.targetId,documentId:page.documentId,field:password.field.id,formKey:this.formKey(page,form),username:username.value,password:password.value};
  }
  private formKey(page: LoginPage, form?: string) { return JSON.stringify([page.targetId,page.documentId,page.origin,form ?? null]); }
  private blockPayment(page: LoginPage, form?: string) {
    const key = this.formKey(page,form);
    if (!this.paymentForms.has(key)) this.paymentForms.set(key,{targetId:page.targetId,documentId:page.documentId});
    if (this.candidate && (this.candidate.formKey === key || form === undefined && this.candidate.targetId === page.targetId && this.candidate.documentId === page.documentId)) this.dropCandidate();
    if (this.ownerPair && (this.ownerPair.formKey === key || form === undefined && this.ownerPair.targetId === page.targetId && this.ownerPair.documentId === page.documentId)) this.dropOwnerPair();
  }
  private validPage(page: LoginPage) {
    if (!page || typeof page !== "object" || Object.keys(page).some(key => !["targetId", "documentId", "url", "origin", "fields", "focused", "clicked"].includes(key)) || typeof page.targetId !== "string" || typeof page.documentId !== "string" || typeof page.url !== "string" || typeof page.origin !== "string" || !Array.isArray(page.fields)) return false;
    try { const url = new URL(page.url); return url.protocol === "https:" && url.origin === page.origin && !url.username && !url.password; } catch { return false; }
  }
  private dropCandidate() { if (this.candidate) { this.candidate.password = ""; this.candidate.username = ""; } this.candidate = null; }
  private dropOwnerPair() { if (this.ownerPair) { this.ownerPair.password = ""; this.ownerPair.username = ""; } this.ownerPair = null; }
  forgetTarget(targetId: string) {
    if (this.candidate?.targetId === targetId) this.dropCandidate();
    if (this.ownerPair?.targetId === targetId) this.dropOwnerPair();
    for (const [key,scope] of this.paymentForms) if (scope.targetId === targetId) this.paymentForms.delete(key);
    for (const [key,entry] of this.fields) if (entry.page.targetId === targetId) { entry.value = entry.privacyValue = ""; this.fields.delete(key); }
  }
  clear() { this.dropCandidate(); this.dropOwnerPair(); for (const entry of this.fields.values()) entry.value = entry.privacyValue = ""; this.fields.clear(); this.paymentForms.clear(); }
}

