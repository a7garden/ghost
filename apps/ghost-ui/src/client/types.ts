export type * from './routingTypes';
import type { RoutingAdapter, RoutingPendingState } from './routingTypes';
import type { HostRoutingTransport } from './hostRouting';
import type { RoutingResultProjection, RoutingShare } from './routingResults';
import type { ConnectedPlanner } from './connectedPlanner';
import type { PetDesign, SpriteVersion } from '../pets/sprites';
export type DotState = 'working' | 'attention' | 'idle' | 'offline';
export type Tone = 'mint' | 'peach' | 'lilac' | 'sky';
export interface Task { id: string; name: string; phase: string; partial: string; output: string; parent_id?: string; }
export interface Message { role: string; text: string; task_id?: string; request_id?:string|null; tool?: { name: string; output?: { summary?: string; status?: string; content?: unknown } }; }
export interface Conversation { id: string; title: string; model: string; selected_model?: string; model_pending?: boolean; model_available?: boolean; model_error?: string | null; offline: boolean; messages: Message[]; tasks: Task[]; }
export interface Avatar { id: string; name: string; description: string; sprite_version: SpriteVersion; design?: PetDesign | null; source_manifest?: Record<string, unknown> | null; created_ms: number; }
export interface Profile { avatar_id?: string | null; avatar_version?: number; id: string; name: string; persona: string; conversations: Conversation[]; policy: Record<string, unknown>; error?: string; }
export interface Review { id: string; profile_id: string; conversation_id: string; title: string; body: string; state: string; space_id: string; }
export interface Goal { id: string; profile_id: string; title: string; criteria: string; instruction: string; state: string; evidence: string[]; note: string; }
export interface Schedule { id: string; profile_id: string; conversation_id: string; prompt: string; interval_seconds: number; next_run_ms: number; paused: boolean; }
export interface Space { id: string; name: string; path: string; writable: boolean; profiles: string[]; }
export interface Page { id: string | null; locator: string; title: string; profile: string; diagnostic?: string | null; body?: string; preview?: string; source?: string; deleted?: boolean; }
export interface Todo { id: string; title: string; notes: string; due: string | null; completed: boolean; version: number; updated_ms: number; }
export interface CalendarEvent { id: string; title: string; notes: string; start_ms: number; end_ms: number; version: number; updated_ms: number; }
export type IntegrationTransport = { kind: 'stdio'; command: string; args: string[]; env_refs: Record<string, string>; cwd: string | null } | { kind: 'http'; url: string; bearer_env: string | null };
export interface Integration { id: string; name: string; transport: IntegrationTransport; profiles: string[]; enabled: boolean; version: number; tools: { name: string; description?: string; inputSchema?: unknown }[]; checked_ms: number | null; error: string | null; }
export interface Delegation { id: string; owner: string; owner_task: string; target: string; conversation_id: string; task_id: string; background: boolean; state: string; }
export interface CollaborationMessage { protocol: string; message_id: string; correlation_id: string; sequence: number; from: string; to: string; created_ms: number; event: { type: string; prompt?: string; phase?: string; summary?: string; reason?: string; artifacts?: string[]; uncertain_effects?: string[] }; }
export interface ModelSettings { version: number; providers: ModelProvider[]; roles: { llm: string | null; stt: string | null; tts: string | null }; catalog_updated_ms: number | null; }
export type ModelRole = "llm" | "stt" | "tts";
export interface ModelProvider { id: string; name: string; kind: "builtin" | "openai_compatible"; endpoint: string; auth: { type: "sdk" | "none" | "env"; variable?: string }; roles: ModelRole[]; models: { id: string; name: string; roles: ModelRole[] }[]; enabled: boolean; checked_ms: number | null; error: string | null; }
export interface Snapshot { routing_results?: RoutingResultProjection; routing_shares?: RoutingShare[]; connected_planner?: ConnectedPlanner; model_settings?: ModelSettings; avatars: Avatar[]; workspace_id: string; default_model: string; profiles: Profile[]; reviews: Review[]; goals: Goal[]; schedules: Schedule[]; spaces: Space[]; delegations: Delegation[]; todos: Todo[]; calendar_events: CalendarEvent[]; integrations: Integration[]; capabilities: Record<string, unknown>; connectors: Record<string, boolean>; }
export type Command = Record<string, unknown> & { type: string };
export interface RoutingPendingMetadata {
 // Disposition of the routing turn carried by this envelope. Kept beside the
 // command (never inside it) so the persisted command identity is unchanged.
 state: RoutingPendingState;
 task_id?: string | null;
 cancel_request_id?: string;
 cancel_message?: string;
}
export interface Envelope { request_id: string; command: Command; routing_pending?: RoutingPendingMetadata; }
export interface Bootstrap { mode: 'demo' | 'live'; csrf: string; }
export interface HostEvent { revision: number; event?: string; task_id?: string }
export interface Client { routing?: RoutingAdapter; routingTransport?: HostRoutingTransport; mode: 'demo' | 'live'; snapshot(signal?: AbortSignal): Promise<Snapshot>; action(envelope: Envelope): Promise<unknown>; events?(profileId: string, after: number, waitMs: number, signal?: AbortSignal): Promise<{ events: HostEvent[]; latest: number }>; }

const runningPhases = new Set(['queued', 'model_ready', 'model_running', 'tools', 'tool_ready', 'tool_running', 'waiting_child']);
export const isRunning = (phase: string) => runningPhases.has(phase);
export const phaseLabel = (phase: string) => ({ queued: '대기 중', model_ready: '준비 중', model_running: '생각하는 중', tools: '도구 준비', tool_ready: '작업 준비', tool_running: '작업 중', waiting_child: '함께 작업 중', waiting_owner: '확인 필요', complete: '완료', failed: '실패', cancelled: '취소됨', uncertain: '결과 확인 필요' }[phase] ?? phase);
export function dotState(profile: Profile, reviews: Review[]): DotState {
  if (profile.error) return 'offline';
  if (reviews.some(r => r.profile_id === profile.id && (r.state === 'pending' || r.state === 'approved')) || profile.conversations.some(c => c.tasks.some(t => ['waiting_owner', 'uncertain', 'failed'].includes(t.phase)))) return 'attention';
  if (profile.conversations.some(c => c.tasks.some(t => isRunning(t.phase)))) return 'working';
  return 'idle';
}
export const stateLabel: Record<DotState, string> = { working: '일하는 중', attention: '내 확인 필요', idle: '대기 중', offline: '연결 확인' };
export function toneFor(id: string): Tone {
  const known: Record<string, Tone> = { sage: 'mint', milo: 'peach', nova: 'lilac', theo: 'sky' };
  return known[id] ?? (['mint', 'peach', 'lilac', 'sky'] as Tone[])[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 4];
}
