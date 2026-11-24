/**
 * `tailscale serve` terminates TLS for the tailnet origin and forwards to the Host on loopback. For a
 * request from a user-owned tailnet node it sets `Tailscale-User-Login` (after deleting any client-sent
 * value); Funnel and tagged nodes carry none. The Host accepts that login as the owner, but only for the
 * configured origin's Host header from a loopback peer, so the Cloudflare tunnel and every other Host
 * can never claim it.
 * https://tailscale.com/kb/1312/serve#identity-headers
 */
export interface TailscaleIdentityConfig {
  /** Exact HTTPS origin `tailscale serve` publishes, e.g. `https://host.tailnet.ts.net:8443`. */
  origin: string;
  /** Tailscale logins allowed in, e.g. `owner@github`; compared case-insensitively. */
  logins: string[];
}

export function parseTailscaleIdentity(value: unknown): TailscaleIdentityConfig {
  const fail = () => new Error("config.json: tailscaleIdentity needs an HTTPS origin and a non-empty logins list");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw fail();
  const { origin, logins, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw fail();
  let parsedOrigin: URL;
  try { parsedOrigin = new URL(String(origin)); } catch { throw fail(); }
  if (typeof origin !== "string" || parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) throw fail();
  if (!Array.isArray(logins) || logins.length === 0 || !logins.every((login) => typeof login === "string" && /^[^\s]+$/.test(login))) throw fail();
  return { origin, logins: logins.map((login: string) => login.toLowerCase()) };
}

export class TailscaleIdentity {
  readonly host: string;
  private readonly logins: Set<string>;

  constructor(readonly config: TailscaleIdentityConfig) {
    this.host = new URL(config.origin).host.toLowerCase();
    this.logins = new Set(config.logins);
  }

  /** The allowed Tailscale login `tailscale serve` attached to the request, or null. */
  login(headers: Headers): string | null {
    const login = headers.get("tailscale-user-login")?.trim().toLowerCase();
    return login !== undefined && this.logins.has(login) ? login : null;
  }
}

/** How long the entry page waits for the tailnet origin before it falls back to the Access login. */
const PROBE_MS = 3000;

/**
 * `<web origin>/go`: the one Access-bypassed page. It holds no data; it asks the browser whether the tailnet
 * origin answers (Tailscale is on) and sends it there, otherwise on to the Access login. Both origins are
 * fixed in the page, so nothing request-controlled reaches it.
 */
export function goPage(tailnetOrigin: string, webOrigin: string): { html: string; csp: string } {
  const script = `const t=${JSON.stringify(tailnetOrigin)},w=${JSON.stringify(webOrigin)};`
    + `const c=new AbortController(),k=setTimeout(()=>c.abort(),${PROBE_MS});`
    + `fetch(t+"/api/health",{mode:"no-cors",cache:"no-store",signal:c.signal}).then(()=>location.replace(t+"/"),()=>location.replace(w+"/")).finally(()=>clearTimeout(k));`;
  const digest = new Bun.CryptoHasher("sha256").update(script).digest("base64");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Ghost</title></head><body><script>${script}</script><noscript><a href="${webOrigin}/">Ghost</a></noscript></body></html>`;
  return { html, csp: `default-src 'none'; script-src 'sha256-${digest}'; connect-src ${tailnetOrigin}; base-uri 'none'` };
}
