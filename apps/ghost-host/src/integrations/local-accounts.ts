import { isRecord, runCli, type CliRunner } from "./cli.ts";
import { findProgram } from "./program.ts";

export interface LocalGithubAccount { login: string; scopes: string[] }

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** Accounts already signed in on the Host's own Mac. Only github.com through the GitHub CLI; nothing is stored or kept here. */
export class LocalAccounts {
  constructor(private readonly options: { program?: string | null; run?: CliRunner } = {}) {}
  private program(): string | null { return this.options.program === undefined ? findProgram("gh") : this.options.program; }

  async github(): Promise<LocalGithubAccount[]> {
    const program = this.program();
    if (!program) return [];
    try {
      const result = await (this.options.run ?? runCli)(program, ["auth", "status", "--hostname", "github.com", "--json", "hosts"]);
      if (result.code !== 0) return [];
      const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
      const entries = isRecord(parsed) && isRecord(parsed.hosts) ? parsed.hosts["github.com"] : null;
      if (!Array.isArray(entries)) return [];
      const accounts: LocalGithubAccount[] = [];
      for (const entry of entries) {
        if (!isRecord(entry) || entry.state !== "success" || typeof entry.login !== "string" || !LOGIN.test(entry.login)) continue;
        const scopes = typeof entry.scopes === "string" ? entry.scopes.split(",").map((scope) => scope.trim().replaceAll("'", "")).filter(Boolean).slice(0, 64) : [];
        accounts.push({ login: entry.login, scopes });
      }
      return accounts;
    } catch { return []; }
  }

  /** The account's token, for Host code that stores it as a connection credential; it never reaches a response. */
  async githubToken(login: string): Promise<string> {
    const program = this.program();
    if (!program || !LOGIN.test(login)) throw new Error("GitHub 계정을 사용할 수 없습니다.");
    const result = await (this.options.run ?? runCli)(program, ["auth", "token", "--hostname", "github.com", "--user", login]);
    try {
      const token = result.stdout.toString("utf8").trim();
      if (result.code !== 0 || !TOKEN.test(token)) throw new Error("GitHub 계정의 토큰을 읽을 수 없습니다.");
      return token;
    } finally { result.stdout.fill(0); }
  }
}
