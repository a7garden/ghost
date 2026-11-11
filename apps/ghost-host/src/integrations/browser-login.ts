import { randomBytes } from "node:crypto";
import { CommandError } from "../core/errors.ts";
import { BrowserCdp, type CdpEvent } from "./browser-cdp.ts";
import { chromeLoginScript } from "./login-capture-chrome-script.ts";
import type { LoginCapture, LoginField, LoginPage, LoginEdit } from "./login-capture.ts";

interface Metadata { fields: LoginField[]; focused: string | null; clicked: string | null; documentId?: string; url?: string; origin?: string }
function metadata(value: unknown): Metadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.fields) || data.fields.length > 512) return null;
  const fields: LoginField[] = [];
  for (const item of data.fields) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const field = item as Record<string, unknown>;
    if (Object.keys(field).some(key => !["id","form","kind","length","start","end","score"].includes(key)) || typeof field.id !== "string" || field.id.length > 256 || typeof field.form !== "string" || field.form.length > 256 || !["username","password","sensitive","submit","other"].includes(String(field.kind)) || !Number.isSafeInteger(field.length) || Number(field.length) < 0 || Number(field.length) > 65536 || ![field.start,field.end].every(v => v === null || Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= Number(field.length)) || typeof field.score !== "number" || !Number.isFinite(field.score) || field.score < 0 || field.score > 200) return null;
    fields.push(field as unknown as LoginField);
  }
  return { fields, focused: typeof data.focused === "string" ? data.focused : null, clicked: typeof data.clicked === "string" ? data.clicked : null, ...(typeof data.documentId === "string" && data.documentId.length <= 128 ? {documentId:data.documentId} : {}), ...(typeof data.url === "string" && data.url.length <= 65536 ? {url:data.url} : {}), ...(typeof data.origin === "string" && data.origin.length <= 2048 ? {origin:data.origin} : {}) };
}
function evaluation(result: Record<string, unknown>): unknown {
  const remote = result.result;
  if (result.exceptionDetails || !remote || typeof remote !== "object" || !("value" in remote)) throw new CommandError("unavailable", "Private browser observation failed");
  return remote.value;
}
interface PageAttachment { targetId: string; sessionId: string; frameId: string; url: string; context?: number; ready: Promise<void> }
export interface LoginObserver {
  snapshot(targetId?: string, point?: { x: number; y: number }): Promise<LoginPage | null>;
  updateMode?(): Promise<void>;
  selectAll?(targetId?: string): Promise<boolean>;
  close(): void;
  ownerKey?(key: string): Promise<void>;
}
interface ChromeOptions {
  isCurrent(): boolean;
  nativeAllowed(): boolean;
  ownerApiActive(): boolean;
  activity(): void;
  secret(page: LoginPage, kind: "password" | "sensitive"): void;
  windowClosed(): void;
}

