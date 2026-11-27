import { Fragment, type ReactNode } from 'react';
import type { Live } from '@ghost/contract';
import { OutcomeLine, PresenceAvatar } from './agent';
import { ConversationMessage } from '../ui'
import { INTERACTIVE_UI_TOOL, QUIET_REPLY, readInteractiveUi, type GhostTool, type LiveTool, type Message } from '@ghost/contract';
import { ArtifactPreview } from './ArtifactPreview';
import { CopyButton, InlineText, MessageBody, useSmoothText } from './MessageBody';
import { MessageMenu } from './MessageMenu';
import { describeWake, parseOutcome } from './wake';
import { InteractivePresentation } from './interactive/InteractivePresentation';
import type { UiSubmit } from './interactive/UiInputBlock';
import { ProjectChips } from './composer/ProjectMentions';
import { toolLabels } from '../features/toolLabels';

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

/** Trail summaries name at most this many kinds of work; the rest count as 「외 N개」. */
const SUMMARY_KINDS = 3;

/**
 * What a trail did, in the tool names the owner grants in 설정 → Ghost: 「파일 읽기 3번 · 명령 실행」.
 * A trail still running names what it is doing now: 「명령 실행 중」.
 */
export function trailSummary(names: readonly string[], live: boolean): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const label = toolLabels[name as GhostTool] ?? name;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const kinds = [...counts].map(([label, count]) => live || count === 1 ? label : `${label} ${count}번`);
  const rest = kinds.length - SUMMARY_KINDS;
  return `${kinds.slice(0, SUMMARY_KINDS).join(' · ')}${rest > 0 ? ` 외 ${rest}개` : ''}${live ? ' 중' : ''}`;
}

/**
 * Consecutive calls read as one sentence. The opened rows keep tool names, states and exact output.
 */
export function ToolTrail({ results, running = [] }: { results: Message[]; running?: LiveTool[] }) {
  const failed = results.filter(message => message.tool?.isError).length;
  const done = results.length ? trailSummary(results.map(message => message.tool?.name ?? '도구'), false) : '';
  const current = running.length ? trailSummary(running.map(tool => tool.name), true) : '';
  return <details className="trail" data-kind="trail" data-live={running.length > 0 || undefined}>
    <summary className="trail__summary">
      <span className="trail__count">{done}{done && current && ' · '}{current && <span className="trail__current">{current}</span>}</span>
      {failed > 0 && <span className="trail__failed">실패 {failed}</span>}
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
      <span className="reasoning__label">{live ? '생각 중' : '생각 과정'}</span>
      {live && now && <span className="reasoning__now">{now}</span>}
    </summary>
    <div className="reasoning__body"><div><MessageBody text={text}/></div></div>
  </details>;
}

type HostWake = Message & { origin: Exclude<Message['origin'], 'owner' | null> };

function hostWake(message: Message): message is HostWake {
  return message.role === 'user' && message.origin !== null && message.origin !== 'owner';
}

function wakeOutcome(message: Message) {
  return message.origin === 'report' || message.origin === 'child_result' ? parseOutcome(message.text) : null;
}

/** Ignore typography, not changed words or numbers. The full wake must match, not just its heading. */
function wakeText(text: string): string {
  return text.normalize('NFC').trim().replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ').replace(/[.。!！]+$/, '');
}

function wakeRepeatsReply(messages: readonly Message[], index: number): boolean {
  const text = wakeText(messages[index].text);
  if (!text) return false;
  for (let next = index + 1; next < messages.length; next++) {
    const message = messages[next];
    if (message.role === 'user' || message.role === 'note') return false;
    if (message.role === 'assistant' && message.text.trim() && !silent(message)) return text === wakeText(message.text);
  }
  return false;
}

function EventLine({ kind, line, detail, origin, label }: {
  kind?: string; line: string; detail?: string | null; origin?: string; label: string;
}) {
  const head = <>
    {kind && <span className="transcript-event__kind">{kind}</span>}
    <span className="transcript-event__text"><InlineText text={line}/></span>
  </>;
  if (!detail) return <div className="transcript-event" data-kind="note" data-origin={origin} role="note" aria-label={label}>{head}</div>;
  return <details className="transcript-event" data-kind="note" data-origin={origin} aria-label={label}>
    <summary>{head}</summary>
    <div className="transcript-event__detail">{detail}</div>
  </details>;
}

