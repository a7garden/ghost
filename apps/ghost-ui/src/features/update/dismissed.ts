const KEY = 'ghost-ui:update-dismissed';

/** Versions the owner put off with 「나중에」; a different (newer) version asks again. */
export function loadDismissedVersions(storage: Pick<Storage, 'getItem'> = localStorage): string[] {
  try {
    const saved: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((version): version is string => typeof version === 'string') : [];
  } catch { return []; }
}

/** A dismissal applies to one offered version, never to future releases. */
export function isVersionDismissed(version: string, dismissed: readonly string[]): boolean {
  return dismissed.includes(version);
}

export function dismissVersion(version: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  try { storage.setItem(KEY, JSON.stringify([...new Set([...loadDismissedVersions(storage), version])])); }
  catch { /* 사설 모드 등에서 못 저장해도 동작에는 지장 없다 */ }
}
