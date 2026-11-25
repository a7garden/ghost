import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { ORCHESTRATION_READ_TOOLS, ORCHESTRATION_TOOLS, SESSION_MODEL_ROLE, type OrchestrationAgent, type OrchestrationConfig, type OrchestrationFallback, type OrchestrationIssue, type OrchestrationModelRef, type OrchestrationView } from '@ghost/contract';
import { Button } from '../ui';
import { connectAgents, issueText, nodeId, reorderFallback, type NodeKey } from './OrchestrationModel';

export function OrchestrationInspector({ selected, config, models, issues, preview, onConfig, onRename, onRemove, onClose }: {
  selected: NodeKey | null; config: OrchestrationConfig; models: OrchestrationView['models']; issues: OrchestrationIssue[]; preview: boolean;
  onConfig(config: OrchestrationConfig): void; onRename(name: string): boolean; onRemove(): void; onClose(): void;
}) {
  if (!selected) return <aside className="orchestration-inspector orchestration-inspector-empty"><p>편집할 노드를 선택하세요.</p></aside>;
  const { name, kind } = selected;
  const agent = kind === 'agents' ? config.agents.find(agent => agent.name === name) : undefined;
  const role = kind === 'roles' && Object.hasOwn(config.modelRoles, name) ? config.modelRoles[name] : undefined;
  if (!agent && !role) return null;
  const fixed = kind === 'roles' && name === SESSION_MODEL_ROLE;
  const title = fixed ? '세션 모델' : name;
  const notes = issues.filter(issue => issue.name === name && issue.kind === (agent ? 'agent' : 'role'));
  const updateAgent = (patch: Partial<OrchestrationAgent>) => onConfig({ ...config, agents: config.agents.map(row => row === agent ? { ...row, ...patch } : row) });
  const chain = Object.hasOwn(config.fallbackChains, name) ? config.fallbackChains[name]! : [];
  const updateChain = (next: OrchestrationFallback[]) => onConfig({ ...config, fallbackChains: { ...config.fallbackChains, [name]: next } });
  return <aside className="orchestration-inspector" aria-label="노드 설정">
    <header><h2>{title}</h2><Button variant="ghost" size="icon" aria-label="노드 설정 닫기" onClick={onClose}><X size={16}/></Button></header>
    {notes.length > 0 && <ul className="orchestration-issues">{notes.map((issue, i) => <li key={i} data-warning={['model', 'thinking', 'credential'].includes(issue.code) || undefined}>{issueText(issue)}</li>)}</ul>}
    <fieldset disabled={preview}>
      {!fixed && <Rename key={nodeId(selected)} name={name} onRename={onRename}/>}
      {agent && <>
        <label>설명<input value={agent.description} maxLength={400} onChange={event => updateAgent({ description: event.target.value })}/></label>
        <label>모델 역할<select value={agent.modelRole} onChange={event => updateAgent({ modelRole: event.target.value })}>
          {!Object.hasOwn(config.modelRoles, agent.modelRole) && <option value={agent.modelRole}>{agent.modelRole} (없음)</option>}
          {Object.keys(config.modelRoles).map(roleName => <option key={roleName} value={roleName}>{roleName === SESSION_MODEL_ROLE ? '세션 모델' : roleName}</option>)}
        </select></label>
        <label>지시<textarea value={agent.instructions} maxLength={40_000} rows={4} onChange={event => updateAgent({ instructions: event.target.value })}/></label>
        <label className="orchestration-check"><input type="checkbox" checked={agent.readOnly} onChange={event => {
          const readOnly = event.target.checked;
          updateAgent({ readOnly, tools: readOnly ? agent.tools.filter(tool => (ORCHESTRATION_READ_TOOLS as readonly string[]).includes(tool)) : agent.tools });
        }}/> 읽기 전용</label>
        <div className="orchestration-fields" role="group" aria-label="허용 도구"><h3>허용 도구</h3>
          <div className="orchestration-tools">{ORCHESTRATION_TOOLS.map(tool => <label className="orchestration-check" key={tool}>
            <input type="checkbox" checked={agent.tools.includes(tool)} disabled={agent.readOnly && !(ORCHESTRATION_READ_TOOLS as readonly string[]).includes(tool)}
              onChange={event => updateAgent({ tools: event.target.checked ? [...agent.tools, tool] : agent.tools.filter(item => item !== tool) })}/>{tool}
          </label>)}</div>
        </div>
        <div className="orchestration-fields" role="group" aria-label="위임 대상"><h3>위임 대상</h3>
          {config.agents.filter(target => target.name !== name).map(target => <label key={target.name} className="orchestration-check">
            <input type="checkbox" checked={agent.canDelegateTo.includes(target.name)} onChange={event => onConfig(connectAgents(config, name, target.name, event.target.checked))}/>{target.name}
          </label>)}
          {config.agents.length === 1 && <p>다른 에이전트를 추가하면 연결할 수 있습니다.</p>}
        </div>
      </>}
      {role && <>
        {role.provider === null ? <p>현재 세션의 모델과 사고 수준을 따릅니다.</p> : <ModelFields model={role} models={models} onChange={next => onConfig({ ...config, modelRoles: { ...config.modelRoles, [name]: next } })}/>}
        <FallbackEditor chain={chain} roles={Object.keys(config.modelRoles).filter(role => role !== name)} models={models} onChange={updateChain}/>
      </>}
      {!fixed && <Button type="button" variant="ghost" className="orchestration-remove" onClick={onRemove}><Trash2 size={14}/>{agent ? '에이전트 삭제' : '모델 역할 삭제'}</Button>}
    </fieldset>
  </aside>;
}

