export type HostStatus = { state: 'demo' | 'connecting' | 'connected' | 'stale' | 'offline'; label: string };

/** A configured live transport is not evidence of a successful Host read. */
export function hostStatus(mode: string, error: string, observedAt: number | null, connecting: boolean, now = Date.now()): HostStatus {
  if (connecting) return { state: 'connecting', label: '연결 확인 중' };
  if (error) return { state: observedAt ? 'stale' : 'offline', label: observedAt ? '갱신 지연' : '연결 필요' };
  if (mode === 'demo') return { state: 'demo', label: '예시 모드' };
  if (!observedAt) return { state: 'connecting', label: '연결 확인 중' };
  if (now - observedAt > 60000) return { state: 'stale', label: '갱신 지연' };
  return { state: 'connected', label: '연결됨' };
}

export function observedTime(value: number | null) {
  return value ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '아직 확인하지 않음';
}