/** A host wake is not an owner bubble. Settled Work has its own outcome row. */
function WakeEvent({ message, label }: { message: HostWake; label: string }) {
  const outcome = wakeOutcome(message);
  if (outcome) return <OutcomeLine outcome={outcome}/>;
  const view = describeWake(message.origin, message.text);
  return <EventLine kind={view.label} line={view.line} detail={view.detail ?? (view.line === message.text.trim() ? message.text : null)}
    origin={message.origin} label={label}/>;
}

/** Composer actions a transcript offers from its message menus; absent in read-only transcripts. */
export interface TranscriptActions { onQuote?(text: string): void; onReuse?(text: string): void }

/** Rows that render nothing: an empty reply, or a Ghost that looked around and found nothing worth saying. */
const silent = (message: Message) => message.role === 'assistant' && message.attachments.length === 0
  && ((!message.text && !message.thinking) || message.text.trim() === QUIET_REPLY);

/** A row the Ghost produced (true), one the owner or host wrote (false), or nothing on screen (null). */
function ghostRow(message: Message): boolean | null {
  if (silent(message)) return null;
  return message.role === 'assistant' || message.role === 'tool';
}

/** Whether the transcript's last visible row is the Ghost's, so a reply streaming after it continues the same run. */
export function endsInGhostRun(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = ghostRow(messages[index]);
    if (row !== null) return row;
  }
  return false;
}

/** The Ghost's name over a run of its rows; each article already carries it as its accessible name. */
export function GhostRunLabel({ name }: { name: string }) {
  return <p className="ghost-conversation__speaker" data-kind="speaker" aria-hidden="true">{name}</p>;
}

/**
 * One transcript row shared by the direct conversation and the read-only work conversation.
 * `delivered`: an owner turn that takes the place of its outgoing row, already on screen — it does not rise in again.
 */
