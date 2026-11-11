import { describe, expect, it } from 'vitest';
import type { VaultItem } from '@ghost/contract';
import { emptyVaultForm, generatePassword, toggleGhostGrant, vaultFormFromItem, vaultGrantsLabel, vaultRowDetail, vaultWriteBody } from './VaultView';

const item = (patch: Partial<VaultItem> = {}): VaultItem => ({
  id: 'v1', kind: 'login', title: '예시 로그인', origin: 'https://app.example.com', username: 'owner@example.com',
  cardLast4: null, cardExpiry: null, contact: null, hints: '', ghostIds: ['g1', 'g2'],
  hasPassword: true, hasTotp: false, expiresAt: null, createdAt: 1, updatedAt: 1, ...patch,
});

describe('vaultFormFromItem', () => {
  it('prefills the readable fields and leaves every secret empty', () => {
    const form = vaultFormFromItem(item({
      kind: 'card', title: '업무 카드', origin: null, username: null, cardLast4: '4242', cardExpiry: '12/28',
      hints: '구독 결제', ghostIds: ['g3'],
    }));
    expect(form).toEqual({ ...emptyVaultForm, kind: 'card', title: '업무 카드', cardExpiry: '12/28', hints: '구독 결제', ghostIds: ['g3'] });
  });

  it('carries contact fields so an edit replaces the whole contact', () => {
    const form = vaultFormFromItem(item({ kind: 'contact', origin: null, username: null,
      contact: { name: '홍길동', phone: '010', email: 'h@e.com', address: '서울시 강남구', addressDetail: '101동 1203호', postalCode: '06236' } }));
    expect(form.contactName).toBe('홍길동');
    expect(form.contactPhone).toBe('010');
    expect(form.contactEmail).toBe('h@e.com');
    expect(form.contactAddress).toBe('서울시 강남구');
    expect(form.contactAddressDetail).toBe('101동 1203호');
    expect(form.contactPostalCode).toBe('06236');
  });
});

