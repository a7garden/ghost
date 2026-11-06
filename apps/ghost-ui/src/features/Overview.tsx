import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge, GComposer, GPage, InlineError } from '@garden/ui';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import type { Snapshot, Profile } from '../client/types';
import { inboxItems } from '../client/inbox';
import { approvalTitle, type ApprovalRef } from '../plugins/approvals';
import { ghostDisplayName } from './profileSummary';

export interface OverviewProps {
  snapshot: Snapshot; connected?: boolean; navigate: (path: string) => void;
  onOpenApproval: (ref: ApprovalRef) => void;
  /** Sends the first message to `chatTarget`; rejects with a displayable error. */
  onStartChat: (text: string) => Promise<void>; chatTarget?: Profile;
}

/** New request: one composer to the default Ghost, and only the decisions that wait for the owner. */
export function Overview({ snapshot, connected = true, navigate, onOpenApproval, onStartChat, chatTarget }: OverviewProps) {
  const decisions = inboxItems(snapshot, connected).groups.pending;
  const names = new Map(snapshot.profiles.map(profile => [profile.id, ghostDisplayName(profile.name)]));
  const [text, setText] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState('');
  const target = connected ? chatTarget : undefined;
  const send = async (value: string) => {
    if (!target || sending) return;
    setSending(true); setError('');
    try { await onStartChat(value); setText(''); }
    catch (e) { setError(e instanceof Error ? e.message : '메시지를 보내지 못했습니다.'); }
    finally { setSending(false); }
  };
  return <GPage width="reading" className="grid content-start gap-8 pt-[12vh]">
    <div className="grid gap-2">
      <GComposer variant="conversation" inputId="dashboard-message" rows={3} value={text} onValueChange={setText} onSubmit={value => void send(value)}
        label={target ? `${ghostDisplayName(target.name)}에게 메시지` : '메시지'} placeholder="무엇을 맡길까요?" submitLabel="보내기"
        disabled={!target} pending={sending}
        footer={target && <span className="inline-flex items-center gap-1.5 text-caption text-ink-2"><DotAvatar profileId={target.id} tone={toneFor(target.id)} size={18}/>{ghostDisplayName(target.name)}</span>}/>
      {error && <InlineError>{error}</InlineError>}
    </div>
    {decisions.length > 0 && <section className="grid gap-2" aria-labelledby="home-decisions">
      <h2 id="home-decisions" className="flex items-center gap-2 text-ui font-semibold text-ink">확인 필요 <Badge variant="warning">{decisions.length}</Badge></h2>
      <ul className="grid">{decisions.slice(0, 3).map(item => <li key={`${item.kind}:${item.id}`}>
        <button type="button" disabled={!connected} onClick={() => onOpenApproval({ kind: item.kind, id: item.id })}
          className="flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2.5 text-left hover:bg-hover disabled:opacity-50">
          <span className="grid min-w-0 flex-1 gap-0.5"><span className="truncate text-ui font-medium text-ink">{approvalTitle(item)}</span><span className="truncate text-caption text-ink-2">{names.get(item.ghostId) ?? 'Ghost'}</span></span>
          <ChevronRight className="size-4 text-ink-3"/>
        </button>
      </li>)}</ul>
      {decisions.length > 3 && <button type="button" className="justify-self-start text-caption text-ink-2 hover:text-ink" onClick={() => navigate('/inbox')}>{decisions.length - 3}개 더 보기</button>}
    </section>}
  </GPage>;
}
