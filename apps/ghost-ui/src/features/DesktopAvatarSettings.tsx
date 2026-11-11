import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { desktopInvoke, initializeDesktopCompanion, isDesktopShell } from '../host/desktop';
import { Button, InlineError, SegmentedControl, SelectField, Switch } from '../ui';
import { CompanionAvatar, companionGhost } from '../companion/Avatar';
import { saveCompanionPreferences, useCompanionPreferences, type CompanionPreferences, type CompanionSize } from '../companion/preferences';
import '../companion/companion.css';

export default function DesktopAvatarSettings() {
  const { store } = useHost();
  const { state } = useHostState(store);
  const { preferences, error: storageError } = useCompanionPreferences();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const ghost = companionGhost(state, preferences.ghostId);
  const ghosts = state?.ghosts.filter(item => item.state !== 'retired') ?? [];
  useEffect(() => {
    void initializeDesktopCompanion().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  if (!isDesktopShell()) return null;

  const update = async (patch: Partial<CompanionPreferences>) => {
    if (saving) return;
    setSaving(true); setError('');
    const next = { ...preferences, ...patch };
    try {
      saveCompanionPreferences(next);
      if (patch.enabled !== undefined) {
        try { await desktopInvoke('companion_set', { visible: next.enabled }); }
        catch (reason) { saveCompanionPreferences(preferences); throw reason; }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '아바타 설정을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  return <section className="desktop-avatar-settings" aria-label="데스크톱 아바타">
    <header className="desktop-avatar-heading">
      <label htmlFor="desktop-avatar-enabled">데스크톱에 표시</label>
      <Switch id="desktop-avatar-enabled" checked={preferences.enabled} disabled={saving} onCheckedChange={enabled => void update({ enabled })}/>
    </header>
    <div className="desktop-avatar-workbench">
      <div className="desktop-avatar-preview" role="img" aria-label={ghost ? `${ghost.name} 데스크톱 아바타 미리보기` : '아바타 미리보기'}>
        {ghost && state ? <CompanionAvatar ghost={ghost} state={state} preferences={preferences}/> : <span className="text-caption text-ink-3">Ghost를 불러오는 중</span>}
      </div>
      <div className="desktop-avatar-controls">
        <label className="desktop-avatar-field" htmlFor="desktop-avatar-ghost"><span>Ghost</span>
          <SelectField id="desktop-avatar-ghost" label="Ghost" value={ghosts.some(item => item.id === preferences.ghostId) ? preferences.ghostId : '__main__'} disabled={saving}
            options={[{ value: '__main__', label: '메인 Ghost' }, ...ghosts.map(item => ({ value: item.id, label: item.name }))]}
            onValueChange={ghostId => void update({ ghostId: ghostId === '__main__' ? '' : ghostId })}/>
        </label>
        <div className="desktop-avatar-field"><span id="desktop-avatar-size-label">크기</span>
          <SegmentedControl<CompanionSize> aria-label="크기" value={preferences.size} onValueChange={size => void update({ size })}
            options={[{ value: 's', label: '작게', disabled: saving }, { value: 'm', label: '보통', disabled: saving }, { value: 'l', label: '크게', disabled: saving }]}/>
        </div>
        <div className="desktop-avatar-bubble-control"><label htmlFor="desktop-avatar-bubble">일 표시</label>
          <Switch id="desktop-avatar-bubble" checked={preferences.bubble} disabled={saving} onCheckedChange={bubble => void update({ bubble })}/>
        </div>
        <Button variant="outline" className="desktop-avatar-reset" disabled={saving} onClick={() => {
          setError('');
          void desktopInvoke('companion_reset_position').catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
        }}><RotateCcw size={14}/>위치 초기화</Button>
      </div>
    </div>
    {(error || storageError) && <InlineError>{error || storageError}</InlineError>}
  </section>;
}
