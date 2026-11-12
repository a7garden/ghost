import { useState } from 'react';
import type { ConfigRevision } from '@ghost/contract';
import { Button, InlineError, SettingsGroup } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { absoluteTime } from './time';
import { Choice, errorText } from './InfrastructureFields';

const entities = [{ value: '', label: '전체' }, { value: 'scope', label: '프로젝트' }, { value: 'ghost', label: 'Ghost' }, { value: 'rule', label: '정책 규칙' }, { value: 'slot', label: '모델 자리' }, { value: 'mcp', label: 'MCP 서버' }, { value: 'activity', label: '계기' }, { value: 'limits', label: '한도' }];

export function ConfigHistory({ scopeId }: { scopeId?: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [filter, setFilter] = useState(''), [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const revisions = (state?.configRevisions ?? []).filter(revision => (!filter || revision.entity === filter) && (!scopeId || (revision.entity === 'scope' || revision.entity === 'limits') && revision.entityId === scopeId)).sort((a, b) => b.at - a.at);
  const name = (revision: ConfigRevision) => {
    const after = revision.after as { name?: unknown } | null, before = revision.before as { name?: unknown } | null;
    const stored = after?.name ?? before?.name;
    return typeof stored === 'string' ? stored : revision.entityId ?? '전체';
  };
  const revert = async (revisionId: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await client.send({ type: 'config.revert', revisionId }); setConfirm(null); setNotice('변경 전 구성으로 되돌렸습니다.'); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <SettingsGroup title="구성 기록">
    {!scopeId && <Choice label="구성 종류" value={filter} onChange={setFilter} options={entities.map(item => item.value ? item : { ...item, label: '전체' })}/>}
    {error && <InlineError>{error}</InlineError>}{notice && <p role="status">{notice}</p>}
    {!revisions.length && <p className="infra-record__meta">구성 변경 기록이 없습니다.</p>}
    <div className="infra-history">{revisions.map(revision => <article className="infra-record" key={revision.id}>
      <div className="infra-record__head"><h3>{entities.find(item => item.value === revision.entity)?.label} · {name(revision)}</h3><time className="infra-record__meta">{absoluteTime(revision.at)}</time></div>
      <p className="infra-record__meta">{revision.actor.kind === 'owner' ? '소유자' : revision.actor.kind === 'ghost' ? state?.ghosts.find(ghost => ghost.id === revision.actor.id)?.name ?? 'Ghost' : '기기'}{revision.reason ? ` · ${revision.reason}` : ''}</p>
      <details><summary>변경 내용</summary><div className="infra-columns"><div><h4>변경 전</h4><pre>{JSON.stringify(revision.before, null, 2)}</pre></div><div><h4>변경 후</h4><pre>{JSON.stringify(revision.after, null, 2)}</pre></div></div></details>
      {confirm === revision.id ? <div className="infra-delete"><p>이 변경 전 구성으로 되돌릴까요? 이후에 구성이 달라졌다면 충돌로 중단됩니다.</p><div className="infra-actions"><Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>취소</Button><Button disabled={busy} onClick={() => void revert(revision.id)}>{busy ? '되돌리는 중…' : '변경 전으로 되돌리기'}</Button></div></div>
        : <div><Button variant="outline" size="sm" onClick={() => { setConfirm(revision.id); setError(''); }}>되돌리기</Button></div>}
    </article>)}</div>
  </SettingsGroup>;
}
