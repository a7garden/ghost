import { CircleAlert } from 'lucide-react';
import { GConversationActivity, GConversationMessage } from '@garden/ui';
import type { Message } from '@ghost/contract';
import { ArtifactPreview } from './ArtifactPreview';
import { CopyButton, MessageBody } from './MessageBody';

function Attachments({ message }: { message: Message }) {
  if (message.attachments.length === 0) return null;
  return <div className="mt-1.5 flex flex-wrap gap-1.5">
    {message.attachments.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}
  </div>;
}

/** One transcript row shared by the direct conversation and the read-only work conversation. */
export function TranscriptMessage({ message, speaker }: { message: Message; speaker(message: Message): string }) {
  if (message.role === 'tool') {
    const title = message.tool?.name ?? '도구 기록';
    return <GConversationMessage role="assistant" label={speaker(message)}>
      <GConversationActivity summary={<span className="flex items-center gap-1.5">
        {message.tool?.isError && <CircleAlert size={13} className="text-red" aria-hidden="true"/>}{title}
      </span>}>
        <pre className="m-0 text-caption whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</pre>
      </GConversationActivity>
    </GConversationMessage>;
  }
  if (message.role === 'user') {
    return <GConversationMessage role="user" label={speaker(message)}>
      <div className="text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
      <Attachments message={message}/>
    </GConversationMessage>;
  }
  if (!message.text && message.attachments.length === 0) return null;
  return <GConversationMessage role="assistant" label={speaker(message)}
    actions={<CopyButton label="메시지 복사" getText={() => message.text}/>}>
    <MessageBody text={message.text}/>
    <Attachments message={message}/>
  </GConversationMessage>;
}
