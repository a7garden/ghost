import { CommandError } from "../core/errors.ts";
import type { Updater } from "./index.ts";
import { iosPage, iosPlist } from "./ios.ts";

export function isIosTokenRoute(path: string): boolean {
  return path === "/api/update/ios/install" || path === "/api/update/ios/manifest.plist" || path === "/api/update/ios/Ghost.ipa";
}

/** Registered after the host-header guard but before bearer authentication. */
export async function serveIosUpdate(request: Request, url: URL, updater: Updater | null): Promise<Response> {
  const entry = request.method === "GET" ? updater?.iosInstall(url.searchParams.get("t")) : null;
  if (!entry || !updater) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  if (url.pathname === "/api/update/ios/install") {
    return new Response(iosPage(entry), { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  if (url.pathname === "/api/update/ios/manifest.plist") return new Response(iosPlist(entry), { headers: { ...headers, "content-type": "application/xml" } });
  if (url.pathname === "/api/update/ios/Ghost.ipa") return new Response(Bun.file(await updater.iosAsset(entry)), { headers: { ...headers, "content-type": "application/octet-stream" } });
  return new Response(null, { status: 404, headers });
}

/** Called only after owner/device bearer authentication by the API server. */
export async function serveUpdate(request: Request, url: URL, updater: Updater | null): Promise<Response> {
  if (!updater) throw new CommandError("unavailable", "업데이트를 사용할 수 없습니다.");
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const path = url.pathname;
  if (path === "/api/update" && request.method === "GET") return json(updater.status());
  if (path === "/api/update/check" && request.method === "POST") return json(await updater.check());
  if (path === "/api/update/cancel" && request.method === "POST") return json(await updater.cancel());
  if (path === "/api/update/ios/link" && request.method === "POST") return json(updater.iosLink());
  if (path === "/api/update/shell/latest.json" && request.method === "GET") {
    const latest = updater.shellLatest(url.origin);
    return latest === null ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : json(latest);
  }
  if (path === "/api/update/shell/Ghost.app.tar.gz" && request.method === "GET") {
    return new Response(Bun.file(await updater.shellAsset()), { headers: { "content-type": "application/gzip", "cache-control": "no-store" } });
  }
  if ((path === "/api/update/settings" && request.method === "PUT") || (path === "/api/update/install" && request.method === "POST")) {
    let body: unknown;
    try {
      if (Number(request.headers.get("content-length")) > 4096) throw new Error("body too large");
      const reader = request.body?.getReader();
      if (!reader) throw new Error("empty body");
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 4096) throw new Error("body too large");
          chunks.push(value);
        }
      } catch (error) { await reader.cancel(); throw error; }
      body = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } catch { throw new CommandError("invalid", "요청 내용을 확인해 주세요."); }
    if (!body || Array.isArray(body) || typeof body !== "object") throw new CommandError("invalid", "요청 내용을 확인해 주세요.");
    const input = body as Record<string, unknown>;
    if (path === "/api/update/install") {
      if (Object.keys(input).length !== 1 || typeof input.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new CommandError("invalid", "버전이 올바르지 않습니다.");
      return json(updater.install(input.version), 202);
    }
    if (Object.keys(input).some((key) => key !== "autoCheck" && key !== "token") || ("autoCheck" in input && typeof input.autoCheck !== "boolean")
      || ("token" in input && input.token !== null && (typeof input.token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(input.token)))) throw new CommandError("invalid", "업데이트 설정이 올바르지 않습니다.");
    return json(updater.settings(input as { autoCheck?: boolean; token?: string | null }));
  }
  throw new CommandError("not_found", "업데이트 경로를 찾을 수 없습니다.");
}
