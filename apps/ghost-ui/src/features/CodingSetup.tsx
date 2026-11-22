import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import type { CodingAgentId, CodingPrefs, CodingSetup } from '@ghost/contract';
import { CopyButton } from '../components/MessageBody';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Button, InlineError, SegmentedControl, SelectField, SettingsGroup, SettingsRow } from '../ui';

const INSTALL_DOCS = 'https://herdr.dev/tui/docs/install/';
const INSTALL = 'curl -fsSL https://herdr.dev/install.sh | sh';
type SetupStatus = 'ready' | 'missing' | 'invalid' | 'stopped' | 'restart' | 'outdated' | 'unlinked';
const agentNotificationChoices = [
  { value: 'off', label: '끔' }, { value: 'blocked', label: '입력 필요할 때' }, { value: 'all', label: '입력 필요·끝났을 때' },
] as const;

/** The order follows herdr's dependencies. A missing agent or hook never blocks the connection. */
export function codingChecklist(setup: CodingSetup) {
  const connection = [
    { id: 'herdr', status: setup.herdr.path === null ? 'missing' : 'ready' },
    { id: 'config', status: setup.config.ok ? 'ready' : 'invalid' },
    { id: 'server', status: !setup.server ? 'stopped' : setup.server.restartNeeded || !setup.server.compatible ? 'restart' : 'ready' },
  ] as const;
  const agents = setup.agents.map(agent => ({ ...agent, status: (
    agent.path === null ? 'missing' : agent.integration === 'current' ? 'ready' : agent.integration === 'outdated' ? 'outdated' : 'unlinked'
  ) satisfies SetupStatus }));
  return { connection, agents,
    required: connection.some(row => row.status !== 'ready'),
    optional: agents.some(row => row.status !== 'ready'),
    alternateSessions: !setup.server ? setup.sessions.filter(session => session.running && session.name !== setup.session) : [],
  };
}

type SetupAction = { integration: CodingAgentId } | { prefs: CodingPrefs };
type SetupModel = {
  view: CodingSetup | null;
  readError: string;
  actionError: string;
  pending: SetupAction | null;
  act(action: SetupAction): Promise<void>;
  refresh(): void;
};