function Rename({ name, onRename }: { name: string; onRename(name: string): boolean }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState(false);
  const commit = () => setError(!onRename(value.trim()));
  return <label>이름<input value={value} maxLength={80} onChange={event => { setValue(event.target.value); setError(false); }}
    onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} aria-invalid={error || undefined}/>
    {error && <small className="orchestration-invalid">영문·숫자로 시작하는 중복되지 않은 이름을 입력하세요.</small>}
  </label>;
}

const thinkingNames = { off: '끔', low: '낮음', medium: '중간', high: '높음' } as const;
function ModelFields({ model, models, onChange }: { model: OrchestrationModelRef; models: OrchestrationView['models']; onChange(model: OrchestrationModelRef): void }) {
  const reference = models.find(row => row.provider === model.provider && row.model === model.model);
  const matching = models.filter(row => row.provider === model.provider);
  const key = `${model.provider}/${model.model}`;
  const options = reference?.thinking ?? (Object.keys(thinkingNames) as (keyof typeof thinkingNames)[]);
  return <>
    {models.length > 0 && <label>등록된 모델<select value={reference ? key : ''} onChange={event => {
      const selected = models.find(row => `${row.provider}/${row.model}` === event.target.value);
      if (selected) onChange({ provider: selected.provider, model: selected.model, thinking: null });
    }}><option value="">직접 입력</option>{models.map(row => <option key={`${row.provider}/${row.model}`} value={`${row.provider}/${row.model}`}>{row.name} · {row.provider}</option>)}</select></label>}
    <label>제공자<input value={model.provider} maxLength={120} onChange={event => onChange({ ...model, provider: event.target.value })} aria-invalid={!model.provider || undefined}/></label>
    <label>모델<input value={model.model} maxLength={240} list={matching.length ? 'orchestration-model-ids' : undefined}
      onChange={event => onChange({ ...model, model: event.target.value })} aria-invalid={!model.model || undefined}/></label>
    {matching.length > 0 && <datalist id="orchestration-model-ids">{matching.map(row => <option key={row.model} value={row.model}/>)}</datalist>}
    <label>사고 수준<select value={model.thinking ?? ''} onChange={event => {
      const thinking = event.target.value as OrchestrationModelRef['thinking'];
      onChange({ ...model, thinking: thinking || null });
    }}><option value="">모델 기본값</option>
      {model.thinking && !options.includes(model.thinking) && <option value={model.thinking}>{thinkingNames[model.thinking]} (지원하지 않음)</option>}
      {options.map(level => <option key={level} value={level}>{thinkingNames[level]}</option>)}
    </select></label>
  </>;
}

