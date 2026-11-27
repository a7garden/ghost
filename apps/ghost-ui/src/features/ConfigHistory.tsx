import { useState } from 'react';
import { History, Minus, Plus } from 'lucide-react';
import { Button, InlineError, SkeletonRows } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { absoluteTime } from './time';
import { Choice, errorText } from './InfrastructureFields';
import { uiTerms } from '../uiText';
import { entityKindLabels, revisionChanges, revisionSentence, type ConfigEntity } from './configText';
import './SettingsLists.css';

const kindOptions: { value: string; label: string }[] = [
  { value: '', label: '전체' },
  ...(Object.entries(entityKindLabels) as [ConfigEntity, string][]).map(([value, label]) => ({ value, label })),
];

/** 「변경 기록」: 누가 무엇을 바꿨는지 한 문장으로, 무엇이 바뀌었는지 짧은 목록으로 읽는 타임라인. */
export function ConfigHistory({ scopeId }: { scopeId?: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [filter, setFilter] = useState(''), [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const revisions = (state?.configRevisions ?? []).filter(revision => {
    if (filter && revision.entity !== filter) return false;
    if (!scopeId) return true;
    if ((revision.entity === 'scope' || revision.entity === 'limits') && revision.entityId === scopeId) return true;
    return [revision.before, revision.after].some(value => value !== null && typeof value === 'object' && 'scopeId' in value && value.scopeId === scopeId);
  }).sort((a, b) => b.at - a.at);
  const revert = async (revisionId: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await client.send({ type: 'config.revert', revisionId }); setConfirm(null); setNotice('변경 전 구성으로 되돌렸습니다.'); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <section className="settings-list-page" aria-label={uiTerms.configHistory}>
    <div className="settings-list__lead">
      {state && <p className="settings-list__verdict">{revisions.length ? `변경 ${revisions.length}건` : '변경 기록 없음'}</p>}
      {!scopeId && <div className="settings-list__actions"><Choice label="종류" value={filter} onChange={setFilter} options={kindOptions}/></div>}
    </div>
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {!state && <SkeletonRows label="변경 기록을 불러오는 중…" rows={2}/>}
    {revisions.length > 0 && <ul className="settings-list" role="list">
      {revisions.map(revision => {
        const changes = revisionChanges(revision, state ?? null);
        return <li key={revision.id} data-selected={confirm === revision.id || undefined}><article>
          <div className="settings-list__row">
            <span className="settings-list__mark" aria-hidden="true">{changes.created ? <Plus size={16}/> : changes.deleted ? <Minus size={16}/> : <History size={16}/>}</span>
            <div className="settings-list__copy">
              <h3 className="settings-list__title">{revisionSentence(revision, state ?? null)}</h3>
              <time className="settings-list__meta" dateTime={new Date(revision.at).toISOString()}>{absoluteTime(revision.at)}</time>
            </div>
            {confirm !== revision.id && <div className="settings-list__actions">
              <Button variant="ghost" size="sm" onClick={() => { setConfirm(revision.id); setError(''); }}>되돌리기</Button>
            </div>}
          </div>
          <div className="settings-list__branch">
          {(changes.lines.length > 0 || changes.extraCount > 0) && <ul className="m-0 grid list-none gap-1 p-0 text-caption text-ink-2 [overflow-wrap:anywhere]">
            {changes.lines.map(line => <li key={line.label}>{line.label}: {line.before} → {line.after}</li>)}
            {changes.extraCount > 0 && <li>그 밖의 {changes.extraCount}개 항목</li>}
          </ul>}
          <details className="settings-list__disclosure">
            <summary>기술 정보</summary>
            <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
              <div className="min-w-0"><p className="m-0 mb-1">변경 전</p><pre className="infra-json">{JSON.stringify(revision.before, null, 2)}</pre></div>
              <div className="min-w-0"><p className="m-0 mb-1">변경 후</p><pre className="infra-json">{JSON.stringify(revision.after, null, 2)}</pre></div>
            </div>
          </details>
          {confirm === revision.id && <div className="grid gap-2">
              <p className="m-0 text-caption text-ink-2">이 변경 이전의 구성으로 되돌립니다. 그 뒤에 구성이 더 바뀌었다면 충돌로 중단됩니다.</p>
              <div className="settings-list__actions">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>취소</Button>
                <Button disabled={busy} onClick={() => void revert(revision.id)}>{busy ? '되돌리는 중…' : '변경 전으로 되돌리기'}</Button>
              </div>
            </div>}
          </div>
        </article></li>;
      })}
    </ul>}
  </section>;
}