describe('vaultWriteBody', () => {
  it('demands a name and the primary fields on create', () => {
    expect(vaultWriteBody(emptyVaultForm, 'create')).toEqual({ error: '이름을 입력해 주세요.' });
    const base = { ...emptyVaultForm, title: '예시' };
    expect(vaultWriteBody({ ...base, kind: 'login' }, 'create')).toEqual({ error: '로그인에는 https://로 시작하는 주소가 필요합니다.' });
    expect(vaultWriteBody({ ...base, kind: 'login', origin: 'https://a.com', username: 'a' }, 'create')).toEqual({ error: '사용자 이름과 비밀번호를 입력해 주세요.' });
    expect(vaultWriteBody({ ...base, kind: 'card', cardNumber: '4242', cardExpiry: '12/28' }, 'create')).toEqual({ error: '카드 번호와 유효기간, CVC, 이름을 모두 입력해 주세요.' });
    expect(vaultWriteBody({ ...base, kind: 'contact' }, 'create')).toEqual({ error: '한 항목 이상 입력해 주세요.' });
    expect(vaultWriteBody({ ...base, kind: 'secret' }, 'create')).toEqual({ error: '값을 입력해 주세요.' });
    expect(vaultWriteBody({ ...base, kind: 'api' }, 'create')).toEqual({ error: 'https://로 시작하는 주소를 입력해 주세요.' });
    expect(vaultWriteBody({ ...base, kind: 'api', origin: 'http://openapi.example.com', value: 'k' }, 'create')).toEqual({ error: 'https://로 시작하는 주소를 입력해 주세요.' });
    expect(vaultWriteBody({ ...base, kind: 'api', origin: 'https://openapi.example.com' }, 'create')).toEqual({ error: '값을 입력해 주세요.' });
  });

  it('creates a login with trimmed text and a verbatim password', () => {
    const body = vaultWriteBody({ ...emptyVaultForm, title: ' 예시 ', origin: ' https://app.example.com ', username: ' owner@e.com ',
      password: ' spaced pass ', totp: 'JBSW', ghostIds: ['g1'] }, 'create');
    expect(body).toEqual({ body: {
      kind: 'login', title: '예시', origin: 'https://app.example.com', username: 'owner@e.com',
      password: ' spaced pass ', totp: 'JBSW', hints: '', ghostIds: ['g1'],
    } });
  });

  it('drops empty secret fields on edit so they stay unchanged, and keeps the grant list', () => {
    const form = { ...vaultFormFromItem(item()), password: '', totp: '', hints: '새 메모', ghostIds: ['g1'] };
    const body = vaultWriteBody(form, 'edit');
    expect('body' in body && body.body).toEqual({
      kind: 'login', title: '예시 로그인', origin: 'https://app.example.com', username: 'owner@example.com',
      hints: '새 메모', ghostIds: ['g1'],
    });
    expect('body' in body && body.body.password).toBeUndefined();
    expect('body' in body && body.body.totp).toBeUndefined();
  });

  it('sends the card only as a whole replacement with the holder name', () => {
    const base = { ...emptyVaultForm, title: '업무 카드', kind: 'card' as const };
    expect(vaultWriteBody({ ...base, cardNumber: '4242', cardExpiry: '12/28' }, 'edit'))
      .toEqual({ error: '카드 번호와 유효기간, CVC, 이름을 모두 입력해 주세요.' });
    const body = vaultWriteBody({ ...base, cardNumber: ' 4242 ', cardExpiry: '12/28', cardCvc: ' 123 ', cardName: ' 홍 ' }, 'edit');
    expect('body' in body && body.body.card).toEqual({ number: '4242', expiry: '12/28', cvc: '123', name: '홍' });
    // Card-only expiry edits keep the stored card: nothing typed into number or CVC, no card sent.
    const untouched = vaultWriteBody({ ...base, cardExpiry: '01/29' }, 'edit');
    expect('body' in untouched && untouched.body.card).toBeUndefined();
  });

  it('sends only the selected kind’s fields, even when others were typed first', () => {
    const switched = vaultWriteBody({ ...emptyVaultForm, title: '예시', kind: 'card', username: 'left@over', password: 'left',
      cardNumber: '4242', cardExpiry: '12/28', cardCvc: '123', cardName: '홍' }, 'create');
    expect('body' in switched && switched.body).toEqual({
      kind: 'card', title: '예시', hints: '', ghostIds: [],
      card: { number: '4242', expiry: '12/28', cvc: '123', name: '홍' },
    });
    expect('body' in switched && switched.body.username).toBeUndefined();
    expect('body' in switched && switched.body.password).toBeUndefined();
  });

  it('keeps only the contact fields that are filled, and an empty contact clears them', () => {
    const body = vaultWriteBody({ ...emptyVaultForm, title: '연락처', kind: 'contact', contactName: '홍길동', contactEmail: 'h@e.com' }, 'create');
    expect('body' in body && body.body).toEqual({
      kind: 'contact', title: '연락처', hints: '', ghostIds: [],
      contact: { name: '홍길동', email: 'h@e.com' },
    });
    const cleared = vaultWriteBody({ ...emptyVaultForm, title: '연락처', kind: 'contact' }, 'edit');
    expect('body' in cleared && cleared.body.contact).toEqual({});
  });

  it('writes 상세주소 and 우편번호 with the contact, trimmed, and drops them when empty', () => {
    const body = vaultWriteBody({ ...emptyVaultForm, title: '연락처', kind: 'contact', contactName: '홍길동',
      contactAddress: '서울시 강남구', contactAddressDetail: ' 101동 1203호 ', contactPostalCode: '06236' }, 'create');
    expect('body' in body && body.body.contact).toEqual({
      name: '홍길동', address: '서울시 강남구', addressDetail: '101동 1203호', postalCode: '06236',
    });
    const detailOnly = vaultWriteBody({ ...emptyVaultForm, title: '연락처', kind: 'contact', contactAddressDetail: '101동' }, 'create');
    expect('body' in detailOnly && detailOnly.body.contact).toEqual({ addressDetail: '101동' });
  });

  it('keeps a cleared secret origin off the wire and stores the value verbatim', () => {
    const body = vaultWriteBody({ ...emptyVaultForm, title: '키', kind: 'secret', origin: '  ', value: ' raw value ' }, 'edit');
    expect('body' in body && body.body).toEqual({ kind: 'secret', title: '키', hints: '', ghostIds: [], value: ' raw value ' });
    expect('body' in body && body.body.origin).toBeUndefined();
  });

  it('creates an API key with the origin and an optional client id, keeping the key verbatim', () => {
    const body = vaultWriteBody({ ...emptyVaultForm, title: ' 토스 ', kind: 'api', origin: ' https://openapi.example.com ',
      username: ' client ', value: ' raw key ', hints: ' 조회용 ', ghostIds: ['g2'] }, 'create');
    expect(body).toEqual({ body: {
      kind: 'api', title: '토스', origin: 'https://openapi.example.com', username: 'client',
      value: ' raw key ', hints: '조회용', ghostIds: ['g2'],
    } });
    const anonymous = vaultWriteBody({ ...emptyVaultForm, title: '토스', kind: 'api', origin: 'https://openapi.example.com', value: 'k' }, 'create');
    expect('body' in anonymous && anonymous.body.username).toBeUndefined();
  });

  it('drops an empty API key on edit and lets a cleared client id travel', () => {
    const form = vaultFormFromItem(item({ kind: 'api', title: '토스 키', origin: 'https://openapi.example.com', username: 'client' }));
    const body = vaultWriteBody({ ...form, value: '', username: '', hints: '새 메모' }, 'edit');
    expect('body' in body && body.body).toEqual({
      kind: 'api', title: '토스 키', origin: 'https://openapi.example.com', username: '', hints: '새 메모', ghostIds: ['g1', 'g2'],
    });
    expect('body' in body && body.body.value).toBeUndefined();
  });
});

