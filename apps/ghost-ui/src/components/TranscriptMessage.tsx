import { Fragment, type ReactNode } from 'react';
import type { Live } from '@ghost/contract';
import { PresenceAvatar } from './agent';
import { ChevronRight } from 'lucide-react';
import { ConversationMessage } from '../ui'
import { INTERACTIVE_UI_TOOL, readInteractiveUi, type LiveTool, type Message } from '@ghost/contract';
import { ArtifactPreview } from './ArtifactPreview';
import { CopyButton, MessageBody, useSmoothText } from './MessageBody';
import { MessageMenu } from './MessageMenu';
import { InteractivePresentation } from './interactive/InteractivePresentation';
import type { UiSubmit } from './interactive/UiInputBlock';

function Attachments({ message }: { message: Message }) {
  if (message.attachments.length === 0) return null;
  return <div className="mt-2 flex flex-wrap gap-2">
    {message.attachments.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}
  </div>;
}

const interactive = (message: Message) => message.role === 'tool' && message.tool?.name === INTERACTIVE_UI_TOOL && !message.tool.isError
  ? readInteractiveUi(message.text) : null;

/** A `delegate` result names the child Work and its Ghost (host tools/work.ts); it reads as a hand-off event, not a tool chip. */
const delegation = (message: Message) => {
  if (message.role !== 'tool' || message.tool?.name !== 'delegate' || message.tool.isError) return null;
  const match = /^Delegated "([\s\S]+)" \([^)]+\) to ([\s\S]+?)\. Its result arrives here\.$/.exec(message.text.trim());
  return match ? { title: match[1]!, ghost: match[2]! } : null;
};
/** Tool results that render on their own row instead of folding into a trail. */
const standalone = (message: Message) => Boolean(interactive(message) || delegation(message));

/**
 * Consecutive tool results fold into one trail: the tools a Ghost used, in order, as a single
 * line of chips; opening it shows every call's output on a thread. Running tools tick at the end.
 */
export function ToolTrail({ results, running = [] }: { results: Message[]; running?: LiveTool[] }) {
  const failed = results.filter(message => message.tool?.isError).length;
  const names = [...results.map(message => ({ id: message.id, name: message.tool?.name ?? '도구', error: Boolean(message.tool?.isError), live: false })),
    ...running.map(tool => ({ id: tool.callId, name: tool.name, error: false, live: true }))];
  const total = names.length;
  return <details className="trail" data-kind="trail" data-live={running.length > 0 || undefined}>
    <summary className="trail__summary">
      <ChevronRight className="trail__chevron" aria-hidden="true"/>
      <span className="trail__count">{running.length ? `도구 사용 중` : `도구 ${total}개 사용`}{failed > 0 && <span className="trail__failed"> · 실패 {failed}</span>}</span>
      <span className="trail__chips" aria-hidden="true">
        {names.slice(-6).map(item => <span key={item.id} className="trail__chip" data-error={item.error || undefined} data-live={item.live || undefined}>{item.name}</span>)}
        {names.length > 6 && <span className="trail__chip" data-more>+{names.length - 6}</span>}
      </span>
    </summary>
    <ol className="trail__steps">
      {results.map(message => <li key={message.id} data-error={message.tool?.isError || undefined}>
        <span className="trail__step-name">{message.tool?.name ?? '도구 기록'}{message.tool?.isError && <em>실패</em>}</span>
        {message.text && <pre>{message.text}</pre>}
      </li>)}
      {running.map(tool => <li key={tool.callId} data-live>
        <span className="trail__step-name">{tool.name}<em>실행 중</em></span>
        {tool.output && <pre>{tool.output}</pre>}
      </li>)}
    </ol>
  </details>;
}

/**
 * The model's reasoning before a reply. Finished reasoning folds to one line; while the Ghost
 * is still thinking it stays open and shows the newest lines as they stream.
 */
export function Reasoning({ text, live = false }: { text: string; live?: boolean }) {
  // While thinking, the newest step names it: the latest bold heading the model wrote, else its latest line.
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const headings = lines.map(line => /^\*\*(.+)\*\*$/.exec(line)?.[1]).filter((line): line is string => Boolean(line));
  const now = headings.at(-1) ?? lines.at(-1)?.replace(/\*\*/g, '');
  return <details className="reasoning" data-live={live || undefined} open={live || undefined}>
    <summary className="reasoning__summary">
      <ChevronRight className="trail__chevron" aria-hidden="true"/>
      <span className="reasoning__label">{live ? '생각 중' : '생각 과정'}</span>
      {live && now && <span className="reasoning__now">{now}</span>}
    </summary>
    <div className="reasoning__body"><div><MessageBody text={text}/></div></div>
  </details>;
}

/** How a host-originated wake is labelled in the transcript. */
const originLabel: Record<Exclude<NonNullable<Message['origin']>, 'owner'>, string> = {
  work: '맡긴 일', child_result: '위임 결과', decision: '결정 전달', schedule: '반복 작업', verdict: '판정', report: '보고',
};

/** Composer actions a transcript offers from its message menus; absent in read-only transcripts. */
export interface TranscriptActions { onQuote?(text: string): void; onReuse?(text: string): void }

