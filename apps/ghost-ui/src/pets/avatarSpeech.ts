type Speaker = { workspaceId: string; profileId: string };

// Playback state is transient and belongs to the output that started it.
export function createAvatarSpeech() {
  const outputs = new Map<symbol, Speaker>();
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(source: symbol, speaker: Speaker | null) {
      const previous = outputs.get(source);
      if (!speaker && !previous) return;
      if (speaker && previous?.workspaceId === speaker.workspaceId && previous.profileId === speaker.profileId) return;
      if (speaker) outputs.set(source, speaker); else outputs.delete(source);
      listeners.forEach(listener => listener());
    },
    isSpeaking(workspaceId?: string, profileId?: string) {
      if (!workspaceId || !profileId) return false;
      return [...outputs.values()].some(speaker => speaker.workspaceId === workspaceId && speaker.profileId === profileId);
    },
  };
}
