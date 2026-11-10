import type { Connection, ConnectionConfig } from '@ghost/contract';

export interface ConnectionService {
  id: string;
  name: string;
  kind: ConnectionConfig['kind'];
  group: '서비스' | '메일' | '직접 연결';
  icon?: string;
  baseUrl?: string;
  testPath?: string;
  headers?: Record<string, string>;
  setupUrl?: string;
  credentialLabel: string;
  requirement: string;
  mail?: { host: string; smtpHost: string; smtpPort: number; smtpSecure: boolean };
}

export const connectionServices: readonly ConnectionService[] = [
  { id: 'google', name: 'Google', kind: 'api', group: '서비스', icon: 'google', baseUrl: 'https://www.googleapis.com/', testPath: 'oauth2/v3/userinfo', setupUrl: 'https://console.cloud.google.com/apis/credentials', credentialLabel: 'OAuth 액세스 토큰', requirement: 'Google API 연결에는 OAuth 앱 등록과 권한 동의가 필요합니다. Ghost가 설정을 돕고, 로그인·추가 인증은 직접 진행합니다. 액세스 토큰은 만료 후 갱신해야 합니다.' },
  { id: 'notion', name: 'Notion', kind: 'api', group: '서비스', icon: 'notion', baseUrl: 'https://api.notion.com/v1/', testPath: 'users/me', headers: { 'Notion-Version': '2026-03-11' }, setupUrl: 'https://www.notion.so/developers/tokens', credentialLabel: '개인 접근 토큰 또는 통합 토큰', requirement: '로그인으로 연결하거나 개인 접근 토큰을 등록합니다. 내부 통합 토큰을 쓴다면 사용할 페이지를 해당 통합에 공유해야 합니다.' },
  { id: 'x', name: 'X', kind: 'api', group: '서비스', icon: 'x', baseUrl: 'https://api.x.com/2/', testPath: 'users/me', setupUrl: 'https://console.x.com/', credentialLabel: '사용자 액세스 토큰', requirement: '개발자 앱과 사용자 권한이 필요합니다. 앱 전용 Bearer 토큰은 내 계정 확인에 사용할 수 없습니다. 요금·권한 변경은 직접 확인합니다.' },
  { id: 'github', name: 'GitHub', kind: 'github', group: '서비스', icon: 'github', baseUrl: 'https://api.github.com', setupUrl: 'https://github.com/settings/personal-access-tokens/new', credentialLabel: '접근 토큰', requirement: '연결할 저장소와 필요한 권한만 허용한 토큰을 사용합니다.' },
  { id: 'gitea', name: 'Gitea', kind: 'gitea', group: '서비스', icon: 'gitea', setupUrl: undefined, credentialLabel: '접근 토큰', requirement: '서버 주소를 입력하면 API 주소를 설정합니다. 토큰은 해당 서버의 설정 → 애플리케이션에서 발급합니다.' },
  { id: 'slack', name: 'Slack', kind: 'api', group: '서비스', icon: 'slack', baseUrl: 'https://slack.com/api/', testPath: 'auth.test', setupUrl: 'https://api.slack.com/apps', credentialLabel: 'OAuth 토큰', requirement: 'Slack 앱에 필요한 권한을 설정하고 워크스페이스에 설치합니다.' },
  { id: 'icloud', name: 'iCloud', kind: 'mail', group: '메일', icon: 'icloud', setupUrl: 'https://account.apple.com/', credentialLabel: '앱 암호', requirement: 'Apple 계정에서 발급한 앱 암호를 사용합니다. 일반 Apple 계정 암호는 사용하지 않습니다.', mail: { host: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false } },
  { id: 'gmail', name: 'Gmail', kind: 'mail', group: '메일', icon: 'gmail', setupUrl: 'https://myaccount.google.com/apppasswords', credentialLabel: '앱 비밀번호', requirement: '2단계 인증과 앱 비밀번호가 필요합니다. 계정 정책에 따라 앱 비밀번호 발급이 제한될 수 있습니다.', mail: { host: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true } },
  { id: 'outlook', name: 'Outlook', kind: 'mail', group: '메일', icon: 'microsoftoutlook', setupUrl: 'https://entra.microsoft.com/', credentialLabel: 'OAuth 액세스 토큰', requirement: 'Microsoft 로그인과 권한 동의로 연결합니다. 최초 연결에는 OAuth 앱 등록이 필요하며, 메일 설정에서 IMAP을 켜야 합니다.', mail: { host: 'outlook.office365.com', smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecure: false } },
  { id: 'yahoo', name: 'Yahoo Mail', kind: 'mail', group: '메일', icon: 'yahoo', setupUrl: 'https://login.yahoo.com/account/security', credentialLabel: '앱 비밀번호', requirement: 'Yahoo 계정 보안에서 다른 앱용 비밀번호를 발급합니다.', mail: { host: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true } },
  { id: 'naver', name: '네이버 메일', kind: 'mail', group: '메일', icon: 'naver', setupUrl: 'https://mail.naver.com/', credentialLabel: '앱 비밀번호', requirement: '메일 설정에서 IMAP 사용을 켜고, 2단계 인증과 애플리케이션 비밀번호를 설정합니다.', mail: { host: 'imap.naver.com', smtpHost: 'smtp.naver.com', smtpPort: 587, smtpSecure: false } },
  { id: 'daum', name: '다음 메일', kind: 'mail', group: '메일', setupUrl: 'https://mail.daum.net/', credentialLabel: '앱 비밀번호', requirement: '메일 설정에서 IMAP 사용과 앱 비밀번호 발급 조건을 확인합니다.', mail: { host: 'imap.daum.net', smtpHost: 'smtp.daum.net', smtpPort: 465, smtpSecure: true } },
  { id: 'custom-mail', name: '다른 메일 계정', kind: 'mail', group: '직접 연결', credentialLabel: '앱 비밀번호', requirement: '메일 서버 정보를 직접 입력하거나 Ghost에게 확인을 맡길 수 있습니다.' },
  { id: 'custom-api', name: '다른 서비스', kind: 'api', group: '직접 연결', credentialLabel: 'API 키', requirement: '서비스 주소를 알려 주면 Ghost가 인증 방법을 조사하고 연결을 도울 수 있습니다.' },
];

