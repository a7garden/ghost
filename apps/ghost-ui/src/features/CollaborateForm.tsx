import { useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Checkbox, FormField, SelectField, Textarea, Button, InlineError } from '@garden/ui';
import { Modal } from '../components/Modal';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import type { Snapshot, Command } from '../client/types';

export function CollaborateForm({ snapshot, action, busy, mode, onClose, onCreated }: { snapshot: Snapshot; action: (c: Command) => Promise<Record<string, any>>; busy: boolean; mode: string; onClose: () => void; onCreated: (path: string) => void }) {
  const [owner, setOwner] = useState(snapshot.profiles[0]?.id ?? ''), [members, setMembers] = useState<string[]>([]), [error, setError] = useState('');
  const created = useRef<Record<string, string>>({});
  const profile = snapshot.profiles.find(p => p.id === owner);
  const hasAuthority = mode === 'demo' || profile?.policy.delegation === true;
  return <Modal title="협업 요청" onClose={onClose}><form className="grid gap-4" onSubmit={e => {
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
    <FormField label="요청을 받을 Ghost">
      {field => <SelectField {...field} label="요청을 받을 Ghost" value={owner} disabled={busy} onValueChange={value => { setOwner(value); setMembers(ids => ids.filter(id => id !== value)); }}
        options={snapshot.profiles.map(p => ({ value: p.id, label: p.name }))}/>}
    </FormField>
    <fieldset className="m-0 grid gap-2 border-0 p-0" disabled={busy}>
      <legend className="mb-1 text-caption font-medium">참여 Ghost</legend>
      {snapshot.profiles.filter(p => p.id !== owner).map(p => {
        const selected = members.includes(p.id);
        return <label key={p.id} data-selected={selected}
          className="flex cursor-pointer items-center gap-2 rounded-control border border-line bg-surface p-2 text-left hover:bg-hover data-[selected=true]:border-line-strong data-[selected=true]:bg-inset">
          <Checkbox checked={selected} disabled={busy} onCheckedChange={checked => setMembers(ids => checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} aria-label={`참여 Ghost ${p.name}`}/>
          <DotAvatar profileId={p.id} tone={toneFor(p.id)} size={38}/>
          <span className="grid min-w-0 flex-1 gap-0.5"><span className="text-ui font-medium text-ink">{p.name}</span><small className="truncate text-caption text-ink-2">{p.persona}</small></span>
        </label>;
      })}
    </fieldset>
    <label className="grid gap-2 text-caption">요청 내용<Textarea name="prompt" required rows={3} maxLength={5000} placeholder="새 기능을 조사하고, 구현 방향과 소개 문서를 함께 정리해 줘."/></label>
    <p className="m-0 text-caption text-ink-2">{hasAuthority ? '선택한 Ghost에게 요청을 보냅니다. 실제 협업이 시작되면 관계와 기록이 표시됩니다.' : '이 Ghost의 협업 권한이 아직 꺼져 있습니다. 호스트에서 위임 권한을 설정한 후 요청할 수 있습니다.'}</p>
    {error && <InlineError>{error}</InlineError>}
    <div><Button type="submit" disabled={busy || !members.length || !hasAuthority}>{busy ? '요청 저장 중…' : '협업 요청 보내기'}<ArrowUp className="size-4"/></Button></div>
  </form></Modal>;
}
