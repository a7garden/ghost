import { delegationContext } from '../client/collaboration';
import type { Snapshot } from '../client/types';

export function conversationContext(snapshot: Snapshot, profileId: string, conversationId?: string) {
  const profile = snapshot.profiles.find(item => item.id === profileId);
  const conversation = profile?.conversations.find(item => item.id === conversationId);
  const tasks = conversation?.tasks ?? [];
  return {
    reviews: snapshot.reviews.filter(item => item.profile_id === profileId && item.conversation_id === conversation?.id && ['pending', 'approved'].includes(item.state)),
    currentTasks: tasks.filter(item => !['complete', 'cancelled'].includes(item.phase)),
    pastTasks: tasks.filter(item => ['complete', 'cancelled'].includes(item.phase)),
    goals: snapshot.goals.filter(item => item.profile_id === profileId),
    spaces: snapshot.spaces.filter(item => item.profiles.includes(profileId)),
    schedules: snapshot.schedules.filter(item => item.profile_id === profileId && item.conversation_id === conversation?.id),
    delegations: conversation ? snapshot.delegations.filter(item => {
      if (item.target === profileId) return item.conversation_id === conversation.id;
      return item.owner === profileId && delegationContext(snapshot, item).source?.id === conversation.id;
    }) : [],
  };
}

// Only useful, current context claims space beside the conversation. Settled
// history and empty management controls remain available in the context drawer.
export function contextualCards(snapshot: Snapshot, profileId: string, conversationId?: string) {
  const context = conversationContext(snapshot, profileId, conversationId);
  const activeDelegations = context.delegations.filter(item => !['complete', 'cancelled'].includes(item.state));
  const categories = [
    context.reviews.length > 0 && 'reviews', context.currentTasks.length > 0 && 'tasks',
    activeDelegations.length > 0 && 'collaboration', context.goals.length > 0 && 'goals',
    context.spaces.length > 0 && 'spaces', context.schedules.length > 0 && 'schedules',
    snapshot.connectors.computer === true && 'computer',
  ].filter((item): item is string => Boolean(item));
  return { ...context, activeDelegations, categories, count: categories.length };
}
