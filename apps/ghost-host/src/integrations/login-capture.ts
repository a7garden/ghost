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
interface TypedField { page: LoginPage; field: LoginField; value: string; known: boolean; sequence: number }
interface Candidate extends BrowserLogin { targetId: string; documentId: string; url: string; field: string }
const graphemes = new Intl.Segmenter(undefined,{granularity:"grapheme"});
const invalidUtf16 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Only owner input supplies credential bytes. Page observations can establish completion, never values. */
export class LoginCapture {
  private readonly fields = new Map<string, TypedField>();
  private candidate: Candidate | null = null;
  private ownerPair: Candidate | null = null;
  private sequence = 0;
  constructor(private readonly save: (login: BrowserLogin) => Promise<void>, private readonly redact: (value: string, scope?: string, sensitive?: boolean) => void, private readonly rejected: (password: string) => boolean = () => false) {}
  edit(page: LoginPage, field: LoginField, edit: LoginEdit, allowed = true) {
    if (!this.validPage(page) || !page.fields.some(entry => entry.id === field.id) || !["username", "password", "sensitive"].includes(field.kind)) return;
    const secret = field.kind === "password" || field.kind === "sensitive";
    this.dropOwnerPair();
    if (!allowed || edit.type === "unknown") this.dropCandidate();
    const key = `${page.targetId}:${page.documentId}:${field.id}`;
    let entry = this.fields.get(key);
    if (!entry && (!allowed || edit.type === "unknown")) { if (edit.type === "insert" && secret) this.redact(edit.text,undefined,field.kind === "sensitive"); return; }
    if (entry && (entry.field.form !== field.form || entry.field.kind !== field.kind || entry.page.origin !== page.origin)) { entry.value = ""; this.fields.delete(key); entry = undefined; }
    if (!entry) entry = { page, field, value: "", known: field.length === 0, sequence: 0 };
    if (!allowed || edit.type === "unknown" || field.start === null || field.end === null || field.start < 0 || field.end < field.start || field.end > field.length) {
      if (edit.type === "insert" && secret) this.redact(edit.text,undefined,field.kind === "sensitive");
      entry.value = ""; entry.known = false; this.dropCandidate();
    } else {
      const replacesAll = field.start === 0 && field.end === field.length;
      if (entry.known && entry.value.length !== field.length) entry.known = false;
      if (edit.type === "insert" && (entry.known || replacesAll)) {
        const base = entry.known ? entry.value : "";
        entry.value = replacesAll ? edit.text : base.slice(0, field.start) + edit.text + base.slice(field.end);
        entry.known = entry.value.length <= 65536;
      } else if (entry.known && (edit.type === "backspace" || edit.type === "delete")) {
        let start = field.start, end = field.end;
        if (start === end) for (const segment of graphemes.segment(entry.value)) {
          if (edit.type === "backspace" && segment.index < field.start) start = segment.index;
          else if (edit.type === "delete" && segment.index <= field.end) end = segment.index + segment.segment.length;
          else break;
        }
        entry.value = entry.value.slice(0, start) + entry.value.slice(end);
      } else { entry.value = ""; entry.known = false; this.dropCandidate(); }
      if (entry.known && invalidUtf16.test(entry.value)) { entry.value = ""; entry.known = false; this.dropCandidate(); }
      if (entry.known && entry.value && secret) this.redact(entry.value,key,field.kind === "sensitive");
      if (edit.type === "insert" && !entry.known && secret) this.redact(edit.text,undefined,field.kind === "sensitive");
    }
    entry.field = field; entry.page = page; entry.sequence = ++this.sequence;
    this.fields.set(key, entry);
    this.ownerPair = this.pair(page, field.form);
  }
  submit(page: LoginPage, form: string) {
    if (!this.validPage(page)) return;
    // A submitted card/code remains private across runtime replacement, but never becomes a login.
    for (const entry of this.fields.values()) {
      const current = page.fields.find(field => field.id === entry.field.id);
      if (entry.known && entry.value && entry.field.kind === "sensitive" && entry.page.targetId === page.targetId && entry.page.documentId === page.documentId && entry.page.origin === page.origin && entry.field.form === form && current?.kind === "sensitive" && current.form === form && current.length === entry.value.length) this.redact(entry.value,undefined,true);
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
      try { if (!this.rejected(candidate.password)) await this.save({ origin: candidate.origin, username: candidate.username, password: candidate.password }); }
      finally { candidate.password = ""; candidate.username = ""; this.clear(); }
      return;
    }
    if (page) for (const [key,entry] of this.fields) {
      if (entry.page.targetId !== page.targetId) continue;
      if (entry.page.documentId !== page.documentId) { entry.value = ""; this.fields.delete(key); continue; }
      const current = page.fields.find(field => field.id === entry.field.id);
      if (!current || current.form !== entry.field.form || current.kind !== entry.field.kind || current.length !== entry.value.length) { entry.value = ""; entry.known = false; this.dropCandidate(); if (current) this.dropOwnerPair(); }
      else { entry.page = page; entry.field = current; }
    }
    if (page) {
      const latest = [...this.fields.values()].filter(entry => entry.field.kind === "password" && entry.page.targetId === page.targetId && entry.page.documentId === page.documentId).sort((a,b) => b.sequence - a.sequence)[0];
      const pair = latest?.known && this.pair(page,latest.field.form);
      if (pair) { this.dropOwnerPair(); this.ownerPair = pair; }
    }
  }
  private pair(page: LoginPage, form: string): Candidate | null {
    const same = [...this.fields.values()].filter(entry => {
      const current = page.fields.find(field => field.id === entry.field.id);
      return entry.known && entry.value && entry.page.targetId === page.targetId && entry.page.documentId === page.documentId && entry.page.origin === page.origin && entry.field.form === form && current?.form === form && current.kind === entry.field.kind && current.length === entry.value.length;
    });
    const password = same.filter(entry => entry.field.kind === "password").sort((a,b) => b.sequence - a.sequence)[0];
    const username = same.filter(entry => entry.field.kind === "username").sort((a,b) => b.field.score - a.field.score || b.sequence - a.sequence)[0];
    if (!password || !username || this.rejected(password.value)) return null;
    return { origin: page.origin, url: page.url, targetId: page.targetId, documentId: page.documentId, field: password.field.id, username: username.value, password: password.value };
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
    for (const [key,entry] of this.fields) if (entry.page.targetId === targetId) { entry.value = ""; this.fields.delete(key); }
  }
  clear() { this.dropCandidate(); this.dropOwnerPair(); for (const entry of this.fields.values()) entry.value = ""; this.fields.clear(); }
}

