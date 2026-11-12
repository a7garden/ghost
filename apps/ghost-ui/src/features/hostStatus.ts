import { CONFIRM_MS, SILENT_MS, type Connection } from '../host/store';

export type HostStatus = {
  state: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  label: string;
  /** Passive surfaces (sidebar badge, banners) stay silent; 호스트 settings still show the label. */
  quiet?: boolean;
};

/**
 * A live event stream is the freshness proof: while it is up, ledger events keep the snapshot
 * current. A dropped stream with data on screen gets a silent window, then 재연결 중…, and is
 * confirmed lost only after CONFIRM_MS. Without data there is nothing to protect: 연결 필요 at once.
 */
export function hostStatus(connection: Connection, hasState: boolean, offlineSince: number | null, now: number): HostStatus {
  if (connection === 'live') return { state: 'connected', label: '연결됨' };
  if (connection === 'connecting') return { state: 'connecting', label: '연결 확인 중', quiet: true };
  if (!hasState) return { state: 'offline', label: '연결 필요' };
  const elapsed = now - (offlineSince ?? now);
  if (elapsed < SILENT_MS) return { state: 'reconnecting', label: '재연결 중…', quiet: true };
  if (elapsed < CONFIRM_MS) return { state: 'reconnecting', label: '재연결 중…' };
  return { state: 'offline', label: '연결 끊김' };
}
