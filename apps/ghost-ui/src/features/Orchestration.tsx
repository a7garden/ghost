import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowLeft, Download, Plus, SlidersHorizontal } from 'lucide-react';
import {
  ORCHESTRATION_MAX_CONCURRENCY, ORCHESTRATION_MAX_DEPTH, OrchestrationConfig as ConfigSchema, SESSION_MODEL_ROLE, orchestrationIssues, validate,
  type CodingSession, type OrchestrationConfig, type OrchestrationImportPreview, type OrchestrationImportSource,
  type OrchestrationImportSourceInfo, type OrchestrationView,
} from '@ghost/contract';
import { useHost } from '../host/context';
import { Button, InlineError, SkeletonRows } from '../ui';
import { uiTerms } from '../uiText';
import { OrchestrationGraph } from './OrchestrationGraph';
import { OrchestrationInspector } from './OrchestrationInspector';
import { addNode, connectAgents, issueText, moveNode, removeNode, renameNode, type NodeKey } from './OrchestrationModel';
import { mergeImport, selectableItems, type ImportSelection } from './OrchestrationImport';
import { useOrchestrationActivity } from './OrchestrationActivity';
import './Orchestration.css';

export function Orchestration({ importRequested, onImportOpened }: { importRequested: boolean; onImportOpened(): void }) {
  const { client } = useHost();
  const [stored, setStored] = useState<OrchestrationView | null>(null);
  const [draft, setDraft] = useState<OrchestrationConfig | null>(null);
  const [selected, setSelected] = useState<NodeKey | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState(false);
  const [sources, setSources] = useState<OrchestrationImportSourceInfo[] | null>(null);
  const [source, setSource] = useState<OrchestrationImportSource | null>(null);
  const [preview, setPreview] = useState<OrchestrationImportPreview | null>(null);
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const inspector = useRef<HTMLDivElement>(null);
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

  const config = draft;
  const issues = config && stored ? orchestrationIssues(config, stored) : [];
  const structural = config ? orchestrationIssues(config) : [];
  const valid = config ? validate(ConfigSchema, config) : false;
  const dirty = draft !== stored?.config;
  const editable = !saving;

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
  function closeImport() {
    setSources(null); setSource(null); setPreview(null); setSelection(null); setImportError('');
  }
  async function loadPreview(next: OrchestrationImportSource) {
    setImporting(true); setImportError(''); setSource(next); setPreview(null); setSelection(null);
    try {
      const result = await client.previewOrchestrationImport(next);
      setPreview(result);
      setSelection({ ...selectableItems(result.config), limits: true });
    } catch { setImportError('가져올 설정을 미리 볼 수 없습니다.'); }
    finally { setImporting(false); }
  }
  async function openImport() {
    setImporting(true); setImportError('');
    try {
      const listing = await client.orchestrationImportSources();
      const present = listing.sources.filter(entry => entry.available);
      if (!present.length) { setImportError('이 Mac에서 가져올 하네스를 찾지 못했습니다.'); return; }
      setSources(listing.sources);
      await loadPreview(present[0]!.source);
    } catch { setImportError('하네스 목록을 불러오지 못했습니다.'); }
    finally { setImporting(false); }
  }
  function applyImport() {
    if (!draft || !preview || !selection) return;
    change(mergeImport(draft, preview.config, selection));
    closeImport();
  }

  const startRequestedImport = useEffectEvent(() => {
    onImportOpened();
    void openImport();
  });
  useEffect(() => { if (importRequested) startRequestedImport(); }, [importRequested]);

  const toggle = (list: string[], name: string) => list.includes(name) ? list.filter(item => item !== name) : [...list, name];
  const available = sources?.filter(entry => entry.available) ?? [];

  return <section className="orchestration" aria-label={uiTerms.orchestration}>
    <header className="orchestration-heading">
      <a href="#/settings" className="orchestration-back" aria-label="설정으로"><ArrowLeft size={17}/></a>
      <h1>{uiTerms.orchestration}</h1>
      {config && <label className="orchestration-master"><input type="checkbox" role="switch" checked={config.enabled} disabled={!editable}
        onChange={event => change({ ...config, enabled: event.target.checked })}/>위임 사용</label>}
    </header>
    {error && <InlineError>{error}</InlineError>}
    {!config && (error ? <Button onClick={() => { setError(''); setReload(value => value + 1); }}>다시 불러오기</Button> : <SkeletonRows label="설정 불러오는 중…" rows={4}/>)}
    {config && stored && <>
      <div className="orchestration-toolbar">
        <div className="orchestration-actions">
          <Button variant="add" size="sm" disabled={!editable || config.agents.length >= 128} onClick={() => {
            const result = addNode(config, 'agents'); change(result.config); select(result.node, true);
          }}>에이전트</Button>
          <Button variant="add" size="sm" disabled={!editable || Object.keys(config.modelRoles).length >= 128} onClick={() => {
            const result = addNode(config, 'roles', stored.models[0]); change(result.config); select(result.node, true);
          }}>모델 역할</Button>
          <Button variant="ghost" size="sm" disabled={!editable || importing} onClick={() => void openImport()}><Download size={15}/>{uiTerms.importHarness}</Button>
        </div>
        <div className="orchestration-actions orchestration-save">
          <span role="status">{saved && !dirty ? '저장됨' : ''}</span>
          {dirty && <Button variant="ghost" size="sm" disabled={saving} onClick={() => { change(stored.config); setSelected(null); }}>변경 취소</Button>}
          <Button size="sm" disabled={saving || !dirty || !valid || structural.length > 0} onClick={() => void save()}>{saving ? '저장 중…' : '저장'}</Button>
        </div>
      </div>
      {sources && <section className="orchestration-import" aria-label="하네스 가져오기">
        <div className="orchestration-import-head">
          <strong>하네스 가져오기</strong>
          <Button variant="ghost" size="sm" disabled={importing} onClick={closeImport}>닫기</Button>
        </div>
        <div className="orchestration-import-sources" role="radiogroup" aria-label="가져오기 소스">
          {available.map(entry => <label key={entry.source} className="orchestration-check">
            <input type="radio" name="orchestration-import-source" checked={source === entry.source} disabled={importing}
              onChange={() => void loadPreview(entry.source)}/>{entry.label} · 에이전트 {entry.agents}개
          </label>)}
        </div>
        {importing && <p className="orchestration-import-status" role="status">불러오는 중…</p>}
        {importError && <InlineError>{importError}</InlineError>}
        {preview && selection && <>
          <div className="orchestration-import-groups">
            {preview.config.agents.length > 0 && <fieldset>
              <legend>에이전트</legend>
              {preview.config.agents.map(agent => <label key={agent.name} className="orchestration-check">
                <input type="checkbox" checked={selection.agents.includes(agent.name)} aria-label={`에이전트 ${agent.name}`}
                  onChange={() => setSelection({ ...selection, agents: toggle(selection.agents, agent.name) })}/>
                <span className="orchestration-import-item"><strong>{agent.name}</strong><small>{agent.description}</small></span>
              </label>)}
            </fieldset>}
            {selectableItems(preview.config).roles.length > 0 && <fieldset>
              <legend>모델 역할</legend>
              {Object.entries(preview.config.modelRoles).filter(([name]) => name !== SESSION_MODEL_ROLE).map(([name, model]) => <label key={name} className="orchestration-check">
                <input type="checkbox" checked={selection.roles.includes(name)} aria-label={`모델 역할 ${name}`}
                  onChange={() => setSelection({ ...selection, roles: toggle(selection.roles, name) })}/>
                <span className="orchestration-import-item"><strong>{name}</strong>
                  <small>{model.provider === null ? '현재 세션을 따름' : `${model.provider}/${model.model}`}</small></span>
              </label>)}
            </fieldset>}
            {selectableItems(preview.config).fallbacks.length > 0 && <fieldset>
              <legend>대체 모델</legend>
              {Object.entries(preview.config.fallbackChains).map(([role, chain]) => <label key={role} className="orchestration-check">
                <input type="checkbox" checked={selection.fallbacks.includes(role)} aria-label={`대체 모델 ${role}`}
                  onChange={() => setSelection({ ...selection, fallbacks: toggle(selection.fallbacks, role) })}/>
                <span className="orchestration-import-item"><strong>{role}</strong>
                  <small>{chain.map(entry => 'role' in entry ? `@${entry.role}` : `${entry.provider}/${entry.model}`).join(' → ')}</small></span>
              </label>)}
            </fieldset>}
            <fieldset>
              <legend>한도</legend>
              <label className="orchestration-check">
                <input type="checkbox" checked={selection.limits} aria-label="실행 한도" onChange={() => setSelection({ ...selection, limits: !selection.limits })}/>
                <span className="orchestration-import-item"><strong>동시 실행 {preview.config.limits.maxConcurrency} · 위임 깊이 {preview.config.limits.maxDepth}</strong></span>
              </label>
            </fieldset>
          </div>
          {(preview.unmappable.length > 0 || preview.issues.length > 0) && <details className="orchestration-import-notes">
            <summary>가져오기 확인 사항 ({preview.unmappable.length + preview.issues.length})</summary>
            {preview.unmappable.length > 0 && <><h3>가져오지 못한 항목</h3><ul>{preview.unmappable.map((field, i) => <li key={i}><code>{field}</code></li>)}</ul></>}
            {preview.issues.length > 0 && <ul>{preview.issues.map((issue, i) => <li key={i}><code>{issue.name}</code> · {issueText(issue)}</li>)}</ul>}
          </details>}
          <div className="orchestration-actions">
            <Button size="sm" disabled={importing} onClick={applyImport}>편집에 반영</Button>
          </div>
        </>}
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
          <SessionPolicy sessions={sessions} globalEnabled={stored.config.enabled}/>
          {dirty && (!valid || structural[0]) && <p className="orchestration-invalid" role="status">{structural[0] ? `${structural[0].name}: ${issueText(structural[0])}` : '비어 있거나 범위를 벗어난 설정을 확인하세요.'}</p>}
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
    <summary>코딩 세션별 위임</summary>
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
