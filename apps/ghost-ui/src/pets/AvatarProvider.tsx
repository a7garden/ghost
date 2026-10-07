import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Command, Profile, Snapshot } from '../client/types';
import { isRunning } from '../client/types';
import type { PetState } from './sprites';
import { createAvatarSpeech } from './avatarSpeech';

type Query = (command: Command) => Promise<Record<string, any>>;
const Context = createContext<{ snapshot: Snapshot | null; animate: boolean; speech: ReturnType<typeof createAvatarSpeech>; load: (id: string) => Promise<string> }>({ snapshot: null, animate: true, speech: createAvatarSpeech(), load: async () => { throw new Error('아바타를 불러올 수 없습니다.'); } });
export function AvatarProvider({ snapshot, query, animate, children }: { snapshot: Snapshot | null; query: Query; animate: boolean; children: ReactNode }) {
  const images = useRef(new Map<string, Promise<string>>());
  const [speech] = useState(createAvatarSpeech);
  const load = useCallback((id: string) => {
    const cached = images.current.get(id); if (cached) return cached;
    const request = query({ type: 'workspace', action: { type: 'read_avatar', id } }).then(result => {
      if (typeof result.data_url !== 'string' || !/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/.test(result.data_url)) throw new Error('아바타 이미지가 올바르지 않습니다.');
      return result.data_url as string;
    }).catch(error => { images.current.delete(id); throw error; });
    images.current.set(id, request); return request;
  }, [query]);
  useEffect(() => { const ids = new Set(snapshot?.avatars.map(a => a.id)); for (const id of images.current.keys()) if (!ids.has(id)) images.current.delete(id); }, [snapshot?.avatars]);
  return <Context.Provider value={useMemo(() => ({ snapshot, load, animate, speech }), [snapshot, load, animate, speech])}>{children}</Context.Provider>;
}
export function useAvatarSpeaking(profileId: string) {
  const { speech, snapshot } = useContext(Context);
  const workspaceId = snapshot?.workspace_id;
  const source = useMemo(() => Symbol('voice output'), [workspaceId, profileId]);
  useEffect(() => () => speech.set(source, null), [speech, source]);
  return useCallback((speaking: boolean) => {
    speech.set(source, speaking && workspaceId ? { workspaceId, profileId } : null);
  }, [speech, source, workspaceId, profileId]);
}
export function profilePetState(profile?: Profile, snapshot?: Snapshot | null): PetState {
  if (!profile) return 'idle';
  const tasks = profile.conversations.flatMap(c => c.tasks);
  if (profile.error) return 'failed';
  if (tasks.some(t => isRunning(t.phase))) return 'running';
  if (tasks.some(t => t.phase === 'waiting_owner') || snapshot?.reviews.some(r => r.profile_id === profile.id && ['pending', 'approved'].includes(r.state))) return 'waiting';
  const latestMessage = profile.conversations[0]?.messages.at(-1);
  if (latestMessage?.role === 'interrupted' && tasks.some(t => t.id === latestMessage.task_id && t.phase === 'failed')) return 'failed';
  return 'idle';
}
export function profileIsResponding(profile?: Profile) {
  return Boolean(profile && !profile.error && profile.conversations.some(c => c.tasks.some(t => t.phase === 'model_running')));
}
export function useAvatarSource(id?: string | null, fallbackTone?: string) {
  const { load, animate, snapshot } = useContext(Context);
  const [result, setResult] = useState<{ key: string; source?: string; error?: string }>({ key: '' });
  const [attempt, setAttempt] = useState(0);
  const key = `${snapshot?.workspace_id}:${id ?? fallbackTone ?? ''}`;
  useEffect(() => {
    let alive = true;
    if (id) load(id).then(source => { if (alive) setResult({ key, source }); }).catch(error => { if (alive) setResult({ key, error: String(error.message ?? error) }); });
    else setResult({ key });
    return () => { alive = false; };
  }, [key, id, fallbackTone, load, attempt]);
  return { source: result.key === key ? result.source : undefined, error: result.key === key ? result.error : undefined, animate, retry: () => setAttempt(v => v + 1) };
}
export function useProfileAvatar(profileId?: string, tone = 'mint') {
  const { snapshot, speech } = useContext(Context);
  const speaking = useSyncExternalStore(speech.subscribe, () => speech.isSpeaking(snapshot?.workspace_id, profileId), () => false);
  const profile = snapshot?.profiles.find(p => p.id === profileId);
  const avatar = snapshot?.avatars.find(a => a.id === profile?.avatar_id);
  const source = useAvatarSource(profile?.avatar_id, tone);
  return { ...source, isDefault: !profile?.avatar_id, isResponding: profileIsResponding(profile) || speaking, version: avatar?.sprite_version ?? 2, state: speaking ? 'running' as const : profilePetState(profile, snapshot) };
}
