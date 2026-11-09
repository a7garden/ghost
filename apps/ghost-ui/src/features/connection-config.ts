import { type Connection, type ConnectionConfig } from '@ghost/contract';

export const connectionKindLabel: Record<ConnectionConfig['kind'], string> = {
  github: 'GitHub', gitea: 'Gitea', mail: '메일',
};

/** Account metadata only; stored credentials are never part of the summary. */
export function connectionSummary(connection: Connection): string {
  const config = connection.config;
  if (config.kind === 'mail') {
    return [`${config.host}:${config.port}`, config.username, config.mailbox,
      config.smtpHost ? `SMTP ${config.smtpHost}` : null].filter(Boolean).join(' · ');
  }
  return config.baseUrl;
}

/** Everything the connection form owns, as input strings. The secret itself never round-trips. */
export interface ConnectionDraft {
  kind: ConnectionConfig['kind'];
  name: string;
  baseUrl: string;
  host: string;
  port: string;
  username: string;
  mailbox: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  /** Typed secret; the stored one is never shown or prefilled. */
  credential: string;
  /** Editing only: remove the stored credential instead of keeping it. */
  clearCredential: boolean;
}

export const emptyConnectionDraft = (kind: ConnectionConfig['kind']): ConnectionDraft => ({
  kind, name: '', baseUrl: '', host: '', port: '993', username: '', mailbox: 'INBOX',
  smtpHost: '', smtpPort: '587', smtpSecure: false, credential: '', clearCredential: false,
});

export function draftFromConnection(connection: Connection): ConnectionDraft {
  const config = connection.config;
  return {
    ...emptyConnectionDraft(config.kind),
    name: connection.name,
    ...(config.kind === 'mail'
      ? { host: config.host, port: String(config.port), username: config.username, mailbox: config.mailbox, smtpHost: config.smtpHost ?? '', smtpPort: String(config.smtpPort), smtpSecure: config.smtpSecure }
      : { baseUrl: config.baseUrl }),
  };
}

const intIn = (value: string, min: number, max: number, label: string): number | string => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) return `${label}은 ${min}부터 ${max}까지의 수여야 합니다.`;
  return parsed;
};

export type BuiltConnection =
  | { ok: true; command: { type: 'connection.upsert'; connectionId?: string; name: string; config: ConnectionConfig; credential?: string | null } }
  | { ok: false; error: string };

/**
 * Form → connection.upsert command. A blank secret preserves credentials only when
 * configuration is unchanged. A changed disconnected account explicitly stays
 * disconnected; stored credentials must be retyped or explicitly removed.
 */
export function buildConnectionCommand(draft: ConnectionDraft, existing: Connection | null): BuiltConnection {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: '연결 이름을 입력해 주세요.' };
  if (name.length > 128) return { ok: false, error: '연결 이름은 128자 이하여야 합니다.' };

  let config: ConnectionConfig;
  if (draft.kind === 'mail') {
    const host = draft.host.trim();
    if (!host) return { ok: false, error: 'IMAP 서버 주소를 입력해 주세요.' };
    if (host.length > 253) return { ok: false, error: 'IMAP 서버 주소는 253자 이하여야 합니다.' };
    const port = intIn(draft.port, 1, 65535, 'IMAP 포트');
    if (typeof port === 'string') return { ok: false, error: port };
    const username = draft.username.trim();
    if (!username) return { ok: false, error: '메일 계정(사용자 이름)을 입력해 주세요.' };
    if (username.length > 320) return { ok: false, error: '사용자 이름은 320자 이하여야 합니다.' };
    const mailbox = draft.mailbox.trim();
    if (!mailbox) return { ok: false, error: '메일함 이름을 입력해 주세요.' };
    if (mailbox.length > 256) return { ok: false, error: '메일함 이름은 256자 이하여야 합니다.' };
    const smtpHost = draft.smtpHost.trim();
    if (smtpHost.length > 253) return { ok: false, error: 'SMTP 서버 주소는 253자 이하여야 합니다.' };
    const smtpPort = intIn(draft.smtpPort, 1, 65535, 'SMTP 포트');
    if (typeof smtpPort === 'string') return { ok: false, error: smtpPort };
    config = {
      kind: 'mail', host, port, username, mailbox,
      smtpHost: smtpHost || null, smtpPort, smtpSecure: draft.smtpSecure,
    };
  } else {
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) return { ok: false, error: `API 주소를 입력해 주세요. (예: ${draft.kind === 'github' ? 'https://api.github.com' : 'https://git.example.com'})` };
    if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: 'API 주소는 http:// 또는 https://로 시작해야 합니다.' };
    if (baseUrl.length > 2048) return { ok: false, error: 'API 주소는 2,048자 이하여야 합니다.' };
    config = { kind: draft.kind, baseUrl };
  }

  const secret = draft.credential;
  const configChanged = existing !== null && JSON.stringify(config) !== JSON.stringify(existing.config);
  if (existing?.hasCredential && configChanged && !draft.clearCredential && !secret) {
    return { ok: false, error: '연결 정보가 바뀌었습니다. 새 자격 증명을 입력하거나 저장된 자격을 삭제해 주세요.' };
  }
  const command: Extract<BuiltConnection, { ok: true }>['command'] = {
    type: 'connection.upsert',
    ...(existing ? { connectionId: existing.id } : {}),
    name, config,
    ...(draft.clearCredential && existing?.hasCredential ? { credential: null }
      : secret ? { credential: secret } : configChanged ? { credential: null } : {}),
  };
  return { ok: true, command };
}