describe('generatePassword', () => {
  const bytes = (...values: number[]) => (size: number) => Uint8Array.from({ length: size }, (_, index) => values[index % values.length]);

  it('draws every character from the alphabet and keeps the requested length', () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
    const password = generatePassword(20, bytes(...alphabet.split('').map((_, index) => index)));
    expect(password).toBe(alphabet.slice(0, 20));
  });

  it('skips bytes past the last whole multiple of the alphabet to stay unbiased', () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
    const limit = 256 - (256 % alphabet.length);
    const password = generatePassword(4, bytes(limit + 5, 0, limit, 1));
    expect(password).toBe('abab');
  });

  it('fills the length even when rejection discards bytes across draws', () => {
    // Half the bytes sit past the alphabet's last whole multiple and are redrawn.
    const password = generatePassword(20, bytes(255, 0));
    expect(password).toBe('a'.repeat(20));
  });

  it('makes different passwords from different bytes', () => {
    expect(generatePassword(8, bytes(0, 1, 2, 3))).not.toBe(generatePassword(8, bytes(4, 5, 6, 7)));
  });
});

describe('toggleGhostGrant', () => {
  it('adds and removes without duplicates or mutation', () => {
    expect(toggleGhostGrant(['g1'], 'g2', true)).toEqual(['g1', 'g2']);
    expect(toggleGhostGrant(['g1', 'g2'], 'g2', true)).toEqual(['g1', 'g2']);
    expect(toggleGhostGrant(['g1', 'g2'], 'g2', false)).toEqual(['g1']);
    const saved = ['g1'];
    expect(toggleGhostGrant(saved, 'g2', true)).not.toBe(saved);
    expect(saved).toEqual(['g1']);
  });
});

describe('vaultRowDetail and vaultGrantsLabel', () => {
  it('shows only readable facts, never a secret value', () => {
    expect(vaultRowDetail(item())).toBe('https://app.example.com · owner@example.com');
    expect(vaultRowDetail(item({ kind: 'card', origin: null, username: null, cardLast4: '4242', cardExpiry: '12/28' })))
      .toBe('•••• 4242 · 12/28');
    expect(vaultRowDetail(item({ kind: 'secret', origin: 'https://e.com', username: null }))).toBe('https://e.com');
    expect(vaultRowDetail(item({ kind: 'secret', origin: null, username: null }))).toBe('');
    expect(vaultRowDetail(item({ kind: 'contact', origin: null, username: null,
      contact: { name: '홍길동', address: '서울시 강남구', addressDetail: '101동 1203호', postalCode: '06236' } })))
      .toBe('홍길동 · 서울시 강남구 · 101동 1203호 · 06236');
    expect(vaultRowDetail(item({ kind: 'api', origin: 'https://openapi.example.com', username: 'client' })))
      .toBe('https://openapi.example.com · client');
    expect(vaultRowDetail(item({ kind: 'api', origin: 'https://openapi.example.com', username: null })))
      .toBe('https://openapi.example.com');
  });

  it('names the granted Ghosts and the one-time expiry', () => {
    expect(vaultGrantsLabel(item({ ghostIds: ['g1'] }), id => `Ghost ${id}`)).toBe('Ghost g1 사용 가능');
    expect(vaultGrantsLabel(item({ ghostIds: [] }), id => id)).toBe('Ghost 권한 없음');
    // The 일회용 badge already marks the kind; the description carries only the time.
    const expiryLabel = vaultGrantsLabel(item({ ghostIds: [], expiresAt: Date.UTC(2026, 10, 9, 6, 30) }), id => id);
    expect(expiryLabel.startsWith('Ghost 권한 없음 · ')).toBe(true);
    expect(expiryLabel.endsWith('에 삭제')).toBe(true);
    expect(expiryLabel).not.toContain('일회용');
  });
});
