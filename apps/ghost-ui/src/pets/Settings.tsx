import type { ReactNode } from 'react';
import { ChevronRight, Cpu, Palette, type LucideIcon } from 'lucide-react';
import { SettingsLayout, InlineError, Switch } from '../ui'
import type { Preferences } from './preferences';
import { ModelSettings } from './ModelSettings';
import { useCompact } from '../ui/adaptive';

export interface SettingsSection { id: string; label: string; icon: LucideIcon; content: ReactNode }

const themes: { value: Preferences['theme']; label: string }[] = [
  { value: 'system', label: '시스템' }, { value: 'light', label: '밝게' }, { value: 'dark', label: '어둡게' },
];

/** 설정 창 틀. 탭 내용은 섹션(team · devices · schedules · desktop)은 App이, 모델·화면은 여기서 그린다. */
export function Settings({ route, navigate, preferences, updatePreferences, storageError, sections }: {
  route: string;
  navigate: (path: string) => void;
  preferences: Preferences;
  updatePreferences: (p: Partial<Preferences>) => void;
  storageError: string;
  sections: SettingsSection[];
}) {
  const params = new URLSearchParams(route.split('?')[1]);
  const compact = useCompact();
  const items = [...sections.slice(0, 1), { id: 'models', label: '모델', icon: Cpu }, ...sections.slice(1), { id: 'appearance', label: '화면', icon: Palette }];
  const requested = params.get('tab');
  const tab = items.some(item => item.id === requested) ? requested! : items[0].id;
  const ghost = params.get('ghost');
  const changeTab = (next: string) => navigate(`/settings?tab=${next}${ghost && next === 'team' ? `&ghost=${encodeURIComponent(ghost)}` : ''}`);
  const shellSection = sections.find(section => section.id === tab);
  if (compact && !requested) return <section className="compact-settings-list" aria-label="설정 항목">
    {items.map(item => <button type="button" key={item.id} onClick={() => changeTab(item.id)}>
      <item.icon size={20} aria-hidden="true"/><span>{item.label}</span><ChevronRight size={16} aria-hidden="true"/>
    </button>)}
  </section>;
  return <SettingsLayout title="설정" compactDetail={compact} strings={{ navigationLabel: '설정 항목', contentLabel: '설정 내용' }}
    sections={items.map(item => ({ id: item.id, label: item.label, icon: <item.icon aria-hidden="true"/> }))}
    activeSection={tab} onSectionChange={changeTab}>
    {shellSection?.content}
    {storageError && <InlineError className="mt-4">{storageError}</InlineError>}
    {tab === 'models' && <ModelSettings/>}
    {tab === 'appearance' && <div className="appearance">
      <div className="theme-picker" role="radiogroup" aria-label="테마">
        {themes.map(theme => <button key={theme.value} type="button" role="radio" aria-checked={preferences.theme === theme.value}
          className="theme-picker__choice" data-theme-preview={theme.value} onClick={() => updatePreferences({ theme: theme.value })}>
          <span className="theme-picker__window" aria-hidden="true"><i/><i/><i/></span>
          <span className="theme-picker__label">{theme.label}</span>
        </button>)}
      </div>
      <label className="appearance__toggle" htmlFor="animate-switch">
        <span>Ghost 움직임</span>
        <Switch id="animate-switch" checked={preferences.animate} onCheckedChange={animate => updatePreferences({ animate })}/>
      </label>
    </div>}
  </SettingsLayout>;
}
