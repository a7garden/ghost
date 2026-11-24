import { useState } from 'react';
import { Button, InlineError, SettingsGroup } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { absoluteTime } from './time';
import { Choice, errorText } from './InfrastructureFields';
import { uiTerms } from '../uiText';
import { entityKindLabels, revisionChanges, revisionSentence, type ConfigEntity } from './configText';

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
  return <SettingsGroup title={uiTerms.configHistory}>
    {!scopeId && <div className="infra-editor"><Choice label="종류" value={filter} onChange={setFilter} options={kindOptions}/></div>}
    {error && <InlineError className="m-4">{error}</InlineError>}
    {notice && <p className="m-0 px-4 py-3 text-caption text-success" role="status">{notice}</p>}
    {!revisions.length && <p className="m-0 p-4 text-caption text-ink-3">변경 기록이 없습니다.</p>}
    <div className="grid min-w-0 gap-2.5">
      {revisions.map(revision => {
        const changes = revisionChanges(revision, state ?? null);
        return <article key={revision.id} className="grid min-w-0 gap-2 rounded-xl bg-surface p-4 shadow-card">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h3 className="m-0 text-ui font-semibold text-ink [overflow-wrap:anywhere]">{revisionSentence(revision, state ?? null)}</h3>
            <time className="text-caption text-ink-3">{absoluteTime(revision.at)}</time>
          </div>
          {(changes.created || changes.deleted || changes.lines.length > 0 || changes.extraCount > 0) && <ul className="m-0 grid list-none gap-1 p-0 text-caption text-ink-2">
            {changes.created && <li>새로 만듦</li>}
            {changes.deleted && <li>삭제함</li>}
            {changes.lines.map(line => <li key={line.label}>{line.label}: {line.before} → {line.after}</li>)}
            {changes.extraCount > 0 && <li>그 밖의 {changes.extraCount}개 항목</li>}
          </ul>}
          <details className="min-w-0 text-caption text-ink-3">
            <summary className="w-fit cursor-pointer select-none">기술 정보</summary>
            <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
              <div className="min-w-0"><p className="m-0 mb-1">변경 전</p><pre className="infra-json">{JSON.stringify(revision.before, null, 2)}</pre></div>
              <div className="min-w-0"><p className="m-0 mb-1">변경 후</p><pre className="infra-json">{JSON.stringify(revision.after, null, 2)}</pre></div>
            </div>
          </details>
          {confirm === revision.id
            ? <div className="grid gap-2">
              <p className="m-0 text-caption text-ink-2">이 변경 이전의 구성으로 되돌립니다. 그 뒤에 구성이 더 바뀌었다면 충돌로 중단됩니다.</p>
              <div className="infra-actions">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>취소</Button>
                <Button disabled={busy} onClick={() => void revert(revision.id)}>{busy ? '되돌리는 중…' : '변경 전으로 되돌리기'}</Button>
              </div>
            </div>
            : <div className="infra-actions"><Button variant="outline" size="sm" onClick={() => { setConfirm(revision.id); setError(''); }}>되돌리기</Button></div>}
        </article>;
      })}
    </div>
  </SettingsGroup>;
}
