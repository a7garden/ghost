import { Type } from "typebox";
import { Id, parse } from "@ghost/contract";
import { CodingModels } from "../coding/models.ts";
import type { Core } from "../core/core.ts";
import { invalid, notFound } from "../core/errors.ts";
import { orchestrationInventory, orchestrationStore } from "./config.ts";
import { previewOmp } from "./import-omp.ts";

const SessionPolicy = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });

/** Only the authenticated owner/device HTTP surface may mutate delegation: Ghost's tool registry has no write path. */
export async function serveOrchestration(request: Request, path: string, core: Core): Promise<unknown> {
  const store = orchestrationStore(core.ledger);
  const body = (): Promise<unknown> => request.json().catch(() => { throw invalid("malformed JSON body"); });
  if ((path === "/api/orchestration/config" && request.method === "GET") || (path === "/api/orchestration/import-omp" && request.method === "POST")) {
    core.codexCatalog.sync();
    const models = new CodingModels({ settings: () => core.ledger.settings(), secrets: core.secrets, catalog: core.catalog });
    const inventory = orchestrationInventory(core.ledger, core.secrets, models);
    return request.method === "GET" ? { config: store.get(), ...inventory } : previewOmp(inventory);
  }
  if (path === "/api/orchestration/config" && request.method === "PUT") return store.set(await body());
  const session = /^\/api\/orchestration\/sessions\/([^/]+)$/.exec(path);
  if (session) {
    let decoded: string;
    try { decoded = decodeURIComponent(session[1]!); } catch { throw invalid("invalid coding route ID"); }
    const id = parse(Id, decoded);
    if (!core.codingSessions?.get(id)) throw notFound("coding session not found");
    if (request.method === "GET") return { enabled: store.sessionEnabled(id) };
    if (request.method === "PUT") {
      const policy = parse(SessionPolicy, await body());
      store.setSessionEnabled(id, policy.enabled);
      return policy;
    }
  }
  throw notFound("orchestration route not found");
}
