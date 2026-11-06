import { DetailDialog } from '../components/DetailDialog';
import { Button, GPage, GPageHeader } from '@garden/ui';
import { ArrowRight } from 'lucide-react';
import type { Profile } from '../client/types';

export function legacyHistoryRequested(route: string): boolean {
  return new URLSearchParams(route.split('?')[1] ?? '').get('history') === '1';
}
export function legacyHistoryPath(profileID: string, conversationID?: string): string {
  const query = new URLSearchParams({ history: '1' });
  if (conversationID) query.set('conversation', conversationID);
  return `/ghosts/${encodeURIComponent(profileID)}?${query}`;
}

/** Historical workspace conversations remain readable after Pi admission replaces
 * the old execution path. This surface exposes no legacy mutation commands. */
export function LegacyTranscript({ profile, route, navigate }: { profile: Profile; route: string; navigate: (path: string) => void }) {
  const requested = new URLSearchParams(route.split('?')[1] ?? '').get('conversation');
  const conversation = requested ? profile.conversations.find(value => value.id === requested) : profile.conversations[0];
  return <GPage width="reading" className="min-w-0 flex-1 px-2 pb-8">
    <GPageHeader title="이전 대화" actions={<Button type="button" variant="ghost" size="sm" className="-mr-2 text-ink-2 hover:text-ink" onClick={() => navigate(`/lifetime?ghost=${encodeURIComponent(profile.id)}`)}>대화로 돌아가기<ArrowRight size={14}/></Button>}/>
    {profile.conversations.length > 0 && <div className="mt-4 grid max-w-full gap-1">
      <label className="sr-only" htmlFor="legacy-conversation-select">대화 기록</label>
      <select id="legacy-conversation-select" data-slot="native-select" className="max-w-full" value={conversation?.id ?? ''} onChange={event => navigate(legacyHistoryPath(profile.id, event.target.value))}>
        {!conversation && <option value="">이 대화를 찾을 수 없습니다</option>}
        {profile.conversations.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
      </select>
    </div>}
    {!conversation && <p className="py-8 text-center text-ui text-ink-2">{requested ? '이 Ghost에서 해당 대화 기록을 찾을 수 없습니다.' : '저장된 이전 대화 없음'}</p>}
    {conversation && <div className="mt-6 grid content-start gap-8" aria-label={conversation.title}>
      {conversation.messages.map((message, index) => <article data-kind={message.role} key={`${message.role}:${index}`}
        aria-label={message.role === 'user' ? '나' : message.role === 'tool' ? '도구 기록' : profile.name}
        className="grid min-w-0 justify-items-stretch gap-1">
        {message.role === 'tool' && <strong className="text-caption text-ink-3">도구 기록</strong>}
        {message.text && <p className="text-body leading-relaxed [overflow-wrap:anywhere]">{message.text}</p>}
        {message.tool?.output && <DetailDialog title={message.tool.output.summary ?? message.tool.name} className="justify-self-start"><pre className="text-caption [overflow-wrap:anywhere]">{JSON.stringify(message.tool.output.content ?? message.tool.output, null, 2)}</pre></DetailDialog>}
      </article>)}
      {conversation.tasks.map(task => <DetailDialog key={task.id} title={task.name} label={<>{task.name} · 기록된 상태: {task.phase}</>} className="justify-self-start"><div className="grid gap-2">{task.output && <pre className="text-caption [overflow-wrap:anywhere]">{task.output}</pre>}{task.partial && <pre className="text-caption [overflow-wrap:anywhere]">{task.partial}</pre>}<code className="text-caption text-ink-2">{task.id}</code></div></DetailDialog>)}
    </div>}
  </GPage>;
}
