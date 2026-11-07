// Playback state is transient and belongs to the output that started it.
export interface AvatarSpeech {
  subscribe(listener: () => void): () => void;
  set(source: symbol, profileId: string | null): void;
  isSpeaking(profileId?: string): boolean;
}
export function createAvatarSpeech(): AvatarSpeech {
  const outputs = new Map<symbol, string>();
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(source: symbol, profileId: string | null) {
      const previous = outputs.get(source);
      if (!profileId && !previous) return;
      if (profileId && previous === profileId) return;
      if (profileId) outputs.set(source, profileId); else outputs.delete(source);
      listeners.forEach(listener => listener());
    },
    isSpeaking(profileId?: string) {
      if (!profileId) return false;
      return [...outputs.values()].some(id => id === profileId);
    },
  };
}
