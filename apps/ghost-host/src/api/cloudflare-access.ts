/**
 * The public web origin sits behind Cloudflare Access; every request Access lets through carries
 * its signed `Cf-Access-Jwt-Assertion`. The Host checks that JWT again (signature against the
 * team's published keys, audience, issuer, lifetime and an allowed email), so a misconfigured
 * Access policy or a path around the edge still reaches nothing.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export interface CloudflareAccessConfig {
  /** Exact HTTPS origin the browser uses, e.g. `https://ghost.example.com`. */
  origin: string;
  /** Zero Trust team domain, e.g. `team.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** Emails allowed in; compared case-insensitively. */
  emails: string[];
}

type Jwk = JsonWebKey & { kid?: string };
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Clock skew tolerated on `exp`/`nbf`, in seconds. */
const SKEW_SECONDS = 60;
/** Unknown `kid`s refetch the key set at most this often, so forged kids cannot hammer the team domain. */
const REFETCH_MS = 30_000;

const decoder = new TextDecoder();

function base64url(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function jsonPart(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(base64url(value)));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseCloudflareAccess(value: unknown): CloudflareAccessConfig {
  const fail = () => new Error("config.json: cloudflareAccess needs an HTTPS origin, teamDomain, audience and a non-empty emails list");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw fail();
  const { origin, teamDomain, audience, emails, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw fail();
  let parsedOrigin: URL;
  try { parsedOrigin = new URL(String(origin)); } catch { throw fail(); }
  if (typeof origin !== "string" || parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) throw fail();
  if (typeof teamDomain !== "string" || !/^[a-z0-9.-]+$/i.test(teamDomain) || !teamDomain.includes(".")) throw fail();
  if (typeof audience !== "string" || !/^[0-9a-f]{16,}$/i.test(audience)) throw fail();
  if (!Array.isArray(emails) || emails.length === 0 || !emails.every((email) => typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email))) throw fail();
  return { origin, teamDomain: teamDomain.toLowerCase(), audience, emails: emails.map((email: string) => email.toLowerCase()) };
}

export class CloudflareAccessVerifier {
  readonly host: string;
  private readonly issuer: string;
  private readonly emails: Set<string>;
  private keys = new Map<string, CryptoKey>();
  private loading: Promise<void> | null = null;
  private loadedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: CloudflareAccessConfig,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string, detail?: unknown) => void = () => {},
  ) {
    this.host = new URL(config.origin).host.toLowerCase();
    this.issuer = `https://${config.teamDomain}`;
    this.emails = new Set(config.emails);
  }

  /** The verified email of the request's Access session, or null. */
  async verify(request: Request): Promise<string | null> {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (token === null) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = jsonPart(headerPart);
    const payload = jsonPart(payloadPart);
    if (header === null || payload === null || header.alg !== "RS256" || typeof header.kid !== "string") return null;

    const seconds = this.now() / 1000;
    const audience = payload.aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    if (payload.iss !== this.issuer || !audiences.includes(this.config.audience)) return null;
    if (typeof payload.exp !== "number" || payload.exp + SKEW_SECONDS < seconds) return null;
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - SKEW_SECONDS > seconds)) return null;
    if (typeof payload.email !== "string" || !this.emails.has(payload.email.toLowerCase())) return null;

    const key = await this.key(header.kid);
    if (key === null) return null;
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(signaturePart), signed).catch(() => false);
    return valid ? payload.email.toLowerCase() : null;
  }

  private async key(kid: string): Promise<CryptoKey | null> {
    const cached = this.keys.get(kid);
    if (cached !== undefined) return cached;
    if (this.loading === null && this.now() - this.loadedAt >= REFETCH_MS) {
      this.loading = this.load().finally(() => { this.loading = null; });
    }
    if (this.loading !== null) await this.loading;
    return this.keys.get(kid) ?? null;
  }

  private async load(): Promise<void> {
    this.loadedAt = this.now();
    try {
      const response = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { keys?: Jwk[] };
      const keys = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
        keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
      }
      if (keys.size === 0) throw new Error("no RSA keys");
      this.keys = keys;
    } catch (caught) {
      this.log("Cloudflare Access keys unavailable", caught instanceof Error ? caught.message : caught);
    }
  }
}
