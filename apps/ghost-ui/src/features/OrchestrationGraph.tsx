import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { AlertCircle, ArrowRight, CircleDot } from 'lucide-react';
import { SESSION_MODEL_ROLE, type OrchestrationConfig, type OrchestrationIssue } from '@ghost/contract';
import { issueText, nodeId, type NodeKey, type Position } from './OrchestrationModel';

export type Activity = { status: 'running' | 'done' | 'error'; elapsed: number; count: number };
type GraphNode = Position & { id: string; title: string; detail: string; key?: NodeKey; issues?: OrchestrationIssue[] };
type Edge = { from: GraphNode; to: GraphNode; kind: 'model' | 'delegate' | 'fallback'; rank?: number };
type Drag = { pointer: number; from: NodeKey; type: 'move' | 'link'; start: Position; initial: Position; moved: boolean };

const TOOLTIP_ROLE = '세션 모델';
const activityLabel = { running: '실행 중', done: '완료', error: '실패' } as const;
const nameOf = (name: string) => name === SESSION_MODEL_ROLE ? TOOLTIP_ROLE : name;

export function OrchestrationGraph({ config, selected, issues, activity, editable, onSelect, onConnect, onMove }: {
  config: OrchestrationConfig; selected: NodeKey | null; issues: OrchestrationIssue[]; activity: Map<string, Activity>; editable: boolean;
  onSelect(node: NodeKey): void; onConnect(from: string, to: string): void; onMove(node: NodeKey, position: Position): void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(680);
  const [pointer, setPointer] = useState<Position | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const marker = useId();
  useEffect(() => {
    const node = viewport.current!;
    const measure = () => setWidth(Math.max(324, node.clientWidth));
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    measure();
    return () => resize.disconnect();
  }, []);

  const compact = width < 490;
  const nodeWidth = compact ? 136 : 169;
  const nodeHeight = 65;
  const startY = 46;
  const gap = 90;
  const hasConcreteFallbacks = Object.values(config.fallbackChains).some(chain => chain.some(ref => !('role' in ref)));
  const xAgent = compact ? 25 : 34;
  const xRole = compact
    ? Math.max(xAgent + nodeWidth + 20, Math.min(Math.floor(width * .56), width - nodeWidth - 44))
    : Math.max(xAgent + nodeWidth + 64, Math.floor(width * (hasConcreteFallbacks ? .37 : .56)));
  const xFallback = Math.max(xRole + nodeWidth + (compact ? 44 : 65), Math.floor(width * .72));
  const agentNodes = new Map<string, GraphNode>();
  const roleNodes = new Map<string, GraphNode>();
  const fallbackNodes = new Map<string, GraphNode>();
  const edges: Edge[] = [];
  function nodeFor(key: NodeKey, index: number, x: number, title: string, detail: string): GraphNode {
    const configured = config.positions[key.kind][key.name];
    const position = pointer && drag.current?.type === 'move' && nodeId(drag.current.from) === nodeId(key) ? pointer : configured;
    return { id: nodeId(key), key, x: position?.x ?? x, y: position?.y ?? startY + index * gap, title, detail,
      issues: issues.filter(issue => issue.kind === (key.kind === 'agents' ? 'agent' : 'role') && issue.name === key.name) };
  }
  config.agents.forEach((agent, index) => agentNodes.set(agent.name, nodeFor({ kind: 'agents', name: agent.name }, index, xAgent, agent.name, nameOf(agent.modelRole))));
  Object.entries(config.modelRoles).forEach(([name, model], index) => roleNodes.set(name, nodeFor({ kind: 'roles', name }, index, xRole, nameOf(name), model.provider === null ? '현재 세션을 따름' : model.model || '모델 미지정')));
  for (const agent of config.agents) {
    const from = agentNodes.get(agent.name)!;
    const role = roleNodes.get(agent.modelRole);
    if (role) edges.push({ from, to: role, kind: 'model' });
    for (const target of agent.canDelegateTo) {
      const to = agentNodes.get(target);
      if (to) edges.push({ from, to, kind: 'delegate' });
    }
  }
  for (const [role, chain] of Object.entries(config.fallbackChains)) {
    const from = roleNodes.get(role);
    if (!from) continue;
    chain.forEach((entry, index) => {
      let to: GraphNode | undefined;
      if ('role' in entry) to = roleNodes.get(entry.role);
      else {
        const id = JSON.stringify([entry.provider, entry.model, entry.thinking]);
        to = fallbackNodes.get(id);
        if (!to) {
          to = { x: xFallback, y: startY + fallbackNodes.size * gap, id, title: entry.model || '모델 미지정', detail: [entry.provider, entry.thinking].filter(Boolean).join(' · ') };
          fallbackNodes.set(id, to);
        }
      }
      if (to) edges.push({ from, to, kind: 'fallback', rank: index + 1 });
    });
  }
  const nodes = [...agentNodes.values(), ...roleNodes.values(), ...fallbackNodes.values()];
  const graphWidth = Math.max(width, ...nodes.map(node => node.x + nodeWidth + 22));
  const graphHeight = Math.max(232, ...nodes.map(node => node.y + nodeHeight + 28));

  function choose(node: NodeKey) {
    if (editable && armed && node.kind === 'agents') {
      onConnect(armed, node.name);
      setArmed(null);
    }
    onSelect(node);
  }
  function begin(event: PointerEvent<HTMLButtonElement>, key: NodeKey, position: Position, type: Drag['type']) {
    if (!editable || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, from: key, type, start: { x: event.clientX, y: event.clientY }, initial: position, moved: false };
  }
  function movedPosition(active: Drag, dx: number, dy: number): Position {
    return { x: Math.max(4, Math.min(graphWidth - nodeWidth - 4, active.initial.x + dx)), y: Math.max(startY, active.initial.y + dy) };
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    const dx = event.clientX - active.start.x;
    const dy = event.clientY - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) < 5) return;
    active.moved = true;
    if (active.type === 'move') {
      setPointer(movedPosition(active, dx, dy));
    } else {
      const rect = surface.current!.getBoundingClientRect();
      setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
  }
  function end(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    if (active.moved) {
      if (active.type === 'move') onMove(active.from, movedPosition(active, event.clientX - active.start.x, event.clientY - active.start.y));
      else if (active.type === 'link') {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-agent]')?.dataset.agent;
        if (target && target !== active.from.name) onConnect(active.from.name, target);
      }
      // A pointer-generated click follows pointerup. Do not turn a drag into a selection.
      setTimeout(() => { if (drag.current === active) drag.current = null; }, 0);
    } else drag.current = null;
    setPointer(null);
  }
  function cancel() { drag.current = null; setPointer(null); }
  function keydown(event: KeyboardEvent<HTMLButtonElement>, node: GraphNode) {
    const offset = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] }[event.key];
    if (event.key === 'Escape') setArmed(null);
    if (!offset || !editable || !node.key) return;
    event.preventDefault();
    onMove(node.key, { x: Math.max(4, Math.min(graphWidth - nodeWidth - 4, node.x + offset[0]!)), y: Math.max(startY, node.y + offset[1]!) });
  }
  const linkSource = pointer && drag.current?.type === 'link' ? agentNodes.get(drag.current.from.name) : null;

  return <div className="orchestration-viewport" ref={viewport}>
    <div className="orchestration-surface" ref={surface} style={{ width: graphWidth, height: graphHeight }} role="group" aria-label="위임 그래프">
      <div className="orchestration-axis" style={{ left: xAgent }}>에이전트</div>
      <div className="orchestration-axis" style={{ left: xRole }}>모델 역할</div>
      {hasConcreteFallbacks && <div className="orchestration-axis" style={{ left: xFallback }}>대체 모델</div>}
      {agentNodes.size === 0 && <div className="orchestration-graph-empty" style={{ left: xAgent }}>에이전트 없음</div>}
      <svg width={graphWidth} height={graphHeight} aria-hidden="true" className="orchestration-wires">
        <defs><marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L7 4L1 7" fill="none" stroke="currentColor"/></marker></defs>
        {edges.map(({ from, to, kind, rank }, index) => {
          const side = kind === 'delegate' ? -1 : 1;
          const x1 = from.x + (side > 0 ? nodeWidth : 0);
          const x2 = to.x + (kind === 'delegate' ? 0 : kind === 'fallback' && to.key ? nodeWidth : 0);
          const y1 = from.y + nodeHeight / 2 + (rank ? Math.min(rank - 1, 8) * 3 : 0);
          const y2 = to.y + nodeHeight / 2;
          const bend = Math.max(kind === 'delegate' ? 18 : 27, Math.abs(x2 - x1) * .43);
          const c1 = x1 + side * bend, c2 = x2 + (kind === 'fallback' && to.key ? 1 : -1) * bend;
          const path = from === to ? `M${x1},${y1} C${x1 + side * 45},${y1 - 46} ${x1 + side * 45},${y1 + 46} ${x2},${y2 + 8}`
            : `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`;
          const selectedEdge = selected && (from.id === nodeId(selected) || to.id === nodeId(selected));
          return <g key={index} data-edge={kind} data-selected={selectedEdge || undefined}>
            <path d={path} fill="none" markerEnd={`url(#${marker})`}/>
            {rank && <text x={x1 + (x1 === x2 ? 21 + rank * 4 : (x2 - x1) / 2)} y={(y1 + y2) / 2 - 5}>{rank}</text>}
          </g>;
        })}
        {linkSource && pointer && <line x1={linkSource.x + nodeWidth - 11} y1={linkSource.y + nodeHeight - 11} x2={pointer.x} y2={pointer.y} className="orchestration-link-preview"/>}
      </svg>
      {nodes.map(node => {
        const key = node.key;
        const selectedNode = key && selected && nodeId(key) === nodeId(selected);
        const isAgent = key?.kind === 'agents';
        const warnings = node.issues ?? [];
        const status = isAgent ? activity.get(key.name) : undefined;
        const position = { left: node.x, top: node.y, width: nodeWidth, height: nodeHeight };
        const interior = <><span className="orchestration-node-name">{node.title}</span>
          <span className="orchestration-node-detail">{node.detail}</span>
          {warnings.length > 0 && <AlertCircle className="orchestration-node-warning" size={14}/>}
          {status && <span className="orchestration-node-activity"><CircleDot size={11}/>{activityLabel[status.status]}{status.count > 1 ? ` ${status.count}개` : ''} · {status.elapsed}초</span>}</>;
        const title = [node.title, node.detail, ...warnings.map(issueText)].join('\n');
        return key ? <div key={node.id} className="orchestration-node-wrap" style={position}>
          <button type="button" className="orchestration-node" data-kind={key.kind} data-agent={isAgent ? key.name : undefined} data-status={status?.status}
            aria-pressed={Boolean(selectedNode)} aria-description={warnings.length ? warnings.map(issueText).join(' ') : undefined}
            title={title} onClick={() => { if (!drag.current?.moved) choose(key); }}
            onKeyDown={event => keydown(event, node)} onPointerDown={event => begin(event, key, node, 'move')}
            onPointerMove={move} onPointerUp={end} onPointerCancel={cancel}>{interior}</button>
          {isAgent && editable && <button type="button" className="orchestration-port" aria-label={`${key.name}에서 위임 연결`} aria-pressed={armed === key.name}
            title="끌어서 위임 연결" onClick={() => { if (!drag.current?.moved) setArmed(armed === key.name ? null : key.name); }}
            onKeyDown={event => { if (event.key === 'Escape') setArmed(null); }}
            onPointerDown={event => begin(event, key, node, 'link')} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel}><ArrowRight size={13}/></button>}
        </div> : <div key={node.id} className="orchestration-node orchestration-fallback-node" style={position} title={title}>{interior}</div>;
      })}
    </div>
  </div>;
}
