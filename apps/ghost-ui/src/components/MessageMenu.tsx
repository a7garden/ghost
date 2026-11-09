import { cloneElement, useState, type ReactElement, type ReactNode } from 'react';
import { Copy, Link2, PencilLine, Quote, TextSelect } from 'lucide-react';
import { ContextMenu, ContextMenuAction, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui';
import { useTouch } from '../ui/adaptive';

/** What the pointer was on when the menu opened: selected text inside the message and a link under it. */
interface Target { selection: string; href: string }

function targetOf(event: React.MouseEvent<HTMLElement>): Target {
  const host = event.currentTarget;
  const selection = window.getSelection();
  const inside = selection && !selection.isCollapsed && selection.anchorNode && host.contains(selection.anchorNode) ? selection.toString().trim() : '';
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  const href = anchor && /^(https?:|mailto:)/i.test(anchor.href) ? anchor.href : '';
  return { selection: inside, href };
}

const copy = (value: string) => { void navigator.clipboard?.writeText(value).catch(() => {}); };

/** Blockquote the given text for a reply draft. */
export function quoteForReply(text: string): string {
  return `${text.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
}

/**
 * Right-click menu for one transcript message: copy the selection, the link or the whole message,
 * quote it into the reply, or put the owner's own message back into the composer.
 */
export function MessageMenu({ text, onQuote, onReuse, children }: {
  text: string;
  onQuote?(text: string): void;
  onReuse?(text: string): void;
  children: ReactElement<{ actions?: ReactNode }>;
}) {
  const [target, setTarget] = useState<Target>({ selection: '', href: '' });
  const touch = useTouch();
  const link = target.href || (touch ? text.match(/\]\((https?:\/\/[^\s)]+)\)/i)?.[1] || text.match(/https?:\/\/[^\s<>)]+/i)?.[0] || '' : '');
  if (!text) return children;
  const content = touch ? cloneElement(children, { actions: <>{children.props.actions}<ContextMenuAction/></> }) : children;
  return <ContextMenu>
    <ContextMenuTrigger asChild touchAction="inline" onContextMenu={event => setTarget(targetOf(event))}>{content}</ContextMenuTrigger>
    <ContextMenuContent aria-label="메시지 메뉴">
      {target.selection && <ContextMenuItem icon={<TextSelect/>} onSelect={() => copy(target.selection)}>선택한 텍스트 복사</ContextMenuItem>}
      {link && <ContextMenuItem icon={<Link2/>} onSelect={() => copy(link)}>링크 복사</ContextMenuItem>}
      <ContextMenuItem icon={<Copy/>} onSelect={() => copy(text)}>메시지 복사</ContextMenuItem>
      {(onQuote || onReuse) && <ContextMenuSeparator/>}
      {onQuote && <ContextMenuItem icon={<Quote/>} onSelect={() => onQuote(target.selection || text)}>{target.selection ? '선택 부분 인용' : '인용해서 답장'}</ContextMenuItem>}
      {onReuse && <ContextMenuItem icon={<PencilLine/>} onSelect={() => onReuse(text)}>입력창으로 가져오기</ContextMenuItem>}
    </ContextMenuContent>
  </ContextMenu>;
}
