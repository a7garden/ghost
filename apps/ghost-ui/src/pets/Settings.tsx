import { useState, type ReactNode } from 'react';
import { ChevronRight, Cpu, Palette, ShieldCheck, type LucideIcon } from 'lucide-react';
import { SettingsLayout, InlineError, Switch } from '../ui'
import type { Preferences } from './preferences';
import { ModelSettings } from './ModelSettings';
import { ApprovalSettings } from './ApprovalSettings';
import { blurTouchSearchOnEnter, useCompact } from '../ui/adaptive';

export interface SettingsSection { id: string; label: string; icon: LucideIcon; content: ReactNode }

const themes: { value: Preferences['theme']; label: string }[] = [
  { value: 'system', label: '시스템' }, { value: 'light', label: '밝게' }, { value: 'dark', label: '어둡게' },
];

const settingsGroups = [
  { label: 'Ghost와 실행', ids: ['team', 'models', 'voice', 'approvals', 'duty', 'schedules', 'activities'] },
  { label: '연결과 기기', ids: ['devices', 'connections', 'vault', 'coding', 'mcp'] },
  { label: '화면과 앱', ids: ['appearance', 'desktop', 'update'] },
  { label: '호스트 운영', ids: ['slots', 'limits', 'rules', 'history', 'metrics', 'host'] },
];

function SettingsIndex({ items, select }: { items: { id: string; label: string; icon: LucideIcon }[]; select(id: string): void }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const matches = items.filter(item => item.label.toLocaleLowerCase().includes(needle));
  const row = (item: typeof items[number]) => <button type="button" className="settings-index-row" key={item.id} onClick={() => select(item.id)}>
    <item.icon size={18} aria-hidden="true"/><span>{item.label}</span><ChevronRight size={15} aria-hidden="true"/>
  </button>;
  const ungrouped = items.filter(item => !settingsGroups.some(group => group.ids.includes(item.id)));
  return <section className="compact-settings-list" aria-label="설정 항목">
    <input className="mobile-list-search" type="search" aria-label="설정 찾기" placeholder="설정 찾기" enterKeyHint="search"
      value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>
    {needle ? matches.length ? matches.map(row) : <p className="conversations__empty" role="status">일치하는 설정이 없습니다.</p>
      : <>{settingsGroups.map(group => {
        const entries = items.filter(item => group.ids.includes(item.id));
        return entries.length > 0 && <section key={group.label}><h2>{group.label}</h2>{entries.map(row)}</section>;
      })}{ungrouped.map(row)}</>}
  </section>;
}
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
  const items = [...sections.slice(0, 1), { id: 'models', label: '모델', icon: Cpu }, { id: 'approvals', label: '승인과 언어', icon: ShieldCheck }, ...sections.slice(1), { id: 'appearance', label: '화면', icon: Palette }];
  const requested = params.get('tab');
  const tab = items.some(item => item.id === requested) ? requested! : items[0].id;
  const ghost = params.get('ghost');
  const changeTab = (next: string) => navigate(`/settings?tab=${next}${ghost && next === 'team' ? `&ghost=${encodeURIComponent(ghost)}` : ''}`);
  const shellSection = sections.find(section => section.id === tab);
  if (compact && !requested) return <SettingsIndex items={items} select={changeTab}/>;
  return <SettingsLayout title="설정" compactDetail={compact} strings={{ navigationLabel: '설정 항목', contentLabel: '설정 내용' }}
    sections={items.map(item => ({ id: item.id, label: item.label, icon: <item.icon aria-hidden="true"/> }))}
    activeSection={tab} onSectionChange={changeTab}>
    {shellSection?.content}
    {storageError && <InlineError className="mt-4">{storageError}</InlineError>}
    {tab === 'models' && <ModelSettings/>}
    {tab === 'approvals' && <ApprovalSettings/>}
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
