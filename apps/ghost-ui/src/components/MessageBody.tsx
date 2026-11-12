import { createContext, isValidElement, useContext, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Check, CircleAlert, Copy, Image as ImageIcon } from 'lucide-react';
import { Button, cn } from '../ui'
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import './MessageBody.css';
import { ExternalAnchor } from './ExternalAnchor';
import { RefMark } from './agent/RefMark';
import { StateGlyph } from './agent/StateGlyph';
import { REF_TAG, rehypeRefs, type Ref } from './refs';

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

/**
 * Fenced code with its language and a copy action; long lines scroll inside the block instead of the transcript.
 * 2026.11.10 : a one-line command drops the language bar and keeps only its copy action at the line's end —
 * replies that quote several commands read as stacked toolbars otherwise.
 */
function CodeBlock({ language, single = false, children }: { language?: string; single?: boolean; children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  if (single) return <div className="message-body__code" data-single="">
    <pre ref={pre} tabIndex={0}>{children}</pre>
    <CopyButton className="message-body__code-copy" label="코드 복사" getText={() => pre.current?.textContent ?? ''}/>
  </div>;
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
  const source = isValidElement<{ children?: ReactNode }>(child) ? child.props.children : undefined;
  const single = typeof source === 'string' && !source.replace(/\n$/, '').includes('\n');
  return <CodeBlock language={language} single={single}>{children}</CodeBlock>;
}

/**
 * A GFM task-list box becomes the Work state shape: a check for done, a dashed ring for not yet.
 * A disabled form checkbox read as a half-filled form, not as a result.
 */
function TaskCheck({ type, checked, node: _node, ...props }: ComponentPropsWithoutRef<'input'> & { node?: unknown }) {
  if (type !== 'checkbox') return <input type={type} checked={checked} {...props}/>;
  return <span className="message-body__check" role="img" aria-label={checked ? '확인됨' : '확인 안 됨'}>
    <StateGlyph state={checked ? 'done' : 'queued'} size={15}/>
  </span>;
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
        const viewport = target.closest<HTMLElement>('[data-file-scroll], .ghost-conversation__transcript, #main-content');
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
  return <ExternalAnchor {...props} href={href} target="_blank" rel="noopener noreferrer nofollow"><InLink.Provider value={true}>{children}</InLink.Provider></ExternalAnchor>;
}

/** Remote images never load: the alt text becomes an explicit link instead. */
function ImageLink({ alt, src }: { alt?: string; src?: string }) {
  const inLink = useContext(InLink);
  const target = typeof alt === 'string' && alt.trim() ? alt : src;
  if (!target) return null;
  const content = <><ImageIcon size={13} className="size-[13px]" aria-hidden="true"/><span className="message-body__image-label">{target}</span></>;
  return src && !inLink && !src.startsWith('#')
    ? <ExternalAnchor className="message-body__image" href={src} target="_blank" rel="noopener noreferrer nofollow" aria-label={`이미지 열기: ${target}`}>{content}</ExternalAnchor>
    : <span className="message-body__image">{content}</span>;
}

function ScrollableTable({ children, node: _node, ...props }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return <div className="message-body__tablewrap" role="region" aria-label="표" tabIndex={0}><table {...props}>{children}</table></div>;
}

function RefNode({ 'data-kind': kind, 'data-value': value }: { 'data-kind'?: Ref['kind']; 'data-value'?: string }) {
  return kind && value ? <RefMark kind={kind} value={value}/> : null;
}

const components = {
  a: SafeLink,
  img: ImageLink,
  input: TaskCheck,
  pre: FencedCode,
  table: ScrollableTable,
  [REF_TAG]: RefNode,
} as Components;

/**
 * CommonMark drops `**「산림청」**을` to literal asterisks: a delimiter beside punctuation must
 * also touch a space, which Korean prose never puts there. The CJK-friendly rule lifts that.
 * Messages also keep the single line breaks a Ghost writes; a stored document keeps CommonMark's.
 */
const documentRemarkPlugins = [remarkGfm, remarkCjkFriendly];
const messageRemarkPlugins = [remarkGfm, remarkCjkFriendly, remarkBreaks];
const remarkRehypeOptions = { footnoteLabel: '각주', footnoteBackLabel: '본문으로 돌아가기' };

/** Code keeps its exact characters as one node. */
const KEEP_WHOLE: Record<string, true> = { pre: true, code: true, svg: true, [REF_TAG]: true };

const isStreamWord = (node: ElementContent) => node.type === 'element' && node.tagName === 'span'
  && Array.isArray(node.properties.className) && node.properties.className.includes('stream-word');

/**
 * While a reply streams, every word becomes its own span and a caret follows the last text.
 * The renderer keys children by position, so words already on screen keep their elements and
 * only words that just arrived mount — their entrance animation is the streaming effect.
 */
function rehypeStreaming() {
  const split = (parent: Root | Element) => {
    const next: ElementContent[] = [];
    for (const child of parent.children) {
      if (child.type === 'text') {
        for (const piece of child.value.split(/(\s+)/)) {
          if (!piece) continue;
          next.push(/^\s+$/.test(piece) ? { type: 'text', value: piece }
            : { type: 'element', tagName: 'span', properties: { className: ['stream-word'] }, children: [{ type: 'text', value: piece }] });
        }
      } else if (child.type === 'element') {
        if (!KEEP_WHOLE[child.tagName]) split(child);
        next.push(child);
      } else if (child.type !== 'doctype') {
        next.push(child);
      }
    }
    parent.children = next;
  };
  /** The innermost last element that holds text: the caret sits right after the newest word. */
  const tail = (node: Root | Element): Root | Element => {
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index];
      if (child.type === 'text' && child.value.trim() === '' || child.type === 'comment' || child.type === 'doctype') continue;
      return child.type === 'element' && !isStreamWord(child) && !KEEP_WHOLE[child.tagName] ? tail(child) : node;
    }
    return node;
  };
  return (tree: Root) => {
    split(tree);
    tail(tree).children.push({ type: 'element', tagName: 'span', properties: { className: ['stream-caret'], ariaHidden: 'true' }, children: [] });
  };
}
/** From this many columns a table stops fitting a phone: mobile.css lays each row out as a card instead. */
const WIDE_TABLE_COLUMNS = 4;
const textOf = (node: ElementContent): string => node.type === 'text' ? node.value : node.type === 'element' ? node.children.map(textOf).join('') : '';
const childElements = (node: Root | Element, tagName?: string) =>
  (node.children as RootContent[]).filter((child): child is Element => child.type === 'element' && (!tagName || child.tagName === tagName));

