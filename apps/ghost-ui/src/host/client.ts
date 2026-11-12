import { shell, shellCall } from './shell';
import type {
  ApiError,
  ArtifactRef,
  Command,
  CommandOf,
  ConnectionOAuthView,
  ConnectionOAuthClientInput,
  ConnectionOAuthStart,
  CommandResponse,
  ConversationPage,
  LedgerEvent,
  LiveEvent,
  MemoryFile,
  MemoryRevision,
  MemoryView,
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

/** One browser session the host keeps for a conversation (see `/api/browser/sessions`). */
export type BrowserSession = {
  conversationId: string;
  ghostId: string;
  engine: 'chrome' | 'obscura';
  headed: boolean;
  /** The pending handoff question waiting on the owner for this conversation, when one is open. */
  handoffDecisionId: string | null;
};

/** One line of a session's live stream: a JPEG frame, the page the Ghost is on, or the session's end. */
export type BrowserLiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'page'; url: string; title: string }
  | { type: 'end'; reason: string };

/** One owner input into a conversation's browser; coordinates are viewport CSS pixels. */
export type BrowserInput =
  | { type: 'mouse'; event: 'down' | 'up' | 'move' | 'wheel'; x: number; y: number; button?: 'left' | 'middle' | 'right' | 'none'; clickCount?: 1 | 2 | 3; deltaX?: number; deltaY?: number; modifiers?: number }
  | { type: 'key'; event: 'down' | 'up'; key: string; code: string; text?: string; keyCode?: number; modifiers?: number }
  | { type: 'text'; text: string }
  | { type: 'viewport'; width: number; height: number }
  | { type: 'navigate'; action: 'back' | 'forward' | 'reload' };

/**
 * Complete NDJSON lines out of one stream chunk against the previous remainder; the tail goes
 * back in. Blank lines disappear. Pure; tests pin chunks split mid-line.
 */
export function ndjsonLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const joined = buffer + chunk;
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const boundary = joined.indexOf('\n', start);
    if (boundary < 0) break;
    const line = joined.slice(start, boundary).trim();
    if (line) lines.push(line);
    start = boundary + 1;
  }
  return { lines, rest: joined.slice(start) };
}

/** The result of importing an Apple Passwords or Chrome CSV export. */
export type VaultImportResult = { imported: number; skipped: number; rejected: number };

/** One address on a mail header, as IMAP parsed it. */
export type MailAddr = { name: string; address: string };

/** One IMAP mailbox of a connection, with its special-use role when the server declares one. */
export type MailboxInfo = {
  path: string; name: string; delimiter: string | null;
  specialUse: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged' | null;
  total: number | null; unseen: number | null;
};

/** What a mailbox listing says about one message. */
export type MailSummary = {
  uid: number; messageId: string | null; from: MailAddr | null; to: MailAddr[];
  subject: string; date: number; seen: boolean; flagged: boolean; answered: boolean;
  hasAttachments: boolean; size: number;
};

/** One message in full; the host reads with BODY.PEEK, so fetching never marks it seen. */
export type MailMessage = MailSummary & {
  uidValidity?: number;
  cc: MailAddr[]; replyTo: MailAddr[]; text: string; html: string | null;
  attachments: { part: string; filename: string; contentType: string; size: number }[];
};

/** Mail connections that hold a credential; `canSend` says SMTP is configured. */
export type MailAccounts = { accounts: { connectionId: string; name: string; address: string; canSend: boolean }[] };

/** One mailbox page, newest first; `nextBefore` feeds the next older page. */
export type MailPage = { mailbox: string; uidValidity: number; messages: MailSummary[]; nextBefore: number | null };

export type MailQuery = { mailbox: string; q?: string; before?: number; limit?: number };

export type MailSendCommand = CommandOf<'mail.send'>;
export type MailUpdateCommand = CommandOf<'mail.update'>;

/**
 * The only way the UI talks to the host. Same origin; the owner token comes from the
 * host-injected global. In `vite dev` the dev proxy adds it instead.
 */
