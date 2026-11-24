import { useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DocRef, Scope, State } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';
import { FolderField, FolderList } from '../components/FolderPicker';
import { HoldButton } from '../components/projects/HoldButton';
import { DocAttachments } from './DocAttachments';
import { Activities } from './Activities';
import { PolicySettings } from './PolicySettings';
import { LimitSettings } from './LimitSettings';
import { ScopeMetrics } from './ScopeMetrics';
import { ConfigHistory } from './ConfigHistory';
import { errorText } from './InfrastructureFields';

/** The machinery behind a project, one drill-in each; the settings page itself holds only what the owner edits by hand. */
export const settingsParts = [
  { id: 'triggers', label: uiTerms.activities },
  { id: 'rules', label: uiTerms.rules },
  { id: 'limits', label: uiTerms.limits },
  { id: 'metrics', label: uiTerms.metrics },
  { id: 'history', label: uiTerms.configHistory },
] as const;

function summaryOf(id: (typeof settingsParts)[number]['id'], scope: Scope, state: State | null): string {
  if (!state) return '';
  switch (id) {
    case 'triggers': {
      const own = (state.activities ?? []).filter(activity => activity.scopeId === scope.id && activity.deletedAt === null);
      return own.length ? `${own.length}개 · ${own.filter(activity => !activity.paused).length}개 켜짐` : '없음';
    }
    case 'rules': {
      const own = state.policyRules.filter(rule => rule.scopeId === scope.id);
      return own.length ? `이 프로젝트만 ${own.length}개` : '전체 규칙을 따름';
    }
    case 'limits': return Object.keys(scope.limits).length ? `${Object.keys(scope.limits).length}개 따로 정함` : '전체 설정을 따름';
    default: return '';
  }
}

/** The project's setup on one page: values edit where they are and save as they change. */
export function ProjectSettings({ scope, part, onPart, navigate, onDeleted }: {
  scope: Scope; part: string; onPart(id: string): void; navigate(path: string): void; onDeleted(): void;
}) {
  const drill = settingsParts.find(item => item.id === part);
  if (drill) return <div className="project-settings">
    <button type="button" className="project-back" onClick={() => onPart('settings')}><ChevronLeft size={16} aria-hidden="true"/>{uiTerms.settings}</button>
    {part === 'triggers' && <Activities scopeId={scope.id} navigate={navigate}/>}
    {part === 'rules' && <PolicySettings scopeId={scope.id}/>}
    {part === 'limits' && <LimitSettings scopeId={scope.id}/>}
    {part === 'metrics' && <ScopeMetrics scopeId={scope.id}/>}
    {part === 'history' && <ConfigHistory scopeId={scope.id}/>}
  </div>;
  return <div className="project-settings">
    <BasicRows scope={scope}/>
    <Machinery scope={scope} onPart={onPart}/>
    <DeleteProject scope={scope} onDeleted={onDeleted}/>
  </div>;
}

function BasicRows({ scope }: { scope: Scope }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [saved, setSaved] = useState<string | null>(null), [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const ghosts = (state?.ghosts ?? []).filter(ghost => ghost.state === 'active' && !ghost.deletedAt);
  const save = async (key: string, patch: Partial<Pick<Scope, 'ghostId' | 'state' | 'paths' | 'vaultPath' | 'attachments'>>) => {
    setError('');
    try {
      await client.send({ type: 'scope.update', scopeId: scope.id, ...patch });
      setSaved(key); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setSaved(null), 1800);
    } catch (reason) { setError(errorText(reason)); }
  };
  const row = (key: string, label: string, control: ReactNode) => <div className="project-row" key={key}>
    <div className="project-row__label">{label}<span className="project-row__saved" role="status">{saved === key ? '저장됨' : ''}</span></div>
    <div className="project-row__control">{control}</div>
  </div>;
  return <section className="project-rows" aria-label="기본 정보">
    {row('ghost', '받을 Ghost', <select className="infra-select" aria-label="받을 Ghost" value={scope.ghostId ?? ''} onChange={event => void save('ghost', { ghostId: event.target.value || null })}>
      <option value="">기본 Ghost</option>{ghosts.map(ghost => <option key={ghost.id} value={ghost.id}>{ghost.name}</option>)}
    </select>)}
    {row('state', '상태', <select className="infra-select" aria-label="상태" value={scope.state} onChange={event => void save('state', { state: event.target.value as Scope['state'] })}>
      <option value="active">진행</option><option value="paused">멈춤</option>
    </select>)}
    {row('paths', '읽을 폴더', <FolderList label="읽을 폴더" showLabel={false} values={scope.paths} onChange={paths => void save('paths', { paths })}/>)}
    {row('vault', '문서 금고', <FolderField label="문서 금고 경로" showLabel={false} optional value={scope.vaultPath ?? ''} onChange={path => void save('vault', { vaultPath: path || null })}/>)}
    {row('attachments', '함께 읽을 자료', <ReferenceDocs scope={scope} onSave={refs => save('attachments', { attachments: refs })}/>)}
    {error && <InlineError>{error}</InlineError>}
  </section>;
}

/** The documents and skills every conversation and Work in this project reads along; edited as a draft, saved once. */
function ReferenceDocs({ scope, onSave }: { scope: Scope; onSave(refs: DocRef[]): Promise<void> }) {
  const [draft, setDraft] = useState<DocRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (draft === null) return <div className="project-row__summary">
    <span>{scope.attachments.length ? `${scope.attachments.length}개` : '없음'}</span>
    <Button variant="ghost" size="sm" onClick={() => setDraft(scope.attachments)}>{scope.attachments.length ? '편집' : '추가'}</Button>
  </div>;
  return <div className="grid gap-3">
    <DocAttachments label="함께 읽을 자료" value={draft} onChange={setDraft} scopeId={scope.id}/>
    <div className="infra-actions">
      <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>취소</Button>
      <Button disabled={busy} onClick={() => { setBusy(true); void onSave(draft).then(() => setDraft(null)).finally(() => setBusy(false)); }}>저장</Button>
    </div>
  </div>;
}

function Machinery({ scope, onPart }: { scope: Scope; onPart(id: string): void }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  return <section className="project-machinery" aria-label={uiTerms.advanced}>
    <h2 className="section-title">{uiTerms.advanced}</h2>
    <div>{settingsParts.map(item => <button key={item.id} type="button" className="project-drill" onClick={() => onPart(item.id)}>
      <span>{item.label}</span><span className="project-drill__summary">{summaryOf(item.id, scope, state)}</span><ChevronRight size={15} aria-hidden="true"/>
    </button>)}</div>
  </section>;
}

function DeleteProject({ scope, onDeleted }: { scope: Scope; onDeleted(): void }) {
  const { client } = useHost();
  const [armed, setArmed] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const remove = async () => {
    setPending(true); setError('');
    try { await client.send({ type: 'scope.delete', scopeId: scope.id }); onDeleted(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '삭제하지 못했습니다.'); } finally { setPending(false); }
  };
  return <section className="project-delete" aria-label="프로젝트 삭제">
    {!armed ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => setArmed(true)}>프로젝트 삭제</Button>
      : <div className="project-delete__strip"><p>{scope.name} 프로젝트 등록을 지울까요? 보관함의 문서는 지워지지 않습니다.</p>
        <div className="project-delete__row"><Button variant="outline" size="sm" disabled={pending} onClick={() => setArmed(false)}>취소</Button><HoldButton label="삭제" holdingLabel="누르는 중" disabled={pending} onComplete={() => void remove()}/></div></div>}
    {error && <InlineError>{error}</InlineError>}
  </section>;
}