/** Chrome's real separate V8 world is the only source of native-window input payloads. */
export class ChromeLoginObserver implements LoginObserver {
  private readonly world = `ghost-login-${randomBytes(16).toString("hex")}`;
  private readonly binding = `ghostLogin${randomBytes(16).toString("hex")}`;
  private readonly controller = `ghostController${randomBytes(16).toString("hex")}`;
  private readonly pages = new Map<string, PageAttachment>();
  private readonly keys = new Set<{ key:string; resolve():void; reject(error:Error):void; timer:NodeJS.Timeout }>();
  private closed = false;
  private constructor(private readonly cdp: BrowserCdp, private readonly capture: LoginCapture, private readonly options: ChromeOptions) {
    cdp.onEvent(event => this.event(event));
    cdp.onDisconnect(() => {
      if (this.closed) return;
      this.capture.clear(); this.pages.clear(); this.options.windowClosed();
    });
  }
  static async start(endpoint: string, capture: LoginCapture, options: ChromeOptions) {
    const cdp = await BrowserCdp.connect(endpoint), observer = new ChromeLoginObserver(cdp, capture, options);
    try {
      await cdp.request("Target.setAutoAttach", { autoAttach:true, waitForDebuggerOnStart:true, flatten:true, filter:[{type:"page",exclude:false},{exclude:true}] });
      await cdp.request("Target.getTargets"); // Ordered barrier after auto-attach's existing-target events.
      await Promise.all([...observer.pages.values()].map(page => page.ready));
      if (!observer.pages.size) throw new CommandError("unavailable", "Private browser page is unavailable");
      return observer;
    } catch (error) { observer.close(); throw error; }
  }
  private event(event: CdpEvent) {
    if (this.closed) return;
    if (event.method === "Target.attachedToTarget") {
      const info = event.params.targetInfo;
      if (!info || typeof info !== "object" || !("type" in info) || info.type !== "page" || !("targetId" in info) || typeof info.targetId !== "string" || typeof event.params.sessionId !== "string") return;
      const page: PageAttachment = { targetId:info.targetId, sessionId:event.params.sessionId, frameId:"", url:"about:blank", ready:Promise.resolve() };
      this.pages.set(page.sessionId, page);
      page.ready = this.setup(page);
      void page.ready.catch(() => { this.capture.clear(); });
      return;
    }
    if (event.method === "Target.detachedFromTarget" && typeof event.params.sessionId === "string") {
      const removed = this.pages.get(event.params.sessionId);
      this.pages.delete(event.params.sessionId);
      if (removed) this.capture.forgetTarget(removed.targetId);
      if (removed && !this.pages.size) this.options.windowClosed();
      return;
    }
    const page = event.sessionId ? this.pages.get(event.sessionId) : undefined;
    if (!page) return;
    if (event.method === "Runtime.executionContextsCleared") page.context = undefined;
    if (event.method === "Runtime.executionContextCreated") {
      const context = event.params.context;
      if (context && typeof context === "object" && "name" in context && context.name === this.world && "id" in context && typeof context.id === "number" && "auxData" in context && context.auxData && typeof context.auxData === "object" && "frameId" in context.auxData && context.auxData.frameId === page.frameId) {
        page.context = context.id;
        void this.setMode(page).catch(() => this.capture.clear());
      }
    }
    if (event.method === "Page.frameNavigated") {
      const frame = event.params.frame;
      if (frame && typeof frame === "object" && !("parentId" in frame) && "id" in frame && typeof frame.id === "string" && "url" in frame && typeof frame.url === "string") { page.frameId = frame.id; page.url = frame.url; }
    }
    if (event.method === "Page.navigatedWithinDocument" && event.params.frameId === page.frameId && typeof event.params.url === "string") page.url = event.params.url;
    if (event.method !== "Runtime.bindingCalled" || event.params.name !== this.binding || event.params.executionContextId !== page.context || typeof event.params.payload !== "string" || event.params.payload.length > 256 * 1024) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(event.params.payload); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.ownerApi === true && message.type === "activity" && typeof message.key === "string") {
      for (const pending of this.keys) if (pending.key === message.key) { this.keys.delete(pending); clearTimeout(pending.timer); pending.resolve(); }
    }
    const meta = metadata(message.meta), observed = meta ? this.page(page,meta) : null;
    if (!observed || message.ownerApi === true || !this.options.isCurrent()) return; // API edits are recorded once, from Host-accepted bytes.
    // The isolated flag is stamped before event delivery. Mode changes are acknowledged before model I/O.
    const allowed = message.allowed === true;
    if (message.type === "privacy" && typeof message.text === "string" && message.text.length <= 65536 && !message.text.includes("\0")) {
      const descriptor = metadata({fields:[message.field],focused:null,clicked:null})?.fields[0];
      if (this.capture.protectPan(observed,message.text,descriptor?.form) && allowed) this.options.activity();
      return;
    }
    if (allowed && (message.type === "activity" || message.type === "submit")) this.options.activity();
    if (message.type === "submit" && allowed && typeof message.form === "string") this.capture.submit(observed,message.form);
    if (message.type !== "edit") return;
    const descriptor = metadata({ fields:[message.field], focused:null, clicked:null })?.fields[0];
    const edit = message.edit;
    if (!descriptor || !edit || typeof edit !== "object" || !("type" in edit)) return;
    let operation: LoginEdit = {type:"unknown"};
    if (edit.type === "insert" && "text" in edit && typeof edit.text === "string" && edit.text.length <= 65536 && !edit.text.includes("\0")) operation = {type:"insert",text:edit.text};
    else if (edit.type === "backspace" || edit.type === "delete") operation = {type:edit.type};
    if (allowed && operation.type !== "unknown") this.options.activity();
    this.capture.edit(observed,descriptor,operation,allowed);
    if (descriptor.kind === "sensitive" || descriptor.kind === "password" && operation.type !== "unknown") this.options.secret(observed,descriptor.kind);
  }
  private async setup(page: PageAttachment) {
    try {
      await this.cdp.request("Page.enable",{},page.sessionId);
      const tree = await this.cdp.request("Page.getFrameTree",{},page.sessionId);
      const frameTree = tree.frameTree;
      if (!frameTree || typeof frameTree !== "object" || !("frame" in frameTree) || !frameTree.frame || typeof frameTree.frame !== "object" || !("id" in frameTree.frame) || typeof frameTree.frame.id !== "string" || !("url" in frameTree.frame) || typeof frameTree.frame.url !== "string") throw new CommandError("unavailable","Private browser frame is unavailable");
      page.frameId = frameTree.frame.id; page.url = frameTree.frame.url;
      await this.cdp.request("Runtime.enable",{},page.sessionId);
      await this.cdp.request("Runtime.addBinding",{name:this.binding,executionContextName:this.world},page.sessionId);
      const source = chromeLoginScript(this.controller,this.binding);
      await this.cdp.request("Page.addScriptToEvaluateOnNewDocument",{source,worldName:this.world},page.sessionId);
      const world = await this.cdp.request("Page.createIsolatedWorld",{frameId:page.frameId,worldName:this.world},page.sessionId);
      if (typeof world.executionContextId !== "number") throw new CommandError("unavailable","Private browser world is unavailable");
      page.context = world.executionContextId;
      await this.cdp.request("Runtime.evaluate",{expression:source,contextId:page.context,returnByValue:true},page.sessionId);
      await this.setMode(page);
    } finally { await this.cdp.request("Runtime.runIfWaitingForDebugger",{},page.sessionId); }
  }
  private page(page: PageAttachment, meta: Metadata): LoginPage | null {
    if (page.context === undefined || !meta.documentId || !meta.url || !meta.origin) return null;
    let url: URL;
    try { url = new URL(meta.url); if (url.origin !== meta.origin || url.origin !== new URL(page.url).origin) return null; } catch { return null; }
    return {targetId:page.targetId,documentId:meta.documentId,url:url.href,origin:url.origin,fields:meta.fields,focused:meta.focused,clicked:meta.clicked};
  }
  private async active(targetId?: string) {
    for (const page of this.pages.values()) {
      if (targetId && page.targetId !== targetId) continue;
      await page.ready;
      if (page.context === undefined) continue;
      if (targetId) return page;
      const result = await this.cdp.request("Runtime.evaluate",{expression:'document.visibilityState === "visible"',contextId:page.context,returnByValue:true},page.sessionId);
      if (evaluation(result) === true) return page;
    }
    return null;
  }
  private async setMode(page: PageAttachment) {
    if (page.context === undefined || this.closed) return;
    await this.cdp.request("Runtime.evaluate",{expression:`globalThis[${JSON.stringify(this.controller)}]?.native(${this.options.nativeAllowed()},${this.options.ownerApiActive()})`,contextId:page.context,returnByValue:true},page.sessionId);
  }
  async updateMode() { await Promise.all([...this.pages.values()].map(page => this.setMode(page))); }
  async snapshot(targetId?: string, point?: {x:number;y:number}): Promise<LoginPage | null> {
    const page = await this.active(targetId);
    if (!page) return null;
    const result = await this.cdp.request("Runtime.evaluate",{expression:`globalThis[${JSON.stringify(this.controller)}]?.metadata(${point ? JSON.stringify(point) : "null"})`,contextId:page.context,returnByValue:true},page.sessionId);
    const meta = metadata(evaluation(result));
    return meta ? this.page(page,meta) : null;
  }
  async selectAll(targetId?: string) {
    const page = await this.active(targetId); if (!page) return false;
    return evaluation(await this.cdp.request("Runtime.evaluate",{expression:`globalThis[${JSON.stringify(this.controller)}]?.selectAll()`,contextId:page.context,returnByValue:true},page.sessionId)) === true;
  }
  ownerKey(key: string) {
    const result = Promise.withResolvers<void>();
    const pending = { key, resolve:result.resolve, reject:result.reject, timer:setTimeout(() => { this.keys.delete(pending); result.reject(new CommandError("unavailable","Browser key input was not observed")); },5000) };
    this.keys.add(pending);
    void result.promise.catch(() => {});
    return result.promise;
  }
  close() {
    this.closed = true;
    for (const pending of this.keys) { clearTimeout(pending.timer); pending.reject(new CommandError("unavailable","Private browser connection ended")); }
    this.keys.clear(); this.cdp.close(); this.pages.clear();
  }
}

