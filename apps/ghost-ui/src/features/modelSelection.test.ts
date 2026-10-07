import { expect, it } from 'vitest';
import { initialWorkspace } from '../fixtures/workspace';
import { normalizeSnapshot } from '../client/normalize';
import { conversationModelChoices, conversationModelCommand, modelSelectionLabel, selectedConversationModel } from './modelSelection';
import type { ModelSettings } from '../client/types';

const settings: ModelSettings = { version: 1, catalog_updated_ms: null, roles: { llm: 'local/chat', stt: null, tts: null }, providers: [
  { id: 'local', name: 'Local', kind: 'openai_compatible', endpoint: 'http://localhost', auth: { type: 'none' }, roles: ['llm', 'stt'], enabled: true, checked_ms: null, error: null, models: [{ id: 'chat', name: 'Chat', roles: ['llm'] }, { id: 'speech', name: 'Speech', roles: ['stt'] }] },
  { id: 'disabled', name: 'Disabled', kind: 'builtin', endpoint: '', auth: { type: 'sdk' }, roles: ['llm'], enabled: false, checked_ms: null, error: null, models: [{ id: 'chat', name: 'Chat', roles: ['llm'] }] },
] };
it('offers actual registered LLMs and preserves a disabled provider as unavailable', () => {
  expect(conversationModelChoices(settings)).toEqual([
    { value: 'local/chat', label: 'Chat', provider: 'Local', enabled: true, status: undefined },
    { value: 'disabled/chat', label: 'Chat', provider: 'Disabled', enabled: false, status: '비활성' },
  ]);
});
it('restores desired per-conversation selection without replacing the running model', () => {
  const raw = initialWorkspace(); raw.model_settings = settings;
  Object.assign(raw.profiles[0].conversations[0], { model: 'legacy-running', selected_model: 'local/chat', model_pending: true, model_available: true, model_error: null });
  const snapshot = normalizeSnapshot(raw), conversation = snapshot.profiles[0].conversations[0];
  expect(selectedConversationModel(snapshot, conversation)).toBe('local/chat');
  expect(conversation.model).toBe('legacy-running');
  expect(conversation.model_pending).toBe(true);
  expect(modelSelectionLabel(conversation.selected_model!, conversationModelChoices(settings))).toBe('Chat · Local');
});
it('preserves removed models and host error details without silently choosing another model', () => {
  const raw = initialWorkspace(); raw.model_settings = settings;
  Object.assign(raw.profiles[0].conversations[0], { selected_model: 'removed/old', model_available: false, model_error: '제공자가 삭제되었습니다.' });
  const snapshot = normalizeSnapshot(raw), conversation = snapshot.profiles[0].conversations[0];
  expect(selectedConversationModel(snapshot, conversation)).toBe('removed/old');
  expect(conversation.model_available).toBe(false);
  expect(conversation.model_error).toBe('제공자가 삭제되었습니다.');
  expect(conversationModelChoices(settings).some(item => item.value === conversation.selected_model)).toBe(false);
});
it('uses host defaults for a new conversation and sends a conversation-scoped selection command', () => {
  const snapshot = initialWorkspace(); snapshot.model_settings = settings;
  expect(selectedConversationModel(snapshot)).toBe('local/chat');
  expect(conversationModelCommand('ghost-a', 'chat-a', 'local/chat')).toEqual({ type: 'workspace', action: { type: 'conversation_model', profile_id: 'ghost-a', conversation_id: 'chat-a', model: 'local/chat' } });
});
