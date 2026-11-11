import { randomBytes } from "node:crypto";
import { CommandError } from "../core/errors.ts";
import { BrowserCdp, type CdpEvent, type CdpDisconnect } from "./browser-cdp.ts";
import { chromeLoginScript } from "./login-capture-chrome-script.ts";
import type { LoginCapture, LoginField, LoginPage, LoginEdit } from "./login-capture.ts";

interface Metadata { fields: LoginField[]; focused: string | null; clicked: string | null; documentId?: string; url?: string; origin?: string; privacyFocus?: string }
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
  return { fields, focused: typeof data.focused === "string" ? data.focused : null, clicked: typeof data.clicked === "string" ? data.clicked : null, ...(typeof data.documentId === "string" && data.documentId.length <= 128 ? {documentId:data.documentId} : {}), ...(typeof data.url === "string" && data.url.length <= 65536 ? {url:data.url} : {}), ...(typeof data.origin === "string" && data.origin.length <= 2048 ? {origin:data.origin} : {}), ...(typeof data.privacyFocus === "string" && /^n[0-9]{1,12}$/.test(data.privacyFocus) ? {privacyFocus:data.privacyFocus} : {}) };
}
function evaluation(result: Record<string, unknown>): unknown {
  const remote = result.result;
  if (result.exceptionDetails || !remote || typeof remote !== "object" || !("value" in remote)) throw new CommandError("unavailable", "Private browser observation failed");
  return remote.value;
}
interface PageAttachment {
  targetId: string; sessionId: string; frameId: string; url: string; context?: number; documentId?: string; ready: Promise<void>;
  parent?: PageAttachment;
  frames: Map<string,string>;
  contexts: Map<number,string>;
  initialModes: Map<number,{native:boolean;api:boolean}>;
}
export interface LoginObserver {
  privacyScope?: string;
  readonly ended: boolean;
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
  privacy(page: LoginPage | null, scope: string, edit: LoginEdit | null): void;
  windowClosed(observer: LoginObserver): void;
  ended(observer: LoginObserver, reason: CdpDisconnect): void;
}

