import type { Connection } from '../host/store';

export type HostStatus = { state: 'connecting' | 'connected' | 'stale' | 'offline'; label: string };

/**
 * A live event stream is the freshness proof: while it is up, ledger events keep the
 * snapshot current. Stale and offline only describe a dropped stream.
 */
export function hostStatus(connection: Connection, hasState: boolean): HostStatus {
  if (connection === 'live') return { state: 'connected', label: '연결됨' };
  if (connection === 'connecting') return { state: 'connecting', label: '연결 확인 중' };
  return { state: hasState ? 'stale' : 'offline', label: hasState ? '갱신 지연' : '연결 필요' };
}
