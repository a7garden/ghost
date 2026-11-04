import { DetailDialog } from '../components/DetailDialog';
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
  return <section className="thread-archive" aria-label={`${profile.name} 이전 대화`}>
    <header className="thread-toolbar thread-archive-toolbar">
      <h1>이전 대화</h1>
      <button type="button" className="text-button" onClick={() => navigate(`/lifetime?ghost=${encodeURIComponent(profile.id)}`)}>대화로 돌아가기<ArrowRight size={14}/></button>
    </header>
    {profile.conversations.length > 0 && <label className="lifetime-field"><span className="sr-only">대화 기록</span><select className="thread-archive-select" value={conversation?.id ?? ''} onChange={event => navigate(legacyHistoryPath(profile.id, event.target.value))}>
      {!conversation && <option value="">이 대화를 찾을 수 없습니다</option>}
      {profile.conversations.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
    </select></label>}
    {!conversation && <p className="empty-state">{requested ? '이 Ghost에서 해당 대화 기록을 찾을 수 없습니다.' : '저장된 이전 대화 없음'}</p>}
    {conversation && <div className="thread-archive-messages" aria-label={conversation.title}>
      {conversation.messages.map((message, index) => <article className="thread-turn" data-kind={message.role} key={`${message.role}:${index}`}
        aria-label={message.role === 'user' ? '나' : message.role === 'tool' ? '도구 기록' : profile.name}>
        {message.role === 'tool' && <strong className="thread-event-label">도구 기록</strong>}
        {message.text && <p className="thread-body">{message.text}</p>}
        {message.tool?.output && <DetailDialog title={message.tool.output.summary ?? message.tool.name} className="thread-tool"><pre>{JSON.stringify(message.tool.output.content ?? message.tool.output, null, 2)}</pre></DetailDialog>}
      </article>)}
      {conversation.tasks.map(task => <DetailDialog key={task.id} title={task.name} label={<>{task.name} · 기록된 상태: {task.phase}</>} className="lifetime-artifact">{task.output && <pre>{task.output}</pre>}{task.partial && <pre>{task.partial}</pre>}<code>{task.id}</code></DetailDialog>)}
    </div>}
  </section>;
}
