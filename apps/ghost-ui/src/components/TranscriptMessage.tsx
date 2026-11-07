import { CircleAlert } from 'lucide-react';
import { GConversationMessage } from '@garden/ui';
import type { Message } from '@ghost/contract';
import { DetailDialog } from './DetailDialog';
import { ArtifactPreview } from './ArtifactPreview';

/** One transcript row shared by the direct conversation and the read-only work conversation. */
export function TranscriptMessage({ message, speaker }: { message: Message; speaker(message: Message): string }) {
  if (message.role === 'tool') {
    const title = message.tool?.name ?? '도구 기록';
    return <GConversationMessage role="assistant" label={speaker(message)}>
      <DetailDialog title={title} label={<span className="flex items-center gap-1.5 text-caption text-ink-2">{message.tool?.isError && <CircleAlert size={13} className="text-red"/>}{title}</span>}>
        <pre className="text-caption [overflow-wrap:anywhere]">{message.text}</pre>
      </DetailDialog>
    </GConversationMessage>;
  }
  return <GConversationMessage role={message.role === 'user' ? 'user' : 'assistant'} label={speaker(message)}>
    <div className="text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
    {message.attachments.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">
      {message.attachments.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}
    </div>}
  </GConversationMessage>;
}
