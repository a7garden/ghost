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
  return <section className="page-content" aria-label={`${profile.name} 이전 대화`}>
    <header className="page-heading"><h1>{profile.name} · 이전 대화</h1><button type="button" className="button secondary" onClick={() => navigate(`/lifetime?ghost=${encodeURIComponent(profile.id)}`)}>Ghost로 돌아가기</button></header>
    {profile.conversations.length > 0 && <label className="lifetime-field">대화 기록<select value={conversation?.id ?? ''} onChange={event => navigate(legacyHistoryPath(profile.id, event.target.value))}>
      {!conversation && <option value="">이 대화를 찾을 수 없습니다</option>}
      {profile.conversations.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
    </select></label>}
    {!conversation && <p className="empty-state">{requested ? '이 Ghost에서 해당 대화 기록을 찾을 수 없습니다.' : '저장된 이전 대화 없음'}</p>}
    {conversation && <div className="lifetime-transcript" aria-label={conversation.title}>
      {conversation.messages.map((message, index) => <article className="lifetime-turn" key={`${message.role}:${index}`}>
        <header><strong>{message.role === 'user' ? '나' : message.role === 'tool' ? '도구 기록' : profile.name}</strong></header>
        <pre>{message.text}</pre>
        {message.tool?.output && <details><summary>{message.tool.output.summary ?? message.tool.name}</summary><pre>{JSON.stringify(message.tool.output.content ?? message.tool.output, null, 2)}</pre></details>}
      </article>)}
      {conversation.tasks.map(task => <details key={task.id} className="lifetime-artifact"><summary>{task.name} · 기록된 상태: {task.phase}</summary>{task.output && <pre>{task.output}</pre>}{task.partial && <pre>{task.partial}</pre>}<code>{task.id}</code></details>)}
    </div>}
  </section>;
}
