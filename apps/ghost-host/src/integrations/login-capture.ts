import type { BrowserLogin } from "./ports.ts";

/** Host-only read, sent via stdin. Never returned by BrowserPort.run or journaled. */
export function loginCaptureScript(submit?: "enter" | { x: number; y: number }) {
  return `(() => { try {
  if (window.top !== window || location.protocol !== "https:") return null;
  const key = Symbol.for("ghost.owner-login-capture");
  let state = window[key];
  if (!state) {
    state = { baseline: new WeakMap(), touched: new WeakSet(), submitted: false, activity: 0 };
    for (const e of document.querySelectorAll('input[type="password"]')) state.baseline.set(e, e.value);
    Object.defineProperty(window, key, { value: state });
    document.addEventListener("input", e => { if (e.isTrusted && e.target?.type === "password") state.touched.add(e.target); }, true);
    document.addEventListener("change", e => { if (e.isTrusted && e.target?.type === "password") state.touched.add(e.target); }, true);
    document.addEventListener("submit", e => { if (e.target?.querySelector('input[type="password"]')) state.submitted = true; }, true);
    document.addEventListener("keydown", e => { if (e.isTrusted && e.key === "Enter" && e.target?.form?.querySelector('input[type="password"]')) state.submitted = true; }, true);
    document.addEventListener("click", e => { const b = e.target?.closest?.('button,input[type="submit"]'); if (e.isTrusted && b?.form?.querySelector('input[type="password"]') && b.type === "submit") state.submitted = true; }, true);
    for (const name of ["pointerdown", "keydown", "input"]) document.addEventListener(name, e => { if (e.isTrusted) state.activity++; }, true);
  }
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(e => !e.disabled && e.getClientRects().length);
  const password = passwords.find(e => e.value && e.autocomplete !== "new-password" && (state.touched.has(e) || state.baseline.has(e) && state.baseline.get(e) !== e.value));
  let username = "";
  if (password) {
    const candidates = [...(password.form || document).querySelectorAll('input')].filter(e => e !== password && !e.disabled && e.value && ["text","email","tel"].includes(e.type));
    const score = e => (/username|email/.test(e.autocomplete) ? 100 : 0) + (e.type === "email" ? 40 : 0) + (/user|login|email|account|아이디/i.test(e.name + " " + e.id) ? 30 : 0) + (e.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING ? 10 : 0);
    candidates.sort((a,b) => score(b) - score(a)); username = candidates[0]?.value || "";
  }
  const submitTarget = ${submit === "enter" ? "document.activeElement" : submit ? `document.elementFromPoint(${submit.x},${submit.y})?.closest('button,input[type=submit]')` : "null"};
  const submitting = !!submitTarget?.form?.querySelector('input[type="password"]') ${submit && submit !== "enter" ? '&& submitTarget.type === "submit"' : ""};
  return JSON.stringify({ url: location.href, origin: location.origin, username: username.slice(0,512), password: password?.value.slice(0,65536) || "", hasPassword: passwords.some(e => !!e.value), submitted: state.submitted || submitting, activity: state.activity });
} catch { return null; } })()`;
}

interface LoginObservation extends BrowserLogin { url: string; hasPassword: boolean; submitted?: boolean }
/** Holds only the latest attempt. Failed submissions with a populated password never commit. */
export class LoginCapture {
  private candidate: (BrowserLogin & { url: string }) | null = null;
  private submitted = false;
  constructor(private readonly save: (login: BrowserLogin) => Promise<void>, private readonly redact: (value: string) => void) {}
  async observe(raw: unknown, submit = false, finished = false) {
    let page: LoginObservation | null = null;
    try { page = typeof raw === "string" ? JSON.parse(raw) : null; } catch {}
    if (page && (typeof page.url !== "string" || typeof page.origin !== "string" || typeof page.password !== "string" || typeof page.username !== "string" || typeof page.hasPassword !== "boolean")) page = null;
    this.submitted ||= page?.submitted === true || submit;
    if (this.candidate && (finished || this.submitted && page && (page.url !== this.candidate.url || !page.hasPassword))) {
      const login = this.candidate; this.candidate = null; this.submitted = false;
      try { await this.save({ origin: login.origin, username: login.username, password: login.password }); }
      finally { login.password = ""; login.username = ""; }
      return;
    }
    if (!page || !page.origin.startsWith("https://") || !page.password) return;
    this.redact(page.password);
    if (page.username) this.redact(page.username);
    // Do not store sign-up/password-change forms: no username, no trustworthy login pairing.
    if (!page.username) return;
    const submitted = this.submitted && this.candidate?.url === page.url;
    this.clear();
    this.candidate = { origin: page.origin, url: page.url, username: page.username, password: page.password };
    this.submitted = submitted || submit || page.submitted === true;
  }
  clear() { if (this.candidate) { this.candidate.password = ""; this.candidate.username = ""; } this.candidate = null; this.submitted = false; }
}
