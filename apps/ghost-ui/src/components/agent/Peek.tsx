import { useEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '../../ui';

/** One technical fact behind a friendly surface; `copy` makes the value a copy action. */
export interface PeekFact { label: string; value: string; copy?: boolean }

const OPEN_DELAY = 420;
const CLOSE_DELAY = 160;
const COPIED_MS = 1200;

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return <button type="button" className="peek__copy" data-copied={copied || undefined} aria-label={`${value} 복사`}
    onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {}); }}>
    <span>{value}</span><em aria-live="polite">{copied ? '복사됨' : '복사'}</em>
  </button>;
}

/**
 * The details a person rarely needs — ids, hashes, sizes, who judged what — kept off the
 * surface and shown when the pointer rests on it (or keyboard focus lands). Touch has no
 * hover; there the element's own action leads to the full page.
 */
export function Peek({ title, facts, children, side = 'top', align = 'start' }: {
  title?: ReactNode;
  facts: PeekFact[];
  children: ReactElement;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  const close = () => settle(false, CLOSE_DELAY);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild
      onPointerEnter={event => { if (event.pointerType !== 'touch') settle(true, OPEN_DELAY); }}
      onPointerLeave={close}
      onPointerDown={() => { clearTimeout(timer.current); setOpen(false); }}
      onFocus={(event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(':focus-visible')) settle(true, 0); }}
      onBlur={close}>
      {children}
    </PopoverAnchor>
    <PopoverContent side={side} align={align} sideOffset={6} className="peek w-auto max-w-[min(380px,calc(100vw-1rem))] rounded-[12px] p-0"
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={close}>
      {title && <div className="peek__title">{title}</div>}
      {facts.length > 0 && <dl className="peek__facts">
        {facts.map(fact => <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.copy ? <CopyValue value={fact.value}/> : fact.value}</dd>
        </div>)}
      </dl>}
    </PopoverContent>
  </Popover>;
}
