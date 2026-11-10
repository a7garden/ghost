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
  if (!renamed.ok) throw new Error(renamed.error);
  expect('credential' in renamed.command).toBe(false);
  const changed = buildConnectionCommand(githubDraft({ baseUrl: 'https://ghe.example.com/api' }), existing);
  expect(changed.ok).toBe(false);
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

it('preserves OAuth mail authentication when renaming a registered account', () => {
  const existing = connection({ serviceId: 'outlook', config: {
    kind: 'mail', host: 'outlook.office365.com', port: 993, username: 'owner@example.com', mailbox: 'INBOX',
    smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecure: false, authType: 'oauth2',
  } });
  const draft = draftFromConnection(existing);
  draft.name = '회사 메일';
  const result = buildConnectionCommand(draft, existing);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.command.config).toEqual(existing.config);
  expect(result.command).not.toHaveProperty('credential');
});

it('normalizes a new Gitea server but preserves the registered API endpoint on rename', () => {
  const draft = { ...emptyConnectionDraft('gitea'), name: 'mini', baseUrl: 'https://git.example.com/', credential: 'test-token' };
  const created = buildConnectionCommand(draft, null);
  expect(created).toMatchObject({ ok: true, command: { config: { kind: 'gitea', baseUrl: 'https://git.example.com/api/v1' } } });
  const existing = connection({ config: { kind: 'gitea', baseUrl: 'https://git.example.com/api/v1/' } });
  const renamed = draftFromConnection(existing);
  renamed.name = '서버';
  const result = buildConnectionCommand(renamed, existing);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.command.config).toEqual(existing.config);
  expect(result.command).not.toHaveProperty('credential');
});

it('preserves an OAuth API account when only JSON property order differs', () => {
  const existing = connection({ config: {
    ghostIds: ['g1'], headers: { 'Notion-Version': '2026-03-11', Accept: 'application/json' },
    testPath: 'users/me', authPrefix: 'Bearer', authHeader: 'Authorization',
    baseUrl: 'https://api.notion.com/v1/', kind: 'api',
  } });
  const draft = draftFromConnection(existing);
  draft.name = '업무 Notion';
  draft.headers = '{\"Accept\":\"application/json\",\"Notion-Version\":\"2026-03-11\"}';
  const result = buildConnectionCommand(draft, existing);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.command).not.toHaveProperty('credential');
  draft.ghostIds = ['g2'];
  const grantChanged = buildConnectionCommand(draft, existing);
  expect(grantChanged).toMatchObject({ ok: true, command: { config: { ghostIds: ['g2'] } } });
  if (!grantChanged.ok) throw new Error(grantChanged.error);
  expect(grantChanged.command).not.toHaveProperty('credential');
});

it('clearing a custom icon explicitly removes it without replacing authentication', () => {
  const existing = connection({ iconUrl: 'https://example.com/icon.svg' });
  const draft = draftFromConnection(existing);
  draft.iconUrl = '';
  const result = buildConnectionCommand(draft, existing);
  expect(result).toMatchObject({ ok: true, command: { iconUrl: null } });
  if (!result.ok) throw new Error(result.error);
  expect(result.command).not.toHaveProperty('credential');
});
