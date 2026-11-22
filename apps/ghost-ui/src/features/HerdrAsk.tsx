import { useEffect, useRef, useState } from 'react';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { haptic } from '../host/shell';
import { Button, InlineError } from '../ui';
import type { HerdrAsk as Ask } from '@ghost/contract';
import { HerdrState } from './herdrDisplay';
import { choiceVariant } from './herdrInboxModel';

type Approval = { ask: Ask; signature: string; pending?: number; error?: string };
const signature = (ask: Ask) => JSON.stringify([ask.kind, ask.title, ask.detail, ask.choices]);

/** One owner of each pane's approval, shared by the inbox and the pane detail. */
export function useHerdrAsks(session: string | null, blocked: string[], onAnswered: () => void) {
  const { client } = useHost();
  const ids = blocked.join(',');
  const [snapshot, setSnapshot] = useState<{ session: string | null; entries: Record<string, Approval> }>({ session: null, entries: {} });
  const inFlight = useRef(new Set<string>());
  const liveSession = useRef(session);
  liveSession.current = session;
  const [revision, reload] = useState(0);

  useEffect(() => {
    if (!session || !ids) return;
    const request = new AbortController();
    const panes = ids.split(',');
    let timer: ReturnType<typeof setTimeout>;
    function apply(pane: string, ask: Ask | null) {
      if (request.signal.aborted) return;
      setSnapshot(current => {
        const entries = current.session === session ? current.entries : {};
        const old = entries[pane];
        if (!ask) {
          if (!old || old.pending !== undefined) return current;
          const { [pane]: _, ...rest } = entries;
          return { session, entries: rest };
        }
        const marker = signature(ask);
        if (old?.signature === marker || (old?.pending !== undefined && inFlight.current.has(`${session}/${pane}`))) return current;
        return { session, entries: { ...entries, [pane]: { ask, signature: marker } } };
      });
    }
    async function read() {
      if (!document.hidden) await Promise.all(panes.map(async pane => {
        try { apply(pane, await client.herdrAsk(pane, request.signal)); }
        catch { apply(pane, null); }
      }));
      if (!request.signal.aborted) timer = setTimeout(() => void read(), 1800);
    }
    void read();
    return () => { request.abort(); clearTimeout(timer); };
  }, [client, session, ids, revision]);

  // Retire optimistic state when the roster stops showing this question's pane as blocked.
  useEffect(() => {
    const shown = new Set(ids ? ids.split(',') : []);
    setSnapshot(current => {
      if (current.session !== session) return { session, entries: {} };
      if (Object.keys(current.entries).every(pane => shown.has(pane))) return current;
      return { session, entries: Object.fromEntries(Object.entries(current.entries).filter(([pane]) => shown.has(pane))) };
    });
  }, [session, ids]);

  async function answer(pane: string, index: number) {
    if (snapshot.session !== session) return;
    const entry = snapshot.entries[pane];
    const key = `${session}/${pane}`;
    if (!entry || entry.pending !== undefined || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const update = (next?: Approval) => setSnapshot(current => {
      if (current.session !== session || current.entries[pane]?.signature !== entry.signature) return current;
      if (next) return { session, entries: { ...current.entries, [pane]: next } };
      const { [pane]: _, ...rest } = current.entries;
      return { session, entries: rest };
    });
    update({ ...entry, pending: index, error: undefined });
    try {
      await client.answerHerdr({ pane, index, title: entry.ask.title });
      if (liveSession.current === session) { haptic(); onAnswered(); reload(n => n + 1); }
    } catch (reason) {
      if (reason instanceof HostError && (reason.code === 'conflict' || reason.code === 'not_found')) {
        update();
        if (liveSession.current === session) { onAnswered(); reload(n => n + 1); }
      } else update({ ...entry, error: reason instanceof Error ? reason.message : '답변을 보내지 못했습니다.' });
    } finally { inFlight.current.delete(key); }
  }
  return { entries: snapshot.session === session ? snapshot.entries : {}, answer };
}

export function HerdrAskCard({ entry, answer }: { entry: Approval; answer(index: number): void }) {
  const { ask, pending, error } = entry;
  return <section className="herdr-ask" aria-label={ask.kind === 'approval' ? '승인 요청' : '질문'} aria-busy={pending !== undefined || undefined}>
    <p className="herdr-ask-title">{ask.title}</p>
    {ask.detail && <pre className="herdr-ask-command" tabIndex={0}>{ask.detail}</pre>}
    <div className="herdr-ask-choices">
      {ask.choices.map(choice => <Button key={choice.index} type="button" variant={choiceVariant[choice.tone]} data-choice={choice.tone}
        className={choice.tone === 'deny' ? 'border text-danger shadow-none hover:bg-red-tint hover:text-danger' : undefined}
        disabled={pending !== undefined} onClick={() => answer(choice.index)}>
        {choice.label}{pending === choice.index && <span className="herdr-ask-sending"><HerdrState status="working" label={false}/></span>}
      </Button>)}
    </div>
    {error && <InlineError>{error}</InlineError>}
  </section>;
}

export type HerdrAsks = ReturnType<typeof useHerdrAsks>;