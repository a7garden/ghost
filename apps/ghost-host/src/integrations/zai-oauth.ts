import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

/**
 * Z.ai / GLM Coding Plan sign-in, mirroring ZCode's desktop "Individual Plan"
 * browser flow: an authorization-code request without PKCE against chat.z.ai,
 * a JSON token exchange that yields a short-lived OAuth access token, and a
 * business-API sequence that provisions a durable `id.secret` API key. The
 * minted key is stored as a plain API-key credential, so requests need no
 * dialect change and no refresh scheduler; the interactive grant never recurs.
 */

const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const REDIRECT_URI = "zcode://zai-auth/callback";
const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
const BIZ_BASE = "https://api.z.ai";
const BUSINESS_LOGIN_URL = `${BIZ_BASE}/api/auth/z/login`;
/** Our own key name so sign-in never mutates ZCode's `zcode-api-key`. */
const KEY_NAME = "ghost";
const REQUEST_TIMEOUT_MS = 30_000;

interface ZaiEnvelope { code?: unknown; msg?: unknown; data?: unknown; success?: unknown }

/** Z.ai's `{ code, msg, data, success }` envelope: OAuth answers `code: 0`, biz answers `code: 200`. */
function unwrapEnvelope(body: unknown, operation: string): unknown {
  if (body && typeof body === "object" && ("code" in body || "success" in body)) {
    const envelope = body as ZaiEnvelope;
    const ok = envelope.success === true || envelope.code === 0 || envelope.code === 200 || envelope.code === "0" || envelope.code === "200";
    if (!ok) throw new Error(`Z.ai ${operation} failed: ${typeof envelope.msg === "string" && envelope.msg ? envelope.msg : `code ${String(envelope.code)}`}`);
    return "data" in envelope ? envelope.data : envelope;
  }
  return body;
}

async function requestJson(url: string, init: RequestInit, operation: string): Promise<unknown> {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])];
  const response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Z.ai ${operation} request failed with status ${response.status}`);
  try {
    return text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`Z.ai ${operation} returned invalid JSON`);
  }
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Accepts a pasted final redirect URL, a `code#state` pair, or a bare code. */
function parsePastedCode(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
  } catch { /* not a URL */ }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

/** Exchanges the authorization code for ZCode's short-lived OAuth access token. */
async function exchangeAuthorizationCode(code: string, state: string, redirectUri: string, signal: AbortSignal): Promise<string> {
  const data = unwrapEnvelope(
    await requestJson(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ provider: "zai", code, redirect_uri: redirectUri, state }),
      signal,
    }, "token exchange"),
    "token exchange",
  ) as { zai?: { access_token?: unknown } } | undefined;
  const accessToken = trimmed(data?.zai?.access_token);
  if (!accessToken) throw new Error("Z.ai token exchange returned no access token");
  return accessToken;
}

async function businessLogin(oauthAccessToken: string, signal: AbortSignal): Promise<string> {
  const data = unwrapEnvelope(
    await requestJson(BUSINESS_LOGIN_URL, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: JSON.stringify({ token: oauthAccessToken }),
      signal,
    }, "business login"),
    "business login",
  ) as { access_token?: unknown; accessToken?: unknown } | undefined;
  const bizToken = trimmed(data?.access_token) ?? trimmed(data?.accessToken);
  if (!bizToken) throw new Error("Z.ai business login returned no access token");
  return bizToken;
}

interface ZaiProject { projectId?: unknown; isDefault?: unknown }
interface ZaiOrganization { organizationId?: unknown; isDefault?: unknown; projects?: ZaiProject[] }

function asKeyArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === "object") {
    for (const field of ["list", "keys", "apiKeys", "records"]) {
      const entries = (value as Record<string, unknown>)[field];
      if (Array.isArray(entries)) return entries as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/**
 * Provisions the durable Z.ai API key from a short-lived OAuth access token,
 * mirroring ZCode: business-login → resolve the default org/project from
 * `getCustomerInfo` → find/create our named key → fetch its secret → return
 * `${apiKey}.${secretKey}`.
 */
async function mintApiKey(oauthAccessToken: string, signal: AbortSignal): Promise<string> {
  const bizToken = await businessLogin(oauthAccessToken, signal);
  const auth = { Authorization: `Bearer ${bizToken}`, Accept: "application/json" };

  const customer = unwrapEnvelope(
    await requestJson(`${BIZ_BASE}/api/biz/customer/getCustomerInfo`, { headers: auth, signal }, "customer lookup"),
    "customer lookup",
  ) as { organizations?: ZaiOrganization[] } | undefined;
  const orgs = Array.isArray(customer?.organizations) ? customer.organizations : [];
  const org = orgs.find(entry => entry?.isDefault) ?? orgs[0];
  const project = (Array.isArray(org?.projects) ? org.projects : []).find(entry => entry?.isDefault) ?? org?.projects?.[0];
  const organizationId = trimmed(org?.organizationId);
  const projectId = trimmed(project?.projectId);
  if (!organizationId || !projectId) throw new Error("Z.ai key provisioning failed: no organization/project on account");

  const keysUrl = `${BIZ_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
  const existing = asKeyArray(
    unwrapEnvelope(await requestJson(keysUrl, { headers: auth, signal }, "api key list"), "api key list"),
  ).find(key => key.name === KEY_NAME);
  const record = existing ?? unwrapEnvelope(
    await requestJson(keysUrl, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: KEY_NAME }),
      signal,
    }, "api key create"),
    "api key create",
  ) as Record<string, unknown> | undefined;
  const apiKey = trimmed(record?.apiKey);
  if (!apiKey) throw new Error("Z.ai key provisioning returned no apiKey");

  // List entries mask the secret (`*****abcd`) and the create response's inline
  // secret is unreliable; the copy endpoint always returns the full secret.
  const copied = unwrapEnvelope(
    await requestJson(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, { headers: auth, signal }, "api key copy"),
    "api key copy",
  ) as { secretKey?: unknown } | undefined;
  const secretKey = trimmed(copied?.secretKey);
  if (!secretKey) throw new Error("Z.ai key provisioning returned no secretKey");
  return `${apiKey}.${secretKey}`;
}

/** Interactive Z.ai Coding Plan sign-in; the browser completes it and the code arrives pasted or via the loopback. */
export async function loginZai(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
  const state = crypto.randomUUID().replace(/-/g, "");
  const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    state,
  }).toString()}`;
  interaction.notify({ type: "auth_url", url: authorizeUrl, instructions: "Complete Z.ai login in your browser, then paste the final redirect URL or the code." });
  const pasted = await interaction.prompt({ type: "manual_code", message: "Paste the final redirect URL or the code:", placeholder: REDIRECT_URI, signal: interaction.signal });
  const parsed = parsePastedCode(pasted);
  if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
  if (!parsed.code) throw new Error("Missing authorization code");
  const oauthAccessToken = await exchangeAuthorizationCode(parsed.code, parsed.state ?? state, REDIRECT_URI, interaction.signal);
  return { type: "api_key", key: await mintApiKey(oauthAccessToken, interaction.signal) };
}
