import { expect, it } from 'vitest';
import type { Connection } from '@ghost/contract';
import { buildConnectionCommand, draftFromConnection, emptyConnectionDraft, type ConnectionDraft } from './connection-config';

const connection = (patch: Partial<Connection> = {}): Connection => ({
  id: 'c1', name: '소유자 GitHub', hasCredential: true, createdAt: 1, updatedAt: 1, credentialVersion: 'v1',
  config: { kind: 'github', baseUrl: 'https://api.github.com' },
  ...patch,
});

const githubDraft = (patch: Partial<ConnectionDraft> = {}): ConnectionDraft => ({
  ...emptyConnectionDraft('github'), name: '소유자 GitHub', baseUrl: 'https://api.github.com', ...patch,
});

it('a name-only edit preserves the stored credential; an endpoint change forces re-entry or removal', () => {
  const existing = connection();
  const renamed = buildConnectionCommand(githubDraft({ name: '회사 GitHub' }), existing);
  if (!renamed.ok) return;
  expect('credential' in renamed.command).toBe(false);
  const changed = buildConnectionCommand(githubDraft({ baseUrl: 'https://ghe.example.com/api' }), existing);
  expect(changed).toMatchObject({ ok: false, error: '연결 정보가 바뀌었습니다. 새 자격 증명을 입력하거나 저장된 자격을 삭제해 주세요.' });
  const replaced = buildConnectionCommand(githubDraft({ baseUrl: 'https://ghe.example.com/api', credential: 'ghp_new' }), existing);
  expect(replaced).toMatchObject({ ok: true, command: { credential: 'ghp_new' } });
  const stripped = buildConnectionCommand(githubDraft({ baseUrl: 'https://ghe.example.com/api', clearCredential: true }), existing);
  expect(stripped).toMatchObject({ ok: true, command: { credential: null } });
});

it('an endpoint change on a disconnected account explicitly stays disconnected for the Host', () => {
  const bare = connection({ hasCredential: false, credentialVersion: null });
  const changed = buildConnectionCommand(githubDraft({ baseUrl: 'https://ghe.example.com/api' }), bare);
  expect(changed).toMatchObject({ ok: true, command: { connectionId: 'c1', credential: null } });
});

it('editing never echoes the stored secret back into the form', () => {
  const draft = draftFromConnection(connection());
  expect(draft.credential).toBe('');
  expect(draft.clearCredential).toBe(false);
  expect(draft.baseUrl).toBe('https://api.github.com');
});

it('incomplete or malformed connection forms are refused locally', () => {
  expect(buildConnectionCommand(githubDraft({ name: '' }), null)).toMatchObject({ ok: false });
  expect(buildConnectionCommand(githubDraft({ baseUrl: 'api.github.com' }), null)).toMatchObject({ ok: false });
  expect(buildConnectionCommand(githubDraft({ baseUrl: '' }), null)).toMatchObject({ ok: false });
});

it('keeps custom mail ports and transport mode when renaming without replacing the credential', () => {
  const existing = connection({ config: {
    kind: 'mail', host: 'imap.example.com', port: 1993, username: 'owner@example.com', mailbox: 'Priority',
    smtpHost: 'smtp.example.com', smtpPort: 2525, smtpSecure: false,
  } });
  const edited = draftFromConnection(existing);
  edited.name = 'Priority mail';
  const built = buildConnectionCommand(edited, existing);
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(built.error);
  expect(built.command.config).toEqual(existing.config);
  expect(built.command).not.toHaveProperty('credential');
});
