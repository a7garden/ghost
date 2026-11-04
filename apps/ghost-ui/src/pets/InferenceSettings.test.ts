import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrationCatalogStatus } from '../features/Integrations';
import { inferenceProviderStatus, inferenceRequest } from './InferenceSettings';

afterEach(() => vi.unstubAllGlobals());

describe('inference provider status', () => {
  it('treats the API credential bit as key registration only', () => {
    const provider = { id: 'zai-coding', auth: 'api_key', models: ['glm-5.3'] };
    expect(inferenceProviderStatus(provider, false)).toMatchObject({ label: '인증 필요' });
    expect(inferenceProviderStatus(provider, true)).toMatchObject({
      label: '키 등록됨', detail: '응답을 생성할 때 계정 권한을 확인합니다.',
    });
  });

  it('uses the CLI login method independently of API keys', () => {
    const provider = { id: 'codex', auth: 'codex_oauth', models: ['gpt-6-luna'] };
    expect(inferenceProviderStatus(provider, false)).toMatchObject({ label: 'CLI 로그인' });
  });

  it('distinguishes local route configuration from an absent route', () => {
    const provider = { id: 'local', auth: 'none', models: [] };
    expect(inferenceProviderStatus(provider, false)).toMatchObject({ label: '로컬 미설정' });
    expect(inferenceProviderStatus({ ...provider, models: ['local-fixture'] }, false)).toMatchObject({
      label: '로컬 설정됨', detail: 'local-fixture',
    });
  });
});

describe('inference settings requests', () => {
  it('rejects a response that has settings without a catalog', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'live', csrf: 'fixture' }))
      .mockResolvedValueOnce(Response.json({ ok: true, settings: {} })));
    await expect(inferenceRequest()).rejects.toThrow('모델 설정을 불러오지 못했습니다.');
  });

  it('does not post configuration when the bootstrap is disconnected', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ mode: 'demo' }));
    vi.stubGlobal('fetch', fetch);
    await expect(inferenceRequest({ operation: 'set_default', version: 2 })).rejects.toThrow('연결된 Ghost 호스트');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('MCP discovery status', () => {
  const item = { enabled: true, error: null, checked_ms: null, tools: [{ name: 'example_tool' }] };
  it('reports saved, discovered, failed and disabled states without claiming execution', () => {
    expect(integrationCatalogStatus(item).label).toBe('설정 저장됨');
    expect(integrationCatalogStatus({ ...item, checked_ms: 1 }).label).toBe('도구 목록 확인 · 1개');
    expect(integrationCatalogStatus({ ...item, checked_ms: 1, error: 'fixture failure' }).label).toBe('확인 실패');
    expect(integrationCatalogStatus({ ...item, enabled: false, checked_ms: 1 }).label).toBe('사용 안 함');
  });
});
