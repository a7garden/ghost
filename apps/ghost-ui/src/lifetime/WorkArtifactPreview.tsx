import { useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { Modal } from '../components/Modal';
import { isRecord } from './guards';
import type { Artifact, LifetimeClient, Work } from './types';

type WorkIdentity = Pick<Work, 'id' | 'goal_id' | 'goal_revision' | 'execution_id'>;
const maxArtifactBytes = 1_048_576;
const integrityError = '결과물의 작업 정보와 원문을 확인하지 못했습니다.';

export async function readVerifiedWorkArtifact(client: Pick<LifetimeClient, 'request'>, work: WorkIdentity, artifact: Artifact): Promise<Uint8Array> {
  if (!work.execution_id || work.execution_id !== artifact.producing_attempt || !/^[a-f0-9]{64}$/.test(artifact.digest)) {
    throw new Error(integrityError);
  }
  const response = await client.request({
    method: 'work.artifact', work_id: work.id, execution_id: work.execution_id,
    digest: artifact.digest, locator: artifact.locator,
  });
  if (response.status !== 'success') throw new Error(response.summary || '호스트에서 현재 결과물을 읽지 못했습니다.');

  const data = response.data;
  // Both worker routes echo the artifact reference. Older Pi replies carry
  // the Goal ID only in object_refs.
  const matchingArtifact = response.artifacts.some(item => item.digest === artifact.digest
    && item.locator === artifact.locator && item.producing_attempt === artifact.producing_attempt
    && item.privacy === artifact.privacy);
  if (!matchingArtifact || !response.object_refs.includes(work.id) || !response.object_refs.includes(work.goal_id)
    || !isRecord(data) || data.work_id !== work.id || data.execution_id !== work.execution_id
    || data.goal_revision !== work.goal_revision || (data.goal_id !== undefined && data.goal_id !== work.goal_id)
    || data.digest !== artifact.digest || data.privacy !== artifact.privacy || data.encoding !== 'base64'
    || typeof data.byte_length !== 'number' || !Number.isSafeInteger(data.byte_length)
    || data.byte_length < 0 || data.byte_length > maxArtifactBytes
    || typeof data.data !== 'string' || data.data.length !== 4 * Math.ceil(data.byte_length / 3)) {
    throw new Error(integrityError);
  }

  let decoded: string;
  try {
    decoded = atob(data.data);
  } catch {
    throw new Error(integrityError);
  }
  if (decoded.length !== data.byte_length || btoa(decoded) !== data.data) throw new Error(integrityError);

  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  const sha256 = await crypto.subtle.digest('SHA-256', bytes);
  const digest = Array.from(new Uint8Array(sha256), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== artifact.digest) throw new Error(integrityError);
  return bytes;
}

export function artifactSource(bytes: Uint8Array): string | null {
  try {
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return source.includes('\0') ? null : source;
  } catch {
    return null;
  }
}

type Props = { client: LifetimeClient; work: WorkIdentity; artifact: Artifact; disabled?: boolean };
type ReaderState = { status: 'loading' } | { status: 'ready'; source: string | null } | { status: 'error'; message: string };

export function WorkArtifactPreview(props: Props) {
  const { client, work, artifact } = props;
  const key = JSON.stringify([client.workspace_id, client.actor_ref, client.authority_epoch, work.id, work.goal_id, work.goal_revision,
    work.execution_id, artifact.digest, artifact.locator, artifact.privacy]);
  return <ArtifactReader key={key} {...props}/>;
}

function ArtifactReader({ client, work, artifact, disabled = false }: Props) {
  const [reader, setReader] = useState<ReaderState>();
  const request = useRef(0);
  const load = async () => {
    if (disabled || reader?.status === 'loading') return;
    const version = ++request.current;
    setReader({ status: 'loading' });
    try {
      const bytes = await readVerifiedWorkArtifact(client, work, artifact);
      if (request.current === version) setReader({ status: 'ready', source: artifactSource(bytes) });
    } catch (reason) {
      if (request.current === version) {
        setReader({ status: 'error', message: reason instanceof Error ? reason.message : '결과물을 읽지 못했습니다.' });
      }
    }
  };
  const close = () => { request.current++; setReader(undefined); };

  return <>
    <button type="button" className="button secondary" disabled={disabled} onClick={() => void load()}><FileText size={15}/>결과 열기</button>
    {reader && <Modal title="결과 문서" onClose={close} drawer focusClose>
      <div className="page-reader" aria-busy={reader.status === 'loading'}>
        {reader.status === 'loading' && <p role="status">호스트에서 결과물을 읽는 중…</p>}
        {reader.status === 'error' && <>
          <p className="inline-error" role="alert">{reader.message}</p>
          <button type="button" className="button secondary" disabled={disabled} onClick={() => void load()}>다시 읽기</button>
        </>}
        {reader.status === 'ready' && (reader.source === null
          ? <p role="status">검증된 결과물이지만 이 형식은 여기에서 열 수 없습니다.</p>
          : <>
            <p className="field-help">원문 · 읽기 전용</p>
            {reader.source.length
              ? <pre className="garden-document-source-readonly"><code>{reader.source}</code></pre>
              : <p className="field-help">빈 문서입니다.</p>}
          </>)}
      </div>
    </Modal>}
  </>;
}
