import { useState } from 'react';
import type { DocRef, Ghost } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { useHost } from '../host/context';
import { DocAttachments } from './DocAttachments';
import { errorText } from './InfrastructureFields';

export function GhostAttachments({ ghost }: { ghost: Ghost }) {
  const { client } = useHost();
  const [attachments, setAttachments] = useState<DocRef[]>(ghost.attachments);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await client.send({ type: 'ghost.update', ghostId: ghost.id, attachments }); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <div className="infra-form"><fieldset disabled={busy} className="border-0 p-0 m-0"><DocAttachments value={attachments} onChange={setAttachments}/></fieldset>
    {error && <InlineError>{error}</InlineError>}<div className="infra-actions"><Button disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '붙임 저장'}</Button></div>
  </div>;
}