function useCodingSetup(pollOptional: boolean, onSessionChanged?: () => void): SetupModel {
  const { client } = useHost();
  const [view, setView] = useState<CodingSetup | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<SetupAction | null>(null);
  const busy = useRef(false);
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      let poll = true;
      try {
        const next = await client.codingSetup();
        if (!live || busy.current) return;
        setView(next);
        setReadError('');
        const { required, optional } = codingChecklist(next);
        poll = required || (optional && pollOptional);
      } catch (reason) {
        if (live && !busy.current) setReadError(reason instanceof Error ? reason.message : 'herdr 설정을 불러오지 못했습니다.');
      }
      if (live && poll) timer = setTimeout(() => void load(), 4000);
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, pending, pollOptional, revision]);

  async function act(action: SetupAction) {
    if (!view || busy.current) return;
    busy.current = true;
    setPending(action);
    setActionError('');
    try {
      if ('integration' in action) {
        setView(await client.installHerdrIntegration({ agent: action.integration }));
      } else {
        await client.send({ type: 'coding.set', ...action.prefs });
        if (view.prefs.session !== action.prefs.session) {
          setView(null);
          onSessionChanged?.();
        } else {
          setView({ ...view, prefs: action.prefs });
        }
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'herdr 설정을 바꾸지 못했습니다.');
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return { view, readError, actionError, pending, act, refresh };
}

function SetupCommand({ command, label }: { command: string; label: string }) {
  return <div className="coding-setup-command"><code>{command}</code><CopyButton label={label} getText={() => command}/></div>;
}

function SetupChecklist({ setup, pending, act, all = false }: {
  setup: CodingSetup; pending: SetupAction | null; act(action: SetupAction): Promise<void>; all?: boolean;
}) {
  const { connection, agents, alternateSessions } = codingChecklist(setup);
  const serverCommand = setup.prefs.session ? `herdr --session ${setup.prefs.session}` : 'herdr';
  const [herdr, config, server] = connection;
  const rows = [
    { id: 'herdr', status: herdr.status, title: 'herdr 설치', detail: herdr.status === 'ready'
      ? setup.herdr.version ?? '설치됨' : 'Mac 터미널에서 설치하세요.', action: herdr.status !== 'ready' && <>
      <SetupCommand command={INSTALL} label="설치 명령 복사"/>
      <a href={INSTALL_DOCS} target="_blank" rel="noreferrer">설치 안내</a>
    </> },
    { id: 'config', status: config.status, title: 'herdr 설정', detail: setup.config.ok ? '유효함' : setup.config.note || 'herdr 설정을 수정하세요.' },
    { id: 'server', status: server.status, title: `herdr 서버 · ${setup.session}`, detail: server.status === 'ready'
      ? '실행 중' : server.status === 'restart' ? 'herdr 서버를 재시작하세요.' : 'Mac 터미널에서 herdr를 여세요.', action: server.status === 'restart'
      ? <a href={`${INSTALL_DOCS}#update`} target="_blank" rel="noreferrer">재시작 안내</a>
      : server.status === 'stopped' && <>
        <SetupCommand command={serverCommand} label="실행 명령 복사"/>
        {alternateSessions.map(session => <div key={session.name} className="coding-setup-session">
          <code>{session.name}</code>
          <Button type="button" size="sm" variant="outline" disabled={Boolean(pending)} aria-label={`${session.name} · 이 세션 쓰기`}
            onClick={() => void act({ prefs: { ...setup.prefs, session: session.name } })}>이 세션 쓰기</Button>
        </div>)}
      </> },
    ...agents.map(agent => ({ id: agent.id, status: agent.status, title: agent.name, detail: agent.status === 'missing'
      ? 'Mac에 설치하세요.' : agent.status === 'outdated' ? '설치됨 · herdr 연동 업데이트 필요'
        : agent.status === 'unlinked' ? '설치됨 · herdr 연동 없음' : '설치됨 · herdr 연동 완료',
    action: setup.herdr.path !== null && (agent.status === 'outdated' || agent.status === 'unlinked') &&
      <Button type="button" size="sm" variant="outline" disabled={Boolean(pending)} aria-label={`${agent.name} 연동 설치`} onClick={() => void act({ integration: agent.id })}>
        {pending && 'integration' in pending && pending.integration === agent.id ? '설치 중…' : '연동 설치'}
      </Button> })),
  ];
  return <ol className="coding-setup-checklist" role="list">{rows.filter(row => all || row.status !== 'ready').map(row => {
    const Icon = row.status === 'ready' ? Check : CircleAlert;
    return <li key={row.id} data-status={row.status}>
      <Icon size={16} aria-hidden="true"/>
      <div className="coding-setup-copy"><strong>{row.title}</strong><p>{row.detail}</p>
        {row.action && <div className="coding-setup-actions">{row.action}</div>}
      </div>
    </li>;
  })}</ol>;
}

function SetupErrors({ model }: { model: SetupModel }) {
  return <>
    {model.readError && <InlineError onRetry={model.refresh} retryLabel="다시 불러오기">{model.readError}</InlineError>}
    {model.actionError && <InlineError>{model.actionError}</InlineError>}
  </>;
}

export function useCodingPageSetup(showOptional: boolean, onSessionChanged: () => void) {
  const [expanded, setExpanded] = useState(false);
  const model = useCodingSetup(showOptional && expanded, onSessionChanged);
  const checklist = model.view && codingChecklist(model.view);
  const panel = model.view && checklist && (checklist.required || checklist.optional) ? (
    checklist.required ? <section className="coding-setup" aria-label="herdr 연결">
      <h2>herdr 연결</h2>
      <SetupChecklist setup={model.view} pending={model.pending} act={model.act}/>
    </section> : <details className="coding-setup" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>에이전트 연동</summary>
      <SetupChecklist setup={model.view} pending={model.pending} act={model.act}/>
    </details>
  ) : null;
  return { setup: model.view, required: Boolean(checklist?.required), panel, refreshSetup: model.refresh,
    errors: model.readError || model.actionError ? <SetupErrors model={model}/> : null };
}

export function CodingSettings() {
  const model = useCodingSetup(true);
  const { view, pending, readError, act } = model;
  const sessionId = useId(), agentId = useId(), notifyId = useId();
  const { client, store } = useHost();
  const { state } = useHostState(store);
  const delivery = state?.settings?.codingDelivery ?? 'steer';
  const [deliveryError, setDeliveryError] = useState('');
  return <div className="coding-settings">
    <SetupErrors model={model}/>
    {deliveryError && <InlineError>{deliveryError}</InlineError>}
    <SettingsGroup title="작업 중 보내기">
      <SettingsRow label="지시를 보내는 방식" description="에이전트가 일하는 중에 보낸 지시를 어떻게 전할지 정합니다. ⌥Enter로 보내면 다른 방식으로 한 번 보냅니다. omp에서 구분하며 다른 에이전트는 자기 Enter 동작을 따릅니다.">
        <SegmentedControl aria-label="지시를 보내는 방식" value={delivery}
          onValueChange={value => {
            setDeliveryError('');
            client.send({ type: 'settings.update', codingDelivery: value }).catch(reason => setDeliveryError(reason instanceof Error ? reason.message : '설정을 저장하지 못했습니다.'));
          }}
          options={[{ value: 'steer', label: '스티어링', disabled: !state?.settings }, { value: 'queue', label: '대기열', disabled: !state?.settings }]}/>
      </SettingsRow>
    </SettingsGroup>
    {!view && !readError && <p role="status">herdr 설정을 불러오는 중…</p>}
    {view && <>
      <SettingsGroup title="세션과 에이전트">
        <SettingsRow label="herdr 세션" htmlFor={sessionId}>
          <SelectField id={sessionId} label="herdr 세션" value={view.prefs.session ? `session:${view.prefs.session}` : 'default'} disabled={Boolean(pending)}
            options={[{ value: 'default', label: '기본 세션' }, ...Array.from(new Set([view.session, ...view.sessions.map(session => session.name)]), name => ({ value: `session:${name}`, label: name }))]}
            onValueChange={value => void act({ prefs: { ...view.prefs, session: value === 'default' ? null : value.slice('session:'.length) } })}/>
        </SettingsRow>
        <SettingsRow label="기본 에이전트" htmlFor={agentId}>
          <SelectField id={agentId} label="기본 에이전트" value={view.prefs.agent ?? 'auto'} disabled={Boolean(pending)}
            options={[{ value: 'auto', label: '자동 선택' }, ...view.agents.map(agent => ({ value: agent.id, label: agent.name, disabled: agent.path === null && agent.id !== view.prefs.agent }))]}
            onValueChange={value => void act({ prefs: { ...view.prefs, agent: view.agents.find(agent => agent.id === value)?.id ?? null } })}/>
        </SettingsRow>
        <SettingsRow label="에이전트 알림" htmlFor={notifyId}>
          <SelectField id={notifyId} label="에이전트 알림" value={view.prefs.notify} disabled={Boolean(pending)}
            options={[...agentNotificationChoices]} onValueChange={value => {
              const choice = agentNotificationChoices.find(option => option.value === value);
              if (choice) void act({ prefs: { ...view.prefs, notify: choice.value } });
            }}/>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="herdr 연결">
        <SetupChecklist setup={view} pending={pending} act={act} all/>
      </SettingsGroup>
    </>}
  </div>;
}
