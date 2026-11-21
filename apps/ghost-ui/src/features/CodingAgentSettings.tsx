import { useCallback, useEffect, useState } from 'react';
import type { CodingAgentId, CodingAgentsView } from '@ghost/contract';
import { Badge, Button, InlineError, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';
import { RecentCodingSessions } from './CodingSession';

/** The agent a run uses when no one names one: the owner's pick if it can run, else the first that can. */
export function usedByDefault(view: CodingAgentsView): CodingAgentId | null {
  const usable = view.agents.filter(agent => agent.ready && !view.disabled.includes(agent.id));
  return (usable.find(agent => agent.id === view.default) ?? usable[0])?.id ?? null;
}

/** 이 Mac에서 Host가 찾은 코딩 에이전트와, 그중 무엇을 쓸지. */
export function CodingAgentSettings() {
  const { client } = useHost();
  const [view, setView] = useState<CodingAgentsView | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const failed = (reason: unknown) => setError(reason instanceof Error ? reason.message : '불러오지 못했습니다.');
  const look = useCallback(async (refresh: boolean) => {
    setPending(true); setError('');
    try { setView(await client.codingAgents(refresh)); }
    catch (reason) { failed(reason); }
    finally { setPending(false); }
  }, [client]);
  useEffect(() => { void look(false); }, [look]);

  const choose = async (next: Pick<CodingAgentsView, 'default' | 'disabled'>) => {
    if (!view) return;
    setPending(true); setError('');
    try { await client.send({ type: 'coding.set', ...next }); setView({ ...view, ...next }); }
    catch (reason) { failed(reason); }
    finally { setPending(false); }
  };
  const toggle = (id: CodingAgentId, on: boolean) => view && choose({
    default: !on && view.default === id ? null : view.default,
    disabled: on ? view.disabled.filter(entry => entry !== id) : [...view.disabled, id],
  });

  const active = view ? usedByDefault(view) : null;
  return <section className="flex min-w-0 flex-col gap-6" aria-label="코딩 에이전트">
    <SettingsGroup title="코딩 에이전트" actions={<Button variant="outline" type="button" disabled={pending} onClick={() => void look(true)}>다시 찾기</Button>}>
      {error && <InlineError>{error}</InlineError>}
      {view && view.agents.length === 0 && <p className="m-0 text-caption text-ink-3">이 Mac에서 찾지 못했습니다.</p>}
      {view?.agents.map(agent => {
        const off = view.disabled.includes(agent.id);
        return <SettingsRow key={agent.id}
          label={<span className="flex flex-wrap items-center gap-2">
            {agent.name}{agent.version && <span className="text-caption font-normal text-ink-3">{agent.version}</span>}
            {agent.id === active && <Badge variant="success">기본</Badge>}
            {!agent.ready && <Badge variant="danger">쓸 수 없음</Badge>}
          </span>}
          description={<>
            <span className="block break-all font-mono">{agent.path}</span>
            {agent.note && <span className="mt-0.5 block">{agent.note}</span>}
          </>}>
          <span className="flex items-center gap-3">
            {agent.ready && !off && agent.id !== active && <Button variant="outline" size="sm" type="button" disabled={pending} onClick={() => void choose({ default: agent.id, disabled: view.disabled })}>기본으로</Button>}
            <Switch aria-label={`${agent.name} 사용`} checked={!off} disabled={pending} onCheckedChange={on => void toggle(agent.id, on)}/>
          </span>
        </SettingsRow>;
      })}
    </SettingsGroup>
    <RecentCodingSessions/>
  </section>;
}
