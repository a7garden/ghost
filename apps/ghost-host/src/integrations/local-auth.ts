import { Database } from "bun:sqlite";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import type { AuthType, LocalAuthSource, ProviderKind } from "@ghost/contract";
import { isRecord } from "./cli.ts";

/** One credential another agent on this Mac holds, with its secret. It never leaves Host code; `LocalAuthSource` is the safe view. */
export interface LocalAuthEntry {
  id: string;
  agent: LocalAuthSource["agent"];
  agentName: string;
  kind: ProviderKind;
  authType: AuthType;
  account: string | null;
  credential: Credential;
}

type Found = Pick<LocalAuthEntry, "kind" | "authType" | "account" | "credential">;

const MAX_FILE_BYTES = 512_000;
const MAX_KEY_LENGTH = 4096;
/** The agents' own provider ids for API keys Ghost can use as-is, mapped to Ghost's provider kinds. */
const API_KEY_KINDS: Readonly<Record<string, ProviderKind>> = {
  openai: "openai", anthropic: "anthropic", google: "google", zai: "zai", minimax: "minimax", "minimax-code": "minimax",
};
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

function readJson(path: string): unknown {
  try {
    const file = realpathSync(path);
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return null; }
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isRecord(claims) ? claims : null;
  } catch { return null; }
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * A ChatGPT login. Ghost's OpenAI OAuth speaks the Codex backend, so only these tokens fit; the account id and
 * expiry come from the access token itself, where the other agents' files may or may not repeat them.
 */
function chatgptLogin(access: unknown, refresh: unknown, hint: { expires?: unknown; accountId?: unknown; email?: unknown }): Found | null {
  const accessToken = text(access), refreshToken = text(refresh);
  if (accessToken === null || refreshToken === null) return null;
  const claims = jwtClaims(accessToken);
  const auth = claims?.[CODEX_AUTH_CLAIM];
  const accountId = (isRecord(auth) ? text(auth.chatgpt_account_id) : null) ?? text(hint.accountId);
  const expires = typeof claims?.exp === "number" ? claims.exp * 1000 : hint.expires;
  if (accountId === null || typeof expires !== "number" || !Number.isFinite(expires)) return null;
  return { kind: "openai", authType: "oauth", account: text(hint.email), credential: { type: "oauth", access: accessToken, refresh: refreshToken, expires, accountId } };
}

/**
 * An API key. pi and its forks let `key` name an environment variable or a `!shell command` instead of holding the
 * secret; neither is a key Ghost can use, so they are not offered.
 */
function apiKeyFor(provider: string, value: unknown): Found | null {
  const kind = API_KEY_KINDS[provider];
  const key = text(value)?.trim();
  if (kind === undefined || key === undefined || key.length > MAX_KEY_LENGTH || key.startsWith("!") || /^[A-Z][A-Z0-9_]*$/.test(key)) return null;
  return { kind, authType: "api_key", account: `…${key.slice(-4)}`, credential: { type: "api_key", key } };
}

/** The credential shape pi and omp share: `{ type: "oauth" | "api_key", … }` under a provider id. */
function sharedShape(provider: string, stored: unknown): Found | null {
  if (!isRecord(stored)) return null;
  if (stored.type === "oauth") return provider === "openai-codex" ? chatgptLogin(stored.access, stored.refresh, stored) : null;
  return stored.type === "api_key" ? apiKeyFor(provider, stored.key) : null;
}

/**
 * Credentials other agents already hold on the Host's Mac: Codex CLI, omp and pi. Read on demand and never kept;
 * nothing is written to those agents. Only credentials Ghost can actually use are offered, which today is a ChatGPT
 * login (OpenAI) and plain API keys.
 */
export class LocalAuth {
  private readonly home: string;
  private readonly codexHome: string;

  constructor(options: { home?: string; codexHome?: string } = {}) {
    this.home = options.home ?? homedir();
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(this.home, ".codex");
  }

  /** Every usable credential, once per distinct secret even when several agents share it. */
  scan(): LocalAuthEntry[] {
    const seen = new Set<string>();
    return [...this.codex(), ...this.omp(), ...this.pi()].filter(entry => {
      const secret = entry.credential.type === "oauth" ? entry.credential.refresh : entry.credential.key;
      const identity = `${entry.kind}:${secret}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  find(id: string): LocalAuthEntry | undefined {
    return this.scan().find(entry => entry.id === id);
  }

  private codex(): LocalAuthEntry[] {
    const file = readJson(join(this.codexHome, "auth.json"));
    if (!isRecord(file)) return [];
    const entries: LocalAuthEntry[] = [];
    const tokens = isRecord(file.tokens) ? file.tokens : null;
    const email = tokens !== null && typeof tokens.id_token === "string" ? jwtClaims(tokens.id_token)?.email : undefined;
    const login = tokens === null ? null : chatgptLogin(tokens.access_token, tokens.refresh_token, { accountId: tokens.account_id, email });
    if (login !== null) entries.push({ id: "codex:chatgpt", agent: "codex", agentName: "Codex CLI", ...login });
    const key = apiKeyFor("openai", file.OPENAI_API_KEY);
    if (key !== null) entries.push({ id: "codex:api-key", agent: "codex", agentName: "Codex CLI", ...key });
    return entries;
  }

  private omp(): LocalAuthEntry[] {
    const path = join(this.home, ".omp", "agent", "agent.db");
    try { if (!statSync(path).isFile()) return []; } catch { return []; }
    let db: Database | null = null;
    try {
      db = new Database(path, { readonly: true });
      const rows = db.query("SELECT id, provider, credential_type, data FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id").all() as { id: number; provider: string; credential_type: string; data: string }[];
      const entries: LocalAuthEntry[] = [];
      for (const row of rows) {
        let stored: unknown;
        try { stored = JSON.parse(row.data); } catch { continue; }
        // omp keeps the type in its own column; the JSON carries only the fields.
        const found = sharedShape(row.provider, isRecord(stored) ? { ...stored, type: row.credential_type } : null);
        if (found !== null) entries.push({ id: `omp:${row.id}`, agent: "omp", agentName: "omp", ...found });
      }
      return entries;
    } catch { return []; }
    finally { db?.close(); }
  }

  private pi(): LocalAuthEntry[] {
    const file = readJson(join(this.home, ".pi", "agent", "auth.json"));
    if (!isRecord(file)) return [];
    const entries: LocalAuthEntry[] = [];
    for (const [provider, stored] of Object.entries(file)) {
      const found = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider) ? sharedShape(provider, stored) : null;
      if (found !== null) entries.push({ id: `pi:${provider}`, agent: "pi", agentName: "pi", ...found });
    }
    return entries;
  }
}
