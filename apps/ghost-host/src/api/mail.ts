import { CommandError, invalid, notFound } from "../core/errors.ts";
import { MailService, MailTooLarge } from "../integrations/mail.ts";

/** Server authentication has already admitted the owner or a paired device. Reads never journal or mark seen. */
export async function serveMail(request: Request, url: URL, mail: MailService | null): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    if (!mail) throw new CommandError("unavailable", "메일 서비스를 사용할 수 없습니다.");
    if (request.method !== "GET") return json({ ok: false, error: { code: "invalid", message: "메일 변경은 명령 API로 요청해 주세요." } }, 405);
    if (url.pathname === "/api/mail/accounts") return json({ accounts: mail.accounts() });
    const match = /^\/api\/mail\/([^/]+)\/(mailboxes|messages|message|attachment)$/.exec(url.pathname);
    if (!match) throw notFound("메일 경로가 없습니다.");
    let account: string;
    try { account = decodeURIComponent(match[1]!); } catch { throw invalid("계정 ID가 올바르지 않습니다."); }
    if (!account || account.length > 128 || /[\r\n\0]/.test(account)) throw invalid("계정 ID가 올바르지 않습니다.");
    const number = (key: string, fallback?: number) => {
      const raw = url.searchParams.get(key);
      if (raw === null && fallback !== undefined) return fallback;
      if (!raw || !/^[1-9][0-9]{0,9}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw invalid(`${key} 값이 올바르지 않습니다.`);
      return Number(raw);
    };
    const mailbox = url.searchParams.get("mailbox") ?? "INBOX";
    if (match[2] === "mailboxes") return json({ mailboxes: await mail.mailboxes(account) });
    if (match[2] === "messages") return json(await mail.list(account, { mailbox, query: url.searchParams.get("q") ?? undefined, limit: number("limit", 50), before: url.searchParams.has("before") ? number("before") : undefined }));
    if (match[2] === "message") return json(await mail.read(account, mailbox, number("uid")));
    const attachment = await mail.attachment(account, mailbox, number("uid"), url.searchParams.get("part") ?? "");
    return new Response(attachment.bytes, { headers: { "cache-control": "no-store", "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}` } });
  } catch (error) {
    if (error instanceof MailTooLarge) return json({ ok: false, error: { code: "invalid", message: error.message } }, 413);
    if (error instanceof CommandError) return json({ ok: false, error: { code: error.code, message: error.message } }, { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 }[error.code]);
    return json({ ok: false, error: { code: "internal", message: "메일 요청을 처리하지 못했습니다." } }, 500);
  }
}