function FallbackEditor({ chain, roles, models, onChange }: {
  chain: OrchestrationFallback[]; roles: string[]; models: OrchestrationView['models']; onChange(chain: OrchestrationFallback[]): void;
}) {
  const dragged = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const entry = chain[selected];
  function reorder(from: number, to: number) {
    if (from === selected) setSelected(to);
    else if (from < selected && to >= selected) setSelected(selected - 1);
    else if (from > selected && to <= selected) setSelected(selected + 1);
    onChange(reorderFallback(chain, from, to));
  }
  return <div className="orchestration-fields">
    <h3>대체 순서</h3>
    {chain.length === 0 && <p>대체 모델 없음</p>}
    <ol className="orchestration-chain">
      {chain.map((model, index) => <li key={index} data-drop={over === index || undefined} onDragOver={event => {
        if (dragged.current === null) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(index);
      }} onDrop={event => {
        event.preventDefault();
        if (dragged.current !== null) reorder(dragged.current, index);
        dragged.current = null; setOver(null);
      }}>
        <span className="orchestration-grip" draggable onDragStart={event => {
          if (event.currentTarget.closest('fieldset')?.disabled) { event.preventDefault(); return; }
          dragged.current = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index));
        }} onDragEnd={() => { dragged.current = null; setOver(null); }} title="끌어서 순서 바꾸기"><GripVertical size={14}/></span>
        <button type="button" className="orchestration-chain-name" title={'role' in model ? `@${model.role}` : `${model.provider}/${model.model}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>
          <span>{index + 1}</span>{'role' in model ? `@${model.role}` : model.model || '모델 미지정'}
        </button>
        <button type="button" aria-label={`대체 ${index + 1} 위로`} disabled={index === 0} onClick={() => reorder(index, index - 1)}><ArrowUp size={14}/></button>
        <button type="button" aria-label={`대체 ${index + 1} 아래로`} disabled={index === chain.length - 1} onClick={() => reorder(index, index + 1)}><ArrowDown size={14}/></button>
        <button type="button" aria-label={`대체 ${index + 1} 삭제`} onClick={() => { setSelected(Math.max(0, selected > index ? selected - 1 : Math.min(selected, chain.length - 2))); onChange(chain.filter((_, i) => i !== index)); }}><X size={14}/></button>
      </li>)}
    </ol>
    {entry && <div className="orchestration-fallback-inputs">
      <label>대체 {selected + 1}<select value={'role' in entry ? entry.role : ''} onChange={event => onChange(chain.map((row, index) => index !== selected ? row
        : event.target.value ? { role: event.target.value } : { provider: '', model: '', thinking: null }))}>
        <option value="">직접 모델 지정</option>
        {roles.map(role => <option key={role} value={role}>{role === SESSION_MODEL_ROLE ? '세션 모델' : role}</option>)}
        {'role' in entry && !roles.includes(entry.role) && <option value={entry.role}>{entry.role}</option>}
      </select></label>
      {!('role' in entry) && <ModelFields model={entry} models={models} onChange={next => onChange(chain.map((row, index) => index === selected ? next : row))}/>}
    </div>}
    <Button type="button" size="sm" variant="outline" disabled={chain.length >= 32} onClick={() => {
      const first = models[0];
      setSelected(chain.length);
      onChange([...chain, { provider: first?.provider ?? '', model: first?.model ?? '', thinking: null }]);
    }}>대체 모델 추가</Button>
  </div>;
}
