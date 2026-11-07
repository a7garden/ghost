import { CircleAlert } from 'lucide-react';
import { ConversationActivity, ConversationMessage } from '../ui'
import { INTERACTIVE_UI_TOOL, readInteractiveUi, type Message } from '@ghost/contract';
import { ArtifactPreview } from './ArtifactPreview';
import { CopyButton, MessageBody } from './MessageBody';
import { InteractivePresentation } from './interactive/InteractivePresentation';
import type { UiSubmit } from './interactive/UiInputBlock';

function Attachments({ message }: { message: Message }) {
  if (message.attachments.length === 0) return null;
  return <div className="mt-1.5 flex flex-wrap gap-1.5">
    {message.attachments.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}
  </div>;
}

/** One transcript row shared by the direct conversation and the read-only work conversation. */
export function TranscriptMessage({ message, speaker, onUiSubmit }: { message: Message; speaker(message: Message): string; onUiSubmit?: UiSubmit }) {
  if (message.role === 'tool') {
    const ui = message.tool?.name === INTERACTIVE_UI_TOOL && !message.tool.isError ? readInteractiveUi(message.text) : null;
    if (ui) return <ConversationMessage role="assistant" label={speaker(message)}>
      <InteractivePresentation key={`${message.conversationId}:${message.id}`} ui={ui} conversationId={message.conversationId} messageId={message.id} onUiSubmit={onUiSubmit}/>
      <Attachments message={message}/>
    </ConversationMessage>;
    const title = message.tool?.name ?? '도구 기록';
    return <ConversationMessage role="assistant" label={speaker(message)}>
      <ConversationActivity summary={<span className="flex items-center gap-1.5">
        {message.tool?.isError && <CircleAlert size={13} className="text-red" aria-hidden="true"/>}{title}
      </span>}>
        <pre className="m-0 text-caption whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</pre>
      </ConversationActivity>
    </ConversationMessage>;
  }
  if (message.role === 'user') {
    return <ConversationMessage role="user" label={speaker(message)}>
      <div className="text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
      <Attachments message={message}/>
    </ConversationMessage>;
  }
  if (!message.text && message.attachments.length === 0) return null;
  return <ConversationMessage role="assistant" label={speaker(message)}
    actions={<CopyButton label="메시지 복사" getText={() => message.text}/>}>
    <MessageBody text={message.text}/>
    <Attachments message={message}/>
  </ConversationMessage>;
}
