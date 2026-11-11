import { expect, it } from 'vitest';
import type { Connection } from '@ghost/contract';
import { buildConnectionCommand, draftFromConnection, emptyConnectionDraft, type ConnectionDraft } from './connection-config';
import { giteaApiUrl, mailPresetFor, mailServerGuess, matchesMailServers, tokenPageUrl } from './connection-presets';

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

it('a blank name falls back to the account so a new connection needs only the address and the token', () => {
  expect(buildConnectionCommand(githubDraft({ name: '', credential: 'ghp_x' }), null)).toMatchObject({ ok: true, command: { name: 'GitHub' } });
  const mail = { ...emptyConnectionDraft('mail'), username: 'me@gmail.com', host: 'imap.gmail.com', credential: 'app' };
  expect(buildConnectionCommand(mail, null)).toMatchObject({ ok: true, command: { name: 'me@gmail.com' } });
});

it('a Gitea server address gains the API path the Host calls', () => {
  expect(giteaApiUrl('https://git.example.com/')).toBe('https://git.example.com/api/v1');
  expect(giteaApiUrl('https://git.example.com/api/v1')).toBe('https://git.example.com/api/v1');
  const built = buildConnectionCommand({ ...emptyConnectionDraft('gitea'), baseUrl: 'https://git.example.com', credential: 't' }, null);
  expect(built).toMatchObject({ ok: true, command: { config: { kind: 'gitea', baseUrl: 'https://git.example.com/api/v1' } } });
});

it('token pages open on the site that issues the credential', () => {
  expect(tokenPageUrl('github', 'https://api.github.com')).toBe('https://github.com/settings/tokens/new?description=Ghost&scopes=repo');
  expect(tokenPageUrl('github', 'https://ghe.example.com/api/v3')).toBe('https://ghe.example.com/settings/tokens/new?description=Ghost&scopes=repo');
  expect(tokenPageUrl('gitea', 'https://git.example.com/sub/api/v1')).toBe('https://git.example.com/sub/user/settings/applications');
  expect(tokenPageUrl('gitea', 'git.example.com')).toBeNull();
});

it('known mail domains resolve to their servers; unknown ones stay manual', () => {
  expect(mailPresetFor('Me@GMAIL.com')?.host).toBe('imap.gmail.com');
  expect(mailPresetFor('me@hanmail.net')?.id).toBe('daum');
  expect(mailPresetFor('me@company.co.kr')).toBeUndefined();
  expect(mailPresetFor('me')).toBeUndefined();
});

it('every mail address gets servers so the server fields can stay folded', () => {
  expect(mailServerGuess('me@naver.com')).toMatchObject({ host: 'imap.naver.com', smtpHost: 'smtp.naver.com' });
  expect(mailServerGuess('me@company.co.kr')).toEqual({ host: 'imap.company.co.kr', port: '993', smtpHost: 'smtp.company.co.kr', smtpPort: '587', smtpSecure: false });
  expect(mailServerGuess('me@')).toBeNull();
  const guessed = mailServerGuess('me@company.co.kr')!;
  expect(matchesMailServers(guessed, guessed)).toBe(true);
  expect(matchesMailServers(guessed, { ...guessed, host: 'mail.company.co.kr' })).toBe(false);
});
