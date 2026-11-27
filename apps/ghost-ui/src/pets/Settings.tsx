import { isValidElement, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { ArrowRight, Cpu, Palette, ShieldCheck, type LucideIcon } from 'lucide-react';
import { SettingsLayout, InlineError, Switch } from '../ui';
import { StateGlyph, type GlyphState } from '../components/agent/StateGlyph';
import { secureFormProposal } from '../features/decisionText';
import { handedOver } from '../features/ghostState';
import { hostStatus } from '../features/hostStatus';
import { UpdateSettings } from '../features/UpdateSettings';
import { updateOffer, updatePollingPhase } from '../features/update/useUpdate';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import type { Preferences } from './preferences';
import { ModelSettings } from './ModelSettings';
import { modelDisplayName } from './ModelPicker';
import { ApprovalSettings } from './ApprovalSettings';
import { blurTouchSearchOnEnter, useCompact } from '../ui/adaptive';
import { uiTerms } from '../uiText';
import '../ui/settings-frame.css';

export interface SettingsSection { id: string; label: string; icon: LucideIcon; content: ReactNode; wide?: boolean }

type SettingsStatus = { glyph: GlyphState; label: string; count?: number };
type SettingsItem = Pick<SettingsSection, 'id' | 'label' | 'icon'> & { status?: SettingsStatus; value?: string };
type IndexPosition = { scroll: number; query: string; row: string; advanced: boolean };

const subscribeWithoutUpdate = () => () => {};
const noUpdate = () => null;
const indexPosition = (): IndexPosition | undefined => history.state?.settingsIndex;

const themes: { value: Preferences['theme']; label: string }[] = [
  { value: 'system', label: '시스템' }, { value: 'light', label: '밝게' }, { value: 'dark', label: '어둡게' },
];

/** Daily settings first; the machinery a person rarely needs sits behind one 「고급」 fold. */
const settingsGroups: { label: string; folded?: boolean; ids: string[] }[] = [
  { label: 'Ghost와 일', ids: ['team', 'models', 'approvals', 'duty', 'schedules', 'activities', 'voice'] },
  { label: '연결과 기기', ids: ['connections', 'vault', 'devices', 'coding'] },
  { label: '앱', ids: ['appearance', 'desktop', 'host', 'update'] },
  { label: uiTerms.advanced, folded: true, ids: ['rules', 'history', 'limits', 'metrics', 'slots', 'mcp'] },
];

function SettingsStatusMark({ status }: { status: SettingsStatus }) {
  return <span className="settings-status" title={status.label}>
    <StateGlyph state={status.glyph} size={15} accessibleLabel={status.count === undefined ? status.label : `${status.label} ${status.count}건`}/>
    {status.count !== undefined && <span className="settings-status__count" aria-hidden="true">{status.count}</span>}
  </span>;
}

function SettingsIndex({ items, select }: { items: SettingsItem[]; select(id: string): void }) {
  const [query, setQuery] = useState(() => indexPosition()?.query ?? '');
  const [advanced, setAdvanced] = useState(() => indexPosition()?.advanced ?? false);
  const list = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const saved = indexPosition();
    if (!saved || !list.current) return;
    list.current.scrollTop = saved.scroll;
    document.getElementById(`settings-index-${saved.row}`)?.focus({ preventScroll: true });
  }, []);
  const needle = query.trim().toLocaleLowerCase();
  const matches = items.filter(item => item.label.toLocaleLowerCase().includes(needle));
  const row = (item: SettingsItem) => {
    const id = `settings-index-${item.id}`;
    const meta = item.status ? [item.status.label, item.value].filter(Boolean).join(' · ') : item.value;
    return <button type="button" id={id} className="settings-index-row" key={item.id} aria-label={item.label}
      aria-describedby={meta ? `${id}-value` : undefined} onClick={() => {
        history.replaceState({ ...history.state, settingsIndex: { scroll: list.current?.scrollTop ?? 0, query, row: item.id, advanced } }, '');
        select(item.id);
      }}>
      <span className="settings-index-row__icon" aria-hidden="true">
        {item.status ? <StateGlyph state={item.status.glyph} size={18}/> : <item.icon size={18}/>}
      </span>
      <span className="settings-index-row__copy">
        <span className="settings-index-row__title">{item.label}</span>
        {meta && <span id={`${id}-value`} className="settings-index-row__value">
          {meta}{item.status?.count !== undefined && <span className="sr-only"> {item.status.count}건</span>}
        </span>}
      </span>
      {item.status?.count !== undefined && <span className="settings-status__count" aria-hidden="true">{item.status.count}</span>}
      <ArrowRight className="settings-index-row__arrow" size={15} aria-hidden="true"/>
    </button>;
  };
  const ungrouped = items.filter(item => !settingsGroups.some(group => group.ids.includes(item.id)));
  return <section ref={list} className="compact-settings-list" aria-label="설정 항목">
    <input className="mobile-list-search" type="search" aria-label="설정 찾기" placeholder="설정 찾기" enterKeyHint="search"
      value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>
    {needle ? matches.length ? <div className="settings-index__rows">{matches.map(row)}</div>
      : <p className="conversations__empty" role="status">일치하는 설정이 없습니다.</p>
      : <>{settingsGroups.map(group => {
        const entries = items.filter(item => group.ids.includes(item.id));
        if (!entries.length) return null;
        const rows = <div className="settings-index__rows">{entries.map(row)}</div>;
        return group.folded
          ? <details key={group.label} className="settings-index-fold" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
              <summary>{group.label}</summary>{rows}
            </details>
          : <section key={group.label}><h2>{group.label}</h2>{rows}</section>;
      })}{ungrouped.length > 0 && <div className="settings-index__rows">{ungrouped.map(row)}</div>}</>}
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
  const { store } = useHost();
  const { state, connection, offlineSince } = useHostState(store);
  const host = hostStatus(connection, Boolean(state), offlineSince, Date.now());
  // App already passes the shared monitor to the update page. Reuse that store; no second poll.
  const updatePage = sections.find(section => section.id === 'update')?.content;
  const monitor = isValidElement<ComponentProps<typeof UpdateSettings>>(updatePage) && updatePage.type === UpdateSettings
    ? updatePage.props.monitor : undefined;
  const update = useSyncExternalStore(monitor?.subscribe ?? subscribeWithoutUpdate, monitor?.get ?? noUpdate, monitor?.get ?? noUpdate);
  const offer = updateOffer(update?.status ?? null, update?.shell ?? null);
  const settings = state?.settings;
  const defaultModel = settings?.defaultModel;
  const modelProvider = settings?.providers.find(provider => provider.id === defaultModel?.provider);
  const missingProviders = settings?.providers.reduce((count, provider) => count + Number(!provider.hasCredential), 0) ?? 0;
  const missingAccounts = state?.connections?.reduce((count, account) => count + Number(!account.hasCredential), 0) ?? 0;
  const vaultRequests = state?.decisions.reduce((count, decision) =>
    count + Number(decision.state === 'pending' && !handedOver(decision) && Boolean(secureFormProposal(decision))), 0) ?? 0;
  const principal = state?.principal;
  const missingDevice = principal?.kind === 'device' && !state?.devices.some(device => device.id === principal.deviceId);
  const modelStatus: SettingsStatus | undefined = state && !state.runtime.ready ? { glyph: 'failed', label: '대화 실행 불가' }
    : settings && !defaultModel ? { glyph: 'attention', label: '기본 모델 미지정' }
      : defaultModel && (!modelProvider || !modelProvider.models.some(model => model.id === defaultModel.model)) ? { glyph: 'attention', label: '기본 모델 확인 필요' }
        : missingProviders > 0 ? { glyph: 'attention', label: '제공자 인증 필요', count: missingProviders }
          : undefined;
  const statuses: Partial<Record<string, SettingsStatus>> = {
    models: modelStatus,
    host: host.state === 'offline' ? { glyph: 'failed', label: host.label }
      : host.state === 'reconnecting' && !host.quiet ? { glyph: 'attention', label: host.label } : undefined,
    update: offer && !updatePollingPhase(update?.status?.phase) ? { glyph: 'verifying', label: '업데이트 가능' } : undefined,
    connections: missingAccounts ? { glyph: 'attention', label: '인증 정보 필요', count: missingAccounts } : undefined,
    vault: vaultRequests ? { glyph: 'attention', label: '금고 요청 대기', count: vaultRequests } : undefined,
    devices: missingDevice ? { glyph: 'failed', label: '이 기기의 등록 정보 없음' } : undefined,
  };
  const values: Partial<Record<string, string>> = {
    models: defaultModel ? modelDisplayName(settings, defaultModel) : undefined,
    host: statuses.host || host.quiet ? undefined : host.label,
    update: offer?.version ?? update?.status?.current.version,
    devices: missingDevice ? undefined : principal?.kind === 'device' ? principal.name : state ? `등록 ${state.devices.length}대` : undefined,
    appearance: themes.find(theme => theme.value === preferences.theme)?.label,
  };
  const unordered = [...sections.slice(0, 1), { id: 'models', label: '모델', icon: Cpu }, { id: 'approvals', label: '승인과 언어', icon: ShieldCheck }, ...sections.slice(1), { id: 'appearance', label: '화면', icon: Palette }];
  const items = [...settingsGroups.flatMap(group => group.ids.flatMap(id => unordered.filter(item => item.id === id))), ...unordered.filter(item => !settingsGroups.some(group => group.ids.includes(item.id)))];
  const indexItems = items.map(item => ({ ...item, status: statuses[item.id], value: values[item.id] }));
  const requested = params.get('tab');
  const tab = items.some(item => item.id === requested) ? requested! : items[0].id;
  const ghost = params.get('ghost');
  const changeTab = (next: string) => navigate(`/settings?tab=${next}${ghost && next === 'team' ? `&ghost=${encodeURIComponent(ghost)}` : ''}`);
  const shellSection = sections.find(section => section.id === tab);
  if (compact && !requested) return <SettingsIndex items={indexItems} select={changeTab}/>;
  return <SettingsLayout className="ghost-settings--frame" pageTitle={items.find(item => item.id === tab)?.label}
    compactDetail={compact} wide={tab === 'team' || shellSection?.wide} strings={{ navigationLabel: '설정 항목', contentLabel: '설정 내용' }}
    sections={indexItems.map(item => {
      const group = settingsGroups.find(entry => entry.ids.includes(item.id));
      return { id: item.id, label: item.label, icon: <item.icon aria-hidden="true"/>, group: group?.label, folded: group?.folded,
        status: item.status && <SettingsStatusMark status={item.status}/> };
    })} foldedLabel={uiTerms.advanced} activeSection={tab} onSectionChange={changeTab}>
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
