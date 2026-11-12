import { useEffect, useState } from 'react';
import type { DocRef, PageSummary } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Choice, errorText, TextField } from './InfrastructureFields';

export function DocAttachments({ value, onChange, scopeId }: { value: DocRef[]; onChange(value: DocRef[]): void; scopeId?: string }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  return <fieldset className="infra-list"><legend>붙임</legend>
    <div className="infra-attachments">{value.map((ref, index) => <div className="infra-attachment" key={index}>
      <Choice label={`붙임 ${index + 1} 종류`} value={ref.kind} onChange={kind => onChange(value.map((item, at) => at !== index ? item : kind === 'skill' ? { kind: 'skill', name: '' } : { kind: 'page', scopeId: scopeId ?? state?.scopes[0]?.id ?? '', locator: '' }))} options={[{ value: 'page', label: '문서' }, { value: 'skill', label: '스킬' }]}/>
      {ref.kind === 'page' ? <>
        <Choice label={`붙임 ${index + 1} 프로젝트`} value={ref.scopeId} onChange={id => onChange(value.map((item, at) => at === index ? { kind: 'page', scopeId: id, locator: '' } : item))} required options={[{ value: '', label: '선택' }, ...(state?.scopes ?? []).filter(scope => scope.vaultPath).map(scope => ({ value: scope.id, label: scope.name }))]}/>
        <PageChoice scopeId={ref.scopeId} locator={ref.locator} label={`붙임 ${index + 1} 문서`} onChange={locator => onChange(value.map((item, at) => at === index ? { ...ref, locator } : item))}/>
      </> : <TextField label={`붙임 ${index + 1} 스킬 이름`} value={ref.name} onChange={name => onChange(value.map((item, at) => at === index ? { ...ref, name } : item))} required/>}
      <div className="infra-actions"><Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, at) => at !== index))}>붙임 삭제</Button></div>
    </div>)}</div>
    <Button type="button" variant="outline" size="sm" disabled={value.length >= 32} onClick={() => onChange([...value, { kind: 'page', scopeId: scopeId ?? state?.scopes.find(scope => scope.vaultPath)?.id ?? '', locator: '' }])}>붙임 추가</Button>
  </fieldset>;
}

function PageChoice({ scopeId, locator, onChange, label }: { scopeId: string; locator: string; onChange(value: string): void; label: string }) {
  const { client } = useHost();
  const [pages, setPages] = useState<PageSummary[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setPages([]); setError('');
    if (!scopeId) return;
    setLoading(true);
    client.pages(scopeId).then(items => { if (alive) setPages(items); }).catch(reason => { if (alive) setError(errorText(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, scopeId]);
  return <div className="infra-form">
    <Choice label={label} value={locator} onChange={onChange} required options={[{ value: '', label: loading ? '불러오는 중…' : '선택' }, ...(!pages.some(page => page.locator === locator) && locator ? [{ value: locator, label: locator }] : []), ...pages.map(page => ({ value: page.locator, label: page.title }))]}/>
    {error && <InlineError>{error}</InlineError>}
  </div>;
}
