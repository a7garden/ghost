import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Plus, SlidersHorizontal } from 'lucide-react';
import {
  ORCHESTRATION_MAX_CONCURRENCY, ORCHESTRATION_MAX_DEPTH, OrchestrationConfig as ConfigSchema, SESSION_MODEL_ROLE, orchestrationIssues, validate,
  type CodingSession, type OrchestrationConfig, type OrchestrationImportPreview, type OrchestrationView,
} from '@ghost/contract';
import { useHost } from '../host/context';
import { Button, InlineError, SkeletonRows } from '../ui';
import { OrchestrationGraph } from './OrchestrationGraph';
import { OrchestrationInspector } from './OrchestrationInspector';
import { addNode, connectAgents, issueText, moveNode, removeNode, renameNode, type NodeKey } from './OrchestrationModel';
import { useOrchestrationActivity } from './OrchestrationActivity';
import './Orchestration.css';

export const orchestrationPath = '/coding/orchestration';

export function Orchestration() {
  const { client } = useHost();
  const [stored, setStored] = useState<OrchestrationView | null>(null);
  const [draft, setDraft] = useState<OrchestrationConfig | null>(null);
  const [preview, setPreview] = useState<OrchestrationImportPreview | null>(null);
  const [selected, setSelected] = useState<NodeKey | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState(false);
  const inspector = useRef<HTMLDivElement>(null);
  const priorSelection = useRef<NodeKey | null>(null);
  const { sessions, activity } = useOrchestrationActivity(client);
  useEffect(() => {
    const abort = new AbortController();
    void client.orchestration(abort.signal).then(view => {
      if (abort.signal.aborted) return;
      setStored(view); setDraft(view.config);
      const agent = view.config.agents[0];
      setSelected(agent ? { kind: 'agents', name: agent.name } : { kind: 'roles', name: SESSION_MODEL_ROLE });
    }).catch(() => { if (!abort.signal.aborted) setError('오케스트레이션 설정을 불러오지 못했습니다.'); });
    return () => abort.abort();
  }, [client, reload]);

  const config = preview?.config ?? draft;
  const issues = config && stored ? orchestrationIssues(config, stored) : [];
  const structural = config ? orchestrationIssues(config) : [];
  const valid = config ? validate(ConfigSchema, config) : false;
  const dirty = draft !== stored?.config;
  const editable = !preview && !saving;

  function select(node: NodeKey, showInspector = false) {
    setSelected(node);
    if (showInspector && matchMedia('(max-width: 700px)').matches) {
      requestAnimationFrame(() => inspector.current?.scrollIntoView({ block: 'start' }));
    }
  }
  function change(next: OrchestrationConfig) {
    setDraft(next); setSaved(false); setError('');
  }
  async function save() {
    if (!draft || !stored || !valid || structural.length) return;
    setSaving(true); setError('');
    try {
      const config = await client.saveOrchestration(draft);
      setStored({ ...stored, config }); setDraft(config); setSaved(true);
    } catch { setError('설정을 저장하지 못했습니다. 화면의 변경은 남아 있습니다.'); }
    finally { setSaving(false); }
  }
  async function importOmp() {
    setImporting(true); setError('');
    try {
      const result = await client.previewOrchestrationImport();
      priorSelection.current = selected;
      setPreview(result);
      setSelected(result.config.agents[0] ? { kind: 'agents', name: result.config.agents[0].name } : { kind: 'roles', name: SESSION_MODEL_ROLE });
    } catch { setError('이 Mac의 omp 설정을 미리 볼 수 없습니다.'); }
    finally { setImporting(false); }
  }

  return <section className="orchestration" aria-label="오케스트레이션">
    <header className="orchestration-heading">
      <a href="#/coding" className="orchestration-back" aria-label="코딩 작업대로"><ArrowLeft size={17}/></a>
      <h1>오케스트레이션</h1>
      {config && <label className="orchestration-master"><input type="checkbox" role="switch" checked={config.enabled} disabled={!editable}
        onChange={event => change({ ...config, enabled: event.target.checked })}/>위임 사용</label>}
    </header>
    {error && <InlineError>{error}</InlineError>}
    {!config && (error ? <Button onClick={() => { setError(''); setReload(value => value + 1); }}>다시 불러오기</Button> : <SkeletonRows label="설정 불러오는 중…" rows={4}/>)}
    {config && stored && <>
      <div className="orchestration-toolbar">
        <div className="orchestration-actions">
          <Button variant="outline" size="sm" disabled={!editable || config.agents.length >= 128} onClick={() => {
            const result = addNode(config, 'agents'); change(result.config); select(result.node, true);
          }}><Plus size={15}/>에이전트</Button>
          <Button variant="outline" size="sm" disabled={!editable || Object.keys(config.modelRoles).length >= 128} onClick={() => {
            const result = addNode(config, 'roles', stored.models[0]); change(result.config); select(result.node, true);
          }}><Plus size={15}/>모델 역할</Button>
          <Button variant="ghost" size="sm" disabled={!editable || importing} onClick={() => void importOmp()}><Download size={15}/>omp 가져오기</Button>
        </div>
        <div className="orchestration-actions orchestration-save">
          <span role="status">{saved && !dirty && !preview ? '저장됨' : ''}</span>
          {!preview && dirty && <Button variant="ghost" size="sm" disabled={saving} onClick={() => { change(stored.config); setSelected(null); }}>변경 취소</Button>}
          {!preview && <Button size="sm" disabled={saving || !dirty || !valid || structural.length > 0} onClick={() => void save()}>{saving ? '저장 중…' : '저장'}</Button>}
        </div>
      </div>
      {preview && <section className="orchestration-preview" aria-label="omp 가져오기 미리보기">
        <div><strong>omp 가져오기 미리보기</strong><span> · 에이전트 {config.agents.length}개 · 모델 역할 {Object.keys(config.modelRoles).length}개</span></div>
        <div className="orchestration-actions">
          <Button size="sm" variant="outline" onClick={() => { setPreview(null); setSelected(priorSelection.current); }}>미리보기 닫기</Button>
          <Button size="sm" onClick={() => { change(preview.config); setPreview(null); }}>편집에 반영</Button>
        </div>
        {(preview.unmappable.length > 0 || preview.issues.length > 0) && <details>
          <summary>가져오기 확인 사항 ({preview.unmappable.length + preview.issues.length})</summary>
          {preview.unmappable.length > 0 && <><h3>가져오지 못한 항목</h3><ul>{preview.unmappable.map((field, i) => <li key={i}><code>{field}</code></li>)}</ul></>}
          {preview.issues.length > 0 && <ul>{preview.issues.map((issue, i) => <li key={i}><code>{issue.name}</code> · {issueText(issue)}</li>)}</ul>}
        </details>}
      </section>}
      <div className="orchestration-layout">
        <div className="orchestration-diagram">
          <OrchestrationGraph config={config} selected={selected} issues={issues} activity={activity} editable={editable}
            onSelect={node => select(node, true)} onMove={(node, position) => change(moveNode(config, node, position))}
            onConnect={(from, to) => change(connectAgents(config, from, to))}/>
          <div className="orchestration-legend"><span><i/>사용 모델</span><span><i data-line="delegate"/>위임</span><span><i data-line="fallback"/>대체 순서</span></div>
          <div className="orchestration-limits" aria-label="실행 한도">
            <SlidersHorizontal size={15} aria-hidden="true"/>
            <label>동시 실행<input type="number" min={1} max={ORCHESTRATION_MAX_CONCURRENCY} value={config.limits.maxConcurrency || ''} disabled={!editable}
              onChange={event => change({ ...config, limits: { ...config.limits, maxConcurrency: Number(event.target.value) } })}/></label>
            <label>위임 깊이<input type="number" min={1} max={ORCHESTRATION_MAX_DEPTH} value={config.limits.maxDepth || ''} disabled={!editable}
              onChange={event => change({ ...config, limits: { ...config.limits, maxDepth: Number(event.target.value) } })}/></label>
          </div>
          {!preview && <SessionPolicy sessions={sessions} globalEnabled={stored.config.enabled}/>}
          {dirty && !preview && (!valid || structural[0]) && <p className="orchestration-invalid" role="status">{structural[0] ? `${structural[0].name}: ${issueText(structural[0])}` : '비어 있거나 범위를 벗어난 설정을 확인하세요.'}</p>}
        </div>
        <div ref={inspector} className="orchestration-inspector-slot">
          <OrchestrationInspector key={selected ? `${selected.kind}:${selected.name}` : 'empty'} selected={selected} config={config} models={stored.models} issues={issues} preview={!editable}
            onConfig={change} onClose={() => setSelected(null)} onRemove={() => { if (selected) { change(removeNode(config, selected)); setSelected(null); } }}
            onRename={name => {
              if (!selected) return false;
              const next = renameNode(config, selected, name);
              if (!next) return false;
              if (next !== config) { change(next); setSelected({ ...selected, name }); }
              return true;
            }}/>
        </div>
      </div>
    </>}
  </section>;
}

