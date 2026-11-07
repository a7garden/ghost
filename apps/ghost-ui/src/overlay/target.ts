/** Pure overlay target selection — no DOM, so the rules stay unit-testable. */
import type { Ghost, State } from '@ghost/contract';

export type Target = { ghostId?: string; conversationId?: string };

/** The default Ghost is the entry point; an explicit target id wins, else the first Ghost. */
export function pickGhost(state: State, wanted?: string): Ghost | null {
  return (
    state.ghosts.find(ghost => ghost.id === wanted) ??
    state.ghosts.find(ghost => ghost.isDefault) ??
    state.ghosts[0] ??
    null
  );
}

/** The stored direct conversation when it still belongs to this Ghost, else the Ghost's own conversation. */
export function pickConversation(state: State, ghost: Ghost, wanted?: string): string {
  if (wanted && state.conversations.some(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct' && conversation.id === wanted)) return wanted;
  return ghost.directConversationId;
}