/** One transcript row shared by the direct conversation and the read-only work conversation. */
export function TranscriptMessage({ message, speaker, onUiSubmit, onQuote, onReuse }: { message: Message; speaker(message: Message): string; onUiSubmit?: UiSubmit } & TranscriptActions) {
  if (message.role === 'tool') {
    const ui = interactive(message);
    if (ui) return <ConversationMessage role="assistant" label={speaker(message)}>
      <InteractivePresentation key={`${message.conversationId}:${message.id}`} ui={ui} conversationId={message.conversationId} messageId={message.id} onUiSubmit={onUiSubmit}/>
      <Attachments message={message}/>
    </ConversationMessage>;
    const handoff = delegation(message);
    if (handoff) return <div className="transcript-event" data-kind="note" data-origin="delegate" role="note" aria-label="위임">
      <span className="transcript-event__kind">위임</span>
      <span className="transcript-event__text">{handoff.ghost} · {handoff.title}</span>
    </div>;
    return <ToolTrail results={[message]}/>;
  }
  // Wakes the host sent on the owner's behalf (reports, results, answers, schedules) are events, not the owner speaking.
  if (message.role === 'user' && message.origin && message.origin !== 'owner') {
    return <div className="transcript-event" data-kind="note" data-origin={message.origin} role="note" aria-label={speaker(message)}>
      <span className="transcript-event__kind">{originLabel[message.origin]}</span>
      <span className="transcript-event__text">{message.text}</span>
    </div>;
  }
  if (message.role === 'user') {
    return <MessageMenu text={message.text} onReuse={onReuse}>
      <ConversationMessage role="user" label={speaker(message)}>
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
        <Attachments message={message}/>
      </ConversationMessage>
    </MessageMenu>;
  }
  if (message.role === 'note') {
    return <p className="transcript-note" data-kind="note">{message.text}</p>;
  }
  if (!message.text && !message.thinking && message.attachments.length === 0) return null;
  return <MessageMenu text={message.text} onQuote={onQuote}>
    <ConversationMessage role="assistant" label={speaker(message)}
      actions={message.text ? <CopyButton label="메시지 복사" getText={() => message.text}/> : undefined}>
      {message.thinking && <Reasoning text={message.thinking}/>}
      {message.text && <MessageBody text={message.text}/>}
      <Attachments message={message}/>
    </ConversationMessage>
  </MessageMenu>;
}

/** Something placed in the transcript at a moment of its own, such as a thread that started there. */
export interface TranscriptExtra { key: string; at: number; node: ReactNode }

/** A whole transcript: tool results that follow each other become one trail; extras sit where they happened. */
export function Transcript({ messages, speaker, onUiSubmit, extras = [], onQuote, onReuse }: { messages: Message[]; speaker(message: Message): string; onUiSubmit?(message: Message): UiSubmit | undefined; extras?: TranscriptExtra[] } & TranscriptActions) {
  const rows: ReactNode[] = [];
  const pending = [...extras].sort((a, b) => a.at - b.at);
  const flushBefore = (at: number) => { while (pending.length && pending[0].at <= at) { const extra = pending.shift()!; rows.push(<Fragment key={extra.key}>{extra.node}</Fragment>); } };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    flushBefore(message.createdAt);
    if (message.role === 'tool' && !standalone(message)) {
      const run = [message];
      // A thread that began between two results splits the trail so it sits where it started.
      while (index + 1 < messages.length && messages[index + 1].role === 'tool' && !standalone(messages[index + 1])
        && !(pending.length && pending[0].at <= messages[index + 1].createdAt)) run.push(messages[++index]);
      rows.push(<ToolTrail key={`${message.conversationId}:${message.id}`} results={run}/>);
      continue;
    }
    rows.push(<TranscriptMessage key={`${message.conversationId}:${message.id}`} message={message} speaker={speaker} onUiSubmit={onUiSubmit?.(message)} onQuote={onQuote} onReuse={onReuse}/>);
  }
  flushBefore(Infinity);
  return <>{rows}</>;
}

/** The generation in progress: running tools, then reasoning and the reply as they stream. */
export function LiveReply({ live, ghostId, ghostName }: { live: Live; ghostId: string; ghostName: string }) {
  if (!live.running) return null;
  return <>
    {live.tools.length > 0 && <ToolTrail results={[]} running={live.tools}/>}
    <article className="ghost-conversation-message chat-live" data-role="assistant" aria-label={`${ghostName} · 응답 작성 중`} aria-busy="true">
      <div className="ghost-conversation-message__content">
        {live.thinking && <Reasoning text={live.thinking} live={!live.partial}/>}
        {live.partial
          ? <StreamingText text={live.partial}/>
          : !live.thinking && <div className="chat-thinking" role="status"><PresenceAvatar ghostId={ghostId} state="working" size={22}/><span>응답 중</span></div>}
      </div>
    </article>
  </>;
}

function StreamingText({ text }: { text: string }) {
  const shown = useSmoothText(text);
  return <div className="chat-live__text"><MessageBody text={shown} streaming/></div>;
}
