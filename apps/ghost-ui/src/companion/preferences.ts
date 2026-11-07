import { useEffect, useState } from 'react';

export const COMPANION_KEY = 'ghost-desktop:companion';
const CHANGED = 'ghost-companion-preferences';
export type CompanionSize = 's' | 'm' | 'l';
export interface CompanionPreferences { enabled: boolean; ghostId: string; size: CompanionSize; bubble: boolean; }
const defaults: CompanionPreferences = { enabled: false, ghostId: '', size: 'm', bubble: true };

export function readCompanionPreferences(): CompanionPreferences {
  const text = localStorage.getItem(COMPANION_KEY);
  if (!text) return { ...defaults };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ...defaults }; }
  if (!value || typeof value !== 'object') return { ...defaults };
  return {
    enabled: 'enabled' in value && value.enabled === true,
    ghostId: 'ghostId' in value && typeof value.ghostId === 'string' ? value.ghostId : '',
    size: 'size' in value && (value.size === 's' || value.size === 'l') ? value.size : 'm',
    bubble: !('bubble' in value) || value.bubble !== false,
  };
}

export function saveCompanionPreferences(value: CompanionPreferences): void {
  localStorage.setItem(COMPANION_KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(CHANGED));
}

export function useCompanionPreferences() {
  const [preferences, setPreferences] = useState<CompanionPreferences>(() => {
    try { return readCompanionPreferences(); } catch { return { ...defaults }; }
  });
  const [error, setError] = useState('');
  useEffect(() => {
    const sync = () => {
      try { setPreferences(readCompanionPreferences()); setError(''); }
      catch { setError('아바타 설정을 읽지 못했습니다.'); }
    };
    const storage = (event: StorageEvent) => { if (event.key === COMPANION_KEY || event.key === null) sync(); };
    window.addEventListener('storage', storage);
    window.addEventListener(CHANGED, sync);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(CHANGED, sync); };
  }, []);
  return { preferences, error };
}
