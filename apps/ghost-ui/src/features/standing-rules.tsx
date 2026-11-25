import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { matchesToolPatterns, type Ghost, type State } from '@ghost/contract';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { Button, InlineError } from '../ui';
import './standing-rules.css';

/** Native controls keep their own keys; Enter in a blank advances, and ⌘/Ctrl+Enter submits. */
export function ruleKeys(event: KeyboardEvent<HTMLFormElement>, close: () => void) {
  if (event.nativeEvent.isComposing || event.defaultPrevented) return;
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (event.key !== 'Enter' || event.shiftKey) return;
  const form = event.currentTarget;
  if (event.metaKey || event.ctrlKey) { event.preventDefault(); form.requestSubmit(); return; }
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) || !target.hasAttribute('data-rule-blank')) return;
  event.preventDefault();
  const blanks = Array.from(form.querySelectorAll<HTMLElement>('[data-rule-blank]:not(:disabled)'));
  const next = blanks[blanks.indexOf(target) + 1];
  if (next) next.focus(); else form.requestSubmit();
}

export function restoreRuleFocus(id: string, fallback?: string) {
  requestAnimationFrame(() => (document.getElementById(id) ?? (fallback ? document.getElementById(fallback) : null))?.focus());
}

export function ruleError(reason: unknown, fallback: string): string {
  if (reason instanceof HostError) {
    switch (reason.code) {
      case 'conflict': return '다른 곳에서 변경되었습니다. 현재 상태를 확인해 주세요.';
      case 'not_found': return '대상을 찾을 수 없습니다.';
      case 'forbidden': return '이 변경을 할 권한이 없습니다.';
      case 'invalid': return '입력한 내용을 확인해 주세요.';
      case 'network': return '호스트에 연결하지 못했습니다. 연결 후 다시 시도해 주세요.';
      case 'unavailable': return '지금은 호스트가 요청을 처리할 수 없습니다.';
    }
  }
  return fallback;
}

export function mainForRule(state: State | null | undefined, tool: 'activity_propose' | 'schedule_create'): Ghost | undefined {
  return state?.ghosts.find(ghost => ghost.isDefault && ghost.state === 'active' && ghost.deletedAt === null && matchesToolPatterns(ghost.tools, tool));
}

/** Free words go to the main Ghost; the live Host list, not the send response, shows what it created. */
export function TellRule({ main, scopeId, label, placeholder, consequence, requestText, onClose }: {
  main: Ghost | undefined;
  scopeId?: string;
  label: string;
  placeholder: string;
  consequence: ReactNode;
  requestText(words: string): string;
  onClose(): void;
}) {
  const { client } = useHost();
  const [words, setWords] = useState('');
  const [phase, setPhase] = useState<'writing' | 'sending' | Ghost>('writing');
  const [error, setError] = useState('');
  const request = useRef<{ text: string; conversationId: string; id: string } | null>(null);
  const send = async () => {
    if (!main || phase !== 'writing' || !words.trim()) return;
    const text = requestText(words.trim());
    const conversationId = main.directConversationId;
    if (request.current?.text !== text || request.current.conversationId !== conversationId) request.current = { text, conversationId, id: crypto.randomUUID() };
    setPhase('sending'); setError('');
    try {
      await client.send({ type: 'message.send', conversationId, text, scopeId: scopeId ?? null }, request.current.id);
      setPhase(main);
    } catch (reason) {
      setError(ruleError(reason, '메시지를 보내지 못했습니다. 다시 시도해 주세요.'));
      setPhase('writing');
    }
  };
  if (typeof phase === 'object') return <section className="rule-tell" aria-label={label} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <p className="rule-tell__note" role="status">{phase.name}의 대화에 보냈습니다. <a href={`#/ghosts/${encodeURIComponent(phase.id)}`}>대화 열기</a></p>
    <Button type="button" variant="ghost" size="sm" autoFocus onClick={onClose}>닫기</Button>
  </section>;
  return <form className="rule-tell" aria-label={label} aria-busy={phase === 'sending'} onSubmit={event => { event.preventDefault(); void send(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && phase === 'writing') onClose();
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
    }}>
    <textarea className="rule-blank rule-tell__words" aria-label={label} autoFocus rows={3} value={words} readOnly={phase === 'sending'}
      placeholder={placeholder} onChange={event => setWords(event.target.value)}/>
    <p className="rule-tell__note">{consequence}</p>
    {!main && <InlineError>지금은 메인 Ghost에게 보낼 수 없습니다.</InlineError>}
    {error && <InlineError>{error}</InlineError>}
    <div className="rule-actions rule-actions--end">
      <Button type="button" variant="ghost" size="sm" disabled={phase === 'sending'} onClick={onClose}>취소</Button>
      <Button type="submit" size="sm" disabled={!main || phase === 'sending' || !words.trim()}>{phase === 'sending' ? '보내는 중…' : '보내기'}</Button>
    </div>
  </form>;
}