/** Chrome's real separate V8 world is the only source of native-window input payloads. */
export class ChromeLoginObserver implements LoginObserver {
  privacyScope?: string;
  private readonly world = `ghost-login-${randomBytes(16).toString("hex")}`;
  private readonly binding = `ghostLogin${randomBytes(16).toString("hex")}`;
  private readonly controller = `ghostController${randomBytes(16).toString("hex")}`;
  private readonly pages = new Map<string, PageAttachment>();
  private readonly keys = new Set<{ key:string; resolve():void; reject(error:Error):void; timer:NodeJS.Timeout }>();
  private closed = false;
  private closedError?: CommandError;
  get ended() { return this.closed; }
  private constructor(private readonly cdp: BrowserCdp, private readonly capture: LoginCapture, private readonly options: ChromeOptions) {
    cdp.onEvent(event => this.event(event));
    cdp.onDisconnect(reason => {
      if (this.closed) return;
      this.closed = true;
      this.closedError = new CommandError("unavailable",`Private Chrome observation ended (${reason.cause}; ${reason.stage}${reason.closeCode === undefined ? "" : `; ${reason.closeCode}`})`);
      for (const pending of this.keys) { clearTimeout(pending.timer); pending.reject(this.closedError); }
      this.keys.clear();
      this.capture.clear(); this.pages.clear(); this.options.ended(this,reason);
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
      if (!info || typeof info !== "object" || !("type" in info) || !["page","iframe"].includes(String(info.type)) || !("targetId" in info) || typeof info.targetId !== "string" || typeof event.params.sessionId !== "string") return;
      const parent = event.sessionId ? this.pages.get(event.sessionId) : undefined;
      if (info.type === "iframe" && !parent) return;
      const page: PageAttachment = { targetId:info.targetId, sessionId:event.params.sessionId, frameId:"", url:"about:blank", ready:Promise.resolve(), frames:new Map(), contexts:new Map(), initialModes:new Map(), ...(parent ? {parent} : {}) };
      this.pages.set(page.sessionId, page);
      page.ready = this.setup(page);
      void page.ready.catch(() => { this.capture.clear(); });
      return;
    }
    if (event.method === "Target.detachedFromTarget" && typeof event.params.sessionId === "string") {
      const removed = this.pages.get(event.params.sessionId);
      this.pages.delete(event.params.sessionId);
      if (removed) this.capture.forgetTarget(removed.targetId);
      if (removed && !removed.parent && ![...this.pages.values()].some(page=>!page.parent)) this.options.windowClosed(this);
      return;
    }
    const page = event.sessionId ? this.pages.get(event.sessionId) : undefined;
    if (!page) return;
    if (event.method === "Runtime.executionContextsCleared") { page.context = undefined; page.documentId = undefined; page.contexts.clear(); page.initialModes.clear(); this.options.privacy(null,"",null); }
    if (event.method === "Runtime.executionContextDestroyed" && typeof event.params.executionContextId === "number") {
      page.contexts.delete(event.params.executionContextId);
      page.initialModes.delete(event.params.executionContextId);
      if (page.context === event.params.executionContextId) page.context = undefined;
    }
    if (event.method === "Runtime.executionContextCreated") {
      const context = event.params.context;
      if (context && typeof context === "object" && "name" in context && context.name === this.world && "id" in context && typeof context.id === "number" && "auxData" in context && context.auxData && typeof context.auxData === "object" && "frameId" in context.auxData && typeof context.auxData.frameId === "string") {
        page.contexts.set(context.id,context.auxData.frameId);
        page.initialModes.set(context.id,{native:this.options.nativeAllowed(),api:this.options.ownerApiActive()});
        if (context.auxData.frameId === page.frameId) page.context = context.id;
        void this.setMode(page).catch(() => this.capture.clear());
      }
    }
    if (event.method === "Page.frameAttached" && typeof event.params.frameId === "string") page.frames.set(event.params.frameId,"about:blank");
    if (event.method === "Page.frameDetached" && typeof event.params.frameId === "string") {
      page.frames.delete(event.params.frameId);
      for (const [context,frame] of page.contexts) if (frame === event.params.frameId) { page.contexts.delete(context); page.initialModes.delete(context); }
      this.options.privacy(null,"",null);
    }
    if (event.method === "Page.frameNavigated") {
      const frame = event.params.frame;
      if (frame && typeof frame === "object" && "id" in frame && typeof frame.id === "string" && "url" in frame && typeof frame.url === "string") {
        page.frames.set(frame.id,frame.url);
        if (!("parentId" in frame)) { page.frameId = frame.id; page.url = frame.url; page.documentId = undefined; }
        this.options.privacy(null,"",null);
      }
    }
    if (event.method === "Page.navigatedWithinDocument" && typeof event.params.frameId === "string" && typeof event.params.url === "string") {
      page.frames.set(event.params.frameId,event.params.url);
      if (event.params.frameId === page.frameId) page.url = event.params.url;
      this.options.privacy(null,"",null);
    }
    const contextId = event.params.executionContextId;
    const frameId = typeof contextId === "number" ? page.contexts.get(contextId) : undefined;
    if (event.method !== "Runtime.bindingCalled" || event.params.name !== this.binding || !frameId || !page.frames.has(frameId) || typeof event.params.payload !== "string" || event.params.payload.length > 256 * 1024) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(event.params.payload); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.ownerApi === true && message.type === "activity" && typeof message.key === "string") {
      for (const pending of this.keys) if (pending.key === message.key) { this.keys.delete(pending); clearTimeout(pending.timer); pending.resolve(); }
    }
    const meta = metadata(message.meta);
    if (!meta || !meta.documentId || !this.options.isCurrent() || message.ownerApi === true) return; // API bytes are recorded once by the Host.
    const root = this.rootPage(page);
    const rootEvent = !page.parent && contextId === page.context;
    const observed = rootEvent ? this.page(page,meta) : root.documentId ? {targetId:root.targetId,documentId:root.documentId,url:root.url,origin:new URL(root.url).origin,fields:[],focused:null,clicked:null} : null;
    // Only this named isolated world, in a currently attached frame, may emit privacy data.
    // Child contexts never reach LoginCapture.edit/submit, even with plausible field metadata.
    const allowed = message.allowed === true;
    if (message.type === "privacy-boundary") {
      if (allowed) this.options.privacy(null,"",null);
      return;
    }
    if (message.type === "privacy-edit") {
      if (!allowed || !observed || typeof message.scope !== "string" || !/^n[0-9]{1,12}$/.test(message.scope)) return;
      const edit = message.edit;
      if (!edit || typeof edit !== "object" || !("type" in edit)) return;
      let operation: LoginEdit = {type:"unknown"};
      if (edit.type === "insert" && "text" in edit && typeof edit.text === "string" && edit.text.length <= 65536 && !edit.text.includes("\0")) operation = {type:"insert",text:edit.text};
      else if (edit.type === "backspace" || edit.type === "delete") operation = {type:edit.type};
      this.options.activity();
      this.options.privacy(observed,JSON.stringify([page.sessionId,frameId,meta.documentId,message.scope]),operation);
      return;
    }
    if (!rootEvent) {
      if (allowed && message.type === "activity") this.options.activity();
      return;
    }
    if (!observed) return;
    // The isolated flag is stamped before event delivery. Mode changes are acknowledged before model I/O.
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
    if (!observed.fields.some(field=>field.id === descriptor.id)) {
      if (allowed) this.options.privacy(observed,JSON.stringify([page.sessionId,frameId,meta.documentId,descriptor.id]),operation);
      return;
    }
    this.capture.edit(observed,descriptor,operation,allowed);
    if (descriptor.kind === "sensitive" || descriptor.kind === "password" && operation.type !== "unknown") this.options.secret(observed,descriptor.kind);
  }
  private async setup(page: PageAttachment) {
    let stage = "Page.enable";
    let resumeSent = false;
    try {
      await this.cdp.request("Page.enable",{},page.sessionId);
      stage = "Page.getFrameTree";
      const tree = await this.cdp.request("Page.getFrameTree",{},page.sessionId);
      const frameTree = tree.frameTree;
      const frames: string[] = [];
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object" || !("frame" in value) || !value.frame || typeof value.frame !== "object" || !("id" in value.frame) || typeof value.frame.id !== "string" || !("url" in value.frame) || typeof value.frame.url !== "string") throw new CommandError("unavailable","Private browser frame is unavailable");
        if (!page.frameId) { page.frameId = value.frame.id; page.url = value.frame.url; }
        page.frames.set(value.frame.id,value.frame.url); frames.push(value.frame.id);
        if ("childFrames" in value && Array.isArray(value.childFrames)) value.childFrames.forEach(visit);
      };
      visit(frameTree);
      stage = "Runtime.enable";
      await this.cdp.request("Runtime.enable",{},page.sessionId);
      stage = "Runtime.addBinding";
      await this.cdp.request("Runtime.addBinding",{name:this.binding,executionContextName:this.world},page.sessionId);
      const source = chromeLoginScript(this.controller,this.binding);
      stage = "Page.addScriptToEvaluateOnNewDocument";
      await this.cdp.request("Page.addScriptToEvaluateOnNewDocument",{source,worldName:this.world},page.sessionId);
      // Register child preloads and descendant interception while paused. Chrome
      // cannot complete createIsolatedWorld for this OOPIF until it is resumed.
      stage = "Target.setAutoAttach";
      await this.cdp.request("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:"iframe",exclude:false},{exclude:true}]},page.sessionId);
      stage = "Runtime.runIfWaitingForDebugger";
      resumeSent = true;
      await this.cdp.request("Runtime.runIfWaitingForDebugger",{},page.sessionId);
      for (const frameId of frames) {
        stage = "Page.createIsolatedWorld";
        const world = await this.cdp.request("Page.createIsolatedWorld",{frameId,worldName:this.world},page.sessionId);
        if (typeof world.executionContextId !== "number") throw new CommandError("unavailable","Private browser world is unavailable");
        page.contexts.set(world.executionContextId,frameId);
        if (!page.initialModes.has(world.executionContextId)) page.initialModes.set(world.executionContextId,{native:this.options.nativeAllowed(),api:this.options.ownerApiActive()});
        if (frameId === page.frameId) page.context = world.executionContextId;
        stage = "Runtime.evaluate (install)";
        await this.cdp.request("Runtime.evaluate",{expression:source,contextId:world.executionContextId,returnByValue:true},page.sessionId);
      }
      stage = "Runtime.evaluate (mode)";
      await this.setMode(page,true);
    } catch {
      throw new CommandError("unavailable",`Private Chrome ${page.parent ? "child-frame" : "page"} capture setup failed (${stage})`);
    } finally { if (!resumeSent) await this.cdp.request("Runtime.runIfWaitingForDebugger",{},page.sessionId); }
  }
  private rootPage(page: PageAttachment) {
    while (page.parent) page = page.parent;
    return page;
  }
  private page(page: PageAttachment, meta: Metadata): LoginPage | null {
    if (page.context === undefined || !meta.documentId || !meta.url || !meta.origin) return null;
    let url: URL;
    try { url = new URL(meta.url); if (url.origin !== meta.origin || url.origin !== new URL(page.url).origin) return null; } catch { return null; }
    page.documentId = meta.documentId;
    return {targetId:page.targetId,documentId:meta.documentId,url:url.href,origin:url.origin,fields:meta.fields,focused:meta.focused,clicked:meta.clicked};
  }
  private async active(targetId?: string) {
    if (this.closed) throw this.closedError ?? new CommandError("unavailable","Private Chrome observation ended");
    for (const page of this.pages.values()) {
      if (page.parent) continue;
      if (targetId && page.targetId !== targetId) continue;
      await page.ready;
      if (page.context === undefined) continue;
      if (targetId) return page;
      const result = await this.cdp.request("Runtime.evaluate",{expression:'document.visibilityState === "visible"',contextId:page.context,returnByValue:true},page.sessionId);
      if (evaluation(result) === true) return page;
    }
    return null;
  }
  private async setMode(page: PageAttachment, required = false) {
    if (this.closed) {
      if (required) throw this.closedError ?? new CommandError("unavailable","Private Chrome observation ended");
      return;
    }
    await Promise.all([...page.contexts].filter(([,frame])=>page.frames.has(frame)).map(async ([contextId,frame]) => {
      const initial = page.initialModes.get(contextId);
      const native = this.options.nativeAllowed(), api = this.options.ownerApiActive();
      const result = await this.cdp.request("Runtime.evaluate",{expression:`(() => { const c = globalThis[${JSON.stringify(this.controller)}]; if (!c) return null; return c.native(${native},${api},${initial?.native === true},${initial?.api === true}); })()`,contextId,returnByValue:true},page.sessionId);
      if (this.closed) {
        if (required) throw this.closedError ?? new CommandError("unavailable","Private Chrome observation ended");
        return;
      }
      if (this.pages.get(page.sessionId) !== page || page.contexts.get(contextId) !== frame || !page.frames.has(frame)) return;
      let value: unknown;
      try { value = evaluation(result); }
      catch (error) {
        // A failed current controller is a lost observation capability, not a
        // healthy channel to keep reusing. Recovery belongs to the next action.
        if (required) this.cdp.close("controller-ack");
        throw error;
      }
      // A context-created probe can precede its preload. It grants no readiness;
      // setup/updateMode must later acknowledge every still-current controller.
      if (!required && value === null) return;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4
        || !("version" in value) || value.version !== 1
        || !("documentId" in value) || typeof value.documentId !== "string" || !value.documentId || value.documentId.length > 128
        || !("allowed" in value) || value.allowed !== native || !("ownerApi" in value) || value.ownerApi !== api) {
        if (required) this.cdp.close("controller-ack");
        throw new CommandError("unavailable","Private Chrome input controller did not acknowledge its mode");
      }
      // The authenticated controller stamps document identity; URL/origin checks
      // stay in snapshot/page observation and never gate about:blank bootstrap.
      if (!page.parent && contextId === page.context) page.documentId = value.documentId;
    }));
  }
  async updateMode() {
    if (this.closed) throw this.closedError ?? new CommandError("unavailable","Private Chrome observation ended");
    // A child listener is part of the privacy boundary, not optional background
    // work. Surface a failed/paused attachment before any model or owner I/O.
    await Promise.all([...this.pages.values()].map(async page => { await page.ready; await this.setMode(page,true); }));
  }
  async snapshot(targetId?: string, point?: {x:number;y:number}): Promise<LoginPage | null> {
    const page = await this.active(targetId);
    if (!page) return null;
    const result = await this.cdp.request("Runtime.evaluate",{expression:`globalThis[${JSON.stringify(this.controller)}]?.metadata(${point ? JSON.stringify(point) : "null"})`,contextId:page.context,returnByValue:true},page.sessionId);
    const meta = metadata(evaluation(result));
    this.privacyScope = meta?.privacyFocus;
    return meta ? this.page(page,meta) : null;
  }
  async selectAll(targetId?: string) {
    const page = await this.active(targetId); if (!page) return false;
    if (evaluation(await this.cdp.request("Runtime.evaluate",{expression:`globalThis[${JSON.stringify(this.controller)}]?.selectAll()`,contextId:page.context,returnByValue:true},page.sessionId)) === true) return true;
    // Chrome routes editing commands to its actual focused frame/shadow editor.
    // Do not read a child/closed-shadow value to emulate the selection in Host.
    await this.cdp.request("Input.dispatchKeyEvent",{type:"keyDown",key:"a",code:"KeyA",modifiers:4,commands:["selectAll"]},page.sessionId);
    await this.cdp.request("Input.dispatchKeyEvent",{type:"keyUp",key:"a",code:"KeyA",modifiers:4},page.sessionId);
    return true;
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

