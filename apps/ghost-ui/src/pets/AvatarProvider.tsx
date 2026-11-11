import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Ghost, State } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { createAvatarSpeech } from './avatarSpeech';
import type { AvatarSpeech } from './avatarSpeech';
import { spriteVersionOf } from './sprites';
import type { PetState } from './sprites';

type ContextValue = {
  state: State | null;
  animate: boolean;
  speech: AvatarSpeech;
  /** Object URL of an avatar image, cached per digest. The provider revokes it on unmount. */
  load: (digest: string) => Promise<string>;
};

const Context = createContext<ContextValue>({ state: null, animate: true, speech: createAvatarSpeech(), load: async () => { throw new Error('아바타를 불러올 수 없습니다.'); } });

/** Loads avatar images from host artifacts; mount inside `<HostProvider>`. */
export function AvatarProvider({ animate, children }: { animate: boolean; children: ReactNode }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const promises = useRef(new Map<string, Promise<string>>());
  const urls = useRef(new Map<string, string>());
  const [speech] = useState(createAvatarSpeech);
  const load = useCallback((digest: string) => {
    const cached = promises.current.get(digest);
    if (cached) return cached;
    const request = client.artifactUrl(digest).then(url => {
      urls.current.set(digest, url);
      return url;
    }).catch(error => { promises.current.delete(digest); throw error; });
    promises.current.set(digest, request);
    return request;
  }, [client]);
  const digests = useMemo(() => state?.avatars.map(avatar => avatar.imageDigest).join(' ') ?? '', [state?.avatars]);
  useEffect(() => {
    const known = new Set(digests ? digests.split(' ') : []);
    for (const digest of promises.current.keys()) if (!known.has(digest)) promises.current.delete(digest);
  }, [digests]);
  useEffect(() => () => {
    for (const url of urls.current.values()) URL.revokeObjectURL(url);
    urls.current.clear(); promises.current.clear();
  }, []);
  const value = useMemo(() => ({ state, load, animate, speech }), [state, load, animate, speech]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Voice playback badge for one Ghost's avatar; returns a setter, not a value. */
export function useAvatarSpeaking(ghostId: string) {
  const { speech } = useContext(Context);
  const source = useMemo(() => Symbol('voice output'), [ghostId]);
  useEffect(() => () => speech.set(source, null), [speech, source]);
  return useCallback((speaking: boolean) => {
    speech.set(source, speaking ? ghostId : null);
  }, [speech, source, ghostId]);
}

/** The owner's avatar animation preference. */
export function useAvatarMotion() {
  return useContext(Context).animate;
}

/** Pet sprite row for a Ghost: busy conversation, a pending decision, or idle. Pure; exported for tests. */
export function ghostPetState(ghost: Ghost | undefined, state: State | null | undefined): PetState {
  if (!ghost) return 'idle';
  if (state?.conversations.some(conversation => conversation.ghostId === ghost.id && conversation.busy)) return 'running';
  if (state?.decisions.some(decision => decision.ghostId === ghost.id && decision.state === 'pending')) return 'waiting';
  return 'idle';
}

export function useAvatarSource(digest?: string | null) {
  const { load, animate } = useContext(Context);
  const [result, setResult] = useState<{ key: string; source?: string; error?: string }>({ key: '' });
  const [attempt, setAttempt] = useState(0);
  const key = digest ?? '';
  useEffect(() => {
    let alive = true;
    if (digest) load(digest).then(source => { if (alive) setResult({ key, source }); }).catch(error => { if (alive) setResult({ key, error: String(error.message ?? error) }); });
    else setResult({ key });
    return () => { alive = false; };
  }, [key, digest, load, attempt]);
  return { source: result.key === key ? result.source : undefined, error: result.key === key ? result.error : undefined, animate, retry: () => setAttempt(v => v + 1) };
}

export function useProfileAvatar(ghostId?: string, tone?: string) {
  const { state, speech } = useContext(Context);
  const ghost = state?.ghosts.find(item => item.id === ghostId);
  const avatar = ghost?.look.avatarId ? state?.avatars.find(item => item.id === ghost.look.avatarId) : undefined;
  const source = useAvatarSource(avatar?.imageDigest);
  const speaking = useSyncExternalStore(speech.subscribe, () => speech.isSpeaking(ghostId), () => false);
  const busy = Boolean(ghost && state?.conversations.some(conversation => conversation.ghostId === ghost.id && conversation.busy));
  return { ...source, isDefault: !avatar, isResponding: busy || speaking, version: spriteVersionOf(avatar?.design), state: speaking ? 'running' as const : ghostPetState(ghost, state) };
}
