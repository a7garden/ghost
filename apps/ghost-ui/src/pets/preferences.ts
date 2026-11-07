import { useEffect, useState } from 'react';
// Ghost colors belong to each Ghost's look; there is no display-wide override.
export interface Preferences { theme: 'system' | 'light' | 'dark'; animate: boolean; }
const defaults: Preferences = { theme: 'system', animate: true };
export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try { const saved = JSON.parse(localStorage.getItem('ghost-ui:preferences') ?? 'null'); const theme = saved?.theme ?? localStorage.getItem('ghost-ui:theme'); return { theme: ['system', 'light', 'dark'].includes(theme) ? theme : 'system', animate: saved?.animate !== false }; } catch { return defaults; }
  });
  const [storageError, setStorageError] = useState('');
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { setSystemDark(media.matches); const theme = preferences.theme === 'system' ? (media.matches ? 'dark' : 'light') : preferences.theme; document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('ghost-ui:preferences', JSON.stringify(preferences)); setStorageError(''); } catch { setStorageError('이 브라우저에 표시 설정을 저장하지 못했습니다.'); }
    return () => media.removeEventListener('change', apply);
  }, [preferences]);
  return { preferences, storageError, resolvedTheme: preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme, updatePreferences: (patch: Partial<Preferences>) => setPreferences(p => ({ ...p, ...patch })) };
}
