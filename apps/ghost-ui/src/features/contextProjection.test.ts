import { expect, it } from 'vitest';
import { initialWorkspace } from '../fixtures/workspace';
import { conversationContext } from './contextProjection';

it('keeps reviews and schedules scoped to both the Ghost and its conversation', () => {
  const snapshot = initialWorkspace(), profile = snapshot.profiles[0], conversation = profile.conversations[0];
  const review = { id: 'here', profile_id: profile.id, conversation_id: conversation.id, state: 'pending', title: '', body: '', space_id: '' };
  const schedule = { id: 'here', profile_id: profile.id, conversation_id: conversation.id, prompt: '', interval_seconds: 3600, next_run_ms: 0, paused: false };
  snapshot.reviews = [review, { ...review, id: 'other-ghost', profile_id: 'someone-else' }, { ...review, id: 'other-chat', conversation_id: 'another' }, { ...review, id: 'done', state: 'saved' }];
  snapshot.schedules = [schedule, { ...schedule, id: 'other-ghost', profile_id: 'someone-else' }, { ...schedule, id: 'other-chat', conversation_id: 'another' }];
  const result = conversationContext(snapshot, profile.id, conversation.id);
  expect(result.reviews.map(item => item.id)).toEqual(['here']);
  expect(result.schedules.map(item => item.id)).toEqual(['here']);
});

it('leaves failed, uncertain and waiting tasks visible while folding settled history', () => {
  const snapshot = initialWorkspace(), profile = snapshot.profiles[0], conversation = profile.conversations[0];
  conversation.tasks = ['complete', 'failed', 'cancelled', 'uncertain', 'waiting_owner', 'model_running'].map(phase => ({ id: phase, phase, name: phase, output: '', partial: '' }));
  const result = conversationContext(snapshot, profile.id, conversation.id);
  expect(result.currentTasks.map(item => item.phase)).toEqual(['failed', 'uncertain', 'waiting_owner', 'model_running']);
  expect(result.pastTasks.map(item => item.phase)).toEqual(['complete', 'cancelled']);
});

it('follows the actual outgoing and incoming conversation when showing collaboration', () => {
  const snapshot = initialWorkspace(), delegation = snapshot.delegations[0];
  const owner = snapshot.profiles.find(profile => profile.id === delegation.owner)!;
  const source = owner.conversations.find(conversation => conversation.tasks.some(task => task.id === delegation.owner_task))!;
  expect(conversationContext(snapshot, owner.id, source.id).delegations).toContain(delegation);
  expect(conversationContext(snapshot, delegation.target, delegation.conversation_id).delegations).toContain(delegation);
  expect(conversationContext(snapshot, owner.id, delegation.conversation_id).delegations).toEqual([]);
  expect(conversationContext(snapshot, 'theo', source.id).delegations).toEqual([]);
});

it('does not attach orphaned collaboration or another conversation to an empty view', () => {
  const snapshot = initialWorkspace();
  snapshot.profiles[0].conversations = [];
  const result = conversationContext(snapshot, snapshot.profiles[0].id);
  expect(result.delegations).toEqual([]);
  expect(result.currentTasks).toEqual([]);
  expect(result.reviews).toEqual([]);
  expect(result.schedules).toEqual([]);
});

it('omits empty and settled-only categories from the automatic deck while keeping history available', async () => {
  const { contextualCards } = await import('./contextProjection');
  const snapshot = initialWorkspace(), profile = snapshot.profiles[0], conversation = profile.conversations[0];
  snapshot.reviews = []; snapshot.goals = []; snapshot.spaces = []; snapshot.schedules = []; snapshot.delegations = []; snapshot.connectors.computer = false;
  conversation.tasks = [{ id: 'past', name: 'done', phase: 'complete', partial: '', output: '' }];
  const result = contextualCards(snapshot, profile.id, conversation.id);
  expect(result.categories).toEqual([]);
  expect(result.pastTasks).toHaveLength(1);
});

it('keeps attention categories present and orders cards by useful current context', async () => {
  const { contextualCards } = await import('./contextProjection');
  const snapshot = initialWorkspace(), profile = snapshot.profiles[0], conversation = profile.conversations[0];
  snapshot.reviews = [{ id: 'review', profile_id: profile.id, conversation_id: conversation.id, title: 'Review', body: '', state: 'pending', space_id: '' }];
  conversation.tasks = [{ id: 'failed', name: 'check', phase: 'failed', partial: '', output: '' }];
  snapshot.delegations = []; snapshot.goals = []; snapshot.schedules = []; snapshot.spaces = []; snapshot.connectors.computer = true;
  expect(contextualCards(snapshot, profile.id, conversation.id).categories).toEqual(['reviews', 'tasks', 'computer']);
});
