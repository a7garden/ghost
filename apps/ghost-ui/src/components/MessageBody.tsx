import { createContext, isValidElement, useContext, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Check, CircleAlert, Copy, Image as ImageIcon } from 'lucide-react';
import { Button, cn } from '../ui'
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './MessageBody.css';

/** Transcript links have no document base; only external URLs and local footnotes are navigable. */
const allowedSchemes: Record<string, true> = { http: true, https: true, mailto: true };
const InLink = createContext(false);

function safeUrl(value: string): string {
  const url = defaultUrlTransform(value);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return url.startsWith('#') || scheme && allowedSchemes[scheme] ? url : '';
}

type CopyStatus = 'idle' | 'copied' | 'failed';

const copyStatusLabel: Record<CopyStatus, string> = { idle: '복사', copied: '복사됨', failed: '복사 실패' };

const COPY_FEEDBACK_MS = 1600;

/** Clipboard action with real success/failure feedback; feedback resets on a timer and never updates after unmount. */
export function CopyButton({ getText, label, className }: {
  getText(): string;
  /** Accessible name kept stable across states, e.g. “메시지 복사”. */
  label: string;
  className?: string;
}) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const feedback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const request = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(feedback.current);
      feedback.current = undefined;
    };
  }, []);

  const copy = async () => {
    const id = ++request.current;
    let copied = false;
    try {
      const value = getText();
      if (navigator.clipboard && value.length > 0) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch { copied = false; }
    if (!mounted.current || id !== request.current) return;
    setStatus(copied ? 'copied' : 'failed');
    clearTimeout(feedback.current);
    feedback.current = setTimeout(() => {
      if (mounted.current) setStatus('idle');
    }, COPY_FEEDBACK_MS);
  };

  const Icon = status === 'copied' ? Check : status === 'failed' ? CircleAlert : Copy;
  return <Button type="button" variant="ghost" size="sm" className={cn(className, status === 'copied' && 'text-success', status === 'failed' && 'text-red')}
    aria-label={label} onClick={() => { void copy(); }}>
    <Icon size={12} className="size-3" aria-hidden="true"/>
    <span aria-live="polite">{copyStatusLabel[status]}</span>
  </Button>;
}

/** Fenced code with its language and a copy action; long lines scroll inside the block instead of the transcript. */
function CodeBlock({ language, children }: { language?: string; children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  return <div className="message-body__code">
    <div className="message-body__code-bar">
      {language && <span className="message-body__code-lang">{language}</span>}
      <CopyButton className="message-body__code-copy" label="코드 복사" getText={() => pre.current?.textContent ?? ''}/>
    </div>
    <pre ref={pre} tabIndex={0}>{children}</pre>
  </div>;
}

function FencedCode({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  const className = isValidElement<{ className?: string }>(child) && typeof child.props.className === 'string' ? child.props.className : '';
  const language = /language-([\w+#./-]+)/.exec(className)?.[1];
  return <CodeBlock language={language}>{children}</CodeBlock>;
}

function SafeLink({ children, href, node: _node, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  if (!href) return <span>{children}</span>;
  if (href.startsWith('#')) {
    return <a {...props} href={href} onClick={event => {
      event.preventDefault();
      const body = event.currentTarget.closest('.message-body');
      let id: string;
      try { id = decodeURIComponent(href.slice(1)); } catch { return; }
      const target = [...(body?.querySelectorAll<HTMLElement>('[id]') ?? [])].find(element => element.id === id);
      if (target) {
        const viewport = target.closest<HTMLElement>('.ghost-conversation__transcript, #main-content');
        if (viewport) {
          const content = target.getBoundingClientRect();
          const frame = viewport.getBoundingClientRect();
          if (content.top < frame.top) viewport.scrollTop += content.top - frame.top;
          else if (content.bottom > frame.bottom) viewport.scrollTop += content.bottom - frame.bottom;
        }
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }}><InLink.Provider value={true}>{children}</InLink.Provider></a>;
  }
  return <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow"><InLink.Provider value={true}>{children}</InLink.Provider></a>;
}

/** Remote images never load: the alt text becomes an explicit link instead. */
function ImageLink({ alt, src }: { alt?: string; src?: string }) {
  const inLink = useContext(InLink);
  const target = typeof alt === 'string' && alt.trim() ? alt : src;
  if (!target) return null;
  const content = <><ImageIcon size={13} className="size-[13px]" aria-hidden="true"/><span className="message-body__image-label">{target}</span></>;
  return src && !inLink && !src.startsWith('#')
    ? <a className="message-body__image" href={src} target="_blank" rel="noopener noreferrer nofollow" aria-label={`이미지 열기: ${target}`}>{content}</a>
    : <span className="message-body__image">{content}</span>;
}

function ScrollableTable({ children }: { children?: ReactNode }) {
  return <div className="message-body__tablewrap" role="region" aria-label="표" tabIndex={0}><table>{children}</table></div>;
}

const components: Components = {
  a: SafeLink,
  img: ImageLink,
  pre: FencedCode,
  table: ScrollableTable,
};

const remarkPlugins = [remarkGfm];
const remarkRehypeOptions = { footnoteLabel: '각주', footnoteBackLabel: '본문으로 돌아가기' };

/** Assistant transcript body: GFM markdown kept inside the message column, no raw HTML, no automatic remote resources. */
export function MessageBody({ text }: { text: string }) {
  return <div className="message-body">
    <Markdown remarkPlugins={remarkPlugins} remarkRehypeOptions={remarkRehypeOptions} urlTransform={safeUrl} components={components}>{text}</Markdown>
  </div>;
}
