export type ShellInfo = Readonly<{ platform: 'ios'; version: string; deviceId: string }>;
export type PermissionStatus = 'allowed' | 'denied' | 'undetermined';
export type ShellEvent = { type: 'notification.open'; notificationId: string } | { type: 'resume' };
export type ShellRequest = { type: 'ready' } | { type: 'notifications.status' | 'notifications.request' | 'notifications.settings' } | { type: 'theme'; scheme: 'light' | 'dark' } | { type: 'haptic'; style: 'selection' | 'success' | 'warning' } | { type: 'disconnected' | 'revoked' };
type Reply<R extends ShellRequest> = R extends { type: 'ready' } ? { events: ShellEvent[] } : R extends { type: 'notifications.status' | 'notifications.request' } ? { status: PermissionStatus } : Record<string, never>;
declare global {
  interface Window {
    __GHOST_SHELL__?: ShellInfo;
    webkit?: { messageHandlers?: { ghostShell?: { postMessage(request: ShellRequest): Promise<unknown> } } };
  }
}
export function isShellInfo(value: unknown): value is ShellInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Partial<ShellInfo>;
  return info.platform === 'ios' && typeof info.version === 'string' && typeof info.deviceId === 'string' && info.deviceId.length > 0;
}
export function isShellRequest(value: unknown): value is ShellRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  switch (request.type) {
    case 'ready': case 'notifications.status': case 'notifications.request': case 'notifications.settings': case 'disconnected': case 'revoked': return true;
    case 'theme': return request.scheme === 'light' || request.scheme === 'dark';
    case 'haptic': return request.style === 'selection' || request.style === 'success' || request.style === 'warning';
    default: return false;
  }
}
export const shell = typeof window !== 'undefined' && isShellInfo(window.__GHOST_SHELL__) ? window.__GHOST_SHELL__ : undefined;
export function isShellEvent(value: unknown): value is ShellEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<ShellEvent>;
  return event.type === 'resume' || (event.type === 'notification.open' && typeof event.notificationId === 'string' && event.notificationId.length > 0);
}
export function routeShellEvent(value: unknown, handler: (event: ShellEvent) => void): void {
  if (isShellEvent(value)) handler(value);
}
export async function shellCall<R extends ShellRequest>(request: R): Promise<Reply<R>> {
  const bridge = typeof window !== 'undefined' ? window.webkit?.messageHandlers?.ghostShell : undefined;
  if (!shell || !bridge) throw new Error('iPhone 앱에서 사용할 수 있습니다.');
  if (!isShellRequest(request)) throw new Error('지원하지 않는 앱 요청입니다.');
  return await bridge.postMessage(request) as Reply<R>;
}
export function onShellEvent(handler: (event: ShellEvent) => void): () => void {
  const listener = (event: Event) => routeShellEvent((event as CustomEvent<unknown>).detail, handler);
  window.addEventListener('ghost-shell', listener);
  return () => window.removeEventListener('ghost-shell', listener);
}
export async function ready(handler: (event: ShellEvent) => void): Promise<void> {
  const reply = await shellCall({ type: 'ready' });
  if (Array.isArray(reply.events)) for (const event of reply.events) routeShellEvent(event, handler);
}
export function haptic(): void { if (shell) void shellCall({ type: 'haptic', style: 'selection' }).catch(() => {}); }
