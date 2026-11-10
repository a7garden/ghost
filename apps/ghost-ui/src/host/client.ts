import { shell, shellCall } from './shell';
import type {
  ApiError,
  ArtifactRef,
  Command,
  ConnectionOAuthView,
  ConnectionOAuthClientInput,
  ConnectionOAuthStart,
  CommandResponse,
  ConversationPage,
  LedgerEvent,
  LiveEvent,
  OAuthStatus,
  PageSummary,
  ProviderPreset,
  PageView,
  SkillCatalog,
  State,
  UpdateStatus,
  VaultContact,
  VaultItem,
  VaultItemKind,
  WorkDetail,
} from '@ghost/contract';

declare global {
  interface Window {
    /** Injected by the host into index.html for loopback requests. */
    __GHOST_TOKEN__?: string;
  }
}

export class HostError extends Error {
  constructor(readonly code: ApiError['code'] | 'network', message: string) {
    super(message);
    this.name = 'HostError';
  }
}

export type StreamHandlers = {
  ledger(event: LedgerEvent): void;
  live(event: LiveEvent): void;
  /** `after` is too old; refetch state. */
  reset(): void;
};

/** One owner write of a vault item. Secret fields are write-only; the host accepts them, no API returns them. */
export type VaultItemWrite = {
  kind: VaultItemKind;
  title: string;
  origin?: string;
  extraOrigins?: string[];
  username?: string;
  password?: string;
  totp?: string;
  card?: { number: string; expiry: string; cvc: string; name: string };
  contact?: VaultContact;
  value?: string;
  hints?: string;
  ghostIds?: string[];
};

/** One live-view frame of a browser handoff (see the host's `/api/browser/handoffs/:id/frame`). */
export type BrowserFrame = { image: string; mediaType: 'image/jpeg'; width: number; height: number; url: string; title: string; windowAvailable?: boolean };

