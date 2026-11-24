import { LocalAccountConnect, validate, type Command, type LocalAccount } from "@ghost/contract";
import { Access } from "../core/access.ts";
import { execute } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { CommandError, invalid, notFound } from "../core/errors.ts";
import { discoverMail, type MailDiscoveryDeps } from "../integrations/mail-discovery.ts";
import type { LocalAccounts } from "../integrations/local-accounts.ts";

const STATUSES = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 };
const GITHUB_API = "https://api.github.com";
/** The connection a local GitHub account becomes is named after the account, so it can be recognised later. */
export const githubConnectionName = (login: string) => `GitHub · ${login}`;
/** A double click joins the connection already being made instead of registering the account twice. */
const connecting = new Map<string, Promise<string>>();

/** Server authentication has already admitted `access`: the owner or a paired device. */
export async function serveConnect(request: Request, url: URL, core: Core, access: Access, local: LocalAccounts | null, publicOrigin: string, discovery: MailDiscoveryDeps = {}): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    if (url.pathname === "/api/connect/mail" && request.method === "GET") {
      return json(await discoverMail(url.searchParams.get("email") ?? "", discovery));
    }
    if (url.pathname === "/api/connect/local") {
      const connectionFor = (login: string) => core.ledger.connections().find((connection) => connection.config.kind === "github" && connection.serviceId === "github" && connection.name === githubConnectionName(login) && connection.hasCredential)?.id ?? null;
      if (request.method === "GET") {
        const accounts: LocalAccount[] = local ? (await local.github()).map((account) => ({ source: "gh", serviceId: "github", login: account.login, scopes: account.scopes, connectionId: connectionFor(account.login) })) : [];
        return json({ accounts });
      }
      if (request.method === "POST") {
        const input: unknown = await request.json().catch(() => null);
        if (!validate(LocalAccountConnect, input)) throw invalid("invalid local account");
        if (!local || !(await local.github()).some((account) => account.login === input.login)) throw notFound("이 Mac에서 로그인된 GitHub 계정이 아니에요.");
        const key = input.login.toLowerCase();
        const existing = connectionFor(input.login);
        if (existing) return json({ connectionId: existing });
        const pending = connecting.get(key);
        if (pending) return json({ connectionId: await pending });
        const registering = (async () => {
          const token = await local.githubToken(input.login).catch(() => { throw new CommandError("unavailable", "GitHub 계정의 토큰을 읽을 수 없어요. 터미널에서 gh auth login을 확인해 주세요."); });
          const command: Command = { type: "connection.upsert", name: githubConnectionName(input.login), config: { kind: "github", baseUrl: GITHUB_API }, credential: token, serviceId: "github" };
          const result = await execute(core, access, { requestId: `connect-local:gh:${key}:${Date.now().toString(36)}`, command }, { publicOrigin, documents: null });
          const connectionId = "connectionId" in result ? result.connectionId : undefined;
          if (typeof connectionId !== "string" || !connectionId) throw new CommandError("unavailable", "연결을 만들지 못했어요.");
          return connectionId;
        })();
        connecting.set(key, registering);
        try { return json({ connectionId: await registering }, 201); } finally { connecting.delete(key); }
      }
    }
    throw notFound("connect route not found");
  } catch (error) {
    if (error instanceof CommandError) return json({ ok: false, error: { code: error.code, message: error.message } }, STATUSES[error.code]);
    return json({ ok: false, error: { code: "internal", message: "connect request failed" } }, 500);
  }
}
