import { useEffect, useState } from 'react';
import { faceColor, isGhostColor } from './appearance';
export interface Preferences { theme: 'system' | 'light' | 'dark'; animate: boolean; companion: boolean; companionProfile: string; ghostColor: string; }
const defaults: Preferences = { theme: 'system', animate: true, companion: false, companionProfile: '', ghostColor: 'auto' };
export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try { const saved = JSON.parse(localStorage.getItem('ghost-ui:preferences') ?? 'null'); const theme = saved?.theme ?? localStorage.getItem('ghost-ui:theme'); return { theme: ['system', 'light', 'dark'].includes(theme) ? theme : 'system', animate: saved?.animate !== false, companion: saved?.companion === true, companionProfile: typeof saved?.companionProfile === 'string' ? saved.companionProfile : '', ghostColor: isGhostColor(saved?.ghostColor) ? saved.ghostColor : 'auto' }; } catch { return defaults; }
  });
  const [storageError, setStorageError] = useState('');
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    // Garden resolves its token aliases on the root element, so the dark class belongs on <html>.
    const apply = () => { setSystemDark(media.matches); const theme = preferences.theme === 'system' ? (media.matches ? 'dark' : 'light') : preferences.theme; document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); };
    apply(); media.addEventListener('change', apply);
    const style = document.documentElement.style;
    if (preferences.ghostColor === 'auto') { style.removeProperty('--ghost-body-color'); style.removeProperty('--ghost-face-color'); }
    else { style.setProperty('--ghost-body-color', preferences.ghostColor); style.setProperty('--ghost-face-color', faceColor(preferences.ghostColor)); }
    try { localStorage.setItem('ghost-ui:preferences', JSON.stringify(preferences)); setStorageError(''); } catch { setStorageError('이 브라우저에 표시 설정을 저장하지 못했습니다.'); }
    return () => media.removeEventListener('change', apply);
  }, [preferences]);
  return { preferences, storageError, resolvedTheme: preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme, updatePreferences: (patch: Partial<Preferences>) => setPreferences(p => ({ ...p, ...patch })) };
}
