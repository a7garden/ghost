import { validateGraph } from './orchestration';
import { assetStorage } from './storage';
import { normalizeSnapshot } from './normalize';
import { initialWorkspace, examplePages } from '../fixtures/workspace';
import { exampleCollaboration } from '../fixtures/collaboration';
import type { Bootstrap, Client, Command, Envelope, Page, RoutingPendingMetadata, Snapshot } from './types';
import { ConfirmedFailure, RoutingPending, RoutingTerminal } from './errors';
import type { PendingRoutingRequest, RoutingEntry, RoutingTurn } from './routingTypes';
import { normalizeRoutingFailure } from './routingClient';
import { HostRoutingTransport, createHostRoutingAdapter } from './hostRouting';
import type { RoutingAdapter } from './routingTypes';

export { ConfirmedFailure, RoutingPending, RoutingTerminal } from './errors';

export async function connect(options?: { routingProviders?: Partial<Pick<RoutingAdapter, 'view' | 'prepare'>> & { canPrepareInput?: boolean } }): Promise<Client> {
  const response = await fetch('/ghost-api/bootstrap', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('UI 서버에 연결할 수 없습니다. 잠시 후 다시 연결해 주세요.');
  const config: Bootstrap = await response.json();
  if (config.mode === 'demo') return new DemoClient();
  if (config.mode !== 'live' || !config.csrf) throw new Error('UI 서버 설정을 확인할 수 없습니다.');
  const client: Client = {
    mode: 'live',
    async snapshot(signal) {
      const r = await fetch('/ghost-api/snapshot', { headers: { 'X-Ghost-UI-CSRF': config.csrf }, cache: 'no-store', signal });
      if (!r.ok) throw new Error('Ghost 호스트와 연결이 끊겼습니다. 저장된 화면을 유지하고 다시 연결합니다.');
      const snapshot = normalizeSnapshot(await r.json());
      const capability = snapshot.capabilities.routing as { schema?: unknown; admission?: unknown; entry_view?: unknown; model_router?: unknown; model_tool_registration?: unknown } | undefined;
      if (capability?.schema === 'ghost-routing-host/1' && capability.admission === true) {
        client.routingTransport ??= new HostRoutingTransport(envelope => client.action(envelope), () => client.snapshot());
        if (options?.routingProviders || capability.entry_view === true) {
          const providers = options?.routingProviders ?? (capability.model_router === true && capability.model_tool_registration === true ? {canPrepareInput:true,prepare:(turn:import('./routingTypes').RoutingTurn,id:string)=>client.routingTransport!.prepare(turn,id)} : undefined);
          client.routing = createHostRoutingAdapter(client.routingTransport, providers);
        }
        else client.routing = undefined;
      } else { client.routingTransport = undefined; client.routing = undefined; }
      return snapshot;
    },
    async action(envelope) {
      const r = await fetch('/ghost-api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': config.csrf }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(35000) });
      const data = await r.json();
      if ((r.ok || r.status === 409) && data.ok === false) throw normalizeRoutingFailure(data) ?? new ConfirmedFailure(typeof data.error === 'string' ? data.error : '요청을 처리하지 못했습니다.');
      if (!r.ok || data.ok !== true) throw new Error(typeof data.error === 'string' ? data.error : '요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.');
      return data.result;
    },
  };
  return client;
}

// A snapshot can gain the committed first message before its HTTP reply arrives.
// The composer's prompt/follow_up hint then changes; the pending intent retains
// its original envelope and kind until its exact UUID receipt is recovered.
function commandIdentity(command: Command): string {
  if (command.type === 'routing_turn') {
    const { kind: _kind, ...turn } = command.turn as Record<string, unknown>;
    const { prepared: _prepared, ...intent } = command;
    return JSON.stringify({ ...intent, turn });
  }
  return JSON.stringify(command);
}