/**
 * A wide table carries what its phone card needs: every cell names its column (`data-label`) and holds
 * its content in one block, and the table keeps its ARIA roles once the card layout re-displays it.
 */
function rehypeTableCells() {
  const mark = (table: Element) => {
    const sections = childElements(table);
    const headRow = childElements(sections.find(section => section.tagName === 'thead') ?? table, 'tr')[0];
    const names = headRow ? childElements(headRow, 'th').map(cell => textOf(cell).trim()) : [];
    if (names.length < WIDE_TABLE_COLUMNS) return;
    table.properties = { ...table.properties, dataWide: '', role: 'table' };
    for (const section of sections) {
      section.properties = { ...section.properties, role: 'rowgroup' };
      for (const row of childElements(section, 'tr')) {
        row.properties = { ...row.properties, role: 'row' };
        childElements(row).forEach((cell, index) => {
          if (cell.tagName === 'th') { cell.properties = { ...cell.properties, role: 'columnheader' }; return; }
          cell.properties = { ...cell.properties, role: 'cell', ...names[index] ? { dataLabel: names[index] } : {} };
          cell.children = [{ type: 'element', tagName: 'div', properties: { className: ['message-body__cell'] }, children: cell.children }];
        });
      }
    }
  };
  const visit = (node: Root | Element) => {
    for (const child of childElements(node)) {
      if (child.tagName === 'table') mark(child);
      else visit(child);
    }
  };
  return (tree: Root) => visit(tree);
}
const rehypePlugins = [rehypeRefs, rehypeTableCells];
const streamingRehypePlugins = [rehypeRefs, rehypeTableCells, rehypeStreaming];

/** Assistant transcript body: GFM markdown kept inside the message column, no raw HTML, no automatic remote resources. */
export function MessageBody({ text, streaming = false, document = false }: { text: string; streaming?: boolean; document?: boolean }) {
  return <div className="message-body" data-streaming={streaming || undefined}>
    <Markdown remarkPlugins={document ? documentRemarkPlugins : messageRemarkPlugins} rehypePlugins={streaming ? streamingRehypePlugins : rehypePlugins} remarkRehypeOptions={remarkRehypeOptions} urlTransform={safeUrl} components={components}>{text}</Markdown>
  </div>;
}

const inlineRemarkPlugins = [remarkGfm, remarkCjkFriendly];
const INLINE_ELEMENTS = ['strong', 'em', 'del', 'code', REF_TAG];
const inlineRehypePlugins = [rehypeRefs];

/**
 * Ghost text in a one-line slot (a failure reason, an outcome, a wake line): emphasis, short
 * code and reference marks render, while blocks fold into the line. Line breaks become scopes
 * first, so unwrapped paragraphs and list items never glue their words together. The wrapper
 * breaks long tokens (paths, URLs) wherever the slot puts it, so no caller has to.
 */
export function InlineText({ text }: { text: string }) {
  return <span className="message-body__inline"><Markdown remarkPlugins={inlineRemarkPlugins} rehypePlugins={inlineRehypePlugins} allowedElements={INLINE_ELEMENTS} unwrapDisallowed
    components={components}>{text.replace(/\s*\n\s*/g, ' ')}</Markdown></span>;
}

/**
 * Streamed text revealed at an even pace: providers deliver in bursts, the screen advances a few
 * characters per frame and speeds up with the backlog so it never trails far behind the stream.
 */
export function useSmoothText(target: string): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    // A replaced (not extended) text, or reduced motion, shows at once.
    if (!target.startsWith(shownRef.current) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let frame = 0;
    const step = () => {
      const goal = targetRef.current;
      const backlog = goal.length - shownRef.current.length;
      if (backlog <= 0) return;
      let end = shownRef.current.length + Math.max(2, Math.ceil(backlog / 10));
      // Never end between the halves of a surrogate pair.
      if (end < goal.length && /[\uD800-\uDBFF]/.test(goal[end - 1] ?? '')) end += 1;
      shownRef.current = goal.slice(0, end);
      setShown(shownRef.current);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}