export class HostClient {
  constructor(private readonly token: string | undefined = typeof window === 'undefined' ? undefined : window.__GHOST_TOKEN__) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}`, ...extra } : extra;
  }

  /**
   * Every Host request. The Host never redirects an API call; on the Cloudflare Access web origin
   * a redirect is Access sending an expired session to its login, which only a page load can follow.
   */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(path, { ...init, redirect: 'manual' });
    if (response.type === 'opaqueredirect') {
      window.location.reload();
      throw new HostError('forbidden', '다시 로그인해야 합니다.');
    }
    return response;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.request(path, { ...init, cache: 'no-store', headers: this.headers(init.headers as Record<string, string> | undefined) });
    } catch (caught) {
      throw caught instanceof HostError ? caught : new HostError('network', 'Ghost 호스트에 연결할 수 없습니다.');
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

  /** One Ghost's Host memory: the visible files and recent consolidation runs. */
  memory(ghostId: string): Promise<MemoryView> {
    return this.json(`/api/memory/${encodeURIComponent(ghostId)}`);
  }

  /** Every kept version of one memory file, deletes included. */
  memoryRevisions(ghostId: string, path: string): Promise<MemoryRevision[]> {
    return this.json(`/api/memory/${encodeURIComponent(ghostId)}/revisions?path=${encodeURIComponent(path)}`);
  }

  /**
   * Create or replace one memory file. `expectedHash` must match the stored version,
   * so an edit that raced another writer is refused instead of overwriting it.
   */
  memoryWrite(ghostId: string, input: { path: string; content: string; expectedHash: string | null; requestId?: string }): Promise<MemoryFile | null> {
    return this.json(`/api/memory/${encodeURIComponent(ghostId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }),
    });
  }

  /** Delete one memory file at its exact version; every revision is kept. */
  async memoryDelete(ghostId: string, path: string, expectedHash: string): Promise<void> {
    await this.json(`/api/memory/${encodeURIComponent(ghostId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, expectedHash, requestId: crypto.randomUUID() }),
    });
  }

  /** Ask the Host to consolidate this Ghost's memory at the next idle moment. */
  async memoryDream(ghostId: string): Promise<void> {
    await this.json(`/api/memory/${encodeURIComponent(ghostId)}/dream`, { method: 'POST' });
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

  // Mail (메일): the owner's IMAP/SMTP accounts, read through the host.

  /** Mail connections that hold a credential; `canSend` says SMTP is configured. */
  mailAccounts(): Promise<MailAccounts> {
    return this.json('/api/mail/accounts');
  }

  /** One account's mailboxes, server order; the UI sorts special-use mailboxes first. */
  mailMailboxes(connectionId: string): Promise<{ mailboxes: MailboxInfo[] }> {
    return this.json(`/api/mail/${encodeURIComponent(connectionId)}/mailboxes`);
  }

  /** One mailbox's summaries, newest first; `before` pages older mail via `nextBefore`. */
  mailMessages(connectionId: string, query: MailQuery): Promise<MailPage> {
    const params = new URLSearchParams({ mailbox: query.mailbox });
    if (query.q) params.set('q', query.q);
    if (query.before !== undefined) params.set('before', String(query.before));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    return this.json(`/api/mail/${encodeURIComponent(connectionId)}/messages?${params}`);
  }

  /** One message with headers and body; BODY.PEEK means this never marks it seen. */
  mailMessage(connectionId: string, mailbox: string, uid: number): Promise<MailMessage> {
    const params = new URLSearchParams({ mailbox, uid: String(uid) });
    return this.json(`/api/mail/${encodeURIComponent(connectionId)}/message?${params}`);
  }

  /** Download one attachment: fetch the bytes with the bearer token, then save them as a file. */
  async mailAttachment(connectionId: string, mailbox: string, uid: number, part: string, filename: string): Promise<void> {
    const params = new URLSearchParams({ mailbox, uid: String(uid), part });
    const response = await this.request(`/api/mail/${encodeURIComponent(connectionId)}/attachment?${params}`, { headers: this.headers() });
    if (response.status === 401 && shell) void shellCall({ type: 'revoked' }).catch(() => {});
    if (!response.ok) throw new HostError('not_found', '첨부 파일을 저장하지 못했습니다.');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** mail.send through the command endpoint; a retried request id never sends twice. */
  mailSend(command: MailSendCommand, requestId?: string): Promise<{ messageId: string }> {
    return this.send<{ messageId: string }>(command, requestId);
  }

  /** mail.update: seen/flag state and mailbox moves. */
  mailUpdate(command: MailUpdateCommand): Promise<{ updated: number }> {
    return this.send<{ updated: number }>(command);
  }

  /** The browser sessions the host keeps, one per conversation, with any pending handoff question. */
  browserSessions(): Promise<{ sessions: BrowserSession[] }> {
    return this.json('/api/browser/sessions');
  }

  /**
   * The live NDJSON stream of one conversation's browser: JSON lines until the session or the
   * client ends. TextDecoderStream is missing in the iPhone shell's WKWebView, so the bytes
   * decode incrementally. 404 means the session is gone; abort `signal` to stop watching.
   */
  async browserLive(conversationId: string, fps: number, onEvent: (event: BrowserLiveEvent) => void, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.request(`/api/browser/sessions/${encodeURIComponent(conversationId)}/live?fps=${fps}`, { cache: 'no-store', headers: this.headers({ Accept: 'application/x-ndjson' }), signal });
    } catch (caught) {
      throw caught instanceof HostError ? caught : new HostError('network', '브라우저 화면에 연결할 수 없습니다.');
    }
    if (response.status === 401 && shell) void shellCall({ type: 'revoked' }).catch(() => {});
    if (!response.ok || !response.body) {
      throw response.status === 404
        ? new HostError('not_found', '브라우저 세션이 없습니다.')
        : new HostError(response.status === 409 ? 'conflict' : 'network', '브라우저 화면을 볼 수 없습니다.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parsed = ndjsonLines(buffer, '');
      buffer = parsed.rest;
      for (const line of parsed.lines) {
        try { onEvent(JSON.parse(line) as BrowserLiveEvent); }
        catch { /* a torn line never breaks the stream */ }
      }
    }
  }

  /** One owner input into a conversation's browser; the host validates the grammar again. */
  async browserInput(conversationId: string, input: BrowserInput): Promise<void> {
    await this.json(`/api/browser/sessions/${encodeURIComponent(conversationId)}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  }

  /** Move the conversation's browser into a visible Chrome window on the Mac running the host. */
  async browserWindow(conversationId: string): Promise<void> {
    await this.json(`/api/browser/sessions/${encodeURIComponent(conversationId)}/window`, { method: 'POST' });
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
    const response = await this.request(`/api/artifacts/${digest}`, { headers: this.headers() });
    if (response.status === 401 && shell) void shellCall({ type: 'revoked' }).catch(() => {});
    if (!response.ok) throw new HostError('not_found', '파일을 불러올 수 없습니다.');
    const blob = await response.blob();
    return URL.createObjectURL(mediaType ? blob.slice(0, blob.size, mediaType) : blob);
  }

  async artifactText(digest: string): Promise<string> {
    const response = await this.request(`/api/artifacts/${digest}`, { headers: this.headers() });
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
    const response = await this.request(`/api/events?${query}`, { headers: this.headers({ Accept: 'text/event-stream' }), signal });
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