// Pending mutation IDs survive refresh. Unknown outcomes are never auto-replayed.
export class CommandQueue {
  private inFlight = new Map<string, Promise<unknown>>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private storage: { getItem(key: string): string | null | Promise<string | null>; setItem(key: string, value: string): void | Promise<void> }, private namespace: string, private imageQueue = false) {}
  private async read(): Promise<Record<string, Envelope>> {
    try { return JSON.parse((await this.storage.getItem(this.namespace)) || '{}'); } catch { throw new Error('이 브라우저의 요청 기록을 읽지 못했습니다. 새 명령을 보내기 전에 저장 공간을 확인하세요.'); }
  }
  async send(client: Client, command: Command, prepare?: (envelope: Envelope) => Promise<Command>): Promise<unknown> {
    const identity = commandIdentity(command), existing = this.inFlight.get(identity);
    if (existing) return existing;
    const operation = this.serial.then(() => this.dispatch(client, command, prepare));
    this.inFlight.set(identity, operation);
    this.serial = operation.catch(() => undefined);
    try { return await operation; }
    finally { if (this.inFlight.get(identity) === operation) this.inFlight.delete(identity); }
  }
  private async dispatch(client: Client, command: Command, prepare?: (envelope: Envelope) => Promise<Command>): Promise<unknown> {
    if (!this.imageQueue && command.type === 'workspace' && (command.action as { type?: string })?.type === 'create_avatar') return new CommandQueue(assetStorage, this.namespace + ':images', true).send(client, command);
    const payload = commandIdentity(command);
    const key = this.imageQueue ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))), n => n.toString(16).padStart(2, '0')).join('') : payload;
    const pending = await this.read();
    if (command.type === 'routing_turn' && !pending[key]) {
      // Older UI versions keyed the pending journal by the full turn, including
      // kind. Recover that original envelope without guessing a server message.
      const legacy = Object.keys(pending).filter(oldKey => {
        try { return commandIdentity(JSON.parse(oldKey)) === key; } catch { return false; }
      });
      if (legacy.length > 1) throw new Error('이 입력에 미확인 요청이 여러 개 있습니다. 기존 접수 결과를 확인해 주세요.');
      if (legacy.length === 1) { pending[key] = pending[legacy[0]]; if (legacy[0] !== key) delete pending[legacy[0]]; }
    }
    const selection = command.type === 'workspace' && (command.action as Record<string, unknown>)?.type === 'conversation_model' ? command.action as Record<string, unknown> : null;
    const sameSelection = (candidate: Envelope) => {
      const operation = candidate.command.action as Record<string, unknown> | undefined;
      return Boolean(selection && candidate.command.type === 'workspace' && operation?.type === 'conversation_model' && operation.profile_id === selection.profile_id && operation.conversation_id === selection.conversation_id);
    };
    const selections = Object.entries(pending).filter(([, candidate]) => sameSelection(candidate));
    // An explicit later choice is a new intent even if an older uncertain
    // receipt had the same value. Only an immediate retry reuses that receipt.
    const reusable = !selection || !selections.length || selections.at(-1)?.[0] === key;
    const envelope = reusable && pending[key] ? pending[key] : { request_id: crypto.randomUUID(), command };
    if (!reusable) delete pending[key];
    pending[key] = envelope;
    // Persist before dispatch; if storage fails, no command is sent.
    await this.storage.setItem(this.namespace, JSON.stringify(pending));
    let result: unknown;
    try {
      if (prepare && !envelope.command.prepared) {
        const prepared = await prepare(envelope);
        envelope.command = prepared;
        const current = await this.read(); current[key] = envelope;
        await this.storage.setItem(this.namespace, JSON.stringify(current));
      }
      result = await client.action(envelope);
    }
    catch (e) {
      // Explicit routing dispositions keep the exact UUID and persist their
      // observed state; the envelope is retained for the status UI. A pending
      // submission is asynchronous acceptance, a terminal outcome is confirmed
      // work that admitted nothing — neither is failed validation.
      if ((e instanceof RoutingPending || e instanceof RoutingTerminal) && command.type === 'routing_turn') {
        await this.patchPendingRoutingNow(envelope.request_id, { state: e.state, ...(e.task_id ? { task_id: e.task_id } : {}) });
      }
      // Confirmed failures of checks and a rejected model selection may be retried
      // after settings are corrected. Unknown outcomes keep their receipt ID.
      if (e instanceof ConfirmedFailure && !(e instanceof RoutingTerminal) && command.type === 'routing_turn') {
        const current = await this.read(); delete current[key]; await this.storage.setItem(this.namespace, JSON.stringify(current));
      }
      if (e instanceof ConfirmedFailure && command.type === 'workspace' && ['save_orchestration', 'start_orchestration', 'cancel_orchestration', 'planner_sync_once', 'conversation_model', 'check_integration', 'decide_integration_approval', 'check_model_provider', 'model_catalog', 'discover_local_models', 'create_avatar', 'set_profile_avatar', 'delete_avatar'].includes((command.action as { type?: string })?.type ?? '')) {
        const current = await this.read(); delete current[key]; await this.storage.setItem(this.namespace, JSON.stringify(current));
      }
      throw e;
    }
    const current = await this.read();
    delete current[key];
    if (selection) for (const [oldKey, candidate] of Object.entries(current)) if (sameSelection(candidate)) delete current[oldKey];
    await this.storage.setItem(this.namespace, JSON.stringify(current));
    return result;
  }
  // Pending routing turns keep their original envelope (UUID, exact turn) in
  // this journal; only routing_turn records are ever touched below, and every
  // write re-reads the journal first so a stale caller cannot drop a newer
  // request or an unrelated command.
  async pendingRouting(entry: RoutingEntry): Promise<PendingRoutingRequest[]> {
    const pending = await this.read();
    return Object.values(pending).flatMap(envelope => {
      if (envelope?.command?.type !== 'routing_turn') return [];
      const turn = (envelope.command as { turn?: RoutingTurn }).turn;
      if (!turn || turn.entry?.entry_profile_id !== entry.entry_profile_id || turn.entry?.conversation_id !== entry.conversation_id) return [];
      const metadata = envelope.routing_pending;
      return [{ request_id: envelope.request_id, turn, task_id: metadata?.task_id ?? null, state: metadata?.state ?? 'unknown', cancel_request_id: metadata?.cancel_request_id, cancel_message: metadata?.cancel_message }];
    });
  }
  // Public pending journal updates chain on the queue's own serial so they never
  // interleave with an in-flight dispatch's read-modify-write (which would
  // resurrect or clobber unrelated envelopes). Dispatch itself already holds the
  // serial and therefore writes through the unlocked ...Now variants.
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work);
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }
  async patchPendingRouting(requestId: string, metadata: Partial<RoutingPendingMetadata>): Promise<void> { return this.enqueue(() => this.patchPendingRoutingNow(requestId, metadata)); }
  async clearPendingRouting(requestId: string): Promise<void> { return this.enqueue(() => this.clearPendingRoutingNow(requestId)); }
  private async patchPendingRoutingNow(requestId: string, metadata: Partial<RoutingPendingMetadata>): Promise<void> {
    const current = await this.read();
    const key = Object.keys(current).find(k => current[k]?.command?.type === 'routing_turn' && current[k]?.request_id === requestId);
    if (!key) return;
    const patch = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
    current[key] = { ...current[key], routing_pending: { ...(current[key].routing_pending ?? { state: 'unknown' as const }), ...patch } };
    await this.storage.setItem(this.namespace, JSON.stringify(current));
  }
  private async clearPendingRoutingNow(requestId: string): Promise<void> {
    const current = await this.read();
    const key = Object.keys(current).find(k => current[k]?.command?.type === 'routing_turn' && current[k]?.request_id === requestId);
    if (!key) return;
    delete current[key];
    await this.storage.setItem(this.namespace, JSON.stringify(current));
  }
}

