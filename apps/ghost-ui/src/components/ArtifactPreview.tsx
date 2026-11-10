import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Download, FileCode2, FileImage, FileText, File as FileIcon, WrapText, X } from 'lucide-react';
import type { ArtifactRef } from '@ghost/contract';
import { useHost } from '../host/context';
import { Peek } from './agent/Peek';
import { Button, Dialog, DialogTitle, SegmentedControl } from '../ui';
import { CopyButton, MessageBody } from './MessageBody';
import './ArtifactPreview.css';
import { SheetHandle, useCompact } from '../ui/adaptive';

export const sizeLabel = (size: number) => size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`;

/** The sheet owns its request and object URL, including a request finishing after dismissal. */
function FileSheet({ artifact, onClose, returnFocus }: { artifact: ArtifactRef; onClose(): void; returnFocus(): void }) {
  const { client } = useHost();
  const compact = useCompact();
  const [content, setContent] = useState<{ url: string; text?: string } | null>(null);
  const [error, setError] = useState('');
  const markdown = /(?:markdown)/i.test(artifact.mediaType) || /\.(md|markdown)$/i.test(artifact.name);
  const textual = !artifact.mediaType.startsWith('image/') && (artifact.mediaType.startsWith('text/') || /(?:json|javascript|xml|yaml|toml)/i.test(artifact.mediaType)
    || /\.(md|markdown|txt|log|csv|ts|tsx|js|jsx|py|sh|json|ya?ml|toml|html|css|sql|rs|swift)$/i.test(artifact.name));
  const [view, setView] = useState<'preview' | 'source'>(markdown ? 'preview' : 'source');
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    let disposed = false;
    let url = '';
    void (async () => {
      try {
        url = await client.artifactUrl(artifact.digest, artifact.mediaType.startsWith('image/') || artifact.mediaType === 'application/pdf' ? artifact.mediaType : undefined);
        if (disposed) { URL.revokeObjectURL(url); return; }
        const text = textual ? await (await fetch(url)).text() : undefined;
        if (!disposed) setContent({ url, text });
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : '파일을 읽지 못했습니다.');
      }
    })();
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [client, artifact.digest, textual]);

  const source = content?.text;
  const lines = useMemo(() => {
    if (!source) return 0;
    let count = 1;
    for (let index = 0; index < source.length; index++) if (source.charCodeAt(index) === 10) count++;
    return count;
  }, [source]);
  // Keep the source complete without amplifying newline-heavy uploads into a giant gutter.
  const gutter = useMemo(() => lines <= 10_000 ? Array.from({ length: lines }, (_, index) => index + 1).join('\n') : '', [lines]);
  const image = artifact.mediaType.startsWith('image/');
  const pdf = artifact.mediaType === 'application/pdf';
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="file-sheet-backdrop"/>
      <DialogPrimitive.Content className="file-sheet" aria-describedby={undefined}
        onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}
        onOpenAutoFocus={event => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-file-close]')?.focus();
        }}>
        {compact && <SheetHandle/>}
        <header className="file-sheet__bar">
          <div className="file-sheet__identity">
            {image ? <FileImage size={18} aria-hidden="true"/> : markdown ? <FileText size={18} aria-hidden="true"/> : <FileCode2 size={18} aria-hidden="true"/>}
            <DialogTitle className="file-sheet__title">{artifact.name}</DialogTitle>
          </div>
          <div className="file-sheet__actions">
            {source !== undefined && source !== '' && <CopyButton label="파일 내용 복사" getText={() => source}/>}
            {content && <Button asChild variant="ghost" size="sm"><a href={content.url} download={artifact.name} aria-label="파일 다운로드"><Download aria-hidden="true"/><span>저장</span></a></Button>}
            <DialogPrimitive.Close className="file-sheet__close" data-file-close aria-label="파일 닫기"><X size={18} aria-hidden="true"/></DialogPrimitive.Close>
          </div>
        </header>
        {source !== undefined && <div className="file-sheet__tools">
          {markdown && <SegmentedControl className="file-sheet__views" aria-label="파일 보기" value={view} onValueChange={setView}
            options={[{ value: 'preview', label: '읽기' }, { value: 'source', label: '원문' }]}/>}
          {(!markdown || view === 'source') && <button type="button" className="file-sheet__wrap" aria-label="긴 줄 접기" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={16} aria-hidden="true"/><span>줄 접기</span></button>}
        </div>}
        <div className="file-sheet__viewport" data-file-scroll tabIndex={0} aria-label="파일 내용">
          {error ? <p className="file-sheet__notice text-red" role="alert">{error}</p>
            : !content ? <p className="file-sheet__notice" role="status">파일을 읽는 중…</p>
            : source !== undefined ? source === '' ? <p className="file-sheet__notice">빈 파일</p>
              : markdown && view === 'preview' ? <article className="file-sheet__document"><MessageBody text={source} document/></article>
              : <div className="file-sheet__source" data-wrap={wrap || undefined}>
                {gutter && <pre className="file-sheet__gutter" aria-hidden="true">{gutter}</pre>}
                <pre className="file-sheet__code">{source}</pre>
              </div>
            : image ? <div className="file-sheet__image"><img src={content.url} alt={artifact.name}/></div>
            : pdf ? <iframe className="file-sheet__pdf" src={content.url} title={artifact.name}/>
            : <div className="file-sheet__unsupported"><FileIcon size={32} aria-hidden="true"/><p>이 파일은 저장해서 열어 주세요.</p><Button asChild variant="secondary"><a href={content.url} download={artifact.name}><Download aria-hidden="true"/>파일 저장</a></Button></div>}
        </div>
        <footer className="file-sheet__foot"><span>{artifact.mediaType}</span>{compact && <CopyButton label="파일 해시 복사" getText={() => artifact.digest}/>}<span>{sizeLabel(artifact.size)}{source !== undefined && ` · ${lines.toLocaleString()}줄`}</span></footer>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </Dialog>;
}

/**
 * 첨부 자료: fetches bytes on demand and previews them in place; the object URL dies with the dialog.
 * `chip` is the inline form for a report line: the name alone, size and hash behind a hover.
 */
export function ArtifactPreview({ artifact, label, variant = 'tile' }: { artifact: ArtifactRef; label?: string; variant?: 'tile' | 'chip' }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const icon = artifact.mediaType.startsWith('image/') ? <FileImage/> : artifact.mediaType === 'application/json' || /\.(ts|js|py|sh|json|ya?ml|toml)$/i.test(artifact.name) ? <FileCode2/> : artifact.mediaType.startsWith('text/') ? <FileText/> : <FileIcon/>;
  return <>
    {variant === 'chip'
      ? <Peek facts={[{ label: '크기', value: sizeLabel(artifact.size) }, { label: '형식', value: artifact.mediaType }, { label: '해시', value: artifact.digest, copy: true }]}>
        <button ref={trigger} type="button" className="file-chip" onClick={() => setOpen(true)}>
          <span className="file-chip__icon" aria-hidden="true">{icon}</span><span className="file-chip__name">{label ?? artifact.name}</span>
        </button>
      </Peek>
      : <button ref={trigger} type="button" className="artifact-tile" onClick={() => setOpen(true)} title={artifact.name}>
        <span className="artifact-tile__icon" aria-hidden="true">{icon}</span>
        <span className="artifact-tile__copy"><span>{label ?? artifact.name}</span><small className="tabular">{sizeLabel(artifact.size)}</small></span>
      </button>}
    {open && <FileSheet key={artifact.digest} artifact={artifact} onClose={() => setOpen(false)} returnFocus={() => trigger.current?.focus()}/>}
  </>;
}
