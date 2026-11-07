import { useEffect, useState } from 'react';

/** Host timestamps rendered relative to the local clock; dates beyond a day stay absolute. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return '방금';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return new Date(at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export const absoluteTime = (at: number) =>
  new Date(at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** A coarse clock for relative labels; it never drives data. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