class DemoClient implements Client {
  mode = 'demo' as const;
  private state: Snapshot;
  private pages: Record<string, Page[]>;
  private avatarImages: Record<string, string> = {};
  private receipts: Record<string, { command: string; result: unknown }>;
  constructor() {
    let saved: { state: Snapshot; pages: Record<string, Page[]>; receipts: DemoClient['receipts'] } | null = null;
    try { saved = JSON.parse(localStorage.getItem('ghost-ui:example-v1') || 'null'); } catch { /* only disposable fixtures */ }
    this.state = saved?.state?.workspace_id === 'ghost-ui-demo-v1' ? normalizeSnapshot(saved.state) : initialWorkspace();
    this.pages = saved?.pages ?? structuredClone(examplePages);
    this.receipts = saved?.receipts ?? {};
  }
  private async restore() {
    const raw = await assetStorage.getItem('ghost-ui:example-v2') ?? localStorage.getItem('ghost-ui:example-v1');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved?.state?.workspace_id !== 'ghost-ui-demo-v1') return;
    this.state = normalizeSnapshot(saved.state); this.pages = saved.pages ?? this.pages; this.receipts = saved.receipts ?? {}; this.avatarImages = saved.avatarImages ?? {};
  }
  async snapshot() { await this.restore(); return structuredClone(this.state); }
  async action(envelope: Envelope): Promise<unknown> {
    const apply = async () => this.commit(envelope);
    return globalThis.navigator?.locks ? navigator.locks.request('ghost-ui:example-v1', apply) : apply();
  }
  private async commit(envelope: Envelope): Promise<unknown> {
    await this.restore();
    const operation = envelope.command.action as { type?: string } | undefined;
    if (envelope.command.type === 'workspace' && ['list_pages', 'read_page', 'collaboration_messages', 'read_avatar'].includes(operation?.type ?? '')) return structuredClone(this.apply(envelope.command));
    const encoded = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(envelope.command)))), n => n.toString(16).padStart(2, '0')).join(''), receipt = this.receipts[envelope.request_id];
    if (receipt) {
      if (receipt.command !== encoded && receipt.command !== JSON.stringify(envelope.command)) throw new Error('같은 요청 ID의 내용이 변경됐습니다.');
      return structuredClone(receipt.result);
    }
    const previous = structuredClone({ state: this.state, pages: this.pages, receipts: this.receipts, avatarImages: this.avatarImages });
    try {
      const result = this.apply(envelope.command);
      this.receipts[envelope.request_id] = { command: encoded, result };
      await assetStorage.setItem('ghost-ui:example-v2', JSON.stringify({ state: this.state, pages: this.pages, receipts: this.receipts, avatarImages: this.avatarImages }));
      return structuredClone(result);
    } catch (error) {
      this.state = previous.state; this.pages = previous.pages; this.receipts = previous.receipts; this.avatarImages = previous.avatarImages;
      throw error;
    }
  }
  private apply(command: Command): unknown {
    const c = command as Record<string, any>;
    const p = this.state.profiles.find(p => p.id === c.profile_id);
    const conversation = p?.conversations.find(v => v.id === c.conversation_id);
    switch (c.type) {
      case 'create_profile': {
        if (this.state.profiles.some(p => p.name === c.name)) throw new Error('같은 이름의 Ghost가 있습니다. 다른 이름을 골라주세요.');
        const id = crypto.randomUUID(); this.state.profiles.push({ id, name: c.name, persona: c.persona, conversations: [], policy: {} }); return { profile_id: id };
      }
      case 'create_conversation': {
        if (!p) throw new Error('Ghost를 찾지 못했습니다.');
        const id = crypto.randomUUID(); p.conversations.unshift({ id, title: '새 대화', model: 'mock', offline: true, messages: [], tasks: [] }); return { conversation_id: id };
      }
      case 'submit': {
        if (!conversation) throw new Error('대화를 선택해 주세요.');
        const id = crypto.randomUUID();
        if (!conversation.messages.some(m => m.role === 'user')) conversation.title = c.prompt.slice(0, 48);
        conversation.messages.push({ role: 'user', text: c.prompt }, { role: 'assistant', text: '예시 모드에서 요청을 받았어요. 연결된 호스트에서는 이 대화에서 실제 작업과 결과를 이어서 볼 수 있습니다.' });
        conversation.tasks.push({ id, name: c.prompt.slice(0, 40), phase: 'complete', partial: '', output: '예시 요청 접수 완료. 실제 모델이나 도구는 실행하지 않았습니다.' }); return { task_id: id };
      }
      case 'cancel': {
        const task = p?.conversations.flatMap(c => c.tasks).find(t => t.id === c.task_id);
        if (!task) throw new Error('작업을 찾지 못했습니다.'); task.phase = 'cancelled'; return {};
      }
      case 'pause_schedule': {
        const schedule = this.state.schedules.find(s => s.id === c.schedule_id); if (!schedule) throw new Error('예약을 찾지 못했습니다.'); schedule.paused = c.paused; return {};
      }
      case 'add_schedule': {
        const id = crypto.randomUUID(); this.state.schedules.push({ id, profile_id: c.profile_id, conversation_id: c.conversation_id, prompt: c.prompt, interval_seconds: c.interval_seconds, next_run_ms: Date.now() + c.interval_seconds * 1000, paused: false }); return { schedule_id: id };
      }
      case 'workspace': return this.owner(c.action);
      default: throw new Error('이 동작은 예시 모드에서 제공하지 않습니다.');
    }
  }
  private owner(a: Record<string, any>): unknown {
    switch (a.type) {
      case 'save_orchestration': {
        if (!a.plan || typeof a.plan.title !== 'string' || !Array.isArray(a.plan.nodes) || !Array.isArray(a.plan.edges)) throw new Error('구조 내용을 확인할 수 없습니다. 다시 저장해 주세요.');
        const error = validateGraph(a.plan, this.state.profiles.map(p => p.id));
        if (error) throw new Error(error);
        const plans = this.state.orchestration_plans ??= [];
        const previous = plans.find(plan => plan.id === a.id);
        const staleUpdate = a.id && (!previous || previous.version !== a.version);
        const staleCreate = !a.id && a.version !== null && a.version !== undefined;
        if (staleUpdate || staleCreate) throw new Error('구조가 변경되었습니다. 최신 구조를 다시 열어 주세요.');
        const plan = { ...structuredClone(a.plan), id: a.id ?? crypto.randomUUID(), version: (previous?.version ?? 0) + 1, updated_ms: Date.now() };
        if (previous) Object.assign(previous, plan); else plans.push(plan);
        return plan;
      }
      case 'start_orchestration': throw new Error('구조 실행은 연결된 호스트에서 사용할 수 있습니다. 예시 모드에서는 실제 Ghost를 실행하지 않습니다.');

      case 'create_avatar': {
        if (this.state.avatars.length >= 64) throw new Error('아바타는 최대 64개까지 보관할 수 있습니다.');
        const { data_url, ...input } = a.avatar;
        const avatar = { ...input, id: crypto.randomUUID(), created_ms: Date.now() };
        this.state.avatars.push(avatar); this.avatarImages[avatar.id] = data_url; return avatar;
      }
      case 'read_avatar': {
        const avatar = this.state.avatars.find(v => v.id === a.id);
        if (!avatar || !this.avatarImages[a.id]) throw new Error('아바타를 찾을 수 없습니다.');
        return { avatar, data_url: this.avatarImages[a.id] };
      }
      case 'set_profile_avatar': {
        const profile = this.state.profiles.find(p => p.id === a.profile_id);
        if (!profile) throw new Error('Ghost를 찾을 수 없습니다.');
        if ((profile.avatar_version ?? 0) !== a.version) throw new Error('다른 곳에서 아바타를 변경했습니다. 최신 화면에서 다시 선택해 주세요.');
        if (a.avatar_id && !this.state.avatars.some(v => v.id === a.avatar_id)) throw new Error('아바타를 찾을 수 없습니다.');
        profile.avatar_id = a.avatar_id; profile.avatar_version = a.version + 1; return {};
      }
      case 'delete_avatar': {
        if (this.state.profiles.some(p => p.avatar_id === a.id)) throw new Error('사용 중인 아바타입니다. Ghost의 아바타를 먼저 변경해 주세요.');
        this.state.avatars = this.state.avatars.filter(v => v.id !== a.id); delete this.avatarImages[a.id]; return {};
      }
      case 'save_todo':
      case 'save_calendar_event':
      case 'save_integration': {
        const list = a.type === 'save_todo' ? this.state.todos : a.type === 'save_calendar_event' ? this.state.calendar_events : this.state.integrations;
        const previous = list.find(t => t.id === a.id);
        if (a.id && (!previous || previous.version !== a.version)) throw new Error('다른 변경이 저장되었습니다. 최신 항목을 다시 열어 주세요.');
        if (a.event && a.event.end_ms <= a.event.start_ms) throw new Error('종료 시각은 시작 이후여야 합니다.');
        const record = { ...(a.todo ?? a.event ?? a.integration), id: a.id ?? crypto.randomUUID(), version: (previous?.version ?? 0) + 1, updated_ms: Date.now(), ...(a.integration ? { tools: [], checked_ms: null, error: null } : {}) };
        if (previous) Object.assign(previous, record); else list.push(record);
        return record;
      }
      case 'delete_todo':
      case 'delete_calendar_event':
      case 'delete_integration': {
        const list = a.type === 'delete_todo' ? this.state.todos : a.type === 'delete_calendar_event' ? this.state.calendar_events : this.state.integrations;
        const index = list.findIndex(t => t.id === a.id && t.version === a.version);
        if (index < 0) throw new Error('항목이 변경되었습니다. 최신 항목을 다시 열어 주세요.');
        list.splice(index, 1); return { deleted: a.id };
      }
      case 'check_integration': throw new Error('실제 연결 확인은 로컬 호스트 연결 후 사용할 수 있습니다. 예시 모드에서는 외부 프로그램을 실행하지 않습니다.');
      case 'collaboration_messages': {
        const d = this.state.delegations.find(d => d.id === a.delegation_id);
        if (!d) throw new Error('협업 기록을 찾지 못했습니다.');
        return exampleCollaboration(this.state, d).filter(m => m.sequence > (a.after ?? 0));
      }
      case 'cancel_delegation': {
        const d = this.state.delegations.find(d => d.id === a.delegation_id);
        if (!d) throw new Error('협업을 찾지 못했습니다.');
        if (d.state === 'complete') return d;
        d.state = 'cancelled';
        const target = this.state.profiles.find(p => p.id === d.target)?.conversations.find(c => c.id === d.conversation_id)?.tasks.find(t => t.id === d.task_id);
        if (target) target.phase = 'cancelled';
        return d;
      }
      case 'decide_review': {
        const r = this.state.reviews.find(r => r.id === a.review_id); if (!r) throw new Error('이미 처리된 검토입니다.');
        r.state = a.approve ? 'saved' : 'declined';
        if (a.approve) (this.pages[r.space_id] ??= []).push({ id: crypto.randomUUID(), locator: 'intro.md', title: 'Ghost 소개', profile: 'example', body: r.body });
        const p = this.state.profiles.find(p => p.id === r.profile_id);
        p?.conversations.find(c => c.id === r.conversation_id)?.tasks.forEach(t => { if (t.phase === 'waiting_owner') t.phase = 'complete'; });
        this.state.delegations.filter(d => d.target === r.profile_id && d.conversation_id === r.conversation_id).forEach(d => { d.state = 'complete'; }); return {};
      }
      case 'list_pages': return (this.pages[a.space_id] ?? []).filter(p => !a.query || p.title.includes(a.query));
      case 'read_page': {
        const page = (this.pages[a.space_id] ?? []).find(p => a.page_id ? p.id === a.page_id : p.locator === a.locator); if (!page) throw new Error('문서를 찾지 못했습니다.'); return page;
      }
      case 'persona': { const p = this.state.profiles.find(p => p.id === a.profile_id); if (p) p.persona = a.persona; return {}; }
      case 'goal_state': { const g = this.state.goals.find(g => g.id === a.goal_id); if (g) { g.state = a.state; g.evidence = a.evidence; } return {}; }
      case 'goal': { const id = crypto.randomUUID(); this.state.goals.push({ id, profile_id: a.profile_id, title: a.title, criteria: a.criteria, instruction: a.instruction, state: 'ready', note: '', evidence: [] }); return { goal_id: id }; }
      default: throw new Error('이 동작은 호스트 연결 후 사용할 수 있습니다.');
    }
  }
}
