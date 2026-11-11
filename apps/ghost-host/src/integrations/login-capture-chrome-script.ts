/** Chrome isolated-world capture; new documents use a preload. No DOM value is exported. */
export function chromeLoginScript(controller: string, binding: string) {
  return `(() => { "use strict";
    if (globalThis[${JSON.stringify(controller)}]) return;
    const privacyOnly = window.top !== window;
    const send = globalThis[${JSON.stringify(binding)}];
    const ids = new WeakMap(), selections = new WeakMap(); let serial = 0, nativeAllowed = false, ownerApi = false;
    let modeKnown = false, deferredBytes = 0, deferredOverflow = false, deferredScope = null;
    const deferredPrivacy = [];
    const documentToken = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
    let key = null, paste = null, pending = null, composition = null;
    const id = e => { if (!e) return "document"; let value = ids.get(e); if (!value) { value = "n" + ++serial; ids.set(e,value); } return value; };
    const field = e => {
      if (privacyOnly) return null;
      const input = e instanceof HTMLInputElement, textarea = typeof HTMLTextAreaElement !== "undefined" && e instanceof HTMLTextAreaElement;
      if (!(input || textarea || e instanceof HTMLButtonElement)) return null;
      const type = e.type, editable = input || textarea;
      const autocomplete = (e.getAttribute("autocomplete") || "").trim().toLowerCase().split(/\\s+/);
      const labels = [...(e.labels || [])].slice(0,8).map(label => (label.textContent || "").slice(0,256));
      const referenced = (e.getAttribute("aria-labelledby") || "").trim().split(/\\s+/).slice(0,8).map(name => (document.getElementById?.(name)?.textContent || "").slice(0,256));
      const hints = [e.name,e.id,e.getAttribute("aria-label"),...labels,...referenced].map(value => (value || "").slice(0,256)).join(" ").replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().replace(/[_-]+/g," ");
      const sensitive = autocomplete.some(token => token.startsWith("cc-") || token === "one-time-code" || token === "new-password") || /\\b(?:pan|cc ?(?:num(?:ber)?|no|csc|cvv|cvc|exp(?:iry|iration)?|name)|(?:credit|debit) card|card ?(?:num(?:ber)?|no|security code|verification (?:code|value)|cvc|cvv|csc|expiry|expiration|exp)|card ?holder(?: name)?|name on card|cvv2?|cvc2?|csc|otp|one time (?:code|password|passcode)|verification code|security code|sms code|auth(?:entication)? code|pin)\\b|카드\\s*(?:번호|유효|만료|보안)|인증\\s*(?:번호|코드)|일회용\\s*(?:비밀번호|코드)/.test(hints);
      const selection = selections.get(e), length = editable ? e.value.length : 0;
      return { id:id(e), form:id(e.form), kind:e.disabled || e.readOnly ? "other" : editable && sensitive ? "sensitive" : input && type === "password" ? "password" : type === "submit" ? "submit" : input && ["text","email","tel"].includes(type) ? "username" : "other",
        length, start:editable ? Number.isInteger(e.selectionStart) ? e.selectionStart : selection?.start ?? length : null, end:editable ? Number.isInteger(e.selectionEnd) ? e.selectionEnd : selection?.end ?? length : null,
        score:(autocomplete.some(token => token === "username" || token === "email") ? 100 : 0) + (type === "email" ? 40 : 0) + (/user|login|email|account|아이디/i.test(e.name + " " + e.id) ? 30 : 0) };
    };
    const metadata = point => {
      const fields = privacyOnly ? [] : [...document.querySelectorAll("input,button,textarea")].slice(0,512).map(field).filter(Boolean);
      const active = field(document.activeElement);
      const hit = point ? document.elementFromPoint(point.x,point.y) : null;
      const clicked = field(hit?.closest("button,input[type=submit]") || hit);
      return { documentId:documentToken, url:location.href, origin:location.origin, fields, focused:active?.id || null, clicked:clicked?.id || null, privacyFocus:id(document.activeElement) };
    };
    const publish = (payload, allowed, api) => { try { send(JSON.stringify({ ...payload, meta:metadata(null), allowed, ownerApi:api })); } catch {} };
    const emit = payload => {
      if (!modeKnown && (payload.type === "privacy-edit" || payload.type === "privacy-boundary")) {
        // A resumed child may accept genuine input before its first mode ack.
        // Only privacy events wait here: never login-authority edits/DOM values.
        const length = typeof payload.edit?.text === "string" ? payload.edit.text.length : 0;
        if (payload.scope) deferredScope = payload.scope;
        if (deferredPrivacy.length < 128 && deferredBytes + length <= 4096) { deferredPrivacy.push(payload); deferredBytes += length; }
        else deferredOverflow = true;
        return;
      }
      publish(payload,nativeAllowed,ownerApi);
    };
    const boundary = () => emit({type:"privacy-boundary"});
    const privateEdit = (e, edit) => emit({type:"privacy-edit",scope:id(e),edit});
    window.addEventListener("focusin", e => { if (e.isTrusted) boundary(); }, true);
    const unknown = e => { const target = field(e); if (target) emit({type:"edit",field:target,edit:{type:"unknown"}}); };
    window.addEventListener("keydown", e => {
      if (!e.isTrusted) return;
      key = { element:e.target, field:field(e.target), key:e.key, modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0) };
      emit({type:"activity",key:e.key});
      if (/^(?:Tab|Enter|Escape|Arrow.*|Home|End|PageUp|PageDown)$/.test(e.key) || (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") boundary();
      if (key.field && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") selections.set(e.target,{start:0,end:key.field.length});
      else if (e.target instanceof HTMLInputElement && e.target.selectionStart === null && /^(Arrow|Home|End)/.test(e.key)) unknown(e.target);
      if (e.key === "Enter" && key.field) emit({type:"submit",form:key.field.form});
    }, true);
    window.addEventListener("keyup", e => { if (e.isTrusted) key = null; }, true);
    window.addEventListener("pointerdown", e => {
      if (!e.isTrusted) return;
      emit({type:"activity"});
      boundary();
      if (!privacyOnly && e.target instanceof HTMLInputElement && e.target.selectionStart === null && e.target.value.length) unknown(e.target);
      const target = field(e.target?.closest?.("button,input[type=submit]"));
      if (target?.kind === "submit") emit({type:"submit",form:target.form});
    }, true);
    window.addEventListener("paste", e => {
      if (!e.isTrusted) return;
      const value = e.clipboardData?.getData("text/plain");
      paste = typeof value === "string" ? {element:e.target,text:value} : null;
      if (typeof value === "string" && value.length <= 65536) emit({type:"privacy",text:value,field:field(e.target)});
    }, true);
    window.addEventListener("compositionstart", e => {
      if (e.isTrusted) { composition = {element:e.target,field:field(e.target)}; if (!composition.field) privateEdit(e.target,{type:"unknown"}); }
    }, true);
    window.addEventListener("compositionend", e => {
      if (!e.isTrusted || !composition || composition.element !== e.target) return;
      if (typeof e.data === "string" && e.data.length <= 65536) emit({type:"privacy",text:e.data,field:field(e.target)});
      if (composition.field && typeof e.data === "string") emit({type:"edit",field:composition.field,edit:{type:"insert",text:e.data}});
      else if (typeof e.data === "string") privateEdit(e.target,{type:"insert",text:e.data});
      composition = null; pending = null; key = null;
    }, true);
    window.addEventListener("beforeinput", e => {
      if (!e.isTrusted || composition) return;
      const target = field(e.target); pending = null;
      if (target?.kind === "submit") return;
      let edit = null;
      const sameKey = key && key.element === e.target && key.field?.kind === target?.kind;
      if (e.inputType === "insertText" && sameKey && !(key.modifiers & 7) && typeof e.data === "string" && e.data === key.key) edit = {type:"insert",text:e.data};
      else if (e.inputType === "insertFromPaste" && paste?.element === e.target && (e.data === null || e.data === paste.text)) edit = {type:"insert",text:paste.text};
      else if (!target && e.inputType === "insertText" && typeof e.data === "string") edit = {type:"insert",text:e.data};
      // Browser-managed replacement may carry real input data; a null data payload is NOT a DOM-value fallback.
      else if (e.inputType === "insertReplacementText" && typeof e.data === "string") edit = {type:"insert",text:e.data};
      else if (e.inputType === "deleteContentBackward" && sameKey && key.key === "Backspace" && !(key.modifiers & 7)) edit = {type:"backspace"};
      else if (e.inputType === "deleteContentForward" && sameKey && key.key === "Delete" && !(key.modifiers & 7)) edit = {type:"delete"};
      pending = {element:e.target,field:target,edit:edit || {type:"unknown"}};
      // Privacy is registered before the browser mutates an undescribed field.
      // The bytes are trusted input/clipboard/composition data, never a DOM value.
      if (!target) privateEdit(e.target,pending.edit);
    }, true);
    window.addEventListener("input", e => {
      if (!e.isTrusted || composition) return;
      const action = pending; pending = null; paste = null; key = null;
      selections.delete(e.target);
      if (action?.element === e.target) { if (action.field) emit({type:"edit",field:action.field,edit:action.edit}); }
      else if (field(e.target)) unknown(e.target);
      else privateEdit(e.target,{type:"unknown"});
    }, true);
    Object.defineProperty(globalThis, ${JSON.stringify(controller)}, { configurable:false, writable:false, value:Object.freeze({
      metadata,
      native(value, api, initialNative, initialApi) {
        if (!modeKnown) {
          modeKnown = true;
          // The Host stamps creation-time mode from this validated execution
          // context, not whichever mode happens to apply when its ack arrives.
          if (initialNative === true && initialApi !== true) {
            for (const payload of deferredPrivacy) publish(payload,true,false);
            if (deferredOverflow) publish({type:"privacy-edit",scope:deferredScope || id(document.activeElement),edit:{type:"unknown"}},true,false);
          }
          deferredPrivacy.length = 0; deferredBytes = 0; deferredOverflow = false; deferredScope = null;
        }
        nativeAllowed = value === true; ownerApi = api === true; key = paste = pending = composition = null;
        // Control readiness is independent of URL/DOM credential observation.
        return {version:1,documentId:documentToken,allowed:nativeAllowed,ownerApi};
      },
      selectAll() {
        const e = document.activeElement;
        if (!e || e.disabled) return false;
        if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) { e.select(); selections.set(e,{start:0,end:e.value.length}); return true; }
        if (!e.isContentEditable && e !== document.body && e !== document.documentElement) return false;
        let root = e; if (e.isContentEditable) while (root.parentElement?.isContentEditable) root = root.parentElement;
        const selection = window.getSelection(); if (!selection) return false;
        const range = document.createRange(); range.selectNodeContents(root); selection.removeAllRanges(); selection.addRange(range); return true;
      }
    }) });
  })()`;
}
