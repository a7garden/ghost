import type { ModelProvider } from '../client/types';

export function checkedProvider(result: Record<string, any>, id: string): ModelProvider {
  const provider = Array.isArray(result.settings?.providers) ? result.settings.providers.find((p: ModelProvider) => p.id === id) as ModelProvider | undefined : undefined;
  if (!provider) throw new Error('모델 목록 확인 결과를 읽지 못했습니다.');
  if (provider.error) throw new Error(provider.error);
  if (!provider.checked_ms) throw new Error('모델 목록 응답을 확인하지 못했습니다.');
  return provider;
}
export function respondingServers(providers: ModelProvider[]): ModelProvider[] {
  return providers.filter(p => !p.error && Boolean(p.checked_ms));
}
