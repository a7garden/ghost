import type { Conversation, ModelSettings, Snapshot } from '../client/types';

export type ModelChoice = { value: string; label: string; provider: string; enabled: boolean; status?: string };
export function conversationModelChoices(settings?: ModelSettings): ModelChoice[] {
  return (settings?.providers ?? []).filter(provider => provider.roles.includes('llm')).flatMap(provider => provider.models.filter(model => model.roles.includes('llm')).map(model => ({
    value: `${provider.id}/${model.id}`, label: model.name || model.id, provider: provider.name || provider.id,
    enabled: provider.enabled, status: !provider.enabled ? '비활성' : provider.error ? '목록 확인 필요' : undefined,
  })));
}
export function selectedConversationModel(snapshot: Snapshot, conversation?: Conversation) {
  return conversation?.selected_model ?? conversation?.model ?? snapshot.model_settings?.roles.llm ?? snapshot.default_model;
}
export function modelSelectionLabel(value: string, choices: ModelChoice[]) {
  if (value === 'mock') return '오프라인 테스트 모델';
  const choice = choices.find(item => item.value === value);
  return choice ? `${choice.label} · ${choice.provider}` : value || '모델 선택 필요';
}
export function conversationModelCommand(profileId: string, conversationId: string, model: string) {
  return { type: 'workspace', action: { type: 'conversation_model', profile_id: profileId, conversation_id: conversationId, model } };
}
