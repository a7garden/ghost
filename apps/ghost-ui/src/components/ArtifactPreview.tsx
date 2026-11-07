import { useState } from 'react';
import { Button } from '@garden/ui';
import type { ArtifactRef } from '@ghost/contract';
import { useHost } from '../host/context';
import { Modal } from './Modal';

const sizeLabel = (size: number) => size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`;

/** 첨부 자료: fetches bytes on demand and previews them in place; the object URL dies with the dialog. */
export function ArtifactPreview({ artifact, label }: { artifact: ArtifactRef; label?: string }) {
  const { client } = useHost();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<{ url: string; mediaType: string; text?: string } | null>(null);
  const [error, setError] = useState('');
  const openPreview = () => {
    setOpen(true); setError('');
    void (async () => {
      try {
        if (artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json' || artifact.mediaType === 'text/markdown') {
          const text = await client.artifactText(artifact.digest);
          setContent({ url: '', mediaType: artifact.mediaType, text });
        } else {
          const url = await client.artifactUrl(artifact.digest);
          setContent({ url, mediaType: artifact.mediaType });
        }
      } catch (e) { setError(e instanceof Error ? e.message : '결과 자료를 읽지 못했습니다.'); }
    })();
  };
  const close = () => {
    setOpen(false);
    if (content?.url) URL.revokeObjectURL(content.url);
    setContent(null);
  };
  return <>
    <Button variant="outline" size="sm" onClick={openPreview}>{label ?? artifact.name}<span className="text-caption text-ink-3">{sizeLabel(artifact.size)}</span></Button>
    {open && <Modal title={artifact.name} onClose={close}>
      {error && <p className="m-0 text-caption text-red" role="alert">{error}</p>}
      {!error && !content && <p className="m-0 text-caption text-ink-2" aria-busy="true">읽는 중…</p>}
      {content?.text !== undefined && <pre className="max-h-[60dvh] overflow-auto rounded-control border border-line bg-inset p-3 text-caption [overflow-wrap:anywhere]">{content.text}</pre>}
      {content && !content.text && content.mediaType.startsWith('image/') && <img src={content.url} alt={artifact.name} className="max-h-[60dvh] w-full object-contain"/>}
      {content && !content.text && !content.mediaType.startsWith('image/') && <iframe src={content.url} title={artifact.name} className="h-[60dvh] w-full rounded-control border border-line"/>}
    </Modal>}
  </>;
}
