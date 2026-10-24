export type EdgeCondition = 'success' | 'failure' | 'always';
export interface GraphNode { id: string; profile_id: string; title: string; prompt: string; }
export interface GraphEdge { from: string; to: string; condition: EdgeCondition; }
export interface GraphInput { title: string; nodes: GraphNode[]; edges: GraphEdge[]; }
export interface GraphPlan extends GraphInput { id: string; version: number; updated_ms: number; }
export interface GraphJob { node_id: string; state: string; conversation_id: string; task_id: string | null; output: string; }
export interface GraphRun { id: string; plan: GraphPlan; state: string; created_ms: number; jobs: GraphJob[]; }
export const edgeLabels: Record<EdgeCondition, string> = { success: '성공하면', failure: '실패하면', always: '성공·실패 모두' };
export const graphStateLabels: Record<string, string> = { pending: '선행 작업 대기', starting: '접수 중', running: '실행 중', complete: '완료', failed: '실패', uncertain: '결과 확인 필요', skipped: '조건 불일치', cancelled: '취소됨', cancelling: '취소 확인 중' };
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function graphLayers(plan: GraphInput): string[][] {
  const remaining = new Set(plan.nodes.map(node => node.id)), visited = new Set<string>(), layers: string[][] = [];
  while (remaining.size) {
    const layer = [...remaining].filter(id => plan.edges.filter(edge => edge.to === id).every(edge => visited.has(edge.from)));
    if (!layer.length) return [];
    layers.push(layer); layer.forEach(id => { remaining.delete(id); visited.add(id); });
  }
  return layers;
}
export const activeRunStates: readonly string[] = ['running', 'cancelling'];
export function validateGraph(plan: GraphInput, profiles: string[]): string | null {
  if (!plan.title.trim() || bytes(plan.title) > 200) return '구조 이름을 200바이트 이내로 입력해 주세요.';
  if (!plan.nodes.length || plan.nodes.length > 16) return '작업을 1~16개 지정해 주세요.';
  if (plan.edges.length > 64) return '연결은 64개까지 지정할 수 있습니다.';
  const ids = new Set(plan.nodes.map(node => node.id));
  if (ids.size !== plan.nodes.length) return '작업 ID가 중복되었습니다.';
  for (const node of plan.nodes) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.id) || !profiles.includes(node.profile_id)) return '담당 Ghost를 선택해 주세요.';
    if (!node.title.trim() || bytes(node.title) > 200) return '각 작업 이름을 200바이트 이내로 입력해 주세요.';
    if (!node.prompt.trim() || bytes(node.prompt) > 4000) return '각 작업의 요청 내용을 4000바이트 이내로 입력해 주세요.';
  }
  const pairs = new Set<string>();
  for (const edge of plan.edges) {
    const key = `${edge.from}:${edge.to}`;
    if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to) || pairs.has(key) || !Object.hasOwn(edgeLabels, edge.condition)) return '작업 연결과 조건을 확인해 주세요.';
    pairs.add(key);
  }
  if (!graphLayers(plan).length) return '순환 연결은 실행할 수 없습니다. 앞선 작업으로 돌아가는 연결을 제거해 주세요.';
  return null;
}
export function normalizeGraphs(value: unknown, profiles: string[]): GraphPlan[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('호스트의 작업 구조 응답을 확인하지 못했습니다.');
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !Number.isSafeInteger(item.version) || item.version < 1 || !Number.isFinite(item.updated_ms) || typeof item.title !== 'string' || !Array.isArray(item.nodes) || !Array.isArray(item.edges)
      || item.nodes.some((node: GraphNode) => !node || ['id','profile_id','title','prompt'].some(key => typeof node[key as keyof GraphNode] !== 'string'))
      || item.edges.some((edge: GraphEdge) => !edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || !Object.hasOwn(edgeLabels,edge.condition))) throw new Error('호스트의 작업 구조 응답을 확인하지 못했습니다.');
    const plan = item as GraphPlan;
    if (validateGraph(plan, profiles)) throw new Error('호스트가 유효하지 않은 작업 구조를 반환했습니다.');
    return plan;
  });
}
export function normalizeGraphRuns(value: unknown, profiles: string[]): GraphRun[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('호스트의 구조 실행 기록을 확인하지 못했습니다.');
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !['running','cancelling','complete','failed','cancelled'].includes(item.state) || !Number.isFinite(item.created_ms) || !Array.isArray(item.jobs) || item.jobs.some((job: GraphJob) => !job || typeof job !== 'object')) throw new Error('호스트의 구조 실행 기록을 확인하지 못했습니다.');
    const plan = normalizeGraphs([item.plan], profiles)[0];
    if (item.jobs.length !== plan.nodes.length || new Set(item.jobs.map((job: GraphJob) => job.node_id)).size !== plan.nodes.length || item.jobs.some((job: GraphJob) => !plan.nodes.some(node => node.id === job.node_id) || !Object.hasOwn(graphStateLabels,job.state) || typeof job.output !== 'string' || typeof job.conversation_id !== 'string' || !(job.task_id === null || typeof job.task_id === 'string'))) throw new Error('호스트의 작업별 실행 기록을 확인하지 못했습니다.');
    return { ...item, plan } as GraphRun;
  });
}
