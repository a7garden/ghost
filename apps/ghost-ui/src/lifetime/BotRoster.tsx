import { DetailDialog } from '../components/DetailDialog';
import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, EmptyState, Input, InlineError, Textarea } from '@garden/ui';
import type { Response } from '../../../../contracts/lifetime/bindings.ts';
import type { LifetimeClient } from './types';
import { botAvailability, botBlocker, botDefinitionCommand, botLifecycleCommand, botOperationLabel, parseBotSurface } from './bots';
import type { BotSummary, BotSurface, BotTarget } from './bots';

interface Props {
  client: LifetimeClient;
  target: BotTarget;
  disabled: boolean;
  onRun: (key: string, operation: () => Promise<Response>) => Promise<Response | null>;
  onSelect: (target: BotTarget) => void;
  onCreate: () => void;
}

/** Existing Owner conversation's roster. This never calls global discovery. */
export function BotRoster({ client, target, disabled, onRun, onSelect, onCreate }: Props) {
  const [surface, setSurface] = useState<BotSurface | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [flow, setFlow] = useState<{ bot: BotSummary; action: 'update' | 'clone'; value: string } | null>(null);
  useEffect(() => {
    let mounted = true, timer = 0;
    const poll = async () => {
      try {
        const response = await client.request({ method: 'bot.surface.inspect', ...target });
        const next = parseBotSurface(response, target);
        if (mounted) { setSurface(next); setError(''); }
      } catch {
        if (mounted) setError('Ghost 상태를 확인하지 못했습니다. 새로 고침으로 다시 확인해 주세요.');
      } finally {
        if (mounted) timer = window.setTimeout(() => { if (document.visibilityState === 'hidden') timer = window.setTimeout(poll, 10000); else void poll(); }, 3000);
      }
    };
    void poll();
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [client, target.ghost_id, target.conversation_id, refresh]);
  const blocked = disabled || Boolean(error) || !surface;

  async function setMode(bot: BotSummary, next: 'active' | 'paused' | 'retired') {
    const command = botLifecycleCommand(bot, next);
    await onRun(`bot.lifecycle.set:${bot.ghost_id}`, () => client.request(command.body, command.expectedRevision));
    setRefresh(value => value + 1);
  }
  async function submitDefinition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!flow || blocked) return;
    let body;
    try { body = botDefinitionCommand(flow.bot, flow.action, flow.value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '변경할 내용을 확인해 주세요.'); return; }
    const response = await onRun(String(body.method), () => client.request(body));
    if (response?.status === 'success') { onSelect(flow.bot); setFlow(null); }
    setRefresh(value => value + 1);
  }

  return <section aria-label="이 대화의 Ghost" className="min-w-0">
    <Card className="gap-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-line py-0 pb-3 pt-4">
        <strong className="text-body font-semibold text-ink">나의 Ghost</strong>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="icon" type="button" onClick={() => setRefresh(value => value + 1)} aria-label="Ghost 상태 새로 고침"><RefreshCw size={14}/></Button>
          <Button variant="secondary" type="button" disabled={disabled} onClick={onCreate}>이 작업을 Ghost로 만들기</Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 pt-3">
        {error && <InlineError>{error}</InlineError>}
        {!surface && !error && <p role="status" className="m-0 text-ui text-ink-2">Ghost 상태 확인 중</p>}
        {surface && <BotStatusList surface={surface}/>}
        {surface?.truncated && <p className="m-0 text-caption text-ink-2">최근 생성 요청 128개를 표시합니다.</p>}
        {surface?.bots.map(bot => <article key={bot.ghost_id} className="grid gap-2 rounded-card border border-line bg-inset p-3">
          <h3 className="m-0 text-ui font-semibold text-ink [overflow-wrap:anywhere]">{bot.display_name} · {botAvailability(bot)}</h3>
          <p className="m-0 text-caption text-ink-2 [overflow-wrap:anywhere]">{bot.purpose}</p>
          {bot.memory && bot.memory.state !== 'verified' && <p role="status" className="m-0 text-caption text-orange [overflow-wrap:anywhere]">{botBlocker(bot.memory.reason)}</p>}
          {bot.required_capabilities.length > 0 && <p className="m-0 text-caption text-ink-2">{bot.required_capabilities.join(' · ')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={blocked || !bot.admission_allowed} onClick={() => onSelect(bot)}>대화하기</Button>
            <Button type="button" variant="secondary" disabled={blocked || bot.mode === 'retired'} onClick={() => setFlow({ bot: structuredClone(bot), action: 'update', value: '' })}>역할 수정</Button>
            <Button type="button" variant="secondary" disabled={blocked} onClick={() => setFlow({ bot: structuredClone(bot), action: 'clone', value: `${bot.display_name} 사본` })}>새 Ghost로 복제</Button>
            {bot.mode !== 'retired' && <Button type="button" variant="secondary" disabled={blocked} onClick={() => void setMode(bot, bot.mode === 'paused' ? 'active' : 'paused')}>{bot.mode === 'paused' ? '재개' : '일시정지'}</Button>}
            {bot.mode !== 'retired' && <Button type="button" variant="ghost" className="text-red" disabled={blocked} onClick={() => void setMode(bot, 'retired')}>사용 종료</Button>}
          </div>
          <div className="flex flex-wrap gap-2">
            <DetailDialog title="입력과 결과"><pre className="garden-document-source-readonly"><code>{JSON.stringify({ input: bot.input_contract, output: bot.output_contract }, null, 2)}</code></pre></DetailDialog>
            <DetailDialog title="판본과 기록"><p className="m-0">Pi · 정의 {bot.definition_ref.revision}</p><code className="block font-mono text-caption text-ink-2 [overflow-wrap:anywhere]">{bot.ghost_id} · {bot.definition_ref.digest}</code><p className="m-0 text-caption text-ink-2">일시정지와 사용 종료 후에도 기존 작업과 기록은 유지됩니다.</p></DetailDialog>
          </div>
        </article>)}
        {flow && <form className="grid gap-3 rounded-card border border-line-strong bg-surface p-3" onSubmit={event => void submitDefinition(event)}>
          <h4 className="m-0 text-ui font-semibold text-ink">{flow.bot.display_name} · {flow.action === 'update' ? '역할 수정' : '새 Ghost로 복제'}</h4>
          {flow.action === 'update'
            ? <label className="grid gap-1.5 text-caption text-ink-2">역할 지시<Textarea value={flow.value} maxLength={32768} required rows={4} onChange={event => setFlow({ ...flow, value: event.target.value })}/></label>
            : <><label className="grid gap-1.5 text-caption text-ink-2">새 이름<Input value={flow.value} maxLength={256} required onChange={event => setFlow({ ...flow, value: event.target.value })}/></label>
              <p className="m-0 text-caption text-ink-2">기억과 대화, 자격 증명은 복사하지 않습니다.</p></>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" disabled={disabled} onClick={() => setFlow(null)}>닫기</Button>
            <Button type="submit" disabled={blocked || !flow.value.trim()}>{flow.action === 'update' ? '수정안 평가' : '새 Ghost 만들기'}</Button>
          </div>
        </form>}
      </CardContent>
    </Card>
  </section>;
}

/** Pure view kept separate so cold-reload and failed-state fixtures exercise real labels. */
export function BotStatusList({ surface }: { surface: BotSurface }) {
  return <div aria-live="polite" className="grid gap-2">
    {surface.operations.filter(operation => operation.state !== 'ready' || !surface.bots.some(bot => bot.ghost_id === operation.ghost_id)).map(operation => <article key={operation.candidate_id} className="grid gap-1 rounded-card border border-line bg-inset p-3">
      <strong className="text-ui font-medium text-ink">{operation.display_name}</strong>
      <span className="text-caption text-ink-2">{botOperationLabel(operation)}</span>
      <p className="m-0 text-caption text-ink-2 [overflow-wrap:anywhere]">{operation.purpose}</p>
      {botBlocker(operation.blocker) && <p className="m-0 text-caption text-orange [overflow-wrap:anywhere]">{botBlocker(operation.blocker)}</p>}
    </article>)}
    {surface.bots.length === 0 && surface.operations.length === 0 && <EmptyState title="이 대화에서 만든 Ghost 없음"/>}
  </div>;
}
