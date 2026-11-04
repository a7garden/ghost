import { normalizeGraphs, normalizeGraphRuns } from './orchestration';
export { normalizeWork, normalizeDecision, normalizeAdmission, normalizeAdmissionView, normalizeResolution, normalizeRoutingCapability, normalizeRoutingView } from './routingNormalize';
import { normalizeRoutingResults, normalizeRoutingShares } from './routingResults';
import { isDesign } from '../pets/sprites';
import type { Snapshot, IntegrationApproval, ModelSettings, ModelProvider, ModelRole } from './types';

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(object) : [];
const text = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback;
const nullableText = (v: unknown) => typeof v === 'string' ? v : null;
const modelRoles = (v: unknown): ModelRole[] => Array.isArray(v) ? v.filter((r): r is ModelRole => r === 'llm' || r === 'stt' || r === 'tts') : [];
const optionalNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
function modelSettings(v: unknown): ModelSettings | undefined {
  const s = object(v);
  if (!Array.isArray(s.providers)) return undefined;
  const providers: ModelProvider[] = list(s.providers).filter(p => p.kind === 'builtin' || p.kind === 'openai_compatible' || p.kind === 'omp_subscription').map(p => {
    const auth = object(p.auth);
    return { id: text(p.id), name: text(p.name), kind: p.kind as ModelProvider['kind'], endpoint: text(p.endpoint),
      auth: auth.type === 'env' ? { type: 'env', variable: text(auth.variable) } : { type: auth.type === 'sdk' ? 'sdk' : 'none' },
      roles: modelRoles(p.roles), models: list(p.models).map(m => ({ id: text(m.id), name: text(m.name), roles: modelRoles(m.roles) })),
      enabled: p.enabled === true, checked_ms: optionalNumber(p.checked_ms), error: nullableText(p.error) };
  });
  const roles = object(s.roles);
  return { version: optionalNumber(s.version) ?? 0, providers, roles: { llm: nullableText(roles.llm), stt: nullableText(roles.stt), tts: nullableText(roles.tts) }, catalog_updated_ms: optionalNumber(s.catalog_updated_ms) };
}
function integrationApprovals(value: unknown): IntegrationApproval[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return list(value).flatMap(row => {
    const { id, ghost_id, conversation_id, integration_id, integration_name, tool, state, created_ms } = row;
    if (state !== 'pending' && state !== 'dispatching' && state !== 'sent'
      && state !== 'failed' && state !== 'uncertain' && state !== 'declined') return [];
    if (typeof id !== 'string' || typeof ghost_id !== 'string' || typeof conversation_id !== 'string'
      || typeof integration_id !== 'string' || typeof integration_name !== 'string' || typeof tool !== 'string'
      || typeof created_ms !== 'number' || !Number.isSafeInteger(created_ms)) return [];
    return [{ id, ghost_id, conversation_id, integration_id, integration_name, tool, state, created_ms }];
  });
}
export function normalizeSnapshot(value: unknown): Snapshot {
  const s = object(value);
  if (typeof s.workspace_id !== 'string' || !Array.isArray(s.profiles)) throw new Error('호스트 응답 형식을 확인할 수 없습니다. UI와 호스트 버전을 확인하세요.');
  if (s.host_protocol_version !== undefined && s.host_protocol_version !== 1) throw new Error('이 UI가 지원하지 않는 호스트 버전입니다.');
  const authority = object(s.lifetime_authority);
  if (s.lifetime_authority !== undefined && (!Number.isSafeInteger(authority.authority_epoch)
    || (authority.authority_epoch as number) < 1 || typeof authority.dispatch_enabled !== 'boolean')) {
    throw new Error('호스트의 지속형 권한과 실행 상태를 확인하지 못했습니다.');
  }
  const profiles = list(s.profiles).map(p => text(p.id));
  return {
    orchestration_plans: normalizeGraphs(s.orchestration_plans, profiles), orchestration_runs: normalizeGraphRuns(s.orchestration_runs, profiles),
    workspace_id: s.workspace_id, default_model: text(s.default_model, 'mock'),
    lifetime_authority: s.lifetime_authority === undefined ? undefined : {
      authority_epoch: authority.authority_epoch as number, dispatch_enabled: authority.dispatch_enabled as boolean,
    },
    model_settings: modelSettings(s.model_settings),
    connected_planner: s.connected_planner,
    routing_results: normalizeRoutingResults(s.routing_results), routing_shares: normalizeRoutingShares(s.routing_shares),
    avatars: list(s.avatars).filter(a => a.sprite_version === 1 || a.sprite_version === 2).map(a => ({ id: text(a.id), name: text(a.name), description: text(a.description), sprite_version: a.sprite_version as 1 | 2, design: isDesign(a.design) ? a.design : null, source_manifest: a.source_manifest && typeof a.source_manifest === "object" ? object(a.source_manifest) : null, created_ms: Number(a.created_ms) || 0 })),
    profiles: list(s.profiles).map(p => ({ id: text(p.id), avatar_id: typeof p.avatar_id === 'string' ? p.avatar_id : null, avatar_version: Number(p.avatar_version) || 0, name: text(p.name, 'Ghost'), persona: text(p.persona), policy: object(p.policy), error: typeof p.error === 'string' ? p.error : undefined,
      conversations: list(p.conversations).map(c => ({ id: text(c.id), title: text(c.title, '새 대화'), model: text(c.model), selected_model: typeof c.selected_model === 'string' ? c.selected_model : undefined, model_pending: typeof c.model_pending === 'boolean' ? c.model_pending : undefined, model_available: typeof c.model_available === 'boolean' ? c.model_available : undefined, model_error: nullableText(c.model_error), offline: c.offline === true,
        messages: list(c.messages).map(m => ({ ...m, role: text(m.role), text: text(m.text) })) as Snapshot['profiles'][number]['conversations'][number]['messages'],
        tasks: list(c.tasks).map(t => ({ id: text(t.id), name: text(t.name, '작업'), phase: text(t.phase, 'unknown'), partial: text(t.partial), output: text(t.output), parent_id: text(t.parent_id) })),
      })),
    })),
    reviews: list(s.reviews).map(r => {
      const origin = r.lifetime_origin !== null && typeof r.lifetime_origin === 'object' && !Array.isArray(r.lifetime_origin) ? r.lifetime_origin as Record<string, unknown> : null;
      const lifetimeOrigin = origin !== null && typeof origin.turn_id === 'string'
        && Number.isSafeInteger(origin.authority_epoch) && (origin.authority_epoch as number) >= 1
        && typeof origin.request_digest === 'string'
        ? { turn_id: origin.turn_id, authority_epoch: origin.authority_epoch as number, request_digest: origin.request_digest }
        : undefined;
      return {
        id: text(r.id), profile_id: text(r.profile_id), conversation_id: text(r.conversation_id),
        title: text(r.title), body: text(r.body), state: text(r.state), space_id: text(r.space_id),
        page_id: typeof r.page_id === 'string' && r.page_id.trim() !== '' ? r.page_id : null,
        expected_hash: r.expected_hash === null ? null : typeof r.expected_hash === 'string' && /^[0-9a-f]{64}$/i.test(r.expected_hash) ? r.expected_hash : undefined,
        ...(lifetimeOrigin !== undefined ? { lifetime_origin: lifetimeOrigin } : {}),
      };
    }),
    goals: list(s.goals).map(g => ({ id: text(g.id), profile_id: text(g.profile_id), title: text(g.title), criteria: text(g.criteria), instruction: text(g.instruction), state: text(g.state), evidence: Array.isArray(g.evidence) ? g.evidence.filter((e): e is string => typeof e === 'string') : [], note: text(g.note) })),
    schedules: list(s.schedules).map(g => ({ id: text(g.id), profile_id: text(g.profile_id), conversation_id: text(g.conversation_id), prompt: text(g.prompt), interval_seconds: Number(g.interval_seconds) || 0, next_run_ms: Number(g.next_run_ms) || 0, paused: g.paused === true })),
    spaces: list(s.spaces).map(g => ({ id: text(g.id), name: text(g.name), path: text(g.path), writable: g.writable === true, profiles: Array.isArray(g.profiles) ? g.profiles.filter((p): p is string => typeof p === 'string') : [] })),
    todos: list(s.todos).map(t => ({ id: text(t.id), title: text(t.title), notes: text(t.notes), due: typeof t.due === 'string' ? t.due : null, completed: t.completed === true, version: Number(t.version) || 1, updated_ms: Number(t.updated_ms) || 0 })),
    calendar_events: list(s.calendar_events).map(t => ({ id: text(t.id), title: text(t.title), notes: text(t.notes), start_ms: Number(t.start_ms), end_ms: Number(t.end_ms), version: Number(t.version) || 1, updated_ms: Number(t.updated_ms) || 0 })),
    integrationApprovals: integrationApprovals(s.integration_approvals),
    integrations: list(s.integrations).map(t => ({ id: text(t.id), name: text(t.name), transport: object(t.transport) as unknown as Snapshot['integrations'][number]['transport'], profiles: Array.isArray(t.profiles) ? t.profiles.filter((p): p is string => typeof p === 'string') : [], enabled: t.enabled === true, version: Number(t.version) || 1, approved_tools: Array.isArray(t.approved_tools) ? t.approved_tools.filter((name): name is string => typeof name === 'string') : t.approved_tools === null ? null : undefined, tools: list(t.tools).map(v => ({ name: text(v.name), description: text(v.description), inputSchema: v.inputSchema })), checked_ms: Number(t.checked_ms) || null, error: typeof t.error === 'string' ? t.error : null })),
    delegations: list(s.delegations).map(d => ({ id: text(d.id), owner: text(d.owner), owner_task: text(d.owner_task), target: text(d.target), conversation_id: text(d.conversation_id), task_id: text(d.task_id), background: d.background === true, state: text(d.state, 'unknown') })),
    capabilities: object(s.capabilities), connectors: Object.fromEntries(Object.entries(object(s.connectors)).map(([k, v]) => [k, v === true])),
  };
}
