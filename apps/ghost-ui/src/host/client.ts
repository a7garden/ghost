import type {
  ApiError,
  ArtifactRef,
  Command,
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

  /** Artifact bytes as an object URL; revoke it when done. */
  async artifactUrl(digest: string): Promise<string> {
    const response = await fetch(`/api/artifacts/${digest}`, { headers: this.headers() });
    if (!response.ok) throw new HostError('not_found', '파일을 불러올 수 없습니다.');
    return URL.createObjectURL(await response.blob());
  }

  async artifactText(digest: string): Promise<string> {
    const response = await fetch(`/api/artifacts/${digest}`, { headers: this.headers() });
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