export const serviceById = (id?: string) => connectionServices.find(service => service.id === id);

export function serviceForConnection(connection: Connection): ConnectionService | undefined {
  const saved = serviceById(connection.serviceId);
  if (saved) return saved;
  const config = connection.config;
  if (config.kind === 'mail') return connectionServices.find(service => service.mail?.host === config.host);
  return connectionServices.find(service => service.id === config.kind);
}

export function connectionSetupPrompt(service: ConnectionService, detail: string): string {
  return `${service.name} 연결을 도와줘.${detail.trim() ? ` 계정·서비스 정보: ${detail.trim()}` : ''}\n공식 인증 방법과 필요한 최소 권한을 조사하고, 브라우저에서 연결 설정과 키 발급을 진행해 줘. 로그인·SSO·2단계 인증은 browser_handoff로 내가 진행하게 해 줘. 비용 발생이나 권한 동의가 필요한 단계는 내 확인을 받아 줘. 비밀번호·API 키는 대화에 표시하거나 요청하지 말고, 발급된 키는 connection_register의 보안 캡처 또는 금고 참조로 등록해 줘. 연결 이름·서비스 아이콘·사용 Ghost 권한을 확인하고, 실제 인증 테스트가 통과해야 연결 완료라고 해 줘. 기존 연결이 있으면 먼저 확인해서 중복을 만들지 마.${service.setupUrl ? `\n공식 설정 진입점: ${service.setupUrl}` : ''}`;
}
