import type { ConnectionConfig } from '@ghost/contract';

/**
 * 연결 추가를 「주소 입력 → 토큰 · 앱 비밀번호 붙여 넣기」 두 걸음으로 줄이는 사이트별 기본값.
 * OAuth 는 사이트마다 Ghost 를 앱으로 등록해야 해서 쓰지 않는다(2026.11.11 소유자 결정) —
 * 대신 자격을 만드는 페이지를 바로 열어 주고, 서버 주소 · 포트는 메일 주소에서 채운다.
 */

export interface MailPreset {
  id: string;
  label: string;
  domains: readonly string[];
  host: string;
  port: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** 앱 비밀번호를 만드는 곳. 정확한 주소를 모르는 곳은 메일 홈만 연다. */
  credentialUrl: string;
  credentialLabel: string;
  /** 사이트에서 미리 해 둘 일. 하지 않으면 로그인이 거절된다. */
  steps: readonly string[];
}

// 2026.11.11 : 각 사이트가 공개한 IMAP/SMTP 안내 기준. Gmail 외에는 실제 계정으로 확인하지 않았다 — 저장 직후 연결 테스트가 확인한다.
export const mailPresets: readonly MailPreset[] = [
  {
    id: 'gmail', label: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
    host: 'imap.gmail.com', port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
    credentialUrl: 'https://myaccount.google.com/apppasswords', credentialLabel: 'Google 앱 비밀번호 만들기',
    steps: ['Google 계정에 2단계 인증을 켭니다.', '앱 비밀번호를 만들어 16자리를 아래에 붙여 넣습니다.'],
  },
  {
    id: 'naver', label: '네이버 메일', domains: ['naver.com'],
    host: 'imap.naver.com', port: 993, smtpHost: 'smtp.naver.com', smtpPort: 465, smtpSecure: true,
    credentialUrl: 'https://mail.naver.com', credentialLabel: '네이버 메일 열기',
    steps: ['메일 환경설정 → POP3/IMAP 설정에서 IMAP/SMTP 사용을 켭니다.', '2단계 인증을 쓰면 애플리케이션 비밀번호를, 아니면 네이버 비밀번호를 붙여 넣습니다.'],
  },
  {
    id: 'daum', label: 'Daum 메일', domains: ['daum.net', 'hanmail.net'],
    host: 'imap.daum.net', port: 993, smtpHost: 'smtp.daum.net', smtpPort: 465, smtpSecure: true,
    credentialUrl: 'https://mail.daum.net', credentialLabel: 'Daum 메일 열기',
    steps: ['메일 환경설정 → IMAP/SMTP 에서 사용을 켭니다.', '2단계 인증을 쓰면 앱 비밀번호를, 아니면 계정 비밀번호를 붙여 넣습니다.'],
  },
  {
    id: 'icloud', label: 'iCloud 메일', domains: ['icloud.com', 'me.com', 'mac.com'],
    host: 'imap.mail.me.com', port: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false,
    credentialUrl: 'https://account.apple.com/account/manage', credentialLabel: 'Apple 계정 열기',
    steps: ['로그인 및 보안 → 앱 암호에서 새 암호를 만듭니다.', '만든 앱 암호를 아래에 붙여 넣습니다.'],
  },
];

export const mailPresetFor = (address: string): MailPreset | undefined => {
  const domain = address.trim().toLowerCase().split('@')[1];
  return domain ? mailPresets.find(preset => preset.domains.includes(domain)) : undefined;
};

export interface MailServerFields { host: string; port: string; smtpHost: string; smtpPort: string; smtpSecure: boolean }

/**
 * 메일 주소에서 서버 값을 정한다. 아는 사이트는 프리셋, 모르는 도메인은 가장 흔한 꼴(imap.<도메인> · smtp.<도메인>)로 추측한다.
 * 2026.11.11 : 서버 칸을 늘 접어 두기로 해서(소유자 요청) 모르는 도메인도 빈칸 대신 추측값으로 채운다 — 틀리면 저장 직후 연결 테스트가 알린다.
 */
export function mailServerGuess(address: string): MailServerFields | null {
  const preset = mailPresetFor(address);
  if (preset) return { host: preset.host, port: String(preset.port), smtpHost: preset.smtpHost, smtpPort: String(preset.smtpPort), smtpSecure: preset.smtpSecure };
  const domain = address.trim().toLowerCase().split('@')[1];
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return { host: `imap.${domain}`, port: '993', smtpHost: `smtp.${domain}`, smtpPort: '587', smtpSecure: false };
}

/** 폼의 서버 값이 그 주소의 자동값 그대로인지. 사용자가 고쳤으면 더는 자동으로 덮어쓰지 않는다. */
export const matchesMailServers = (fields: MailServerFields | null, draft: MailServerFields) => fields !== null
  && draft.host.trim() === fields.host && draft.port === fields.port
  && draft.smtpHost.trim() === fields.smtpHost && draft.smtpPort === fields.smtpPort && draft.smtpSecure === fields.smtpSecure;

export const GITHUB_API = 'https://api.github.com';

/**
 * Gitea 는 서버 주소만 받아도 된다 — API 는 늘 `<서버>/api/v1` 이다.
 * 그대로 두면 호스트가 `https://git.example.com` 을 API 주소로 불러 404 가 난다.
 */
export function giteaApiUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/.test(trimmed)) return trimmed;
  return /\/api\/v1$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

/** 토큰 발급 페이지. 주소를 아직 모르면 null. */
export function tokenPageUrl(kind: Exclude<ConnectionConfig['kind'], 'mail'>, baseUrl: string): string | null {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (kind === 'github') {
    // classic 토큰만 권한 · 이름을 주소로 미리 고를 수 있다. repo 는 PR 읽기 · 댓글에 필요하다.
    const query = '?description=Ghost&scopes=repo';
    if (url.hostname === 'api.github.com') return `https://github.com/settings/tokens/new${query}`;
    // GitHub Enterprise: https://ghe.example.com/api/v3 → https://ghe.example.com
    return `${url.origin}${url.pathname.replace(/\/api\/v3\/?$/, '').replace(/\/+$/, '')}/settings/tokens/new${query}`;
  }
  return `${url.origin}${url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '')}/user/settings/applications`;
}

/** 이름을 비워 두면 쓰는 이름. 연결 목록에서 계정을 알아볼 수 있는 값을 고른다. */
export function defaultConnectionName(draft: { kind: ConnectionConfig['kind']; baseUrl: string; username: string }): string {
  if (draft.kind === 'mail') return draft.username.trim();
  if (draft.kind === 'github') {
    try { const host = new URL(draft.baseUrl).hostname; return host === 'api.github.com' ? 'GitHub' : `GitHub ${host}`; } catch { return 'GitHub'; }
  }
  try { return `Gitea ${new URL(draft.baseUrl).hostname}`; } catch { return 'Gitea'; }
}
