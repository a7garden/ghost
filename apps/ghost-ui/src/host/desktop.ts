import { readCompanionPreferences, saveCompanionPreferences } from '../companion/preferences';

type DesktopBridge = { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
declare global {
  interface Window { __TAURI_INTERNALS__?: DesktopBridge; }
}


export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__) && !/iPhone|iPad/.test(navigator.userAgent);
}

export function desktopInvoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T> {
  const desktop = isDesktopShell() ? window.__TAURI_INTERNALS__ : undefined;
  return desktop ? desktop.invoke<T>(command, args) : Promise.reject(new Error('데스크톱 앱에서 사용할 수 있습니다.'));
}

/** One shell update the host offers; the shell compares `version` with its own. */
export type ShellUpdate = { version: string; notes: string };

/** The desktop shell's own version (Tauri command `shell_version`). */
export function shellVersion(): Promise<string> {
  return desktopInvoke<string>('shell_version');
}

/** The shell update the host offers, or `null` when the shell is current (Tauri command `shell_update_check`). */
export function shellUpdateCheck(): Promise<ShellUpdate | null> {
  return desktopInvoke<ShellUpdate | null>('shell_update_check');
}

/** Download, install and restart the desktop shell (Tauri command `shell_update_install`). */
export function shellUpdateInstall(): Promise<void> {
  return desktopInvoke('shell_update_install');
}

/** Shell state survives a Host port/origin change; synchronize the shared UI preference at startup. */
export async function initializeDesktopCompanion(): Promise<void> {
  if (!isDesktopShell()) return;
  const enabled = await desktopInvoke<boolean>('companion_enabled');
  const saved = readCompanionPreferences();
  if (saved.enabled !== enabled) saveCompanionPreferences({ ...saved, enabled });
  await desktopInvoke('companion_set', { visible: enabled });
}
