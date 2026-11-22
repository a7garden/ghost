import { useId, useState } from 'react';
import { ChevronDown, CircleAlert } from 'lucide-react';
import type { Decision, State } from '@ghost/contract';
import { deadlineText, DecisionDeck } from './Decision';
import { decisionHeading } from './decisionText';
import { ownerOrder, useLater } from './decisionQueue';
import { useNow } from './time';
import { useCompact } from '../ui/adaptive';
import './chat-decisions.css';

/** Summarize the first request in the same order as the deck. */
export function chatPendingSummary(decisions: Decision[], later: Record<string, number>, state: State, now: number): {
  count: string;
  lead: string;
  due: string | null;
} {
  const [first] = ownerOrder(decisions, later);
  const rest = decisions.length - 1;
  return {
    count: `확인 필요 ${decisions.length}건`,
    lead: `${decisionHeading(first, state)}${rest > 0 ? ` 외 ${rest}건` : ''}`,
    due: deadlineText(first, now),
  };
}

/** Folding changes disclosure only; resolution always goes through DecisionDeck. */
export function ChatDecisions({ state, navigate, decisions, onOpenWork }: {
  state: State;
  navigate(path: string): void;
  /** The pending decisions of this conversation, oldest first. */
  decisions: Decision[];
  onOpenWork(workId: string): void;
}) {
  const compact = useCompact();
  const [disclosure, setDisclosure] = useState<'unopened' | 'open' | 'closed'>('unopened');
  const open = disclosure === 'open';
  const bodyId = useId();
  const later = useLater();
  const now = useNow();
  const deck = <DecisionDeck state={state} navigate={navigate} decisions={decisions} onOpenWork={onOpenWork} docked/>;
  if (!compact) return deck;
  // Nothing waits and nothing is unfolded: the dock is the composer alone.
  if (!open && decisions.length === 0) return deck;
  const summary = decisions.length > 0 ? chatPendingSummary(decisions, later, state, now) : null;
  return <div className="chat-decisions" data-open={open || undefined}>
    {summary && <button type="button" className="chat-decisions__row" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setDisclosure(open ? 'closed' : 'open')}>
      <CircleAlert size={16} aria-hidden="true"/>
      <span className="chat-decisions__count">{summary.count}</span>
      <span className="chat-decisions__lead">{summary.lead}</span>
      {summary.due && <span className="chat-decisions__due">{summary.due}</span>}
      <ChevronDown size={16} aria-hidden="true" className="chat-decisions__chevron"/>
    </button>}
    <div className="chat-decisions__body" id={bodyId} hidden={!open}>{disclosure !== 'unopened' && deck}</div>
  </div>;
}
