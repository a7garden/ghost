import { afterEach, expect, it, vi } from 'vitest';
import { connect } from '../client/api';
import { assetStorage } from '../client/storage';
const setup = () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ mode: 'demo', csrf: '' })));
  vi.spyOn(assetStorage, 'getItem').mockImplementation(async key => saved.get(key) ?? null);
  vi.spyOn(assetStorage, 'setItem').mockImplementation(async (key, value) => { saved.set(key, value); });
  return saved;
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const create = () => ({ request_id: crypto.randomUUID(), command: { type: 'workspace', action: { type: 'create_avatar', avatar: { name: 'Ghost', description: '', data_url: 'data:image/png;base64,AQID', sprite_version: 2, design: null } } } });
it('does not expose an unsaved avatar when browser storage fails', async () => {
  setup(); const client = await connect();
  vi.mocked(assetStorage.setItem).mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(client.action(create())).rejects.toThrow('quota exceeded');
  expect((await client.snapshot()).avatars).toEqual([]);
});
it('restores an avatar and assignment after reconnect, with idempotent creation and an independent second Ghost', async () => {
  setup(); const client = await connect(), envelope = create();
  const avatar = await client.action(envelope) as { id: string };
  expect(await client.action(envelope)).toEqual(avatar);
  await client.action({ request_id: crypto.randomUUID(), command: { type: 'workspace', action: { type: 'set_profile_avatar', profile_id: 'sage', avatar_id: avatar.id, version: 0 } } });
  const reconnected = await connect(), snapshot = await reconnected.snapshot();
  expect(snapshot.avatars).toHaveLength(1);
  expect(snapshot.profiles.find(p => p.id === 'sage')?.avatar_id).toBe(avatar.id);
  expect(snapshot.profiles.find(p => p.id === 'milo')?.avatar_id).toBeNull();
  expect(JSON.stringify(snapshot)).not.toContain('data:image');
  expect(await reconnected.action({ request_id: crypto.randomUUID(), command: { type: 'workspace', action: { type: 'read_avatar', id: avatar.id } } })).toMatchObject({ data_url: 'data:image/png;base64,AQID' });
});
