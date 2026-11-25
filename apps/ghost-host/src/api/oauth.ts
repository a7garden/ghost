import type { OAuthStatus, Provider } from "@ghost/contract";
import type { AuthEvent, AuthPrompt, OAuthAuth } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Core } from "../core/core.ts";
import { settingsView } from "../core/commands.ts";
import { CommandError, notFound } from "../core/errors.ts";

const LOGIN_TTL = 15 * 60 * 1000;
/** Only this authorization endpoint may be surfaced to the UI. */
const CLAUDE_AUTHORIZE_PREFIX = "https://claude.ai/oauth/authorize";

interface Login {
  status: OAuthStatus;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  provider: string;
  credential: string | undefined;
  /** Settles the pasted code of an in-flight manual_code prompt (Anthropic). */
  manual?: { promise: Promise<string>; resolve(code: string): void; reject(reason: unknown): void };
}

/** Ephemeral login attempts only; durable credentials belong to Secrets, not the ledger. */
export class OAuthLogins {
  private readonly logins = new Map<string, Login>();
  private readonly unwatch: () => void;

  constructor(
    private readonly core: Core,
    private readonly oauth: OAuthAuth = openaiCodexProvider().auth.oauth!,
    private readonly claude: OAuthAuth = anthropicProvider().auth.oauth!,
  ) {
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
    if (provider.baseUrl !== null) throw new CommandError("invalid", "계정 로그인은 기본 서버 주소를 쓰는 제공자에만 사용할 수 있습니다");
    if (provider.kind !== "openai" && provider.kind !== "anthropic") throw new CommandError("invalid", "이 제공자는 계정 로그인을 지원하지 않습니다");
    return provider;
  }

  start(id: string): OAuthStatus {
    const provider = this.provider(id);
    const previous = this.logins.get(id);
    if (previous?.status.state === "pending") return { ...previous.status };
    if (previous) clearTimeout(previous.timer);
    const controller = new AbortController();
    const login: Login = {
      status: { state: "pending", userCode: null, verificationUri: null, authUrl: null, expiresAt: Date.now() + LOGIN_TTL, message: null },
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

  /** Delivers a code the user pasted in the UI (Anthropic browser login without a reachable callback). */
  submitCode(id: string, code: string): OAuthStatus {
    const login = this.logins.get(id);
    if (!login || login.status.state !== "pending" || login.manual === undefined) {
      throw notFound("붙여넣을 코드를 기다리는 로그인이 없습니다");
    }
    login.manual.resolve(code);
    return { ...login.status };
  }

  private async run(id: string, login: Login): Promise<void> {
    const provider: Provider = JSON.parse(login.provider);
    // ChatGPT completes the device grant; Anthropic completes the browser grant.
    const flow = provider.kind === "anthropic" ? this.claude : this.oauth;
    const active = () => this.logins.get(id) === login && login.status.state === "pending" && !login.controller.signal.aborted;
    try {
      const credential = await flow.login({
        signal: login.controller.signal,
        prompt: async prompt => this.prompt(id, login, prompt),
        notify: event => this.notify(id, login, event),
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
      login.status.authUrl = null;
      this.core.ledger.tx(() => this.core.ledger.emit({ type: "settings", settings: settingsView(this.core) }));
    } catch {
      if (!active()) return;
      login.status.state = "failed";
      // Provider failures can contain token responses. Never expose or log their raw text.
      login.status.message = provider.kind === "anthropic"
        ? "Claude 로그인에 실패했습니다. 인증 코드가 올바른지 확인한 뒤 다시 시도해 주세요."
        : "ChatGPT 로그인에 실패했습니다. 계정의 기기 코드 로그인을 확인한 뒤 다시 시도해 주세요.";
    }
  }

  private async prompt(id: string, login: Login, prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") {
      // ChatGPT offers several grant types; the Host only completes the device code. Anthropic opens the browser.
      if (prompt.options.some(option => option.id === "device_code")) return "device_code";
      if (prompt.options.some(option => option.id === "browser")) return "browser";
      throw new Error("unsupported login prompt");
    }
    if (prompt.type === "manual_code") {
      // The flow races the loopback callback against this prompt; the UI pastes the code here.
      const manual = Promise.withResolvers<string>();
      login.manual = manual;
      const settle = () => manual.reject(new Error("manual code cancelled"));
      prompt.signal?.addEventListener("abort", settle, { once: true });
      try {
        return (await manual.promise).trim();
      } finally {
        prompt.signal?.removeEventListener("abort", settle);
        if (login.manual === manual) login.manual = undefined;
      }
    }
    throw new Error("unsupported login prompt");
  }

  private notify(id: string, login: Login, event: AuthEvent): void {
    if (this.logins.get(id) !== login || login.status.state !== "pending") return;
    if (event.type === "device_code") {
      // Only the expected provider verification site is ever surfaced; a flow presenting anything else fails the login.
      if (event.verificationUri !== "https://auth.openai.com/codex/device") throw new Error("unexpected verification URL");
      login.status.userCode = event.userCode;
      login.status.verificationUri = event.verificationUri;
      return;
    }
    if (event.type === "auth_url") {
      if (!event.url.startsWith(CLAUDE_AUTHORIZE_PREFIX)) throw new Error("unexpected authorization URL");
      login.status.authUrl = event.url;
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
