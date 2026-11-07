import type { OAuthStatus, Provider } from "@ghost/contract";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Core } from "../core/core.ts";
import { settingsView } from "../core/commands.ts";
import { CommandError, notFound } from "../core/errors.ts";

const LOGIN_TTL = 15 * 60 * 1000;
interface Login {
  status: OAuthStatus;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  provider: string;
  credential: string | undefined;
}

/** Ephemeral login attempts only; durable credentials belong to Secrets, not the ledger. */
export class OAuthLogins {
  private readonly logins = new Map<string, Login>();
  private readonly unwatch: () => void;

  constructor(private readonly core: Core, private readonly oauth: OAuthAuth = openaiCodexProvider().auth.oauth!) {
    this.unwatch = core.ledger.subscribe(event => {
      if (event.data.type !== "settings") return;
      for (const [id, login] of this.logins) {
        const provider = core.ledger.providers().find(item => item.id === id);
        if (!provider) {
          login.controller.abort();
          clearTimeout(login.timer);
          this.logins.delete(id);
        } else if (login.status.state === "pending" && (JSON.stringify(provider) !== login.provider || JSON.stringify(core.secrets.credential(id)) !== login.credential)) {
          this.cancel(id);
        }
      }
    });
  }

  private provider(id: string): Provider {
    const provider = this.core.ledger.providers().find(item => item.id === id);
    if (!provider) throw notFound(`provider ${id}`);
    if (provider.kind !== "openai" || provider.baseUrl !== null) {
      throw new CommandError("invalid", "ChatGPT login requires an OpenAI provider with the default server address");
    }
    return provider;
  }

  start(id: string): OAuthStatus {
    const provider = this.provider(id);
    const previous = this.logins.get(id);
    if (previous?.status.state === "pending") return { ...previous.status };
    if (previous) clearTimeout(previous.timer);
    const controller = new AbortController();
    const login: Login = {
      status: { state: "pending", userCode: null, verificationUri: null, expiresAt: Date.now() + LOGIN_TTL, message: null },
      controller,
      timer: setTimeout(() => {
        if (login.status.state === "pending") {
          login.status.state = "failed";
          login.status.message = "로그인 시간이 만료되었습니다. 다시 로그인해 주세요.";
          controller.abort();
        }
      }, LOGIN_TTL),
      provider: JSON.stringify(provider),
      credential: JSON.stringify(this.core.secrets.credential(id)),
    };
    this.logins.set(id, login);
    void this.run(id, login);
    return { ...login.status };
  }

  status(id: string): OAuthStatus {
    this.provider(id);
    const login = this.logins.get(id);
    if (!login) throw notFound("OAuth login; start a new login");
    return { ...login.status };
  }

  cancel(id: string): OAuthStatus {
    const login = this.logins.get(id);
    if (!login) throw notFound("OAuth login");
    if (login.status.state === "pending") {
      login.status.state = "cancelled";
      login.controller.abort();
    }
    return { ...login.status };
  }

  private async run(id: string, login: Login): Promise<void> {
    const active = () => this.logins.get(id) === login && login.status.state === "pending" && !login.controller.signal.aborted;
    try {
      const credential = await this.oauth.login({
        signal: login.controller.signal,
        prompt: async prompt => {
          if (prompt.type !== "select" || !prompt.options.some(option => option.id === "device_code")) throw new Error("unsupported login prompt");
          return "device_code";
        },
        notify: event => {
          if (!active() || event.type !== "device_code") return;
          // Only the expected provider verification site is exposed as a clickable link.
          if (event.verificationUri !== "https://auth.openai.com/codex/device") throw new Error("unexpected verification URL");
          login.status.userCode = event.userCode;
          login.status.verificationUri = event.verificationUri;
        },
      }, { agentName: "ghost" });
      if (!active()) return;
      const stored = await this.core.secrets.modify(id, async current => {
        if (!active()) return undefined;
        this.provider(id);
        if (JSON.stringify(current) !== login.credential) throw new Error("credential changed during login");
        return credential;
      });
      if (!active()) return;
      if (stored?.type !== "oauth" || stored.access !== credential.access || stored.refresh !== credential.refresh) throw new Error("credential changed during login");
      login.status.state = "done";
      login.status.userCode = null;
      login.status.verificationUri = null;
      this.core.ledger.tx(() => this.core.ledger.emit({ type: "settings", settings: settingsView(this.core) }));
    } catch {
      if (!active()) return;
      login.status.state = "failed";
      // Provider failures can contain token responses. Never expose or log their raw text.
      login.status.message = "ChatGPT 로그인에 실패했습니다. 계정의 기기 코드 로그인을 확인한 뒤 다시 시도해 주세요.";
    }
  }

  close(): void {
    this.unwatch();
    for (const login of this.logins.values()) {
      clearTimeout(login.timer);
      login.controller.abort();
    }
    this.logins.clear();
  }
}
