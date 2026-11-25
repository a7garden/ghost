import {
  Id, parse, WorkbenchAgentCreate, WorkbenchFocus, WorkbenchRename, WorkbenchSpaceCreate, WorkbenchVersion, type Principal,
} from "@ghost/contract";
import { forbidden, invalid, notFound } from "../core/errors.ts";
import type { Workbench } from "./service.ts";

/** The workbench is the owner's: it lists and arranges sessions that run with the owner's Mac access, outside coding's tool grants. */
export async function serveWorkbench(bench: Workbench, principal: Principal | { kind: "ghost" }, request: Request, pathname: string) {
  if (principal.kind !== "owner" && principal.kind !== "device") throw forbidden("작업대는 소유자만 조작할 수 있습니다.");
  const method = request.method;
  const body = (): Promise<unknown> => request.json().catch(() => { throw invalid("요청 본문이 올바르지 않습니다."); });
  if (pathname === "/api/workbench/spaces") {
    if (method === "GET") return bench.read();
    if (method === "POST") return bench.createSpace(parse(WorkbenchSpaceCreate, await body()));
  }
  if (pathname === "/api/workbench/focus" && method === "POST") return bench.focus(parse(WorkbenchFocus, await body()));

  const route = /^\/api\/workbench\/(spaces|agents)\/([^/]+)(?:\/(agents|changes))?$/.exec(pathname);
  if (!route) throw notFound("작업대 경로를 찾을 수 없습니다.");
  const [, resource, rawId, action] = route;
  const id = parse(Id, decodeId(rawId!));
  if (resource === "spaces" && action === "changes" && method === "GET") {
    return bench.changes(id, new URL(request.url).searchParams.get("path"));
  }
  if (!action && method === "DELETE") {
    const { version } = parse(WorkbenchVersion, await body());
    return resource === "spaces" ? bench.deleteSpace(id, version) : bench.removeAgent(id, version);
  }
  if (resource === "spaces" && !action && method === "PATCH") {
    const { version, title } = parse(WorkbenchRename, await body());
    return bench.renameSpace(id, version, title);
  }
  if (resource === "spaces" && action === "agents" && method === "POST") return bench.addAgent(id, parse(WorkbenchAgentCreate, await body()));
  throw notFound("작업대 경로를 찾을 수 없습니다.");
}

function decodeId(value: string): string {
  try { return decodeURIComponent(value); } catch { throw invalid("작업대 ID가 올바르지 않습니다."); }
}
