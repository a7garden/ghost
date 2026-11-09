import { useEffect } from 'react';
import { isDesktopShell } from './desktop';

/** WKWebView keeps the layout viewport behind the keyboard; size the shared frame to the visible one. */
export function useVisibleViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const compact = !isDesktopShell() && matchMedia('(max-width: 55.999rem)').matches;
      document.documentElement.style.setProperty('--ghost-visible-height', compact ? `${viewport.height}px` : '100dvh');
      document.documentElement.style.setProperty('--ghost-visible-top', compact ? `${viewport.offsetTop}px` : '0px');
      document.documentElement.dataset.keyboard = compact && window.innerHeight - viewport.height > 120 ? 'open' : 'closed';
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--ghost-visible-height');
      document.documentElement.style.removeProperty('--ghost-visible-top');
      delete document.documentElement.dataset.keyboard;
    };
  }, []);
}
