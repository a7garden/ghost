import { ORCHESTRATION_NAME_PATTERN, SESSION_MODEL_ROLE, type OrchestrationConfig, type OrchestrationFallback, type OrchestrationIssue } from '@ghost/contract';

export type NodeKey = { kind: 'agents' | 'roles'; name: string };
export type Position = { x: number; y: number };
export const validName = new RegExp(ORCHESTRATION_NAME_PATTERN);
export const nodeId = ({ kind, name }: NodeKey) => `${kind}:${name}`;

export function addNode(config: OrchestrationConfig, kind: NodeKey['kind'], model?: { provider: string; model: string }) {
  const existing = kind === 'agents' ? config.agents.map(agent => agent.name) : Object.keys(config.modelRoles);
  const prefix = kind === 'agents' ? 'agent' : 'model';
  let number = 1;
  while (existing.includes(`${prefix}-${number}`)) number++;
  const name = `${prefix}-${number}`;
  const next = kind === 'agents' ? {
    ...config, agents: [...config.agents, { name, description: '', modelRole: SESSION_MODEL_ROLE, instructions: '', tools: ['read' as const], readOnly: true, canDelegateTo: [] }],
  } : { ...config, modelRoles: { ...config.modelRoles, [name]: { provider: model?.provider ?? '', model: model?.model ?? '', thinking: null } } };
  return { config: next, node: { kind, name } satisfies NodeKey };
}

export function renameNode(config: OrchestrationConfig, node: NodeKey, name: string): OrchestrationConfig | null {
  if (name === node.name) return config;
  if (!validName.test(name)) return null;
  const positions = { ...config.positions, [node.kind]: replaceKey(config.positions[node.kind], node.name, name) };
  if (node.kind === 'agents') {
    if (config.agents.some(agent => agent.name === name)) return null;
    return { ...config, positions, agents: config.agents.map(agent => ({ ...agent,
      name: agent.name === node.name ? name : agent.name,
      canDelegateTo: agent.canDelegateTo.map(target => target === node.name ? name : target),
    })) };
  }
  if (node.name === SESSION_MODEL_ROLE || Object.hasOwn(config.modelRoles, name)) return null;
  const fallbackChains = Object.fromEntries(Object.entries(replaceKey(config.fallbackChains, node.name, name)).map(([role, chain]) =>
    [role, chain.map(model => 'role' in model && model.role === node.name ? { role: name } : model)]));
  return { ...config, positions, modelRoles: replaceKey(config.modelRoles, node.name, name), fallbackChains,
    agents: config.agents.map(agent => agent.modelRole === node.name ? { ...agent, modelRole: name } : agent) };
}

function replaceKey<T>(values: Record<string, T>, from: string, to?: string): Record<string, T> {
  return Object.fromEntries(Object.entries(values).flatMap(([name, value]) => name === from ? (to ? [[to, value]] : []) : [[name, value]]));
}

export function removeNode(config: OrchestrationConfig, node: NodeKey): OrchestrationConfig {
  if (node.kind === 'roles' && node.name === SESSION_MODEL_ROLE) return config;
  const positions = { ...config.positions, [node.kind]: replaceKey(config.positions[node.kind], node.name) };
  if (node.kind === 'agents') return { ...config, positions, agents: config.agents.filter(agent => agent.name !== node.name).map(agent => ({
    ...agent, canDelegateTo: agent.canDelegateTo.filter(target => target !== node.name),
  })) };
  return { ...config, positions, modelRoles: replaceKey(config.modelRoles, node.name),
    fallbackChains: Object.fromEntries(Object.entries(replaceKey(config.fallbackChains, node.name)).map(([name, chain]) =>
      [name, chain.filter(model => !('role' in model) || model.role !== node.name)])),
    agents: config.agents.map(agent => agent.modelRole === node.name ? { ...agent, modelRole: SESSION_MODEL_ROLE } : agent),
  };
}

export function connectAgents(config: OrchestrationConfig, from: string, to: string, connected = true): OrchestrationConfig {
  if (!config.agents.some(agent => agent.name === to)) return config;
  return { ...config, agents: config.agents.map(agent => agent.name !== from || connected === agent.canDelegateTo.includes(to) ? agent : {
    ...agent, canDelegateTo: connected ? [...agent.canDelegateTo, to] : agent.canDelegateTo.filter(name => name !== to),
  }) };
}

export function reorderFallback(chain: OrchestrationFallback[], from: number, to: number): OrchestrationFallback[] {
  if (from === to || !chain[from] || !chain[to]) return chain;
  const next = chain.slice();
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

export function moveNode(config: OrchestrationConfig, node: NodeKey, position: Position): OrchestrationConfig {
  const bound = (value: number) => Math.max(0, Math.min(20_000, Math.round(value)));
  return { ...config, positions: { ...config.positions, [node.kind]: { ...config.positions[node.kind],
    [node.name]: { x: bound(position.x), y: bound(position.y) },
  } } };
}

export function issueText({ code, ref }: OrchestrationIssue) {
  switch (code) {
    case 'duplicate': return '같은 이름의 에이전트가 있습니다.';
    case 'unknown-role': return `모델 역할 ‘${ref}’이 없습니다.`;
    case 'unknown-agent': return `에이전트 ‘${ref}’가 없습니다.`;
    case 'cycle': return '위임 연결이 순환합니다.';
    case 'depth': return '이 에이전트에서 시작하는 위임이 깊이 한도를 넘습니다.';
    case 'read-only': return '읽기 전용 에이전트에 쓰기 도구가 있습니다.';
    case 'reserved-role': return '세션 모델 역할을 바꿀 수 없습니다.';
    case 'credential': return `${ref}: 연결된 자격 증명이 없습니다.`;
    case 'model': return `${ref}: Ghost에 등록된 모델이 아닙니다.`;
    case 'thinking': return `${ref}: 선택한 사고 수준을 지원하지 않습니다.`;
  }
}
