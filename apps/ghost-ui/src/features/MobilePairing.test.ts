import { expect, it } from 'vitest';
import type { DeviceGrant } from '@ghost/contract';
import { grantsLabel, pairingUrl, sameGrants } from './MobilePairing';

const grant = (ghostId: string, conversationId: string | null = null): DeviceGrant => ({ ghostId, conversationId });

it('builds the deep link the iPhone scans, url-encoding origin and code', () => {
  expect(pairingUrl({ origin: 'http://192.168.0.7:62062', code: 'ABCD-2345' }))
    .toBe('ghost://pair?origin=http%3A%2F%2F192.168.0.7%3A62062&code=ABCD-2345');
});

it('compares grants order-independently, separating the every-conversation null', () => {
  expect(sameGrants([grant('sage')], [grant('sage')])).toBe(true);
  expect(sameGrants([grant('sage'), grant('milo')], [grant('milo'), grant('sage')])).toBe(true);
  expect(sameGrants([grant('sage')], [grant('milo')])).toBe(false);
  expect(sameGrants([grant('sage')], [grant('sage', 'c1')])).toBe(false);
  expect(sameGrants([], [])).toBe(true);
});

it('describes grants with the current Ghost names', () => {
  const name = (id: string) => (id === 'sage' ? '세이지' : id);
  expect(grantsLabel([grant('sage')], name)).toBe('세이지 대화');
  expect(grantsLabel([], name)).toBe('Ghost 권한 없음');
});
