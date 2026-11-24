import { CommandError, invalid, notFound } from "../core/errors.ts";
import type { Shade } from "../integrations/shade.ts";

const STATUSES = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 };

/** Server authentication has already admitted the owner or a paired device. Status and preference only; no item or secret. */
export async function serveShade(request: Request, url: URL, shade: Shade | null): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    if (url.pathname !== "/api/shade") throw notFound("Shade route not found");
    if (!shade) return json({ state: "unavailable", writable: false, saveLogins: false });
    if (request.method === "GET") return json(await shade.status());
    if (request.method === "PUT") {
      const input: unknown = await request.json().catch(() => null);
      if (!input || typeof input !== "object" || !("saveLogins" in input) || typeof input.saveLogins !== "boolean" || Object.keys(input).length !== 1) throw invalid("saveLogins must be a boolean");
      shade.setSaveLogins(input.saveLogins);
      return json(await shade.status());
    }
    throw notFound("Shade route not found");
  } catch (error) {
    if (error instanceof CommandError) return json({ ok: false, error: { code: error.code, message: error.message } }, STATUSES[error.code]);
    return json({ ok: false, error: { code: "internal", message: "Shade request failed" } }, 500);
  }
}
