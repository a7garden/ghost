import { resolveMx } from "node:dns/promises";
import type { MailDiscovery } from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import { assertFetchableUrl } from "./netguard.ts";
import { mailAddress } from "./mail.ts";

type Server = { host: string; port: number };
type Smtp = Server & { secure: boolean };
interface Provider {
  id: string; name: string; imap: Server; smtp: Smtp; auth: MailDiscovery["auth"];
  setupUrl: string | null; note: string | null;
}

/** Providers the catalog already has an icon and wording for; their servers never need a network lookup. */
const PROVIDERS: readonly Provider[] = [
  { id: "gmail", name: "Gmail", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465, secure: true }, auth: "app_password", setupUrl: "https://myaccount.google.com/apppasswords", note: "2단계 인증을 켠 뒤 앱 비밀번호를 만들어 주세요." },
  { id: "icloud", name: "iCloud", imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587, secure: false }, auth: "app_password", setupUrl: "https://account.apple.com/", note: "Apple 계정의 로그인 및 보안에서 앱 암호를 만들어 주세요." },
  { id: "outlook", name: "Outlook", imap: { host: "outlook.office365.com", port: 993 }, smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false }, auth: "oauth", setupUrl: null, note: "Outlook 설정에서 IMAP을 켜야 합니다." },
  { id: "yahoo", name: "Yahoo Mail", imap: { host: "imap.mail.yahoo.com", port: 993 }, smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true }, auth: "app_password", setupUrl: "https://login.yahoo.com/account/security", note: "계정 보안에서 앱 비밀번호를 만들어 주세요." },
  { id: "naver", name: "네이버 메일", imap: { host: "imap.naver.com", port: 993 }, smtp: { host: "smtp.naver.com", port: 587, secure: false }, auth: "app_password", setupUrl: "https://mail.naver.com/", note: "메일 설정에서 IMAP을 켜고 2단계 인증 후 애플리케이션 비밀번호를 만들어 주세요." },
  { id: "daum", name: "다음 메일", imap: { host: "imap.daum.net", port: 993 }, smtp: { host: "smtp.daum.net", port: 465, secure: true }, auth: "app_password", setupUrl: "https://mail.daum.net/", note: "메일 설정에서 IMAP을 켜고 앱 비밀번호를 만들어 주세요." },
];
const provider = (id: string) => PROVIDERS.find(entry => entry.id === id)!;

const DOMAINS: Readonly<Record<string, string>> = {
  "gmail.com": "gmail", "googlemail.com": "gmail",
  "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud",
  "outlook.com": "outlook", "hotmail.com": "outlook", "live.com": "outlook", "msn.com": "outlook", "outlook.kr": "outlook", "hotmail.co.kr": "outlook",
  "yahoo.com": "yahoo", "ymail.com": "yahoo", "rocketmail.com": "yahoo",
  "naver.com": "naver",
  "daum.net": "daum", "hanmail.net": "daum",
};

/** Hosted mail recognised from a company domain's MX records. */
const MX_SUFFIXES: readonly [string, string][] = [
  [".google.com", "gmail"], [".googlemail.com", "gmail"],
  [".protection.outlook.com", "outlook"], [".outlook.com", "outlook"],
  [".yahoodns.net", "yahoo"],
];
const OTHER_MX: readonly [string, Provider][] = [
  [".messagingengine.com", { id: "", name: "Fastmail", imap: { host: "imap.fastmail.com", port: 993 }, smtp: { host: "smtp.fastmail.com", port: 465, secure: true }, auth: "app_password", setupUrl: "https://app.fastmail.com/settings/security/devicekeys", note: "Fastmail 설정에서 앱 비밀번호를 만들어 주세요." }],
  [".zoho.com", { id: "", name: "Zoho Mail", imap: { host: "imap.zoho.com", port: 993 }, smtp: { host: "smtp.zoho.com", port: 465, secure: true }, auth: "app_password", setupUrl: "https://accounts.zoho.com/home#security/app_password", note: "Zoho 계정에서 앱 비밀번호를 만들어 주세요." }],
];

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const FETCH_TIMEOUT_MS = 4000;
const MAX_XML = 64 * 1024;