export function TranscriptMessage({ message, speaker, onUiSubmit, onQuote, onReuse, delivered = false }: { message: Message; speaker(message: Message): string; onUiSubmit?: UiSubmit; delivered?: boolean } & TranscriptActions) {
  if (message.role === 'tool') {
    const ui = interactive(message);
    if (ui) return <ConversationMessage role="assistant" label={speaker(message)}>
      <InteractivePresentation key={`${message.conversationId}:${message.id}`} ui={ui} conversationId={message.conversationId} messageId={message.id} onUiSubmit={onUiSubmit}/>
      <Attachments message={message}/>
    </ConversationMessage>;
    const handoff = delegation(message);
    if (handoff) return <EventLine kind="위임" line={`${handoff.ghost} · ${handoff.title}`} origin="delegate" label="위임"/>;
    return <ToolTrail results={[message]}/>;
  }
  // Wakes the host sent on the owner's behalf (reports, results, answers, schedules) are events, not the owner speaking.
  if (hostWake(message)) return <WakeEvent message={message} label={speaker(message)}/>;
  if (message.role === 'user') {
    return <MessageMenu text={message.text} onReuse={onReuse}>
      <ConversationMessage role="user" label={speaker(message)} data-rail="owner" data-rail-label={message.text.replace(/\s+/g, ' ').trim().slice(0, 80)} data-delivered={delivered || undefined}>
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
        <ProjectChips scopes={message.scopes ?? []}/>
        <Attachments message={message}/>
      </ConversationMessage>
    </MessageMenu>;
  }
  if (message.role === 'note') {
    const line = message.text.trim().split('\n', 1)[0];
    return <EventLine line={line} detail={message.text} label={speaker(message)}/>;
  }
  if (silent(message)) return null;
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
export interface TranscriptExtra {
  key: string; at: number; node: ReactNode;
  /** A settled thread's Work id. When its outcome returns on the very next row, the outcome alone draws the branch; the card would only repeat its title. */
  returnsAs?: string;
}

/**
 * Each turn reads as speech followed by one group of actions. Within the group, tools, thread starts
 * and outcomes follow their recorded order. A new owner turn or host wake ends the preceding group.
 * With `runLabel`, the Ghost's name also heads each run of its rows in a work conversation.
 */
export function Transcript({ messages, speaker, onUiSubmit, extras = [], onQuote, onReuse, runLabel, delivered, continuation }: {
  messages: Message[]; speaker(message: Message): string; onUiSubmit?(message: Message): UiSubmit | undefined; extras?: TranscriptExtra[]; runLabel?: string;
  /** Owner turns that replaced an outgoing row (useOutbox). */
  delivered?: ReadonlySet<string>;
  continuation?: { live: Live | null; ghostId: string; ghostName: string; outgoing?: ReactNode[] };
} & TranscriptActions) {
  const rows: ReactNode[] = [];
  const pending = [...extras].sort((a, b) => a.at - b.at);
  let nextExtra = 0;
  let activity: ReactNode[] = [];
  let tools: Message[] = [];
  let turn = 'start';
  let folding: string | undefined;
  let inRun = false;
  const flushTools = (running?: LiveTool[]) => {
    const first = tools[0];
    if (!first && !running?.length) return;
    activity.push(<ToolTrail key={first ? `${first.conversationId}:${first.id}` : 'live-tools'} results={tools} running={running}/>);
    tools = [];
  };
  const flushActivity = () => {
    flushTools();
    if (activity.length === 0) return;
    rows.push(<div key={`activity:${turn}`} className="transcript-activity" data-kind="activity">{activity}</div>);
    activity = [];
  };
  const flushBefore = (at: number) => {
    while (nextExtra < pending.length && pending[nextExtra].at <= at) {
      const extra = pending[nextExtra++];
      flushTools();
      activity.push(<Fragment key={extra.key}>{extra.node}</Fragment>);
      folding = extra.returnsAs;
    }
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    flushBefore(message.createdAt);
    if (silent(message)) continue;
    const key = `${message.conversationId}:${message.id}`;
    const outcome = wakeOutcome(message);
    if (outcome) {
      flushTools();
      if (outcome.workId === folding) activity.pop();
      activity.push(<OutcomeLine key={key} outcome={outcome}/>);
      folding = undefined;
      continue;
    }
    folding = undefined;
    if (message.role === 'user' || message.role === 'note') {
      flushActivity();
      turn = key;
      inRun = false;
      if ((message.role === 'note' || hostWake(message)) && wakeRepeatsReply(messages, index)) continue;
    } else {
      if (!inRun && runLabel) rows.push(<GhostRunLabel key={`${key}:speaker`} name={runLabel}/>);
      inRun = true;
      if (message.role === 'tool' && !standalone(message)) { tools.push(message); continue; }
    }
    const node = <TranscriptMessage key={key} message={message} speaker={speaker}
      onUiSubmit={onUiSubmit?.(message)} onQuote={onQuote} onReuse={onReuse} delivered={delivered?.has(message.id)}/>;
    if (message.role === 'tool' && message.tool?.name === 'delegate') {
      flushTools();
      activity.push(node);
    } else rows.push(node);
  }
  flushBefore(Infinity);
  if (continuation?.outgoing?.length) {
    flushActivity();
    rows.push(...continuation.outgoing);
    turn = 'outgoing';
    inRun = false;
  }
  if (continuation?.live?.running) {
    const { live, ghostId, ghostName } = continuation;
    if (!inRun && runLabel) rows.push(<GhostRunLabel key="live-speaker" name={runLabel}/>);
    rows.push(<StreamingReply key="live-reply" live={live} ghostId={ghostId} ghostName={ghostName}/>);
    flushTools(live.tools);
  }
  flushActivity();
  return <>{rows}</>;
}

/** The generation in progress, used by the Work detail's read-only conversation. */
export function LiveReply(props: { live: Live; ghostId: string; ghostName: string }) {
  if (!props.live.running) return null;
  return <>
    <StreamingReply {...props}/>
    {props.live.tools.length > 0 && <div className="transcript-activity" data-kind="activity"><ToolTrail results={[]} running={props.live.tools}/></div>}
  </>;
}

function StreamingReply({ live, ghostId, ghostName }: { live: Live; ghostId: string; ghostName: string }) {
  return <article className="ghost-conversation-message chat-live" data-role="assistant" aria-label={`${ghostName} · 응답 작성 중`} aria-busy="true">
    <div className="ghost-conversation-message__content">
      {live.thinking && <Reasoning text={live.thinking} live={!live.partial}/>}
      {live.partial
        ? <StreamingText text={live.partial}/>
        : !live.thinking && <div className="chat-thinking" role="status"><PresenceAvatar ghostId={ghostId} state="working" size={22}/><span>응답 중</span></div>}
    </div>
  </article>;
}

function StreamingText({ text }: { text: string }) {
  const shown = useSmoothText(text);
  return <div className="chat-live__text"><MessageBody text={shown} streaming/></div>;
}
