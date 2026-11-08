import { expect, it } from 'vitest';
import { pairingUrl } from './MobilePairing';

it('builds the deep link the iPhone scans, url-encoding origin and code', () => {
  expect(pairingUrl({ origin: 'http://192.168.0.7:62062', code: 'ABCD-2345' }))
    .toBe('ghost://pair?origin=http%3A%2F%2F192.168.0.7%3A62062&code=ABCD-2345');
});

