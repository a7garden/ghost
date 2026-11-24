import { describe, expect, it } from 'vitest';
import type { Connection, MailDiscovery } from '@ghost/contract';
import { buildConnectionCommand, draftForService, draftFromConnection, draftFromMailDiscovery, emptyConnectionDraft, groupConnectionsByService, mailAddressFromParts, mailAddressReady, sameMailAddress, type ConnectionDraft } from './connection-config';
import { localScopeSummary, serviceById } from './connection-services';

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

describe('mail service transport commands', () => {
  for (const [id, host, smtpHost, smtpPort, smtpSecure] of [
    ['gmail', 'imap.gmail.com', 'smtp.gmail.com', 465, true],
    ['icloud', 'imap.mail.me.com', 'smtp.mail.me.com', 587, false],
    ['naver', 'imap.naver.com', 'smtp.naver.com', 587, false],
    ['daum', 'imap.daum.net', 'smtp.daum.net', 465, true],
  ] as const) {
    it(`registers ${id} with its configured TLS transports and the owner's account`, () => {
      const service = serviceById(id);
      if (!service) throw new Error(`Missing mail service ${id}`);
      const result = buildConnectionCommand({ ...draftForService(service), name: 'Owner mail', username: 'owner@example.com', credential: 'app-password' }, null);
      expect(result).toMatchObject({ ok: true, command: {
        name: 'Owner mail', credential: 'app-password',
        config: { kind: 'mail', username: 'owner@example.com', host, port: 993, smtpHost, smtpPort, smtpSecure },
      } });
    });
  }
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

const discovery = (patch: Partial<MailDiscovery> = {}): MailDiscovery => ({
  email: 'owner@gmail.com', domain: 'gmail.com',
  provider: { id: 'gmail', name: 'Gmail' },
  imap: { host: 'imap.gmail.com', port: 993 },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  auth: 'app_password',
  setupUrl: 'https://myaccount.google.com/apppasswords',
  note: '2단계 인증이 필요합니다.',
  source: 'known',
  ...patch,
});

describe('grouping accounts under their service', () => {
  it('counts a PAT account the same as any other and keeps unmatched rows with the custom presets', () => {
    const patGithub = connection({ id: 'pat', serviceId: 'github', config: { kind: 'github', baseUrl: 'https://api.github.com' } });
    const gmail = connection({ id: 'mail', serviceId: 'gmail', config: { kind: 'mail', host: 'imap.gmail.com', port: 993, username: 'owner@gmail.com', mailbox: 'INBOX', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true } });
    const unknownMail = connection({ id: 'self', config: { kind: 'mail', host: 'imap.selfhost.test', port: 993, username: 'owner@selfhost.test', mailbox: 'INBOX', smtpHost: null, smtpPort: 587, smtpSecure: false } });
    const wiki = connection({ id: 'wiki', config: { kind: 'api', baseUrl: 'https://wiki.example.com/api', authHeader: 'Authorization', authPrefix: 'Bearer', testPath: 'me', headers: {}, ghostIds: [] } });
    const grouped = groupConnectionsByService([patGithub, gmail, unknownMail, wiki]);
    expect([...grouped.keys()]).toEqual(['github', 'gmail', 'custom-mail', 'custom-api']);
    expect(grouped.get('github')).toEqual([patGithub]);
    expect(grouped.get('custom-mail')).toEqual([unknownMail]);
  });

  it('falls back to the preset whose IMAP host matches when the row carries no service id', () => {
    const legacy = connection({ config: { kind: 'mail', host: 'imap.naver.com', port: 993, username: 'owner@naver.com', mailbox: 'INBOX', smtpHost: 'smtp.naver.com', smtpPort: 587, smtpSecure: false } });
    expect(groupConnectionsByService([legacy]).get('naver')).toEqual([legacy]);
  });
});

describe('mail address-first entry', () => {
  it('completes a local part against the seeded service domain only', () => {
    expect(mailAddressFromParts('owner', serviceById('gmail'))).toBe('owner@gmail.com');
    expect(mailAddressFromParts('owner@company.test', serviceById('gmail'))).toBe('owner@company.test');
    expect(mailAddressFromParts('  owner  ', serviceById('custom-mail'))).toBe('owner');
  });

  it('asks the Host only once both sides of the address exist, and drops stale echoes', () => {
    expect(mailAddressReady('owner@gmail.com')).toBe(true);
    expect(mailAddressReady('owner@')).toBe(false);
    expect(mailAddressReady('@gmail.com')).toBe(false);
    expect(mailAddressReady('owner gmail.com')).toBe(false);
    expect(sameMailAddress(' Owner@Gmail.com ', 'owner@gmail.com')).toBe(true);
    expect(sameMailAddress('owner@gmail.com', 'other@gmail.com')).toBe(false);
  });
});

describe('building a mail draft from discovery', () => {
  it('names the account after the provider and carries the resolved servers verbatim', () => {
    const draft = draftFromMailDiscovery('owner@gmail.com', discovery());
    expect(draft).toMatchObject({
      kind: 'mail', serviceId: 'gmail', name: 'Gmail · owner@gmail.com', username: 'owner@gmail.com',
      host: 'imap.gmail.com', port: '993', mailbox: 'INBOX', smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpSecure: true,
    });
    expect(draft.mailAuthType).toBeUndefined();
    const built = buildConnectionCommand({ ...draft, credential: 'app-password' }, null);
    expect(built).toMatchObject({ ok: true, command: { serviceId: 'gmail', credential: 'app-password', config: { host: 'imap.gmail.com', port: 993, smtpPort: 465, smtpSecure: true } } });
  });

  it('marks OAuth mail so the Host stores the token kind, and omits the flag for app passwords', () => {
    expect(draftFromMailDiscovery('me@outlook.com', discovery({ email: 'me@outlook.com', domain: 'outlook.com', provider: { id: 'outlook', name: 'Outlook' }, auth: 'oauth' })).mailAuthType).toBe('oauth2');
  });

  it('leaves the servers empty for an unresolved domain so the owner types the host', () => {
    const draft = draftFromMailDiscovery('me@selfhost.test', discovery({ email: 'me@selfhost.test', domain: 'selfhost.test', provider: null, imap: null, smtp: null, auth: 'password', setupUrl: null, note: null, source: 'none' }));
    expect(draft).toMatchObject({ serviceId: 'custom-mail', name: 'selfhost.test · me@selfhost.test', host: '', smtpHost: '', smtpSecure: false });
    expect(buildConnectionCommand({ ...draft, credential: 'pw' }, null)).toMatchObject({ ok: false, error: 'IMAP 서버 주소를 입력해 주세요.' });
    const typed = buildConnectionCommand({ ...draft, host: 'imap.selfhost.test', credential: 'pw' }, null);
    expect(typed).toMatchObject({ ok: true, command: { serviceId: 'custom-mail', config: { host: 'imap.selfhost.test' } } });
  });
});

describe('local account scope summary', () => {
  it('stays one short line whatever the Mac sign-in holds', () => {
    expect(localScopeSummary([])).toBe('기본 권한');
    expect(localScopeSummary(['repo', 'read:org'])).toBe('repo · read:org');
    expect(localScopeSummary(['repo', 'read:org', 'gist', 'workflow'])).toBe('repo · read:org 외 2개');
  });
});
