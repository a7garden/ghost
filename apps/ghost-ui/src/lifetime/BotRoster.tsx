import { DetailDialog } from '../components/DetailDialog';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
  async function submitDefinition() {
    if (!flow || blocked) return;
    let body;
    try { body = botDefinitionCommand(flow.bot, flow.action, flow.value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '변경할 내용을 확인해 주세요.'); return; }
    const response = await onRun(String(body.method), () => client.request(body));
    if (response?.status === 'success') { onSelect(flow.bot); setFlow(null); }
    setRefresh(value => value + 1);
  }

  return <section className="lifetime-outbox" aria-label="이 대화의 Ghost">
    <div className="lifetime-section-heading"><h3>나의 Ghost</h3><div className="lifetime-heading-actions">
      <button className="button secondary" type="button" onClick={() => setRefresh(value => value + 1)} aria-label="Ghost 상태 새로 고침"><RefreshCw size={14}/></button>
      <button className="button secondary" type="button" disabled={disabled} onClick={onCreate}>이 작업을 Ghost로 만들기</button>
    </div></div>
    {error && <p className="lifetime-alert" role="alert">{error}</p>}
    {!surface && !error && <p role="status">Ghost 상태 확인 중</p>}
    {surface && <BotStatusList surface={surface}/>}
    {surface?.truncated && <p className="lifetime-empty">최근 생성 요청 128개를 표시합니다.</p>}
    {surface?.bots.map(bot => <section key={bot.ghost_id} className="lifetime-artifact"><h3>{bot.display_name} · {botAvailability(bot)}</h3>
      <p>{bot.purpose}</p>
      {bot.memory && bot.memory.state !== 'verified' && <p role="status">{botBlocker(bot.memory.reason)}</p>}
      {bot.required_capabilities.length > 0 && <p>{bot.required_capabilities.join(' · ')}</p>}
      <div className="lifetime-submit-actions">
        <button type="button" className="button primary" disabled={blocked || !bot.admission_allowed} onClick={() => onSelect(bot)}>대화하기</button>
        <button type="button" className="button secondary" disabled={blocked || bot.mode === 'retired'} onClick={() => setFlow({ bot: structuredClone(bot), action: 'update', value: '' })}>역할 수정</button>
        <button type="button" className="button secondary" disabled={blocked} onClick={() => setFlow({ bot: structuredClone(bot), action: 'clone', value: `${bot.display_name} 사본` })}>새 Ghost로 복제</button>
        {bot.mode !== 'retired' && <button type="button" className="button secondary" disabled={blocked} onClick={() => void setMode(bot, bot.mode === 'paused' ? 'active' : 'paused')}>{bot.mode === 'paused' ? '재개' : '일시정지'}</button>}
        {bot.mode !== 'retired' && <button type="button" className="button secondary lifetime-cancel" disabled={blocked} onClick={() => void setMode(bot, 'retired')}>사용 종료</button>}
      </div>
      <DetailDialog title="입력과 결과"><pre>{JSON.stringify({ input: bot.input_contract, output: bot.output_contract }, null, 2)}</pre></DetailDialog>
      <DetailDialog title="판본과 기록"><p>Pi · 정의 {bot.definition_ref.revision}</p><code>{bot.ghost_id} · {bot.definition_ref.digest}</code><p>일시정지와 사용 종료 후에도 기존 작업과 기록은 유지됩니다.</p></DetailDialog>
    </section>)}
    {flow && <form className="form-stack" onSubmit={event => { event.preventDefault(); void submitDefinition(); }}>
      <h4>{flow.bot.display_name} · {flow.action === 'update' ? '역할 수정' : '새 Ghost로 복제'}</h4>
      {flow.action === 'update' ? <label>역할 지시<textarea value={flow.value} maxLength={32768} required rows={4} onChange={event => setFlow({ ...flow, value: event.target.value })}/></label>
        : <><label>새 이름<input value={flow.value} maxLength={256} required onChange={event => setFlow({ ...flow, value: event.target.value })}/></label><p>기억과 대화, 자격 증명은 복사하지 않습니다.</p></>}
      <div className="lifetime-submit-actions"><button type="button" className="button secondary" disabled={disabled} onClick={() => setFlow(null)}>닫기</button><button type="submit" className="button primary" disabled={blocked || !flow.value.trim()}>{flow.action === 'update' ? '수정안 평가' : '새 Ghost 만들기'}</button></div>
    </form>}
  </section>;
}

/** Pure view kept separate so cold-reload and failed-state fixtures exercise real labels. */
export function BotStatusList({ surface }: { surface: BotSurface }) {
  return <div aria-live="polite">
    {surface.operations.filter(operation => operation.state !== 'ready' || !surface.bots.some(bot => bot.ghost_id === operation.ghost_id)).map(operation => <article className="lifetime-outbox-row" key={operation.candidate_id}>
      <div><strong>{operation.display_name}</strong><span>{botOperationLabel(operation)}</span><p>{operation.purpose}</p>{botBlocker(operation.blocker) && <p>{botBlocker(operation.blocker)}</p>}</div>
    </article>)}
    {surface.bots.length === 0 && surface.operations.length === 0 && <p className="lifetime-empty">이 대화에서 만든 Ghost 없음</p>}
  </div>;
}
