import { elapsedLabel } from './herdrInboxModel';
import { useNow } from './time';

export function CodingSkeleton({ detail = false }: { detail?: boolean }) {
  return <div className={`herdr-skeleton${detail ? ' herdr-skeleton--pane' : ''}`} role="status" aria-label="불러오는 중">
    {[0, 1, 2].map(i => <div key={i}><i/><span><b/><b/></span></div>)}
  </div>;
}

export function WorkingTime({ since }: { since: number }) {
  const now = useNow(1000);
  return <span className="herdr-elapsed">{elapsedLabel(since || now, now)}</span>;
}