function SessionPolicy({ sessions, globalEnabled }: { sessions: CodingSession[]; globalEnabled: boolean }) {
  const { client } = useHost();
  const [sessionId, setSessionId] = useState('');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();
    void client.orchestrationForSession(sessionId, undefined, abort.signal).then(result => {
      if (!abort.signal.aborted) setEnabled(result.enabled);
    }).catch(() => { if (!abort.signal.aborted) setError('세션 설정을 불러오지 못했습니다.'); });
    return () => abort.abort();
  }, [client, sessionId]);
  const available = sessions.some(session => session.id === sessionId);
  return <details className="orchestration-session-policy">
    <summary>세션별 위임</summary>
    {sessions.length === 0 ? <p>열린 코딩 세션이 없습니다.</p> : <>
      <label>코딩 세션<select value={available ? sessionId : ''} disabled={busy} onChange={event => { setEnabled(null); setError(''); setSessionId(event.target.value); }}>
        <option value="">세션 선택</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
      </select></label>
      {available && enabled !== null && <label className="orchestration-check"><input type="checkbox" role="switch" checked={enabled} disabled={busy}
        onChange={event => {
          setBusy(true); setError('');
          void client.orchestrationForSession(sessionId, event.target.checked).then(result => setEnabled(result.enabled))
            .catch(() => setError('세션 위임 설정을 저장하지 못했습니다.')).finally(() => setBusy(false));
        }}/> 이 세션에서 위임 허용</label>}
      {!globalEnabled && <p>전체 위임이 꺼져 있습니다.</p>}
    </>}
    {error && <InlineError>{error}</InlineError>}
  </details>;
}
