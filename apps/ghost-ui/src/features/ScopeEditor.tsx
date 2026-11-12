import { useState, type FormEvent } from 'react';
import type { DocRef, Limits, Scope } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Choice, EditorActions, errorText, StringList, TextField } from './InfrastructureFields';
import { DocAttachments } from './DocAttachments';
import { LimitFields } from './LimitSettings';
import { DEFAULT_LIMITS } from '@ghost/contract';

export function ScopeEditor({ scope, onClose, onSaved }: { scope?: Scope; onClose(): void; onSaved(id: string): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [name, setName] = useState(scope?.name ?? '');
  const [ghostId, setGhostId] = useState(scope?.ghostId ?? '');
  const [paths, setPaths] = useState(scope?.paths ?? []);
  const [vaultPath, setVaultPath] = useState(scope?.vaultPath ?? '');
  const [status, setStatus] = useState(scope?.state ?? 'active');
  const [attachments, setAttachments] = useState<DocRef[]>(scope?.attachments ?? []);
  const [limits, setLimits] = useState<Partial<Limits>>(scope?.limits ?? {});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const roots = paths.map(path => path.trim()).filter(Boolean);
      if (roots.some(path => !path.startsWith('/')) || vaultPath && !vaultPath.trim().startsWith('/')) throw new Error('경로는 /로 시작하는 절대 경로를 입력하세요.');
      const input = { name: name.trim(), ghostId: ghostId || null, paths: roots, vaultPath: vaultPath.trim() || null, state: status, attachments, limits };
      const result = await client.send<{ scopeId: string }>(scope ? { type: 'scope.update', scopeId: scope.id, ...input } : { type: 'scope.create', ...input });
      onSaved(scope?.id ?? result.scopeId);
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <form className="infra-form" aria-label={scope ? '프로젝트 편집' : '새 프로젝트'} onSubmit={event => void save(event)}>
    <fieldset className="infra-form border-0 p-0 m-0" disabled={busy}>
      <TextField label="프로젝트 이름" required value={name} onChange={setName} maxLength={128}/>
      <Choice label="받을 Ghost" value={ghostId} onChange={setGhostId} options={[{ value: '', label: '기본 Ghost' }, ...(state?.ghosts ?? []).filter(ghost => ghost.state === 'active' && !ghost.deletedAt).map(ghost => ({ value: ghost.id, label: ghost.name }))]}/>
      <StringList label="읽기 경로" values={paths} onChange={setPaths} placeholder="/Users/…"/>
      <TextField label="문서 금고 경로 (선택)" value={vaultPath} onChange={setVaultPath} placeholder="/Users/…"/>
      <Choice label="상태" value={status} onChange={value => setStatus(value as Scope['state'])} options={[{ value: 'active', label: '진행' }, { value: 'paused', label: '멈춤' }]}/>
      <DocAttachments value={attachments} onChange={setAttachments} scopeId={scope?.id}/>
      <details><summary>프로젝트 한도</summary><div className="infra-form pt-4"><p className="infra-record__meta">비운 항목은 전체 한도를 따릅니다.</p><LimitFields value={limits} onChange={setLimits} inherited={state?.settings.limits ?? DEFAULT_LIMITS}/><Button type="button" variant="ghost" onClick={() => setLimits({})}>전체 한도 따르기</Button></div></details>
    </fieldset>
    {error && <InlineError>{error}</InlineError>}<EditorActions busy={busy} onCancel={onClose}/>
  </form>;
}