/** One owner input into a handoff browser. */
export type BrowserControl =
  | { type: 'tap'; x: number; y: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: 'Enter' | 'Tab' | 'Backspace' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' }
  | { type: 'scroll'; dy: number }
  | { type: 'navigate'; action: 'back' | 'forward' | 'reload' };

/** The result of importing an Apple Passwords or Chrome CSV export. */
export type VaultImportResult = { imported: number; skipped: number; rejected: number };

/**
 * The only way the UI talks to the host. Same origin; the owner token comes from the
 * host-injected global. In `vite dev` the dev proxy adds it instead.
 */
export class HostClient {
  constructor(private readonly token: string | undefined = typeof window === 'undefined' ? undefined : window.__GHOST_TOKEN__) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}`, ...extra } : extra;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, { ...init, cache: 'no-store', headers: this.headers(init.headers as Record<string, string> | undefined) });
    } catch {
      throw new HostError('network', 'Ghost 호스트에 연결할 수 없습니다.');
    }
    const body = (await response.json().catch(() => null)) as { error?: ApiError } | null;
    if (response.status === 401 && shell) void shellCall({ type: 'revoked' }).catch(() => {});
    if (!response.ok) throw new HostError(body?.error?.code ?? 'internal', body?.error?.message ?? `요청이 실패했습니다 (${response.status}).`);
    return body as T;
  }

  state(): Promise<State> {
    return this.json('/api/state');
  }

  /** Skills a Ghost may be given (owner only); 404 or empty when no skill root is configured. */
  skills(): Promise<SkillCatalog> {
    return this.json('/api/skills');
  }

  /** The host's own release update state. */
  update(): Promise<UpdateStatus> {
    return this.json('/api/update');
  }
  /** Short-lived link for installing the offered iPhone app. */
  iosUpdateLink(): Promise<{ install: string; page: string }> {
    return this.json('/api/update/ios/link', { method: 'POST' });
  }


  /** Ask the host to check GitHub for a newer release; resolves after the check finishes. */
  checkUpdate(): Promise<UpdateStatus> {
    return this.json('/api/update/check', { method: 'POST' });
  }

  /** Start installing `version` in the background (202); refused while another phase is active. */
  installUpdate(version: string): Promise<UpdateStatus> {
    return this.json('/api/update/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    });
  }

  /** Cancel a download or a waiting install; refused during installing. */
  cancelUpdate(): Promise<UpdateStatus> {
    return this.json('/api/update/cancel', { method: 'POST' });
  }

  /** Switch auto-checking or replace (`token`) / remove (`token: null`) the stored GitHub token. */
  updateSettings(patch: { autoCheck?: boolean; token?: string | null }): Promise<UpdateStatus> {
    return this.json('/api/update/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  conversation(id: string, before?: string | null, limit = 50): Promise<ConversationPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    return this.json(`/api/conversations/${encodeURIComponent(id)}?${query}`);
  }

  work(id: string): Promise<WorkDetail> {
    return this.json(`/api/works/${encodeURIComponent(id)}`);
  }

  /** Document summaries of one space, newest edit last; `query` filters by title (owner only). */
  pages(spaceId: string, query?: string): Promise<PageSummary[]> {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    const suffix = params.size ? `?${params}` : '';
    return this.json(`/api/spaces/${encodeURIComponent(spaceId)}/pages${suffix}`);
  }

  /** One page's body and content hash, for editing and conflict detection (owner only). */
  page(spaceId: string, pageId: string): Promise<PageView> {
    return this.json(`/api/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`);
  }

  /** Send a command. Retrying the same call reuses its request id, so it never runs twice. */
  async send<T extends Record<string, unknown> = Record<string, unknown>>(command: Command, requestId: string = crypto.randomUUID()): Promise<T> {
    const response = await this.json<CommandResponse>('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, command }),
    }).catch((error: unknown) => {
      if (error instanceof HostError) throw error;
      throw new HostError('internal', String(error));
    });
    if (!response.ok) throw new HostError(response.error.code, response.error.message);
    return response.result as T;
  }

  /** Bundled provider/model defaults; no account credentials or network discovery. */
  providerCatalog(): Promise<ProviderPreset[]> {
    return this.json('/api/providers/catalog');
  }

  /** Start a device-code login for one OpenAI provider (owner only); joining a pending session returns it unchanged. */
  startOAuth(providerId: string): Promise<OAuthStatus> {
    return this.json(`/api/providers/${encodeURIComponent(providerId)}/oauth`, { method: 'POST' });
  }

  /** Read the current device-code login status of one provider (owner only). */
  oauthStatus(providerId: string): Promise<OAuthStatus> {
    return this.json(`/api/providers/${encodeURIComponent(providerId)}/oauth`);
  }

  /** Cancel a pending device-code login (owner only). */
  cancelOAuth(providerId: string): Promise<OAuthStatus> {
    return this.json(`/api/providers/${encodeURIComponent(providerId)}/oauth`, { method: 'DELETE' });
  }

  connectionOAuth(serviceId: string): Promise<ConnectionOAuthView> {
    return this.json(`/api/connection-oauth/${encodeURIComponent(serviceId)}`);
  }

  configureConnectionOAuth(serviceId: string, input: ConnectionOAuthClientInput): Promise<ConnectionOAuthView> {
    return this.json(`/api/connection-oauth/${encodeURIComponent(serviceId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
  }

  startConnectionOAuth(serviceId: string, input: ConnectionOAuthStart): Promise<ConnectionOAuthView> {
    return this.json(`/api/connection-oauth/${encodeURIComponent(serviceId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
  }

  cancelConnectionOAuth(serviceId: string): Promise<ConnectionOAuthView> {
    return this.json(`/api/connection-oauth/${encodeURIComponent(serviceId)}`, { method: 'DELETE' });
  }

  /** The owner's vault metadata; one-time items that expired are already gone. Values are never returned. */
  vaultItems(): Promise<{ items: VaultItem[] }> {
    return this.json('/api/vault/items');
  }

  /** Create one vault item and return its metadata. */
  vaultCreate(item: VaultItemWrite): Promise<VaultItem> {
    return this.json('/api/vault/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
  }

  /** Edit one vault item; omitted fields keep the stored value. Stored versions stay encrypted. */
  vaultUpdate(id: string, item: VaultItemWrite): Promise<VaultItem> {
    return this.json(`/api/vault/items/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
  }

  /** Delete one vault item and its history. */
  async vaultDelete(id: string): Promise<void> {
    await this.json(`/api/vault/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Import an Apple Passwords or Chrome CSV export. */
  vaultImportCsv(csv: string): Promise<VaultImportResult> {
    return this.json('/api/vault/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
  }

  /**
   * Answer a secure-form question through the vault: item fields plus `save`. The
   * decision resolves with metadata only, so the ordinary answer path never sees a value.
   */
  async vaultRequestAnswer(decisionId: string, answer: Record<string, unknown>): Promise<void> {
    await this.json(`/api/vault/requests/${encodeURIComponent(decisionId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
  }

  /** The live frame of a pending browser handoff: a JPEG of the Ghost's page and its CSS-pixel size. */
  browserFrame(decisionId: string): Promise<BrowserFrame> {
    return this.json(`/api/browser/handoffs/${encodeURIComponent(decisionId)}/frame`);
  }

  /** One owner input into a pending handoff's browser; tap coordinates are fractions of the frame. */
  async browserControl(decisionId: string, input: BrowserControl): Promise<void> {
    await this.json(`/api/browser/handoffs/${encodeURIComponent(decisionId)}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  }

  /** Open the same handoff session as a visible Chrome window on the Mac running the host. */
  async browserWindow(decisionId: string): Promise<void> {
    await this.json(`/api/browser/handoffs/${encodeURIComponent(decisionId)}/window`, { method: 'POST' });
  }

  /** Upload owner message bytes; the returned reference can be passed to message.send. */
  uploadArtifact(file: File): Promise<ArtifactRef> {
    return this.json('/api/artifacts', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Ghost-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    });
  }

  /** Artifact bytes as an object URL; callers may type an image/PDF for its native decoder. Revoke when done. */
  async artifactUrl(digest: string, mediaType?: string): Promise<string> {
    const response = await fetch(`/api/artifacts/${digest}`, { headers: this.headers() });
    if (response.status === 401 && shell) void shellCall({ type: 'revoked' }).catch(() => {});
    if (!response.ok) throw new HostError('not_found', '파일을 불러올 수 없습니다.');
    const blob = await response.blob();
    return URL.createObjectURL(mediaType ? blob.slice(0, blob.size, mediaType) : blob);
  }

  async artifactText(digest: string): Promise<string> {
    const response = await fetch(`/api/artifacts/${digest}`, { headers: this.headers() });
    if (response.status === 401 && shell) void shellCall({ type: 'revoked' }).catch(() => {});
    if (!response.ok) throw new HostError('not_found', '파일을 불러올 수 없습니다.');
    return response.text();
  }

  /**
   * Server-sent events over fetch (EventSource cannot send a bearer token).
   * Resolves when the stream ends; abort `signal` to stop.
   */
  async stream(after: number, conversations: string[], handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
    const query = new URLSearchParams({ after: String(after) });
    for (const id of conversations) query.append('conversation', id);
    const response = await fetch(`/api/events?${query}`, { headers: this.headers({ Accept: 'text/event-stream' }), signal });
    if (response.status === 401 && shell) void shellCall({ type: 'revoked' }).catch(() => {});
    if (!response.ok || !response.body) throw new HostError('network', '이벤트 스트림에 연결할 수 없습니다.');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatch(frame, handlers);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }
}

function dispatch(frame: string, handlers: StreamHandlers) {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  const payload = JSON.parse(data.join('\n')) as unknown;
  if (event === 'ledger') handlers.ledger(payload as LedgerEvent);
  else if (event === 'live') handlers.live(payload as LiveEvent);
  else if (event === 'reset') handlers.reset();
}
