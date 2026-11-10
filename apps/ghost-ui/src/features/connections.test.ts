import { describe, expect, it } from 'vitest';
import type { Connection } from '@ghost/contract';
import { buildConnectionCommand, draftFromConnection, emptyConnectionDraft, applyMailPreset, mailPresetForHost, mailPresets, type ConnectionDraft } from './connection-config';

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

describe('mail presets', () => {
  it('a preset fills only the transports; name, account and secret stay the owner’s', () => {
    const gmail = mailPresets.find(preset => preset.id === 'gmail');
    if (!gmail) throw new Error('Gmail preset missing');
    const draft = applyMailPreset(emptyConnectionDraft('mail'), gmail);
    expect(draft).toEqual({
      ...emptyConnectionDraft('mail'),
      host: 'imap.gmail.com', port: '993', smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpSecure: true,
    });
  });

  it('Gmail runs implicit TLS on 465, iCloud STARTTLS on 587, Naver and Daum implicit TLS on 465', () => {
    const byId = new Map(mailPresets.map(preset => [preset.id, preset]));
    expect(byId.get('gmail')).toMatchObject({ host: 'imap.gmail.com', port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true });
    expect(byId.get('icloud')).toMatchObject({ host: 'imap.mail.me.com', port: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false });
    expect(byId.get('naver')).toMatchObject({ host: 'imap.naver.com', port: 993, smtpHost: 'smtp.naver.com', smtpPort: 465, smtpSecure: true });
    expect(byId.get('daum')).toMatchObject({ host: 'imap.daum.net', port: 993, smtpHost: 'smtp.daum.net', smtpPort: 465, smtpSecure: true });
    // Microsoft dropped password IMAP for consumer accounts, so Outlook is not offered.
    expect(mailPresets.some(preset => /outlook|office|microsoft/i.test(preset.label))).toBe(false);
  });

  it('recognizes a preset by its IMAP host and points at its app-password page', () => {
    expect(mailPresetForHost(' imap.gmail.com ')?.helpUrl).toBe('https://myaccount.google.com/apppasswords');
    expect(mailPresetForHost('imap.mail.me.com')).toMatchObject({ id: 'icloud', helpUrl: 'https://account.apple.com/account/manage' });
    expect(mailPresetForHost('imap.example.com')).toBeNull();
    // Naver and Daum have no app-password page; the copy tells what to switch on instead.
    expect(mailPresetForHost('imap.naver.com')?.helpUrl).toBe('');
    expect(mailPresetForHost('imap.naver.com')?.helpText).toContain('IMAP/SMTP');
    expect(mailPresetForHost('imap.daum.net')?.helpText).toContain('IMAP/SMTP');
  });
});
