import { useState, type ReactElement } from 'react';
import { Copy, Link2, PencilLine, Quote, TextSelect } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui';

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
  children: ReactElement;
}) {
  const [target, setTarget] = useState<Target>({ selection: '', href: '' });
  if (!text) return children;
  return <ContextMenu>
    <ContextMenuTrigger asChild onContextMenu={event => setTarget(targetOf(event))}>{children}</ContextMenuTrigger>
    <ContextMenuContent aria-label="메시지 메뉴">
      {target.selection && <ContextMenuItem icon={<TextSelect/>} onSelect={() => copy(target.selection)}>선택한 텍스트 복사</ContextMenuItem>}
      {target.href && <ContextMenuItem icon={<Link2/>} onSelect={() => copy(target.href)}>링크 복사</ContextMenuItem>}
      <ContextMenuItem icon={<Copy/>} onSelect={() => copy(text)}>메시지 복사</ContextMenuItem>
      {(onQuote || onReuse) && <ContextMenuSeparator/>}
      {onQuote && <ContextMenuItem icon={<Quote/>} onSelect={() => onQuote(target.selection || text)}>{target.selection ? '선택 부분 인용' : '인용해서 답장'}</ContextMenuItem>}
      {onReuse && <ContextMenuItem icon={<PencilLine/>} onSelect={() => onReuse(text)}>입력창으로 가져오기</ContextMenuItem>}
    </ContextMenuContent>
  </ContextMenu>;
}
