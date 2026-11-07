type FolderPickerShell = { invoke(command: 'pick_folder'): Promise<string | null> };

// Tauri injects this bridge before the app loads; the browser never installs it.
const desktopWindow = typeof window !== 'undefined' ? window as Window & { __TAURI_INTERNALS__?: FolderPickerShell } : undefined;
const shell = desktopWindow && /Mac/.test(navigator.platform) && !/iPhone|iPad/.test(navigator.userAgent)
  ? desktopWindow.__TAURI_INTERNALS__
  : undefined;

/** Native folder selection is available only in the macOS desktop shell. */
export const canPickFolder = shell !== undefined;

export function pickFolder(): Promise<string | null> {
  if (!shell) return Promise.reject(new Error('데스크톱 앱에서 폴더를 선택해 주세요.'));
  return shell.invoke('pick_folder');
}
