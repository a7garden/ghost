/** Runs only in Chrome's real isolated world, installed before any page script. No DOM value is exported. */
export function chromeLoginScript(controller: string, binding: string) {
  return `(() => { "use strict";
    if (window.top !== window || globalThis[${JSON.stringify(controller)}]) return;
    const send = globalThis[${JSON.stringify(binding)}];
    const ids = new WeakMap(), selections = new WeakMap(); let serial = 0, nativeAllowed = false, ownerApi = false;
    const documentToken = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
    let key = null, paste = null, pending = null, composition = null;
    const id = e => { if (!e) return "document"; let value = ids.get(e); if (!value) { value = "n" + ++serial; ids.set(e,value); } return value; };
    const field = e => {
      if (!(e instanceof HTMLInputElement || e instanceof HTMLButtonElement)) return null;
      const type = e.type, input = e instanceof HTMLInputElement;
      const autocomplete = (e.getAttribute("autocomplete") || "").trim().toLowerCase().split(/\\s+/);
      const sensitive = autocomplete.some(token => token.startsWith("cc-") || token === "one-time-code" || token === "new-password");
      const selection = selections.get(e), length = input ? e.value.length : 0;
      return { id:id(e), form:id(e.form), kind:e.disabled || e.readOnly ? "other" : input && sensitive ? "sensitive" : input && type === "password" ? "password" : type === "submit" ? "submit" : input && ["text","email","tel"].includes(type) ? "username" : "other",
        length, start:input ? Number.isInteger(e.selectionStart) ? e.selectionStart : selection?.start ?? length : null, end:input ? Number.isInteger(e.selectionEnd) ? e.selectionEnd : selection?.end ?? length : null,
        score:(autocomplete.some(token => token === "username" || token === "email") ? 100 : 0) + (type === "email" ? 40 : 0) + (/user|login|email|account|아이디/i.test(e.name + " " + e.id) ? 30 : 0) };
    };
    const metadata = point => {
      const fields = [...document.querySelectorAll("input,button")].slice(0,512).map(field).filter(Boolean);
      const active = field(document.activeElement);
      const hit = point ? document.elementFromPoint(point.x,point.y) : null;
      const clicked = field(hit?.closest("button,input[type=submit]") || hit);
      return { documentId:documentToken, url:location.href, origin:location.origin, fields, focused:active?.id || null, clicked:clicked?.id || null };
    };
    const emit = payload => { try { send(JSON.stringify({ ...payload, meta:metadata(null), allowed:nativeAllowed, ownerApi })); } catch {} };
    const unknown = e => { const target = field(e); if (target) emit({type:"edit",field:target,edit:{type:"unknown"}}); };
    window.addEventListener("keydown", e => {
      if (!e.isTrusted) return;
      key = { element:e.target, field:field(e.target), key:e.key, modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0) };
      emit({type:"activity",key:e.key});
      if (key.field && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") selections.set(e.target,{start:0,end:key.field.length});
      else if (e.target instanceof HTMLInputElement && e.target.selectionStart === null && /^(Arrow|Home|End)/.test(e.key)) unknown(e.target);
      if (e.key === "Enter" && key.field) emit({type:"submit",form:key.field.form});
    }, true);
    window.addEventListener("keyup", e => { if (e.isTrusted) key = null; }, true);
    window.addEventListener("pointerdown", e => {
      if (!e.isTrusted) return;
      emit({type:"activity"});
      if (e.target instanceof HTMLInputElement && e.target.selectionStart === null && e.target.value.length) unknown(e.target);
      const target = field(e.target?.closest?.("button,input[type=submit]"));
      if (target?.kind === "submit") emit({type:"submit",form:target.form});
    }, true);
    window.addEventListener("paste", e => {
      if (!e.isTrusted) return;
      const value = e.clipboardData?.getData("text/plain");
      paste = typeof value === "string" ? {element:e.target,text:value} : null;
    }, true);
    window.addEventListener("compositionstart", e => {
      if (e.isTrusted) composition = {element:e.target,field:field(e.target)};
    }, true);
    window.addEventListener("compositionend", e => {
      if (!e.isTrusted || !composition || composition.element !== e.target) return;
      if (composition.field && typeof e.data === "string") emit({type:"edit",field:composition.field,edit:{type:"insert",text:e.data}});
      else unknown(e.target);
      composition = null; pending = null; key = null;
    }, true);
    window.addEventListener("beforeinput", e => {
      if (!e.isTrusted || composition) return;
      const target = field(e.target); pending = null;
      if (!target || !["username","password","sensitive"].includes(target.kind)) return;
      let edit = null;
      const sameKey = key && key.element === e.target && key.field?.kind === target.kind;
      if (e.inputType === "insertText" && sameKey && !(key.modifiers & 7) && typeof e.data === "string" && e.data === key.key) edit = {type:"insert",text:e.data};
      else if (e.inputType === "insertFromPaste" && paste?.element === e.target && (e.data === null || e.data === paste.text)) edit = {type:"insert",text:paste.text};
      // Browser-managed replacement may carry real input data; a null data payload is NOT a DOM-value fallback.
      else if (e.inputType === "insertReplacementText" && typeof e.data === "string") edit = {type:"insert",text:e.data};
      else if (e.inputType === "deleteContentBackward" && sameKey && key.key === "Backspace" && !(key.modifiers & 7)) edit = {type:"backspace"};
      else if (e.inputType === "deleteContentForward" && sameKey && key.key === "Delete" && !(key.modifiers & 7)) edit = {type:"delete"};
      pending = {element:e.target,field:target,edit:edit || {type:"unknown"}};
    }, true);
    window.addEventListener("input", e => {
      if (!e.isTrusted || composition) return;
      const action = pending; pending = null; paste = null; key = null;
      selections.delete(e.target);
      if (action?.element === e.target) emit({type:"edit",field:action.field,edit:action.edit});
      else unknown(e.target);
    }, true);
    Object.defineProperty(globalThis, ${JSON.stringify(controller)}, { configurable:false, writable:false, value:Object.freeze({
      metadata,
      native(value, api) { nativeAllowed = value === true; ownerApi = api === true; key = paste = pending = composition = null; },
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
