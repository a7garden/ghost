import '../ui/styles.css';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostProvider, useHost } from '../host/context';
import { useHostState } from '../host/store';
import { desktopInvoke } from '../host/desktop';
import { CompanionAvatar, companionGhost } from './Avatar';
import { readCompanionPreferences, saveCompanionPreferences, useCompanionPreferences } from './preferences';
import './companion.css';

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', systemDark.matches);
applyTheme();
systemDark.addEventListener('change', applyTheme);

function Companion() {
  const { store } = useHost();
  const { state, error: hostError } = useHostState(store);
  const { preferences, error: storageError } = useCompanionPreferences();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const clickTimer = useRef<number | undefined>(undefined);
  const ghost = companionGhost(state, preferences.ghostId);
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));

  useEffect(() => {
    let disposed = false;
    void desktopInvoke<boolean>('companion_enabled').then(enabled => {
      saveCompanionPreferences({ ...readCompanionPreferences(), enabled });
      if (!disposed) setReady(true);
    }).catch(report);
    const hide = () => {
      try { saveCompanionPreferences({ ...readCompanionPreferences(), enabled: false }); }
      catch (reason) { report(reason); }
    };
    window.addEventListener('ghost-companion-hide', hide);
    return () => { disposed = true; window.removeEventListener('ghost-companion-hide', hide); clearTimeout(clickTimer.current); };
  }, []);

  useEffect(() => {
    if (!ready || !state) return;
    void desktopInvoke('companion_resize', { size: preferences.size })
      .then(() => desktopInvoke('companion_set', { visible: preferences.enabled }))
      .catch(report);
  }, [ready, Boolean(state), preferences.size, preferences.enabled]);

  const selectOverlayGhost = () => {
    if (!ghost) return true;
    try {
      localStorage.setItem('ghost-overlay:target', JSON.stringify({ ghostId: ghost.id, conversationId: ghost.directConversationId }));
      return true;
    } catch (reason) { report(reason); return false; }
  };
  const openChat = () => {
    if (selectOverlayGhost()) void desktopInvoke('toggle_overlay').catch(report);
  };
  const status = error || storageError || hostError;
  return <main className="companion-window" aria-label="데스크톱 Ghost">
    {ghost && state && <button type="button" className="companion-hit" aria-label={`${ghost.name} 대화 열기`} title={status || `${ghost.name} · 두 번 누르면 Ghost 창 열기`}
      onMouseDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (clickTimer.current !== undefined) {
          clearTimeout(clickTimer.current);
          clickTimer.current = undefined;
          void desktopInvoke('focus_main').catch(report);
          return;
        }
        void desktopInvoke<boolean>('companion_drag').then(moved => {
          if (moved) return;
          clickTimer.current = window.setTimeout(() => {
            clickTimer.current = undefined;
            openChat();
          }, 300);
        }).catch(report);
      }}
      onClick={event => { if (event.detail === 0) openChat(); }}
      onContextMenu={event => {
        event.preventDefault();
        clearTimeout(clickTimer.current);
        clickTimer.current = undefined;
        if (selectOverlayGhost()) void desktopInvoke('companion_menu').catch(report);
      }}>
      <CompanionAvatar ghost={ghost} state={state} preferences={preferences}/>
    </button>}
    {status && <span className="companion-error" role="status" title={status}>연결 확인</span>}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('아바타 화면을 찾지 못했습니다.');
createRoot(root).render(<HostProvider><Companion/></HostProvider>);
