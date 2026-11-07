import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { ConversationMessage } from '../ui'
import { INTERACTIVE_UI_TOOL, readInteractiveUi, type LiveTool, type Message } from '@ghost/contract';
import { ArtifactPreview } from './ArtifactPreview';
import { CopyButton, MessageBody } from './MessageBody';
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

/** One transcript row shared by the direct conversation and the read-only work conversation. */
export function TranscriptMessage({ message, speaker, onUiSubmit }: { message: Message; speaker(message: Message): string; onUiSubmit?: UiSubmit }) {
  if (message.role === 'tool') {
    const ui = interactive(message);
    if (ui) return <ConversationMessage role="assistant" label={speaker(message)}>
      <InteractivePresentation key={`${message.conversationId}:${message.id}`} ui={ui} conversationId={message.conversationId} messageId={message.id} onUiSubmit={onUiSubmit}/>
      <Attachments message={message}/>
    </ConversationMessage>;
    return <ToolTrail results={[message]}/>;
  }
  if (message.role === 'user') {
    return <ConversationMessage role="user" label={speaker(message)}>
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
      <Attachments message={message}/>
    </ConversationMessage>;
  }
  if (message.role === 'note') {
    return <p className="transcript-note" data-kind="note">{message.text}</p>;
  }
  if (!message.text && message.attachments.length === 0) return null;
  return <ConversationMessage role="assistant" label={speaker(message)}
    actions={<CopyButton label="메시지 복사" getText={() => message.text}/>}>
    <MessageBody text={message.text}/>
    <Attachments message={message}/>
  </ConversationMessage>;
}

/** A whole transcript: tool results that follow each other become one trail. */
export function Transcript({ messages, speaker, onUiSubmit }: { messages: Message[]; speaker(message: Message): string; onUiSubmit?(message: Message): UiSubmit | undefined }) {
  const rows: ReactNode[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'tool' && !interactive(message)) {
      const run = [message];
      while (index + 1 < messages.length && messages[index + 1].role === 'tool' && !interactive(messages[index + 1])) run.push(messages[++index]);
      rows.push(<ToolTrail key={`${message.conversationId}:${message.id}`} results={run}/>);
      continue;
    }
    rows.push(<TranscriptMessage key={`${message.conversationId}:${message.id}`} message={message} speaker={speaker} onUiSubmit={onUiSubmit?.(message)}/>);
  }
  return <>{rows}</>;
}
