import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Crumb } from '../features/crumbs';
import { useCompact } from '../ui/adaptive';
import { shortcut } from '../ui/keys';

/**
 * Where the owner is and how they got there, in the title bar: back and forward through their
 * own steps, then the trail of the current page — each step above the page goes up to it.
 */
export function TitleNav({ crumbs, canBack, canForward, onBack, onForward, navigate, compactBack }: {
  crumbs: Crumb[];
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  navigate(path: string): void;
  compactBack?: string;
}) {
  const compact = useCompact();
  return <nav className="title-nav" aria-label="위치">
    {(!compact || compactBack) && <span className="title-nav__steps">
      <button type="button" className="title-nav__step" disabled={!canBack && !compact} aria-label="뒤로" title={`뒤로 · ${shortcut('[')}`} onClick={() => canBack ? onBack() : compactBack && navigate(compactBack)}><ChevronLeft aria-hidden="true"/></button>
      {!compact && <button type="button" className="title-nav__step" disabled={!canForward} aria-label="앞으로" title={`앞으로 · ${shortcut(']')}`} onClick={onForward}><ChevronRight aria-hidden="true"/></button>}
    </span>}
    <ol className="title-nav__trail">
      {crumbs.map(({ label, path }, index) => <li key={`${index}:${label}`} className="title-nav__crumb">
        {path === null
          ? <span aria-current="page">{label}</span>
          : <button type="button" onClick={() => navigate(path)}>{label}</button>}
      </li>)}
    </ol>
  </nav>;
}