export interface MailDiscoveryDeps {
  fetch?: (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;
  resolveMx?: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  /** Test seam for the public-address check; defaults to the Host's network guard. */
  guard?: (url: string, what: string) => Promise<unknown>;
}

const result = (email: string, domain: string, found: Partial<MailDiscovery> & Pick<MailDiscovery, "source">): MailDiscovery => ({
  email, domain, provider: null, imap: null, smtp: null, auth: "password", setupUrl: null, note: null, ...found,
});
const fromProvider = (email: string, domain: string, entry: Provider, source: MailDiscovery["source"], name = entry.name, id: string | null = entry.id): MailDiscovery =>
  result(email, domain, { provider: id ? { id, name } : null, imap: entry.imap, smtp: entry.smtp, auth: entry.auth, setupUrl: entry.setupUrl, note: entry.note, source });

/** Names the Host may later connect to must not point at this machine or a private network. */
async function publicHost(host: string, deps: MailDiscoveryDeps): Promise<boolean> {
  if (!HOSTNAME.test(host)) return false;
  try { await (deps.guard ?? assertFetchableUrl)(`https://${host}/`, "mail server"); return true; } catch { return false; }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_XML) return "";
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

const tag = (block: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i").exec(block)?.[1];
const blocks = (xml: string, element: string, type: string) =>
  [...xml.matchAll(new RegExp(`<${element}\\s+type=["']${type}["'][^>]*>([\\s\\S]*?)</${element}>`, "gi"))].map(match => match[1]!);
const placeholders = (value: string | undefined, domain: string, local: string) =>
  value?.replaceAll("%EMAILDOMAIN%", domain).replaceAll("%EMAILLOCALPART%", local).trim().toLowerCase();

/** Mozilla autoconfig 1.1 as served by the domain, or by Thunderbird's ISP database. IMAP over implicit TLS only. */
async function autoconfig(email: string, domain: string, deps: MailDiscoveryDeps): Promise<{ imap: Server; smtp: Smtp | null } | null> {
  const local = email.slice(0, email.lastIndexOf("@"));
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ];
  const get = deps.fetch ?? ((url, init) => fetch(url, init));
  for (const url of urls) {
    try {
      await (deps.guard ?? assertFetchableUrl)(url, "autoconfig URL");
      const response = await get(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual", headers: { accept: "application/xml,text/xml" } });
      if (!response.ok) continue;
      const xml = await readLimited(response);
      let imap: Server | null = null, smtp: Smtp | null = null;
      for (const block of blocks(xml, "incomingServer", "imap")) {
        const host = placeholders(tag(block, "hostname"), domain, local), port = Number(tag(block, "port"));
        if (host && Number.isInteger(port) && tag(block, "socketType")?.toUpperCase() === "SSL" && await publicHost(host, deps)) { imap = { host, port }; break; }
      }
      if (!imap) continue;
      for (const block of blocks(xml, "outgoingServer", "smtp")) {
        const host = placeholders(tag(block, "hostname"), domain, local), port = Number(tag(block, "port")), socket = tag(block, "socketType")?.toUpperCase();
        if (!host || !Number.isInteger(port) || (socket !== "SSL" && socket !== "STARTTLS") || !await publicHost(host, deps)) continue;
        if (!smtp || (socket === "SSL" && !smtp.secure)) smtp = { host, port, secure: socket === "SSL" };
      }
      return { imap, smtp };
    } catch { /* an unreachable or malformed source is just a miss */ }
  }
  return null;
}

/** How one mail address connects. Network lookups are bounded and never leave a secret behind; nothing is stored. */
export async function discoverMail(input: string, deps: MailDiscoveryDeps = {}): Promise<MailDiscovery> {
  let email: string;
  try { email = mailAddress(input.trim()); } catch { throw invalid("이메일 주소를 확인해 주세요."); }
  const at = email.lastIndexOf("@");
  let domain: string;
  try { domain = new URL(`https://${email.slice(at + 1)}`).hostname.toLowerCase(); } catch { throw invalid("이메일 주소를 확인해 주세요."); }
  if (!HOSTNAME.test(domain)) throw invalid("이메일 주소를 확인해 주세요.");

  const known = DOMAINS[domain];
  if (known) return fromProvider(email, domain, provider(known), "known");

  const found = await autoconfig(email, domain, deps);
  if (found) return result(email, domain, { imap: found.imap, smtp: found.smtp, source: "autoconfig" });

  try {
    const records = await (deps.resolveMx ?? resolveMx)(domain);
    for (const record of records.slice().sort((a, b) => a.priority - b.priority)) {
      const exchange = record.exchange.toLowerCase().replace(/\.$/, "");
      const hosted = MX_SUFFIXES.find(([suffix]) => exchange.endsWith(suffix));
      if (hosted) {
        const entry = provider(hosted[1]);
        return fromProvider(email, domain, entry, "mx", hosted[1] === "gmail" ? "Google Workspace" : hosted[1] === "outlook" ? "Microsoft 365" : entry.name);
      }
      const other = OTHER_MX.find(([suffix]) => exchange.endsWith(suffix));
      if (other) return fromProvider(email, domain, other[1], "mx", other[1].name, null);
    }
  } catch { /* no MX is the same as no hint */ }

  const imapHost = `imap.${domain}`, smtpHost = `smtp.${domain}`;
  // publicHost resolves the name: a guessed server must exist and be public to be offered.
  if (await publicHost(imapHost, deps)) {
    return result(email, domain, { imap: { host: imapHost, port: 993 }, smtp: await publicHost(smtpHost, deps) ? { host: smtpHost, port: 465, secure: true } : null, source: "guess" });
  }
  return result(email, domain, { source: "none" });
}
