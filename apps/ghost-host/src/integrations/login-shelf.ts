import type { BrowserLoginFill, BrowserLoginShelf, LoginChoice, VaultItem } from "@ghost/contract";
import { forbidden, invalid, notFound } from "../core/errors.ts";
import { Vault, originsOf } from "../stores/vault.ts";
import { normalizeOrigin } from "../stores/vault/model.ts";
import { isRecord } from "./cli.ts";
import type { BrowserLogin, BrowserPort, BrowserSessionRef } from "./ports.ts";
import type { Shade } from "./shade.ts";

interface Recent { itemId: string; username: string; origin: string; at: number; created: boolean; shade: boolean }

const MAX_FILL = 2000;
/** Read-only probe of where typing would land: the top document's focused editable field, never a frame's. */
const FOCUS_SCRIPT = `(() => { if (window.top !== window) return { reason: "frame" }; const e = document.activeElement; if (!e || e === document.body) return { reason: "no_field" }; if (e instanceof HTMLIFrameElement || e instanceof HTMLFrameElement) return { reason: "frame" }; if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) || e.readOnly || e.disabled) return { reason: "not_editable" }; return { origin: location.origin, password: e instanceof HTMLInputElement && e.type === "password" }; })()`;
const choice = (item: VaultItem): LoginChoice => ({ id: item.id, title: item.title, username: item.username, hasPassword: item.hasPassword, hasTotp: item.hasTotp });

/**
 * What a handoff offers for the page the owner is on: the Ghost's saved logins, the Shade logins that could join
 * them, and the login the owner just completed. Everything here is metadata except `fill` and `importShade`, whose
 * secret values go from the vault or Shade straight into the page the owner is driving, never into a response.
 */
export class LoginShelf {
  private readonly recent = new Map<string, Recent>();
  constructor(private readonly deps: { vault: Vault; shade: Shade; browser: BrowserPort }) {}

  /**
   * The owner finished a login in this session: remember it for the card and mirror it to Shade when allowed.
   * The returned promise settles when the mirror attempt does; callers on the capture path need not wait for it.
   */
  captured(ref: BrowserSessionRef, login: BrowserLogin, item: VaultItem, startedAt: number): Promise<void> {
    const entry: Recent = { itemId: item.id, username: login.username, origin: item.origin ?? login.origin, at: Date.now(), created: item.updatedAt >= startedAt, shade: false };
    this.recent.set(ref.conversationId, entry);
    const { origin, username, password } = login;
    return this.deps.shade.saveLogin({ origin, username, password, title: item.title })
      .then((saved) => { if (this.recent.get(ref.conversationId) === entry) entry.shade = saved; })
      .catch(() => {});
  }

  /** Fresh origin of the page, or null when it is blank, not https or protected. */
  private async origin(session: BrowserSessionRef, fresh: boolean): Promise<string | null> {
    let raw = fresh ? null : this.deps.browser.pageUrl?.(session) ?? null;
    if (raw === null) {
      const current = await this.deps.browser.run(session, ["get", "url"]);
      raw = typeof current.data === "string" ? current.data : current.data && typeof current.data === "object" && "url" in current.data && typeof current.data.url === "string" ? current.data.url : null;
    }
    if (!raw || raw.includes("[redacted]")) return null;
    try { return normalizeOrigin(new URL(raw).origin); } catch { return null; }
  }

  async shelf(session: BrowserSessionRef, since: number | null): Promise<BrowserLoginShelf> {
    const origin = await this.origin(session, false);
    const status = await this.deps.shade.status();
    const items = origin === null ? [] : this.deps.vault.listFor(session.ghostId, { origin, kind: "login" }).filter((item) => item.hasPassword || item.hasTotp).slice(0, 32).map(choice);
    const known = new Set(items.map((item) => item.username ?? ""));
    const shade = origin === null ? [] : (await this.deps.shade.find(origin)).filter((item) => !known.has(item.username));
    const saved = this.recent.get(session.conversationId);
    return {
      origin,
      saved: saved && (since === null || saved.at >= since) ? { ...saved } : null,
      items,
      shade: { status, items: shade },
    };
  }

  /** Type one saved field into the page's focused field, exactly as the owner typing it would. */
  async fill(session: BrowserSessionRef, input: BrowserLoginFill): Promise<void> {
    const origin = await this.origin(session, true);
    if (origin === null) throw invalid("입력할 수 있는 페이지가 아니에요.");
    const item = this.deps.vault.itemFor(session.ghostId, input.itemId);
    if (item.kind !== "login" || !originsOf(item).includes(origin)) throw forbidden("이 사이트의 로그인이 아니에요.");
    if (input.field === "username" ? !item.username : input.field === "password" ? !item.hasPassword : !item.hasTotp) throw notFound("저장된 값이 없어요.");
    // The owner chose the field; the Host only makes sure the value cannot land in a frame, a read-only box or a field of the wrong kind.
    const probe = await this.deps.browser.run(session, ["eval", FOCUS_SCRIPT]);
    const focused = probe.ok && isRecord(probe.data) ? probe.data.result : null;
    if (!isRecord(focused)) throw invalid("입력할 칸을 확인하지 못했어요.");
    if (typeof focused.origin !== "string") throw invalid(focused.reason === "frame" ? "이 칸에는 입력할 수 없어요." : "입력할 칸을 먼저 눌러 주세요.");
    if (focused.origin !== origin) throw forbidden("이 사이트의 로그인이 아니에요.");
    if ((input.field === "password") !== (focused.password === true)) throw invalid(input.field === "password" ? "비밀번호는 비밀번호 칸에만 넣을 수 있어요." : "이 칸에는 입력할 수 없어요.");
    const value = this.deps.vault.reveal(session.ghostId, item.id, input.field);
    if (!value || value.length > MAX_FILL) throw invalid("입력할 수 없는 값이에요.");
    await this.deps.browser.input(session, { type: "text", text: value });
  }

  /** Copy one Shade login into the Ghost vault for this session's Ghost. The password never reaches a response. */
  async importShade(session: BrowserSessionRef, shadeItemId: string): Promise<LoginChoice> {
    const origin = await this.origin(session, true);
    if (origin === null) throw invalid("가져올 수 있는 페이지가 아니에요.");
    const found = (await this.deps.shade.find(origin)).find((item) => item.id === shadeItemId);
    if (!found) throw notFound("Shade에서 이 로그인을 찾을 수 없어요.");
    const password = await this.deps.shade.password(found.id);
    return choice(this.deps.vault.saveLogin(session.ghostId, { origin, username: found.username, password, title: found.title, hints: "Shade에서 가져옴" }));
  }
}
