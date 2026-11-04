import { useRef, useState } from 'react';
import { ArrowUp, Check } from 'lucide-react';
import { Modal } from '../components/Modal';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import type { Snapshot, Command } from '../client/types';

export function CollaborateForm({ snapshot, action, busy, mode, onClose, onCreated }: { snapshot: Snapshot; action: (c: Command) => Promise<Record<string, any>>; busy: boolean; mode: string; onClose: () => void; onCreated: (path: string) => void }) {
  const [owner, setOwner] = useState(snapshot.profiles[0]?.id ?? ''), [members, setMembers] = useState<string[]>([]), [error, setError] = useState('');
  const created = useRef<Record<string, string>>({});
  const profile = snapshot.profiles.find(p => p.id === owner);
  const hasAuthority = mode === 'demo' || profile?.policy.delegation === true;
  return <Modal title="협업 요청" onClose={onClose}><form className="form-stack" onSubmit={e => {
    e.preventDefault(); const text = String(new FormData(e.currentTarget).get('prompt')); setError('');
    const participants = snapshot.profiles.filter(p => members.includes(p.id) && p.id !== owner);
    if (!participants.length) { setError('함께할 Ghost를 한 명 이상 선택해 주세요.'); return; }
    void (async () => {
      let cid = created.current[owner];
      if (!cid) { const result = await action({ type: 'create_conversation', profile_id: owner, model: snapshot.default_model, tools: true }); cid = result.conversation_id; created.current[owner] = cid; }
      const prompt = `${text}\n\n함께할 Ghost:\n${participants.map(p => `- ${p.name} (${p.id}): ${p.persona.slice(0, 180)}`).join('\n')}\n\n각자의 역할에 맞게 협업을 요청하고, 받은 결과를 이 대화에서 정리해 줘. 현재 허용된 도구와 권한 안에서 진행해 줘.`;
      if (new TextEncoder().encode(prompt).length > 8192) throw new Error('요청 내용이나 참여 Ghost 수를 줄여 주세요.');
      await action({ type: 'submit', profile_id: owner, conversation_id: cid, prompt, kind: 'prompt' });
      onCreated(`/ghosts/${owner}?conversation=${cid}`);
    })().catch(e => setError(e.message));
  }}>
    
    <label>요청을 받을 Ghost<select value={owner} disabled={busy} onChange={e => { setOwner(e.target.value); setMembers(ids => ids.filter(id => id !== e.target.value)); }}>{snapshot.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <fieldset className="collab-member-field"><legend>참여 Ghost</legend>{snapshot.profiles.filter(p => p.id !== owner).map(p => <label key={p.id} className={`collab-member ${members.includes(p.id) ? 'selected' : ''}`}><input type="checkbox" checked={members.includes(p.id)} disabled={busy} onChange={e => setMembers(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))}/><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={38}/><span><strong>{p.name}</strong><small>{p.persona}</small></span><span className="member-check" aria-hidden="true"><Check size={12}/></span></label>)}</fieldset>
    <label>요청 내용<textarea name="prompt" required rows={3} maxLength={5000} placeholder="새 기능을 조사하고, 구현 방향과 소개 문서를 함께 정리해 줘."/></label>
    <p className="field-help">{hasAuthority ? '선택한 Ghost에게 요청을 보냅니다. 실제 협업이 시작되면 관계와 기록이 표시됩니다.' : '이 Ghost의 협업 권한이 아직 꺼져 있습니다. 호스트에서 위임 권한을 설정한 후 요청할 수 있습니다.'}</p>
    {error && <p className="form-error" role="alert">{error}</p>}<button className="button primary" disabled={busy || !members.length || !hasAuthority}>{busy ? '요청 저장 중…' : '협업 요청 보내기'}<ArrowUp size={16}/></button>
  </form></Modal>;
}
