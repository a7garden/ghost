import { useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { FileCode2, FileImage, Maximize2, X } from 'lucide-react';
import { staticHtmlPreview } from '../components/interactive/StaticHtmlBlock';
import { useHost } from '../host/context';
import { Dialog, DialogTitle, SkeletonText } from '../ui';
import { SheetHandle, useCompact } from '../ui/adaptive';
import '../components/ArtifactPreview.css';

const PREVIEW_WIDTH = 720;

function HtmlThumbnail({ url, label }: { url: string; label: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const size = () => node.style.setProperty('--coding-preview-scale', String(node.clientWidth / PREVIEW_WIDTH));
    const observer = new ResizeObserver(size);
    observer.observe(node);
    size();
    return () => observer.disconnect();
  }, []);
  return <span className="embedded-preview__thumb" ref={viewport}>
    <iframe src={url} sandbox="" referrerPolicy="no-referrer" title={`${label} · HTML 미리보기`} tabIndex={-1} width={PREVIEW_WIDTH} height={450}/>
  </span>;
}

/** Session files require a bearer on paired devices, so tags only receive local object URLs. */
export function CodingSessionPreview({ id, path, label, kind, thumbnail = false }: {
  id: string; path: string; label: string; kind: 'image' | 'html'; thumbnail?: boolean;
}) {
  const { client } = useHost();
  const compact = useCompact();
  const [url, setUrl] = useState('');
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const Icon = kind === 'html' ? FileCode2 : FileImage;
  useEffect(() => {
    let owned = '';
    const request = new AbortController();
    setUrl('');
    setError(false);
    async function load() {
      const file = await client.codingSessionFile(id, path, request.signal);
      if (request.signal.aborted) return;
      let content = file;
      if (kind === 'html') {
        const source = await file.text();
        if (request.signal.aborted) return;
        // Reuse the app's static tag allow-list and CSP: sandbox alone does not block network requests.
        content = new Blob([staticHtmlPreview(source).document], { type: 'text/html' });
      } else if (!file.type.startsWith('image/')) {
        throw new Error('이미지 파일이 아닙니다.');
      }
      owned = URL.createObjectURL(content);
      setUrl(owned);
    }
    void load().catch(() => { if (!request.signal.aborted) setError(true); });
    return () => { request.abort(); if (owned) URL.revokeObjectURL(owned); };
  }, [client, id, path, kind]);

  return <div className="embedded-preview" data-thumbnail={thumbnail || undefined}>
    {error ? <span className="embedded-preview__notice" role="alert">
      <Icon size={16} aria-hidden="true"/>미리보기를 불러오지 못했습니다.
    </span> : !url ? <SkeletonText label="미리보기 불러오는 중…" lines={2} className="p-2"/> : <>
      {kind === 'html' ? <HtmlThumbnail url={url} label={label}/>
        : <img src={url} alt={label} onError={() => setError(true)}/>}
      <button type="button" ref={trigger} onClick={() => setOpen(true)} aria-label={`${label} 크게 보기`} title={`${label} 크게 보기`}>
        <Maximize2 size={16} aria-hidden="true"/>
      </button>
    </>}
    {open && url && <Dialog open onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="file-sheet-backdrop"/>
        <DialogPrimitive.Content className="file-sheet" aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
          {compact && <SheetHandle/>}
          <header className="file-sheet__bar">
            <div className="file-sheet__identity"><Icon size={18} aria-hidden="true"/><DialogTitle className="file-sheet__title">{label}</DialogTitle></div>
            <DialogPrimitive.Close className="file-sheet__close" aria-label="미리보기 닫기" title="미리보기 닫기"><X size={18} aria-hidden="true"/></DialogPrimitive.Close>
          </header>
          <div className="file-sheet__viewport" data-file-scroll>
            {kind === 'html' ? <iframe className="file-sheet__pdf" src={url} sandbox="" referrerPolicy="no-referrer" title={`${label} · HTML 미리보기`}/>
              : <div className="file-sheet__image"><img src={url} alt={label}/></div>}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>}
  </div>;
}
